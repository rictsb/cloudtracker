/* Shared market marks refresh every 30 minutes and after sleeping tabs resume.
 * Equity provider timestamps remain separate from retrieval times. Coinbase spot
 * has no trade clock: its date records receipt. Failed names keep their own dates. */
(function (root) {
  'use strict';
  const INTERVAL=1800000,CACHE_KEY='cloudtracker.market-marks.v1',FALLBACK=['IREN','CRWV','NBIS'],listeners=new Set();
  let timer=null,inFlight=null,listening=false,hydrated=false,lastAttempt=0,started=false,serverChecked=false;
  let requested=new Set(),activeTickers=[];
  let marks={prices:{},priceDates:{},priceFetchedAt:{},priceSources:{},cryptoDates:{},btc:null,eth:null,asOf:null,fetchedAt:null};
  let state={phase:'idle',lastAttemptAt:null,lastSuccessAt:null,failedTickers:[],failedCrypto:[],fromCache:false,transport:null,serverCheckedAt:null,serverStatus:null};
  const usable=n=>typeof n==='number'&&Number.isFinite(n)&&n>0;
  const now=()=>Date.now(),iso=()=>new Date(now()).toISOString();
  const validDate=v=>{
    if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(v))return false;
    const ms=Date.parse(v);return Number.isFinite(ms)&&ms<=now()+300000&&new Date(ms).toISOString().slice(0,19)===v.slice(0,19);
  };
  const cloneMarks=()=>({...marks,prices:{...marks.prices},priceDates:{...marks.priceDates},priceFetchedAt:{...marks.priceFetchedAt},priceSources:{...marks.priceSources},cryptoDates:{...marks.cryptoDates}});
  function getState(){
    return {...state,failedTickers:[...state.failedTickers],failedCrypto:[...state.failedCrypto],refreshing:!!inFlight,
      intervalMs:INTERVAL,nextRefreshAt:lastAttempt?new Date(lastAttempt+INTERVAL).toISOString():null,cryptoClock:'receipt',marks:cloneMarks()};
  }
  function publish(){listeners.forEach(fn=>{try{fn(getState());}catch(_){}});}
  function universe(){
    const companies=root.CloudModel&&root.CloudModel.source&&root.CloudModel.source.companies;
    return [...new Set(Array.isArray(companies)&&companies.length?companies.map(c=>c.tk).filter(tk=>typeof tk==='string'&&/^[A-Z0-9._-]{1,32}$/.test(tk)):FALLBACK)];
  }
  function repaint(){try{if(root.CVApp&&typeof root.CVApp.refresh==='function')root.CVApp.refresh();}catch(_){}}
  function applyToModel(delta,paint){
    try{if(root.CloudModel&&typeof root.CloudModel.setMarks==='function')root.CloudModel.setMarks(delta);}catch(_){}
    if(paint!==false)repaint();
  }
  // Merge successful observations only; never promote the cycle clock to a ticker clock.
  function merge(delta,cached){
    const accepted={prices:{},priceDates:{},priceFetchedAt:{},priceSources:{},cryptoDates:{}};
    const current=root.CloudModel&&root.CloudModel.marks;
    Object.entries(delta.prices||{}).forEach(([tk,price])=>{
      if(!/^[A-Z0-9._-]{1,32}$/.test(tk)||!usable(price))return;
      const date=validDate(delta.priceDates&&delta.priceDates[tk])?delta.priceDates[tk]:null;
      const previousDates=[marks.priceDates[tk],current&&current.priceDates&&current.priceDates[tk]].filter(validDate);
      if(date&&previousDates.some(previous=>Date.parse(previous)>Date.parse(date)))return;
      const fetchedAt=validDate(delta.priceFetchedAt&&delta.priceFetchedAt[tk])?delta.priceFetchedAt[tk]:null;
      const previousReceipts=[marks.priceFetchedAt[tk],current&&current.priceFetchedAt&&current.priceFetchedAt[tk]].filter(validDate);
      if(cached&&((!date&&previousDates.length)||(!fetchedAt&&previousReceipts.length)||(fetchedAt&&previousReceipts.some(previous=>Date.parse(previous)>Date.parse(fetchedAt)))))return;
      marks.prices[tk]=accepted.prices[tk]=price;marks.priceDates[tk]=accepted.priceDates[tk]=date;
      marks.priceFetchedAt[tk]=accepted.priceFetchedAt[tk]=fetchedAt;
      marks.priceSources[tk]=accepted.priceSources[tk]=delta.priceSources&&delta.priceSources[tk]==='Finnhub'?'Finnhub':'Market quote';
    });
    ['btc','eth'].forEach(asset=>{
      if(!usable(delta[asset]))return;
      const date=validDate(delta.cryptoDates&&delta.cryptoDates[asset])?delta.cryptoDates[asset]:null;
      if(date&&validDate(marks.cryptoDates[asset])&&Date.parse(date)<Date.parse(marks.cryptoDates[asset]))return;
      if(cached&&!date&&validDate(marks.cryptoDates[asset]))return;
      marks[asset]=accepted[asset]=delta[asset];marks.cryptoDates[asset]=accepted.cryptoDates[asset]=date;
    });
    if(!Object.keys(accepted.prices).length&&!('btc'in accepted)&&!('eth'in accepted))return null;
    const fetchedAt=validDate(delta.fetchedAt)?delta.fetchedAt:validDate(delta.asOf)?delta.asOf:null;
    if(fetchedAt&&(!validDate(marks.fetchedAt)||Date.parse(fetchedAt)>=Date.parse(marks.fetchedAt)))marks.asOf=marks.fetchedAt=fetchedAt;
    accepted.asOf=marks.asOf;accepted.fetchedAt=marks.fetchedAt;return accepted;
  }
  function saveCache(){try{root.localStorage.setItem(CACHE_KEY,JSON.stringify({version:1,marks:cloneMarks()}));}catch(_){}}
  function hydrate(){
    if(hydrated)return;hydrated=true;
    if(root.CloudModel&&root.CloudModel.marks)merge(root.CloudModel.marks);
    try{
      const cached=JSON.parse(root.localStorage.getItem(CACHE_KEY)||'null');
      if(!cached||cached.version!==1||!cached.marks||!validDate(cached.marks.fetchedAt))return;
      const accepted=merge(cached.marks,true);if(!accepted)return;applyToModel(accepted);
      state={...state,phase:'cached',fromCache:true,transport:'cache',lastSuccessAt:marks.fetchedAt};
      lastAttempt=Date.parse(marks.fetchedAt);requested=new Set(Object.keys(marks.prices));
    }catch(_){}finally{publish();}
  }
  async function readJSON(url){
    const controller=typeof root.AbortController==='function'?new root.AbortController():null;
    const timeout=controller?root.setTimeout(()=>controller.abort(),15000):null;
    try{const r=await root.fetch(url,{cache:'no-store',...(controller?{signal:controller.signal}:{})});return r.ok?await r.json():null;}
    catch(_){return null;}finally{if(timeout!=null)root.clearTimeout(timeout);}
  }
  async function quote(tk,token){
    const j=await readJSON('https://finnhub.io/api/v1/quote?symbol='+encodeURIComponent(tk)+'&token='+encodeURIComponent(token));
    if(!j||!usable(j.c))return null;
    const ms=typeof j.t==='number'&&j.t>0?j.t*1000:NaN;
    const date=Number.isFinite(ms)&&Math.abs(ms)<=8640000000000000?new Date(ms).toISOString():null;
    return {price:j.c,date:validDate(date)?date:null,fetchedAt:iso()};
  }
  async function spot(pair){
    const j=await readJSON('https://api.coinbase.com/v2/prices/'+pair+'/spot'),v=j&&j.data&&j.data.amount;
    const price=typeof v==='string'&&v.trim()?Number(v):typeof v==='number'?v:NaN;
    return usable(price)?{price,fetchedAt:iso()}:null;
  }
  function snapshotShape(s){
    const object=x=>x&&typeof x==='object'&&!Array.isArray(x),tickers=x=>Array.isArray(x)&&x.every(t=>typeof t==='string'&&/^[A-Z0-9._-]{1,32}$/.test(t))&&new Set(x).size===x.length;
    if(!object(s)||s.version!==1||!validDate(s.checkedAt)||!['ready','partial','error'].includes(s.status)||!tickers(s.universe)||!tickers(s.failedTickers)||!Array.isArray(s.failedCrypto)||s.failedCrypto.some(x=>!['btc','eth'].includes(x))||!object(s.marks))return false;
    if(!object(s.marks.prices)||!object(s.marks.priceFetchedAt)||!object(s.marks.priceDates)||!object(s.marks.cryptoDates))return false;
    if(s.failedTickers.some(t=>!s.universe.includes(t))||(s.status==='ready'&&(s.failedTickers.length||s.failedCrypto.length)))return false;
    return Object.entries(s.marks.prices).every(([tk,p])=>s.universe.includes(tk)&&usable(p)&&validDate(s.marks.priceFetchedAt[tk])&&(s.marks.priceDates[tk]==null||validDate(s.marks.priceDates[tk])))&&
      ['btc','eth'].every(asset=>s.marks[asset]==null||(usable(s.marks[asset])&&validDate(s.marks.cryptoDates[asset])));
  }
  function snapshotComplete(s){
    const fresh=d=>validDate(d)&&now()-Date.parse(d)<INTERVAL;
    return s.status==='ready'&&activeTickers.every(tk=>s.universe.includes(tk)&&usable(s.marks.prices[tk])&&fresh(s.marks.priceFetchedAt[tk]))&&
      ['btc','eth'].every(asset=>usable(s.marks[asset])&&fresh(s.marks.cryptoDates[asset]));
  }
  function refresh(options){
    hydrate();if(inFlight)return inFlight;
    const token=root.FINNHUB_TOKEN||'';
    const previousAttempt=lastAttempt,cacheFresh=previousAttempt&&now()-previousAttempt<INTERVAL&&universe().every(tk=>requested.has(tk));
    activeTickers=universe();lastAttempt=now();state={...state,phase:'refreshing',lastAttemptAt:iso(),serverCheckedAt:null,serverStatus:null};
    inFlight=Promise.resolve().then(async()=>{
      const raw=await readJSON('/market-prices.json');serverChecked=true;
      const snapshot=snapshotShape(raw)?raw:null;
      if(snapshot){
        const fresh=now()-Date.parse(snapshot.checkedAt)<INTERVAL,complete=snapshotComplete(snapshot),accepted=merge(snapshot.marks,true);
        const unavailable=activeTickers.filter(tk=>!snapshot.universe.includes(tk)||!usable(snapshot.marks.prices[tk])||now()-Date.parse(snapshot.marks.priceFetchedAt[tk])>=INTERVAL);
        const missingCrypto=['btc','eth'].filter(asset=>!usable(snapshot.marks[asset])||now()-Date.parse(snapshot.marks.cryptoDates[asset])>=INTERVAL);
        state={...state,phase:fresh?(snapshot.status==='error'?'error':complete?'ready':'partial'):'cached',fromCache:!fresh,transport:'shared',serverCheckedAt:snapshot.checkedAt,serverStatus:snapshot.status,
          failedTickers:[...new Set([...snapshot.failedTickers,...unavailable])],failedCrypto:[...new Set([...snapshot.failedCrypto,...missingCrypto])],lastSuccessAt:accepted?marks.fetchedAt:state.lastSuccessAt};
        if(accepted){applyToModel(accepted,false);saveCache();if(!fresh||!complete){publish();repaint();}}
        if(fresh&&complete){
          requested=new Set(snapshot.universe);lastAttempt=Math.min(now(),Date.parse(snapshot.checkedAt));return;
        }
        // A current partial/error job is still useful evidence, even without a browser token.
        if(!token){requested=new Set(activeTickers);if(fresh)lastAttempt=Math.min(now(),Date.parse(snapshot.checkedAt));return;}
      }
      // A local cache is not allowed to suppress the first shared-snapshot check.
      if(!snapshot&&options&&options.allowFreshCache&&cacheFresh){
        lastAttempt=previousAttempt;state={...state,phase:'cached',fromCache:true,transport:'cache'};return;
      }
      if(!token){requested=new Set(activeTickers);state={...state,phase:'unconfigured',transport:state.fromCache?'cache':null};return;}
      lastAttempt=now();
      const [entries,btc,eth]=await Promise.all([Promise.all(activeTickers.map(async tk=>[tk,await quote(tk,token)])),spot('BTC-USD'),spot('ETH-USD')]);
      const delta={prices:{},priceDates:{},priceFetchedAt:{},priceSources:{},cryptoDates:{},asOf:iso(),fetchedAt:iso()},failedTickers=[];
      entries.forEach(([tk,q])=>{
        if(!q){failedTickers.push(tk);return;}
        delta.prices[tk]=q.price;delta.priceDates[tk]=q.date;delta.priceFetchedAt[tk]=q.fetchedAt;delta.priceSources[tk]='Finnhub';
      });
      if(btc){delta.btc=btc.price;delta.cryptoDates.btc=btc.fetchedAt;}
      if(eth){delta.eth=eth.price;delta.cryptoDates.eth=eth.fetchedAt;}
      const accepted=merge(delta),failedCrypto=['btc','eth'].filter(asset=>!delta[asset]);requested=new Set(activeTickers);
      state={...state,phase:accepted?(failedTickers.length||failedCrypto.length?'partial':'ready'):'error',
        failedTickers,failedCrypto,transport:accepted?'browser':state.transport,fromCache:accepted?false:state.fromCache,lastSuccessAt:accepted?marks.fetchedAt:state.lastSuccessAt};
      if(accepted){applyToModel(accepted,false);saveCache();}
    }).finally(()=>{
      inFlight=null;publish();repaint();
      if(started&&universe().some(tk=>!requested.has(tk)))refreshIfDue();
      schedule();
    });
    publish();return inFlight;
  }
  function refreshIfDue(){
    if(inFlight)return inFlight;
    if(!serverChecked)return refresh({allowFreshCache:true});
    if(!lastAttempt||now()-lastAttempt>=INTERVAL||universe().some(tk=>!requested.has(tk)))return refresh();
    return Promise.resolve(getState());
  }
  function wake(){if(!root.document||!root.document.hidden)refreshIfDue();}
  function schedule(){
    if(!started)return;
    if(timer!=null)root.clearTimeout(timer);
    const delay=state.phase==='unconfigured'?INTERVAL:Math.max(1,INTERVAL-(lastAttempt?now()-lastAttempt:0));
    timer=root.setTimeout(()=>{timer=null;refreshIfDue().finally(schedule);},delay);
  }
  function start(){
    started=true;hydrate();
    if(!listening){
      if(root.document&&root.document.addEventListener)root.document.addEventListener('visibilitychange',wake);
      if(root.addEventListener)root.addEventListener('focus',wake);listening=true;
    }const task=refreshIfDue();schedule();return task;
  }
  function stop(){
    started=false;if(timer!=null)root.clearTimeout(timer);timer=null;
    if(root.document&&root.document.removeEventListener)root.document.removeEventListener('visibilitychange',wake);
    if(root.removeEventListener)root.removeEventListener('focus',wake);listening=false;
  }
  root.Quotes={start,stop,refresh,refreshIfDue,getState,
    subscribe(fn){if(typeof fn!=='function')throw new TypeError('Quote subscriber must be a function');listeners.add(fn);fn(getState());return()=>listeners.delete(fn);}};
  Object.defineProperty(root.Quotes,'status',{get:getState});
})(typeof window!=='undefined'?window:globalThis);
