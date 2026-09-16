/* Economic assumption review. Read-only, deterministic; valuations use the existing
   calculators. Reconciliation is not independent evidence that an input is right. */
'use strict';
const crypto = require('node:crypto');
const { createEngine } = require('./engine.js');
const { assemble } = require('./onepager.js');
const OP = require('./onepager-core.js');
const RULE_VERSION = '1.1.0';
const FAMILIES = ['capacity', 'economics', 'funding'];
const RESEARCH = new Set(['IREN', 'CRWV', 'NBIS']);
const finite = Number.isFinite;
const positive = x => finite(x) && x > 0;
const sum = (rows, fn) => rows.reduce((n, x) => n + fn(x), 0);
const clone = x => JSON.parse(JSON.stringify(x));
const qSerial = q => typeof q === 'string' && /^\d{4}Q[1-4]$/.test(q) ? +q.slice(0, 4) * 4 + +q.slice(-1) : NaN;
const fmt = (x, n = 2) => finite(x) ? x.toLocaleString('en-US', { maximumFractionDigits: n }) : 'unavailable';
const safeURL = x => typeof x === 'string' && /^https?:\/\/[^\s<>]+$/.test(x) ? x : null;
const evidence = (label, url) => ({ label, ...(safeURL(url) ? { url } : {}) });
const stable = x => Array.isArray(x) ? x.map(stable) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k => [k, stable(x[k])])) : x;
const digest = x => crypto.createHash('sha256').update(JSON.stringify(stable(x))).digest('hex');
function impact(base, alternative, label, basis) {
  return finite(base) && finite(alternative) ? { base, alternative, delta: alternative - base,
    pct: base !== 0 ? (alternative - base) / Math.abs(base) * 100 : null, pctUnit: 'percent', label, basis } : null;
}

