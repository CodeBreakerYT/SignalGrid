// Minimal dependency-free canvas charts in the SignalGrid look.
import { fitCanvas } from './util.js';

const GRID = 'rgba(120, 140, 200, .12)', AXIS = 'rgba(140, 155, 210, .55)', TXT = '#8a93b8';

function niceRange(lo, hi) {
  if (!(hi > lo)) { hi = lo + 1; }
  const pad = (hi - lo) * 0.08;
  lo -= pad; hi += pad;
  return [lo, hi];
}

/** series: [{name,color,data:[[x,y],...],dash?,width?,fill?}] */
export function lineChart(canvas, { series, xLabel = '', yLabel = '', yMin, yMax, xMin, xMax, markers } = {}) {
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  const L = 44, R = 12, T = 10, B = 26;
  let xs0 = Infinity, xs1 = -Infinity, ys0 = Infinity, ys1 = -Infinity;
  for (const s of series) for (const [x, y] of s.data) { if (x < xs0) xs0 = x; if (x > xs1) xs1 = x; if (y < ys0) ys0 = y; if (y > ys1) ys1 = y; }
  if (!Number.isFinite(xs0)) { ctx.fillStyle = TXT; ctx.font = '12px sans-serif'; ctx.fillText('no data yet', L + 10, h / 2); return; }
  if (xMin != null) xs0 = xMin; if (xMax != null) xs1 = xMax;
  let [y0, y1] = niceRange(ys0, ys1);
  if (yMin != null) y0 = yMin; if (yMax != null) y1 = yMax;
  if (xs1 === xs0) xs1 = xs0 + 1;
  const X = (x) => L + ((x - xs0) / (xs1 - xs0)) * (w - L - R);
  const Y = (y) => T + (1 - (y - y0) / (y1 - y0)) * (h - T - B);
  ctx.font = '10.5px "Cascadia Mono", monospace'; ctx.fillStyle = TXT; ctx.strokeStyle = GRID; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = y0 + ((y1 - y0) * i) / 4, py = Y(y);
    ctx.beginPath(); ctx.moveTo(L, py); ctx.lineTo(w - R, py); ctx.stroke();
    ctx.textAlign = 'right'; ctx.fillText(Math.abs(y) >= 100 ? y.toFixed(0) : y.toFixed(1), L - 6, py + 3);
  }
  ctx.textAlign = 'center';
  for (let i = 0; i <= 5; i++) { const x = xs0 + ((xs1 - xs0) * i) / 5; ctx.fillText(Math.abs(xs1 - xs0) > 20 ? x.toFixed(0) : x.toFixed(1), X(x), h - B + 14); }
  if (xLabel) { ctx.fillText(xLabel, (L + w - R) / 2, h - 2); }
  if (yLabel) { ctx.save(); ctx.translate(10, (T + h - B) / 2); ctx.rotate(-Math.PI / 2); ctx.fillText(yLabel, 0, 0); ctx.restore(); }
  ctx.strokeStyle = AXIS; ctx.beginPath(); ctx.moveTo(L, T); ctx.lineTo(L, h - B); ctx.lineTo(w - R, h - B); ctx.stroke();
  ctx.save(); ctx.beginPath(); ctx.rect(L, T - 2, w - L - R, h - T - B + 4); ctx.clip();
  for (const s of series) {
    if (!s.data.length) continue;
    ctx.beginPath();
    s.data.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))));
    if (s.fill) { const g = ctx.createLinearGradient(0, T, 0, h - B); g.addColorStop(0, s.color + '55'); g.addColorStop(1, s.color + '00'); ctx.save(); ctx.lineTo(X(s.data[s.data.length - 1][0]), h - B); ctx.lineTo(X(s.data[0][0]), h - B); ctx.fillStyle = g; ctx.fill(); ctx.restore(); ctx.beginPath(); s.data.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y)))); }
    ctx.strokeStyle = s.color; ctx.lineWidth = s.width || 2; ctx.setLineDash(s.dash || []); ctx.shadowColor = s.color; ctx.shadowBlur = s.dash ? 0 : 6; ctx.lineJoin = 'round'; ctx.stroke(); ctx.shadowBlur = 0; ctx.setLineDash([]);
  }
  if (markers) for (const m of markers) { ctx.strokeStyle = m.color || 'rgba(255,255,255,.25)'; ctx.setLineDash([3, 4]); ctx.beginPath(); ctx.moveTo(X(m.x), T); ctx.lineTo(X(m.x), h - B); ctx.stroke(); ctx.setLineDash([]); if (m.label) { ctx.fillStyle = m.color || TXT; ctx.textAlign = 'left'; ctx.fillText(m.label, X(m.x) + 4, T + 10); } }
  ctx.restore();
}

