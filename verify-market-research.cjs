/* Offline integration tests for shared research values and independent quote clocks.
   Fixtures are the actual generated reports; no provider request or credential is used. */
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ROOT=__dirname,TICKERS=['IREN','CRWV','NBIS'];
const read=name=>JSON.parse(fs.readFileSync(path.join(ROOT,name),'utf8'));
const copy=x=>JSON.parse(JSON.stringify(x));
const close=(actual,expected,label)=>assert.ok(Math.abs(actual-expected)<=1e-10*Math.max(1,Math.abs(expected)),`${label}: ${actual} != ${expected}`);
const settled=()=>new Promise(resolve=>setImmediate(resolve));
let groups=0;

function harness(overrides={}){
  let now=Date.parse('2026-09-15T20:30:00Z');
  class TestDate extends Date{
    constructor(...args){super(...(args.length?args:[now]));}
    static now(){return now;}
  }
  const counts={},handlers={},listeners={},errors=[];
  const context=vm.createContext({console:{...console,error:e=>errors.push(e)},Date:TestDate,URLSearchParams,setTimeout,clearTimeout,AbortController,
    fetch:async url=>{
      const file=String(url).split('/').at(-1);counts[file]=(counts[file]||0)+1;
      if(handlers[file])return handlers[file](counts[file]);
      return {ok:true,status:200,json:async()=>copy(overrides[file]||read(file))};
    }});
  context.window=context;
  context.document={getElementById:()=>null,querySelector:()=>null,querySelectorAll:()=>[],
    addEventListener:(type,fn)=>{(listeners[type]??=[]).push(fn);},removeEventListener:()=>{}};
  context.location={pathname:'/',search:'',hash:''};
  const n=(x,d=0)=>Number(x).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});
  context.UI={
    esc:x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),n,
    money:x=>'$'+n(x,2),big:x=>Math.abs(x)>=1000?'$'+n(x/1000,1)+'bn':'$'+n(x,0)+'m',
    pct:(x,d=0,sign=false)=>(sign&&x>0?'+':'')+n(x*100,d)+'%',
    date:x=>x?String(x):'Not supplied',icon:()=>'<svg aria-hidden="true"></svg>',
    metric:(l,v,note,cls='')=>`<div class="metric"><div class="metric-label">${l}</div><div class="metric-value ${cls}">${v}</div><div class="metric-note">${note}</div></div>`,
    lineChart:()=>'<svg role="img"></svg>'
  };
  for(const file of ['engine.js','ramp-core.js','onepager-core.js','model-data.js','research-data.js','report-graphics.js','report-layout.js','report-view.js','compare-view.js'])
    vm.runInContext(fs.readFileSync(path.join(ROOT,file),'utf8'),context,{filename:file});
  return {context,counts,handlers,listeners,errors,
    now:()=>new Date(now).toISOString(),advance:ms=>{now+=ms;},
    payload:tk=>context.ResearchData.get(tk),
    summary:tk=>context.ResearchData.summaryCompany(context.CloudModel.company(tk)),
    mark(prices,extra={}){
      const stamp=new Date(now).toISOString();
      return context.CloudModel.setMarks({prices,
        priceDates:Object.fromEntries(Object.keys(prices).map(tk=>[tk,stamp])),
        priceFetchedAt:Object.fromEntries(Object.keys(prices).map(tk=>[tk,stamp])),
        priceSources:Object.fromEntries(Object.keys(prices).map(tk=>[tk,'Test provider'])),
        asOf:stamp,fetchedAt:stamp,...extra});
    },
    async ready(){
      await context.CloudModel.load();
      await Promise.all(TICKERS.map(tk=>context.ResearchData.load(tk)));
      TICKERS.forEach(tk=>context.ReportView.render(tk,new URLSearchParams()));
      context.CompareView.render(new URLSearchParams());
      await settled();await settled();
    }
  };
}
const attr=(html,name)=>{
  const m=new RegExp('\\b'+name+'="([^"]*)"').exec(html);
  assert.ok(m,'missing '+name);return m[1];
};
const report=(h,tk,query='')=>h.context.ReportView.render(tk,new URLSearchParams(query));
function tile(html,tk){
  const m=new RegExp('<a\\b[^>]*href="/'+tk.toLowerCase()+'"[^>]*data-reference-price="[^"]*"[^>]*>[\\s\\S]*?</a>').exec(html);
  assert.ok(m,tk+' comparison price tile missing');return m[0];
}
function parity(h,tk,status){
  const {context:c}=h,ref=c.ResearchData.reference(tk),summary=h.summary(tk),html=report(h,tk);
  const comparison=tile(c.CompareView.render(new URLSearchParams()),tk);
  assert.equal(summary.price,ref.value,tk+' summary reference differs');
  assert.equal(summary.priceReference.status,status,tk+' summary quote status');
  for(const [name,markup] of [['report',html],['comparison',comparison]]){
    assert.equal(attr(markup,'data-reference-price'),ref.value==null?'':String(ref.value),tk+' '+name+' reference');
    assert.equal(attr(markup,'data-price-state'),status,tk+' '+name+' quote status');
    assert.equal(attr(markup,'data-price-as-of'),ref.asOf||'',tk+' '+name+' provider clock');
  }
  close(summary.target,c.OnePager.waterfall(h.payload(tk).L,h.payload(tk).CAPQ,h.payload(tk).finance,h.payload(tk).ARRC).ps,tk+' canonical research summary');
  assert.equal(attr(html,'data-base-value'),summary.target.toFixed(2),tk+' report vs summary base');
  if(Number.isFinite(ref.value)&&ref.value>0){
    close(summary.upside,summary.target/summary.price-1,tk+' current reference upside');
    assert.ok(comparison.includes('$'+ref.value.toFixed(2)+' reference'),tk+' displayed comparison reference');
    assert.ok(comparison.includes((summary.target/ref.value).toFixed(1)+'×'),tk+' displayed comparison value ratio');
  }else assert.equal(summary.upside,null,tk+' unavailable price cannot imply upside');
  assert.ok(comparison.includes('$'+Math.round(summary.target).toLocaleString('en-US')),tk+' comparison base changed');
  return html;
}

