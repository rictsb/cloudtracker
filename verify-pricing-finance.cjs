/* Research-pricing finance checks. No writes or network; independent calendar reconciliation. */
'use strict';
const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const { assemble } = require('./onepager.js'), OP = require('./onepager-core.js');
const data = JSON.parse(fs.readFileSync(__dirname + '/data.json', 'utf8'));
const copy = value => JSON.parse(JSON.stringify(value));
const serial = q => Number(q.slice(0, 4)) * 4 + Number(q.slice(-1)) - 1;
const near = (actual, expected, label, tolerance = 1e-8) => assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: ${actual} vs ${expected}`);
const browser = vm.createContext({ console });
vm.runInContext(fs.readFileSync(__dirname + '/onepager-core.js', 'utf8'), browser, { filename: 'onepager-core.js' });
const names = ['IREN', 'CRWV', 'NBIS'], models = {};
let passed = 0, failed = 0;
function check(label, fn) {
  try { fn(); passed++; console.log('PASS: ' + label); }
  catch (error) { failed++; console.error('FAIL: ' + label + '\n  ' + error.message); }
}
for (const tk of names) {
  const company = data.companies.find(c => c.tk === tk);
  models[tk] = { company, cases: company.ramp.scenarios.map(s => ({ scenario: s, model: assemble(company, data.researchPricing, s) })) };
  models[tk].base = assemble(company, data.researchPricing);
}

check('IREN house default adds one half-turn without changing its operating or funding inputs', () => {
  const { company, base } = models.IREN, original = JSON.stringify(company), unadjusted = copy(company);
  delete unadjusted.page.valuationMultiplePremium;
  const underlying = assemble(unadjusted, data.researchPricing);
  const previousHigh = OP.waterfall(underlying.L, underlying.CAPQ, underlying.F, underlying.ARRC, { mult: underlying.F.MULT + .5 });
  near(base.F.MULT, underlying.F.MULT + .5, 'default premium');
  near(base.F.DCF_MULT, underlying.F.MULT, 'unadjusted multiple retained');
  near(base.W.ps, previousHigh.ps, 'default equals original higher-multiple sensitivity');
  assert.deepEqual(base.L, underlying.L, 'operating ledger unchanged');
  assert.deepEqual(base.CAPQ, underlying.CAPQ, 'capex unchanged');
  near(base.W.eqTot, underlying.W.eqTot, 'funding unchanged');
  near(base.W.last.nd, underlying.W.last.nd, 'net debt unchanged');
  const sensitivities = OP.sensitivities(base.L, base.CAPQ, base.F, base.ARRC, company.page.px.v);
  near(sensitivities[7].ps, underlying.W.ps, 'no-premium sensitivity restores original value');
  assert.match(sensitivities[0].name, /Default/);
  assert.match(sensitivities[7].name, /no premium/);
  near(assemble(company, data.researchPricing).W.ps, previousHigh.ps, 'reassembly does not compound premium');
  assert.equal(JSON.stringify(company), original, 'source remains immutable');
  for (const tk of ['CRWV', 'NBIS']) {
    assert.equal(models[tk].company.page.valuationMultiplePremium, undefined, tk + ' has no premium');
    near(models[tk].base.F.MULT, OP.steadyMultiple(models[tk].base.pg.steady.inputs).blend, tk + ' retains DCF-derived multiple');
  }
});

/* Reconstruct credit dates using published receipts and explicit schedule fields, without
   the calculator's array indexes or liability output. The map uses absolute calendar quarters. */
function credits(model) {
  const pp = model.F.prepay || {}, calendar = new Map();
  const add = (start, count, amount) => {
    assert.ok(Number.isInteger(start) && Number.isInteger(count) && count > 0, 'valid credit dates and duration');
    for (let i = 0; i < count; i++) calendar.set(start + i, (calendar.get(start + i) || 0) + amount / count);
  };
  for (const fixed of pp.credits || []) add(serial(fixed.from), fixed.n, fixed.amt);
  for (const quarter of model.W.C.filter(c => !c.past)) {
    const q = quarter.q;
    const inferredReceipt = quarter.r.pre / 1000 - (pp.special?.[q]?.upfront || 0) + (pp.alreadyReceived?.[q] || 0);
    const schedule = pp.creditSchedules?.[q] || [{ weight: 1, startQ: pp.startQ ?? 8, termQ: pp.termQOverride?.[q] || pp.termQ || 4 }];
    for (const part of schedule) add(serial(q) + part.startQ, part.termQ, inferredReceipt * part.weight);
  }
  const horizon = serial(model.L.at(-1)[0]);
  let future = 0, pv = 0;
  for (const [quarter, amount] of calendar) if (quarter > horizon) {
    future += amount;
    pv += amount / Math.pow(1 + model.F.W, (quarter - horizon) / 4);
  }
  return { calendar, future, pv };
}

check('Every scenario preserves source data and the original capex purchase calendar', () => {
  for (const tk of names) {
    const { company, base, cases } = models[tk], before = JSON.stringify(company);
    for (const { scenario, model } of cases) {
      assert.deepEqual(model.CAPQ, base.CAPQ, tk + '/' + scenario.id + ' purchase dates');
      assert.deepEqual(model.F.prepay.credits, company.page.finance.prepay.credits, tk + '/' + scenario.id + ' fixed opening credits');
      assert.deepEqual(model.F.prepay.special, company.page.finance.prepay.special, tk + '/' + scenario.id + ' special receipts');
      assert.ok(Number.isFinite(model.W.ps), tk + '/' + scenario.id + ' finite value');
    }
    assemble(company, data.researchPricing, company.ramp.scenarios.at(-1));
    assert.equal(JSON.stringify(company), before, tk + ' source mutation');
  }
});

check('Node and browser calculators return identical complete waterfalls for every pricing scenario', () => {
  for (const tk of names) for (const { scenario, model } of models[tk].cases) {
    const result = browser.OnePager.waterfall(copy(model.L), copy(model.CAPQ), copy(model.F), copy(model.ARRC));
    assert.deepEqual(JSON.parse(JSON.stringify(result)), copy(model.W), tk + '/' + scenario.id);
  }
});

check('Prepayment balances equal opening liabilities plus receipts less customer credits', () => {
  for (const tk of names) for (const { scenario, model } of models[tk].cases) {
    let owed = model.F.prepay.openingOwed || 0;
    for (const c of model.W.C.filter(c => !c.past)) {
      owed += (c.r.pre - c.r.cred) / 1000;
      near(c.r.owed, owed, tk + '/' + scenario.id + '/' + c.q + ' balance');
    }
  }
});

check('Inferred credits are fully allocated inside modeled service terms', () => {
  for (const tk of names) for (const { scenario, model } of models[tk].cases) {
    const timing = model.F.prepay.creditTiming;
    for (const [purchase, parts] of Object.entries(model.F.prepay.creditSchedules || {})) {
      near(parts.reduce((sum, p) => sum + p.weight, 0), 1, tk + '/' + scenario.id + '/' + purchase + ' weights');
      for (const part of parts) {
        const first = serial(purchase) + part.startQ, end = first + part.termQ, service = serial(part.serviceQ), expiry = serial(part.endQ);
        assert.ok(Number.isInteger(part.startQ) && Number.isInteger(part.termQ) && part.startQ >= 0 && part.termQ > 0, 'positive integer schedule');
        assert.ok(first >= service && end <= expiry, tk + '/' + scenario.id + '/' + purchase + ' credits within service term');
        if (timing.mode === 'final-quarters') { assert.equal(end, expiry); assert.equal(part.termQ, Math.min(timing.quarters, expiry - service)); }
        if (timing.mode === 'first-quarters') { assert.equal(first, service); assert.equal(part.termQ, Math.min(timing.quarters, expiry - service)); }
        if (timing.mode === 'after-quarters') { assert.equal(first, Math.min(service + timing.quarters, expiry - 1)); assert.equal(end, expiry); }
      }
    }
  }
});

check('Calendar credit reconstruction matches cash credits and all horizon liabilities', () => {
  for (const tk of names) for (const { scenario, model } of models[tk].cases) {
    const reconstructed = credits(model);
    for (const c of model.W.C.filter(c => !c.past)) near(c.r.cred / 1000, reconstructed.calendar.get(serial(c.q)) || 0, tk + '/' + scenario.id + '/' + c.q + ' credit');
    const unscheduled = Math.max(0, model.W.last.owed - reconstructed.future);
    near(model.W.liab, reconstructed.pv + unscheduled, tk + '/' + scenario.id + ' full liability including unscheduled balance');
  }
});

check('CoreWeave 2031–32 opening credits reduce horizon value even though they start after the ledger', () => {
  const model = models.CRWV.base, F = copy(model.F), horizon = serial(model.L.at(-1)[0]);
  const removed = F.prepay.credits.filter(c => serial(c.from) > horizon);
  assert.ok(removed.length > 0, 'fixture contains post-horizon credits');
  F.prepay.credits = F.prepay.credits.filter(c => serial(c.from) <= horizon);
  const without = OP.waterfall(model.L, model.CAPQ, F, model.ARRC);
  let expected = 0;
  for (const credit of removed) for (let i = 0; i < credit.n; i++) expected += credit.amt / credit.n / Math.pow(1 + F.W, (serial(credit.from) + i - horizon) / 4);
  // Keep opening balance consistent in the counterfactual; otherwise the amount becomes unscheduled owed.
  F.prepay.openingOwed -= removed.reduce((sum, c) => sum + c.amt, 0);
  const absent = OP.waterfall(model.L, model.CAPQ, F, model.ARRC);
  near(model.W.liab - absent.liab, expected, 'post-horizon fixed-credit PV');
  near(model.W.last.nd, absent.last.nd, 'post-horizon credits do not change in-horizon net debt');
  assert.ok(absent.ps > model.W.ps, 'removing actual obligation increases equity value');
  assert.ok(Number.isFinite(without.ps));
});

check('Never-credit sensitivity has no customer credits or terminal credit liability', () => {
  for (const tk of names) {
    const model = models[tk].base;
    const result = OP.waterfall(model.L, model.CAPQ, model.F, model.ARRC, { noCredit: true });
    for (const c of result.C.filter(c => !c.past)) near(c.r.cred, 0, tk + '/' + c.q + ' no credit');
    near(result.liab, 0, tk + ' never-credit liability');
  }
});

check('Fixed credits beyond six years remain in the liability, with calendar discounting', () => {
  const L = ['2026Q3', '2026Q4'].map(q => [q, 10, 10, 10, 1000, 1000, 1000, 100, 100, 100, 1, 10, null, null]);
  const F = { M: .5, W: .1, MULT: 3, SH0: 100, EQ_SHARE: 0, EQ_PX: 10, DEBT0: 0, CASH0: 0, RATE: 0, TAX: 0, MINCASH: 0,
    T0: '2026Q3', prepay: { ratio: 0, openingOwed: 1, credits: [{ from: '2038Q1', n: 4, amt: 1 }] } };
  const result = OP.waterfall(L, {}, F, {});
  const expected = [0, 1, 2, 3].reduce((sum, i) => sum + .25 / Math.pow(1.1, (serial('2038Q1') + i - serial('2026Q4')) / 4), 0);
  near(result.liab, expected, 'long-dated fixed credit PV');
  near(result.scheduledOwed, 1, 'long-dated undiscounted obligation');
  near(result.unscheduledOwed, 0, 'fixed future credits are scheduled');
});

check('Steady-state term and horizon cohort metadata follow their scenario', () => {
  for (const tk of names) for (const { scenario, model } of models[tk].cases) {
    assert.equal(model.pg.steady.inputs.term, scenario.d?.newTermYears ?? models[tk].company.page.steadyInputs.term, tk + '/' + scenario.id + ' steady term');
    const last = model.rawQuarters.at(-1);
    near(model.pricing.cohorts.reduce((sum, c) => sum + c.earningRevenueBn, 0), last.rev * .004, tk + '/' + scenario.id + ' cohort revenue');
    for (let i = 0; i < model.pricing.cohorts.length; i++) {
      const c = model.pricing.cohorts[i], original = models[tk].company.ramp.tranches[i];
      if (c.contractShare > 0) {
        const expectedExpiry = serial(original.contract.endQ) + (original.contract.expiryBasis === 'disclosed' ? 0 : serial(c.firstRevenue) - serial(original.rev));
        assert.equal(serial(c.endQ), expectedExpiry, tk + '/' + scenario.id + '/' + c.name + ' original expiry');
      }
      if (c.newBusinessShare > 0) {
        assert.ok(Number.isFinite(c.newRatePerMW) && c.newRatePerMW >= 0, tk + '/' + scenario.id + '/' + c.name + ' new rate');
        const term = scenario.d?.newTermYears ?? original.newBusiness.termYears;
        assert.equal(c.newTermYears, term, tk + '/' + scenario.id + '/' + c.name + ' new term');
        assert.equal(serial(c.newEndQ), Math.max(serial(c.firstRevenue), serial(model.pricing.effectiveQ)) + 4 * term, tk + '/' + scenario.id + '/' + c.name + ' new expiry');
      }
      if (c.nextExpiryQ) assert.ok(serial(c.nextExpiryQ) > serial(last.lbl), 'next expiry after horizon');
    }
  }
});

console.log(`${passed} finance check groups passed; ${failed} failed.`);
if (failed) process.exitCode = 1;
