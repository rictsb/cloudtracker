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
let CFG, COMPANIES, YEAR, NOW, BASE, A, SLIDERS, HORIZON;
let REGION, CONST, PROV, PROV_OP, TIERS;
let LIVE_PRICES={}, PRICES_AT=null, BTC_PRICE=null, BTC_AT=null, ETH_PRICE=null;
let FP_COMPANY=null, BUILDOUT_METRIC='mw', SITE_FILTER=null;

let sortKey='upside',sortDir=-1,view='cmp',siteSort='val',siteDir=-1;
const reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;

function fmtSlider(s,v){return (FMT[s.fmt]||(x=>x))(v);}
function fmtM(x){return Math.abs(x)>=1000?'$'+(x/1000).toFixed(1)+'B':'$'+x.toFixed(0)+'M';}
function priceOf(c){const p=LIVE_PRICES[c.tk];return (typeof p==='number'&&p>0)?p:c.price;}
function fmtPrice(p){return p>=100?'$'+p.toFixed(0):'$'+p.toFixed(2);}
function btcPrice(){return BTC_PRICE||(CFG&&CFG.btcFallback)||60000;}
function ethPrice(){return ETH_PRICE||(CFG&&CFG.ethFallback)||3000;}
// Look-through value of a controlling stake in another tracked name (SOTP holdcos, e.g. BTBT → WhiteFiber).
// pct × that company's modeled equity; auto-updates as the held company's inputs/price move (the "routine").
function stakeValue(c){if(!c.stake)return 0;const t=COMPANIES&&COMPANIES.find(x=>x.tk===c.stake.tk);if(!t)return 0;const v=value(t);
  const dil=v.fundedShares>0?t.shares/v.fundedShares:1;                      // ownership dilutes through the held company's planned raise
  const eq=(c.stake.pct>0.5&&v.equityPre!=null)?v.equityPre:v.equity;       // a CONTROLLING stake doesn't inherit the minority discount its own control created
  return (c.stake.pct||0)*dil*eq;}
// Legacy/non-core EV = BTC + ETH treasuries (marked live) + look-through stakes + a non-crypto residual (mining/software).
function legacyOf(c){return (c.btc||0)*btcPrice()/1e6+(c.eth||0)*ethPrice()/1e6+stakeValue(c)+(c.legacyEV||0);}
function horizon(yr){return yr<=HORIZON.near?'var(--indigo)':yr<=HORIZON.mid?'var(--indigo-soft)':'var(--far)';}

