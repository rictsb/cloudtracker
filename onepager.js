#!/usr/bin/env node
/* Research one-pager generator (spec §6d–6e).
   node onepager.js <TK>            writes <tk>.html from onepager-template.html + the name's `page` and `ramp` blocks in data.json
   node onepager.js <TK> --check    prints the tie-out and the year-end columns, writes nothing
   node onepager.js <TK> --sens     prints the standard sensitivities
   node onepager.js <TK> --artifact <path>   also writes a self-contained copy without the html wrapper, config.js and the tracker link
   The math lives in ramp-core.js (build-out) and onepager-core.js (waterfall, tie-out); this file only assembles data and fills the template. */
const fs = require('fs'), path = require('path');
const ROOT = __dirname;
const RC = require('./ramp-core.js'), OP = require('./onepager-core.js');
/* assemble(c): the page's data series for one company record {page, ramp} — used by the CLI below and by any draft script */
function assemble(c) {
  const pg = c.page, R = c.ramp;
  const QS = RC.RAMP_QS, F = pg.finance;
  const r1 = n => Math.round(n * 10) / 10, r2 = n => Math.round(n * 100) / 100;

  /* ---- series from the ramp (never typed) ---- */
  const S0 = pg.fromQ != null ? QS(pg.fromQ) : -2, S1 = pg.toQ != null ? QS(pg.toQ) : RC.RAMP_END;
  const QQ = RC.rampQuarters(R, null, S0, S1);
  const T0 = QS(F.T0 || '2026Q3');
  const Q = QQ.filter(q => q.s >= T0).map(q => [q.lbl, r1(q.rev), r1(q.revC), r1(q.revS), Math.round(q.itMW), Math.round(q.grossMW), Math.round(q.cum),
    { hopper: Math.round(q.by.hopper), blackwell: Math.round(q.by.blackwell), rubin: Math.round(q.by.rubin), next: Math.round(q.by.next) }]);
  const prints = Object.assign({}, Object.fromEntries(Object.entries(R.actuals || {}).map(([k, v]) => [k, v.aiRevM])), pg.prints || {});
  const L = QQ.map(q => {
    const s = q.s, gi = R.tranches.filter(t => QS(t.energize) <= s).reduce((a, t) => a + t.gpus, 0);
    const vt = R.tranches.filter(t => QS(t.energize) === s), vint = vt.length ? r1(vt.reduce((a, t) => a + t.rate * t.gpus * 8.76, 0) / vt.reduce((a, t) => a + t.itMW, 0) / 1000) : null;
    const cons = (R.consensus || {})[q.lbl];
    return [q.lbl, Math.round(q.grossMW), Math.round(q.itCom), r1(q.itMW), gi, Math.round(q.cum), Math.round(q.signed), r1(q.rev), r1(q.revC), r1(q.revS), r2(q.blend), vint,
      prints[q.lbl] != null ? prints[q.lbl] : null, cons ? cons[1] : null];
  });
  /* contracted ARR on the company's definition: contracted GPUs on energised capacity x rate x 8,760 h; spot excluded */
  const A = QQ.map(q => { const tr = R.tranches.filter(t => QS(t.energize) <= q.s);
    return [q.lbl, r2(tr.reduce((a, t) => a + t.ctr * t.gpus * t.rate * 8760, 0) / 1e9), r2(tr.reduce((a, t) => a + (t.signed || 0) * t.gpus * t.rate * 8760, 0) / 1e9)]; });
  const ARRC = Object.fromEntries(A.map(r => [r[0], r[1]]));
  /* site phasing: an override in page.gantt, else one row per campus from the tranches */
  const gantt = pg.gantt || (() => { const by = {}; R.tranches.forEach(t => { (by[t.campus] = by[t.campus] || []).push([t.n, t.itMW, t.energize, t.rev, t.rampQtrs, (t.signed || 0) > 0 ? 1 : 0]); });
    return Object.entries(by).map(([campus, rows]) => [campus, R.tranches.filter(t => t.campus === campus).reduce((a, t) => a + t.grossMW, 0), rows, null]); })();
  /* capex by energisation quarter: an override in page.capexQ (verified numbers), else rules per generation and build type */
  const CAPQ = pg.capexQ || (() => { const out = {}, ru = pg.capexRules; R.tranches.forEach(t => { const air = /air|retrofit/i.test(t.n) || (t.air === true); const g = (ru.gpu[air ? t.gen + '-air' : t.gen] || ru.gpu[t.gen]) * (ru.inflate[t.energize.slice(0, 4)] || 1);
    const sh = t.shellPerMW != null ? t.shellPerMW : (air ? ru.shell.air : ru.shell.liquid); const o = out[t.energize] = out[t.energize] || [0, 0]; o[0] += Math.round(g * t.itMW); o[1] += Math.round(sh * t.itMW); }); return out; })();
  const rr = L[L.length - 1][7] * 4 / 1000, year = L[L.length - 1][0].slice(0, 4);
  const W = OP.waterfall(L, CAPQ, F, ARRC);
  return { Q, L, A, ARRC, gantt, CAPQ, rr, year, W, F, pg, R };
}
module.exports = { assemble };
if (require.main === module) {
const args = process.argv.slice(2), tk = (args[0] || '').toUpperCase();
if (!tk) { console.error('usage: node onepager.js <TK> [--check] [--sens] [--artifact <path>]'); process.exit(1); }
const flag = f => args.includes(f), argOf = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8'));
const c = d.companies.find(x => x.tk === tk); if (!c) { console.error('no such company: ' + tk); process.exit(1); }
if (!c.page || !c.ramp) { console.error(tk + ' needs both a page block and a ramp block in data.json'); process.exit(1); }
const { Q, L, A, ARRC, gantt, CAPQ, rr, year, W, F, pg, R } = assemble(c);
if (flag('--check')) {
  const f = n => n.toFixed(1);
  console.log(`${tk} ${pg.asOf} — base $${W.ps.toFixed(0)} per share · ${year} run-rate $${rr.toFixed(1)}bn × ${F.MULT} = EV $${W.ev.toFixed(0)}bn · net debt ex converts $${f(W.last.nd)}bn · prepayments owed at PV $${f(W.liab)}bn · diluted ${W.dil.toFixed(0)}m (${F.SH0}m + ${W.issued.toFixed(0)}m issued for $${f(W.eqTot)}bn at $${F.EQ_PX} + ${W.convSh.toFixed(0)}m converts − ${F.FWD || 0}m forwards) · ${year} EPS $${((W.pl.ni * 1000 + W.addb) / W.dil).toFixed(2)}`);
  W.C.filter(x => x.ye && x.r).forEach(x => console.log(`  ${x.q}  rev ${x.rev.toFixed(0)}  ebitda ${x.eb.toFixed(0)}  capex ${x.capex}  pre ${x.r.pre.toFixed(0)}  cred ${x.r.cred.toFixed(0)}  eq ${x.r.eq.toFixed(0)}  draw ${x.r.draw.toFixed(0)}  debt ${f(x.r.debt)}  cash ${f(x.r.cash)}  nd ${f(x.r.nd)}  owed ${f(x.r.owed)}  sh ${x.r.sh.toFixed(0)}  ni ${x.r.ni.toFixed(0)}  eps ${x.epsYE != null ? x.epsYE.toFixed(2) : ''}`));
  const bt = RC.rampBacktest(R); if (bt) console.log(`  backtest MAPE ${bt.mape.toFixed(4)}% · contracted ARR ${year}Q4 $${ARRC[L[L.length - 1][0]]}bn · Q rows ${Q.length} · L rows ${L.length}`);
}
if (flag('--sens')) OP.sensitivities(L, CAPQ, F, ARRC, pg.px.v).forEach(x => console.log(`  ${x.name.padEnd(52)} $${x.ps.toFixed(0).padStart(4)}  ${(x.delta >= 0 ? '+' : '') + x.delta.toFixed(0)}`));
if (flag('--check') || flag('--sens')) process.exit(0);

/* ---- fill the template ---- */
const P = { tk, name: c.name, asOf: pg.asOf, kicker: pg.kicker, title: pg.title, sub: pg.sub, px: pg.px, evArr: pg.evArr, arrLabel: pg.arrLabel, capacity: pg.capacity, gantt, Q, A, L, CAPQ, ARRC,
  fund: pg.fund, bridge: pg.bridge, steady: pg.steady, finance: F, labels: pg.labels || {}, rr, year, gpuMax: Math.ceil(Q[Q.length - 1][6] / 250000) * 250000, arrMax: Math.ceil(A[A.length - 1][1] / 15) * 15, hero: pg.hero };
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const fmtK = n => n >= 1e6 ? (n / 1e6).toFixed(2) + 'm' : Math.round(n / 1000) + 'k';
const tpl = fs.readFileSync(path.join(ROOT, 'onepager-template.html'), 'utf8');
const core = fs.readFileSync(path.join(ROOT, 'onepager-core.js'), 'utf8');
const notes = (pg.notes || []).map(sec => sec.map(n => '      <div class="note">' + n + '</div>').join('\n'));
const folds = (pg.arr.folds || []).map(fd => '      <details class="fold">\n        <summary><span class="k">' + fd.summary[0] + '</span><span>' + fd.summary[1] + '</span></summary>\n        <div class="ledger">\n' + fd.rows.map(r => '          <span class="k">' + r[0] + '</span><span>' + r[1] + '</span>').join('\n') + '\n        </div>\n      </details>').join('\n');
const tiles = (pg.tiles || []).map(t => '      <div class="tile"><div class="l">' + t[0] + '</div><div class="v">' + t[1] + '</div><div class="n">' + t[2] + '</div></div>').join('\n');
const facts = (pg.facts || []).map(f => '    <div class="fact"><span class="l">' + f[0] + '</span><span class="v">' + f[1] + '</span><span class="n">' + f[2] + '</span></div>').join('\n');
const dateLong = new Date(pg.asOf + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const fill = (html, artifact) => html
  .replace('__TITLE__', esc(c.name) + ' Value Path').replace('__KICKER__', pg.kicker + ' · ' + dateLong).replace('__H1__', pg.title).replace('__SUB__', pg.sub)
  .replace('__PXNOTE__', pg.px.note).replace('__FACTS__', facts)
  .replace('__HERO1V__', pg.hero.power[0]).replace('__HERO1U__', pg.hero.power[1])
  .replace('__HERO2V__', fmtK(Q[Q.length - 1][6])).replace('__HERO2U__', 'GPUs commissioned by end-' + year)
  .replace('__HERO3V__', '$' + A[A.length - 1][1].toFixed(1) + 'bn').replace('__HERO3U__', 'contracted ARR · end-' + year)
  .replace('__HERO4V__', pg.hero.capex[0]).replace('__HERO4U__', pg.hero.capex[1])
  .replace('__HERO5V__', '$' + F.MULT.toFixed(2)).replace('__HERO5U__', 'what $1 of ARR is worth')
  .replace('__FOLDS__', folds).replace('__ARRCAP__', pg.arr.cap).replace('__TILES__', tiles).replace('__FUNDCAP__', pg.fund.cap).replace('__BRIDGECAP__', pg.bridge.cap)
  .replace('__VALUECAP__', '$ per share · by pricing and maintenance regime · ' + W.dil.toFixed(0) + 'm diluted shares after a $' + W.eqTot.toFixed(1) + 'bn raise at $' + F.EQ_PX + ' and the converts, $' + W.last.nd.toFixed(0) + 'bn net debt, $' + W.liab.toFixed(0) + 'bn of prepayments owed')
  .replace(/__NOTES_(\d)__/g, (m, i) => notes[+i - 1] || '')
  .replace('__FOOT_SOURCES__', pg.footer.sources).replace('__FOOT_MODEL__', pg.footer.model)
  .replace('__FOOT_SNAPSHOT__', 'This page is a dated cut of the tracker’s ' + tk + ' ramp as of ' + dateLong + ' and does not update with the model; the live model, scenarios and backtest are on the ' + (artifact ? 'tracker’s GPU RAMP tab' : '<a href="/">tracker’s GPU RAMP tab</a>') + '. <b>Not advice.</b> A first-principles model of what the assets earn — not a price target.')
  .replace('__CONFIG__', artifact ? '' : '<script src="config.js"></script>')
  .replace('__TK__', tk)
  .replace('__SHELLDEBT__', (pg.labels && pg.labels.shellDebt) || 'data-centre debt')
  .replace('/*__CORE__*/', () => core)
  .replace('__PAGE__', () => JSON.stringify(P).replace(/<\//g, '<\\/'));
let out = fill(tpl, false);
fs.writeFileSync(path.join(ROOT, tk.toLowerCase() + '.html'), out);
console.log(`wrote ${tk.toLowerCase()}.html — base $${W.ps.toFixed(0)} · ${out.length.toLocaleString()} bytes`);
const art = argOf('--artifact');
if (art) { let a = fill(tpl, true); a = a.replace(/^[\s\S]*?<title>/, '<title>').replace(/<\/head>\s*<body>/, '').replace(/<\/body>\s*<\/html>\s*$/, ''); fs.writeFileSync(art, a); console.log('wrote artifact copy ' + art); }
}
