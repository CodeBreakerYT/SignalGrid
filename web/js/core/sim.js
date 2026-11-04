// SignalGrid traffic engine: car-following (IDM) vehicles on two-lane approaches, 4-phase signals,
// pedestrian crossings, emergency vehicles, incidents, and a grid of coupled intersections.
// Pure, deterministic, DOM-free: the same code drives the browser UI and the Node benchmarks.
import { DIRS, MOVE, VTYPES, buildScenario } from './scenarios.js';

export const DT = 0.25;
export const GEO = { L: 100, half: 7, lat: [5.25, 1.75] }; // approach length, road half-width, lane offsets (lane0 = through/right, lane1 = left)
export const SAFETY = {
  minGreen: [8, 5, 8, 5],
  maxGreen: [55, 22, 55, 22],
  amber: 3,
  allRed: 2,
  pedClearMax: 12,
  starve: 90, // any waiting vehicle/pedestrian older than this forces service (fairness guard)
  decisionEvery: 1,
};
export const PHASES = [
  { id: 0, name: 'E-W Through', short: 'EW', lanes: [[0, 0], [2, 0]], walk: [1, 3] },
  { id: 1, name: 'E-W Left', short: 'EWL', lanes: [[0, 1], [2, 1]], walk: [] },
  { id: 2, name: 'N-S Through', short: 'NS', lanes: [[1, 0], [3, 0]], walk: [0, 2] },
  { id: 3, name: 'N-S Left', short: 'NSL', lanes: [[1, 1], [3, 1]], walk: [] },
];
const phaseOf = (h, lane) => (h % 2 === 0 ? 0 : 2) + lane;
const servedPhaseOfCrosswalk = (c) => (c % 2 === 0 ? 2 : 0);

const IDM = { a: 1.7, b: 2.5, T: 1.2, s0: 2.0, delta: 4, bmax: 9 };

// ---- junction paths (local coords, centre at 0,0) ----
const rightVec = (h) => [-DIRS[h][1], DIRS[h][0]];
export function boxPath(h, move, laneIn, laneOut) {
  const d = DIRS[h], r = rightVec(h);
  const h2 = move === MOVE.T ? h : move === MOVE.L ? (h + 3) % 4 : (h + 1) % 4;
  const d2 = DIRS[h2], r2 = rightVec(h2);
  const p0 = [-d[0] * GEO.half + r[0] * GEO.lat[laneIn], -d[1] * GEO.half + r[1] * GEO.lat[laneIn]];
  const p2 = [d2[0] * GEO.half + r2[0] * GEO.lat[laneOut], d2[1] * GEO.half + r2[1] * GEO.lat[laneOut]];
  let c;
  if (move === MOVE.T) c = [(p0[0] + p2[0]) / 2, (p0[1] + p2[1]) / 2];
  else { const k = (p2[0] - p0[0]) * d[0] + (p2[1] - p0[1]) * d[1]; c = [p0[0] + d[0] * k, p0[1] + d[1] * k]; }
  let len = 0, px = p0[0], py = p0[1];
  for (let i = 1; i <= 8; i++) {
    const t = i / 8, u = 1 - t;
    const x = u * u * p0[0] + 2 * u * t * c[0] + t * t * p2[0], y = u * u * p0[1] + 2 * u * t * c[1] + t * t * p2[1];
    len += Math.hypot(x - px, y - py); px = x; py = y;
  }
  return { p0, c, p2, len, h2 };
}
const PATHS = {};
for (let h = 0; h < 4; h++) for (const m of [0, 1, 2]) for (const lo of [0, 1]) PATHS[`${h}${m}${lo}`] = boxPath(h, m, m === MOVE.L ? 1 : 0, lo);
export const pathFor = (h, move, laneOut) => PATHS[`${h}${move}${laneOut}`];

