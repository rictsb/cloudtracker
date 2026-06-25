/* Compute / Value — relative-value tracker.
   Engine + screens ported from the prototype; all data loads from data.json at runtime. */

const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const FMT={
  money1M:v=>'$'+v.toFixed(1)+'M',
  pctInt:v=>v+'%',
  mult:v=>v.toFixed(1)+'×',
  pct1:v=>v.toFixed(1)+'%',
};

/* runtime state, populated once data.json loads */
let CFG, COMPANIES, YEAR, NOW, BASE, A, SLIDERS, HORIZON;
let REGION, CONST, PROV, PROV_OP;

let sortKey='upside',sortDir=-1,view='cmp',siteSort='val',siteDir=-1;
const reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;

function fmtSlider(s,v){return (FMT[s.fmt]||(x=>x))(v);}
function fmtM(x){return Math.abs(x)>=1000?'$'+(x/1000).toFixed(1)+'B':'$'+x.toFixed(0)+'M';}
function horizon(yr){return yr<=HORIZON.near?'var(--indigo)':yr<=HORIZON.mid?'var(--indigo-soft)':'var(--far)';}

/* ---- engine ---- */
function ownerRate(c){const lock=Math.min(c.termYrs/3,1);const ls=lock*(c.contractedPct/100);const realize=c.renewalProb*c.mtm;return ls*CONST.contractRate+(1-ls)*A.rate*realize;}
// Site-aware contracted/spot split (spec §4): rumored (uncontracted pipeline) earns pure spot and
// moves with the GPU-rate dial; disclosed/estimated capacity carries the company contracted book,
// which stays insulated from the dial. `contracted %` remains the company number — no per-site tag.
function siteRates(c,s){
  const lock=Math.min(c.termYrs/3,1);
  const cf=(s.prov==='rumored')?0:(c.contractedPct/100);
  const ls=lock*cf;
  const spot=A.rate*(c.renewalProb*c.mtm);
  const contractedRate=ls*CONST.contractRate, spotRate=(1-ls)*spot;
  return{eff:contractedRate+spotRate,contractedRate,spotRate};
}
function siteValue(c,s){const r=REGION[s.region];let ppm,contractedShare,calc;
  if(c.model==='landlord'){const noi=CONST.landlordNOI*r.lNOI*(s.owned?CONST.ownedLNOI:CONST.leasedLNOI)*(0.9+0.1*c.mtm);const cap=(A.capRate/100)*(1-CONST.capCompress*(c.contractedPct/100));ppm=noi/cap;
    contractedShare=(s.prov==='rumored')?0:(c.contractedPct/100);calc={noi,cap};}
  else{const R=siteRates(c,s);const m=A.margin+r.cMargin+(s.owned?CONST.ownedCMargin:CONST.leasedCMargin);const mult=A.multiple*(1+CONST.multPremium*(c.contractedPct/100));ppm=R.eff*(m/100)*mult;
    contractedShare=R.eff>0?R.contractedRate/R.eff:0;calc={eff:R.eff,m,mult};}
  const dr=Math.max(A.disc,c.costOfDebt||0),gross=ppm*s.mw,hair=PROV[s.prov],t=s.yr+((s.mo||1)-1)/12,yrs=Math.max(0,t-NOW),dfac=1/Math.pow(1+dr/100,yrs);
  const ev=gross*hair*dfac;
  return{gross,ev,contractedEV:ev*contractedShare,expectedEV:ev*(1-contractedShare),hair,yrs,dfac,ppm,contractedShare,dr,calc};}
function value(c){let ev=0,cEV=0,eEV=0;const segs=[];c.sites.forEach(s=>{const sv=siteValue(c,s);ev+=sv.ev;cEV+=sv.contractedEV;eEV+=sv.expectedEV;segs.push({s,...sv});});ev+=(c.legacyEV||0);const equity=ev-c.netDebt;
  return{ev,equity,contractedEV:cEV,expectedEV:eEV,target:equity/c.shares,upside:equity/c.shares/c.price-1,segs};}
