/* Shared research payloads and market references. Canonical reports are never mutated by
   quotes. Their dated cash-flow values supply the preferred summary values for these names. */
(function(root){
  'use strict';
  const TICKERS=['IREN','CRWV','NBIS'], entries={};
  const usable=x=>typeof x==='number'&&Number.isFinite(x)&&x>0;
  const validDate=x=>typeof x==='string'&&/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(x)&&Number.isFinite(Date.parse(x));
  const clock=x=>validDate(x)?new Date(x).toLocaleString('en-US',{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',timeZone:'America/New_York',timeZoneName:'short'}):'time unavailable';
  const supports=tk=>TICKERS.includes(tk);
  function load(tk){
    if(!supports(tk))return Promise.reject(new Error('No preferred research model for '+tk));
    const old=entries[tk];
    if(old?.P)return Promise.resolve(old.P);
    if(old?.pending)return old.pending;
    const st=entries[tk]={P:null,error:null,pending:null,base:null};
    const controller=typeof AbortController==='function'?new AbortController():null;
    const timer=controller?setTimeout(()=>controller.abort(),15000):null;
    st.pending=fetch('/'+tk.toLowerCase()+'-data.json',{cache:'no-store',...(controller?{signal:controller.signal}:{})})
      .then(r=>{if(!r.ok)throw new Error(tk+' research returned HTTP '+r.status);return r.json();})
      .then(P=>{
        if(P?.tk!==tk||!Array.isArray(P.L)||!P.CAPQ||!P.finance||!root.OnePager)throw new Error(tk+' research data is incomplete');
        const base=root.OnePager.waterfall(P.L,P.CAPQ,P.finance,P.ARRC);
        if(!Number.isFinite(base.ps))throw new Error(tk+' research value is unavailable');
        st.P=P;st.base=base;return P;
      }).catch(e=>{st.error=e.message||'Research unavailable';throw e;})
      .finally(()=>{if(timer)clearTimeout(timer);st.pending=null;});
    return st.pending;
  }
  const get=tk=>entries[tk]?.P||null;
  function reference(tk){
    const P=get(tk),c=root.CloudModel?.source?.companies?.find(c=>c.tk===tk),marks=root.CloudModel?.marks||{};
    if(usable(marks.prices?.[tk])){
      const rawDate=marks.priceDates?.[tk],asOf=validDate(rawDate)&&Date.parse(rawDate)<=Date.now()+300000?rawDate:null;
      const fetchedAt=marks.priceFetchedAt?.[tk]||null,source=marks.priceSources?.[tk]||'Market quote';
      const quoteState=root.Quotes?.status,failed=quoteState?.failedTickers?.includes(tk);
      const current=!failed&&!quoteState?.fromCache&&asOf&&validDate(fetchedAt)&&Date.now()-Date.parse(fetchedAt)<30*60000&&Date.parse(fetchedAt)<=Date.now()+300000;
      return {value:marks.prices[tk],asOf,source,fetchedAt,status:current?'market':'cached',
        label:(current?'':'Cached ')+source+' · '+(asOf?clock(asOf):'quote time unavailable')+(failed?' · refresh failed':'')};
    }
    const px=P?.px||c?.page?.px,stamp=px?.asOf||P?.asOf||c?.page?.asOf||null;
    if(usable(px?.v))return {value:px.v,asOf:validDate(stamp)?stamp:null,source:'Research snapshot',fetchedAt:null,status:'snapshot',
      label:'Saved reference · '+(validDate(stamp)?stamp:'date unavailable')+' · market refresh unavailable'};
    const price=c?.price;
    return {value:usable(price)?price:null,asOf:null,source:'Saved source',fetchedAt:null,status:'unavailable',label:usable(price)?'Saved price · quote date unavailable':'Market price unavailable'};
  }
  function displayPayload(tk){
    const P=get(tk);if(!P)return null;
    const ref=reference(tk);
    return {...P,px:{...P.px,v:ref.value,note:ref.label,asOf:ref.asOf},priceReference:ref};
  }
  function summaryCompany(c){
    const ref=reference(c.ticker);
    const price=usable(ref.value)?ref.value:c.price;
    if(!supports(c.ticker))return {...c,price,priceAsOf:ref.asOf,priceReference:ref,upside:Number.isFinite(c.target)&&price>0?c.target/price-1:null,summaryBasis:'Asset model',summaryHref:'/company/'+c.ticker};
    const st=entries[c.ticker],P=st?.P,target=st?.base?.ps;
    return {...c,price,priceAsOf:ref.asOf,priceReference:ref,target:Number.isFinite(target)?target:null,floor:null,
      upside:Number.isFinite(target)&&price>0?target/price-1:null,summaryBasis:'Research DCF',summaryHref:'/'+c.ticker.toLowerCase(),
      modelAsOf:P?.modelAsOf||P?.pricing?.asOf||P?.asOf||null,researchStatus:P?'ready':st?.error?'unavailable':'loading',researchError:st?.error||null};
  }
  root.ResearchData={tickers:TICKERS.slice(),supports,load,get,reference,displayPayload,summaryCompany,
    value:tk=>entries[tk]?.base?.ps??null,status:tk=>({loaded:!!entries[tk]?.P,error:entries[tk]?.error||null})};
})(typeof window!=='undefined'?window:globalThis);
