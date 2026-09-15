/* CSS moved to styles.css (Wave 3 consolidation) */
/* The three-way comparison, /research/compare (spec-6 section (c); production compare.js).
   'The same megawatt, three balance sheets' rebuilt client-side: compare-data.json carries the
   authored compare block (factors, notes, footer, mwBasis — no numbers), and every derived
   number is recomputed at render time from the three <tk>-data.json payloads through
   OnePager.waterfall — the same co-map derivations as production compare.js:13-17. This file
   computes nothing of its own beyond those ported derivations; the math source stays
   onepager-core.js, never forked. A static dated read: no controls beyond the app shell.
   Per ruling C12 the compare block's authored fragments (factors, notes, footer, kicker,
   title, sub, mwBasis) are first-party HTML rendered unescaped, exactly as production
   compare.js injects them raw; everything this view formats itself is escaped. */
(function (root) {
  'use strict';

  let STATUS = 'idle';        // idle -> loading -> ready | error (error retries via the button)
  let CMP = null, CO = null, NAMES = null, ERR = null;
  let WIRED = false;

  const SHORT = { IREN: 'IREN', CRWV: 'CoreWeave', NBIS: 'Nebius' };
  const COLORS = { IREN: '#345cd0', CRWV: '#7c8da8', NBIS: '#263c64' };   // report palette (iren-view.js)
  const short = tk => SHORT[tk] || tk;
  const color = tk => COLORS[tk] || '#8a97ab';
  /* production compare.js number formats (compare.js:18) */
  const f0 = n => Math.round(n).toLocaleString('en-US');
  const f1 = n => n.toFixed(1);
  const refresh = () => { if (root.CVApp && typeof root.CVApp.refresh === 'function') root.CVApp.refresh(); };
  const reportHref = tk => '/' + String(tk).toLowerCase();

  /* ---------- data: compare-data.json + the three report payloads, fetched lazily once ---------- */
  function load() {
    if (STATUS !== 'idle') return;
    if (typeof fetch !== 'function') { STATUS = 'error'; ERR = 'no fetch in this environment'; return; }
    STATUS = 'loading'; ERR = null;
    fetch('/compare-data.json', { cache: 'no-store' })
      .then(r => { if (!r.ok) throw new Error('compare-data.json returned HTTP ' + r.status); return r.json(); })
      .then(cmp => {
        if (!cmp || !Array.isArray(cmp.names) || !Array.isArray(cmp.factors)) throw new Error('compare-data.json is missing its names or factors');
        return Promise.all(cmp.names.map(tk => fetch(reportHref(tk) + '-data.json', { cache: 'no-store' })
          .then(r => { if (!r.ok) throw new Error(tk + '-data.json returned HTTP ' + r.status); return r.json(); })))
          .then(payloads => ({ cmp, payloads }));
      })
      .then(({ cmp, payloads }) => {
        if (!root.OnePager || typeof root.OnePager.waterfall !== 'function') throw new Error('the one-pager calculator (onepager-core.js) is unavailable');
        const co = {};
        cmp.names.forEach((tk, i) => { co[tk] = derive(tk, payloads[i]); });
        CMP = cmp; CO = co; NAMES = cmp.names; STATUS = 'ready';
      })
      .catch(e => { STATUS = 'error'; ERR = e && e.message ? String(e.message) : 'load failed'; })
      .then(refresh);
  }
  function retry() { if (STATUS !== 'loading') { STATUS = 'idle'; CMP = CO = NAMES = null; load(); refresh(); } }

  /* ---------- the per-name derivations, ported verbatim from production compare.js:13-17.
     pg.* fields live at the payload root (P.steady, P.fund, P.finance, P.px, P.evArr) and the
     assemble() outputs the generator baked in replace A.* (P.L, P.rr, P.year). ---------- */
  function derive(tk, P) {
    if (!P || !P.steady || !Array.isArray(P.steady.steps) || !P.L || !P.finance || !P.fund || !P.px || !P.evArr) throw new Error(tk + ' research data is incomplete');
    const W = root.OnePager.waterfall(P.L, P.CAPQ, P.finance, P.ARRC);
    const st = P.steady, steps = Object.fromEntries(st.steps.map(s => [s[0], s[1]]));
    const rev = st.steps[0][1], keep = st.steps[st.steps.length - 1][1], costs = -(st.steps[1][1]),
      refreshC = -(steps['GPU refresh + spares'] || 0), shell = -(steps['Shell 25-yr'] || 0), tax = -(steps['Tax 21%'] || 0);
    const own = P.fund.cost, C = W.C.filter(x => !x.past), capex = C.reduce((a, x) => a + x.capex, 0) / 1000,
      ebitda30 = W.pl.eb, mw30 = P.L[P.L.length - 1][2], t0row = P.L.find(r => r[0] === (P.finance.T0 || '2026Q3'));
    if (!t0row) throw new Error(tk + ' ledger has no ' + (P.finance.T0 || '2026Q3') + ' row');
    return { tk, name: P.name, rev, costs, refresh: refreshC, shell, tax, keep, own,
      roic: keep / own, payback: own / (rev * 0.85),
      ebitdaMW: steps['Cash profit'] != null ? steps['Cash profit'] : rev * P.finance.M,
      capex, ebitda30, mw30, mwNow: t0row[2], rr: P.rr, mult: P.finance.MULT,
      ps: W.ps, px: P.px.v, dil: W.dil, nd: W.last.nd, liab: W.liab, owed: W.last.owed,
      eq: W.eqTot, year: P.year,
      evArr: (P.evArr.sh * P.px.v / 1000 + P.evArr.nd) / P.evArr.arr,
      eps: (W.pl.ni * 1000 + W.addb) / W.dil };
  }
  /* like-for-like repricing (compare.js:51-52): hold each company's running costs, refresh and
     shell in $ per MW and price every megawatt at the same 5-yr hyperscaler rate */
  const LFL = 16;
  const keepAt = (c, price) => { const eb = price - c.costs, tax = Math.max(0, eb - c.refresh - c.shell) * 0.21; return eb - c.refresh - c.shell - tax; };

  /* ---------- presentation ---------- */
  function heading(number, title, note) {
    const esc = root.UI.esc;
    return '<div class="section-intro"><span class="section-number">' + number + '</span><h2>' + esc(title) + '</h2>' + (note ? '<span class="muted">' + esc(note) + '</span>' : '') + '</div>';
  }
  /* C12: note fragments are the compare block's authored HTML — injected raw, as production does */
  const notes = arr => Array.isArray(arr) && arr.length ? '<section class="panel padded cmp-notes report-section">' + arr.map(n => '<div class="cmp-note">' + n + '</div>').join('') + '</section>' : '';
  const trendClass = trend => { const w = String(trend || '').split(' ')[0]; return w === 'structural' ? 'negative' : (w === 'converging' || w === 'converged') ? 'positive' : ''; };
  const svgText = (x, y, t, attrs) => '<text x="' + x + '" y="' + y + '"' + (attrs || '') + '>' + root.UI.esc(t) + '</text>';
  const svgRect = (x, y, w, h, fill, extra) => '<rect x="' + x + '" y="' + y + '" width="' + Math.max(0, w).toFixed(2) + '" height="' + Math.max(0, h) + '" fill="' + fill + '"' + (extra || '') + '/>';

  /* per-MW grouped bars (compare.js:28-37): revenue, running costs, refresh, shell, tax, keeps × three names */
  function perMWChart() {
    const cats = [['Revenue', c => c.rev], ['Running costs incl. rent and power', c => c.costs], ['GPU refresh + spares', c => c.refresh], ['Shell', c => c.shell], ['Tax', c => c.tax], ['Owner keeps', c => c.keep]];
    const W = 880, L = 240, R = 60, top = 18, rowH = 36, H = top + cats.length * rowH + 8;
    const max = Math.max(...NAMES.map(tk => CO[tk].rev)), x = v => L + v / max * (W - L - R);
    let s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-labelledby="cmp-permw-title cmp-permw-desc"><title id="cmp-permw-title">What one megawatt keeps, by company</title><desc id="cmp-permw-desc">Grouped horizontal bars comparing ' + NAMES.map(tk => short(tk)).join(', ') + ' per IT megawatt-year: revenue, running costs, GPU refresh and spares, shell, tax, and what the owner keeps, in millions of dollars. The values appear beside each group and in the table below.</desc>';
    cats.forEach(([lab, fn], i) => {
      const y = top + i * rowH;
      s += svgText(L - 10, y + 15, lab, ' text-anchor="end" class="chart-label"');
      NAMES.forEach((tk, j) => { s += svgRect(L, y + j * 9, x(fn(CO[tk])) - L, 8, color(tk), ' rx="1"'); });
      const vals = NAMES.map(tk => fn(CO[tk]));
      s += svgText(x(Math.max(...vals)) + 8, y + 15, vals.map(v => '$' + f1(v) + 'm').join(' · '), '');
    });
    return s + '</svg>';
  }
  /* value bars (compare.js:39-46): base vs market per name, with the ×-multiple label */
  function valueChart() {
    const W = 880, L = 160, R = 80, top = 12, rowH = 36, H = top + NAMES.length * rowH + 6;
    const max = Math.max(...NAMES.map(tk => Math.max(CO[tk].ps, CO[tk].px))) * 1.15, x = v => L + v / max * (W - L - R);
    let s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-labelledby="cmp-value-title cmp-value-desc"><title id="cmp-value-title">Base value against the market price</title><desc id="cmp-value-desc">Paired horizontal bars per company: the model base value per share against the market price, with the multiple between them. The same figures are in the last row of the table above.</desc>';
    NAMES.forEach((tk, i) => {
      const c = CO[tk], y = top + i * rowH;
      s += svgText(L - 10, y + 15, short(tk), ' text-anchor="end" class="chart-label"');
      s += svgRect(L, y, x(c.ps) - L, 14, '#345cd0');
      s += svgText(x(c.ps) + 6, y + 12, '$' + f0(c.ps) + ' base', '');
      s += svgRect(L, y + 16, x(c.px) - L, 6, '#e3e9f2', ' stroke="#aab9cf"');
      s += svgText(x(c.px) + 6, y + 24, '$' + c.px.toFixed(2) + ' market · ' + (c.ps / c.px).toFixed(1) + '×', '');
    });
    return s + '</svg>';
  }

  function cmpTable(cls, firstHead, nameHead, rows, caption) {
    const esc = root.UI.esc;
    return '<div class="table-scroll"><table class="plain-table cmp ' + cls + '">' + (caption ? '<caption>' + esc(caption) + '</caption>' : '') +
      '<thead><tr><th scope="col">' + esc(firstHead) + '</th>' + NAMES.map(nameHead).join('') + '</tr></thead><tbody>' +
      rows.join('') + '</tbody></table></div>';
  }

  function page() {
    const UI = root.UI, esc = UI.esc;
    const dateLong = UI.date(CMP.asOf);
    const y30 = CO[NAMES[0]].year;

    /* header: kicker/title/sub are the compare block's authored copy (raw, as production injects them) */
    const head = '<header class="page-top"><div><div class="eyebrow">Research library · ' + CMP.kicker + '</div><h1>' + CMP.title + '</h1><p class="page-description">' + CMP.sub + '</p></div><div class="actions"><a class="text-button" href="/research">Research library ' + UI.icon('back') + '</a></div></header>';
    const banner = '<div class="snapshot-banner">' + UI.icon('clock') + '<span><strong>Dated research comparison · ' + esc(dateLong) + '.</strong> Every number is recomputed at render time from the three research data files through the shared one-pager calculator — nothing on this page reads live prices, and the date comes from the data file itself.</span></div>';
    const tiles = '<div class="metric-strip cmp-tiles">' + NAMES.map(tk => { const c = CO[tk];
      return '<a class="metric" href="' + reportHref(tk) + '"><div class="metric-label">' + esc(short(tk)) + '</div><div class="metric-value">$' + esc(f0(c.ps)) + '</div><div class="metric-note">base · $' + esc(c.px.toFixed(2)) + ' market · ' + esc((c.ps / c.px).toFixed(1)) + '× · open the report</div></a>'; }).join('') + '</div>';

    /* card 1 — the gating factors (17 authored rows; values and src raw per C12, trend colored by its first word) */
    const factorRows = CMP.factors.map(r => '<tr><td class="k">' + r.f + (r.src ? '<span class="src small muted">' + r.src + '</span>' : '') + '</td>' + NAMES.map(tk => '<td>' + (r.v && r.v[tk] ? r.v[tk] : '') + '</td>').join('') + '<td class="trend ' + trendClass(r.trend) + '">' + (r.trend || '') + '</td></tr>');
    const factors = '<section class="report-section">' + heading('01', 'The gating factors', 'Three balance sheets · one megawatt · what each company must secure before a megawatt earns') +
      '<div class="panel"><div class="table-scroll"><table class="plain-table cmp cmp-factors"><caption>Sourced values from the three research packs · trend = the evidence since 2025.</caption><thead><tr><th scope="col"></th>' +
      NAMES.map(tk => '<th scope="col"><a href="/company/' + esc(tk) + '">' + esc(short(tk)) + '</a></th>').join('') +
      '<th scope="col">Trend</th></tr></thead><tbody>' + factorRows.join('') + '</tbody></table></div></div></section>' + notes(CMP.notes && CMP.notes.factors);

    /* card 2 — what one megawatt keeps (compare.js:53-56, 11 economics rows) */
    const heroKeepOrder = ['IREN', 'NBIS', 'CRWV'].every(tk => CO[tk]) ? ['IREN', 'NBIS', 'CRWV'] : NAMES;
    const heroKeep = heroKeepOrder.map(tk => '$' + f1(CO[tk].keep) + 'm').join(' · ') + ' — ' + heroKeepOrder.map(tk => short(tk)).join(' · ') + ', per MW-yr after refresh, shell and tax';
    const econDefs = [
      ['Revenue per MW-yr in the per-MW block (a late vintage)', c => '$' + f1(c.rev) + 'm'],
      ['MW basis', c => (CMP.mwBasis && CMP.mwBasis[c.tk]) || 'critical IT MW'],
      ['2030 fleet average per MW-yr (run-rate ÷ active MW)', c => '$' + f1(c.rr * 1000 / c.mw30) + 'm'],
      ['Running costs per MW-yr, $ (power, rent, staff, overhead)', c => '$' + f1(c.costs) + 'm'],
      ['EBITDA per MW-yr (steady state)', c => '$' + f1(c.ebitdaMW) + 'm (' + Math.round(c.ebitdaMW / c.rev * 100) + '%)'],
      ['Owner keeps after refresh, shell and tax', c => '$' + f1(c.keep) + 'm'],
      ['Capital the company itself puts into one MW', c => '$' + f0(c.own) + 'm'],
      ['Cash return on that capital', c => (c.roic * 100).toFixed(0) + '%'],
      ['Payback on own capex, after direct costs', c => f1(c.payback) + ' yr'],
      ['$1 of run-rate is worth', c => c.mult.toFixed(2) + '×'],
      ['Kept per MW-yr if every MW sold at the same $' + LFL + 'm 5-yr rate, costs held in $', c => '$' + f1(keepAt(c, LFL)) + 'm']
    ];
    const econRows = econDefs.map(([k, fn]) => '<tr><td class="k">' + k + '</td>' + NAMES.map(tk => '<td>' + fn(CO[tk]) + '</td>').join('') + '</tr>');
    const legend = '<div class="chart-legend">' + NAMES.map(tk => '<span><i class="swatch" style="background:' + color(tk) + '"></i>' + esc(short(tk)) + '</span>').join('') + '<span class="muted">one IT MW · one year · $m</span></div>';
    const perMW = '<section class="report-section">' + heading('02', 'What one megawatt keeps', heroKeep) +
      '<div class="panel report-section"><div class="chart-header"><div><h2>One megawatt, one year</h2><p>The 2027 marginal megawatt of each research page · $m per IT MW-yr</p></div></div><div class="chart cmp-chart">' + perMWChart() + '</div>' + legend + '<div class="chart-note">Revenue, running costs, GPU refresh and spares, shell, tax and what the owner keeps — each company’s per-megawatt block from its own research page, on one dollar scale.</div></div>' +
      '<div class="panel">' + cmpTable('cmp-econ', 'One megawatt', tk => '<th scope="col"><a href="' + esc(reportHref(tk)) + '">' + esc(short(tk)) + '</a></th>', econRows, 'Per-megawatt economics, recomputed from each report’s data file. Rows link the column heads to the full reports.') + '</div></section>' + notes(CMP.notes && CMP.notes.economics);

    /* card 3 — the 2030 picture (compare.js:57-59, 11 horizon rows + the value bars) */
    const heroGWOrder = ['CRWV', 'NBIS', 'IREN'].every(tk => CO[tk]) ? ['CRWV', 'NBIS', 'IREN'] : NAMES;
    const heroGW = heroGWOrder.map(tk => (Math.round(CO[tk].mw30 / 100) / 10)).join(' · ') + ' GW — ' + heroGWOrder.map(tk => short(tk)).join(' · ') + ' active by end-' + y30;
    const picDefs = [
      ['Active IT MW, 2026Q3 model → end-' + y30, c => f0(c.mwNow) + ' → ' + f0(c.mw30)],
      ['Run-rate revenue at end-' + y30, c => '$' + f1(c.rr) + 'bn'],
      [y30 + ' EBITDA', c => '$' + f1(c.ebitda30) + 'bn'],
      ['Capex 2026H2–' + y30, c => '$' + f0(c.capex) + 'bn'],
      ['Equity raised on the way', c => '$' + f1(c.eq) + 'bn'],
      ['Net debt ex converts at ' + y30, c => '$' + f1(c.nd) + 'bn'],
      ['Prepayments still owed at ' + y30 + ', PV', c => '$' + f1(c.liab) + 'bn'],
      ['Diluted shares, converts in', c => f0(c.dil) + 'm'],
      [y30 + ' EPS', c => '$' + c.eps.toFixed(1)],
      ['EV / ARR today', c => c.evArr.toFixed(1) + '×'],
      ['Base value vs market', c => '$' + f0(c.ps) + ' vs $' + c.px.toFixed(2) + ' · ' + (c.ps / c.px).toFixed(1) + '×']
    ];
    const picRows = picDefs.map(([k, fn]) => '<tr><td class="k">' + k + '</td>' + NAMES.map(tk => '<td>' + fn(CO[tk]) + '</td>').join('') + '</tr>');
    const picture = '<section class="report-section">' + heading('03', 'The ' + y30 + ' picture', heroGW) +
      '<div class="panel report-section">' + cmpTable('cmp-picture', '', tk => '<th scope="col"><a href="' + esc(reportHref(tk)) + '">' + esc(short(tk)) + '</a></th>', picRows, 'The ' + y30 + ' horizon of each research model, recomputed from its data file.') + '</div>' +
      '<div class="panel"><div class="chart-header"><div><h2>Base-case value per share against the market</h2><p>Model base value (solid) over the ' + esc(dateLong) + ' market price (outline)</p></div></div><div class="chart cmp-chart">' + valueChart() + '</div><div class="chart-note">The base bar is each research page’s discounted value per share; the thin bar is the market price recorded in the same dated snapshot; the multiple is base over market. Open each report from the tiles above or the table heads.</div></div></section>' + notes(CMP.notes && CMP.notes.picture);

    /* card 4 — converging or structural */
    const convergence = '<section class="report-section">' + heading('04', 'Converging or structural', 'The convergence read across the three names') + notes(CMP.notes && CMP.notes.convergence) + '</section>';

    /* footer: sources/model raw (authored), snapshot links re-pointed at the client reports */
    const footer = '<section class="panel padded reading cmp-footer report-section"><h2>Sources, model and snapshot</h2>' +
      (CMP.footer && CMP.footer.sources ? '<p><b>Sources.</b> ' + CMP.footer.sources + '</p>' : '') +
      (CMP.footer && CMP.footer.model ? '<p><b>Model.</b> ' + CMP.footer.model + '</p>' : '') +
      '<p><b>Snapshot.</b> Every number is computed from the same data that generates the three research reports (' + NAMES.map(tk => '<a href="' + esc(reportHref(tk)) + '">' + esc(short(tk)) + '</a>').join(', ') + ') as of ' + esc(dateLong) + '; the live capacity-based model is on the <a href="/">comparison screen</a>. <b>Not advice.</b> A first-principles comparison of what the assets earn — not a price target.</p></section>';

    return head + banner + tiles + factors + perMW + picture + convergence + footer;
  }

  /* ---------- shell states ---------- */
  const shellTop = '<header class="page-top"><div><div class="eyebrow">Research library · comparison</div><h1>The megawatt comparison</h1><p class="page-description">IREN, CoreWeave and Nebius side by side, every number recomputed from the three research data files.</p></div></header>';
  function loadingState() {
    return shellTop + '<section class="panel padded"><div class="empty"><strong>Loading the comparison…</strong><p>Fetching compare-data.json and the three research data files, then recomputing every number with the shared one-pager calculator.</p></div></section>';
  }
  function errorState() {
    return shellTop + '<section class="panel padded"><div class="empty"><strong>The comparison could not load.</strong><p>' + root.UI.esc(ERR || 'load failed') + ' — this route degrades alone; the rest of the app is unaffected.</p><button class="button" type="button" data-cmp-retry>Retry</button></div></section>';
  }

  function wire() {
    if (WIRED || typeof document === 'undefined') return;
    WIRED = true;
    document.addEventListener('click', e => { if (e.target && e.target.closest && e.target.closest('[data-cmp-retry]')) retry(); });
  }

  function render(p) {
    wire();
    if (STATUS === 'idle') load();
    if (STATUS === 'error') return errorState();
    if (STATUS !== 'ready') return loadingState();
    return page();
  }

  root.CompareView = { render };
})(typeof window !== 'undefined' ? window : globalThis);
