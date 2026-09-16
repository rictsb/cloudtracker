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
  assert.ok(base.findings.length < 120, 'grouped company findings, not a flag for every tranche');
});

check('Analysis leaves recursively frozen model and quote inputs untouched', () => {
  const d = freeze(copy(data)), p = freeze(copy(snapshot)), before = JSON.stringify([d, p]);
  run(d, p);
  assert.equal(JSON.stringify([d, p]), before);
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

console.log(`${passes} assumption review groups passed; ${failures} failed.`);
if (failures) process.exitCode = 1;
