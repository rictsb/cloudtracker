/* Offline shared-snapshot invariants and CLI exit/publication behavior. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { refreshSnapshot, validateSnapshot } = require('./quote-snapshot.cjs');

const START = Date.parse('2026-09-15T14:00:00Z'), HALF_HOUR = 1800000;
const TOKEN = 'offline-synthetic-token', TICKERS = ['IREN', 'CRWV', 'NBIS'];
const copy = value => JSON.parse(JSON.stringify(value));
const response = body => ({ ok: true, json: async () => body });
const provider = (time = START, overrides = {}) => async url => {
  const u = new URL(url);
  if (u.hostname === 'finnhub.io') {
    const tk = u.searchParams.get('symbol');
    assert.equal(u.searchParams.get('token'), TOKEN);
    return tk in overrides ? overrides[tk] : response({ c: { IREN: 50, CRWV: 100, NBIS: 75 }[tk] || 20, t: (time - 60000) / 1000 });
  }
  const asset = u.pathname.includes('BTC') ? 'btc' : 'eth';
  return asset in overrides ? overrides[asset] : response({ data: { amount: asset === 'btc' ? '100000' : '5000' } });
};
const options = (now = START, overrides = {}) => ({ tickers: TICKERS, token: TOKEN, now, fetch: provider(now, overrides) });
let count = 0;
async function check(name, fn) { await fn(); count++; console.log('PASS: ' + name); }

(async () => {
  const initial = await refreshSnapshot(null, options());
  await check('First snapshot is sourced, immutable, and separates quote and retrieval clocks', async () => {
    assert.equal(initial.status, 'ready'); assert.ok(validateSnapshot(initial, { now: START }));
    assert.equal(initial.marks.prices.IREN, 50);
    assert.equal(initial.marks.priceDates.IREN, '2026-09-15T13:59:00.000Z');
    assert.equal(initial.marks.priceFetchedAt.IREN, '2026-09-15T14:00:00.000Z');
    assert.equal(initial.marks.priceSources.IREN, 'Finnhub');
    assert.equal(initial.marks.cryptoDates.btc, initial.checkedAt);
    assert.equal(initial.marks.btc, 100000); assert.equal(initial.marks.eth, 5000);
    assert.ok(!JSON.stringify(initial).includes(TOKEN));
    const frozen = copy(initial); Object.freeze(initial.marks.prices); Object.freeze(initial);
    const next = await refreshSnapshot(initial, options(START + HALF_HOUR));
    assert.deepEqual(initial, frozen); assert.notEqual(next.marks, initial.marks);
  });
  await check('Partial failure retains each failed name and all of its clocks', async () => {
    const next = await refreshSnapshot(initial, options(START + HALF_HOUR, { IREN: { ok: false }, eth: response({ error: 'offline' }) }));
    assert.equal(next.status, 'partial'); assert.deepEqual(next.failedTickers, ['IREN']); assert.deepEqual(next.failedCrypto, ['eth']);
    for (const map of ['prices', 'priceDates', 'priceFetchedAt', 'priceSources']) assert.equal(next.marks[map].IREN, initial.marks[map].IREN);
    assert.equal(next.marks.cryptoDates.eth, initial.marks.cryptoDates.eth);
    assert.equal(next.marks.priceFetchedAt.CRWV, '2026-09-15T14:30:00.000Z');
    assert.ok(validateSnapshot(next, { now: START + HALF_HOUR }));
  });
  await check('All-feed failure advances only the check status and preserves last-good marks', async () => {
    const next = await refreshSnapshot(initial, { ...options(START + HALF_HOUR), fetch: async () => { throw new Error('provider failure ' + TOKEN); } });
    assert.equal(next.status, 'error'); assert.deepEqual(next.marks, initial.marks);
    assert.deepEqual(next.failedTickers, TICKERS); assert.deepEqual(next.failedCrypto, ['btc', 'eth']);
    assert.equal(next.checkedAt, '2026-09-15T14:30:00.000Z');
    assert.ok(!JSON.stringify(next).includes(TOKEN));
    const empty = await refreshSnapshot(null, { ...options(), fetch: async () => ({ ok: false }) });
    assert.equal(empty.status, 'error'); assert.equal(empty.marks.fetchedAt, null); assert.deepEqual(empty.marks.prices, {});
  });
  await check('Older and unknown provider times cannot erase newer known observations', async () => {
    const next = await refreshSnapshot(initial, options(START + HALF_HOUR, {
      IREN: response({ c: 2, t: (START - 120000) / 1000 }),
      CRWV: response({ c: 3, t: 0 }), NBIS: response({ c: 4, t: (START + 86400000) / 1000 })
    }));
    assert.deepEqual(next.failedTickers, TICKERS);
    for (const map of ['prices', 'priceDates', 'priceFetchedAt']) assert.deepEqual(next.marks[map], initial.marks[map]);
    const unknown = await refreshSnapshot(null, options(START, { IREN: response({ c: 70 }) }));
    assert.equal(unknown.marks.priceDates.IREN, null); assert.equal(unknown.marks.prices.IREN, 70);
  });
  await check('Closed-market repeated trade clock can be checked again without forging a new trade time', async () => {
    const next = await refreshSnapshot(initial, { ...options(START + HALF_HOUR), fetch: provider(START) });
    assert.equal(next.status, 'ready'); assert.equal(next.marks.priceDates.IREN, initial.marks.priceDates.IREN);
    assert.equal(next.marks.priceFetchedAt.IREN, '2026-09-15T14:30:00.000Z');
  });
  await check('Invalid prices and malformed provider responses never enter a snapshot', async () => {
    const next = await refreshSnapshot(initial, options(START + HALF_HOUR, {
      IREN: response({ c: Infinity, t: START / 1000 }), CRWV: response({ c: -1, t: START / 1000 }),
      NBIS: { ok: true, json: async () => { throw new Error(TOKEN); } },
      btc: response({ data: { amount: '999garbage' } }), eth: response({ data: { amount: '' } })
    }));
    assert.equal(next.status, 'error'); assert.deepEqual(next.marks, initial.marks);
  });
  await check('New universe is honored without mutating or retaining removed names', async () => {
    const next = await refreshSnapshot(initial, { ...options(START + HALF_HOUR), tickers: ['IREN', 'NEW'] });
    assert.deepEqual(Object.keys(next.marks.prices), ['IREN', 'NEW']); assert.deepEqual(next.universe, ['IREN', 'NEW']);
    assert.ok(validateSnapshot(next, { now: START + HALF_HOUR }));
  });
  await check('Credential and corrupt-snapshot failures stop before fetching', async () => {
    let fetched = false;
    await assert.rejects(() => refreshSnapshot(initial, { ...options(), token: '', fetch: async () => { fetched = true; } }), /FINNHUB_TOKEN is not configured/);
    assert.equal(fetched, false);
    const corrupt = copy(initial); corrupt.marks.priceDates.IREN = 'not-a-date';
    await assert.rejects(() => refreshSnapshot(corrupt, options()), /existing market-price snapshot is invalid/);
    await assert.rejects(() => refreshSnapshot(null, { ...options(), tickers: ['IREN', 'IREN'] }), /unique valid tickers/);
    await assert.rejects(() => refreshSnapshot(null, { ...options(), tickers: ['../IREN'] }), /unique valid tickers/);
    for (const change of [s => { s.marks.priceSources.IREN = 'Invented'; }, s => { s.marks.priceFetchedAt.IREN = null; },
      s => { s.checkedAt = '2026-09-16T14:00:00Z'; }, s => { s.failedCrypto = ['btc']; },
      s => { delete s.marks.prices.IREN; }, s => { s.status = 'partial'; }]) {
      const bad = copy(initial); change(bad); assert.equal(validateSnapshot(bad, { now: START }), false);
    }
  });
  await check('Provider requests are bounded to four in flight', async () => {
    let active = 0, peak = 0;
    const fetch = async (url, request) => {
      assert.ok(request.signal instanceof AbortSignal); active++; peak = Math.max(peak, active);
      await new Promise(resolve => setImmediate(resolve)); active--;
      return provider()(url);
    };
    await refreshSnapshot(null, { ...options(), tickers: [...TICKERS, 'FOUR', 'FIVE', 'SIX'], fetch });
    assert.equal(peak, 4); assert.equal(active, 0);
  });
  await check('Timeouts finish even when a broken provider adapter ignores abort', async () => {
    const originalTimer = global.setTimeout;
    global.setTimeout = (fn, ms, ...args) => originalTimer(fn, ms === 15000 ? 1 : ms, ...args);
    try {
      const next = await refreshSnapshot(initial, { ...options(), fetch: () => new Promise(() => {}) });
      assert.equal(next.status, 'error'); assert.deepEqual(next.marks, initial.marks);
    } finally { global.setTimeout = originalTimer; }
  });
  await check('CLI publishes atomically, reports partial/all-failure, and fails clearly without a secret', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudtracker-quote-snapshot-'));
    try {
      fs.copyFileSync(path.join(__dirname, 'quote-snapshot.cjs'), path.join(dir, 'quote-snapshot.cjs'));
      fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify({ companies: TICKERS.map(tk => ({ tk })) }));
      const preload = path.join(dir, 'offline.cjs');
      fs.writeFileSync(preload, `global.fetch=async url=>({ok:process.env.OFFLINE_FAIL!=='all',json:async()=>url.includes('coinbase')?{data:{amount:'10'}}:process.env.OFFLINE_FAIL==='partial'&&url.includes('IREN')?{}:{c:50,t:Math.floor(Date.now()/1000)-60}});`);
      const run = (mode, token = TOKEN) => spawnSync(process.execPath, ['--require', preload, path.join(dir, 'quote-snapshot.cjs')], {
        env: { ...process.env, FINNHUB_TOKEN: token, OFFLINE_FAIL: mode }, encoding: 'utf8'
      });
      const missing = run('', ''); assert.equal(missing.status, 1); assert.match(missing.stderr, /FINNHUB_TOKEN is not configured/);
      assert.equal(fs.existsSync(path.join(dir, 'market-prices.json')), false);
      const ready = run(''); assert.equal(ready.status, 0); assert.match(ready.stdout, /refresh: ready/);
      const good = JSON.parse(fs.readFileSync(path.join(dir, 'market-prices.json'), 'utf8')); assert.ok(validateSnapshot(good));
      const partial = run('partial'); assert.equal(partial.status, 0); assert.match(partial.stdout, /refresh: partial/);
      const partialSnapshot = JSON.parse(fs.readFileSync(path.join(dir, 'market-prices.json'), 'utf8'));
      const error = run('all'); assert.equal(error.status, 1); assert.match(error.stdout, /refresh: error/);
      const failed = JSON.parse(fs.readFileSync(path.join(dir, 'market-prices.json'), 'utf8'));
      assert.deepEqual(failed.marks, partialSnapshot.marks); assert.ok(validateSnapshot(failed));
      assert.equal(fs.readdirSync(dir).some(file => file.endsWith('.tmp')), false);
      assert.ok(![missing, ready, partial, error].some(result => (result.stdout + result.stderr).includes(TOKEN)));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  console.log('PASS: ' + count + ' shared quote snapshot regression groups.');
})().catch(error => { console.error(error); process.exitCode = 1; });
