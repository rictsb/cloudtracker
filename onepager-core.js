/* Research one-pager math — ONE source of truth for the quarterly cash waterfall, the tie-out and the
   standard sensitivities (spec §6e), run by both:
   - the generated pages (inlined by onepager.js, browser)
   - onepager.js --check / --sens (node)
   Never fork it. Inputs are plain data: the ledger rows L, capex by quarter CAPQ, the finance block F and
   the contracted-ARR series ARRC; everything else on the page is presentation. */
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else root.OnePager = m;
})(typeof self !== 'undefined' ? self : this, function () {
  const QS = l => (+l.slice(0, 4) - 2026) * 4 + (+l.slice(5));

  /* L rows: [q, grossMW energised, IT MW energised, IT MW earning, GPUs installed, GPUs commissioned, GPUs signed,
              rev $m, revC $m, revS $m, $/GPU-hr blend, vintage $m per IT MW-yr, actual $m, street $m]
     CAPQ: {q:[GPUs+ancillaries $m, shell $m]}   F: finance block (see onepager.js / spec §6e)   ARRC: {q: contracted ARR $bn} */
  function waterfall(L, CAPQ, F, ARRC, o) {
    o = o || {};
    const M = F.M, W = F.W, MULT = F.MULT, SH0 = F.SH0, EQ_SHARE = F.EQ_SHARE, EQ_PX = o.eqPx != null ? o.eqPx : F.EQ_PX,
      DEBT0 = F.DEBT0, CASH0 = F.CASH0, RATE = o.rate != null ? o.rate : F.RATE, TAX = F.TAX, MINCASH = F.MINCASH,
      CONV = F.CONV || 0, CONV_RATE = o.convAsDebt ? RATE : (F.CONV_RATE || 0), CASH_R = o.noRestricted ? 0 : (F.CASH_R || 0), FWD = F.FWD || 0,
      SERIES = F.SERIES || [], T0 = QS(F.T0 || '2026Q3'), HZ = F.HORIZON || 4.33, AM = 1 - Math.pow(1 - (F.AMORT || 0.16), 0.25),
      PP = F.prepay || {}, ratio = PP.ratio != null ? PP.ratio : 0.5, startQ = PP.startQ != null ? PP.startQ : 8, termQ = PP.termQ || 4,
      termOv = PP.termQOverride || {}, already = PP.alreadyReceived || {}, special = PP.special || {}, creditsFixed = PP.credits || [],
      CV = F.cover || { ctrPre: .5, ctrGpu: .9, ctrShell: .65, spotGpu: .5, spotShell: .5 }, revScale = o.revScale || 1, mult = o.mult != null ? o.mult : MULT;
    let cumPV = 0, prevIT = 0;
    const C = L.map((r, i) => {
      const [q, g, it, itE, gi, gc, gs, rev0, revC0, revS0, bl, vint, act, st] = r; const rev = rev0 * revScale, revC = revC0 * revScale, revS = revS0 * revScale;
      const add = i ? it - prevIT : it; prevIT = it;
      const util = it > 0 ? itE / it : 0, sg = rev > 0 ? revS / rev : 0, cs = rev > 0 ? revC / rev : 0, perMW = itE > 0 ? rev * 4 / itE : 0, eb = rev * M,
        cq = CAPQ[q] || [0, 0], capG = cq[0], capS = cq[1], capex = capG + capS, cbf = eb - capex;
      const t = (QS(q) - T0) / 4, past = QS(q) < T0, df = past ? null : Math.pow(1 + W, -t), pv = df ? eb * df : 0; if (!past) cumPV += pv;
      return { q, g, it, add, itE, util, gi, gc, vint, sg, cs, bl, perMW, rev, act, dl: act != null ? rev / act - 1 : null, st, rr: rev * 4 / 1000,
        arrc: (ARRC || {})[q], eb, capG, capS, capex, cbf, df, pv, cum: past ? null : cumPV / 1000, past, ye: /Q4$/.test(q) };
    });
    const N = C.length, CR = new Array(N + 24).fill(0), qi = q => C.findIndex(x => x.q === q);
    creditsFixed.forEach(c => { const i0 = qi(c.from); if (i0 < 0) return; for (let k = 0; k < c.n; k++) CR[i0 + k] += c.amt / c.n; });
    const rd = { debt: DEBT0 - CONV, cash: CASH0 + CASH_R, sh: SH0, gpu: 0, shell: 0, owed: PP.openingOwed || 0 };
    let eqTot = 0;
    C.forEach((c, i) => {
      if (c.past) { c.r = null; return; }
      const G = c.capG / 1000, S = c.capS / 1000, capex = G + S, eb = c.eb / 1000, yr = +c.q.slice(0, 4), eqPol = yr >= (F.EQ_FROM || 2027) ? EQ_SHARE * capex : 0;
      const sp = special[c.q] || {};
      const preOth = c.cs * ratio * (G - (sp.replaceG || 0)), nq = termOv[c.q] || termQ;
      if (!o.noCredit) for (let k = 0; k < nq; k++) CR[i + startQ + k] += preOth / nq;
      const pre = preOth + (sp.upfront || 0) - (already[c.q] || 0), cred = o.noCredit ? 0 : CR[i];
      rd.gpu += G; rd.shell += S;
      const da = rd.gpu / (F.GPU_LIFE || 5) / 4 + rd.shell / (F.SHELL_LIFE || 25) / 4, intr = rd.debt * RATE / 4 + CONV * CONV_RATE / 4,
        tax = Math.max(0, eb - da - intr) * TAX, op = eb - intr - tax - cred, amort = rd.debt * AM;
      const need = capex + amort - op - pre - eqPol - (rd.cash - MINCASH),
        cap = Math.max(0, Math.min(c.cs * (CV.ctrPre * G + CV.ctrGpu * G + CV.ctrShell * S) + (1 - c.cs) * (CV.spotGpu * G + CV.spotShell * S), capex) - pre);
      let draw = 0, eqRes = 0; if (need > 0) { draw = Math.min(need, cap); eqRes = need - draw; }
      rd.debt += draw - amort; rd.cash += op - capex + pre + draw - amort + eqPol + eqRes;
      if (need < 0) { const rp = Math.min(-need, rd.debt); rd.debt -= rp; rd.cash -= rp; }
      rd.sh += (eqPol + eqRes) * 1000 / EQ_PX; rd.owed += pre - cred; eqTot += eqPol + eqRes;
      const ni = eb - da - intr - tax;
      c.r = { eb: eb * 1000, dag: rd.gpu / (F.GPU_LIFE || 5) / 4 * 1000, pre: pre * 1000, cred: cred * 1000, owed: rd.owed, eq: (eqPol + eqRes) * 1000, draw: draw * 1000,
        intr: intr * 1000, tax: tax * 1000, da: da * 1000, ni: ni * 1000, debt: rd.debt, cash: rd.cash, nd: rd.debt - rd.cash, sh: rd.sh };
    });
    /* tie-out: horizon run-rate x multiple, less net debt ex converts and prepayments still owed at PV, over the diluted count;
       the converts become shares at the model's own horizon price with the capped calls netted */
    const last = C[N - 1].r, rr = L[N - 1][7] * revScale * 4 / 1000, ev = rr * mult, DF = Math.pow(1 + W, HZ);
    let liab = 0; for (let k = N; k < CR.length; k++) liab += CR[k] / Math.pow(1 + W, (k - N + 1) / 4);
    const sh30 = last.sh - FWD; let S = 0, convSh = 0;
    if (o.convAsDebt) { S = (ev - (last.nd + CONV) - liab) / sh30 * 1000; }
    else for (let it = 0; it < 40; it++) { S = (ev - last.nd - liab) / (sh30 + convSh) * 1000; convSh = SERIES.reduce((a, s) => a + s[0] / s[1] * 1000 * (1 - Math.max(0, Math.min(s[2] || Infinity, S) - s[1]) / S), 0); }
    const dil = sh30 + convSh, ps = S / DF, addb = o.convAsDebt ? 0 : CONV * CONV_RATE * (1 - TAX) * 1000;
    C.forEach(c => { if (!/Q4$/.test(c.q)) return; const ys = C.filter(x => x.q.slice(0, 4) === c.q.slice(0, 4) && x.r);
      if (ys.length === 4) c.epsYE = (ys.reduce((s, x) => s + x.r.ni, 0) + addb) / (c.r.sh + convSh - (c.q.slice(0, 4) === L[N - 1][0].slice(0, 4) ? FWD : 0)); });
    const hy = L[N - 1][0].slice(0, 4), Y = C.filter(x => x.q.startsWith(hy) && x.r), S30 = k => Y.reduce((s, x) => s + x.r[k], 0) / 1000;
    const pl = { rev: S30('eb') / M, eb: S30('eb'), da: S30('da'), intr: S30('intr'), tax: S30('tax'), ni: S30('ni'), dag: S30('dag'), debtAvg: Y.reduce((s, x) => s + x.r.debt, 0) / Math.max(1, Y.length) };
    return { C, N, last, rr, ev, DF, liab, sh30, S, convSh, dil, ps, addb, pl, eqTot, issued: last.sh - SH0, year: hy, ndc: last.nd + (o.convAsDebt ? CONV : 0) };
  }

  /* the standard sensitivities every page shows the same way */
  function sensitivities(L, CAPQ, F, ARRC, PX) {
    const base = waterfall(L, CAPQ, F, ARRC).ps;
    const S = [
      ['Base', {}],
      ['Debt at 8% instead of ' + Math.round(F.RATE * 100) + '%', { rate: .08 }],
      ['Equity raised at today’s price, not $' + F.EQ_PX, { eqPx: PX }],
      ['Prepayments kept as funding, never credited back', { noCredit: true }],
      ['Converts carried as debt, not converted', { convAsDebt: true }],
      ['Restricted cash excluded', { noRestricted: true }],
      ['Revenue −10% every quarter', { revScale: .9 }],
      ['Multiple −0.5×', { mult: F.MULT - .5 }],
      ['Multiple +0.5×', { mult: F.MULT + .5 }],
    ];
    return S.map(([n, o]) => { const r = waterfall(L, CAPQ, F, ARRC, o); return { name: n, ps: r.ps, delta: r.ps - base, nd: r.ndc, sh: r.dil, eq: r.eqTot }; });
  }

  return { waterfall, sensitivities, QS };
});
