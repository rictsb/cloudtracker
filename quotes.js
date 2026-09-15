/* Live market marks: Finnhub equity quotes + Coinbase BTC/ETH spots, hourly (WP-Quotes).
 * Feeds CloudModel's marks store (setMarks) and repaints via CVApp.refresh, so marks
 * survive every recalculation (handoff hazard 2). Fetch failures leave saved prices in
 * place — captions must only ever claim marks that exist. No token → no requests. */
(function (root) {
  'use strict';
  let FETCHING = false, timer = null;

  async function quote(tk, token) {
    try {
      const r = await fetch('https://finnhub.io/api/v1/quote?symbol=' + encodeURIComponent(tk) + '&token=' + token);
      if (!r.ok) return null;
      const j = await r.json();
      return (j && typeof j.c === 'number' && j.c > 0) ? j.c : null;
    } catch (e) { return null; }
  }

  async function spot(pair) {
    try {
      const r = await fetch('https://api.coinbase.com/v2/prices/' + pair + '/spot');
      if (!r.ok) return null;
      const j = await r.json();
      const p = parseFloat(j && j.data && j.data.amount);
      return p > 0 ? p : null;
    } catch (e) { return null; }
  }

  async function refresh() {
    const token = root.FINNHUB_TOKEN || '';
    if (FETCHING || !token || !root.CloudModel || !root.CloudModel.source) return;
    FETCHING = true;
    try {
      const tks = root.CloudModel.source.companies.map(c => c.tk);
      const [entries, btc, eth] = await Promise.all([
        Promise.all(tks.map(async tk => [tk, await quote(tk, token)])),
        spot('BTC-USD'),
        spot('ETH-USD')
      ]);
      const prices = Object.fromEntries(entries.filter(e => e[1] != null));
      const marks = {};
      if (Object.keys(prices).length) marks.prices = prices;
      if (btc != null) marks.btc = btc;
      if (eth != null) marks.eth = eth;
      if (!Object.keys(marks).length) return;
      marks.asOf = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      root.CloudModel.setMarks(marks);
      if (root.CVApp) root.CVApp.refresh();
    } finally { FETCHING = false; }
  }

  root.Quotes = {
    start() { if (timer) return; refresh(); timer = setInterval(refresh, 3600000); },
    refresh
  };
})(typeof window !== 'undefined' ? window : globalThis);