function splitParts(v){const tot=v.contractedEV+v.expectedEV;const cf=tot>0?v.contractedEV/tot*100:0;return{cf,eu:100-cf};}
function splitBarHTML(v){const p=splitParts(v);return `<div class="splitbar" title="Contracted floor ${p.cf.toFixed(0)}% · expected upside ${p.eu.toFixed(0)}%"><i class="cf" style="width:${p.cf.toFixed(1)}%"></i><i class="eu" style="width:${p.eu.toFixed(1)}%"></i></div>`;}
function scores(rows){const max=f=>Math.max(...rows.map(f),1e-9);const nearMW=r=>r.c.sites.filter(s=>s.yr<=YEAR+1).reduce((a,s)=>a+s.mw,0);const totMW=r=>r.c.sites.reduce((a,s)=>a+s.mw,0);
  const mN=max(nearMW),mT=max(totMW),mLQ=max(r=>r.c.leaseQ),mC=max(r=>r.v.ev>0?Math.max(r.v.equity/r.v.ev,0):0);
  rows.forEach(r=>{const cap=r.v.ev>0?Math.max(r.v.equity/r.v.ev,0):0;r.score=100*(.34*(nearMW(r)/mN)+.18*(totMW(r)/mT)+.26*(r.c.leaseQ/mLQ)+.22*(cap/mC));});}

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
function renderCmp(){
  let rows=COMPANIES.map(c=>({c,v:value(c)}));scores(rows);
  rows.sort((a,b)=>sortDir*((sortKey==='score'?a.score-b.score:a.v.upside-b.v.upside)));
  const cont=document.getElementById('rows');const old={};if(!reduce)[...cont.children].forEach(ch=>old[ch.dataset.tk]=ch.getBoundingClientRect().top);
  cont.innerHTML='';
  rows.forEach((r,i)=>{const v=r.v,c=r.c,tot=v.ev>0?v.ev:1;
    const segHTML=v.segs.map(sg=>{const w=Math.max(0,sg.ev/tot*100).toFixed(2);return `<div class="seg" title="${sg.s.n}: ${fmtM(sg.ev)} (${MONTHS[(sg.s.mo||1)-1]} ${sg.s.yr}, ${sg.s.prov})" style="width:${w}%;background:${horizon(sg.s.yr)};opacity:${PROV_OP[sg.s.prov]}"></div>`;}).join('');
    const upCls=v.upside>=0?'pos':'neg',upTxt=(v.upside>=0?'+':'')+(v.upside*100).toFixed(0)+'%',totMW=c.sites.reduce((a,s)=>a+s.mw,0);
    const row=document.createElement('div');row.className='rowline';row.dataset.tk=c.tk;row.tabIndex=0;row.setAttribute('role','button');
    row.innerHTML=`<div class="rank">${i+1}</div>
      <div><div class="tk">${c.tk}</div><span class="pill ${c.model}">${c.model==='owner'?'owner-operator':c.model==='landlord'?'landlord':'hybrid'}</span><span class="ct">${c.contractedPct}% contracted · ${c.termYrs}y term</span></div>
      <div class="col-stack"><div class="stack">${segHTML}</div><div class="stacklabel"><span>EV ${fmtM(v.ev)}</span><span>${totMW.toLocaleString()} MW · ${c.sites.length} sites</span></div>${splitBarHTML(v)}<div class="stacklabel"><span>Contracted ${splitParts(v).cf.toFixed(0)}%</span><span>Expected ${splitParts(v).eu.toFixed(0)}%</span></div></div>
      <div class="num"><div class="target">$${v.target.toFixed(0)}</div><div class="up ${upCls}">${upTxt}</div></div>
      <div class="num"><div class="score-wrap"><div class="score-n">${r.score.toFixed(0)}</div><div class="score-bar"><span style="width:${r.score.toFixed(0)}%"></span></div></div></div>`;
    row.addEventListener('click',()=>openPanel(c));row.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();openPanel(c);}});
    cont.appendChild(row);});
  if(!reduce)[...cont.children].forEach(ch=>{const p=old[ch.dataset.tk];if(p==null)return;const dy=p-ch.getBoundingClientRect().top;if(dy){ch.style.transition='none';ch.style.transform=`translateY(${dy}px)`;requestAnimationFrame(()=>{ch.style.transition='';ch.style.transform='';});}});
  document.getElementById('sortlabel').textContent=sortKey==='score'?'relative-strength score':'upside to target';
  document.getElementById('ar-upside').textContent=sortKey==='upside'?(sortDir<0?'▾':'▴'):'';
  document.getElementById('ar-score').textContent=sortKey==='score'?(sortDir<0?'▾':'▴'):'';
}
function renderSites(){
  let all=[];
  COMPANIES.forEach(c=>{
    const v=value(c);
    v.segs.forEach(sg=>{
      all.push({co:c.tk,coName:c.name,model:c.model,company:c,name:sg.s.n,mw:sg.s.mw,tenure:sg.s.owned?'owned':'leased',region:REGION[sg.s.region].name,yr:sg.s.yr,mo:sg.s.mo,prov:sg.s.prov,val:sg.ev,hair:sg.hair,dfac:sg.dfac});
    });
  });
  const cmp={co:(a,b)=>a.co.localeCompare(b.co),name:(a,b)=>a.name.localeCompare(b.name),mw:(a,b)=>a.mw-b.mw,tenure:(a,b)=>a.tenure.localeCompare(b.tenure),region:(a,b)=>a.region.localeCompare(b.region),yr:(a,b)=>(a.yr*12+(a.mo||1))-(b.yr*12+(b.mo||1)),prov:(a,b)=>a.prov.localeCompare(b.prov),val:(a,b)=>a.val-b.val};
  all.sort((a,b)=>siteDir*cmp[siteSort](a,b));
  document.getElementById('sites-body').innerHTML=all.map(s=>`<tr style="cursor:pointer" onclick="openPanelTk('${s.co}')">
    <td class="co">${s.co}</td><td>${s.name}</td><td class="r mono">${s.mw.toLocaleString()}</td>
    <td>${s.tenure}</td><td><span class="dot" style="background:${horizon(s.yr)}"></span>${s.region}</td>
    <td class="r mono">${MONTHS[(s.mo||1)-1]} ${s.yr}</td><td><span class="prov ${s.prov}">${s.prov}</span></td>
    <td class="r mono">${fmtM(s.val)}</td></tr>`).join('');
  // MW-by-provenance summary
  const byP={disclosed:0,estimated:0,rumored:0};let totMW=0;all.forEach(s=>{byP[s.prov]+=s.mw;totMW+=s.mw;});
  const col={disclosed:'var(--indigo)',estimated:'#C9A86A',rumored:'var(--clay)'};
  document.getElementById('mwbar').innerHTML=['disclosed','estimated','rumored'].map(k=>`<i style="width:${(byP[k]/totMW*100).toFixed(1)}%;background:${col[k]}"></i>`).join('');
  document.getElementById('ssummary').innerHTML=`<span>Total <b>${totMW.toLocaleString()} MW</b> across ${all.length} sites</span>`+['disclosed','estimated','rumored'].map(k=>`<span>${k} <b>${(byP[k]/totMW*100).toFixed(0)}%</b></span>`).join('')+`<span style="font-style:italic">— ${((byP.rumored)/totMW*100).toFixed(0)}% of universe MW is rumored</span>`;
}
window.openPanelTk=tk=>openPanel(COMPANIES.find(c=>c.tk===tk));

