#!/usr/bin/env node
/* Paper-portfolio backtest (spec §6b) — regenerates the simulated genesis.
   `node portfolio-backtest.js [--days 365] [--force] [--allow-missing]`
   Prices: Finnhub daily candles when FINNHUB_TOKEN (env) has candle access,
   else Yahoo's public chart API — never mixed. Every series is BASIS-VALIDATED
   against a live quote (Yahoo chart series can sit on a different share basis
   than the live listing — ABTC shipped 15× off) and rescaled when it disagrees.
   BTC/ETH: Coinbase daily candles, stored per record for live forward-fill.
   Refuses to overwrite a ledger containing LIVE records unless --force.
   HONEST LABEL: uses TODAY'S data.json against historical prices — validates the
   machinery and calibrates parameters; it is NOT evidence of alpha. */
const fs = require('fs');
const path = require('path');
const { createEngine } = require('./engine.js');
const PC = require('./portfolio-core.js');

const ROOT = __dirname;
const DAYS = (() => { const i = process.argv.indexOf('--days'); return i > 0 ? +process.argv[i + 1] : 365; })();
const FORCE = process.argv.includes('--force');
const ALLOW_MISSING = process.argv.includes('--allow-missing');
const TOKEN = process.env.FINNHUB_TOKEN || '';
const QUOTE_TOKEN = TOKEN ||
  (fs.readFileSync(path.join(ROOT, 'config.js'), 'utf8').match(/"([a-z0-9]{20,})"/) || [])[1] || '';

const iso = d => d.toISOString().slice(0, 10);
function decYear(isoDate) {
  const d = new Date(isoDate + 'T00:00:00Z');
  const y0 = Date.UTC(d.getUTCFullYear(), 0, 1);
  const y1 = Date.UTC(d.getUTCFullYear() + 1, 0, 1);
  return d.getUTCFullYear() + (d - y0) / (y1 - y0);
}

async function getJSON(url, headers) {
  const r = await fetch(url, { headers: headers || {} });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url.split('?')[0]}`);
  return r.json();
}

/* → {date: close} via Finnhub candles (paid) */
async function finnhubDaily(tk, from, to) {
  const j = await getJSON(`https://finnhub.io/api/v1/stock/candle?symbol=${tk}&resolution=D&from=${from}&to=${to}&token=${TOKEN}`);
  if (j.s !== 'ok') throw new Error(`finnhub ${tk}: ${j.s || j.error}`);
  const out = {};
  j.t.forEach((t, i) => { out[iso(new Date(t * 1000))] = j.c[i]; });
  return out;
}

/* → {date: adjusted close} via Yahoo chart API */
async function yahooDaily(tk, from, to) {
  const j = await getJSON(
    `https://query1.finance.yahoo.com/v8/finance/chart/${tk}?period1=${from}&period2=${to}&interval=1d`,
    { 'User-Agent': 'Mozilla/5.0' });
  const res = j.chart && j.chart.result && j.chart.result[0];
  if (!res || !res.timestamp) throw new Error(`yahoo ${tk}: no data`);
  const closes = (res.indicators.adjclose && res.indicators.adjclose[0].adjclose) ||
                 res.indicators.quote[0].close;
  const out = {};
  res.timestamp.forEach((t, i) => { if (closes[i] != null) out[iso(new Date(t * 1000))] = closes[i]; });
  return out;
}

/* → {date: close} via Coinbase public daily candles (300/request, paginated) */
async function coinbaseDaily(product, from, to) {
  const out = {};
  for (let end = to; end > from;) {
    const start = Math.max(from, end - 300 * 86400);
    const rows = await getJSON(
      `https://api.exchange.coinbase.com/products/${product}/candles?granularity=86400&start=${iso(new Date(start * 1000))}T00:00:00Z&end=${iso(new Date(end * 1000))}T00:00:00Z`,
      { 'User-Agent': 'compute-value-tracker' });
    rows.forEach(r => { out[iso(new Date(r[0] * 1000))] = r[4]; });
    end = start;
  }
  return out;
}

async function fetchAll(tickers, from, to, source) {
  const hist = {}; const missing = [];
  for (const tk of tickers) {
    try {
      hist[tk] = source === 'finnhub' ? await finnhubDaily(tk, from, to) : await yahooDaily(tk, from, to);
    } catch (e) {
      if (source === 'finnhub') throw { fallback: true, message: e.message };  // restart the WHOLE fetch on yahoo — never mix bases
      missing.push(`${tk} (${e.message})`);
      hist[tk] = {};
    }
    process.stdout.write(`${tk}:${Object.keys(hist[tk]).length}d `);
  }
  return { hist, missing };
}

