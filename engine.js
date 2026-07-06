/* Shared valuation engine — ONE source of truth (spec §5), run by both:
   - app.js (browser dashboard, live dials)
   - portfolio-run.js / portfolio-backtest.js (node, paper portfolio §6b)
   The math is identical everywhere; never fork it. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Engine = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  // data = parsed data.json; opts.now = decimal-year as-of date (defaults to config reference date)
  function createEngine(data, opts) {
    opts = opts || {};
    const CFG = data.config;
    const YEAR = CFG.referenceYear;
    const NOW = (opts.now != null) ? opts.now : CFG.referenceYear + ((CFG.referenceMonth || 1) - 1) / 12;
    const HORIZON = CFG.horizon;
    const BASE = { ...CFG.dials };
    const A = { ...CFG.dials };                    // mutable dials (browser sliders write here)
    const SLIDERS = CFG.sliders;
    const REGION = CFG.regions;
    const CONST = CFG.constants;
    const TIERS = CFG.tiers || {};
    const PROV = {}, PROV_OP = {};
    Object.entries(CFG.provenance).forEach(([k, v]) => { PROV[k] = v.haircut; PROV_OP[k] = v.opacity; });
    const COMPANIES = data.companies;
    const ctx = { prices: {}, btc: null, eth: null };  // live market inputs (per-ticker price map + crypto spots)

    function priceOf(c){const p=ctx.prices[c.tk];return (typeof p==='number'&&p>0)?p:c.price;}
    function btcPrice(){return ctx.btc||CFG.btcFallback||60000;}
    function ethPrice(){return ctx.eth||CFG.ethFallback||3000;}
    // Look-through value of a controlling stake in another tracked name (SOTP holdcos, e.g. BTBT → WhiteFiber).
    // pct × that company's modeled equity; auto-updates as the held company's inputs/price move (the "routine").
    function stakeValue(c){if(!c.stake)return 0;const t=COMPANIES.find(x=>x.tk===c.stake.tk);if(!t)return 0;const v=value(t);
      const dil=v.fundedShares>0?t.shares/v.fundedShares:1;                      // ownership dilutes through the held company's planned raise
      const eq=(c.stake.pct>0.5&&v.equityPre!=null)?v.equityPre:v.equity;       // a CONTROLLING stake doesn't inherit the minority discount its own control created
      return (c.stake.pct||0)*dil*eq;}
    // Legacy/non-core EV = BTC + ETH treasuries (marked live) + look-through stakes + a non-crypto residual (mining/software).
    function legacyOf(c){return (c.btc||0)*btcPrice()/1e6+(c.eth||0)*ethPrice()/1e6+stakeValue(c)+(c.legacyEV||0);}

    function prevailingRate(yrs){return A.rate*Math.pow(1+(A.rateTrend||0)/100,Math.max(0,yrs));}
    function ownerRate(c){return c&&c.signedRate?c.signedRate:A.rate;}
    // Vintage-rate model (spec §4): $/MW·yr is priced at the rate prevailing when capacity is
    // contracted/energized, and that rate trends over time (the "GPU rate trend" dial). The CONTRACTED
    // share is locked at today's rate; the UNCONTRACTED share floats to the future prevailing rate at
    // its energization vintage — so in a rising-rate world unsold capacity is the upside, not a spot
    // haircut. `contracted %` remains the company number; rumored sites are 100% uncontracted (no lock).
    function effTrend(){return Math.min(A.rateTrend||0,(A.disc||10)-2);}  // landlord RENT trend, guardrailed (uncontracted real discount ≥2%/yr)
    function gpuTrendEff(){return Math.min(A.gpuTrend!=null?A.gpuTrend:(A.rateTrend||0),(A.disc||10)-2);}  // owner GPU $/MW GENERATION curve (decoupled from rents), same guardrail
    // Signed compute book (owner contract registry): the $-weighted rate of the signed take-or-pay book.
    // Contracts are DOLLARS+TERM facts; MW is often inference — so the company carries a `signedRate`
    // ($/MW·yr, basis-noted, checks-reconciled vs the registry) rather than per-contract rate binding.
    function signedRateOf(c){return c.signedRate||A.rate;}
    function genAccessOf(c){return c.genAccess!=null?c.genAccess:1;}       // frontier-allocation factor on UNSIGNED/re-sign rates (1.0 = frontier access)
    function leaseUp(){return A.leaseUp!=null?A.leaseUp:1;}               // lease-up / spot realization on the uncontracted slice (base 1.0 = scarcity view: energized capacity gets rented; 0.42 = consensus spread)
    function siteRates(c,s){
      // lock = share of capitalized value inside the signed window: term ÷ capitalization years (≈ the multiple).
      // A 5-yr compute book on a ~7-yr capitalization leaves ~30% of every contracted MW's value at the
      // RE-SIGNING — priced off the generation curve. That terminal slice is how rising $/MW enters over time.
      const capYears=Math.max(A.multiple||7,1);
      const lock=Math.min(c.termYrs/capYears,1);
      const cf=(s.prov==='rumored')?0:(c.contractedPct/100);
      const ls=lock*cf;
      const rm=(REGION[s.region]&&REGION[s.region].rateMul)||1;   // geography rate factor (US 1.0, EU/AU < 1)
      const yrs=Math.max(0,s.yr+((s.mo||1)-1)/12-NOW);
      const prevailing=A.rate*rm*Math.pow(1+gpuTrendEff()/100,yrs)*genAccessOf(c);  // gen-curve rate at this vintage, for this operator's silicon access
      const contractedRate=ls*signedRateOf(c)*rm, spotRate=(1-ls)*prevailing*leaseUp();
      return{eff:contractedRate+spotRate,contractedRate,spotRate,prevailing,yrs,lock,signedRate:signedRateOf(c)};
    }
    function tierOf(c){return TIERS[c.tier]||TIERS.proven||{name:'—',capSpread:0,multFactor:1};}
    // anchor-scale premium on FORWARD space only: big blocks print richer than small retrofits (observed across signed deals)
    function sizeFactor(mw){if(mw<(CONST.sizeSmallMW||100))return CONST.sizeSmallF||0.9;if(mw>(CONST.sizeLargeMW||300))return CONST.sizeLargeF||1.1;return 1;}
    function leaseOf(c,s){if(!s.leaseId)return null;const l=(c.leases||[]).find(x=>x.id===s.leaseId);return (l&&l.effective!==false)?l:null;}
    function siteValue(c,s){const r=REGION[s.region];const tier=tierOf(c);let ppm,contractedShare,calc;
      // site-aware contracted share: rumored capacity has no contracts, so it earns NO contract premium / cap compression
      const cs0=(s.prov==='rumored')?0:(c.contractedPct/100);
      if(c.model==='landlord'){
        const lease=leaseOf(c,s);
        if(lease){
          // SIGNED lease — a fact, not a model: actual TERM-AVERAGE NOI (escalators embedded), fully contracted.
          const noi=lease.noiPerMWyr;
          const cap=Math.max(((A.capRate+tier.capSpread)/100)*(1-CONST.capCompress),(CONST.capFloor||6.5)/100);
          ppm=noi/cap;contractedShare=1;calc={noi,cap,leased:true,counterparty:lease.counterparty,kind:lease.kind};
        }else{
          // FORWARD space — market anchor × grid(region) × size × lease-up × trend to vintage. The anchor prices only what's unsigned.
          const vyrs=Math.max(0,s.yr+((s.mo||1)-1)/12-NOW);const escal=Math.pow(1+effTrend()/100,vyrs);
          const baseNOI=CONST.landlordNOI*r.lNOI*(s.owned?CONST.ownedLNOI:CONST.leasedLNOI)*sizeFactor(s.physMW||s.mw);  // physMW: physical block size when row MW is an economic slice (JVs)
          const noi=baseNOI*leaseUp()*escal;
          const cap=Math.max(((A.capRate+tier.capSpread)/100),(CONST.capFloor||6.5)/100);   // no compression without a signed lease
          ppm=noi/cap;contractedShare=0;calc={noi,cap,baseNOI,prevailingNOI:baseNOI*escal,leased:false};
        }}
      else{const R=siteRates(c,s);const m=A.margin+r.cMargin+(s.owned?CONST.ownedCMargin:CONST.leasedCMargin);const mult=A.multiple*tier.multFactor*(1+CONST.multPremium*cs0);ppm=R.eff*(m/100)*mult;
        contractedShare=R.eff>0?R.contractedRate/R.eff:0;calc={eff:R.eff,m,mult,prevailing:R.prevailing};}
      const dr=A.disc,gross=ppm*s.mw;
      let hair=PROV[s.prov];if(s.prov==='rumored')hair*=(A.pipelineCredit!=null?A.pipelineCredit:1);  // rumored-pipeline credit dial
      const t=s.yr+((s.mo||1)-1)/12;
      // ramp (commissioning/fill) applies only to the UNCONTRACTED share — take-or-pay leases bill from commencement
      const yrsC=Math.max(0,t-NOW),yrsU=Math.max(0,t+(A.ramp||0)/12-NOW),yrs=yrsU;
      const dfac=contractedShare/Math.pow(1+dr/100,yrsC)+(1-contractedShare)/Math.pow(1+dr/100,yrsU);
      const ev=gross*hair*dfac;
      return{gross,ev,contractedEV:ev*contractedShare,expectedEV:ev*(1-contractedShare),hair,yrs,dfac,ppm,contractedShare,dr,calc};}
    function value(c){let ev=0,cEV=0,eEV=0;const segs=[];c.sites.forEach(s=>{const sv=siteValue(c,s);ev+=sv.ev;cEV+=sv.contractedEV;eEV+=sv.expectedEV;segs.push({s,...sv});});ev+=legacyOf(c);
      // claims senior to common: net debt + ISSUED project bonds funding credited sites (committedDebt, even if escrowed) + drawn preferred/NCI (seniorClaims)
      const claims=c.netDebt+(c.committedDebt||0)+(c.seniorClaims||0);
      const equityPre=ev-claims,equity=equityPre*(1-(c.equityDiscount||0)),px=priceOf(c);
      // Funding dilution: charge only the REALISTIC equity each name actually issues (its ATM / telegraphed
      // raises, `plannedRaise`), NOT full build capex — the rest is debt / prepayments / project finance, and a
      // revenue multiple already embeds capital intensity. New shares raised at the live price; a global
      // `dilutionStress` dial scales every planned raise. Built-out equity is spread over the funded share count.
      const equityRaise=(c.plannedRaise||0)*(A.dilutionStress!=null?A.dilutionStress:1);
      const newShares=px>0?equityRaise/px:0, fundedShares=c.shares+newShares;
      const target=equity/fundedShares;
      return{ev,equity,equityPre,claims,contractedEV:cEV,expectedEV:eEV,target,upside:target/px-1,price:px,segs,equityRaise,newShares,fundedShares};}

    return { A, BASE, ctx, CFG, YEAR, NOW, HORIZON, SLIDERS, REGION, CONST, TIERS, PROV, PROV_OP, COMPANIES,
             priceOf, btcPrice, ethPrice, stakeValue, legacyOf, prevailingRate, ownerRate, effTrend, leaseUp,
             sizeFactor, leaseOf, gpuTrendEff, signedRateOf, genAccessOf, siteRates, tierOf, siteValue, value };
  }

  return { createEngine };
});