/* ---- shared one-pager pieces (used by both the quick panel and the full page) ---- */
function modelLabel(c){return c.model==='owner'?'GPU owner-operator':c.model==='landlord'?'colo / data-center landlord':'hybrid';}
function scoreOf(c){let rs=COMPANIES.map(x=>({c:x,v:value(x)}));scores(rs);return rs.find(x=>x.c.tk===c.tk).score;}
function liHTML(a){return a.map(x=>`<li>${x}</li>`).join('');}
function qualHTML(c){return `<div class="qual">
  <div class="qcol bull"><h5>Bull case</h5><ul>${liHTML(c.bull)}</ul></div>
  <div class="qcol bear"><h5>Bear case</h5><ul>${liHTML(c.bear)}</ul></div>
  <div class="qcol"><h5>Catalysts</h5><ul>${liHTML(c.catalysts)}</ul></div>
  <div class="qcol"><h5>Key risks</h5><ul>${liHTML(c.risks)}</ul></div></div>`;}
function siteCalcHTML(c,sg){const s=sg.s,k=sg.calc,r=REGION[s.region];
  const row=(a,b,note)=>`<div class="cstep"><span>${a}</span><span class="cval">${b}</span><span class="cnote">${note||''}</span></div>`;
  let steps='';
  if(c.model==='landlord'){
    steps+=row('NOI / MW·yr','$'+k.noi.toFixed(2)+'M',`$${CONST.landlordNOI}M base · ${r.name.toLowerCase()} · ${s.owned?'owned':'leased'} · MTM`);
    steps+=row('Cap rate',(k.cap*100).toFixed(2)+'%',`${A.capRate}% dial − ${(CONST.capCompress*c.contractedPct).toFixed(0)}% contracted`);
    steps+=row('Value / MW','$'+sg.ppm.toFixed(1)+'M','NOI ÷ cap rate');
  }else{
    steps+=row('Effective rate','$'+k.eff.toFixed(2)+'M/MW·yr',`${Math.round(sg.contractedShare*100)}% @ $${CONST.contractRate}M contract · rest spot`);
    steps+=row('Margin',k.m+'%',`${A.margin} ${r.cMargin>=0?'+':'−'}${Math.abs(r.cMargin)} ${r.name.toLowerCase()} ${s.owned?'+'+CONST.ownedCMargin+' owned':CONST.leasedCMargin+' leased'}`);
    steps+=row('Multiple',k.mult.toFixed(2)+'×',`${A.multiple}× · (1 + ${(CONST.multPremium*c.contractedPct/100).toFixed(2)} contracted)`);
    steps+=row('Value / MW','$'+sg.ppm.toFixed(1)+'M','rate × margin × multiple');
  }
  steps+=row('Gross value',fmtM(sg.gross),`$${sg.ppm.toFixed(1)}M × ${s.mw} MW`);
  steps+=row('× Execution haircut','×'+sg.hair.toFixed(2),s.prov);
  steps+=row('× Time discount','×'+sg.dfac.toFixed(2),sg.yrs<=0?'live now':`${sg.yrs.toFixed(1)} yrs @ ${sg.dr%1===0?sg.dr:sg.dr.toFixed(1)}%`);
  steps+=`<div class="cstep tot"><span>Site value</span><span class="cval">${fmtM(sg.ev)}</span><span class="cnote"></span></div>`;
  steps+=row('— Contracted floor',fmtM(sg.contractedEV),`${Math.round(sg.contractedShare*100)}% of value`);
  steps+=row('— Expected upside',fmtM(sg.expectedEV),`${Math.round((1-sg.contractedShare)*100)}%`);
  return `<div class="sitecalc">${steps}</div>`;}
