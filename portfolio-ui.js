/* Portfolio tab (spec §6b) — renders portfolio.json + portfolio-history.json.
   Display + "what the book does next": current weights from the ledger, target
   weights recomputed live from the engine at today's prices and the go-live state. */
let PF=null,PFH=null,PF_LOADING=false,PF_ERR=null,PF_AT=0;

async function loadPortfolio(){
  if(PF_LOADING)return;PF_LOADING=true;PF_ERR=null;
  try{
    const [a,b]=await Promise.all([
      fetch('portfolio.json',{cache:'no-store'}),
      fetch('portfolio-history.json',{cache:'no-store'})]);
    if(!a.ok||!b.ok)throw new Error('HTTP '+(a.ok?b.status:a.status));
    PF=await a.json();PFH=await b.json();PF_AT=Date.now();
  }catch(e){PF_ERR=e.message;}
  PF_LOADING=false;
  if(view==='port'||view==='checks')render();
}
function retryPortfolio(){PF_ERR=null;PF=null;PFH=null;loadPortfolio();}

function pfPct(x,dp){return (x>=0?'+':'')+(x*100).toFixed(dp==null?1:dp)+'%';}
function pfW(x){return (x*100).toFixed(1)+'%';}

/* today's views/targets from the live engine + the CURRENT (go-live) learning state */
function pfTodayViews(){
  const watch={};(RAW_DATA.watchItems||[]).forEach(w=>{watch[w.tk]=(watch[w.tk]||0)+1;});
  const rows=COMPANIES.map(c=>{const v=value(c);return{tk:c.tk,price:priceOf(c),target:v.target,ev:v.ev,contractedEV:v.contractedEV,legacy:legacyOf(c),watch:watch[c.tk]||0};});
  const state=JSON.parse(JSON.stringify(PF.state));
  const views=PortfolioCore.computeViews(rows,state,PF.params);
  const tw=PortfolioCore.targetWeights(views,PF.params);
  return{views,tw};
}

/* per-name NAV-point contributions: w(t−1) × return(t) × nav(t−1)/100, split sim vs live */
function pfAttribution(days,backtestThrough){
  const sim={},live={};
  for(let i=1;i<days.length;i++){
    const a=days[i-1],b=days[i];
    const tgt=(b.d<=backtestThrough)?sim:live;
    for(const tk in (a.w||{})){
      const p0=a.px[tk],p1=b.px[tk];
      if(p0>0&&p1>0)tgt[tk]=(tgt[tk]||0)+a.w[tk]*(p1/p0-1)*a.nav;
    }
  }
  return{sim,live};
}