/** World pose of a vehicle. s>0: on approach; s<=0: inside the junction box. */
export function poseOf(sim, link, v, sOverride) {
  const s = sOverride ?? v.s;
  const node = link.node, h = link.h;
  const d = DIRS[h], r = rightVec(h);
  if (s > 0 || v.state !== 'box') {
    const lat = GEO.lat[v.lane];
    const dist = GEO.half + s;
    return { x: node.cx - d[0] * dist + r[0] * lat, y: node.cy - d[1] * dist + r[1] * lat, a: Math.atan2(d[1], d[0]) };
  }
  const pa = v.path, t = Math.min(1, Math.max(0, -s / pa.len)), u = 1 - t;
  const x = u * u * pa.p0[0] + 2 * u * t * pa.c[0] + t * t * pa.p2[0];
  const y = u * u * pa.p0[1] + 2 * u * t * pa.c[1] + t * t * pa.p2[1];
  const dx = 2 * u * (pa.c[0] - pa.p0[0]) + 2 * t * (pa.p2[0] - pa.c[0]);
  const dy = 2 * u * (pa.c[1] - pa.p0[1]) + 2 * t * (pa.p2[1] - pa.c[1]);
  return { x: node.cx + x, y: node.cy + y, a: Math.atan2(dy, dx) };
}

export class Sim {
  /**
   * @param {object} scenario output of buildScenario
   * @param {(node)=>object} controllerFactory returns a controller instance per intersection
   */
  constructor(scenario, controllerFactory, opts = {}) {
    this.sc = scenario;
    this.t = 0;
    this.nx = scenario.nx; this.ny = scenario.ny;
    this.S = GEO.L + 2 * GEO.half;
    this.nodes = [];
    this.links = [];
    this.linkByKey = new Map();
    this.vehicles = 0;
    this.stats = { completed: 0, delaySum: 0, waitDoneSum: 0, doneStoppedMax: 0, thruTimes: [], emergDone: [], emergDelaySum: 0, emergCount: 0 };
    this.spawned = 0;
    this.maxQ = 0; this.maxQNode = 0;
    this.series = [];
    this.nextSample = 0;
    this.demandPtr = 0; this.pedPtr = 0;
    this.sources = new Map();
    this.incidents = scenario.incidents.map((x) => ({ ...x, done: false, until: 0, veh: null }));
    this.pedStats = { arrived: 0, started: 0, waitSum: 0, maxWait: 0 };
    this.queueIntegral = 0; this.queueSamples = 0;
    this.events = [];
    this.opts = opts;

    for (let j = 0; j < this.ny; j++) for (let i = 0; i < this.nx; i++) {
      const node = {
        i, j, id: j * this.nx + i, cx: i * this.S, cy: j * this.S, inLinks: [],
        sig: { phase: 0, state: 'green', timer: 0, elapsed: 0, pending: -1, clearT: 0, decT: SAFETY.decisionEvery, switches: 0, greenSteps: 0, usedSteps: 0, usedNow: false },
        pedQ: [[], [], [], []], pedCross: [[], [], [], []],
        ctrl: null, passed: 0,
      };
      this.nodes.push(node);
    }
    for (const node of this.nodes) for (let h = 0; h < 4; h++) {
      const link = { node, h, lanes: [[], []], key: `${node.id}:${h}`, entry: false, count: 0, up: null };
      const pi = node.i - DIRS[h][0], pj = node.j - DIRS[h][1];
      if (pi < 0 || pj < 0 || pi >= this.nx || pj >= this.ny) { link.entry = true; this.sources.set(link.key, []); }
      else link.up = this.nodes[pj * this.nx + pi];
      node.inLinks.push(link);
      this.links.push(link);
      this.linkByKey.set(link.key, link);
    }
    for (const node of this.nodes) {
      node.ctrl = controllerFactory(node, this);
      if (node.ctrl.init) node.ctrl.init(this, node);
    }
  }

  nodeAt(i, j) { return i < 0 || j < 0 || i >= this.nx || j >= this.ny ? null : this.nodes[j * this.nx + i]; }

  // ------------------------------------------------------------------ vehicle helpers
  makeVehicle(d, tSpawn) {
    const ty = VTYPES[d.type];
    return {
      id: d.id, type: d.type, len: ty.len, w: ty.w, v0: ty.v0 * d.jitter, emerg: d.emerg, route: d.route, ri: 0,
      s: 0, v: 0, lane: d.route[0] === MOVE.L ? 1 : 0, state: 'link', path: null, tSpawn, waitT: 0, stopT: 0,
      freeT: d.route.length * ((GEO.L + 2 * GEO.half + 6) / (ty.v0 * d.jitter * 0.9)), crashed: false, link: null, nextLane: 0,
    };
  }