(async()=>{
  // Concurrent router, comparison and summary requests must share one actual load.
  {
    const h=harness(),c=h.context;await c.CloudModel.load();
    let resolve;
    h.handlers['iren-data.json']=()=>new Promise(r=>{resolve=r;});
    const a=c.ResearchData.load('IREN'),b=c.ResearchData.load('IREN');
    assert.strictEqual(a,b,'concurrent loads must share their pending promise');
    assert.equal(h.counts['iren-data.json'],1);
    c.ReportView.render('IREN',new URLSearchParams());c.CompareView.render(new URLSearchParams());
    await settled();assert.equal(h.counts['iren-data.json'],1,'view load duplicated pending fetch');
    resolve({ok:true,status:200,json:async()=>read('iren-data.json')});await a;await settled();
    assert.strictEqual(await c.ResearchData.load('IREN'),h.payload('IREN'));
    assert.equal(h.counts['iren-data.json'],1,'cached load fetched again');
    assert.equal(c.ResearchData.status('IREN').loaded,true);
    assert.equal(c.ResearchData.status('IREN').error,null);
    await assert.rejects(c.ResearchData.load('NOTREAL'),/No preferred research model/);
    assert.equal(h.counts['notreal-data.json'],undefined);
    groups++;
  }
  // A missing preferred report never silently presents the separate asset value.
  {
    const h=harness(),c=h.context;await c.CloudModel.load();
    const asset=c.CloudModel.company('IREN').target;
    assert.ok(asset>0);assert.equal(h.summary('IREN').target,null);
    assert.equal(h.summary('IREN').researchStatus,'loading');
    h.handlers['iren-data.json']=async()=>({ok:false,status:503});
    await assert.rejects(c.ResearchData.load('IREN'),/HTTP 503/);
    const failed=h.summary('IREN');
    assert.equal(failed.target,null);assert.equal(failed.floor,null);assert.equal(failed.upside,null);
    assert.equal(failed.researchStatus,'unavailable');assert.match(failed.researchError,/503/);
    assert.equal(c.ResearchData.get('IREN'),null);assert.equal(c.ResearchData.value('IREN'),null);
    delete h.handlers['iren-data.json'];await c.ResearchData.load('IREN');
    assert.equal(h.counts['iren-data.json'],2);assert.equal(h.summary('IREN').researchStatus,'ready');
    assert.notEqual(h.summary('IREN').target,asset,'research value must replace asset target');
    const normal=c.CloudModel.current.companies.find(x=>!TICKERS.includes(x.ticker));
    assert.equal(c.ResearchData.summaryCompany(normal).target,normal.target);
    assert.equal(c.ResearchData.summaryCompany(normal).summaryBasis,'Asset model');
    groups++;
  }
  // Wrong ticker/incomplete payloads and a rejected network request are retryable.
  for(const failure of ['wrong ticker','incomplete','network']){
    const h=harness(),c=h.context;await c.CloudModel.load();
    h.handlers['crwv-data.json']=async()=>{
      if(failure==='network')throw new Error('Network unavailable');
      const P=read('crwv-data.json');if(failure==='wrong ticker')P.tk='IREN';else delete P.CAPQ;
      return {ok:true,status:200,json:async()=>P};
    };
    await assert.rejects(c.ResearchData.load('CRWV'),failure==='network'?/Network unavailable/:/incomplete/);
    assert.equal(h.summary('CRWV').target,null);
    assert.equal(c.ResearchData.status('CRWV').loaded,false);
    delete h.handlers['crwv-data.json'];await c.ResearchData.load('CRWV');
    assert.equal(h.counts['crwv-data.json'],2);assert.equal(c.ResearchData.status('CRWV').error,null);
    groups++;
  }
  const h=harness(),c=h.context;await h.ready();
  const canonical=Object.fromEntries(TICKERS.map(tk=>[tk,JSON.stringify(h.payload(tk))]));
  const values=Object.fromEntries(TICKERS.map(tk=>[tk,c.ResearchData.value(tk)]));
  const nonPriceScenarios=Object.fromEntries(TICKERS.map(tk=>[tk,attr(report(h,tk,'scenario=rate8'),'data-scenario-value')]));
  for(const tk of TICKERS){
    parity(h,tk,'snapshot');assert.equal(h.counts[tk.toLowerCase()+'-data.json'],1);
    assert.equal(h.summary(tk).summaryBasis,'Research DCF');
    assert.equal(h.summary(tk).summaryHref,'/'+tk.toLowerCase());
    assert.equal(h.summary(tk).modelAsOf,h.payload(tk).modelAsOf||h.payload(tk).pricing?.asOf||h.payload(tk).asOf);
    assert.equal(h.summary(tk).floor,null);
    assert.match(c.ResearchData.reference(tk).label,/Saved reference.*market refresh unavailable/);
  }
  groups++;
  // All three views receive the same marks and provider clocks on every rerender.
  const prices={IREN:57.25,CRWV:123.75,NBIS:98.5};h.mark(prices);
  for(const tk of TICKERS){
    const html=parity(h,tk,'market'),P=h.payload(tk),display=c.ResearchData.displayPayload(tk);
    assert.notStrictEqual(display,P);assert.notStrictEqual(display.px,P.px);
    assert.equal(display.px.v,prices[tk]);assert.equal(display.px.asOf,h.now());
    assert.match(html,/Test provider/);
    const expected=c.OnePager.waterfall(P.L,P.CAPQ,P.finance,P.ARRC,{eqPx:prices[tk]});
    assert.equal(attr(report(h,tk,'scenario=equityPrice'),'data-scenario-value'),expected.ps.toFixed(2),tk+' price-linked scenario stale');
    assert.equal(attr(report(h,tk,'scenario=rate8'),'data-scenario-value'),nonPriceScenarios[tk],tk+' unrelated sensitivity moved');
  }
  groups++;
  // Asset-model dials and equity-funding marks cannot reset the preferred DCF values.
  const assetBefore=c.CloudModel.company('IREN').target;
  c.CloudModel.recalculate({disc:11});
  assert.notEqual(c.CloudModel.company('IREN').target,assetBefore,'dial fixture must actually change asset model');
  for(const tk of TICKERS){parity(h,tk,'market');assert.equal(c.ResearchData.value(tk),values[tk]);}
  c.CloudModel.reset();
  for(const tk of TICKERS){parity(h,tk,'market');assert.equal(c.ResearchData.value(tk),values[tk]);}
  groups++;
  // A success for IREN must not refresh CRWV/NBIS clocks after their quote failures.
  const staleClock=h.now();h.advance(36*60000);h.mark({IREN:58.5});
  parity(h,'IREN','market');parity(h,'CRWV','cached');parity(h,'NBIS','cached');
  assert.equal(c.CloudModel.marks.priceFetchedAt.CRWV,staleClock);
  assert.equal(c.CloudModel.marks.priceDates.CRWV,staleClock);
  assert.equal(c.CloudModel.company('CRWV').priceAsOf,staleClock);
  assert.equal(c.CloudModel.company('CRWV').priceFetchedAt,staleClock);
  assert.match(c.ResearchData.reference('CRWV').label,/^Cached Test provider/);
  c.CloudModel.setMarks({prices:{},asOf:h.now(),fetchedAt:h.now()});
  parity(h,'CRWV','cached');assert.equal(c.CloudModel.marks.priceFetchedAt.CRWV,staleClock);
  groups++;
  // Unknown/future provider clocks cannot be labelled fresh just because polling ran.
  h.mark({IREN:59},{priceDates:{IREN:null}});
  parity(h,'IREN','cached');assert.equal(c.ResearchData.reference('IREN').asOf,null);
  assert.match(c.ResearchData.reference('IREN').label,/quote time unavailable/);
  const future=new Date(Date.parse(h.now())+6*60000).toISOString();
  h.mark({IREN:60},{priceDates:{IREN:future}});
  parity(h,'IREN','cached');assert.equal(c.ResearchData.reference('IREN').asOf,null);
  h.mark({IREN:61},{priceFetchedAt:{IREN:future}});parity(h,'IREN','cached');
  h.mark({IREN:62},{priceFetchedAt:{IREN:null}});parity(h,'IREN','cached');
  groups++;
  // Quote-only metadata cannot freshen any retained symbol; invalid marks cleanly degrade.
  const before=c.CloudModel.marks.priceDates.NBIS;
  c.CloudModel.setMarks({prices:{},priceDates:{NBIS:h.now()},priceFetchedAt:{NBIS:h.now()},fetchedAt:h.now()});
  assert.equal(c.CloudModel.marks.priceDates.NBIS,before);parity(h,'NBIS','cached');
  c.CloudModel.setMarks({prices:{IREN:0,CRWV:NaN,NBIS:'99'}});
  for(const tk of TICKERS){
    parity(h,tk,'snapshot');assert.equal(c.CloudModel.marks.prices[tk],undefined);
    assert.equal(c.CloudModel.marks.priceDates[tk],undefined);
    assert.equal(c.CloudModel.marks.priceFetchedAt[tk],undefined);
    assert.equal(c.CloudModel.marks.priceSources[tk],undefined);
  }
  c.CloudModel.clearMarks();
  for(const tk of TICKERS){
    parity(h,tk,'snapshot');assert.equal(JSON.stringify(h.payload(tk)),canonical[tk],tk+' canonical payload mutated');
    assert.equal(c.ResearchData.value(tk),values[tk]);assert.equal(h.counts[tk.toLowerCase()+'-data.json'],1);
  }
  assert.deepEqual(h.errors,[],'render failures must not be hidden by fallback markup');
  groups++;
  // A failed refresh or restored browser cache is stale immediately, even with a recent receipt.
  {
    const quotes=harness(),q=quotes.context;await quotes.ready();quotes.mark(prices);
    const providerDate=quotes.now();
    q.Quotes={status:{failedTickers:['CRWV'],fromCache:false}};
    parity(quotes,'IREN','market');parity(quotes,'NBIS','market');
    const failed=parity(quotes,'CRWV','cached');
    assert.match(q.ResearchData.reference('CRWV').label,/refresh failed/i);
    assert.match(failed,/refresh failed/i);
    assert.equal(q.ResearchData.reference('CRWV').asOf,providerDate);
    assert.equal(q.ResearchData.reference('CRWV').fetchedAt,providerDate);
    q.Quotes.status={failedTickers:[],fromCache:true};
    for(const tk of TICKERS){
      parity(quotes,tk,'cached');
      assert.equal(q.ResearchData.reference(tk).asOf,providerDate,tk+' cache restore changed provider date');
      assert.equal(q.ResearchData.reference(tk).fetchedAt,providerDate,tk+' cache restore changed receipt date');
    }
    q.Quotes.status={failedTickers:[],fromCache:false};
    for(const tk of TICKERS)parity(quotes,tk,'market');
    quotes.advance(30*60000+1);
    for(const tk of TICKERS){
      parity(quotes,tk,'cached');assert.equal(q.ResearchData.reference(tk).asOf,providerDate);
    }
    assert.deepEqual(quotes.errors,[],'quote expiry must not break report/comparison rendering');
    groups++;
  }
  // Truly missing prices must not become $0, an invented gain, or a usable equity sensitivity.
  {
    const data=read('data.json'),P=read('iren-data.json'),source=data.companies.find(x=>x.tk==='IREN');
    source.price=null;source.page.px.v=null;P.px.v=null;
    const missing=harness({'data.json':data,'iren-data.json':P});await missing.ready();
    const html=parity(missing,'IREN','unavailable');
    assert.equal(missing.context.ResearchData.reference('IREN').value,null);
    const selected=report(missing,'IREN','scenario=equityPrice');
    assert.match(selected,/price-linked sensitivity is unavailable/);
    assert.equal(attr(selected,'data-scenario-value'),missing.context.ResearchData.value('IREN').toFixed(2));
    assert.equal((html.match(/data-report-scenario-link=/g)||[]).length,8);
    assert.ok(!/NaN|Infinity/.test(selected));assert.deepEqual(missing.errors,[]);
    groups++;
  }
  // The report's actual Retry control recovers a failed shared load, not just the cache API.
  {
    const retry=harness(),r=retry.context;await r.CloudModel.load();
    retry.handlers['nbis-data.json']=async()=>({ok:false,status:503});
    report(retry,'NBIS');await settled();
    assert.match(report(retry,'NBIS'),/data-report-retry="NBIS"/);
    delete retry.handlers['nbis-data.json'];
    const event={target:{closest:selector=>selector==='[data-report-retry]'?{getAttribute:()=> 'NBIS'}:null}};
    retry.listeners.click.forEach(fn=>fn(event));report(retry,'NBIS');await settled();
    assert.equal(retry.counts['nbis-data.json'],2);
    assert.equal(attr(report(retry,'NBIS'),'data-base-value'),r.ResearchData.value('NBIS').toFixed(2));
    assert.equal(retry.summary('NBIS').researchStatus,'ready');groups++;
  }
  console.log(`PASS ${groups} market/research integration groups: shared loads/retries, no asset fallback, per-symbol clocks, live reference parity, price-linked scenarios and immutable base values.`);
})().catch(error=>{console.error(error);process.exitCode=1;});
