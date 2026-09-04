/* Shared GPU-ramp math — ONE source of truth for the quarterly build-out (spec §6 screen 11, §6e), run by both:
   - app.js (browser: the GPU RAMP tab)
   - onepager.js (node: the research pages)
   Display-only overlay on data.json ramp objects; never a valuation input. Never fork it. */
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
  if(d.ctrMult!=null){const sg=t.signed||0;o.ctr=sg+(t.ctr-sg)*d.ctrMult;}
  if(d.slipQtrs){const from=d.from!=null?d.from:-99;
    if(RAMP_QS(t.energize)>=from){o.energize=RAMP_QL(RAMP_QS(t.energize)+d.slipQtrs);o.rev=RAMP_QL(RAMP_QS(t.rev)+d.slipQtrs);}}
  return o;
}
function rampQuarters(R,sc,from,to){
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
function rampBacktest(R){
  const A=R.actuals||{}; const ks=Object.keys(A); if(!ks.length)return null;
  const first=Math.min(...ks.map(RAMP_QS)), last=Math.max(...ks.map(RAMP_QS));
  const Q=rampQuarters(R,null,first,last);
  const Qu=rampQuarters({...R,calibration:{rampMult:1}},null,first,last);
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
function rampTrancheAt(R,t,s){   // {gpus,revM} of one tranche in quarter s
  const rs=RAMP_QS(t.rev),f=Math.min(Math.max((s-rs+1)/t.rampQtrs,0),1);
  if(f<=0)return{g:0,r:0};
  const yr=2026+Math.floor((s-1)/4);
  const er=t.ctr*t.rate+(1-t.ctr)*(R.spot[String(yr)]||0)*(R.spotMult[t.gen]||1);
  return{g:t.gpus*f,r:t.gpus*f*er*2190/1e6};
}
  return { RAMP_QS, RAMP_QL, RAMP_START, RAMP_END, RAMP_HIST, RAMP_CONS_HARD, rampApplySc, rampQuarters, rampBacktest, rampTrancheAt };
});