  tailRoom(link, laneIdx, need) {
    const arr = link.lanes[laneIdx];
    if (!arr.length) return true;
    const tail = arr[arr.length - 1];
    return tail.s + tail.len <= GEO.L - need;
  }

  /** Destination link/lane of vehicle at the stop line of `link`. Returns null if it exits the network. */
  downstreamOf(link, v) {
    const m = v.route[v.ri];
    const h2 = m === MOVE.T ? link.h : m === MOVE.L ? (link.h + 3) % 4 : (link.h + 1) % 4;
    const nn = this.nodeAt(link.node.i + DIRS[h2][0], link.node.j + DIRS[h2][1]);
    if (!nn) return { exit: true, h2 };
    const lane = v.route[v.ri + 1] === MOVE.L ? 1 : 0;
    return { exit: false, link: nn.inLinks[h2], lane, h2 };
  }

  // ------------------------------------------------------------------ main step
  step() {
    const sc = this.sc;
    this.t += DT;
    const t = this.t;
    // 1. demand
    while (this.demandPtr < sc.demand.length && sc.demand[this.demandPtr].t <= t) {
      const d = sc.demand[this.demandPtr++];
      const v = this.makeVehicle(d, d.t);
      this.spawned++;
      const e = d.e;
      this.sources.get(`${e.j * this.nx + e.i}:${e.h}`).push(v);
    }
    // 2. pedestrians
    while (this.pedPtr < sc.peds.length && sc.peds[this.pedPtr].t <= t) {
      const p = sc.peds[this.pedPtr++];
      this.nodes[p.j * this.nx + p.i].pedQ[p.c].push({ t0: p.t, dur: p.dur });
      this.pedStats.arrived++;
    }
    // 3. incidents
    for (const inc of this.incidents) this.updateIncident(inc);
    // 4. signals + pedestrians
    for (const node of this.nodes) { this.updateSignal(node); this.updatePeds(node); }
    // 5. vehicles
    const transfers = [];
    let qMaxNow = 0;
    for (const link of this.links) {
      let linkStopped = 0;
      for (let li = 0; li < 2; li++) {
        const arr = link.lanes[li];
        if (!arr.length) continue;
        const phase = phaseOf(link.h, li);
        const sig = link.node.sig;
        const green = sig.phase === phase && sig.state === 'green';
        const amber = sig.phase === phase && sig.state === 'amber';
        for (let k = 0; k < arr.length; k++) {
          const v = arr[k];
          if (v.crashed) { v.v = 0; if (v.s > 0 && v.v < 0.5) linkStopped++; continue; }
          let gap = 1e9, dv = 0;
          if (k > 0) { const L = arr[k - 1]; gap = v.s - L.s - L.len; dv = v.v - L.v; }
          let stopForLine = false;
          if (v.state === 'link') {
            if (v.s < 70) {
              if (green) stopForLine = !this.roomDownstream(link, v);
              else if (amber) { const dstop = (v.v * v.v) / (2 * 3); stopForLine = !(v.s <= dstop && this.roomDownstream(link, v)); }
              else stopForLine = true;
            }
            if (stopForLine) { const g = v.s - 0.5; if (g < gap) { gap = g; dv = v.v; } }
          }
          let v0 = v.v0;
          const turning = v.route[v.ri] !== MOVE.T;
          if (turning && (v.state === 'box' || v.s < 25)) v0 = Math.min(v0, 6.5);
          const dd = Math.max(gap, 0.1);
          const sstar = IDM.s0 + Math.max(0, v.v * IDM.T + (v.v * dv) / (2 * Math.sqrt(IDM.a * IDM.b)));
          let a = IDM.a * (1 - Math.pow(v.v / v0, IDM.delta) - (sstar / dd) * (sstar / dd));
          if (a < -IDM.bmax) a = -IDM.bmax;
          let nv = v.v + a * DT; if (nv < 0) nv = 0;
          let ns = v.s - nv * DT;
          if (stopForLine && v.state === 'link' && ns < 0.2) { ns = 0.2; nv = 0; }
          v.v = nv; v.s = ns;
          if (v.state === 'link' && v.s <= 0) {
            v.state = 'box';
            const ds = this.downstreamOf(link, v);
            v.path = pathFor(link.h, v.route[v.ri], ds.exit ? 0 : ds.lane);
            v.nextLane = ds.exit ? 0 : ds.lane;
            link.node.passed++;
            v.crossT = t;
          }
          if (v.state === 'box' && v.s <= -v.path.len) transfers.push([link, li, v]);
          if (v.v < 0.5) { v.waitT += DT; v.stopT += DT; if (v.s > 0) linkStopped++; } else { v.stopT = 0; }
        }
      }
      link.stopped = linkStopped;
      if (linkStopped > qMaxNow) qMaxNow = linkStopped;
      if (linkStopped > this.maxQ) { this.maxQ = linkStopped; this.maxQNode = link.node.id; }
    }
    // 6. transfers
    for (const [link, li, v] of transfers) {
      const arr = link.lanes[li];
      const idx = arr.indexOf(v); if (idx >= 0) arr.splice(idx, 1);
      this.complete(link, v, t);
    }
    // 7. spawn from source queues
    for (const [key, q] of this.sources) {
      if (!q.length) continue;
      const link = this.linkByKey.get(key);
      for (let guard = 0; guard < 2 && q.length; guard++) {
        const v = q[0];
        const spawnV = Math.min(v.v0, 9);
        if (!this.tailRoom(link, v.lane, v.len + 3 + 1.4 * spawnV)) break;
        q.shift();
        v.v = spawnV; v.s = GEO.L; v.link = link;
        link.lanes[v.lane].push(v);
      }
      for (const v of q) v.waitT += DT;
    }
    // 8. stats
    this.sampleStats();
    return this;
  }

