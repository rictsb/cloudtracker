/* Paper-portfolio allocation + learning (spec §6b) — ONE source of truth, run by:
   - portfolio-backtest.js (node, simulated genesis)
   - portfolio-run.js (node, the daily GitHub Action)
   - the site's Portfolio tab (browser, display + what-if)
   Pure logic: no I/O, no clock — callers pass dates, prices and engine outputs in.

   The rule (spec §6b):
     view      μ = ln(target ÷ price)
     confidence c = (confMin + (1−confMin)·hardShare) × watch-item penalty
                    hardShare = (contracted floor + legacy) ÷ EV — value backed by
                    signed contracts and marked treasuries vs expected/pipeline
     effective ν = λ × c × m × μ   (λ global fight-the-market, m per-name learning)
     weights: softmax over ν>0 names at temperature T (low T = concentrated, no cap),
              gross exposure = min(1, Σν⁺ ÷ grossFullAt) — cash grows as edge thins,
     rebalance only when a weight drifts past the band; frozen (non-tradable) names
     are never traded — their value is carved out of the investable base. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PortfolioCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  const DEFAULT_PARAMS = {
    temperature: 0.15,     // softmax T: lower = more concentrated in top convictions
    confMin: 0.35,         // confidence floor for a name with zero hard backing
    watchPenalty: 0.9,     // × per open watch-item…
    watchPenaltyFloor: 0.7,//   …but never below this
    deMinimis: 0.01,       // weights under 1% drop to zero
    band: 0.02,            // rebalance only when some weight drifts > 2pts
    grossFullAt: 0.75,     // Σ positive views at which the book is fully invested
    tcBps: 5,              // paper transaction cost, bps of traded value
    lambda0: 0.75,         // starting λ (how hard we fight the market)
    lambdaMin: 0.3, lambdaMax: 1.25, lambdaGain: 0.3,
    learnEvery: 21,        // trading days between learning updates
    lookback: 63,          // trading days a view is given to play out
    mShrink: 0.92, mRecover: 1.03, mMin: 0.5,
    excessThreshold: 0.10, // |excess vs universe median| that counts as dis/agreement
    benchEvery: 21,        // benchmark equal-weight rebalance cadence
  };

  const r2 = x => Math.round(x * 100) / 100;
  const r4 = x => Math.round(x * 10000) / 10000;
  const rPx = x => (x < 10 ? r4(x) : r2(x));   // sub-$10 names keep 4dp — cents-rounding a $0.33 name is a 1.5% error

  function nameState(state, tk) {
    if (!state.names) state.names = {};
    return state.names[tk] || (state.names[tk] = { m: 1 });
  }

  /* rows: [{tk, price, target, ev, contractedEV, legacy, watch}] — engine outputs at live prices */
  function computeViews(rows, state, params) {
    return rows.map(r => {
      const ok = r.price > 0 && r.target > 0;
      const mu = ok ? Math.log(r.target / r.price) : null;
      const hard = r.ev > 0 ? Math.min(1, Math.max(0, (r.contractedEV + r.legacy) / r.ev)) : 0;
      const wpen = Math.max(params.watchPenaltyFloor, Math.pow(params.watchPenalty, r.watch || 0));
      const conf = (params.confMin + (1 - params.confMin) * hard) * wpen;
      const ns = nameState(state, r.tk);
      return { tk: r.tk, price: r.price, target: r.target,
               upside: ok ? r.target / r.price - 1 : null,
               mu, hardShare: hard, conf, m: ns.m, conviction: !!ns.conviction,
               nu: mu == null ? null : state.lambda * conf * ns.m * mu };
    });
  }

  /* long-only: only ν>0 names compete; cash = 1 − gross (grows mechanically as edge thins) */
  function targetWeights(views, params) {
    const pos = views.filter(v => v.nu != null && v.nu > 0);
    const sumNu = pos.reduce((a, v) => a + v.nu, 0);
    const gross = Math.min(1, sumNu / params.grossFullAt);
    const weights = {};
    if (pos.length && gross > 0) {
      const mx = Math.max(...pos.map(v => v.nu));
      let z = 0; const e = {};
      pos.forEach(v => { e[v.tk] = Math.exp((v.nu - mx) / params.temperature); z += e[v.tk]; });
      pos.forEach(v => { const w = gross * e[v.tk] / z; if (w >= params.deMinimis) weights[v.tk] = w; });
      const kept = Object.values(weights).reduce((a, b) => a + b, 0);
      if (kept > 0) Object.keys(weights).forEach(tk => { weights[tk] *= gross / kept; });
    }
    const cash = 1 - Object.values(weights).reduce((a, b) => a + b, 0);
    return { weights, cash, gross, sumNu };
  }

  /* holdings = {cash, positions:{tk: shares}}; px must price every held name (forward-filled) */
  function markNav(holdings, px) {
    let nav = holdings.cash;
    for (const tk in holdings.positions) nav += holdings.positions[tk] * (px[tk] || 0);
    return nav;
  }
  function currentWeights(holdings, px) {
    const nav = markNav(holdings, px), w = {};
    if (nav <= 0) return w;
    for (const tk in holdings.positions) w[tk] = holdings.positions[tk] * (px[tk] || 0) / nav;
    return w;
  }

  /* Trade to target when drift breaches the band; returns {holdings, trades, drift} (new objects).
     tradable (Set|null): names allowed to trade — null means all. Frozen names (stale quote,
     removed from universe, suspect print) keep their shares; their value is carved out of the
     investable base AND their target weight is renormalized away over the tradable sleeve —
     otherwise a one-day freeze of a large name would force-sell every healthy position into
     phantom cash. Cost-aware sizing keeps cash ≥ 0; an impossible balance aborts untraded. */
  function applyRebalance(holdings, tw, px, params, tradable) {
    const nav = markNav(holdings, px);
    if (nav <= 0) return { holdings, trades: [], drift: 0 };
    const isT = tk => (!tradable || tradable.has(tk)) && px[tk] > 0;
    let frozenVal = 0;
    for (const tk in holdings.positions) if (!isT(tk)) frozenVal += holdings.positions[tk] * (px[tk] || 0);
    const inv = Math.max(0, nav - frozenVal);          // investable base
    const cur = currentWeights(holdings, px);
    const names = [...new Set([...Object.keys(cur), ...Object.keys(tw.weights)])].filter(isT);
    // renormalize targets over the tradable sleeve: frozen names' weights must not become cash
    const denom = tw.cash + names.reduce((a, tk) => a + (tw.weights[tk] || 0), 0);
    const eff = tk => denom > 0 ? (tw.weights[tk] || 0) / denom : 0;
    const effCash = denom > 0 ? tw.cash / denom : 1;
    let drift = Math.abs((holdings.cash / nav) - effCash * inv / nav);
    names.forEach(tk => { drift = Math.max(drift, Math.abs((cur[tk] || 0) - eff(tk) * inv / nav)); });
    if (drift <= params.band) return { holdings, trades: [], drift };

    // two-pass cost-aware sizing: size positions to (investable − cost) so cash never goes negative
    let cost = 0, navEff = inv;
    for (let pass = 0; pass < 2; pass++) {
      cost = 0;
      names.forEach(tk => {
        const dv = eff(tk) * navEff - (holdings.positions[tk] || 0) * px[tk];
        if (Math.abs(dv) > nav * 1e-6) cost += Math.abs(dv) * params.tcBps / 1e4;
      });
      navEff = inv - cost;
    }
    const positions = {}; const trades = [];
    for (const tk in holdings.positions) if (!isT(tk) && holdings.positions[tk] > 0) positions[tk] = holdings.positions[tk]; // frozen carry
    names.forEach(tk => {
      const curVal = (holdings.positions[tk] || 0) * px[tk];
      const tgtVal = eff(tk) * navEff;
      const dv = tgtVal - curVal;
      if (Math.abs(dv) > nav * 1e-6) trades.push({ tk, usd: r2(dv), px: rPx(px[tk]), to: r4(eff(tk) * inv / nav) });
      if (tgtVal > 0) positions[tk] = tgtVal / px[tk];
    });
    let held = 0; for (const tk in positions) held += positions[tk] * (px[tk] || 0);
    const rawCash = nav - held - cost;
    if (rawCash < -nav * 1e-9) return { holdings, trades: [], drift, corrupt: true };  // accounting hole (frozenVal > nav?) — never clamp it away silently
    return { holdings: { cash: Math.max(0, rawCash), positions }, trades, drift };
  }

  /* Spearman with average ranks for ties (equal ν values are common — equal confidence tiers) */
  function spearman(xs, ys) {
    const rank = a => {
      const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]);
      const rk = new Array(a.length);
      let i = 0;
      while (i < idx.length) {
        let j = i;
        while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
        const r = (i + j) / 2 + 1;
        for (let k = i; k <= j; k++) rk[idx[k][1]] = r;
        i = j + 1;
      }
      return rk;
    };
    const rx = rank(xs), ry = rank(ys), n = xs.length;
    const mean = n ? (n + 1) / 2 : 0;
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < n; i++) { num += (rx[i] - mean) * (ry[i] - mean); dx += (rx[i] - mean) ** 2; dy += (ry[i] - mean) ** 2; }
    return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : 0;
  }

  /* Every learnEvery days: λ follows the realized rank-correlation of views → returns;
     per-name m shrinks only when the market opposed the view in TWO CONSECUTIVE learn windows
     (one bad window is noise; overlapping windows must not triple-count one episode), measured
     vs the cross-sectional MEDIAN (one +800% moonshot must not mark every other name 'wrong').
     m recovers only when vindicated (aligned), exactly as §6b states. eraStart (date string):
     never learn from windows that begin at or before it — simulated-era views are hindsight. */
  function updateLearning(state, ledger, params, eraStart) {
    const t = ledger.length - 1, t0 = t - params.lookback;
    if (t0 < 0) return null;
    const a = ledger[t0], b = ledger[t];
    if (eraStart && a.d <= eraStart) return { gated: true };
    const pairs = [];
    for (const tk in (a.nu || {})) {
      if (a.nu[tk] != null && a.px[tk] > 0 && b.px[tk] > 0)
        pairs.push({ tk, nu: a.nu[tk], ret: b.px[tk] / a.px[tk] - 1 });
    }
    if (pairs.length < 6) return null;
    const ic = spearman(pairs.map(p => p.nu), pairs.map(p => p.ret));
    state.lambda = Math.min(params.lambdaMax, Math.max(params.lambdaMin, state.lambda * (1 + params.lambdaGain * ic)));
    const rets = pairs.map(p => p.ret).sort((x, y) => x - y);
    const median = rets.length % 2 ? rets[(rets.length - 1) / 2] : (rets[rets.length / 2 - 1] + rets[rets.length / 2]) / 2;
    const diag = [];
    pairs.forEach(p => {
      const ns = nameState(state, p.tk);
      const excess = p.ret - median, thr = params.excessThreshold;
      const opposed = (p.nu > 0 && excess < -thr) || (p.nu < 0 && excess > thr);
      const aligned = (p.nu > 0 && excess > thr) || (p.nu < 0 && excess < -thr);
      if (opposed && !ns.conviction) {
        ns.opp = (ns.opp || 0) + 1;
        if (ns.opp >= 2) { ns.m = Math.max(params.mMin, ns.m * params.mShrink); ns.opp = 0; }
      } else {
        ns.opp = 0;
        if (aligned) ns.m = Math.min(1, ns.m * params.mRecover);
      }
      if (ns.m < 0.995 || ns.opp > 0) diag.push({ tk: p.tk, m: r4(ns.m), opp: ns.opp || 0, excess: r4(excess) });
    });
    // a name absent from this window (delisted/frozen/new) must not carry a months-old
    // opposition count into its next appearance — "consecutive" means consecutive
    const inWindow = new Set(pairs.map(p => p.tk));
    Object.entries(state.names).forEach(([tk, ns]) => { if (!inWindow.has(tk)) ns.opp = 0; });
    return { ic: r4(ic), lambda: r4(state.lambda), diag };
  }

  /* One trading day, identical for backtest and live run.
     ctx: {date, rows, px, state, params, holdings, bench, ledger, dayIdx,
           eraStart?, tradable?, btc?, eth?, notes?}
     px prices every ticker seen so far (forward-filled); rows only names investable today. */
  function step(ctx) {
    const { params, state } = ctx;
    ctx.notes = ctx.notes || [];

    // learn BEFORE forming today's views. Cadence anchors to the last successful learn
    // (not a length modulo) so the first CLEAN post-era window fires as soon as it exists;
    // era-gated attempts are surfaced as a note, never silent.
    let learn = null;
    if (ctx.ledger.length >= params.lookback && ctx.ledger.length - (state.lastLearnLen || 0) >= params.learnEvery) {
      const u = updateLearning(state, ctx.ledger, params, ctx.eraStart || null);
      if (u && u.gated) {
        if (!state.lastGateNote || ctx.ledger.length - state.lastGateNote >= params.learnEvery) {
          ctx.notes.push('learning paused — lookback window still contains simulated-genesis records');
          state.lastGateNote = ctx.ledger.length;
        }
      } else if (u) { learn = u; state.lastLearnLen = ctx.ledger.length; }
    }

    const views = computeViews(ctx.rows, state, params);
    const tw = targetWeights(views, params);
    const reb = applyRebalance(ctx.holdings, tw, ctx.px, params, ctx.tradable || null);
    if (reb.corrupt) ctx.notes.push('REBALANCE ABORTED — holdings do not reconcile with NAV (possible data corruption); book left untouched');
    ctx.holdings = reb.holdings;
    const nav = markNav(ctx.holdings, ctx.px);

    // benchmark: equal-weight every investable name, rebalanced monthly (new listings enter then).
    // Frozen names (in the bench but not investable today) carry their shares — never liquidated
    // at a forward-filled phantom price; suspended days (empty tradable set) defer the rebuild.
    const investable = ctx.rows.filter(r => r.price > 0).map(r => r.tk);
    const suspended = !!(ctx.tradable && ctx.tradable.size === 0);
    if (investable.length && !suspended && (ctx.bench.lastReb == null || ctx.dayIdx - ctx.bench.lastReb >= params.benchEvery)) {
      const positions = {}; let frozenVal = 0;
      for (const tk in ctx.bench.positions) if (!investable.includes(tk)) {
        positions[tk] = ctx.bench.positions[tk]; frozenVal += ctx.bench.positions[tk] * (ctx.px[tk] || 0);
      }
      const investVal = Math.max(0, markNav(ctx.bench, ctx.px) - frozenVal);
      investable.forEach(tk => { positions[tk] = (investVal / investable.length) / ctx.px[tk]; });
      ctx.bench = { cash: 0, positions, lastReb: ctx.dayIdx };
    }
    const benchNav = markNav(ctx.bench, ctx.px);

    const w = {}, nu = {}, pxr = {};
    const curW = currentWeights(ctx.holdings, ctx.px);
    for (const tk in curW) if (curW[tk] >= 0.0005) w[tk] = r4(curW[tk]);
    views.forEach(v => { if (v.nu != null) nu[v.tk] = r4(v.nu); });
    for (const tk in ctx.px) pxr[tk] = rPx(ctx.px[tk]) || ctx.px[tk];

    const rec = { d: ctx.date, nav: r2(nav), bench: r2(benchNav),
                  cash: r4(nav > 0 ? ctx.holdings.cash / nav : 1), gross: r4(tw.gross),
                  lambda: r4(state.lambda), w, nu, px: pxr, trades: reb.trades };
    if (ctx.btc != null) rec.btc = r2(ctx.btc);
    if (ctx.eth != null) rec.eth = r2(ctx.eth);
    if (ctx.notes && ctx.notes.length) rec.notes = ctx.notes;
    if (learn) rec.learn = learn;
    ctx.ledger.push(rec);
    return rec;
  }

  return { DEFAULT_PARAMS, computeViews, targetWeights, markNav, currentWeights,
           applyRebalance, spearman, updateLearning, step };
});
