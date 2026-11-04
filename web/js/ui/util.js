// Small DOM + formatting helpers shared by all views.
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
  return el;
}
export const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '-');
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const pct = (v, d = 0) => (v >= 0 ? '+' : '') + v.toFixed(d) + '%';

export function toast(msg, kind = '') {
  const t = h('div', { class: 'toast ' + kind }, msg);
  $('#toasts').append(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .4s'; setTimeout(() => t.remove(), 450); }, 3800);
}

export function modal(contentEl, { onClose } = {}) {
  const m = $('#modal'), card = $('#modalcard');
  card.replaceChildren(contentEl);
  m.classList.remove('hidden');
  const close = () => { m.classList.add('hidden'); card.replaceChildren(); document.removeEventListener('keydown', esc); if (onClose) onClose(); };
  const esc = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', esc);
  m.onclick = (e) => { if (e.target === m) close(); };
  return close;
}

/** Size a canvas to its CSS box at device pixel ratio; returns a 2d context scaled to CSS pixels. */
export function fitCanvas(canvas, maxDpr = 2) {
  const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
  const w = Math.max(10, Math.round(canvas.clientWidth)), hh = Math.max(10, Math.round(canvas.clientHeight));
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hh * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(hh * dpr); }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h: hh, dpr };
}

export const COLORS = { cyan: '#00f3ff', blue: '#3d7bff', purple: '#a35bff', magenta: '#ff2bd6', green: '#31ff9a', amber: '#ffb020', red: '#ff3b5c', dim: '#566089' };
export const CTRL_COLORS = { fixed: '#ffb020', adaptive: '#3d7bff', evolved: '#00f3ff', expert: '#a35bff', manual: '#31ff9a' };

export function icon(name) {
  const p = {
    command: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
    sim: '<circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/><rect x="7" y="1.5" width="10" height="21" rx="3"/>',
    lab: '<path d="M9 3h6M10 3v6l-5.5 9.5A2 2 0 0 0 6.2 21h11.6a2 2 0 0 0 1.7-2.5L14 9V3"/><path d="M7.5 15h9"/>',
    vision: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    chart: '<path d="M3 3v18h18"/><path d="M7 15l4-5 3 3 5-7"/>',
    flag: '<path d="M5 21V4"/><path d="M5 4h12l-2 4 2 4H5"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.1"/>',
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${p[name] || ''}</svg>`;
}
