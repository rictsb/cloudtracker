#!/usr/bin/env node
/* Paper-portfolio daily step (spec §6b) — run by the scheduled GitHub Action after US close.
   Fetches closes (Finnhub quotes) + BTC/ETH (Coinbase), values every name with the shared
   engine at TODAY'S as-of date, rebalances via portfolio-core, appends one ledger record.
   Idempotent per date; exits quietly on weekends/holidays (no fresh prints → no record). */
const fs = require('fs');
const path = require('path');
const { createEngine } = require('./engine.js');
const PC = require('./portfolio-core.js');

const ROOT = __dirname;
const TOKEN = process.env.FINNHUB_TOKEN ||
  (fs.readFileSync(path.join(ROOT, 'config.js'), 'utf8').match(/"([a-z0-9]{20,})"/) || [])[1] || '';

function decYear(isoDate) {
  const d = new Date(isoDate + 'T00:00:00Z');
  const y0 = Date.UTC(d.getUTCFullYear(), 0, 1);
  const y1 = Date.UTC(d.getUTCFullYear() + 1, 0, 1);
  return d.getUTCFullYear() + (d - y0) / (y1 - y0);
}
const etDate = ts => new Date(ts).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

async function getJSON(url, headers) {
  const r = await fetch(url, { headers: headers || {} });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url.split('?')[0]}`);
  return r.json();
}

async function main() {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8'));
  const pf = JSON.parse(fs.readFileSync(path.join(ROOT, 'portfolio.json'), 'utf8'));
  const histFile = JSON.parse(fs.readFileSync(path.join(ROOT, 'portfolio-history.json'), 'utf8'));
  const ledger = histFile.days;

  const today = etDate(Date.now());
  const dow = new Date(today + 'T12:00:00Z').getUTCDay();
  if (dow === 0 || dow === 6) { console.log(`${today} is a weekend — nothing to do`); return; }
  if (ledger.length && ledger[ledger.length - 1].d >= today) {
    console.log(`${today} already recorded — nothing to do`); return;
  }

  // quotes: Finnhub `c` = latest close, `t` = time of last print (stale on holidays)
  const quotes = {}; let fresh = 0;
  for (const c of data.companies) {
    try {
      const q = await getJSON(`https://finnhub.io/api/v1/quote?symbol=${c.tk}&token=${TOKEN}`);
      if (q && q.c > 0) { quotes[c.tk] = q.c; if (q.t && etDate(q.t * 1000) === today) fresh++; }
    } catch (e) { console.error(`WARN quote ${c.tk}: ${e.message}`); }
  }
  if (fresh < 5) { console.log(`${today}: only ${fresh} fresh prints — market holiday? Skipping.`); return; }

  let btc = null, eth = null;
  try { btc = +(await getJSON('https://api.coinbase.com/v2/prices/BTC-USD/spot')).data.amount; } catch (e) {}
  try { eth = +(await getJSON('https://api.coinbase.com/v2/prices/ETH-USD/spot')).data.amount; } catch (e) {}

  // forward-fill from the last ledger record, overlay today's quotes
  const px = { ...(ledger.length ? ledger[ledger.length - 1].px : {}) };
  Object.assign(px, quotes);

  const E = createEngine(data, { now: decYear(today) });
  Object.assign(E.ctx.prices, px);
  E.ctx.btc = btc; E.ctx.eth = eth;

  const watch = {};
  (data.watchItems || []).forEach(w => { watch[w.tk] = (watch[w.tk] || 0) + 1; });

  const rows = data.companies.filter(c => px[c.tk] > 0).map(c => {
    const v = E.value(c);
    return { tk: c.tk, price: px[c.tk], target: v.target, ev: v.ev,
             contractedEV: v.contractedEV, legacy: E.legacyOf(c), watch: watch[c.tk] || 0 };
  });

  const ctx = { date: today, rows, px, state: pf.state, params: pf.params,
                holdings: pf.holdings, bench: pf.bench, ledger, dayIdx: pf.dayIdx + 1 };
  const rec = PC.step(ctx);

  fs.writeFileSync(path.join(ROOT, 'portfolio-history.json'),
    JSON.stringify({ meta: histFile.meta, days: ledger }));
  fs.writeFileSync(path.join(ROOT, 'portfolio.json'), JSON.stringify({
    asOf: today, backtestThrough: pf.backtestThrough, priceSource: pf.priceSource,
    params: pf.params, state: pf.state,
    holdings: { cash: ctx.holdings.cash, positions: Object.fromEntries(Object.entries(ctx.holdings.positions).map(([k, v]) => [k, +v.toFixed(6)])) },
    bench: { cash: ctx.bench.cash, positions: Object.fromEntries(Object.entries(ctx.bench.positions).map(([k, v]) => [k, +v.toFixed(6)])), lastReb: ctx.bench.lastReb },
    dayIdx: ctx.dayIdx,
  }, null, 1));

  console.log(`${today}: NAV ${rec.nav} vs bench ${rec.bench} · gross ${(rec.gross * 100).toFixed(0)}% · λ ${rec.lambda} · ${rec.trades.length} trades${rec.learn ? ` · learn IC ${rec.learn.ic}` : ''}`);
}

main().catch(e => { console.error(e); process.exit(1); });
