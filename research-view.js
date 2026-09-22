/* CSS moved to styles.css (Wave 2 consolidation) */
/* CSS moved to styles.css (Wave 3 consolidation) */
/* Read-only presentation of the original tracker research records. */
(function (root) {
  'use strict';

  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const list = value => Array.isArray(value) ? value : [];
  const title = value => String(value || 'Note').replace(/(^|[\s-])\S/g, letter => letter.toUpperCase());
  const date = value => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return value || 'Date not supplied';
    const parsed = new Date(value + 'T12:00:00Z');
    return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  };
  const money = value => typeof value !== 'number' || !Number.isFinite(value) ? 'Not supplied' : value >= 1000 ? '$' + (value / 1000).toLocaleString('en-US', { maximumFractionDigits: 2 }) + 'bn' : '$' + value.toLocaleString('en-US', { maximumFractionDigits: 1 }) + 'm';
  const excerpt = (value, length) => {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (text.length <= length) return text;
    const prefix = text.slice(0, length);
    const stop = prefix.lastIndexOf(' ');
    return prefix.slice(0, stop > length / 2 ? stop : length) + '…';
  };
  const stamp = value => value ? '<time datetime="' + esc(value) + '">' + esc(date(value)) + '</time>' : '<span>Date not supplied</span>';

  /* Raises event study (plan ruling C5; production app.js:189-260) — day-0 reaction and
     +5/+15/+30 trading-day forward returns derived at render time from the portfolio
     ledger (portfolio-history.json), never stored. */
  const RZ_WINDOWS = [5, 15, 30];
  const nextDay = iso => { const t = new Date(iso + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + 1); return t.toISOString().slice(0, 10); };
  const median = values => { const usable = values.filter(v => typeof v === 'number' && Number.isFinite(v)); if (!usable.length) return null; const sorted = usable.slice().sort((a, b) => a - b), mid = sorted.length >> 1; return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; };
  const signedPct = value => value == null || !Number.isFinite(value) ? '—' : (value >= 0 ? '+' : '') + (value * 100).toFixed(1) + '%';
  const tone = value => value == null || !Number.isFinite(value) ? '—' : '<span class="' + (value >= 0 ? 'positive' : 'negative') + '">' + signedPct(value) + '</span>';
  const deriveRaise = (tk, event, days, livePrice) => {
    if (!Array.isArray(days) || !days.length) return { status: 'nohistory' };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(event.d || ''))) return { status: 'nohistory' }; // undated event: a fact without returns
    const announced = event.ah ? nextDay(event.d) : event.d;                // after the close -> the next session
    const last = days.length - 1;
    if (announced > String(days[last].d || '')) return { status: 'pending' }; // announced after the last mark — day 0 not printed yet
    let start = -1;
    for (let i = 0; i < days.length; i++) { if (String(days[i].d || '') >= announced && days[i].px && days[i].px[tk] > 0) { start = i; break; } }
    if (start <= 0 || !(days[start - 1].px && days[start - 1].px[tk] > 0)) return { status: 'nohistory' }; // pre-ledger or pre-listing
    const baseline = days[start - 1].px[tk], close0 = days[start].px[tk], wins = {};
    const bench = i => days[i].bench > 0 ? days[i].bench : null;
    RZ_WINDOWS.forEach(N => {
      const j = start + N;
      if (j <= last && days[j].px && days[j].px[tk] > 0) {
        const r = days[j].px[tk] / close0 - 1;
        wins[N] = { r, x: bench(j) && bench(start) ? r - (bench(j) / bench(start) - 1) : null, done: true };
      } else if (j > last && last > start) {                                // window still running: return so far
        const lp = livePrice > 0 ? livePrice : days[last].px && days[last].px[tk];
        if (lp > 0) { const r = lp / close0 - 1; wins[N] = { r, x: bench(last) && bench(start) ? r - (bench(last) / bench(start) - 1) : null, done: false, el: last - start }; }
        else wins[N] = null;
      } else wins[N] = null;                                                // day 0 is the latest mark — no forward path yet
    });
    return { status: 'ok', d0: days[start].d, baseline, close0, reaction: close0 / baseline - 1, wins };
  };

  let ledgerStatus = 'idle';
  let ledgerDays = null;
  let ledgerNote = '';
  function ensureLedger() {
    if (ledgerStatus === 'loading' || ledgerStatus === 'ready') return;   // 'error' retries on the next visit to the tab
    const fetcher = root && root.fetch;
    if (typeof fetcher !== 'function') { ledgerStatus = 'error'; ledgerNote = 'no fetch in this environment'; return; }
    ledgerStatus = 'loading';
    Promise.resolve()
      .then(() => fetcher.call(root, 'portfolio-history.json', { cache: 'no-store' }))
      .then(response => { if (!response || !response.ok) throw new Error('the ledger request failed'); return response.json(); })
      .then(json => { ledgerDays = json && Array.isArray(json.days) ? json.days : []; ledgerStatus = 'ready'; })
      .catch(error => { ledgerStatus = 'error'; ledgerNote = error && error.message ? String(error.message) : 'load failed'; })
      .then(() => { try { if (root.CVApp && typeof root.CVApp.refresh === 'function') root.CVApp.refresh(); } catch (ignored) { /* repaint only */ } });
  }

  /* Catalyst board (spec §6 screen 8) — every row's Δtarget / Δfloor is priced LIVE by the shared engine
     through catalyst-core.js at the current dials and marks; nothing is stored. Rank = prob × max(|Δtarget|,|Δfloor|) ÷ price × (1 − priced). */
  const KIND_LABEL = { lease: 'Lease', contract: 'Contract', power: 'Power', energization: 'Energization', financing: 'Financing', jv: 'JV / partner', site: 'New site', regulatory: 'Regulatory', earnings: 'Earnings', other: 'Other' };
  const signedMoney = v => v == null || !Number.isFinite(v) ? '—' : (v >= 0 ? '+' : '−') + '$' + Math.abs(v).toFixed(2);
  const toneMoney = v => v == null || !Number.isFinite(v) ? '—' : Math.abs(v) < 0.005 ? '<span class="muted">$0.00</span>' : '<span class="' + (v >= 0 ? 'positive' : 'negative') + '">' + signedMoney(v) + '</span>';
  function priceCatalysts(M, rows) {
    const CC = root.CatalystCore, E = root.Engine, model = root.CloudModel, data = model && model.source;
    if (!CC || !E || !data) return rows.map(r => ({ ...r, imp: { error: 'engine not loaded' } }));
    const marks = model.marks || {};
    const opts = { dials: M.dials, prices: marks.prices, btc: marks.btc, eth: marks.eth };
    return rows.map(r => { let imp; try { imp = CC.impactOf(E, data, r, opts); } catch (e) { imp = { error: e && e.message ? e.message : 'impact failed' }; } return { ...r, imp }; });
  }
  function catalystBoard(M, outlook, query, h) {
    const kind = query.get('kind') || '';
    const dated = query.get('dated') === '1';
    const today = new Date().toISOString().slice(0, 10);
    let rows = list(outlook.catalysts).filter(r => (!h.company || r.tk === h.company) && (!kind || r.kind === kind) && (!dated || r.by));
    rows = priceCatalysts(M, rows);
    rows.sort((a, b) => ((b.imp && b.imp.score) || 0) - ((a.imp && a.imp.score) || 0) || (b.prob || 0) - (a.prob || 0) || String(a.by || '9').localeCompare(String(b.by || '9')));
    const kinds = [...new Set(list(outlook.catalysts).map(r => r.kind))].filter(Boolean);
    const kindFilter = '<label class="company-search-select"><span class="small muted">Event</span><select class="select-control" id="research-kind" aria-label="Filter catalysts by event kind"><option value="">All events</option>' + kinds.map(k => '<option value="' + esc(k) + '"' + (kind === k ? ' selected' : '') + '>' + esc(KIND_LABEL[k] || title(k)) + '</option>').join('') + '</select></label>';
    const datedToggle = '<label class="company-search-select"><span class="small muted">Hard-dated only</span><input type="checkbox" id="research-dated"' + (dated ? ' checked' : '') + ' aria-label="Show only catalysts with a hard date"></label>';
    const hardDate = r => !r.by ? '' : ' <span class="' + (r.by < today ? 'negative' : 'muted') + ' small nowrap" title="Hard date">' + (r.by < today ? 'passed ' : 'by ') + esc(date(r.by)) + '</span>';
    const impCell = r => r.imp && r.imp.error ? '<span class="negative small" title="' + esc(r.imp.error) + '">broken op</span>' : r.impact == null ? '<span class="muted small">no modelled effect</span>' : toneMoney(r.imp.delta) + ' <span class="muted small">(' + (r.imp.pct >= 0 ? '+' : '') + (r.imp.pct * 100).toFixed(0) + '%)</span>';
    const floorCell = r => r.imp && !r.imp.error && r.impact != null ? toneMoney(r.imp.dfloor) : '<span class="muted">—</span>';
    const scoreCell = r => r.imp && !r.imp.error && r.imp.score > 0 ? (r.imp.score * 100).toFixed(1) : '<span class="muted">0</span>';
    const detail = r => '<details><summary>Evidence</summary>' + (r.imp && !r.imp.error && r.impact != null ? '<p><strong>Modelled as.</strong> ' + esc(describeImpact(r.impact)) + ' → target $' + r.imp.target0.toFixed(2) + ' → $' + r.imp.target1.toFixed(2) + ', floor $' + r.imp.floor0.toFixed(2) + ' → $' + r.imp.floor1.toFixed(2) + ' at $' + r.imp.price.toFixed(2) + '.</p>' : '') + '<p><strong>Priced in.</strong> ' + esc(r.priced) + '% by the sweep’s judgement.</p>' + list(r.drivers).map(d => '<p>' + esc(d) + '</p>').join('') + '<p><strong>Sources.</strong> ' + esc(h.sources(r.sources) || 'Not supplied') + '</p></details>';
    const table = rows.length ? '<div class="table-scroll"><table class="plain-table catalyst-board"><caption class="sr-only">Catalyst board, ranked by probability × per-share effect × how little is priced in. Effects are priced live by the tracker engine.</caption><thead><tr><th scope="col" class="num">#</th><th scope="col">Company</th><th scope="col">Event</th><th scope="col">What</th><th scope="col" class="num">P</th><th scope="col">Window</th><th scope="col" class="num">Δ target</th><th scope="col" class="num">Δ floor</th><th scope="col" class="num">Priced</th><th scope="col" class="num">Rank score</th></tr></thead><tbody>' + rows.map((r, i) => '<tr' + (r.by && r.by < today ? ' class="rz-dim"' : '') + '><td class="num muted">' + (i + 1) + '</td><td>' + h.companyLink(r.tk) + '</td><td><span class="source-pill">' + esc(KIND_LABEL[r.kind] || title(r.kind)) + '</span></td><td><span>' + esc(r.title) + '</span>' + hardDate(r) + detail(r) + '</td><td class="num"><strong>' + esc(r.prob) + '%</strong></td><td class="small">' + esc(r.window || '—') + '</td><td class="num">' + impCell(r) + '</td><td class="num">' + floorCell(r) + '</td><td class="num">' + esc(r.priced) + '%</td><td class="num">' + scoreCell(r) + '</td></tr>').join('') + '</tbody></table></div><div class="table-foot"><span>' + rows.length + ' catalysts' + (h.company ? ' · ' + esc(h.company) : '') + (kind ? ' · ' + esc(KIND_LABEL[kind] || kind) : '') + '</span><span>Ranked live at current dials and marks</span></div>' : h.empty('catalysts');
    return '<section class="panel" aria-labelledby="research-section-title"><div class="panel-header"><div><h2 id="research-section-title">Catalyst board</h2><p>Every dated, material event inside ~6 months — leases, power, energizations, financings, JVs, sites, regulatory, earnings — priced by the tracker’s own engine and ranked by probability × per-share effect × how little the market already discounts it.</p></div><div class="catalyst-filters">' + h.filter + kindFilter + datedToggle + '</div></div>' + table + '<div class="chart-note"><strong>Δ target</strong> = the change in the headline target per share if the event lands as modelled; <strong>Δ floor</strong> = the change in the signed-only execution floor — a lease can leave the target still (the scarcity thesis already credits unsigned capacity) while lifting the floor a lot. Negative rows (a likely raise, a covenant election) are ranked on magnitude. <strong>Rank score</strong> = P × max(|Δ target|, |Δ floor|) ÷ price × (1 − priced) × 100. Rows with no modelled effect (earnings, most regulatory) show for completeness and score zero. Dimmed rows have passed their hard date without resolving — the sweep owes an update.</div></section>';
  }
  function describeImpact(op) {
    if (!op) return 'no change';
    switch (op.op) {
      case 'prov': return 'site “' + op.site + '” existence → ' + op.to;
      case 'lease': return (op.mw ? op.mw + ' MW' : 'the row') + ' at “' + op.site + '” signed' + (op.noiPerMWyr ? ' at $' + op.noiPerMWyr + 'M/MW·yr' : ' at the market anchor') + (op.counterparty ? ' with ' + op.counterparty : '');
      case 'energize': return 'site “' + op.site + '” first power → ' + op.yr + '-' + String(op.mo || 1).padStart(2, '0');
      case 'site': return 'new site ' + (op.n || '') + ' ' + op.mw + ' MW, ' + op.region + ', ' + op.yr + ', ' + op.prov;
      case 'raise': return 'planned equity raise ' + (op.sizeM >= 0 ? '+' : '−') + '$' + Math.abs(op.sizeM) + 'M';
      case 'debt': return 'net debt ' + (op.deltaM >= 0 ? '+' : '−') + '$' + Math.abs(op.deltaM) + 'M';
      case 'tier': return 'investability tier → ' + op.to;
      case 'multi': return list(op.ops).map(describeImpact).join('; ');
      default: return op.op;
    }
  }

  function render(data, params) {
    const M = data || {};
    const query = params instanceof URLSearchParams ? params : new URLSearchParams(params || '');
    const companies = list(M.companies).map(c => ({ ...c, ticker: c.ticker || c.tk, raw: c.raw || c }));
    const companyByTicker = Object.fromEntries(companies.map(c => [c.ticker, c]));
    const company = query.get('company') || '';
    const tab = ['developments', 'financing', 'outlook'].includes(query.get('tab')) ? query.get('tab') : 'developments';
    const limit = Math.min(200, Math.max(12, Number.parseInt(query.get('limit'), 10) || 12));
    const href = changes => {
      const next = new URLSearchParams(query);
      next.set('tab', tab);
      Object.entries(changes).forEach(([key, value]) => value == null || value === '' ? next.delete(key) : next.set(key, String(value)));
      return '/research?' + next.toString();
    };
    const companyLink = ticker => '<a href="/company/' + encodeURIComponent(ticker) + '">' + esc(ticker) + '</a>';
    const filter = '<label class="company-search-select"><span class="small muted">Company</span><select class="select-control" id="research-company" aria-label="Filter research by company"><option value="">All companies</option>' + companies.slice().sort((a, b) => a.ticker.localeCompare(b.ticker)).map(c => '<option value="' + esc(c.ticker) + '"' + (company === c.ticker ? ' selected' : '') + '>' + esc(c.ticker + ' · ' + c.name) + '</option>').join('') + (company && !companyByTicker[company] ? '<option value="' + esc(company) + '" selected>' + esc(company) + '</option>' : '') + '</select></label>';
    const more = (count, shown) => '<div class="table-foot"><span>' + shown + ' of ' + count + ' records' + (company ? ' · ' + esc(company) : '') + '</span>' + (count > shown ? '<a class="text-button" href="' + esc(href({ limit: Math.min(200, Math.max(50, limit + 50)) })) + '">Show more records →</a>' : '<span>Saved research records</span>') + '</div>';
    const empty = noun => '<div class="empty"><strong>No ' + esc(noun) + ' recorded' + (company ? ' for ' + esc(company) : '') + '</strong><p>This source snapshot does not contain matching records.</p>' + (company ? '<a class="text-button" href="' + esc(href({ company: '', limit: '' })) + '">View all companies →</a>' : '') + '</div>';
    const sources = values => list(values).map(id => {
      const source = list(M.sources).find(s => s.id === id);
      return source ? source.name : id;
    }).join(' · ');
    const details = (text, label) => text ? '<details><summary>' + esc(label || 'Read the full note') + '</summary><p>' + esc(text) + '</p></details>' : '';
    const outlook = M.outlook && !Array.isArray(M.outlook) ? M.outlook : {};
    const rampDate = ticker => M.ramps && M.ramps[ticker] ? M.ramps[ticker].asOf : companyByTicker[ticker] && companyByTicker[ticker].raw.ramp ? companyByTicker[ticker].raw.ramp.asOf : null;
    const compareAsOf = root.CloudModel && root.CloudModel.source && root.CloudModel.source.compare ? root.CloudModel.source.compare.asOf : null;
    const RD=root.ResearchData;
    const cards = '<section class="research-cards four" aria-label="Company research reports">' + [
      { ticker: 'IREN', url: '/iren', title: 'IREN', text: 'Power, delivery, earnings and funding in one research report.', feature: true },
      { ticker: 'CRWV', url: '/crwv', title: 'CoreWeave', text: 'Capacity, contract renewals and funding through to per-share value.' },
      { ticker: 'NBIS', url: '/nbis', title: 'Nebius', text: 'The build-out, earnings and balance sheet behind the research valuation.' },
      { ticker: 'IREN · CRWV · NBIS', url: '/research/compare', title: 'The same megawatt, three balance sheets', text: 'Gating factors, per-megawatt economics and the 2030 picture, recomputed side by side from the three research models.', date: compareAsOf }
    ].map(card => {
      const P=RD?.get(card.ticker),ref=RD?.supports(card.ticker)?RD.reference(card.ticker):null,value=RD?.value(card.ticker);
      const modelDate=P?.modelAsOf||P?.pricing?.asOf||P?.asOf||card.date;
      const prices=ref?'<div class="research-prices"><span>Market <strong>'+(ref.value>0?'$'+ref.value.toFixed(2):'Unavailable')+'</strong></span><span>Research <strong>'+(Number.isFinite(value)?'$'+value.toFixed(2):RD.status(card.ticker).error?'Unavailable':'Loading…')+'</strong></span></div><small class="quote-clock">'+esc(ref.label)+'</small>':'';
      return '<a class="research-card'+(card.feature?' feature':'')+'" href="'+esc(card.url)+'"><div class="eyebrow">'+card.ticker+' · '+(ref?'Research DCF':'Comparison')+'</div><h2>'+card.title+'</h2><p>'+card.text+'</p>'+prices+'<div class="card-bottom"><span>'+(modelDate?'Model · '+esc(date(modelDate)):'Model loading')+'</span><span>Open report →</span></div></a>';
    }).join('') + '</section>';

    let content = '';
    if (tab === 'developments') {
      const rows = companies.filter(c => !company || c.ticker === company).flatMap(c => list(c.raw.log).map(entry => ({ ...entry, ticker: c.ticker }))).sort((a, b) => String(b.d || '').localeCompare(String(a.d || '')) || a.ticker.localeCompare(b.ticker));
      const shown = rows.slice(0, limit);
      content = '<section class="panel" aria-labelledby="research-section-title"><div class="panel-header"><div><h2 id="research-section-title">Company developments</h2><p>Dated notes from the tracker’s source records.</p></div>' + filter + '</div>' + (shown.length ? shown.map(entry => '<article class="feed-item"><div class="feed-meta">' + companyLink(entry.ticker) + stamp(entry.d) + '<span class="source-pill">' + esc(title(entry.t)) + '</span></div><p>' + esc(excerpt(entry.x, 300)) + '</p>' + (String(entry.x || '').length > 300 ? details(entry.x) : '') + '<div class="section-caption">Source recorded: ' + esc(entry.s || 'Not supplied') + '</div></article>').join('') + more(rows.length, shown.length) : empty('developments')) + '</section>';
    } else if (tab === 'financing') {
      ensureLedger();
      const rows = companies.filter(c => !company || c.ticker === company).flatMap(c => list(c.raises || c.raw.raises).map(entry => ({ ...entry, ticker: c.ticker }))).sort((a, b) => String(b.d || '').localeCompare(String(a.d || '')) || a.ticker.localeCompare(b.ticker));
      const shown = rows.slice(0, limit);
      const labels = { atm: 'ATM programme', convert: 'Convertible notes', equity: 'Equity', debt: 'Debt', preferred: 'Preferred equity', pref: 'Preferred equity', other: 'Other' };
      const ready = ledgerStatus === 'ready' && Array.isArray(ledgerDays);
      if (ready) rows.forEach(row => {
        const marks = root.CloudModel && root.CloudModel.marks;
        row.study = deriveRaise(row.ticker, row, ledgerDays, marks && marks.prices && marks.prices[row.ticker] > 0 ? marks.prices[row.ticker] : null);
      });
      const okRows = ready ? rows.filter(r => r.study.status === 'ok') : [];
      const agg = kind => {
        const events = okRows.filter(r => kind === 'all' || r.kind === kind);
        const out = { n: events.length, rx: median(events.map(r => r.study.reaction)) };
        RZ_WINDOWS.forEach(N => {
          const done = events.filter(r => r.study.wins[N] && r.study.wins[N].done);
          out[N] = { n: done.length, med: median(done.map(r => r.study.wins[N].r)), hit: done.length ? done.filter(r => r.study.wins[N].r > 0).length / done.length : null, xmed: median(done.filter(r => r.study.wins[N].x != null).map(r => r.study.wins[N].x)) };
        });
        return out;
      };
      let study = '';
      if (rows.length && !ready) {
        study = '<div class="snapshot-banner"><span>' + (ledgerStatus === 'error'
          ? '<strong>Event study unavailable.</strong> The portfolio price ledger did not load (' + esc(ledgerNote) + '), so day-0 and forward returns cannot be derived. The recorded announcements below are unaffected.'
          : '<strong>Event study loads with the ledger…</strong> Day-0 reactions, +5/+15/+30 trading-day windows and benchmark excess are derived from the portfolio price ledger at render time. Announcements are shown meanwhile; no return is displayed before the ledger arrives.') + '</span></div>';
      } else if (rows.length && !okRows.length) {
        study = '<section class="panel raises-study" aria-labelledby="raises-study-title"><div class="panel-header"><div><h2 id="raises-study-title">Raise reaction study</h2><p>No matching announcement has a day 0 inside the ledger yet — the events below are facts without returns (pre-ledger history, or awaiting the next mark).</p></div></div></section>';
      } else if (rows.length) {
        const A = agg('all');
        const kindOrder = ['equity', 'atm', 'convert', 'pref', 'preferred', 'debt', 'other'];
        const kinds = kindOrder.filter(k => okRows.some(r => r.kind === k)).concat([...new Set(okRows.map(r => r.kind))].filter(k => !kindOrder.includes(k)));
        const windowCells = a => RZ_WINDOWS.map(N => a[N].n
          ? '<td class="num rz-sep">' + tone(a[N].med) + '</td><td class="num">' + tone(a[N].xmed) + '</td><td class="num">' + (a[N].hit * 100).toFixed(0) + '% <span class="muted">(' + a[N].n + ')</span></td>'
          : '<td class="num rz-sep">—</td><td class="num">—</td><td class="num">—</td>').join('');
        const aggRow = (label, a, strong) => '<tr><td>' + (strong ? '<strong>' + esc(label) + '</strong>' : esc(label)) + '</td><td class="num">' + a.n + '</td><td class="num">' + tone(a.rx) + '</td>' + windowCells(a) + '</tr>';
        study = '<section class="panel raises-study" aria-labelledby="raises-study-title"><div class="panel-header"><div><h2 id="raises-study-title">Raise reaction study</h2><p>' + okRows.length + ' of ' + rows.length + ' matching announcements have a day 0 in the ledger · ' + A[15].n + ' complete +15d windows · day-0 median ' + tone(A.rx) + ' · +15d median ' + tone(A[15].med) + (A[15].hit != null ? ' · +15d hit ' + (A[15].hit * 100).toFixed(0) + '%' : '') + '</p></div></div><div class="table-scroll"><table class="plain-table"><caption class="sr-only">Median raise reactions and hit rates by instrument type, complete windows only, derived from the portfolio price ledger.</caption><thead><tr><th scope="col" rowspan="2">Type</th><th scope="col" class="num" rowspan="2">N</th><th scope="col" class="num" rowspan="2">Day 0 median</th>' + RZ_WINDOWS.map(N => '<th scope="colgroup" class="rz-group" colspan="3">+' + N + ' trading days</th>').join('') + '</tr><tr>' + RZ_WINDOWS.map(() => '<th scope="col" class="num rz-sep">abs</th><th scope="col" class="num">vs univ</th><th scope="col" class="num">hit</th>').join('') + '</tr></thead><tbody>' + kinds.map(k => aggRow(labels[k] || title(k), agg(k), false)).join('') + aggRow('All raises', A, true) + '</tbody></table></div><div class="chart-note"><strong>Day 0</strong> = the first ledger session on or after the announcement; <strong>ah</strong> marks a raise announced after the close, so day 0 rolls to the next session, and non-trading days roll forward the same way. The baseline is the prior ledger close; windows are trading days anchored at the day-0 close — they test buying the reaction, not the round trip. <strong>abs</strong> = median move from the day-0 close; <strong>vs univ</strong> = the same net of the equal-weight universe benchmark over the window (each name is roughly 1/' + companies.length + ' of that basket); <strong>hit</strong> = the share of events that finished positive, (n) = events with the window complete. Italic grey returns in the table below are windows still running — the return so far, excluded from every aggregate. Ledger closes forward-fill days without a fresh print, so a flat day 0 on an illiquid name is suspect. Dimmed rows predate the name’s ledger history — facts without returns. Aggregates cover every matching announcement, not only the rows shown on this page, and are derived at render time from the ledger — nothing is stored.</div></section>';
      }
      const winCell = (s, N) => { if (!s || s.status !== 'ok' || !s.wins[N]) return '—'; const w = s.wins[N]; return w.done ? tone(w.r) : '<span class="rz-sofar">' + signedPct(w.r) + ' (' + w.el + 'd)</span>'; };
      const excessCell = s => { if (!s || s.status !== 'ok' || !s.wins[15] || s.wins[15].x == null) return '—'; const w = s.wins[15]; return w.done ? tone(w.x) : '<span class="rz-sofar">' + signedPct(w.x) + ' (' + w.el + 'd)</span>'; };
      const dayZeroCell = s => !s ? '—' : s.status === 'pending' ? '<span class="muted small">awaiting mark</span>' : s.status === 'nohistory' ? '<span class="muted small">no price history</span>' : tone(s.reaction);
      const studyDetail = s => {
        if (!ready || !s) return '';
        if (s.status === 'pending') return '<p><strong>Event study.</strong> Announced after the latest ledger mark — day 0 has not printed yet.</p>';
        if (s.status === 'nohistory') return '<p><strong>Event study.</strong> Predates this name’s ledger price history — recorded as a fact without returns.</p>';
        const win = N => { const w = s.wins[N]; return '+' + N + 'd ' + (!w ? '—' : signedPct(w.r) + (w.x != null ? ' (excess ' + signedPct(w.x) + ')' : '') + (w.done ? '' : ' — ' + w.el + ' trading days so far')); };
        return '<p><strong>Event study.</strong> Day 0 ' + esc(date(s.d0)) + ': $' + s.baseline.toFixed(2) + ' → $' + s.close0.toFixed(2) + ' (' + signedPct(s.reaction) + ' on the prior close). Windows from the day-0 close: ' + RZ_WINDOWS.map(win).join(' · ') + '. Excess is net of the equal-weight universe benchmark over the same window.</p>';
      };
      const studyHead = ready ? '<th scope="col" class="num rz-sep">Day 0</th><th scope="col" class="num">+5d</th><th scope="col" class="num">+15d</th><th scope="col" class="num">+30d</th><th scope="col" class="num">+15d excess</th>' : '';
      const studyCols = entry => ready ? '<td class="num rz-sep">' + dayZeroCell(entry.study) + '</td><td class="num">' + winCell(entry.study, 5) + '</td><td class="num">' + winCell(entry.study, 15) + '</td><td class="num">' + winCell(entry.study, 30) + '</td><td class="num">' + excessCell(entry.study) + '</td>' : '';
      content = study + '<section class="panel" aria-labelledby="research-section-title"><div class="panel-header"><div><h2 id="research-section-title">Capital raises</h2><p>Recorded announcements and programmes. Amounts are not necessarily cash raised.</p></div>' + filter + '</div>' + (shown.length ? '<div class="table-scroll"><table class="plain-table"><caption class="sr-only">Financing announcements, newest first. Amounts in US dollars as recorded by the source.' + (ready ? ' Return columns are derived from the portfolio price ledger at render time.' : '') + '</caption><thead><tr><th scope="col">Announced</th><th scope="col">Company</th><th scope="col">Type</th><th scope="col" class="num">Amount</th>' + studyHead + '<th scope="col">Purpose & terms</th></tr></thead><tbody>' + shown.map(entry => '<tr' + (ready && entry.study.status !== 'ok' ? ' class="rz-dim"' : '') + '><td class="nowrap">' + stamp(entry.d) + (ready && entry.ah ? ' <span class="muted small" title="Announced after the close — day 0 is the next session">ah</span>' : '') + '</td><td>' + companyLink(entry.ticker) + '</td><td>' + esc(labels[entry.kind] || title(entry.kind)) + '</td><td class="num">' + esc(money(entry.sizeM)) + '</td>' + studyCols(entry) + '<td><span>' + esc(excerpt(entry.use || 'Purpose not supplied', 130)) + '</span><details><summary>View recorded terms</summary>' + studyDetail(entry.study) + (entry.use ? '<p><strong>Purpose.</strong> ' + esc(entry.use) + '</p>' : '') + '<p><strong>Terms.</strong> ' + esc(entry.terms || 'Not supplied') + '</p><p><strong>Source.</strong> ' + esc(entry.source || 'Not supplied') + '</p>' + (entry.ah ? '<p>Announcement marked after market close in the source.</p>' : '') + '</details></td></tr>').join('') + '</tbody></table></div>' + more(rows.length, shown.length) : empty('financing announcements')) + '</section>';
    } else {
      const view = ['contracts', 'earnings', 'catalysts'].includes(query.get('view')) ? query.get('view') : 'catalysts';
      const asOf = outlook.asOf;
      const recorded = asOf ? 'Research as of ' + date(asOf) : 'Research date not supplied';
      const switcher = '<nav class="subnav" aria-label="Outlook views">' + [['catalysts', 'Catalyst board'], ['contracts', 'Next leases'], ['earnings', 'Earnings setup']].map(([key, label]) => '<a href="' + esc(href({ view: key, limit: '', kind: '', dated: '' })) + '"' + (view === key ? ' aria-current="page"' : '') + '>' + label + '</a>').join('') + '</nav>';
      const banner = '<div class="snapshot-banner"><span><strong>' + esc(recorded) + '.</strong> Dated analyst judgements from the weekly sweep — never a valuation input, never a sizing input to the paper portfolio. Probabilities are calibrated guesses, not company guidance.</span></div>';
      if (view === 'catalysts') {
        content = banner + switcher + catalystBoard(M, outlook, query, { company, href, filter, companyLink, sources, empty });
      } else {
        let rows = list(view === 'contracts' ? outlook.leases : outlook.earnings).filter(row => !company || row.tk === company);
        rows = rows.slice().sort(view === 'contracts' ? (a, b) => (b.prob || 0) - (a.prob || 0) : (a, b) => String(b.date || '').localeCompare(String(a.date || '')));
        const shown = rows.slice(0, limit);
        const recordDetails = entry => '<details><summary>Read the recorded reasoning</summary>' + (entry.site ? '<p><strong>Capacity.</strong> ' + esc(entry.site) + '</p>' : '') + (entry.tenants ? '<p><strong>Counterparties.</strong> ' + esc(entry.tenants) + '</p>' : '') + (entry.keyNumber ? '<p><strong>What the research tracked.</strong> ' + esc(entry.keyNumber) + '</p>' : '') + list(entry.drivers).map(driver => '<p>' + esc(driver) + '</p>').join('') + (entry.sentiment ? '<p><strong>Sentiment assessment.</strong> ' + esc(entry.sentiment) + '</p>' : '') + '<p><strong>Sources recorded.</strong> ' + esc(sources(entry.sources) || 'Not supplied') + '</p></details>';
        content = banner + switcher + '<section class="panel" aria-labelledby="research-section-title"><div class="panel-header"><div><h2 id="research-section-title">' + (view === 'contracts' ? 'Next leases' : 'Earnings setup') + '</h2><p>' + (view === 'contracts' ? 'Recorded probability of a binding revenue commitment within roughly six months of the research date.' : 'The questions and expectations recorded around each earnings event.') + '</p></div>' + filter + '</div>' + (shown.length ? shown.map(entry => '<article class="feed-item"><div class="feed-meta">' + companyLink(entry.tk) + '<span class="source-pill">Analyst judgement</span>' + (view === 'earnings' ? stamp(entry.date) : '') + '</div>' + (view === 'contracts' ? '<h3>' + (typeof entry.prob === 'number' ? esc(entry.prob) + '% recorded probability' : 'Probability not supplied') + '</h3><p>' + esc(entry.window || 'Window not supplied') + '</p><div class="section-caption">Expected capacity: ' + (typeof entry.mwLo === 'number' && typeof entry.mwHi === 'number' ? esc(entry.mwLo.toLocaleString('en-US') + '–' + entry.mwHi.toLocaleString('en-US')) + ' MW · source basis' : 'Not supplied') + '</div>' : '<p>' + esc(excerpt(entry.keyNumber || 'No research focus supplied.', 300)) + '</p>') + recordDetails(entry) + '</article>').join('') + more(rows.length, shown.length) : empty(view === 'contracts' ? 'contract forecasts' : 'earnings forecasts')) + '</section>';
      }
    }

    return '<header class="page-top"><div><div class="eyebrow">Research library</div><h1>Research &amp; developments</h1><p class="page-description">Company studies and dated source notes, with the assumptions kept in view.</p></div></header>' + (tab === 'developments' ? cards : '') + '<nav class="subnav" aria-label="Research sections">' + [['developments', 'Developments'], ['financing', 'Financing'], ['outlook', 'Outlook']].map(([key, label]) => '<a href="' + esc(href({ tab: key, view: '', limit: '' })) + '"' + (tab === key ? ' aria-current="page"' : '') + '>' + label + '</a>').join('') + '<a href="/research/compare">Megawatt comparison</a></nav>' + content + '<p class="table-explainer">Research preserves the source snapshot’s wording and attribution. A recorded source label is not a new verification of the underlying statement.</p>';
  }

  root.ResearchView = { render };
})(typeof window !== 'undefined' ? window : globalThis);
