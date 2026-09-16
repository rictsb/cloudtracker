#!/usr/bin/env node
/* Present-tense economic review. Only the generated review snapshot is written.
 * Analysis is offline; --verify-live is a separate, read-only publication check. */
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');

const MODEL_FILES=Object.freeze(['assumption-core.cjs','assumption-proposals.cjs','model-data.js','engine.js','ramp-core.js','onepager.js','onepager-core.js','export-research.js','checks-core.js']);
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
function stableStringify(value){
  const sort=x=>Array.isArray(x)?x.map(sort):plain(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,sort(x[k])])):x;
  return JSON.stringify(sort(value));
}
const hashJSON=value=>crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
// Report calculations can differ by machine roundoff across Node platforms.
// Only finite numbers get the same 1e-12 relative tolerance as verify.cjs;
// evidence text, types, field sets and array order/length remain exact.
function canonicalJSONEqual(actual,expected){
  if(typeof actual!==typeof expected)return false;
  if(typeof actual==='number')return Number.isFinite(actual)&&Number.isFinite(expected)&&
    Math.abs(actual-expected)<=1e-12*Math.max(Math.abs(actual),Math.abs(expected));
  if(actual===null||expected===null||typeof actual!=='object')return actual===expected;
  if(Array.isArray(actual)!==Array.isArray(expected))return false;
  if(Array.isArray(actual))return actual.length===expected.length&&actual.every((v,i)=>canonicalJSONEqual(v,expected[i]));
  const a=Object.keys(actual).sort(),b=Object.keys(expected).sort();
  return a.length===b.length&&a.every((key,i)=>key===b[i]&&canonicalJSONEqual(actual[key],expected[key]));
}
function modelHash(root=__dirname){
  return hashJSON(Object.fromEntries(MODEL_FILES.map(file=>[file,fs.existsSync(path.join(root,file))?fs.readFileSync(path.join(root,file),'utf8'):null])));
}
function readJSON(file,optional=false){
  if(optional&&!fs.existsSync(file))return null;
  let text;
  try{text=fs.readFileSync(file,'utf8');}catch(_){throw new Error('Cannot read '+path.basename(file));}
  try{return JSON.parse(text);}catch(_){throw new Error('Invalid JSON in '+path.basename(file));}
}
function atomicWrite(file,value){
  const temp=file+'.'+process.pid+'.tmp';
  try{fs.writeFileSync(temp,JSON.stringify(value,null,2)+'\n');fs.renameSync(temp,file);}
  finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
}
function validResult(result){
  return plain(result)&&typeof result.ruleVersion==='string'&&plain(result.summary)&&Array.isArray(result.companies)&&Array.isArray(result.findings)&&
    ['companies','findings','errors','reviews','gaps'].every(k=>Number.isInteger(result.summary[k])&&result.summary[k]>=0)&&
    result.summary.companies===result.companies.length&&result.summary.findings===result.findings.length;
}
function runReview(options={}){
  const root=path.resolve(options.root||__dirname),modelRoot=path.resolve(options.modelRoot||__dirname);
  const output=path.resolve(options.output||path.join(root,'assumption-review.json'));
  if(['data.json','market-prices.json','proposals.json'].some(file=>output===path.join(root,file)))throw new Error('Refusing to overwrite a review input');
  const now=new Date(options.now===undefined?Date.now():options.now).toISOString();
  const asOf=options.asOf||now.slice(0,10);
  let previous=null,data=null,quotes=null,sourceHash=null,quoteHash=null,codeHash=null,snapshot;
  try{previous=readJSON(output,true);}catch(_){} // A broken prior snapshot never prevents a new review.
  try{
    if(!/^\d{4}-\d{2}-\d{2}$/.test(asOf)||new Date(asOf).toISOString().slice(0,10)!==asOf)throw new Error('asOf must be a valid YYYY-MM-DD date');
    codeHash=modelHash(modelRoot);
    data=readJSON(path.join(root,'data.json'));
    if(!plain(data)||!Array.isArray(data.companies))throw new Error('data.json must contain a company universe');
    sourceHash=hashJSON(data);
    quotes=readJSON(path.join(root,'market-prices.json'),true);
    if(quotes!==null&&(!plain(quotes)||!plain(quotes.marks)))throw new Error('market-prices.json must contain a marks object');
    quoteHash=hashJSON(quotes);
    const analyze=options.analyze||require(path.join(modelRoot,'assumption-core.cjs')).analyze;
    const result=analyze(data,quotes?.marks||{},{asOf});
    if(!validResult(result))throw new Error('Economic reviewer returned an incomplete result');
    snapshot={...result,schemaVersion:1,status:'ready',checkedAt:now,attemptedAt:now,lastSuccessAt:now,
      sourceHash,quoteHash,modelHash:codeHash,
      provenance:{
        data:{file:'data.json',hash:sourceHash,asOf:data.asOf||null},
        quotes:{file:'market-prices.json',hash:quoteHash,status:quotes?.status||'unavailable',checkedAt:quotes?.checkedAt||null,
          asOf:quotes?.marks?.asOf||null,failedTickers:quotes?.failedTickers||[],priceCount:Object.keys(quotes?.marks?.prices||{}).length},
        model:{hash:codeHash,files:MODEL_FILES},
        run:{trigger:process.env.GITHUB_EVENT_NAME||'local',commit:process.env.GITHUB_SHA||null}
      },
      cadence:{numerical:'After relevant data, model and shared quote changes; nightly backstop',overdueAfterHours:30,
        evidence:'External evidence research is a separate review; this numerical run does not claim new source verification'}
    };
  }catch(error){
    const message=error instanceof Error?error.message:String(error);
    snapshot={schemaVersion:1,status:'error',checkedAt:null,attemptedAt:now,
      lastSuccessAt:previous?.status==='ready'?previous.checkedAt:previous?.lastSuccessAt||null,
      sourceHash,quoteHash,modelHash:codeHash,asOf:null,ruleVersion:null,
      summary:{companies:0,findings:1,errors:1,reviews:0,gaps:0},companies:[],
      findings:[{id:'system:review-failed',ticker:'SYSTEM',family:'system',severity:'error',title:'Numerical review could not complete',
        explanation:message,calculation:null,evidence:[],impact:null,nextAction:'Repair the failed input or reviewer and run the review again.',
        fingerprint:hashJSON({error:message,sourceHash,quoteHash,modelHash:codeHash})}],
      error:message,policy:{automaticModelChanges:false},
      provenance:{data:{file:'data.json',hash:sourceHash},quotes:{file:'market-prices.json',hash:quoteHash},model:{hash:codeHash,files:MODEL_FILES}},
      cadence:{overdueAfterHours:30,evidence:'No successful numerical or external evidence review is claimed'}
    };
  }
  atomicWrite(output,snapshot);
  return {snapshot,output,exitCode:snapshot.status==='ready'?0:1};
}