  roomDownstream(link, v) {
    if (v.s > 15 && v.v > 1) return true;
    const ds = this.downstreamOf(link, v);
    if (ds.exit) return true;
    return this.tailRoom(ds.link, ds.lane, v.len + 3);
  }

  complete(link, v) {
    const ds = this.downstreamOf(link, v);
    if (ds.exit) {
      this.stats.completed++;
      const total = this.t - v.tSpawn;
      const delay = Math.max(0, total - v.freeT);
      this.stats.delaySum += delay;
      this.stats.waitDoneSum += v.waitT;
      if (v.emerg) { this.stats.emergCount++; this.stats.emergDelaySum += delay; this.stats.emergDone.push(delay); }
      v.done = true; v.tDone = this.t;
      this.events.push({ type: 'exit', t: this.t, v, link });
      return;
    }
    const carry = v.s + pathLen(v);
    v.ri++; v.state = 'link'; v.path = null; v.lane = ds.lane;
    const arr = ds.link.lanes[ds.lane];
    let s = GEO.L + carry;
    if (arr.length) { const tail = arr[arr.length - 1]; s = Math.max(s, tail.s + tail.len + 0.8); }
    v.s = s; v.link = ds.link;
    arr.push(v);
  }

  // ------------------------------------------------------------------ signals
  pedBusy(node, phase) {
    for (const c of PHASES[phase].walk) if (node.pedCross[c].length) return true;
    return false;
  }

  demandOf(node, phase) {
    let n = 0;
    for (const [h, lane] of PHASES[phase].lanes) { const a = node.inLinks[h].lanes[lane]; for (const v of a) if (v.state === 'link' && v.s < 90 && !v.crashed) n++; }
    for (const c of PHASES[phase].walk) n += node.pedQ[c].length;
    return n;
  }

  headWait(node, phase) {
    let m = 0;
    for (const [h, lane] of PHASES[phase].lanes) { const a = node.inLinks[h].lanes[lane]; if (a.length && !a[0].crashed) m = Math.max(m, a[0].stopT); }
    for (const c of PHASES[phase].walk) { const q = node.pedQ[c]; if (q.length) m = Math.max(m, this.t - q[0].t0); }
    return m;
  }

