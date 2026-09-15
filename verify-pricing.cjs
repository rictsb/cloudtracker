/* Synthetic accounting regressions for contract expiry, comparable pricing and renewals. No writes. */
const assert=require('node:assert/strict');
const {rampQuarters,rampTrancheAt,RAMP_QS}=require('./ramp-core.js');
const copy=x=>JSON.parse(JSON.stringify(x));
const near=(actual,expected,message)=>assert.ok(Math.abs(actual-expected)<1e-8*Math.max(1,Math.abs(expected)),`${message}: ${actual} != ${expected}`);
const market={asOf:'2026-09-15',effectiveQ:'2026Q3',curve:{2026:{1:20,3:20,5:20},2027:{1:22,3:22,5:22},2028:{1:24,3:24,5:24},2029:{1:26,3:26,5:26}},
  generationFactors:{hopper:1,blackwell:1},softwarePremium:0,
  renewal:{termYears:1,retention:1,rateMode:'retain',rateMultiplier:1},
  spot:{basis:'per-gpu-hour',rates:{2026:1,2027:1,2028:1,2029:1},generationMultipliers:{hopper:1,blackwell:1}}};
const tranche={id:'fixture',n:'Fixture',campus:'Fixture',grossMW:12,itMW:10,gpus:1000,gen:'hopper',energize:'2026Q1',rev:'2026Q1',rampQtrs:1,ctr:1,signed:1,rate:3,
  contract:{termYears:1,expiryBasis:'estimated',priceBasis:'inferred',commitmentBasis:'disclosed',source:'fixture-primary'},newBusiness:{termYears:1}};
