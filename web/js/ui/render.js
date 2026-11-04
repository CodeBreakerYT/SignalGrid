// Canvas renderer for the traffic simulator: roads, markings, signals, pedestrians, vehicles.
import { GEO, DT, poseOf } from '../core/sim.js';
import { DIRS } from '../core/scenarios.js';
import { fitCanvas } from './util.js';

const CAR_COLORS = ['#4cc9f0', '#7b8cff', '#b388ff', '#3ddc97', '#5eead4', '#93c5fd', '#c4b5fd', '#67e8f9'];
const SIG = { green: '#31ff9a', amber: '#ffb020', red: '#ff3b5c' };
const rightVec = (h) => [-DIRS[h][1], DIRS[h][0]];

export class SimView {
  constructor(canvas, { onSelect, interactive = true } = {}) {
    this.canvas = canvas; this.sim = null; this.selected = 0; this.onSelect = onSelect; this.interactive = interactive;
    this.cam = null; this.userCam = false; this.size = { w: 0, h: 0 };
    this.showHeat = true;
    if (interactive) this.bind();
  }

  setSim(sim) { this.sim = sim; this.userCam = false; this.cam = null; this.selected = Math.min(this.selected, sim.nodes.length - 1); }

  bounds() {
    const s = this.sim, ext = GEO.L + GEO.half + 14;
    return { x0: -ext, y0: -ext, x1: (s.nx - 1) * s.S + ext, y1: (s.ny - 1) * s.S + ext };
  }

  fit(w, h) {
    const b = this.bounds(), sw = b.x1 - b.x0, sh = b.y1 - b.y0;
    const scale = Math.min(w / sw, h / sh) * 0.98;
    this.cam = { scale, x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2, base: scale };
  }

  bind() {
    const c = this.canvas;
    let drag = null;
    c.addEventListener('pointerdown', (e) => { c.setPointerCapture(e.pointerId); drag = { x: e.clientX, y: e.clientY, moved: false, cx: this.cam?.x, cy: this.cam?.y }; });
    c.addEventListener('pointermove', (e) => {
      if (!drag || !this.cam) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      if (drag.moved) { this.cam.x = drag.cx - dx / this.cam.scale; this.cam.y = drag.cy - dy / this.cam.scale; this.userCam = true; }
    });
    c.addEventListener('pointerup', (e) => {
      if (drag && !drag.moved) this.pick(e);
      drag = null;
    });
    c.addEventListener('wheel', (e) => {
      if (!this.cam) return;
      e.preventDefault();
      const r = c.getBoundingClientRect(), mx = e.clientX - r.left - r.width / 2, my = e.clientY - r.top - r.height / 2;
      const wx = this.cam.x + mx / this.cam.scale, wy = this.cam.y + my / this.cam.scale;
      const k = Math.exp(-e.deltaY * 0.0012);
      this.cam.scale = Math.min(this.cam.base * 8, Math.max(this.cam.base * 0.6, this.cam.scale * k));
      this.cam.x = wx - mx / this.cam.scale; this.cam.y = wy - my / this.cam.scale; this.userCam = true;
    }, { passive: false });
    c.addEventListener('dblclick', () => { this.userCam = false; this.cam = null; });
  }

  pick(e) {
    if (!this.sim || !this.cam) return;
    const r = this.canvas.getBoundingClientRect();
    const wx = this.cam.x + (e.clientX - r.left - r.width / 2) / this.cam.scale, wy = this.cam.y + (e.clientY - r.top - r.height / 2) / this.cam.scale;
    let best = null, bd = 1e9;
    for (const n of this.sim.nodes) { const d = Math.hypot(n.cx - wx, n.cy - wy); if (d < bd) { bd = d; best = n; } }
    if (best && bd < 60) { this.selected = best.id; if (this.onSelect) this.onSelect(best); }
  }

