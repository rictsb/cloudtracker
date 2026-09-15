/* Research reports — the generalized client-rendered research destination (spec §6 sections (b);
   rulings C6, C8, C12), one continuous visual view for /iren, /crwv and /nbis with ZERO per-name code.
   User direction 14 Sep: restore the seven-stage graphical report; legacy tab queries show the full document.
   Data: shared ResearchData.load(tk), lazily once per ticker — the exact P payload of
   onepager.js:64-65 plus the narrative extension (facts/tiles/notes/arr/footer/capexBasis/prints).
   Math: window.OnePager (the canonical onepager-core.js) — waterfall, sensitivities, tie-out.
   NEVER forked or reimplemented here; this file is presentation only, every displayed number
   is computed from the payload, never typed. Model dates come from P.asOf; reference prices
   carry a separate provider clock. Price updates never change the canonical research payload.
   Narrative blocks (notes/facts/tiles/folds/captions/footer) are first-party HTML fragments,
   rendered UNESCAPED per ruling C12 — exactly as production onepager.js injects them raw.
   Everything else is escaped. A failed report degrades only its own route (scoped error). */
(function (root) {
  'use strict';

  /* ---------- self-contained helpers (same pattern as iren-view.js / portfolio-view.js) ---------- */
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const n = (v, d = 0) => Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const usd = v => '$' + n(v, 2);
  const bn = (v, d = 1) => '$' + n(v, d) + 'bn';
  const pctf = x => n(x * 100, (x * 100) % 1 ? 1 : 0) + '%';
  const qlabel = q => q.slice(0, 4) + ' Q' + q.slice(-1);
  const dateLong = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? new Date(v + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : String(v || '');
  const f0 = v => v == null ? '' : Math.round(v).toLocaleString('en-US');
  const f1 = v => v == null ? '' : Number(v).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const p0 = v => v == null ? '' : (v * 100).toFixed(0) + '%';
  const fmtK = v => v >= 1e6 ? n(v / 1e6, 2) + 'm' : n(Math.round(v / 1000)) + 'k';
  const colors = ['#345cd0', '#7c8da8', '#263c64'];
  let chartSequence = 0;

  /* ---------- per-ticker state: one lazy fetch, scoped loading/error (spec failure states) ---------- */
  const REPORTS = {};
  let wired = false;

  function ensure(tk) {
    let st = REPORTS[tk];
    if (st) return st;
    st = REPORTS[tk] = { P: null, base: null, sens: null, sensPrice: undefined, labels: null, err: null };
    if (!root.ResearchData && typeof fetch !== 'function') { st.err = 'This environment cannot fetch the snapshot.'; return st; }
    const payload = root.ResearchData ? root.ResearchData.load(tk) : fetch('/' + tk.toLowerCase() + '-data.json', { cache: 'no-store' })
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + tk.toLowerCase() + '-data.json'); return r.json(); });
    st.loading = payload
      .then(P => {
        if (!root.OnePager) throw new Error('The valuation calculator (onepager-core.js) is unavailable.');
        if (!P || !P.L || !P.finance || !P.CAPQ) throw new Error('The snapshot file is missing its model series.');
        st.P = P;
        /* label defaults exactly as the production template applies them (onepager-template.html:293) */
        st.labels = Object.assign({ shell: 'shell', shellRow: 'Capex — shell', shellDebt: 'data-centre debt', debt: 'Debt', energised: 'energised' }, P.labels || {});
        st.base = root.OnePager.waterfall(P.L, P.CAPQ, P.finance, P.ARRC);
      })
      .catch(e => { st.P = null; st.err = (e && e.message) || String(e); })
      .then(() => { if (root.CVApp && root.CVApp.refresh) root.CVApp.refresh(); });
    return st;
  }

  function presentation(tk, st) {
    const canonical = st.P;
    const reference = root.ResearchData ? root.ResearchData.reference(tk) : {
      value: canonical.px?.v, asOf: canonical.px?.asOf || canonical.asOf,
      source: 'Research snapshot', status: 'snapshot',
      label: 'Research snapshot fallback · ' + dateLong(canonical.px?.asOf || canonical.asOf)
    };
    const available = Number.isFinite(reference.value) && reference.value > 0;
    const price = available ? reference.value : null;
    const displayed = root.ResearchData?.displayPayload(tk);
    const P = displayed || { ...canonical, px: { ...canonical.px, v: price, note: reference.label, asOf: reference.asOf } };
    if (!st.sens || st.sensPrice !== price) {
      st.sens = root.OnePager.sensitivities(canonical.L, canonical.CAPQ, canonical.finance, canonical.ARRC, price);
      st.sens[2] = { ...st.sens[2], name: available ? 'Equity raised at reference price, not $' + canonical.finance.EQ_PX : 'Equity raised at reference price · unavailable', unavailable: !available };
      if (!available) st.sens[2] = { ...st.sens[2], ps: null, delta: null, nd: null, sh: null, eq: null };
      st.sensPrice = price;
    }
    return { ...st, P, reference: { ...reference, value: price }, referenceUnavailable: !available };
  }

  /* ---------- the nine standard sensitivities (onepager-core.js:77-91) as URL-addressable keys.
     The first six keys match /iren's historical grammar so existing ?scenario= deep links keep
     working; the option objects mirror the canonical list one-for-one — options are data, the
     math stays in OnePager. Labels come from OnePager.sensitivities so wording is single-sourced. */
  const SCENARIO_KEYS = ['base', 'rate8', 'equityPrice', 'noCredit', 'convAsDebt', 'noRestricted', 'rev90', 'multLow', 'multHigh'];
  function scenarioOptions(P, key) {
    const F = P.finance;
    switch (key) {
      case 'rate8': return { rate: .08 };
      case 'equityPrice': return Number.isFinite(P.px.v) && P.px.v > 0 ? { eqPx: P.px.v } : {};
      case 'noCredit': return { noCredit: true };
      case 'convAsDebt': return { convAsDebt: true };
      case 'noRestricted': return { noRestricted: true };
      case 'rev90': return { revScale: .9 };
      case 'multLow': return { mult: F.MULT - .5 };
      case 'multHigh': return { mult: F.MULT + .5 };
      default: return {};
    }
  }

  /* ---------- generic building blocks ---------- */
  function lineChart(idp, rows, series, opt) {
    const W = 680, H = 245, L = 48, R = 78, T = 26, B = 44;
    const id = idp + '-chart-' + (++chartSequence);
    const values = series.flatMap(s => rows.map(s.get));
    const maxRaw = Math.max(...values, 1);
    const magnitude = Math.pow(10, Math.floor(Math.log10(maxRaw)));
    const maximum = opt.max || Math.ceil(maxRaw / magnitude * 2) / 2 * magnitude;
    const x = i => L + i / Math.max(1, rows.length - 1) * (W - L - R);
    const y = v => T + (1 - v / maximum) * (H - T - B);
    let body = '';
    for (let k = 0; k <= 4; k++) {
      const v = maximum * k / 4;
      body += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(v) + '" y2="' + y(v) + '" stroke="#e8ecf2"/><text x="' + (L - 10) + '" y="' + (y(v) + 4) + '" text-anchor="end">' + esc(opt.tick(v)) + '</text>';
    }
    rows.map((r, i) => ({ q: r[0], i })).filter(t => /Q4$/.test(t.q)).forEach(t => { body += '<text x="' + x(t.i) + '" y="' + (H - 17) + '" text-anchor="middle">' + t.q.slice(0, 4) + '</text>'; });
    const endLabels = series.map((s, i) => ({ i, y: y(s.get(rows[rows.length - 1])) })).sort((a, b) => a.y - b.y);
    endLabels.forEach((label, i) => { if (i) label.y = Math.max(label.y, endLabels[i - 1].y + 26); });
    const overrun = Math.max(0, endLabels[endLabels.length - 1].y - (H - B));
    endLabels.forEach(label => { label.y -= overrun; });
    series.forEach((s, si) => {
      const pts = rows.map((row, i) => [x(i), y(s.get(row))]);
      const path = pts.map((p, i) => (i ? 'L' : 'M') + p.join(',')).join(' ');
      if (si === 0 && opt.fill !== false) body += '<path d="' + path + ' L' + x(rows.length - 1) + ',' + y(0) + ' L' + x(0) + ',' + y(0) + ' Z" fill="#edf2ff"/>';
      body += '<path d="' + path + '" stroke="' + s.color + '" stroke-width="2.6" fill="none" stroke-linejoin="round"' + (s.dash ? ' stroke-dasharray="6 4"' : '') + '/>';
      rows.forEach((r, i) => {
        body += '<circle cx="' + x(i) + '" cy="' + y(s.get(r)) + '" r="6" fill="transparent"><title>' + esc(qlabel(r[0]) + ' · ' + s.label + ': ' + opt.value(s.get(r))) + '</title></circle>';
      });
      const last = pts[pts.length - 1], value = s.get(rows[rows.length - 1]);
      const labelY = endLabels.find(label => label.i === si).y;
      body += '<circle cx="' + last[0] + '" cy="' + last[1] + '" r="3" fill="' + s.color + '"/>' + (Math.abs(labelY - last[1]) > 2 ? '<path d="M' + last[0] + ',' + last[1] + ' L' + (last[0] + 7) + ',' + labelY + '" stroke="' + s.color + '" fill="none"/>' : '') + '<text class="chart-label" x="' + (last[0] + 10) + '" y="' + (labelY + 4) + '" style="fill:' + s.color + '">' + esc(opt.end ? opt.end(value) : opt.value(value)) + '</text>';
    });
    return '<div class="chart"><svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-labelledby="' + id + '-title ' + id + '-desc"><title id="' + id + '-title">' + esc(opt.title) + '</title><desc id="' + id + '-desc">' + esc(opt.description) + '</desc>' + body + '</svg></div><div class="chart-legend">' + series.map(s => '<span><i class="swatch" style="background:' + (s.dash ? 'repeating-linear-gradient(90deg,' + s.color + ' 0 4px,transparent 4px 7px)' : s.color) + '"></i>' + esc(s.label) + '</span>').join('') + '</div>';
  }

  /* rows may be plain cell arrays or {c:[cells], cls:'q-past'} for greyed reported quarters */
  function table(headers, rows, caption) {
    return '<div class="table-scroll"><table class="plain-table">' + (caption ? '<caption>' + esc(caption) + '</caption>' : '') +
      '<thead><tr>' + headers.map((h, i) => '<th scope="col"' + (i ? ' class="num"' : '') + '>' + esc(h) + '</th>').join('') + '</tr></thead><tbody>' +
      rows.map(r => { const cells = Array.isArray(r) ? r : r.c, cls = Array.isArray(r) ? '' : (r.cls || ''); return '<tr' + (cls ? ' class="' + cls + '"' : '') + '>' + cells.map((cell, i) => '<' + (i ? 'td class="num"' : 'th scope="row"') + '>' + esc(cell) + '</' + (i ? 'td' : 'th') + '>').join('') + '</tr>'; }).join('') +
      '</tbody></table></div>';
  }

  function heading(number, title, note) {
    return '<div class="section-intro"><span class="section-number">' + number + '</span><h2>' + esc(title) + '</h2>' + (note ? '<span class="muted">' + esc(note) + '</span>' : '') + '</div>';
  }

  function notesGrid(group) {
    if (!group || !group.length) return '';
    /* C12: first-party HTML fragments, rendered unescaped exactly as production injects them */
    return '<div class="notes-grid">' + group.map(note => '<div class="note-block">' + note + '</div>').join('') + '</div>';
  }

  /* ---------- VALUATION SVG panels ported from the production template ---------- */

  /* per-MW funding stack (onepager-template.html gFund, :370-381) */
  function svgFund(P) {
    const f = P.fund, W = 880, L = 150, R = 100, H = 34 + f.rows.length * 40;
    const x = v => L + v / f.max * (W - L - R);
    let b = '';
    f.rows.forEach((r, i) => {
      const y = 14 + i * 40; let acc = 0;
      b += '<text x="' + (L - 10) + '" y="' + (y + 15) + '" text-anchor="end" class="strong">' + esc(r[0]) + '</text>';
      r[1].forEach(seg => {
        b += '<rect x="' + x(acc) + '" y="' + y + '" width="' + Math.max(1, x(acc + seg[0]) - x(acc) - 2) + '" height="20" fill="' + esc(seg[1]) + '"><title>' + esc(r[0] + ' — ' + seg[2] + ': $' + seg[0] + 'm per MW') + '</title></rect>';
        if (seg[0] >= f.max / 10) b += '<text x="' + (x(acc) + 6) + '" y="' + (y + 14) + '" fill="#fff">$' + n(seg[0], seg[0] % 1 ? 1 : 0) + 'm</text>';
        acc += seg[0];
      });
      b += '<text x="' + (x(acc) + 8) + '" y="' + (y + 14) + '" class="strong">$' + n(acc, 1) + 'm per MW</text>';
    });
    b += '<line x1="' + x(f.cost) + '" x2="' + x(f.cost) + '" y1="6" y2="' + (H - 14) + '" stroke="#1c2735" stroke-width="1.5"/>';
    b += '<text x="' + x(f.cost) + '" y="' + (H - 2) + '" text-anchor="middle" class="strong">cost $' + n(f.cost) + 'm per MW</text>';
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="How one megawatt of new build is funded">' + b + '</svg>';
  }

  /* company capex bridge (template gBridge, :383-396) */
  function svgBridge(P) {
    const g = P.bridge, W = 880, L = 150, R = 100, H = 96;
    const x = v => L + v / g.max * (W - L - R);
    let b = '<text x="' + (L - 10) + '" y="25" text-anchor="end" class="strong">' + esc(g.label) + '</text>';
    b += '<rect x="' + x(0) + '" y="10" width="' + (x(g.lo) - x(0)) + '" height="20" fill="#1c2735"><title>' + esc(g.quote) + '</title></rect>';
    b += '<rect x="' + x(g.lo) + '" y="10" width="' + (x(g.hi) - x(g.lo)) + '" height="20" fill="#1c2735" opacity=".35"/>';
    b += '<text x="' + (x(g.hi) + 8) + '" y="24" class="strong">' + esc(g.range) + '</text>';
    b += '<text x="' + (L - 10) + '" y="65" text-anchor="end" class="strong">Funded by</text>';
    let acc = 0;
    g.segs.forEach(sg => {
      b += '<rect x="' + x(acc) + '" y="50" width="' + Math.max(1, x(acc + sg[0]) - x(acc) - 2) + '" height="20" fill="' + esc(sg[1]) + '"' + (sg[1] === 'var(--sunk)' ? ' stroke="#d3dae0"' : '') + '><title>' + esc(sg[2] + ': ~$' + sg[0] + 'bn') + '</title></rect>';
      b += '<text x="' + (x(acc) + 6) + '" y="64"' + (sg[1] === 'var(--sunk)' ? '' : ' fill="#fff"') + '>$' + n(sg[0]) + 'bn</text>';
      acc += sg[0];
    });
    b += '<text x="' + (x(acc) + 8) + '" y="64" class="strong">' + esc(g.total) + '</text>';
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Company capex guide and how it is funded">' + b + '</svg>';
  }

  /* per-MW one-year waterfall (template gWater, :398-411) */
  function svgSteps(P) {
    const steps = P.steady.steps, W = 680, H = 250, L = 8, R = 8, top = 22, bot = 62;
    const nSteps = steps.length, bw = (W - L - R) / nSteps, max = P.steady.stepsMax;
    const y = v => top + (H - top - bot) * (1 - v / max);
    let run = 0, b = '';
    steps.forEach((st, i) => {
      const cx = L + i * bw + bw / 2, w = Math.min(30, bw - 10);
      let a, bb, fill;
      if (st[2] === 'd') { a = run; bb = run + st[1]; run = bb; fill = 'var(--s2)'; }
      else { a = 0; bb = st[1]; run = bb; fill = i === nSteps - 1 ? 'var(--s1)' : 'var(--s1u)'; }
      b += '<rect x="' + (cx - w / 2) + '" y="' + y(Math.max(a, bb)) + '" width="' + w + '" height="' + Math.max(1, Math.abs(y(a) - y(bb))) + '" fill="' + fill + '"><title>' + esc(st[0] + ': ' + (st[1] > 0 ? '+' : '') + '$' + n(st[1], 2) + 'm') + '</title></rect>';
      b += '<text x="' + cx + '" y="' + (y(Math.max(a, bb)) - 6) + '" text-anchor="middle" class="strong">' + (st[1] < 0 ? '−' : '') + '$' + n(Math.abs(st[1]), Math.abs(st[1]) % 1 ? 2 : 1) + 'm</text>';
      const lab = st[0].split(' ');
      b += '<text x="' + cx + '" y="' + (H - 38) + '" text-anchor="middle">' + esc(lab.slice(0, 2).join(' ')) + '</text>';
      if (lab.length > 2) b += '<text x="' + cx + '" y="' + (H - 25) + '" text-anchor="middle">' + esc(lab.slice(2).join(' ')) + '</text>';
    });
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="What one megawatt earns in one year, step by step">' + b + '</svg>';
  }

  /* ---------- the FULL quarterly cash-waterfall ledger (template :448-471; spec §6e invariant 1) —
     rows from OnePager.waterfall(...).C plus epsYE, labels from P.labels, base case, never typed. */
  function cashLedger(st) {
    const P = st.P, F = P.finance, lb = st.labels, v = st.base, C = v.C, CONV = F.CONV || 0;
    const ROWS = [
      ['sec', 'Power'], ['Gross MW ' + lb.energised, c => f0(c.g)], ['IT MW ' + lb.energised, c => f0(c.it)], ['+ IT MW in the quarter', c => f0(c.add)],
      ['sec', 'Use'], ['IT MW earning', c => f1(c.itE)], ['Utilisation — earning ÷ ' + lb.energised, c => p0(c.util)],
      ['sec', 'GPUs'], ['Installed', c => f0(c.gi)], ['Commissioned', c => f0(c.gc)],
      ['sec', 'Rate'], ['$ per GPU-hr, fleet blend', c => c.bl != null ? n(c.bl, 2) : ''], ['$m per IT MW-yr, fleet blend', c => c.itE > 0 ? f1(c.perMW) : '—'],
      ['sec', 'Revenue'], ['Contracted ARR — ' + P.arrLabel + ', $bn', c => c.arrc != null ? n(c.arrc, 1) : ''], ['Model, $m', c => f1(c.rev)], ['Street, $m', c => c.st != null ? f0(c.st) : ''], ['Run-rate, $bn', c => n(c.rr, 1)],
      ['sec', 'Cash'], ['EBITDA at ' + p0(F.M) + ', $m', c => f0(c.eb)], ['Capex — GPUs + ancillaries, by vintage', c => f0(c.capG)], [lb.shellRow, c => f0(c.capS)], ['Capex, total', c => f0(c.capex)],
      ['Cash before financing', c => f0(c.cbf), c => c.cbf < 0 ? 'neg' : c.cbf > 0 ? 'pos' : ''],
      ['Customer prepayments received', c => c.r ? f0(c.r.pre) : ''], ['Prepayments credited against fees', c => c.r ? f0(-c.r.cred) : '', c => c.r && c.r.cred > 0 ? 'neg' : ''],
      ['Equity raised', c => c.r ? f0(c.r.eq) : ''], ['Debt drawn', c => c.r ? f0(c.r.draw) : ''],
      ['Interest — debt at ' + p0(F.RATE) + (CONV ? ', converts at ' + n((F.CONV_RATE || 0) * 100, 1) + '%' : ''), c => c.r ? f0(c.r.intr) : ''],
      ['sec', 'Balance sheet'], [lb.debt + (CONV ? ' ex converts' : '') + ', $bn', c => c.r ? n(c.r.debt, 1) : ''],
      CONV ? ['Convertible notes, $bn — equity at the tie-out', c => c.r ? n(CONV, 1) : ''] : null,
      ['Cash, $bn', c => c.r ? n(c.r.cash, 1) : ''], ['Net debt' + (CONV ? ' ex converts' : '') + ', $bn', c => c.r ? n(c.r.nd, 1) : '', c => c.r && c.r.nd < 0 ? 'pos' : ''],
      ['Prepayments owed to customers, $bn', c => c.r ? n(c.r.owed, 1) : ''], ['Shares outstanding, m' + (CONV ? ' — before the converts' : ''), c => c.r ? f0(c.r.sh) : ''],
      ['sec', 'Earnings'], ['Net income, $m', c => c.r ? f0(c.r.ni) : '', c => c.r && c.r.ni < 0 ? 'neg' : ''],
      ['EPS, calendar year' + (CONV ? ' — converts in' : ''), c => c.epsYE !== undefined ? '$' + n(c.epsYE, 2) : '', c => c.epsYE !== undefined && c.epsYE < 0 ? 'neg' : '']
    ].filter(Boolean);
    const qh = q => '’' + q.slice(2, 4) + '<br>Q' + q.slice(5);
    let html = '<table><thead><tr><th></th>' + C.map(c => '<th class="' + (c.ye ? 'ye ' : '') + (c.past ? 'past' : '') + '">' + qh(c.q) + '</th>').join('') + '</tr></thead><tbody>';
    ROWS.forEach(r => {
      if (r[0] === 'sec') { html += '<tr class="sec"><td colspan="' + (C.length + 1) + '">' + esc(r[1]) + '</td></tr>'; return; }
      html += '<tr><td>' + esc(r[0]) + '</td>' + C.map(c => '<td class="' + (c.ye ? 'ye ' : '') + (c.past ? 'past ' : '') + (r[2] ? r[2](c) : '') + '">' + r[1](c) + '</td>').join('') + '</tr>';
    });
    return html + '</tbody></table>';
  }

  function updateReadingPosition(){
    if(typeof document==='undefined'||!document.querySelector)return;
    const page=document.querySelector('.report-single');if(!page)return;
    const nodes=[...page.querySelectorAll('[data-report-section]')];
    let current=nodes[0]?.dataset.reportSection;
    for(const el of nodes){if(el.getBoundingClientRect().top<=135)current=el.dataset.reportSection;}
    page.querySelectorAll('[data-report-jump]').forEach(a=>a.dataset.reportJump===current?a.setAttribute('aria-current','location'):a.removeAttribute('aria-current'));
    const progress=page.querySelector('.rp-progress i'),r=page.getBoundingClientRect(),range=Math.max(1,r.height-root.innerHeight);
    if(progress)progress.style.width=Math.max(0,Math.min(100,-r.top/range*100))+'%';
  }

  /* ---------- wiring: one document-level listener set, attached once (styles live in report-layout.css) ---------- */
  function wire() {
    if (wired || typeof document === 'undefined') return;
    wired = true;
    if(root.addEventListener){
      let queued=false;
      root.addEventListener('scroll',()=>{if(!queued){queued=true;root.requestAnimationFrame(()=>{queued=false;updateReadingPosition();});}},{passive:true});
      root.addEventListener('resize',updateReadingPosition);
    }
    document.addEventListener('click', function (e) {
      const jump = e.target.closest && e.target.closest('[data-report-jump], .rp-sticky-name');
      if(jump && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey){
        const target=document.querySelector(jump.getAttribute('href'));
        if(target){e.preventDefault();history.replaceState({},'',location.pathname+location.search+jump.getAttribute('href'));target.scrollIntoView({behavior:root.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'start'});}
        return;
      }
      const choice=e.target.closest && e.target.closest('[data-report-scenario-link]');
      if(choice && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey){
        e.preventDefault();const q=new URLSearchParams(location.search),key=choice.getAttribute('data-report-scenario-link');
        q.delete('tab');key==='base'?q.delete('scenario'):q.set('scenario',key);
        history.pushState({},'',location.pathname+(q.size?'?'+q.toString():'')+'#report-valuation');
        if(root.CVApp && root.CVApp.refresh)root.CVApp.refresh();
        if(typeof root.requestAnimationFrame==='function')root.requestAnimationFrame(()=>document.getElementById('report-valuation')?.scrollIntoView({behavior:'auto',block:'start'}));
        return;
      }
      if(e.target.closest && e.target.closest('[data-report-print]')){root.print();return;}
      const b = e.target.closest && e.target.closest('[data-report-retry]');
      if (b) { delete REPORTS[b.getAttribute('data-report-retry')]; if (root.CVApp && root.CVApp.refresh) root.CVApp.refresh(); }
    });
    document.addEventListener('change', function (e) {
      const t = e.target;
      if (t && t.hasAttribute && t.hasAttribute('data-report-scenario')) {
        const q = new URLSearchParams(location.search);
        t.value === 'base' ? q.delete('scenario') : q.set('scenario', t.value);
        q.delete('tab');
        history.pushState({}, '', location.pathname + (q.size ? '?' + q.toString() : '') + '#report-valuation');
        if (root.CVApp && root.CVApp.refresh) root.CVApp.refresh();
      }
    });
  }

  /* ---------- entry: window.ReportView.render(tk, params) ---------- */
  root.ReportView = {
    /* optional preload hook for the router; render() also loads lazily on first paint */
    load(tk) {
      tk = String(tk || '').toUpperCase();
      ensure(tk);
      return Promise.resolve();
    },
    render(tk, params) {
      tk = String(tk || '').toUpperCase();
      wire();
      chartSequence = 0;
      const st = ensure(tk);
      if (st.err) return '<div class="report-view"><div class="page-top"><div><h1>' + esc(tk) + '</h1><p class="page-description">Research report</p></div></div>' +
        '<section class="panel padded report-section"><div class="empty"><strong>The ' + esc(tk) + ' research snapshot could not load.</strong>' + esc(st.err) + ' — the rest of the app is unaffected.<br><button type="button" class="button" data-report-retry="' + esc(tk) + '" style="margin-top:12px">Retry</button></div></section></div>';
      if (!st.P) return '<div class="report-view"><div class="page-top"><div><h1>' + esc(tk) + '</h1><p class="page-description">Research report</p></div></div>' +
        '<section class="panel padded report-section"><div class="empty"><strong>Loading the ' + esc(tk) + ' research snapshot…</strong>A dated cut of the research model; the page renders once the data file arrives.</div></section></div>';
      const query = params instanceof URLSearchParams ? params : new URLSearchParams(params || '');
      let output;
      try {
        output = root.ResearchLayout.render(presentation(tk, st), query, {cashLedger,svgFund,svgBridge,svgSteps,scenarioOptions,SCENARIO_KEYS});
      } catch (e) {
        // A malformed payload field must degrade this route alone, like a failed fetch does.
        console.error(e);
        return '<div class="report-view"><div class="page-top"><div><h1>' + esc(tk) + '</h1><p class="page-description">Research report</p></div></div>' +
          '<section class="panel padded report-section"><div class="empty"><strong>The ' + esc(tk) + ' report failed to render.</strong>' + esc(e && e.message || 'unexpected data shape') + ' — the rest of the app is unaffected.<br><button type="button" class="button" data-report-retry="' + esc(tk) + '" style="margin-top:12px">Retry</button></div></section></div>';
      }
      if (typeof root.requestAnimationFrame === 'function') root.requestAnimationFrame(updateReadingPosition);
      return '<div class="report-view" id="report-top">' + output + '</div>';
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
