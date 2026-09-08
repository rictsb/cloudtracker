#!/usr/bin/env node
/* The three-way comparison page (spec §6f).
   node compare.js                 writes compare.html from the `compare` block in data.json and the three names' page + ramp blocks
   node compare.js --artifact <path>   also writes a self-contained copy without the html wrapper and the tracker link
   Every number on the page is computed by onepager.js assemble() from the same blocks the one-pagers use; this file only lays them out. */
const fs = require('fs'), path = require('path');
const { assemble } = require('./onepager.js'), OP = require('./onepager-core.js');
const ROOT = __dirname, args = process.argv.slice(2), argOf = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8'));
const CMP = d.compare; if (!CMP) { console.error('data.json has no compare block'); process.exit(1); }
const names = CMP.names, co = {};
names.forEach(tk => { const c = d.companies.find(x => x.tk === tk); if (!c || !c.page || !c.ramp) { console.error(tk + ' needs page + ramp'); process.exit(1); }
  const A = assemble(c), W = A.W, pg = c.page, st = pg.steady, steps = Object.fromEntries(st.steps.map(s => [s[0], s[1]]));
  const rev = st.steps[0][1], keep = st.steps[st.steps.length - 1][1], costs = -(st.steps[1][1]), refresh = -(steps['GPU refresh + spares'] || 0), shell = -(steps['Shell 25-yr'] || 0), tax = -(steps['Tax 21%'] || 0);
  const own = pg.fund.cost, C = W.C.filter(x => !x.past), capex = C.reduce((a, x) => a + x.capex, 0) / 1000, ebitda30 = W.pl.eb, mw30 = A.L[A.L.length - 1][2], mwNow = A.L.find(r => r[0] === (pg.finance.T0 || '2026Q3'))[2];
  co[tk] = { name: c.name, pg, A, W, rev, costs, refresh, shell, tax, keep, own, roic: keep / own, payback: own / (rev * 0.85), ebitdaMW: steps['Cash profit'] != null ? steps['Cash profit'] : rev * pg.finance.M, capex, ebitda30, mw30, mwNow, rr: A.rr, mult: pg.finance.MULT, ps: W.ps, px: pg.px.v, dil: W.dil, nd: W.last.nd, liab: W.liab, owed: W.last.owed, eq: W.eqTot, year: A.year,
    evArr: (pg.evArr.sh * pg.px.v / 1000 + pg.evArr.nd) / pg.evArr.arr, eps: (W.pl.ni * 1000 + W.addb) / W.dil }; });
