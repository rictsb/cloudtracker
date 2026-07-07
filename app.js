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

let sortKey='upside',sortDir=-1,view='cmp',siteSort='val',siteDir=-1,leaseSort='annual',leaseDir=-1,ocSort='total',ocDir=-1,covSort='totcov',covDir=-1;
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
  if(view==='cmp')renderCmp(); else if(view==='checks')renderChecks(); else if(view==='port')renderPortfolio(); else if(view==='leases')renderLeases(); else if(view==='cover')renderCoverage(); else renderSites();
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
  const cols=[['tk','Company',''],['mcap','Market cap','r'],['gross','Contracted','r'],['wterm','Avg term','r'],['ann','Annualized','r'],['anncov','Ann ÷ cap','r'],['totcov','Backlog ÷ cap','r']];
  h+=`<div style="overflow-x:auto"><table class="stab"><thead><tr><th></th>${cols.map(([k,lab,cl])=>`<th class="${cl}" data-cv="${k}">${lab}${covSort===k?' <span class="arr">'+(covDir<0?'▾':'▴')+'</span>':''}</th>`).join('')}</tr></thead><tbody>`;
  rows.forEach((r,i)=>{const none=r.items.length===0;
    h+=`<tr class="cvrow srow" data-i="${i}"><td style="width:18px;color:var(--indigo-soft)">${none?'':'▸'}</td>`+
      `<td class="co">${r.c.tk}</td>`+
      `<td class="r mono">${fmtM(r.mcap)}</td>`+
      `<td class="r mono">${none?'—':fmtM(r.gross)}</td>`+
      `<td class="r mono">${none?'—':r.wterm.toFixed(1)+'y'}</td>`+
      `<td class="r mono">${none?'—':fmtM(r.ann)+'/y'}</td>`+
      `<td class="r mono">${none?'—':(r.anncov*100).toFixed(0)+'%'}</td>`+
      `<td class="r mono"><b>${none?'—':(r.totcov*100).toFixed(0)+'%'}</b></td></tr>`;
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
  if(raw==='portfolio'){showDashboard('port',null);return;}
  showDashboard('cmp',null);
}
function showDashboard(v,filter){
  SITE_FILTER=filter||null;view=v;
  document.getElementById('fullpage').classList.remove('on');
  document.querySelector('.grid').style.display='';
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('on',t.dataset.view===v));
  document.getElementById('view-cmp').style.display=v==='cmp'?'':'none';
  document.getElementById('view-sites').style.display=v==='sites'?'':'none';
  const vc=document.getElementById('view-checks');if(vc)vc.style.display=v==='checks'?'':'none';
  const vp=document.getElementById('view-port');if(vp)vp.style.display=v==='port'?'':'none';
  const vl=document.getElementById('view-leases');if(vl)vl.style.display=v==='leases'?'':'none';
  const vv=document.getElementById('view-cover');if(vv)vv.style.display=v==='cover'?'':'none';
  render();window.scrollTo(0,0);
}

/* ---- wiring (after data loads) ---- */
function wireEvents(){
  document.querySelectorAll('.tab').forEach(t=>t.addEventListener('click',()=>setHash(t.dataset.view==='sites'?'sites':t.dataset.view==='checks'?'checks':t.dataset.view==='port'?'portfolio':t.dataset.view==='leases'?'leases':t.dataset.view==='cover'?'coverage':'')));
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