  updateSignal(node) {
    const s = node.sig;
    if (s.state === 'green') {
      s.elapsed += DT; s.greenSteps++;
      if (s.usedNow = this.greenUsed(node, s.phase)) s.usedSteps++;
      if (s.pending >= 0) {
        if (this.pedBusy(node, s.phase) && s.clearT < SAFETY.pedClearMax) s.clearT += DT;
        else { s.state = 'amber'; s.timer = SAFETY.amber; }
        return;
      }
      s.decT -= DT;
      if (s.decT <= 1e-9) {
        s.decT += SAFETY.decisionEvery;
        if (s.elapsed + 1e-9 >= SAFETY.minGreen[s.phase]) {
          let tgt = node.ctrl.decide(this, node);
          if (tgt == null || tgt < 0) tgt = s.phase;
          const forced = this.guardTarget(node);
          if (forced >= 0) tgt = forced;
          if (tgt !== s.phase) { s.pending = tgt; s.clearT = 0; }
        }
      }
    } else if (s.state === 'amber') {
      s.timer -= DT;
      if (s.timer <= 1e-9) { s.state = 'allred'; s.timer = SAFETY.allRed; }
    } else {
      s.timer -= DT;
      if (s.timer <= 1e-9) {
        s.phase = s.pending; s.pending = -1; s.state = 'green'; s.elapsed = 0; s.decT = SAFETY.decisionEvery; s.switches++;
        this.events.push({ type: 'phase', t: this.t, node, phase: s.phase });
      }
    }
  }

  /** Hard limits that no controller can override: max green and starvation protection. */
  guardTarget(node) {
    const s = node.sig;
    const over = s.elapsed >= SAFETY.maxGreen[s.phase];
    let best = -1, bestScore = 0;
    for (let p = 0; p < 4; p++) {
      if (p === s.phase) continue;
      const w = this.headWait(node, p);
      const dem = this.demandOf(node, p);
      if (w >= SAFETY.starve && dem > 0) { const sc = 1000 + w; if (sc > bestScore) { bestScore = sc; best = p; } }
      else if (over && dem > 0) { const sc = dem + w * 0.1; if (sc > bestScore) { bestScore = sc; best = p; } }
    }
    return best;
  }

  greenUsed(node, phase) {
    for (const [h, lane] of PHASES[phase].lanes) {
      const a = node.inLinks[h].lanes[lane];
      if (a.length && !a[0].crashed && (a[0].s < 45 || a[0].state === 'box')) return true;
    }
    for (const c of PHASES[phase].walk) if (node.pedCross[c].length) return true;
    return false;
  }

  updatePeds(node) {
    const s = node.sig, t = this.t;
    for (let c = 0; c < 4; c++) {
      const cr = node.pedCross[c];
      if (cr.length) { let w = 0; for (let k = 0; k < cr.length; k++) if (cr[k].end > t) cr[w++] = cr[k]; cr.length = w; }
      const q = node.pedQ[c];
      if (q.length && s.state === 'green' && s.pending < 0 && s.phase === servedPhaseOfCrosswalk(c)) {
        for (const p of q) { this.pedStats.started++; this.pedStats.waitSum += t - p.t0; if (t - p.t0 > this.pedStats.maxWait) this.pedStats.maxWait = t - p.t0; cr.push({ start: t, end: t + p.dur, dir: Math.floor(p.t0 * 10) % 2 ? 1 : -1, off: (p.t0 * 7.13) % 1 }); }
        q.length = 0;
      }
    }
  }

  // ------------------------------------------------------------------ incidents
  updateIncident(inc) {
    if (!inc.done && this.t >= inc.t) {
      const node = this.nodeAt(inc.i, inc.j);
      const arr = node.inLinks[inc.h].lanes[inc.lane];
      let pick = null;
      for (const v of arr) if (v.state === 'link' && v.s >= 18 && !v.emerg) { if (!pick || Math.abs(v.s - 32) < Math.abs(pick.s - 32)) pick = v; }
      if (!pick) for (const v of arr) if (v.state === 'link' && v.s > 6 && !v.emerg) pick = v;
      if (pick) {
        pick.crashed = true; pick.v = 0; inc.done = true; inc.veh = pick; inc.until = this.t + inc.dur;
        this.events.push({ type: 'incident', t: this.t, node, h: inc.h });
      }
    } else if (inc.done && inc.veh && this.t >= inc.until) {
      const v = inc.veh; inc.veh = null;
      const node = this.nodeAt(inc.i, inc.j);
      const arr = node.inLinks[inc.h].lanes[inc.lane];
      const idx = arr.indexOf(v); if (idx >= 0) arr.splice(idx, 1);
      v.cleared = true; this.spawnedAdjust = (this.spawnedAdjust || 0) + 1;
      this.events.push({ type: 'cleared', t: this.t, node });
    }
  }

