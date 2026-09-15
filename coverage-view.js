/* CSS moved to styles.css (Wave 2 consolidation) */

/* Coverage tab body for /infrastructure?tab=coverage — confirmed contracted value (gross
 * headline $) vs basic-share market cap, one row per name, per-contract breakdown.
 * Rebuilt from production renderCoverage (GPU Cloud and Colo Tracker/app.js:148-188).
 * Reads RAW company fields from CloudModel.source (sharesReported is raw-only) joined with
 * CloudModel.current companies for price (live mark when present) — no engine output, no ramp.
 */
(function (root) {
  'use strict';
  var SORT_KEYS = ['tk', 'mcap', 'gross', 'wterm', 'ann', 'totcov', 'anncov'];
  var open = {}; // ticker -> true while its breakdown is expanded; survives repaints (live-quote refresh)
  var wired = false;

  // Production number formats (app.js:27): $XM below 1000, $X.XB at/above — parity to displayed rounding.
  function fmtM(x) { return Math.abs(x) >= 1000 ? '$' + (x / 1000).toFixed(1) + 'B' : '$' + x.toFixed(0) + 'M'; }
  function pct0(x) { return (x * 100).toFixed(0) + '%'; }

  // Production math, exactly (app.js:150-159): per-kind value basis (leases grossTotalM,
  // contracts totalRevM), effective!==false and gross<=0 excluded, annualized per-item then
  // summed, wterm gross-weighted. Guard (spec failure state): an item with missing/zero termYrs
  // keeps its gross but is skipped from annualized & wterm and renders its term as an em-dash.
  function computeRows() {
    var src = root.CloudModel.source, cur = root.CloudModel.current;
    var byTk = {};
    cur.companies.forEach(function (c) { byTk[c.ticker] = c; });
    return src.companies.map(function (c) {
      var a = byTk[c.tk];
      var px = a ? a.price : (c.price || 0); // adapted price = live mark when present, saved otherwise
      var mcap = (c.sharesReported || c.shares) * px; // reported (basic) shares × price, $M
      var items = [];
      (c.leases || []).forEach(function (l) {
        if (l.effective === false) return;
        var g = l.grossTotalM || 0; if (g <= 0) return;
        var t = Number(l.termYrs), ok = t > 0;
        items.push({ kind: 'lease', cp: l.counterparty, gross: g, term: ok ? t : null, mw: l.mw || null, ann: ok ? g / t : null });
      });
      (c.contracts || []).forEach(function (x) {
        if (x.effective === false) return;
        var g = x.totalRevM || 0; if (g <= 0) return;
        var t = Number(x.termYrs), ok = t > 0;
        items.push({ kind: 'compute', cp: x.counterparty, gross: g, term: ok ? t : null, mw: x.mw || null, ann: ok ? g / t : null });
      });
      var gross = items.reduce(function (s, i) { return s + i.gross; }, 0);
      var termed = items.filter(function (i) { return i.term != null; });
      var ann = termed.reduce(function (s, i) { return s + i.ann; }, 0);
      var termedGross = termed.reduce(function (s, i) { return s + i.gross; }, 0);
      var wterm = termedGross ? termed.reduce(function (s, i) { return s + i.gross * i.term; }, 0) / termedGross : 0;
      return {
        tk: c.tk, name: c.name || '', mcap: mcap, items: items, gross: gross, ann: ann, wterm: wterm,
        anncov: mcap ? ann / mcap : 0, totcov: mcap ? gross / mcap : 0
      };
    });
  }

  function sortState(p) {
    var key = SORT_KEYS.indexOf(p.get('sort')) >= 0 ? p.get('sort') : 'anncov';
    var dir = p.get('dir');
    if (dir !== 'asc' && dir !== 'desc') dir = key === 'tk' ? 'asc' : 'desc'; // production first-click defaults (app.js:186)
    return { key: key, dir: dir };
  }

  function setParams(pairs) {
    var q = new URLSearchParams(location.search);
    Object.keys(pairs).forEach(function (k) { pairs[k] ? q.set(k, pairs[k]) : q.delete(k); });
    history.replaceState({}, '', location.pathname + (q.size ? '?' + q.toString() : ''));
    if (root.CVApp) root.CVApp.refresh();
  }

  function toggle(tk) {
    var d = document.getElementById('cov-detail-' + tk);
    if (!d) return;
    var show = d.hidden;
    d.hidden = !show;
    open[tk] = show || undefined;
    if (!show) delete open[tk];
    var btn = document.querySelector('[data-cov-toggle="' + tk + '"]');
    if (btn) btn.setAttribute('aria-expanded', show ? 'true' : 'false');
  }

  function wire() {
    if (wired || typeof document === 'undefined') return;
    wired = true;
    document.addEventListener('click', function (e) {
      var s = e.target.closest('[data-cov-sort]');
      if (s) {
        var key = s.getAttribute('data-cov-sort');
        var cur = sortState(new URLSearchParams(location.search));
        var dir = cur.key === key ? (cur.dir === 'desc' ? 'asc' : 'desc') : (key === 'tk' ? 'asc' : 'desc');
        setParams({ sort: key, dir: dir });
        return;
      }
      var t = e.target.closest('[data-cov-toggle]');
      if (t) { toggle(t.getAttribute('data-cov-toggle')); return; }
      var row = e.target.closest('tr[data-cov-row]');
      if (row && !e.target.closest('a')) toggle(row.getAttribute('data-cov-row'));
    });
    document.addEventListener('change', function (e) {
      if (e.target && e.target.id === 'cov-company') setParams({ company: e.target.value });
    });
  }

  function th(key, label, num, st) {
    var active = st.key === key;
    return '<th scope="col"' + (num ? ' class="num"' : '') +
      (active ? ' aria-sort="' + (st.dir === 'asc' ? 'ascending' : 'descending') + '"' : '') +
      '><button type="button" data-cov-sort="' + key + '" aria-label="Sort by ' + label + '">' + label +
      (active ? '<span aria-hidden="true">' + (st.dir === 'asc' ? '↑' : '↓') + '</span>' : '') +
      '</button></th>';
  }

  function render(p) {
    var UI = root.UI;
    if (!(root.CloudModel && root.CloudModel.current && root.CloudModel.source)) {
      return '<section class="panel padded"><div class="empty"><strong>Coverage has no data yet</strong>The model data has not finished loading. Reload the preview if this persists.</div></section>';
    }
    wire();
    var esc = UI.esc, meta = root.CloudModel.current.meta;
    var live = !!meta.priceAsOf;
    var rows = computeRows();
    var st = sortState(p);
    var company = p.get('company') || '';
    if (company && !rows.some(function (r) { return r.tk === company; })) company = '';
    var visible = rows.filter(function (r) { return !company || r.tk === company; });
    var kf = function (r) { return r[st.key]; };
    visible.sort(function (x, y) {
      var av = kf(x), bv = kf(y);
      return (typeof av === 'string' ? av.localeCompare(bv) : av - bv) * (st.dir === 'asc' ? 1 : -1);
    });

    // Universe aggregates over ALL names after exclusions — never the filtered subset (production app.js:164).
    var uMcap = 0, uGross = 0, uAnn = 0;
    rows.forEach(function (r) { uMcap += r.mcap; uGross += r.gross; uAnn += r.ann; });

    var strip = '<div class="metric-strip">' +
      UI.metric('Universe market cap', fmtM(uMcap), live ? 'Reported basic shares × live marks' : 'Reported basic shares × saved prices') +
      UI.metric('Confirmed contracted', fmtM(uGross), 'Gross headline $ · signed &amp; effective only') +
      UI.metric('Annualized', fmtM(uAnn) + '<span class="suffix">/yr</span>', 'Σ(gross ÷ term) · term-average, not run-rate') +
      UI.metric('Backlog ÷ market cap', pct0(uMcap ? uGross / uMcap : 0), 'Confirmed contracted ÷ universe market cap') +
      '</div>';

    var filterbar = '<div class="filterbar" style="margin:0 0 20px;justify-content:flex-start">' +
      '<select id="cov-company" class="select-control" aria-label="Filter coverage rows by company">' +
      '<option value="">All companies</option>' +
      rows.slice().sort(function (a, b) { return a.tk.localeCompare(b.tk); }).map(function (r) {
        return '<option value="' + esc(r.tk) + '"' + (company === r.tk ? ' selected' : '') + '>' + esc(r.tk) + ' · ' + esc(r.name) + '</option>';
      }).join('') + '</select></div>';

    var rule = company
      ? '<div class="date-rule"><span>Showing ' + visible.length + ' of ' + rows.length + ' names</span><span>The aggregates above cover the full universe</span></div>'
      : '';

    var caption = live
      ? 'Live marks · updated ' + esc(meta.priceAsOf) + ' · names without a mark keep saved prices'
      : 'Saved prices, undated';

    var head = '<tr>' +
      th('tk', 'Company', false, st) +
      th('mcap', 'Market cap', true, st) +
      th('gross', 'Contracted', true, st) +
      th('wterm', 'Avg term', true, st) +
      th('ann', 'Annualized', true, st) +
      th('totcov', 'Backlog ÷ cap', true, st) +
      th('anncov', 'Ann ÷ cap', true, st) +
      '</tr>';

    var body = visible.map(function (r) {
      var none = r.items.length === 0;
      var isOpen = !none && !!open[r.tk];
      var chev = none
        ? '<span class="cov-chev-spacer" aria-hidden="true"></span>'
        : '<button type="button" class="cov-chev" data-cov-toggle="' + esc(r.tk) + '" aria-expanded="' + isOpen + '" aria-controls="cov-detail-' + esc(r.tk) + '" aria-label="Per-contract breakdown for ' + esc(r.tk) + '">' + UI.icon('down') + '</button>';
      var h = '<tr' + (none ? '' : ' data-cov-row="' + esc(r.tk) + '"') + '>' +
        '<td><div class="cov-company">' + chev + '<div><span class="ticker-line">' + esc(r.tk) + '</span><span class="company-sub">' + esc(r.name) + '</span></div></div></td>' +
        '<td class="num">' + fmtM(r.mcap) + '</td>' +
        '<td class="num">' + (none ? '—' : fmtM(r.gross)) + '</td>' +
        '<td class="num">' + (none ? '—' : r.wterm.toFixed(1) + 'y') + '</td>' +
        '<td class="num">' + (none ? '—' : fmtM(r.ann) + '/y') + '</td>' +
        '<td class="num">' + (none ? '—' : pct0(r.totcov)) + '</td>' +
        '<td class="num">' + (none ? '—' : '<strong>' + pct0(r.anncov) + '</strong>') + '</td>' +
        '</tr>';
      if (!none) {
        var its = r.items.slice().sort(function (a, b) { return b.gross - a.gross; });
        h += '<tr class="cov-detail" id="cov-detail-' + esc(r.tk) + '"' + (isOpen ? '' : ' hidden') + '><td colspan="7">' +
          '<div class="cov-detail-box"><div class="table-scroll"><table class="plain-table">' +
          '<thead><tr><th>Counterparty</th><th>Kind</th><th class="num">Gross</th><th class="num">Term</th><th class="num">Annualized</th><th class="num">IT MW</th></tr></thead><tbody>' +
          its.map(function (it) {
            return '<tr><td style="max-width:300px;white-space:normal">' + esc(it.cp) + '</td>' +
              '<td><span class="source-pill' + (it.kind === 'lease' ? ' disclosed' : '') + '">' + (it.kind === 'lease' ? 'Data-centre lease' : 'GPU compute') + '</span></td>' +
              '<td class="num">' + fmtM(it.gross) + '</td>' +
              '<td class="num">' + (it.term != null ? it.term + 'y' : '—') + '</td>' +
              '<td class="num">' + (it.ann != null ? fmtM(it.ann) + '/y' : '—') + '</td>' +
              '<td class="num">' + (it.mw ? UI.n(it.mw, Number.isInteger(it.mw) ? 0 : 1) : '—') + '</td></tr>';
          }).join('') +
          '</tbody></table></div></div>' +
          '<a class="text-button cov-open-link" href="/company/' + esc(r.tk) + '">Open ' + esc(r.tk) + ' ' + UI.icon('arrow') + '</a>' +
          '</td></tr>';
      }
      return h;
    }).join('') || '<tr><td colspan="7"><div class="empty"><strong>No names match this filter</strong>Clear the company filter to see the full universe.</div></td></tr>';

    // Honest-methodology legend: production's four caveats + exclusion sentence (app.js:183),
    // with the price wording tracking the actual basis — never "live" while prices are saved.
    var legend = '<div class="chart-note"><strong>Market cap</strong> = reported (basic) shares × ' + (live ? 'live price' : 'saved price') + ' — tracks the tape, not fully-diluted. ' +
      '<strong>Contracted</strong> = gross value of every signed/effective lease + compute contract (the headline announced $, not NOI). ' +
      '<strong>Annualized</strong> = Σ(gross ÷ term) — a term-average, not a current run-rate (many contracts ramp from 2027+). ' +
      '<strong>Ann ÷ cap</strong> and <strong>Backlog ÷ cap</strong> measure contracted revenue against market value. ' +
      'Excludes options, LOIs and non-performing books. Click a row for the per-contract breakdown with terms.</div>';

    return strip + filterbar + rule +
      '<section class="panel" aria-labelledby="cov-title">' +
      '<div class="panel-header"><div><h2 id="cov-title">Contract coverage</h2><p>' + caption + '</p></div></div>' +
      '<div class="table-scroll"><table class="plain-table"><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>' +
      legend + '</section>';
  }

  root.CoverageView = { render: render, computeRows: computeRows };
})(typeof window !== 'undefined' ? window : globalThis);
