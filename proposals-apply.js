#!/usr/bin/env node
/* Applies owner-ACCEPTED proposals (§6g and Assumption Review). The Action is the
   only writer. Every item is staged and checked independently; an invalid item cannot
   partially change the model or prevent an unrelated valid approval from being saved. */
'use strict';
const fs=require('node:fs'), path=require('node:path');
const ROOT=__dirname;
const copy=x=>JSON.parse(JSON.stringify(x));
const findingID=m=>`${m.group}|${m.tk}|${m.level}|${m.msg}`;
function failures(data){return new Set(require('./checks-core.js').runChecks(data).msgs.filter(m=>m.level==='fail').map(findingID));}
function legacyChange(data,p){
  const c=data.companies.find(x=>x.tk===p.tk);
  if(!c)throw new Error('unknown ticker');
  if(p.kind==='log'){
    c.log=c.log||[]; const e=Object.assign({},p.proposed);
    if(!c.log.some(l=>l.d===e.d&&l.x===e.x))c.log.unshift(e);
    c.log.sort((a,b)=>String(b.d||'').localeCompare(String(a.d||'')));
  }else if(p.kind==='site'){
    const s=(c.sites||[]).find(x=>x.n===p.site);
    if(!s)throw new Error('site not found: '+p.site);
    const stale=Object.entries(p.current||{}).find(([k,val])=>JSON.stringify(s[k])!==JSON.stringify(val));
    if(stale)throw new Error(`stale: expected current ${stale[0]}=${JSON.stringify(stale[1])}, data now has ${JSON.stringify(s[stale[0]])} — rebase against current data`);
    Object.assign(s,p.proposed);
  }else if(p.kind==='catalyst'){
    c.catalysts=c.catalysts||[];
    if(!c.catalysts.includes(p.proposed.text))c.catalysts.unshift(p.proposed.text);
  }else throw new Error('unknown kind '+p.kind);
}
function buildResearchPayloads(data){
  const {buildPayload,buildCompare}=require('./export-research.js'), {waterfall}=require('./onepager-core.js');
  const result={};
  for(const c of data.companies.filter(c=>c.page&&c.ramp)){
    const payload=buildPayload(c.tk,data), w=waterfall(payload.L,payload.CAPQ,payload.finance,payload.ARRC);
    if(![w.ps,w.ev,w.dil,w.last.nd].every(Number.isFinite)||w.dil<=0)throw new Error(c.tk+': invalid regenerated research waterfall');
    result[c.tk.toLowerCase()+'-data.json']=payload;
  }
  result['compare-data.json']=buildCompare(data);
  return result;
}
function processQueue(queue,data,options={}){
  const P=copy(queue), baseline=copy(data), root=options.root||ROOT, today=options.today||new Date().toISOString().slice(0,10);
  let D=copy(data), payloads=null; const lines=[],errors=[];
  const todo=(P.items||[]).filter(p=>p.status==='accepted'&&!p.applied);
  for(const p of todo){
    try{
      let candidate=copy(D), generated=null;
      if(p.kind==='assumption'){
        const A=require('./assumption-proposals.cjs');
        // All items bind to the same pre-batch source. Before each write the preview is
        // reproduced on the accumulated candidate too, blocking interacting changes.
        A.validateProposal(p,{data:baseline,marks:options.marks,root});
        candidate=A.applyChanges(D,p.changes);
        A.assertMatchingImpact(p.review.impact,A.evaluateImpact(D,candidate,p.changes,p.review.quoteBasis));
        A.noNewFailures(D,candidate);
        generated=buildResearchPayloads(candidate);
      }else legacyChange(candidate,p);
      const before=failures(D), introduced=[...failures(candidate)].filter(id=>!before.has(id));
      if(introduced.length)throw new Error(`would introduce ${introduced.length} new check failure(s): ${introduced.slice(0,3).join('; ')}`);
      if(!generated&&payloads)generated=buildResearchPayloads(candidate);
      D=candidate;
      if(generated)payloads=generated;
      p.applied=today; delete p.error;
      if(p.kind==='assumption')p.validation={sourceHash:require('./assumption-review.cjs').hashJSON(D),modelHash:p.review.modelHash,checkedAt:options.now||new Date().toISOString(),publishedVerified:false};
      lines.push(`- ${p.tk}: ${p.title} — approved on the Approvals screen ${p.decided||today}, applied ${today} (proposal ${p.id}; source ${p.sourceName||'McNallie Money (YouTube)'}${p.evidence?.[0]?', '+p.evidence[0].url:''}).`);
    }catch(e){p.status='error';p.error='not applied: '+e.message;delete p.applied;errors.push({id:p.id,error:p.error});}
  }
  return {data:D,queue:P,payloads,lines,errors,attempted:todo.length};
}
module.exports={processQueue,buildResearchPayloads};
if(require.main===module){
  try{
    const read=name=>JSON.parse(fs.readFileSync(path.join(ROOT,name),'utf8'));
    const out=processQueue(read('proposals.json'),read('data.json'),{marks:read('market-prices.json')});
    if(!out.attempted){console.log('no accepted proposals to apply');process.exitCode=0;}
    else{
      const staged={'proposals.json':JSON.stringify(out.queue,null,1)+'\n'};
      if(out.lines.length){
        staged['data.json']=JSON.stringify(out.data,null,1)+'\n';
        for(const [name,payload] of Object.entries(out.payloads||{}))staged[name]=JSON.stringify(payload,null,2)+'\n';
        const cl=fs.readFileSync(path.join(ROOT,'CHANGELOG.md'),'utf8').split('\n'),at=cl.findIndex(l=>l.startsWith('- '));
        cl.splice(at<0?cl.length:at,0,...out.lines);staged['CHANGELOG.md']=cl.join('\n');
      }
      // Files are committed together only after the Action's validation gates pass.
      for(const [name,content] of Object.entries(staged))fs.writeFileSync(path.join(ROOT,name),content);
      console.log(`applied ${out.lines.length} proposal(s); ${out.errors.length} blocked`);
      for(const e of out.errors)console.log(e.id+': '+e.error);
      // Handled rejections are saved to the queue. A nonzero exit before git commit would
      // strand the error status and repeatedly retry the same approval on every run.
    }
  }catch(e){console.error(e.stack||e.message);process.exitCode=1;}
}
