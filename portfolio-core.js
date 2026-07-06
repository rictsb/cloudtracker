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
     rebalance only when a weight drifts past the band. */
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
    excessThreshold: 0.10, // |excess vs universe| that counts as dis/agreement
    benchEvery: 21,        // benchmark equal-weight rebalance cadence
  };

  const r2 = x => Math.round(x * 100) / 100;
  const r4 = x => Math.round(x * 10000) / 10000;

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

  /* trade to target when drift breaches the band; returns {holdings, trades} (new objects) */
  function applyRebalance(holdings, tw, px, params) {
    const nav = markNav(holdings, px);
    const cur = currentWeights(holdings, px);
    const names = new Set([...Object.keys(cur), ...Object.keys(tw.weights)]);
    let drift = Math.abs((holdings.cash / nav) - tw.cash);
    names.forEach(tk => { drift = Math.max(drift, Math.abs((cur[tk] || 0) - (tw.weights[tk] || 0))); });
    if (drift <= params.band) return { holdings, trades: [], drift };
    const positions = {}; const trades = []; let cost = 0;
    names.forEach(tk => {
      if (!(px[tk] > 0)) { // unpriceable (halted/delisted): freeze the position, never trade blind
        if (holdings.positions[tk]) positions[tk] = holdings.positions[tk];
        return;
      }
      const curVal = (holdings.positions[tk] || 0) * px[tk];
      const tgtVal = (tw.weights[tk] || 0) * nav;
      const dv = tgtVal - curVal;
      if (Math.abs(dv) > nav * 1e-6) {
        trades.push({ tk, usd: r2(dv), px: r2(px[tk]), to: r4((tw.weights[tk] || 0)) });
        cost += Math.abs(dv) * params.tcBps / 1e4;
      }
      if (tgtVal > 0) positions[tk] = tgtVal / px[tk];
    });
    let held = 0; for (const tk in positions) held += positions[tk] * (px[tk] || 0);
    return { holdings: { cash: nav - held - cost, positions }, trades, drift };
  }

  function spearman(xs, ys) {
    const rank = a => { const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]);
      const rk = new Array(a.length); idx.forEach((p, i) => { rk[p[1]] = i + 1; }); return rk; };
    const rx = rank(xs), ry = rank(ys), n = xs.length;
    const mean = n ? (n + 1) / 2 : 0;
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < n; i++) { num += (rx[i] - mean) * (ry[i] - mean); dx += (rx[i] - mean) ** 2; dy += (ry[i] - mean) ** 2; }
    return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : 0;
  }

  /* Every learnEvery days: λ follows the realized rank-correlation of views → returns;
     per-name m shrinks where the market persistently disagreed (unless conviction), recovers when vindicated.
     Adapts SIZING only — never touches data.json. Diagnostics are surfaced on the Portfolio tab. */
  function updateLearning(state, ledger, params) {
    const t = ledger.length - 1, t0 = t - params.lookback;
    if (t0 < 0) return null;
    const a = ledger[t0], b = ledger[t];
    const pairs = [];
    for (const tk in (a.nu || {})) {
      if (a.nu[tk] != null && a.px[tk] > 0 && b.px[tk] > 0)
        pairs.push({ tk, nu: a.nu[tk], ret: b.px[tk] / a.px[tk] - 1 });
    }
    if (pairs.length < 6) return null;
    const ic = spearman(pairs.map(p => p.nu), pairs.map(p => p.ret));
    state.lambda = Math.min(params.lambdaMax, Math.max(params.lambdaMin, state.lambda * (1 + params.lambdaGain * ic)));
    const mean = pairs.reduce((s, p) => s + p.ret, 0) / pairs.length;
    const diag = [];
    pairs.forEach(p => {
      const ns = nameState(state, p.tk);
      const excess = p.ret - mean, thr = params.excessThreshold;
      const opposed = (p.nu > 0 && excess < -thr) || (p.nu < 0 && excess > thr);
      const aligned = (p.nu > 0 && excess > thr) || (p.nu < 0 && excess < -thr);
      if (opposed && !ns.conviction) ns.m = Math.max(params.mMin, ns.m * params.mShrink);
      else if (aligned || ns.m < 1) ns.m = Math.min(1, ns.m * params.mRecover);
      if (ns.m < 0.995) diag.push({ tk: p.tk, m: r4(ns.m), excess: r4(excess) });
    });
    return { ic: r4(ic), lambda: r4(state.lambda), diag };
  }

  /* One trading day, identical for backtest and live run.
     ctx: {date, rows, px, state, params, holdings, bench, ledger, dayIdx}
     px prices every ticker seen so far (forward-filled); rows only names trading today. */
  function step(ctx) {
    const { params, state } = ctx;

    // learn BEFORE forming today's views, on the recorded history
    let learn = null;
    if (ctx.ledger.length >= params.lookback && ctx.ledger.length % params.learnEvery === 0)
      learn = updateLearning(state, ctx.ledger, params);

    const views = computeViews(ctx.rows, state, params);
    const tw = targetWeights(views, params);
    const reb = applyRebalance(ctx.holdings, tw, ctx.px, params);
    ctx.holdings = reb.holdings;
    const nav = markNav(ctx.holdings, ctx.px);

    // benchmark: equal-weight every name trading today, rebalanced monthly (new listings enter then)
    const investable = ctx.rows.filter(r => r.price > 0).map(r => r.tk);
    if (ctx.bench.lastReb == null || ctx.dayIdx - ctx.bench.lastReb >= params.benchEvery) {
      const bnav = markNav(ctx.bench, ctx.px);
      const positions = {};
      investable.forEach(tk => { positions[tk] = (bnav / investable.length) / ctx.px[tk]; });
      ctx.bench = { cash: 0, positions, lastReb: ctx.dayIdx };
    }
    const benchNav = markNav(ctx.bench, ctx.px);

    const w = {}, nu = {}, pxr = {};
    const curW = currentWeights(ctx.holdings, ctx.px);
    for (const tk in curW) if (curW[tk] >= 0.0005) w[tk] = r4(curW[tk]);
    views.forEach(v => { if (v.nu != null) nu[v.tk] = r4(v.nu); });
    for (const tk in ctx.px) pxr[tk] = r2(ctx.px[tk]) || ctx.px[tk];

    const rec = { d: ctx.date, nav: r2(nav), bench: r2(benchNav),
                  cash: r4(ctx.holdings.cash / nav), gross: r4(tw.gross),
                  lambda: r4(state.lambda), w, nu, px: pxr, trades: reb.trades };
    if (learn) rec.learn = learn;
    ctx.ledger.push(rec);
    return rec;
  }

  return { DEFAULT_PARAMS, computeViews, targetWeights, markNav, currentWeights,
           applyRebalance, spearman, updateLearning, step };
});
