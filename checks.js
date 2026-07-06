#!/usr/bin/env node
/* Data unit tests for data.json + the portfolio ledger — run `node checks.js` (exit 1 on FAIL).
   Thin CLI wrapper around checks-core.js — the SAME checks the site's
   "Checks" tab runs live in the browser on every load. */
const fs = require('fs');
const { runChecks } = require('./checks-core.js');
const d = JSON.parse(fs.readFileSync(__dirname + '/data.json', 'utf8'));
let pf = null;
try {
  pf = { portfolio: JSON.parse(fs.readFileSync(__dirname + '/portfolio.json', 'utf8')),
         history: JSON.parse(fs.readFileSync(__dirname + '/portfolio-history.json', 'utf8')) };
} catch (e) { /* portfolio files optional — checks run without the port group */ }
const r = runChecks(d, undefined, pf);

let g = null;
for (const m of r.msgs) {
  if (m.group !== g) { g = m.group; console.log(`== ${r.groups[g].name} ==`); }
  console.log(`  ${m.level === 'fail' ? 'FAIL ' : 'warn '} ${m.tk === '—' ? '' : m.tk + ': '}${m.msg}`);
}
console.log(`\n${r.summary.companies} companies, ${r.summary.sites} sites, ${r.summary.checksRun} checks — ${r.summary.fail} FAIL, ${r.summary.warn} warn`);
process.exit(r.summary.fail ? 1 : 0);
