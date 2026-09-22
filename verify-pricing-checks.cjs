#!/usr/bin/env node
'use strict';
// Regression fixtures mutate copies only. No generated files, network or live-data writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const C = require('./checks-core.js');
const Ramp = require('./ramp-core.js');
const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'data.json'), 'utf8'));
const TODAY = new Date().toISOString().slice(0, 10);
const clone = v => structuredClone(v);
const copy = () => clone(data);
const company = (d, tk = 'CRWV') => d.companies.find(c => c.tk === tk);
const first = d => company(d).ramp.tranches.find(t => t.contract);
const index = d => company(d).ramp.tranches.indexOf(first(d));
const marketYear = d => Object.keys(d.researchPricing.curve)[0];
const tenor = d => Object.keys(d.researchPricing.curve[marketYear(d)])[0];
const check = d => C.runChecks(d, TODAY);
const finding = (r, id) => r.msgs.find(m => m.id === id);
function rejects(mutator, id) {
  const d = copy(); mutator(d);
  assert.equal(finding(check(d), id)?.level, 'fail', `missing failure ${id}`);
}
function browserChecker(rampFunction = Ramp.rampQuarters) {
  const context = { rampQuarters: rampFunction };
  context.self = context;
  for (const file of ['engine.js', 'catalyst-core.js', 'checks-core.js']) vm.runInNewContext(fs.readFileSync(path.join(__dirname, file), 'utf8'), context);  // same modules index.html loads
  return d => context.ChecksCore.runChecks(d, TODAY);
}
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('PASS ' + name); }

test('adopted pricing baseline has zero data failures', () => {
  assert.ok(data.researchPricing);
  assert.equal(data.companies.filter(c => c.ramp?.pricing).length, 3);
  const result = check(data);
  assert.equal(result.summary.fail, 0, JSON.stringify(result.msgs.filter(m => m.level === 'fail')));
});

test('missing shared policy fails explicitly instead of silently using old math', () => {
  rejects(d => { delete d.researchPricing; }, 'pricing|—|market.missing');
});

test('every contract market price is finite, numeric and positive', () => {
  for (const bad of [0, -1, NaN, Infinity, '20']) {
    const d = copy(), y = marketYear(d), t = tenor(d);
    d.researchPricing.curve[y][t] = bad;
    assert.equal(finding(check(d), `pricing|—|market.curve.${y}.${t}.rate`)?.level, 'fail');
  }
  rejects(d => { d.researchPricing.curve = {}; }, 'pricing|—|market.curve.empty');
});