function pfChartHTML(days,meta){
  const W=640,H=260,ml=46,mr=12,mt=12,mb=26,pw=W-ml-mr,ph=H-mt-mb;
  const lo=Math.min(...days.map(d=>Math.min(d.nav,d.bench))),hi=Math.max(...days.map(d=>Math.max(d.nav,d.bench)));
  const span=Math.max(1e-9,Math.log(hi*1.05)-Math.log(lo*0.95));
  const yOf=v=>mt+ph-((Math.log(v)-Math.log(lo*0.95))/span)*ph;
  const xOf=i=>ml+(i/Math.max(1,days.length-1))*pw;
  const tx='style="font-family:var(--mono);font-size:10px;fill:var(--ink-soft)"';
  let s='';
  // simulated-genesis region
  let simEnd=days.length-1;
  for(let i=0;i<days.length;i++)if(days[i].d>meta.backtestThrough){simEnd=i-1;break;}
  if(simEnd>=0)s+=`<rect x="${ml}" y="${mt}" width="${(xOf(simEnd)-ml).toFixed(1)}" height="${ph}" fill="var(--far)" opacity="0.14"/>`;
  const levels=[25,50,75,100,150,200,300,400,600,800,1200,1600,2400].filter(v=>v>=lo*0.95&&v<=hi*1.05);
  levels.forEach(v=>{const y=yOf(v);s+=`<line x1="${ml}" y1="${y.toFixed(1)}" x2="${W-mr}" y2="${y.toFixed(1)}" style="stroke:var(--line);stroke-width:1"/><text x="${ml-6}" y="${(y+3).toFixed(1)}" text-anchor="end" ${tx}>${v}</text>`;});
  // date ticks: quarterly under ~1.7yr, else semiannual, else annual
  const months=days.length>900?[1]:days.length>420?[1,7]:[1,4,7,10];
  let lastLbl='';days.forEach((d,i)=>{const ym=d.d.slice(0,7),m=+d.d.slice(5,7);
    if(ym!==lastLbl&&months.includes(m)){lastLbl=ym;
      const x=Math.min(Math.max(xOf(i),ml+22),W-mr-22);
      s+=`<text x="${x.toFixed(1)}" y="${(mt+ph+16).toFixed(1)}" text-anchor="middle" ${tx}>${d.d.slice(0,7)}</text>`;}});
  const line=(key,style)=>`<polyline fill="none" ${style} points="${days.map((d,i)=>xOf(i).toFixed(1)+','+yOf(d[key]).toFixed(1)).join(' ')}"/>`;
  s+=line('bench','style="stroke:var(--ink-soft);stroke-width:1.3" stroke-dasharray="4 3"');
  s+=line('nav','style="stroke:var(--indigo);stroke-width:1.8"');
  if(simEnd>=0&&simEnd<days.length-1){const x=xOf(simEnd);s+=`<line x1="${x.toFixed(1)}" y1="${mt}" x2="${x.toFixed(1)}" y2="${mt+ph}" style="stroke:var(--clay);stroke-width:1" stroke-dasharray="2 3"/>`;}
  s+=`<text x="${ml+6}" y="${mt+12}" ${tx}>simulated genesis</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Portfolio NAV vs equal-weight benchmark (log scale, base 100)">${s}</svg>`;
}

