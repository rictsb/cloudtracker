#!/usr/bin/env node
/* Data unit tests for data.json — run `node checks.js` (exit 1 on FAIL).
   Deterministic/offline checks only. Research-dependent checks (FD shares vs
   filings, new issuance, contract announcements, GPU spot pricing) run in the
   weekly scheduled sweep — see WIKI "Keeping it current". */
const fs = require('fs');
const d = JSON.parse(fs.readFileSync(__dirname + '/data.json', 'utf8'));
const cfg = d.config, cos = d.companies;
const NOWY = cfg.referenceYear + ((cfg.referenceMonth || 1) - 1) / 12;

let fails = 0, warns = 0;
const FAIL = (m) => { fails++; console.log('  FAIL  ' + m); };
const WARN = (m) => { warns++; console.log('  warn  ' + m); };

console.log('== config ==');
{
  const dials = ['rate','margin','multiple','capRate','disc','ramp','rateTrend','dilutionStress'];
  dials.forEach(k => { if (!(k in cfg.dials)) FAIL(`config.dials missing ${k}`); });
  const sk = (cfg.sliders || []).map(s => s.k);
  dials.forEach(k => { if (!sk.includes(k)) FAIL(`no slider for dial ${k}`); });
  sk.forEach(k => { if (!(k in cfg.dials)) FAIL(`slider ${k} has no dial`); });
  ['disclosed','estimated','rumored'].forEach(p => { if (!cfg.provenance[p]) FAIL(`provenance missing ${p}`); });
  Object.entries(cfg.regions).forEach(([k, r]) => { if (typeof r.rateMul !== 'number') FAIL(`region ${k} missing rateMul`); });
  if ('contractRate' in cfg.constants) FAIL('dead constant contractRate present');
  if (!cfg.btcFallback || !cfg.ethFallback) WARN('btcFallback/ethFallback missing');
}

console.log('== companies ==');
const tks = cos.map(c => c.tk);
if (new Set(tks).size !== tks.length) FAIL('duplicate tickers');
const REG = Object.keys(cfg.regions), PROV = ['disclosed','estimated','rumored'];
const DEAD = ['renewalProb','costOfDebt','legacyExBtc','confidence','dataGaps'];

