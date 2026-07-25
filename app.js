/* Compute / Value — relative-value tracker.
   Engine + screens ported from the prototype; all data loads from data.json at runtime. */

const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const FMT={
  money1M:v=>'$'+v.toFixed(1)+'M',
  pctInt:v=>v+'%',
  mult:v=>v.toFixed(1)+'×',
  pct1:v=>v.toFixed(1)+'%',
  months:v=>v+' mo',
  trend:v=>(v>=0?'+':'')+v+'%/yr',
};

/* runtime state, populated once data.json loads */
let E=null;   // the shared valuation engine instance (engine.js) — all math lives there
let CFG, COMPANIES, YEAR, NOW, BASE, A, SLIDERS, HORIZON;
let REGION, CONST, PROV, PROV_OP, TIERS;
let LIVE_PRICES={}, PRICES_AT=null, BTC_PRICE=null, BTC_AT=null, ETH_PRICE=null;
let FP_COMPANY=null, BUILDOUT_METRIC='mw', SITE_FILTER=null;

let sortKey='upside',sortDir=-1,view='cmp',siteSort='val',siteDir=-1,leaseSort='annual',leaseDir=-1,ocSort='total',ocDir=-1,covSort='anncov',covDir=-1,rzSort='d',rzDir=-1,olTab='leases',olSort='prob',olDir=-1,oeSort='score',oeDir=-1,olBigOnly=false;
const reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;

function fmtSlider(s,v){return (FMT[s.fmt]||(x=>x))(v);}
function fmtM(x){return Math.abs(x)>=1000?'$'+(x/1000).toFixed(1)+'B':'$'+x.toFixed(0)+'M';}
function fmtPrice(p){return p>=100?'$'+p.toFixed(0):'$'+p.toFixed(2);}
function horizon(yr){return yr<=HORIZON.near?'var(--indigo)':yr<=HORIZON.mid?'var(--indigo-soft)':'var(--far)';}

/* ---- engine (engine.js — shared with the node portfolio scripts; thin delegates keep call-sites unchanged) ---- */
function priceOf(c){return E.priceOf(c);}
function btcPrice(){return E.btcPrice();}
function ethPrice(){return E.ethPrice();}
function stakeValue(c){return E.stakeValue(c);}
function legacyOf(c){return E.legacyOf(c);}
function prevailingRate(yrs){return E.prevailingRate(yrs);}
function ownerRate(c){return E.ownerRate(c);}
function effTrend(){return E.effTrend();}
function leaseUp(){return E.leaseUp();}
function siteRates(c,s){return E.siteRates(c,s);}
function tierOf(c){return E.tierOf(c);}
function siteValue(c,s){return E.siteValue(c,s);}
function value(c){return E.value(c);}
function splitParts(v){const tot=v.contractedEV+v.expectedEV;const cf=tot>0?v.contractedEV/tot*100:0;return{cf,eu:100-cf};}
function splitBarHTML(v){const p=splitParts(v);return `<div class="splitbar" title="Contracted floor ${p.cf.toFixed(0)}% · expected upside ${p.eu.toFixed(0)}%"><i class="cf" style="width:${p.cf.toFixed(1)}%"></i><i class="eu" style="width:${p.eu.toFixed(1)}%"></i></div>`;}
/* ---- controls ---- */
function buildControls(){const w=document.getElementById('controls');w.innerHTML='';SLIDERS.forEach(s=>{const d=document.createElement('div');d.className='ctrl';
  d.innerHTML=`<div class="row"><label for="s-${s.k}">${s.label}</label><span class="val" id="v-${s.k}">${fmtSlider(s,A[s.k])}</span></div><input type="range" id="s-${s.k}" min="${s.min}" max="${s.max}" step="${s.step}" value="${A[s.k]}" aria-label="${s.label}">`;
  w.appendChild(d);d.querySelector('input').addEventListener('input',e=>{A[s.k]=parseFloat(e.target.value);document.getElementById('v-'+s.k).textContent=fmtSlider(s,A[s.k]);render();});});}
function syncControls(){SLIDERS.forEach(s=>{const i=document.getElementById('s-'+s.k);if(i){i.value=A[s.k];document.getElementById('v-'+s.k).textContent=fmtSlider(s,A[s.k]);}});}

/* ---- render ---- */
function render(){
  const refO={model:'owner',contractedPct:60,termYrs:3,renewalProb:0.8,mtm:0.95};
  document.getElementById('d-owner').textContent=fmtM(ownerRate(refO)*((A.margin+CONST.leasedCMargin)/100)*(A.multiple*(1+CONST.multPremium*0.6)))+' / MW';
  document.getElementById('d-land').textContent=fmtM((CONST.landlordNOI*CONST.leasedLNOI)/((A.capRate/100)*(1-CONST.capCompress*0.4)))+' / MW';
  if(view==='cmp')renderCmp(); else if(view==='checks')renderChecks(); else if(view==='port')renderPortfolio(); else if(view==='leases')renderLeases(); else if(view==='cover')renderCoverage(); else if(view==='raises')renderRaises(); else if(view==='outlook')renderOutlook(); else if(view==='ramp'){if(!RAMP_CTX||!document.getElementById('rampPlayBtn'))renderRamp();} else renderSites();
}

