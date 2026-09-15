/* Graphical research reports. Presentation only: every value comes from the
   published one-pager payload; no model inputs or calculations are changed. */
(function (root) {
  'use strict';
  const C = { ink: '#263c64', muted: '#657083', grid: '#e5eaf1', blue: '#345cd0', future: '#b3c6ed', gold: '#bd9b54', purple: '#8777af', teal: '#3e918a' };
  const esc = x => String(x == null ? '' : x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (x, digits = 0) => Number(x).toLocaleString('en-US', { maximumFractionDigits: digits });
  const quarter = q => Number(String(q).slice(0, 4)) * 4 + Number(String(q).slice(-1)) - 1;
  const qLabel = q => String(q).slice(0, 4) + ' Q' + String(q).slice(-1);
  const text = (x, y, label, opt = '') => '<text x="' + x + '" y="' + y + '" fill="' + C.muted + '" font-size="12" ' + opt + '>' + esc(label) + '</text>';
  const line = (x1, y1, x2, y2, extra = '') => '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" stroke="' + C.grid + '" ' + extra + '/>';
  const rect = (x, y, w, h, color, label) => '<rect x="' + x + '" y="' + y + '" width="' + Math.max(0, w) + '" height="' + Math.max(0, h) + '" rx="2" fill="' + color + '" tabindex="0" role="img" aria-label="' + esc(label) + '"><title>' + esc(label) + '</title></rect>';
  const svg = (P, key, h, min, title, desc, body) => '<svg class="report-graphic report-graphic-' + key + '" viewBox="0 0 1000 ' + h + '" style="display:block;width:100%;min-width:' + min + 'px;height:auto;font-family:inherit" role="img" aria-labelledby="rg-' + esc(P.tk) + '-' + key + '-title rg-' + esc(P.tk) + '-' + key + '-desc"><title id="rg-' + esc(P.tk) + '-' + key + '-title">' + esc(title) + '</title><desc id="rg-' + esc(P.tk) + '-' + key + '-desc">' + esc(desc) + '</desc>' + body + '</svg>';
  function legend(items, y = 17) {
    let x = 68;
    return items.map(([label, color]) => {
      const b = '<rect x="' + x + '" y="' + (y - 9) + '" width="10" height="10" rx="2" fill="' + color + '"/>' + text(x + 16, y, label);
      x += label.length * 6.5 + 43;
      return b;
    }).join('');
  }
  function nice(max) {
    if (!(max > 0)) return 1;
    const base = Math.pow(10, Math.floor(Math.log10(max)));
    return [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map(x => x * base).find(x => x >= max) || base * 10;
  }

  function timeline(P) {
    const L = 255, R = 27, first = quarter('2026Q1'), end = quarter((Number(P.year) + 1) + 'Q1');
    const x = q => L + (q - first) / (end - first) * (1000 - L - R);
    let top = 49;
    const layouts = (P.gantt || []).map(site => {
      const historical = [], future = [];
      (site[2] || []).forEach(t => {
        const start = quarter(t[2]), finish = quarter(t[3]) + Number(t[4] || 0);
        const item = { t, start, finish };
        if (finish <= first) historical.push(item);
        else if (start < end) future.push(item);
      });
      const laneEnds = historical.length ? [end] : [];
      future.sort((a, b) => a.start - b.start || a.finish - b.finish).forEach(item => {
        const start = Math.max(first, item.start), finish = Math.max(start + .1, Math.min(end, item.finish));
        let lane = laneEnds.findIndex(v => v <= start);
        if (lane < 0) lane = laneEnds.length;
        laneEnds[lane] = finish + .08;
        item.lane = lane; item.plotStart = start; item.plotEnd = finish;
      });
      const height = Math.max(36, 4 + laneEnds.length * 16), out = { site, historical, future, top, height };
      top += height;
      return out;
    });
    const H = top + 29;
    let b = legend([['Signed at snapshot', C.blue], ['Future assumed / unsigned', C.future]]);
    b += text(1000 - R, 17, 'Labels: IT MW', 'text-anchor="end"');
    for (let year = 2026; year <= Number(P.year); year++) {
      const a = x(quarter(year + 'Q1')), z = x(quarter((year + 1) + 'Q1'));
      if (year % 2 === 0) b += '<rect x="' + a + '" y="43" width="' + (z - a) + '" height="' + (top - 43) + '" fill="#f6f8fb"/>';
      b += line(a, 42, a, top) + text((a + z) / 2, 37, year, 'text-anchor="middle" font-weight="600"');
    }
    layouts.forEach(({ site, historical, future, top: y, height }) => {
      const total = (site[2] || []).reduce((a, t) => a + Number(t[1] || 0), 0);
      b += text(16, y + 13, site[0], 'style="fill:' + C.ink + ';font-size:13px;font-weight:600"');
      b += text(16, y + 27, num(total) + ' IT MW in schedule', 'style="font-size:10px"');
      if (historical.length) {
        const mw = historical.reduce((a, item) => a + Number(item.t[1]), 0);
        const desc = num(mw) + ' IT MW already in place before 2026. ' + historical.map(({ t }) => t[0] + ': ' + num(t[1]) + ' IT MW; energised ' + qLabel(t[2]) + ', first revenue ' + qLabel(t[3]) + ', ' + (t[5] ? 'signed' : 'unsigned')).join('. ');
        b += rect(L, y, 8, 14, C.blue, desc) + text(L + 15, y + 11, num(mw) + ' in place before 2026', 'style="font-size:10px;fill:' + C.ink + '"');
      }
      future.forEach(({ t, plotStart, plotEnd, lane }) => {
        const bx = x(plotStart), by = y + lane * 16, w = x(plotEnd) - bx - 2;
        const desc = site[0] + ' — ' + t[0] + ': ' + num(t[1]) + ' IT MW; energised ' + qLabel(t[2]) + '; first revenue ' + qLabel(t[3]) + '; commissioning ramp ' + num(t[4]) + ' quarters; ' + (t[5] ? 'signed at snapshot' : 'future assumed / unsigned');
        b += rect(bx, by, Math.max(4, w), 14, t[5] ? C.blue : C.future, desc);
        const firstRevenue = quarter(t[3]);
        if (firstRevenue >= first && firstRevenue < end) {
          const rx = x(firstRevenue);
          b += '<line x1="' + rx + '" x2="' + rx + '" y1="' + (by - 1) + '" y2="' + (by + 15) + '" stroke="' + C.ink + '" stroke-width="1.2" pointer-events="none"><title>' + esc(site[0] + ' — ' + t[0] + ': first revenue ' + qLabel(t[3])) + '</title></line>';
        }
        if (w >= 30) b += text(bx + w / 2, by + 10.5, num(t[1]), 'text-anchor="middle" style="font-size:10px;fill:' + (t[5] ? '#ffffff' : C.ink) + ';pointer-events:none"');
      });
      if (site[3]) {
        const sx = 6, sy = y + 8;
        const title = site[0] + ': substation energised ' + qLabel(site[3]) + (quarter(site[3]) < first ? ' (before the displayed range)' : '');
        b += '<path d="M' + (sx - 4) + ' ' + (sy + 4) + ' l4 -7 l4 7 z" fill="' + C.ink + '" tabindex="0" role="img" aria-label="' + esc(title) + '"><title>' + esc(title) + '</title></path>';
      }
      b += line(9, y + height - 4, 1000 - R, y + height - 4);
    });
    b += text(L, H - 8, '▲ Substation date on hover · bar: energisation through commissioning · tick: first revenue', 'style="font-size:10px"');
    return svg(P, 'timeline', H, 880, P.name + ': when power comes online', 'Campus and capacity tranche schedule, 2026 through ' + P.year + '. Separate lanes preserve overlapping tranches. Blue means signed at the research snapshot; pale blue means future assumed capacity. Labels and schedule totals are IT MW. A thin tick marks first revenue. Earlier operating tranches are explicitly marked in place. Campus triangles disclose substation dates on focus or hover.', b);
  }

  function fleet(P) {
    const rows = P.Q || [], L = 68, R = 24, top = 55, bottom = 266, H = 304;
    const maximum = nice(Math.max(1, ...rows.map(q => Object.values(q[7] || {}).reduce((a, v) => a + Number(v || 0), 0))) * 1.1);
    const y = v => bottom - v / maximum * (bottom - top), band = (1000 - L - R) / Math.max(1, rows.length);
    const gens = [['hopper', 'Hopper', C.gold], ['blackwell', 'Blackwell', C.blue], ['rubin', 'Rubin', C.purple], ['next', 'Next generation', C.teal]];
    let b = legend(gens.map(g => [g[1], g[2]]));
    b += text(1000 - R, 17, 'Year-end labels: earning IT MW', 'text-anchor="end"');
    for (let i = 0; i <= 4; i++) { const value = maximum * i / 4; b += line(L, y(value), 1000 - R, y(value)) + text(L - 9, y(value) + 4, value >= 1e6 ? num(value / 1e6, 2) + 'm' : num(value / 1000) + 'k', 'text-anchor="end"'); }
    rows.forEach((q, i) => {
      const cx = L + band * (i + .5), w = Math.min(30, band - 9); let total = 0;
      gens.forEach(([key, label, color]) => {
        const value = Number((q[7] || {})[key] || 0); if (!value) return;
        b += rect(cx - w / 2, y(total + value), w, Math.max(1, y(total) - y(total + value) - 1), color, qLabel(q[0]) + ' — ' + label + ': ' + num(value) + ' earning GPU packages; fleet total ' + num(q[6]) + ' earning GPU packages and ' + num(q[4]) + ' earning IT MW'); total += value;
      });
      if (/Q4$/.test(q[0])) b += text(cx, y(total) - 8, num(q[4]) + ' IT MW', 'text-anchor="middle" style="fill:' + C.ink + ';font-size:11px;font-weight:600"');
      if (i === 0 || /Q[24]$/.test(q[0])) b += text(cx, bottom + 23, String(q[0]).slice(2, 4) + ' Q' + String(q[0]).slice(-1), 'text-anchor="middle" style="font-size:11px"');
    });
    return svg(P, 'fleet', H, 740, P.name + ': earning GPU packages by generation', 'Quarterly stacked earning GPU package counts for Hopper, Blackwell, Rubin and next-generation hardware. Year-end labels show earning IT MW, a different measure from the GPU-package-count axis.', b);
  }

  function arr(P) {
    const start = P.finance && P.finance.T0 || '2026Q3', rows = (P.A || []).filter(r => r[0] >= start);
    const L = 68, R = 24, top = 55, bottom = 266, H = 304, maximum = nice(Math.max(1, ...rows.map(r => Number(r[1]))) * 1.1);
    const y = v => bottom - v / maximum * (bottom - top), band = (1000 - L - R) / Math.max(1, rows.length);
    let b = legend([['Contracts signed at snapshot', C.blue], ['Future assumed contracts', C.future]]);
    b += text(1000 - R, 17, 'Contracted ARR · $bn', 'text-anchor="end"');
    for (let i = 0; i <= 4; i++) { const value = maximum * i / 4; b += line(L, y(value), 1000 - R, y(value)) + text(L - 9, y(value) + 4, '$' + num(value, 1), 'text-anchor="end"'); }
    rows.forEach((r, i) => {
      const cx = L + band * (i + .5), w = Math.min(30, band - 9), signed = Number(r[2]), model = Number(r[1]), future = Math.max(0, model - signed);
      b += rect(cx - w / 2, y(signed), w, bottom - y(signed), C.blue, qLabel(r[0]) + ': $' + num(signed, 2) + 'bn ARR from contracts signed at the ' + P.asOf + ' snapshot');
      if (future > 0) b += rect(cx - w / 2, y(model), w, Math.max(1, y(signed) - y(model) - 1), C.future, qLabel(r[0]) + ': $' + num(future, 2) + 'bn ARR from future assumed contracts; total modeled contracted ARR $' + num(model, 2) + 'bn');
      if (/Q4$/.test(r[0])) b += text(cx, y(model) - 8, '$' + num(model, 1) + 'bn', 'text-anchor="middle" style="fill:' + C.ink + ';font-size:11px;font-weight:600"');
      if (i === 0 || /Q[24]$/.test(r[0])) b += text(cx, bottom + 23, String(r[0]).slice(2, 4) + ' Q' + String(r[0]).slice(-1), 'text-anchor="middle" style="font-size:11px"');
    });
    return svg(P, 'arr', H, 740, P.name + ': signed and modeled contracted ARR', 'Quarterly annual recurring revenue in billions of US dollars. Solid blue is covered by contracts signed at the research snapshot. Pale blue is additional revenue from future assumed signings. Their sum is modeled contracted ARR; it excludes spot and differs from recognized revenue.', b);
  }
  root.ReportGraphics = { timeline, fleet, arr };
})(typeof window !== 'undefined' ? window : globalThis);