for (const c of cos) {
  const id = c.tk, holdco = c.model === 'holdco';
  // -- schema / types
  for (const k of ['tk','name','model','tier','contractedPct','netDebt','shares','price','sites'])
    if (c[k] === undefined) FAIL(`${id}: missing ${k}`);
  if (!['owner','landlord','hybrid','holdco'].includes(c.model)) FAIL(`${id}: bad model ${c.model}`);
  if (!['proven','ig','ig-reit'].includes(c.tier)) FAIL(`${id}: bad tier ${c.tier}`);
  DEAD.forEach(k => { if (k in c) FAIL(`${id}: dead field ${k}`); });
  // -- capital structure sanity
  if (!(c.shares > 0)) FAIL(`${id}: shares must be > 0`);
  if (!(c.price > 0)) FAIL(`${id}: price must be > 0`);
  if (Math.abs(c.netDebt) > 60000) FAIL(`${id}: netDebt ${c.netDebt} implausible`);
  if (c.contractedPct < 0 || c.contractedPct > 100) FAIL(`${id}: contractedPct out of range`);
  if (c.equityDiscount && (c.equityDiscount < 0 || c.equityDiscount > 0.5)) FAIL(`${id}: equityDiscount out of range`);
  if ((c.plannedRaise || 0) < 0) FAIL(`${id}: negative plannedRaise`);
  if ((c.plannedRaise || 0) > c.shares * c.price * 3) WARN(`${id}: plannedRaise ${c.plannedRaise} > 3x market cap — check`);
  // -- judgement inputs need a basis
  const bz = c.basis || {};
  if ((c.plannedRaise || 0) > 0 && !bz.plannedRaise) FAIL(`${id}: plannedRaise without basis`);
  if (c.tier !== 'proven' && !bz.tier) FAIL(`${id}: non-Proven tier without basis`);
  if ((c.equityDiscount || 0) > 0 && !bz.equityDiscount) FAIL(`${id}: equityDiscount without basis`);
  // -- narrative layer
  if (!c.thesis) WARN(`${id}: no thesis`);
  else { const n = (c.thesis.match(/[.!?](\s|$)/g) || []).length; if (n > 3) WARN(`${id}: thesis ${n} sentences (max 3)`); }
  if (!c.narrative) FAIL(`${id}: no narrative`);
  // -- freshness (log recency as proxy for last verification)
  const logs = (c.log || []).map(e => e.d).sort();
  if (!logs.length) WARN(`${id}: empty developments log`);
  // -- holdco vs operating shape
  if (holdco) {
    if ((c.sites || []).length) FAIL(`${id}: holdco must have no sites`);
    if (!c.stake && !c.btc && !c.eth && !(c.legacyEV > 0)) FAIL(`${id}: holdco with no stake/treasury/legacy`);
  } else {
    if (!(c.sites || []).length) FAIL(`${id}: operating company with no sites`);
    if (c.model !== 'landlord' && !(c.termYrs > 0)) FAIL(`${id}: owner/hybrid needs termYrs > 0`);
    if (c.model === 'landlord' && !(c.mtm > 0 && c.mtm <= 1.3)) FAIL(`${id}: landlord mtm out of range`);
  }
  // -- stake integrity
  if (c.stake) {
    if (!tks.includes(c.stake.tk)) FAIL(`${id}: stake target ${c.stake.tk} not tracked`);
    if (c.stake.tk === c.tk) FAIL(`${id}: self-stake`);
    if (!(c.stake.pct > 0 && c.stake.pct <= 1)) FAIL(`${id}: stake pct ${c.stake.pct} out of (0,1]`);
    const t = cos.find(x => x.tk === c.stake.tk);
    if (t && t.stake && t.stake.tk === c.tk) FAIL(`${id}: circular stake with ${c.stake.tk}`);
  }
  // -- sites: schedule, phasing, provenance
  const names = new Set();
  for (const s of (c.sites || [])) {
    const sid = `${id}/${s.n}`;
    if (names.has(s.n)) FAIL(`${sid}: duplicate site name`); names.add(s.n);
    if (!(s.mw > 0)) FAIL(`${sid}: mw must be > 0`);
    if (s.mw > 800) WARN(`${sid}: ${s.mw}MW single row — decompose by rollout (max ~800)`);
    if (!REG.includes(s.region)) FAIL(`${sid}: bad region ${s.region}`);
    if (!PROV.includes(s.prov)) FAIL(`${sid}: bad prov ${s.prov}`);
    if (typeof s.owned !== 'boolean') FAIL(`${sid}: owned must be boolean`);
    if (!(s.yr >= 2024 && s.yr <= 2032)) FAIL(`${sid}: yr ${s.yr} outside 2024-2032`);
    if (!(s.mo >= 1 && s.mo <= 12)) FAIL(`${sid}: mo ${s.mo} invalid`);
    const t = s.yr + (s.mo - 1) / 12;
    if (t < NOWY - 0.5 && s.prov !== 'disclosed') WARN(`${sid}: energized in the past but prov=${s.prov} (past capacity should be disclosed)`);
    if (s.yr >= 2031 && s.prov === 'disclosed') WARN(`${sid}: 2031+ but disclosed — really under construction/secured?`);
  }
  // -- contracted% vs book shape
  const mw = (c.sites || []).reduce((a, s) => a + s.mw, 0);
  const rumMW = (c.sites || []).filter(s => s.prov === 'rumored').reduce((a, s) => a + s.mw, 0);
  if (!holdco && c.contractedPct >= 80 && rumMW / (mw || 1) > 0.5)
    WARN(`${id}: ${c.contractedPct}% contracted but ${(rumMW / mw * 100).toFixed(0)}% of MW rumored — consistent?`);
  if (!holdco && c.contractedPct <= 5 && (c.sites || []).every(s => s.prov === 'disclosed') && mw > 500)
    WARN(`${id}: ~0% contracted yet all-disclosed ${mw}MW — lease-up risk carried only by contractedPct`);
}

console.log(`\n${cos.length} companies, ${cos.reduce((a, c) => a + (c.sites || []).length, 0)} sites checked — ${fails} FAIL, ${warns} warn`);
process.exit(fails ? 1 : 0);