async function main() {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8'));
  const tickers = data.companies.map(c => c.tk);
  const to = Math.floor(Date.now() / 1000);
  const from = to - (DAYS + 10) * 86400;

  // refuse to clobber live history
  const histPath = path.join(ROOT, 'portfolio-history.json');
  if (fs.existsSync(histPath) && !FORCE) {
    const old = JSON.parse(fs.readFileSync(histPath, 'utf8'));
    const live = (old.days || []).filter(d => old.meta && d.d > old.meta.backtestThrough);
    if (live.length) {
      console.error(`REFUSING: ${live.length} LIVE ledger records exist after ${old.meta.backtestThrough} — rerun with --force to destroy them.`);
      process.exit(1);
    }
  }

  let source = TOKEN ? 'finnhub' : 'yahoo';
  let fetched;
  try { fetched = await fetchAll(tickers, from, to, source); }
  catch (e) {
    if (!e.fallback) throw e;
    console.error(`\nfinnhub candles unavailable (${e.message}) — refetching EVERYTHING via yahoo`);
    source = 'yahoo';
    fetched = await fetchAll(tickers, from, to, source);
  }
  const { hist, missing } = fetched;
  if (missing.length && !ALLOW_MISSING) {
    console.error(`\nFAILED to fetch: ${missing.join(', ')} — a silently smaller universe corrupts the benchmark. Rerun with --allow-missing to accept.`);
    process.exit(1);
  }
  console.log(`\nprice source: ${source}`);

  // BASIS VALIDATION: a chart series can sit on a different share basis than the live
  // listing (ABTC: Yahoo chart 15× off vs its own live quote). Compare each series' last
  // close to a live Finnhub quote and rescale the WHOLE series (return-preserving).
  const rescaled = {};
  for (const tk of tickers) {
    const dts = Object.keys(hist[tk]).sort();
    if (!dts.length) continue;
    const lastClose = hist[tk][dts[dts.length - 1]];
    let ref = null;
    try { const q = await getJSON(`https://finnhub.io/api/v1/quote?symbol=${tk}&token=${QUOTE_TOKEN}`); if (q && q.c > 0) ref = q.c; } catch (e) {}
    if (!(ref > 0)) { console.error(`BASIS UNVERIFIED ${tk}: no live quote — series accepted as-is (never rescale off a stale manual price)`); continue; }
    if (!(lastClose > 0)) continue;
    const ratio = ref / lastClose;
    if (Math.abs(Math.log(ratio)) > Math.log(1.25)) {
      dts.forEach(d => { hist[tk][d] *= ratio; });
      rescaled[tk] = +ratio.toFixed(6);
      console.error(`BASIS FIX ${tk}: series rescaled ×${ratio.toFixed(4)} (chart ${lastClose} vs live ${ref})`);
    }
  }

  const btc = await coinbaseDaily('BTC-USD', from, to);
  const eth = await coinbaseDaily('ETH-USD', from, to);
  console.log(`BTC ${Object.keys(btc).length}d, ETH ${Object.keys(eth).length}d`);

  const days = [...new Set(Object.values(hist).flatMap(h => Object.keys(h)))].sort();
  if (!days.length) throw new Error('no price history fetched');

  const watch = {};
  (data.watchItems || []).forEach(w => { watch[w.tk] = (watch[w.tk] || 0) + 1; });

  const params = { ...PC.DEFAULT_PARAMS };
  const state = { lambda: params.lambda0, names: {} };
  let holdings = { cash: 100, positions: {} };   // NAV index base 100
  let bench = { cash: 100, positions: {}, lastReb: null };
  const ledger = [];
  const px = {};
  let lastBtc = null, lastEth = null;

  days.forEach((d, dayIdx) => {
    tickers.forEach(tk => { if (hist[tk][d] != null) px[tk] = hist[tk][d]; });
    if (btc[d] != null) lastBtc = btc[d];
    if (eth[d] != null) lastEth = eth[d];

    const E = createEngine(data, { now: decYear(d) });
    Object.assign(E.ctx.prices, px);
    E.ctx.btc = lastBtc; E.ctx.eth = lastEth;

    const rows = data.companies.filter(c => px[c.tk] > 0).map(c => {
      const v = E.value(c);
      return { tk: c.tk, price: px[c.tk], target: v.target, ev: v.ev,
               contractedEV: v.contractedEV, legacy: E.legacyOf(c), watch: watch[c.tk] || 0 };
    });

    const ctx = { date: d, rows, px: { ...px }, state, params, holdings, bench, ledger, dayIdx,
                  btc: lastBtc, eth: lastEth };
    PC.step(ctx);
    holdings = ctx.holdings; bench = ctx.bench;
  });

  const last = ledger[ledger.length - 1];
  console.log(`\n${ledger.length} trading days ${days[0]} → ${last.d}`);
  console.log(`portfolio NAV ${last.nav} vs equal-weight ${last.bench} (base 100) · λ ${last.lambda} · cash ${(last.cash * 100).toFixed(1)}%`);

  const meta = { base: 100, start: days[0], backtestThrough: last.d,
                 note: 'Records through backtestThrough are SIMULATED with current data.json against historical prices (spec §6b) — machinery validation, not evidence of alpha.' };
  if (Object.keys(rescaled).length) meta.rescaled = rescaled;
  fs.writeFileSync(histPath, JSON.stringify({ meta, days: ledger }));
  fs.writeFileSync(path.join(ROOT, 'portfolio.json'), JSON.stringify({
    asOf: last.d, backtestThrough: last.d, priceSource: source, params,
    // live learning restarts NEUTRAL: the backtest's λ/m are hindsight-contaminated
    // (today's data.json "knew" the year) — the ledger keeps them for inspection only
    state: { lambda: params.lambda0, names: {} },
    suspect: {},
    // seed freshness at go-live from ACTUAL final-day prints — a name that stopped printing
    // months ago must enter live operation already counted stale, not masked by forward-fill
    lastFresh: Object.fromEntries(tickers.filter(tk => hist[tk][last.d] != null).map(tk => [tk, last.d])),
    holdings: { cash: holdings.cash, positions: Object.fromEntries(Object.entries(holdings.positions).map(([k, v]) => [k, +v.toFixed(6)])) },
    bench: { cash: bench.cash, positions: Object.fromEntries(Object.entries(bench.positions).map(([k, v]) => [k, +v.toFixed(6)])), lastReb: bench.lastReb },
    dayIdx: ledger.length - 1,
  }, null, 1));
  console.log('wrote portfolio.json + portfolio-history.json');
}

main().catch(e => { console.error(e); process.exit(1); });