function renderPortfolio(){
  const body=document.getElementById('port-body');if(!body)return;
  if(PF_ERR){body.innerHTML=`<div class="appmsg err">Could not load portfolio files — ${PF_ERR} <button class="refreshbtn" onclick="retryPortfolio()">retry</button></div>`;return;}
  if(!PF||!PFH){body.innerHTML='<div class="legend2">loading portfolio…</div>';loadPortfolio();return;}
  if(Date.now()-PF_AT>1800000)loadPortfolio();   // stale open tab: refetch every 30min (daily Action commits new marks)
  const days=PFH.days,meta=PFH.meta,last=days[days.length-1];
  const liveDays=days.filter(d=>d.d>PF.backtestThrough);
  let peak=0,mdd=0;days.forEach(d=>{peak=Math.max(peak,d.nav);mdd=Math.max(mdd,1-d.nav/peak);});
  const {views,tw}=pfTodayViews();
  const vBy={};views.forEach(v=>{vBy[v.tk]=v;});
  const dialsMoved=typeof A!=='undefined'&&typeof BASE!=='undefined'&&JSON.stringify(A)!==JSON.stringify(BASE);

  const stat=(l,v,sub)=>`<div class="pf-stat"><span>${l}</span><b>${v}</b>${sub?`<i>${sub}</i>`:''}</div>`;
  let h=`<div class="pf-stats">`+
    stat('NAV (base 100)',last.nav.toFixed(1),last.d)+
    stat('Total return',pfPct(last.nav/meta.base-1,0),'vs equal-weight '+pfPct(last.bench/meta.base-1,0))+
    stat('Live period',liveDays.length?pfPct(last.nav/days[days.length-1-liveDays.length].nav-1):'starts next close',liveDays.length?liveDays.length+' trading days · bench '+pfPct(last.bench/days[days.length-1-liveDays.length].bench-1):'genesis is simulated')+
    stat('Max drawdown',pfPct(-mdd,0),'benchmark path is rougher')+
    stat('Invested',pfW(1-last.cash),'cash '+pfW(last.cash))+
    stat('λ fight-the-market',PF.state.lambda.toFixed(2),'restarted neutral at go-live')+
    `</div>`;

  h+=`<h4 class="sec">NAV vs equal-weight universe (log scale)</h4><div class="pf-chart">${pfChartHTML(days,meta)}</div>
  <div class="legend2"><b>solid</b> portfolio · <b>dashed</b> equal-weight benchmark · shaded = simulated genesis (today's data.json against last year's prices — machinery validation, <b>not evidence of alpha</b>); the live record starts at the clay line.</div>`;

  if(dialsMoved)h+=`<div class="ck-m mid"><span class="ck-lv">note</span><b>dials moved</b> "Target now" below reflects your sandbox dial settings, not the base case the daily job trades — hit "Reset to base case" to see the job's view.</div>`;

  // holdings: current book (ledger) vs where today's views want it
  const names=new Set([...Object.keys(last.w),...Object.keys(tw.weights)]);
  const rows=[...names].map(tk=>({tk,cur:last.w[tk]||0,tgt:tw.weights[tk]||0,v:vBy[tk]})).sort((a,b)=>b.tgt-a.tgt||b.cur-a.cur);
  h+=`<h4 class="sec">Holdings — current book → today's target</h4><div style="overflow-x:auto"><table class="stab"><thead><tr>
    <th>Name</th><th class="r">Weight</th><th class="r">Target now</th><th class="r">Upside</th><th class="r">Confidence</th><th class="r">Mult m</th><th class="r">View ν</th></tr></thead><tbody>`;
  rows.forEach(r=>{const v=r.v||{};
    h+=`<tr><td class="co">${r.tk}</td><td class="r mono">${pfW(r.cur)}</td><td class="r mono">${pfW(r.tgt)}</td>
      <td class="r mono">${v.upside!=null?pfPct(v.upside,0):'—'}</td>
      <td class="r mono" title="hard backing ${(100*(v.hardShare||0)).toFixed(0)}% of EV (contracted floor + legacy)">${v.conf!=null?(v.conf*100).toFixed(0)+'%':'—'}</td>
      <td class="r mono">${v.m!=null?v.m.toFixed(2):'—'}</td>
      <td class="r mono">${v.nu!=null?v.nu.toFixed(3):'—'}</td></tr>`;});
  h+=`<tr><td class="co">Cash</td><td class="r mono">${pfW(last.cash)}</td><td class="r mono">${pfW(tw.cash)}</td><td class="r mono">—</td><td class="r mono">—</td><td class="r mono">—</td><td class="r mono">0</td></tr>`;
  h+=`</tbody></table></div>
  <div class="legend2">ν = λ × confidence × m × ln(target ÷ price) — the shrunk view that sizes the book. Confidence comes from how much of the target is contracted floor + marked legacy vs pipeline hope, less open watch-items. Softmax at T=${PF.params.temperature} (low = concentrated, no cap, by mandate); gross ${(tw.gross*100).toFixed(0)}% — cash grows mechanically when total edge thins. Trades fire only past the ${(PF.params.band*100).toFixed(0)}pt band.</div>`;

  // attribution: who actually made the money
  const att=pfAttribution(days,PF.backtestThrough);
  const attNames=[...new Set([...Object.keys(att.sim),...Object.keys(att.live)])]
    .map(tk=>({tk,sim:att.sim[tk]||0,live:att.live[tk]||0}))
    .sort((a,b)=>(b.live+b.sim)-(a.live+a.sim));
  if(attNames.length){
    h+=`<h4 class="sec">Attribution — NAV points by name</h4><div style="overflow-x:auto"><table class="stab"><thead><tr><th>Name</th><th class="r">Simulated</th><th class="r">Live</th></tr></thead><tbody>`;
    attNames.slice(0,12).forEach(a=>{const f=x=>x?`<span style="color:${x>=0?'var(--pine)':'var(--clay)'}">${x>=0?'+':''}${x.toFixed(1)}</span>`:'—';
      h+=`<tr><td class="co">${a.tk}</td><td class="r mono">${f(a.sim)}</td><td class="r mono">${f(a.live)}</td></tr>`;});
    h+=`</tbody></table></div><div class="legend2">Yesterday's weight × today's return, in points of a base-100 NAV. The simulated column is hindsight (see chart label); the live column is the real scoreboard and starts empty.</div>`;
  }

  // learning state
  const shrunk=Object.entries(PF.state.names||{}).filter(([,s])=>s.m<0.995||s.opp>0).sort((a,b)=>a[1].m-b[1].m);
  let lastLearn=null;for(let i=days.length-1;i>=0;i--)if(days[i].learn){lastLearn={d:days[i].d,...days[i].learn};break;}
  h+=`<h4 class="sec">Learning — where the market disagrees with us</h4>`;
  if(shrunk.length){h+=`<div style="overflow-x:auto"><table class="stab"><thead><tr><th>Name</th><th class="r">Multiplier</th><th></th></tr></thead><tbody>`;
    shrunk.forEach(([tk,s])=>{h+=`<tr><td class="co">${tk}</td><td class="r mono">${s.m.toFixed(2)}${s.opp>0?' <span class="ck-age mid">on watch</span>':''}</td><td>${s.conviction?'<span class="prov disclosed">conviction — shrink exempt</span>':s.m<0.995?'market opposed this view in two consecutive windows; sizing shrunk, recovers when vindicated':'one opposed window — shrinks if the next window agrees'}</td></tr>`;});
    h+=`</tbody></table></div>`;}
  else h+=`<div class="legend2">No active disagreements — every multiplier at 1.0 (learning restarted neutral at go-live; updates every ${PF.params.learnEvery} trading days over a ${PF.params.lookback}-day window vs the universe <b>median</b>, only on live records${lastLearn?` · last simulated update ${lastLearn.d}: rank-IC ${lastLearn.ic}`:''}). To exempt a name from shrinkage, set <b>conviction: true</b> on it in portfolio.json.</div>`;

  // operational flags + notes: quarantines, stale names, corporate actions — surfaced, never silent
  const flags=[];
  Object.entries(PF.suspect||{}).forEach(([tk,n])=>{if(n>0)flags.push(`${tk}: suspect print quarantined (day ${n}/3)`);});
  const noteDays=days.filter(d=>d.notes&&d.notes.length).slice(-5);
  if(flags.length||noteDays.length){
    h+=`<h4 class="sec">Operational notes</h4>`;
    flags.forEach(f=>{h+=`<div class="ck-m mid"><span class="ck-lv">flag</span>${f}</div>`;});
    noteDays.forEach(d=>d.notes.forEach(n=>{h+=`<div class="ck-m ${n.includes('SUSPECT')||n.includes('frozen')?'mid':'ok'}"><span class="ck-lv">${d.d.slice(5)}</span>${n}</div>`;}));
  }

  // recent trades
  const tds=[];for(let i=days.length-1;i>=0&&tds.length<12;i--)days[i].trades.forEach(t=>{if(tds.length<12)tds.push({d:days[i].d,...t});});
  if(tds.length){h+=`<h4 class="sec">Latest trades (paper, ${PF.params.tcBps}bps cost)</h4><div style="overflow-x:auto"><table class="stab"><thead><tr><th>Date</th><th>Name</th><th class="r">Trade</th><th class="r">Price</th><th class="r">To weight</th></tr></thead><tbody>`;
    tds.forEach(t=>{h+=`<tr><td class="mono">${t.d}</td><td class="co">${t.tk}</td><td class="r mono" style="color:${t.usd>=0?'var(--pine)':'var(--clay)'}">${t.usd>=0?'buy':'sell'} ${Math.abs(t.usd).toFixed(1)}</td><td class="r mono">$${t.px}</td><td class="r mono">${pfW(t.to)}</td></tr>`;});
    h+=`</tbody></table></div><div class="legend2">Trade sizes are NAV points (base 100). The daily job runs after US close (GitHub Action) — facts change the book only by flowing through data.json first.</div>`;}

  body.innerHTML=h;
}
