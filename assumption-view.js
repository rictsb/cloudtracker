/* Economic review inbox. The background snapshot is read-only; triage goes through
   the existing proposal queue. A displayed finding never changes model inputs. */
(function (root) {
  'use strict';
  const API = 'https://api.github.com/repos/rictsb/cloudtracker/contents/';
  const FAMILIES = { capacity: 'Capacity → revenue', economics: 'Equipment economics', funding: 'Funding → equity' };
  const LABELS = { consistent: 'Reconciled', review: 'Review', error: 'Error', insufficient: 'Incomplete', 'not-applicable': 'Not applicable' };
  let snapshot = null, queue = null, state = 'idle', error = '', sourceMatch = null, quoteMatch = null, loadedAt = 0;
  let filter = { ticker: '', family: '', severity: 'actionable', showKept: false }, busy = false;
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const n = (v, d = 1) => Number.isFinite(v) ? v.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d }) : '—';
  const money = v => Number.isFinite(v) ? '$' + n(v, 2) : 'Unavailable';
  const time = v => v && Number.isFinite(Date.parse(v)) ? new Date(v).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }) : 'Not yet reviewed';
  const safeURL = v => { try { const u = new URL(v); return ['https:', 'http:'].includes(u.protocol) ? u.href : ''; } catch (_) { return ''; } };
  const stable = v => v && typeof v === 'object' ? Array.isArray(v) ? '[' + v.map(stable).join(',') + ']' : '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}' : JSON.stringify(v);
  async function digest(v) { return Array.from(new Uint8Array(await root.crypto.subtle.digest('SHA-256', new TextEncoder().encode(stable(v))))).map(x => x.toString(16).padStart(2, '0')).join(''); }
  const refresh = () => root.CVApp && root.CVApp.refresh();
  const dry = () => new URLSearchParams(root.location?.search || '').get('dryrun') === '1';
  const token = () => { try { return root.localStorage.getItem('cv-gh-token') || ''; } catch (_) { return ''; } };
  async function json(url) {
    const controller = typeof root.AbortController === 'function' ? new root.AbortController() : null;
    let timer;
    try { return await Promise.race([
      (async () => { const r = await fetch(url, { cache: 'no-store', ...(controller ? { signal: controller.signal } : {}) }); if (!r.ok) throw new Error(url + ' returned HTTP ' + r.status); return r.json(); })(),
      new Promise((_, reject) => { timer = setTimeout(() => { controller?.abort(); reject(new Error(url + ' timed out. Try refreshing.')); }, 15000); })
    ]); } finally { clearTimeout(timer); }
  }
  async function load(force = false) {
    if (state === 'loading' || (!force && state !== 'idle')) return;
    state = 'loading'; error = ''; sourceMatch = null; quoteMatch = null;
    try {
      const results = await Promise.allSettled([json('/assumption-review.json'), json('/proposals.json'), json('/data.json'), json('/market-prices.json')]);
      if (results[0].status !== 'fulfilled') throw results[0].reason;
      snapshot = results[0].value;
      if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.findings) || !Array.isArray(snapshot.companies)) throw new Error('The review snapshot is incomplete.');
      queue = results[1].status === 'fulfilled' ? results[1].value : null;
      if (results[2].status === 'fulfilled' && root.crypto?.subtle && snapshot.sourceHash) sourceMatch = await digest(results[2].value) === snapshot.sourceHash;
      if (results[3].status === 'fulfilled' && root.crypto?.subtle && snapshot.quoteHash) quoteMatch = await digest(results[3].value) === snapshot.quoteHash;
      state = 'ready'; loadedAt = Date.now();
    } catch (e) { state = 'error'; error = e.message || 'Review unavailable'; }
    refresh();
  }
  function decision(f) {
    const d = queue?.assumptionReviews?.[f.id];
    if (!d || d.fingerprint !== f.fingerprint || (d.reviewAfter && d.reviewAfter < new Date().toISOString().slice(0, 10))) return null;
    return d;
  }
  function research(f) {
    const r = queue?.assumptionResearch?.findings?.[f.id];
    return r && r.fingerprint === f.fingerprint ? r : null;
  }
  function freshEnough(s = snapshot) { const stamp = Date.parse(s?.checkedAt); return Number.isFinite(stamp) && stamp <= Date.now() + 300000 && Date.now() - stamp <= (s?.cadence?.overdueAfterHours || 30) * 3600000; }
  function triageReady() { return snapshot?.status === 'ready' && sourceMatch === true && quoteMatch === true && freshEnough() && queue !== null; }
  function statusBanner() {
    const old = !freshEnough();
    if (snapshot.status === 'error') return '<div class="ar-banner error" role="alert"><strong>The last numerical review failed.</strong> ' + esc(snapshot.error || 'Results are unavailable.') + ' Last successful run: ' + esc(time(snapshot.lastSuccessAt)) + '.</div>';
    if (sourceMatch === false) return '<div class="ar-banner review" role="status"><strong>Model changes are awaiting review.</strong> This snapshot describes an earlier data version. Triage is paused until the background review catches up.</div>';
    if (quoteMatch === false) return '<div class="ar-banner review" role="status"><strong>New market quotes are awaiting review.</strong> Sensitivities below retain the reviewed market snapshot. Triage resumes when the background review catches up.</div>';
    if (old) return '<div class="ar-banner review" role="status"><strong>Numerical review overdue.</strong> These are the last available findings, not a fresh assessment.</div>';
    if (sourceMatch === null || quoteMatch === null) return '<div class="ar-banner review" role="status">The review snapshot loaded, but its match to the published model could not be verified. Triage is paused.</div>';
    return '<div class="ar-banner" role="status"><span class="ar-live-dot"></span> Reviewed model and market snapshot match the published data. Economic flags and evidence gaps remain open until investigated.</div>';
  }
  function header() {
    const s = snapshot.summary || {}, m = root.UI.metric;
    const pending = (queue?.items || []).filter(p => p.kind === 'assumption' && p.status === 'pending');
    const quotes = snapshot.provenance?.quotes || {};
    const quoteWarning = quotes.status && quotes.status !== 'ready' ? '<div class="ar-banner review">Market refresh is ' + esc(quotes.status) + '. Retained quotes keep their original dates. ' + esc((quotes.failedTickers || []).join(', ')) + '</div>' : '';
    return '<div class="ar-controls"><p class="page-description">Follow the numbers from power to earnings and value per share.</p><div class="actions"><button class="button" data-ar-reload>Refresh review</button><a class="button" href="/approvals">Approvals' + (pending.length ? ' · ' + pending.length : '') + '</a></div></div>' + statusBanner() + quoteWarning
      + '<div class="metric-strip ar-metrics">' + m('Companies reviewed', String(snapshot.companies.length), 'Research and asset models, clearly separated')
      + m('Numerical errors', String(s.errors ?? snapshot.findings.filter(f => f.severity === 'error').length), 'Contradictions requiring attention', s.errors ? 'negative' : '')
      + m('Economic questions', String(s.reviews ?? snapshot.findings.filter(f => f.severity === 'review').length), 'Assumptions to explain or challenge')
      + m('Evidence gaps', String(s.gaps ?? snapshot.findings.filter(f => f.severity === 'gap').length), 'Incomplete evidence is never a pass') + '</div>'
      + '<div class="ar-clocks"><span>Numerical review <b>' + esc(time(snapshot.checkedAt)) + '</b></span><span>External evidence review <b>' + esc(time(queue?.assumptionResearch?.checkedAt)) + '</b></span><span>Market snapshot checked <b>' + esc(time(snapshot.provenance?.quotes?.checkedAt)) + '</b></span></div><p class="ar-basis-note">Sensitivity values use the reviewed market snapshot shown above. Live quotes on other pages may be newer.</p>';
  }
  function matrix() {
    return '<details class="panel ar-matrix"><summary><strong>Universe coverage</strong><span>Choose a cell to inspect its findings</span></summary><div class="table-scroll"><table class="plain-table"><thead><tr><th>Company / model</th>' + Object.values(FAMILIES).map(x => '<th>' + esc(x) + '</th>').join('') + '</tr></thead><tbody>'
      + snapshot.companies.map(c => '<tr><td><a href="/company/' + esc(c.ticker) + '">' + esc(c.ticker) + '</a><div class="company-sub">' + esc(c.modelBasis || c.model) + '</div></td>' + Object.keys(FAMILIES).map(k => {
        const t = c.tests?.[k] || { status: 'insufficient', summary: 'Not assessed' };
        return '<td><button class="ar-status ' + esc(t.status) + '" data-ar-cell="' + esc(c.ticker + '|' + k) + '" title="' + esc(t.summary) + '">' + esc(LABELS[t.status] || t.status) + '</button><div class="ar-cell-note">' + esc(t.summary) + '</div></td>';
      }).join('') + '</tr>').join('') + '</tbody></table></div><p class="chart-note">Reconciled means the available quantities agree. It does not establish that the forecast will occur. Landlords, GPU operators and holding companies use different economic checks.</p></details>';
  }
  function toolbar() {
    const select = (id, label, options, selected) => '<label><span>' + esc(label) + '</span><select class="select-control" id="' + id + '" data-ar-filter="' + id.slice(3) + '"><option value="">All</option>' + options.map(([v, l]) => '<option value="' + esc(v) + '"' + (v === selected ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select></label>';
    return '<div class="ar-toolbar" id="ar-findings"><div><h2>Decisions worth a closer look</h2><p>Errors first, then measured valuation sensitivity. Impacts are separate scenarios and must not be added together.</p></div><div class="ar-filters">'
      + select('ar-ticker', 'Company', snapshot.companies.map(c => [c.ticker, c.ticker]), filter.ticker)
      + select('ar-family', 'Test', Object.entries(FAMILIES), filter.family)
      + select('ar-severity', 'Finding', [['actionable', 'Errors and questions'], ['error', 'Numerical errors'], ['review', 'Economic questions'], ['gap', 'Evidence gaps']], filter.severity)
      + '<label class="ar-kept"><input type="checkbox" data-ar-kept' + (filter.showKept ? ' checked' : '') + '> Include kept assumptions</label></div></div>';
  }
  function evidenceHTML(evidence) {
    return (evidence || []).map(e => { const url = safeURL(e.url); return '<li>' + (url ? '<a href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(e.label || e.title || e.sourceName || url) + ' ↗</a>' : esc(e.label || e.title || 'Model assumption')) + (e.date ? ' · ' + esc(e.date) : '') + '</li>'; }).join('');
  }
  function findingCard(f) {
    const d = decision(f), r = research(f), impact = f.impact;
    const reviewedCompany = snapshot.companies.find(c => c.ticker === f.ticker), market = reviewedCompany?.metrics;
    const priceNote = market && Number.isFinite(market.price) ? '<p class="muted ar-quote-note">Reviewed reference: ' + money(market.price) + ' · ' + esc(market.priceAsOf || market.priceDate || market.priceBasis || 'provider date unavailable') + '. Research issuance assumptions are shown separately from this market reference.</p>' : ''; 
    const ready = (queue?.items || []).find(p => p.kind === 'assumption' && p.status === 'pending' && (p.findingId === f.id || p.findingIds?.includes(f.id)));
    const canTriage = triageReady() && (dry() || token());
    return '<details class="panel ar-finding ' + esc(f.severity) + '" id="finding-' + esc(f.id) + '"><summary><div><div class="ar-finding-meta"><span class="ar-status ' + esc(f.severity) + '">' + esc(f.severity === 'error' ? 'Numerical error' : f.severity === 'gap' ? 'Evidence gap' : 'Economic question') + '</span><b>' + esc(f.ticker) + '</b><span>' + esc(FAMILIES[f.family]) + '</span>' + (d ? '<span>' + (d.status === 'kept' ? 'Kept until ' + esc(d.reviewAfter) : 'Research requested') + '</span>' : '') + '</div><h3>' + esc(f.title) + '</h3></div><div class="ar-impact">' + (impact && Number.isFinite(impact.pct) ? '<strong>' + (impact.pct > 0 ? '+' : '') + n(impact.pct) + '%</strong><span>scenario value effect</span>' : '<span>Impact not quantified</span>') + '</div></summary><div class="ar-finding-body">'
      + '<p class="ar-explanation">' + esc(f.explanation) + '</p><div class="ar-detail-grid"><div><h4>Calculation and comparison</h4><p class="ar-calculation">' + esc(typeof f.calculation === 'object' ? JSON.stringify(f.calculation, null, 2) : f.calculation || 'Further evidence is needed to calculate this independently.') + '</p><h4>Evidence and basis</h4><ul class="ar-evidence">' + evidenceHTML(f.evidence) + '</ul></div><div><h4>What it could change</h4>'
      + (impact ? '<div class="ar-value-bridge"><span>Current model<strong>' + money(impact.base) + '</strong></span><span>Scenario<strong>' + money(impact.alternative) + '</strong></span></div><p>' + esc(impact.label) + '</p><p class="muted">' + esc(impact.basis || 'Sensitivity only; not a proposed target or verified replacement assumption.') + '</p>' : '<p>The available evidence does not support a reliable per-share estimate. This gap remains visible.</p>')
      + priceNote + '<h4>Next step</h4><p>' + esc(f.nextAction) + '</p></div></div>'
      + (r ? '<div class="ar-research"><h4>Analyst review · ' + esc(time(r.reviewedAt)) + '</h4><p>' + esc(r.conclusion) + '</p><ul class="ar-evidence">' + evidenceHTML(r.sources) + '</ul></div>' : '')
      + (d ? '<p class="ar-decision-note"><b>' + (d.status === 'kept' ? 'Current assumption retained' : 'Research requested') + ':</b> ' + esc(d.reason) + '</p>' : '')
      + '<div class="ar-actions">' + (ready ? '<a class="button primary" href="/approvals#prop-' + esc(ready.id) + '">Review proposed change</a>' : '')
      + '<button class="button' + (!ready ? ' primary' : '') + '" data-ar-triage="research" data-ar-id="' + esc(f.id) + '"' + (canTriage ? '' : ' disabled') + '>Request research</button>'
      + (f.severity !== 'error' && f.severity !== 'gap' ? '<button class="button" data-ar-triage="kept" data-ar-id="' + esc(f.id) + '"' + (canTriage ? '' : ' disabled') + '>Keep assumption with reason</button>' : '')
      + '<span class="muted">' + (!token() && !dry() ? '<a href="/approvals">Enable decisions on this device</a>' : 'Model changes require a separate approval.') + '</span></div></div></details>';
  }
  function findings() {
    const rank = { error: 0, review: 1, gap: 2 };
    const rows = snapshot.findings.filter(f => (!filter.ticker || f.ticker === filter.ticker || f.ticker === 'ALL') && (!filter.family || f.family === filter.family) && (!filter.severity || (filter.severity === 'actionable' ? f.severity !== 'gap' : f.severity === filter.severity)) && (filter.showKept || decision(f)?.status !== 'kept'))
      .sort((a, b) => rank[a.severity] - rank[b.severity] || Math.abs(b.impact?.pct || 0) - Math.abs(a.impact?.pct || 0) || a.ticker.localeCompare(b.ticker));
    return '<div class="ar-findings-count">' + rows.length + ' findings shown · ' + snapshot.findings.length + ' in the full review</div>' + (rows.length ? rows.map(findingCard).join('') : '<div class="panel empty"><strong>No open findings match this view.</strong>Check universe coverage for incomplete tests.</div>');
  }
  function openTriage(id, status) {
    const f = snapshot.findings.find(x => x.id === id), drawer = document.getElementById('drawer');
    if (!f || !drawer) return;
    const reviewAfter = new Date(Date.now() + (status === 'kept' ? 30 : 7) * 86400000).toISOString().slice(0, 10);
    drawer.innerHTML = '<div class="drawer-head"><h2 id="drawer-title">' + (status === 'kept' ? 'Keep current assumption' : 'Request research') + '</h2><button class="icon-button" data-ar-close aria-label="Close review">×</button></div><form id="ar-triage-form" class="drawer-body" data-finding="' + esc(id) + '" data-status="' + status + '"><p class="drawer-intro">' + esc(f.ticker + ' · ' + f.title) + '</p><label class="ar-field">' + (status === 'kept' ? 'Why is the current assumption justified?' : 'What should the analyst investigate?') + '<textarea id="ar-reason" required rows="5" maxlength="2000">' + (status === 'research' ? esc(f.nextAction || '') : '') + '</textarea></label><label class="ar-field">Review again on<input id="ar-review-date" type="date" required value="' + reviewAfter + '"></label><p class="muted">This records your decision in the shared review queue. It does not change model inputs. New evidence or changed assumptions reopen the finding.</p><button class="button primary" type="submit">' + (dry() ? 'Preview decision' : 'Save review decision') + '</button><p id="ar-save-status" role="status" aria-live="polite"></p></form>';
    if (!drawer.open) drawer.showModal();
  }
  async function saveTriage(form) {
    if (busy) return;
    const msg = document.getElementById('ar-save-status'), button = form.querySelector('button[type="submit"]');
    const id = form.dataset.finding, f = snapshot.findings.find(x => x.id === id);
    const record = { fingerprint: f.fingerprint, status: form.dataset.status, reason: document.getElementById('ar-reason').value.trim(), reviewAfter: document.getElementById('ar-review-date').value, updatedAt: new Date().toISOString() };
    busy = true; button.disabled = true;
    try {
      if (!root.ApprovalsCore?.buildReviewCommit) throw new Error('The review decision helper could not load.');
      if (dry()) { root.ApprovalsCore.buildReviewCommit(queue || { items: [] }, id, record); msg.textContent = 'Preview validated. No decision was saved and no model data changed.'; return; }
      if (!token() || !triageReady()) throw new Error('Refresh the model review and enable decisions before saving.');
      const headers = { Authorization: 'Bearer ' + token(), Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
      for (let attempt = 0; attempt < 3; attempt++) {
        const [sr, pr, dr, qr] = await Promise.all(['assumption-review.json', 'proposals.json', 'data.json', 'market-prices.json'].map(file => fetch(API + file + '?ref=main', { headers, cache: 'no-store' })));
        if (!dr.ok || !qr.ok) throw new Error('Could not verify the current model and market snapshot.');
        if (!sr.ok || !pr.ok) throw new Error('Could not read the current review queue (HTTP ' + (!sr.ok ? sr.status : pr.status) + ').');
        const fresh = JSON.parse(root.ApprovalsCore.b64dec((await sr.json()).content)), p = await pr.json();
        if (fresh.status !== 'ready' || !freshEnough(fresh) || fresh.findings?.find(x => x.id === id)?.fingerprint !== f.fingerprint) throw new Error('This finding changed. Refresh and review the latest evidence.');
        const latestData = JSON.parse(root.ApprovalsCore.b64dec((await dr.json()).content));
        const latestQuotes = JSON.parse(root.ApprovalsCore.b64dec((await qr.json()).content));
        if (fresh.sourceHash !== await digest(latestData) || fresh.quoteHash !== await digest(latestQuotes)) throw new Error('The model or market snapshot changed after this review. Wait for the next review.');
        const current = JSON.parse(root.ApprovalsCore.b64dec(p.content));
        if (stable(current.assumptionReviews?.[id] || null) !== stable(queue?.assumptionReviews?.[id] || null)) throw new Error('A newer decision was recorded. Refresh before deciding again.');
        const commit = root.ApprovalsCore.buildReviewCommit(current, id, record);
        const wr = await fetch(API + 'proposals.json', { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: commit.message, content: commit.content, sha: p.sha, branch: 'main' }) });
        if ([409, 422].includes(wr.status)) continue;
        if (!wr.ok) throw new Error('Saving the review failed (HTTP ' + wr.status + ').');
        queue = commit.mutated; msg.textContent = 'Review saved. Model inputs are unchanged.'; refresh(); return;
      }
      throw new Error('The queue changed repeatedly. Please refresh and try again.');
    } catch (e) { msg.textContent = e.message || 'Could not save the review.'; }
    finally { busy = false; button.disabled = false; }
  }
  function render() {
    if (state === 'idle' || (state === 'ready' && Date.now() - loadedAt > 5 * 60000 && !document.getElementById('drawer')?.open)) load(true);
    if (state === 'loading') return '<section class="panel empty"><strong>Loading the latest economic review…</strong></section>';
    if (state === 'error') return '<section class="panel empty"><strong>Assumption review unavailable</strong><p>' + esc(error) + '</p><p>No successful review is implied.</p><button class="button" data-ar-reload>Retry</button></section>';
    if (!snapshot) return '';
    return header() + (dry() ? '<div class="ar-banner review">Decision preview: no writes are made from this page.</div>' : '') + (!queue ? '<div class="ar-banner review">The decision queue could not load. Findings remain visible; decisions and external-review status are unavailable.</div>' : '')
      + matrix() + toolbar() + findings() + '<details class="panel ar-method"><summary>How this review works</summary><p>Numerical checks run after model changes and quote jobs, and nightly. Research reviews investigate source evidence separately. Existing valuation engines calculate sensitivities; an independent economic check requires independent evidence.</p><p>Keeping an assumption expires on the review date and reopens when its inputs change. Model changes enter Approvals with exact values, supporting evidence and per-share effects. No finding adjusts a forecast automatically.</p><p>Rule version: ' + esc(snapshot.ruleVersion) + ' · <a href="/assumption-review.json">Review data</a> · <a href="/checks">Technical checks</a> · <a href="https://github.com/rictsb/cloudtracker/actions/workflows/assumption-review.yml" target="_blank" rel="noopener">Background job</a></p></details>';
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('click', e => {
      if (e.target.closest('[data-ar-reload]')) { load(true); refresh(); }
      const cell = e.target.closest('[data-ar-cell]');
      if (cell) { [filter.ticker, filter.family] = cell.dataset.arCell.split('|'); filter.severity = ''; refresh(); document.getElementById('ar-findings')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
      const triage = e.target.closest('[data-ar-triage]');
      if (triage && !triage.disabled) openTriage(triage.dataset.arId, triage.dataset.arTriage);
      if (e.target.closest('[data-ar-close]')) document.getElementById('drawer')?.close();
    });
    document.addEventListener('change', e => { if (e.target.dataset?.arFilter) { filter[e.target.dataset.arFilter] = e.target.value; refresh(); } if (e.target.matches?.('[data-ar-kept]')) { filter.showKept = e.target.checked; refresh(); } });
    document.addEventListener('submit', e => { if (e.target.id === 'ar-triage-form') { e.preventDefault(); saveTriage(e.target); } });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && root.location?.pathname === '/research/assumptions' && Date.now() - loadedAt > 5 * 60000) load(true); });
  }
  if (typeof root.setInterval === 'function') root.setInterval(() => { if (root.location?.pathname === '/research/assumptions' && document.visibilityState === 'visible' && !document.getElementById('drawer')?.open && Date.now() - loadedAt > 5 * 60000) load(true); }, 60000);
  root.AssumptionView = { render, reload: () => load(true), stable, digest };
})(typeof window !== 'undefined' ? window : globalThis);
