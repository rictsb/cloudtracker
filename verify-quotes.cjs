/* Quote polling/cache regressions with a fake clock and provider responses. No network or secrets. */
'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(__dirname+'/quotes.js','utf8'),KEY='cloudtracker.market-marks.v1',HALF_HOUR=1800000;
const INITIAL=Date.parse('2026-09-15T14:00:00Z'),copy=v=>JSON.parse(JSON.stringify(v));
const flush=async()=>{for(let i=0;i<24;i++)await Promise.resolve();};
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};}
function harness(options={}){
  let time=options.time||INITIAL,seq=0,repaints=0;
  const timers=new Map(),storage=new Map(options.storage||[]),requests=[],updates=[],events={},docEvents={},paintStates=[];
  let saved={prices:{},priceDates:{},priceFetchedAt:{},priceSources:{},cryptoDates:{},btc:null,eth:null,asOf:null,fetchedAt:null,...copy(options.marks||{})};
  class Clock extends Date{constructor(...args){super(...(args.length?args:[time]));}static now(){return time;}}
  const add=(list,type,fn)=>{(list[type]||(list[type]=new Set())).add(fn);},remove=(list,type,fn)=>list[type]?.delete(fn);
  const document={hidden:false,addEventListener:(t,f)=>add(docEvents,t,f),removeEventListener:(t,f)=>remove(docEvents,t,f)};
  let fetchImpl=async url=>({ok:true,json:async()=>url.includes('coinbase')?{data:{amount:url.includes('BTC')?'100000':'4000'}}:{c:50,t:Math.floor((time-60000)/1000)}});
  const CloudModel={source:options.source===null?null:{companies:(options.tickers||['IREN','CRWV','NBIS']).map(tk=>({tk}))},
    get marks(){return copy(saved);},
    setMarks(m){updates.push(copy(m));for(const k of ['prices','priceDates','priceFetchedAt','priceSources','cryptoDates'])saved[k]={...saved[k],...(m[k]||{})};for(const k of ['btc','eth','asOf','fetchedAt'])if(k in m)saved[k]=m[k];}};
  const context=vm.createContext({console,Date:Clock,Promise,AbortController,document,CloudModel,FINNHUB_TOKEN:options.token===undefined?'synthetic-test-token':options.token,
    CVApp:{refresh(){repaints++;paintStates.push(copy(context.Quotes.getState()));}},localStorage:{getItem(k){if(options.storageThrows)throw Error('storage disabled');return storage.get(k)||null;},setItem(k,v){if(options.storageThrows)throw Error('quota');storage.set(k,v);}},
    addEventListener:(t,f)=>add(events,t,f),removeEventListener:(t,f)=>remove(events,t,f),
    setInterval(fn,delay){const id=++seq;timers.set(id,{fn,delay,next:time+delay,repeat:true});return id;},clearInterval:id=>timers.delete(id),
    setTimeout(fn,delay){const id=++seq;timers.set(id,{fn,delay,next:time+delay,repeat:false});return id;},clearTimeout:id=>timers.delete(id),
    fetch(url,options){requests.push(url);return fetchImpl(url,options);}});
  vm.runInContext(source,context,{filename:'quotes.js'});
  return {context,requests,updates,storage,timers,paintStates,get marks(){return copy(saved);},get repaints(){return repaints;},
    now:()=>time,setTime:t=>{time=t;},fetch:fn=>{fetchImpl=fn;},
    event:(type)=>{for(const fn of events[type]||[])fn();},visibility:hidden=>{document.hidden=hidden;for(const fn of docEvents.visibilitychange||[])fn();},
    advance(ms){const end=time+ms;for(;;){const due=[...timers].filter(([,t])=>t.next<=end).sort((a,b)=>a[1].next-b[1].next)[0];if(!due)break;const[id,t]=due;time=t.next;if(t.repeat)t.next+=t.delay;else timers.delete(id);t.fn();}time=end;},
    setSource:tickers=>{CloudModel.source={companies:tickers.map(tk=>({tk}))};}};
}
let count=0;
async function check(name,fn){await fn();count++;console.log('PASS '+name);}
(async()=>{
  await check('Initial subscriptions are immediate; successful marks retain provider and receipt clocks separately',async()=>{
    const h=harness(),seen=[];h.context.Quotes.subscribe(s=>seen.push(s));assert.equal(seen[0].phase,'idle');
    await h.context.Quotes.start();
    assert.equal(h.marks.priceDates.IREN,'2026-09-15T13:59:00.000Z');assert.equal(h.marks.priceFetchedAt.IREN,'2026-09-15T14:00:00.000Z');
    assert.equal(h.marks.priceSources.IREN,'Finnhub');assert.equal(h.marks.cryptoDates.btc,h.marks.fetchedAt);
    assert.equal(h.context.Quotes.status.cryptoClock,'receipt');assert.ok(seen.some(s=>s.phase==='ready'));
    assert.equal(h.requests.length,5);assert.ok(!h.storage.get(KEY).includes('synthetic-test-token'));
    h.context.Quotes.stop();assert.equal(h.timers.size,0);
  });
  await check('One 30-minute timer survives repeated starts and does not poll early',async()=>{
    const h=harness();await h.context.Quotes.start();await h.context.Quotes.start();
    assert.equal(h.timers.size,1);assert.equal([...h.timers.values()][0].delay,HALF_HOUR);
    h.advance(HALF_HOUR-1);await flush();assert.equal(h.requests.length,5);
    h.advance(1);await flush();assert.equal(h.requests.length,10);assert.equal(h.marks.priceFetchedAt.IREN,'2026-09-15T14:30:00.000Z');
  });
  await check('Concurrent refreshes share one in-flight promise and one request batch',async()=>{
    const h=harness(),gate=deferred();h.fetch(async()=>{await gate.promise;return{ok:true,json:async()=>({c:50,t:Math.floor(INITIAL/1000),data:{amount:'1'}})};});
    const a=h.context.Quotes.refresh(),b=h.context.Quotes.refresh();assert.equal(a,b);await flush();assert.equal(h.requests.length,5);
    gate.resolve();await a;assert.equal(h.context.Quotes.status.refreshing,false);
  });
  await check('Partial failures preserve each failed ticker/asset clock and unknown trade times remain unknown',async()=>{
    const h=harness();await h.context.Quotes.refresh();const before=h.marks;h.setTime(INITIAL+HALF_HOUR);
    h.fetch(async url=>{if(url.includes('IREN'))throw Error('offline');return{ok:!url.includes('ETH'),json:async()=>url.includes('CRWV')?{c:0,t:0}:url.includes('NBIS')?{c:75,t:0}:{data:{amount:'100001'}}};});
    await h.context.Quotes.refresh();
    assert.equal(h.marks.prices.IREN,before.prices.IREN);assert.equal(h.marks.priceDates.IREN,before.priceDates.IREN);assert.equal(h.marks.priceFetchedAt.IREN,before.priceFetchedAt.IREN);
    assert.equal(h.marks.priceDates.CRWV,before.priceDates.CRWV);assert.equal(h.marks.cryptoDates.eth,before.cryptoDates.eth);
    assert.equal(h.marks.prices.NBIS,75);assert.equal(h.marks.priceDates.NBIS,null);assert.equal(h.marks.priceFetchedAt.NBIS,'2026-09-15T14:30:00.000Z');
    assert.equal(h.context.Quotes.status.phase,'partial');assert.deepEqual(copy(h.context.Quotes.status.failedTickers),['IREN','CRWV']);
  });
  await check('A failed cycle never refreshes successful or per-ticker timestamps',async()=>{
    const h=harness();await h.context.Quotes.refresh();const before=h.marks,success=h.context.Quotes.status.lastSuccessAt;
    const paints=h.repaints;
    h.setTime(INITIAL+HALF_HOUR);h.fetch(async()=>({ok:false}));await h.context.Quotes.refresh();
    assert.deepEqual(h.marks,before);assert.equal(h.context.Quotes.status.lastSuccessAt,success);assert.equal(h.context.Quotes.status.phase,'error');
    assert.equal(h.context.Quotes.status.lastAttemptAt,'2026-09-15T14:30:00.000Z');
    assert.equal(h.repaints,paints+1,'a fully failed cycle still repaints stale badges');
    assert.equal(h.paintStates.at(-1).phase,'error');assert.equal(h.paintStates.at(-1).refreshing,false);
    assert.deepEqual(h.paintStates.at(-1).failedTickers,['IREN','CRWV','NBIS']);
  });
  await check('Older provider quotes cannot overwrite a newer good quote',async()=>{
    const h=harness();await h.context.Quotes.refresh();const before=h.marks;
    h.setTime(INITIAL+HALF_HOUR);h.fetch(async url=>({ok:true,json:async()=>url.includes('coinbase')?{data:{amount:'1'}}:{c:12,t:Math.floor((INITIAL-3600000)/1000)}}));
    await h.context.Quotes.refresh();assert.deepEqual(h.marks.prices,before.prices);assert.deepEqual(h.marks.priceDates,before.priceDates);assert.deepEqual(h.marks.priceFetchedAt,before.priceFetchedAt);
  });
  await check('Fresh cache hydration immediately publishes dated marks and avoids another network batch',async()=>{
    const a=harness();await a.context.Quotes.refresh();
    const h=harness({time:INITIAL+300000,storage:a.storage}),seen=[];h.context.Quotes.subscribe(s=>seen.push(copy(s)));await h.context.Quotes.start();
    assert.equal(h.requests.length,0);assert.deepEqual(h.marks,a.marks);assert.ok(seen.some(s=>s.phase==='cached'&&s.marks.prices.IREN===50));
    const late=[];h.context.Quotes.subscribe(s=>late.push(s));assert.equal(late[0].marks.priceFetchedAt.IREN,'2026-09-15T14:00:00.000Z');
    h.advance(HALF_HOUR-300000);await flush();assert.equal(h.requests.length,5,'cache reload retains the original 30-minute refresh deadline');
    assert.equal(h.marks.priceFetchedAt.IREN,'2026-09-15T14:30:00.000Z');
  });
  await check('Stale cache is visible immediately while refresh is pending, without relabeling its timestamps',async()=>{
    const a=harness();await a.context.Quotes.refresh();const h=harness({time:INITIAL+HALF_HOUR+1,storage:a.storage}),gate=deferred(),seen=[];
    h.context.Quotes.subscribe(s=>seen.push(copy(s)));h.fetch(async()=>{await gate.promise;return{ok:false};});const task=h.context.Quotes.start();await flush();
    assert.equal(h.requests.length,5);assert.ok(seen.some(s=>s.phase==='cached'));assert.equal(h.marks.priceFetchedAt.IREN,a.marks.priceFetchedAt.IREN);
    gate.resolve();await task;assert.equal(h.context.Quotes.status.phase,'error');assert.deepEqual(h.marks,a.marks);
  });
  await check('Overdue visible/focus wakeups refresh once; hidden or fresh tabs do not',async()=>{
    const h=harness();await h.context.Quotes.start();h.setTime(INITIAL+HALF_HOUR+1000);
    h.visibility(true);h.event('focus');await flush();assert.equal(h.requests.length,5);
    h.visibility(false);h.event('focus');await flush();assert.equal(h.requests.length,10);
    h.event('focus');h.visibility(false);await flush();assert.equal(h.requests.length,10);
  });
  await check('Research fallback quotes work without source data and expand when the company universe loads',async()=>{
    const h=harness({source:null}),gate=deferred();h.fetch(async url=>{await gate.promise;return{ok:true,json:async()=>url.includes('coinbase')?{data:{amount:'1'}}:{c:60,t:Math.floor(INITIAL/1000)}};});
    const first=h.context.Quotes.start();await flush();assert.equal(h.requests.length,5);
    h.setSource(['IREN','CRWV','NBIS','RIOT']);gate.resolve();await first;await flush();await h.context.Quotes.refreshIfDue();
    assert.equal(h.requests.length,11);assert.equal(h.marks.prices.RIOT,60);
  });
  await check('Malformed/disabled storage cannot prevent fetching or destroy usable session marks',async()=>{
    for(const options of [{storage:[[KEY,'{bad json']]},{storageThrows:true}]){
      const h=harness(options);await h.context.Quotes.start();assert.equal(h.marks.prices.IREN,50);assert.equal(h.context.Quotes.status.phase,'ready');
    }
  });
  await check('Cache cannot overwrite newer in-memory observations or accept normalized impossible dates',async()=>{
    const a=harness();await a.context.Quotes.refresh();const cached=JSON.parse(a.storage.get(KEY));
    cached.marks.priceDates.IREN=null;cached.marks.prices.IREN=12;
    const newer=copy(a.marks);newer.prices.IREN=80;newer.priceFetchedAt.IREN='2026-09-15T14:05:00.000Z';
    const h=harness({time:INITIAL+600000,marks:newer,storage:[[KEY,JSON.stringify(cached)]]});await h.context.Quotes.start();
    assert.equal(h.marks.prices.IREN,80);assert.equal(h.marks.priceFetchedAt.IREN,newer.priceFetchedAt.IREN);
    cached.marks.fetchedAt='2026-02-30T14:00:00.000Z';const invalid=harness({storage:[[KEY,JSON.stringify(cached)]]});
    await invalid.context.Quotes.start();assert.equal(invalid.requests.length,5);assert.equal(invalid.context.Quotes.status.fromCache,false);
  });
  await check('Missing credentials do not make network requests',async()=>{
    const h=harness({token:''});await h.context.Quotes.start();assert.equal(h.requests.length,0);assert.equal(h.context.Quotes.status.phase,'unconfigured');
    const a=harness();await a.context.Quotes.refresh();const stale=harness({token:'',time:INITIAL+HALF_HOUR+1,storage:a.storage});
    await stale.context.Quotes.start();assert.equal([...stale.timers.values()][0].delay,HALF_HOUR,'stale cache without credentials must not spin');
  });
  await check('Timeouts release in-flight state so the next refresh can recover',async()=>{
    const h=harness();h.fetch((url,options)=>new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Error('timeout')))));
    const task=h.context.Quotes.refresh();await flush();h.advance(15000);await task;assert.equal(h.context.Quotes.status.phase,'error');assert.equal(h.context.Quotes.status.refreshing,false);
    h.fetch(async()=>({ok:true,json:async()=>({c:80,t:Math.floor(h.now()/1000),data:{amount:'1'}})}));await h.context.Quotes.refresh();assert.equal(h.marks.prices.IREN,80);
  });
  await check('Invalid prices are rejected and future provider clocks are never represented as real trade timestamps',async()=>{
    const h=harness();h.fetch(async url=>({ok:true,json:async()=>url.includes('coinbase')?{data:{amount:'123not-a-price'}}:url.includes('IREN')?{c:Infinity,t:0}:url.includes('CRWV')?{c:-1,t:0}:{c:60,t:Math.floor((INITIAL+86400000)/1000)}}));
    await h.context.Quotes.refresh();assert.equal(h.marks.prices.IREN,undefined);assert.equal(h.marks.prices.CRWV,undefined);assert.equal(h.marks.prices.NBIS,60);assert.equal(h.marks.priceDates.NBIS,null);assert.equal(h.marks.btc,null);
  });
  await check('Subscriber snapshots and unsubscription cannot mutate or disrupt quote state',async()=>{
    const h=harness();let calls=0;const off=h.context.Quotes.subscribe(()=>calls++);assert.equal(calls,1);off();
    h.context.Quotes.subscribe(s=>{s.marks.prices.IREN=-100;});await h.context.Quotes.refresh();assert.equal(calls,1);assert.equal(h.marks.prices.IREN,50);assert.equal(h.context.Quotes.status.marks.prices.IREN,50);
  });
  console.log('PASS: '+count+' quote polling, cache and provider-clock regression groups.');
})().catch(error=>{console.error(error);process.exitCode=1;});
