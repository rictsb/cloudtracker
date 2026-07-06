/* Shared data-check definitions — ONE source of truth, run by both:
   - checks.js (Node CLI, pre-push + weekly sweep)
   - the site's "Checks" tab (live in the browser, on every load)
   Deterministic/offline only; research checks live in the weekly sweep (see WIKI). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ChecksCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  const GROUPS = [
    { k: 'config',  name: 'Config integrity',       guards: 'every dial has a slider; provenance/regions complete; no dead constants' },
    { k: 'schema',  name: 'Schema & types',         guards: 'required fields per model type; valid enums; no dead fields; holdco shape' },
    { k: 'sites',   name: 'Site schedules',         guards: 'energization dates & months in range; MW > 0; phased blocks ≤ ~800MW; no duplicates' },
    { k: 'prov',    name: 'Provenance consistency', guards: 'past capacity must be disclosed; 2031+ "disclosed" questioned; contracted% vs rumored-MW tension' },
    { k: 'capital', name: 'Capital structure',      guards: 'shares/price/net-debt sanity; raise vs market cap; claims non-negative; discount bounds' },
    { k: 'basis',   name: 'Judgement discipline',   guards: 'every plannedRaise / non-Proven tier / equityDiscount / committedDebt / seniorClaims carries a sourced basis' },
    { k: 'stakes',  name: 'Stake integrity',        guards: 'stake targets tracked; pct in (0,1]; no self-stakes or cycles at any depth' },
    { k: 'fresh',   name: 'Freshness',              guards: 'thesis present & ≤3 sentences; developments log recency; filing-verification age' },
    { k: 'leases',  name: 'Lease registry',         guards: 'every leaseId resolves; signed NOI within sane bounds; effective leases map to sites; sources present; leased sites disclosed; contracted% ≈ leased share' },
    { k: 'port',    name: 'Portfolio ledger',       guards: 'NAV recomputes from holdings; dates monotonic; weights sum to 1; px-vs-fundamentals basis tripwire; ledger freshness; learning-state bounds' },
  ];

  function runChecks(d, todayISO, pf) {
    const cfg = d.config, cos = d.companies;
    const NOWY = cfg.referenceYear + ((cfg.referenceMonth || 1) - 1) / 12;
    const today = todayISO ? new Date(todayISO) : new Date();
    const groups = {}; GROUPS.forEach(g => groups[g.k] = { ...g, pass: 0, warn: 0, fail: 0, total: 0 });
    const perCo = {}; const msgs = [];
    const co = (tk) => perCo[tk] || (perCo[tk] = {});
    const cell = (tk, g) => co(tk)[g] || (co(tk)[g] = { pass: 0, warn: 0, fail: 0, msgs: [] });

    function assert(g, tk, ok, msg, level) {
      level = level || 'fail';
      const G = groups[g], C = tk ? cell(tk, g) : null;
      G.total++; if (C) { }
      if (ok) { G.pass++; if (C) C.pass++; }
      else {
        G[level]++; if (C) { C[level]++; C.msgs.push({ level, msg }); }
        msgs.push({ group: g, tk: tk || '—', level, msg });
      }
    }
    const failIf = (g, tk, bad, msg) => assert(g, tk, !bad, msg, 'fail');
    const warnIf = (g, tk, bad, msg) => assert(g, tk, !bad, msg, 'warn');
    const days = (iso) => iso ? Math.round((today - new Date(iso)) / 86400000) : null;

    /* ---- config ---- */
    const dials = ['rate','margin','multiple','capRate','disc','ramp','rateTrend','dilutionStress','leaseUp','pipelineCredit'];
    const sk = (cfg.sliders || []).map(s => s.k);
    dials.forEach(k => { failIf('config', null, !(k in cfg.dials), `config.dials missing ${k}`); failIf('config', null, !sk.includes(k), `no slider for dial ${k}`); });
    sk.forEach(k => failIf('config', null, !(k in cfg.dials), `slider ${k} has no dial`));
    ['disclosed','estimated','rumored'].forEach(p => failIf('config', null, !cfg.provenance[p], `provenance missing ${p}`));
    Object.entries(cfg.regions).forEach(([k, r]) => failIf('config', null, typeof r.rateMul !== 'number', `region ${k} missing rateMul`));
    failIf('config', null, 'contractRate' in cfg.constants, 'dead constant contractRate present');
    warnIf('config', null, !cfg.btcFallback || !cfg.ethFallback, 'btcFallback/ethFallback missing');
    const pAge = days(cfg.verifiedPricing);
    warnIf('config', null, pAge == null || pAge > 30, `GPU rate/trend dials last checked vs market ${pAge == null ? 'never' : pAge + 'd ago'} (verify ≤30d)`);

    /* ---- companies ---- */
    const tks = cos.map(c => c.tk);
    failIf('schema', null, new Set(tks).size !== tks.length, 'duplicate tickers');
    const REG = Object.keys(cfg.regions), PROV = ['disclosed','estimated','rumored'];
    const DEAD = ['renewalProb','costOfDebt','legacyExBtc','confidence','dataGaps','mtm'];
    let siteCount = 0;

    for (const c of cos) {
      const id = c.tk, holdco = c.model === 'holdco';
      for (const k of ['tk','name','model','tier','contractedPct','netDebt','shares','price','sites'])
        failIf('schema', id, c[k] === undefined, `missing ${k}`);
      failIf('schema', id, !['owner','landlord','hybrid','holdco'].includes(c.model), `bad model ${c.model}`);
      failIf('schema', id, !['proven','ig','ig-reit'].includes(c.tier), `bad tier ${c.tier}`);
      DEAD.forEach(k => failIf('schema', id, k in c, `dead field ${k}`));
      if (holdco) {
        failIf('schema', id, (c.sites || []).length > 0, 'holdco must have no sites');
        failIf('schema', id, !c.stake && !c.btc && !c.eth && !(c.legacyEV > 0), 'holdco with no stake/treasury/legacy');
      } else {
        failIf('schema', id, !(c.sites || []).length, 'operating company with no sites');
        if (c.model !== 'landlord') failIf('schema', id, !(c.termYrs > 0), 'owner/hybrid needs termYrs > 0');
      }

      failIf('capital', id, !(c.shares > 0), 'shares must be > 0');
      failIf('capital', id, !(c.price > 0), 'price must be > 0');
      failIf('capital', id, Math.abs(c.netDebt) > 60000, `netDebt ${c.netDebt} implausible`);
      failIf('capital', id, c.contractedPct < 0 || c.contractedPct > 100, 'contractedPct out of range');
      failIf('capital', id, !!c.equityDiscount && (c.equityDiscount < 0 || c.equityDiscount > 0.5), 'equityDiscount out of range');
      failIf('capital', id, (c.plannedRaise || 0) < 0, 'negative plannedRaise');
      failIf('capital', id, (c.committedDebt || 0) < 0 || (c.seniorClaims || 0) < 0, 'negative committedDebt/seniorClaims');
      warnIf('capital', id, (c.plannedRaise || 0) > c.shares * c.price * 3, `plannedRaise ${c.plannedRaise} > 3x market cap — check`);

      const bz = c.basis || {};
      failIf('basis', id, (c.plannedRaise || 0) > 0 && !bz.plannedRaise, 'plannedRaise without basis');
      failIf('basis', id, c.tier !== 'proven' && !bz.tier, 'non-Proven tier without basis');
      failIf('basis', id, (c.equityDiscount || 0) > 0 && !bz.equityDiscount, 'equityDiscount without basis');
      failIf('basis', id, (c.committedDebt || 0) > 0 && !bz.committedDebt, 'committedDebt without basis');
      failIf('basis', id, (c.seniorClaims || 0) > 0 && !bz.seniorClaims, 'seniorClaims without basis');

      if (c.stake) {
        failIf('stakes', id, !tks.includes(c.stake.tk), `stake target ${c.stake.tk} not tracked`);
        failIf('stakes', id, c.stake.tk === c.tk, 'self-stake');
        failIf('stakes', id, !(c.stake.pct > 0 && c.stake.pct <= 1), `stake pct ${c.stake.pct} out of (0,1]`);
        let cur = cos.find(x => x.tk === c.stake.tk), seen = { [c.tk]: 1 }, depth = 0, cyc = false;
        while (cur && cur.stake && depth++ < 25) { if (seen[cur.tk]) { cyc = true; break; } seen[cur.tk] = 1; cur = cos.find(x => x.tk === cur.stake.tk); }
        failIf('stakes', id, cyc, 'stake cycle in chain');
      }

      const names = {};
      for (const s of (c.sites || [])) {
        siteCount++; const sid = s.n;
        failIf('sites', id, !!names[s.n], `${sid}: duplicate site name`); names[s.n] = 1;
        failIf('sites', id, !(s.mw > 0), `${sid}: mw must be > 0`);
        warnIf('sites', id, s.mw > 800, `${sid}: ${s.mw}MW single row — decompose by rollout (max ~800)`);
        failIf('sites', id, !REG.includes(s.region), `${sid}: bad region ${s.region}`);
        failIf('sites', id, !PROV.includes(s.prov), `${sid}: bad prov ${s.prov}`);
        failIf('sites', id, typeof s.owned !== 'boolean', `${sid}: owned must be boolean`);
        failIf('sites', id, !(s.yr >= 2024 && s.yr <= 2032), `${sid}: yr ${s.yr} outside 2024-2032`);
        failIf('sites', id, !(s.mo >= 1 && s.mo <= 12), `${sid}: mo ${s.mo} invalid`);
        const t = s.yr + (s.mo - 1) / 12;
        warnIf('prov', id, t < NOWY - 0.5 && s.prov !== 'disclosed', `${sid}: energized in the past but prov=${s.prov} (past capacity should be disclosed)`);
        warnIf('prov', id, s.yr >= 2031 && s.prov === 'disclosed', `${sid}: 2031+ but disclosed — really under construction/secured?`);
      }
      const mw = (c.sites || []).reduce((a, s) => a + s.mw, 0);
      const rumMW = (c.sites || []).filter(s => s.prov === 'rumored').reduce((a, s) => a + s.mw, 0);
      warnIf('prov', id, !holdco && c.contractedPct >= 80 && rumMW / (mw || 1) > 0.5, `${c.contractedPct}% contracted but ${(rumMW / (mw || 1) * 100).toFixed(0)}% of MW rumored — consistent?`);
      warnIf('prov', id, !holdco && c.contractedPct <= 5 && (c.sites || []).every(s => s.prov === 'disclosed') && mw > 500, `~0% contracted yet all-disclosed ${mw}MW — lease-up risk carried only by contractedPct`);

      // -- lease registry (landlords)
      const LSE = c.leases || [];
      const lids = {};
      for (const l of LSE) {
        failIf('leases', id, !l.id || lids[l.id], `lease ${l.id||'?'}: missing/duplicate id`); lids[l.id] = l;
        failIf('leases', id, !(l.mw > 0), `lease ${l.id}: mw must be > 0`);
        if (l.effective !== false) {
          failIf('leases', id, !(l.noiPerMWyr >= 0.4 && l.noiPerMWyr <= 3.5), `lease ${l.id}: NOI $${l.noiPerMWyr}M/MW·yr outside sane bounds (0.4–3.5)`);
          failIf('leases', id, !(l.termYrs >= 1 && l.termYrs <= 30), `lease ${l.id}: term ${l.termYrs}yr out of range`);
        }
        warnIf('leases', id, l.kind && !['retrofit','conversion','build-to-spec'].includes(l.kind), `lease ${l.id}: unknown kind ${l.kind}`);
        warnIf('leases', id, !l.kind, `lease ${l.id}: no kind tag (retrofit / conversion / build-to-spec)`);
        failIf('leases', id, !l.counterparty || !l.source, `lease ${l.id}: counterparty/source missing`);
        if (l.effective !== false) {
          const cover = (c.sites || []).filter(x => x.leaseId === l.id);
          warnIf('leases', id, !cover.length, `lease ${l.id}: effective but mapped to no site rows`);
          const cmw = cover.reduce((a2h, x) => a2h + x.mw, 0);
          warnIf('leases', id, cover.length > 0 && Math.abs(cmw - l.mw) / l.mw > 0.25, `lease ${l.id}: site rows sum ${cmw}MW vs lease ${l.mw}MW (>25% gap)`);
        }
      }
      for (const x of (c.sites || [])) {
        if (!x.leaseId) continue;
        const l = lids[x.leaseId];
        failIf('leases', id, !l, `site ${x.n}: leaseId ${x.leaseId} not in registry`);
        if (l) warnIf('leases', id, l.effective === false, `site ${x.n}: linked lease ${x.leaseId} is not yet effective — should not be linked`);
        warnIf('leases', id, x.prov !== 'disclosed', `site ${x.n}: leased but prov=${x.prov} (signed lease ⇒ disclosed)`);
      }
      if (c.model === 'landlord' && !holdco) {
        const lmw = (c.sites || []).filter(x => x.leaseId && lids[x.leaseId] && lids[x.leaseId].effective !== false).reduce((a2h, x) => a2h + x.mw, 0);
        const tmw2 = (c.sites || []).reduce((a2h, x) => a2h + x.mw, 0);
        const derived = tmw2 ? Math.round(lmw / tmw2 * 100) : 0;
        warnIf('leases', id, Math.abs(derived - c.contractedPct) > 15, `contractedPct ${c.contractedPct} vs registry-derived leased share ${derived}% (>15pt gap)`);
      }

      warnIf('fresh', id, !c.thesis, 'no thesis');
      if (c.thesis) warnIf('fresh', id, ((c.thesis.match(/[.!?](\s|$)/g) || []).length) > 3, 'thesis over 3 sentences');
      failIf('fresh', id, !c.narrative, 'no narrative');
      warnIf('fresh', id, !(c.log || []).length, 'empty developments log');
      const v = c.verified || {};
      const aCap = days(v.capital), aCon = days(v.contracts);
      warnIf('fresh', id, aCap == null || aCap > 45, `capital structure last verified vs filings ${aCap == null ? 'never' : aCap + 'd ago'} (target ≤45d)`);
      warnIf('fresh', id, aCon == null || aCon > 45, `contracts/sites last verified ${aCon == null ? 'never' : aCon + 'd ago'} (target ≤45d)`);
    }

    /* ---- portfolio ledger (spec §6b) — only when the caller supplies the portfolio files ---- */
    if (pf && pf.portfolio && pf.history) {
      const P = pf.portfolio, H = pf.history, L = H.days || [], last = L[L.length - 1];
      const prm = P.params || {}, st = P.state || {};
      failIf('port', null, !L.length, 'ledger has no records');
      if (L.length) {
        let mono = true, weekend = false, badNav = false;
        for (let i = 0; i < L.length; i++) {
          if (i && L[i].d <= L[i - 1].d) mono = false;
          const dw = new Date(L[i].d + 'T12:00:00Z').getUTCDay();
          if (dw === 0 || dw === 6) weekend = true;
          if (!(L[i].nav > 0) || !(L[i].bench > 0) || !isFinite(L[i].nav) || !isFinite(L[i].bench)) badNav = true;
        }
        failIf('port', null, !mono, 'ledger dates not strictly increasing');
        failIf('port', null, weekend, 'ledger contains weekend records');
        failIf('port', null, badNav, 'non-finite or non-positive NAV/bench in ledger');
        const sumW = Object.values(last.w || {}).reduce((a, b) => a + b, 0);
        failIf('port', null, Math.abs(sumW + last.cash - 1) > 0.02, `last record weights+cash = ${(sumW + last.cash).toFixed(3)} ≠ 1`);
        failIf('port', null, last.cash < -0.001, `negative cash weight ${last.cash}`);
        // NAV must recompute from holdings × last prices (basis/share-count corruption tripwire)
        const remark = (book) => { let n = book.cash; for (const tk in (book.positions || {})) n += book.positions[tk] * (last.px[tk] || 0); return n; };
        if (P.holdings) failIf('port', null, Math.abs(remark(P.holdings) / last.nav - 1) > 0.01, `holdings remark ${remark(P.holdings).toFixed(2)} vs ledger NAV ${last.nav} — share counts and prices disagree`);
        if (P.bench) failIf('port', null, Math.abs(remark(P.bench) / last.bench - 1) > 0.01, `bench remark ${remark(P.bench).toFixed(2)} vs ledger ${last.bench}`);
        failIf('port', null, P.asOf !== last.d, `portfolio.json asOf ${P.asOf} ≠ last ledger day ${last.d}`);
        failIf('port', null, P.dayIdx !== L.length - 1, `dayIdx ${P.dayIdx} ≠ ledger length−1 (${L.length - 1})`);
        failIf('port', null, (H.meta || {}).backtestThrough !== P.backtestThrough, 'backtestThrough differs between ledger meta and portfolio.json');
        const age = days(last.d);
        assert('port', null, age <= 6, `ledger ${age}d stale — the daily Action has not marked in over a week`, age > 12 ? 'fail' : 'warn');
        // per-name: positions must be tracked names; prices must sit near fundamentals (basis breaks)
        for (const tk in (P.holdings || {}).positions || {}) {
          const c = cos.find(x => x.tk === tk);
          warnIf('port', c ? tk : null, !c, `${tk}: held but no longer in data.json — frozen, dispose via the proposal path`);
          if (c && last.px[tk] > 0 && c.price > 0) {
            const ratio = last.px[tk] / c.price;
            warnIf('port', tk, ratio > 1.35 || ratio < 0.75, `${tk}: ledger price ${last.px[tk]} vs data.json price ${c.price} (${ratio.toFixed(2)}×) — split/basis break, or the manual fallback price needs the weekly-sweep refresh`);
          }
        }
        for (const tk in (P.suspect || {})) warnIf('port', cos.find(x => x.tk === tk) ? tk : null, P.suspect[tk] > 0, `${tk}: suspect print quarantined ${P.suspect[tk]} day(s) — 3 fails the Action`);
        for (const tk in (P.lastFresh || {})) { const a = days(P.lastFresh[tk]); warnIf('port', cos.find(x => x.tk === tk) ? tk : null, a > 10, `${tk}: no fresh market print for ${a}d — halted/delisted?`); }
      }
      // exclusions are judgement inputs: every entry carries a one-line basis, and a held
      // exclusion is a pending sale, not a steady state
      Object.entries(P.exclude || {}).forEach(([tk, basis]) => {
        const id = cos.find(x => x.tk === tk) ? tk : null;
        failIf('port', id, !(typeof basis === 'string' && basis.trim().length > 5), 'excluded without a basis note');
        warnIf('port', id, !!((P.holdings || {}).positions || {})[tk], 'excluded but still held — sells at the next mark');
        warnIf('port', id, !!((P.bench || {}).positions || {})[tk], 'excluded but still in the benchmark — rebuilds at the next mark');
      });
      failIf('port', null, !(st.lambda >= (prm.lambdaMin || 0.3) - 1e-9 && st.lambda <= (prm.lambdaMax || 1.25) + 1e-9), `λ ${st.lambda} outside [${prm.lambdaMin}, ${prm.lambdaMax}]`);
      Object.entries(st.names || {}).forEach(([tk, ns]) => {
        failIf('port', cos.find(x => x.tk === tk) ? tk : null, !(ns.m >= (prm.mMin || 0.5) - 1e-9 && ns.m <= 1 + 1e-9), `${tk}: multiplier m ${ns.m} out of bounds`);
      });
      ['temperature','confMin','band','grossFullAt','learnEvery','lookback'].forEach(k =>
        warnIf('port', null, !(k in prm), `portfolio params missing ${k}`));
    }

    const summary = { companies: cos.length, sites: siteCount,
      checksRun: GROUPS.reduce((a, g) => a + groups[g.k].total, 0),
      fail: GROUPS.reduce((a, g) => a + groups[g.k].fail, 0),
      warn: GROUPS.reduce((a, g) => a + groups[g.k].warn, 0) };
    return { groups, groupOrder: GROUPS.map(g => g.k), perCo, msgs, summary };
  }

  return { runChecks, GROUPS };
});
