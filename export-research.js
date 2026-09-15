#!/usr/bin/env node
/* Research report-data generator (research-destinations spec, section (a)).
   node export-research.js <TK> [--out <dir>]      writes <tk>-data.json — the exact template payload P of onepager.js
                                                   extended with the narrative blocks the template consumed separately
                                                   (facts, tiles, notes, arr{folds,cap}, footer{sources,model}, capexBasis, prints)
   node export-research.js --compare [--out <dir>] writes compare-data.json — data.json's compare block verbatim + a generator stamp
   All math lives in ramp-core.js and onepager-core.js via onepager.js's assemble(); this file only shapes and writes JSON.
   Resolution: CT_ROOT env var, else this file's own directory (its production home is the repo root). */
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = process.env.CT_ROOT || __dirname;
const { assemble } = require(path.join(ROOT, 'onepager.js'));
const RC = require(path.join(ROOT, 'ramp-core.js'));   /* same instances onepager.js uses (require cache); */
const OP = require(path.join(ROOT, 'onepager-core.js')); /* required here so a missing math file fails fast and loudly */

function readData() { return JSON.parse(fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8')); }

/* buildPayload(tk[, dataObj]) — the report-data payload for one name.
   Exactly the P object literal of onepager.js (template payload, construction order = serialization order),
   then the narrative extension. Throws (nothing written) when the name lacks a page or ramp block. */
function buildPayload(tk, dataObj) {
  tk = String(tk).toUpperCase();
  const d = dataObj || readData();
  const c = (d.companies || []).find(x => x.tk === tk);
  if (!c) throw new Error('no such company: ' + tk);
  if (!c.page || !c.ramp) throw new Error(tk + ' needs both a page block and a ramp block in data.json');
  const { Q, L, A, ARRC, gantt, CAPQ, rr, year, F, pg, R, pricing } = assemble(c, d.researchPricing);
  /* ---- the P payload, verbatim from onepager.js ---- */
  const P = { tk, name: c.name, asOf: pg.asOf, kicker: pg.kicker, title: pg.title, sub: pg.sub, px: pg.px, evArr: pg.evArr, arrLabel: pg.arrLabel, capacity: pg.capacity, gantt, Q, A, L, CAPQ, ARRC,
    fund: pg.fund, bridge: pg.bridge, steady: pg.steady, finance: F, labels: pg.labels || {}, rr, year, gpuMax: Math.ceil(Q[Q.length - 1][6] / 250000) * 250000, arrMax: Math.ceil(A[A.length - 1][1] / 15) * 15, hero: pg.hero };
  /* ---- narrative extension: the blocks onepager.js injected into the template outside P ---- */
  P.facts = pg.facts || [];
  P.tiles = pg.tiles || [];
  P.notes = pg.notes || [];
  P.arr = { folds: (pg.arr && pg.arr.folds) || [], cap: pg.arr && pg.arr.cap };
  P.footer = { sources: pg.footer && pg.footer.sources, model: pg.footer && pg.footer.model };
  if (pg.capexBasis != null) P.capexBasis = pg.capexBasis;
  /* merged actuals, exactly as assemble()'s internal `prints` const (onepager.js): ramp actuals overlaid with page prints */
  P.prints = Object.assign({}, Object.fromEntries(Object.entries(R.actuals || {}).map(([k, v]) => [k, v.aiRevM])), pg.prints || {});
  if (pricing) {
    P.modelAsOf = pg.modelAsOf;
    P.pricing = pricing;
    P.pricing.sensitivities = R.scenarios.map(s => {
      const a = assemble(c, d.researchPricing, s);
      return { id:s.id,label:s.name,valuePerShare:a.W.ps,runRateBn:a.rr,multiple:a.F.MULT,note:s.note };
    });
  }
  return P;
}

/* buildCompare([dataObj]) — data.json's compare block verbatim, plus a generator stamp. */
function buildCompare(dataObj) {
  const d = dataObj || readData();
  if (!d.compare) throw new Error('data.json has no compare block');
  return Object.assign({}, d.compare, { generatedBy: 'export-research.js' });
}

module.exports = { buildPayload, buildCompare };

if (require.main === module) {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const outDir = outIdx >= 0 ? args[outIdx + 1] : ROOT;
  if (outIdx >= 0 && (!outDir || outDir.startsWith('--'))) { console.error('--out needs a directory'); process.exit(1); }
  // Write-target guard: when CT_ROOT points at another repo (development mode), an explicit --out
  // is REQUIRED — the default-out-to-ROOT convenience is for the script's own repo only, so a dev
  // run can never silently write generated files into the source repo.
  if (process.env.CT_ROOT && path.resolve(process.env.CT_ROOT) !== path.resolve(__dirname) && outIdx < 0) {
    console.error('CT_ROOT points outside this script’s repo — pass --out <dir> explicitly (refusing to write into ' + ROOT + ')');
    process.exit(1);
  }
  const pos = args.filter((a, i) => !a.startsWith('--') && (outIdx < 0 || i !== outIdx + 1));
  const write = (name, obj) => { const p = path.join(outDir, name); fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n'); return p; };
  try {
    if (args.includes('--compare')) {
      const cmp = buildCompare();
      const p = write('compare-data.json', cmp);
      console.log(`wrote ${p} — compare block as of ${cmp.asOf}`);
    } else if (pos[0]) {
      const P = buildPayload(pos[0]);
      /* base from the payload's own series — the same call the client view makes, mirroring the --check tie-out */
      const W = OP.waterfall(P.L, P.CAPQ, P.finance, P.ARRC);
      const p = write(P.tk.toLowerCase() + '-data.json', P);
      console.log(`wrote ${p} — base $${W.ps.toFixed(2)} per share · ${P.year} run-rate $${P.rr.toFixed(1)}bn × ${P.finance.MULT} · diluted ${W.dil.toFixed(0)}m`);
    } else {
      console.error('usage: node export-research.js <TK> [--out <dir>] | node export-research.js --compare [--out <dir>]');
      process.exit(1);
    }
  } catch (e) { console.error(e.message); process.exit(1); }
}