/* ---- engine ---- */
function prevailingRate(yrs){return A.rate*Math.pow(1+(A.rateTrend||0)/100,Math.max(0,yrs));}
function ownerRate(c){return A.rate;}
// Vintage-rate model (spec §4): $/MW·yr is priced at the rate prevailing when capacity is
// contracted/energized, and that rate trends over time (the "GPU rate trend" dial). The CONTRACTED
// share is locked at today's rate; the UNCONTRACTED share floats to the future prevailing rate at
// its energization vintage — so in a rising-rate world unsold capacity is the upside, not a spot
// haircut. `contracted %` remains the company number; rumored sites are 100% uncontracted (no lock).
function effTrend(){return Math.min(A.rateTrend||0,(A.disc||10)-2);}  // guardrail: uncontracted real discount ≥2%/yr (time axis can't invert at bull settings)
function leaseUp(){return A.leaseUp!=null?A.leaseUp:1;}               // lease-up / spot realization on the uncontracted slice (base 1.0 = scarcity view: energized capacity gets rented; 0.42 = consensus spread)
function siteRates(c,s){
  const lock=Math.min(c.termYrs/3,1);
  const cf=(s.prov==='rumored')?0:(c.contractedPct/100);
  const ls=lock*cf;
  const rm=(REGION[s.region]&&REGION[s.region].rateMul)||1;   // geography rate factor (US 1.0, EU/AU < 1)
  const base=A.rate*rm;
  const yrs=Math.max(0,s.yr+((s.mo||1)-1)/12-NOW);
  const prevailing=base*Math.pow(1+effTrend()/100,yrs);
  const contractedRate=ls*base, spotRate=(1-ls)*prevailing*leaseUp();
  return{eff:contractedRate+spotRate,contractedRate,spotRate,prevailing,yrs};
}
function tierOf(c){return TIERS[c.tier]||TIERS.proven||{name:'—',capSpread:0,multFactor:1};}
function siteValue(c,s){const r=REGION[s.region];const tier=tierOf(c);let ppm,contractedShare,calc;
  // site-aware contracted share: rumored capacity has no contracts, so it earns NO contract premium / cap compression
  const cs0=(s.prov==='rumored')?0:(c.contractedPct/100);
  if(c.model==='landlord'){const vyrs=Math.max(0,s.yr+((s.mo||1)-1)/12-NOW);const escal=Math.pow(1+effTrend()/100,vyrs);const baseNOI=CONST.landlordNOI*r.lNOI*(s.owned?CONST.ownedLNOI:CONST.leasedLNOI)*(0.9+0.1*c.mtm);const trendMult=cs0+(1-cs0)*leaseUp()*escal;const noi=baseNOI*trendMult;
    const cap=Math.max(((A.capRate+tier.capSpread)/100)*(1-CONST.capCompress*cs0),(CONST.capFloor||6.5)/100);ppm=noi/cap;   // floored at the DLR fully-leased-IG print
    contractedShare=trendMult>0?cs0/trendMult:0;calc={noi,cap,baseNOI,prevailingNOI:baseNOI*escal};}
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
  if(view==='cmp')renderCmp(); else renderSites();
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
    steps+=row('NOI / MW·yr','$'+k.noi.toFixed(2)+'M',`${Math.round(sg.contractedShare*100)}% locked @ $${(k.baseNOI||k.noi).toFixed(2)}M · rest @ $${(k.prevailingNOI||k.baseNOI||k.noi).toFixed(2)}M (${s.yr} prevailing, ${(A.rateTrend>=0?'+':'')+(A.rateTrend||0)}%/yr)`);
    steps+=row('Cap rate',(k.cap*100).toFixed(2)+'%',`${A.capRate}% dial ${tier.capSpread>=0?'+':'−'}${Math.abs(tier.capSpread)} ${tier.name} − ${(CONST.capCompress*(s.prov==='rumored'?0:c.contractedPct)).toFixed(0)}% contracted (site-aware) · floor ${(CONST.capFloor||6.5)}%`);
    steps+=row('Value / MW','$'+sg.ppm.toFixed(1)+'M','NOI ÷ cap rate');
  }else{
    steps+=row('Effective rate','$'+k.eff.toFixed(2)+'M/MW·yr',`${Math.round(sg.contractedShare*100)}% locked @ $${A.rate.toFixed(1)}M · rest @ $${(k.prevailing||A.rate).toFixed(1)}M (${s.yr} prevailing, ${(A.rateTrend>=0?'+':'')+(A.rateTrend||0)}%/yr)`);
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
  (holdco?'':(!owner?f('Mark-to-market (% original)',(c.mtm*100).toFixed(0)+'%'):''))+
  (holdco?'':(owner?f('GPU rate (today · trend)','$'+A.rate.toFixed(1)+'M · '+(A.rateTrend>=0?'+':'')+(A.rateTrend||0)+'%/yr'):''))+
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
  showDashboard('cmp',null);
}
function showDashboard(v,filter){
  SITE_FILTER=filter||null;view=v;
  document.getElementById('fullpage').classList.remove('on');
  document.querySelector('.grid').style.display='';
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('on',t.dataset.view===v));
  document.getElementById('view-cmp').style.display=v==='cmp'?'':'none';
  document.getElementById('view-sites').style.display=v==='sites'?'':'none';
  render();window.scrollTo(0,0);
}

/* ---- wiring (after data loads) ---- */
function wireEvents(){
  document.querySelectorAll('.tab').forEach(t=>t.addEventListener('click',()=>setHash(t.dataset.view==='sites'?'sites':'')));
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
    if(p>0){BTC_PRICE=p;BTC_AT=new Date();updatePriceNote(!!PRICES_AT);render();}}catch(e){}
}
async function fetchEth(){
  try{const r=await fetch('https://api.coinbase.com/v2/prices/ETH-USD/spot');
    if(!r.ok)return;const j=await r.json();const p=parseFloat(j&&j.data&&j.data.amount);
    if(p>0){ETH_PRICE=p;updatePriceNote(!!PRICES_AT);render();}}catch(e){}
}

/* ---- boot: load data, then build ---- */
function applyConfig(cfg){
  CFG=cfg;
  YEAR=cfg.referenceYear;
  NOW=cfg.referenceYear+((cfg.referenceMonth||1)-1)/12;
  HORIZON=cfg.horizon;
  BASE={...cfg.dials};A={...cfg.dials};
  SLIDERS=cfg.sliders;
  REGION=cfg.regions;
  CONST=cfg.constants;
  TIERS=cfg.tiers||{};
  PROV={};PROV_OP={};
  Object.entries(cfg.provenance).forEach(([k,v])=>{PROV[k]=v.haircut;PROV_OP[k]=v.opacity;});
}
async function boot(){
  try{
    const res=await fetch('data.json',{cache:'no-store'});
    if(!res.ok)throw new Error('HTTP '+res.status);
    const data=await res.json();
    applyConfig(data.config);
    COMPANIES=data.companies;
    buildControls();
    wireEvents();
    route();
    fetchPrices();fetchBtc();fetchEth();
    setInterval(()=>{fetchPrices();fetchBtc();fetchEth();},3600000);
  }catch(err){
    document.getElementById('rows').innerHTML=`<div class="appmsg err">Could not load data.json — ${err.message}. Serve this folder over HTTP (not file://).</div>`;
  }
}
boot();
