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
  function mutate(fileObj, id, status, todayISO) {
    const P = JSON.parse(JSON.stringify(fileObj));
    const it = (P.items || []).find(x => x.id === id);
    if (!it) throw new Error('proposal not found on main any more');
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
  function buildCommit(fileObj, id, status, today) {
    const mutated = mutate(fileObj, id, status, today);
    return {
      message: 'proposals: ' + id + ' ' + status + ' (Approvals screen)',
      content: b64enc(serialize(mutated)),
      mutated
    };
  }

  return { mutate, serialize, b64enc, b64dec, buildCommit };
});
