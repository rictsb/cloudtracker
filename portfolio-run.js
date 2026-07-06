#!/usr/bin/env node
/* Paper-portfolio daily step (spec §6b) — run by the scheduled GitHub Action after US close.
   Fetches closes (Finnhub quotes) + BTC/ETH (Coinbase), values every name with the shared
   engine at TODAY'S as-of date, rebalances via portfolio-core, appends one ledger record.

   Guards (this runs unattended for a non-coder — silent wrong numbers are the worst failure):
   - weekend / already-recorded / market-still-open (before 16:05 ET; FORCE_MARK=1 overrides)
   - feed-death: skipping with a ledger already >5 calendar days stale exits 1 (Action goes red)
   - corporate actions: a >40% overnight move is cross-checked against Yahoo splits/quote;
     real splits adjust share counts (value-preserving), source conflicts freeze the name and
     3 consecutive suspect days exit 1 for human review
   - partial feed: <70% fresh prints marks NAV but suspends ALL trading that day
   - stale names (no fresh print >10 days: halted/delisted): frozen, uninvestable, surfaced
   - Coinbase outage: BTC/ETH forward-fill from the ledger — never the static fallbacks */
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
const etTime = () => new Date().toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour12: false });
const daysBetween = (a, b) => Math.round((new Date(b + 'T12:00Z') - new Date(a + 'T12:00Z')) / 86400000);

async function getJSON(url, headers) {
  const r = await fetch(url, { headers: headers || {} });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url.split('?')[0]}`);
  return r.json();
}
function writeAtomic(file, content) {
  fs.writeFileSync(file + '.tmp', content);
  fs.renameSync(file + '.tmp', file);
}

/* Yahoo cross-check for a suspicious move: splits over the whole ledger gap + the live quote.
   Returns null on network failure — the caller must treat "second source unavailable"
   differently from "second source disagrees". */
async function yahooCheck(tk, gapDays) {
  const range = gapDays <= 22 ? '1mo' : gapDays <= 80 ? '3mo' : '1y';
  try {
    const j = await getJSON(
      `https://query1.finance.yahoo.com/v8/finance/chart/${tk}?range=${range}&interval=1d&events=splits`,
      { 'User-Agent': 'Mozilla/5.0' });
    const res = j.chart && j.chart.result && j.chart.result[0];
    if (!res) return null;
    const splits = Object.values((res.events && res.events.splits) || {})
      .map(s => ({ d: etDate(s.date * 1000), num: s.numerator, den: s.denominator }));
    return { splits, live: res.meta && res.meta.regularMarketPrice };
  } catch (e) { return null; }
}