const model=(t=tranche)=>({asOf:'2026-09-15',pricing:{defaultTermYears:1},spot:{2026:1,2027:1,2028:1,2029:1},spotMult:{hopper:1,blackwell:1},tranches:[copy(t)]});
const at=(R,label,delta={},M=market)=>rampQuarters(R,{d:delta},RAMP_QS(label),RAMP_QS(label),M)[0];
let tests=0;
function test(name,fn){fn();tests++;console.log('PASS '+name);}
test('Legacy and pre-effective history remain byte-for-byte compatible',()=>{
  const R=model({...tranche,ctr:.7,signed:.4,rampQtrs:4});R.calibration={rampMult:3};
  const old=copy(R);delete old.pricing;
  assert.deepEqual(rampQuarters(R,null,-1,2,market),rampQuarters(old,null,-1,2));
  assert.deepEqual(rampQuarters(old,null,3,12,market),rampQuarters(old,null,3,12));
  assert.throws(()=>at(R,'2026Q3',{},null),/requires data.researchPricing/);
});
test('Exclusive expiry retires signed revenue while retaining productive equipment',()=>{
  const before=at(model(),'2026Q4'),after=at(model(),'2027Q1');
  near(before.revExisting,6.57,'original quarter revenue');near(before.revS,6.57,'confirmed commitment');
  near(after.revExisting,0,'expired original book');near(after.revS,0,'expired signed revenue');near(after.signed,0,'expired signed GPUs');
  near(after.revRenewal,6.57,'retained renewal rate');near(after.cum,1000,'no forced retirement');
  assert.equal(after.details[0].groups[0].endQ,'2028Q1');
});
test('Assumed existing book is not legally signed',()=>{
  const t=copy(tranche);t.contract.commitmentBasis='assumed';
  const q=at(model(t),'2026Q3');near(q.revExistingAssumed,6.57,'economic assumed book');
  near(q.revS,0,'confirmed revenue');near(q.signed,0,'confirmed GPUs');assert.equal(q.provenance.assumedExisting,1);
});
test('Partial signed tranche separates old contract, new contract and spot without double billing',()=>{
  const q=at(model({...tranche,ctr:.8,signed:.5}),'2026Q3');
  near(q.revExisting,3.285,'half original commitment');near(q.revNew,15,'30% new capacity on market curve');near(q.revSpot,.438,'20% realized spot');
  near(q.cum,1000,'whole fleet');near(q.ctr,800,'contracted GPUs');near(q.signed,500,'original disclosed GPUs');
  near(q.rev,q.revExisting+q.revNew+q.revRenewal+q.revSpot,'revenue identity');
  near(q.itMW,q.itContracted+q.itSpot,'capacity identity');near(q.arrContracted,q.arrExisting+q.arrNew+q.arrRenewal,'ARR identity');
});
test('Acceptance and spot ramps are separate, with no second contract mix haircut',()=>{
  const t={...tranche,rev:'2026Q3',energize:'2026Q3',rampQtrs:2,ctr:.5,signed:.5};
  const R=model(t);R.calibration={rampMult:4};const q=at(R,'2026Q3');
  near(q.itContracted,2.5,'reserved capacity accepted at half its two-quarter ramp');
  near(q.itSpot,.625,'spot rents at one eighth of its separate ramp');
  near(q.revExisting,250*3*2190/1e6,'reserved revenue follows acceptance');
  near(q.earningArrContracted/q.itContracted,3*100*8760/1e9,'earned yield reconciles');
  near(q.arrExisting,q.revExisting*8/1000,'energized ARR is independent of acceptance');
});
test('Multiple renewal cycles carry an explicit retention probability and no capacity duplication',()=>{
  const M=copy(market);M.renewal.retention=.8;M.renewal.rateMultiplier=.9;
  const q=at(model(),'2028Q1',{},M),g=q.details[0].groups[0];
  assert.equal(g.renewalCycle,2);near(g.rate,3*.9*.9,'rate retained at each renewal');
  near(q.ctr,640,'retention compounded twice');near(q.itSpot,3.6,'unretained equipment moves to spot');near(q.cum,1000,'fleet total');
  near(q.revRenewal,640*3*.81*2190/1e6,'renewal revenue');
});
test('The same generation, tenor, year and IT MW earn the same new-business revenue across companies',()=>{
  const a={...tranche,rate:2,ctr:1,signed:0},b={...tranche,id:'other',rate:8,gpus:2000,ctr:1,signed:0};
  const qa=at(model(a),'2026Q3'),qb=at(model(b),'2026Q3');
  near(qa.revNew,qb.revNew,'common $/MW curve');near(qa.arrNew,qb.arrNew,'common ARR');near(qa.revNew,50,'market price from first principles');
});
test('Unmapped future book is market-priced in base and explicitly restored only by its allocation sensitivity',()=>{
  const t=copy(tranche);t.energize=t.rev='2027Q1';t.contract.signedShare=0;t.contract.allocationBasis='unmapped-future';t.contract.commitmentBasis='assumed';
  const R=model(t),snapshot=copy(R),base=at(R,'2027Q1'),legacy=at(R,'2027Q1',{legacyBookAllocation:true});
  near(base.revExisting,0,'unmapped future allocation absent in base');near(base.revNew,55,'common 2027 price');
  near(legacy.revExistingAssumed,6.57,'alternative inferred old book');near(legacy.revNew,0,'alternative is not double billed');near(legacy.revS,0,'alternative does not invent confirmed commitments');
  const lease=at(R,'2027Q1',{ctrMult:.5}),locked=at(R,'2027Q1',{ctrMult:.5,legacyBookAllocation:true});
  near(lease.ctr,500,'unmapped base slice responds to leasing stress');near(locked.ctr,1000,'alternative assumed existing book remains locked');
  near(lease.arrNew,.11,'ARR follows selected share');assert.deepEqual(R,snapshot,'scenario does not mutate original data');
  t.contract.allocationBasis='mapped';near(at(model(t),'2027Q1',{legacyBookAllocation:true}).revNew,55,'legacy switch affects only explicitly unmapped future capacity');
});
test('New-business price and term stresses leave existing contractual locks intact',()=>{
  const R=model({...tranche,ctr:1,signed:.5});const base=at(R,'2026Q3'),stress=at(R,'2026Q3',{newRateMult:.85,newTermYears:5});
  near(stress.revExisting,base.revExisting,'existing lock unaffected');near(stress.revNew,base.revNew*.85,'new price stress');
  near(stress.arrNew,base.arrNew*.85,'new ARR stress');assert.equal(stress.details[0].groups.find(g=>g.origin==='new').endQ,'2031Q3');
});
test('Broad pricing and GPU-price-cap scenarios consistently affect ARR and earned revenue',()=>{
  const R=model({...tranche,ctr:1,signed:.5});const base=at(R,'2026Q3'),stress=at(R,'2026Q3',{rateMult:.8});
  near(stress.revC,base.revC*.8,'quarterly contract revenue');near(stress.arrContracted,base.arrContracted*.8,'contracted ARR');
  const cap=at(R,'2026Q3',{genRateCap:{hopper:4}});
  near(cap.revExisting,base.revExisting,'unsigned cap leaves original contract');near(cap.revNew,500*4*2190/1e6,'new rate capped');
  near(cap.arrNew,cap.revNew*4/1000,'cap propagates to ARR');
});
test('Renewal-specific stresses leave pre-expiry original contracts intact',()=>{
  near(at(model(),'2026Q3',{renewalRateMult:.7}).revExisting,6.57,'pre-expiry rate');
  near(at(model(),'2027Q1',{renewalRateMult:.7}).revRenewal,6.57*.7,'renewal haircut');
  const q=at(model(),'2027Q1',{renewalRetention:0});near(q.revRenewal,0,'no renewal');near(q.cum,1000,'equipment retained');near(q.itSpot,10,'spot redistribution');
});
test('Explicit calendar end dates do not move with delivery delays',()=>{
  const t=copy(tranche);t.contract.endQ='2027Q1';t.contract.expiryBasis='disclosed';
  const q=at(model(t),'2027Q1',{slipQtrs:2,from:1});near(q.revS,0,'calendar expiry remains fixed');near(q.revRenewal,6.57,'renewal begins on fixed date');
  const estimated=at(model(),'2027Q1',{slipQtrs:2,from:1});near(estimated.revExisting,6.57,'estimated term follows acceptance start');
  t.contract.expiryBasis='estimated';
  const estimatedExplicit=at(model(t),'2027Q1',{slipQtrs:2,from:1});
  near(estimatedExplicit.revExisting,6.57,'estimated explicit expiry follows delivery');
  assert.equal(estimatedExplicit.details[0].groups[0].endQ,'2027Q3');
});
test('Optional market-priced renewals use their renewal date and software uplift once',()=>{
  const M=copy(market);M.renewal.rateMode='market';M.softwarePremium=.1;
  const q=at(model(),'2027Q1',{},M);near(q.revRenewal,22*10*1.1/4,'renewal market curve');near(q.arrRenewal,22*10*1.1/1000,'all-in ARR');
});
test('Tranche trace and report aggregate use the same math',()=>{
  const R=model({...tranche,ctr:.8,signed:.5});const q=at(R,'2028Q1'),one=rampTrancheAt(R,R.tranches[0],RAMP_QS('2028Q1'),market);
  near(one.g,q.cum,'tranche GPUs');near(one.r,q.rev,'tranche revenue');assert.equal(q.pricingAsOf,market.asOf);
  assert.equal(q.details[0].groups[0].source,'fixture-primary');
});
console.log(`PASS: ${tests} synthetic research-pricing regression groups.`);