function analyze(data, marks = {}, options = {}) {
  if (!data || !Array.isArray(data.companies) || !data.config) throw new TypeError('Model config and companies are required');
  const asOf = options.asOf || new Date().toISOString();
  if (!finite(Date.parse(asOf))) throw new TypeError('asOf must be an ISO date or timestamp');
  const findings = [], companies = [], models = new Map();
  const engine = createEngine(data);
  // Accept the shared snapshot shape and simple ticker-price maps; never alter marks.
  const markSet = marks.marks || marks;
  const prices = markSet.prices || markSet.quotes || markSet;
  for (const c of data.companies) {
    const p = prices[c.tk];
    const v = typeof p === 'number' ? p : p?.price;
    if (positive(v)) engine.ctx.prices[c.tk] = v;
  }
  for (const asset of ['btc', 'eth']) if (positive(markSet[asset])) engine.ctx[asset] = markSet[asset];
  const policy = {
    purpose: 'Economic consistency and evidence review; findings never edit model assumptions.',
    rules: RULE_VERSION,
    thresholds: { peerRevenueDeviation: .25, capacityIdleShare: .20, priceSensitivityGap: .10,
      gpuDensityPerITMW: [10, 2000], annualRevenueMillionPerITMW: [.05, 100],
      unsignedEVShare: .50, unsignedRealizationEffect: .10, newSharesToExisting: .25,
      signedFloorEVShare: .20, signedResidualEVShare: .10, stakeEVShare: .25, claimToStake: .25, treasuryEVShare: .50 },
    thresholdBasis: 'Broad house triage bands, not empirical market limits or price targets. Deviations request investigation.',
    peerScope: 'Research GPU operators only, with matched modeled earning IT MW; landlord NOI and holding-company assets are separate.',
    quarterBasis: 'Annualized quarter revenue = quarter revenue × 4. Earning IT MW is the model-effective billable capacity used for that quarter; it is not a separately observed December exit capacity. Ramp fractions are quarter-step approximations.',
    independentEvidence: 'A recomputation from the same inputs establishes arithmetic consistency only. Independent fleet, realized price, acceptance and funding evidence remain coverage gaps.',
    fundingScope: 'Quarterly cash and dilution for research names; static claims and planned issuance for other names. Funding feasibility is not established by an automatically balanced waterfall.',
    units: 'Capacity MW; revenue and asset-model claims USD millions; research funding USD billions; shares millions; valuation USD per share.',
    scenarios: 'Illustrative house sensitivities using the canonical calculators; alternatives are not recommendations and are never applied automatically.'
  };
  function add(c, family, key, severity, title, explanation, calculation, sources, nextAction, inputs, extra = {}) {
    const id = `${c.tk}:${family}:${key}`;
    const f = { id, ticker: c.tk, family, severity, title, explanation, calculation,
      evidence: sources || [], impact: null, nextAction, ...extra };
    f.fingerprint = digest({ ruleVersion: RULE_VERSION, id, severity, inputs, evidence: f.evidence, impact: f.impact, scenario: f.scenario });
    findings.push(f);
    return f;
  }
  function scenario(c, m, delta, label) {
    try {
      const alt = assemble(c, data.researchPricing, { id: 'assumption-review', name: label, d: delta });
      return { impact: impact(m.W.ps, alt.W.ps, label, 'USD per share; canonical research ramp, funding waterfall and steady-state DCF recalculated.'),
        scenario: { kind: 'ramp', delta, label }, alternativeMetrics: { annualizedRevenueBn: alt.W.rr, debtBn: alt.W.last.nd, sharesM: alt.W.dil } };
    } catch (error) { return { scenarioError: error.message }; }
  }
  function waterfall(m, opts, label) {
    const alt = OP.waterfall(m.L, m.CAPQ, m.F, m.ARRC, opts);
    return { impact: impact(m.W.ps, alt.ps, label, 'USD per share; canonical research funding waterfall, operating forecast unchanged.'),
      scenario: { kind: 'waterfall', options: opts, label }, alternativeMetrics: { debtBn: alt.last.nd, sharesM: alt.dil, equityRaisedBn: alt.eqTot } };
  }
  function assetScenario(c, changes, label) {
    try {
      const d = clone(data), company = d.companies.find(x => x.tk === c.tk);
      Object.assign(company, changes.company || {});
      Object.assign(d.config.constants, changes.constants || {});
      const e = createEngine(d);
      Object.assign(e.ctx, clone(engine.ctx));
      Object.assign(e.A, changes.dials || {});
      if (changes.price != null) e.ctx.prices[c.tk] = changes.price;
      for (const key of ['btc', 'eth']) if (changes[key] != null) e.ctx[key] = changes[key];
      const before = engine.value(c), after = e.value(company);
      return { impact: impact(before.target, after.target, label, 'USD per share; canonical asset engine with the stated assumption changed. Other inputs and existing provenance haircuts are retained. This is a sensitivity, not a replacement forecast.'),
        scenario: { kind: 'asset', changes, label }, alternativeMetrics: { enterpriseValueM: after.ev, claimsM: after.claims, fundedSharesM: after.fundedShares, newSharesM: after.newShares } };
    } catch (error) { return { scenarioError: error.message }; }
  }
  function reviewAssetAssumptions(c, row, asset, src) {
    if (!asset || !positive(asset.ev) || !finite(asset.target)) return;
    const evidence = [...src, { label: 'Canonical asset engine: current site values, claims and funded share count; no new filing verification is implied.' }];
    row.metrics.unsignedEVShare = asset.expectedEV / asset.ev;
    row.metrics.assetClaimsM = asset.claims;
    row.metrics.assetEnterpriseValueM = asset.ev;
    if (asset.expectedEV / asset.ev >= policy.thresholds.unsignedEVShare) {
      const current = engine.leaseUp(), stressed = current * .8;
      const s = assetScenario(c, { dials: { leaseUp: stressed } }, `Unsigned realization ${fmt(current * 100)}% → ${fmt(stressed * 100)}%`);
      if (Math.abs(s.impact?.pct || 0) >= policy.thresholds.unsignedRealizationEffect * 100) add(c, 'economics', 'unsigned-realization', 'review', 'Unsigned business drives a material part of equity value',
        'The model capitalizes capacity without executed contracts at the assumed lease-up or spot realization. Existing provenance haircuts already apply, but they do not establish customer demand or realization at the assumed rate. This measures the exposure without requiring a quarterly model.',
        `${fmt(asset.expectedEV)}m unsigned site EV / ${fmt(asset.ev)}m total modeled EV = ${fmt(asset.expectedEV / asset.ev * 100)}%; realization ${fmt(current * 100)}% → ${fmt(stressed * 100)}% with signed business unchanged.`, evidence,
        'Underwrite tenant conversion, price, utilization and timing for the unsigned blocks. Explain the assumed realization and distinguish secured power from customer-accepted capacity.',
        { sites: c.sites, contractedPct: c.contractedPct, signedRate: c.signedRate, termYrs: c.termYrs, config: data.config, asset }, s);
    }
    if (positive(c.shares) && asset.newShares / c.shares > policy.thresholds.newSharesToExisting) {
      const price = engine.priceOf(c);
      const s = assetScenario(c, { price: price * .8 }, 'Same planned equity dollars issued at a 20% lower price');
      add(c, 'funding', 'issuance-price', 'review', 'Planned issuance is large relative to existing shares',
        'The asset model issues the entire planned equity raise at the reference share price. A large raise makes the execution price and financing sequence material. This is an issuance-price sensitivity; it does not claim that the share price will fall.',
        `${fmt(asset.equityRaise)}m planned raise / $${fmt(price)} = ${fmt(asset.newShares)}m new shares, ${fmt(asset.newShares / c.shares * 100)}% of ${fmt(c.shares)}m existing shares; funded denominator ${fmt(asset.fundedShares)}m.`,
        [...evidence, { label: `Model funding basis: ${c.basis?.plannedRaise || 'not supplied'}` }],
        'Reconcile committed versus assumed funding, issue prices, staged draws and potential convertible dilution; test whether funding access persists at lower share prices.',
        { shares: c.shares, plannedRaise: c.plannedRaise, dilutionStress: engine.A.dilutionStress, price, basis: c.basis?.plannedRaise }, s);
    }
    if (positive(c.sharesReported) && positive(c.shares) && c.shares < c.sharesReported * .99) add(c, 'funding', 'shares-below-reported', 'review', 'Valuation share count is below the reported share count',
      'The model denominator is smaller than its own reported-share field. Dates, repurchases, share classes or a stale field could explain the difference; until reconciled, the per-share result needs review.',
      `${fmt(c.shares)}m model shares vs ${fmt(c.sharesReported)}m reported shares (${fmt((c.shares / c.sharesReported - 1) * 100)}%).`,
      [...evidence, { label: `Model share basis: ${c.basis?.shares || 'not supplied'}` }],
      'Reconcile basic outstanding, diluted awards, if-converted debt and as-of dates. Do not select a denominator merely because it raises or lowers value.',
      { shares: c.shares, sharesReported: c.sharesReported, basis: c.basis?.shares },
      assetScenario(c, { company: { shares: c.sharesReported } }, 'Use the reported-share field before modeled new issuance'));
    if (c.model === 'landlord') {
      const signed = asset.segs.filter(v => engine.leaseOf(c, v.s));
      const floor = (engine.CONST.capFloor || 6.5) / 100;
      const boundEV = sum(signed.filter(v => Math.abs(v.calc.cap - floor) < 1e-9), v => v.contractedEV);
      const tail = signed.map(v => { const l = engine.leaseOf(c, v.s); return { name: v.s.n, lease: l.id, years: l.termYrs,
        value: v.contractedEV, initialTermNOI: v.s.mw * l.noiPerMWyr * l.termYrs }; })
        .filter(v => positive(v.initialTermNOI) && v.value > v.initialTermNOI * 1.05);
      const excess = sum(tail, v => v.value - v.initialTermNOI);
      if (boundEV / asset.ev >= policy.thresholds.signedFloorEVShare || excess / asset.ev >= policy.thresholds.signedResidualEVShare) add(c, 'economics', 'lease-capitalization', 'review', 'Signed lease value depends on the cap-rate floor and residual value',
        'Signed leases capitalize term-average NOI and classify the full asset value as contracted. The cap-rate floor can erase tenant-tier differences. Where that value exceeds even undiscounted full initial-term NOI, it necessarily relies on residual property value or future use beyond the initial lease; that residual is not signed rent.',
        `${fmt(boundEV)}m signed EV is pinned to the ${fmt(floor * 100)}% floor (${fmt(boundEV / asset.ev * 100)}% of total EV). ` + (tail.length ? tail.slice(0, 4).map(v => `${v.name}: ${fmt(v.value)}m contracted EV vs ${fmt(v.initialTermNOI)}m undiscounted full ${fmt(v.years)}-year NOI`).join('; ') + (tail.length > 4 ? `; ${tail.length - 4} further blocks` : '') : 'No mapped block exceeds its full initial-term NOI in this comparison; credit and capitalization assumptions still require justification.'),
        [...evidence, { label: `Model landlord tier ${c.tier}; base cap ${fmt(engine.A.capRate)}%, tier spread ${fmt(engine.tierOf(c).capSpread)} points, signed compression ${fmt(engine.CONST.capCompress * 100)}%, floor ${fmt(floor * 100)}%.` }],
        'Separate contracted cash flows from post-expiry residual value. Justify cap rates by tenant credit, contract duration, termination rights and asset quality; review whether the signed-only floor label overstates contractual protection.',
        { leases: c.leases, sites: c.sites, tier: c.tier, config: data.config, boundEV, tail },
        assetScenario(c, { constants: { capFloor: floor * 100 + 1 } }, `Cap-rate floor ${fmt(floor * 100)}% → ${fmt(floor * 100 + 1)}%; no change to lease NOI`));
    }
    if (c.model === 'owner' && positive(c.signedRate)) {
      const contracts = (c.contracts || []).filter(x => x.effective !== false);
      const complete = contracts.length && contracts.every(x => positive(x.totalRevM) && positive(x.mw) && positive(x.termYrs));
      if (complete) {
        const bookRate = sum(contracts, x => x.totalRevM) / sum(contracts, x => x.mw * x.termYrs);
        const signedSites = asset.segs.filter(v => v.contractedEV > 0);
        const factors = [...new Set(signedSites.map(v => engine.REGION[v.s.region]?.rateMul || 1))];
        if (Math.abs(c.signedRate / bookRate - 1) <= .10 && factors.length === 1 && factors[0] < .90) add(c, 'economics', 'signed-rate-region', 'review', 'Contract-derived pricing receives another regional discount',
          'The company-specific signed rate agrees with its own effective contract registry, yet the engine applies a further geography factor to that signed income. If those contracts already reflect local pricing, the same regional effect may be counted twice. Registry estimates remain estimates.',
          `${fmt(sum(contracts, x => x.totalRevM))}m contract value / ${fmt(sum(contracts, x => x.mw * x.termYrs))} MW-years = ${fmt(bookRate)}m/MW-year; model signed rate ${fmt(c.signedRate)} × regional factor ${fmt(factors[0])} = ${fmt(c.signedRate * factors[0])}m/MW-year before contract-share weighting.`,
          [...evidence, { label: `Model signed-rate basis: ${c.basis?.signedRate || 'not supplied'}` }],
          'Confirm whether signedRate is already company-local or a US-equivalent anchor. Reconcile signed dollars before applying geography; keep any regional assumptions for unsigned business separate.',
          { contracts, signedRate: c.signedRate, sites: c.sites, factors, basis: c.basis?.signedRate },
          assetScenario(c, { company: { signedRate: c.signedRate / factors[0] } }, 'Neutralize the additional regional discount on signed income only'));
      }
    }
    if (c.stake && positive(c.stake.pct)) {
      const investee = data.companies.find(x => x.tk === c.stake.tk), stakeValue = engine.stakeValue(c);
      if (investee && positive(stakeValue) && (stakeValue / asset.ev >= policy.thresholds.stakeEVShare || (c.seniorClaims || 0) / stakeValue >= policy.thresholds.claimToStake)) add(c, 'funding', 'lookthrough-ownership', 'review', 'Subsidiary ownership and parent claims need a common share basis',
        'The asset engine applies an ownership percentage to the subsidiary and then applies its planned dilution. It also deducts parent-level claims. Held shares, the subsidiary denominator and the entity scope of minority claims must reconcile; otherwise ownership can be diluted twice or minority interests deducted twice. Separate preferred claims can remain valid.',
        `${fmt(c.stake.pct * 100)}% × ${fmt(investee.shares)}m ${investee.tk} model shares implies ${fmt(c.stake.pct * investee.shares)}m held before future issuance; stake value ${fmt(stakeValue)}m; separate parent senior claims ${fmt(c.seniorClaims || 0)}m.`,
        [...evidence, { label: `Model ownership basis: ${c.basis?.stake || 'not supplied'}` }, { label: `Model senior-claim basis: ${c.basis?.seniorClaims || 'not supplied'}` }],
        'Reconcile documented shares held to the current subsidiary basic/diluted denominator. Map each claim to its legal entity; reconcile proportionate valuation with consolidated-value-less-minority treatment before proposing a change.',
        { stake: c.stake, investeeShares: investee.shares, investeeRaise: investee.plannedRaise, seniorClaims: c.seniorClaims, basis: c.basis, stakeValue });
    }
    const treasury = (c.btc || 0) * engine.btcPrice() / 1e6 + (c.eth || 0) * engine.ethPrice() / 1e6;
    if (treasury / asset.ev > policy.thresholds.treasuryEVShare) add(c, 'funding', 'treasury-claims', 'review', 'Treasury assets dominate; associated claims need reconciliation',
      'Most modeled enterprise value comes from marked crypto holdings. Free versus pledged units, purchase obligations, derivatives and related-party balances must use a consistent valuation perimeter. A correct multiplication of coins by price does not settle which assets and claims belong to common equity.',
      `${fmt(treasury)}m marked treasury / ${fmt(asset.ev)}m modeled EV = ${fmt(treasury / asset.ev * 100)}%; ${fmt(c.btc || 0)} BTC, ${fmt(c.eth || 0)} ETH; total deducted claims ${fmt(asset.claims)}m.`,
      [...evidence, { label: `Model treasury basis: ${c.basis?.btc || c.basis?.eth || 'not supplied'}` }, { label: `Model debt perimeter: ${c.basis?.netDebt || 'not supplied'}` }],
      'Reconcile unencumbered holdings, pledged collateral, associated liabilities and related-party eliminations using the same date and legal-entity perimeter.',
      { btc: c.btc, eth: c.eth, btcPrice: engine.btcPrice(), ethPrice: engine.ethPrice(), claims: asset.claims, basis: c.basis },
      assetScenario(c, { btc: engine.btcPrice() * .8, eth: engine.ethPrice() * .8 }, 'Crypto reference prices 20% lower; asset and claim perimeter unchanged'));
  }
  const commonSources = (data.researchPricing?.sources || []).map(s => typeof s === 'string' ? evidence('Referenced pricing source; forward curve remains a house assumption', s) : evidence(`${s.title || 'Pricing source'}: ${s.supports || 'Context for the house pricing assumption'}`, s.url));

  for (const c of data.companies) {
    const research = RESEARCH.has(c.tk), holdco = c.model === 'holdco';
    const row = { ticker: c.tk, name: c.name, model: c.model,
      modelBasis: research ? 'Research quarterly funding and DCF' : holdco ? 'Holding-company asset value' : 'Asset model; no quarterly operating and funding bridge',
      tests: Object.fromEntries(FAMILIES.map(f => [f, { status: 'consistent', summary: 'Arithmetic checks passed within available model coverage.' }])), metrics: {} };
    companies.push(row);
    const src = [evidence(`Model inputs: data.json → companies.${c.tk}; filing verification ${c.verified?.filings || (typeof c.verified === 'string' ? c.verified : 'not dated here')}`)];
    if (holdco) for (const f of ['capacity', 'economics']) row.tests[f] = { status: 'not-applicable', summary: 'Holding-company assets require a look-through claim analysis; GPU/MW parity does not apply.' };
    const badCapital = ['shares', 'price'].filter(k => !positive(c[k]));
    for (const k of ['netDebt', 'plannedRaise', 'committedDebt', 'seniorClaims']) if ((k === 'netDebt' || c[k] != null) && (!finite(c[k]) || (k !== 'netDebt' && c[k] < 0))) badCapital.push(k);
    if (badCapital.length) add(c, 'funding', 'capital-inputs', 'error', 'Capital inputs cannot support a finite per-share value',
      'Shares and price must be positive; claims and raises need finite values in USD millions. Net cash is allowed as negative net debt.', badCapital.join(', '), src,
      'Correct the input units and reconcile to the capital table before interpreting valuation.', badCapital.map(k => [k, c[k]]));
    let asset;
    try {
      asset = engine.value(c);
      Object.assign(row.metrics, { price: engine.priceOf(c), priceAsOf: markSet.priceDates?.[c.tk] || null,
        priceBasis: positive(engine.ctx.prices[c.tk]) ? 'Supplied market snapshot' : 'Fallback data.json price; live quote unavailable',
        assetValuePerShare: finite(asset.target) ? asset.target : null,
        modelSharesM: c.shares, plannedRaiseM: c.plannedRaise || 0, assetFundedSharesM: finite(asset.fundedShares) ? asset.fundedShares : null });
      if (![asset.target, asset.ev, asset.fundedShares].every(finite)) throw new Error('non-finite asset value or share count');
    } catch (error) {
      add(c, 'funding', 'asset-calculation', 'error', 'Asset valuation could not be reconciled', error.message, 'Canonical engine.value failed or returned non-finite output.', src,
        'Resolve the model input failure and rerun.', { company: c, error: error.message });
    }
    if (!holdco) {
      const sites = c.sites || [];
      const invalid = sites.filter(s => !positive(s.mw) || (s.physMW != null && (!positive(s.physMW) || s.mw > s.physMW)));
      if (invalid.length) add(c, 'capacity', 'site-physical', 'error', 'Credited site capacity exceeds its stated physical basis',
        'Economic capacity must be positive and cannot exceed a supplied physical block. A JV economic slice is not the whole facility.',
        invalid.map(s => `${s.n}: economic ${fmt(s.mw)} MW / physical ${fmt(s.physMW)} MW`).join('; '), src,
        'Reconcile facility, IT, gross and economic ownership units.', invalid);
      row.metrics.siteEconomicMW = sum(sites, s => finite(s.mw) ? s.mw : 0);
      row.metrics.siteCapacityBasis = 'Economic MW in the asset register, including future pipeline; not an earning-capacity denominator.';
    }
    if (!research) {
      reviewAssetAssumptions(c, row, asset, src);
      if (!holdco) {
        add(c, 'capacity', 'quarterly-bridge-missing', 'gap', 'Energized-to-earning capacity is not modeled quarterly',
          'The site register records credited economic MW and commissioning dates, but has no separate installed, accepted and billable-capacity ledger. This cannot pass the revenue-per-earning-MW test.',
          `${fmt(row.metrics.siteEconomicMW)} economic MW across ${(c.sites || []).length} site blocks; earning IT MW unavailable.`, src,
          'Map site stages and customer acceptance to a quarterly capacity and revenue schedule.', { sites: c.sites, model: c.model });
        if (c.model === 'landlord') {
          const leases = (c.leases || []).filter(l => l.effective !== false);
          const mapped = (c.sites || []).filter(s => leases.some(l => l.id === s.leaseId));
          const leasedMW = sum(mapped, s => s.mw);
          const annualNOI = sum(mapped, s => s.mw * leases.find(l => l.id === s.leaseId).noiPerMWyr);
          row.metrics.leasedEconomicMW = leasedMW;
          row.metrics.annualContractNOIM = annualNOI;
          row.metrics.contractNOIPerMW = leasedMW > 0 ? annualNOI / leasedMW : null;
          const leaseGross = l => l.grossTotalM ?? l.totalRevM;
          const impossible = leases.filter(l => positive(leaseGross(l)) && l.mw * l.termYrs * l.noiPerMWyr > leaseGross(l) * 1.05);
          if (impossible.length) add(c, 'economics', 'lease-noi-exceeds-revenue', 'review', 'Lease NOI and headline revenue need reconciliation',
            'On an identical initial-term basis, cumulative NOI cannot exceed revenue. Scope, phasing and averaging are not independently verified here, so a 5% discrepancy requests reconciliation rather than asserting an accounting error.',
            impossible.map(l => `${l.id}: ${fmt(l.mw * l.termYrs * l.noiPerMWyr)}m NOI vs ${fmt(leaseGross(l))}m gross revenue`).join('; '),
            impossible.map(l => evidence(`Lease ${l.id}: ${l.source || 'model registry'}`, l.source)),
            'Verify MW, NOI versus revenue, initial term and extension treatment.', impossible);
          add(c, 'economics', 'lease-evidence-coverage', 'gap', 'Lease economics lack a complete cash-return bridge',
            'Registered lease NOI is checked against stated term revenue where available. Tenant-funded work, landlord capex, rent commencement, replacement obligations and project ownership are not fully reconciled in a quarterly model.',
            leasedMW ? `${fmt(annualNOI)}m annual term-average NOI / ${fmt(leasedMW)} leased economic MW = ${fmt(annualNOI / leasedMW)}m/MW-year. This is landlord NOI, not cloud revenue.` : 'No effective lease-to-site NOI denominator is available.',
            leases.length ? leases.slice(0, 3).map(l => evidence(`Model lease ${l.id}: ${l.source || 'source missing'}`, l.source)) : src,
            'Build lease cash returns and capital obligations; compare against matched landlord leases only.', { leases, mapped });
        } else add(c, 'economics', 'gpu-evidence-coverage', 'gap', 'GPU-hour economics cannot be independently reproduced',
          'The asset model capitalizes a company-level revenue-per-MW assumption without a complete fleet-generation, realized-price and billable-hours ledger.',
          `Signed revenue anchor ${fmt(c.signedRate ?? data.config.dials.rate)}m/MW-year; company contracted share ${fmt(c.contractedPct)}%.`, src,
          'Source fleet counts and power density, realized all-in pricing and utilization before validating GPU economics.', { signedRate: c.signedRate, contractedPct: c.contractedPct, sites: c.sites, basis: c.basis });
      }
      add(c, 'funding', 'funding-bridge-missing', 'gap', 'Funding and dilution have only static coverage',
        'The asset model subtracts current claims and divides by shares including planned issuance. It does not prove that construction, maturities, covenants, restricted cash and partner interests can be financed through time.',
        `${fmt(c.shares)}m existing shares + ${fmt(asset?.newShares)}m modeled issuance; net debt ${fmt(c.netDebt)}m, committed debt ${fmt(c.committedDebt || 0)}m, senior claims ${fmt(c.seniorClaims || 0)}m.`, src,
        'Reconcile the capital table and a dated sources-and-uses bridge, including convertible settlement and minority ownership.',
        { shares: c.shares, netDebt: c.netDebt, plannedRaise: c.plannedRaise, committedDebt: c.committedDebt, seniorClaims: c.seniorClaims, basis: c.basis, price: engine.priceOf(c) });
      continue;
    }

    if (!c.page || !c.ramp || !c.ramp.pricing) {
      for (const family of FAMILIES) add(c, family, 'research-inputs-missing', 'gap', 'Preferred research model is incomplete',
        'A missing research payload must not silently fall back to the asset valuation.', 'Required page, ramp and pricing blocks are not all present.', src,
        'Restore the canonical research inputs.', { page: !!c.page, ramp: !!c.ramp, pricing: !!c.ramp?.pricing });
      continue;
    }
    const T = c.ramp.tranches || [], F = c.page.finance || {}, P = data.researchPricing || {};
    if (P.units !== 'USD millions per IT MW per year; all-in contracted services') add(c, 'economics', 'pricing-units', 'error', 'Shared pricing units do not match the calculator',
      'The shared curve calculator requires USD millions per IT MW-year. A changed unit label cannot silently change numerical meaning.',
      `Declared units: ${P.units || 'missing'}`, [evidence('Model assumption: data.researchPricing.units')],
      'Normalize the values and explicit units together before using the curve.', { units: P.units, curve: P.curve });
    const physical = T.filter(t => !positive(t.itMW) || !positive(t.grossMW) || t.itMW > t.grossMW || !positive(t.gpus));
    if (physical.length) add(c, 'capacity', 'tranche-physical', 'error', 'Research tranche capacity violates physical units',
      'Installed IT load cannot exceed gross facility load; MW and installed GPU quantities must be positive.',
      physical.slice(0, 6).map(t => `${t.n}: IT ${fmt(t.itMW)} / gross ${fmt(t.grossMW)} MW, ${fmt(t.gpus, 0)} GPUs`).join('; '), src,
      'Reconcile gross-versus-IT power and the fleet count at each affected tranche.', physical);
    const dates = T.filter(t => !finite(qSerial(t.energize)) || !finite(qSerial(t.rev)) || qSerial(t.rev) < qSerial(t.energize));
    if (dates.length) add(c, 'capacity', 'earning-before-power', 'error', 'Revenue begins before the associated capacity is energized',
      'Acceptance and billing cannot precede the modeled physical power date. Missing or invalid quarters cannot establish order.',
      dates.slice(0, 6).map(t => `${t.n}: power ${t.energize}, revenue ${t.rev}`).join('; '), src,
      'Resolve the energization, installation and acceptance schedule.', dates);
    const financeInvalid = [];
    for (const k of ['SH0', 'EQ_PX', 'GPU_LIFE', 'SHELL_LIFE']) if (!positive(F[k])) financeInvalid.push(k);
    for (const k of ['DEBT0', 'CASH0', 'MINCASH', 'CONV', 'CASH_R', 'FWD']) if (F[k] != null && (!finite(F[k]) || F[k] < 0)) financeInvalid.push(k);
    for (const k of ['M', 'EQ_SHARE', 'RATE', 'TAX', 'AMORT']) if (!finite(F[k]) || F[k] < 0 || F[k] > 1) financeInvalid.push(k);
    if (!finite(F.W) || F.W <= -1 || F.W > 1) financeInvalid.push('W');
    if ((F.CONV || 0) > F.DEBT0 + .002) financeInvalid.push('CONV > DEBT0');
    if (financeInvalid.length) add(c, 'funding', 'research-capital-inputs', 'error', 'Research funding inputs contain invalid units or bounds',
      'Funding rates are fractions, debt and cash are USD billions, and shares are millions. Invalid values can manufacture borrowing, liquidity or dilution.',
      financeInvalid.join(', '), [evidence(`Model finance: ${c.tk}.page.finance; ${F.basis || 'basis missing'}`)],
      'Correct capital input units and reconcile them to disclosed balances.', { invalid: financeInvalid, F });
    let m;
    try {
      m = assemble(c, P);
      if (!finite(m.W.ps) || !positive(m.W.dil) || !m.rawQuarters.length) throw new Error('Research model returned non-finite valuation or invalid shares');
    } catch (error) {
      add(c, 'funding', 'research-calculation', 'error', 'Canonical research calculation cannot complete', error.message,
        'No replacement asset value is used for the preferred research model.', src, 'Resolve the input/calculation failure and rerun all families.',
        { page: c.page, ramp: c.ramp, market: P, error: error.message });
      for (const family of ['capacity', 'economics']) add(c, family, 'research-calculation-coverage', 'gap', 'Derived research checks could not run',
        'The canonical research calculation failed; this family has incomplete coverage.', error.message, src, 'Repair the research calculation.', { error: error.message });
      continue;
    }
    models.set(c.tk, m);
    const Q = m.rawQuarters, last = Q.at(-1), forward = m.W.C.filter(q => !q.past), funding = m.W;
    const perMW = last.itMW > 0 ? last.rev * 4 / last.itMW : null;
    const perContractMW = last.itContracted > 0 ? last.revC * 4 / last.itContracted : null;
    Object.assign(row.metrics, { horizonQuarter: last.lbl, grossEnergizedMW: last.grossMW, energizedITMW: last.itCom,
      earningITMW: last.itMW, contractedEarningITMW: last.itContracted, earningGPUCount: last.cum,
      annualizedQuarterRevenueBn: last.rev * .004, annualizedContractRevenueBn: last.revC * .004,
      revenuePerEarningITMWM: perMW, revenuePerEnergizedITMWM: last.itCom > 0 ? last.rev * 4 / last.itCom : null,
      contractRevenuePerEarningITMWM: perContractMW, modeledGPUHourPrice: last.blend,
      valuePerShare: funding.ps, dilutedSharesM: funding.dil, fundingEquityBn: funding.eqTot,
      horizonNetDebtBn: funding.last.nd, futureCustomerCreditsPVBn: funding.liab,
      renewalRevenueShare: last.rev > 0 ? last.revRenewal / last.rev : null,
      annualizedQuarterBasis: policy.quarterBasis });
    const breaches = Q.filter(q => q.itMW > q.itCom + .01 || q.itCom > q.grossMW + .01 || q.cum < -.01 || ![q.rev, q.itMW, q.itCom].every(finite));
    if (breaches.length) add(c, 'capacity', 'earning-over-installed', 'error', 'Earning capacity exceeds energized physical capacity',
      'The revenue denominator must remain within the energized IT envelope in every quarter.',
      breaches.slice(0, 6).map(q => `${q.lbl}: earning ${fmt(q.itMW)} / energized IT ${fmt(q.itCom)} / gross ${fmt(q.grossMW)} MW`).join('; '), src,
      'Reconcile ramp dates and quantities before interpreting revenue or value.', breaches.map(q => [q.lbl, q.itMW, q.itCom, q.grossMW]));
    const idle = last.itCom > 0 ? 1 - last.itMW / last.itCom : 0;
    if (idle > policy.thresholds.capacityIdleShare) add(c, 'capacity', 'horizon-unbillable', 'review', 'Material energized capacity is not earning at the horizon',
      'This can reflect deployment lag, contract timing or commercial utilization. It requires an explicit explanation rather than applying earning revenue to all powered MW.',
      `${last.lbl}: ${fmt(last.itCom - last.itMW)} / ${fmt(last.itCom)} energized IT MW not earning (${fmt(idle * 100)}%).`, src,
      'Review stage timing and specify which capacity is installed, accepted and billable.', { energized: last.itCom, earning: last.itMW, tranches: T });
    const inferred = T.filter(t => (t.contract?.signedShare ?? t.signed ?? 0) > 0 && (t.contract?.commitmentBasis !== 'disclosed' || t.contract?.expiryBasis !== 'disclosed'));
    if (inferred.length) add(c, 'capacity', 'customer-mapping', 'gap', 'Physical capacity is not fully mapped to disclosed customer commitments',
      'An aggregate backlog or power lease does not independently establish the acceptance, commercial share and expiry of each physical compute tranche.',
      `${inferred.length} of ${T.length} tranches have assumed commitments or estimated expiries.`,
      inferred.slice(0, 3).map(t => evidence(`${t.n}: ${t.contract?.note || 'inferred mapping'}`, t.contract?.source)),
      'Source a contract-to-tranche schedule and keep inferred customer coverage explicitly labeled.', inferred.map(t => ({ id: t.id, n: t.n, itMW: t.itMW, rev: t.rev, contract: t.contract })));
    const density = T.filter(t => positive(t.itMW)).map(t => ({ id: t.id || t.n, density: t.gpus / t.itMW, annualRate: t.rate * t.gpus * 8760 / t.itMW / 1e6 }));
    const unusual = density.filter(t => t.density < 10 || t.density > 2000 || !finite(t.annualRate) || t.annualRate < .05 || t.annualRate > 100);
    if (unusual.length) add(c, 'economics', 'density-price-scale', 'review', 'Fleet density or revenue-per-MW needs a unit check',
      'Broad triage bands catch unit/order-of-magnitude mistakes. They are not claims that all GPU generations have the same physical density or realized price.',
      unusual.slice(0, 6).map(t => `${t.id}: ${fmt(t.density)} GPUs/IT MW, ${fmt(t.annualRate)}m/MW-year`).join('; '), src,
      'Verify GPU quantity units, supporting IT power, realized all-in prices and equipment generation.', unusual);
    add(c, 'economics', 'independent-gpu-evidence', 'gap', 'MW pricing is not an independent GPU-hour validation',
      'Future contract GPU-hour rates are algebraically derived from the shared MW curve. Multiplying them back by the same fleet quantity is an identity, not corroboration. Fleet power, billable hours, ancillary revenue and realized prices need separately sourced evidence.',
      `${last.lbl}: ${fmt(last.cum, 0)} modeled earning GPUs × 2,190 hours × $${fmt(last.blend, 4)}/hour = $${fmt(last.rev)}m quarter revenue. Tranche densities span ${fmt(Math.min(...density.map(t => t.density)))}–${fmt(Math.max(...density.map(t => t.density)))} GPUs/IT MW.`,
      [evidence('Model assumptions: ramp tranches; shared researchPricing curve and generation factors'), ...commonSources],
      'Build an independent fleet-generation, power, utilization and realized-price evidence table; do not derive all inputs from the same MW revenue anchor.',
      { density, genFactors: P.generationFactors, spot: P.spot, curve: P.curve, basis: P.basis });
    const extremeCurve = Object.entries(P.curve || {}).flatMap(([year, terms]) => Object.entries(terms).map(([term, rate]) => ({ year, term, rate: typeof rate === 'number' ? rate : rate.rate })))
      .filter(x => !finite(x.rate) || x.rate < .05 || x.rate > 100);
    if (extremeCurve.length) add(c, 'economics', 'forward-curve-scale', 'review', 'Common forward pricing is outside broad unit-check bounds',
      'A common error can affect every company without creating a peer outlier. The MW-year curve is checked independently against broad house scale limits, not accepted because all companies share it.',
      extremeCurve.slice(0, 6).map(x => `${x.year}/${x.term} years: ${fmt(x.rate)}m/IT MW-year`).join('; '),
      [evidence('Model shared curve: researchPricing.curve')], 'Verify dollar scale, power denominator and annual-versus-quarter units.', extremeCurve);
    const spotSteps = Object.entries(P.spot?.rates || {}).sort(([a], [b]) => +a - +b).flatMap(([year, rate], i, all) => {
      if (!i) return [];
      const previous = all[i - 1], r = typeof rate === 'number' ? rate : rate.rate, prior = typeof previous[1] === 'number' ? previous[1] : previous[1].rate;
      return positive(prior) && Math.abs(r / prior - 1) > .5 ? [{ year, previousYear: previous[0], rate: r, prior }] : [];
    });
    if (spotSteps.length && last.revSpot > 0) add(c, 'economics', 'spot-price-step', 'review', 'The shared spot curve contains a large price step',
      'A greater-than-50% adjacent-year change in the same quoted spot unit needs a hardware, product-mix or market-pricing explanation. Generation multipliers do not independently substantiate the base step.',
      spotSteps.map(x => `${x.previousYear} $${fmt(x.prior)} → ${x.year} $${fmt(x.rate)} (${fmt((x.rate / x.prior - 1) * 100)}%); basis ${P.spot.basis}`).join('; '),
      [evidence(`Model spot assumption: ${P.spot.note || 'house curve'}`)],
      'Source realized forward spot prices by generation and clarify ancillary-services comparability; review the 20% spot-price sensitivity.',
      { spot: P.spot, earningSpotRevenue: last.revSpot }, scenario(c, m, { spotMult: .8 }, '20% lower spot pricing'));
    if (last.revRenewal > 0) {
      const renewal = { retention: P.renewal?.retention, rateMultiplier: P.renewal?.rateMultiplier, rateMode: P.renewal?.rateMode };
      // ramp-core's retention delta is absolute, so use 80% of the LOWEST effective
      // policy across all tranches. A company/contract override must never be raised
      // accidentally by a purported retention stress.
      const effectiveRetentions = T.map(t => ({ id: t.id || t.n,
        value: { retention: 1, ...P.renewal, ...c.ramp.pricing.renewal, ...t.contract?.renewal }.retention }));
      const minimumRetention = Math.min(...effectiveRetentions.map(t => t.value));
      const stressedRetention = minimumRetention * .8;
      const stressLabel = `Renewal retention capped at ${fmt(stressedRetention * 100)}%; renewed prices 20% lower`;
      const renewalScenario = scenario(c, m, { renewalRetention: stressedRetention, renewalRateMult: .8 }, stressLabel);
      add(c, 'economics', 'same-hardware-renewal', 'review', 'Same-hardware renewals materially support future revenue',
        'The model allows renewal without purchasing a replacement fleet at each expiry. The common policy assumes full retention and original rates when both multipliers are 1; company or contract overrides must also be examined. The terminal refresh reserve is a separate assumption.',
        `${last.lbl} annualized renewal revenue $${fmt(last.revRenewal * .004)}bn (${fmt(last.revRenewal / last.rev * 100)}% of total); common retention ${fmt(renewal.retention * 100)}%, rate multiplier ${fmt(renewal.rateMultiplier)}.`,
        [evidence(`Model renewal policy: ${P.renewal?.basis || 'house assumption'}`), ...commonSources],
        `Review customer retention, equipment-age pricing and maintenance cost together. The stress sets retention to 80% of the lowest effective cohort assumption (${fmt(minimumRetention * 100)}% → ${fmt(stressedRetention * 100)}%) and reduces renewed prices by 20%.`,
        { renewal, effectiveRetentions, overrides: T.map(t => t.contract?.renewal || null), company: c.ramp.pricing.renewal, tranches: T, steady: c.page.steadyInputs },
        renewalScenario);
      if (renewalScenario.impact?.delta > 0) add(c, 'economics', 'renewal-spot-substitution', 'review', 'Losing renewals increases modeled value through spot resale',
        'The canonical model moves non-renewed capacity into spot with the contracted ramp fraction. High assumed spot rates and the resulting revenue mix can offset lost renewals. This is a commercial re-leasing assumption, not a guaranteed downside cushion.',
        `${fmt(stressedRetention * 100)}% retention and 20% lower renewed prices move value from $${fmt(m.W.ps)} to $${fmt(renewalScenario.impact.alternative)} per share (${fmt(renewalScenario.impact.pct)}%). Retention is never increased for any modeled cohort.`,
        [evidence(`Shared spot assumption: ${P.spot?.note || 'house curve'}`), evidence('Canonical ramp rule: displaced renewal share enters spot at contracted ramp fraction')],
        'Source achievable spot rates on the same aging equipment and model vacancy/re-leasing delay before crediting instant spot resale.',
        { spot: P.spot, tranches: T, renewal }, renewalScenario);
    }
    const steady = m.pg.steady.inputs;
    const reserve = steady.gpu * steady.swap / steady.life + steady.gpu * steady.fail;
    const shell = steady.shell / steady.shellLife;
    const tax = Math.max(0, steady.rev * steady.M - steady.gpu * steady.swap / steady.life - shell) * steady.tax;
    row.metrics.normalizedCashPerEarningITMWM = steady.rev * steady.M - reserve - shell - tax;
    row.metrics.maintenanceReservePerITMWM = reserve + shell;
    if (!finite(row.metrics.normalizedCashPerEarningITMWM) || row.metrics.normalizedCashPerEarningITMWM < 0) add(c, 'economics', 'replacement-economics', 'review', 'Normalized cash earnings do not cover replacement economics',
      'Revenue must support operating costs, equipment replacement, shell maintenance and tax. A positive revenue multiple alone cannot establish a positive underlying cash return.',
      `Annualized revenue ${fmt(steady.rev)}m/MW, cash margin ${fmt(steady.M * 100)}%, maintenance ${fmt(reserve + shell)}m/MW; normalized cash ${fmt(row.metrics.normalizedCashPerEarningITMWM)}m/MW.`,
      [evidence(`Terminal equipment assumptions: ${steady.basis || 'house model'}`)],
      'Reconcile fleet life, replacement price, productivity and margins.', steady);
    if (steady.g > 0 && steady.gY > 0) {
      const mult = OP.steadyMultiple({ ...steady, g: 0 }).blend + (m.F.MULT_PREMIUM || 0);
      add(c, 'economics', 'terminal-price-growth', 'review', 'Post-horizon price growth lifts the terminal multiple',
        'Forward growth after the explicit forecast is a house assumption. It needs support from generation productivity, replacement cost and realized pricing; consistent application alone does not validate it.',
        `${fmt(steady.g * 100)}% annual market price growth for ${steady.gY} years; DCF/house multiple ${fmt(m.F.MULT)}× annualized quarter revenue.`,
        [evidence(`Model terminal economics: ${steady.basis || 'house assumption'}`)],
        'Review flat post-horizon pricing alongside equipment refresh and margin assumptions.', { steady, premium: m.F.MULT_PREMIUM || 0 },
        waterfall(m, { mult }, 'Flat post-horizon prices, existing refresh assumptions'));
    }
    const invalidCapex = Object.entries(m.CAPQ).filter(([, costs]) => !Array.isArray(costs) || costs.length !== 2 || costs.some(v => !finite(v) || v < 0));
    if (invalidCapex.length) add(c, 'funding', 'capex-inputs', 'error', 'Capex includes invalid or negative purchase costs',
      'GPU and shell purchase costs are cash uses in USD millions; negative capex would create artificial liquidity.',
      invalidCapex.map(([q, costs]) => `${q}: ${JSON.stringify(costs)}`).join('; '), src,
      'Reconcile the purchase schedule and monetary units.', invalidCapex);
    const series = F.SERIES || [], seriesTotal = sum(series, s => s[0]);
    if (series.some(s => !positive(s[0]) || !positive(s[1]) || (s[2] != null && s[2] < s[1])) || Math.abs(seriesTotal - (F.CONV || 0)) > .002) add(c, 'funding', 'convertible-principal', 'error', 'Convertible series do not reconcile to excluded debt',
      'The principal removed from ordinary debt must match the convertible register; strikes and capped-call caps require valid terms.',
      `Series $${fmt(seriesTotal, 4)}bn vs convertible balance $${fmt(F.CONV || 0, 4)}bn.`, [evidence(`Model finance assumptions: ${F.basis || 'missing'}`)],
      'Reconcile each series, accreted principal, settlement terms and capped calls.', { series, CONV: F.CONV });
    const unconverted = series.filter(s => funding.S <= s[1]);
    if (unconverted.length) add(c, 'funding', 'unconverted-debt-claim', 'error', 'Out-of-money convertibles may disappear from both claims and shares',
      'The canonical waterfall removes total convertible principal from ordinary debt but only adds shares above each conversion strike. An out-of-money series still requires an explicit repayment/refinancing claim.',
      `Horizon price $${fmt(funding.S)}; ${unconverted.length} series totaling $${fmt(sum(unconverted, s => s[0]))}bn do not convert under that price.`,
      [evidence(`Convertible settlement assumption: ${F.basis || 'model finance'}`)],
      'Review cash redemption and maturity treatment before adopting the valuation.', { series, horizonPrice: funding.S, CONV: F.CONV },
      waterfall(m, { convAsDebt: true }, 'All convertibles carried as debt (bounding case)'));
    const badLiquidity = forward.filter(q => !finite(q.r.cash) || q.r.cash < F.MINCASH - .000001 || !positive(q.r.sh));
    if (badLiquidity.length) add(c, 'funding', 'cash-floor', 'error', 'Quarterly funding fails liquidity or share-count constraints',
      'Every projected quarter requires finite cash at the stated minimum and a positive share count.',
      badLiquidity.map(q => `${q.q}: cash $${fmt(q.r.cash)}bn, shares ${fmt(q.r.sh)}m`).join('; '), src,
      'Reconcile funding sources, uses and issuance mechanics.', badLiquidity.map(q => ({ q: q.q, cash: q.r.cash, sh: q.r.sh })));
    const draw = sum(forward, q => q.r.draw) / 1000, pre = sum(forward, q => q.r.pre) / 1000;
    add(c, 'funding', 'committed-financing-evidence', 'gap', 'An automatically funded forecast does not establish financing availability',
      'The waterfall fills residual funding needs with assumed borrowing and equity. Aggregate advance rates and prepayment ratios do not verify committed facilities, collateral eligibility, maturity dates, covenants or project cash restrictions.',
      `Forecast gross draws $${fmt(draw)}bn + customer cash receipts $${fmt(pre)}bn + equity $${fmt(funding.eqTot)}bn; diluted shares ${fmt(funding.dil)}m; ending net debt $${fmt(funding.last.nd)}bn.`,
      [evidence(`Model funding: ${F.basis || 'house assumptions'}`), evidence(`Customer credits: ${F.prepay?.basis || 'house assumptions'}`)],
      'Map draws to facility commitments and maturity schedules; identify residual financing that is still assumed.',
      { F, capex: m.CAPQ, draw, pre, equity: funding.eqTot });
    const price = engine.priceOf(c);
    const markDate = markSet.priceDates?.[c.tk], markAgeDays = markDate && finite(Date.parse(markDate)) ? (Date.parse(asOf.slice(0, 10)) - Date.parse(markDate.slice(0, 10))) / 86400000 : null;
    if (!positive(engine.ctx.prices[c.tk]) || markAgeDays == null || markAgeDays > 4 || markAgeDays < 0) add(c, 'funding', 'reference-price-evidence', 'gap', 'Issuance sensitivity lacks a current dated market reference',
      'The model can calculate from a fallback price, but an undated, stale or future-dated reference cannot support a current funding-price comparison. The four-calendar-day band is a review convention, not a trading-calendar service.',
      `Price $${fmt(price)}; provider date ${markDate || 'unavailable'}; ${row.metrics.priceBasis}.`,
      [evidence('Supplied market snapshot and fallback data.json price')],
      'Refresh the shared market snapshot and retain the provider timestamp for this company.', { price, markDate: markDate || null, basis: row.metrics.priceBasis });
    if (funding.eqTot > .001 && positive(price) && Math.abs(F.EQ_PX / price - 1) > .10) add(c, 'funding', 'equity-issuance-price', 'review', 'Future equity is issued at a materially different price from the reference mark',
      'A fixed future issuance price changes how much of the funded operating outcome belongs to each share. The current reference mark is a sensitivity, not a forecast of future execution.',
      `$${fmt(funding.eqTot)}bn raised at $${fmt(F.EQ_PX)} vs reference mark $${fmt(price)}; ${fmt(funding.issued)}m shares issued in the base.`,
      [evidence(`Model equity assumption: ${F.basis || 'page.finance.EQ_PX'}`), evidence(`Reference price: supplied quote if available; otherwise data.json price $${fmt(price)}`)],
      'Review issuance pricing and access to capital; compare the reference-price sensitivity.', { price, equityPrice: F.EQ_PX, equity: funding.eqTot, finance: F },
      waterfall(m, { eqPx: price }, 'Equity issued at the reference share price'));
    if (F.CASH_R > 0) add(c, 'funding', 'restricted-cash', 'review', 'Restricted cash is available to the modeled funding pool',
      'The funding waterfall includes restricted cash alongside opening cash. Release conditions and project boundaries need evidence before treating it as interchangeable liquidity.',
      `$${fmt(F.CASH_R)}bn restricted cash included with $${fmt(F.CASH0)}bn opening unrestricted cash.`,
      [evidence(`Model opening cash: ${F.basis || 'page.finance.CASH_R'}`)],
      'Confirm permitted uses and release timing; review the excluded-restricted-cash case.', { restricted: F.CASH_R, finance: F },
      waterfall(m, { noRestricted: true }, 'Restricted cash excluded from funding'));
    const seriesEvidence = F.basis || '';
    if (/accret/i.test(seriesEvidence)) add(c, 'funding', 'accreting-convertibles', 'review', 'Accreting convertible principal is not a dated claim schedule',
      'The finance basis describes accretion, while the numeric series contain principal, strike and cap only. This does not independently establish the claim or conversion ratio at each maturity.',
      `Numeric series principal $${fmt(seriesTotal)}bn; dated accretion and settlement schedule unavailable.`, [evidence(seriesEvidence)],
      'Map accreted redemption/conversion amounts and maturities series by series; propose a change only after sourcing the terms.', { series, basis: seriesEvidence });
  }

  // Relative pricing is a review trigger only within matched research GPU operators.
  const eligiblePeers = companies.filter(c => models.has(c.ticker) && positive(c.metrics.contractRevenuePerEarningITMWM));
  const horizons = [...new Set(eligiblePeers.map(c => c.metrics.horizonQuarter))];
  for (const horizon of horizons) {
    const peers = eligiblePeers.filter(c => c.metrics.horizonQuarter === horizon);
    if (peers.length < 3) continue;
    const rates = peers.map(c => c.metrics.contractRevenuePerEarningITMWM).sort((a, b) => a - b);
    const median = rates[Math.floor(rates.length / 2)];
    for (const row of peers) if (Math.abs(row.metrics.contractRevenuePerEarningITMWM / median - 1) > policy.thresholds.peerRevenueDeviation) {
      const c = data.companies.find(c => c.tk === row.ticker), v = row.metrics.contractRevenuePerEarningITMWM;
      add(c, 'economics', 'matched-peer-price', 'review', 'Contract revenue per earning MW differs materially from research peers',
        'Hardware, legacy contract vintage, tenant terms, geography and ancillary services can explain the difference. Equal prices are not imposed and landlord NOI is excluded.',
        `${row.metrics.horizonQuarter}: $${fmt(v)}m/contracted earning IT MW vs peer median $${fmt(median)}m (${fmt((v / median - 1) * 100)}%).`,
        [evidence('Canonical research outputs, matched annualized quarter contract revenue and effective contracted earning IT MW')],
        'Explain the difference with contract and fleet composition; investigate unsupported residuals.',
        peers.map(p => [p.ticker, p.metrics.horizonQuarter, p.metrics.contractRevenuePerEarningITMWM]));
    }
  }
  // A gap always prevents a green pass, even when arithmetic is internally consistent.
  for (const c of companies) for (const family of FAMILIES) {
    const fs = findings.filter(f => f.ticker === c.ticker && f.family === family);
    const status = fs.some(f => f.severity === 'error') ? 'error' : fs.some(f => f.severity === 'review') ? 'review' : fs.some(f => f.severity === 'gap') ? 'insufficient' : c.tests[family].status;
    c.tests[family] = { status, summary: fs.length ? `${fs.filter(f => f.severity === 'error').length} errors, ${fs.filter(f => f.severity === 'review').length} reviews, ${fs.filter(f => f.severity === 'gap').length} coverage gaps. ${status === 'insufficient' ? 'Arithmetic consistency does not establish economic validity.' : ''}`.trim() : c.tests[family].summary };
  }
  const rank = { error: 0, review: 1, gap: 2 };
  findings.sort((a, b) => rank[a.severity] - rank[b.severity] || Math.abs(b.impact?.pct || 0) - Math.abs(a.impact?.pct || 0) || a.id.localeCompare(b.id));
  const output = { ruleVersion: RULE_VERSION, asOf, summary: { companies: companies.length, findings: findings.length,
    errors: findings.filter(f => f.severity === 'error').length, reviews: findings.filter(f => f.severity === 'review').length,
    gaps: findings.filter(f => f.severity === 'gap').length }, companies, findings, policy };
  // Non-finite diagnostics remain explicitly unavailable in the JSON artifact.
  return JSON.parse(JSON.stringify(output, (key, v) => typeof v === 'number' && !finite(v) ? null : v));
}
module.exports = { RULE_VERSION, analyze };