async function main() {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8'));
  const pf = JSON.parse(fs.readFileSync(path.join(ROOT, 'portfolio.json'), 'utf8'));
  const histFile = JSON.parse(fs.readFileSync(path.join(ROOT, 'portfolio-history.json'), 'utf8'));
  const ledger = histFile.days;
  const last = ledger[ledger.length - 1];
  const universe = new Set(data.companies.map(c => c.tk));
  pf.suspect = pf.suspect || {};
  pf.lastFresh = pf.lastFresh || {};
  pf.exclude = pf.exclude || {};                 // ticker → one-line basis (judgement input, checks-enforced)
  const excluded = new Set(Object.keys(pf.exclude));
  // an exclusion change rebuilds the benchmark immediately — book and yardstick must share a universe
  const excludeKey = [...excluded].sort().join(',');
  const forceBenchReb = excludeKey !== (pf.lastExcludeKey || '');
  const notes = [];
  if (forceBenchReb) notes.push(`investable universe changed (excluded: ${excludeKey || 'none'}) — benchmark rebuilt`);

  const today = etDate(Date.now());
  const dow = new Date(today + 'T12:00:00Z').getUTCDay();
  if (dow === 0 || dow === 6) { console.log(`${today} is a weekend — nothing to do`); return; }
  if (last && last.d >= today) { console.log(`${today} already recorded — nothing to do`); return; }
  if (etTime() < '16:05:00' && !process.env.FORCE_MARK) {
    console.log(`${etTime()} ET is before today's 4pm close — refusing a premature mark (set FORCE_MARK=1 to override)`);
    return;
  }

  // quotes: Finnhub `c` = latest close, `t` = time of last print (stale on holidays/halts)
  const quotes = {}, freshCandidates = new Set();
  for (const c of data.companies) {
    try {
      const q = await getJSON(`https://finnhub.io/api/v1/quote?symbol=${c.tk}&token=${TOKEN}`);
      if (q && q.c > 0) {
        quotes[c.tk] = q.c;
        if (q.t && etDate(q.t * 1000) === today) freshCandidates.add(c.tk);
      }
    } catch (e) { console.error(`WARN quote ${c.tk}: ${e.message}`); }
  }
  if (freshCandidates.size < 5) {
    const gap = last ? daysBetween(last.d, today) : 0;
    if (gap > 5) { console.error(`FEED DEAD: only ${freshCandidates.size} fresh prints and the ledger is ${gap} days stale — failing loudly.`); process.exit(1); }
    console.log(`${today}: only ${freshCandidates.size} fresh prints — market holiday? Skipping.`); return;
  }

  // forward-fill from the last ledger record, then screen every quote for corporate actions.
  // The accept band is DELIBERATELY narrow (±12%): splits as small as 6:5 must hit the check;
  // a real move outside it costs one Yahoo call and passes on source agreement.
  const px = { ...(last ? last.px : {}) };
  let holdings = pf.holdings, bench = pf.bench;
  let alert = null;
  const gapDays = last ? daysBetween(last.d, today) : 5;
  for (const tk of Object.keys(quotes)) {
    const prev = px[tk];
    if (!(prev > 0)) { px[tk] = quotes[tk]; pf.lastFresh[tk] = today; continue; }   // new listing — no baseline
    const move = quotes[tk] / prev;
    if (move > 0.88 && move < 1.13) { px[tk] = quotes[tk]; pf.suspect[tk] = 0; continue; }
    const chk = await yahooCheck(tk, gapDays);
    const split = chk && chk.splits.find(s => last ? s.d > last.d : false);
    if (split && split.num > 0 && split.den > 0) {
      const f = split.num / split.den;                          // 10:1 forward → shares ×10, price ÷10
      if (holdings.positions[tk]) holdings.positions[tk] *= f;
      if (bench.positions[tk]) bench.positions[tk] *= f;
      // back-adjust the ledger's price history so returns stay continuous across the split —
      // learning, attribution and the chart all read px ratios (standard adjusted-series practice)
      ledger.forEach(rec => { if (rec.px && rec.px[tk] != null) { const v = rec.px[tk] / f; rec.px[tk] = v < 10 ? Math.round(v * 10000) / 10000 : Math.round(v * 100) / 100; } });
      px[tk] = quotes[tk]; pf.suspect[tk] = 0;
      notes.push(`${tk}: ${split.num}:${split.den} split — share counts adjusted ×${f}, ledger price history back-adjusted`);
    } else if (chk === null) {
      // second source UNAVAILABLE ≠ second source disagrees: freeze without quarantine count
      freshCandidates.delete(tk);
      notes.push(`${tk}: ${((move - 1) * 100).toFixed(0)}% move but second source unreachable — frozen today, not counted toward quarantine`);
    } else if (chk.live > 0 && Math.abs(chk.live / quotes[tk] - 1) < 0.10) {
      px[tk] = quotes[tk]; pf.suspect[tk] = 0;                  // two sources agree — a real (violent) move
      if (move <= 0.6 || move >= 1.67) notes.push(`${tk}: real ${((move - 1) * 100).toFixed(0)}% move confirmed by second source`);
    } else {
      pf.suspect[tk] = (pf.suspect[tk] || 0) + 1;               // sources conflict — freeze at prior price
      freshCandidates.delete(tk);
      notes.push(`${tk}: SUSPECT print ${quotes[tk]} vs prior ${prev} (yahoo ${chk.live}) — frozen, day ${pf.suspect[tk]}/3`);
      if (pf.suspect[tk] >= 3) alert = `${tk} suspect print 3 days running (${quotes[tk]} vs ${prev}) — needs manual reconciliation (split? basis? delisting?)`;
    }
  }
  // freshness is stamped only for SCREENED, accepted prints — quarantined names age toward stale
  const freshToday = freshCandidates;
  freshToday.forEach(tk => { pf.lastFresh[tk] = today; });

  // stale names (halted/delisted/renamed): >10 days without a fresh print → uninvestable + frozen
  const stale = new Set();
  for (const tk of Object.keys(px)) {
    if (!universe.has(tk)) { stale.add(tk); if (holdings.positions[tk]) notes.push(`${tk}: no longer in data.json — position frozen, dispose via the proposal path`); continue; }
    const lf = pf.lastFresh[tk];
    if (!lf || daysBetween(lf, today) > 10) {
      stale.add(tk);
      if (holdings.positions[tk] || bench.positions[tk]) notes.push(`${tk}: no fresh print since ${lf || 'ever'} — frozen and uninvestable (halted/delisted?)`);
    }
  }

  // partial feed: mark NAV but never trade on a day where much of the tape is missing
  let tradable = new Set([...freshToday].filter(tk => universe.has(tk)));
  if (freshToday.size < 0.7 * universe.size) {
    notes.push(`partial feed (${freshToday.size}/${universe.size} fresh) — all trading suspended today`);
    tradable = new Set();
  }

  // BTC/ETH: live spot, else forward-fill from the ledger — NEVER the static config fallbacks
  let btc = null, eth = null;
  try { btc = +(await getJSON('https://api.coinbase.com/v2/prices/BTC-USD/spot')).data.amount || null; } catch (e) {}
  try { eth = +(await getJSON('https://api.coinbase.com/v2/prices/ETH-USD/spot')).data.amount || null; } catch (e) {}
  if (btc == null && last && last.btc) { btc = last.btc; notes.push(`Coinbase BTC failed — forward-filled ${btc}`); }
  if (eth == null && last && last.eth) { eth = last.eth; notes.push(`Coinbase ETH failed — forward-filled ${eth}`); }

  const E = createEngine(data, { now: decYear(today) });
  Object.assign(E.ctx.prices, px);
  E.ctx.btc = btc; E.ctx.eth = eth;

  const watch = {};
  (data.watchItems || []).forEach(w => { watch[w.tk] = (watch[w.tk] || 0) + 1; });

  const rows = data.companies.filter(c => px[c.tk] > 0 && !stale.has(c.tk) && !(pf.suspect[c.tk] > 0) && !excluded.has(c.tk)).map(c => {
    const v = E.value(c);
    return { tk: c.tk, price: px[c.tk], target: v.target, ev: v.ev,
             contractedEV: v.contractedEV, legacy: E.legacyOf(c), watch: watch[c.tk] || 0 };
  });

  const ctx = { date: today, rows, px, state: pf.state, params: pf.params,
                holdings, bench, ledger, dayIdx: pf.dayIdx + 1,
                eraStart: pf.backtestThrough, tradable, excluded, forceBenchReb, btc, eth, notes };
  const rec = PC.step(ctx);

  writeAtomic(path.join(ROOT, 'portfolio-history.json'),
    JSON.stringify({ meta: histFile.meta, days: ledger }));
  writeAtomic(path.join(ROOT, 'portfolio.json'), JSON.stringify({
    asOf: today, backtestThrough: pf.backtestThrough, priceSource: pf.priceSource,
    params: pf.params, state: pf.state, suspect: pf.suspect, lastFresh: pf.lastFresh,
    exclude: pf.exclude, lastExcludeKey: excludeKey,
    holdings: { cash: ctx.holdings.cash, positions: Object.fromEntries(Object.entries(ctx.holdings.positions).map(([k, v]) => [k, +v.toFixed(6)])) },
    bench: { cash: ctx.bench.cash, positions: Object.fromEntries(Object.entries(ctx.bench.positions).map(([k, v]) => [k, +v.toFixed(6)])), lastReb: ctx.bench.lastReb },
    dayIdx: ctx.dayIdx,
  }, null, 1));

  console.log(`${today}: NAV ${rec.nav} vs bench ${rec.bench} · gross ${(rec.gross * 100).toFixed(0)}% · λ ${rec.lambda} · ${rec.trades.length} trades${rec.learn ? ` · learn IC ${rec.learn.ic}` : ''}`);
  if (notes.length) notes.forEach(n => console.log('  note: ' + n));
  // the day's record is written and committed first; the workflow turns this into a red run + issue
  if (alert) console.log('PORTFOLIO_ALERT: ' + alert);
}

main().catch(e => { console.error(e); process.exit(1); });
