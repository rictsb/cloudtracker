#!/usr/bin/env node
/* Concrete economic proposals only. Drafting never changes data.json; application requires
   an owner decision, unchanged source/model inputs, and a reproducible impact preview. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const RULE_VERSION = 'assumption-approvals-v2';
const ROOT = __dirname;
const copy = x => JSON.parse(JSON.stringify(x));
// Shared with the scheduled reviewer; importing either module performs no work.
const hashes = () => require('./assumption-review.cjs');
const own = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const COMPANY_FIELDS = {
  shares:[0.000001,1000000,'million shares'], netDebt:[-1000000,1000000,'USD million'],
  plannedRaise:[0,1000000,'USD million'], committedDebt:[0,1000000,'USD million'], seniorClaims:[0,1000000,'USD million'],
  contractedPct:[0,100,'percent'], termYrs:[0,50,'years'], signedRate:[0.000001,100,'USD million/IT MW/year'],
  genAccess:[0,2,'multiple'], signedRegionFactor:[0.000001,2,'multiple'], equityDiscount:[0,0.99,'fraction']
};
// Scalars whose units and dependency treatment are explicit in onepager-core.js. Convertible
// SERIES, principal, dates, prepayment calendars and generated fields are deliberately excluded.
const FINANCE_FIELDS = {
  M:[0.001,1,'fraction'], W:[0.001,0.5,'fraction'], SH0:[0.000001,1000000,'million shares'],
  EQ_SHARE:[0,1,'fraction'], EQ_PX:[0.01,100000,'USD/share'], DEBT0:[0,1000,'USD billion'],
  CASH0:[0,1000,'USD billion'], RATE:[0,0.5,'fraction'], TAX:[0,1,'fraction'], MINCASH:[0,1000,'USD billion'],
  CASH_R:[0,1000,'USD billion'], FWD:[0,1000000,'million shares'], AMORT:[0.000001,0.999999,'fraction'],
  GPU_LIFE:[1,20,'years'], SHELL_LIFE:[1,100,'years'], NONCORE:[0,1000,'USD billion']
};
function changeKey(c) { return (c.scope === 'global' ? 'global' : c.ticker) + ':' + c.path.join('.'); }
function fieldRule(c) {
  const p = c.path;
  if (c.scope === 'company') {
    if (p.length === 1 && own(COMPANY_FIELDS,p[0])) return COMPANY_FIELDS[p[0]];
    if (p.length === 3 && p[0] === 'page' && p[1] === 'finance' && own(FINANCE_FIELDS,p[2])) return FINANCE_FIELDS[p[2]];
  } else if (c.scope === 'global' && p[0] === 'researchPricing') {
    if (p.length === 3 && p[1] === 'renewal' && p[2] === 'retention') return [0,1,'fraction'];
    if (p.length === 3 && p[1] === 'renewal' && p[2] === 'rateMultiplier') return [0,3,'multiple'];
    if (p.length === 4 && p[1] === 'spot' && p[2] === 'rates' && /^20\d{2}$/.test(p[3])) return [0.000001,100,'USD/GPU-hour'];
    if (p.length === 4 && p[1] === 'curve' && /^20\d{2}$/.test(p[2]) && /^(1|2|3|5|6)$/.test(p[3])) return [0.000001,100,'USD million/IT MW/year'];
    if (p.length === 3 && p[1] === 'generationFactors' && ['hopper','blackwell','rubin','next'].includes(p[2])) return [0.000001,5,'multiple'];
  }
  throw new Error('field is outside the numerical approval allow-list: ' + changeKey(c));
}
function locate(data, c) {
  let target = c.scope === 'global' ? data : data.companies.find(x => x.tk === c.ticker);
  if (!target) throw new Error('unknown ticker: ' + c.ticker);
  for (const k of c.path.slice(0,-1)) {
    if (!own(target,k) || typeof target[k] !== 'object' || target[k] === null || Array.isArray(target[k])) throw new Error('missing existing numerical path: ' + changeKey(c));
    target = target[k];
  }
  const key = c.path.at(-1);
  // This single optional scalar has a canonical implied value. Do not generalize
  // missing-path writes: a mixed-region signed book has no one current multiplier.
  if (c.scope === 'company' && c.path.length === 1 && key === 'signedRegionFactor') {
    if (target.model !== 'owner') throw new Error('signed-region factor requires an owner model');
    if (!own(target,key)) {
      const E = require('./engine.js').createEngine(data);
      const factors = [...new Set((target.sites || []).filter(s => E.siteRates(target,s).contractedRate > 0).map(s => E.signedRegionFactorOf(target,s)))];
      if (factors.length !== 1 || !Number.isFinite(factors[0])) throw new Error('signed-region factor requires one unambiguous current signed-site multiplier');
      return {target,key,value:factors[0]};
    }
  }
  if (!own(target,key) || typeof target[key] !== 'number' || !Number.isFinite(target[key])) throw new Error('field is not an existing finite number: ' + changeKey(c));
  return { target, key, value:target[key] };
}
function validateChanges(data, changes) {
  if (!Array.isArray(changes) || !changes.length || changes.length > 60) throw new Error('proposal requires 1–60 explicit numerical changes');
  const seen = [];
  for (const c of changes) {
    if (!c || !['company','global'].includes(c.scope) || !Array.isArray(c.path) || !c.path.length || c.path.some(k => typeof k !== 'string' || !/^[A-Za-z0-9_]+$/.test(k) || BAD_KEYS.has(k))) throw new Error('invalid numerical change path');
    if (Object.keys(c).some(k => !['scope','ticker','path','current','proposed','unit'].includes(k))) throw new Error('unsupported numerical change property');
    if (c.scope === 'global' && c.ticker != null) throw new Error('global change cannot specify a ticker');
    if (c.scope === 'company' && !data.companies.some(x => x.tk === c.ticker)) throw new Error('unknown company ticker');
    const rule = fieldRule(c), id = changeKey(c);
    if (c.scope === 'global' && c.path[0] === 'researchPricing' && c.path[1] === 'spot' && data.researchPricing?.spot?.basis !== 'per-gpu-hour') throw new Error('spot rate approval requires the actual per-gpu-hour policy basis; this policy uses different units');
    if (seen.some(k => k === id || k.startsWith(id + '.') || id.startsWith(k + '.'))) throw new Error('duplicate or overlapping numerical changes: ' + id);
    seen.push(id);
    if (!Number.isFinite(c.current) || !Number.isFinite(c.proposed) || c.current === c.proposed) throw new Error('change must contain different finite current/proposed numbers: ' + id);
    if (c.proposed < rule[0] || c.proposed > rule[1]) throw new Error('proposed number outside allowed range: ' + id);
    if (c.unit !== rule[2]) throw new Error('unit must be "' + rule[2] + '" for ' + id);
    const {value} = locate(data,c);
    if (value !== c.current) throw new Error('stale current value: ' + id + '; rebase and review again');
  }
}
function applyChanges(data, changes) {
  validateChanges(data,changes);
  const next = copy(data);
  for (const c of changes) { const {target,key} = locate(next,c); target[key] = c.proposed; }
  for (const c of next.companies.filter(c => c.page?.finance)) {
    const F = c.page.finance;
    if (F.DEBT0 < (F.CONV || 0)) throw new Error(c.tk + ': debt cannot be below convertible principal');
    if (F.SH0 <= (F.FWD || 0)) throw new Error(c.tk + ': opening shares must exceed prepaid-forward shares');
  }
  return next;
}
function affectedTickers(data, changes) {
  const affected = new Set(changes.filter(c => c.scope === 'company').map(c => c.ticker));
  if (changes.some(c => c.scope === 'global')) data.companies.filter(c => c.ramp && c.page).forEach(c => affected.add(c.tk));
  let n;
  do { n = affected.size; data.companies.filter(c => c.stake && affected.has(c.stake.tk)).forEach(c => affected.add(c.tk)); } while (affected.size !== n);
  return [...affected].sort();
}
function normalizeMarks(snapshot) { return copy(snapshot?.marks || snapshot || {}); }
function markedEngine(data, marks) {
  const E = require('./engine.js').createEngine(data);
  E.ctx.prices = copy(marks.prices || {}); E.ctx.btc = marks.btc || null; E.ctx.eth = marks.eth || null;
  return E;
}
function researchMetrics(m) {
  const w=m.W;
  return { revenueRunRateBn:m.rr, enterpriseValueBn:w.ev, cashBn:w.last.cash, netDebtExConvertsBn:w.last.nd,
    dilutedSharesM:w.dil, financingEquityBn:w.eqTot, convertibleSharesM:w.convSh, prepaymentLiabilityBn:w.liab };
}
function assetMetrics(v) { return {enterpriseValueM:v.ev,seniorClaimsM:v.claims,equityM:v.equity,dilutedSharesM:v.fundedShares,financingEquityM:v.equityRaise}; }
function finiteTree(value, label) {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('non-finite model result: ' + label);
  if (value && typeof value === 'object') for (const [k,v] of Object.entries(value)) finiteTree(v,label + '.' + k);
}
function evaluateImpact(data, next, changes, snapshot) {
  const marks=normalizeMarks(snapshot), E0=markedEngine(data,marks), E1=markedEngine(next,marks), {assemble}=require('./onepager.js');
  return affectedTickers(data,changes).map(ticker => {
    const c0=data.companies.find(c=>c.tk===ticker), c1=next.companies.find(c=>c.tk===ticker);
    const a0=E0.value(c0), a1=E1.value(c1), research=!!(c0.ramp && c0.page);
    const m0=research ? assemble(c0,data.researchPricing) : null, m1=research ? assemble(c1,next.researchPricing) : null;
    const base=research?m0.W.ps:a0.target, proposed=research?m1.W.ps:a1.target;
    const row={ticker,modelBasis:research?'Canonical quarterly research waterfall':'Canonical asset valuation',unit:'USD/share',base,proposed,
      delta:proposed-base,pct:base===0?null:(proposed-base)/Math.abs(base)*100,
      baseMetrics:research?researchMetrics(m0):assetMetrics(a0),proposedMetrics:research?researchMetrics(m1):assetMetrics(a1),
      quoteBasis:{price:E0.priceOf(c0),date:marks.priceDates?.[ticker]||null,source:marks.prices?.[ticker]>0?(marks.priceSources?.[ticker]||'market-prices.json'):'saved company price fallback',
        financingPriceBase:research?m0.F.EQ_PX:E0.priceOf(c0),financingPriceProposed:research?m1.F.EQ_PX:E1.priceOf(c1),
        financingMethod:research?'Dated research issuance assumption; market refresh does not overwrite it':'Share issuance at shared market mark'}};
    if(research) row.assetAlternative={label:'Supplemental asset model; not the displayed research value',base:a0.target,proposed:a1.target,delta:a1.target-a0.target};
    finiteTree(row,ticker); return row;
  });
}
function validCalendarDate(date) {
  if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date))return false;
  const parsed=new Date(date+'T00:00:00Z');
  return Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===date;
}
function findingLinks(input) {
  const valid=id=>typeof id==='string'&&/^[A-Za-z0-9_.:|/-]{1,160}$/.test(id)&&!['__proto__','constructor','prototype'].includes(id);
  if(input.findingId!==undefined&&!valid(input.findingId))throw new Error('invalid linked finding id');
  if(input.findingIds!==undefined&&(!Array.isArray(input.findingIds)||!input.findingIds.length||input.findingIds.length>60||input.findingIds.some(id=>!valid(id))||new Set(input.findingIds).size!==input.findingIds.length))throw new Error('findingIds must contain 1–60 unique valid finding ids');
  return {...(input.findingId!==undefined?{findingId:input.findingId}:{}),...(input.findingIds!==undefined?{findingIds:copy(input.findingIds)}:{})};
}
function evidenceValid(input,today=new Date().toISOString().slice(0,10)) {
  if (typeof input.title !== 'string' || !input.title.trim() || input.title.length>240) throw new Error('a concise proposal title is required');
  if (typeof input.basis !== 'string' || input.basis.trim().length < 20 || input.basis.length > 12000) throw new Error('a substantive evidence-based rationale is required');
  if (!Array.isArray(input.evidence) || !input.evidence.length || input.evidence.length>30) throw new Error('at least one evidence source is required');
  for (const e of input.evidence) {
    let u; try { u=new URL(e.url); } catch { throw new Error('evidence requires a valid source URL'); }
    if (!['http:','https:'].includes(u.protocol) || u.username || u.password) throw new Error('evidence URL must be public HTTP(S)');
    if (![e.quote,e.sourceName,e.title,e.claim].some(v=>typeof v==='string' && v.trim())) throw new Error('evidence must identify what the source supports');
    if(e.date!==undefined && (!validCalendarDate(e.date)||e.date>today)) throw new Error('evidence date must be a real calendar date on or before the review date');
  }
}
function checkFailures(data) { return require('./checks-core.js').runChecks(data).msgs.filter(m=>m.level==='fail').map(m=>`${m.group}|${m.tk}|${m.level}|${m.msg}`); }
function noNewFailures(data,next) {
  const before=new Set(checkFailures(data)), introduced=checkFailures(next).filter(x=>!before.has(x));
  if(introduced.length) throw new Error('would introduce check failures: ' + introduced.slice(0,3).join('; '));
  // The economic reviewer can expose hard model failures absent from the legacy
  // structural checks (for example, out-of-money convertibles disappearing from
  // both debt and dilution). Compare stable finding IDs, not changing prose/amounts.
  const analyze=require('./assumption-core.cjs').analyze;
  const asOf=new Date().toISOString().slice(0,10);
  const hard=d=>analyze(d,{}, {asOf}).findings.filter(f=>f.severity==='error').map(f=>f.id);
  const prior=new Set(hard(data)), added=hard(next).filter(id=>!prior.has(id));
  if(added.length)throw new Error('would introduce economic model errors: '+added.join('; '));
}
function proposalFingerprint(p) { return hashes().hashJSON({kind:'assumption',changes:p.changes,basis:p.basis,evidence:p.evidence}); }
function draftProposal(input, options={}) {
  const root=options.root||ROOT, data=options.data||JSON.parse(fs.readFileSync(path.join(root,'data.json'),'utf8'));
  const snapshot=options.marks||JSON.parse(fs.readFileSync(path.join(root,'market-prices.json'),'utf8'));
  evidenceValid(input,options.today); const links=findingLinks(input), next=applyChanges(data,input.changes); noNewFailures(data,next);
  const changes=copy(input.changes), tickers=affectedTickers(data,changes), fp=proposalFingerprint({...input,basis:input.basis.trim(),changes});
  const impact=evaluateImpact(data,next,changes,snapshot), quoteBasis=normalizeMarks(snapshot);
  const p={id:input.id||'assumption-'+fp.slice(0,16),fp,kind:'assumption',tk:changes.some(c=>c.scope==='global')||tickers.length!==1?'ALL':tickers[0],title:input.title.trim(),
    created:options.today||new Date().toISOString().slice(0,10),sourceName:'Assumption Review',status:'pending',changes,basis:input.basis.trim(),evidence:copy(input.evidence),
    review:{sourceHash:hashes().hashJSON(data),modelHash:hashes().modelHash(root),ruleVersion:RULE_VERSION,impact,quoteBasis,quoteHash:hashes().hashJSON(snapshot),
      quoteTolerance:{economicMetricRelative:0.005,economicMetricAbsolute:0.000001},impactHash:hashes().hashJSON(impact)}};
  if(!/^[A-Za-z0-9_-]{1,100}$/.test(p.id)) throw new Error('invalid proposal id');
  Object.assign(p,links);
  return p;
}
function impactComparable(rows) {
  return rows.map(r=>({ticker:r.ticker,modelBasis:r.modelBasis,base:r.base,proposed:r.proposed,delta:r.delta,pct:r.pct,baseMetrics:r.baseMetrics,proposedMetrics:r.proposedMetrics,assetAlternative:r.assetAlternative}));
}
function assertMatchingImpact(expected,actual,material=false) {
  function compare(a,b,p) {
    if(typeof a==='number' && typeof b==='number') {
      const tolerance=material?Math.max(0.000001,Math.abs(a)*0.005):1e-9*Math.max(1,Math.abs(a));
      if(Math.abs(a-b)>tolerance) throw new Error('impact changed since review ('+p+'); refresh the proposal');
    } else if(a && typeof a==='object' && b && typeof b==='object') {
      if(Object.keys(a).length!==Object.keys(b).length) throw new Error('impact preview shape changed');
      for(const k of Object.keys(a))compare(a[k],b[k],p+'.'+k);
    } else if(a!==b) throw new Error('impact preview changed ('+p+')');
  }
  compare(impactComparable(expected),impactComparable(actual),'impact');
}
function validateProposal(p,options={}) {
  const root=options.root||ROOT, data=options.data||JSON.parse(fs.readFileSync(path.join(root,'data.json'),'utf8'));
  const marks=options.marks||JSON.parse(fs.readFileSync(path.join(root,'market-prices.json'),'utf8'));
  if(p.kind!=='assumption')throw new Error('not a numerical assumption proposal');
  evidenceValid(p,options.today); findingLinks(p);
  if(p.fp!==proposalFingerprint(p))throw new Error('proposal fingerprint does not match its change and evidence');
  if(p.review?.ruleVersion!==RULE_VERSION)throw new Error('numerical approval rule changed; draft a fresh proposal');
  if(p.review.sourceHash!==hashes().hashJSON(data))throw new Error('source inputs changed since review; draft a fresh proposal');
  if(p.review.modelHash!==hashes().modelHash(root))throw new Error('valuation or review code changed since review; draft a fresh proposal');
  const next=applyChanges(data,p.changes); noNewFailures(data,next);
  if(!Array.isArray(p.review.impact) || p.review.impactHash!==hashes().hashJSON(p.review.impact))throw new Error('invalid impact preview');
  const expected=evaluateImpact(data,next,p.changes,p.review.quoteBasis);
  assertMatchingImpact(p.review.impact,expected);
  const liveImpact=evaluateImpact(data,next,p.changes,marks);
  assertMatchingImpact(p.review.impact,liveImpact,true);
  const tickers=affectedTickers(data,p.changes), tk=p.changes.some(c=>c.scope==='global')||tickers.length!==1?'ALL':tickers[0];
  if(p.tk!==tk)throw new Error('proposal company scope does not match the change');
  return {next,impact:liveImpact};
}
function enqueueProposal(queue,p) {
  const P=copy(queue);
  const duplicate=(P.items||[]).find(x=>x.id===p.id||x.fp===p.fp);
  if(duplicate)throw new Error('proposal already exists ('+duplicate.status+'): '+duplicate.id);
  if((P.seen||[]).some(x=>x===p.fp || x?.fp===p.fp))throw new Error('proposal fingerprint has already been reviewed');
  P.items=P.items||[]; P.items.push(p); return P;
}
module.exports={RULE_VERSION,COMPANY_FIELDS,FINANCE_FIELDS,fieldRule,changeKey,validateChanges,applyChanges,affectedTickers,evaluateImpact,draftProposal,validateProposal,enqueueProposal,noNewFailures,assertMatchingImpact,proposalFingerprint};
if(require.main===module) {
  try {
    const args=process.argv.slice(2), at=args.indexOf('--input');
    if(at<0||!args[at+1]||args.some((a,i)=>!['--input','--check','--dryrun'].includes(a)&&i!==at+1))throw new Error('usage: node assumption-proposals.cjs --input proposal.json [--check|--dryrun]');
    const input=JSON.parse(fs.readFileSync(path.resolve(args[at+1]),'utf8')), p=draftProposal(input), filename=path.join(ROOT,'proposals.json');
    const queue=JSON.parse(fs.readFileSync(filename,'utf8')), next=enqueueProposal(queue,p);
    if(args.includes('--check')||args.includes('--dryrun'))console.log(JSON.stringify(p,null,2));
    else { fs.writeFileSync(filename,require('./approvals-core.js').serialize(next)); console.log('Drafted '+p.id+' for owner review. Model assumptions are unchanged.'); }
  } catch(e) {console.error(e.message); process.exitCode=1;}
}