  /** world (metres) -> CSS pixels of the canvas, valid after draw(). */
  toScreen(x, y) { const c = this.cam; return [(x - c.x) * c.scale + this.size.w / 2, (y - c.y) * c.scale + this.size.h / 2]; }

  focusNode(id) {
    const n = this.sim.nodes[id];
    if (!n || !this.cam) return;
    this.selected = id;
  }

  /** frac in [0,1): how far we are between the previous and the current simulation step. */
  draw(frac = 1) {
    const sim = this.sim; if (!sim) return;
    const { ctx, w, h } = fitCanvas(this.canvas);
    this.size = { w, h };
    if (!this.cam || !this.userCam) this.fit(w, h);
    const cam = this.cam;
    ctx.fillStyle = '#05060d'; ctx.fillRect(0, 0, w, h);
    ctx.save();
    ctx.translate(w / 2, h / 2); ctx.scale(cam.scale, cam.scale); ctx.translate(-cam.x, -cam.y);
    this.drawGround(ctx);
    for (const n of sim.nodes) this.drawRoads(ctx, n);
    if (this.showHeat) for (const l of sim.links) this.drawHeat(ctx, l);
    for (const n of sim.nodes) this.drawMarkings(ctx, n);
    for (const n of sim.nodes) this.drawSignals(ctx, n);
    for (const n of sim.nodes) this.drawPeds(ctx, n);
    this.drawVehicles(ctx, frac);
    for (const n of sim.nodes) this.drawNodeTag(ctx, n);
    ctx.restore();
  }

  /** Paint roads + markings (no vehicles) onto `canvas`, mapping the world rectangle `b` to the full canvas. */
  paintStatic(canvas, b) {
    const ctx = canvas.getContext('2d'), k = canvas.width / (b.x1 - b.x0);
    ctx.fillStyle = '#080b17'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    this.roadFill = '#1c2445'; this.lw = 2.4;
    ctx.save(); ctx.scale(k, k); ctx.translate(-b.x0, -b.y0);
    this.drawGround(ctx);
    for (const n of this.sim.nodes) this.drawRoads(ctx, n);
    for (const n of this.sim.nodes) this.drawMarkings(ctx, n);
    ctx.restore();
  }

  drawGround(ctx) {
    const b = this.bounds();
    ctx.strokeStyle = 'rgba(80,100,170,.07)'; ctx.lineWidth = 0.4;
    ctx.beginPath();
    for (let x = Math.floor(b.x0 / 20) * 20; x <= b.x1; x += 20) { ctx.moveTo(x, b.y0); ctx.lineTo(x, b.y1); }
    for (let y = Math.floor(b.y0 / 20) * 20; y <= b.y1; y += 20) { ctx.moveTo(b.x0, y); ctx.lineTo(b.x1, y); }
    ctx.stroke();
  }

  drawRoads(ctx, n) {
    const ext = GEO.L + GEO.half;
    ctx.fillStyle = this.roadFill || '#0d1122';
    ctx.fillRect(n.cx - ext, n.cy - GEO.half, 2 * ext, 2 * GEO.half);
    ctx.fillRect(n.cx - GEO.half, n.cy - ext, 2 * GEO.half, 2 * ext);
    ctx.strokeStyle = 'rgba(0,243,255,.45)'; ctx.lineWidth = 0.5 * (this.lw || 1);
    for (const sgn of [-1, 1]) {
      ctx.beginPath(); ctx.moveTo(n.cx - ext, n.cy + sgn * GEO.half); ctx.lineTo(n.cx - GEO.half, n.cy + sgn * GEO.half); ctx.moveTo(n.cx + GEO.half, n.cy + sgn * GEO.half); ctx.lineTo(n.cx + ext, n.cy + sgn * GEO.half);
      ctx.moveTo(n.cx + sgn * GEO.half, n.cy - ext); ctx.lineTo(n.cx + sgn * GEO.half, n.cy - GEO.half); ctx.moveTo(n.cx + sgn * GEO.half, n.cy + GEO.half); ctx.lineTo(n.cx + sgn * GEO.half, n.cy + ext);
      ctx.stroke();
    }
  }

