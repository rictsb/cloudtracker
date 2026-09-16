/* Approvals decision core — ONE source of truth for the mutate + serialize step, run by both:
   - approvals-view.js (browser, the Approvals screen's commit builder)
   - the node byte-compat harness (CI/preview, no PAT, no browser)
   The serialized output is a byte contract with production (GPU Cloud and Colo Tracker/app.js:386-389):
   JSON.stringify(P, null, 1) + '\n' — 1-space indent plus trailing newline. The pushed commit is what
   triggers the apply-proposals Action (push paths filter on proposals.json); never fork or "tidy" it. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ApprovalsCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  /* Unicode-safe chunked base64 codec, ported verbatim from production app.js:376-377 —
     evidence quotes carry curly quotes and em-dashes that naive btoa corrupts. */
  function b64enc(str) { const b = new TextEncoder().encode(str); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); }
  function b64dec(b64) { const s = atob(b64.replace(/\n/g, '')); const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return new TextDecoder().decode(b); }

  /* Returns a NEW file object with exactly two fields changed on the one item: status, and
     decided = todayISO. fp, seen[], asOf, item order and every other field round-trip untouched —
     that is what keeps the Spark's fingerprint-based rejected-proposal suppression working.
     JSON round-trip copy preserves key order (the file is pure JSON), so serialization is stable. */
  function decisionIdentity(p) {
    return JSON.stringify({ fp:p.fp, kind:p.kind, tk:p.tk, title:p.title, current:p.current, proposed:p.proposed, changes:p.changes, basis:p.basis, evidence:p.evidence, review:p.review, findingId:p.findingId, findingIds:p.findingIds });
  }
  function validDate(value) { return /^\d{4}-\d{2}-\d{2}$/.test(value || '') && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value; }
  function mutate(fileObj, id, status, todayISO, expectedIdentity) {
    if (!['accepted', 'rejected'].includes(status)) throw new Error('invalid proposal decision');
    if (!validDate(todayISO)) throw new Error('invalid decision date');
    const P = JSON.parse(JSON.stringify(fileObj));
    const it = (P.items || []).find(x => x.id === id);
    if (!it) throw new Error('proposal not found on main any more');
    if (it.status !== 'pending' || it.applied) throw new Error('proposal is no longer pending — reload the queue');
    if (expectedIdentity != null && decisionIdentity(it) !== expectedIdentity) throw new Error('proposal changed since you reviewed it — reload the queue');
    if (it.kind === 'assumption' && (!it.review?.sourceHash || !it.review?.modelHash || !it.review?.ruleVersion || !Array.isArray(it.review.impact) || !it.review.impact.length)) throw new Error('numerical proposal has no validated impact preview');
    it.status = status;
    it.decided = todayISO;
    return P;
  }

  /* Byte contract with production app.js:389 — do not change the indent or the trailing newline. */
  function serialize(fileObj) {
    return JSON.stringify(fileObj, null, 1) + '\n';
  }

  /* The full local half of a decision: what the Contents-API PUT body would carry.
     message matches production app.js:389 exactly; content is base64 of the serialized bytes. */
  function buildCommit(fileObj, id, status, today, expectedIdentity) {
    const mutated = mutate(fileObj, id, status, today, expectedIdentity);
    return {
      message: 'proposals: ' + id + ' ' + status + ' (Approvals screen)',
      content: b64enc(serialize(mutated)),
      mutated
    };
  }

  function recordReview(fileObj, findingId, review, expectedReview) {
    if (typeof findingId !== 'string' || !/^[A-Za-z0-9_.:|/-]{1,160}$/.test(findingId) || ['__proto__','constructor','prototype'].includes(findingId)) throw new Error('invalid finding id');
    if (!review || !['research', 'kept'].includes(review.status)) throw new Error('invalid review status');
    if (typeof review.fingerprint !== 'string' || !/^[A-Za-z0-9_.:-]{8,160}$/.test(review.fingerprint)) throw new Error('invalid finding fingerprint');
    if (typeof review.reason !== 'string' || !review.reason.trim() || review.reason.length > 4000) throw new Error('a review rationale is required (maximum 4,000 characters)');
    const updatedAt = review.updatedAt || new Date().toISOString();
    if (!Number.isFinite(Date.parse(updatedAt))) throw new Error('invalid review update date');
    const today = new Date(updatedAt).toISOString().slice(0,10);
    const after = review.reviewAfter || new Date(Date.parse(today + 'T00:00:00Z') + (review.status === 'kept' ? 30 : 7) * 86400000).toISOString().slice(0,10);
    if (!validDate(after) || after <= today || Date.parse(after) - Date.parse(today) > 90 * 86400000) throw new Error('review date must be in the next 90 days');
    const P = JSON.parse(JSON.stringify(fileObj));
    const previous = P.assumptionReviews?.[findingId] || null;
    if (expectedReview !== undefined && JSON.stringify(previous) !== JSON.stringify(expectedReview)) throw new Error('finding decision changed — reload before saving');
    P.assumptionReviews = P.assumptionReviews || {};
    P.assumptionReviews[findingId] = { fingerprint:review.fingerprint, status:review.status, reason:review.reason.trim(), reviewAfter:after, updatedAt };
    return P;
  }
  function buildReviewCommit(fileObj, findingId, review, expectedReview) {
    const mutated = recordReview(fileObj, findingId, review, expectedReview);
    return { message:'assumptions: ' + findingId + ' ' + review.status + ' (Assumption Review)', content:b64enc(serialize(mutated)), mutated };
  }

  return { mutate, serialize, b64enc, b64dec, buildCommit, decisionIdentity, recordReview, buildReviewCommit };
});
