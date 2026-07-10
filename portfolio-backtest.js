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
const PIT = process.argv.includes('--pit');   // run the genesis on data-pit.json point-in-time snapshots
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

  // exclusions are a standing judgement input — preserved (and honored) across regenerations
  let exclude = {};
  try { exclude = JSON.parse(fs.readFileSync(path.join(ROOT, 'portfolio.json'), 'utf8')).exclude || {}; } catch (e) {}
  const excluded = new Set(Object.keys(exclude));
  if (excluded.size) console.log(`excluded from book + benchmark: ${[...excluded].join(', ')}`);

  // live history is sacred: by default a regeneration REATTACHES existing live records onto the
  // new genesis (rescaled, return-preserving); --force discards them (almost never what you want)
  const histPath = path.join(ROOT, 'portfolio-history.json');
  let oldLive = [], oldSimEnd = null, simCutoff = null, oldSimLen = 0;
  if (fs.existsSync(histPath) && !FORCE) {
    const old = JSON.parse(fs.readFileSync(histPath, 'utf8'));
    if (old.meta) {
      oldLive = (old.days || []).filter(d => d.d > old.meta.backtestThrough);
      const oldSim = (old.days || []).filter(d => d.d <= old.meta.backtestThrough);
      oldSimEnd = oldSim[oldSim.length - 1] || null;
      oldSimLen = oldSim.length;
      if (oldLive.length) {
        simCutoff = old.meta.backtestThrough;   // the sim must stop where the live record begins
        console.log(`reattaching ${oldLive.length} live records after ${simCutoff}`);
      }
    }
  }

  // point-in-time snapshots: {companies: {TK: [{asOf, basis, company}, ...]}} sorted by asOf
  let pit = null;
  if (PIT) {
    pit = JSON.parse(fs.readFileSync(path.join(ROOT, 'data-pit.json'), 'utf8'));
    Object.values(pit.companies).forEach(sn => sn.sort((a, b) => a.asOf < b.asOf ? -1 : 1));
    console.log(`PIT mode: ${Object.keys(pit.companies).length} tickers, ${Object.values(pit.companies).reduce((a, s) => a + s.length, 0)} dated snapshots`);
  }
  const activeCompanies = (d) => {
    if (!pit) return data.companies;
    const out = [];
    for (const tk in pit.companies) {
      let cur = null;
      for (const s of pit.companies[tk]) { if (s.asOf <= d) cur = s.company; else break; }
      if (cur) out.push(cur);
    }
    return out;
  };

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

  let days = [...new Set(Object.values(hist).flatMap(h => Object.keys(h)))].sort();
  if (simCutoff) days = days.filter(d => d <= simCutoff);
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

    const active = activeCompanies(d);
    const E = createEngine({ config: data.config, companies: active }, { now: decYear(d) });
    Object.assign(E.ctx.prices, px);
    E.ctx.btc = lastBtc; E.ctx.eth = lastEth;

    // PIT mode: watch-items are today's judgements — they do not exist in the reconstruction
    const rows = active.filter(c => px[c.tk] > 0 && !excluded.has(c.tk)).map(c => {
      const v = E.value(c);
      return { tk: c.tk, price: px[c.tk], target: v.target, ev: v.ev,
               contractedEV: v.contractedEV, legacy: E.legacyOf(c), watch: pit ? 0 : (watch[c.tk] || 0) };
    });

    const ctx = { date: d, rows, px: { ...px }, state, params, holdings, bench, ledger, dayIdx,
                  btc: lastBtc, eth: lastEth };
    PC.step(ctx);
    holdings = ctx.holdings; bench = ctx.bench;
  });

  const simEnd = ledger[ledger.length - 1];
  console.log(`\n${ledger.length} simulated trading days ${days[0]} → ${simEnd.d}`);
  console.log(`genesis NAV ${simEnd.nav} vs equal-weight ${simEnd.bench} (base 100) · λ ${simEnd.lambda} · cash ${(simEnd.cash * 100).toFixed(1)}%`);

  // reattach live records: rescale (return-preserving) so the live era chains from the new genesis end
  const rPx = x => (x < 10 ? Math.round(x * 10000) / 10000 : Math.round(x * 100) / 100);
  if (oldLive.length && oldSimEnd) {
    // seam guard: if a ticker's price basis differs between the new sim series and the live
    // records (splits handled live but not in a re-fetched chart, etc.), align the SIM series
    // to the live basis — live is canonical
    const firstLive = oldLive[0];
    for (const tk of Object.keys(firstLive.px || {})) {
      const a = simEnd.px[tk], b = firstLive.px[tk];
      if (a > 0 && b > 0 && Math.abs(Math.log(b / a)) > Math.log(1.5)) {
        const f = b / a;
        ledger.forEach(rec => { if (rec.px[tk] != null) rec.px[tk] = rPx(rec.px[tk] * f); });
        console.log(`SEAM FIX ${tk}: sim price series aligned ×${f.toFixed(4)} to the live basis`);
      }
    }
    const r = simEnd.nav / oldSimEnd.nav, rB = simEnd.bench / oldSimEnd.bench;
    oldLive.forEach(recOld => {
      const rec = JSON.parse(JSON.stringify(recOld));
      rec.nav = Math.round(rec.nav * r * 100) / 100;
      rec.bench = Math.round(rec.bench * rB * 100) / 100;
      rec.trades.forEach(t => { t.usd = Math.round(t.usd * r * 100) / 100; });
      ledger.push(rec);
    });
    console.log(`reattached ${oldLive.length} live records (NAV ×${r.toFixed(4)}, bench ×${rB.toFixed(4)}) → ledger ends ${ledger[ledger.length - 1].d}`);
  }
  const last = ledger[ledger.length - 1];

  const meta = { base: 100, start: days[0], backtestThrough: simEnd.d,
                 note: pit
                   ? 'Records through backtestThrough are a RECONSTRUCTION: point-in-time company snapshots (data-pit.json, facts as disclosed by each date) valued with TODAY\'S model, calibration and universe selection (spec §6b) — meaningfully de-biased, still not a track record. The live record after backtestThrough is the evidence.'
                   : 'Records through backtestThrough are SIMULATED with current data.json against historical prices (spec §6b) — machinery validation, not evidence of alpha.' };
  if (pit) meta.pit = { generated: pit.meta && pit.meta.generated, snapshots: Object.values(pit.companies).reduce((a, s) => a + s.length, 0) };
  if (Object.keys(rescaled).length) meta.rescaled = rescaled;
  fs.writeFileSync(histPath, JSON.stringify({ meta, days: ledger }));

  if (oldLive.length && oldSimEnd) {
    // live state is sacred: preserve portfolio.json wholesale, rescale only the book & bench
    const pfOld = JSON.parse(fs.readFileSync(path.join(ROOT, 'portfolio.json'), 'utf8'));
    const r = simEnd.nav / oldSimEnd.nav, rB = simEnd.bench / oldSimEnd.bench;
    const scale = (book, f) => ({ ...book, cash: book.cash * f,
      positions: Object.fromEntries(Object.entries(book.positions).map(([k, v]) => [k, +(v * f).toFixed(6)])) });
    const dLen = ledger.length - oldLive.length - oldSimLen;   // sim-length delta shifts ledger-length anchors
    if (pfOld.state) {
      if (pfOld.state.lastLearnLen != null) pfOld.state.lastLearnLen += dLen;
      if (pfOld.state.lastGateNote != null) pfOld.state.lastGateNote += dLen;
    }
    fs.writeFileSync(path.join(ROOT, 'portfolio.json'), JSON.stringify({
      ...pfOld, holdings: scale(pfOld.holdings, r), bench: scale(pfOld.bench, rB),
      dayIdx: ledger.length - 1,
    }, null, 1));
    console.log('portfolio.json: live state preserved, book rescaled to the new genesis chain');
  } else {
    fs.writeFileSync(path.join(ROOT, 'portfolio.json'), JSON.stringify({
      asOf: last.d, backtestThrough: simEnd.d, priceSource: source, params,
      // live learning restarts NEUTRAL: the genesis λ/m are artifacts — the ledger keeps them for inspection only
      state: { lambda: params.lambda0, names: {} },
      suspect: {},
      exclude, lastExcludeKey: [...excluded].sort().join(','),
      // seed freshness at go-live from ACTUAL final-day prints — a name that stopped printing
      // months ago must enter live operation already counted stale, not masked by forward-fill
      lastFresh: Object.fromEntries(tickers.filter(tk => hist[tk][last.d] != null).map(tk => [tk, last.d])),
      holdings: { cash: holdings.cash, positions: Object.fromEntries(Object.entries(holdings.positions).map(([k, v]) => [k, +v.toFixed(6)])) },
      bench: { cash: bench.cash, positions: Object.fromEntries(Object.entries(bench.positions).map(([k, v]) => [k, +v.toFixed(6)])), lastReb: bench.lastReb },
      dayIdx: ledger.length - 1,
    }, null, 1));
  }
  console.log('wrote portfolio.json + portfolio-history.json');
}

main().catch(e => { console.error(e); process.exit(1); });
