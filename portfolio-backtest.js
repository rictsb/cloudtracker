#!/usr/bin/env node
/* Paper-portfolio backtest (spec §6b) — regenerates the simulated genesis.
   `node portfolio-backtest.js [--days 365]`
   Prices: Finnhub daily candles when FINNHUB_TOKEN (env) has candle access,
   else Yahoo's public chart API. BTC/ETH: Coinbase daily candles.
   HONEST LABEL: uses TODAY'S data.json against historical prices — validates the
   machinery and calibrates λ; it is NOT evidence of alpha. Writes portfolio.json
   + portfolio-history.json with backtestThrough = the last simulated day. */
const fs = require('fs');
const path = require('path');
const { createEngine } = require('./engine.js');
const PC = require('./portfolio-core.js');

const ROOT = __dirname;
const DAYS = (() => { const i = process.argv.indexOf('--days'); return i > 0 ? +process.argv[i + 1] : 365; })();
const TOKEN = process.env.FINNHUB_TOKEN || '';

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

async function main() {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8'));
  const tickers = data.companies.map(c => c.tk);
  const to = Math.floor(Date.now() / 1000);
  const from = to - (DAYS + 10) * 86400;

  // fetch price history (Finnhub if entitled, else Yahoo), sequential to respect rate limits
  let source = TOKEN ? 'finnhub' : 'yahoo';
  const hist = {};
  for (const tk of tickers) {
    try {
      hist[tk] = source === 'finnhub' ? await finnhubDaily(tk, from, to) : await yahooDaily(tk, from, to);
    } catch (e) {
      if (source === 'finnhub') {          // token lacks candle access → fall back for the whole run
        console.error(`finnhub candles unavailable (${e.message}) — falling back to yahoo`);
        source = 'yahoo';
        hist[tk] = await yahooDaily(tk, from, to);
      } else { console.error(`WARN no history for ${tk}: ${e.message}`); hist[tk] = {}; }
    }
    process.stdout.write(`${tk}:${Object.keys(hist[tk]).length}d `);
  }
  console.log(`\nprice source: ${source}`);
  const btc = await coinbaseDaily('BTC-USD', from, to);
  const eth = await coinbaseDaily('ETH-USD', from, to);
  console.log(`BTC ${Object.keys(btc).length}d, ETH ${Object.keys(eth).length}d`);

  // trading calendar = union of equity trading dates
  const days = [...new Set(Object.values(hist).flatMap(h => Object.keys(h)))].sort();
  if (!days.length) throw new Error('no price history fetched');

  const watch = {};
  (data.watchItems || []).forEach(w => { watch[w.tk] = (watch[w.tk] || 0) + 1; });

  const params = { ...PC.DEFAULT_PARAMS };
  const state = { lambda: params.lambda0, names: {} };
  let holdings = { cash: 100, positions: {} };   // NAV index base 100
  let bench = { cash: 100, positions: {}, lastReb: null };
  const ledger = [];
  const px = {};                                  // forward-filled last close per ticker
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

    const ctx = { date: d, rows, px: { ...px }, state, params, holdings, bench, ledger, dayIdx };
    PC.step(ctx);
    holdings = ctx.holdings; bench = ctx.bench;
  });

  const last = ledger[ledger.length - 1];
  console.log(`\n${ledger.length} trading days ${days[0]} → ${last.d}`);
  console.log(`portfolio NAV ${last.nav} vs equal-weight ${last.bench} (base 100) · λ ${last.lambda} · cash ${(last.cash * 100).toFixed(1)}%`);

  fs.writeFileSync(path.join(ROOT, 'portfolio-history.json'), JSON.stringify({
    meta: { base: 100, start: days[0], backtestThrough: last.d,
            note: 'Records through backtestThrough are SIMULATED with current data.json against historical prices (spec §6b) — machinery validation, not evidence of alpha.' },
    days: ledger,
  }));
  fs.writeFileSync(path.join(ROOT, 'portfolio.json'), JSON.stringify({
    asOf: last.d, backtestThrough: last.d, priceSource: source, params,
    // live learning restarts NEUTRAL: the backtest's λ/m are hindsight-contaminated
    // (today's data.json "knew" the year) — the ledger keeps them for inspection only
    state: { lambda: params.lambda0, names: {} },
    holdings: { cash: holdings.cash, positions: Object.fromEntries(Object.entries(holdings.positions).map(([k, v]) => [k, +v.toFixed(6)])) },
    bench: { cash: bench.cash, positions: Object.fromEntries(Object.entries(bench.positions).map(([k, v]) => [k, +v.toFixed(6)])), lastReb: bench.lastReb },
    dayIdx: ledger.length - 1,
  }, null, 1));
  console.log('wrote portfolio.json + portfolio-history.json');
}

main().catch(e => { console.error(e); process.exit(1); });
