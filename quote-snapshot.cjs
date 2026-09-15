#!/usr/bin/env node
/* Shared, present-tense market references. Providers supply every price; this job
 * never changes valuation inputs or the paper-portfolio ledger. Credentials are
 * environment-only and neither request URLs nor provider errors are logged. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const MAPS = ['prices', 'priceDates', 'priceFetchedAt', 'priceSources', 'cryptoDates'];
const TICKER = /^[A-Z0-9._-]{1,32}$/;
const TIMEOUT_MS = 15000, CONCURRENCY = 4;
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const emptyMarks = () => ({ prices: {}, priceDates: {}, priceFetchedAt: {}, priceSources: {},
  btc: null, eth: null, cryptoDates: {}, asOf: null, fetchedAt: null });
const clock = now => typeof now === 'function' ? now : () => now === undefined ? Date.now() : now;
function validDate(value, now) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms <= now + 300000 && new Date(ms).toISOString().slice(0, 19) === value.slice(0, 19);
}
const uniqueTickers = values => Array.isArray(values) && values.every(tk => typeof tk === 'string' && TICKER.test(tk)) && new Set(values).size === values.length;

function validateSnapshot(snapshot, options = {}) {
  const now = clock(options.now)();
  if (!plain(snapshot) || snapshot.version !== 1 || !validDate(snapshot.checkedAt, now) ||
      !['ready', 'partial', 'error'].includes(snapshot.status) || !uniqueTickers(snapshot.universe) ||
      !uniqueTickers(snapshot.failedTickers) || !Array.isArray(snapshot.failedCrypto) ||
      snapshot.failedTickers.some(tk => !snapshot.universe.includes(tk)) ||
      snapshot.failedCrypto.some(asset => !['btc', 'eth'].includes(asset)) ||
      new Set(snapshot.failedCrypto).size !== snapshot.failedCrypto.length) return false;
  const m = snapshot.marks;
  if (!plain(m) || MAPS.some(key => !plain(m[key]))) return false;
  const keys = Object.keys(m.prices);
  if (keys.some(tk => !snapshot.universe.includes(tk) || !positive(m.prices[tk]) ||
      !(m.priceDates[tk] === null || validDate(m.priceDates[tk], now)) ||
      !validDate(m.priceFetchedAt[tk], now) || m.priceSources[tk] !== 'Finnhub')) return false;
  if (['priceDates', 'priceFetchedAt', 'priceSources'].some(key => Object.keys(m[key]).length !== keys.length ||
      Object.keys(m[key]).some(tk => !keys.includes(tk)))) return false;
  if (Object.keys(m.cryptoDates).some(asset => !['btc', 'eth'].includes(asset))) return false;
  for (const asset of ['btc', 'eth']) {
    if (m[asset] !== null && !positive(m[asset])) return false;
    if (positive(m[asset]) ? !validDate(m.cryptoDates[asset], now) : asset in m.cryptoDates) return false;
  }
  if (![m.asOf, m.fetchedAt].every(value => value === null || validDate(value, now)) || m.asOf !== m.fetchedAt) return false;
  if ((keys.length || positive(m.btc) || positive(m.eth)) && !validDate(m.fetchedAt, now)) return false;
  const failures = snapshot.failedTickers.length + snapshot.failedCrypto.length, total = snapshot.universe.length + 2;
  if (snapshot.status === 'ready' ? failures !== 0 : snapshot.status === 'error' ? failures !== total : failures === 0 || failures === total) return false;
  if (snapshot.universe.some(tk => !snapshot.failedTickers.includes(tk) && !positive(m.prices[tk])) ||
      ['btc', 'eth'].some(asset => !snapshot.failedCrypto.includes(asset) && !positive(m[asset]))) return false;
  return true;
}

async function readJSON(fetchImpl, url) {
  const controller = new AbortController();
  let timer;
  // Race the timeout as well as aborting: even a broken adapter cannot stall a job.
  const deadline = new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, TIMEOUT_MS); });
  const request = Promise.resolve().then(async () => {
    try {
      const response = await fetchImpl(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
      return response && response.ok ? await response.json() : null;
    } catch (_) { return null; }
  });
  try { return await Promise.race([request, deadline]); }
  finally { clearTimeout(timer); }
}

async function mapLimited(values, fn) {
  const results = new Array(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, values.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= values.length) return;
      results[index] = await fn(values[index]);
    }
  }));
  return results;
}

async function refreshSnapshot(previous, options = {}) {
  const { tickers, token, fetch: fetchImpl = globalThis.fetch } = options;
  const now = clock(options.now);
  if (typeof token !== 'string' || !token.trim()) throw new Error('FINNHUB_TOKEN is not configured; set the workflow secret.');
  if (!uniqueTickers(tickers) || !tickers.length) throw new Error('The market-price universe must contain unique valid tickers.');
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required.');
  if (!Number.isFinite(now())) throw new Error('The refresh clock is invalid.');
  if (previous !== null && previous !== undefined && !validateSnapshot(previous, { now })) throw new Error('The existing market-price snapshot is invalid; refusing to overwrite it.');
  const marks = emptyMarks();
  if (previous) {
    for (const tk of tickers) if (positive(previous.marks.prices[tk])) {
      for (const key of ['prices', 'priceDates', 'priceFetchedAt', 'priceSources']) marks[key][tk] = previous.marks[key][tk];
    }
    for (const asset of ['btc', 'eth']) if (positive(previous.marks[asset])) {
      marks[asset] = previous.marks[asset]; marks.cryptoDates[asset] = previous.marks.cryptoDates[asset];
    }
    marks.asOf = previous.marks.asOf; marks.fetchedAt = previous.marks.fetchedAt;
  }
  const jobs = [...tickers.map(tk => ({ tk })), { asset: 'btc', pair: 'BTC-USD' }, { asset: 'eth', pair: 'ETH-USD' }];
  const observations = await mapLimited(jobs, async job => {
    const url = job.tk ? 'https://finnhub.io/api/v1/quote?symbol=' + encodeURIComponent(job.tk) + '&token=' + encodeURIComponent(token.trim()) :
      'https://api.coinbase.com/v2/prices/' + job.pair + '/spot';
    const body = await readJSON(fetchImpl, url), received = new Date(now()).toISOString();
    if (job.tk) {
      if (!body || !positive(body.c)) return { ...job, failed: true };
      const ms = typeof body.t === 'number' && body.t > 0 ? body.t * 1000 : NaN;
      const stamp = Number.isFinite(ms) && Math.abs(ms) <= 8640000000000000 ? new Date(ms).toISOString() : null;
      return { ...job, price: body.c, quoteAt: validDate(stamp, now()) ? stamp : null, received };
    }
    const amount = body && body.data && body.data.amount;
    const price = typeof amount === 'string' && amount.trim() ? Number(amount) : typeof amount === 'number' ? amount : NaN;
    return positive(price) ? { ...job, price, received } : { ...job, failed: true };
  });
  const failedTickers = [], failedCrypto = [];
  let successes = 0, latestReceipt = null;
  for (const observation of observations) {
    const { tk, asset, price, quoteAt, received } = observation;
    const olderReceipt = received && (tk ? marks.priceFetchedAt[tk] : marks.cryptoDates[asset]);
    const priorQuote = tk && marks.priceDates[tk];
    const regressed = olderReceipt && Date.parse(received) < Date.parse(olderReceipt);
    const missingOrOlderQuote = priorQuote && (!quoteAt || Date.parse(quoteAt) < Date.parse(priorQuote));
    if (observation.failed || regressed || missingOrOlderQuote) {
      (tk ? failedTickers : failedCrypto).push(tk || asset); continue;
    }
    successes++;
    if (!latestReceipt || Date.parse(received) > Date.parse(latestReceipt)) latestReceipt = received;
    if (tk) {
      marks.prices[tk] = price; marks.priceDates[tk] = quoteAt;
      marks.priceFetchedAt[tk] = received; marks.priceSources[tk] = 'Finnhub';
    } else { marks[asset] = price; marks.cryptoDates[asset] = received; }
  }
  if (latestReceipt && (!marks.fetchedAt || Date.parse(latestReceipt) >= Date.parse(marks.fetchedAt))) marks.asOf = marks.fetchedAt = latestReceipt;
  const snapshot = { version: 1, checkedAt: new Date(now()).toISOString(),
    status: successes ? (failedTickers.length || failedCrypto.length ? 'partial' : 'ready') : 'error',
    failedTickers, failedCrypto, universe: tickers.slice(), marks };
  if (!validateSnapshot(snapshot, { now })) throw new Error('The generated market-price snapshot failed validation.');
  return snapshot;
}

async function main() {
  const token = process.env.FINNHUB_TOKEN;
  if (typeof token !== 'string' || !token.trim()) throw new Error('FINNHUB_TOKEN is not configured; set the workflow secret.');
  const file = path.join(__dirname, 'market-prices.json');
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'data.json'), 'utf8'));
  const previous = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  const snapshot = await refreshSnapshot(previous, { tickers: data.companies.map(company => company.tk), token });
  const temporary = file + '.' + process.pid + '.tmp';
  try { fs.writeFileSync(temporary, JSON.stringify(snapshot, null, 2) + '\n'); fs.renameSync(temporary, file); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  console.log('Market-price refresh: ' + snapshot.status + '; equities ' + (snapshot.universe.length - snapshot.failedTickers.length) + '/' + snapshot.universe.length +
    '; crypto ' + (2 - snapshot.failedCrypto.length) + '/2; checked ' + snapshot.checkedAt + '.');
  if (snapshot.failedTickers.length) console.log('Retained or unavailable equity quotes: ' + snapshot.failedTickers.join(', ') + '.');
  if (snapshot.failedCrypto.length) console.log('Retained or unavailable crypto quotes: ' + snapshot.failedCrypto.join(', ') + '.');
  if (snapshot.status === 'error') process.exitCode = 1;
}

module.exports = { refreshSnapshot, validateSnapshot };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