/* ---- leases page: the registry rendered — every signed book + its economics (the print tape) ---- */
function renderLeases(){
  const body=document.getElementById('leases-body');if(!body)return;
  // campus stem: the site-name prefix before phase/building qualifiers — groups rows into physical campuses
  const stem=n=>{let x=n;const seps=[' ph',' Ph',' ELN',' CB-',' Bldg',' ROFO',' expansion',' approved',' pipeline',' tranche',' balance',' initial',' build-out',' buildout',' long-term',' Phase','(','—','ph1','ph2'];
    let cut=x.length;seps.forEach(sp=>{const i=x.indexOf(sp);if(i>0&&i<cut)cut=i;});return x.slice(0,cut).trim().replace(/[,\s]+$/,'');};
  const rows=[];
  COMPANIES.forEach(c=>(c.leases||[]).forEach(l=>{
    const v=value(c);const segs=v.segs.filter(g=>g.s.leaseId===l.id);
    const ev=segs.reduce((x,g)=>x+g.ev,0);
    const startYr=segs.length?Math.min(...segs.map(g=>g.s.yr)):null;
    const camp=segs.length?[...new Set(segs.map(g=>g.s.n.split('(')[0].trim()))].join(' · '):'—';
    // leased share of the campus power we credit: this lease's MW ÷ all company rows sharing its campus stems
    const stems=[...new Set(segs.map(g=>stem(g.s.n)))];
    const campMW=stems.length?c.sites.filter(s2=>stems.some(st=>stem(s2.n)===st)).reduce((x,s2)=>x+(s2.physMW||s2.mw),0):0;
    rows.push({c,l,ev,campMW,pctCamp:campMW>0?l.mw/campMW:null,annual:l.mw*l.noiPerMWyr,startYr,camp});
  }));
  const LKEY={tk:r=>r.c.tk,tenant:r=>r.l.counterparty||'',camp:r=>r.camp||'',base:r=>r.l.totalRevM||0,mw:r=>r.l.mw,noi:r=>r.l.noiPerMWyr,annual:r=>r.annual};
  const kf=LKEY[leaseSort]||LKEY.annual;
  rows.sort((x,y)=>{const av=kf(x),bv=kf(y);return (typeof av==='string'?av.localeCompare(bv):av-bv)*leaseDir;});
  const eff=rows.filter(r=>r.l.effective!==false);
  const totMW=eff.reduce((x,r)=>x+r.l.mw,0),totNOI=eff.reduce((x,r)=>x+r.annual,0);
  const totBase=eff.reduce((x,r)=>x+(r.l.totalRevM||0),0);
  const blended=totMW?totNOI/totMW:0;
  let h=`<div class="ssummary" style="margin:4px 4px 16px"><span><b>${eff.length}</b> signed books</span><span><b>${totMW.toLocaleString()}</b> MW critical IT</span><span><b>$${(totBase/1000).toFixed(0)}B</b> base-term value</span><span>blended NOI <b>$${blended.toFixed(2)}M</b>/MW·yr</span><span>forward anchor <b>$${(CONST.landlordNOI*1.1).toFixed(2)}M</b> (cheap-owned)</span></div>`;
  // print tape: median by kind + by signing half
  const med=x=>{if(!x.length)return null;const s2=[...x].sort((p,q)=>p-q);return s2[Math.floor(s2.length/2)];};
  const byKind={};eff.forEach(r=>{(byKind[r.l.kind||'?']=byKind[r.l.kind||'?']||[]).push(r.l.noiPerMWyr);});
  const half=s2=>{const [y,m]=s2.split('-').map(Number);return y+(m<=6?' H1':' H2');};
  const byHalf={};eff.forEach(r=>{if(r.l.signed)(byHalf[half(r.l.signed)]=byHalf[half(r.l.signed)]||[]).push(r.l.noiPerMWyr);});
  h+=`<div class="legend2" style="margin:0 4px 18px">Print tape (median signed NOI $M/MW·yr) — by kind: ${Object.entries(byKind).map(([k,x])=>`<b>${k}</b> $${med(x).toFixed(2)} (${x.length})`).join(' · ')} &nbsp;|&nbsp; by vintage: ${Object.keys(byHalf).sort().map(k=>`<b>${k}</b> $${med(byHalf[k]).toFixed(2)}`).join(' → ')}</div>`;
  h+=`<div style="overflow-x:auto"><table class="stab"><thead><tr><th></th>${[['tk','Lessor',''],['tenant','Tenant',''],['camp','Campus',''],['base','Base term','r'],['mw','IT MW','r'],['noi','NOI $/MW·yr','r']].map(([k,lab,cl])=>`<th class="${cl}" data-ls="${k}">${lab}${leaseSort===k?' <span class="arr">'+(leaseDir<0?'▾':'▴')+'</span>':''}</th>`).join('')}</tr></thead><tbody>`;
  rows.forEach((r,i)=>{const l=r.l;const pend=l.effective===false;
    h+=`<tr class="lrow srow${pend?' lpend':''}" data-i="${i}"><td style="width:18px;color:var(--indigo-soft)">▸</td>`+
    `<td class="co">${r.c.tk}</td>`+
    `<td style="max-width:250px">${l.counterparty}${pend?' <span class="prov rumored">not effective</span>':''}</td>`+
    `<td style="max-width:200px;font-size:11.5px">${r.camp}</td>`+
    `<td class="r mono">${l.totalRevM?'$'+(l.totalRevM/1000).toFixed(1)+'B':'—'}</td>`+
    `<td class="r mono">${l.mw.toLocaleString()}</td>`+
    `<td class="r mono">$${l.noiPerMWyr.toFixed(2)}M</td></tr>`;
    const f2=(k2,v2)=>`<div class="cstep"><span>${k2}</span><span class="cval">${v2}</span><span class="cnote"></span></div>`;
    h+=`<tr class="sdetail" id="ld-${i}"><td colspan="7"><div class="sitecalc">`+
      f2('Kind',l.kind||'—')+f2('Signed',l.signed||'—')+f2('Term',l.termYrs+' yrs')+
      (l.grossMW?f2('Gross MW',l.grossMW+' MW ('+Math.round(l.mw/l.grossMW*100)+'% IT ratio)'):'')+
      (pend?'':f2('Annual NOI','$'+r.annual.toFixed(0)+'M'))+
      (pend?'':f2('Value added',fmtM(r.ev)))+
      (r.pctCamp!=null?f2('Campus leased',(r.pctCamp*100).toFixed(0)+'% of '+r.campMW.toLocaleString()+' MW credited'):'')+
      (r.startYr?f2('First rent',String(r.startYr)):'')+
      `<div class="cstep"><span>Source</span><span class="cval" style="text-align:left;font-family:var(--sans);font-size:11px;color:var(--ink-soft)">${l.source||'—'}</span><span class="cnote"></span></div>`+
      `<a class="clearfilter" href="#${r.c.tk}" style="font-size:11px">open ${r.c.tk} page →</a>`+
      `</div></td></tr>`;});
  h+=`</tbody></table></div><div class="legend2" style="margin-top:12px">NOI is the <b>term-average of the actual contract</b> (escalators embedded) — a fact from the filing. <b>Base term</b> = total base-term contract value. Click a row for kind, vintage, term, gross MW, annual NOI, value added, campus-leased runway and the source.</div>`;
  // compute contracts (GPU-cloud owners) — dollars+term facts; $/MW mostly inferred
  const oc=[];COMPANIES.forEach(c=>(c.contracts||[]).forEach(x=>oc.push({c,x})));
  if(oc.length){
    const OKEY={tk:r=>r.c.tk,cp:r=>r.x.counterparty||'',gen:r=>r.x.gen||'',signed:r=>r.x.signed||'',total:r=>r.x.totalRevM||0,mw:r=>r.x.mw||0,rate:r=>r.x.ratePerMWyr||0};
    const okf=OKEY[ocSort]||OKEY.total;
    oc.sort((p,q)=>{const av=okf(p),bv=okf(q);return (typeof av==='string'?av.localeCompare(bv):av-bv)*ocDir;});
    const eff2=oc.filter(r=>r.x.effective!==false);
    const totB=eff2.reduce((a3,r)=>a3+(r.x.totalRevM||0),0);
    h+=`<h4 class="sec" style="margin-top:30px">Compute contracts — GPU clouds</h4>`;
    h+=`<div class="ssummary" style="margin:4px 4px 12px"><span><b>${eff2.length}</b> signed contracts</span><span><b>$${(totB/1000).toFixed(0)}B</b> total book</span><span>signed rates: <b>CRWV $9.3M</b>~ · <b>NBIS $11.5M</b>~ · <b>IREN $10.1M</b> (disclosed MW)</span><span>gen ladder: hopper ~$9.3 → blackwell $9.7–11.6 → VR (1H27, est. $13–16)</span></div>`;
    h+=`<div style="overflow-x:auto"><table class="stab"><thead><tr><th></th>${[['tk','Owner',''],['cp','Counterparty',''],['gen','Gen',''],['total','Base term','r'],['mw','~IT MW','r'],['rate','$/MW·yr','r']].map(([k,lab,cl])=>`<th class="${cl}" data-oc="${k}">${lab}${ocSort===k?' <span class="arr">'+(ocDir<0?'▾':'▴')+'</span>':''}</th>`).join('')}</tr></thead><tbody>`;
    oc.forEach((r,i)=>{const x=r.x;const pend=x.effective===false;
      h+=`<tr class="ocrow srow${pend?' lpend':''}" data-i="${i}"><td style="width:18px;color:var(--indigo-soft)">▸</td>`+
      `<td class="co">${r.c.tk}</td><td style="max-width:250px">${x.counterparty}${pend?' <span class="prov rumored">pending</span>':''}</td>`+
      `<td><span class="prov ${x.gen==='vera-rubin'?'rumored':x.gen==='blackwell'?'disclosed':'estimated'}">${x.gen||'—'}</span></td>`+
      `<td class="r mono">${x.totalRevM?'$'+(x.totalRevM/1000).toFixed(1)+'B':'—'}</td>`+
      `<td class="r mono">${x.mw?x.mw.toLocaleString()+(x.inferredMW?' <span style="color:var(--ink-soft)">~</span>':''):'—'}</td>`+
      `<td class="r mono">${x.ratePerMWyr?('$'+x.ratePerMWyr.toFixed(1)+'M'+(x.inferredMW?' <span style="color:var(--ink-soft)">~</span>':'')):'—'}</td></tr>`;
      const f3=(k2,v2)=>`<div class="cstep"><span>${k2}</span><span class="cval">${v2}</span><span class="cnote"></span></div>`;
      h+=`<tr class="sdetail" id="oc-${i}"><td colspan="7"><div class="sitecalc">`+
        f3('Signed',x.signed||'—')+f3('Term',x.termYrs+' yrs')+f3('Status',pend?'signed, pending/undisclosed':'effective')+
        f3('Annual run-rate',x.totalRevM?'$'+(x.totalRevM/x.termYrs/1000).toFixed(2)+'B/yr':'—')+
        (x.mw?f3('MW basis',x.inferredMW?'analyst inference (dollars ÷ fleet rate) — not disclosed':'COMPANY-DISCLOSED'):'')+
        `<div class="cstep"><span>Source</span><span class="cval" style="text-align:left;font-family:var(--sans);font-size:11px;color:var(--ink-soft)">${x.source||'—'}</span><span class="cnote"></span></div>`+
        `<a class="clearfilter" href="#${r.c.tk}" style="font-size:11px">open ${r.c.tk} page →</a></div></td></tr>`;});
    h+=`</tbody></table></div><div class="legend2">Compute contracts are take-or-pay DOLLARS over a TERM — MW and $/MW marked <b>~</b> are analyst inference (only IREN disclosés contractual MW). Each owner's $-weighted blended rate binds its contracted slice via `+'`signedRate`'+`; unsigned + re-signing slices ride the GPU gen-curve dial. Click a row for detail.</div>`;}
  body.innerHTML=h;
  body.querySelectorAll('th[data-ls]').forEach(th=>th.addEventListener('click',()=>{const k=th.dataset.ls;
    if(k===leaseSort)leaseDir*=-1;else{leaseSort=k;leaseDir=(k==='tk'||k==='tenant'||k==='camp')?1:-1;}renderLeases();}));
  body.querySelectorAll('th[data-oc]').forEach(th=>th.addEventListener('click',()=>{const k=th.dataset.oc;
    if(k===ocSort)ocDir*=-1;else{ocSort=k;ocDir=(k==='tk'||k==='cp'||k==='gen'||k==='signed')?1:-1;}renderLeases();}));
  body.querySelectorAll('.ocrow').forEach(tr=>tr.addEventListener('click',()=>{const d2=document.getElementById('oc-'+tr.dataset.i);if(d2)d2.classList.toggle('open');const car=tr.querySelector('td');if(car)car.textContent=d2&&d2.classList.contains('open')?'▾':'▸';}));
  body.querySelectorAll('.lrow').forEach(tr=>tr.addEventListener('click',()=>{const d=document.getElementById('ld-'+tr.dataset.i);if(d)d.classList.toggle('open');const car=tr.querySelector('td');if(car)car.textContent=d&&d.classList.contains('open')?'▾':'▸';}));
}
/* ---- coverage page: confirmed contracted value vs live market cap (gross headline $, not NOI) ---- */
function renderCoverage(){
  const body=document.getElementById('cover-body');if(!body)return;
  const rows=COMPANIES.map(c=>{
    const px=priceOf(c),mcap=(c.sharesReported||c.shares)*px;   // reported (basic) shares × live price, $M
    const items=[];
    (c.leases||[]).forEach(l=>{if(l.effective===false)return;const g=l.grossTotalM||0;if(g<=0)return;
      items.push({kind:'lease',cp:l.counterparty,gross:g,term:l.termYrs,mw:l.mw,ann:g/l.termYrs});});
    (c.contracts||[]).forEach(x=>{if(x.effective===false)return;const g=x.totalRevM||0;if(g<=0)return;
      items.push({kind:'compute',cp:x.counterparty,gross:g,term:x.termYrs,mw:x.mw||null,ann:g/x.termYrs});});
    const gross=items.reduce((a,i)=>a+i.gross,0),ann=items.reduce((a,i)=>a+i.ann,0);
    const wterm=gross?items.reduce((a,i)=>a+i.gross*i.term,0)/gross:0;
    return {c,px,mcap,items,gross,ann,wterm,anncov:mcap?ann/mcap:0,totcov:mcap?gross/mcap:0};
  });
  const CKEY={tk:r=>r.c.tk,mcap:r=>r.mcap,gross:r=>r.gross,wterm:r=>r.wterm,ann:r=>r.ann,anncov:r=>r.anncov,totcov:r=>r.totcov};
  const kf=CKEY[covSort]||CKEY.totcov;
  rows.sort((x,y)=>{const av=kf(x),bv=kf(y);return (typeof av==='string'?av.localeCompare(bv):av-bv)*covDir;});
  const uMcap=rows.reduce((a,r)=>a+r.mcap,0),uGross=rows.reduce((a,r)=>a+r.gross,0),uAnn=rows.reduce((a,r)=>a+r.ann,0);
  let h=`<div class="ssummary" style="margin:4px 4px 16px"><span><b>${fmtM(uMcap)}</b> total market cap</span><span><b>${fmtM(uGross)}</b> confirmed contracted</span><span><b>${fmtM(uAnn)}</b>/yr annualized</span><span>backlog / market cap <b>${(uGross/uMcap*100).toFixed(0)}%</b></span></div>`;
  const cols=[['tk','Company',''],['mcap','Market cap','r'],['gross','Contracted','r'],['wterm','Avg term','r'],['ann','Annualized','r'],['totcov','Backlog ÷ cap','r'],['anncov','Ann ÷ cap','r']];
  h+=`<div style="overflow-x:auto"><table class="stab"><thead><tr><th></th>${cols.map(([k,lab,cl])=>`<th class="${cl}" data-cv="${k}">${lab}${covSort===k?' <span class="arr">'+(covDir<0?'▾':'▴')+'</span>':''}</th>`).join('')}</tr></thead><tbody>`;
  rows.forEach((r,i)=>{const none=r.items.length===0;
    h+=`<tr class="cvrow srow" data-i="${i}"><td style="width:18px;color:var(--indigo-soft)">${none?'':'▸'}</td>`+
      `<td class="co">${r.c.tk}</td>`+
      `<td class="r mono">${fmtM(r.mcap)}</td>`+
      `<td class="r mono">${none?'—':fmtM(r.gross)}</td>`+
      `<td class="r mono">${none?'—':r.wterm.toFixed(1)+'y'}</td>`+
      `<td class="r mono">${none?'—':fmtM(r.ann)+'/y'}</td>`+
      `<td class="r mono">${none?'—':(r.totcov*100).toFixed(0)+'%'}</td>`+
      `<td class="r mono"><b>${none?'—':(r.anncov*100).toFixed(0)+'%'}</b></td></tr>`;
    if(!none){const its=[...r.items].sort((a,b)=>b.gross-a.gross);
      h+=`<tr class="sdetail" id="cv-${i}"><td colspan="8"><div style="padding:8px 14px 12px">`+
        `<table class="stab" style="margin:0;width:100%"><thead><tr><th>Counterparty</th><th></th><th class="r">Gross</th><th class="r">Term</th><th class="r">Annualized</th><th class="r">IT&nbsp;MW</th></tr></thead><tbody>`+
        its.map(it=>`<tr><td style="max-width:300px">${it.cp}</td><td><span class="prov ${it.kind==='lease'?'disclosed':'estimated'}">${it.kind==='lease'?'colo lease':'compute'}</span></td><td class="r mono">${fmtM(it.gross)}</td><td class="r mono">${it.term}y</td><td class="r mono">${fmtM(it.ann)}/y</td><td class="r mono">${it.mw?it.mw.toLocaleString():'—'}</td></tr>`).join('')+
        `</tbody></table><a class="clearfilter" href="#${r.c.tk}" style="font-size:11px">open ${r.c.tk} page →</a></div></td></tr>`;}
  });
  h+=`</tbody></table></div><div class="legend2" style="margin-top:12px"><b>Market cap</b> = reported (basic) shares × live price — tracks the tape, not fully-diluted. <b>Contracted</b> = gross value of every signed/effective lease + compute contract (the headline announced $, not NOI). <b>Annualized</b> = Σ(gross ÷ term) — a term-average, not a current run-rate (many contracts ramp from 2027+). <b>Ann ÷ cap</b> and <b>Backlog ÷ cap</b> measure contracted revenue against market value. Excludes options, LOIs and non-performing books. Click a row for the per-contract breakdown with terms.</div>`;
  body.innerHTML=h;
  body.querySelectorAll('th[data-cv]').forEach(th=>th.addEventListener('click',()=>{const k=th.dataset.cv;
    if(k===covSort)covDir*=-1;else{covSort=k;covDir=(k==='tk')?1:-1;}renderCoverage();}));
  body.querySelectorAll('.cvrow').forEach(tr=>tr.addEventListener('click',()=>{const d=document.getElementById('cv-'+tr.dataset.i);if(!d)return;d.classList.toggle('open');const car=tr.querySelector('td');if(car&&car.textContent)car.textContent=d.classList.contains('open')?'▾':'▸';}));
}
/* ---- raises page: capital-raise event study (spec §6c) — returns derived live from the sanctioned ledger, nothing stored ---- */
const RZ_WINDOWS=[5,15,30];
const RZ_KIND_CLS={equity:'rumored',atm:'rumored',convert:'estimated',pref:'estimated',debt:'disclosed',other:'disclosed'};
const RZ_KIND_LABEL={equity:'Equity',atm:'ATM',convert:'Convert',pref:'Preferred',debt:'Debt',other:'Other'};
function rzNextDay(iso){const t=new Date(iso+'T12:00:00Z');t.setUTCDate(t.getUTCDate()+1);return t.toISOString().slice(0,10);}
function rzDerive(tk,ev,days){
  const eff=ev.ah?rzNextDay(ev.d):ev.d,last=days.length-1;
  if(eff>days[last].d)return{status:'pending'};                       // announced after the last mark — day 0 not printed yet
  let i0=-1;for(let i=0;i<days.length;i++){if(days[i].d>=eff&&days[i].px[tk]>0){i0=i;break;}}
  if(i0<=0||!(days[i0-1].px[tk]>0))return{status:'nohistory'};        // pre-ledger or pre-listing: a fact without returns
  const baseline=days[i0-1].px[tk],px0=days[i0].px[tk],wins={};
  RZ_WINDOWS.forEach(N=>{const j=i0+N;
    if(j<=last){wins[N]={r:days[j].px[tk]/px0-1,x:days[j].px[tk]/px0-1-(days[j].bench/days[i0].bench-1),done:true};}
    else if(last>i0){const lp=LIVE_PRICES[tk]>0?LIVE_PRICES[tk]:days[last].px[tk];
      wins[N]={r:lp/px0-1,x:lp/px0-1-(days[last].bench/days[i0].bench-1),done:false,el:last-i0};}
    else wins[N]=null;});                                             // day 0 is the latest mark — no forward path yet
  return{status:'ok',d0:days[i0].d,baseline,px0,reaction:px0/baseline-1,wins};
}
function renderRaises(){
  const body=document.getElementById('raises-body');if(!body)return;
  if(typeof PFH==='undefined'||!PFH){
    body.innerHTML=(typeof PF_ERR!=='undefined'&&PF_ERR)?`<div class="appmsg err">Could not load the price ledger — ${PF_ERR} <button class="refreshbtn" onclick="retryPortfolio()">retry</button></div>`:'<div class="legend2">loading price ledger…</div>';
    if(typeof loadPortfolio==='function'&&!PF_LOADING&&!PF_ERR)loadPortfolio();return;}
  const days=PFH.days;
  const rows=[];COMPANIES.forEach(c=>(c.raises||[]).forEach(ev=>rows.push({c,ev,der:rzDerive(c.tk,ev,days)})));
  if(!rows.length){body.innerHTML='<div class="legend2">no raises recorded yet — events enter data.json as sourced facts (spec §6c)</div>';return;}
  /* aggregates — complete windows only; the hypothesis test */
  const med=a=>{if(!a.length)return null;const s=[...a].sort((x,y)=>x-y),m=s.length>>1;return s.length%2?s[m]:(s[m-1]+s[m])/2;};
  const agg=ks=>{const ev=rows.filter(r=>r.der.status==='ok'&&(ks==='all'||r.ev.kind===ks));
    const o={n:ev.length,rx:med(ev.map(r=>r.der.reaction))};
    RZ_WINDOWS.forEach(N=>{const done=ev.filter(r=>r.der.wins[N]&&r.der.wins[N].done);
      o[N]={n:done.length,med:med(done.map(r=>r.der.wins[N].r)),hit:done.length?done.filter(r=>r.der.wins[N].r>0).length/done.length:null,xmed:med(done.map(r=>r.der.wins[N].x))};});
    return o;};
  const A=agg('all');
  const kinds=Object.keys(RZ_KIND_CLS).filter(k=>rows.some(r=>r.ev.kind===k&&r.der.status==='ok'));
  const pc=x=>x==null?'—':(x>=0?'+':'')+(x*100).toFixed(1)+'%';
  const col=(x,inner)=>x==null?'—':`<span style="color:${x>=0?'var(--pine)':'var(--clay)'}">${inner}</span>`;
  let h=`<div class="ssummary" style="margin:4px 4px 16px"><span><b>${rows.length}</b> raises recorded</span><span><b>${A[15].n}</b> with a complete +15d window</span><span>day-0 median <b>${pc(A.rx)}</b></span><span>+15d median <b>${pc(A[15].med)}</b>${A[15].hit!=null?' · hit <b>'+(A[15].hit*100).toFixed(0)+'%</b>':''}</span></div>`;
  /* aggregate table by instrument — per window: absolute median | median net of universe | hit rate */
  const gsep='border-left:1px solid var(--line)';
  h+=`<div style="overflow-x:auto"><table class="stab" style="margin:0 0 18px"><thead>`+
    `<tr><th rowspan="2" style="vertical-align:bottom">Type</th><th class="r" rowspan="2" style="vertical-align:bottom">N</th><th class="r" rowspan="2" style="vertical-align:bottom">Day 0 med</th><th colspan="3" style="text-align:center;${gsep}">+5d</th><th colspan="3" style="text-align:center;${gsep}">+15d</th></tr>`+
    `<tr><th class="r" style="${gsep}">abs</th><th class="r">vs univ</th><th class="r">hit</th><th class="r" style="${gsep}">abs</th><th class="r">vs univ</th><th class="r">hit</th></tr></thead><tbody>`;
  const aggRow=(lab,a,bold)=>{const w=N=>a[N].n?`<td class="r mono" style="${gsep}">${col(a[N].med,pc(a[N].med))}</td><td class="r mono">${col(a[N].xmed,pc(a[N].xmed))}</td><td class="r mono">${(a[N].hit*100).toFixed(0)}% <span style="color:var(--ink-soft)">(${a[N].n})</span></td>`:`<td class="r mono" style="${gsep}">—</td><td class="r mono">—</td><td class="r mono">—</td>`;
    return `<tr><td>${bold?'<b>All</b>':(RZ_KIND_LABEL[lab]||lab)}</td><td class="r mono">${a.n}</td><td class="r mono">${col(a.rx,pc(a.rx))}</td>${w(5)}${w(15)}</tr>`;};
  kinds.forEach(k=>{h+=aggRow(k,agg(k),false);});
  h+=aggRow('all',A,true)+`</tbody></table></div>`;
  /* event table */
  const wk=(N,f)=>r=>{const w=r.der.wins&&r.der.wins[N];return w&&w.done?w[f]:-9;};
  const RKEY={tk:r=>r.c.tk,d:r=>r.ev.d,kind:r=>r.ev.kind,sizeM:r=>r.ev.sizeM||0,rx:r=>r.der.reaction!=null?r.der.reaction:-9,r5:wk(5,'r'),r15:wk(15,'r')};
  const kf=RKEY[rzSort]||RKEY.d;
  rows.sort((x,y)=>{const av=kf(x),bv=kf(y);return (typeof av==='string'?av.localeCompare(bv):av-bv)*rzDir;});
  const cols=[['tk','Company',''],['d','Announced',''],['kind','Type',''],['sizeM','Size','r'],['rx','Day 0','r'],['r5','+5d','r'],['r15','+15d','r']];
  h+=`<div style="overflow-x:auto"><table class="stab"><thead><tr><th></th>${cols.map(([k,lab,cl])=>`<th class="${cl}" data-rz="${k}">${lab}${rzSort===k?' <span class="arr">'+(rzDir<0?'▾':'▴')+'</span>':''}</th>`).join('')}</tr></thead><tbody>`;
  const wcell=(der,N)=>{if(der.status!=='ok'||!der.wins[N])return '—';const w=der.wins[N];
    return w.done?col(w.r,pc(w.r)):`<span class="sofar">${pc(w.r)} (${w.el}d)</span>`;};
  rows.forEach((r,i)=>{const{c,ev,der}=r,ok=der.status==='ok';
    h+=`<tr class="rzrow srow${ok?'':' rzdim'}" data-i="${i}"><td style="width:18px;color:var(--indigo-soft)">▸</td>`+
      `<td class="co">${c.tk}</td>`+
      `<td class="mono">${ev.d}${ev.ah?'<span style="color:var(--ink-soft)" title="announced after the close — day 0 is the next session"> ah</span>':''}</td>`+
      `<td><span class="prov ${RZ_KIND_CLS[ev.kind]||'estimated'}">${ev.kind}</span></td>`+
      `<td class="r mono">${ev.sizeM?fmtM(ev.sizeM):'—'}</td>`+
      `<td class="r mono">${ok?col(der.reaction,pc(der.reaction)):`<span style="color:var(--ink-soft)">${der.status==='pending'?'awaiting mark':'no price history'}</span>`}</td>`+
      `<td class="r mono">${wcell(der,5)}</td><td class="r mono">${wcell(der,15)}</td></tr>`;
    const xs=N=>der.status==='ok'&&der.wins[N]?` <span style="color:var(--ink-soft)">(xs ${pc(der.wins[N].x)}${der.wins[N].done?'':' so far'})</span>`:'';
    h+=`<tr class="sdetail" id="rz-${i}"><td colspan="8"><div style="padding:8px 14px 12px;font-size:12px;line-height:1.8">`+
      `<b>Announced</b> ${ev.d}${ev.ah?' — after the close; day 0 is the next session':''}`+
      (ok?` · <b>day 0</b> ${der.d0}: ${fmtPrice(der.baseline)} → ${fmtPrice(der.px0)} (${pc(der.reaction)})`:'')+
      (ev.sizeM?` · <b>size</b> ${fmtM(ev.sizeM)}${(c.sharesReported||c.shares)&&priceOf(c)?` = ${(ev.sizeM/((c.sharesReported||c.shares)*priceOf(c))*100).toFixed(0)}% of today's mkt cap`:''}`:'')+
      (ok?`<br><b>Windows</b> +5d ${wcell(der,5)}${xs(5)} · +15d ${wcell(der,15)}${xs(15)} · +30d ${wcell(der,30)}${xs(30)}`:'')+
      (ev.terms?`<br><b>Terms</b> ${ev.terms}`:'')+(ev.use?`<br><b>Purpose</b> ${ev.use}`:'')+
      `<br><b>Source</b> <span style="color:var(--ink-soft)">${ev.source||'—'}</span> · <a class="clearfilter" href="#${c.tk}" style="font-size:11px">open ${c.tk} page →</a></div></td></tr>`;
  });
  h+=`</tbody></table></div><div class="legend2" style="margin-top:12px"><b>Day 0</b> = the first ledger session on/after the announcement (<b>ah</b> = announced after the close → next session). Windows are trading days, anchored at the day-0 close — they test buying the reaction, not the round trip. Event-table returns are <b>absolute</b> (the stock's own move). Type summary: <b>abs</b> = median move from the day-0 close, <b>vs univ</b> = the same net of the equal-weight universe benchmark over the window (the name itself is ~1/${COMPANIES.length} of that basket), <b>hit</b> = share that finished positive, (n) = events with the window complete. The row detail adds the +30d path and per-window excess for each event. <i>Italic grey</i> = window still running (return so far — excluded from every aggregate). Ledger closes forward-fill on days without a fresh print, so a flat day 0 on an illiquid name is suspect. Dimmed rows predate the name's ledger history — facts without returns.</div>`;
  body.innerHTML=h;
  body.querySelectorAll('th[data-rz]').forEach(th=>th.addEventListener('click',()=>{const k=th.dataset.rz;
    if(k===rzSort)rzDir*=-1;else{rzSort=k;rzDir=(k==='tk'||k==='kind')?1:-1;}renderRaises();}));
  body.querySelectorAll('.rzrow').forEach(tr=>tr.addEventListener('click',()=>{const d=document.getElementById('rz-'+tr.dataset.i);if(!d)return;d.classList.toggle('open');const car=tr.querySelector('td');if(car&&car.textContent)car.textContent=d.classList.contains('open')?'▾':'▸';}));
}
/* ---- outlook page: the forward book — next leases + earnings setup (judgement, weekly refresh, never a valuation input) ---- */
function renderOutlook(){
  const body=document.getElementById('outlook-body');if(!body)return;
  const O=(RAW_DATA&&RAW_DATA.outlook)||null;
  if(!O){body.innerHTML='<div class="legend2">no outlook yet — generated by the weekly sweep</div>';return;}
  const age=Math.round((Date.now()-new Date(O.asOf))/86400000);
  let h=`<div class="ssummary" style="margin:4px 4px 14px"><span>as of <b>${O.asOf}</b>${age>8?' <span class="prov rumored">stale — sweep overdue</span>':''}</span><span>refreshed <b>weekly</b> (Monday sweep)</span><span><b>${(O.leases||[]).length}</b> lease candidates</span><span><b>${(O.earnings||[]).length}</b> earnings setups</span></div>`;
  h+=`<div style="margin:0 4px 14px"><button class="tab ${olTab==='leases'?'on':''}" data-ot="leases">Next leases</button> <button class="tab ${olTab==='earn'?'on':''}" data-ot="earn">Earnings setup</button>`+(olTab==='leases'?` &nbsp; <label style="font-size:11.5px;color:var(--ink-soft);cursor:pointer"><input type="checkbox" id="ol-big" ${olBigOnly?'checked':''}> big leases only (≥100MW expected)</label>`:'')+`</div>`;
  if(olTab==='leases'){
    let rows=(O.leases||[]).map(r=>({...r}));
    if(olBigOnly)rows=rows.filter(r=>(r.mwHi||0)>=100);
    const K={tk:r=>r.tk,prob:r=>r.prob||0,mw:r=>r.mwHi||0,window:r=>r.window||'',exec:r=>r.exec||0};
    const kf=K[olSort]||K.prob;
    rows.sort((x,y)=>{const a=kf(x),b=kf(y);return (typeof a==='string'?a.localeCompare(b):a-b)*olDir;});
    h+=`<div style="overflow-x:auto"><table class="stab"><thead><tr><th></th>${[['tk','Company',''],['prob','P(lease, 6mo)','r'],['mw','Expected MW','r'],['window','Window',''],['exec','Build speed','r']].map(([k,lab,cl])=>`<th class="${cl}" data-ol="${k}">${lab}${olSort===k?' <span class="arr">'+(olDir<0?'▾':'▴')+'</span>':''}</th>`).join('')}</tr></thead><tbody>`;
    rows.forEach((r,i)=>{
      const oc2=COMPANIES.find(c2=>c2.tk===r.tk);const isOwner=oc2&&(oc2.model==='owner');
      h+=`<tr class="olrow srow" data-i="${i}"><td style="width:18px;color:var(--indigo-soft)">▸</td><td class="co">${r.tk} <span class="prov ${isOwner?'estimated':'disclosed'}" style="font-size:9px">${isOwner?'compute contract':'colo lease'}</span></td>`+
        `<td class="r mono"><b>${r.prob}%</b></td>`+
        `<td class="r mono">${r.mwLo!=null?r.mwLo+'–'+r.mwHi:'—'}</td>`+
        `<td style="font-size:11.5px">${r.window||'—'}</td>`+
        `<td class="r mono">${'★'.repeat(Math.round(r.exec||0))||'—'}</td></tr>`;
      h+=`<tr class="sdetail" id="ol-${i}"><td colspan="6"><div class="sitecalc" style="display:block;padding:10px 14px">`+
        `<div style="font-size:12px;margin-bottom:6px"><b>Likely site:</b> ${r.site||'—'} &nbsp; <b>Candidate tenants:</b> ${r.tenants||'unknown'}</div>`+
        `<ul style="margin:0 0 8px 18px;font-size:11.5px;color:var(--ink-soft)">${(r.drivers||[]).map(d=>`<li>${d}</li>`).join('')}</ul>`+
        `<div style="font-size:10.5px;color:var(--ink-soft)">${(r.sources||[]).join(' · ')}</div>`+
        `<a class="clearfilter" href="#${r.tk}" style="font-size:11px">open ${r.tk} page →</a></div></td></tr>`;});
    h+=`</tbody></table></div><div class="legend2" style="margin-top:12px"><b>P(lease)</b> = our probability of the NEXT BINDING REVENUE COMMITMENT inside ~6 months — for <b>landlords</b> a colo lease (they own the shell, a tenant signs); for <b>owners</b> (CRWV/NBIS/IREN/HIVE) a take-or-pay <b>compute contract</b> (capacity sold, not property let — these names appear as TENANTS in other landlords' books) — judgement built from negotiation language in filings/calls, financing tripwires, exclusivities, site readiness and tenant-side signals. <b>Build speed</b> = differential execution (announced→energized track record vs peers). Click a row for the evidence.</div>`;
  }else{
    let rows=(O.earnings||[]).map(r=>({...r}));
    const K={tk:r=>r.tk,date:r=>r.date||'9999',score:r=>r.score||0,dir:r=>r.direction||''};
    const kf=K[oeSort]||K.score;
    rows.sort((x,y)=>{const a=kf(x),b=kf(y);return (typeof a==='string'?a.localeCompare(b):a-b)*oeDir;});
    h+=`<div style="overflow-x:auto"><table class="stab"><thead><tr><th></th>${[['tk','Company',''],['date','Reports',''],['score','Surprise score','r'],['dir','Lean','']].map(([k,lab,cl])=>`<th class="${cl}" data-oe="${k}">${lab}${oeSort===k?' <span class="arr">'+(oeDir<0?'▾':'▴')+'</span>':''}</th>`).join('')}</tr></thead><tbody>`;
    rows.forEach((r,i)=>{
      const cls=r.direction==='upside'?'disclosed':r.direction==='downside'?'rumored':'estimated';
      h+=`<tr class="oerow srow" data-i="${i}"><td style="width:18px;color:var(--indigo-soft)">▸</td><td class="co">${r.tk}</td>`+
        `<td style="font-size:11.5px">${r.date||'TBC'}${r.session?' '+r.session:''}${r.confirmed?'':' <span style="color:var(--ink-soft)">(est.)</span>'}</td>`+
        `<td class="r mono"><b>${r.score>0?'+':''}${r.score}</b></td>`+
        `<td><span class="prov ${cls}">${r.direction||'—'}</span></td></tr>`;
      h+=`<tr class="sdetail" id="oe-${i}"><td colspan="5"><div class="sitecalc" style="display:block;padding:10px 14px">`+
        `<div style="font-size:12px;margin-bottom:6px"><b>The number that decides it:</b> ${r.keyNumber||'—'}${r.consensusRevM?' &nbsp; <b>Consensus rev:</b> $'+r.consensusRevM+'M':''}</div>`+
        `<ul style="margin:0 0 8px 18px;font-size:11.5px;color:var(--ink-soft)">${(r.drivers||[]).map(d=>`<li>${d}</li>`).join('')}</ul>`+
        `<div style="font-size:11px;margin-bottom:6px"><b>Sentiment:</b> ${r.sentiment||'—'}</div>`+
        `<div style="font-size:10.5px;color:var(--ink-soft)">${(r.sources||[]).join(' · ')}</div>`+
        `<a class="clearfilter" href="#${r.tk}" style="font-size:11px">open ${r.tk} page →</a></div></td></tr>`;});
    h+=`</tbody></table></div><div class="legend2" style="margin-top:12px"><b>Surprise score</b> (−5…+5) = likelihood × magnitude of an earnings-day surprise <b>relative to what the selloff has already priced</b> — not a forecast of good results, a forecast of the market's reaction risk. Dates from the owner's calendar (est. = unconfirmed). Click a row for the evidence and sentiment read.</div>`;
  }
  body.innerHTML=h;
  body.querySelectorAll('[data-ot]').forEach(b=>b.addEventListener('click',()=>{olTab=b.dataset.ot;renderOutlook();}));
  const big=document.getElementById('ol-big');if(big)big.addEventListener('change',()=>{olBigOnly=big.checked;renderOutlook();});
  body.querySelectorAll('th[data-ol]').forEach(th=>th.addEventListener('click',()=>{const k=th.dataset.ol;if(k===olSort)olDir*=-1;else{olSort=k;olDir=(k==='tk'||k==='window')?1:-1;}renderOutlook();}));
  body.querySelectorAll('th[data-oe]').forEach(th=>th.addEventListener('click',()=>{const k=th.dataset.oe;if(k===oeSort)oeDir*=-1;else{oeSort=k;oeDir=(k==='tk'||k==='date'||k==='dir')?1:-1;}renderOutlook();}));
  body.querySelectorAll('.olrow').forEach(tr=>tr.addEventListener('click',()=>{const d=document.getElementById('ol-'+tr.dataset.i);if(d)d.classList.toggle('open');const c2=tr.querySelector('td');if(c2)c2.textContent=d&&d.classList.contains('open')?'▾':'▸';}));
  body.querySelectorAll('.oerow').forEach(tr=>tr.addEventListener('click',()=>{const d=document.getElementById('oe-'+tr.dataset.i);if(d)d.classList.toggle('open');const c2=tr.querySelector('td');if(c2)c2.textContent=d&&d.classList.contains('open')?'▾':'▸';}));
}
/* ---- GPU ramp page (spec §6 screen 11) — the rollout explorer: scrub or replay the build-out quarter by
   quarter, per-quarter dispatches, tranche spotlight, synced crosshairs, model-vs-street mode.
   Display-only; never a valuation input ---- */
let rampCo='IREN';
let RAMP_T=null,RAMP_PLAYING=false,RAMP_RAF=0,RAMP_LASTF=0,RAMP_IV=null,RAMP_SEL=null,RAMP_INTRO_TO=0,RAMP_CTX=null,RAMP_CUR=-1,RAMP_REV_MODE='gen';
const RAMP_GEN={hopper:{c:'var(--gen-hopper)',n:'Hopper'},blackwell:{c:'var(--gen-blackwell)',n:'Blackwell'},rubin:{c:'var(--gen-rubin)',n:'Rubin-class'},next:{c:'var(--gen-next)',n:'Next-gen'}};
const RAMP_QS=l=>{const y=+l.slice(0,4),q=+l.slice(5);return (y-2026)*4+q;};
const RAMP_QL=s=>`${2026+Math.floor((s-1)/4)}Q${((s-1)%4)+1}`;
const RAMP_START=3,RAMP_END=20;   // 2026Q3 .. 2030Q4
function rampQuarters(R){
  const YR=s=>2026+Math.floor((s-1)/4);   // serial 1 = 2026Q1 … 20 = 2030Q4
  const out=[];
  for(let s=RAMP_START;s<=RAMP_END;s++){
    const by={hopper:0,blackwell:0,rubin:0,next:0},rv={hopper:0,blackwell:0,rubin:0,next:0},camps={};
    let cum=0,prev=0,signed=0,ctr=0,rev=0;
    R.tranches.forEach(t=>{
      const rs=RAMP_QS(t.rev),f=Math.min(Math.max((s-rs+1)/t.rampQtrs,0),1),f0=Math.min(Math.max((s-rs)/t.rampQtrs,0),1);
      if(f<=0)return;const live=t.gpus*f;
      by[t.gen]+=live;cum+=live;prev+=t.gpus*f0;signed+=live*(t.signed||0);ctr+=live*t.ctr;camps[t.campus]=1;
      const er=t.ctr*t.rate+(1-t.ctr)*(R.spot[String(YR(s))]||0)*(R.spotMult[t.gen]||1);
      const rq=live*er*2190/1e6;rv[t.gen]+=rq;rev+=rq;});
    const grossMW=R.tranches.filter(t=>RAMP_QS(t.energize)<=s).reduce((a,t)=>a+t.grossMW,0);
    const itMW=R.tranches.reduce((a,t)=>{const rs=RAMP_QS(t.rev),f=Math.min(Math.max((s-rs+1)/t.rampQtrs,0),1);return a+t.itMW*f;},0);
    const lbl=RAMP_QL(s);const cons=(R.consensus||{})[lbl]||null;
    out.push({s,lbl,by,rv,cum,added:cum-prev,signed,ctr,rev,grossMW,itMW,nCamps:Object.keys(camps).length,
      mining:(R.mining||{})[lbl]||0,consTot:cons?cons[0]:null,consAI:cons?cons[1]:null,
      blend:cum>0?rev*1e6/(cum*2190):0});}
  return out;
}
function rampTrancheAt(R,t,s){   // {gpus,revM} of one tranche in quarter s
  const rs=RAMP_QS(t.rev),f=Math.min(Math.max((s-rs+1)/t.rampQtrs,0),1);
  if(f<=0)return{g:0,r:0};
  const yr=2026+Math.floor((s-1)/4);
  const er=t.ctr*t.rate+(1-t.ctr)*(R.spot[String(yr)]||0)*(R.spotMult[t.gen]||1);
  return{g:t.gpus*f,r:t.gpus*f*er*2190/1e6};
}
function rampEvents(R,Q){
  const ev={};const add=(s,k,t)=>{if(s<RAMP_START||s>RAMP_END)return;(ev[s]=ev[s]||[]).push({k,t});};
  R.tranches.forEach(t=>{
    add(RAMP_QS(t.energize),'power',`${t.n} energized — +${t.grossMW}MW at ${t.campus}`);
    add(RAMP_QS(t.rev),'rev',`${t.n} starts earning — ${Math.round(t.gpus/1000)}k ${RAMP_GEN[t.gen].n} GPUs ramp over ${t.rampQtrs} qtr${t.rampQtrs>1?'s':''}${(t.signed||0)>0?'':' · uncontracted today'}`);});
  Q.forEach((q,i)=>{const p=i>0?Q[i-1]:null;
    const x=(f,lvl,txt)=>{if((p?p[f]:0)<lvl&&q[f]>=lvl)add(q.s,'mile',txt);};
    x('grossMW',480,'480MW energized — the 2026 program lands (company target)');
    x('grossMW',1210,'1,210MW energized — the 2027 program lands (company target)');
    [[100000,'100k'],[250000,'250k'],[500000,'500k'],[750000,'750k']].forEach(([l,n])=>x('cum',l,`fleet passes ${n} revenue-generating GPUs`));
    if(p&&p.by.rubin<=0&&q.by.rubin>0)add(q.s,'mile','first Rubin-class silicon earns — the Sweetwater / 800V-DC era begins');
    if(p&&p.by.next<=0&&q.by.next>0)add(q.s,'mile','first next-generation silicon earns');
    if(p&&p.consTot!=null&&q.consTot!=null&&(p.rev+p.mining)<=p.consTot&&(q.rev+q.mining)>q.consTot)add(q.s,'mile','model revenue passes street consensus — the capacity wedge opens');
    if(p&&p.mining>0&&q.mining<=0)add(q.s,'mile','Bitcoin mining revenue reaches zero — the pivot completes');});
  return ev;
}
let RAMP_TIP_EL=null;
// two-layer escape for tip strings embedded in inline single-quoted handler attributes:
// JS layer (backslash, then apostrophe) then HTML-attribute layer (& before ") — &#39; alone decodes back to ' and breaks the handler
const rampTipEsc=s=>s.replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/&/g,'&amp;').replace(/"/g,'&quot;');
function rampTip(e,html){const wrap=e.currentTarget&&e.currentTarget.closest?e.currentTarget.closest('.bo-wrap'):null;
  const t=wrap?wrap.querySelector('.bo-tip'):null;if(!t)return;RAMP_TIP_EL=t;t.innerHTML=html;t.style.display='block';
  const w=wrap.getBoundingClientRect();let x=e.clientX-w.left+14,y=e.clientY-w.top+14;
  if(x+t.offsetWidth>w.width-6)x=w.width-t.offsetWidth-6;if(x<2)x=2;t.style.left=x+'px';t.style.top=y+'px';}
function rampTipHide(){if(RAMP_TIP_EL)RAMP_TIP_EL.style.display='none';}
/* ---- chart builders: each emits a ghost layer (full picture, faint) + a reveal layer clipped at the scrub time ---- */
const RAMP_GANTT={W:960,ml:150,mr:56,d0:2025.6,d1:2031.2};
function rampGanttX(dec){const G=RAMP_GANTT;return G.ml+(dec-G.d0)*((G.W-G.ml-G.mr)/(G.d1-G.d0));}
function rampGanttHTML(R){
  const G=RAMP_GANTT,W=G.W;
  const dec=l=>{const y=+l.slice(0,4),q=+l.slice(5);return y+(q-1)*0.25;};
  const CAMPS=[...new Set([...R.tranches].sort((a,b)=>dec(a.energize)-dec(b.energize)).map(t=>t.campus))];
  const rows=R.tranches.map((t,ti)=>({t,ti})).sort((a,b)=>(CAMPS.indexOf(a.t.campus)-CAMPS.indexOf(b.t.campus))||(dec(a.t.energize)-dec(b.t.energize)));
  const rowH=22,top=44,H=top+rows.length*rowH+26;
  const X=rampGanttX,tx='style="font-family:var(--mono);font-size:10px;fill:var(--ink-soft)"';
  let stat='',bars='';
  stat+='<defs>'+Object.entries(RAMP_GEN).map(([k,g])=>`<pattern id="rghx-${k}" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="5" height="5" fill="${g.c}" opacity="0.3"/><rect width="2.2" height="5" fill="${g.c}" opacity="0.85"/></pattern>`).join('')+
    `<clipPath id="rampClipG"><rect id="rampClipGR" x="0" y="0" width="${W}" height="${H}"/></clipPath></defs>`;
  for(let yr=2026;yr<=2031;yr++){const x=X(yr);stat+=`<line x1="${x.toFixed(1)}" y1="18" x2="${x.toFixed(1)}" y2="${H-22}" style="stroke:var(--line);stroke-width:1"/><text x="${(x+4).toFixed(1)}" y="${H-8}" ${tx}>${yr}</text>`;}
  const tn=X(NOW);
  stat+=`<line x1="${tn.toFixed(1)}" y1="18" x2="${tn.toFixed(1)}" y2="${H-22}" style="stroke:var(--clay);stroke-width:1;stroke-dasharray:2 3"/><text x="${(tn-4).toFixed(1)}" y="${H-26}" text-anchor="end" style="font-family:var(--mono);font-size:9px;fill:var(--clay)">TODAY</text>`;
  // era bands: the three chapters of the calendar
  const ERAS=[[2026,2027,'PROVE','480MW · 150k GPUs'],[2027,2028,'SCALE','the 1,210MW program'],[2028,2031.1,'COMPOUND','Sweetwater · Kiowa · EU / AU']];
  ERAS.forEach(([a,b,nm,sub],i)=>{const x0=X(Math.max(a,G.d0)),x1=X(Math.min(b,G.d1));
    stat+=`<rect x="${x0.toFixed(1)}" y="18" width="${(x1-x0).toFixed(1)}" height="${H-40}" fill="${i%2?'rgba(42,39,34,.028)':'transparent'}" style="pointer-events:none"/>`;
    stat+=`<text x="${(x0+6).toFixed(1)}" y="30" style="font-family:var(--mono);font-size:9px;fill:var(--ink);letter-spacing:.14em;font-weight:500">${nm}</text><text x="${(x0+6).toFixed(1)}" y="40" style="font-family:var(--mono);font-size:8.5px;fill:var(--ink-soft)">${sub}</text>`;});
  stat+=`<rect x="${G.ml}" y="18" width="${W-G.ml-G.mr}" height="${H-40}" fill="transparent" style="cursor:crosshair" onclick="rampGanttSeek(event)"/>`;
  let lastCamp=null;
  rows.forEach(({t,ti},i)=>{const y=top+i*rowH;
    if(t.campus!==lastCamp){lastCamp=t.campus;
      const span=rows.filter(r=>r.t.campus===t.campus).length;
      if(CAMPS.indexOf(t.campus)%2)stat+=`<rect x="0" y="${y-2}" width="${G.ml-8}" height="${span*rowH}" fill="rgba(55,73,91,.045)" style="pointer-events:none"/>`;
      stat+=`<text x="4" y="${y+12}" style="font-family:var(--mono);font-size:9.5px;fill:var(--ink);letter-spacing:.06em">${t.campus.toUpperCase()}</text>`;}
    const th=Math.max(4,Math.sqrt(t.grossMW)*1.05),x0=X(dec(t.energize)),x1=X(2031.1);
    const g=RAMP_GEN[t.gen],solid=(t.signed||0)>0;
    const tip=`<b>${t.n}</b><br>${t.campus} · ${g.n}<br>${t.grossMW}MW gross · ${t.itMW}MW IT · ${(t.gpus/1000).toFixed(0)}k GPUs<br>energized ${t.energize} · first revenue ${t.rev} (${t.rampQtrs}q ramp)<br>${solid?`signed today (${Math.round(t.ctr*100)}% @ $${t.rate.toFixed(2)}/GPU-hr)`:`uncontracted today · modeled ${Math.round(t.ctr*100)}% @ $${t.rate.toFixed(2)}/GPU-hr at commissioning`}<br><span style="color:var(--ink-soft)">click to spotlight this tranche</span>`;
    const rect=cls=>`<rect class="${cls}" data-ti="${ti}" x="${x0.toFixed(1)}" y="${(y+(rowH-4-th)/2).toFixed(1)}" width="${(x1-x0).toFixed(1)}" height="${th.toFixed(1)}" fill="${solid?g.c:`url(#rghx-${t.gen})`}"${solid?' opacity="0.9"':''}`;
    bars+=rect('rampbarR')+` style="cursor:pointer" onmousemove="rampTip(event,'${rampTipEsc(tip)}')" onmouseleave="rampTipHide()" onclick="rampSelect(${ti})"/>`;
    const rx=X(dec(t.rev));
    bars+=`<path data-ti="${ti}" class="rampbarR" d="M ${rx.toFixed(1)} ${y+rowH/2-6} l 4.5 5 l -4.5 5 l -4.5 -5 z" fill="var(--ink)" opacity="0.85" style="pointer-events:none"/>`;
    stat+=`<text x="${(X(2031.1)+3).toFixed(1)}" y="${y+rowH/2+3}" style="font-family:var(--mono);font-size:9px;fill:var(--ink-soft)">${t.grossMW}MW</text>`;});
  const ghost=`<g class="rampghost" style="pointer-events:none">${bars.replace(/onmousemove="[^"]*" onmouseleave="[^"]*" onclick="[^"]*"/g,'')}</g>`;
  const reveal=`<g clip-path="url(#rampClipG)">${bars}</g>`;
  const sweep=`<g id="rampSweepG" style="pointer-events:none"><line id="rampSweepGL" x1="0" y1="18" x2="0" y2="${H-22}" style="stroke:var(--ink);stroke-width:1.5"/><g id="rampSweepChip"><rect id="rampSweepChipR" x="-26" y="2" width="52" height="15" rx="3" fill="var(--ink)"/><text id="rampSweepGT" x="0" y="13" text-anchor="middle" style="font-family:var(--mono);font-size:9.5px;fill:var(--paper);font-weight:600"></text></g></g>`;
  const hl=`<rect id="rampHLG" y="18" height="${H-40}" width="0" fill="rgba(55,73,91,.07)" style="pointer-events:none"/>`;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Capacity tranches by campus: energization to first revenue; drag the timeline to replay">${stat}${hl}${ghost}${reveal}${sweep}</svg>`;
}
const RAMP_F={W:960,ml:54,mr:20,H:300,mt:16,mb:26};
function rampFleetHTML(Q){
  const F=RAMP_F,W=F.W,ml=F.ml,mr=F.mr,H=F.H,mt=F.mt,ph=H-mt-F.mb;
  const max=Math.max(...Q.map(q=>q.cum))*1.06;
  const X=i=>ml+i*((W-ml-mr)/(Q.length-1)),Y=v=>mt+ph-(v/max)*ph;
  RAMP_F.X=X;RAMP_F.Y=Y;RAMP_F.max=max;
  const tx='style="font-family:var(--mono);font-size:10px;fill:var(--ink-soft)"';
  let stat='',body='';
  stat+=`<defs><clipPath id="rampClipF"><rect id="rampClipFR" x="0" y="0" width="${W}" height="${H}"/></clipPath></defs>`;
  for(let k=0;k<max;k+=200000){stat+=`<line x1="${ml}" y1="${Y(k).toFixed(1)}" x2="${W-mr}" y2="${Y(k).toFixed(1)}" style="stroke:var(--line);stroke-width:1"/><text x="${ml-6}" y="${(Y(k)+3).toFixed(1)}" text-anchor="end" ${tx}>${k===0?'0':k/1000+'k'}</text>`;}
  Q.forEach((q,i)=>{if(i%2)return;stat+=`<text x="${X(i).toFixed(1)}" y="${H-8}" text-anchor="middle" ${tx}>${q.lbl}</text>`;});
  // era annotations: first Rubin quarter, first next-gen quarter
  const mark=(cond,txt)=>{const i=Q.findIndex(cond);if(i<0)return;
    stat+=`<line x1="${X(i).toFixed(1)}" y1="${mt}" x2="${X(i).toFixed(1)}" y2="${mt+10}" style="stroke:var(--ink-soft);stroke-width:1"/><text x="${(X(i)+4).toFixed(1)}" y="${mt+8}" style="font-family:var(--mono);font-size:8.5px;fill:var(--ink-soft);letter-spacing:.08em">${txt}</text>`;};
  mark(q=>q.by.rubin>0,'SWEETWATER / RUBIN ERA');
  mark(q=>q.by.next>0,'NEXT-GEN');
  let base=Q.map(()=>0);
  ['hopper','blackwell','rubin','next'].forEach(gk=>{
    const tops=Q.map((q,i)=>base[i]+q.by[gk]);
    if(tops.some((t,i)=>t>base[i])){
      const p='M'+Q.map((q,i)=>`${X(i).toFixed(1)},${Y(tops[i]).toFixed(1)}`).join(' L')+' L'+[...Q].map((q,i)=>Q.length-1-i).map(i=>`${X(i).toFixed(1)},${Y(base[i]).toFixed(1)}`).join(' L')+' Z';
      body+=`<path d="${p}" fill="${RAMP_GEN[gk].c}" opacity="0.82" style="stroke:var(--card);stroke-width:1.5"/>`;}
    base=tops;});
  body+=`<path d="M${Q.map((q,i)=>`${X(i).toFixed(1)},${Y(q.signed).toFixed(1)}`).join(' L')}" fill="none" style="stroke:var(--ink);stroke-width:1.8;stroke-dasharray:6 4"/>`;
  const li=gk=>{let bi=-1,bv=0;Q.forEach((q,i)=>{if(q.by[gk]>bv){bv=q.by[gk];bi=i;}});return bi;};
  const lbl=(gk,txt,fill)=>{const i=li(gk);if(i<0)return '';const q=Q[i];let b=0;for(const g of ['hopper','blackwell','rubin','next']){if(g===gk)break;b+=q.by[g];}
    if(q.by[gk]<=60000)return '';
    let cy=Y(b+q.by[gk]*0.5);const sy=Y(q.signed);if(Math.abs(cy-sy)<12)cy+=(cy>=sy?14:-14);
    return `<text x="${X(i).toFixed(1)}" y="${(cy+4).toFixed(1)}" text-anchor="middle" style="font-family:var(--mono);font-size:10px;font-weight:600;fill:${fill}">${txt}</text>`;};
  body+=lbl('blackwell','BLACKWELL','#fff')+lbl('rubin','RUBIN','#fff')+lbl('next','NEXT','#7c2c52');
  body+=`<text x="${X(5).toFixed(1)}" y="${(Y(Q[5].signed)-7).toFixed(1)}" style="font-family:var(--mono);font-size:9.5px;fill:var(--ink)">contracted today (signed book)</text>`;
  let cap='';
  Q.forEach((q,i)=>{const tip=`<b>${q.lbl}</b><br>fleet ${(q.cum/1000).toFixed(0)}k GPUs (+${(q.added/1000).toFixed(1)}k)<br>`+['hopper','blackwell','rubin','next'].filter(g=>q.by[g]>0).map(g=>`${RAMP_GEN[g].n} ${(q.by[g]/1000).toFixed(0)}k`).join(' · ')+`<br>signed today ${(q.signed/1000).toFixed(0)}k · modeled contracted ${q.cum>0?Math.round(q.ctr/q.cum*100)+'%':'—'}<br><span style="color:var(--ink-soft)">click to jump the timeline here</span>`;
    cap+=`<rect x="${(X(i)-((W-ml-mr)/(Q.length-1))/2).toFixed(1)}" y="${mt}" width="${((W-ml-mr)/(Q.length-1)).toFixed(1)}" height="${ph}" fill="transparent" style="cursor:pointer" onmousemove="rampTip(event,'${rampTipEsc(tip)}');rampHoverQ(${i})" onmouseleave="rampTipHide();rampHoverClear()" onclick="rampSeekQ(${i})"/>`;});
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Revenue-generating GPUs by generation, quarterly">${stat}<rect id="rampHLF" y="${mt}" height="${ph}" width="0" fill="rgba(55,73,91,.07)" style="pointer-events:none"/><g class="rampghost" style="pointer-events:none">${body}</g><g clip-path="url(#rampClipF)">${body}</g><path id="rampSelF0" fill="none" style="stroke:var(--card);stroke-width:4;pointer-events:none" d=""/><path id="rampSelF" fill="none" style="stroke-width:2;pointer-events:none" d=""/>${cap}</svg>`;
}
function rampRevHTML(Q,mode){
  const F=RAMP_F,W=F.W,ml=F.ml,mr=F.mr,H=310,mt=16,ph=H-mt-26;
  const tots=Q.map(q=>q.rev+q.mining);
  const max=Math.max(...tots)*1.1;
  const n=Q.length,slot=(W-ml-mr)/n,bw=slot*0.6;
  const X=i=>ml+i*slot+slot/2,Y=v=>mt+ph-(v/max)*ph;
  RAMP_F.rX=X;RAMP_F.rY=Y;RAMP_F.rmax=max;RAMP_F.rslot=slot;
  const tx='style="font-family:var(--mono);font-size:10px;fill:var(--ink-soft)"';
  let stat='',body='',cap='';
  stat+=`<defs><clipPath id="rampClipR"><rect id="rampClipRR" x="0" y="0" width="${W}" height="${H}"/></clipPath></defs>`;
  for(let k=0;k<max;k+=2000){stat+=`<line x1="${ml}" y1="${Y(k).toFixed(1)}" x2="${W-mr}" y2="${Y(k).toFixed(1)}" style="stroke:var(--line);stroke-width:1"/><text x="${ml-6}" y="${(Y(k)+3).toFixed(1)}" text-anchor="end" ${tx}>${k===0?'0':'$'+k/1000+'B'}</text>`;}
  Q.forEach((q,i)=>{if(i%2===0)stat+=`<text x="${X(i).toFixed(1)}" y="${H-8}" text-anchor="middle" ${tx}>${q.lbl}</text>`;});
  const consPts=Q.map((q,i)=>q.consTot!=null?[i,q.consTot]:null).filter(Boolean);
  if(mode==='street'){
    // the wedge: model total vs street, trapezoid-shaded by sign per quarter (empty-safe)
    for(let k=0;k<consPts.length-1;k++){
      const [i0,c0]=consPts[k],[i1,c1]=consPts[k+1],t0=tots[i0],t1=tots[i1];
      const above=(t0-c0+t1-c1)/2>=0;
      body+=`<path d="M${X(i0).toFixed(1)},${Y(t0).toFixed(1)} L${X(i1).toFixed(1)},${Y(t1).toFixed(1)} L${X(i1).toFixed(1)},${Y(c1).toFixed(1)} L${X(i0).toFixed(1)},${Y(c0).toFixed(1)} Z" fill="${above?'rgba(91,122,92,.16)':'rgba(170,107,79,.16)'}"/>`;}
    if(consPts.length){
      body+=`<path d="M${consPts.map(([i,c])=>`${X(i).toFixed(1)},${Y(c).toFixed(1)}`).join(' L')}" fill="none" style="stroke:var(--ink-soft);stroke-width:1.8;stroke-dasharray:6 4"/>`;
      consPts.forEach(([i,c])=>{body+=`<circle cx="${X(i).toFixed(1)}" cy="${Y(c).toFixed(1)}" r="2.6" fill="var(--ink-soft)" style="stroke:var(--card);stroke-width:1.5"/>`;});}
    body+=`<path d="M${Q.map((q,i)=>`${X(i).toFixed(1)},${Y(tots[i]).toFixed(1)}`).join(' L')}" fill="none" style="stroke:var(--indigo);stroke-width:2.4"/>`;
    Q.forEach((q,i)=>{body+=`<circle cx="${X(i).toFixed(1)}" cy="${Y(tots[i]).toFixed(1)}" r="2.8" fill="var(--indigo)" style="stroke:var(--card);stroke-width:1.5"/>`;});
    if(consPts.length){
      // per-quarter deltas, every other consensus quarter
      consPts.forEach(([i,c],k)=>{if(k%2)return;const d=tots[i]/c-1;if(Math.abs(d)<0.005)return;
        body+=`<text x="${X(i).toFixed(1)}" y="${(Math.min(Y(tots[i]),Y(c))-8).toFixed(1)}" text-anchor="middle" style="font-family:var(--mono);font-size:9px;font-weight:600;fill:${d>=0?'var(--pine)':'var(--clay)'}">${d>=0?'+':''}${Math.round(d*100)}%</text>`;});
      const [li2,lc]=consPts[consPts.length-1];
      body+=`<text x="${(X(li2)+8).toFixed(1)}" y="${(Y(lc)+4).toFixed(1)}" style="font-family:var(--mono);font-size:9.5px;fill:var(--ink-soft)">street</text>`;
      // cumulative wedge annotation, anchored inside the wedge opening (index-safe for shorter consensus runs)
      const wedge=consPts.reduce((a,[i,c])=>a+(tots[i]-c),0);
      const kk=Math.min(13,consPts.length-1),[wi,wc]=consPts[kk];
      body+=`<text x="${X(Math.min(wi+1,Q.length-1)).toFixed(1)}" y="${((Y(tots[wi])+Y(wc))/2).toFixed(1)}" text-anchor="middle" style="font-family:var(--mono);font-size:9.5px;fill:${wedge>=0?'var(--pine)':'var(--clay)'}">the wedge: ${wedge>=0?'+':'−'}$${(Math.abs(wedge)/1000).toFixed(1)}B cumulative vs street</text>`;}
    body+=`<text x="${(X(Q.length-1)-8).toFixed(1)}" y="${(Y(tots[Q.length-1])-8).toFixed(1)}" text-anchor="end" style="font-family:var(--mono);font-size:9.5px;fill:var(--indigo);font-weight:600">model</text>`;
  }else{
    Q.forEach((q,i)=>{let y0=mt+ph;
      const parts=[['mining',q.mining,'var(--far)','BTC mining (residual)'],...['hopper','blackwell','rubin','next'].map(g=>[g,q.rv[g],RAMP_GEN[g].c,RAMP_GEN[g].n])];
      parts.forEach(([g,v,col])=>{if(v<1)return;const h=(v/max)*ph;
        body+=`<rect x="${(X(i)-bw/2).toFixed(1)}" y="${(y0-h).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(h,0.5).toFixed(1)}" fill="${col}" style="stroke:var(--card);stroke-width:1.5"/>`;y0-=h;});});
    if(consPts.length){body+=`<path d="M${consPts.map(([i,c])=>`${X(i).toFixed(1)},${Y(c).toFixed(1)}`).join(' L')}" fill="none" style="stroke:var(--ink-soft);stroke-width:1.8;stroke-dasharray:6 4"/>`;
      consPts.forEach(([i,c])=>{body+=`<circle cx="${X(i).toFixed(1)}" cy="${Y(c).toFixed(1)}" r="2.6" fill="var(--ink-soft)" style="stroke:var(--card);stroke-width:1.5"/>`;});}
  }
  Q.forEach((q,i)=>{
    const parts=[['mining',q.mining,'','BTC mining (residual)'],...['hopper','blackwell','rubin','next'].map(g=>[g,q.rv[g],'',RAMP_GEN[g].n])];
    const tip=`<b>${q.lbl}</b><br>total $${Math.round(q.rev+q.mining)}M${q.consTot?` · consensus $${Math.round(q.consTot)}M (Δ ${Math.round(((q.rev+q.mining)/q.consTot-1)*100)}%)`:''}<br>`+parts.filter(p=>p[1]>=1).map(p=>`${p[3]} $${Math.round(p[1])}M`).join(' · ')+`<br>blend $${q.blend.toFixed(2)}/GPU-hr<br><span style="color:var(--ink-soft)">click to jump the timeline here</span>`;
    cap+=`<rect x="${(X(i)-slot/2).toFixed(1)}" y="${mt}" width="${slot.toFixed(1)}" height="${ph}" fill="transparent" style="cursor:pointer" onmousemove="rampTip(event,'${rampTipEsc(tip)}');rampHoverQ(${i})" onmouseleave="rampTipHide();rampHoverClear()" onclick="rampSeekQ(${i})"/>`;});
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Quarterly revenue ${mode==='street'?'model vs Bloomberg consensus':'by GPU generation vs Bloomberg consensus'}">${stat}<rect id="rampHLR" y="${mt}" height="${ph}" width="0" fill="rgba(55,73,91,.07)" style="pointer-events:none"/><g class="rampghost" style="pointer-events:none">${body}</g><g clip-path="url(#rampClipR)">${body}</g><path id="rampSelR0" fill="none" style="stroke:var(--card);stroke-width:4;pointer-events:none" d=""/><path id="rampSelR" fill="none" style="stroke-width:2;pointer-events:none" d=""/>${cap}</svg>`;
}
/* ---- interactions ---- */
function rampSeek(v,keepPlay){RAMP_T=Math.max(RAMP_START,Math.min(RAMP_END,+v));if(!keepPlay)rampStop();rampApply();}
function rampSeekQ(i){rampSeek(RAMP_START+i);}
function rampGanttSeek(e){const svg=e.currentTarget.ownerSVGElement,r=svg.getBoundingClientRect();
  const vx=(e.clientX-r.left)*(RAMP_GANTT.W/r.width);
  const G=RAMP_GANTT,dec=G.d0+(vx-G.ml)/((G.W-G.ml-G.mr)/(G.d1-G.d0));
  rampSeek((dec-2026)/0.25);}
function rampRevMode(m){if(m===RAMP_REV_MODE)return;RAMP_REV_MODE=m;
  const holder=document.getElementById('rampRevWrap');if(!holder||!RAMP_CTX)return;
  holder.innerHTML=rampRevHTML(RAMP_CTX.Q,m)+'<div class="bo-tip"></div>';
  document.querySelectorAll('[data-rm]').forEach(b=>b.classList.toggle('on',b.dataset.rm===m));
  const lg=document.getElementById('rampRevLeg');if(lg)lg.innerHTML=rampRevLegend(m);
  RAMP_CUR=-1;rampApply();
  if(RAMP_SEL!=null){const keep=RAMP_SEL;RAMP_SEL=null;rampSelect(keep,true);}}
function rampRevLegend(m){
  const genLeg=Object.entries(RAMP_GEN).map(([k,g])=>`<span class="bo-leg"><i style="background:${g.c}"></i>${g.n}</span>`).join('');
  const lineLeg=(col,lab)=>`<span class="bo-leg"><i style="height:0;border-radius:0;border-top:2px dashed ${col}"></i>${lab}</span>`;
  return m==='street'
    ?`<span class="bo-leg"><i style="height:2px;border-radius:0;background:var(--indigo)"></i>model (total)</span>${lineLeg('var(--ink-soft)','consensus (Bloomberg)')}<span class="bo-leg"><i style="background:rgba(91,122,92,.4)"></i>model above street</span><span class="bo-leg"><i style="background:rgba(170,107,79,.4)"></i>below</span>`
    :`${genLeg}<span class="bo-leg"><i style="background:var(--far)"></i>BTC mining (residual)</span>${lineLeg('var(--ink-soft)','consensus (Bloomberg)')}`;}
function rampStop(){if(RAMP_INTRO_TO){clearTimeout(RAMP_INTRO_TO);RAMP_INTRO_TO=0;}
  RAMP_PLAYING=false;if(RAMP_RAF)cancelAnimationFrame(RAMP_RAF);if(RAMP_IV)clearInterval(RAMP_IV);RAMP_RAF=0;RAMP_IV=null;
  const b=document.getElementById('rampPlayBtn');if(b)b.textContent=(RAMP_T>=RAMP_END-0.01)?'↺ replay the build-out':'▶ play';}
function rampPlay(){
  if(RAMP_PLAYING){rampStop();return;}
  if(RAMP_T>=RAMP_END-0.01)RAMP_T=RAMP_START;
  RAMP_PLAYING=true;const b=document.getElementById('rampPlayBtn');if(b)b.textContent='❚❚ pause';
  if(reduce){rampApply();RAMP_IV=setInterval(()=>{RAMP_T=Math.min(RAMP_END,Math.round(RAMP_T)+1);rampApply();if(RAMP_T>=RAMP_END)rampStop();},700);return;}
  RAMP_LASTF=performance.now();
  const step=now=>{if(!RAMP_PLAYING)return;const dt=Math.min((now-RAMP_LASTF)/1000,0.1);RAMP_LASTF=now;
    RAMP_T=Math.min(RAMP_END,RAMP_T+dt*1.6);rampApply();
    if(RAMP_T>=RAMP_END){rampStop();return;}RAMP_RAF=requestAnimationFrame(step);};
  RAMP_RAF=requestAnimationFrame(step);
}
function rampHoverQ(i){const C=RAMP_CTX;if(!C)return;const F=RAMP_F;
  const set=(id,x,w)=>{const el=document.getElementById(id);if(el){el.setAttribute('x',x);el.setAttribute('width',w);}};
  const half=((F.W-F.ml-F.mr)/(C.Q.length-1))/2;
  set('rampHLF',F.X(i)-half,half*2);
  set('rampHLR',F.rX(i)-F.rslot/2,F.rslot);
  const s=RAMP_START+i,x0=rampGanttX(2026+(s-1)*0.25),x1=rampGanttX(2026+s*0.25);
  set('rampHLG',x0,x1-x0);}
function rampHoverClear(){['rampHLF','rampHLR','rampHLG'].forEach(id=>{const el=document.getElementById(id);if(el)el.setAttribute('width',0);});}
function rampSelect(ti,noScroll){
  const C=RAMP_CTX;if(!C)return;
  RAMP_SEL=(RAMP_SEL===ti)?null:ti;
  document.querySelectorAll('#ramp-body [data-ti]').forEach(el=>{el.style.opacity=(RAMP_SEL==null||+el.dataset.ti===RAMP_SEL)?'':'0.12';});
  const card=document.getElementById('rampSelCard');
  const setD=(id,d,col)=>{const el=document.getElementById(id);if(el){el.setAttribute('d',d);if(col)el.style.stroke=col;}};
  if(RAMP_SEL==null){if(card)card.style.display='none';setD('rampSelF','');setD('rampSelF0','');setD('rampSelR','');setD('rampSelR0','');return;}
  const t=C.R.tranches[RAMP_SEL],F=RAMP_F;
  const pts=C.Q.map((q,i)=>rampTrancheAt(C.R,t,q.s));
  const df='M'+C.Q.map((q,i)=>`${F.X(i).toFixed(1)},${F.Y(Math.min(pts[i].g,F.max)).toFixed(1)}`).join(' L');
  const dr='M'+C.Q.map((q,i)=>`${F.rX(i).toFixed(1)},${F.rY(Math.min(pts[i].r,F.rmax)).toFixed(1)}`).join(' L');
  const col=RAMP_GEN[t.gen].c;
  setD('rampSelF0',df);setD('rampSelF',df,col);setD('rampSelR0',dr);setD('rampSelR',dr,col);
  const peak=Math.max(...pts.map(p=>p.r));
  const f=(a,b,note)=>`<div class="cstep"><span>${a}</span><span class="cval">${b}</span><span class="cnote">${note||''}</span></div>`;
  card.style.display='';
  card.innerHTML=`<div class="sitecalc">`+
    `<div class="cstep tot"><span>${t.n}</span><span class="cval">${t.campus}</span><span class="cnote"><a href="#ramp" onclick="rampSelect(${RAMP_SEL});return false" style="color:var(--indigo)">✕ clear spotlight</a></span></div>`+
    f('Generation',RAMP_GEN[t.gen].n)+f('Power',`${t.grossMW}MW gross · ${t.itMW}MW critical IT`)+
    f('Fleet',`${(t.gpus/1000).toFixed(0)}k GPUs`,`${((t.gpus/C.Q[C.Q.length-1].cum)*100).toFixed(0)}% of the YE-30 fleet`)+
    f('Energized',t.energize)+f('First revenue',t.rev,`${t.rampQtrs}-quarter ramp to full`)+
    f('Contract',(t.signed||0)>0?`signed today — ${Math.round(t.ctr*100)}% @ $${t.rate.toFixed(2)}/GPU-hr`:`uncontracted today — modeled ${Math.round(t.ctr*100)}% @ $${t.rate.toFixed(2)}/GPU-hr`,(t.signed||0)>0?'take-or-pay, bills 8,760 hr/yr':'rest earns effective spot')+
    f('Peak quarter',`$${Math.round(peak)}M revenue`)+
    `</div>`;
  if(!noScroll)card.scrollIntoView({behavior:reduce?'auto':'smooth',block:'nearest'});
}
function rampApply(){
  const C=RAMP_CTX;if(!C)return;
  const T=Math.max(RAMP_START,Math.min(RAMP_END,RAMP_T)),cur=Math.min(RAMP_END,Math.round(T)),q=C.Q[cur-RAMP_START];
  // every frame: clips, sweep, scrubber fill
  const gx=rampGanttX(2026+T*0.25);
  const gr=document.getElementById('rampClipGR');if(gr)gr.setAttribute('width',gx.toFixed(1));
  const sl=document.getElementById('rampSweepGL');
  if(sl){sl.setAttribute('x1',gx.toFixed(1));sl.setAttribute('x2',gx.toFixed(1));}
  const chip=document.getElementById('rampSweepChip');
  if(chip)chip.setAttribute('transform',`translate(${Math.max(RAMP_GANTT.ml+26,Math.min(gx,RAMP_GANTT.W-30)).toFixed(1)},0)`);
  const F=RAMP_F,fx=F.X(Math.max(0,T-RAMP_START))+((F.W-F.ml-F.mr)/(C.Q.length-1))/2;
  const fr=document.getElementById('rampClipFR');if(fr)fr.setAttribute('width',fx.toFixed(1));
  const rx=F.rX(Math.max(0,T-RAMP_START))+F.rslot/2;
  const rr=document.getElementById('rampClipRR');if(rr)rr.setAttribute('width',rx.toFixed(1));
  const rg=document.getElementById('rampRange');
  if(rg){rg.value=T;const p=((T-RAMP_START)/(RAMP_END-RAMP_START)*100).toFixed(2);
    rg.style.background=`linear-gradient(to right,var(--indigo) ${p}%,var(--line) ${p}%)`;}
  // quarter-keyed writes: only when the displayed quarter actually changes
  if(cur===RAMP_CUR)return;
  RAMP_CUR=cur;
  const st=document.getElementById('rampSweepGT');if(st)st.textContent=RAMP_QL(cur);
  const qn=document.getElementById('rampQnow');if(qn)qn.textContent=RAMP_QL(cur);
  const S=(id,v)=>{const el=document.getElementById(id);if(!el)return;el.textContent=v;
    if(!reduce){el.classList.remove('tick');void el.offsetWidth;el.classList.add('tick');}};
  S('rs-gpu',(q.cum/1000).toFixed(q.cum<100000?1:0)+'k');
  S('rs-mw',Math.round(q.grossMW).toLocaleString());
  S('rs-it',Math.round(q.itMW).toLocaleString());
  S('rs-rev','$'+Math.round(q.rev+q.mining).toLocaleString()+'M');
  S('rs-blend','$'+q.blend.toFixed(2));
  S('rs-sign',q.cum>0?Math.round(q.signed/q.cum*100)+'%':'—');
  const qp=cur>RAMP_START?C.Q[cur-RAMP_START-1]:null;
  const D=(id,v,fmt)=>{const el=document.getElementById(id+'-d');if(!el)return;
    if(qp==null||v==null||Math.abs(v)<1e-9){el.textContent='';return;}
    el.textContent=(v>0?'+':'−')+fmt(Math.abs(v))+' q/q';el.style.color=v>0?'var(--pine)':'var(--clay)';};
  D('rs-gpu',qp?q.cum-qp.cum:null,v=>(v/1000).toFixed(1)+'k');
  D('rs-mw',qp?q.grossMW-qp.grossMW:null,v=>Math.round(v).toLocaleString());
  D('rs-it',qp?q.itMW-qp.itMW:null,v=>Math.round(v).toLocaleString());
  D('rs-rev',qp?(q.rev+q.mining)-(qp.rev+qp.mining):null,v=>'$'+Math.round(v).toLocaleString()+'M');
  D('rs-blend',qp?q.blend-qp.blend:null,v=>'$'+v.toFixed(2));
  const d=q.consTot!=null?(q.rev+q.mining)/q.consTot-1:null;
  S('rs-street',d==null?'—':(d>=0?'+':'')+Math.round(d*100)+'%');
  const rsEl=document.getElementById('rs-street');if(rsEl)rsEl.style.color=d==null?'':(d>=0?'var(--pine)':'var(--clay)');
  // the dispatch
  const cc=document.getElementById('rampCall');
  if(cc){const evs=C.EV[cur]||[];const nxt=C.EV[cur+1]||[];
    const PILL={power:['disclosed','power'],rev:['estimated','revenue'],mile:['rumored','milestone']};
    cc.innerHTML=`<div class="cq">${RAMP_QL(cur)} · dispatch</div>`+
      (evs.length?evs.map((e,i)=>`<div class="rampev" style="${reduce?'':`animation-delay:${i*60}ms`}"><span class="prov ${PILL[e.k][0]}">${PILL[e.k][1]}</span><span>${e.t}</span></div>`).join(''):`<div class="rampev" style="color:var(--ink-soft)">quiet quarter — capacity ramps, revenue compounds</div>`)+
      (nxt.length?`<div class="rampnext">next quarter: ${nxt[0].t}${nxt.length>1?` (+${nxt.length-1} more)`:''}</div>`:'');}
  if(C.rows)C.rows.forEach((tr,i)=>tr.classList.toggle('ramp-now',i===cur-RAMP_START));
}
function renderRamp(){
  const body=document.getElementById('ramp-body');if(!body)return;
  rampStop();
  const cos=COMPANIES.filter(c=>c.ramp);
  if(!cos.length){body.innerHTML='<div class="legend2">no ramp models yet — built per GPU-cloud name from the quarterly research overlay</div>';RAMP_CTX=null;return;}
  const c=cos.find(x=>x.tk===rampCo)||cos[0];rampCo=c.tk;
  const R=c.ramp,Q=rampQuarters(R),EV=rampEvents(R,Q);
  const last=Q[Q.length-1],signedK=Math.round(R.tranches.reduce((a,t)=>a+t.gpus*(t.signed||0),0)/1000);
  const secured=(c.sites||[]).reduce((a,s)=>a+s.mw,0);
  const genLeg=Object.entries(RAMP_GEN).map(([k,g])=>`<span class="bo-leg"><i style="background:${g.c}"></i>${g.n}</span>`).join('');
  const hatchLeg=`<span class="bo-leg"><i style="background:repeating-linear-gradient(45deg,var(--ink-soft) 0 2px,transparent 2px 4px);border:1px solid var(--line)"></i>hatched = uncontracted today</span>`;
  const lineLeg=(col,lab)=>`<span class="bo-leg"><i style="height:0;border-radius:0;border-top:2px dashed ${col}"></i>${lab}</span>`;
  let h=`<div style="margin:0 4px 12px">${cos.map(x=>`<button class="tab ${x.tk===rampCo?'on':''}" data-rc="${x.tk}">${x.tk}</button>`).join(' ')}<span style="font-size:11px;color:var(--ink-soft);margin-left:10px">model as of ${R.asOf}</span></div>`;
  h+=`<div class="ssummary" style="margin:4px 4px 12px"><span>secured power <b>${(secured/1000).toFixed(1)} GW</b></span><span>modeled in-window <b>${(R.tranches.reduce((a,t)=>a+t.grossMW,0)/1000).toFixed(1)} GW</b></span><span>GPUs 26Q3 <b>${(Q[0].cum/1000).toFixed(1)}k</b> → YE-30 <b>~${Math.round(last.cum/1000)}k</b></span><span>signed book today <b>~${signedK}k GPUs</b></span><span>exit ARR 2030 <b>$${(last.rev*4/1000).toFixed(1)}B</b> @ $${last.blend.toFixed(2)}/GPU-hr</span></div>`;
  // the time machine
  h+=`<div class="rampbar"><button class="rampplay" id="rampPlayBtn">${(RAMP_T==null||RAMP_T>=RAMP_END-0.01)?'↺ replay the build-out':'▶ play'}</button><div class="ramptrack"><div class="rampflags">`+
    Object.keys(EV).map(s=>{const kinds=[...new Set(EV[s].map(e=>e.k))];const col=kinds.includes('mile')?'var(--clay)':kinds.includes('rev')?'var(--gold)':'var(--indigo-soft)';
      return `<i class="rampflag" style="left:${(((+s)-RAMP_START)/(RAMP_END-RAMP_START)*100).toFixed(1)}%;background:${col}" title="${RAMP_QL(+s)}: ${rampTipEsc(EV[s].map(e=>e.t).join(' · '))}" onclick="rampSeek(${s})"></i>`;}).join('')+
    `</div><input type="range" id="rampRange" min="${RAMP_START}" max="${RAMP_END}" step="0.05" value="${RAMP_END}" aria-label="Timeline scrubber — drag to replay the build-out"><div class="rampyears">`+
    [2027,2028,2029,2030].map(y=>`<span style="left:${(((y-2026)*4+1-RAMP_START)/(RAMP_END-RAMP_START)*100).toFixed(1)}%">${y}</span>`).join('')+
    `</div></div><span class="qnow" id="rampQnow">${RAMP_QL(RAMP_END)}</span></div>`;
  // live state panel
  h+=`<div class="rampstats">`+[['rs-gpu','GPUs earning'],['rs-mw','gross MW energized'],['rs-it','critical IT MW active'],['rs-rev','revenue / qtr'],['rs-blend','blend $/GPU-hr'],['rs-sign','fleet signed today'],['rs-street','vs street']].map(([id,lab])=>`<div class="rampstat"><span>${lab}</span><b id="${id}">—</b><i id="${id}-d"></i></div>`).join('')+`</div>`;
  h+=`<div class="rampcall" id="rampCall"></div>`;
  h+=`<h4 class="sec">01 · Concrete — capacity tranches</h4>
    <div class="bo-head"><div class="bo-legend">${genLeg}${hatchLeg}<span class="bo-leg">◆ first revenue</span></div></div><div class="bo-wrap">${rampGanttHTML(R)}<div class="bo-tip"></div></div>`;
  h+=`<div id="rampSelCard" style="display:none;margin:10px 4px 0"></div>`;
  h+=`<div class="legend2" style="margin:6px 4px 0">Only the 480MW YE-26 and 1,210MW YE-27 programs are company commitments; everything later is modeled cadence. Tranches sum to the ~${(R.tranches.reduce((a,t)=>a+t.grossMW,0)/1000).toFixed(1)}GW monetized in-window, a subset of the ${(secured/1000).toFixed(1)}GW secured-power site list.</div>`;
  h+=`<h4 class="sec">02 · Silicon — the fleet by generation</h4>
    <div class="bo-head"><div class="bo-legend">${genLeg}${lineLeg('var(--ink)','contracted today (signed book)')}</div></div><div class="bo-wrap">${rampFleetHTML(Q)}<div class="bo-tip"></div></div>`;
  h+=`<h4 class="sec">03 · Money — revenue vs the street</h4>
    <div class="bo-head"><div class="bo-toggle"><button class="bo-tog ${RAMP_REV_MODE==='gen'?'on':''}" data-rm="gen">by generation</button><button class="bo-tog ${RAMP_REV_MODE==='street'?'on':''}" data-rm="street">vs street</button></div><div class="bo-legend" id="rampRevLeg">${rampRevLegend(RAMP_REV_MODE)}</div></div><div class="bo-wrap" id="rampRevWrap">${rampRevHTML(Q,RAMP_REV_MODE)}<div class="bo-tip"></div></div>`;
  h+=`<h4 class="sec">The quarterly table</h4><div style="overflow-x:auto"><table class="stab nosort"><thead><tr><th>Qtr</th><th class="r">Gross MW (cum)</th><th class="r">IT MW active</th><th class="r">GPUs added</th><th class="r">GPUs cum</th><th class="r">Signed today</th><th class="r">Contracted (mod.)</th><th class="r">Blend $/hr</th><th class="r">AI rev $M</th><th class="r">Total $M</th><th class="r">Consensus $M</th><th class="r">Δ</th></tr></thead><tbody>`;
  Q.forEach(q=>{const tot=q.rev+q.mining;
    h+=`<tr class="srow ramprow${q.s%4===1?' yrb':''}" data-qs="${q.s}"><td class="mono">${q.lbl}</td><td class="r mono">${Math.round(q.grossMW).toLocaleString()}</td><td class="r mono">${Math.round(q.itMW).toLocaleString()}</td><td class="r mono">${q.added>0?'+'+Math.round(q.added/100)*100/1000+'k':'—'}</td><td class="r mono">${Math.round(q.cum/100)/10}k</td><td class="r mono">${q.cum>0?Math.round(q.signed/q.cum*100)+'%':'—'}</td><td class="r mono">${q.cum>0?Math.round(q.ctr/q.cum*100)+'%':'—'}</td><td class="r mono">${q.blend.toFixed(2)}</td><td class="r mono">${Math.round(q.rev).toLocaleString()}</td><td class="r mono"><b>${Math.round(tot).toLocaleString()}</b></td><td class="r mono">${q.consTot!=null?Math.round(q.consTot).toLocaleString():'—'}</td><td class="r mono" style="${q.consTot?('color:'+((tot/q.consTot-1)>=0?'var(--pine)':'var(--clay)')):''}">${q.consTot?((tot/q.consTot-1)>=0?'+':'')+Math.round((tot/q.consTot-1)*100)+'%':'—'}</td></tr>`;});
  h+=`</tbody></table></div>`;
  h+=`<div class="legend2" style="margin-top:12px"><b>Basis.</b> ${R.basis}</div>`;
  h+=`<div class="legend2" style="margin-top:6px"><b>Consensus.</b> ${R.consensusSource}</div>`;
  body.innerHTML=h;
  RAMP_SEL=null;RAMP_CUR=-1;
  RAMP_CTX={Q,EV,R,rows:[...body.querySelectorAll('tr.ramprow')]};
  body.querySelectorAll('[data-rc]').forEach(b=>b.addEventListener('click',()=>{rampCo=b.dataset.rc;RAMP_T=RAMP_END;renderRamp();}));
  body.querySelectorAll('[data-rm]').forEach(b=>b.addEventListener('click',()=>rampRevMode(b.dataset.rm)));
  const btn=document.getElementById('rampPlayBtn');if(btn)btn.addEventListener('click',rampPlay);
  const rg=document.getElementById('rampRange');if(rg)rg.addEventListener('input',()=>rampSeek(rg.value));
  RAMP_CTX.rows.forEach(tr=>tr.addEventListener('click',()=>rampSeek(+tr.dataset.qs)));
  if(RAMP_T==null)RAMP_T=RAMP_END;
  rampApply();   // land on the full 2030 picture; the replay button is the movie
}
/* ---- checks page: the live data test suite (same code as `node checks.js`) ---- */
let RAW_DATA=null;
function checkAge(iso){if(!iso)return {t:'never',cls:'bad'};const d=Math.round((Date.now()-new Date(iso))/86400000);return {t:d+'d ago',cls:d>60?'bad':d>30?'mid':'ok'};}
function updateChecksBadge(r){const el=document.getElementById('tabbadge');if(!el)return;
  el.className='cbadge '+(r.summary.fail?'bad':r.summary.warn?'mid':'ok');
  el.textContent=r.summary.fail?r.summary.fail+' fail':r.summary.warn?r.summary.warn+' warn':'✓';}
function renderChecks(){
  const body=document.getElementById('checks-body');if(!body||!RAW_DATA||typeof ChecksCore==='undefined')return;
  // include the portfolio-ledger group once portfolio files are loaded (portfolio-ui.js re-renders
  // on arrival). Never re-trigger a failed load from here — that would loop; retry lives on the tab.
  const pfFiles=(typeof PF!=='undefined'&&PF&&PFH)?{portfolio:PF,history:PFH}:null;
  if(!pfFiles&&typeof loadPortfolio==='function'&&typeof PF_ERR!=='undefined'&&!PF_ERR&&!PF_LOADING)loadPortfolio();
  const r=ChecksCore.runChecks(RAW_DATA,undefined,pfFiles);updateChecksBadge(r);
  const esc=t=>String(t).replace(/</g,'&lt;');
  let h=`<div class="ck-verdict ${r.summary.fail?'bad':'ok'}">${r.summary.fail?'✗':'✓'} ${r.summary.checksRun.toLocaleString()} checks · ${r.summary.companies} companies · ${r.summary.sites} sites — <b>${r.summary.fail} FAIL</b> · ${r.summary.warn} warn · checked just now, in this browser, against the deployed data</div>`;
  // group cards
  h+=`<h4 class="sec">What is checked</h4><div class="ck-groups">`;
  r.groupOrder.forEach(k=>{const g=r.groups[k];const st=g.fail?'bad':g.warn?'mid':'ok';
    h+=`<div class="ck-g"><div class="ck-g-head"><span class="ck-dot ${st}"></span><b>${g.name}</b><span class="ck-n">${g.pass}/${g.total} pass${g.warn?` · ${g.warn} warn`:''}${g.fail?` · ${g.fail} FAIL`:''}</span></div><div class="ck-guard">${g.guards}</div></div>`;});
  h+=`</div>`;
  // findings
  if(r.msgs.length){h+=`<h4 class="sec">Findings (${r.msgs.length})</h4><div class="ck-msgs">`;
    r.msgs.forEach(m=>{h+=`<div class="ck-m ${m.level}"><span class="ck-lv">${m.level==='fail'?'FAIL':'warn'}</span><b>${m.tk}</b> ${esc(m.msg)}</div>`;});h+=`</div>`;}
  // per-company matrix
  const cols=r.groupOrder.filter(k=>k!=='config');
  h+=`<h4 class="sec">Per company</h4><div style="overflow-x:auto"><table class="stab ck-mx"><thead><tr><th>Company</th>${cols.map(k=>`<th>${r.groups[k].name.split(' ')[0]}</th>`).join('')}<th class="r">Capital verified</th><th class="r">Contracts verified</th></tr></thead><tbody>`;
  COMPANIES.forEach(c=>{const pc=r.perCo[c.tk]||{};const v=c.verified||{};const a1=checkAge(v.capital),a2=checkAge(v.contracts);
    const cells=cols.map(k=>{const x=pc[k];if(!x||!(x.pass+x.warn+x.fail))return '<td class="ck-c">·</td>';
      const st=x.fail?'bad':x.warn?'mid':'ok';const sym=x.fail?'✗':x.warn?'⚠':'✓';
      const tip=x.msgs.length?` title="${esc(x.msgs.map(m=>m.msg).join(' · '))}"`:'';
      return `<td class="ck-c ${st}"${tip}>${sym}${x.fail||x.warn?'<span class="ck-cn">'+(x.fail+x.warn)+'</span>':''}</td>`;}).join('');
    h+=`<tr><td class="co">${c.tk}</td>${cells}<td class="r"><span class="ck-age ${a1.cls}">${a1.t}</span></td><td class="r"><span class="ck-age ${a2.cls}">${a2.t}</span></td></tr>`;});
  h+=`</tbody></table></div><div class="legend2">✓ all assertions pass · ⚠ warnings (hover for detail) · ✗ failures. Verification ages: filings/contracts re-checked by the weekly sweep — <span class="ck-age ok">≤30d</span> <span class="ck-age mid">31–60d</span> <span class="ck-age bad">&gt;60d / never</span>. GPU pricing dials last checked vs market: <b>${RAW_DATA.config.verifiedPricing||'never'}</b>.</div>`;
  // watch items
  const wi=RAW_DATA.watchItems||[];
  if(wi.length){h+=`<h4 class="sec">Open watch-items (${wi.length})</h4>`;wi.forEach(w=>{h+=`<div class="ck-m mid"><span class="ck-lv">watch</span><b>${w.tk}</b> ${esc(w.note)} <span class="ck-when">· ${w.added}</span></div>`;});}
  h+=`<div class="legend2" style="margin-top:14px">Deterministic checks run in this browser via <b>checks-core.js</b> — the identical code <b>node checks.js</b> runs before every push. Research checks (fully-diluted shares vs filings, new issuance, contract announcements, GPU spot pricing) run in the weekly sweep, which updates the verification stamps above on approval.</div>`;
  body.innerHTML=h;
}
// Value gauge: bar = our target value (split contracted-floor / expected / legacy), line = market price,
// shaded gap = upside (green) or overvalued (red). Bar scaled per-row to max(price,target).
function gaugeHTML(c,v){
  const px=v.price,tgt=v.target,scale=Math.max(px,tgt,1e-9);
  const barW=Math.min(100,tgt/scale*100),pPos=Math.min(100,px/scale*100),under=tgt>=px;
  let cf=Math.max(0,v.contractedEV),eu=Math.max(0,v.expectedEV),lg=Math.max(0,legacyOf(c));
  const s=cf+eu+lg||1;cf=cf/s*100;eu=eu/s*100;lg=lg/s*100;
  const gap=under
    ? `<div class="vg-gap up" style="left:${pPos.toFixed(2)}%;width:${Math.max(0,100-pPos).toFixed(2)}%"></div>`
    : `<div class="vg-gap dn" style="left:${barW.toFixed(2)}%;width:${Math.max(0,100-barW).toFixed(2)}%"></div>`;
  return `<div class="vg-track" title="Market ${fmtPrice(px)} vs our value $${tgt.toFixed(tgt<60?2:0)} — ${cf.toFixed(0)}% contracted floor · ${eu.toFixed(0)}% expected · ${lg.toFixed(0)}% legacy">
    <div class="vg-bar" style="width:${barW.toFixed(2)}%"><i class="vg-seg cf" style="width:${cf.toFixed(2)}%"></i><i class="vg-seg eu" style="width:${eu.toFixed(2)}%"></i><i class="vg-seg lg" style="width:${lg.toFixed(2)}%"></i></div>
    ${gap}<div class="vg-price" style="left:${pPos.toFixed(2)}%"></div></div>`;
}
function renderCmp(){
  let rows=COMPANIES.map(c=>({c,v:value(c)}));
  rows.sort((a,b)=>sortDir*(a.v.upside-b.v.upside));
  const cont=document.getElementById('rows');const old={};if(!reduce)[...cont.children].forEach(ch=>old[ch.dataset.tk]=ch.getBoundingClientRect().top);
  cont.innerHTML='';
  rows.forEach((r,i)=>{const v=r.v,c=r.c;
    const upCls=v.upside>=0?'pos':'neg',upTxt=(v.upside>=0?'+':'')+(v.upside*100).toFixed(0)+'%';
    const row=document.createElement('div');row.className='rowline';row.dataset.tk=c.tk;row.tabIndex=0;row.setAttribute('role','button');
    row.innerHTML=`<div class="rank">${i+1}</div>
      <div><div class="tk">${c.tk}</div><span class="pill ${c.model}">${c.model==='owner'?'owner-operator':c.model==='landlord'?'landlord':c.model==='holdco'?'holdco / SOTP':'hybrid'}</span>${c.tier&&c.tier!=='proven'?`<span class="pill tier">${tierOf(c).name}</span>`:''}<span class="ct">${c.model==='holdco'?'sum-of-the-parts':c.contractedPct+'% contracted · '+c.termYrs+'y term'}</span></div>
      <div class="col-stack">${gaugeHTML(c,v)}</div>
      <div class="num"><div class="price">${fmtPrice(v.price)}</div></div>
      <div class="num"><div class="target">$${v.target.toFixed(v.target<60?2:0)}</div><div class="up ${upCls}">${upTxt}</div></div>`;
    row.addEventListener('click',()=>setHash(c.tk));row.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();setHash(c.tk);}});
    cont.appendChild(row);
    if(c.thesis){
      const tog=document.createElement('button');tog.type='button';tog.className='thtoggle';tog.innerHTML='<span class="cv">▸</span> valuation narrative';tog.setAttribute('aria-expanded','false');
      const th=document.createElement('div');th.className='thesisline';th.innerHTML=`<b>${c.tk}</b> — ${c.thesis}`;
      tog.addEventListener('click',e=>{e.stopPropagation();const open=th.classList.toggle('open');tog.classList.toggle('open',open);tog.setAttribute('aria-expanded',open?'true':'false');});
      cont.appendChild(tog);cont.appendChild(th);
    }});
  if(!reduce)[...cont.children].forEach(ch=>{const p=old[ch.dataset.tk];if(p==null)return;const dy=p-ch.getBoundingClientRect().top;if(dy){ch.style.transition='none';ch.style.transform=`translateY(${dy}px)`;requestAnimationFrame(()=>{ch.style.transition='';ch.style.transform='';});}});
  document.getElementById('sortlabel').textContent='upside to target';
  document.getElementById('ar-upside').textContent=sortDir<0?'▾':'▴';
}
function renderSites(){
  let all=[];
  COMPANIES.forEach(c=>{
    if(SITE_FILTER&&c.tk!==SITE_FILTER)return;
    const v=value(c);
    v.segs.forEach(sg=>{
      all.push({c,sg,co:c.tk,coName:c.name,model:c.model,name:sg.s.n,mw:sg.s.mw,tenure:sg.s.owned?'owned':'leased',region:REGION[sg.s.region].name,yr:sg.s.yr,mo:sg.s.mo,prov:sg.s.prov,val:sg.ev});
    });
  });
  const cmp={co:(a,b)=>a.co.localeCompare(b.co),name:(a,b)=>a.name.localeCompare(b.name),mw:(a,b)=>a.mw-b.mw,tenure:(a,b)=>a.tenure.localeCompare(b.tenure),region:(a,b)=>a.region.localeCompare(b.region),yr:(a,b)=>(a.yr*12+(a.mo||1))-(b.yr*12+(b.mo||1)),prov:(a,b)=>a.prov.localeCompare(b.prov),val:(a,b)=>a.val-b.val};
  all.sort((a,b)=>siteDir*cmp[siteSort](a,b));
  document.getElementById('sites-body').innerHTML=all.map((s,i)=>`<tr class="srow" onclick="toggleSiteRow(${i})">
    <td class="co">${s.co}</td><td>${s.name}</td><td class="r mono">${s.mw.toLocaleString()}</td>
    <td>${s.tenure}</td><td><span class="dot" style="background:${horizon(s.yr)}"></span>${s.region}</td>
    <td class="r mono">${MONTHS[(s.mo||1)-1]} ${s.yr}</td><td><span class="prov ${s.prov}">${s.prov}</span></td>
    <td class="r mono">${fmtM(s.val)}</td></tr><tr class="sdetail" id="sd-${i}"><td colspan="8">${siteCalcHTML(s.c,s.sg)}</td></tr>`).join('');
  const eb=document.getElementById('sites-eyebrow');
  if(eb)eb.innerHTML=SITE_FILTER?`${SITE_FILTER} sites — <a href="#sites" class="clearfilter">show all ✕</a>`:'Every site in the universe — the inventory the roll-up is built from · <span style="font-style:italic">tap a row for the math</span>';
  // MW-by-provenance summary
  const byP={disclosed:0,estimated:0,rumored:0};let totMW=0;all.forEach(s=>{byP[s.prov]+=s.mw;totMW+=s.mw;});
  const col={disclosed:'var(--indigo)',estimated:'#C9A86A',rumored:'var(--clay)'};
  document.getElementById('mwbar').innerHTML=['disclosed','estimated','rumored'].map(k=>`<i style="width:${(byP[k]/(totMW||1)*100).toFixed(1)}%;background:${col[k]}"></i>`).join('');
  document.getElementById('ssummary').innerHTML=`<span>${SITE_FILTER||'Total'} <b>${totMW.toLocaleString()} MW</b> across ${all.length} sites</span>`+['disclosed','estimated','rumored'].map(k=>`<span>${k} <b>${(byP[k]/(totMW||1)*100).toFixed(0)}%</b></span>`).join('')+`<span style="font-style:italic">— ${((byP.rumored)/(totMW||1)*100).toFixed(0)}% rumored</span>`;
}
function toggleSiteRow(i){const d=document.getElementById('sd-'+i);if(d)d.classList.toggle('open');}

/* ---- shared one-pager pieces (used by both the quick panel and the full page) ---- */
function modelLabel(c){return c.model==='owner'?'GPU owner-operator':c.model==='landlord'?'colo / data-center landlord':'hybrid';}
function liHTML(a){return a.map(x=>`<li>${x}</li>`).join('');}
function qualHTML(c){return `<div class="qual">
  <div class="qcol bull"><h5>Bull case</h5><ul>${liHTML(c.bull)}</ul></div>
  <div class="qcol bear"><h5>Bear case</h5><ul>${liHTML(c.bear)}</ul></div>
  <div class="qcol"><h5>Catalysts</h5><ul>${liHTML(c.catalysts)}</ul></div>
  <div class="qcol"><h5>Key risks</h5><ul>${liHTML(c.risks)}</ul></div></div>`;}
function siteCalcHTML(c,sg){const s=sg.s,k=sg.calc,r=REGION[s.region],tier=tierOf(c);
  const row=(a,b,note)=>`<div class="cstep"><span>${a}</span><span class="cval">${b}</span><span class="cnote">${note||''}</span></div>`;
  let steps='';
  if(c.model==='landlord'){
    if(k.leased){
      steps+=row('NOI / MW·yr','$'+k.noi.toFixed(2)+'M',`SIGNED LEASE — ${k.counterparty}${k.kind?' · '+k.kind:''} · term-average of the actual contract (escalators embedded)`);
      steps+=row('Cap rate',(k.cap*100).toFixed(2)+'%',`${A.capRate}% dial ${tier.capSpread>=0?'+':'−'}${Math.abs(tier.capSpread)} ${tier.name} − full contracted compression · floor ${(CONST.capFloor||6.5)}%`);
    }else{
      steps+=row('NOI / MW·yr','$'+k.noi.toFixed(2)+'M',`UNLEASED — market anchor $${(k.baseNOI||k.noi).toFixed(2)}M (incl. size factor) × lease-up × trend → $${(k.prevailingNOI||k.noi).toFixed(2)}M at ${s.yr} vintage`);
      steps+=row('Cap rate',(k.cap*100).toFixed(2)+'%',`${A.capRate}% dial ${tier.capSpread>=0?'+':'−'}${Math.abs(tier.capSpread)} ${tier.name} · no compression without a signed lease · floor ${(CONST.capFloor||6.5)}%`);
    }
    steps+=row('Value / MW','$'+sg.ppm.toFixed(1)+'M','NOI ÷ cap rate');
  }else{
    steps+=row('Effective rate','$'+k.eff.toFixed(2)+'M/MW·yr',`${Math.round(sg.contractedShare*100)}% @ signed book $${(c.signedRate||A.rate).toFixed(1)}M · rest @ $${(k.prevailing||A.rate).toFixed(1)}M (${s.yr} gen-curve, ${(A.gpuTrend>=0?'+':'')+(A.gpuTrend!=null?A.gpuTrend:A.rateTrend)}%/yr${c.genAccess&&c.genAccess!==1?' × '+c.genAccess+' access':''})`);
    steps+=row('Margin',k.m+'%',`${A.margin} ${r.cMargin>=0?'+':'−'}${Math.abs(r.cMargin)} ${r.name.toLowerCase()} ${s.owned?'+'+CONST.ownedCMargin+' owned':CONST.leasedCMargin+' leased'}`);
    steps+=row('Multiple',k.mult.toFixed(2)+'×',`${A.multiple}× × ${tier.multFactor} ${tier.name} · (1 + ${(CONST.multPremium*(s.prov==='rumored'?0:c.contractedPct)/100).toFixed(2)} contracted, site-aware)`);
    steps+=row('Value / MW','$'+sg.ppm.toFixed(1)+'M','rate × margin × multiple');
  }
  steps+=row('Gross value',fmtM(sg.gross),`$${sg.ppm.toFixed(1)}M × ${s.mw} MW`);
  steps+=row('× Execution haircut','×'+sg.hair.toFixed(2),s.prov);
  steps+=row('× Time discount','×'+sg.dfac.toFixed(2),sg.yrs<=0?'live now':`${sg.yrs.toFixed(1)} yrs @ ${sg.dr%1===0?sg.dr:sg.dr.toFixed(1)}%${A.ramp>0?` · ${A.ramp}mo ramp on uncontracted share`:''}`);
  steps+=`<div class="cstep tot"><span>Site value</span><span class="cval">${fmtM(sg.ev)}</span><span class="cnote"></span></div>`;
  steps+=row('— Contracted floor',fmtM(sg.contractedEV),`${Math.round(sg.contractedShare*100)}% of value`);
  steps+=row('— Expected upside',fmtM(sg.expectedEV),`${Math.round((1-sg.contractedShare)*100)}%`);
  return `<div class="sitecalc">${steps}</div>`;}
function commercialHTML(c){const f=(a,b)=>`<div class="f"><span>${a}</span><span>${b}</span></div>`;const tier=tierOf(c);const v=value(c);const bz=c.basis||{};const owner=c.model!=='landlord';const holdco=c.model==='holdco';
  let stakeRow='';
  if(c.stake){const t=COMPANIES.find(x=>x.tk===c.stake.tk);const mkt=t?(c.stake.pct*t.shares*priceOf(t)):0;const cap=c.shares*priceOf(c);
    stakeRow=f(`Stake: ${(c.stake.pct*100).toFixed(0)}% of ${c.stake.tk}`,`${fmtM(stakeValue(c))} (modeled value)`)+
      f(`↳ ${c.stake.tk} stake at market`,`${fmtM(mkt)} vs ${c.tk} mkt cap ${fmtM(cap)}${mkt>cap?' — stake alone > whole company':''}`);}
  const ethRow=c.eth?f('ETH treasury',`${c.eth.toLocaleString()} Ξ × $${Math.round(ethPrice()).toLocaleString()} = ${fmtM(c.eth*ethPrice()/1e6)}`):'';
  const btcRow=c.btc?f('BTC treasury',`${c.btc.toLocaleString()} ₿ × $${Math.round(btcPrice()).toLocaleString()} = ${fmtM(c.btc*btcPrice()/1e6)}`):'';
  return `<div class="facts">`+
  (holdco?'':f('Investability tier',tier.name+(bz.tier?` · ${bz.tier}`:'')))+
  (holdco?'':(owner?f('Compute multiple (incl. tier)',(A.multiple*tier.multFactor).toFixed(1)+'×'):f('Cap rate (incl. tier)',(A.capRate+tier.capSpread).toFixed(1)+'%')))+
  (holdco?'':f('Contracted today',c.contractedPct+'%'))+
  (holdco?'':(owner?f('Avg term remaining',c.termYrs+' yrs'):''))+
  (holdco?'':(!owner?(()=>{const ls=(c.leases||[]).filter(l=>l.effective!==false);if(!ls.length)return '';const mw=ls.reduce((a,l)=>a+l.mw,0);const wnoi=ls.reduce((a,l)=>a+l.noiPerMWyr*l.mw,0)/(mw||1);return f('Signed lease book',`${mw.toLocaleString()}MW @ $${wnoi.toFixed(2)}M NOI/MW·yr (term-avg, actual contracts)`);})():''))+
  (holdco?'':(owner?f('GPU rate (market · gen-curve)','$'+A.rate.toFixed(1)+'M · '+((A.gpuTrend!=null?A.gpuTrend:A.rateTrend)>=0?'+':'')+(A.gpuTrend!=null?A.gpuTrend:A.rateTrend)+'%/yr'):''))+
  (owner&&!holdco&&(c.contracts||[]).length?(()=>{const cs2=(c.contracts||[]).filter(x=>x.effective!==false);const tot=cs2.reduce((a3,x)=>a3+(x.totalRevM||0),0);return f('Signed compute book',`$${(tot/1000).toFixed(1)}B across ${cs2.length} contracts @ ~$${(c.signedRate||0).toFixed(1)}M/MW·yr blended`);})():'')+
  stakeRow+ethRow+btcRow+
  (c.legacyEV?f(holdco?'Legacy mining':'Legacy / other',fmtM(c.legacyEV)):'')+
  f('Net debt',fmtM(c.netDebt))+
  (c.committedDebt?f('Committed project debt',fmtM(c.committedDebt)+(bz.committedDebt?` · ${bz.committedDebt}`:'')):'')+
  (c.seniorClaims?f('Preferred / minority claims',fmtM(c.seniorClaims)+(bz.seniorClaims?` · ${bz.seniorClaims}`:'')):'')+
  (()=>{const fmw=(c.sites||[]).filter(s=>s.yr>YEAR).reduce((a,s)=>a+s.mw,0);const cpx=c.model==='landlord'?(CONST.capexLandlordMW||10):(CONST.capexOwnerMW||25);const gap=Math.max(0,fmw*cpx-(c.committedDebt||0)-(c.plannedRaise||0));return fmw>0&&!holdco?f('Funding gap (est., uncharged)',fmtM(gap)+` · ${fmw.toLocaleString()}MW × $${cpx}M − committed − raise`):'';})()+
  (c.equityDiscount?f('Governance / control discount',(c.equityDiscount*100).toFixed(0)+'% off equity'+(bz.equityDiscount?` · ${bz.equityDiscount}`:'')):'')+
  (holdco?'':f('Financing mix',c.finMix||'—'))+
  (holdco?'':f('Discount rate (time)',A.disc.toFixed(0)+'%'))+
  f('Shares out',c.shares+'M')+
  (v.equityRaise>0?f('Planned equity raise',fmtM(v.equityRaise)+' @ '+fmtPrice(v.price)+(bz.plannedRaise?` · ${bz.plannedRaise}`:'')):'')+
  (v.newShares>0?f('Funded shares (incl. dilution)',Math.round(v.fundedShares)+'M ('+(v.newShares/c.shares*100).toFixed(0)+'% dilution)'):'')+
  (c.leaseQ!=null?f('Counterparty quality (reference)',c.leaseQ.toFixed(1)+' / 5'):'')+
  `</div>`;}
/* ---- build-out over time (cumulative capacity or value, stacked by provenance) ---- */
function buildoutData(c,v){
  const metric=BUILDOUT_METRIC;
  const ys=c.sites.map(s=>s.yr),minY=Math.min(...ys),maxY=Math.max(...ys),years=[];
  for(let y=minY;y<=maxY;y++)years.push(y);
  const annual={};years.forEach(y=>annual[y]={disclosed:0,estimated:0,rumored:0});
  v.segs.forEach(sg=>{const q=metric==='mw'?sg.s.mw:sg.ev;if(annual[sg.s.yr])annual[sg.s.yr][sg.s.prov]+=q;});
  const cum={},run={disclosed:0,estimated:0,rumored:0};
  years.forEach(y=>{run.disclosed+=annual[y].disclosed;run.estimated+=annual[y].estimated;run.rumored+=annual[y].rumored;cum[y]={disclosed:run.disclosed,estimated:run.estimated,rumored:run.rumored};});
  const max=Math.max(...years.map(y=>cum[y].disclosed+cum[y].estimated+cum[y].rumored),1e-9);
  return{years,cum,max,metric};
}
function fmtAxis(metric,val){if(metric==='mw'){return val>=1000?(val/1000).toFixed(val%1000===0?0:1)+'GW':Math.round(val)+'';}return fmtM(val);}
function buildoutChartHTML(c,v){
  const d=buildoutData(c,v),years=d.years,cum=d.cum,max=d.max,metric=d.metric;
  const W=640,H=300,ml=54,mr=14,mt=14,mb=30,pw=W-ml-mr,ph=H-mt-mb;
  const n=years.length||1,step=pw/n,bw=Math.min(48,step*0.6);
  const COL={disclosed:'var(--indigo)',estimated:'var(--indigo-soft)',rumored:'var(--far)'};
  const yOf=val=>mt+ph-(val/max)*ph;
  const tx='style="font-family:var(--mono);font-size:10px;fill:var(--ink-soft)"';
  let s='';
  for(let i=0;i<=4;i++){const val=max*i/4,y=yOf(val);s+=`<line x1="${ml}" y1="${y.toFixed(1)}" x2="${W-mr}" y2="${y.toFixed(1)}" style="stroke:var(--line);stroke-width:1"/><text x="${ml-6}" y="${(y+3).toFixed(1)}" text-anchor="end" ${tx}>${fmtAxis(metric,val)}</text>`;}
  years.forEach((yr,i)=>{const cx=ml+step*i+step/2,x=cx-bw/2;let yb=mt+ph;
    ['disclosed','estimated','rumored'].forEach(p=>{const val=cum[yr][p];if(val<=0)return;const h=(val/max)*ph;yb-=h;s+=`<rect x="${x.toFixed(1)}" y="${yb.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" style="fill:${COL[p]};stroke:var(--card);stroke-width:1.5"><title>${yr} ${p}: ${fmtAxis(metric,val)}</title></rect>`;});
    const tot=cum[yr].disclosed+cum[yr].estimated+cum[yr].rumored;
    s+=`<text x="${cx.toFixed(1)}" y="${(mt+ph+18).toFixed(1)}" text-anchor="middle" ${tx}>${yr}</text>`;
    if(tot>0)s+=`<text x="${cx.toFixed(1)}" y="${(yOf(tot)-5).toFixed(1)}" text-anchor="middle" style="font-family:var(--mono);font-size:9px;fill:var(--ink)">${fmtAxis(metric,tot)}</text>`;
  });
  years.forEach((yr,i)=>{s+=`<rect x="${(ml+step*i).toFixed(1)}" y="${mt}" width="${step.toFixed(1)}" height="${ph}" fill="transparent" style="cursor:pointer" onmousemove="boTip(event,${yr})" onmouseleave="boTipHide()"></rect>`;});
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Cumulative ${metric==='mw'?'capacity':'value'} build-out by energization year">${s}</svg>`;
}
function boTipFor(year){
  const c=FP_COMPANY;if(!c)return'';
  const g={disclosed:[],estimated:[],rumored:[]};
  c.sites.forEach(s=>{if(s.yr<=year&&g[s.prov])g[s.prov].push(s);});
  const COL={disclosed:'var(--indigo)',estimated:'var(--indigo-soft)',rumored:'var(--far)'},LBL={disclosed:'Disclosed',estimated:'Estimated',rumored:'Rumored'};
  let h=`<div class="bo-tip-yr">Online by ${year}</div>`;
  ['disclosed','estimated','rumored'].forEach(p=>{if(!g[p].length)return;
    h+=`<div class="bo-tip-grp"><span class="bo-tip-h" style="color:${COL[p]}">${LBL[p]}</span>`+g[p].map(s=>`<div class="bo-tip-row"><span>${s.n}</span><span>${s.mw.toLocaleString()} MW</span></div>`).join('')+`</div>`;});
  return h;
}
function boTip(e,year){const t=document.getElementById('botip');if(!t)return;t.innerHTML=boTipFor(year);t.style.display='block';
  const w=t.parentElement.getBoundingClientRect();let x=e.clientX-w.left+14,y=e.clientY-w.top+14;
  if(x+t.offsetWidth>w.width-6)x=w.width-t.offsetWidth-6;if(x<2)x=2;
  t.style.left=x+'px';t.style.top=y+'px';}
function boTipHide(){const t=document.getElementById('botip');if(t)t.style.display='none';}
function buildoutHTML(c,v){
  const m=BUILDOUT_METRIC;
  const tg=(id,lbl)=>`<button class="bo-tog${m===id?' on':''}" onclick="toggleBuildout('${id}')">${lbl}</button>`;
  const legend=[['Disclosed','indigo'],['Estimated','indigo-soft'],['Rumored','far']].map(p=>`<span class="bo-leg"><i style="background:var(--${p[1]})"></i>${p[0]}</span>`).join('');
  return `<div class="bo-head"><div class="bo-toggle">${tg('mw','MW')}${tg('val','$ value')}</div><div class="bo-legend">${legend}</div></div><div class="bo-wrap">${buildoutChartHTML(c,v)}<div class="bo-tip" id="botip"></div></div>`;
}
function toggleBuildout(m){BUILDOUT_METRIC=m;if(FP_COMPANY){const el=document.getElementById('buildout');if(el)el.innerHTML=buildoutHTML(FP_COMPANY,value(FP_COMPANY));}}
/* ---- value bridge waterfall ---- */
function waterfallHTML(c,v){
  const legacy=legacyOf(c),computeEV=v.ev-legacy,totalEV=v.ev,nd=c.netDebt,equity=v.equity;
  const steps=[{label:'Sites',val:computeEV,from:0,to:computeEV,k:'pos'}];
  let run=computeEV;
  if(legacy){steps.push({label:'Legacy',val:legacy,from:run,to:run+legacy,k:'pos'});run+=legacy;}
  steps.push({label:nd>=0?'Net debt':'Net cash',val:-nd,from:run,to:run-nd,k:nd>=0?'neg':'pos'});run-=nd;
  if(c.equityDiscount){const gd=run*c.equityDiscount;steps.push({label:'Gov. disc',val:-gd,from:run,to:run-gd,k:'neg'});run-=gd;}
  steps.push({label:'Equity',val:equity,from:0,to:equity,k:'tot'});
  const max=Math.max(computeEV,totalEV,equity,1e-9);
  const W=640,H=230,ml=54,mr=14,mt=14,mb=28,pw=W-ml-mr,ph=H-mt-mb;
  const n=steps.length,step=pw/n,bw=Math.min(72,step*0.5);
  const yOf=val=>mt+ph-(val/max)*ph;
  const COL={pos:'var(--indigo)',neg:'var(--clay)',tot:'var(--pine)'};
  const tx='style="font-family:var(--mono);font-size:10px;fill:var(--ink-soft)"';
  let s='';
  for(let i=0;i<=4;i++){const val=max*i/4,y=yOf(val);s+=`<line x1="${ml}" y1="${y.toFixed(1)}" x2="${W-mr}" y2="${y.toFixed(1)}" style="stroke:var(--line);stroke-width:1"/><text x="${ml-6}" y="${(y+3).toFixed(1)}" text-anchor="end" ${tx}>${fmtM(val)}</text>`;}
  steps.forEach((st,i)=>{const cx=ml+step*i+step/2,x=cx-bw/2,yT=yOf(Math.max(st.from,st.to)),h=Math.max(1.5,Math.abs(yOf(st.from)-yOf(st.to)));
    s+=`<rect x="${x.toFixed(1)}" y="${yT.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" style="fill:${COL[st.k]}"/>`;
    s+=`<text x="${cx.toFixed(1)}" y="${(mt+ph+17).toFixed(1)}" text-anchor="middle" ${tx}>${st.label}</text>`;
    s+=`<text x="${cx.toFixed(1)}" y="${(yT-5).toFixed(1)}" text-anchor="middle" style="font-family:var(--mono);font-size:9.5px;fill:var(--ink)">${st.val<0?'−'+fmtM(-st.val):fmtM(st.val)}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Value bridge: sites plus legacy minus net debt equals equity">${s}</svg><div class="bo-cap">Equity ${fmtM(equity)} ÷ ${Math.round(v.fundedShares)}M funded shares${v.newShares>0?` (${c.shares}M + ${Math.round(v.newShares)}M raise)`:''} = <b>$${v.target.toFixed(v.target<60?2:0)}</b> target</div>`;
}
function valBuildHTML(c,v){const upCls=v.upside>=0?'pos':'neg',upTxt=(v.upside>=0?'+':'')+(v.upside*100).toFixed(1)+'%';const p=splitParts(v);return `<div class="breakdown"><div class="b tot"><span>Enterprise value (sum of sites)</span><b>${fmtM(v.ev)}</b></div>${splitBarHTML(v)}<div class="b"><span>— Contracted floor (dial-insulated)</span><b>${fmtM(v.contractedEV)} · ${p.cf.toFixed(0)}%</b></div><div class="b"><span>— Expected upside (spot &amp; pipeline)</span><b>${fmtM(v.expectedEV)} · ${p.eu.toFixed(0)}%</b></div><div class="b"><span>Less: net debt</span><b>−${fmtM(c.netDebt)}</b></div><div class="b tot"><span>Equity value</span><b>${fmtM(v.equity)}</b></div><div class="b tot"><span>Price target → upside</span><b>$${v.target.toFixed(0)} · <span class="up ${upCls}">${upTxt}</span></b></div></div>`;}
function devsHTML(c){return c.log.map(e=>`<div class="ev"><div class="meta"><span class="etype">${e.t}</span><span>${e.d} · ${e.s}</span></div><div>${e.x}</div></div>`).join('');}

/* ---- full page: the extensible home (graphical, with planned-module slots) ---- */
function openFull(c){const v=value(c),fp=document.getElementById('fullpage');FP_COMPANY=c;
  const upCls=v.upside>=0?'pos':'neg',upTxt=(v.upside>=0?'+':'')+(v.upside*100).toFixed(1)+'%';
  fp.innerHTML=`<button class="back" id="fpback">← Back to comparison</button>
    <div class="fp-head">
      <div><div class="fp-tk">${c.tk}</div><div class="fp-model">${c.name} · ${modelLabel(c)} · ${tierOf(c).name}</div></div>
      <div class="fp-nums">
        <div class="fp-num"><span>Price</span><b>${fmtPrice(priceOf(c))}</b></div>
        <div class="fp-num"><span>Target</span><b>$${v.target.toFixed(v.target<60?2:0)}</b></div>
        <div class="fp-num"><span>Upside</span><b class="up ${upCls}">${upTxt}</b></div>
      </div>
    </div>
    <div class="fp-grid">
      <div class="fp-main">
        <div class="narr">${c.narrative}</div>
        <h4 class="sec">Build-out over time</h4>
        <div id="buildout">${buildoutHTML(c,v)}</div>
        <h4 class="sec">Value bridge</h4>
        ${waterfallHTML(c,v)}
        ${valBuildHTML(c,v)}
        <a class="siteslink" href="#sites=${c.tk}">Where the value comes from — all ${c.tk} sites, with the math per site →</a>
        <h4 class="sec">Developments</h4>${devsHTML(c)}
      </div>
      <div class="fp-side">
        ${qualHTML(c)}
        <h4 class="sec">Commercial &amp; capital</h4>${commercialHTML(c)}
        <div class="module planned"><div class="mtag">Planned</div><h5>Management commentary</h5><p>Quotes and read-throughs from earnings calls, fireside chats and interviews.</p></div>
        <div class="module planned"><div class="mtag">Planned</div><h5>Investor &amp; conference calendar</h5><p>Upcoming earnings dates, growth conferences and investor days.</p></div>
      </div>
    </div>`;
  document.querySelector('.grid').style.display='none';
  fp.classList.add('on');document.getElementById('fpback').onclick=closeFull;
  window.scrollTo(0,0);document.getElementById('fpback').focus();}
function closeFull(){setHash('');}

/* ---- hash routing: #TICKER → full page, #sites[=TK] → sites tab, # → comparison ---- */
function setHash(h){const cur=location.hash.replace(/^#/,'');if(cur===h){route();}else{location.hash=h;}}
function route(){
  if(!COMPANIES)return;
  const raw=decodeURIComponent((location.hash||'').replace(/^#\/?/,''));
  const c=COMPANIES.find(x=>x.tk===raw.toUpperCase());
  if(c){openFull(c);return;}
  if(raw==='sites'||raw.indexOf('sites=')===0){
    const tk=raw.indexOf('sites=')===0?raw.slice(6).toUpperCase():null;
    showDashboard('sites',(tk&&COMPANIES.find(x=>x.tk===tk))?tk:null);return;
  }
  if(raw==='checks'){showDashboard('checks',null);return;}
  if(raw==='leases'){showDashboard('leases',null);return;}
  if(raw==='coverage'){showDashboard('cover',null);return;}
  if(raw==='raises'){showDashboard('raises',null);return;}
  if(raw==='outlook'){showDashboard('outlook',null);return;}
  if(raw==='ramp'){showDashboard('ramp',null);return;}
  if(raw==='portfolio'){showDashboard('port',null);return;}
  showDashboard('cmp',null);
}
function showDashboard(v,filter){
  SITE_FILTER=filter||null;view=v;
  if(v!=='ramp'&&typeof rampStop==='function')rampStop();   // leaving the ramp view stops any running replay
  document.getElementById('fullpage').classList.remove('on');
  document.querySelector('.grid').style.display='';
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('on',t.dataset.view===v));
  document.getElementById('view-cmp').style.display=v==='cmp'?'':'none';
  document.getElementById('view-sites').style.display=v==='sites'?'':'none';
  const vc=document.getElementById('view-checks');if(vc)vc.style.display=v==='checks'?'':'none';
  const vp=document.getElementById('view-port');if(vp)vp.style.display=v==='port'?'':'none';
  const vl=document.getElementById('view-leases');if(vl)vl.style.display=v==='leases'?'':'none';
  const vv=document.getElementById('view-cover');if(vv)vv.style.display=v==='cover'?'':'none';
  const vz=document.getElementById('view-raises');if(vz)vz.style.display=v==='raises'?'':'none';
  const vo=document.getElementById('view-outlook');if(vo)vo.style.display=v==='outlook'?'':'none';
  const vg=document.getElementById('view-ramp');if(vg)vg.style.display=v==='ramp'?'':'none';
  render();window.scrollTo(0,0);
}

/* ---- wiring (after data loads) ---- */
function wireEvents(){
  // global dials: collapsible sidebar, collapsed by default, preference remembered
  const grid=document.querySelector('.grid'),dbtn=document.getElementById('dialsToggle');
  if(grid&&dbtn){
    const setDials=open=>{grid.classList.toggle('nodials',!open);dbtn.classList.toggle('on',open);dbtn.setAttribute('aria-expanded',open?'true':'false');try{localStorage.setItem('cv-dials',open?'1':'0');}catch(e){}};
    let dOpen=false;try{dOpen=localStorage.getItem('cv-dials')==='1';}catch(e){}
    setDials(dOpen);
    dbtn.addEventListener('click',()=>setDials(grid.classList.contains('nodials')));
  }
  document.querySelectorAll('.tab').forEach(t=>t.addEventListener('click',()=>setHash(t.dataset.view==='sites'?'sites':t.dataset.view==='checks'?'checks':t.dataset.view==='port'?'portfolio':t.dataset.view==='leases'?'leases':t.dataset.view==='cover'?'coverage':t.dataset.view==='raises'?'raises':t.dataset.view==='outlook'?'outlook':t.dataset.view==='ramp'?'ramp':'')));
  document.querySelectorAll('.thead .sortable').forEach(h=>h.addEventListener('click',()=>{const k=h.dataset.sort;if(k===sortKey)sortDir*=-1;else{sortKey=k;sortDir=-1;}render();}));
  document.querySelectorAll('.stab th').forEach(h=>h.addEventListener('click',()=>{const k=h.dataset.s;if(k===siteSort)siteDir*=-1;else{siteSort=k;siteDir=(k==='co'||k==='name'||k==='region'||k==='tenure'||k==='prov')?1:-1;}render();}));
  document.getElementById('reset').addEventListener('click',()=>{Object.assign(A,BASE);syncControls();render();});
  const rb=document.getElementById('refreshprices');if(rb)rb.addEventListener('click',()=>{fetchPrices();fetchBtc();fetchEth();});
  addEventListener('keydown',e=>{if(e.key==='Escape'&&document.getElementById('fullpage').classList.contains('on'))setHash('');});
  addEventListener('hashchange',route);
}

/* ---- live prices (Finnhub, hourly) ---- */
function updatePriceNote(live){const el=document.getElementById('pricenote');if(!el)return;
  const base=live&&PRICES_AT?`· prices: Finnhub · updated ${PRICES_AT.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}`:'· prices: manual';
  el.textContent=base+(BTC_PRICE?` · BTC $${Math.round(BTC_PRICE).toLocaleString()}`:'')+(ETH_PRICE?` · ETH $${Math.round(ETH_PRICE).toLocaleString()}`:'');}
let FETCHING=false;
async function fetchPrices(){
  const token=(typeof window!=='undefined'&&window.FINNHUB_TOKEN)||'';
  if(!token){updatePriceNote(false);return;}
  if(FETCHING)return;FETCHING=true;
  const btn=document.getElementById('refreshprices');if(btn)btn.disabled=true;
  const note=document.getElementById('pricenote');if(note)note.textContent='· prices: refreshing…';
  await Promise.all(COMPANIES.map(async c=>{
    try{const r=await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(c.tk)}&token=${token}`);
      if(!r.ok)return;const j=await r.json();
      if(j&&typeof j.c==='number'&&j.c>0)LIVE_PRICES[c.tk]=j.c;}catch(e){}
  }));
  PRICES_AT=new Date();FETCHING=false;if(btn)btn.disabled=false;updatePriceNote(true);render();
}
async function fetchBtc(){
  try{const r=await fetch('https://api.coinbase.com/v2/prices/BTC-USD/spot');
    if(!r.ok)return;const j=await r.json();const p=parseFloat(j&&j.data&&j.data.amount);
    if(p>0){BTC_PRICE=p;E.ctx.btc=p;BTC_AT=new Date();updatePriceNote(!!PRICES_AT);render();}}catch(e){}
}
async function fetchEth(){
  try{const r=await fetch('https://api.coinbase.com/v2/prices/ETH-USD/spot');
    if(!r.ok)return;const j=await r.json();const p=parseFloat(j&&j.data&&j.data.amount);
    if(p>0){ETH_PRICE=p;E.ctx.eth=p;updatePriceNote(!!PRICES_AT);render();}}catch(e){}
}

/* ---- boot: load data, then build ---- */
function applyConfig(data){
  E=Engine.createEngine(data);
  CFG=E.CFG;YEAR=E.YEAR;NOW=E.NOW;HORIZON=E.HORIZON;BASE=E.BASE;A=E.A;SLIDERS=E.SLIDERS;
  REGION=E.REGION;CONST=E.CONST;TIERS=E.TIERS;PROV=E.PROV;PROV_OP=E.PROV_OP;
  LIVE_PRICES=E.ctx.prices;   // same object — quote fetches flow straight into the engine
}
async function boot(){
  try{
    const res=await fetch('data.json',{cache:'no-store'});
    if(!res.ok)throw new Error('HTTP '+res.status);
    const data=await res.json();
    RAW_DATA=data;
    applyConfig(data);
    COMPANIES=data.companies;
    buildControls();
    wireEvents();
    route();
    try{if(typeof ChecksCore!=='undefined')updateChecksBadge(ChecksCore.runChecks(RAW_DATA));}catch(e){}
    fetchPrices();fetchBtc();fetchEth();
    setInterval(()=>{fetchPrices();fetchBtc();fetchEth();},3600000);
  }catch(err){
    document.getElementById('rows').innerHTML=`<div class="appmsg err">Could not load data.json — ${err.message}. Serve this folder over HTTP (not file://).</div>`;
  }
}
boot();