function sitesRowsHTML(v){return v.segs.map(sg=>{const s=sg.s,r=REGION[s.region];return `<div class="site"><div><div class="s1">${s.n} · ${s.mw} MW</div><div class="s2">${s.owned?'owned':'leased'} · ${r.name} power · live ${MONTHS[(s.mo||1)-1]} ${s.yr} <span class="prov ${s.prov}">${s.prov}</span></div></div><div class="sv">${fmtM(sg.ev)}<div class="s2" style="text-align:right">×${(sg.hair*100).toFixed(0)}% × ${sg.dfac.toFixed(2)}df</div></div></div>`;}).join('');}
function evChartHTML(v,c){const max=Math.max(...v.segs.map(s=>s.ev),1e-9);return v.segs.map(sg=>{const s=sg.s,w=(sg.ev/max*100).toFixed(1);return `<details class="evexp"><summary class="evrow"><div class="evlbl">${s.n}<span class="evmeta">${MONTHS[(s.mo||1)-1]} ${s.yr} · ${s.prov}</span></div><div class="evbarwrap"><div class="evbar" style="width:${w}%;background:${horizon(s.yr)};opacity:${PROV_OP[s.prov]}"></div></div><div class="evval">${fmtM(sg.ev)}</div></summary>${siteCalcHTML(c,sg)}</details>`;}).join('');}
function commercialHTML(c){const f=(a,b)=>`<div class="f"><span>${a}</span><span>${b}</span></div>`;return `<div class="facts">${f('Contracted today',c.contractedPct+'%')}${f('Avg term remaining',c.termYrs+' yrs')}${f('Renewal probability',(c.renewalProb*100).toFixed(0)+'%')}${f(c.model==='landlord'?'Mark-to-market (% original)':'Mark-to-market (% prevailing)',(c.mtm*100).toFixed(0)+'%')}${c.model!=='landlord'?f('Effective realized rate','$'+ownerRate(c).toFixed(1)+'M / MW·yr'):''}${f('Counterparty quality',c.leaseQ.toFixed(1)+' / 5')}${f('Net debt',fmtM(c.netDebt))}${f('Cost of debt',(c.costOfDebt||0).toFixed(1)+'%')}${f('Financing mix',c.finMix||'—')}${f('Discount used',Math.max(A.disc,c.costOfDebt||0).toFixed(0)+'% (floor = cost of debt)')}${f('Shares out',c.shares+'M')}</div>`;}
function valBuildHTML(c,v){const upCls=v.upside>=0?'pos':'neg',upTxt=(v.upside>=0?'+':'')+(v.upside*100).toFixed(1)+'%';const p=splitParts(v);return `<div class="breakdown"><div class="b tot"><span>Enterprise value (sum of sites)</span><b>${fmtM(v.ev)}</b></div>${splitBarHTML(v)}<div class="b"><span>— Contracted floor (dial-insulated)</span><b>${fmtM(v.contractedEV)} · ${p.cf.toFixed(0)}%</b></div><div class="b"><span>— Expected upside (spot &amp; pipeline)</span><b>${fmtM(v.expectedEV)} · ${p.eu.toFixed(0)}%</b></div><div class="b"><span>Less: net debt</span><b>−${fmtM(c.netDebt)}</b></div><div class="b tot"><span>Equity value</span><b>${fmtM(v.equity)}</b></div><div class="b tot"><span>Price target → upside</span><b>$${v.target.toFixed(0)} · <span class="up ${upCls}">${upTxt}</span></b></div></div>`;}
function devsHTML(c){return c.log.map(e=>`<div class="ev"><div class="meta"><span class="etype">${e.t}</span><span>${e.d} · ${e.s}</span></div><div>${e.x}</div></div>`).join('');}

