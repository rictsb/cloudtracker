/* CSS moved to styles.css (Wave 2 consolidation) */
/* Signed-contracts tab — WP-Contracts+ (rebuild plan ruling C3).
 * Everything production's Leases screen computes (GPU Cloud and Colo Tracker/app.js:62-138), restyled:
 * totals strip, print tape, pending-book dimming, campus-stem grouping, compute-contract analytics.
 * Reads adapted values from CloudModel.current and the RAW books (incl. effective:false) from the
 * source company objects, which the adapter keeps intact on company.raw.
 * No fetches: render(M, company, search) is synchronous. */
(function (root) {
  'use strict';

  let wired = false;

  /* campus stem: the site-name prefix before phase/building qualifiers — groups rows into
     physical campuses. Ported verbatim from production app.js:66-67. */
  function stem(n) {
    let x = n; const seps = [' ph', ' Ph', ' ELN', ' CB-', ' Bldg', ' ROFO', ' expansion', ' approved', ' pipeline', ' tranche', ' balance', ' initial', ' build-out', ' buildout', ' long-term', ' Phase', '(', '—', 'ph1', 'ph2'];
    let cut = x.length; seps.forEach(sp => { const i = x.indexOf(sp); if (i > 0 && i < cut) cut = i; }); return x.slice(0, cut).trim().replace(/[,\s]+$/, '');
  }
  /* median + signing half-year, ported from production app.js:87-88 */
  const med = x => { if (!x.length) return null; const s = [...x].sort((p, q) => p - q); return s[Math.floor(s.length / 2)]; };
  const half = s => { const [y, m] = String(s).split('-').map(Number); return y + (m <= 6 ? ' H1' : ' H2'); };

  const GEN_ORDER = ['hopper', 'blackwell', 'vera-rubin', 'mixed'];
  const SORT_DEFAULT = { co: 'asc', type: 'asc', signed: 'asc', value: 'desc', term: 'desc', mw: 'desc', rate: 'desc' };

  function helpers() {
    const U = root.UI || {};
    const esc = U.esc || (v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
    const n = U.n || ((x, d = 0) => Number(x).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
    const big = U.big || (x => Math.abs(x) >= 1000 ? '$' + n(x / 1000, 1) + 'bn' : '$' + n(x, 0) + 'm');
    const metric = U.metric || ((label, value, note, cls = '') => `<div class="metric"><div class="metric-label">${label}</div><div class="metric-value ${cls}">${value}</div><div class="metric-note">${note}</div></div>`);
    return { esc, n, big, metric };
  }

  const mwFmt = (n, v) => n(v, v % 1 ? 1 : 0);

  function wire() {
    if (wired || typeof document === 'undefined') return; wired = true;
    document.addEventListener('click', e => {
      const b = e.target.closest('[data-csort]'); if (!b) return;
      const k = b.getAttribute('data-csort');
      const q = new URLSearchParams(location.search);
      const hasSort = x => Object.prototype.hasOwnProperty.call(SORT_DEFAULT, x);
      const cur = hasSort(q.get('csort')) ? q.get('csort') : 'value';
      const curDir = q.get('cdir') || SORT_DEFAULT[cur] || 'desc';
      const dir = cur === k ? (curDir === 'asc' ? 'desc' : 'asc') : (SORT_DEFAULT[k] || 'desc');
      if (k === 'value' && dir === 'desc') { q.delete('csort'); q.delete('cdir'); }
      else { q.set('csort', k); q.set('cdir', dir); }
      history.replaceState({}, '', location.pathname + (q.size ? '?' + q.toString() : ''));
      if (root.CVApp && root.CVApp.refresh) root.CVApp.refresh();
    });
  }

  function render(M, company, search) {
    wire();
    const { esc, n, big, metric } = helpers();
    if (!M || !Array.isArray(M.companies)) return '<section class="panel padded"><div class="empty"><strong>Contract register unavailable</strong><p>The valuation model has not loaded yet — reload to retry.</p></div></section>';

    company = company || '';
    const q = String(search || '').trim().toLowerCase();
    const S = (root.CloudModel && root.CloudModel.source) || null;
    const CONST = S && S.config && S.config.constants ? S.config.constants : null;
    const mcs = M.companies.filter(c => !company || c.ticker === company);
    const hit = (co, cp, src) => !q || (co + ' ' + (cp || '') + ' ' + (src || '')).toLowerCase().includes(q);

    /* ---- lease book with production's per-book analytics (app.js:68-76) ---- */
    const leases = [];
    mcs.forEach(mc => {
      const raw = mc.raw || {};
      (raw.leases || []).forEach(l => {
        if (!hit(mc.ticker, l.counterparty, l.source)) return;
        const pend = l.effective === false;
        const segs = (mc.sites || []).filter(s => s.raw && s.raw.leaseId === l.id);
        const ev = segs.reduce((x, s) => x + (s.evM || 0), 0);
        const startYr = segs.length ? Math.min(...segs.map(s => s.year)) : null;
        const camp = segs.length ? [...new Set(segs.map(s => String(s.name).split('(')[0].trim()))].join(' · ') : '';
        // leased share of the campus power we credit: this lease's MW ÷ all company rows sharing its campus stems
        const stems = [...new Set(segs.map(s => stem(String(s.name))))];
        const campMW = stems.length ? (raw.sites || []).filter(s2 => stems.some(st => stem(String(s2.n)) === st)).reduce((x, s2) => x + (s2.physMW || s2.mw || 0), 0) : 0;
        leases.push({ co: mc.ticker, l, pend, ev, campMW, pctCamp: campMW > 0 ? l.mw / campMW : null, annual: (l.mw || 0) * (l.noiPerMWyr || 0), startYr, camp });
      });
    });
    const effL = leases.filter(r => !r.pend), pendL = leases.length - effL.length;
    const totMW = effL.reduce((x, r) => x + (r.l.mw || 0), 0);
    const totNOI = effL.reduce((x, r) => x + r.annual, 0);
    const totBase = effL.reduce((x, r) => x + (r.l.totalRevM || 0), 0);
    const blended = totMW ? totNOI / totMW : null;
    const anchor = CONST && typeof CONST.landlordNOI === 'number' ? CONST.landlordNOI * 1.1 : null;

    /* ---- compute-contract book (app.js:113-138) ---- */
    const comps = [];
    mcs.forEach(mc => {
      const raw = mc.raw || {};
      (raw.contracts || []).forEach(x => {
        if (!hit(mc.ticker, x.counterparty, x.source)) return;
        comps.push({ co: mc.ticker, x, pend: x.effective === false });
      });
    });
    const effC = comps.filter(r => !r.pend), pendC = comps.length - effC.length;
    const totBook = effC.reduce((x, r) => x + (r.x.totalRevM || 0), 0);

    /* ---- merged register entries — per-kind value cells & basis labels kept exactly ---- */
    const entries = [];
    comps.forEach(r => {
      const x = r.x;
      entries.push({
        kind: 'compute', co: r.co, counterparty: x.counterparty || '', pend: r.pend,
        kindLabel: 'GPU compute', signed: x.signed || '', valM: x.totalRevM != null ? x.totalRevM : null,
        valBasis: 'Take-or-pay contract revenue', termYrs: x.termYrs || 0,
        mwNum: x.mw || 0, rateNum: x.ratePerMWyr || 0, r
      });
    });
    leases.forEach(r => {
      const l = r.l, g = l.grossTotalM != null;
      entries.push({
        kind: 'lease', co: r.co, counterparty: l.counterparty || '', pend: r.pend,
        kindLabel: 'Data-centre lease', signed: l.signed || '', valM: g ? l.grossTotalM : (l.totalRevM != null ? l.totalRevM : null),
        valBasis: g ? 'Gross base-term lease value' : 'Contract revenue over term', termYrs: l.termYrs || 0,
        mwNum: l.mw || 0, rateNum: l.noiPerMWyr || 0, r
      });
    });
    const ps = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
    const csort = ps.get('csort') && Object.prototype.hasOwnProperty.call(SORT_DEFAULT, ps.get('csort')) ? ps.get('csort') : 'value';
    const cdir = ps.get('cdir') === 'asc' ? 'asc' : ps.get('cdir') === 'desc' ? 'desc' : (SORT_DEFAULT[csort] || 'desc');
    const KEY = {
      co: e => e.co, type: e => e.kindLabel, signed: e => e.signed || '',
      value: e => e.pend || e.valM == null ? -Infinity : e.valM,
      term: e => e.termYrs || 0, mw: e => e.pend ? -Infinity : e.mwNum, rate: e => e.pend ? -Infinity : e.rateNum
    };
    const kf = KEY[csort], dm = cdir === 'asc' ? 1 : -1;
    entries.sort((a, b) => { const av = kf(a), bv = kf(b); const d = (typeof av === 'string' ? av.localeCompare(bv) : av - bv) * dm; return d || a.co.localeCompare(b.co); });

    /* ---- totals strip (production app.js:82-85) ---- */
    let strip = '';
    if (leases.length) {
      strip = `<div class="metric-strip cols-5">${
        metric('Signed lease books', String(effL.length), pendL ? pendL + ' more signed, not yet effective' : 'Effective data-centre leases')
      }${metric('Critical IT capacity', n(totMW) + '<span class="suffix">MW</span>', 'Across effective books')
      }${metric('Base-term value', totBase ? big(totBase) : '—', 'Total base-term contract revenue')
      }${metric('Blended NOI', blended != null ? '$' + n(blended, 2) + '<span class="suffix">M</span>' : '—', 'Per MW·yr, MW-weighted term-average')
      }${metric('Forward anchor', anchor != null ? '$' + n(anchor, 2) + '<span class="suffix">M</span>' : '—', anchor != null ? 'Cheap-owned landlord NOI, per MW·yr' : 'Model constant unavailable')}</div>`;
    }

    /* ---- print tape (production app.js:86-91): median signed NOI by kind and by signing vintage ---- */
    let tape = '';
    if (effL.length) {
      const byKind = {}; effL.forEach(r => { (byKind[r.l.kind || '?'] = byKind[r.l.kind || '?'] || []).push(r.l.noiPerMWyr); });
      const byHalf = {}; effL.forEach(r => { if (r.l.signed) (byHalf[half(r.l.signed)] = byHalf[half(r.l.signed)] || []).push(r.l.noiPerMWyr); });
      const row = (label, vals) => { const m = med(vals); return `<tr><td>${esc(label)}</td><td class="num">${vals.length}</td><td class="num">${m != null ? '$' + n(m, 2) + 'M' : '—'}</td></tr>`; };
      tape = `<section class="panel report-section"><div class="panel-header"><div><h2>Print tape</h2><p>Median signed NOI, $M per MW·yr — effective colo books only</p></div></div><div class="table-scroll"><table class="plain-table"><thead><tr><th>Segment</th><th class="num">Books</th><th class="num">Median signed NOI</th></tr></thead><tbody>` +
        `<tr class="tape-cut"><td colspan="3">By kind</td></tr>` +
        Object.entries(byKind).sort((a, b) => b[1].length - a[1].length).map(([k, v]) => row(k, v)).join('') +
        `<tr class="tape-cut"><td colspan="3">By signing vintage</td></tr>` +
        Object.keys(byHalf).sort().map(k => row(k, byHalf[k])).join('') +
        `</tbody></table></div><div class="chart-note">The market-rate read the forward anchor is calibrated against. NOI is the term-average of each actual contract, escalators embedded — a fact from the filing. Books signed but not yet effective are excluded.</div></section>`;
    }

    /* ---- the register ---- */
    const arrow = k => csort === k ? (cdir === 'asc' ? ' ↑' : ' ↓') : '';
    const sortAttr = k => csort === k ? ` aria-sort="${cdir === 'asc' ? 'ascending' : 'descending'}"` : '';
    const th = (k, label, num) => `<th${num ? ' class="num"' : ''}${sortAttr(k)}><button data-csort="${k}" type="button">${label}${arrow(k)}</button></th>`;
    const detail = lines => `<details><summary>Economics &amp; source</summary>${lines.filter(Boolean).map(([k, v]) => `<p><strong>${k}</strong> ${v}</p>`).join('')}</details>`;
    const bodyRows = entries.map(e => {
      const pendPill = e.pend ? ' <span class="source-pill rumored">not yet effective</span>' : '';
      let mwCell = '—', rateCell = '—', valCell = '—', sub = '', lines;
      if (e.kind === 'lease') {
        const r = e.r, l = r.l;
        if (r.camp) sub = `<div class="company-sub" style="max-width:230px">${esc(r.camp)}</div>`;
        if (!e.pend) {
          mwCell = mwFmt(n, l.mw || 0);
          rateCell = l.noiPerMWyr != null ? '$' + n(l.noiPerMWyr, 2) + 'M<div class="company-sub" style="margin-top:2px">NOI, term-avg</div>' : '—';
          valCell = e.valM != null ? `${big(e.valM)}<div class="company-sub" style="margin-top:2px">${e.valBasis}</div>` : '—';
        } else valCell = '<span class="muted">Signed, not yet effective</span>';
        lines = [
          ['Kind', esc(l.kind || '—')],
          r.camp ? ['Campus', esc(r.camp)] : null,
          r.pctCamp != null ? ['Campus leased', n(r.pctCamp * 100, 0) + '% of ' + n(r.campMW) + ' MW credited'] : null,
          l.grossMW ? ['Gross MW', mwFmt(n, l.grossMW) + ' MW · ' + Math.round((l.mw || 0) / l.grossMW * 100) + '% IT ratio'] : null,
          e.pend ? ['Status', 'Signed, not yet effective — values suppressed, excluded from all totals and the print tape'] : null,
          !e.pend && l.noiPerMWyr != null ? ['Annual NOI', '$' + n(r.annual, 0) + 'm'] : null,
          !e.pend ? ['Value added', big(r.ev) + ' of modelled site value at the current assumptions'] : null,
          r.startYr ? ['First rent', String(r.startYr) + ' (model energisation)'] : null,
          ['Source', esc(l.source || '—')]
        ];
      } else {
        const x = e.r.x;
        if (!e.pend) {
          mwCell = x.mw ? (x.inferredMW ? '<span class="muted">~</span>' : '') + mwFmt(n, x.mw) : '—';
          rateCell = x.ratePerMWyr ? '$' + n(x.ratePerMWyr, 1) + 'M' + (x.inferredMW ? ' <span class="muted">~</span>' : '') : '—';
          valCell = e.valM != null ? `${big(e.valM)}<div class="company-sub" style="margin-top:2px">${e.valBasis}</div>` : '—';
        } else valCell = '<span class="muted">Signed, not yet effective</span>';
        lines = [
          ['Generation', esc(x.gen || '—')],
          ['Status', e.pend ? 'Signed, not yet effective — values suppressed, excluded from all totals and the ladder' : 'Effective'],
          !e.pend && x.totalRevM && x.termYrs ? ['Annual run-rate', big(x.totalRevM / x.termYrs) + ' per year over the term'] : null,
          x.mw ? ['MW basis', x.inferredMW ? 'Analyst inference (contract dollars ÷ fleet rate) — MW not disclosed by the company' : 'Company-disclosed'] : null,
          ['Source', esc(x.source || '—')]
        ];
      }
      const genPill = e.kind === 'compute' && e.r.x.gen ? `<div style="margin-top:4px"><span class="source-pill">${esc(e.r.x.gen)}</span></div>` : e.kind === 'lease' && e.r.l.kind ? `<div style="margin-top:4px"><span class="source-pill">${esc(e.r.l.kind)}</span></div>` : '';
      return `<tr${e.pend ? ' class="row-pending"' : ''}><td><a href="/company/${esc(e.co)}">${esc(e.co)}</a><div style="margin-top:4px;max-width:230px">${esc(e.counterparty)}${pendPill}</div>${sub}</td><td>${e.kindLabel}${genPill}</td><td class="nowrap">${esc(e.signed || 'Not supplied')}</td><td class="num">${valCell}</td><td class="num">${e.termYrs ? n(e.termYrs, 1) + ' years' : '—'}</td><td class="num">${mwCell}</td><td class="num">${rateCell}</td><td>${detail(lines)}</td></tr>`;
    }).join('') || `<tr><td colspan="8"><div class="empty">No signed contracts match this filter.</div></td></tr>`;

    const pendTot = pendL + pendC;
    const register = `<section class="panel report-section"><div class="panel-header"><div><h2>Signed contract register</h2><p>${entries.length} signed records shown${pendTot ? ` · ${pendTot} not yet effective — dimmed, excluded from every total` : ''}</p></div></div><div class="table-scroll"><table class="plain-table"><thead><tr>${th('co', 'Company / counterparty')}${th('type', 'Type')}${th('signed', 'Signed')}${th('value', 'Contract value', true)}${th('term', 'Term', true)}${th('mw', 'IT MW', true)}${th('rate', 'Rate $/MW·yr', true)}<th>Detail</th></tr></thead><tbody>${bodyRows}</tbody></table></div><div class="chart-note">Contract value is the total signed value over the stated term — take-or-pay contract revenue for GPU compute, gross base-term value for data-centre leases; the basis is labelled on each row. It is not annual revenue, recognised revenue or equity value. Lease NOI is the term-average of the actual contract (escalators embedded) — a fact from the filing; base term is the total base-term contract value. MW and $/MW·yr marked ~ are analyst inference, not disclosure. Open a row's detail for kind, vintage, campus-leased share, gross MW, annual NOI, value added and the source.</div></section>`;

    /* ---- compute-contract analytics: blended signed rates + generation ladder ---- */
    let computePanel = '';
    if (comps.length) {
      const rateTag = mc => {
        const xs = ((mc.raw && mc.raw.contracts) || []).filter(x => x.effective !== false && x.mw);
        const d = xs.filter(x => !x.inferredMW).length;
        return xs.length && d === xs.length ? ' (disclosed MW)' : d > 0 ? ' (MW partly disclosed)' : '<span class="muted">~</span>';
      };
      const rated = mcs.filter(mc => mc.raw && typeof mc.raw.signedRate === 'number');
      const ratesLine = rated.length ? `<div style="padding:0 24px 16px;font-size:12px;color:var(--muted)">$-weighted blended signed rates (source <code>signedRate</code>): ${rated.map(mc => `<b>${esc(mc.ticker)}</b> $${n(mc.raw.signedRate, 1)}M${rateTag(mc)}`).join(' · ')}</div>` : '';
      const byGen = {};
      effC.forEach(r => { const x = r.x; if (!x.ratePerMWyr) return; (byGen[x.gen || 'unspecified'] = byGen[x.gen || 'unspecified'] || []).push({ rate: x.ratePerMWyr, inf: !!x.inferredMW }); });
      const genKeys = [...GEN_ORDER.filter(g => byGen[g]), ...Object.keys(byGen).filter(g => !GEN_ORDER.includes(g))];
      const unpriced = effC.filter(r => !r.x.ratePerMWyr).length;
      const ladder = genKeys.length ? `<div class="table-scroll"><table class="plain-table"><thead><tr><th>Generation</th><th class="num">Contracts priced</th><th class="num">Signed rate, $M/MW·yr</th><th>MW basis</th></tr></thead><tbody>${genKeys.map(g => {
        const v = byGen[g], rs = v.map(e => e.rate), lo = Math.min(...rs), hi = Math.max(...rs);
        const allInf = v.every(e => e.inf), anyInf = v.some(e => e.inf);
        return `<tr><td><span class="source-pill">${esc(g)}</span></td><td class="num">${v.length}</td><td class="num">${lo === hi ? '$' + n(lo, 1) + 'M' : '$' + n(lo, 1) + 'M – $' + n(hi, 1) + 'M'}${allInf ? ' <span class="muted">~</span>' : ''}</td><td>${allInf ? 'Analyst inference ~' : anyInf ? 'Mixed — ~ marks inference' : 'Company-disclosed'}</td></tr>`;
      }).join('')}</tbody></table></div>` : '<div class="empty">No effective compute contract in this filter carries a derivable $/MW·yr.</div>';
      const disclosedCos = M.companies.filter(c => ((c.raw && c.raw.contracts) || []).some(x => x.effective !== false && x.mw && !x.inferredMW)).map(c => c.ticker);
      computePanel = `<section class="panel report-section"><div class="panel-header"><div><h2>GPU compute book — generation ladder</h2><p>${effC.length} signed contracts · ${totBook ? big(totBook) : '$0m'} total book${pendC ? ` · ${pendC} not yet effective excluded` : ''}</p></div></div>${ratesLine}${ladder}<div class="chart-note">Compute contracts are take-or-pay dollars over a term — MW and $/MW·yr marked ~ are analyst inference, not disclosure${disclosedCos.length ? ` (companies disclosing any contractual MW: ${disclosedCos.map(esc).join(', ')})` : ' (no company disclosed contractual MW)'}. Each owner's $-weighted blended rate binds its contracted slice via <code>signedRate</code>; unsigned and re-signing slices ride the GPU generation-curve dial.${unpriced ? ` ${unpriced} priced-in-dollars contract${unpriced === 1 ? ' carries' : 's carry'} no derivable rate and sit${unpriced === 1 ? 's' : ''} outside the ladder.` : ''}</div></section>`;
    }

    const filtered = !!(company || q);
    return `<div class="date-rule"><span>${entries.length} signed records${company ? ' · ' + esc(company) : ''}</span><span>${filtered ? 'Filtered — totals, tape and ladder reflect this filter' : 'All companies · effective books only in totals'}</span></div>${strip}${tape}${register}${computePanel}`;
  }

  root.ContractsView = { render };
})(typeof window !== 'undefined' ? window : globalThis);