async function fetchJSON(url,options={}){
  const controller=new AbortController();let timer;
  const timeout=options.timeoutMs??15000;
  const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('Publication request timed out'));},timeout);});
  try{
    return await Promise.race([deadline,Promise.resolve().then(async()=>{
      const response=await (options.fetch||fetch)(url,{cache:'no-store',signal:controller.signal,headers:{Accept:'application/json'}});
      if(!response?.ok)throw new Error('Published '+new URL(url).pathname+' returned HTTP '+(response?.status||'unavailable'));
      return response.json();
    })]);
  }finally{clearTimeout(timer);}
}
async function verifyLive(url,options={}){
  const root=path.resolve(options.root||__dirname),modelRoot=path.resolve(options.modelRoot||__dirname);
  const expected=options.snapshot||readJSON(path.join(root,'assumption-review.json'));
  if(expected.status!=='ready')throw new Error('Cannot verify a failed numerical review as a successful publication');
  if(expected.modelHash!==modelHash(modelRoot))throw new Error('Local model code changed after the numerical review; regenerate the review before publication verification');
  const base=new URL(url);
  if(!['https:','http:'].includes(base.protocol))throw new Error('Publication URL must use HTTP or HTTPS');
  const get=file=>{const target=new URL(file,base.origin+'/');target.searchParams.set('review',expected.sourceHash.slice(0,16));return fetchJSON(target.href,options);};
  const [live,servedData,servedQuotes]=await Promise.all([get('assumption-review.json'),get('data.json'),get('market-prices.json')]);
  const exactInputs=live.sourceHash===expected.sourceHash&&live.quoteHash===expected.quoteHash;
  // A newer quote/data review can supersede this queued job while Render deploys.
  // Accept it only with this exact model code, a newer successful review clock,
  // and independently matched served inputs and regenerated report payloads.
  const newer=Number.isFinite(Date.parse(live.checkedAt))&&Date.parse(live.checkedAt)>=Date.parse(expected.checkedAt);
  if(live.status!=='ready'||live.modelHash!==expected.modelHash||(!exactInputs&&!newer))
    throw new Error('Published review has not reached the expected data, quote and model version');
  if(hashJSON(servedData)!==live.sourceHash)throw new Error('Published data.json does not match the reviewed inputs');
  if(hashJSON(servedQuotes)!==live.quoteHash)throw new Error('Published market-prices.json does not match the reviewed quotes');
  const generator=options.generator||require(path.join(modelRoot,'export-research.js'));
  const tickers=servedData.companies.filter(c=>c.page&&c.ramp).map(c=>c.tk);
  await Promise.all(tickers.map(async tk=>{
    const served=await get(tk.toLowerCase()+'-data.json');
    const expectedPayload=JSON.parse(JSON.stringify(generator.buildPayload(tk,servedData)));
    if(!canonicalJSONEqual(served,expectedPayload))throw new Error('Published '+tk+' research payload disagrees with the reviewed model');
  }));
  if(servedData.compare){
    const expectedCompare=JSON.parse(JSON.stringify(generator.buildCompare(servedData)));
    if(!canonicalJSONEqual(await get('compare-data.json'),expectedCompare))throw new Error('Published comparison payload disagrees with the reviewed model');
  }
  return {status:'verified',verifiedAt:new Date().toISOString(),reviewCheckedAt:live.checkedAt,
    sourceHash:live.sourceHash,quoteHash:live.quoteHash,modelHash:live.modelHash,researchTickers:tickers};
}
async function main(args){
  const options={},allowed=new Set(['--root','--output','--as-of','--verify-live','--attempts','--interval-ms']);
  for(let i=0;i<args.length;i++){
    if(args[i]==='--help'){console.log('node assumption-review.cjs [--root DIR] [--output FILE] [--as-of YYYY-MM-DD]\nnode assumption-review.cjs --verify-live URL [--root DIR] [--attempts 5] [--interval-ms 20000]');return 0;}
    if(!allowed.has(args[i])||!args[i+1]||args[i+1].startsWith('--'))throw new Error('Unknown or incomplete argument: '+args[i]);
    options[args[i].slice(2)]=args[++i];
  }
  if(options['verify-live']){
    const attempts=Number(options.attempts||1),intervalMs=Number(options['interval-ms']||20000);
    if(!Number.isInteger(attempts)||attempts<1||attempts>15||!Number.isFinite(intervalMs)||intervalMs<0||intervalMs>60000)throw new Error('Invalid publication retry bounds');
    for(let attempt=1;attempt<=attempts;attempt++){
      try{console.log(JSON.stringify(await verifyLive(options['verify-live'],{root:options.root})));return 0;}
      catch(error){if(attempt===attempts)throw error;console.log('Waiting for publication ('+attempt+'/'+attempts+'): '+error.message);await new Promise(resolve=>setTimeout(resolve,intervalMs));}
    }
  }
  const result=runReview({root:options.root,output:options.output,asOf:options['as-of']});
  console.log(JSON.stringify({status:result.snapshot.status,checkedAt:result.snapshot.checkedAt,summary:result.snapshot.summary,error:result.snapshot.error||null}));
  return result.exitCode;
}
module.exports={MODEL_FILES,stableStringify,hashJSON,hashValue:hashJSON,modelHash,runReview,verifyLive,fetchJSON,validResult,canonicalJSONEqual};
if(require.main===module)main(process.argv.slice(2)).then(code=>{process.exitCode=code;}).catch(error=>{console.error(error.message);process.exitCode=1;});