/* ---- quick panel: a summary surface of the full page ---- */
function openPanel(c){const v=value(c),p=document.getElementById('panel');const score=scoreOf(c);
  const upCls=v.upside>=0?'pos':'neg',upTxt=(v.upside>=0?'+':'')+(v.upside*100).toFixed(1)+'%';
  p.innerHTML=`<button class="x" id="closex" aria-label="Close">✕</button>
    <div class="p-head"><div><div class="p-tk">${c.tk}</div><div class="p-model">${c.name} · ${modelLabel(c)} · $${c.price} now</div></div>
      <div class="p-tgt"><div class="t">$${v.target.toFixed(0)}</div><div class="u up ${upCls}">${upTxt}</div><div class="sc">score ${score.toFixed(0)}/100</div></div></div>
    <div class="narr">${c.narrative}</div>
    ${qualHTML(c)}
    <h4 class="sec">Sites — value rolls up from here</h4>${sitesRowsHTML(v)}
    <h4 class="sec">Commercial &amp; capital</h4>${commercialHTML(c)}
    <h4 class="sec">Valuation</h4>${valBuildHTML(c,v)}
    <h4 class="sec">Developments</h4>${devsHTML(c)}
    <button class="fpbtn" id="fullbtn">Open full page ↗</button>
    <div class="lognote">In the real app, logging a development attaches to a site and updates the facts above; the valuation and ranking move automatically.</div>`;
  p.classList.add('on');document.getElementById('scrim').classList.add('on');
  document.getElementById('closex').onclick=closePanel;
  document.getElementById('fullbtn').onclick=()=>{closePanel();openFull(c);};
  document.getElementById('closex').focus();}

