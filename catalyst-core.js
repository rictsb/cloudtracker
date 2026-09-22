/* Catalyst board math (spec §6 screen 8) — ONE source of truth, shared by the browser
   (research-view.js) and node (checks.js). Never fork it.
   A catalyst row describes a FUTURE event as a change to the tracker's inputs (`impact`);
   the engine prices that change. The board ranks by  prob × |Δtarget| × (1 − priced).
   Judgement only — nothing here feeds the valuation or the paper portfolio. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CatalystCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  const KINDS = ['lease', 'contract', 'power', 'energization', 'financing', 'jv', 'site', 'regulatory', 'earnings', 'other'];
  const OPS = ['prov', 'lease', 'energize', 'site', 'raise', 'debt', 'tier', 'multi'];
  const PROVS = ['disclosed', 'estimated'];

  const clone = v => JSON.parse(JSON.stringify(v));
  const findSite = (c, key) => {
    const k = String(key || '').toLowerCase();
    return (c.sites || []).find(s => String(s.n || '').toLowerCase().includes(k)) || null;
  };

  // Apply ONE op to a company copy. Returns an error string, or null when applied.
  function applyOp(c, op, cfg) {
    if (!op || typeof op !== 'object') return 'impact op missing';
    switch (op.op) {
      case 'prov': {
        const s = findSite(c, op.site); if (!s) return 'no site matches "' + op.site + '"';
        if (!PROVS.includes(op.to)) return 'prov.to must be disclosed|estimated';
        s.prov = op.to; return null;
      }
      case 'energize': {
        const s = findSite(c, op.site); if (!s) return 'no site matches "' + op.site + '"';
        if (!(op.yr >= 2024 && op.yr <= 2040)) return 'energize.yr out of range';
        s.yr = op.yr; s.mo = (op.mo >= 1 && op.mo <= 12) ? op.mo : 1; return null;
      }
      case 'lease': {
        const s = findSite(c, op.site); if (!s) return 'no site matches "' + op.site + '"';
        const mw = op.mw > 0 ? Math.min(op.mw, s.mw) : s.mw;
        if (s.prov === 'rumored') s.prov = 'estimated';                 // a signed counterparty makes the concrete real
        if (c.model === 'landlord') {
          // Signed regime: term-average NOI print if given, else the market anchor × region × owned/leased (no size/lease-up — the print replaces them)
          const r = cfg.regions[s.region] || { lNOI: 1 };
          const noi = op.noiPerMWyr > 0 ? op.noiPerMWyr : cfg.constants.landlordNOI * r.lNOI * (s.owned ? cfg.constants.ownedLNOI : cfg.constants.leasedLNOI);
          const id = 'cat-' + Math.random().toString(36).slice(2, 8);
          c.leases = (c.leases || []).concat([{ id, counterparty: op.counterparty || 'catalyst', mw, termYrs: op.termYrs || 10, noiPerMWyr: noi, kind: 'build-to-spec', effective: true, signed: 'catalyst' }]);
          if (mw < s.mw) {                                               // split the row: leased slice + the remainder stays forward space
            const rest = clone(s); rest.mw = s.mw - mw; rest.n = s.n + ' (unleased remainder)';
            s.mw = mw; c.sites.push(rest);
          }
          s.leaseId = id;
          const leasedMW = c.sites.filter(x => x.leaseId).reduce((a, x) => a + x.mw, 0), totMW = c.sites.reduce((a, x) => a + x.mw, 0);
          c.contractedPct = totMW > 0 ? Math.min(100, Math.round(100 * leasedMW / totMW)) : c.contractedPct;
        } else {
          const totMW = c.sites.filter(x => x.prov !== 'rumored').reduce((a, x) => a + x.mw, 0);
          if (totMW > 0) c.contractedPct = Math.min(100, (c.contractedPct || 0) + 100 * mw / totMW);
        }
        return null;
      }
      case 'site': {
        if (!(op.mw > 0)) return 'site.mw must be > 0';
        if (!cfg.regions[op.region]) return 'site.region unknown';
        if (!cfg.provenance[op.prov]) return 'site.prov unknown';
        if (!(op.yr >= 2024 && op.yr <= 2040)) return 'site.yr out of range';
        c.sites.push({ n: op.n || 'catalyst site', mw: op.mw, owned: op.owned !== false, region: op.region, yr: op.yr, mo: (op.mo >= 1 && op.mo <= 12) ? op.mo : 1, prov: op.prov, physMW: op.physMW });
        return null;
      }
      case 'raise': {
        // +sizeM = more equity to issue; −sizeM = planned equity DISPLACED (e.g. by a debt facility), floored at zero
        if (!Number.isFinite(op.sizeM) || op.sizeM === 0) return 'raise.sizeM must be a non-zero number';
        c.plannedRaise = Math.max(0, (c.plannedRaise || 0) + op.sizeM); return null;
      }
      case 'debt': {
        if (!Number.isFinite(op.deltaM)) return 'debt.deltaM must be a number';
        c.netDebt = (c.netDebt || 0) + op.deltaM; return null;
      }
      case 'tier': {
        if (!cfg.tiers[op.to]) return 'tier.to unknown';
        c.tier = op.to; return null;
      }
      case 'multi': {
        if (!Array.isArray(op.ops) || !op.ops.length) return 'multi.ops empty';
        for (const sub of op.ops) { const e = applyOp(c, sub, cfg); if (e) return e; }
        return null;
      }
      default: return 'unknown op "' + op.op + '"';
    }
  }

  // Price a row: build a mutated copy of the company inside a copy of the data, value both with the same
  // engine factory, dials and live marks. Returns {target0, target1, delta, pct, floor0, floor1, dfloor, score, error}
  // (target = headline; floor = the signed-only execution floor — a lease moves the floor even when leaseUp=1 leaves the target still).
  function impactOf(Engine, data, row, opts) {
    opts = opts || {};
    const c0 = (data.companies || []).find(x => x.tk === row.tk);
    if (!c0) return { error: 'unknown ticker ' + row.tk };
    const build = companies => {
      const e = Engine.createEngine({ ...data, companies }, { now: opts.now });
      if (opts.dials) Object.keys(opts.dials).forEach(k => { if (k in e.BASE) e.A[k] = opts.dials[k]; });
      if (opts.prices) Object.assign(e.ctx.prices, opts.prices);
      if (opts.btc != null) e.ctx.btc = opts.btc;
      if (opts.eth != null) e.ctx.eth = opts.eth;
      return e;
    };
    const e0 = build(data.companies);
    const v0 = e0.value(e0.COMPANIES.find(x => x.tk === row.tk));
    const out = { target0: v0.target, price: v0.price, target1: v0.target, delta: 0, pct: 0, floor0: v0.floorTarget, floor1: v0.floorTarget, dfloor: 0, error: null };
    if (row.impact == null) { out.score = 0; return out; }
    const companies = clone(data.companies);
    const c1 = companies.find(x => x.tk === row.tk);
    const err = applyOp(c1, row.impact, data.config);
    if (err) return { ...out, error: err };
    const e1 = build(companies);
    const v1 = e1.value(e1.COMPANIES.find(x => x.tk === row.tk));
    out.target1 = v1.target; out.delta = v1.target - v0.target;
    out.floor1 = v1.floorTarget; out.dfloor = v1.floorTarget - v0.floorTarget;
    out.pct = v0.target > 0 ? out.delta / v0.target : 0;
    out.score = score(row, out);
    return out;
  }

  // Ranking score: probability × (the larger of |Δtarget|, |Δfloor|) ÷ price × (1 − priced). Measured against
  // PRICE, not target, so a name trading far from its target is not flattered by a small target; the floor
  // enters so a de-risking lease ranks even when the scarcity thesis (leaseUp 1.0) leaves the headline still.
  function score(row, imp) {
    const p = Math.max(0, Math.min(100, row.prob || 0)) / 100;
    const priced = Math.max(0, Math.min(100, row.priced || 0)) / 100;
    const move = imp && imp.price > 0 ? Math.max(Math.abs(imp.delta || 0), Math.abs(imp.dfloor || 0)) / imp.price : 0;
    return p * move * (1 - priced);
  }

  // Structural validation (no engine): returns an array of error strings.
  function validate(row, data) {
    const errs = [];
    if (!row || typeof row !== 'object') return ['row is not an object'];
    if (!(data.companies || []).some(c => c.tk === row.tk)) errs.push('unknown ticker ' + row.tk);
    if (!/^[a-z0-9-]+$/.test(String(row.id || ''))) errs.push('id must be a slug');
    if (!KINDS.includes(row.kind)) errs.push('kind "' + row.kind + '" not in ' + KINDS.join('|'));
    if (!row.title) errs.push('title missing');
    if (!(row.prob >= 0 && row.prob <= 100)) errs.push('prob out of 0-100');
    if (!(row.priced >= 0 && row.priced <= 100)) errs.push('priced out of 0-100');
    if (!row.window) errs.push('window missing');
    if (row.by != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(row.by))) errs.push('by is not an ISO date');
    if (!Array.isArray(row.drivers) || !row.drivers.length) errs.push('no evidence drivers');
    if (!Array.isArray(row.sources) || !row.sources.length) errs.push('no sources');
    else { const ids = (data.sources || []).map(s => s.id); row.sources.forEach(s => { if (!ids.includes(s)) errs.push('source "' + s + '" not in registry'); }); }
    if (row.impact != null && (typeof row.impact !== 'object' || !OPS.includes(row.impact.op))) errs.push('impact.op not in ' + OPS.join('|'));
    return errs;
  }

  return { KINDS, OPS, applyOp, impactOf, score, validate };
});
