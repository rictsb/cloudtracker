/* Presentation adapter for the existing public Cloudtracker model.
 * Load engine.js, ramp-core.js, then this file. No market-data requests are made here;
 * live marks may be supplied by the caller via CloudModel.setMarks().
 * The asset engine is shared unchanged; research ramps consume the canonical pricing policy.
 */
(function (root) {
  'use strict';

  const MODEL_ID = 'cloudtracker-capacity-valuation';
  const CAPTURED_ON = '2026-09-14';
  let source = null;
  let current = null;
  let pending = null;
  // Live marks live OUTSIDE the engine: every build() constructs a fresh engine, so marks must be
  // re-applied on each build or a slider recalculation silently reverts to saved prices/fallbacks.
  const emptyMarks = () => ({prices:{},priceDates:{},priceFetchedAt:{},priceSources:{},cryptoDates:{},btc:null,eth:null,asOf:null,fetchedAt:null});
  let marks = emptyMarks();
  const hasMarks = () => Object.keys(marks.prices).length > 0 || marks.btc != null || marks.eth != null;
  const labels = { owner: 'GPU operator', landlord: 'Data-centre landlord', holdco: 'Holding company' };
  const sum = (rows, key) => rows.reduce((n, row) => n + (row[key] || 0), 0);

  function requireData() {
    if (!source) throw new Error('Load CloudModel with await CloudModel.load() first.');
  }

  function currentOverrides() {
    const overrides = {};
    if (current) Object.entries(current.dials).forEach(([key, value]) => { if (value !== current.baseAssumptions[key]) overrides[key] = value; });
    return overrides;
  }

  function rampModel(company, scenario) {
    if (!company.ramp || typeof root.rampQuarters !== 'function') return null;
    const quarters = root.rampQuarters(company.ramp, scenario || null, undefined, undefined, source.researchPricing).map(q => ({
      quarter: q.lbl,
      serial: q.s,
      energizedGrossMW: q.grossMW,
      commissionedITMW: q.itCom,
      earningITMW: q.itMW,
      earningGPUs: q.cum,
      addedGPUs: q.added,
      signedGPUs: q.signed,
      modeledContractedGPUs: q.ctr,
      revenueM: q.rev,
      signedRevenueM: q.revS,
      modeledContractedRevenueM: q.revC,
      futureContractRevenueM: q.revC - q.revS,
      spotRevenueM: q.rev - q.revC,
      miningRevenueM: q.mining,
      totalRevenueM: q.rev + q.mining,
      revenueRunRateM: q.rev * 4,
      consensusTotalRevenueM: q.consTot,
      consensusAIRevenueM: q.consAI,
      consensusIsIndicative: q.s > root.RAMP_CONS_HARD,
      signedRevenueShare: q.rev > 0 ? q.revS / q.rev : 0,
      gpuGenerations: { ...q.by },
      generationRevenueM: { ...q.rv },
      raw: q
    }));
    return {
      ticker: company.tk,
      asOf: company.ramp.asOf || null,
      modelId: 'cloudtracker-quarterly-ramp',
      independentOfValuation: true,
      basis: company.ramp.basis || '',
      quarters,
      backtest: typeof root.rampBacktest === 'function' ? root.rampBacktest(company.ramp, source.researchPricing) : null,
      scenarios: company.ramp.scenarios || [],
      raw: company.ramp
    };
  }

  function build(dialOverrides) {
    requireData();
    const engine = root.Engine.createEngine(source);
    Object.entries(dialOverrides || {}).forEach(([key, value]) => {
      if (!(key in engine.BASE)) throw new Error('Unknown model assumption: ' + key);
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Invalid assumption: ' + key);
      const slider = engine.SLIDERS.find(s => s.k === key);
      if (slider && (value < slider.min || value > slider.max)) throw new Error('Assumption outside source range: ' + key);
      engine.A[key] = value;
    });
    Object.assign(engine.ctx.prices, marks.prices);
    if (marks.btc != null) engine.ctx.btc = marks.btc;
    if (marks.eth != null) engine.ctx.eth = marks.eth;

    const companies = engine.COMPANIES.map(c => {
      const v = engine.value(c);
      const legacy = engine.legacyOf(c);
      const discount = c.equityDiscount || 0;
      const siteEV = v.contractedEV + v.expectedEV;
      const floorEquityPre = Math.max(0, v.contractedEV + legacy - v.claims);
      const sites = v.segs.map((segment, index) => ({
        id: c.tk + '-' + index,
        ticker: c.tk,
        companyName: c.name,
        type: c.model,
        name: segment.s.n,
        mw: segment.s.mw,
        physicalMW: segment.s.physMW || null,
        owned: segment.s.owned,
        tenure: segment.s.owned ? 'Owned' : 'Leased',
        region: segment.s.region,
        regionLabel: engine.REGION[segment.s.region].name,
        year: segment.s.yr,
        month: segment.s.mo || 1,
        provenance: segment.s.prov,
        evM: segment.ev,
        contractedEVM: segment.contractedEV,
        expectedEVM: segment.expectedEV,
        evidenceWeight: segment.hair,
        raw: segment.s
      }));
      const leases = (c.leases || []).filter(l => l.effective !== false);
      const contracts = (c.contracts || []).filter(l => l.effective !== false);
      return {
        ticker: c.tk,
        name: c.name,
        type: c.model,
        typeLabel: labels[c.model] || c.model,
        tier: c.tier || 'proven',
        tierLabel: engine.tierOf(c).name,
        price: v.price,
        priceAsOf: marks.prices[c.tk] != null ? marks.priceDates[c.tk] || null : null,
        priceFetchedAt: marks.priceFetchedAt[c.tk] || null,
        floor: v.floorTarget,
        target: v.target,
        upside: v.upside,
        contractedPct: c.contractedPct,
        termYears: c.termYrs,
        marketCapM: c.shares * v.price,
        sharesM: c.shares,
        fundedSharesM: v.fundedShares,
        capacityMW: sum(sites, 'mw'),
        siteCount: sites.length,
        sites,
        leases,
        contracts,
        narrative: c.narrative || '',
        bull: c.bull || [],
        bear: c.bear || [],
        catalysts: c.catalysts || [],
        risks: c.risks || [],
        raises: c.raises || [],
        verified: c.verified || {},
        sources: c.sources || [],
        basis: c.basis || {},
        decomposition: {
          // Enterprise values and claims are USD millions, share counts millions.
          gross: v.ev,
          enterpriseValueM: v.ev,
          siteEV,
          siteEVM: siteEV,
          contractedEVM: v.contractedEV,
          expectedEVM: v.expectedEV,
          legacy,
          legacyM: legacy,
          netDebt: c.netDebt,
          netDebtM: c.netDebt,
          committedDebtM: c.committedDebt || 0,
          seniorClaimsM: c.seniorClaims || 0,
          claimsM: v.claims,
          equityPreDiscountM: v.equityPre,
          equityDiscount: discount,
          equityDiscountM: v.equityPre * discount,
          equity: v.equity,
          equityM: v.equity,
          plannedRaiseM: c.plannedRaise || 0,
          equityRaiseM: v.equityRaise,
          newSharesM: v.newShares,
          fundedSharesM: v.fundedShares,
          floorEquityPreDiscountM: floorEquityPre,
          floorEquityM: floorEquityPre * (1 - discount),
          contractedShareOfSiteEV: siteEV > 0 ? v.contractedEV / siteEV : 0,
          perShare: {
            signed: v.contractedEV * (1 - discount) / v.fundedShares,
            unsigned: v.expectedEV * (1 - discount) / v.fundedShares,
            legacy: legacy * (1 - discount) / v.fundedShares,
            claims: -v.claims * (1 - discount) / v.fundedShares,
            floor: v.floorTarget,
            total: v.target
          }
        },
        raw: c
      };
    });
    const sites = companies.flatMap(c => c.sites);
    const contractedEVM = companies.reduce((n, c) => n + c.decomposition.contractedEVM, 0);
    const siteEVM = companies.reduce((n, c) => n + c.decomposition.siteEVM, 0);
    const ramps = Object.fromEntries(engine.COMPANIES.filter(c => c.ramp).map(c => [c.tk, rampModel(c)]));
    current = {
      meta: {
        modelId: MODEL_ID,
        capturedOn: CAPTURED_ON,
        asOf: CAPTURED_ON,
        priceMode: hasMarks() ? 'Market references supplied' : 'Saved source prices',
        priceAsOf: hasMarks() ? marks.asOf : null,
        priceNote: hasMarks()
          ? 'Market equity/crypto references; per-company provider dates are separate from receipt time. Names without a quote keep saved prices.'
          : 'Saved source prices; quote dates are not supplied. Awaiting a usable market refresh.',
        modelReferenceDate: engine.YEAR + '-' + String(engine.CFG.referenceMonth || 1).padStart(2, '0') + '-01',
        assumptionsVerifiedOn: engine.CFG.verifiedPricing || null,
        sourceURL: 'https://cloudtracker.onrender.com/data.json',
        originalEngineURL: 'https://cloudtracker.onrender.com/engine.js',
        currency: 'USD',
        valueUnit: 'millions',
        perShareUnit: 'USD',
        upsideUnit: 'fraction',
        siteCountNote: 'Source capacity rows, including phases and pipeline tranches; not unique physical campuses.',
        capacityNote: 'Source model MW; company/tenancy rows can overlap. Do not total as distinct industry capacity.',
        floorNote: 'Signed-value case after claims and modeled dilution. A scenario output, not guaranteed downside protection.'
      },
      dials: { ...engine.A },
      baseAssumptions: { ...engine.BASE },
      assumptions: engine.SLIDERS.map(s => ({ key: s.k, label: s.label, value: engine.A[s.k], baseValue: engine.BASE[s.k], min: s.min, max: s.max, step: s.step, format: s.fmt })),
      companies,
      sites,
      ramps,
      sources: source.sources || [],
      watchItems: source.watchItems || [],
      outlook: source.outlook || [],
      summary: {
        companyCount: companies.length,
        siteRowCount: sites.length,
        marketCapM: sum(companies, 'marketCapM'),
        modelEquityM: companies.reduce((n, c) => n + c.decomposition.equityM, 0),
        contractedEVM,
        siteEVM,
        contractedShareOfSiteEV: siteEVM > 0 ? contractedEVM / siteEVM : 0,
        aggregationNote: 'Arithmetic company totals, including holding-company stakes and overlapping exposures; not a deduplicated sector valuation or investment portfolio.'
      }
    };
    return current;
  }

  const api = {
    async load(url) {
      if (source) return current || build({});
      if (!pending) pending = (async () => {
        if (!root.Engine) throw new Error('engine.js must load before model-data.js.');
        const response = await fetch(url || 'data.json', { cache: 'no-store' });
        if (!response.ok) throw new Error('Could not load model data (HTTP ' + response.status + ').');
        const data = await response.json();
        if (!data.config || !Array.isArray(data.companies)) throw new Error('Invalid source model data.');
        source = data;
        return build({});
      })().catch(error => { pending = null; throw error; });
      return pending;
    },
    // Every call starts from original base dials. Pass all desired overrides.
    // Calling recalculate({}) or reset() restores every original assumption.
    recalculate: build,
    reset: () => build({}),
    // Marks persist across every subsequent build (recalculate/reset), changing valuations AND
    // dilution (new shares = planned raise ÷ live price); meta.priceMode/priceAsOf reflect them.
    // Only finite numbers > 0 are stored — anything else DELETES that mark (that name degrades to
    // its saved price), so the display can never claim a live mark the engine would fall back on
    // (engine priceOf/btcPrice ignore 0, NaN and non-numbers). setMarks merges per key; clearMarks
    // returns everything to saved prices. Both rebuild keeping the current dials.
    setMarks(next) {
      next = next || {};
      const usable = v => typeof v === 'number' && Number.isFinite(v) && v > 0;
      const prices={...marks.prices},priceDates={...marks.priceDates},priceFetchedAt={...marks.priceFetchedAt},priceSources={...marks.priceSources};
      const own=(o,k)=>o&&Object.prototype.hasOwnProperty.call(o,k);
      Object.entries(next.prices||{}).forEach(([tk,v])=>{
        if(usable(v)){
          prices[tk]=v;
          priceDates[tk]=own(next.priceDates,tk)?next.priceDates[tk]||null:next.asOf||null;
          priceFetchedAt[tk]=own(next.priceFetchedAt,tk)?next.priceFetchedAt[tk]||null:next.fetchedAt||next.asOf||null;
          priceSources[tk]=next.priceSources?.[tk]||'Market quote';
        }else{delete prices[tk];delete priceDates[tk];delete priceFetchedAt[tk];delete priceSources[tk];}
      });
      marks = {
        prices,priceDates,priceFetchedAt,priceSources,
        cryptoDates:Object.fromEntries(['btc','eth'].map(k=>[k,k in next?(usable(next[k])?(own(next.cryptoDates,k)?next.cryptoDates[k]||null:next.asOf||null):null):marks.cryptoDates[k]||null])),
        fetchedAt:next.fetchedAt??marks.fetchedAt,
        btc: 'btc' in next ? (usable(next.btc) ? next.btc : null) : marks.btc,
        eth: 'eth' in next ? (usable(next.eth) ? next.eth : null) : marks.eth,
        asOf: next.asOf != null ? next.asOf : marks.asOf
      };
      return source ? build(currentOverrides()) : null;
    },
    clearMarks() {
      marks = emptyMarks();
      return source ? build(currentOverrides()) : null;
    },
    company: ticker => { requireData(); return current.companies.find(c => c.ticker === ticker) || null; },
    ramp(ticker, scenario) {
      requireData();
      const company = source.companies.find(c => c.tk === ticker);
      return company ? rampModel(company, scenario) : null;
    }
  };
  Object.defineProperty(api, 'baseAssumptions', { get() { requireData(); return { ...source.config.dials }; } });
  // Raw parsed data.json — the checks suite needs unadapted fields (watchItems, config, verified).
  Object.defineProperty(api, 'source', { get() { return source; } });
  // Read-only snapshot of the live marks, so other views (e.g. Portfolio's Target-now engine)
  // can price at the same marks this adapter uses. Never mutate through this.
  Object.defineProperty(api, 'marks', { get() { return {...marks,prices:{...marks.prices},priceDates:{...marks.priceDates},priceFetchedAt:{...marks.priceFetchedAt},priceSources:{...marks.priceSources},cryptoDates:{...marks.cryptoDates}}; } });
  Object.defineProperty(api, 'current', { get() { return current; } });
  root.CloudModel = api;
})(typeof window !== 'undefined' ? window : globalThis);
