/* CSS moved to styles.css (Wave 2 consolidation) */
/* Portfolio — the paper book (spec §6b), /portfolio BODY below the Operations subnav.
   Display-only over portfolio.json + portfolio-history.json; every behavior is ported from
   production portfolio-ui.js (cited by line). PortfolioCore does the math (never forked);
   "Target now" prices a fresh Engine at CloudModel's live marks. Zero writes — the daily
   GitHub Action, portfolio-run.js, portfolio-backtest.js and both ledgers are untouched. */
(function (root) {
  'use strict';

  /* ---------- self-contained helpers (same pattern as iren-view.js) ---------- */
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const dateLong = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? new Date(v + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : String(v || '');
  const ICONS = { info: '<circle cx="8" cy="8" r="6"/><path d="M8 7v4m0-7v1"/>', close: '<path d="m4 4 8 8M4 12l8-8"/>' };
  const icon = k => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[k]}</svg>`;
  const metric = (label, value, note, cls = '') => `<div class="metric"><div class="metric-label">${label}</div><div class="metric-value ${cls}">${value}</div><div class="metric-note">${note}</div></div>`;
  /* production number formats (portfolio-ui.js:20-21): signed % and 1dp weights */
  const pfPct = (x, dp) => (x >= 0 ? '+' : '') + (x * 100).toFixed(dp == null ? 1 : dp) + '%';
  const pfW = x => (x * 100).toFixed(1) + '%';
  const moneyPx = x => '$' + (x < 10 ? Number(x).toFixed(4) : Number(x).toFixed(2)); // sub-$10 names keep 4dp (portfolio-core rPx)
  const refresh = () => { if (root.CVApp && root.CVApp.refresh) root.CVApp.refresh(); };

  /* ---------- data: both ledgers fetched once, cache:'no-store' (portfolio-ui.js:6-18) ---------- */
  let PF = null, PFH = null, ERR = null, LOADING = false, AT = 0;
  let LAST = null;      // snapshot of the last computed render inputs, for the drawer
  let WIRED = false;

  function load() {
    if (LOADING || typeof fetch !== 'function') return;
    LOADING = true; ERR = null;
    Promise.all([fetch('portfolio.json', { cache: 'no-store' }), fetch('portfolio-history.json', { cache: 'no-store' })])
      .then(([a, b]) => { if (!a.ok || !b.ok) throw new Error('HTTP ' + (a.ok ? b.status : a.status)); return Promise.all([a.json(), b.json()]); })
      .then(([p, h]) => { PF = p; PFH = h; AT = Date.now(); })
      .catch(e => { ERR = (e && e.message) || String(e); })
      .then(() => { LOADING = false; refresh(); });
  }
  /* retryPortfolio semantics (portfolio-ui.js:18): clear and refetch both files */
  function retry() { ERR = null; PF = null; PFH = null; AT = 0; load(); }

  /* ---------- scope: full history vs the live record alone (portfolio-ui.js:38-47).
     Live scope keeps the go-live boundary record as day 0 — its close is the true live base. */
  let SCOPE = 'all';
  try { SCOPE = (typeof localStorage !== 'undefined' && localStorage.getItem('pfScope')) || 'all'; } catch (e) {}
  function setScope(s) {
    SCOPE = s === 'live' ? 'live' : 'all';
    try { localStorage.setItem('pfScope', SCOPE); } catch (e) {}
    refresh();
  }
  function scopeDays(days, backtestThrough) {
    if (SCOPE !== 'live') return days;
    const i = days.findIndex(d => d.d > backtestThrough);
    if (i < 0) return days.slice(-1);        // no live records yet — show the boundary point
    return days.slice(Math.max(0, i - 1));   // boundary record = live day 0
  }

  /* ---------- chart range: trading-day windows, state in the URL (?range=) ---------- */
  const WINDOWS = { '1d': 1, '5d': 5, '1m': 21, '6m': 126, '1y': 252 };
  function setRange(r) {
    if (!WINDOWS[r] || typeof location === 'undefined') return;
    const q = new URLSearchParams(location.search);
    r === '1y' ? q.delete('range') : q.set('range', r);
    history.replaceState({}, '', location.pathname + (q.size ? '?' + q.toString() : ''));
    refresh();
  }

  /* ---------- absolute return over the last n trading days (portfolio-ui.js:48-53) ---------- */
  function pfRet(days, nn, key) {
    if (days.length < 2) return null;
    const i = Math.max(0, days.length - 1 - nn);
    const a = days[i][key], b = days[days.length - 1][key];
    return a > 0 ? { r: b / a - 1, partial: days.length - 1 < nn } : null;
  }

  /* ---------- per-name NAV-point attribution, split sim vs live (portfolio-ui.js:55-67) ---------- */
  function attribution(days, backtestThrough) {
    const sim = {}, live = {};
    for (let i = 1; i < days.length; i++) {
      const a = days[i - 1], b = days[i];
      const tgt = (b.d <= backtestThrough) ? sim : live;
      for (const tk in (a.w || {})) {
        const p0 = a.px[tk], p1 = b.px[tk];
        if (p0 > 0 && p1 > 0) tgt[tk] = (tgt[tk] || 0) + a.w[tk] * (p1 / p0 - 1) * a.nav;
      }
    }
    return { sim, live };
  }

  /* ---------- today's views/targets: fresh engine at the live marks + go-live learning state,
     porting portfolio-ui.js:24-32 faithfully. Returns null when the engine stack is unavailable —
     target cells then render em-dash, never a number this module did not compute. ---------- */
  function todayViews() {
    try {
      const CM = root.CloudModel;
      if (!root.PortfolioCore || !root.Engine || !CM || !CM.source || !PF) return null;
      const eng = root.Engine.createEngine(CM.source);
      /* carry the sandbox dial settings so "Target now" responds to the assumptions drawer,
         exactly as production's shared-engine A does (portfolio-ui.js:27 uses the live dials) */
      const cur = CM.current;
      if (cur && cur.dials) Object.keys(cur.dials).forEach(k => { if (k in eng.A) eng.A[k] = cur.dials[k]; });
      const marks = CM.marks || { prices: {} };
      Object.assign(eng.ctx.prices, marks.prices || {});
      if (marks.btc != null) eng.ctx.btc = marks.btc;
      if (marks.eth != null) eng.ctx.eth = marks.eth;
      const watch = {};
      // Count distinct concerns (grp), not atomic records — mirrors portfolio-run.js exactly.
      const wg = {};
      ((CM.source.watchItems) || []).forEach((w, i) => { (wg[w.tk] = wg[w.tk] || new Set()).add(w.grp || w.id || i); });
      Object.entries(wg).forEach(([tk2, s]) => { watch[tk2] = s.size; });
      const excluded = new Set(Object.keys(PF.exclude || {}));
      const rows = eng.COMPANIES.filter(c => !excluded.has(c.tk)).map(c => {
        const v = eng.value(c);
        return { tk: c.tk, price: eng.priceOf(c), target: v.target, ev: v.ev, contractedEV: v.contractedEV, legacy: eng.legacyOf(c), watch: watch[c.tk] || 0 };
      });
      const state = JSON.parse(JSON.stringify(PF.state));   // computeViews mutates name state — never PF.state itself
      const views = root.PortfolioCore.computeViews(rows, state, PF.params);
      const tw = root.PortfolioCore.targetWeights(views, PF.params);
      const names = {}; eng.COMPANIES.forEach(c => { names[c.tk] = c.name; });
      const priceAsOf = cur && cur.meta ? cur.meta.priceAsOf : (marks.asOf || null);
      return { views, tw, excluded, watch, state, names, marks, priceAsOf };
    } catch (e) { return null; }
  }
  const dialsMoved = () => {
    const cur = root.CloudModel && root.CloudModel.current;   // preview equivalent of A vs BASE (portfolio-ui.js:122)
    return !!(cur && cur.dials && cur.baseAssumptions && JSON.stringify(cur.dials) !== JSON.stringify(cur.baseAssumptions));
  };

  /* ---------- cumulative % return chart, both series rebased to 0% at the window start —
     own SVG modeled on production pfChartHTML (portfolio-ui.js:70-106): shaded genesis region,
     clay boundary rule at backtestThrough, endpoint % label. UI.lineChart cannot shade regions
     or plot negatives, so the drawing is ported, restyled to the preview palette. ---------- */
  function chartSVG(allDays, meta, range) {
    const nWin = WINDOWS[range] || 252;
    const days = allDays.slice(-(nWin + 1));
    if (days.length < 2) return null;
    const base = { nav: days[0].nav, bench: days[0].bench };
    const val = (d, k) => (d[k] / base[k] - 1) * 100;
    const W = 680, H = 260, ml = 52, mr = 14, mt = 14, mb = 26, pw = W - ml - mr, ph = H - mt - mb;
    let lo = 0, hi = 0;
    days.forEach(d => { lo = Math.min(lo, val(d, 'nav'), val(d, 'bench')); hi = Math.max(hi, val(d, 'nav'), val(d, 'bench')); });
    const pad = Math.max(1, (hi - lo) * 0.06); lo -= pad; hi += pad;
    const yOf = v => mt + ph - ((v - lo) / (hi - lo)) * ph;
    const xOf = i => ml + (i / (days.length - 1)) * pw;
    let s = '';
    /* simulated/reconstructed-genesis region within the window */
    let simEnd = days.length - 1;
    for (let i = 0; i < days.length; i++) if (days[i].d > meta.backtestThrough) { simEnd = i - 1; break; }
    if (simEnd >= 0) s += `<rect x="${ml}" y="${mt}" width="${(xOf(simEnd) - ml).toFixed(1)}" height="${ph}" fill="#7c93b5" opacity="0.12"/>`;
    /* % gridlines at a nice step (~5 lines), 0% emphasized */
    const step = [0.5, 1, 2, 5, 10, 20, 25, 50, 100, 200, 400].find(st => (hi - lo) / st <= 7) || 800;
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
      const y = yOf(v);
      s += `<line x1="${ml}" y1="${y.toFixed(1)}" x2="${W - mr}" y2="${y.toFixed(1)}" stroke="${v === 0 ? '#8b98ac' : '#e6ebf2'}" stroke-width="1"/><text x="${ml - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end">${v > 0 ? '+' : ''}${v}%</text>`;
    }
    /* ~5 evenly spaced date ticks */
    const nt = Math.min(5, days.length);
    for (let k = 0; k < nt; k++) {
      const i = Math.round(k * (days.length - 1) / Math.max(1, nt - 1));
      const x = Math.min(Math.max(xOf(i), ml + 22), W - mr - 22);
      const lbl = days.length > 140 ? days[i].d.slice(0, 7) : days[i].d.slice(5);
      s += `<text x="${x.toFixed(1)}" y="${(mt + ph + 17).toFixed(1)}" text-anchor="middle">${esc(lbl)}</text>`;
    }
    const line = (key, attrs) => `<polyline fill="none" ${attrs} points="${days.map((d, i) => xOf(i).toFixed(1) + ',' + yOf(val(d, key)).toFixed(1)).join(' ')}"/>`;
    s += line('bench', 'stroke="#8293a9" stroke-width="1.5" stroke-dasharray="5 4"');
    s += line('nav', 'stroke="#345cd0" stroke-width="2.2" stroke-linejoin="round"');
    if (simEnd >= 0 && simEnd < days.length - 1) {
      const x = xOf(simEnd);
      s += `<line x1="${x.toFixed(1)}" y1="${mt}" x2="${x.toFixed(1)}" y2="${mt + ph}" stroke="#a94e49" stroke-width="1" stroke-dasharray="2 3"/>`;
    }
    if (simEnd >= 2) s += `<text x="${ml + 8}" y="${mt + 13}">${meta.pit ? 'reconstructed genesis' : 'simulated genesis'}</text>`;
    const lastD = days[days.length - 1];
    s += `<circle cx="${xOf(days.length - 1).toFixed(1)}" cy="${yOf(val(lastD, 'nav')).toFixed(1)}" r="3" fill="#345cd0"/>`;
    s += `<text class="chart-label" x="${(W - mr - 2).toFixed(1)}" y="${(yOf(val(lastD, 'nav')) - 7).toFixed(1)}" text-anchor="end" style="fill:#345cd0">${pfPct(val(lastD, 'nav') / 100, 1)}</text>`;
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Cumulative return, portfolio vs equal-weight benchmark, ${esc(range)} window">${s}</svg>`;
  }

  /* ---------- holdings drawer: the full per-name confidence chain (PortfolioCore.computeViews) ---------- */
  function drawerHTML(tk) {
    const L = LAST; if (!L) return '';
    const P = L.pf.params, ex = L.excluded.has(tk), basis = (L.pf.exclude || {})[tk] || '';
    const v = L.vBy[tk], w = L.tw ? (L.tw.weights[tk] || 0) : null, cur = L.lastDay.w[tk] || 0;
    const ns = (L.state && L.state.names && L.state.names[tk]) || {};
    const wn = L.watch ? (L.watch[tk] || 0) : 0;
    const wpen = Math.max(P.watchPenaltyFloor, Math.pow(P.watchPenalty, wn));
    const name = (L.names && L.names[tk]) || '';
    const pxBasis = L.marks && L.marks.prices && L.marks.prices[tk] != null ? 'live mark · ' + (L.priceAsOf || 'time unknown') : 'saved price, undated';
    const row = (l, val, cl = '') => `<span class="${cl}">${l}</span><strong class="${cl}">${val}</strong>`;
    let body = `<p class="drawer-intro">${esc(name || tk)} · current book weight ${pfW(cur)} (from the ledger, ${esc(L.lastDay.d)}).</p>`;
    if (ex) {
      body += `<div class="drawer-section-title">Excluded by mandate</div>
        <p style="font-size:12px;color:var(--muted);line-height:1.7">${esc(basis)}</p>
        <p style="font-size:12px;color:var(--muted);margin-top:12px">Target now 0.0% — <strong>out by mandate</strong>. Exclusion removes the name from the book AND the equal-weight benchmark (the benchmark was rebuilt when the exclusion took effect); the row stays listed while any weight remains.</p>`;
    }
    if (v && v.mu != null) {
      body += `<div class="drawer-section-title">Confidence chain — PortfolioCore.computeViews</div><div class="ledger">`
        + row('Price (' + esc(pxBasis) + ')', moneyPx(v.price))
        + row('Target now (live engine)', moneyPx(v.target))
        + row('View μ = ln(target ÷ price)', v.mu.toFixed(4))
        + row('Hard backing of EV — (contracted floor + legacy) ÷ EV', (100 * v.hardShare).toFixed(0) + '%')
        + row('Confidence before watch items — ' + P.confMin + ' + ' + (1 - P.confMin).toFixed(2) + ' × hard', (P.confMin + (1 - P.confMin) * v.hardShare).toFixed(3))
        + row('Open watch items (×' + P.watchPenalty + ' each, floor ' + P.watchPenaltyFloor + ')', wn + ' → ×' + wpen.toFixed(3))
        + row('Confidence c', v.conf.toFixed(3))
        + row('λ fight-the-market (global)', Number(L.pf.state.lambda).toFixed(2))
        + row('Learning multiplier m' + (v.conviction ? ' — conviction, shrink exempt' : ns.opp > 0 ? ' — on watch (one opposed window)' : ''), v.m.toFixed(2))
        + row('ν = λ × c × m × μ', v.nu != null ? v.nu.toFixed(3) : '—', 'total')
        + row('Softmax weight (T = ' + P.temperature + ')', ex ? '0.0% — out by mandate' : v.nu == null || v.nu <= 0 ? 'no positive view — not sized' : w > 0 ? pfW(w) : 'below ' + (P.deMinimis * 100).toFixed(0) + '% de minimis — dropped', 'final')
        + `</div><p class="bridge-caption">Only ν &gt; 0 names compete in the softmax; gross = min(1, Σν⁺ ÷ ${P.grossFullAt}), so cash grows mechanically as edge thins. Trades fire only past the ${(P.band * 100).toFixed(0)}pt band.</p>`;
    } else if (!ex) {
      body += `<p style="font-size:12px;color:var(--muted);margin-top:16px">No target data for this name right now — the confidence chain needs the live engine (engine.js + data.json + portfolio-core.js). Cells on the table show — rather than a number this page did not compute.</p>`;
    }
    return `<div class="drawer-head"><h2 id="drawer-title">${esc(tk)}</h2><button class="icon-button" data-pf-close aria-label="Close">${icon('close')}</button></div><div class="drawer-body">${body}</div>`;
  }
  function openDrawer(tk) {
    if (typeof document === 'undefined' || !LAST) return;
    const d = document.getElementById('drawer'); if (!d || !d.showModal) return;
    const rf = document.activeElement;
    d.innerHTML = drawerHTML(tk);
    d.showModal();
    d.addEventListener('close', () => { if (rf && rf.focus) try { rf.focus(); } catch (e) {} }, { once: true });
  }

  /* ---------- one delegated listener, guarded, own data-pf-* attributes only ---------- */
  function wire() {
    if (WIRED || typeof document === 'undefined') return;
    WIRED = true;
    document.addEventListener('click', e => {
      const t = e.target.closest('[data-pf-range],[data-pf-scope],[data-pf-retry],[data-pf-close],[data-pf-name]');
      if (!t) return;
      if (t.hasAttribute('data-pf-range')) { e.preventDefault(); setRange(t.getAttribute('data-pf-range')); }
      else if (t.hasAttribute('data-pf-scope')) { e.preventDefault(); setScope(t.getAttribute('data-pf-scope')); }
      else if (t.hasAttribute('data-pf-retry')) { e.preventDefault(); retry(); refresh(); }
      else if (t.hasAttribute('data-pf-close')) { e.preventDefault(); const d = document.getElementById('drawer'); if (d && d.open) d.close(); }
      else if (t.hasAttribute('data-pf-name')) { openDrawer(t.getAttribute('data-pf-name')); }
    });
  }

  /* ---------- render (portfolio-ui.js:108-211, restated in the preview's components) ---------- */
  function render(p) {
    wire();
    const rq = p && typeof p.get === 'function' ? String(p.get('range') || '').toLowerCase() : '';
    const range = WINDOWS[rq] ? rq : '1y';

    /* error screen ONLY when there is nothing to show — a failed background refresh must not wipe a healthy tab */
    if (ERR && (!PF || !PFH)) return `<section class="panel"><div class="empty"><strong>Could not load portfolio files</strong>${esc(ERR)}<p style="margin-top:14px"><button class="button" data-pf-retry>Retry</button></p></div></section>`;
    if (!PF || !PFH) { load(); return '<section class="panel"><div class="loading">Loading the paper book…</div></section>'; }
    if (!ERR && Date.now() - AT > 1800000) load();   // stale open tab: refetch every 30 min (the daily Action commits new marks)

    const allDays = PFH.days || [], meta = PFH.meta || {};
    if (!allDays.length) return `<section class="panel"><div class="empty"><strong>portfolio-history.json has no records</strong><p style="margin-top:14px"><button class="button" data-pf-retry>Retry</button></p></div></section>`;
    const gLabel = meta.pit ? 'reconstructed genesis' : 'simulated genesis';
    const days = scopeDays(allDays, PF.backtestThrough);
    const last = allDays[allDays.length - 1];
    const liveDays = allDays.filter(d => d.d > PF.backtestThrough);
    const liveBase = liveDays.length ? allDays[allDays.length - 1 - liveDays.length] : null;
    let peak = 0, mdd = 0; days.forEach(d => { peak = Math.max(peak, d.nav); mdd = Math.max(mdd, 1 - d.nav / peak); });

    const tv = todayViews();
    const excluded = tv ? tv.excluded : new Set(Object.keys(PF.exclude || {}));
    const tw = tv ? tv.tw : null;
    const vBy = {}; if (tv) tv.views.forEach(v => { vBy[v.tk] = v; });
    LAST = { pf: PF, lastDay: last, vBy, tw, excluded, watch: tv && tv.watch, state: tv && tv.state, names: tv && tv.names, marks: tv && tv.marks, priceAsOf: tv && tv.priceAsOf };
    const targetBasis = !tv ? 'target engine unavailable — cells show —' : tv.priceAsOf ? 'live marks · ' + tv.priceAsOf : 'saved prices, undated';

    let h = `<div class="date-rule"><span>Paper book · as of ${esc(dateLong(PF.asOf || last.d))}</span><span>ledger ${esc(meta.start || allDays[0].d)} → ${esc(last.d)} · base ${esc(meta.base != null ? meta.base : 100)}</span></div>`;

    /* honest-status notes: failed background refresh keeps the last state; moved dials are flagged */
    if (ERR) h += `<div class="snapshot-banner">${icon('info')}<span>Background refresh failed (${esc(ERR)}) — showing the last loaded state.</span><button class="text-button" data-pf-retry>Retry now</button></div>`;
    if (dialsMoved()) h += `<div class="snapshot-banner">${icon('info')}<span><strong>Dials moved</strong> — "Target now" below reflects your sandbox dial settings, not the base case the daily job trades. Hit "Reset to base case" in the assumptions drawer to see the job's view.</span></div>`;

    /* metric strip — the six pf-stats (portfolio-ui.js:126-135), scope-aware */
    h += `<div class="metric-strip pf-strip">`
      + metric('NAV (base 100)', last.nav.toFixed(1), esc(last.d))
      + (SCOPE === 'live'
        ? metric('Live return', liveBase ? pfPct(last.nav / liveBase.nav - 1) : '—', liveBase ? 'vs equal-weight ' + pfPct(last.bench / liveBase.bench - 1) : 'no live records yet', liveBase && last.nav / liveBase.nav - 1 >= 0 ? 'positive' : liveBase ? 'negative' : '')
        : metric('Total return', pfPct(last.nav / (meta.base || 100) - 1, 0), 'vs equal-weight ' + pfPct(last.bench / (meta.base || 100) - 1, 0) + ' · incl. genesis', last.nav / (meta.base || 100) - 1 >= 0 ? 'positive' : 'negative'))
      + metric('Live period', liveBase ? pfPct(last.nav / liveBase.nav - 1) : 'starts next close', liveBase ? liveDays.length + ' trading days · bench ' + pfPct(last.bench / liveBase.bench - 1) : 'genesis only so far')
      + metric('Max drawdown', pfPct(-mdd, 0), SCOPE === 'live' ? 'live era only' : 'incl. genesis', 'negative')
      + metric('Invested', pfW(1 - last.cash), 'cash ' + pfW(last.cash))
      + metric('λ fight-the-market', Number(PF.state.lambda).toFixed(2), 'restarted neutral at go-live')
      + `</div>`;

    /* NAV vs equal-weight chart — the ONE surface that earns full chart treatment */
    const rangeBtns = Object.keys(WINDOWS).map(r => `<button data-pf-range="${r}" aria-pressed="${range === r}">${r.toUpperCase()}</button>`).join('');
    const scopeBtns = [['all', 'Incl. genesis'], ['live', 'Live only']].map(([k, l]) => `<button data-pf-scope="${k}" aria-pressed="${SCOPE === k}">${l}</button>`).join('');
    const svg = chartSVG(days, meta, range);
    const chartCaption = `Vertical axis = cumulative <b>%</b> return from the start of the selected window (both lines rebased to 0%). <b>solid</b> portfolio · <b>dashed</b> equal-weight benchmark`
      + (SCOPE === 'live'
        ? ` · live records only (from ${esc(PF.backtestThrough)})`
        : ` · shaded = ${gLabel}${meta.pit ? ' (point-in-time facts, today’s model & universe — de-biased, still not a track record)' : ' (today’s data.json against last year’s prices — machinery validation, <b>not evidence of alpha</b>)'}; the live record starts at the clay line`) + '.';
    h += `<section class="panel report-section">
      <div class="chart-header"><div><h2>Cumulative return vs equal-weight universe</h2><p>Trading-day windows: 1D/5D/1M/6M/1Y · scope ${SCOPE === 'live' ? 'live only' : 'incl. genesis'}</p></div>
        <div class="pf-toggles"><div class="chart-toggle" role="group" aria-label="Chart range">${rangeBtns}</div><div class="chart-toggle" role="group" aria-label="History scope">${scopeBtns}</div></div></div>
      ${svg ? `<div class="chart">${svg}</div><div class="chart-legend"><span><i class="swatch"></i>Portfolio NAV</span><span><i class="swatch dashed"></i>Equal-weight benchmark</span>${SCOPE !== 'live' ? `<span><i class="swatch" style="background:#7c93b5;opacity:.35;height:9px"></i>${esc(gLabel)}</span>` : ''}</div>` : `<div class="padded muted" style="padding-top:6px">not enough history for this window yet</div>`}
      <div class="chart-note">${chartCaption}</div>
      ${meta.note ? `<details class="read-more"><summary>About the ${meta.pit ? 'reconstruction' : 'simulation'}</summary><p>${esc(meta.note)}</p></details>` : ''}
    </section>`;

    /* absolute returns table — the number the chart is drawing (portfolio-ui.js:137-143) */
    const retCell = x => x == null ? '<td class="num">—</td>' : `<td class="num ${x.r >= 0 ? 'positive' : 'negative'}">${pfPct(x.r, Math.abs(x.r) < 0.10 ? 1 : 0)}${x.partial ? '<span title="shorter history than the window">*</span>' : ''}</td>`;
    h += `<section class="panel report-section"><div class="panel-header"><div><h2>Absolute returns</h2><p>${SCOPE === 'live' ? 'live records only' : 'incl. genesis'} · trading-day windows</p></div></div>
      <div class="table-scroll"><table class="plain-table"><thead><tr><th scope="col"></th><th scope="col" class="num">1D</th><th scope="col" class="num">5D</th><th scope="col" class="num">1M</th><th scope="col" class="num">6M</th><th scope="col" class="num">1Y</th></tr></thead><tbody>`
      + [['Portfolio', 'nav'], ['Equal-weight', 'bench']].map(([lbl, key]) => `<tr><th scope="row">${lbl}</th>` + [1, 5, 21, 126, 252].map(nn => retCell(pfRet(days, nn, key))).join('') + `</tr>`).join('')
      + `</tbody></table></div>${SCOPE === 'live' ? `<div class="chart-note">Live records only — a window longer than the live era shows the since-go-live return, marked *.</div>` : ''}</section>`;

    /* holdings: current book (ledger) → today's target; excluded names show until sold (portfolio-ui.js:155-168) */
    const names = new Set([...Object.keys(last.w || {}), ...Object.keys(tw ? tw.weights : {}), ...excluded].filter(tk => (last.w && last.w[tk]) || (tw && tw.weights[tk]) || excluded.has(tk)));
    const rows = [...names].map(tk => ({ tk, cur: (last.w && last.w[tk]) || 0, tgt: tw ? (tw.weights[tk] || 0) : null, v: vBy[tk] })).sort((a, b) => (b.tgt || 0) - (a.tgt || 0) || b.cur - a.cur);
    h += `<section class="panel report-section"><div class="panel-header"><div><h2>Holdings — current book → today's target</h2><p>Click a name for its full confidence chain</p></div><span class="muted small nowrap">Target now · ${esc(targetBasis)}</span></div>
      <div class="table-scroll"><table class="plain-table"><thead><tr><th scope="col">Name</th><th scope="col" class="num">Weight</th><th scope="col" class="num">Target now</th><th scope="col" class="num">Upside</th><th scope="col" class="num">Confidence</th><th scope="col" class="num">Mult m</th><th scope="col" class="num">View ν</th></tr></thead><tbody>`;
    rows.forEach(r => {
      const v = r.v || {}, ex = excluded.has(r.tk);
      h += `<tr class="pf-row" data-pf-name="${esc(r.tk)}"><td><button class="text-button" data-pf-name="${esc(r.tk)}" aria-label="Open the ${esc(r.tk)} confidence chain">${esc(r.tk)}</button>${ex ? ` <span class="source-pill rumored" title="${esc((PF.exclude || {})[r.tk] || '')}">excluded</span>` : ''}</td>
        <td class="num">${pfW(r.cur)}</td>
        <td class="num">${ex ? '0.0%' : r.tgt != null ? pfW(r.tgt) : '—'}</td>
        <td class="num ${v.upside != null ? (v.upside >= 0 ? 'positive' : 'negative') : ''}">${v.upside != null ? pfPct(v.upside, 0) : '—'}</td>
        <td class="num" title="hard backing ${(100 * (v.hardShare || 0)).toFixed(0)}% of EV (contracted floor + legacy)">${v.conf != null ? (v.conf * 100).toFixed(0) + '%' : '—'}</td>
        <td class="num">${v.m != null ? v.m.toFixed(2) : '—'}</td>
        <td class="num">${ex ? 'out by mandate' : v.nu != null ? v.nu.toFixed(3) : '—'}</td></tr>`;
    });
    h += `<tr><th scope="row">Cash</th><td class="num">${pfW(last.cash)}</td><td class="num">${tw ? pfW(tw.cash) : '—'}</td><td class="num">—</td><td class="num">—</td><td class="num">—</td><td class="num">0</td></tr>`;
    h += `</tbody></table></div>
      <div class="chart-note">ν = λ × confidence × m × ln(target ÷ price) — the shrunk view that sizes the book. Confidence comes from how much of the target is contracted floor + marked legacy vs pipeline hope, less open watch-items. Softmax at T=${esc(PF.params.temperature)} (low = concentrated, no cap, by mandate); gross ${tw ? (tw.gross * 100).toFixed(0) + '%' : '—'} — cash grows mechanically when total edge thins. Trades fire only past the ${(PF.params.band * 100).toFixed(0)}pt band.</div></section>`;

    /* attribution: who actually made the money (portfolio-ui.js:170-182) */
    const showSim = SCOPE !== 'live';
    const att = attribution(allDays, PF.backtestThrough);
    const attNames = [...new Set([...Object.keys(att.sim), ...Object.keys(att.live)])]
      .map(tk => ({ tk, sim: att.sim[tk] || 0, live: att.live[tk] || 0 }))
      .filter(a => showSim || Math.abs(a.live) > 0.005)
      .sort((a, b) => showSim ? ((b.live + b.sim) - (a.live + a.sim)) : (b.live - a.live));
    if (attNames.length) {
      const f = x => x ? `<span class="${x >= 0 ? 'positive' : 'negative'}">${x >= 0 ? '+' : ''}${x.toFixed(1)}</span>` : '—';
      h += `<section class="panel report-section"><div class="panel-header"><div><h2>Attribution — NAV points by name</h2><p>winners AND losers · yesterday's weight × today's return</p></div></div>
        <div class="table-scroll"><table class="plain-table"><thead><tr><th scope="col">Name</th>${showSim ? `<th scope="col" class="num">${meta.pit ? 'Reconstructed' : 'Simulated'}</th>` : ''}<th scope="col" class="num">Live</th></tr></thead><tbody>`
        + attNames.map(a => `<tr><th scope="row">${esc(a.tk)}</th>${showSim ? `<td class="num">${f(a.sim)}</td>` : ''}<td class="num">${f(a.live)}</td></tr>`).join('')
        + `</tbody></table></div><div class="chart-note">Every name that ${showSim ? 'ever held' : 'holds'} weight — winners AND losers (yesterday's weight × today's return, in points of a base-100 NAV). ${showSim ? `The ${meta.pit ? 'reconstructed' : 'simulated'} column carries the genesis caveats (see chart label); the` : 'The'} live column is the real scoreboard.</div></section>`;
    }

    /* learning state (portfolio-ui.js:184-191) */
    const shrunk = Object.entries(PF.state.names || {}).filter(([, s]) => s.m < 0.995 || s.opp > 0).sort((a, b) => a[1].m - b[1].m);
    let lastLearn = null;
    for (let i = days.length - 1; i >= 0; i--) if (days[i].learn) { lastLearn = { d: days[i].d, ...days[i].learn }; break; }
    h += `<section class="panel report-section"><div class="panel-header"><div><h2>Learning — where the market disagrees with us</h2><p>per-name multipliers · λ follows realized rank-IC · live records only</p></div></div>`;
    if (shrunk.length) {
      h += `<div class="table-scroll"><table class="plain-table"><thead><tr><th scope="col">Name</th><th scope="col" class="num">Multiplier</th><th scope="col"></th></tr></thead><tbody>`
        + shrunk.map(([tk, s]) => `<tr><th scope="row">${esc(tk)}</th><td class="num">${s.m.toFixed(2)}${s.opp > 0 ? ' <span class="source-pill rumored">on watch</span>' : ''}</td><td style="white-space:normal;max-width:460px">${s.conviction ? '<span class="source-pill disclosed">conviction — shrink exempt</span>' : s.m < 0.995 ? 'market opposed this view in two consecutive windows; sizing shrunk, recovers when vindicated' : 'one opposed window — shrinks if the next window agrees'}</td></tr>`).join('')
        + `</tbody></table></div>`;
    } else {
      h += `<div class="chart-note" style="border-top:0">No active disagreements — every multiplier at 1.0 (learning restarted neutral at go-live; updates every ${esc(PF.params.learnEvery)} trading days over a ${esc(PF.params.lookback)}-day window vs the universe <b>median</b>, only on live records${lastLearn ? ` · last simulated update ${esc(lastLearn.d)}: rank-IC ${esc(lastLearn.ic)}` : ''}). To exempt a name from shrinkage, set <b>conviction: true</b> on it in portfolio.json.</div>`;
    }
    h += `</section>`;

    /* operational flags + notes: quarantines, basis rescales, corporate actions — surfaced, never silent (portfolio-ui.js:193-202) */
    const flags = [];
    Object.entries(PF.suspect || {}).forEach(([tk, cnt]) => { if (cnt > 0) flags.push(`${tk}: suspect print quarantined (day ${cnt}/3)`); });
    Object.entries((PFH.meta || {}).rescaled || {}).forEach(([tk, r]) => { flags.push(`${tk}: genesis price series basis-rescaled ×${r} (chart source served a different share basis than the live listing)`); });
    const noteDays = days.filter(d => d.notes && d.notes.length).slice(-5);
    if (flags.length || noteDays.length) {
      h += `<section class="panel report-section"><div class="panel-header"><div><h2>Operational notes</h2><p>quarantines, basis rescales and day notes from the ledger — last 5 note-days</p></div></div><div class="pf-flags">`;
      flags.forEach(f => { h += `<div class="pf-flag mid"><span class="pf-flag-tag">flag</span><span>${esc(f)}</span></div>`; });
      noteDays.forEach(d => d.notes.forEach(note => {
        const hot = note.includes('SUSPECT') || note.includes('frozen') || note.includes('REBALANCE ABORTED');
        h += `<div class="pf-flag${hot ? ' mid' : ''}"><span class="pf-flag-tag">${esc(d.d.slice(5))}</span><span>${esc(note)}</span></div>`;
      }));
      h += `</div></section>`;
    }

    /* trade ledger: latest 12 trades, tcBps caption (portfolio-ui.js:204-208; C14 — 12 stays) */
    const tds = [];
    for (let i = days.length - 1; i >= 0 && tds.length < 12; i--) (days[i].trades || []).forEach(t => { if (tds.length < 12) tds.push({ d: days[i].d, ...t }); });
    if (tds.length) {
      h += `<section class="panel report-section"><div class="panel-header"><div><h2>Latest trades</h2><p>paper, ${esc(PF.params.tcBps)}bps cost</p></div></div>
        <div class="table-scroll"><table class="plain-table"><thead><tr><th scope="col">Date</th><th scope="col">Name</th><th scope="col" class="num">Trade</th><th scope="col" class="num">Price</th><th scope="col" class="num">To weight</th></tr></thead><tbody>`
        + tds.map(t => `<tr><td class="nowrap">${esc(t.d)}</td><th scope="row">${esc(t.tk)}</th><td class="num ${t.usd >= 0 ? 'positive' : 'negative'}">${t.usd >= 0 ? 'buy' : 'sell'} ${Math.abs(t.usd).toFixed(1)}</td><td class="num">$${esc(t.px)}</td><td class="num">${pfW(t.to)}</td></tr>`).join('')
        + `</tbody></table></div><div class="chart-note">Trade sizes are NAV points (base 100). The daily job runs after US close (GitHub Action) — facts change the book only by flowing through data.json first.</div></section>`;
    }

    return h;
  }

  root.PortfolioView = {
    render,
    load,
    retry,
    setScope,
    drawerHTML,   // exposed so the node acceptance harness can verify the confidence chain
    /* Checks' portfolio ledger group and the Raises event study consume this same load (spec must_preserve) */
    data() { return { portfolio: PF, history: PFH, error: ERR, loadedAt: AT }; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
