/* Shared data-check definitions — ONE source of truth, run by both:
   - checks.js (Node CLI, pre-push + weekly sweep)
   - the site's "Checks" tab (live in the browser, on every load)
   Deterministic/offline only; research checks live in the weekly sweep (see WIKI). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./ramp-core.js'), require('./catalyst-core.js'), require('./engine.js'));
  else root.ChecksCore = factory(root, null, null);
})(typeof self !== 'undefined' ? self : this, function (ramp, CatalystCoreDep, EngineDep) {

  // Date.parse normalizes impossible dates such as 2026-02-30. Compare the UTC
  // calendar representation too, so freshness cannot be manufactured by rollover.
  const isoDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) &&
    Number.isFinite(Date.parse(v + 'T00:00:00Z')) &&
    new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;
  const findingID = m => `${m.level}|${m.id || `${m.group}|${m.tk}|${m.msg}`}`;

  const GROUPS = [
    { k: 'config',  name: 'Config integrity',       guards: 'every dial has a slider; provenance/regions complete; no dead constants; source registry typed with provenance ceilings' },
    { k: 'ramp',    name: 'GPU-ramp overlay',       guards: 'chain invariants: MW/GPU sums, date order, coverage monotonicity, declared assumptions, backtest error within tolerance' },
    { k: 'pricing', name: 'Research pricing',      guards: 'shared market curve; contract expiry and provenance; renewals separated from existing commitments; cohort revenue reconciles' },
    { k: 'schema',  name: 'Schema & types',         guards: 'required fields per model type; valid enums; no dead fields; holdco shape' },
    { k: 'sites',   name: 'Site schedules',         guards: 'energization dates & months in range; MW > 0; phased blocks ≤ ~800MW; no duplicates' },
    { k: 'prov',    name: 'Provenance consistency', guards: 'past capacity must be disclosed; 2031+ "disclosed" questioned; contracted% vs rumored-MW tension' },
    { k: 'capital', name: 'Capital structure',      guards: 'shares/price/net-debt sanity; raise vs market cap; claims non-negative; discount bounds; raise registry dated/typed/sourced' },
    { k: 'basis',   name: 'Judgement discipline',   guards: 'every plannedRaise / non-Proven tier / equityDiscount / committedDebt / seniorClaims carries a sourced basis' },
    { k: 'stakes',  name: 'Stake integrity',        guards: 'stake targets tracked; pct in (0,1]; no self-stakes or cycles at any depth' },
    { k: 'fresh',   name: 'Freshness',              guards: 'thesis present & ≤3 sentences; developments log recency; filing-verification age' },
    { k: 'leases',  name: 'Lease registry',         guards: 'every leaseId resolves; signed NOI within sane bounds; effective leases map to sites; sources present; leased sites disclosed; contracted% ≈ leased share; gross contract value ≥ NOI base-term' },
    { k: 'watch',   name: 'Issue registry',         guards: 'every watch item structurally valid: known ticker, dated, non-empty assertion; lifecycle fields (status/reviewed/next) valid when present; an empty registry is valid' },
    { k: 'port',    name: 'Portfolio ledger',       guards: 'NAV recomputes from holdings; dates monotonic; weights sum to 1; px-vs-fundamentals basis tripwire; ledger freshness; learning-state bounds' },
  ];

  function runChecks(d, todayISO, pf) {
    // catalyst-core + engine: injected in node; resolved from the page at run time in the browser (any script order)
    const CatalystCore = CatalystCoreDep || (typeof globalThis !== 'undefined' && globalThis.CatalystCore) || null;
    const Engine = EngineDep || (typeof globalThis !== 'undefined' && globalThis.Engine) || null;
    const cfg = d.config, cos = d.companies;
    const NOWY = cfg.referenceYear + ((cfg.referenceMonth || 1) - 1) / 12;
    const todayDay = todayISO == null ? new Date().toISOString().slice(0, 10) : todayISO;
    if (!isoDate(todayDay)) throw new RangeError('todayISO must be a real YYYY-MM-DD calendar date');
    const today = new Date(todayDay + 'T00:00:00Z');
    const groups = {}; GROUPS.forEach(g => groups[g.k] = { ...g, pass: 0, warn: 0, fail: 0, total: 0 });
    const perCo = {}; const msgs = [];
    const co = (tk) => perCo[tk] || (perCo[tk] = {});
    const cell = (tk, g) => co(tk)[g] || (co(tk)[g] = { pass: 0, warn: 0, fail: 0, msgs: [] });

    function assert(g, tk, ok, msg, level, rule) {
      level = level || 'fail';
      const G = groups[g], C = tk ? cell(tk, g) : null;
      G.total++; if (C) { }
      if (ok) { G.pass++; if (C) C.pass++; }
      else {
        // Explicit IDs identify the rule and entity, independently of changed
        // dates, measured values or wording. Older rules retain a message fallback.
        const id = rule ? `${g}|${tk || '—'}|${rule}` : undefined;
        G[level]++; if (C) { C[level]++; C.msgs.push({ id, level, msg }); }
        msgs.push({ id, group: g, tk: tk || '—', level, msg });
      }
    }
    const failIf = (g, tk, bad, msg, rule) => assert(g, tk, !bad, msg, 'fail', rule);
    const warnIf = (g, tk, bad, msg, rule) => assert(g, tk, !bad, msg, 'warn', rule);
    // An unparseable date must read as MISSING (null), never as fresh — an invalid date
    // suppressing a staleness warning was audit probe P2 (review 2026-09-15).
    const days = iso => isoDate(iso) ? (today - new Date(iso + 'T00:00:00Z')) / 86400000 : null;
    const futureDated = v => isoDate(v) && v > todayDay;
    // Invalid-when-present is a data defect (fail); absent stays a staleness warn elsewhere.
    const badDate = (g, tk, v, what, level) => {
      if (v != null) assert(g, tk, isoDate(v), `${what}: invalid calendar date '${v}'`, level || 'fail', `${what}.date`);
      if (isoDate(v)) assert(g, tk, !futureDated(v), `${what}: inappropriately future-dated ${v}`, level || 'fail', `${what}.future`);
    };

    /* Research pricing assumptions are validated as data, not promoted to facts.
       Unknown mappings are grouped by company; contradictory inputs fail. */
    const qsPricing = q => typeof q === 'string' && /^\d{4}Q[1-4]$/.test(q) ? (+q.slice(0, 4) - 2026) * 4 + +q.slice(5) : NaN;
    const finitePositive = v => typeof v === 'number' && Number.isFinite(v) && v > 0;
    const validTerm = v => finitePositive(v) && v <= 20 && Number.isInteger(v * 4);
    const nonempty = v => typeof v === 'string' && v.trim().length > 0;
    const record = v => v && typeof v === 'object' && !Array.isArray(v);
    const market = d.researchPricing;
    const pricingCos = cos.filter(c => c.ramp && c.ramp.pricing);
    if (pricingCos.length || market != null) {
      failIf('pricing', null, !record(market), 'researchPricing: shared market policy missing', 'market.missing');
      if (record(market)) {
        failIf('pricing', null, !isoDate(market.asOf), 'researchPricing.asOf: real YYYY-MM-DD date required', 'market.asOf.date');
        failIf('pricing', null, futureDated(market.asOf), 'researchPricing.asOf: future evidence date', 'market.asOf.future');
        failIf('pricing', null, !Number.isFinite(qsPricing(market.effectiveQ)), 'researchPricing.effectiveQ: valid quarter required', 'market.effectiveQ');
        if (market.allocationCutoffQ != null) failIf('pricing', null, !Number.isFinite(qsPricing(market.allocationCutoffQ)), 'researchPricing.allocationCutoffQ: valid quarter required', 'market.allocationCutoffQ');
        failIf('pricing', null, !nonempty(market.basis), 'researchPricing: shared curve and renewal assumptions need a basis', 'market.basis');
        const sources = Array.isArray(market.sources) ? market.sources : [];
        failIf('pricing', null, !sources.length || sources.some(s => !/^https?:\/\/\S+$/.test(typeof s === 'string' ? s : (s && s.url) || '')),
          'researchPricing.sources: at least one source URL required; each source must have a URL', 'market.sources');
        sources.forEach((s, i) => {
          if (record(s) && s.asOf != null) badDate('pricing', null, s.asOf, `market.sources.${i}.asOf`);
          if (record(s) && s.date != null) badDate('pricing', null, s.date, `market.sources.${i}.date`);
        });
        failIf('pricing', null, market.softwarePremium !== 0, 'researchPricing: an unsupported software premium cannot enter the common base', 'market.softwarePremium');
        const curve = record(market.curve) ? market.curve : {};
        failIf('pricing', null, !Object.keys(curve).length, 'researchPricing.curve: empty market curve', 'market.curve.empty');
        Object.entries(curve).forEach(([year, terms]) => {
          failIf('pricing', null, !/^\d{4}$/.test(year), `researchPricing.curve: invalid year '${year}'`, `market.curve.${year}.year`);
          failIf('pricing', null, !record(terms) || !Object.keys(terms).length, `researchPricing.curve.${year}: tenor prices missing`, `market.curve.${year}.terms`);
          Object.entries(record(terms) ? terms : {}).forEach(([term, rate]) => {
            failIf('pricing', null, !validTerm(+term), `researchPricing.curve.${year}: invalid ${term}-year tenor`, `market.curve.${year}.${term}.term`);
            failIf('pricing', null, !finitePositive(rate), `researchPricing.curve.${year}.${term}: price must be finite and positive`, `market.curve.${year}.${term}.rate`);
          });
        });
        const gen = record(market.generationFactors) ? market.generationFactors : {};
        const usedGen = [...new Set(pricingCos.flatMap(c => (c.ramp.tranches || []).map(t => t.gen)))];
        usedGen.forEach(g => failIf('pricing', null, !finitePositive(gen[g]), `researchPricing: generation ${g} needs a finite positive factor`, `market.generation.${g}`));
        Object.entries(gen).forEach(([g, v]) => failIf('pricing', null, !finitePositive(v), `researchPricing: invalid factor for ${g}`, `market.generation.${g}.value`));
        const renewal = market.renewal || {};
        failIf('pricing', null, !validTerm(renewal.termYears), 'researchPricing.renewal: term must be positive, at most 20 years and in whole quarters', 'market.renewal.term');
        failIf('pricing', null, !Number.isFinite(renewal.retention) || renewal.retention < 0 || renewal.retention > 1, 'researchPricing.renewal: retention outside [0,1]', 'market.renewal.retention');
        failIf('pricing', null, renewal.rateMode !== 'retain', 'researchPricing.renewal: existing hardware must retain its own price basis; frontier repricing requires funded hardware changes', 'market.renewal.mode');
        failIf('pricing', null, !finitePositive(renewal.rateMultiplier), 'researchPricing.renewal: rate multiplier must be finite and positive', 'market.renewal.multiplier');
        if (record(market.spot)) {
          failIf('pricing', null, !['per-gpu-hour', 'per-it-mw-year'].includes(market.spot.basis), 'researchPricing.spot: explicit GPU-hour or IT-MW-year units required', 'market.spot.basis');
          const rates = record(market.spot.rates) ? market.spot.rates : {};
          failIf('pricing', null, !Object.keys(rates).length || Object.entries(rates).some(([y, v]) => !/^\d{4}$/.test(y) || !finitePositive(v)), 'researchPricing.spot: each annual realized price must be finite and positive', 'market.spot.rates');
          Object.entries(market.spot.generationMultipliers || {}).forEach(([g, v]) => failIf('pricing', null, !finitePositive(v), `researchPricing.spot: invalid generation multiplier for ${g}`, `market.spot.generation.${g}`));
        }
      }
    }

    function checkPricing(c) {
      const id = c.tk, T = c.ramp.tranches || [];
      const cfg = record(c.ramp.pricing) ? c.ramp.pricing : {};
      if (cfg.effectiveQ != null) failIf('pricing', id, !Number.isFinite(qsPricing(cfg.effectiveQ)), 'research pricing: invalid company effective quarter', 'policy.effectiveQ');
      if (cfg.allocationCutoffQ != null) failIf('pricing', id, !Number.isFinite(qsPricing(cfg.allocationCutoffQ)), 'research pricing: invalid allocation cutoff quarter', 'policy.allocationCutoffQ');
      if (cfg.softwarePremium != null) failIf('pricing', id, cfg.softwarePremium !== 0, 'research pricing: unsupported company software premium', 'policy.softwarePremium');
      let assumedMappings = 0, assumedCommitments = 0;
      T.forEach((t, i) => {
        const label = `pricing tranche '${(t.n || i).toString().slice(0, 34)}'`, rule = `tranche.${i}`, ctr = t.contract;
        const existingShare = record(ctr) && ctr.signedShare != null ? ctr.signedShare : (t.signed || 0);
        if ((t.signed || 0) > 0) failIf('pricing', id, !record(ctr), `${label}: existing book needs explicit contract metadata`, `${rule}.contract`);
        if (record(ctr)) {
          const start = qsPricing(t.rev), end = qsPricing(ctr.endQ);
          failIf('pricing', id, !validTerm(ctr.termYears), `${label}: invalid contract term`, `${rule}.term`);
          failIf('pricing', id, !Number.isFinite(end), `${label}: invalid exclusive contract end quarter`, `${rule}.endQ`);
          failIf('pricing', id, Number.isFinite(end) && Number.isFinite(start) && end <= start, `${label}: contract expires before or at first revenue`, `${rule}.expiryOrder`);
          failIf('pricing', id, !['estimated', 'disclosed'].includes(ctr.expiryBasis), `${label}: expiry provenance missing or invalid`, `${rule}.expiryBasis`);
          failIf('pricing', id, !['inferred', 'disclosed'].includes(ctr.priceBasis), `${label}: price provenance missing or invalid`, `${rule}.priceBasis`);
          failIf('pricing', id, !['assumed', 'disclosed'].includes(ctr.commitmentBasis), `${label}: customer commitment provenance missing or invalid`, `${rule}.commitmentBasis`);
          failIf('pricing', id, !nonempty(ctr.source) || !nonempty(ctr.note), `${label}: contract source and explanatory note required`, `${rule}.source`);
          if (ctr.signedShare != null) {
            const cutoff = qsPricing(cfg.allocationCutoffQ || (market && market.allocationCutoffQ));
            const allowedReclassification = ctr.signedShare === 0 && ctr.allocationBasis === 'unmapped-future' &&
              ctr.commitmentBasis === 'assumed' && Number.isFinite(cutoff) && qsPricing(t.energize) >= cutoff && nonempty(ctr.note) && nonempty(ctr.source);
            failIf('pricing', id, !Number.isFinite(ctr.signedShare) || ctr.signedShare < 0 || ctr.signedShare > t.ctr ||
              (Math.abs(ctr.signedShare - (t.signed || 0)) > 1e-9 && !allowedReclassification), `${label}: pricing signed-share override needs an explicit future-allocation policy and cannot remove disclosed commitments`, `${rule}.signedShare`);
          }
          if (ctr.asOf != null) badDate('pricing', id, ctr.asOf, `${rule}.asOf`);
          if (ctr.expiryBasis === 'estimated' && validTerm(ctr.termYears) && Number.isFinite(end) && Number.isFinite(start)) {
            failIf('pricing', id, end !== start + ctr.termYears * 4, `${label}: estimated expiry contradicts its stated term and first revenue`, `${rule}.expiryTerm`);
          }
          if (existingShare > 0 && (ctr.expiryBasis !== 'disclosed' || ctr.priceBasis !== 'disclosed')) assumedMappings++;
          if (ctr.commitmentBasis !== 'disclosed' && existingShare > 0) assumedCommitments++;
        }
        if (t.ctr > existingShare + 1e-9) failIf('pricing', id, !record(t.newBusiness), `${label}: unsigned business needs a stated contract term`, `${rule}.newBusiness`);
        if (record(t.newBusiness)) {
          failIf('pricing', id, !validTerm(t.newBusiness.termYears), `${label}: invalid new-business term`, `${rule}.newTerm`);
          failIf('pricing', id, t.newBusiness.priceBasis !== 'assumed', `${label}: future market prices must be labelled assumed`, `${rule}.newPriceBasis`);
        }
      });
      warnIf('pricing', id, assumedMappings > 0, `${assumedMappings} contract cohorts use estimated expiries or inferred prices; grouped research mapping remains open`, 'mapping.assumptions');
      warnIf('pricing', id, assumedCommitments > 0, `${assumedCommitments} existing-book cohorts have assumed customer commitments; power access alone does not establish signed revenue`, 'commitment.assumptions');
    }

    /* ---- config ---- */
    const dials = ['rate','margin','multiple','capRate','disc','ramp','rateTrend','gpuTrend','dilutionStress','leaseUp','pipelineCredit'];
    const sk = (cfg.sliders || []).map(s => s.k);
    dials.forEach(k => { failIf('config', null, !(k in cfg.dials), `config.dials missing ${k}`); failIf('config', null, !sk.includes(k), `no slider for dial ${k}`); });
    sk.forEach(k => failIf('config', null, !(k in cfg.dials), `slider ${k} has no dial`));
    ['disclosed','estimated','rumored'].forEach(p => failIf('config', null, !cfg.provenance[p], `provenance missing ${p}`));
    Object.entries(cfg.regions).forEach(([k, r]) => failIf('config', null, typeof r.rateMul !== 'number', `region ${k} missing rateMul`));
    failIf('config', null, 'contractRate' in cfg.constants, 'dead constant contractRate present');
    warnIf('config', null, !cfg.btcFallback || !cfg.ethFallback, 'btcFallback/ethFallback missing');
    badDate('config', null, cfg.verifiedPricing, 'config.verifiedPricing');
    const pAge = days(cfg.verifiedPricing);
    warnIf('config', null, pAge == null || pAge > 30, `GPU rate/trend dials last checked vs market ${pAge == null ? 'never' : pAge + 'd ago'} (verify ≤30d)`, 'verifiedPricing.stale');

    /* ---- preferred-source registry (spec §9) ---- */
    const SRC_T = ['market','filings','research','commentary','calendar'];
    const SRC_P = ['disclosed','estimated','rumored','none'];
    const srcs = d.sources || [];
    failIf('config', null, !srcs.length, 'preferred-source registry (sources[]) missing or empty');
    const srcIds = {};
    for (const s of srcs) {
      failIf('config', null, !s.id || srcIds[s.id], `source ${s.id || '?'}: missing/duplicate id`); srcIds[s.id] = 1;
      failIf('config', null, !s.name || !s.note, `source ${s.id}: name/note missing`);
      failIf('config', null, !SRC_T.includes(s.type), `source ${s.id}: bad type ${s.type}`);
      failIf('config', null, !SRC_P.includes(s.provCeiling), `source ${s.id}: bad provCeiling ${s.provCeiling}`);
      warnIf('config', null, s.type === 'commentary' && s.provCeiling === 'disclosed', `source ${s.id}: commentary cannot carry a disclosed ceiling`);
    }

    /* ---- outlook (forward book — judgement, weekly refresh) ---- */
    const OL = d.outlook;
    warnIf('fresh', null, !OL, 'no outlook object — the weekly sweep generates the forward book');
    if (OL) {
      badDate('fresh', null, OL.asOf, 'outlook.asOf');
      const oAge = days(OL.asOf);
      warnIf('fresh', null, oAge == null || oAge > 8, `outlook stale — asOf ${OL.asOf || 'missing'} (${oAge == null ? '?' : oAge + 'd'}; weekly cadence)`, 'outlook.stale');
      const ctks = (d.companies || []).map(c => c.tk);
      (OL.leases || []).forEach(r => {
        failIf('fresh', r.tk, !ctks.includes(r.tk), `outlook lease row: unknown ticker ${r.tk}`);
        failIf('fresh', r.tk, !(r.prob >= 0 && r.prob <= 100), `outlook ${r.tk}: P(lease) ${r.prob} out of 0-100`);
        warnIf('fresh', r.tk, !(r.drivers || []).length, `outlook ${r.tk}: lease row with no evidence drivers`);
      });
      (OL.earnings || []).forEach(r => {
        failIf('fresh', r.tk, !ctks.includes(r.tk), `outlook earnings row: unknown ticker ${r.tk}`);
        failIf('fresh', r.tk, !(r.score >= -5 && r.score <= 5), `outlook ${r.tk}: surprise score ${r.score} out of -5..5`);
        failIf('fresh', r.tk, r.date != null && !isoDate(r.date), `outlook ${r.tk}: invalid earnings date ${r.date}`, 'outlook.earnings.date');
      });
      // Catalyst board (spec §6 screen 8): structure via catalyst-core, and every impact must APPLY and PRICE —
      // the board never renders a broken op. Names with no row at all are a coverage gap for the sweep.
      const cats = OL.catalysts || [];
      failIf('fresh', null, !!cats.length && !(CatalystCore && Engine), 'catalyst-core.js / engine.js not loaded — catalyst impacts cannot be verified');
      warnIf('fresh', null, !cats.length, 'outlook.catalysts empty — the catalyst board has nothing to rank');
      const ids = cats.map(r => r.id);
      failIf('fresh', null, new Set(ids).size !== ids.length, 'outlook.catalysts: duplicate ids');
      cats.forEach(r => {
        const errs = CatalystCore ? CatalystCore.validate(r, d) : [];
        errs.forEach(e => failIf('fresh', r.tk, true, `catalyst ${r.id || '?'}: ${e}`));
        if (!errs.length && r.impact != null && CatalystCore && Engine) {
          let imp; try { imp = CatalystCore.impactOf(Engine, d, r); } catch (e) { imp = { error: e && e.message ? e.message : 'threw' }; }
          failIf('fresh', r.tk, !!imp.error, `catalyst ${r.id}: impact does not price — ${imp.error}`);
          if (!imp.error) {
            failIf('fresh', r.tk, !Number.isFinite(imp.target1), `catalyst ${r.id}: non-finite target after impact`);
            warnIf('fresh', r.tk, Math.abs(imp.delta) < 1e-9 && Math.abs(imp.dfloor) < 1e-9, `catalyst ${r.id}: impact prices to zero effect on target and floor — describe it better or set impact null`);
            warnIf('fresh', r.tk, Math.abs(imp.pct) > 1.5, `catalyst ${r.id}: impact moves the target ${(imp.pct * 100).toFixed(0)}% — re-check the op`);
          }
        }
        warnIf('fresh', r.tk, r.by && isoDate(r.by) && days(r.by) != null && days(r.by) > 0, `catalyst ${r.id}: hard date ${r.by} has passed — resolve or re-date`);
        (r.drivers || []).forEach(dr => warnIf('fresh', r.tk, !/\[[a-z0-9-]+\]\s*$/.test(String(dr)), `catalyst ${r.id}: driver without a trailing [source] tag`));
      });
      if (cats.length) ctks.forEach(tk => warnIf('fresh', tk, !cats.some(r => r.tk === tk), `no catalyst rows for ${tk} — coverage gap on the board`));
    }

    /* ---- companies ---- */
    const tks = cos.map(c => c.tk);
    failIf('schema', null, new Set(tks).size !== tks.length, 'duplicate tickers');
    const REG = Object.keys(cfg.regions), PROV = ['disclosed','estimated','rumored'];
    const RAMP_GENS = ['hopper','blackwell','rubin','next'];
    const DEAD = ['renewalProb','costOfDebt','legacyExBtc','confidence','dataGaps','mtm'];
    const RZ_KINDS = ['equity','atm','convert','debt','pref','other'];
    const LEDGER_START = (pf && pf.history && pf.history.meta && pf.history.meta.start) || '2025-06-26';
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

      /* ---- GPU-ramp overlay (spec §6 screen 11): display-only, but its chain must hold ---- */
      if (c.ramp) {
        const R = c.ramp, T = R.tranches || [];
        if (R.pricing) checkPricing(c);
        const qs = l => /^\d{4}Q[1-4]$/.test(l || '') ? (parseInt(l.slice(0, 4)) - 2026) * 4 + parseInt(l.slice(5)) : NaN;
        failIf('ramp', id, !T.length, 'ramp present but no tranches');
        failIf('ramp', id, !R.basis || R.basis.length < 40, 'ramp: basis note missing or too short to carry provenance');
        failIf('ramp', id, !Array.isArray(R.chain) || !R.chain.length, 'ramp: no declared chain — every link must state its transfer function, assumption and range');
        (R.chain || []).forEach(l => {
          failIf('ramp', id, !l.fn || !l.assumption, `ramp chain '${l.id || '?'}': link without a transfer function or assumption`);
          failIf('ramp', id, !l.range, `ramp chain '${l.id || '?'}': assumption without a stated range (unmarked assumption)`);
        });
        let gross = 0, itmw = 0, gpus = 0;
        T.forEach(t => {
          const tid = `ramp tranche '${(t.n || '?').slice(0, 34)}'`;
          gross += t.grossMW || 0; itmw += t.itMW || 0; gpus += t.gpus || 0;
          failIf('ramp', id, !(t.grossMW > 0 && t.itMW > 0 && t.gpus > 0), `${tid}: grossMW/itMW/gpus must all be > 0`);
          failIf('ramp', id, t.itMW > t.grossMW, `${tid}: critical IT MW exceeds gross MW`);
          failIf('ramp', id, isNaN(qs(t.energize)) || isNaN(qs(t.rev)), `${tid}: energize/rev must be YYYYQn`);
          failIf('ramp', id, qs(t.energize) > qs(t.rev), `${tid}: first revenue precedes energisation`);
          failIf('ramp', id, !(t.rampQtrs >= 1), `${tid}: rampQtrs must be >= 1`);
          failIf('ramp', id, !(t.ctr >= 0 && t.ctr <= 1), `${tid}: contracted share out of [0,1]`);
          failIf('ramp', id, !((t.signed || 0) >= 0 && (t.signed || 0) <= t.ctr + 1e-9), `${tid}: signed-today exceeds contracted share`);
          failIf('ramp', id, !(t.rate > 0), `${tid}: rate must be > 0`);
          failIf('ramp', id, !RAMP_GENS.includes(t.gen), `${tid}: unknown generation ${t.gen}`);
          const kw = t.itMW * 1000 / t.gpus;
          warnIf('ramp', id, kw < 1.0 || kw > 8.0, `${tid}: implied ${kw.toFixed(2)} kW/GPU outside the defensible 1.0-8.0 band`);
        });
        const camp = {}; T.forEach(t => { camp[t.campus] = (camp[t.campus] || 0) + t.grossMW; });
        failIf('ramp', id, Math.abs(gross - Object.values(camp).reduce((a, b) => a + b, 0)) > 0.5, 'ramp: campus MW do not sum to tranche MW');
        warnIf('ramp', id, gross > (c.sites || []).reduce((a, s2) => a + s2.mw, 0),
          `ramp: modelled ${gross}MW exceeds secured ${(c.sites || []).reduce((a, s2) => a + s2.mw, 0)}MW`);
        // Cross-view schedule reconciliation (audit probe P3): where a research tranche names a
        // site row, the two schedules must agree within a year — commissioning lag between the
        // site's power date and GPU energize is normal (~1-2q); a multi-year gap is a contradiction
        // that needs reconciling or an explicit basis.
        T.forEach(t => {
          (c.sites || []).filter(s2 => t.n && s2.n.includes(t.n)).forEach(s2 => {
            const em = String(t.energize || '').match(/^(\d{4})Q([1-4])$/); if (!em) return;
            const siteQ = s2.yr * 4 + Math.ceil((s2.mo || 1) / 3), dq = siteQ - (+em[1] * 4 + +em[2]);
            warnIf('ramp', id, Math.abs(dq) > 4, `tranche '${t.n}': research energize ${t.energize} vs site schedule ${s2.yr}-${String(s2.mo || 1).padStart(2, '0')} (${dq > 0 ? '+' : ''}${dq}q apart) — reconcile the schedules or state a basis for the difference`);
          });
        });
        // backtest must exist and be within tolerance — a model that cannot retrodict has no business forecasting
        const A = R.actuals || {};
        failIf('ramp', id, !Object.keys(A).length, 'ramp: no reported actuals — the chain is untested');
        failIf('ramp', id, !R.calibration || !R.calibration.basis, 'ramp: no calibration note for the backtest');
        Object.entries(A).forEach(([q, a]) => {
          failIf('ramp', id, isNaN(qs(q)), `ramp actual '${q}': not a valid quarter`);
          failIf('ramp', id, !(a.aiRevM > 0), `ramp actual '${q}': aiRevM must be > 0`);
        });
        failIf('ramp', id, !Array.isArray(R.scenarios) || R.scenarios.length < 3, 'ramp: fewer than three scenarios — no sensitivity envelope');
        failIf('ramp', id, !(R.scenarios || []).some(x => x.id === 'joint'), 'ramp: no joint-downside scenario — the bear case must be on the page');
        failIf('ramp', id, !(R.calibration && R.calibration.rampMult > 0), 'ramp: calibration.rampMult missing or not positive');
        failIf('ramp', id, !R.spot || !R.spotMult || !R.consensus, 'ramp: spot / spotMult / consensus missing — revenue and comparison cannot be derived');
        failIf('ramp', id, !(R.earningRate > 0), 'ramp: earningRate missing — reported revenue cannot be converted to an earning-GPU-equivalent');
        RAMP_GENS.forEach(g => failIf('ramp', id, T.some(t => t.gen === g) && !(R.spotMult[g] > 0), `ramp: generation ${g} used but has no spotMult`));
        /* Historical calibration remains independent of the forward pricing policy.
           Cohort forecasts use the shared engine, so checks cannot silently test a
           different renewal/expiry model from the published report. */
        (function rampGate() {
          const cal = R.calibration.rampMult, A2 = R.actuals || {};
          const yr = q => 2026 + Math.floor((q - 1) / 4);
          const ff = (k, n) => Math.min(Math.max(k / n, 0), 1);
          const legacyRevAt = (q, d) => {
            d = d || {}; let rev = 0, gpus = 0, itmw = 0;
            for (const t of T) {
              const rm = d.rampMult || 1, c2 = d.cal != null ? d.cal : cal;
              const slip = (d.slipQtrs && qs(t.energize) >= (d.from != null ? d.from : -99)) ? d.slipQtrs : 0;
              const rs = qs(t.rev) + slip;
              const ctr = d.ctrMult != null ? (t.signed || 0) + (t.ctr - (t.signed || 0)) * d.ctrMult : t.ctr;
              const gp = t.gpus * ((d.genDensity && d.genDensity[t.gen]) || 1);
              const nC = Math.max(1, Math.ceil(t.rampQtrs * rm)), nU = Math.max(1, Math.ceil(t.rampQtrs * rm * c2));
              const f = ctr * ff(q - rs + 1, nC) + (1 - ctr) * ff(q - rs + 1, nU);
              if (f <= 0) continue;
              const spot = (R.spot[String(d.spotFlat ? 2026 : yr(q))] || 0) * (d.spotMult || 1);
              let rate = d.rateCap != null ? Math.min(t.rate, d.rateCap) : t.rate * (d.rateMult || 1);
              if (d.vintageDecay) rate *= Math.pow(1 - d.vintageDecay, Math.max(0, (q - rs) / 4));
              if (d.vintageMult && d.vintageMult[t.energize.slice(0, 4)] != null) rate *= d.vintageMult[t.energize.slice(0, 4)];
              if (d.genRateCap && d.genRateCap[t.gen] != null && !(t.signed >= 1)) rate = Math.min(rate, d.genRateCap[t.gen]);
              rev += gp * f * (ctr * rate + (1 - ctr) * spot * (R.spotMult[t.gen] || 1)) * 2190 / 1e6;
              gpus += gp * f; itmw += t.itMW * f;
            }
            return { rev, gpus, itmw };
          };
          let runtimeFailed = false;
          const canonicalRows = (sc, from, to) => {
            try {
              if (!ramp || typeof ramp.rampQuarters !== 'function') throw new Error('shared ramp engine unavailable');
              return ramp.rampQuarters(R, sc, from, to, market);
            } catch (e) {
              if (!runtimeFailed) failIf('pricing', id, true, `research pricing cannot run: ${e.message}`, 'runtime');
              runtimeFailed = true;
              return [];
            }
          };
          const revAt = (q, d) => {
            if (!R.pricing) return legacyRevAt(q, d);
            const row = canonicalRows({ d: d || {} }, q, q)[0];
            return row ? { rev: row.rev, gpus: row.cum, itmw: row.itMW } : legacyRevAt(q, d);
          };
          const errs = Object.entries(A2).map(([q, a]) => Math.abs(legacyRevAt(qs(q)).rev / a.aiRevM - 1));
          const mape = errs.reduce((x, y) => x + y, 0) / (errs.length || 1);
          failIf('ramp', id, !(mape <= 0.25), `ramp backtest: mean absolute error ${(mape * 100).toFixed(1)}% exceeds the 25% tolerance — the chain does not reproduce reported quarters`);
          warnIf('ramp', id, mape > 0.15, `ramp backtest: mean absolute error ${(mape * 100).toFixed(1)}% above the 15% target`);
          // critical IT MW and GPUs must ramp on the SAME fraction, or the two published columns divide to a false density
          const last = revAt(20), kw = last.itmw * 1000 / last.gpus;
          const nameplateKw = T.reduce((x, t) => x + t.itMW, 0) * 1000 / T.reduce((x, t) => x + t.gpus, 0);
          failIf('ramp', id, Math.abs(kw / nameplateKw - 1) > 0.08,
            `ramp: terminal IT-MW/GPU ratio ${kw.toFixed(2)} kW diverges >8% from the nameplate ${nameplateKw.toFixed(2)} kW — the two columns are on different ramps`);
          if (R.pricing) {
            const rows = canonicalRows({ d: {} }, 3, 20);
            const close = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= Math.max(1, Math.abs(a), Math.abs(b)) * 1e-8;
            rows.filter(q => q.s >= qsPricing(market && market.effectiveQ)).forEach(q => {
              const n = q.lbl || q.s, key = `quarter.${n}`;
              const values = ['rev', 'revC', 'revS', 'revExisting', 'revExistingConfirmed', 'revExistingAssumed', 'revRenewal', 'revNew', 'revSpot', 'arrContracted', 'arrExisting', 'arrRenewal', 'arrNew', 'itMW', 'itContracted', 'itSpot'];
              failIf('pricing', id, values.some(k => !Number.isFinite(q[k]) || q[k] < -1e-8), `pricing ${n}: non-finite or negative cohort amount`, `${key}.amounts`);
              failIf('pricing', id, !close(q.revExisting, q.revExistingConfirmed + q.revExistingAssumed), `pricing ${n}: original commitment evidence groups do not reconcile`, `${key}.existing`);
              failIf('pricing', id, !close(q.revC, q.revExisting + q.revRenewal + q.revNew) || !close(q.rev, q.revC + q.revSpot), `pricing ${n}: cohort revenues do not reconcile`, `${key}.revenue`);
              failIf('pricing', id, !close(q.revS, q.revExistingConfirmed) || q.revS > q.revC + 1e-8, `pricing ${n}: signed revenue includes assumed commitments or renewals`, `${key}.signed`);
              failIf('pricing', id, !close(q.arrContracted, q.arrExisting + q.arrRenewal + q.arrNew), `pricing ${n}: contracted ARR cohorts do not reconcile`, `${key}.arr`);
              failIf('pricing', id, !close(q.itMW, q.itContracted + q.itSpot), `pricing ${n}: contractual and spot earning MW do not reconcile`, `${key}.mw`);
            });
            // Term and renewal sensitivities may change earlier cash receipts while
            // reaching the same endpoint. Test the whole path, not one last cell.
            const outs = (R.scenarios || []).map(sc => ({ id: sc.id, rows: canonicalRows(sc, 3, 20) }));
            outs.forEach(o => {
              if (o.id !== 'base' && !runtimeFailed) failIf('ramp', id, !o.rows.some((q, i) => rows[i] && !close(q.rev, rows[i].rev)), `ramp scenario '${o.id}': changes no quarterly revenue — it is not a sensitivity`, `scenario.${o.id}.noEffect`);
            });
            const total = a => a.reduce((sum, q) => sum + q.rev, 0);
            const joint = outs.find(o => o.id === 'joint');
            const singles = outs.filter(o => !['base', 'joint', 'uncal', 'denselow'].includes(o.id));
            if (joint && singles.length && !runtimeFailed) failIf('ramp', id, total(joint.rows) > Math.min(...singles.map(o => total(o.rows))) + 1e-6, 'ramp: joint downside does not reduce cumulative revenue at least as much as the worst single case', 'scenario.joint.order');
          } else {
            const base = revAt(20).rev;
            const outs = (R.scenarios || []).map(sc => ({ id: sc.id, rev: revAt(20, sc.d || {}).rev }));
            outs.forEach(o => { if (o.id !== 'base') failIf('ramp', id, Math.abs(o.rev / base - 1) < 0.001, `ramp scenario '${o.id}': changes nothing — it is not a sensitivity`); });
            const joint = outs.find(o => o.id === 'joint');
            const worstSingle = Math.min(...outs.filter(o => !['base', 'joint', 'uncal', 'denselow'].includes(o.id)).map(o => o.rev));
            if (joint) failIf('ramp', id, joint.rev > worstSingle + 1e-6, 'ramp: the joint downside is not worse than the worst single scenario — it is not a joint case');
          }
        })();
      }
      failIf('capital', id, !(c.shares > 0), 'shares must be > 0');
      failIf('capital', id, !(c.price > 0), 'price must be > 0');
      warnIf('capital', id, !(c.sharesReported > 0), 'no sharesReported (basic shares for the Coverage market cap)');
      warnIf('capital', id, c.sharesReported > 0 && c.sharesReported > c.shares * 1.05, `sharesReported ${c.sharesReported} > FD shares ${c.shares} (basic should be ≤ fully-diluted)`);
      failIf('capital', id, Math.abs(c.netDebt) > 60000, `netDebt ${c.netDebt} implausible`);
      failIf('capital', id, c.contractedPct < 0 || c.contractedPct > 100, 'contractedPct out of range');
      failIf('capital', id, !!c.equityDiscount && (c.equityDiscount < 0 || c.equityDiscount > 0.5), 'equityDiscount out of range');
      failIf('capital', id, (c.plannedRaise || 0) < 0, 'negative plannedRaise');
      failIf('capital', id, (c.committedDebt || 0) < 0 || (c.seniorClaims || 0) < 0, 'negative committedDebt/seniorClaims');
      warnIf('capital', id, (c.plannedRaise || 0) > c.shares * c.price * 3, `plannedRaise ${c.plannedRaise} > 3x market cap — check`);

      /* capital-raise registry (spec §6c) — dated facts, display-only; returns derive from the ledger */
      const rseen = {};
      for (const r of (c.raises || [])) {
        const rid = `raise ${r.d || '?'}/${r.kind || '?'}`;
        failIf('capital', id, !isoDate(r.d), `${rid}: d must be a real ISO YYYY-MM-DD date`, `${rid}.date`);
        failIf('capital', id, futureDated(r.d), `${rid}: announcement date in the future`, `${rid}.future`);
        failIf('capital', id, !RZ_KINDS.includes(r.kind), `${rid}: bad kind`);
        failIf('capital', id, !(typeof r.source === 'string' && r.source.trim().length > 3), `${rid}: source missing`);
        failIf('capital', id, !(r.sizeM === null || r.sizeM > 0), `${rid}: sizeM must be > 0 or null (undisclosed)`);
        failIf('capital', id, r.ah !== undefined && typeof r.ah !== 'boolean', `${rid}: ah must be boolean`);
        warnIf('capital', id, !!r.d && r.d < LEDGER_START, `${rid}: predates the ledger (${LEDGER_START}) — no returns derivable`);
        warnIf('capital', id, !!rseen[r.d + '|' + r.kind], `${rid}: duplicate date+kind`); rseen[r.d + '|' + r.kind] = 1;
        warnIf('capital', id, (r.kind === 'equity' || r.kind === 'atm') && r.sizeM > c.shares * c.price, `${rid}: sizeM $${r.sizeM}M exceeds market cap — check units`);
      }

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
        siteCount++; const sid = s.n, key = `site:${s.id || sid}`;
        failIf('sites', id, !!names[s.n], `${sid}: duplicate site name`, `${key}.duplicate`); names[s.n] = 1;
        failIf('sites', id, !(Number.isFinite(s.mw) && s.mw > 0), `${sid}: mw must be a finite number > 0`, `${key}.mw`);
        warnIf('sites', id, s.mw > 800, `${sid}: ${s.mw}MW single row — decompose by rollout (max ~800)`, `${key}.size`);
        failIf('sites', id, !REG.includes(s.region), `${sid}: bad region ${s.region}`, `${key}.region`);
        failIf('sites', id, !PROV.includes(s.prov), `${sid}: bad prov ${s.prov}`, `${key}.provenance`);
        failIf('sites', id, typeof s.owned !== 'boolean', `${sid}: owned must be boolean`, `${key}.owned`);
        failIf('sites', id, !(Number.isInteger(s.yr) && s.yr >= 2024 && s.yr <= 2032), `${sid}: yr ${s.yr} outside integer years 2024-2032`, `${key}.year`);
        failIf('sites', id, !(Number.isInteger(s.mo) && s.mo >= 1 && s.mo <= 12), `${sid}: mo ${s.mo} invalid`, `${key}.month`);
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
          // grossTotalM = headline gross contract value (Coverage tab); must exist and exceed the NOI base-term (gross ≥ net)
          warnIf('leases', id, l.grossTotalM == null, `lease ${l.id}: no grossTotalM (gross headline value the Coverage tab needs)`);
          if (l.grossTotalM != null) {
            failIf('leases', id, !(l.grossTotalM > 0), `lease ${l.id}: grossTotalM must be > 0`);
            warnIf('leases', id, l.grossTotalM < l.noiPerMWyr * l.mw * l.termYrs * 0.98, `lease ${l.id}: grossTotalM $${l.grossTotalM}M below NOI base-term $${(l.noiPerMWyr*l.mw*l.termYrs).toFixed(0)}M (gross should exceed net)`);
          }
        }
        warnIf('leases', id, l.kind && !['retrofit','conversion','build-to-spec'].includes(l.kind), `lease ${l.id}: unknown kind ${l.kind}`);
        warnIf('leases', id, !l.kind, `lease ${l.id}: no kind tag (retrofit / conversion / build-to-spec)`);
        failIf('leases', id, !l.counterparty || !l.source, `lease ${l.id}: counterparty/source missing`);
        // Source provenance ceiling (audit probe P4): a [source-id]-tagged source cannot support
        // site provenance above its registry ceiling — commentary cannot make a lease 'disclosed'.
        const srcTag = String(l.source || '').match(/^\[([\w-]+)\]/);
        if (srcTag) {
          const reg = srcs.find(s2 => s2.id === srcTag[1]);
          warnIf('leases', id, !reg, `lease ${l.id}: source tag [${srcTag[1]}] not in the sources registry`);
          if (reg) {
            const RANK = { disclosed: 3, estimated: 2, rumored: 1, none: 0 };
            const maxProv = Math.max(0, ...(c.sites || []).filter(x => x.leaseId === l.id).map(x => RANK[x.prov] || 0));
            failIf('leases', id, (RANK[reg.provCeiling] || 0) < maxProv, `lease ${l.id}: source [${reg.id}] ceiling '${reg.provCeiling}' cannot support '${Object.keys(RANK).find(k => RANK[k] === maxProv)}' site provenance — corroborate or downgrade`);
          }
        }
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

      // -- owner compute-contract registry
      const OC = c.contracts || [];
      const ocids = {};
      for (const x of OC) {
        failIf('leases', id, !x.id || ocids[x.id], `contract ${x.id||'?'}: missing/duplicate id`); ocids[x.id] = 1;
        failIf('leases', id, !(x.totalRevM > 0), `contract ${x.id}: totalRevM must be > 0`);
        failIf('leases', id, !(x.termYrs >= 1 && x.termYrs <= 20), `contract ${x.id}: term ${x.termYrs}yr out of range`);
        failIf('leases', id, !x.counterparty || !x.source, `contract ${x.id}: counterparty/source missing`);
        warnIf('leases', id, !['hopper','blackwell','vera-rubin','mixed','tpu'].includes(x.gen), `contract ${x.id}: unknown gen ${x.gen}`);
        if (x.ratePerMWyr != null) failIf('leases', id, !(x.ratePerMWyr >= 3 && x.ratePerMWyr <= 20), `contract ${x.id}: rate $${x.ratePerMWyr}M/MW·yr outside sane bounds (3–20)`);
      }
      if (c.signedRate != null) {
        failIf('leases', id, !(c.signedRate >= 3 && c.signedRate <= 20), `signedRate $${c.signedRate}M/MW·yr outside sane bounds`);
        failIf('basis', id, !bz.signedRate, 'signedRate without basis');
        // reconcile vs registry where per-contract rates are computable
        const rc = OC.filter(x => x.effective !== false && x.ratePerMWyr && x.totalRevM);
        if (rc.length) {
          const w = rc.reduce((a3, x) => a3 + x.ratePerMWyr * x.totalRevM, 0) / rc.reduce((a3, x) => a3 + x.totalRevM, 0);
          warnIf('leases', id, Math.abs(w - c.signedRate) / w > 0.2, `signedRate $${c.signedRate}M vs registry $-weighted $${w.toFixed(2)}M (>20% gap)`);
        }
      }
      if (c.genAccess != null) {
        failIf('leases', id, !(c.genAccess >= 0.5 && c.genAccess <= 1.2), `genAccess ${c.genAccess} out of range`);
        failIf('basis', id, c.genAccess !== 1 && !bz.genAccess, 'non-default genAccess without basis');
      }
      warnIf('leases', id, OC.length > 0 && c.signedRate == null, 'contracts[] present but no signedRate derived');

      warnIf('fresh', id, !c.thesis, 'no thesis');
      if (c.thesis) warnIf('fresh', id, ((c.thesis.match(/[.!?](\s|$)/g) || []).length) > 3, 'thesis over 3 sentences');
      failIf('fresh', id, !c.narrative, 'no narrative');
      warnIf('fresh', id, !(c.log || []).length, 'empty developments log');
      const v = c.verified || {};
      badDate('fresh', id, v.capital, 'verified.capital'); badDate('fresh', id, v.contracts, 'verified.contracts');
      (c.log || []).forEach(l => badDate('fresh', id, l.d, `log entry '${String(l.x || '').slice(0, 30)}'`));
      // Field-specific freshness (audit probe P1): historical entries never go stale, but a
      // covered name whose NEWEST development entry is old needs a research pass.
      const newest = (c.log || []).map(l => l.d).filter(isoDate).sort().reverse()[0];
      if (newest) warnIf('fresh', id, days(newest) > 60, `developments log stale — newest entry ${days(newest)}d old (research pass due)`, 'log.stale');
      const aCap = days(v.capital), aCon = days(v.contracts);
      warnIf('fresh', id, aCap == null || aCap > 45, `capital structure last verified vs filings ${aCap == null ? 'never' : aCap + 'd ago'} (target ≤45d)`, 'verified.capital.stale');
      warnIf('fresh', id, aCon == null || aCon > 45, `contracts/sites last verified ${aCon == null ? 'never' : aCon + 'd ago'} (target ≤45d)`, 'verified.contracts.stale');
    }

    /* ---- issue registry (watchItems) — structural validity, never a fixed count (probe P5).
       Open issues only live here; resolution removes the record with a CHANGELOG line. ---- */
    {
      const tks2 = (d.companies || []).map(c => c.tk);
      const wids = new Set();
      (d.watchItems || []).forEach((w, i) => {
        const wid = w.id || w.tk || ('#' + i);
        failIf('watch', w.tk, !w.tk || !tks2.includes(w.tk), `watch ${wid}: unknown or missing ticker '${w.tk}'`, `watch:${wid}.ticker`);
        failIf('watch', w.tk, !String(w.note || '').trim(), `watch ${wid}: empty assertion`, `watch:${wid}.assertion`);
        badDate('watch', w.tk, w.added, `watch ${wid} added`);
        failIf('watch', w.tk, !w.added, `watch ${wid}: no added date`, `watch:${wid}.added.missing`);
        if (w.id) { failIf('watch', w.tk, wids.has(w.id), `watch ${w.id}: duplicate id`, `watch:${wid}.duplicate`); wids.add(w.id); }
        if (w.status != null) failIf('watch', w.tk, !['investigating', 'monitoring', 'owner'].includes(w.status), `watch ${wid}: bad status '${w.status}'`, `watch:${wid}.status`);
        if (w.reviewed != null) badDate('watch', w.tk, w.reviewed, `watch ${wid} reviewed`);
        if (w.status != null) warnIf('watch', w.tk, !w.next, `watch ${wid}: structured issue without a next-check trigger`, `watch:${wid}.next`);
      });
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
        failIf('port', null, L.some(day => !isoDate(day.d)), 'ledger contains invalid calendar dates', 'ledger.date');
        failIf('port', null, L.some(day => futureDated(day.d)), 'ledger contains future observations', 'ledger.future');
        badDate('port', null, P.asOf, 'portfolio.asOf');
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
        assert('port', null, age != null && age <= 6, `ledger ${age == null ? '?' : age}d stale — the daily Action has not marked in over a week`, age == null || age > 12 ? 'fail' : 'warn', 'ledger.stale');
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

  return { runChecks, GROUPS, isoDate, findingID };
});
