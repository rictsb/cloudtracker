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
  ];

  function runChecks(d, todayISO) {
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
    const DEAD = ['renewalProb','costOfDebt','legacyExBtc','confidence','dataGaps'];
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
        else failIf('schema', id, !(c.mtm > 0 && c.mtm <= 1.3), 'landlord mtm out of range');
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

      warnIf('fresh', id, !c.thesis, 'no thesis');
      if (c.thesis) warnIf('fresh', id, ((c.thesis.match(/[.!?](\s|$)/g) || []).length) > 3, 'thesis over 3 sentences');
      failIf('fresh', id, !c.narrative, 'no narrative');
      warnIf('fresh', id, !(c.log || []).length, 'empty developments log');
      const v = c.verified || {};
      const aCap = days(v.capital), aCon = days(v.contracts);
      warnIf('fresh', id, aCap == null || aCap > 45, `capital structure last verified vs filings ${aCap == null ? 'never' : aCap + 'd ago'} (target ≤45d)`);
      warnIf('fresh', id, aCon == null || aCon > 45, `contracts/sites last verified ${aCon == null ? 'never' : aCon + 'd ago'} (target ≤45d)`);
    }

    const summary = { companies: cos.length, sites: siteCount,
      checksRun: GROUPS.reduce((a, g) => a + groups[g.k].total, 0),
      fail: GROUPS.reduce((a, g) => a + groups[g.k].fail, 0),
      warn: GROUPS.reduce((a, g) => a + groups[g.k].warn, 0) };
    return { groups, groupOrder: GROUPS.map(g => g.k), perCo, msgs, summary };
  }

  return { runChecks, GROUPS };
});
