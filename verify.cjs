const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const base=__dirname;
process.env.CT_ROOT=base;
const gen=require(path.join(base,'export-research.js'));
const {assemble}=require(path.join(base,'onepager.js'));
const data=JSON.parse(fs.readFileSync(path.join(base,'data.json'),'utf8'));
const p=JSON.parse(fs.readFileSync(path.join(base,'iren-data.json'),'utf8'));
const context=vm.createContext({console,URLSearchParams,TextEncoder,TextDecoder,btoa,atob,setTimeout,clearTimeout,AbortController,fetch:async url=>({ok:true,json:async()=>JSON.parse(fs.readFileSync(path.join(base,String(url).split('/').at(-1)),'utf8'))})});
for(const file of ['engine.js','ramp-core.js','onepager-core.js','model-data.js','research-data.js','checks-core.js','portfolio-core.js','approvals-core.js','research-view.js','coverage-view.js','contracts-view.js','news-view.js','checks-view.js','portfolio-view.js','approvals-view.js','report-graphics.js','report-layout.js','report-view.js','compare-view.js'])vm.runInContext(fs.readFileSync(path.join(base,file),'utf8'),context,{filename:file});
const close=(a,b,label='')=>assert.ok(Math.abs(a-b)<1e-8*Math.max(1,Math.abs(b)),`${label?label+': ':''}${a} != ${b}`);
// Export freshness must survive platform-level floating-point jitter without
// accepting changed evidence, missing fields or material financial differences.
function assertCanonicalJSON(actual,expected,label='canonical payload',at='$'){
  const where=label+' '+at;
  assert.equal(typeof actual,typeof expected,where+' type differs');
  if(typeof actual==='number'){
    assert.ok(Number.isFinite(actual)&&Number.isFinite(expected),where+' must contain finite numbers');
    const tolerance=1e-12*Math.max(Math.abs(actual),Math.abs(expected));
    assert.ok(Math.abs(actual-expected)<=tolerance,where+': '+actual+' != '+expected);
    return;
  }
  if(actual===null||expected===null||typeof actual!=='object'){
    assert.strictEqual(actual,expected,where+' value differs');return;
  }
  assert.equal(Array.isArray(actual),Array.isArray(expected),where+' container type differs');
  if(Array.isArray(actual)){
    assert.equal(actual.length,expected.length,where+' array length differs');
    actual.forEach((value,i)=>assertCanonicalJSON(value,expected[i],label,at+'['+i+']'));
    return;
  }
  const keys=Object.keys(actual).sort();
  assert.deepStrictEqual(keys,Object.keys(expected).sort(),where+' object keys differ');
  keys.forEach(key=>assertCanonicalJSON(actual[key],expected[key],label,at+'.'+key));
}
// Exercise the comparator itself: only tiny numeric round-off may pass.
{
  const expected={valuePerShare:122.93886466253481,sources:[{url:'https://example.com/source',dated:'2026-09-15'}]};
  const changed=fn=>{const x=structuredClone(expected);fn(x);return x;};
  assert.doesNotThrow(()=>assertCanonicalJSON(changed(x=>{x.valuePerShare=122.93886466253483;}),expected));
  for(const mutate of [
    x=>{x.valuePerShare+=1e-5;},
    x=>{x.sources[0].url='https://example.com/other';},
    x=>{x.extra=true;},
    x=>{delete x.valuePerShare;},
    x=>{x.sources.pop();},
    x=>{x.valuePerShare=String(x.valuePerShare);},
    x=>{x.valuePerShare=Infinity;}
  ])assert.throws(()=>assertCanonicalJSON(changed(mutate),expected),assert.AssertionError);
}
(async()=>{
  let model=await context.CloudModel.load();
  assert.equal(model.companies.length,22);assert.equal(model.sites.length,194);assert.equal(model.meta.priceAsOf,null);
  let companyChecks=0;
  const cases=[{},...model.assumptions.flatMap(a=>[{[a.key]:a.min},{[a.key]:a.max}])];
  for(const changes of cases){
    const model=context.CloudModel.recalculate(changes),engine=context.Engine.createEngine(data);Object.assign(engine.A,changes);
    for(const c of model.companies){
      const original=engine.value(data.companies.find(x=>x.tk===c.ticker));
      close(c.target,original.target);close(c.floor,original.floorTarget);close(c.upside,original.upside);
      const d=c.decomposition;close(d.equityM/c.fundedSharesM,c.target);
      close(d.perShare.signed+d.perShare.unsigned+d.perShare.legacy+d.perShare.claims,c.target);
      companyChecks++;
    }
  }
  model=context.CloudModel.reset();
  assert.equal(model.companies.find(c=>c.ticker==='IREN').target.toFixed(2),'289.63');
  for(const ramp of Object.values(model.ramps))for(const q of ramp.quarters){
    close(q.signedRevenueM+q.futureContractRevenueM+q.spotRevenueM,q.revenueM);
    assert.ok(q.earningITMW>=0&&q.earningGPUs>=0);
  }
  // Live-mark propagation (handoff hazard 2): marks must survive recalculation AND reset, match a
  // directly marked engine (equity via IREN, btc via MARA, eth via BTBT — holders where each mark
  // is load-bearing), drop unusable values, and clear cleanly.
  context.CloudModel.setMarks({prices:{IREN:50},btc:100000,eth:5000,asOf:'2026-09-14'});
  const marked=context.CloudModel.recalculate({disc:11});
  const mi=marked.companies.find(c=>c.ticker==='IREN');
  assert.equal(mi.price,50);assert.equal(mi.priceAsOf,'2026-09-14');assert.equal(marked.meta.priceAsOf,'2026-09-14');
  const em=context.Engine.createEngine(data);em.ctx.prices.IREN=50;em.ctx.btc=100000;em.ctx.eth=5000;em.A.disc=11;
  for(const tk of ['IREN','MARA','BTBT'])close(marked.companies.find(c=>c.ticker===tk).target,em.value(data.companies.find(x=>x.tk===tk)).target);
  const kept=context.CloudModel.reset();
  assert.equal(kept.companies.find(c=>c.ticker==='IREN').price,50);
  context.CloudModel.setMarks({prices:{KEEL:0}});
  assert.equal(context.CloudModel.current.companies.find(c=>c.ticker==='KEEL').priceAsOf,null);
  model=context.CloudModel.clearMarks();
  assert.equal(model.meta.priceAsOf,null);assert.equal(model.companies.find(c=>c.ticker==='IREN').price,41.09);
  model=context.CloudModel.reset();
  assert.equal(model.companies.find(c=>c.ticker==='IREN').target.toFixed(2),'289.63');
  const r=context.OnePager.waterfall(p.L,p.CAPQ,p.finance,p.ARRC);
  // Research prices move when the authorized shared curve changes. Reconcile the
  // generated report with canonical data/math; keep the separate asset target pinned.
  close(r.ps,assemble(data.companies.find(c=>c.tk==='IREN'),data.researchPricing).W.ps);
  close(r.ev-r.ndc-r.liab+(p.finance.NONCORE||0),r.ps*r.dil/1000*r.DF);
  const scenarioKeys=['base','rate8','equityPrice','noCredit','convAsDebt','noRestricted','rev90','multLow','multHigh'];
  const pages=['','tab=overview','tab=delivery&metric=gpus','tab=delivery&metric=power','tab=delivery&metric=revenue','tab=evidence',...scenarioKeys.map(x=>'tab=valuation&scenario='+x),'tab=valuation&scenario=unknown'];
  // (rendered via ReportView in the wave-3 block below — iren-view.js is retired)
  for(const query of ['','tab=financing','tab=outlook','tab=outlook&view=earnings','company=IREN','company=NOTREAL','limit=50']){
    const html=context.ResearchView.render(model,new URLSearchParams(query));assert.ok(!/NaN|undefined|\[object Object\]/.test(html));
  }
  // Wave-2 views: they consume window.UI (defined by app.js, which needs a DOM) — provide the
  // same helpers here, plus inert document/window stubs for render-time listener attachment.
  const N=(x,d=0)=>Number(x).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});
  context.UI={
    esc:x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
    n:N,money:x=>'$'+N(x,2),big:x=>Math.abs(x)>=1000?'$'+N(x/1000,1)+'bn':'$'+N(x,0)+'m',
    pct:(x,d=0,sign=false)=>(sign&&x>0?'+':'')+N(x*100,d)+'%',
    date:x=>x?new Date(x.length===7?x+'-01T12:00:00':x+'T12:00:00').toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'}):'Not supplied',
    icon:()=>'<svg aria-hidden="true"></svg>',
    metric:(l,v,note,cls='')=>`<div class="metric"><div class="metric-label">${l}</div><div class="metric-value ${cls}">${v}</div><div class="metric-note">${note}</div></div>`,
    lineChart:()=>'<svg role="img"></svg>'
  };
  context.window=context;
  context.document={getElementById:()=>null,addEventListener:()=>{},removeEventListener:()=>{},querySelector:()=>null,querySelectorAll:()=>[]};
  context.location={pathname:'/',search:'',hash:''};
  const bad=/NaN|\[object Object\]|undefined(?![a-zA-Z])/;
  const settle=()=>new Promise(r=>setTimeout(r,20));
  const states={
    coverage:[()=>context.CoverageView.render(new URLSearchParams('')),()=>context.CoverageView.render(new URLSearchParams('sort=ticker&dir=1&company=IREN'))],
    contracts:[()=>context.ContractsView.render(model,'',''),()=>context.ContractsView.render(model,'CORZ','')],
    news:[()=>context.NewsView.render(new URLSearchParams('')),()=>context.NewsView.render(new URLSearchParams('company=IREN&signal=1'))],
    checks:[()=>context.ChecksView.render(new URLSearchParams(''))],
    portfolio:[()=>context.PortfolioView.render(new URLSearchParams('')),()=>context.PortfolioView.render(new URLSearchParams('range=1M'))],
    approvals:[()=>context.ApprovalsView.render(new URLSearchParams(''))],
    raises:[()=>context.ResearchView.render(model,new URLSearchParams('tab=financing'))]
  };
  for(const [name,renders] of Object.entries(states)){
    renders.forEach(r=>r());await settle();await settle();
    for(const r of renders){const h=r();assert.ok(!bad.test(h),name+' view emits NaN/undefined');assert.ok(h.length>200,name+' view suspiciously empty');}
  }
  assert.ok(states.coverage[0]().includes('Backlog'),'coverage aggregates missing');
  assert.ok(states.approvals[0]().includes('awaiting a decision'),'approvals status line missing');
  assert.ok(states.checks[0]().includes('checked just now, in this browser'),'checks verdict wording missing');
  assert.ok(states.raises[0]().includes('Raise reaction')||states.raises[0]().includes('Event study'),'raises study missing');
  // Approvals byte-contract: only status+decided change; serializer is stringify(,1)+newline.
  const AP=JSON.parse(fs.readFileSync(path.join(base,'proposals.json'),'utf8'));
  const pend=AP.items.find(i=>i.status==='pending');
  const commit=context.ApprovalsCore.buildCommit(AP,pend.id,'rejected','2026-09-14');
  const round=JSON.parse(Buffer.from(commit.content,'base64').toString('utf8'));
  assert.equal(commit.message,'proposals: '+pend.id+' rejected (Approvals screen)');
  assert.equal(round.items.find(i=>i.id===pend.id).status,'rejected');
  assert.equal(round.items.find(i=>i.id===pend.id).decided,'2026-09-14');
  const a=JSON.parse(JSON.stringify(AP));a.items.find(i=>i.id===pend.id).status='rejected';a.items.find(i=>i.id===pend.id).decided='2026-09-14';
  assert.equal(Buffer.from(commit.content,'base64').toString('utf8'),JSON.stringify(a,null,1)+'\n');
  // Every legacy tab/scenario deep link must render the complete graphical one-pager. A base
  // price alone did not catch the earlier loss of timelines and generation charts. CompareView
  // and the R2 contract checks still cover engine byte-parity and data freshness.
  // The authored narrative HTML legitimately contains the word "undefined" (e.g. an NBIS factor
  // note), so these states allow at most the authored count rather than banning the token.
  const P3={iren:fs.readFileSync(path.join(base,'iren-data.json'),'utf8'),crwv:fs.readFileSync(path.join(base,'crwv-data.json'),'utf8'),nbis:fs.readFileSync(path.join(base,'nbis-data.json'),'utf8')};
  const cmpRaw=fs.readFileSync(path.join(base,'compare-data.json'),'utf8');
  const undefCount=s=>(s.match(/undefined/g)||[]).length;
  ['IREN','CRWV','NBIS'].forEach(tk=>context.ReportView.render(tk,new URLSearchParams('')));
  context.CompareView.render(new URLSearchParams(''));
  await settle();await settle();
  const repFixture={};
  let denominatorRegressions=0;
  const reportIds=['power','gpus','arr','funding','economics','valuation','sensitivities','cash-ledger'].map(s=>'report-'+s);
  const sectionHTML=(html,id)=>{
    const hit=new RegExp('<([a-z][\\w:-]*)\\b[^>]*\\sid="'+id+'"[^>]*>').exec(html);
    assert.ok(hit,'missing '+id);
    assert.equal((html.match(new RegExp('\\sid="'+id+'"','g'))||[]).length,1,'duplicate '+id);
    // Visual stages must not be hidden inside collapsed details; supporting data may be.
    const folds=[];
    for(const tag of html.slice(0,hit.index).matchAll(/<\/?details\b[^>]*>/g)){
      if(tag[0].startsWith('</'))folds.pop();else folds.push(/\sopen(?:\s|=|>)/.test(tag[0]));
    }
    assert.ok(folds.every(Boolean),id+' is hidden inside a collapsed detail');
    const tags=new RegExp('<\\/?'+hit[1]+'\\b[^>]*>','g');tags.lastIndex=hit.index+hit[0].length;
    let depth=1,tag;
    while((tag=tags.exec(html))){depth+=tag[0].startsWith('</')?-1:1;if(!depth)return html.slice(hit.index,tags.lastIndex);}
    assert.fail('unclosed '+id);
  };
  for(const [tk,raw] of [['IREN',P3.iren],['CRWV',P3.crwv],['NBIS',P3.nbis]]){
    const D=JSON.parse(raw),W=context.OnePager.waterfall(D.L,D.CAPQ,D.finance,D.ARRC);
    const company=data.companies.find(c=>c.tk===tk),assembled=assemble(company,data.researchPricing);
    close(W.ps,assembled.W.ps);
    close(D.finance.MULT,assembled.F.MULT);
    assert.deepStrictEqual(D.L,assembled.L,tk+' report ledger differs from canonical assembly');
    assert.deepStrictEqual(D.ARRC,assembled.ARRC,tk+' report ARR differs from canonical assembly');
    const sens=context.OnePager.sensitivities(D.L,D.CAPQ,D.finance,D.ARRC,D.px.v);
    // Only the presentation label changes: the reference is dated until quotes load.
    sens[2].name='Equity raised at reference price, not $'+D.finance.EQ_PX;
    const scenarioOptions=[{}, {rate:.08}, {eqPx:D.px.v}, {noCredit:true}, {convAsDebt:true}, {noRestricted:true}, {revScale:.9}, {mult:D.finance.MULT-.5}, {mult:D.finance.MULT+.5}];
    const defaultHTML=context.ReportView.render(tk,new URLSearchParams(''));
    const baseLedger=sectionHTML(defaultHTML,'report-cash-ledger');
    if(company.ramp.pricing){
      assert.ok(D.pricing,tk+' exported pricing model missing');
      const s=D.pricing.summary,q=assembled.rawQuarters.at(-1),arrHTML=sectionHTML(defaultHTML,'report-arr');
      assert.deepStrictEqual(D.pricing.market,data.researchPricing,tk+' forks the common market assumptions');
      close(s.earningITMW,q.itMW);close(s.contractedEarningITMW,q.itContracted);
      close(s.contractRevenueRunRateBn,q.revC*.004);close(s.totalRevenueRunRateBn,q.rev*.004);
      // The numerator is earned annualized revenue, paired with its own earning MW.
      // Energized contracted ARR and total MW must not slip back into this ratio.
      close(s.contractRevenuePerMW,q.revC*4/q.itContracted);
      close(s.totalRevenuePerMW,q.rev*4/q.itMW);
      close(s.existingRevenueBn+s.renewalRevenueBn+s.newRevenueBn+s.spotRevenueBn,s.totalRevenueRunRateBn);
      if(Math.abs(s.contractRevenuePerMW-s.arrContracted*1000/s.earningITMW)>.01)denominatorRegressions++;
      const rawByQuarter=new Map(assembled.rawQuarters.map(x=>[x.lbl,x]));
      for(const x of D.pricing.quarters){
        const rawQ=rawByQuarter.get(x.quarter);assert.ok(rawQ,tk+' unrecognized pricing quarter');
        close(x.existingBn,rawQ.revExisting*.004);close(x.renewalBn,rawQ.revRenewal*.004);
        close(x.newBn,rawQ.revNew*.004);close(x.spotBn,rawQ.revSpot*.004);
      }
      for(const label of ['Existing book','Renewals','New business','Spot','Contract revenue / contracted earning IT MW','Total revenue / all earning IT MW','Pricing assumptions and sources','Contract expiry, rates and evidence'])
        assert.ok(arrHTML.includes(label),tk+' missing pricing presentation: '+label);
      assert.ok(arrHTML.includes('$'+N(s.contractRevenuePerMW,2)+'m'),tk+' contract yield not displayed from the earned denominator');
      assert.ok(arrHTML.includes('$'+N(s.totalRevenuePerMW,2)+'m'),tk+' total yield not displayed from the earned denominator');
      assert.ok(arrHTML.includes('rp-cohort-table'),tk+' contract evidence table missing');
      assert.ok(arrHTML.includes('Pricing and renewal sensitivities'),tk+' pricing sensitivities missing');
      assert.equal(D.pricing.cohorts.length,company.ramp.tranches.length,tk+' missing tranche evidence');
      for(const scenario of company.ramp.scenarios){
        const exported=D.pricing.sensitivities.find(x=>x.id===scenario.id),a=assemble(company,data.researchPricing,scenario);
        assert.ok(exported,tk+' missing pricing sensitivity '+scenario.id);
        close(exported.valuePerShare,a.W.ps,tk+' pricing '+scenario.id);close(exported.runRateBn,a.rr);close(exported.multiple,a.F.MULT);
        assert.ok(arrHTML.includes(context.UI.esc(exported.label)),tk+' missing scenario label '+scenario.id);
        assert.ok(arrHTML.includes('$'+N(exported.valuePerShare,2)),tk+' missing scenario valuation '+scenario.id);
      }
    }
    close(W.ev-W.ndc-W.liab+(D.finance.NONCORE||0),W.ps*W.dil/1000*W.DF);
    for(const query of pages){
      const h=context.ReportView.render(tk,new URLSearchParams(query));
      assert.ok(!/NaN|\[object Object\]/.test(h),tk+' report emits NaN at '+query);
      assert.ok(undefCount(h)<=undefCount(raw),tk+' report emits unauthored undefined at '+query);
      assert.ok(h.includes(tk),tk+' report missing its ticker at '+query);
      const parts=Object.fromEntries(reportIds.map(id=>[id,sectionHTML(h,id)]));
      for(const id of reportIds.filter(id=>!['report-sensitivities','report-cash-ledger'].includes(id))){
        assert.ok(/<svg\b[^>]*\brole="img"/.test(parts[id]),tk+' '+id+' has no accessible graphic at '+query);
      }
      assert.ok(parts['report-power'].includes('timeline'),'campus power timeline missing');
      assert.ok(parts['report-valuation'].includes('Valuation waterfall'),'graphical valuation waterfall missing');
      assert.ok(/<table\b/.test(parts['report-cash-ledger']),'full cash-flow ledger missing');
      assert.equal(parts['report-cash-ledger'],baseLedger,tk+' sensitivity unexpectedly changes the base quarterly ledger');
      assert.ok(h.includes('data-base-value="'+W.ps.toFixed(2)+'"'),tk+' headline lost the canonical base value');
      const requested=new URLSearchParams(query).get('scenario');
      const si=Math.max(0,scenarioKeys.indexOf(requested)),selected=sens[si];
      assert.ok(parts['report-valuation'].includes('data-scenario-value="'+selected.ps.toFixed(2)+'"'),tk+' incorrect selected sensitivity at '+query);
      assert.equal((parts['report-sensitivities'].match(/data-report-scenario-link=/g)||[]).length,9,tk+' does not expose all nine sensitivities');
      for(const s of sens){
        assert.ok(parts['report-sensitivities'].includes(context.UI.esc(s.name)),tk+' sensitivity label missing: '+s.name);
        assert.ok(parts['report-sensitivities'].includes('$'+N(s.ps,2)),tk+' sensitivity result missing: '+s.name);
      }
      const selectedModel=context.OnePager.waterfall(D.L,D.CAPQ,D.finance,D.ARRC,scenarioOptions[si]);
      close(selected.ps,selectedModel.ps);
      const equity=selectedModel.ev-selectedModel.ndc-selectedModel.liab+(D.finance.NONCORE||0);
      const fromBridge=equity/selectedModel.DF*1000/selectedModel.dil;
      // The source solver oscillates at a NBIS convert threshold in multLow. Preserve its result,
      // but prevent the diagram from claiming a false equality. Every base case reconciles above.
      const unreconciled=Math.abs(fromBridge-selectedModel.ps)>.01;
      assert.equal(parts['report-valuation'].includes('data-reconciliation-warning'),unreconciled,tk+' convert-reconciliation warning is incorrect at '+query);
      if(!unreconciled)close(equity,selectedModel.ps*selectedModel.dil/1000*selectedModel.DF);
    }
    // C12: markup-bearing narrative must render AS markup (a future esc() regression on the notes
    // path would otherwise pass silently). Also pin the two derived presentation identities the
    // structural checks miss: the base regime bar equals the canonical base, and EPS renders.
    const markedNote=(D.notes||[]).flat().find(s=>/<b>/.test(String(s)));
    if(markedNote)assert.ok(defaultHTML.includes(markedNote),tk+' markup-bearing note is not rendered as markup (C12)');
    const baseRegime=(D.steady&&D.steady.regimes||[]).find(rg=>Math.abs(rg[1]-D.finance.MULT)<1e-9);
    if(baseRegime)close((D.rr*baseRegime[1]-W.last.nd-W.liab+(D.finance.NONCORE||0))/W.DF*1000/W.dil,W.ps);
    const eps=(W.pl.ni*1000+W.addb)/W.dil;
    assert.ok(defaultHTML.includes('$'+N(eps,1))||defaultHTML.includes('$'+N(eps,2)),tk+' EPS not rendered in the income detail');
    repFixture[tk]=W.ps;
  }
  assert.ok(denominatorRegressions>0,'pricing fixtures no longer distinguish the original mismatched ARR/MW ratio');
  const ch=context.CompareView.render(new URLSearchParams(''));
  assert.ok(!/NaN|\[object Object\]/.test(ch),'compare emits NaN');
  assert.ok(undefCount(ch)<=undefCount(cmpRaw)+undefCount(P3.iren)+undefCount(P3.crwv)+undefCount(P3.nbis),'compare emits unauthored undefined');
  assert.ok(ch.length>2000,'compare suspiciously empty');
  assert.ok(ch.includes('Shared pricing, different revenue books'),'shared pricing comparison missing');
  assert.ok(ch.includes('Contract revenue / contracted earning IT MW'),'comparison reintroduced an unmatched ARR/MW basis');
  // Verify the canonical files in this checkout. A developer's separate checkout
  // is not a reference implementation and must not cause CI to skip freshness.
  // Optional undefined object fields are absent from JSON by definition; compare
  // the serialized exporter contract rather than its pre-serialization shape.
  for(const tk of ['IREN','CRWV','NBIS'])assertCanonicalJSON(JSON.parse(JSON.stringify(gen.buildPayload(tk))),JSON.parse(P3[tk.toLowerCase()]),tk+'-data.json stale — rerun export-research.js');
  assertCanonicalJSON(JSON.parse(JSON.stringify(gen.buildCompare())),JSON.parse(cmpRaw),'compare-data.json stale — rerun export-research.js --compare');
  const nodeChecks=require('./checks-core.js').runChecks(data,'2026-09-15');
  const browserChecks=context.ChecksCore.runChecks(data,'2026-09-15');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(browserChecks)),JSON.parse(JSON.stringify(nodeChecks)),'Browser and CLI checks differ');
  const html=fs.readFileSync(path.join(base,'index.html'),'utf8');
  for(const match of html.matchAll(/(?:src|href)="(\/(?:[\w.-]+\/)*[\w.-]+\.(?:js|css|svg))"/g))assert.ok(fs.existsSync(path.join(base,match[1])),match[1]);
  console.log(`PASS: ${companyChecks} company comparisons across ${cases.length} cases; ramp revenue bridges; ${pages.length} complete graphical report states x 3 names (${Object.entries(repFixture).map(([tk,value])=>tk+' $'+value.toFixed(2)).join(' / ')}), all 9 valuation sensitivities plus pricing/renewal paths, matched earned-MW denominators, base ledger invariance and convert reconciliation + compare; canonical research assembly + data freshness; asset-engine fixed-target parity; 7 research states; live-mark propagation; 7 wave-2 views incl. approvals byte-contract; local asset paths.`);
})().catch(error=>{console.error(error);process.exitCode=1;});
