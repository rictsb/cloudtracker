/* Runner tests use disposable input/output fixtures and mocked publication reads.
 * They never rewrite production inputs or make network requests. */
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {hashJSON,modelHash,runReview,verifyLive,fetchJSON,canonicalJSONEqual}=require('./assumption-review.cjs');
const ROOT=fs.mkdtempSync(path.join(os.tmpdir(),'assumption-review-test-'));
const NOW='2026-09-16T14:00:00.000Z';
const copy=x=>JSON.parse(JSON.stringify(x));
const write=(file,value)=>fs.writeFileSync(path.join(ROOT,file),JSON.stringify(value,null,2)+'\n');
const read=file=>JSON.parse(fs.readFileSync(path.join(ROOT,file),'utf8'));
const data={companies:[{tk:'TEST',name:'Test company',page:{},ramp:{}}],compare:{asOf:'2026-09-16',names:['TEST']}};
const quotes={status:'ready',checkedAt:NOW,marks:{prices:{TEST:15},priceDates:{TEST:NOW},asOf:NOW},failedTickers:[]};
const result={ruleVersion:'test-1',asOf:'2026-09-16',summary:{companies:1,findings:0,errors:0,reviews:0,gaps:0},
  companies:[{ticker:'TEST',tests:{capacity:'consistent',economics:'consistent',funding:'consistent'}}],findings:[],policy:{automaticModelChanges:false}};
