#!/usr/bin/env node
/* Meaningful economic-review fixtures. No network, writes or model changes. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { analyze, RULE_VERSION } = require('./assumption-core.cjs');
const { assemble } = require('./onepager.js');
const OP = require('./onepager-core.js');
const { createEngine } = require('./engine.js');
const data = JSON.parse(fs.readFileSync(__dirname + '/data.json', 'utf8'));
const snapshot = JSON.parse(fs.readFileSync(__dirname + '/market-prices.json', 'utf8'));
const copy = x => JSON.parse(JSON.stringify(x));
const freeze = x => { if (x && typeof x === 'object') { Object.freeze(x); Object.values(x).forEach(freeze); } return x; };
const opts = { asOf: '2026-09-16T18:00:00.000Z' };
const run = (d = data, marks = snapshot) => analyze(d, marks, opts);
const finding = (r, id) => r.findings.find(f => f.id === id);
const company = (d, tk) => d.companies.find(c => c.tk === tk);
const near = (a, b) => assert.ok(Number.isFinite(a) && Math.abs(a - b) < 1e-8, `${a} ≠ ${b}`);
const staticFixture = (model = 'owner') => ({
  config: copy(data.config),
  companies: [{ tk: 'TEST', name: 'Synthetic review fixture', model, tier: 'proven',
    shares: 100, sharesReported: 100, price: 10, netDebt: 0, plannedRaise: 0,
    contractedPct: 0, termYrs: 7, signedRate: 10, legacyEV: 0,
    sites: model === 'holdco' ? [] : [{ n: 'Synthetic 100 MW site', mw: 100,
      owned: true, region: 'mid', yr: 2026, mo: 1, prov: 'disclosed' }] }]
});
const fixtureMarks = { prices: { TEST: 10, HELD: 10 }, priceDates: { TEST: '2026-09-16', HELD: '2026-09-16' }, btc: 60000, eth: 3000 };
const staticValue = (d, tk = 'TEST', marks = fixtureMarks, configure = () => {}) => {
  const e = createEngine(d);
  Object.assign(e.ctx, copy(marks)); configure(e);
  return e.value(company(d, tk));
};
const assertImpact = (f, original, alternative) => {
  assert.ok(f, 'expected a material review finding');
  assert.equal(f.severity, 'review');
  near(f.impact.base, original.target); near(f.impact.alternative, alternative.target);
  near(f.impact.delta, alternative.target - original.target);
  near(f.impact.pct, (alternative.target - original.target) / Math.abs(original.target) * 100);
  assert.equal(f.impact.pctUnit, 'percent');
  assert.equal(f.scenario.kind, 'asset');
  near(f.alternativeMetrics.enterpriseValueM, alternative.ev);
  near(f.alternativeMetrics.claimsM, alternative.claims);
  near(f.alternativeMetrics.fundedSharesM, alternative.fundedShares);
  near(f.alternativeMetrics.newSharesM, alternative.newShares);
};
let passes = 0, failures = 0;
function check(label, fn) { try { fn(); passes++; console.log('PASS: ' + label); } catch (e) { failures++; console.error('FAIL: ' + label + '\n  ' + e.stack); } }
const base = run();

check('All names are covered without passing missing operating or funding evidence', () => {
  assert.equal(base.summary.companies, data.companies.length);
  assert.equal(new Set(base.companies.map(c => c.ticker)).size, data.companies.length);
  assert.equal(base.ruleVersion, RULE_VERSION);
  for (const c of base.companies) {
    for (const f of ['capacity', 'economics', 'funding']) assert.ok(c.tests[f]);
    assert.notEqual(c.tests.funding.status, 'consistent');
    if (c.model === 'holdco') { assert.equal(c.tests.capacity.status, 'not-applicable'); assert.equal(c.tests.economics.status, 'not-applicable'); }
    else assert.notEqual(c.tests.capacity.status, 'consistent');
  }
  for (const c of base.companies) assert.ok(base.findings.filter(f => f.ticker === c.ticker).length <= 20,
    `${c.ticker}: grouped economic questions, not a finding for every tranche`);
});

check('Analysis leaves recursively frozen model and quote inputs untouched', () => {
  const d = freeze(copy(data)), p = freeze(copy(snapshot)), before = JSON.stringify([d, p]);
  run(d, p);
  assert.equal(JSON.stringify([d, p]), before);
});

check('Analysis never freezes or mutates mutable caller data while running asset stresses', () => {
  const d = copy(data), p = copy(snapshot), before = JSON.stringify([d, p]);
  const objects = x => x && typeof x === 'object' ? [x, ...Object.values(x).flatMap(objects)] : [];
  run(d, p);
  assert.equal(JSON.stringify([d, p]), before);
  assert.ok(objects([d, p]).every(x => !Object.isFrozen(x)), 'caller objects remain mutable');
});

check('Fresh quote wrappers and raw marks select the same per-company price', () => {
  const raw = run(data, snapshot.marks);
  for (const c of raw.companies) {
    near(c.metrics.price, snapshot.marks.prices[c.ticker]);
    near(c.metrics.price, base.companies.find(x => x.ticker === c.ticker).metrics.price);
    assert.equal(c.metrics.priceAsOf, snapshot.marks.priceDates[c.ticker]);
  }
  const e = createEngine(data);
  Object.assign(e.ctx, snapshot.marks);
  near(base.companies.find(c => c.ticker === 'BTBT').metrics.assetValuePerShare, e.value(company(data, 'BTBT')).target);
});

check('Missing and stale quote evidence cannot become a current funding-price pass', () => {
  const missing = run(data, {});
  assert.ok(finding(missing, 'IREN:funding:reference-price-evidence'));
  assert.match(missing.companies.find(c => c.ticker === 'IREN').metrics.priceBasis, /Fallback/);
  const stale = copy(snapshot);
  stale.marks.priceDates.IREN = '2020-01-01T00:00:00.000Z';
  assert.ok(finding(run(data, stale), 'IREN:funding:reference-price-evidence'));
});

check('Horizon revenue uses the matching earning IT MW and explicit quarter annualization', () => {
  for (const tk of ['IREN', 'CRWV', 'NBIS']) {
    const m = assemble(company(data, tk), data.researchPricing), last = m.rawQuarters.at(-1), r = base.companies.find(c => c.ticker === tk).metrics;
    near(r.annualizedQuarterRevenueBn, last.rev * 4 / 1000);
    near(r.revenuePerEarningITMWM, last.rev * 4 / last.itMW);
    near(r.contractRevenuePerEarningITMWM, last.revC * 4 / last.itContracted);
    assert.match(r.annualizedQuarterBasis, /not a separately observed December exit/);
  }
});

check('An earning-before-power contradiction is detected in source and derived capacity', () => {
  const d = copy(data), t = company(d, 'CRWV').ramp.tranches[0];
  t.energize = '2031Q4'; t.rev = '2024Q1';
  const r = run(d);
  assert.equal(finding(r, 'CRWV:capacity:earning-before-power').severity, 'error');
  assert.equal(finding(r, 'CRWV:capacity:earning-over-installed').severity, 'error');
  assert.equal(r.companies.find(c => c.ticker === 'CRWV').tests.capacity.status, 'error');
});

check('IT above gross and economic JV MW above physical MW are independently rejected', () => {
  const d = copy(data);
  company(d, 'NBIS').ramp.tranches[0].itMW = company(d, 'NBIS').ramp.tranches[0].grossMW + 50;
  company(d, 'NUAI').sites[0].mw = company(d, 'NUAI').sites[0].physMW + 1;
  const r = run(d);
  assert.equal(finding(r, 'NBIS:capacity:tranche-physical').severity, 'error');
  assert.equal(finding(r, 'NUAI:capacity:site-physical').severity, 'error');
});

check('A thousandfold GPU quantity error requests a dimensional review', () => {
  const d = copy(data);
  company(d, 'IREN').ramp.tranches[0].gpus *= 1000;
  assert.equal(finding(run(d), 'IREN:economics:density-price-scale').severity, 'review');
});

check('Shared unit-label and common curve-scale defects survive peer uniformity', () => {
  const d = copy(data);
  d.researchPricing.units = 'USD per gross MW per quarter';
  for (const row of Object.values(d.researchPricing.curve)) for (const k of Object.keys(row)) row[k] *= 1000;
  const r = run(d);
  for (const tk of ['IREN', 'CRWV', 'NBIS']) {
    assert.equal(finding(r, tk + ':economics:pricing-units').severity, 'error');
    assert.equal(finding(r, tk + ':economics:forward-curve-scale').severity, 'review');
  }
});

check('Missing preferred research model stays a coverage gap, with no valuation substitution', () => {
  const d = copy(data); delete company(d, 'CRWV').page;
  const r = run(d), crwv = r.companies.find(c => c.ticker === 'CRWV');
  assert.equal(finding(r, 'CRWV:economics:research-inputs-missing').severity, 'gap');
  assert.equal(crwv.metrics.valuePerShare, undefined);
  assert.equal(crwv.tests.economics.status, 'insufficient');
});

check('Research and landlord peer scopes cannot be mixed', () => {
  const d = copy(data), landlord = company(d, 'RIOT');
  landlord.leases[0].noiPerMWyr *= 100;
  const r = run(d);
  assert.ok(finding(r, 'RIOT:economics:lease-noi-exceeds-revenue'));
  assert.equal(finding(r, 'RIOT:economics:matched-peer-price'), undefined);
  for (const f of r.findings.filter(f => f.id.endsWith(':matched-peer-price'))) assert.ok(['IREN', 'CRWV', 'NBIS'].includes(f.ticker));
});

check('Different forecast horizons are never compared as a matched peer price', () => {
  const d = copy(data);
  company(d, 'CRWV').page.toQ = '2029Q4';
  company(d, 'CRWV').ramp.tranches[0].rate *= 20;
  const r = run(d);
  assert.equal(r.findings.filter(f => f.id.endsWith(':matched-peer-price')).length, 0);
});

check('Lease gross headline is used instead of an incompatible legacy totalRevM field', () => {
  const d = copy(data), lease = company(d, 'RIOT').leases[0];
  lease.totalRevM = 1; lease.grossTotalM = lease.mw * lease.termYrs * lease.noiPerMWyr * 1.2;
  assert.equal(finding(run(d), 'RIOT:economics:lease-noi-exceeds-revenue'), undefined);
});

check('Bad capital units and negative purchase costs produce errors', () => {
  const d = copy(data);
  company(d, 'IREN').page.finance.RATE = 8;
  company(d, 'NBIS').page.capexQ = { '2026Q3': [-1000, 500] };
  company(d, 'HIVE').shares = 0;
  const r = run(d);
  assert.equal(finding(r, 'IREN:funding:research-capital-inputs').severity, 'error');
  assert.equal(finding(r, 'NBIS:funding:capex-inputs').severity, 'error');
  assert.equal(finding(r, 'HIVE:funding:capital-inputs').severity, 'error');
});

check('Convertible principal mismatch and unconverted debt claims cannot silently pass', () => {
  const d = copy(data), f = company(d, 'NBIS').page.finance;
  f.SERIES[0][0] += .5;
  for (const s of f.SERIES) s[1] = 100000;
  const r = run(d);
  assert.equal(finding(r, 'NBIS:funding:convertible-principal').severity, 'error');
  assert.equal(finding(r, 'NBIS:funding:unconverted-debt-claim').severity, 'error');
});

check('Sensitivity values come from the canonical full model, with declared percent units', () => {
  for (const tk of ['IREN', 'CRWV', 'NBIS']) {
    const m = assemble(company(data, tk), data.researchPricing);
    const f = finding(base, tk + ':economics:same-hardware-renewal');
    if (m.rawQuarters.at(-1).revRenewal > 0) {
      const alt = assemble(company(data, tk), data.researchPricing, { d: f.scenario.delta });
      near(f.impact.base, m.W.ps); near(f.impact.alternative, alt.W.ps);
      near(f.impact.delta, alt.W.ps - m.W.ps);
      near(f.impact.pct, (alt.W.ps - m.W.ps) / Math.abs(m.W.ps) * 100);
      assert.equal(f.impact.pctUnit, 'percent');
      if (alt.W.ps > m.W.ps) assert.ok(finding(base, tk + ':economics:renewal-spot-substitution'));
    } else assert.equal(f, undefined);
    const restricted = finding(base, tk + ':funding:restricted-cash');
    if (m.F.CASH_R > 0) near(restricted.impact.alternative, OP.waterfall(m.L, m.CAPQ, m.F, m.ARRC, { noRestricted: true }).ps);
    else assert.equal(restricted, undefined);
  }
});

check('Renewal stress lowers an already-low base and respects lower cohort overrides', () => {
  const d = copy(data); d.researchPricing.renewal.retention = .5;
  for (const tk of ['IREN', 'CRWV', 'NBIS']) {
    delete company(d, tk).ramp.pricing.renewal;
    for (const t of company(d, tk).ramp.tranches) delete t.contract.renewal;
  }
  const r = run(d);
  for (const tk of ['IREN', 'CRWV', 'NBIS']) near(finding(r, tk + ':economics:same-hardware-renewal').scenario.delta.renewalRetention, .4);
  company(d, 'CRWV').ramp.tranches[0].contract.renewal = { retention: .1 };
  const low = finding(run(d), 'CRWV:economics:same-hardware-renewal');
  near(low.scenario.delta.renewalRetention, .08);
  assert.match(low.impact.label, /8%/);
});

check('Percentage impacts preserve the economic direction for negative base values', () => {
  const d = copy(data); company(d, 'CRWV').page.finance.DEBT0 = 3000; company(d, 'CRWV').page.finance.CASH_R = 1;
  const r = run(d), f = finding(r, 'CRWV:funding:restricted-cash');
  assert.ok(f.impact.base < 0, 'fixture has negative equity value');
  assert.equal(Math.sign(f.impact.pct), Math.sign(f.impact.delta));
  near(f.impact.pct, f.impact.delta / Math.abs(f.impact.base) * 100);
});

check('Stable issue identity survives input changes while relevant evidence fingerprints change', () => {
  const d = copy(data);
  company(d, 'IREN').ramp.tranches[0].gpus += 10;
  const changed = run(d), id = 'IREN:economics:independent-gpu-evidence';
  assert.equal(finding(changed, id).id, finding(base, id).id);
  assert.notEqual(finding(changed, id).fingerprint, finding(base, id).fingerprint);
  const later = analyze(data, snapshot, { asOf: '2026-09-16T20:00:00.000Z' });
  assert.equal(finding(later, id).fingerprint, finding(base, id).fingerprint);
  assert.equal(new Set(base.findings.map(f => f.id)).size, base.findings.length);
});

check('Findings and evidence remain JSON-safe and sources cannot inject executable URLs', () => {
  const d = copy(data);
  company(d, 'CRWV').ramp.tranches[0].contract.source = 'javascript:alert(1)';
  const r = run(d), roundTrip = JSON.parse(JSON.stringify(r));
  assert.deepEqual(roundTrip, r);
  for (const f of r.findings) {
    assert.ok(['error', 'review', 'gap'].includes(f.severity));
    assert.ok(f.id && f.title && f.explanation && f.calculation && f.nextAction && f.fingerprint);
    for (const e of f.evidence) if (e.url) assert.match(e.url, /^https?:\/\//);
  }
});

check('Reviews remain visible in the matrix while coverage gaps remain explicit', () => {
  for (const tk of ['IREN', 'CRWV', 'NBIS']) {
    const r = base.companies.find(c => c.ticker === tk);
    assert.equal(r.tests.economics.status, 'review');
    assert.match(r.tests.economics.summary, /coverage gaps/);
  }
});

check('Unsigned realization reviews require both concentration and material canonical value impact', () => {
  const d = staticFixture(), id = 'TEST:economics:unsigned-realization';
  const original = staticValue(d), alternative = staticValue(d, 'TEST', fixtureMarks, e => { e.A.leaseUp *= .8; });
  assertImpact(finding(run(d, fixtureMarks), id), original, alternative);
  near(alternative.target / original.target, .8);
  // Large net cash makes the same operating stress immaterial to common value.
  d.companies[0].netDebt = -100000;
  assert.equal(finding(run(d, fixtureMarks), id), undefined);
  // A signed lease has no unsigned realization exposure.
  const signed = staticFixture('landlord');
  signed.companies[0].sites[0].leaseId = 'signed';
  signed.companies[0].leases = [{ id: 'signed', effective: true, mw: 100, noiPerMWyr: 1, termYrs: 20 }];
  assert.equal(finding(run(signed, fixtureMarks), id), undefined);
});

check('Static issuance stress uses the reference mark and only flags substantial new shares', () => {
  const d = staticFixture(), c = d.companies[0], id = 'TEST:funding:issuance-price';
  c.price = 100; // The frozen market mark is $10, not this fallback value.
  c.plannedRaise = 260;
  const f = finding(run(d, fixtureMarks), id);
  assertImpact(f, staticValue(d), staticValue(d, 'TEST', fixtureMarks, e => { e.ctx.prices.TEST *= .8; }));
  near(staticValue(d).newShares, 26);
  c.plannedRaise = 250;
  assert.equal(finding(run(d, fixtureMarks), id), undefined, '25% boundary is not greater than 25%');
  c.plannedRaise = 0;
  assert.equal(finding(run(d, fixtureMarks), id), undefined);
});

check('Modeled shares below a reported count request reconciliation rather than asserting an error', () => {
  const d = staticFixture(), c = d.companies[0], id = 'TEST:funding:shares-below-reported';
  c.shares = 98.9;
  const changed = copy(d); changed.companies[0].shares = c.sharesReported;
  assertImpact(finding(run(d, fixtureMarks), id), staticValue(d), staticValue(changed));
  c.shares = 99;
  assert.equal(finding(run(d, fixtureMarks), id), undefined);
  delete c.sharesReported;
  const result = run(d, fixtureMarks);
  assert.equal(finding(result, id), undefined);
  assert.notEqual(result.companies[0].tests.funding.status, 'consistent', 'missing reported shares cannot establish complete funding coverage');
});

check('Signed lease capitalization stress raises the cap floor through the canonical engine', () => {
  const d = staticFixture('landlord'), c = d.companies[0], id = 'TEST:economics:lease-capitalization';
  c.sites[0].leaseId = 'signed';
  c.leases = [{ id: 'signed', effective: true, mw: 100, noiPerMWyr: 1, termYrs: 10, grossTotalM: 1200 }];
  const original = staticValue(d), changed = copy(d);
  changed.config.constants.capFloor += 1;
  const f = finding(run(d, fixtureMarks), id);
  assertImpact(f, original, staticValue(changed));
  assert.ok(original.segs[0].gross > c.leases[0].mw * c.leases[0].noiPerMWyr * c.leases[0].termYrs,
    'fixture capitalization exceeds undiscounted original-term NOI');
  assert.match(f.explanation + ' ' + f.calculation + ' ' + f.evidence.map(x => x.label).join(' '), /term|finite|renewal/i);
  d.config.dials.capRate = 20;
  assert.equal(finding(run(d, fixtureMarks), id), undefined, 'floor is not binding and term exceeds capitalization duration');
});

check('Book-derived regional pricing review requires a complete matching owner book', () => {
  const d = staticFixture(), c = d.companies[0], id = 'TEST:economics:signed-rate-region';
  c.contractedPct = 100;
  c.sites[0].region = 'au';
  c.contracts = [{ id: 'book', effective: true, totalRevM: 5000, termYrs: 5, mw: 100 }];
  const changed = copy(d); changed.companies[0].signedRegionFactor = 1;
  assertImpact(finding(run(d, fixtureMarks), id), staticValue(d), staticValue(changed));
  assert.equal(changed.companies[0].signedRate, c.signedRate, 'scenario preserves the sourced signed rate');
  assert.equal(finding(run(changed, fixtureMarks), id), undefined, 'normalized signed factor resolves this finding');
  c.sites[0].region = 'mid';
  assert.equal(finding(run(d, fixtureMarks), id), undefined, 'a US region factor of one is not a second discount');
  c.sites[0].region = 'au';
  c.contracts.push({ id: 'incomplete', effective: true, totalRevM: 100, termYrs: 5 });
  let result = run(d, fixtureMarks);
  assert.equal(finding(result, id), undefined, 'partial book must not be treated as a complete matching rate');
  assert.ok(result.findings.some(f => f.ticker === 'TEST' && f.family === 'economics' && f.severity === 'gap'));
  c.contracts = [];
  assert.equal(finding(run(d, fixtureMarks), id), undefined, 'missing book cannot corroborate signed rate');
});

check('Optional signed geography retains exact legacy values and keeps unsigned pricing separate', () => {
  const d = staticFixture(), c = d.companies[0];
  c.contractedPct = 70; c.termYrs = 5; c.sites[0].region = 'au'; c.sites[0].yr = 2028;
  const e = createEngine(d), s = c.sites[0], baseline = e.value(c), rates = e.siteRates(c, s);
  const unsignedEconomicValue = (r, v) => {
    const signedYears = Math.max(0, s.yr + ((s.mo || 1) - 1) / 12 - e.NOW);
    const signedValue = v.gross * r.contractedRate / r.eff * v.hair / Math.pow(1 + e.A.disc / 100, signedYears);
    return v.ev - signedValue;
  };
  const unsignedBefore = unsignedEconomicValue(rates, e.siteValue(c, s));
  assert.equal(e.signedRegionFactorOf(c, s), d.config.regions.au.rateMul);
  c.signedRegionFactor = d.config.regions.au.rateMul;
  assert.deepEqual(e.value(c), baseline, 'explicit current factor equals the implicit legacy model exactly');
  const signedBefore = rates.contractedRate;
  c.signedRegionFactor = 1;
  const normalized = e.siteRates(c, s);
  near(normalized.contractedRate, signedBefore / d.config.regions.au.rateMul);
  assert.equal(normalized.spotRate, rates.spotRate);
  assert.equal(normalized.prevailing, rates.prevailing);
  assert.equal(normalized.signedRate, rates.signedRate);
  near(unsignedEconomicValue(normalized, e.siteValue(c, s)), unsignedBefore);
  // Test unsigned-only capacity through the full value path, including future ramp.
  c.sites.push({ ...s, n: 'Unsigned future site', prov: 'rumored', yr: 2029 });
  const unsigned = e.siteValue(c, c.sites[1]);
  delete c.signedRegionFactor;
  assert.deepEqual(e.siteValue(c, c.sites[1]), unsigned, 'unsigned site EV is completely unchanged');
});

check('SHAZ normalization retains its 16.8 signed rate and changes no unrelated company', () => {
  const d = copy(data), shaz = company(d, 'SHAZ'), before = createEngine(d);
  Object.assign(before.ctx, copy(snapshot.marks));
  const originals = new Map(d.companies.map(c => [c.tk, before.value(c)]));
  assert.equal(shaz.signedRate, 16.8);
  delete shaz.signedRegionFactor; // Fixed regression fixture for the original additional discount.
  const reviewed = finding(run(d), 'SHAZ:economics:signed-rate-region');
  assert.ok(reviewed);
  assert.deepEqual(reviewed.scenario.changes.company, { signedRegionFactor: 1 });
  shaz.signedRegionFactor = 1;
  const after = createEngine(d); Object.assign(after.ctx, copy(snapshot.marks));
  near(reviewed.impact.alternative, after.value(shaz).target);
  assert.ok(reviewed.impact.pct > 25 && reviewed.impact.pct < 28, 'the original approximately 26% scenario is retained');
  assert.equal(shaz.signedRate, 16.8);
  assert.equal(finding(run(d), 'SHAZ:economics:signed-rate-region'), undefined);
  for (const c of d.companies) if (c.tk !== 'SHAZ' && c.stake?.tk !== 'SHAZ') assert.deepEqual(after.value(c), originals.get(c.tk), c.tk + ' must not change');
  // A future tracked shareholder should continue receiving the normal stake look-through.
  const holder = { ...copy(staticFixture('holdco').companies[0]), tk: 'HOLDER', stake: { tk: 'SHAZ', pct: .6 } };
  d.companies.push(holder);
  const stakeEngine = createEngine(d); Object.assign(stakeEngine.ctx, copy(snapshot.marks));
  const v = stakeEngine.value(shaz);
  near(stakeEngine.stakeValue(holder), .6 * shaz.shares / v.fundedShares * v.equityPre);
});

check('Invalid signed geography overrides fail review without changing fallback behavior', () => {
  for (const invalid of [null, undefined, 0, -1, 2.01, Infinity, NaN, '1']) {
    const d = staticFixture(), c = d.companies[0]; c.sites[0].region = 'au';
    const before = staticValue(d);
    c.signedRegionFactor = invalid;
    const result = run(d, fixtureMarks);
    assert.equal(finding(result, 'TEST:economics:signed-region-factor').severity, 'error', String(invalid));
    assert.deepEqual(staticValue(d), before, 'invalid input cannot alter valuation');
  }
  for (const model of ['landlord', 'holdco']) {
    const d = staticFixture(model); d.companies[0].signedRegionFactor = 1;
    assert.equal(finding(run(d, fixtureMarks), 'TEST:economics:signed-region-factor').severity, 'error', model);
  }
  for (const valid of [.001, 1, 2]) {
    const d = staticFixture(); d.companies[0].signedRegionFactor = valid;
    assert.equal(finding(run(d, fixtureMarks), 'TEST:economics:signed-region-factor'), undefined);
  }
});

check('Look-through concentration and claims request ownership evidence without inventing an NCI error', () => {
  const d = staticFixture('holdco'), c = d.companies[0];
  const held = { ...copy(c), tk: 'HELD', name: 'Synthetic held company', btc: 1000, plannedRaise: 200 };
  d.companies.push(held); c.stake = { tk: 'HELD', pct: .6 }; c.seniorClaims = 1;
  const id = 'TEST:funding:lookthrough-ownership', result = run(d, fixtureMarks), f = finding(result, id);
  assert.ok(f); assert.equal(f.severity, 'review');
  assert.match(f.calculation + ' ' + f.explanation, /shares|ownership/i);
  assert.match(f.calculation + ' ' + f.explanation, /claim/i);
  assert.match(f.calculation, /60m held before future issuance/);
  assert.match(f.calculation, /stake value 30m/);
  assert.equal(result.companies.find(x => x.ticker === 'TEST').tests.economics.status, 'not-applicable');
  assert.equal(result.companies.find(x => x.ticker === 'TEST').tests.funding.status, 'review');
  assert.ok(!result.findings.some(x => x.ticker === 'TEST' && x.severity === 'error'));
  // Stake is below 25% of assets, but a claim above 25% of its value still needs review.
  c.legacyEV = 200; c.seniorClaims = 10;
  assert.equal(finding(run(d, fixtureMarks), id).severity, 'review');
  c.seniorClaims = 0;
  assert.equal(finding(run(d, fixtureMarks), id), undefined);
});

check('Crypto concentration is an eligible treasury stress with unchanged senior claims', () => {
  const d = staticFixture('holdco'), c = d.companies[0], id = 'TEST:funding:treasury-claims';
  c.btc = 1000; c.legacyEV = 40; c.netDebt = 10; c.seniorClaims = 5;
  const original = staticValue(d), alternative = staticValue(d, 'TEST', fixtureMarks, e => { e.ctx.btc *= .8; e.ctx.eth *= .8; });
  const result = run(d, fixtureMarks), f = finding(result, id);
  assertImpact(f, original, alternative);
  near(alternative.claims, original.claims);
  assert.equal(result.companies[0].tests.economics.status, 'not-applicable');
  assert.ok(!result.findings.some(x => x.severity === 'error'));
  c.legacyEV = 60;
  assert.equal(finding(run(d, fixtureMarks), id), undefined, '50% is not a greater-than-50% concentration');
});

console.log(`${passes} assumption review groups passed; ${failures} failed.`);
if (failures) process.exitCode = 1;
