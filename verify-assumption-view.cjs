'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { hashJSON } = require('./assumption-review.cjs');
const { recordResearch } = require('./assumption-research.cjs');
const data = JSON.parse(fs.readFileSync(__dirname + '/data.json'));
const quotes = { checkedAt: new Date().toISOString(), marks: { prices: { CRWV: 80 } } };
const clone = x => JSON.parse(JSON.stringify(x));
const finding = { id: 'CRWV:test', ticker: 'CRWV', fingerprint: 'abc', family: 'economics', severity: 'review', title: 'Pricing needs evidence', explanation: '<script>bad()</script>', calculation: '10 / 2 = 5', evidence: [{ label: 'Unsafe', url: 'javascript:alert(1)' }], nextAction: 'Verify the pricing evidence', impact: { base: 100, alternative: 60, delta: -40, pct: -40, label: 'Illustrative stress', basis: 'Sensitivity' } };
const fixture = { schemaVersion: 1, status: 'ready', checkedAt: new Date().toISOString(), ruleVersion: 'test', sourceHash: hashJSON(data), quoteHash: hashJSON(quotes), summary: { errors: 0, reviews: 1, gaps: 1 }, companies: [{ ticker: 'CRWV', modelBasis: 'Research', tests: {} }], findings: [finding, { ...finding, id: 'CRWV:gap', severity: 'gap', title: 'Missing independent data', impact: null }] };
async function harness(snapshot = fixture, opts = {}) {
  const calls = [], handlers = {};
  let updates = 0;
  const ctx = vm.createContext({ console, URL, URLSearchParams, Date, TextEncoder, Uint8Array, crypto: webcrypto, setTimeout, clearTimeout, btoa, atob,
    location: { pathname: '/research/assumptions', search: opts.dry ? '?dryrun=1' : '' },
    localStorage: { getItem: () => opts.token ? 'fixture-token' : '' },
    document: { addEventListener: (type, fn) => { handlers[type] = fn; }, getElementById: () => null },
    fetch: async (url, init = {}) => { calls.push({ url, method: init.method || 'GET' }); if (opts.failure && url === '/assumption-review.json') throw new Error('fixture outage'); return { ok: true, json: async () => clone(url === '/assumption-review.json' ? snapshot : url === '/proposals.json' ? { items: [] } : url === '/market-prices.json' ? quotes : data) }; },
    UI: { metric: (l, v, note) => `<div>${l}: ${v} ${note}</div>` }, CVApp: { refresh: () => { updates++; } }
  });
  ctx.window = ctx;
  vm.runInContext(fs.readFileSync(__dirname + '/assumption-view.js', 'utf8'), ctx);
  ctx.AssumptionView.render();
  for (let i = 0; i < 100 && !updates; i++) await new Promise(r => setTimeout(r, 5));
  assert.ok(updates, 'load settled');
  return { html: ctx.AssumptionView.render(), calls, ctx, handlers };
}
async function verifyProposalRefresh() {
  const calls = [], badges = [], handlers = {}, pendingFetches = [];
  let refreshes = 0;
  const ctx = vm.createContext({ console, URL, URLSearchParams, Date,
    location: { pathname: '/approvals', search: '' },
    localStorage: { getItem: () => '' },
    document: { addEventListener: (type, fn) => { handlers[type] = fn; }, getElementById: () => null },
    fetch: (url, init = {}) => { calls.push({ url, ...init }); return new Promise(resolve => pendingFetches.push(resolve)); },
    CVApp: { refresh: () => { refreshes++; }, setPending: n => badges.push(n) }
  });
  ctx.window = ctx;
  vm.runInContext(fs.readFileSync(__dirname + '/approvals-view.js', 'utf8'), ctx);
  const clickRefresh = () => handlers.click({ target: { closest: sel => sel === '[data-ap-refresh]' ? {} : null } });
  const settle = async (queue, ok = true) => { pendingFetches.shift()({ ok, json: async () => clone(queue) }); await new Promise(r => setTimeout(r, 0)); };
  assert.match(ctx.ApprovalsView.render(), /data-ap-refresh="1" disabled aria-busy="true"/);
  clickRefresh(); ctx.ApprovalsView.render();
  assert.equal(calls.length, 1, 'initial load and repeated render cannot fetch duplicates');
  const note = { id: 'hive', tk: 'HIVE', kind: 'log', title: 'Existing research note', status: 'pending', created: '2026-09-16' };
  await settle({ asOf: '2026-09-16', items: [note] });
  assert.match(ctx.ApprovalsView.render(), /Refresh proposals<\/button>/);
  assert.equal(badges.at(-1), 1);
  clickRefresh(); clickRefresh();
  assert.equal(calls.length, 2, 'concurrent refresh clicks share one load');
  assert.match(ctx.ApprovalsView.render(), /Refreshing proposals/);
  const numerical = { id: 'shaz', tk: 'SHAZ', kind: 'assumption', title: 'Normalize signed geography', status: 'pending', created: '2026-09-16',
    changes: [{ scope: 'company', ticker: 'SHAZ', path: ['signedRegionFactor'], current: .7, proposed: 1, unit: 'multiplier' }], review: { impact: [] } };
  await settle({ asOf: '2026-09-16', items: [note, numerical] });
  const html = ctx.ApprovalsView.render();
  assert.match(html, /prop-shaz/); assert.match(html, /Signed-contract geography multiplier/);
  assert.match(html, /data-ap-id="shaz" disabled>Approve numerical change/);
  assert.equal(badges.at(-1), 2, 'refresh updates the pending badge from the new queue');
  clickRefresh(); await settle(null, false);
  assert.match(ctx.ApprovalsView.render(), /Could not load the proposal queue/);
  assert.ok(!ctx.ApprovalsView.render().includes('id="prop-shaz"'), 'failed refresh cannot present stale proposals as fresh');
  clickRefresh(); await settle({ asOf: '2026-09-16', items: [] });
  assert.match(ctx.ApprovalsView.render(), /Nothing waiting/);
  assert.equal(badges.at(-1), 0);
  assert.ok(refreshes >= 4, 'each completed load refreshes the view');
  assert.ok(calls.every(c => c.url === 'proposals.json' && c.cache === 'no-store' && !c.method), 'refresh only performs uncached published-queue GETs');
}
(async () => {
  await verifyProposalRefresh();
  const live = await harness(fixture, { token: true });
  assert.ok(live.html.includes('-40.0%') && !live.html.includes('-4,000'), 'percentage units retained');
  assert.ok(live.html.includes('&lt;script&gt;') && !live.html.includes('<script>bad'), 'finding content escaped');
  assert.ok(!live.html.includes('href="javascript:'), 'unsafe evidence link omitted');
  assert.ok(!live.html.includes('id="finding-CRWV:gap"'), 'gaps do not drown the default decision inbox');
  assert.ok(live.html.includes('Reviewed model and market snapshot match'), 'source identity verified');
  assert.equal(await live.ctx.AssumptionView.digest(data), hashJSON(data), 'browser/node source hashes agree');
  assert.ok(live.calls.every(c => c.method === 'GET'), 'loading makes no writes');
  const stale = await harness({ ...fixture, sourceHash: 'stale' }, { token: true });
  assert.ok(stale.html.includes('Model changes are awaiting review'));
  assert.ok(/data-ar-triage="research"[^>]*disabled/.test(stale.html), 'stale triage disabled');
  const staleQuote = await harness({ ...fixture, quoteHash: 'stale' }, { token: true });
  assert.ok(staleQuote.html.includes('New market quotes are awaiting review'));
  assert.ok(/data-ar-triage="research"[^>]*disabled/.test(staleQuote.html));
  for (const checkedAt of ['invalid', '2020-01-01T00:00:00Z', '2099-01-01T00:00:00Z']) {
    const old = await harness({ ...fixture, checkedAt }, { token: true });
    assert.ok(old.html.includes('Numerical review overdue'));
    assert.ok(/data-ar-triage="research"[^>]*disabled/.test(old.html));
  }
  const failed = await harness(fixture, { failure: true });
  assert.ok(failed.html.includes('No successful review is implied') && !failed.html.includes('Reviewed model and market snapshot match'));
  const errored = await harness({ ...fixture, status: 'error', error: 'Cannot calculate', checkedAt: null });
  assert.ok(errored.html.includes('last numerical review failed'));
  const dry = await harness(fixture, { dry: true });
  assert.ok(dry.html.includes('Decision preview') && dry.calls.every(c => c.method === 'GET'));
  const q = { items: [{ id: 'untouched' }], seen: ['keep'] }, before = JSON.stringify(q);
  const input = { scope: 'Focused evidence investigation', findings: [{ findingId: finding.id, fingerprint: finding.fingerprint, status: 'explained', conclusion: 'The compared records refer to different contract terms and cannot be combined.', sources: [{ label: 'Company filing', url: 'https://example.com/filing', date: '2026-09-15' }] }] };
  const r = recordResearch(q, fixture, input, '2026-09-16T12:00:00Z');
  assert.equal(JSON.stringify(q), before, 'research recorder does not mutate its input');
  assert.deepEqual(r.items, q.items); assert.deepEqual(r.seen, q.seen);
  assert.equal(r.assumptionResearch.reviewedFindingIds.length, 1);
  assert.throws(() => recordResearch(q, fixture, { ...input, findings: [{ ...input.findings[0], fingerprint: 'stale' }] }), /changed/);
  assert.throws(() => recordResearch(q, fixture, { ...input, findings: [{ ...input.findings[0], status: 'proposal-ready', proposalId: 'missing' }] }), /pending/);
  const ready = { ...input, findings: [{ ...input.findings[0], status: 'proposal-ready', proposalId: 'change-1' }] };
  const proposal = { id: 'change-1', kind: 'assumption', status: 'pending', findingIds: ['unrelated'] };
  assert.throws(() => recordResearch({ items: [proposal] }, fixture, ready), /linked/);
  assert.equal(recordResearch({ items: [{ ...proposal, findingIds: [finding.id] }] }, fixture, ready).assumptionResearch.findings[finding.id].proposalId, 'change-1');
  assert.throws(() => recordResearch(q, fixture, { ...input, findings: [{ ...input.findings[0], sources: [{ label: 'Bad', url: 'javascript:alert(1)' }] }] }), /public/);
  console.log('Assumption view and research recording: freshness, units, safety, coverage, proposal refresh and read-only loading passed.');
})().catch(e => { console.error(e); process.exitCode = 1; });