  // ------------------------------------------------------------------ live scenario injection (UI)
  injectEmergency() {
    const e = this.sc.entries[Math.floor(Math.random() * this.sc.entries.length)];
    const route = [];
    let { i, j, h } = e;
    while (i >= 0 && j >= 0 && i < this.nx && j < this.ny) { route.push(MOVE.T); i += DIRS[h][0]; j += DIRS[h][1]; }
    const d = { id: 900000 + this.spawned, t: this.t, e, type: 'emerg', route, jitter: 1, emerg: true };
    this.sc.emergencies++;
    this.spawned++;
    this.sources.get(`${e.j * this.nx + e.i}:${e.h}`).push(this.makeVehicle(d, this.t));
    return e;
  }

  injectIncident(nodeId) {
    const node = this.nodes[nodeId] ?? this.nodes[0];
    const h = Math.floor(Math.random() * 4);
    this.incidents.push({ t: this.t, i: node.i, j: node.j, h, lane: 0, dur: 90, done: false, until: 0, veh: null });
    return { node, h };
  }

  injectPedSurge(nodeId, n = 10) {
    const node = this.nodes[nodeId] ?? this.nodes[0];
    for (let c = 0; c < 4; c++) for (let k = 0; k < n; k++) { node.pedQ[c].push({ t0: this.t - k * 0.2, dur: 9 + (k % 4) }); this.pedStats.arrived++; }
  }

  // ------------------------------------------------------------------ stats
  *allVehicles() {
    for (const link of this.links) for (const arr of link.lanes) for (const v of arr) yield v;
    for (const q of this.sources.values()) for (const v of q) yield v;
  }

  sampleStats() {
    this.queueIntegral += this.nodeQueueTotal(); this.queueSamples++;
    if (this.t >= this.nextSample) {
      this.nextSample += 5;
      let q = 0, n = 0, sp = 0;
      for (const link of this.links) { q += link.stopped || 0; for (const arr of link.lanes) for (const v of arr) { n++; sp += v.v; } }
      this.series.push({ t: this.t, queue: q, vehicles: n, speed: n ? sp / n : 0, done: this.stats.completed, wait: this.liveAvgWait() });
      if (this.series.length > 2000) this.series.shift();
    }
  }

  nodeQueueTotal() { let q = 0; for (const l of this.links) q += l.stopped || 0; return q; }

  liveAvgWait() {
    let sum = this.stats.waitDoneSum, n = this.stats.completed;
    for (const v of this.allVehicles()) { if (v.crashed) continue; sum += v.waitT; n++; }
    return n ? sum / n : 0;
  }

  run(seconds) { const n = Math.round(seconds / DT); for (let i = 0; i < n; i++) this.step(); return this; }
  runToEnd() { while (this.t < this.sc.duration - 1e-9) this.step(); return this; }

