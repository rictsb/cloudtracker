/* CSS moved to styles.css (Wave 2 consolidation) */

/* Checks — the live data test suite (/checks body; the shell renders the page-top and Operations subnav).
   Runs the identical ChecksCore.runChecks assertions that `node checks.js` runs pre-push, in this
   browser, and never claims a verdict it did not compute. checks-core.js is used as-is, never forked. */
(function (root) {
  'use strict';

  const esc = s => root.UI && root.UI.esc ? root.UI.esc(s)
    : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = x => Number(x || 0).toLocaleString('en-US');
  const fdate = iso => root.UI && root.UI.date ? root.UI.date(iso) : String(iso || 'Not supplied');
  const mt = (label, value, note, cls) => root.UI && root.UI.metric ? root.UI.metric(label, value, note, cls || '')
    : '<div class="metric"><div class="metric-label">' + label + '</div><div class="metric-value ' + (cls || '') + '">' + value + '</div><div class="metric-note">' + note + '</div></div>';

  /* Verification-age bands (production app.js checkAge): ≤30d ok · 31–60d mid · >60d-or-never bad. */
  function checkAge(iso) {
    if (!iso) return { t: 'never', cls: 'bad' };
    const d = Math.round((Date.now() - new Date(iso)) / 86400000);
    return { t: d + 'd ago', cls: d > 60 ? 'bad' : d > 30 ? 'mid' : 'ok' };
  }

  /* Portfolio ledgers, lazily and without retry loops: one load attempt is kicked off from render;
     a failed load is never re-triggered from render (that would loop) — retry lives on the button. */
  let pfState = 'idle', pfFiles = null, pfError = '';
  function loadPf() {
    if (pfState === 'loading' || pfState === 'ok') return;
    pfState = 'loading'; pfError = '';
    let p;
    try {
      p = Promise.all([fetch('/portfolio.json', { cache: 'no-store' }), fetch('/portfolio-history.json', { cache: 'no-store' })]);
    } catch (e) { pfState = 'error'; pfError = (e && e.message) || 'fetch unavailable'; return; }
    p.then(([a, b]) => { if (!a.ok || !b.ok) throw new Error('HTTP ' + (a.ok ? b.status : a.status)); return Promise.all([a.json(), b.json()]); })
      .then(([portfolio, history]) => { pfFiles = { portfolio, history }; pfState = 'ok'; })
      .catch(e => { pfFiles = null; pfState = 'error'; pfError = e && e.message ? e.message : 'load failed'; })
      .then(() => { if (root.CVApp && root.CVApp.refresh) root.CVApp.refresh(); });
  }

  /* ---- sections ---- */

  function verdict(r) {
    const s = r.summary;
    const pfNote = pfState === 'ok' ? 'Includes the portfolio-ledger group'
      : pfState === 'loading' ? 'Portfolio-ledger group pending — ledgers loading'
      : 'Portfolio-ledger group not included — ledger not loaded';
    return '<section class="panel ck-vp"><div class="ck-verdict ' + (s.fail ? 'bad' : 'ok') + '">'
      + (s.fail ? '✗' : '✓') + ' ' + num(s.checksRun) + ' checks · ' + s.companies + ' companies · ' + s.sites
      + ' sites — <b>' + s.fail + ' FAIL</b> · ' + s.warn + ' warn · checked just now, in this browser, against the deployed data</div></section>'
      + '<div class="metric-strip ck-strip">'
      + mt('Checks run', num(s.checksRun), pfNote)
      + mt('Companies', s.companies, 'In the deployed data.json')
      + mt('Sites', s.sites, 'Capacity records checked')
      + mt('Failures', s.fail, s.fail ? 'Hard failures — fix before any push' : 'No hard failures', s.fail ? 'negative' : '')
      + mt('Warnings', s.warn, s.warn ? 'Judgement flags to review' : 'No warnings', s.warn ? 'ck-amber' : '')
      + '</div>';
  }

  function groupCard(g) {
    if (g.k === 'port' && pfState !== 'ok') {
      const body = pfState === 'loading'
        ? '<p class="ck-guard">Ledger loading — portfolio.json and portfolio-history.json are being fetched; the portfolio checks join the verdict when they arrive.</p>'
        : '<p class="ck-guard">Ledger not loaded' + (pfError ? ' — ' + esc(pfError) : '') + '. The suite ran without this group; its checks are excluded from the verdict above, not passed.</p><button type="button" class="button ck-retry" data-ckx-retry>Retry ledger checks</button>';
      return '<div class="panel ck-g"><div class="ck-g-head"><span class="ck-dot"></span><strong>' + esc(g.name) + '</strong><span class="ck-n">not run</span></div>' + body + '</div>';
    }
    const st = g.fail ? 'bad' : g.warn ? 'mid' : 'ok';
    const counts = g.pass + '/' + g.total + ' pass' + (g.warn ? ' · ' + g.warn + ' warn' : '') + (g.fail ? ' · ' + g.fail + ' FAIL' : '');
    return '<div class="panel ck-g"><div class="ck-g-head"><span class="ck-dot ' + st + '"></span><strong>' + esc(g.name) + '</strong><span class="ck-n">' + counts + '</span></div><p class="ck-guard">' + esc(g.guards) + '</p></div>';
  }

  function groupsSection(r) {
    return '<div class="date-rule"><span>What is checked</span><span>' + r.groupOrder.length + ' groups · definitions from checks-core.js</span></div>'
      + '<div class="ck-groups">' + r.groupOrder.map(k => groupCard(r.groups[k])).join('') + '</div>';
  }

  function findingsSection(r) {
    const inner = r.msgs.length
      ? r.msgs.map(m => '<div class="ck-m ' + (m.level === 'fail' ? 'fail' : 'warn') + '"><span class="ck-lv">' + (m.level === 'fail' ? 'FAIL' : 'warn') + '</span><span class="ck-tk">' + esc(m.tk) + '</span><span class="ck-msg">' + esc(m.msg) + '</span></div>').join('')
      : '<div class="empty"><strong>No findings</strong>Every assertion passed against the deployed data.</div>';
    return '<section class="panel report-section"><div class="panel-header"><div><h2>Findings' + (r.msgs.length ? ' (' + r.msgs.length + ')' : '') + '</h2><p>Every failed or warned assertion, in the order the suite produced it.</p></div></div>' + inner + '</section>';
  }

  function matrixSection(r, RAW) {
    const cols = r.groupOrder.filter(k => k !== 'config');
    const colCount = cols.length + 3;
    const head = '<tr><th scope="col">Company</th>'
      + cols.map(k => '<th scope="col" class="ck-c" aria-label="' + esc(r.groups[k].name) + '">' + esc(r.groups[k].name.split(' ')[0]) + '</th>').join('')
      + '<th scope="col" class="num">Capital verified</th><th scope="col" class="num">Contracts verified</th></tr>';
    const rows = (RAW.companies || []).map(c => {
      const pc = r.perCo[c.tk] || {}, v = c.verified || {};
      const a1 = checkAge(v.capital), a2 = checkAge(v.contracts);
      let hasDetail = false;
      const cells = cols.map(k => {
        const x = pc[k];
        if (!x || !(x.pass + x.warn + x.fail)) return '<td class="ck-c"><span class="muted">·</span></td>';
        const st = x.fail ? 'bad' : x.warn ? 'mid' : 'ok';
        const sym = x.fail ? '✗' : x.warn ? '⚠' : '✓';
        if (!x.msgs.length) return '<td class="ck-c ' + st + '">' + sym + '</td>';
        hasDetail = true;
        const cnt = x.fail + x.warn, id = 'ckx-' + esc(c.tk) + '-' + k;
        return '<td class="ck-c ' + st + '"><button type="button" class="ck-cb" data-ckx-cell="' + esc(c.tk) + '|' + k + '" aria-expanded="false" aria-controls="' + id + '" aria-label="' + esc(c.tk) + ' ' + esc(r.groups[k].name) + ': ' + cnt + ' issue' + (cnt === 1 ? '' : 's') + ' — show messages">' + sym + '<span class="ck-cn">' + cnt + '</span></button></td>';
      }).join('');
      let row = '<tr><td><a href="/company/' + esc(c.tk) + '">' + esc(c.tk) + '</a></td>' + cells
        + '<td class="num"><span class="ck-age ' + a1.cls + '">' + a1.t + '</span></td><td class="num"><span class="ck-age ' + a2.cls + '">' + a2.t + '</span></td></tr>';
      if (hasDetail) {
        const blocks = cols.filter(k => pc[k] && pc[k].msgs.length).map(k =>
          '<div id="ckx-' + esc(c.tk) + '-' + k + '" data-ckx-msgs="' + esc(c.tk) + '|' + k + '" hidden><strong>' + esc(c.tk) + ' · ' + esc(r.groups[k].name) + '</strong><ul>'
          + pc[k].msgs.map(m => '<li><span class="ck-lvi ' + (m.level === 'fail' ? 'fail' : 'warn') + '">' + (m.level === 'fail' ? 'FAIL' : 'warn') + '</span>' + esc(m.msg) + '</li>').join('')
          + '</ul></div>').join('');
        row += '<tr class="ck-detail" hidden data-ckx-detail="' + esc(c.tk) + '"><td colspan="' + colCount + '">' + blocks + '</td></tr>';
      }
      return row;
    }).join('');
    const legend = '✓ all assertions pass · ⚠ warnings · ✗ failures — tap or select a marked cell to read its messages. '
      + 'Verification ages: filings/contracts re-checked by the weekly sweep — <span class="ck-age ok">≤30d</span> <span class="ck-age mid">31–60d</span> <span class="ck-age bad">&gt;60d / never</span>. '
      + 'GPU pricing dials last checked vs market: <b>' + esc((RAW.config && RAW.config.verifiedPricing) || 'never') + '</b>.';
    return '<section class="panel report-section"><div class="panel-header"><div><h2>Per company</h2><p>Rows follow data.json order · company-scoped check groups (config checks are data-wide) · ages from each record’s verified stamps.</p></div></div>'
      + '<div class="table-scroll"><table class="plain-table ck-mx"><thead>' + head + '</thead><tbody>' + rows + '</tbody></table></div>'
      + '<div class="chart-note">' + legend + '</div></section>';
  }

  function watchSection(RAW) {
    const wi = RAW.watchItems || [];
    const inner = wi.length
      ? wi.map(w => '<div class="ck-m watch"><span class="ck-lv">watch</span><span class="ck-tk">' + esc(w.tk) + '</span><span class="ck-msg">' + esc(w.note) + '</span><span class="ck-when">' + esc(fdate(w.added)) + '</span></div>').join('')
      : '<div class="empty"><strong>No open watch-items</strong>The registry in data.json is empty.</div>';
    return '<section class="panel report-section"><div class="panel-header"><div><h2>Open watch-items' + (wi.length ? ' (' + wi.length + ')' : '') + '</h2><p>Standing follow-ups recorded in data.json — items to re-check, not computed findings.</p></div></div>' + inner + '</section>';
  }

  function footnote() {
    return '<section class="panel"><div class="chart-note">Deterministic checks run in this browser via <b>checks-core.js</b> — the identical code <b>node checks.js</b> runs before every push. Research checks (fully-diluted shares vs filings, new issuance, contract announcements, GPU spot pricing) run in the weekly sweep, which updates the verification stamps above on approval.</div></section>';
  }

  /* ---- failure states: never a false green ---- */

  function coreMissing() {
    return '<section class="panel"><div class="empty"><strong>The check suite could not load</strong>checks-core.js did not load, so no assertions ran. Treat the data as unverified — this is not a pass.<br><br><button class="button" onclick="location.reload()">Reload</button></div></section>' + footnote();
  }

  function dataMissing() {
    return '<section class="panel"><div class="empty"><strong>Waiting for the deployed data</strong>The suite runs against data.json once it loads. If the app could not load its data, this screen inherits that failure — reload to retry.<br><br><button class="button" onclick="location.reload()">Reload</button></div></section>';
  }

  function crashed(e) {
    return '<section class="panel ck-vp"><div class="ck-verdict bad">✗ the check suite itself crashed — treat as failing</div>'
      + '<div class="padded" style="padding-top:0"><p class="muted" style="font-size:12px">runChecks threw before it could produce a verdict: <b>' + esc(e && e.message ? e.message : String(e)) + '</b>. A crashed checker is an alarm, not silence — the data has not passed anything. Fix the data or the suite, then reload.</p><p style="margin-top:12px"><button class="button" onclick="location.reload()">Reload</button></p></div></section>' + footnote();
  }

  /* ---- render ---- */

  function render() {
    wire();
    if (!root.ChecksCore || typeof root.ChecksCore.runChecks !== 'function') return coreMissing();
    const RAW = root.CloudModel && root.CloudModel.source;
    if (!RAW) return dataMissing();
    if (pfState === 'idle' && typeof fetch === 'function') loadPf();
    let r;
    try {
      r = root.ChecksCore.runChecks(RAW, undefined, pfState === 'ok' ? pfFiles : null);
      if (!r || !r.summary || !r.groupOrder) throw new Error('checks returned no summary');
    } catch (e) { return crashed(e); }
    return verdict(r) + groupsSection(r) + findingsSection(r) + matrixSection(r, RAW) + watchSection(RAW) + footnote();
  }

  /* One document-level delegated listener, module-flag guarded; own data-ckx-* attributes only.
     Cell tap/Enter/Space expands that company-group's messages inline (the a11y replacement for
     production's title-attribute tooltips); the retry button makes exactly one attempt per click. */
  let wired = false;
  function wire() {
    if (wired || typeof document === 'undefined') return;
    wired = true;
    document.addEventListener('click', e => {
      if (e.target.closest('[data-ckx-retry]')) {
        pfState = 'idle'; pfFiles = null; pfError = '';
        loadPf();
        if (root.CVApp && root.CVApp.refresh) root.CVApp.refresh();
        return;
      }
      const btn = e.target.closest('[data-ckx-cell]');
      if (!btn) return;
      const key = btn.getAttribute('data-ckx-cell'), tk = key.split('|')[0];
      const table = btn.closest('table');
      if (!table) return;
      const wasOpen = btn.getAttribute('aria-expanded') === 'true';
      table.querySelectorAll('[data-ckx-cell][aria-expanded="true"]').forEach(b => b.setAttribute('aria-expanded', 'false'));
      table.querySelectorAll('tr[data-ckx-detail]').forEach(row => { row.hidden = true; });
      table.querySelectorAll('[data-ckx-msgs]').forEach(d => { d.hidden = true; });
      if (!wasOpen) {
        btn.setAttribute('aria-expanded', 'true');
        const row = table.querySelector('tr[data-ckx-detail="' + tk + '"]');
        const block = table.querySelector('[data-ckx-msgs="' + key + '"]');
        if (row) row.hidden = false;
        if (block) block.hidden = false;
      }
    });
  }

  root.ChecksView = { render };
})(typeof window !== 'undefined' ? window : globalThis);