const f0 = n => Math.round(n).toLocaleString('en-US'), f1 = n => n.toFixed(1), money = n => '$' + f0(n), esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const tpl = fs.readFileSync(path.join(ROOT, 'onepager-template.html'), 'utf8');
const style = tpl.slice(tpl.indexOf('<style>', tpl.indexOf('<title>')) , tpl.indexOf('</style>', tpl.indexOf('<title>')) + 8);
const dateLong = new Date(CMP.asOf + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const short = { IREN: 'IREN', CRWV: 'CoreWeave', NBIS: 'Nebius' };
/* ---- SVG helpers (inline, theme-aware through the template's CSS variables) ---- */
const svgOpen = (w, h) => `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">`;
const text = (x, y, t, a) => `<text x="${x}" y="${y}" ${Object.entries(a || {}).map(([k, v]) => `${k}="${v}"`).join(' ')}>${esc(t)}</text>`;
const rect = (x, y, w, h, fill, extra) => `<rect x="${x}" y="${y}" width="${Math.max(0, w)}" height="${Math.max(0, h)}" fill="${fill}" ${extra || ''}/>`;
/* per-MW grouped bars: revenue, running costs, refresh, shell, tax, keeps — three names side by side */
function perMWChart() {
  const cats = [['Revenue', c => c.rev], ['Running costs incl. rent and power', c => c.costs], ['GPU refresh + spares', c => c.refresh], ['Shell', c => c.shell], ['Tax', c => c.tax], ['Owner keeps', c => c.keep]];
  const W = 880, H = 260, L = 240, R = 60, top = 18, rowH = 36, colors = { IREN: 'var(--s1)', CRWV: 'var(--s2)', NBIS: 'var(--s3)' };
  const max = Math.max(...names.map(tk => co[tk].rev)), x = v => L + v / max * (W - L - R);
  let s = svgOpen(W, top + cats.length * rowH + 8);
  cats.forEach(([lab, fn], i) => { const y = top + i * rowH; s += text(L - 10, y + 15, lab, { 'text-anchor': 'end', 'font-size': 12.5 });
    names.forEach((tk, j) => { const v = fn(co[tk]), by = y + j * 9; s += rect(L, by, x(v) - L, 8, colors[tk], `rx="1"`); if (j === names.length - 1 || v === Math.max(...names.map(t => fn(co[t])))) {} });
    const vals = names.map(tk => fn(co[tk])); s += text(x(Math.max(...vals)) + 8, y + 15, vals.map(v => '$' + f1(v) + 'm').join(' · '), { 'font-size': 11, class: 'm soft' }); });
  return s + '</svg>';
}
/* value bars: base vs market, per name */
function valueChart() {
  const W = 880, H = 130, L = 160, R = 80, top = 12, rowH = 36, max = Math.max(...names.map(tk => Math.max(co[tk].ps, co[tk].px))) * 1.15, x = v => L + v / max * (W - L - R);
  let s = svgOpen(W, top + names.length * rowH + 6);
  names.forEach((tk, i) => { const c = co[tk], y = top + i * rowH; s += text(L - 10, y + 15, short[tk], { 'text-anchor': 'end', 'font-size': 13, 'font-weight': 500 });
    s += rect(L, y, x(c.ps) - L, 14, 'var(--s1)'); s += text(x(c.ps) + 6, y + 12, '$' + f0(c.ps) + ' base', { 'font-size': 11, class: 'm' });
    s += rect(L, y + 16, x(c.px) - L, 6, 'var(--sunk)', 'stroke="var(--line)"'); s += text(x(c.px) + 6, y + 22, '$' + c.px.toFixed(2) + ' market · ' + (c.ps / c.px).toFixed(1) + '×', { 'font-size': 10.5, class: 'm soft' }); });
  return s + '</svg>';
}
const th = (t, cls) => `<th${cls ? ' class="' + cls + '"' : ''}>${t}</th>`;
const factorsTable = '<table class="cmp"><thead><tr>' + th('') + names.map(tk => th(short[tk])).join('') + th('Trend') + '</tr></thead><tbody>' +
  CMP.factors.map(r => `<tr><td class="k">${r.f}${r.src ? '<span class="src">' + r.src + '</span>' : ''}</td>` + names.map(tk => `<td>${r.v[tk] || ''}</td>`).join('') + `<td class="trend ${r.trend.split(' ')[0]}">${r.trend}</td></tr>`).join('') + '</tbody></table>';
const econRows = [['Revenue per MW-yr (2027 vintage)', c => '$' + f1(c.rev) + 'm'], ['EBITDA per MW-yr (steady state)', c => '$' + f1(c.ebitdaMW) + 'm (' + Math.round(c.ebitdaMW / c.rev * 100) + '%)'], ['Owner keeps after refresh, shell and tax', c => '$' + f1(c.keep) + 'm'],
  ['Capital the company itself puts into one MW', c => '$' + f0(c.own) + 'm'], ['Cash return on that capital', c => (c.roic * 100).toFixed(0) + '%'], ['Payback on own capex, after direct costs', c => f1(c.payback) + ' yr'], ['$1 of run-rate is worth', c => c.mult.toFixed(2) + '×']];
const econTable = '<table class="cmp"><thead><tr>' + th('One megawatt') + names.map(tk => th(short[tk])).join('') + '</tr></thead><tbody>' + econRows.map(([k, fn]) => `<tr><td class="k">${k}</td>` + names.map(tk => `<td>${fn(co[tk])}</td>`).join('') + '</tr>').join('') + '</tbody></table>';
const y30 = co[names[0]].year;
const picRows = [['Active IT MW, 2026Q3 model → end-' + y30, c => f0(c.mwNow) + ' → ' + f0(c.mw30)], ['Run-rate revenue at end-' + y30, c => '$' + f1(c.rr) + 'bn'], [y30 + ' EBITDA', c => '$' + f1(c.ebitda30) + 'bn'], ['Capex 2026H2–' + y30, c => '$' + f0(c.capex) + 'bn'], ['Equity raised on the way', c => '$' + f1(c.eq) + 'bn'], ['Net debt ex converts at ' + y30, c => '$' + f1(c.nd) + 'bn'], ['Prepayments still owed at ' + y30 + ', PV', c => '$' + f1(c.liab) + 'bn'], ['Diluted shares, converts in', c => f0(c.dil) + 'm'], [y30 + ' EPS', c => '$' + c.eps.toFixed(1)], ['EV / ARR today', c => c.evArr.toFixed(1) + '×'], ['Base value vs market', c => '$' + f0(c.ps) + ' vs $' + c.px.toFixed(2) + ' · ' + (c.ps / c.px).toFixed(1) + '×']];
const picTable = '<table class="cmp"><thead><tr>' + th('') + names.map(tk => th(short[tk])).join('') + '</tr></thead><tbody>' + picRows.map(([k, fn]) => `<tr><td class="k">${k}</td>` + names.map(tk => `<td>${fn(co[tk])}</td>`).join('') + '</tr>').join('') + '</tbody></table>';
const notes = arr => '<div class="notes">' + arr.map(n => '<div class="note">' + n + '</div>').join('') + '</div>';
const card = (n, h2, hero, body) => `<section class="step"><div class="rail"><div class="num">${n}</div><div class="bar"></div></div><div class="card"><div class="head"><div><h2>${h2}</h2></div>${hero ? '<div class="hero"><div class="v">' + hero[0] + '</div><div class="u">' + hero[1] + '</div></div>' : ''}</div>${body}</div></section>`;
const facts = names.map(tk => { const c = co[tk]; return `<div class="fact"><span class="l">${short[tk]}</span><span class="v">$${f0(c.ps)}</span><span class="n">base · $${c.px.toFixed(2)} market · ${(c.ps / c.px).toFixed(1)}×</span></div>`; }).join('');
const body = (artifact) => `${style}
<style>table.cmp td.k{font-weight:500;white-space:normal;min-width:150px}table.cmp td{white-space:normal;vertical-align:top;font-size:12.5px;line-height:1.35;text-align:left}table.cmp th{text-align:left}table.cmp td.trend{font-family:"JetBrains Mono",monospace;font-size:11px;letter-spacing:.04em;text-transform:uppercase;white-space:normal}table.cmp td.converging{color:var(--pos)}table.cmp td.structural{color:var(--neg)}table.cmp td.k .src{display:block;font-family:"JetBrains Mono",monospace;font-size:10px;color:var(--faint);letter-spacing:.04em;margin-top:3px;text-transform:none}.facts{grid-template-columns:repeat(3,1fr)}</style>
<title>${esc(CMP.title)}</title>
<div class="wrap">
<header>
  <div class="kicker">${CMP.kicker} · ${dateLong}</div>
  <h1>${CMP.title}</h1>
  <p class="sub">${CMP.sub}</p>
  <div class="facts">${facts}</div>
</header>
${card(1, 'The gating factors', ['3', 'balance sheets, one megawatt'], `<figure><div class="cap"><span>what each company must secure before a megawatt earns · sourced values · trend = the evidence since 2025</span></div><div class="scroll">${factorsTable}</div></figure>${notes(CMP.notes.factors)}`)}
${card(2, 'What one megawatt keeps', ['$' + f1(co.IREN.keep) + 'm · $' + f1(co.NBIS.keep) + 'm · $' + f1(co.CRWV.keep) + 'm', 'IREN · Nebius · CoreWeave, per MW-yr after refresh, shell and tax'], `<figure><div class="cap"><span><i class="sw" style="background:var(--s1)"></i>IREN</span><span><i class="sw" style="background:var(--s2)"></i>CoreWeave</span><span><i class="sw" style="background:var(--s3)"></i>Nebius</span><span>one IT MW · one year · $m · the 2027 marginal megawatt of each page</span></div><div class="scroll">${perMWChart()}</div></figure><div class="scroll">${econTable}</div>${notes(CMP.notes.economics)}`)}
${card(3, 'The ' + y30 + ' picture', [f0(co.CRWV.mw30 / 1000 * 10) / 10 + ' · ' + f0(co.NBIS.mw30 / 1000 * 10) / 10 + ' · ' + f0(co.IREN.mw30 / 1000 * 10) / 10 + ' GW', 'CoreWeave · Nebius · IREN active by end-' + y30], `<div class="scroll">${picTable}</div><figure><div class="cap"><span>base-case value per share against the market</span></div><div class="scroll">${valueChart()}</div></figure>${notes(CMP.notes.picture)}`)}
${card(4, 'Converging or structural', null, `${notes(CMP.notes.convergence)}`)}
<footer>
  <b>Sources.</b> ${CMP.footer.sources}
  <b>Model.</b> ${CMP.footer.model}
  <b>Snapshot.</b> Every number is computed from the same page and ramp blocks that generate the three research pages (${names.map(tk => artifact ? short[tk] : '<a href="/' + tk.toLowerCase() + '.html">' + short[tk] + '</a>').join(', ')}) as of ${dateLong}; the live model is on the ${artifact ? 'tracker’s GPU RAMP tab' : '<a href="/">tracker’s GPU RAMP tab</a>'}. <b>Not advice.</b> A first-principles comparison of what the assets earn — not a price target.
</footer>
</div>`;
const full = `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n<style>:root{color-scheme:light dark}body{margin:0}</style>\n<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap">\n</head>\n<body>\n${body(false)}\n</body>\n</html>\n`;
fs.writeFileSync(path.join(ROOT, 'compare.html'), full);
console.log('wrote compare.html — ' + names.map(tk => short[tk] + ' $' + f0(co[tk].ps)).join(' · '));
const art = argOf('--artifact'); if (art) { fs.writeFileSync(art, '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap">\n' + body(true)); console.log('wrote artifact copy ' + art); }