const generator={buildPayload:(tk,d)=>({tk,Q:[[2030,d.companies.length*100]],finance:{diluted:42},evidence:{title:'Fixture evidence',url:'https://example.invalid/source'}}),buildCompare:d=>({...d.compare,generatedBy:'fixture'})};
let groups=0;
async function main(){
  assert.equal(hashJSON({b:[{z:2,a:1}],a:3}),hashJSON({a:3,b:[{a:1,z:2}]}));
  assert.notEqual(hashJSON([1,2]),hashJSON([2,1]));
  const code1=modelHash(ROOT);fs.writeFileSync(path.join(ROOT,'engine.js'),'one');const code2=modelHash(ROOT);
  assert.notEqual(code1,code2);fs.writeFileSync(path.join(ROOT,'engine.js'),'two');assert.notEqual(code2,modelHash(ROOT));groups++;

  write('data.json',data);write('market-prices.json',quotes);write('proposals.json',{proposals:[]});
  const beforeInputs=['data.json','market-prices.json','proposals.json'].map(file=>fs.readFileSync(path.join(ROOT,file),'utf8'));
  let captured;
  const good=runReview({root:ROOT,now:NOW,analyze:(d,m,o)=>{captured={d,m,o};return copy(result);}});
  assert.equal(good.exitCode,0);assert.equal(good.snapshot.checkedAt,NOW);assert.equal(good.snapshot.sourceHash,hashJSON(data));
  assert.equal(good.snapshot.quoteHash,hashJSON(quotes));assert.deepEqual(captured,{d:data,m:quotes.marks,o:{asOf:'2026-09-16'}});
  assert.deepEqual(beforeInputs,['data.json','market-prices.json','proposals.json'].map(file=>fs.readFileSync(path.join(ROOT,file),'utf8')));
  assert.deepEqual(read('assumption-review.json'),good.snapshot);groups++;

  const failed=runReview({root:ROOT,now:'2026-09-16T15:00:00Z',analyze:()=>{throw new Error('deliberate analyzer failure');}});
  assert.equal(failed.exitCode,1);assert.equal(failed.snapshot.status,'error');assert.equal(failed.snapshot.checkedAt,null);
  assert.equal(failed.snapshot.lastSuccessAt,NOW);assert.equal(failed.snapshot.attemptedAt,'2026-09-16T15:00:00.000Z');
  assert.deepEqual(failed.snapshot.companies,[]);assert.equal(failed.snapshot.summary.errors,1);
  assert.equal(runReview({root:ROOT,now:'2026-09-16T16:00:00Z',analyze:()=>null}).snapshot.lastSuccessAt,NOW);groups++;

  fs.writeFileSync(path.join(ROOT,'data.json'),'{"broken":');
  const badData=runReview({root:ROOT,now:NOW,analyze:()=>{throw new Error('must not be called');}});
  assert.equal(badData.exitCode,1);assert.equal(badData.snapshot.error,'Invalid JSON in data.json');
  assert.equal(badData.snapshot.sourceHash,null);write('data.json',data);
  fs.writeFileSync(path.join(ROOT,'market-prices.json'),'{');
  assert.equal(runReview({root:ROOT,now:NOW,analyze:()=>copy(result)}).snapshot.error,'Invalid JSON in market-prices.json');
  fs.unlinkSync(path.join(ROOT,'market-prices.json'));
  const missingQuotes=runReview({root:ROOT,now:NOW,analyze:(d,m)=>{assert.deepEqual(m,{});return copy(result);}});
  assert.equal(missingQuotes.snapshot.provenance.quotes.status,'unavailable');assert.equal(missingQuotes.snapshot.quoteHash,hashJSON(null));
  assert.throws(()=>runReview({root:ROOT,output:path.join(ROOT,'data.json'),now:NOW}),/Refusing/);groups++;

  write('market-prices.json',quotes);
  const incomplete=runReview({root:ROOT,now:NOW,analyze:()=>({...result,companies:[]})});
  assert.equal(incomplete.exitCode,1);assert.match(incomplete.snapshot.error,/incomplete result/);
  write('assumption-review.json',good.snapshot);
  const fixtures={'assumption-review.json':good.snapshot,'data.json':data,'market-prices.json':quotes,
    'test-data.json':generator.buildPayload('TEST',data),'compare-data.json':generator.buildCompare(data)};
  const fetchFixture=async url=>{const key=new URL(url).pathname.slice(1);return {ok:key in fixtures,status:key in fixtures?200:404,json:async()=>copy(fixtures[key])};};
  const verified=await verifyLive('https://example.invalid/research/assumptions',{root:ROOT,fetch:fetchFixture,generator});
  assert.equal(verified.status,'verified');assert.deepEqual(verified.researchTickers,['TEST']);groups++;

  fixtures['test-data.json'].finance.diluted=42+4.2e-13;
  assert.equal((await verifyLive('https://example.invalid',{root:ROOT,fetch:fetchFixture,generator})).status,'verified');
  fixtures['test-data.json'].evidence.title='Different evidence';
  await assert.rejects(verifyLive('https://example.invalid',{root:ROOT,fetch:fetchFixture,generator}),/TEST research payload disagrees/);
  fixtures['test-data.json']=generator.buildPayload('TEST',data);
  const canonical={value:122.93886466253484,zero:0,evidence:'disclosed',rows:[1,2],nullable:null};
  assert.equal(canonicalJSONEqual({...canonical,value:122.93886466253483},canonical),true);
  for(const changed of [{...canonical,value:122.939},{...canonical,zero:1e-16},{...canonical,value:'122.93886466253484'},
    {...canonical,evidence:'inferred'},{...canonical,extra:true},{...canonical,rows:[2,1]},{...canonical,rows:[1]},
    {...canonical,nullable:0},{...canonical,value:Infinity}])assert.equal(canonicalJSONEqual(changed,canonical),false);
  const missing=copy(canonical);delete missing.nullable;assert.equal(canonicalJSONEqual(missing,canonical),false);groups++;

  fixtures['data.json']={...data,unreviewed:true};
  await assert.rejects(verifyLive('https://example.invalid',{root:ROOT,fetch:fetchFixture,generator}),/data.json does not match/);
  fixtures['data.json']=data;fixtures['market-prices.json']={...quotes,checkedAt:'2026-09-16T15:00:00Z'};
  await assert.rejects(verifyLive('https://example.invalid',{root:ROOT,fetch:fetchFixture,generator}),/market-prices.json does not match/);
  fixtures['market-prices.json']=quotes;fixtures['test-data.json']={...fixtures['test-data.json'],finance:{diluted:41}};
  await assert.rejects(verifyLive('https://example.invalid',{root:ROOT,fetch:fetchFixture,generator}),/TEST research payload disagrees/);
  fixtures['test-data.json']=generator.buildPayload('TEST',data);fixtures['assumption-review.json']={...good.snapshot,modelHash:'old'};
  await assert.rejects(verifyLive('https://example.invalid',{root:ROOT,fetch:fetchFixture,generator}),/expected data, quote and model version/);
  fixtures['assumption-review.json']=good.snapshot;fixtures['compare-data.json']={names:[]};
  await assert.rejects(verifyLive('https://example.invalid',{root:ROOT,fetch:fetchFixture,generator}),/comparison payload disagrees/);groups++;

  fixtures['compare-data.json']=generator.buildCompare(data);
  const newerQuotes={...quotes,checkedAt:'2026-09-16T15:00:00Z'};
  fixtures['market-prices.json']=newerQuotes;
  fixtures['assumption-review.json']={...good.snapshot,checkedAt:'2026-09-16T15:01:00Z',quoteHash:hashJSON(newerQuotes)};
  const newerVerified=await verifyLive('https://example.invalid',{root:ROOT,fetch:fetchFixture,generator});
  assert.equal(newerVerified.quoteHash,hashJSON(newerQuotes));
  fixtures['assumption-review.json'].checkedAt='2026-09-16T13:59:00Z';
  await assert.rejects(verifyLive('https://example.invalid',{root:ROOT,fetch:fetchFixture,generator}),/expected data, quote and model version/);groups++;

  await assert.rejects(fetchJSON('https://example.invalid/data.json',{fetch:()=>new Promise(()=>{}),timeoutMs:5}),/timed out/);
  await assert.rejects(fetchJSON('https://example.invalid/data.json',{fetch:async()=>({ok:false,status:503})}),/HTTP 503/);
  await assert.rejects(verifyLive('https://example.invalid',{root:ROOT,snapshot:failed.snapshot,fetch:fetchFixture,generator}),/failed numerical review/);groups++;
  console.log('Assumption runner: '+groups+' groups passed (offline, production inputs unchanged).');
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>fs.rmSync(ROOT,{recursive:true,force:true}));
