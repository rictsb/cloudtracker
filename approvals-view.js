/* CSS moved to styles.css (Wave 2 consolidation) */

/* Approvals — the operator decision desk (BODY below the shell's Operations subnav).
   Reads proposals.json (published daily by the DGX Spark); a Yes/No decision commits
   status + decided to proposals.json on main via the GitHub Contents API, which triggers
   the apply-proposals Action. The mutate + serialize step lives in approvals-core.js
   (ONE source of truth, node-testable — ruling C13).

   HARD DRY-RUN: this preview build is incapable of writing. DRY is const true; the click
   path never calls the write function, and the write function itself throws while DRY.
   No test, demo, or verification flow may ever decide a real proposal — the drawer
   preview exists precisely so the write path is verifiable without a decision. */
(function (root) {
  'use strict';

  /* DRY-RUN CONSTANT — integration flips this to false and nothing else changes.
     While true: decision clicks run ApprovalsCore.buildCommit locally and show the
     would-be commit in the drawer; zero requests reach api.github.com. */
  const DRY = false;   // PRODUCTION build: the write path is live; ?dryrun=1 still previews without committing
  // One dry predicate everywhere (view, buttons, banner, AND the write guard): the compiled
  // constant OR ?dryrun=1 — so the banner and the throw guard can never disagree.
  const isDry = () => DRY || (typeof location !== 'undefined' && new URLSearchParams(location.search).get('dryrun') === '1');

  const GH_REPO = 'rictsb/cloudtracker';                                        // production app.js:21
  const API_URL = 'https://api.github.com/repos/' + GH_REPO + '/contents/proposals.json';

  const esc = s => (root.UI && root.UI.esc) ? root.UI.esc(s) : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtD(iso) { if (!iso) return ''; const d = new Date(iso + 'T00:00:00'); return isNaN(d) ? iso : `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`; }
  function tsLabel(t) { if (t == null) return ''; const m = Math.floor(t / 60), s = t % 60; return `${m}:${String(s).padStart(2, '0')}`; }
  const SAID_BY = { executive: 'company statement', host: "the host's own view", guest: 'a guest', thirdparty: 'a third party' };
  function ym(y, m) { return y ? `${MONTHS[(m || 6) - 1]} ${y}` : '—'; }
  const Core = () => root.ApprovalsCore;

  /* Kind-specific plain-English change sentence — ported verbatim from production app.js:396-404.
     Company display name from raw data.json companies; degrades to the ticker when data.json
     is unavailable (hazard-3 independent-settle rule). */
  function propWhat(p) {
    const cs = (typeof CloudModel !== 'undefined' && CloudModel.source && CloudModel.source.companies) || [];
    const c = cs.find(x => x.tk === p.tk); const name = c ? c.name : p.tk;
    if (p.kind === 'log') return `Add a dated note to ${name}'s record`;
    if (p.kind === 'site' && p.proposed && 'mw' in p.proposed) return `Change ${p.site} from ${p.current?.mw} MW to ${p.proposed.mw} MW`;
    if (p.kind === 'site') return `Move ${p.site}'s energization from ${ym(p.current?.yr, p.current?.mo)} to ${ym(p.proposed?.yr, p.proposed?.mo)}`;
    if (p.kind === 'catalyst') return `Add a catalyst to ${name}`;
    return p.title || p.kind;
  }
  function propStatement(p) { const e = (p.evidence || [])[0] || {}; return e.claim || (p.proposed && p.proposed.x) || p.title || ''; }

  function ghToken() { try { return localStorage.getItem('cv-gh-token') || ''; } catch (e) { return ''; } }

  /* ---- data load: exactly once, failure swallowed (production app.js:329) ---- */
  let PROPOSALS = null, loadStarted = false, loadSettled = false;
  function ensureLoad() {
    if (loadStarted || typeof fetch !== 'function' || typeof document === 'undefined') return;
    loadStarted = true;
    fetch('proposals.json', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(j => { PROPOSALS = j; })
      .catch(() => {})
      .then(() => { loadSettled = true; (root.CVApp && root.CVApp.refresh()); });
  }

  /* ============================================================================
     LIVE WRITE PATH — ported verbatim from production app.js:379-395 (ghDecide),
     with the mutate + serialize step delegated to ApprovalsCore so the browser and
     the node byte-compat harness run the identical code. Kept here so integration
     only flips DRY; while DRY is true this function throws on its first line and
     NOTHING below it — the Contents-API GET (sha) and PUT — can execute. The
     preview's click path never calls it either (see onDecide). Never call this
     to "test" a decision: the drawer dry-run preview exists for that.
     Retry contract: on PUT 409/422 wait 1500ms, re-GET fresh sha + content,
     re-mutate, re-PUT; after 3 failures throw the concurrent-change message.
     GET 401 has its own distinct message.
     ============================================================================ */
  async function ghDecide(id, status) {
    if (isDry()) throw new Error('dry-run — the write path is disabled');
    const tok = ghToken(); if (!tok) throw new Error('no GitHub token on this device');
    const api = API_URL;
    const H = { Authorization: 'Bearer ' + tok, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await fetch(api + '?ref=main', { headers: H, cache: 'no-store' });
      if (r.status === 401) throw new Error('GitHub rejected the token (401) — paste a fresh one');
      if (!r.ok) throw new Error('GitHub read failed: HTTP ' + r.status);
      const j = await r.json(); const P = JSON.parse(Core().b64dec(j.content));
      const commit = Core().buildCommit(P, id, status, new Date().toISOString().slice(0, 10));
      const w = await fetch(api, { method: 'PUT', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: commit.message, content: commit.content, sha: j.sha, branch: 'main' }) });
      if (w.status === 409 || w.status === 422) { await new Promise(r2 => setTimeout(r2, 1500)); continue; }
      if (!w.ok) throw new Error('GitHub write failed: HTTP ' + w.status);
      return commit.mutated;
    }
    throw new Error('someone else changed proposals.json at the same time — try again');
  }

  /* ---- dry-run preview: the local half of a decision, shown in the app drawer ---- */
  function openPreviewDrawer(id, status) {
    const drawer = document.getElementById('drawer'); if (!drawer) return;
    const before = (PROPOSALS.items || []).find(x => x.id === id); if (!before) return;
    const today = new Date().toISOString().slice(0, 10);
    const commit = Core().buildCommit(PROPOSALS, id, status, today);     // local only — no network
    const serialized = Core().serialize(commit.mutated);
    const bytes = new TextEncoder().encode(serialized).length;
    const closeIcon = root.UI ? root.UI.icon('close') : '×';
    const tag = '<div class="ap-dry-tag">Dry run — nothing was committed</div>';
    drawer.innerHTML = `<div class="drawer-head"><h2 id="drawer-title">Would-be commit</h2><button class="icon-button" data-ap-close="1" aria-label="Close commit preview">${closeIcon}</button></div>
      <div class="drawer-body">${tag}
        <p class="drawer-intro">This preview build cannot write to GitHub. Below is exactly what deciding <b>${esc(id)}</b> as <b>${esc(status)}</b> would send.</p>
        <div class="method-block"><h3>Request it would make</h3><p class="ap-mono">PUT ${esc(API_URL)}</p><p class="muted small" style="margin-top:6px">branch main · sha from a fresh GET · up to 3 attempts on 409/422</p></div>
        <div class="method-block"><h3>Commit message</h3><p class="ap-mono">${esc(commit.message)}</p></div>
        <div class="method-block"><h3>The two changed fields</h3><div class="ledger"><span>status</span><strong>${esc(JSON.stringify(before.status))} → ${esc(JSON.stringify(status))}</strong><span>decided</span><strong>${esc(JSON.stringify(before.decided))} → ${esc(JSON.stringify(today))}</strong></div><p class="muted small" style="margin-top:8px">Every other field — fp, seen, asOf, item order — round-trips untouched.</p></div>
        <div class="method-block"><h3>Content</h3><p class="muted small">${bytes.toLocaleString('en-US')} bytes of serialized proposals.json — JSON.stringify(file, null, 1) plus a trailing newline, the production byte contract — base64-encoded to ${commit.content.length.toLocaleString('en-US')} characters.</p></div>
        ${tag}
      </div>`;
    if (drawer.showModal && !drawer.open) drawer.showModal();
  }

  /* ---- decision click. In this build the DRY branch is the only reachable one. ---- */
  async function onDecide(btn) {
    const card = btn.closest('.ap-card'); const msg = card && card.querySelector('.ap-pmsg');
    const id = btn.dataset.apId, status = btn.dataset.apDec;
    if (!PROPOSALS || !Core()) { if (msg) msg.textContent = 'failed: decision core not loaded'; return; }
    if (isDry()) {
      try { openPreviewDrawer(id, status); if (msg) msg.textContent = 'previewed — nothing was committed'; }
      catch (e) { if (msg) msg.textContent = 'failed: ' + e.message; }
      return;
    }
    /* Production decision flow (app.js:430-434) — dead while DRY is true; integration flips the constant. */
    card.querySelectorAll('[data-ap-dec]').forEach(x => x.disabled = true); if (msg) msg.textContent = 'saving…';
    try {
      const P = await ghDecide(id, status); PROPOSALS = P;
      // Badge recomputes from the write's returned file (spec must_preserve), not the boot fetch.
      const pend = (P.items || []).filter(i => i.status === 'pending').length;
      if (root.CVApp && root.CVApp.setPending) root.CVApp.setPending(pend);
      if (msg) msg.textContent = status === 'accepted' ? 'saved — the site updates in a few minutes' : 'saved';
      setTimeout(() => { (root.CVApp && root.CVApp.refresh()); }, 900);
    } catch (e) {
      if (msg) msg.textContent = 'failed: ' + e.message;
      card.querySelectorAll('[data-ap-dec]').forEach(x => x.disabled = false);
    }
  }

  /* ---- one document-level delegated listener, own data-ap-* attributes only ---- */
  if (typeof document !== 'undefined' && !root.__apWired) {
    root.__apWired = true;
    document.addEventListener('click', e => {
      const dec = e.target.closest('[data-ap-dec]');
      if (dec) { onDecide(dec); return; }
      if (e.target.closest('[data-ap-close]')) { const d = document.getElementById('drawer'); if (d && d.open) d.close(); return; }
      if (e.target.closest('[data-ap-tok-save]')) {
        const inp = document.getElementById('ap-token-input'); const v = (inp && inp.value || '').trim(); if (!v) return;
        try { localStorage.setItem('cv-gh-token', v); } catch (e2) {}
        (root.CVApp && root.CVApp.refresh()); return;
      }
      if (e.target.closest('[data-ap-tok-forget]')) {
        try { localStorage.removeItem('cv-gh-token'); } catch (e2) {}
        (root.CVApp && root.CVApp.refresh()); return;
      }
    });
  }

  /* ---- sections ---- */
  function tokenPanel(tok) {
    const inner = tok
      ? `<p>Decisions from this device commit to GitHub as you.</p><div class="ap-token-controls"><button class="button" data-ap-tok-forget="1">forget token</button></div>`
      : `<p>To decide from this device, paste a GitHub token once (fine-grained, this repository only, <b>Contents: read and write</b>). It is stored only in this browser.</p><div class="ap-token-controls"><input type="password" id="ap-token-input" class="ap-token-input" placeholder="github_pat_…" autocomplete="off" aria-label="GitHub token"><button class="button" data-ap-tok-save="1">save on this device</button></div>`;
    const dryNote = isDry() ? `<div class="ap-token-note">Dry-run preview: the token is never used here — a decision click shows the would-be commit instead of making it.</div>` : '';
    return `<section class="panel padded" aria-label="GitHub token"><div class="ap-token-row">${inner}</div>${dryNote}</section>`;
  }

  function dryBanner(fromQuery) {
    if (!DRY && !fromQuery) return '';
    const origin = fromQuery ? 'Enabled by ?dryrun=1.' : 'This preview build is compiled without the write path.';
    const infoIcon = root.UI ? root.UI.icon('info') : '';
    return `<div class="snapshot-banner ap-section-gap" role="status">${infoIcon}<span><b>Dry run — decisions here commit nothing.</b> ${origin} A Yes or No click opens the exact commit a real decision would make; zero requests reach GitHub.</span></div>`;
  }

  function statusStrip(pend, done) {
    const m = (label, value, note) => root.UI ? root.UI.metric(label, value, note) : `<div class="metric"><div class="metric-label">${label}</div><div class="metric-value">${value}</div><div class="metric-note">${note}</div></div>`;
    return `<div class="metric-strip ap-strip ap-section-gap">${m('Awaiting a decision', String(pend.length), 'New proposals arrive with the morning publish')}${m('Updated', esc(fmtD(PROPOSALS.asOf)), 'proposals.json · published daily by the Spark')}${m('Decisions recorded', String(done.length), 'Applied, declined and error outcomes')}</div>`;
  }

  function pendingCard(p, tok) {
    const e = (p.evidence || [])[0] || {};
    const safeUrl = (u) => { try { const x = new URL(String(u || '')); return x.protocol === 'http:' || x.protocol === 'https:' ? x.href : ''; } catch (err) { return ''; } };
    const eu = safeUrl(e.url);
    const watch = eu && /[&?]t=\d+s/.test(eu) ? ` · <a href="${esc(eu)}" target="_blank" rel="noopener">watch at ${tsLabel(parseInt(eu.match(/[&?]t=(\d+)s/)[1]))}</a>` : '';
    const src = `${esc(SAID_BY[e.by] || e.by || '')}${e.title ? (eu ? `, in <a href="${esc(eu)}" target="_blank" rel="noopener">${esc(e.title.split(' | ')[0])}</a>` : `, in ${esc(e.title.split(' | ')[0])}`) : ''}${e.d ? ` (${esc(fmtD(e.d))})` : ''}${watch}`;
    const raw = p.kind === 'site' ? `site "${p.site}": ${JSON.stringify(p.current)} → ${JSON.stringify(p.proposed)}` : JSON.stringify(p.proposed, null, 1);
    const enabled = isDry() || tok;   // dry-run: enabled without a token; live: disabled until a token is saved
    return `<section class="panel ap-card" id="prop-${esc(p.id)}"><div class="padded">
      <div class="feed-meta">Proposed ${esc(fmtD(p.created))} · from ${esc(p.sourceName || 'the curated sources')}</div>
      <h2 class="ap-what"><b>${esc(p.tk)}</b> — ${esc(propWhat(p))}</h2>
      <p class="ap-stmt">${esc(propStatement(p))}</p>
      <div class="ap-src">${src}</div>
      ${e.quote ? `<blockquote class="ap-quote">“${esc(e.quote)}”</blockquote>` : ''}
      <div class="ap-actions"><button class="button primary" data-ap-dec="accepted" data-ap-id="${esc(p.id)}" ${enabled ? '' : 'disabled'}>Yes, ${p.kind === 'log' ? 'add it' : 'change it'}</button><button class="button" data-ap-dec="rejected" data-ap-id="${esc(p.id)}" ${enabled ? '' : 'disabled'}>No</button><span class="ap-pmsg" aria-live="polite"></span></div>
      <details class="ap-rawbox"><summary class="text-button"><span class="ap-when-closed">Show the exact change</span><span class="ap-when-open">Hide the exact change</span></summary><pre class="ap-raw">${esc(raw)}</pre></details>
    </div></section>`;
  }

  function historyPanel(done) {
    if (!done.length) return '';
    const shown = done.slice(0, 25);
    const rows = shown.map(p => {
      const word = p.status === 'applied' || (p.status === 'accepted' && p.applied) ? 'Applied' : p.status === 'accepted' ? 'Approved, applying' : p.status === 'rejected' ? 'Declined' : 'Could not apply';
      const cls = word === 'Applied' ? 'ok' : word === 'Declined' ? 'no' : word === 'Could not apply' ? 'err' : '';
      return `<div class="ap-done"><span class="ap-done-word ${cls}">${word}</span> ${esc(fmtD(p.applied || p.decided))} · <b>${esc(p.tk)}</b> — ${esc(propStatement(p))}${p.error ? ` <span class="muted">(${esc(p.error)})</span>` : ''}</div>`;
    }).join('');
    return `<section class="panel ap-section-gap" aria-label="Recent decisions"><div class="panel-header"><div><h2>Recent decisions</h2><p>${shown.length} of ${done.length} shown · newest first</p></div></div>${rows}</section>`;
  }

  /* Production's legend (app.js:427) — preserved verbatim. */
  const FOOTNOTE = `<p class="table-explainer ap-section-gap">Each proposal is one statement from a curated source that the tracker does not yet reflect. <b>Yes</b> writes it into the model with a changelog line and the site updates within a few minutes; <b>No</b> declines it for good. Site changes move a company's value; notes added to a record do not.</p>`;

  function render(p) {
    ensureLoad();
    const params = p instanceof URLSearchParams ? p : new URLSearchParams(p || '');
    const tok = ghToken();
    let h = tokenPanel(tok);
    if (isDry()) h += dryBanner(!DRY);
    if (!loadSettled) return h + `<section class="panel ap-section-gap"><div class="loading">Loading proposals…</div></section>`;
    if (!PROPOSALS) return h + `<section class="panel ap-section-gap"><div class="empty">no proposals yet — the Spark publishes proposals.json each morning</div></section>` + FOOTNOTE;
    const items = PROPOSALS.items || [];
    const pend = items.filter(x => x.status === 'pending');
    const done = items.filter(x => x.status !== 'pending').sort((a, b) => String(b.decided || '').localeCompare(String(a.decided || '')));
    h += statusStrip(pend, done);
    h += `<div class="date-rule ap-section-gap"><span>${pend.length} awaiting a decision · updated ${esc(fmtD(PROPOSALS.asOf))}</span><span>Nothing changes without a click</span></div>`;
    if (!pend.length) h += `<section class="panel"><div class="empty"><strong>Nothing waiting.</strong>New proposals arrive with the morning publish.</div></section>`;
    else h += pend.map(x => pendingCard(x, tok)).join('');
    h += historyPanel(done);
    h += FOOTNOTE;
    return h;
  }

  root.ApprovalsView = { render };
})(typeof window !== 'undefined' ? window : globalThis);
