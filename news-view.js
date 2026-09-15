/* CSS moved to styles.css (Wave 2 consolidation) */

/* News — the curated video digest (spec §6, §6g). Display-only: reads news.json (published daily
   by the DGX Spark), never writes it, and no field here feeds the valuation engine. */
(function (root) {
  'use strict';

  const esc = (root.UI && root.UI.esc) || (x => String(x == null ? '' : x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const list = v => Array.isArray(v) ? v : [];

  /* Word-label maps, verbatim from production app.js:337-339 */
  const SAID_BY = { executive: 'company statement', host: "the host's own view", guest: 'a guest', thirdparty: 'a third party' };
  const SIG_TAG = { scoop: 'own research', call: 'prediction', big: 'flagged as big', notable: 'flagged' };
  const KIND_WORD = { news: 'news round-up', interview: 'interview', earnings: 'earnings breakdown', members: 'members-only segment', other: 'video' };

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtD(iso) { if (!iso) return ''; const d = new Date(iso + 'T00:00:00'); return isNaN(d) ? iso : `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`; }
  function tsLabel(t) { if (t == null) return ''; const m = Math.floor(t / 60), s = t % 60; return `${m}:${String(s).padStart(2, '0')}`; }
  function safeHref(u) { try { const x = new URL(String(u || '')); return x.protocol === 'http:' || x.protocol === 'https:' ? x.href : ''; } catch (e) { return ''; } }

  let NEWS = null, state = 'idle', wired = false;

  function load() {
    if (state !== 'idle') return;
    state = 'loading';
    let request;
    try { request = fetch('news.json', { cache: 'no-store' }); } catch (e) { state = 'failed'; return; }
    request.then(r => { if (!r.ok) throw new Error('news.json ' + r.status); return r.json(); })
      .then(j => { NEWS = j; state = 'ready'; }, () => { state = 'failed'; })
      .then(() => { if (root.CVApp && root.CVApp.refresh) root.CVApp.refresh(); });
  }

  function setQ(changes) {
    const q = new URLSearchParams(location.search);
    Object.entries(changes).forEach(([k, v]) => { (v == null || v === '') ? q.delete(k) : q.set(k, String(v)); });
    const s = q.toString();
    history.replaceState({}, '', location.pathname + (s ? '?' + s : ''));
    if (root.CVApp && root.CVApp.refresh) root.CVApp.refresh();
  }

  function wire() {
    if (wired || typeof document === 'undefined') return;
    wired = true;
    document.addEventListener('change', e => {
      if (e.target && e.target.matches && e.target.matches('select[data-news-tk]')) setQ({ company: e.target.value || null, limit: null });
    });
    document.addEventListener('click', e => {
      const b = e.target.closest && e.target.closest('button[data-news-signal]');
      if (b) setQ({ signal: b.dataset.newsSignal || null, limit: null });
    });
  }

  function coveredSet() {
    try {
      const m = root.CloudModel && root.CloudModel.current;
      return new Set(list(m && m.companies).map(c => c.ticker).filter(Boolean));
    } catch (e) { return new Set(); }
  }

  function srcName(id) { return (list(NEWS && NEWS.sources).find(s => s.id === id) || {}).name || id || ''; }

  function renderItem(i, covered) {
    const url = safeHref(i.url);
    const main = list(i.main).length ? list(i.main) : list(i.tickers).slice(0, 4);
    const also = list(i.tickers).filter(t => !main.includes(t));
    const meta = `<div class="feed-meta"><span>${esc(fmtD(i.d))} · ${esc(srcName(i.src))} · ${esc(KIND_WORD[i.kind] || 'video')}${i.minutes ? `, ${esc(i.minutes)} min` : ''}</span></div>`;
    const title = url
      ? `<a class="news-title" href="${esc(url)}" target="_blank" rel="noopener" title="${esc(i.title)}">${esc(i.headline || i.title)}</a>`
      : `<span class="news-title" title="${esc(i.title)}">${esc(i.headline || i.title)}</span>`;
    const mainHtml = main.map(t => covered.has(t) ? `<a href="/company/${encodeURIComponent(t)}">${esc(t)}</a>` : esc(t)).join(', ');
    const about = `<div class="news-about">About <b>${mainHtml || '—'}</b>${also.length ? ` · also mentions ${also.map(esc).join(', ')}` : ''}${list(i.sponsored).length ? ` · sponsored segment: ${list(i.sponsored).map(esc).join(', ')} (ignored)` : ''}</div>`;
    const body = i.brief ? `<p>${esc(i.brief)}</p>` : i.summary ? `<p>${esc(String(i.summary).slice(0, 300))}…</p>` : '<p class="muted">Summary pending.</p>';
    let signals = '';
    if (list(i.signal).length) {
      signals = `<div class="news-h">What matters</div><ul>${list(i.signal).map(s => {
        const watch = (s.t != null && url) ? ` · <a href="${esc(url)}&t=${esc(s.t)}s" target="_blank" rel="noopener">watch at ${esc(tsLabel(s.t))}</a>` : '';
        return `<li><b>${esc(s.tk)}</b> — ${esc(s.claim)} <span class="news-src">${esc(SAID_BY[s.by] || s.by)}${s.tag ? `, ${esc(SIG_TAG[s.tag] || s.tag)}` : ''}${watch}</span></li>`;
      }).join('')}</ul>`;
    }
    let full = '';
    if (list(i.facts).length || i.view || list(i.verify).length) {
      full = `<details class="news-full"><summary><span class="nf-show">Show the full summary</span><span class="nf-hide">Hide the full summary</span></summary>` +
        (list(i.facts).length ? `<div class="news-h">Key facts by company</div><ul>${list(i.facts).map(f => `<li>${esc(f)}</li>`).join('')}</ul>` : '') +
        (i.view ? `<div class="news-h">The host&#39;s view</div><p>${esc(i.view)}</p>` : '') +
        (list(i.verify).length ? `<div class="news-h">Worth checking against filings</div><ul>${list(i.verify).map(f => `<li>${esc(f)}</li>`).join('')}</ul>` : '') +
        `</details>`;
    }
    return `<article class="feed-item news-item">${meta}${title}${about}${body}${signals}${full}</article>`;
  }

  function render(p) {
    wire();
    const q = p instanceof URLSearchParams ? p : new URLSearchParams(p || '');
    if (state === 'idle') load();
    if (state === 'idle' || state === 'loading') return '<div class="loading">Loading the news digest…</div>';
    if (state === 'failed' || !NEWS) return '<div class="empty"><p>no news yet — the Spark publishes news.json each morning</p></div>';

    const all = list(NEWS.items);
    const company = q.get('company') || '';
    const signalOnly = q.get('signal') === '1';
    const limit = Math.min(1000, Math.max(30, Number.parseInt(q.get('limit'), 10) || 30));
    const age = Math.round((Date.now() - new Date(NEWS.asOf)) / 86400000);
    const tks = [...new Set(all.flatMap(i => list(i.tickers)))].sort();
    const covered = coveredSet();

    let items = all.slice().sort((a, b) => String(b.d || '').localeCompare(String(a.d || '')));
    if (company) items = items.filter(i => list(i.tickers).includes(company));
    if (signalOnly) items = items.filter(i => list(i.signal).length);
    const shown = items.slice(0, limit);

    const srcLinks = list(NEWS.sources).map(s => {
      const u = safeHref(s.url);
      return u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(s.name)}</a>` : esc(s.name || '');
    }).join(', ');
    const status = `<div class="date-rule news-status"><span>Updated ${esc(fmtD(NEWS.asOf))}${age > 2 ? ' <span class="source-pill rumored">stale</span>' : ''} · ${all.length} videos in the last ${esc(NEWS.windowDays)} days${srcLinks ? ` · ${srcLinks}` : ''}</span></div>`;

    const options = `<option value="">every coverage name</option>` +
      tks.map(t => `<option value="${esc(t)}"${t === company ? ' selected' : ''}>${esc(t)}</option>`).join('') +
      (company && !tks.includes(company) ? `<option value="${esc(company)}" selected>${esc(company)}</option>` : '');
    const filterbar = `<div class="filterbar news-filter"><div class="news-filter-left"><label class="company-search-select"><span class="small muted">Show</span><select class="select-control" data-news-tk aria-label="Filter news by ticker">${options}</select></label><div class="segments" role="group" aria-label="Video filter"><button data-news-signal="" aria-pressed="${!signalOnly}">All videos</button><button data-news-signal="1" aria-pressed="${signalOnly}">Something notable</button></div></div><span class="small muted">${items.length} shown</span></div>`;

    let feed;
    if (!items.length) feed = '<div class="empty"><p>nothing matches</p></div>';
    else {
      const next = new URLSearchParams(q);
      next.set('limit', String(Math.min(1000, limit + 30)));
      const path = typeof location !== 'undefined' ? location.pathname : '/news';
      feed = shown.map(i => renderItem(i, covered)).join('') +
        `<div class="table-foot"><span>${shown.length} of ${items.length} videos</span>${items.length > shown.length ? `<a class="text-button" href="${esc(path + '?' + next.toString())}">Show more →</a>` : '<span>Daily digest from the Spark</span>'}</div>`;
    }

    const legend = `<p class="table-explainer">Each item is one video from a curated source. The summary is ours, written by the local model from the transcript; the video link is the source. Under <b>what matters</b>: <b>company statement</b> means the fact came from the company (its executives, a release, a call), whether quoted or relayed by the presenter; <b>the host&#39;s own view</b> is opinion; <b>own research</b> means the presenter dug it up themselves (filings, dockets, permits, site visits); <b>prediction</b> is a call with a date. Sponsored segments are ignored. Nothing here moves a valuation — changes go through <a href="/approvals">Approvals</a>.</p>`;

    return status + `<section class="panel" aria-label="News digest">${filterbar}${feed}</section>` + legend;
  }

  root.NewsView = { render };
})(typeof window !== 'undefined' ? window : globalThis);