  /** Final measured metrics (all in simulated seconds / vehicles). */
  summary() {
    const st = this.stats;
    let waitSum = st.waitDoneSum, n = st.completed, active = 0;
    let emergSum = st.emergDelaySum, emergN = st.emergCount;
    for (const v of this.allVehicles()) {
      if (v.crashed) continue;
      waitSum += v.waitT; n++; active++;
      if (v.emerg) { emergSum += v.waitT; emergN++; }
    }
    const ps = this.pedStats;
    let pedWaitSum = ps.waitSum, pedN = ps.started, pedMax = ps.maxWait;
    for (const nd of this.nodes) for (const q of nd.pedQ) for (const p of q) { pedWaitSum += this.t - p.t0; pedN++; if (this.t - p.t0 > pedMax) pedMax = this.t - p.t0; }
    let sw = 0, gs = 0, us = 0;
    for (const nd of this.nodes) { sw += nd.sig.switches; gs += nd.sig.greenSteps; us += nd.sig.usedSteps; }
    const hours = this.t / 3600;
    return {
      scenario: this.sc.id, seed: this.sc.seed, duration: this.t, nodes: this.nodes.length,
      avgWait: n ? waitSum / n : 0,
      avgDelay: st.completed ? st.delaySum / st.completed : 0,
      maxQueue: this.maxQ,
      avgQueue: this.queueSamples ? this.queueIntegral / this.queueSamples / this.nodes.length : 0,
      throughput: st.completed,
      throughputPerHour: hours ? st.completed / hours : 0,
      spawned: this.spawned, inSystem: active,
      completionRate: this.spawned ? st.completed / this.spawned : 1,
      pedWait: pedN ? pedWaitSum / pedN : 0, pedMaxWait: pedMax,
      pedServed: ps.started, pedArrived: ps.arrived,
      emergDelay: emergN ? emergSum / emergN : 0, emergCount: this.sc.emergencies,
      switchesPerHour: hours ? sw / this.nodes.length / hours : 0,
      signalEfficiency: gs ? us / gs : 1,
    };
  }
}

function pathLen(v) { return v.path ? v.path.len : 0; }

// ---------------------------------------------------------------------------- observation
export const OBS = { perPhase: 8, size: 38 };
const DEMAND_NORM = { q: 14, n: 18, w: 60, ped: 8, pedW: 60 };

/** Sensor vector for the neural agent. Features are local to one intersection (plus downstream occupancy). */
export function observe(sim, node, out) {
  const o = out || new Float32Array(OBS.size);
  const sig = node.sig, t = sim.t;
  for (let p = 0; p < 4; p++) {
    let q = 0, n = 0, w = 0, em = 0, blk = 0, dn = 0, dnc = 0;
    for (const [h, lane] of PHASES[p].lanes) {
      const link = node.inLinks[h], arr = link.lanes[lane];
      for (let k = 0; k < arr.length; k++) {
        const v = arr[k];
        if (v.state !== 'link') continue;
        if (v.crashed) { blk = 1; continue; }
        if (v.s < 90) { if (v.v < 1.2) q++; if (v.s < 80) n++; }
        if (v.emerg && v.s < 120) em = Math.max(em, 1 - v.s / 140);
      }
      if (arr.length && !arr[0].crashed) w = Math.max(w, arr[0].stopT);
      // downstream occupancy of the link this movement feeds (through for lane 0, cross street for left)
      const m = lane === 1 ? MOVE.L : MOVE.T;
      const h2 = m === MOVE.T ? h : (h + 3) % 4;
      const nn = sim.nodeAt(node.i + DIRS[h2][0], node.j + DIRS[h2][1]);
      if (nn) { const dl = nn.inLinks[h2]; dn += (dl.lanes[0].length + dl.lanes[1].length) / 26; dnc++; }
    }
    let ped = 0, pedW = 0;
    for (const c of PHASES[p].walk) { const qq = node.pedQ[c]; ped += qq.length; if (qq.length) pedW = Math.max(pedW, t - qq[0].t0); }
    const b = p * OBS.perPhase;
    o[b] = Math.min(1, q / DEMAND_NORM.q);
    o[b + 1] = Math.min(1, n / DEMAND_NORM.n);
    o[b + 2] = Math.min(1, w / DEMAND_NORM.w);
    o[b + 3] = Math.min(1, ped / DEMAND_NORM.ped);
    o[b + 4] = Math.min(1, pedW / DEMAND_NORM.pedW);
    o[b + 5] = em;
    o[b + 6] = blk;
    o[b + 7] = dnc ? Math.min(1, dn / dnc) : 0;
  }
  const g = 32;
  for (let p = 0; p < 4; p++) o[g + p] = sig.phase === p ? 1 : 0;
  o[g + 4] = Math.min(1, sig.elapsed / 60);
  let occ = 0;
  for (const l of node.inLinks) occ += l.lanes[0].length + l.lanes[1].length;
  o[g + 5] = Math.min(1, occ / 60);
  return o;
}

export function makeSim(scenarioId, seed, controllerFactory, overrides) {
  return new Sim(buildScenario(scenarioId, seed, overrides), controllerFactory);
}
export { phaseOf, servedPhaseOfCrosswalk };
