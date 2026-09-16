#!/usr/bin/env node
/* Offline approval safety and canonical impact regression checks; never changes the live queue. */
'use strict';
const assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path');
const A=require('./assumption-proposals.cjs'), C=require('./approvals-core.js'), W=require('./proposals-apply.js'), H=require('./assumption-review.cjs');
const root=__dirname, read=f=>JSON.parse(fs.readFileSync(path.join(root,f),'utf8')), data=read('data.json'), marks=read('market-prices.json');
const clone=x=>JSON.parse(JSON.stringify(x));
const opts={data,marks,root,today:'2026-09-16'};
const testRetention=data.researchPricing.renewal.retention>0 ? data.researchPricing.renewal.retention*0.9 : 0.1;
const input={title:'Test renewal retention sensitivity',basis:'Offline fixture: test a lower same-hardware renewal retention assumption; this is not a recommendation.',
  changes:[{scope:'global',path:['researchPricing','renewal','retention'],current:data.researchPricing.renewal.retention,proposed:testRetention,unit:'fraction'}],
  evidence:[{url:'https://example.com/fixture',sourceName:'Offline fixture only',date:'2026-09-16'}]};
let groups=0;
const group=(name,fn)=>{fn();groups++;console.log('PASS '+name);};
const reject=(p,pattern)=>assert.throws(()=>A.draftProposal(p,opts),pattern);
let proposal;
group('canonical preview is immutable and covers the shared research universe',()=>{
  const before=JSON.stringify(data);proposal=A.draftProposal(input,opts);
  assert.equal(JSON.stringify(data),before);assert.equal(proposal.status,'pending');assert.equal(proposal.tk,'ALL');
  assert.deepEqual(proposal.review.impact.map(r=>r.ticker),['CRWV','IREN','NBIS']);
  for(const row of proposal.review.impact){const c=data.companies.find(c=>c.tk===row.ticker);assert.equal(row.quoteBasis.financingPriceBase,c.page.finance.EQ_PX);assert.ok(Number.isFinite(row.base));assert.ok(row.assetAlternative);}
  assert.doesNotThrow(()=>A.validateProposal(proposal,opts));
});
group('closed paths, explicit units, finite numbers, evidence and no-op guards',()=>{
  const change=(patch)=>({...input,changes:[{...input.changes[0],...patch}]});
  reject(change({path:['researchPricing','softwarePremium']}),/allow-list/);
  reject(change({path:['__proto__','polluted']}),/invalid/);
  reject(change({proposed:Infinity}),/finite/);
  reject(change({proposed:1.1}),/range/);
  reject(change({proposed:input.changes[0].current}),/different/);
  reject(change({unit:'percent'}),/unit/);
  reject({...input,evidence:[]},/evidence/);reject({...input,basis:'because'},/rationale/);
  reject({...input,evidence:[{url:'javascript:alert(1)',sourceName:'Bad'}]},/HTTP/);
  reject({...input,changes:[input.changes[0],input.changes[0]]},/duplicate/);
  reject(change({current:input.changes[0].current+0.01}),/stale/);
});
group('source dates are real and nonfuture; linked finding bundles preserve validated ids',()=>{
  for(const date of ['2026-02-30','2026-09-17','2026-9-16','2026-13-01','',null])reject({...input,evidence:[{...input.evidence[0],date}]},/real calendar date/);
  const linked=A.draftProposal({...input,findingIds:['IREN:economics:same-hardware-renewal','NBIS:economics:same-hardware-renewal']},opts);
  assert.deepEqual(linked.findingIds,['IREN:economics:same-hardware-renewal','NBIS:economics:same-hardware-renewal']);
  assert.doesNotThrow(()=>A.validateProposal(linked,opts));
  for(const findingIds of [[],['duplicate','duplicate'],['__proto__'],[null],'IREN:economics:renewal'])reject({...input,findingIds},/findingIds/);
  reject({...input,findingId:42},/finding id/);
  const changed=clone(linked);changed.findingIds=['CRWV:economics:same-hardware-renewal'];
  assert.notEqual(C.decisionIdentity(changed),C.decisionIdentity(linked));
});
group('source, code, preview and evidence cannot change behind an approval',()=>{
  const newer=clone(data);newer.companies[0].shares+=1;
  assert.throws(()=>A.validateProposal(proposal,{...opts,data:newer}),/source inputs changed/);
  const model=clone(proposal);model.review.modelHash='bad';assert.throws(()=>A.validateProposal(model,opts),/code changed/);
  const impact=clone(proposal);impact.review.impact[0].proposed+=50;impact.review.impactHash=H.hashJSON(impact.review.impact);assert.throws(()=>A.validateProposal(impact,opts),/impact changed/);
  const rationale=clone(proposal);rationale.basis+=' altered';assert.throws(()=>A.validateProposal(rationale,opts),/fingerprint/);
  // Quote drift must be tested on a price-sensitive fixture even if an approved
  // production policy later removes this company's planned equity raise entirely.
  const sensitive=clone(data);sensitive.companies.find(c=>c.tk==='CRWV').plannedRaise=15000;
  const quoted=A.draftProposal(input,{...opts,data:sensitive});
  const m=clone(marks);m.marks.prices.CRWV*=2;assert.throws(()=>A.validateProposal(quoted,{...opts,data:sensitive,marks:m}),/impact changed/);
});
group('finance fields retain known units and enforce dependent debt/share constraints',()=>{
  const c=data.companies.find(c=>c.tk==='CRWV');
  reject({...input,changes:[{scope:'company',ticker:c.tk,path:['page','finance','DEBT0'],current:c.page.finance.DEBT0,proposed:1,unit:'USD billion'}]},/convertible principal/);
  reject({...input,changes:[{scope:'company',ticker:c.tk,path:['page','finance','CONV'],current:c.page.finance.CONV,proposed:1,unit:'USD billion'}]},/allow-list/);
});
group('numerical approval cannot introduce hard economic failures hidden from structural checks',()=>{
  const c=data.companies.find(c=>c.tk==='NBIS');
  // A large share count forces an out-of-money series irrespective of a later
  // legitimate margin change; a fixed 10% margin fixture can stop doing so.
  reject({...input,changes:[{scope:'company',ticker:c.tk,path:['page','finance','SH0'],current:c.page.finance.SH0,proposed:1000000,unit:'million shares'}]},/economic model errors.*unconverted-debt-claim/);
});
group('spot numerical approval validates the actual policy units',()=>{
  const altered=clone(data);altered.researchPricing.spot.basis='per-it-mw-year';
  const rate=altered.researchPricing.spot.rates['2030'];
  assert.throws(()=>A.draftProposal({...input,changes:[{scope:'global',path:['researchPricing','spot','rates','2030'],current:rate,proposed:rate*0.9,unit:'USD\/GPU-hour'}]},{...opts,data:altered}),/different units/);
});
group('decisions are pending-only and bind the exact displayed proposal',()=>{
  const q={asOf:'2026-09-16',seen:['keep-me'],items:[proposal]}, before=JSON.stringify(q);
  const decided=C.buildCommit(q,proposal.id,'accepted','2026-09-16',C.decisionIdentity(proposal));
  assert.equal(JSON.stringify(q),before);assert.equal(decided.mutated.items[0].status,'accepted');assert.deepEqual(decided.mutated.seen,['keep-me']);
  assert.equal(C.b64dec(decided.content),JSON.stringify(decided.mutated,null,1)+'\n');
  assert.throws(()=>C.buildCommit(decided.mutated,proposal.id,'rejected','2026-09-16'),/no longer pending/);
  assert.throws(()=>C.buildCommit(q,proposal.id,'applied','2026-09-16'),/invalid/);
  assert.throws(()=>C.buildCommit(q,proposal.id,'accepted','2026-09-16','changed'),/changed since/);
  assert.throws(()=>A.enqueueProposal(q,proposal),/already exists/);
  assert.throws(()=>A.enqueueProposal({items:[],seen:[proposal.fp]},proposal),/already been reviewed/);
});
group('keep/research triage is bounded, current and preserves the proposal queue',()=>{
  const q={items:[proposal],seen:['fingerprint']}, r={fingerprint:'abcdef123456',status:'kept',reason:'Await primary evidence.',updatedAt:'2026-09-16T12:00:00Z'};
  const out=C.recordReview(q,'CRWV:renewal',r,null);
  assert.deepEqual(out.items,q.items);assert.equal(out.assumptionReviews['CRWV:renewal'].reviewAfter,'2026-10-16');assert.equal(q.assumptionReviews,undefined);
  assert.throws(()=>C.recordReview(q,'CRWV:renewal',{...r,reason:''}),/rationale/);
  assert.throws(()=>C.recordReview(q,'CRWV:renewal',{...r,reviewAfter:'2027-09-16'}),/90 days/);
  assert.throws(()=>C.recordReview(out,'CRWV:renewal',r,null),/decision changed/);
  assert.throws(()=>C.recordReview(q,'__proto__',r),/invalid/);
});
group('worker only applies accepted numerical bundles and regenerates canonical payloads',()=>{
  const q={items:[proposal]}, untouched=W.processQueue(q,data,{marks,root,today:'2026-09-16'});assert.equal(untouched.attempted,0);assert.deepEqual(untouched.data,data);
  const accepted=clone(proposal);accepted.status='accepted';accepted.decided='2026-09-16';
  const out=W.processQueue({items:[accepted]},data,{marks,root,today:'2026-09-16'});
  assert.deepEqual(out.errors,[]);assert.equal(out.data.researchPricing.renewal.retention,testRetention);assert.equal(out.queue.items[0].applied,'2026-09-16');
  assert.deepEqual(Object.keys(out.payloads).sort(),['compare-data.json','crwv-data.json','iren-data.json','nbis-data.json']);
  assert.equal(out.queue.items[0].validation.publishedVerified,false);assert.equal(data.researchPricing.renewal.retention,input.changes[0].current);
});
group('one failed numerical item cannot mutate data or deadlock unrelated legacy approvals',()=>{
  const bad=clone(proposal);bad.status='accepted';bad.review.sourceHash='stale';
  const legacy={id:'fixture-legacy',kind:'catalyst',tk:'CRWV',title:'Offline fixture',status:'accepted',proposed:{text:'Offline fixture catalyst'}};
  const out=W.processQueue({items:[bad,legacy]},data,{marks,root,today:'2026-09-16'});
  assert.equal(out.errors.length,1);assert.equal(out.queue.items[0].status,'error');assert.equal(out.queue.items[1].applied,'2026-09-16');
  assert.equal(out.data.researchPricing.renewal.retention,data.researchPricing.renewal.retention);assert.ok(out.data.companies[0].catalysts.includes(legacy.proposed.text));
});
group('independent accepted numerical changes can share one source snapshot',()=>{
  const drafts=['APLD','HIVE'].map(ticker=>{
    const c=data.companies.find(c=>c.tk===ticker), p=A.draftProposal({...input,title:ticker+' offline equity sensitivity',changes:[{scope:'company',ticker,path:['plannedRaise'],current:c.plannedRaise,proposed:c.plannedRaise+100,unit:'USD million'}]},opts);
    p.status='accepted';return p;
  });
  const out=W.processQueue({items:drafts},data,{marks,root,today:'2026-09-16'});assert.deepEqual(out.errors,[]);assert.equal(out.lines.length,2);
});
console.log(groups+' assumption approval safety groups passed; no model or queue files changed.');