/** Population scatter: every individual's fitness per generation. pts: [{gen, fits:[]}] */
export function swarmChart(canvas, hist, { best = '#00f3ff' } = {}) {
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  const L = 44, R = 12, T = 10, B = 26;
  if (!hist.length) { ctx.fillStyle = TXT; ctx.font = '12px sans-serif'; ctx.fillText('no data yet', L + 10, h / 2); return; }
  let y0 = Infinity, y1 = -Infinity;
  for (const r of hist) for (const f of r.fits) { if (f < y0) y0 = f; if (f > y1) y1 = f; }
  [y0, y1] = niceRange(y0, y1);
  const gmax = Math.max(hist[hist.length - 1].gen, 10);
  const X = (g) => L + (g / gmax) * (w - L - R), Y = (y) => T + (1 - (y - y0) / (y1 - y0)) * (h - T - B);
  ctx.font = '10.5px "Cascadia Mono", monospace'; ctx.fillStyle = TXT; ctx.strokeStyle = GRID;
  for (let i = 0; i <= 4; i++) { const y = y0 + ((y1 - y0) * i) / 4; ctx.beginPath(); ctx.moveTo(L, Y(y)); ctx.lineTo(w - R, Y(y)); ctx.stroke(); ctx.textAlign = 'right'; ctx.fillText(y.toFixed(1), L - 6, Y(y) + 3); }
  ctx.textAlign = 'center';
  for (let i = 0; i <= 5; i++) ctx.fillText(((gmax * i) / 5).toFixed(0), X((gmax * i) / 5), h - B + 14);
  for (const r of hist) {
    const x = X(r.gen);
    r.fits.forEach((f, i) => { ctx.fillStyle = i === 0 ? best : `rgba(163,91,255,${0.18 + 0.2 * (1 - i / r.fits.length)})`; ctx.beginPath(); ctx.arc(x + ((i * 7) % 5) - 2, Y(f), i === 0 ? 2.6 : 1.5, 0, 6.3); ctx.fill(); });
  }
}

/** Grouped horizontal bars. rows: [{label, values:[{v,color,text}]}] */
export function groupBars(canvas, rows, { max } = {}) {
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  const L = 118, R = 56, rowH = h / Math.max(1, rows.length);
  const mx = max || Math.max(...rows.flatMap((r) => r.values.map((v) => v.v)), 1e-9) * 1.05;
  ctx.font = '11.5px "Segoe UI", sans-serif';
  rows.forEach((r, i) => {
    const y = i * rowH, bh = Math.min(12, (rowH - 10) / r.values.length);
    ctx.fillStyle = TXT; ctx.textAlign = 'right'; ctx.fillText(r.label, L - 10, y + rowH / 2 + 4);
    r.values.forEach((v, k) => {
      const by = y + (rowH - bh * r.values.length) / 2 + k * bh, bw = Math.max(1, (v.v / mx) * (w - L - R));
      const g = ctx.createLinearGradient(L, 0, L + bw, 0); g.addColorStop(0, v.color + '55'); g.addColorStop(1, v.color);
      ctx.fillStyle = g; ctx.beginPath(); ctx.roundRect(L, by + 1, bw, bh - 2, 3); ctx.fill();
      ctx.fillStyle = '#c9d3ff'; ctx.textAlign = 'left'; ctx.font = '10.5px "Cascadia Mono", monospace'; ctx.fillText(v.text ?? v.v.toFixed(1), L + bw + 6, by + bh - 2); ctx.font = '11.5px "Segoe UI", sans-serif';
    });
  });
}

export function sparkline(canvas, values, color = '#00f3ff') {
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  if (values.length < 2) return;
  let lo = Math.min(...values), hi = Math.max(...values);
  if (hi - lo < 1e-9) { hi = lo + 1; }
  const X = (i) => (i / (values.length - 1)) * (w - 2) + 1, Y = (v) => h - 3 - ((v - lo) / (hi - lo)) * (h - 6);
  const g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, color + '40'); g.addColorStop(1, color + '00');
  ctx.beginPath(); values.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
  ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.stroke();
  ctx.lineTo(X(values.length - 1), h); ctx.lineTo(0, h); ctx.fillStyle = g; ctx.fill();
}

export function legend(items) {
  return `<div class="legend">${items.map((i) => `<span><i style="background:${i.color}"></i>${i.name}</span>`).join('')}</div>`;
}
