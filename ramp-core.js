/* Shared GPU-ramp math — ONE source of truth for the quarterly build-out (spec §6 screen 11, §6e), run by both:
   - app.js (browser: the GPU RAMP tab)
   - onepager.js (node: the research pages)
   Feeds the dated research valuations and delivery views; the broad asset engine never reads it. Never fork it. */
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else Object.assign(root, m);
})(typeof self !== 'undefined' ? self : this, function () {
const RAMP_QS=l=>{const y=+l.slice(0,4),q=+l.slice(5);return (y-2026)*4+q;};
const RAMP_QL=s=>{const i=s-1;return `${2026+Math.floor(i/4)}Q${(((i%4)+4)%4)+1}`;};
const RAMP_START=3,RAMP_END=20,RAMP_HIST=-1,RAMP_CONS_HARD=14;   // consensus is a hard comparator to 2029Q2 (serial 14); indicative beyond   // window 2026Q3..2030Q4; backtest runs from 2025Q3
// apply a scenario delta to one tranche (pure; base returns the tranche unchanged)
function rampApplySc(t,d){
  if(!d||!Object.keys(d).length)return t;
  const o={...t};
  if(d.rateCap!=null)o.rate=Math.min(t.rate,d.rateCap);
  if(d.rateMult)o.rate=t.rate*d.rateMult;
  if(d.genDensity&&d.genDensity[t.gen])o.gpus=Math.round(t.gpus*d.genDensity[t.gen]);
  if(d.vintageMult&&d.vintageMult[t.energize.slice(0,4)]!=null)o.rate=o.rate*d.vintageMult[t.energize.slice(0,4)];   // per-vintage (energise-year) rate multiplier — scenario only
  if(d.genRateCap&&d.genRateCap[t.gen]!=null&&!(t.signed>=1))o.rate=Math.min(o.rate,d.genRateCap[t.gen]);   // per-generation $/GPU-hr cap — scenario only
  if(d.ctrMult!=null){const sg=t.signed||0;o.ctr=sg+(t.ctr-sg)*d.ctrMult;}
  if(d.slipQtrs){const from=d.from!=null?d.from:-99;
    if(RAMP_QS(t.energize)>=from){o.energize=RAMP_QL(RAMP_QS(t.energize)+d.slipQtrs);o.rev=RAMP_QL(RAMP_QS(t.rev)+d.slipQtrs);}}
  return o;
}
function rampLegacyQuarters(R,sc,from,to){
  const d={...((sc&&sc.d)||{})};
  const cal=d.cal!=null?d.cal:((R.calibration&&R.calibration.rampMult)||1);
  const YR=s=>2026+Math.floor((s-1)/4);   // serial 1 = 2026Q1 … 20 = 2030Q4
  const spotOf=s=>{const base=R.spot[String(d.spotFlat?2026:YR(s))]||0;return base*(d.spotMult||1);};
  const TR=R.tranches.map(t=>rampApplySc(t,d));
  const out=[];
  const s0=from!=null?from:RAMP_START, s1=to!=null?to:RAMP_END;
  for(let s=s0;s<=s1;s++){
    const by={hopper:0,blackwell:0,rubin:0,next:0},rv={hopper:0,blackwell:0,rubin:0,next:0},camps={};
    let cum=0,prev=0,signed=0,ctr=0,rev=0,revC=0,revS=0;
    TR.forEach(t=>{
      const rs=RAMP_QS(t.rev),um=(d.rampMult||1)*cal;
      const ff=(k,n)=>Math.min(Math.max(k/n,0),1);
      // contracted share bills from acceptance; uncontracted share ramps at the backtested (slower) rate
      const mix=(k)=>t.ctr*ff(k,Math.max(1,Math.ceil(t.rampQtrs*(d.rampMult||1))))+(1-t.ctr)*ff(k,Math.max(1,Math.ceil(t.rampQtrs*um)));
      const f=mix(s-rs+1),f0=mix(s-rs);
      if(f<=0)return;const live=t.gpus*f;
      by[t.gen]+=live;cum+=live;prev+=t.gpus*f0;signed+=live*(t.signed||0);ctr+=live*t.ctr;camps[t.campus]=1;
      let vr=t.rate;
      if(t.renew&&t.renew.q&&s>=RAMP_QS(t.renew.q)&&!(d&&d.noRenew))vr=t.renew.rate;   // optional re-contracting at the end of the original term
      if(d.vintageDecay){const age=Math.max(0,(s-RAMP_QS(t.rev))/4);vr=t.rate*Math.pow(1-d.vintageDecay,age);}
      // Storage / CPU / networking / managed layer rides on top of the GPU hour. UNSIGNED tranches only:
      // their rates are market GPU-RENTAL prints so attach is additive, whereas every signed rate was
      // back-solved from ALL-IN contract dollars and already contains it. Applying it to signed capacity
      // would double-count and would break the retrodiction.
      const at=(t.signed>0)?1:1+(R.attach||0);
      const er=(t.ctr*vr+(1-t.ctr)*spotOf(s)*(R.spotMult[t.gen]||1))*at;
      const rq=live*er*2190/1e6;rv[t.gen]+=rq;rev+=rq;
      revC+=live*t.ctr*vr*at*2190/1e6; revS+=live*(t.signed||0)*vr*2190/1e6;});
    const grossMW=TR.filter(t=>RAMP_QS(t.energize)<=s).reduce((a,t)=>a+t.grossMW,0);
    const itCom=TR.filter(t=>RAMP_QS(t.energize)<=s).reduce((a,t)=>a+t.itMW,0);
    const itMW=TR.reduce((a,t)=>{const rs=RAMP_QS(t.rev),um=(d.rampMult||1)*cal;
      const ff=(k,n)=>Math.min(Math.max(k/n,0),1);
      const f=t.ctr*ff(s-rs+1,Math.max(1,Math.ceil(t.rampQtrs*(d.rampMult||1))))+(1-t.ctr)*ff(s-rs+1,Math.max(1,Math.ceil(t.rampQtrs*um)));
      return a+t.itMW*f;},0);
    const lbl=RAMP_QL(s);const cons=(R.consensus||{})[lbl]||null;
    out.push({s,lbl,by,rv,cum,added:cum-prev,signed,ctr,rev,revC,revS,grossMW,itCom,itMW,nCamps:Object.keys(camps).length,
      mining:(R.mining||{})[lbl]||0,consTot:cons?cons[0]:null,consAI:cons?cons[1]:null,
      blend:cum>0?rev*1e6/(cum*2190):0});}
  return out;
}
// Research pricing is opt-in. Values on the shared curve are ALL-IN $m / IT MW / year.
// An end quarter is exclusive: a contract ending 2029Q1 earns its original rate through 2028Q4.
const clamp=x=>Math.max(0,Math.min(1,x));
const annualHours=8760,quarterHours=2190;
function rampMarketPrice(market,year,termYears,gen){
  const curve=market&&market.curve;
  if(!curve||!Object.keys(curve).length)throw Error('Research pricing requires a shared market curve');
  const years=Object.keys(curve).map(Number).filter(Number.isFinite).sort((a,b)=>a-b);
  const curveYear=years.filter(y=>y<=year).at(-1)??years[0];
  const tenors=Object.keys(curve[curveYear]).map(Number).filter(Number.isFinite).sort((a,b)=>a-b);
  if(!tenors.length)throw Error('Research pricing curve has no tenors for '+curveYear);
  const curveTerm=tenors.reduce((best,t)=>Math.abs(t-termYears)<Math.abs(best-termYears)?t:best,tenors[0]);
  const cell=curve[curveYear][curveTerm],raw=typeof cell==='number'?cell:cell.rate;
  if(!Number.isFinite(raw)||raw<0)throw Error('Invalid market price for '+curveYear+' / '+curveTerm);
  const factor=market.generationFactors&&market.generationFactors[gen]!=null?market.generationFactors[gen]:1;
  return {rate:raw*factor,curveYear,curveTerm,genFactor:factor,
    fallback:curveYear!==year||curveTerm!==termYears,source:cell.source||market.source||null,
    asOf:cell.asOf||market.asOf||null,priceBasis:cell.priceBasis||'house-assumption'};
}
function researchTerm(value,fallback,label){
  const term=value??fallback;
  if(!Number.isFinite(term)||term<=0||!Number.isInteger(term*4))throw Error('Invalid '+label+' term: '+term);
  return term;
}
function researchRate(rate,t,d,isExisting,age){
  // rate is $ / GPU-hour. Apply each scenario once, to earned revenue AND ARR.
  if(d.rateCap!=null)rate=Math.min(rate,d.rateCap);
  if(d.rateMult!=null)rate*=d.rateMult;
  if(d.vintageMult&&d.vintageMult[t.energize.slice(0,4)]!=null)rate*=d.vintageMult[t.energize.slice(0,4)];
  if(!isExisting&&d.genRateCap&&d.genRateCap[t.gen]!=null)rate=Math.min(rate,d.genRateCap[t.gen]);
  if(d.vintageDecay)rate*=Math.pow(1-d.vintageDecay,Math.max(0,age));
  return rate;
}
function rampPricedTranche(R,original,s,market,d){
  const t={...rampApplySc(original,d)},cfg=R.pricing||{},contract=original.contract||{},future=original.newBusiness||{};
  // Unmapped future capacity has no verified customer-book allocation. Its legacy assignment is an explicit scenario only.
  const legacyAllocation=d.legacyBookAllocation&&contract.allocationBasis==='unmapped-future';
  const signedShare=legacyAllocation?(original.signed||0):(contract.signedShare??original.signed??0);
  if(d.ctrMult!=null)t.ctr=signedShare+(original.ctr-signedShare)*d.ctrMult;
  const policy={termYears:3,retention:1,rateMode:'retain',rateMultiplier:1,...market.renewal,...cfg.renewal,...contract.renewal};
  if(d.renewalRetention!=null)policy.retention=d.renewalRetention;
  const term=researchTerm(contract.termYears,cfg.defaultTermYears??5,'existing contract');
  const newTerm=researchTerm(d.newTermYears??future.termYears,cfg.defaultTermYears??5,'new business');
  const renewalTerm=researchTerm(policy.termYears,term,'renewal');
  if(policy.retention<0||policy.retention>1)throw Error('Renewal retention must be between 0 and 1');
  const rs=RAMP_QS(t.rev),effective=RAMP_QS(cfg.effectiveQ||market.effectiveQ||'2026Q3');
  // A disclosed calendar expiry remains fixed; estimated expiries follow the modeled delivery date.
  const end=contract.endQ?RAMP_QS(contract.endQ)+(contract.expiryBasis==='disclosed'?0:rs-RAMP_QS(original.rev)):rs+term*4;
  const newStart=Math.max(rs,effective),newEnd=newStart+newTerm*4;
  if(signedShare<0||signedShare>1||t.ctr<signedShare-1e-9||t.ctr>1||t.ctr<0)throw Error('Invalid contract shares: '+t.n);
  const newShare=Math.max(0,t.ctr-signedShare),baseSpotShare=1-t.ctr;
  const cal=d.cal??R.calibration?.rampMult??1;
  const fContract=clamp((s-rs+1)/Math.max(1,Math.ceil(t.rampQtrs*(d.rampMult||1))));
  const fSpot=clamp((s-rs+1)/Math.max(1,Math.ceil(t.rampQtrs*(d.rampMult||1)*cal)));
  const energized=RAMP_QS(t.energize)<=s;
  const year=q=>2026+Math.floor((q-1)/4);
  const premium=cfg.softwarePremium??market.softwarePremium??0;
  const toGPU=perMW=>t.gpus>0?perMW*t.itMW*1e6/(t.gpus*annualHours):0;
  const newPrice=rampMarketPrice(market,year(newStart),newTerm,t.gen);
  const newRate=toGPU(newPrice.rate*(1+premium))*(d.newRateMult??1);
  const groups=[];
  const addGroup=(origin,share,initialRate,expiry,initialTerm,priceMeta)=>{
    if(share<=0)return;
    let cohort=origin,rate=initialRate,retained=1,cycle=0,start=origin==='existing'?rs:newStart,finish=expiry,meta=priceMeta;
    if(s>=expiry){
      cycle=Math.floor((s-expiry)/(renewalTerm*4))+1;
      start=expiry+(cycle-1)*renewalTerm*4;finish=start+renewalTerm*4;
      retained=d.noRenew?0:Math.pow(policy.retention,cycle);cohort='renewal';
      if(policy.rateMode==='market'){
        meta=rampMarketPrice(market,year(start),renewalTerm,t.gen);
        rate=toGPU(meta.rate*(1+premium))*(policy.rateMultiplier??1);
      }else if(policy.rateMode==='retain')rate=initialRate*Math.pow(policy.rateMultiplier??1,cycle);
      else throw Error('Unknown renewal rate mode: '+policy.rateMode);
    }
    if(cycle)rate*=d.renewalRateMult??1;
    rate=researchRate(rate,t,d,cohort==='existing',(s-rs)/4);
    const activeShare=share*retained,gpus=t.gpus*activeShare*fContract,itMW=t.itMW*activeShare*fContract;
    groups.push({cohort,origin,share:activeShare,gpus,itMW,rate,rev:gpus*rate*quarterHours/1e6,
      arr:energized?t.gpus*activeShare*rate*annualHours/1e9:0,renewalCycle:cycle,
      startQ:RAMP_QL(start),endQ:RAMP_QL(finish),termYears:cycle?renewalTerm:initialTerm,
      expiryBasis:cycle?'estimated':origin==='existing'?(contract.expiryBasis||'estimated'):'estimated',
      commitmentBasis:cohort==='existing'?(contract.commitmentBasis||'assumed'):'assumed',
      priceBasis:cycle?'house-assumption':(origin==='existing'?(contract.priceBasis||'inferred'):(future.priceBasis||'house-assumption')),
      source:cycle?policy.source||meta.source:origin==='existing'?contract.source||null:future.source||meta.source,
      asOf:cycle?policy.asOf||market.asOf:origin==='existing'?contract.asOf||R.asOf:future.asOf||meta.asOf,
      curve:origin==='new'||(cycle&&policy.rateMode==='market')?meta:null,
      unretainedShare:share*(1-retained)});
  };
  addGroup('existing',signedShare,original.rate,end,term,{source:contract.source||null});
  addGroup('new',newShare,newRate,newEnd,newTerm,newPrice);
  const displaced=groups.reduce((sum,g)=>sum+g.unretainedShare,0);
  const spotShare=baseSpotShare+displaced,spotLiveShare=baseSpotShare*fSpot+displaced*fContract;
  let spotRate,spotBasis;
  if(market.spot){
    const rates=market.spot.rates||market.spot;
    const spotYear=year(d.spotFlat?1:s),years=Object.keys(rates).map(Number).filter(Number.isFinite).sort((a,b)=>a-b);
    const y=years.filter(v=>v<=spotYear).at(-1)??years[0],cell=rates[y];
    const val=typeof cell==='number'?cell:cell.rate;
    const factor=market.spot.generationMultipliers?.[t.gen]??1;
    if(!Number.isFinite(val)||val<0)throw Error('Invalid shared spot rate for '+y);
    spotRate=market.spot.basis==='per-gpu-hour'?val*factor:toGPU(val*factor);
    spotBasis='shared all-in '+(market.spot.basis||'per-it-mw-year')+' market curve';
  }else{
    spotRate=(R.spot[String(d.spotFlat?2026:year(s))]||0)*(R.spotMult[t.gen]||1)*(1+(R.attach||0));
    spotBasis='company realized spot assumption plus explicit attach';
  }
  spotRate*=d.spotMult??1;
  const spotGPUs=t.gpus*spotLiveShare,spotMW=t.itMW*spotLiveShare;
  const contractedGPUs=groups.reduce((v,g)=>v+g.gpus,0),contractedMW=groups.reduce((v,g)=>v+g.itMW,0);
  return {id:original.id||original.n,n:t.n,campus:t.campus,gen:t.gen,energize:t.energize,revQ:t.rev,
    energized,grossMW:energized?t.grossMW:0,itCom:energized?t.itMW:0,
    gpus:contractedGPUs+spotGPUs,itMW:contractedMW+spotMW,itContracted:contractedMW,
    itSpot:spotMW,contractedGPUs,signedGPUs:groups.filter(g=>g.cohort==='existing'&&g.commitmentBasis==='disclosed').reduce((v,g)=>v+g.gpus,0),
    groups,spot:{share:spotShare,gpus:spotGPUs,itMW:spotMW,rate:spotRate,rev:spotGPUs*spotRate*quarterHours/1e6,basis:spotBasis},
    asOf:R.asOf||null,marketAsOf:market.asOf||null,existingShare:signedShare,
    allocationBasis:contract.allocationBasis||null,legacyAllocation:!!legacyAllocation};
}
function rampQuarters(R,sc,from,to,market){
  const legacy=rampLegacyQuarters(R,sc,from,to);
  if(!R.pricing)return legacy;
  if(!market)throw Error('An enabled research pricing model requires data.researchPricing');
  const d={...((sc&&sc.d)||{})},effective=RAMP_QS(R.pricing.effectiveQ||market.effectiveQ||'2026Q3');
  return legacy.map(q=>{
    if(q.s<effective)return q; // Preserve reported-period calibration exactly, including legacy mix convention.
    const details=R.tranches.map(t=>rampPricedTranche(R,t,q.s,market,d));
    const previous=R.tranches.map(t=>rampPricedTranche(R,t,q.s-1,market,d));
    const by={hopper:0,blackwell:0,rubin:0,next:0},rv={hopper:0,blackwell:0,rubin:0,next:0};
    const total=key=>details.reduce((v,t)=>v+(t[key]||0),0);
    const sums={revExisting:0,revExistingConfirmed:0,revExistingAssumed:0,revRenewal:0,revNew:0,revSpot:0,arrExisting:0,arrExistingConfirmed:0,arrExistingAssumed:0,arrRenewal:0,arrNew:0};
    const provenance={disclosedExpiry:0,estimatedExpiry:0,disclosedPrice:0,inferredPrice:0,assumedPrice:0,confirmedExisting:0,assumedExisting:0,curveFallback:0};
    details.forEach(t=>{
      by[t.gen]=(by[t.gen]||0)+t.gpus;let rev=t.spot.rev;sums.revSpot+=t.spot.rev;
      t.groups.forEach(g=>{
        const suffix=g.cohort[0].toUpperCase()+g.cohort.slice(1);
        sums['rev'+suffix]+=g.rev;sums['arr'+suffix]+=g.arr;rev+=g.rev;
        if(g.cohort==='existing'){
          const certainty=g.commitmentBasis==='disclosed'?'Confirmed':'Assumed';
          sums['revExisting'+certainty]+=g.rev;sums['arrExisting'+certainty]+=g.arr;
        }
        if(g.share>0&&t.energized){
          provenance[g.expiryBasis==='disclosed'?'disclosedExpiry':'estimatedExpiry']++;
          provenance[g.priceBasis==='disclosed'?'disclosedPrice':g.priceBasis==='inferred'?'inferredPrice':'assumedPrice']++;
          if(g.cohort==='existing')provenance[g.commitmentBasis==='disclosed'?'confirmedExisting':'assumedExisting']++;
          if(g.curve?.fallback)provenance.curveFallback++;
        }
      });
      rv[t.gen]=(rv[t.gen]||0)+rev;
    });
    const revC=sums.revExisting+sums.revRenewal+sums.revNew,rev=revC+sums.revSpot,cum=total('gpus');
    return {...q,...sums,by,rv,cum,added:cum-previous.reduce((v,t)=>v+t.gpus,0),signed:total('signedGPUs'),
      ctr:total('contractedGPUs'),rev,revC,revS:sums.revExistingConfirmed,grossMW:total('grossMW'),itCom:total('itCom'),
      itMW:total('itMW'),itContracted:total('itContracted'),itSpot:total('itSpot'),
      nCamps:new Set(details.filter(t=>t.gpus>0).map(t=>t.campus)).size,blend:cum?rev*1e6/(cum*quarterHours):0,
      arrContracted:sums.arrExisting+sums.arrRenewal+sums.arrNew,earningArrContracted:revC*4/1000,
      pricingAsOf:market.asOf||null,pricingEffectiveQ:RAMP_QL(effective),provenance,details};
  });
}
function rampBacktest(R,market){
  const A=R.actuals||{}; const ks=Object.keys(A); if(!ks.length)return null;
  const first=Math.min(...ks.map(RAMP_QS)), last=Math.max(...ks.map(RAMP_QS));
  const Q=rampQuarters(R,null,first,last,market);
  const Qu=rampQuarters({...R,calibration:{rampMult:1}},null,first,last,market);
  const rate=R.earningRate||2.48;
  const rows=Q.map((q,i)=>{const act=A[q.lbl]; if(!act)return null;
    const qu=Qu[i];
    const actGpu=act.aiRevM*1e6/(rate*2190);          // earning-GPU-equivalent implied by reported revenue
    return {lbl:q.lbl, modRev:q.rev, actRev:act.aiRevM, errPct:(q.rev/act.aiRevM-1)*100,
            rawRev:qu.rev, rawErrPct:(qu.rev/act.aiRevM-1)*100,
            modGpu:q.cum, actGpu, gpuErrPct:(q.cum/actGpu-1)*100, fleet:act.fleetDisclosed};}).filter(Boolean);
  const mape=rows.reduce((a,r)=>a+Math.abs(r.errPct),0)/rows.length;
  const bias=rows.reduce((a,r)=>a+r.errPct,0)/rows.length;
  const rawMape=rows.reduce((a,r)=>a+Math.abs(r.rawErrPct),0)/rows.length;
  const rawBias=rows.reduce((a,r)=>a+r.rawErrPct,0)/rows.length;
  // implied ramp multiple: how much slower the observed commissioning is than modelled
  const impl=rows.map(r=>r.modGpu/Math.max(r.actGpu,1)).filter(x=>isFinite(x)&&x>0);
  const rampMult=impl.length?impl.reduce((a,b)=>a+b,0)/impl.length:null;
  return {rows,mape,bias,rawMape,rawBias,rampMult,rate};
}
function rampTrancheAt(R,t,s,market,sc){   // {gpus,revM} of one tranche in quarter s
  if(R.pricing&&s>=RAMP_QS(R.pricing.effectiveQ||market?.effectiveQ||'2026Q3')){
    if(!market)throw Error('An enabled research pricing model requires data.researchPricing');
    const result=rampPricedTranche(R,t,s,market,(sc&&sc.d)||{});
    return {g:result.gpus,r:result.groups.reduce((sum,g)=>sum+g.rev,0)+result.spot.rev};
  }
  const rs=RAMP_QS(t.rev),f=Math.min(Math.max((s-rs+1)/t.rampQtrs,0),1);
  if(f<=0)return{g:0,r:0};
  const yr=2026+Math.floor((s-1)/4);
  const er=t.ctr*t.rate+(1-t.ctr)*(R.spot[String(yr)]||0)*(R.spotMult[t.gen]||1);
  return{g:t.gpus*f,r:t.gpus*f*er*2190/1e6};
}
  return { RAMP_QS, RAMP_QL, RAMP_START, RAMP_END, RAMP_HIST, RAMP_CONS_HARD, rampApplySc, rampMarketPrice, rampQuarters, rampBacktest, rampTrancheAt };
});