  drawHeat(ctx, l) {
    const q = l.stopped || 0;
    if (q < 2) return;
    const h = l.h, d = DIRS[h], r = rightVec(h), node = l.node;
    const len = Math.min(GEO.L, 6 + q * 7.5), a = Math.min(0.5, 0.08 + q * 0.03);
    const x0 = node.cx - d[0] * GEO.half + r[0] * 3.5, y0 = node.cy - d[1] * GEO.half + r[1] * 3.5;
    const x1 = x0 - d[0] * len, y1 = y0 - d[1] * len;
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, `rgba(255,59,92,${a})`); g.addColorStop(1, 'rgba(255,59,92,0)');
    ctx.strokeStyle = g; ctx.lineWidth = 7; ctx.lineCap = 'butt';
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
  }

  drawMarkings(ctx, n) {
    const ext = GEO.L + GEO.half;
    ctx.lineWidth = 0.35 * (this.lw || 1);
    // centre lines
    ctx.strokeStyle = 'rgba(255,176,32,.55)';
    ctx.beginPath();
    for (const o of [-0.25, 0.25]) {
      ctx.moveTo(n.cx - ext, n.cy + o); ctx.lineTo(n.cx - GEO.half, n.cy + o); ctx.moveTo(n.cx + GEO.half, n.cy + o); ctx.lineTo(n.cx + ext, n.cy + o);
      ctx.moveTo(n.cx + o, n.cy - ext); ctx.lineTo(n.cx + o, n.cy - GEO.half); ctx.moveTo(n.cx + o, n.cy + GEO.half); ctx.lineTo(n.cx + o, n.cy + ext);
    }
    ctx.stroke();
    // lane dividers
    ctx.strokeStyle = 'rgba(200,215,255,.3)'; ctx.setLineDash([3, 4]);
    ctx.beginPath();
    for (let h = 0; h < 4; h++) {
      const d = DIRS[h], r = rightVec(h);
      for (const lat of [3.5, -3.5]) {
        ctx.moveTo(n.cx - d[0] * GEO.half + r[0] * lat, n.cy - d[1] * GEO.half + r[1] * lat);
        ctx.lineTo(n.cx - d[0] * ext + r[0] * lat, n.cy - d[1] * ext + r[1] * lat);
      }
    }
    ctx.stroke(); ctx.setLineDash([]);
    // crosswalk zebra
    ctx.fillStyle = 'rgba(225,235,255,.22)';
    for (let h = 0; h < 4; h++) {
      const d = DIRS[h], r = rightVec(h);
      for (let lat = -6.3; lat <= 6.3; lat += 1.5) {
        const cx = n.cx - d[0] * (GEO.half - 2) + r[0] * lat, cy = n.cy - d[1] * (GEO.half - 2) + r[1] * lat;
        ctx.save(); ctx.translate(cx, cy); ctx.rotate(Math.atan2(d[1], d[0])); ctx.fillRect(-1.4, -0.4, 2.8, 0.8); ctx.restore();
      }
    }
  }

  drawSignals(ctx, n) {
    const sig = n.sig;
    for (let h = 0; h < 4; h++) {
      const d = DIRS[h], r = rightVec(h);
      for (let lane = 0; lane < 2; lane++) {
        const ph = (h % 2 === 0 ? 0 : 2) + lane;
        let col = SIG.red;
        if (sig.phase === ph) col = sig.state === 'green' ? SIG.green : sig.state === 'amber' ? SIG.amber : SIG.red;
        const lat0 = lane === 0 ? 3.6 : 0.2, lat1 = lane === 0 ? 6.9 : 3.4;
        ctx.strokeStyle = col; ctx.lineWidth = 0.9; ctx.shadowColor = col; ctx.shadowBlur = 6;
        ctx.beginPath();
        ctx.moveTo(n.cx - d[0] * GEO.half + r[0] * lat0, n.cy - d[1] * GEO.half + r[1] * lat0);
        ctx.lineTo(n.cx - d[0] * GEO.half + r[0] * lat1, n.cy - d[1] * GEO.half + r[1] * lat1);
        ctx.stroke(); ctx.shadowBlur = 0;
      }
      // signal head beside the road
      const px = n.cx - d[0] * (GEO.half + 1.5) + r[0] * 8.6, py = n.cy - d[1] * (GEO.half + 1.5) + r[1] * 8.6;
      ctx.fillStyle = '#05060d'; ctx.strokeStyle = 'rgba(0,243,255,.3)'; ctx.lineWidth = 0.3;
      ctx.beginPath(); ctx.roundRect(px - 1.3, py - 2.5, 2.6, 5, 0.8); ctx.fill(); ctx.stroke();
      for (let k = 0; k < 2; k++) {
        const ph = (h % 2 === 0 ? 0 : 2) + k;
        let col = SIG.red;
        if (sig.phase === ph) col = sig.state === 'green' ? SIG.green : sig.state === 'amber' ? SIG.amber : SIG.red;
        ctx.fillStyle = col; ctx.shadowColor = col; ctx.shadowBlur = 5;
        ctx.beginPath(); ctx.arc(px, py - 1.2 + k * 2.4, 0.85, 0, 6.3); ctx.fill(); ctx.shadowBlur = 0;
      }
    }
  }

  drawPeds(ctx, n) {
    const t = this.sim.t;
    for (let c = 0; c < 4; c++) {
      const d = DIRS[c], r = rightVec(c);
      const base = [n.cx - d[0] * (GEO.half - 2), n.cy - d[1] * (GEO.half - 2)];
      const walkPhase = c % 2 === 0 ? 2 : 0;
      const walk = n.sig.phase === walkPhase && n.sig.state === 'green' && n.sig.pending < 0;
      const q = n.pedQ[c];
      ctx.fillStyle = walk ? SIG.green : SIG.red; ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = 5;
      for (const side of [-1, 1]) { ctx.beginPath(); ctx.arc(base[0] + r[0] * side * (GEO.half + 0.8) - d[0] * 2.6, base[1] + r[1] * side * (GEO.half + 0.8) - d[1] * 2.6, 0.6, 0, 6.3); ctx.fill(); }
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#ff9bf0';
      for (let i = 0; i < Math.min(q.length, 9); i++) {
        const lat = (i % 2 ? 1 : -1) * (GEO.half + 1.6 + (i >> 1) * 0.9);
        ctx.beginPath(); ctx.arc(base[0] + r[0] * lat + d[0] * ((i % 3) - 1) * 0.5, base[1] + r[1] * lat + d[1] * ((i % 3) - 1) * 0.5, 0.55, 0, 6.3); ctx.fill();
      }
      ctx.fillStyle = '#ffffff'; ctx.shadowColor = '#ff2bd6'; ctx.shadowBlur = 5;
      for (const p of n.pedCross[c]) {
        const prog = Math.min(1, (t - p.start) / (p.end - p.start));
        const lat = p.dir * (-GEO.half + 2 * GEO.half * prog);
        const off = (p.off * 2 - 1) * 1.1;
        ctx.beginPath(); ctx.arc(base[0] + r[0] * lat + d[0] * off, base[1] + r[1] * lat + d[1] * off, 0.6, 0, 6.3); ctx.fill();
      }
      ctx.shadowBlur = 0;
    }
  }

  drawVehicles(ctx, frac) {
    const sim = this.sim, t = sim.t;
    for (const link of sim.links) {
      for (const arr of link.lanes) {
        for (const v of arr) {
          const adv = v.crashed ? 0 : -v.v * DT * frac;
          const p = poseOf(sim, link, v, v.s + adv);
          this.drawVehicle(ctx, v, p, t);
        }
      }
    }
  }

  drawVehicle(ctx, v, p, t) {
    const len = v.len, wd = v.w;
    ctx.save();
    ctx.translate(p.x, p.y); ctx.rotate(p.a);
    let body = CAR_COLORS[v.id % CAR_COLORS.length];
    if (v.type === 'truck') body = '#ffb020'; else if (v.type === 'bus') body = '#ff2bd6'; else if (v.type === 'emerg') body = '#f4f7ff';
    if (v.crashed) body = '#ff3b5c';
    ctx.shadowColor = v.type === 'emerg' ? ((Math.floor(t * 5) % 2) ? '#ff3b5c' : '#3d7bff') : body; ctx.shadowBlur = v.type === 'emerg' ? 12 : 4;
    ctx.fillStyle = body; ctx.globalAlpha = 0.92;
    ctx.beginPath(); ctx.roundRect(-len / 2, -wd / 2, len, wd, Math.min(1, wd * 0.4)); ctx.fill();
    ctx.shadowBlur = 0; ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(5,8,20,.65)';
    ctx.fillRect(-len * 0.12, -wd * 0.36, len * 0.38, wd * 0.72);
    if (v.v < 0.6 && !v.crashed) { ctx.fillStyle = '#ff3b5c'; ctx.fillRect(-len / 2, -wd * 0.4, 0.55, wd * 0.25); ctx.fillRect(-len / 2, wd * 0.15, 0.55, wd * 0.25); }
    ctx.fillStyle = 'rgba(255,245,200,.9)'; ctx.fillRect(len / 2 - 0.5, -wd * 0.4, 0.5, wd * 0.22); ctx.fillRect(len / 2 - 0.5, wd * 0.18, 0.5, wd * 0.22);
    if (v.type === 'emerg') {
      const f = Math.floor(t * 6) % 2;
      ctx.fillStyle = f ? '#ff3b5c' : '#3d7bff'; ctx.fillRect(-0.4, -wd / 2, 0.9, wd / 2);
      ctx.fillStyle = f ? '#3d7bff' : '#ff3b5c'; ctx.fillRect(-0.4, 0, 0.9, wd / 2);
    }
    if (v.crashed) {
      ctx.strokeStyle = (Math.floor(t * 3) % 2) ? '#ffb020' : '#ff3b5c'; ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.arc(0, 0, len * 0.9, 0, 6.3); ctx.stroke();
    }
    ctx.restore();
  }

  drawNodeTag(ctx, n) {
    const sel = n.id === this.selected && this.sim.nodes.length > 1;
    if (sel) { ctx.strokeStyle = 'rgba(0,243,255,.75)'; ctx.lineWidth = 0.8; ctx.setLineDash([2, 2]); ctx.strokeRect(n.cx - GEO.half - 2, n.cy - GEO.half - 2, 2 * GEO.half + 4, 2 * GEO.half + 4); ctx.setLineDash([]); }
    if (this.sim.nodes.length > 1) {
      ctx.fillStyle = sel ? '#00f3ff' : 'rgba(180,195,255,.55)'; ctx.font = '600 4px "Cascadia Mono", monospace'; ctx.textAlign = 'center';
      ctx.fillText('J' + (n.id + 1), n.cx, n.cy + 1.4);
    }
  }
}

/** Advances a simulation in wall-clock time with a speed multiplier. */
export class SimRunner {
  constructor(sim) { this.sim = sim; this.speed = 1; this.paused = false; this.acc = 0; this.maxSteps = 600; }
  get done() { return this.sim.t >= this.sim.sc.duration - 1e-9; }
  /** @returns fraction between steps (for interpolation). */
  advance(realDt) {
    if (this.paused || this.done) return this.acc / DT;
    this.acc += Math.min(realDt, 0.1) * this.speed;
    let n = 0;
    while (this.acc >= DT && n < this.maxSteps && !this.done) { this.sim.step(); this.acc -= DT; n++; }
    if (n >= this.maxSteps) this.acc = 0;
    return Math.min(1, this.acc / DT);
  }
}