test('market dates and source observation dates are real calendar dates', () => {
  rejects(d => { d.researchPricing.asOf = '2026-02-30'; }, 'pricing|—|market.asOf.date');
  rejects(d => { d.researchPricing.effectiveQ = '2026Q5'; }, 'pricing|—|market.effectiveQ');
  rejects(d => { d.researchPricing.sources[0].date = '2026-02-30'; }, 'pricing|—|market.sources.0.date.date');
  const tomorrow = new Date(Date.parse(TODAY + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
  rejects(d => { d.researchPricing.asOf = tomorrow; }, 'pricing|—|market.asOf.future');
});

test('missing sources and undocumented market assumptions cannot pass', () => {
  rejects(d => { d.researchPricing.sources = []; }, 'pricing|—|market.sources');
  rejects(d => { d.researchPricing.sources[0] = { url: 'not a URL' }; }, 'pricing|—|market.sources');
  rejects(d => { d.researchPricing.basis = ''; }, 'pricing|—|market.basis');
});

test('generation conversion and software premiums are explicit', () => {
  rejects(d => { d.researchPricing.generationFactors.hopper = NaN; }, 'pricing|—|market.generation.hopper');
  rejects(d => { d.researchPricing.softwarePremium = 0.1; }, 'pricing|—|market.softwarePremium');
  rejects(d => { company(d).ramp.pricing.softwarePremium = 0.1; }, 'pricing|CRWV|policy.softwarePremium');
});

test('renewals require finite retention, a quarter-aligned term and existing-hardware prices', () => {
  rejects(d => { d.researchPricing.renewal.retention = 1.1; }, 'pricing|—|market.renewal.retention');
  rejects(d => { d.researchPricing.renewal.retention = NaN; }, 'pricing|—|market.renewal.retention');
  rejects(d => { d.researchPricing.renewal.termYears = 2.53; }, 'pricing|—|market.renewal.term');
  rejects(d => { d.researchPricing.renewal.rateMode = 'market'; }, 'pricing|—|market.renewal.mode');
  rejects(d => { d.researchPricing.renewal.rateMultiplier = -1; }, 'pricing|—|market.renewal.multiplier');
});

test('shared spot prices have units and finite positive rates', () => {
  rejects(d => { d.researchPricing.spot.basis = 'MW'; }, 'pricing|—|market.spot.basis');
  rejects(d => { d.researchPricing.spot.rates['2027'] = Infinity; }, 'pricing|—|market.spot.rates');
});

test('an exclusive expiry must follow first revenue', () => {
  const i = index(data);
  rejects(d => { first(d).contract.endQ = first(d).rev; }, `pricing|CRWV|tranche.${i}.expiryOrder`);
  rejects(d => { first(d).contract.endQ = '2030Q0'; }, `pricing|CRWV|tranche.${i}.endQ`);
  rejects(d => { first(d).contract.termYears = 0; }, `pricing|CRWV|tranche.${i}.term`);
});

test('estimated expiry cannot contradict its own stated term', () => {
  const i = index(data);
  rejects(d => { first(d).contract.endQ = Ramp.RAMP_QL(Ramp.RAMP_QS(first(d).contract.endQ) + 1); }, `pricing|CRWV|tranche.${i}.expiryTerm`);
});

test('source, price, expiry and commitment provenance are mandatory', () => {
  const i = index(data);
  for (const field of ['expiryBasis', 'priceBasis', 'commitmentBasis']) {
    rejects(d => { delete first(d).contract[field]; }, `pricing|CRWV|tranche.${i}.${field}`);
  }
  rejects(d => { first(d).contract.source = ''; }, `pricing|CRWV|tranche.${i}.source`);
  rejects(d => { first(d).contract.note = ''; }, `pricing|CRWV|tranche.${i}.source`);
});

test('contract metadata cannot secretly change the economic signed share', () => {
  const i = index(data);
  rejects(d => { first(d).contract.signedShare = 0.75; }, `pricing|CRWV|tranche.${i}.signedShare`);
});

test('only documented unmapped future allocations may move from the old book to the market curve', () => {
  const d = copy(), c = company(d);
  d.researchPricing.allocationCutoffQ = '2027Q1';
  const t = c.ramp.tranches.find(x => x.energize >= '2027Q1' && x.signed > 0 && x.contract?.commitmentBasis === 'assumed');
  assert.ok(t, 'future assumed-coverage fixture missing');
  const i = c.ramp.tranches.indexOf(t), id = `pricing|CRWV|tranche.${i}.signedShare`;
  t.contract.signedShare = 0;t.contract.allocationBasis = 'unmapped-future';
  t.newBusiness = { termYears: 3, priceBasis: 'assumed' };
  assert.equal(finding(check(d), id), undefined);
  t.contract.commitmentBasis = 'disclosed';
  assert.equal(finding(check(d), id)?.level, 'fail');
  t.contract.commitmentBasis = 'assumed';delete t.contract.allocationBasis;
  assert.equal(finding(check(d), id)?.level, 'fail');
  t.contract.allocationBasis = 'unmapped-future';t.energize = '2026Q4';
  assert.equal(finding(check(d), id)?.level, 'fail');
});

test('a reclassified future allocation must carry new-business assumptions', () => {
  const d = copy(), c = company(d);
  d.researchPricing.allocationCutoffQ = '2027Q1';
  const t = c.ramp.tranches.find(x => x.energize >= '2027Q1' && x.signed > 0 && x.contract?.commitmentBasis === 'assumed');
  const i = c.ramp.tranches.indexOf(t);
  t.contract.signedShare = 0;t.contract.allocationBasis = 'unmapped-future';delete t.newBusiness;
  assert.equal(finding(check(d), `pricing|CRWV|tranche.${i}.newBusiness`)?.level, 'fail');
});

test('missing commercial maps are grouped into at most two warnings per company', () => {
  const result = check(data);
  for (const tk of ['CRWV', 'IREN', 'NBIS']) {
    const warnings = result.msgs.filter(m => m.group === 'pricing' && m.tk === tk && m.level === 'warn');
    assert.ok(warnings.length > 0 && warnings.length <= 2);
    assert.ok(warnings.every(m => ['mapping.assumptions', 'commitment.assumptions'].some(rule => m.id.endsWith(rule))));
  }
});

test('quarterly cohort aggregation detects corrupted canonical output', () => {
  const corrupted = browserChecker((...args) => Ramp.rampQuarters(...args).map(q => q.revExisting == null ? q : { ...q, revC: q.revC + 1 }));
  const result = corrupted(data);
  assert.ok(result.msgs.some(m => m.group === 'pricing' && m.id?.endsWith('.revenue') && m.level === 'fail'));
});

test('signed-revenue guard detects assumed renewals masquerading as commitments', () => {
  const corrupted = browserChecker((...args) => Ramp.rampQuarters(...args).map(q => q.revExisting == null ? q : { ...q, revS: q.revS + 1 }));
  const result = corrupted(data);
  assert.ok(result.msgs.some(m => m.group === 'pricing' && m.id?.endsWith('.signed') && m.level === 'fail'));
});

test('scenario guard tests the full quarterly path when terminal revenue is unchanged', () => {
  const d = copy(); company(d).ramp.checkPathProbe = true;
  company(d).ramp.scenarios = [
    { id: 'base', d: {} },
    { id: 'early', d: { earlyRevenueStress: true } },
    { id: 'joint', d: { jointRevenueStress: true } }
  ];
  const probe = browserChecker((R, sc, ...rest) => Ramp.rampQuarters(R, sc, ...rest).map(q => {
    if (!R.checkPathProbe) return q;
    if (sc?.d?.jointRevenueStress) return { ...q, rev: q.rev * 0.75 };
    if (sc?.d?.earlyRevenueStress && q.s < 12) return { ...q, rev: q.rev * 0.9 };
    return q;
  }));
  const result = probe(d);
  assert.equal(finding(result, 'ramp|CRWV|scenario.early.noEffect'), undefined);
  assert.equal(finding(result, 'ramp|CRWV|scenario.joint.order'), undefined);
  company(d).ramp.scenarios[1].d = {};
  assert.equal(finding(probe(d), 'ramp|CRWV|scenario.early.noEffect')?.level, 'fail');
});

test('browser and Node checks agree using the same canonical engine', () => {
  const node = check(data), browser = browserChecker()(data);
  assert.deepEqual(JSON.parse(JSON.stringify(browser.summary)), node.summary);
  assert.deepEqual(JSON.parse(JSON.stringify(browser.msgs)), JSON.parse(JSON.stringify(node.msgs)));
});

console.log(`Research pricing check regressions: ${passed} passed.`);