/* ---- full page: the extensible home (graphical, with planned-module slots) ---- */
function openFull(c){const v=value(c),score=scoreOf(c),fp=document.getElementById('fullpage');
  const upCls=v.upside>=0?'pos':'neg',upTxt=(v.upside>=0?'+':'')+(v.upside*100).toFixed(1)+'%';
  fp.innerHTML=`<button class="back" id="fpback">← Back to comparison</button>
    <div class="fp-head">
      <div><div class="fp-tk">${c.tk}</div><div class="fp-model">${c.name} · ${modelLabel(c)}</div></div>
      <div class="fp-nums">
        <div class="fp-num"><span>Price</span><b>$${c.price}</b></div>
        <div class="fp-num"><span>Target</span><b>$${v.target.toFixed(0)}</b></div>
        <div class="fp-num"><span>Upside</span><b class="up ${upCls}">${upTxt}</b></div>
        <div class="fp-num"><span>Score</span><b>${score.toFixed(0)}</b></div>
      </div>
    </div>
    <div class="fp-grid">
      <div class="fp-main">
        <div class="narr">${c.narrative}</div>
        <h4 class="sec">Valuation — where the value comes from <span class="hint">tap a bar for the math</span></h4>
        <div class="evchart">${evChartHTML(v,c)}</div>
        ${valBuildHTML(c,v)}
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
function closeFull(){document.getElementById('fullpage').classList.remove('on');document.querySelector('.grid').style.display='';}
function closePanel(){document.getElementById('panel').classList.remove('on');document.getElementById('scrim').classList.remove('on');}

/* ---- wiring (after data loads) ---- */
function wireEvents(){
  document.querySelectorAll('.tab').forEach(t=>t.addEventListener('click',()=>{view=t.dataset.view;document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('on',x===t));document.getElementById('view-cmp').style.display=view==='cmp'?'':'none';document.getElementById('view-sites').style.display=view==='sites'?'':'none';render();}));
  document.querySelectorAll('.thead .sortable').forEach(h=>h.addEventListener('click',()=>{const k=h.dataset.sort;if(k===sortKey)sortDir*=-1;else{sortKey=k;sortDir=-1;}render();}));
  document.querySelectorAll('.stab th').forEach(h=>h.addEventListener('click',()=>{const k=h.dataset.s;if(k===siteSort)siteDir*=-1;else{siteSort=k;siteDir=(k==='co'||k==='name'||k==='region'||k==='tenure'||k==='prov')?1:-1;}render();}));
  document.getElementById('reset').addEventListener('click',()=>{Object.assign(A,BASE);syncControls();render();});
  document.getElementById('scrim').addEventListener('click',closePanel);
  addEventListener('keydown',e=>{if(e.key==='Escape'){closePanel();if(document.getElementById('fullpage').classList.contains('on'))closeFull();}});
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
    render();
  }catch(err){
    document.getElementById('rows').innerHTML=`<div class="appmsg err">Could not load data.json — ${err.message}. Serve this folder over HTTP (not file://).</div>`;
  }
}
boot();
