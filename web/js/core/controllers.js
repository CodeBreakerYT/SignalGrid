// Signal controllers: Fixed Timer, Manual, and the connectome-inspired neural agent (SignalNet).
//
// SignalNet borrows the *style* of the Fly Dungeon brain (fly-brain sim.js): a sparse recurrent
// rate network, x <- (1-a)x + a*clip(W x + I - theta), signed pre-synaptic neurons (Dale's law:
// excitatory / inhibitory), and a tiny genome evolved by selection + mutation. It is NOT the
// Drosophila connectome and is not trained on it; the wiring below is designed for traffic.
import { Rng } from './rng.js';
import { OBS, observe, SAFETY, PHASES } from './sim.js';

export const NET = { nIn: OBS.size, nHid: 28, nOut: 6, alpha: 0.5, steps: 6 };
NET.n = NET.nHid + NET.nOut;
const { nIn, nHid, nOut, n: N } = NET;
export const NEURON = {
  E: (k, j) => k * 6 + j, I: (k, j) => k * 6 + 4 + j, G: (k) => 24 + k,
  S: (k) => nHid + k, HOLD: nHid + 4, DUR: nHid + 5,
};
const OFF = { win: 0, rec: nIn * nHid, theta: nIn * nHid + N * N };
export const GENOME_LEN = OFF.theta + N;

// fixed structural wiring (the "connectome" of the agent): which recurrent synapses exist and neuron signs
const sign = new Float32Array(N).fill(1);
for (let k = 0; k < 4; k++) { sign[NEURON.I(k, 0)] = -1; sign[NEURON.I(k, 1)] = -1; }
const recMask = new Uint8Array(N * N);
{
  const r = new Rng(20260);
  for (let post = 0; post < N; post++) for (let pre = 0; pre < N; pre++) {
    if (post === pre) continue;
    const preHid = pre < nHid, postHid = post < nHid;
    let on = false;
    if (preHid && postHid) on = r.next() < 0.1;
    else if (preHid && !postHid) on = true;
    else if (!preHid && postHid) on = r.next() < 0.07;
    recMask[post * N + pre] = on ? 1 : 0;
  }
  // designed backbone: each phase module projects to its own output neuron
  for (let k = 0; k < 4; k++) {
    for (let j = 0; j < 4; j++) recMask[NEURON.S(k) * N + NEURON.E(k, j)] = 1;
    for (let j = 0; j < 2; j++) recMask[NEURON.S(k) * N + NEURON.I(k, j)] = 1;
    recMask[NEURON.HOLD * N + NEURON.G(k)] = 1;
  }
}
export const STRUCTURE = { sign, recMask, synapses: recMask.reduce((a, b) => a + b, 0) };

/**
 * Hand-wired seed agents.
 *  'basic'  - the "Adaptive AI": every phase module only senses queue length and approach density.
 *             It has no pathway for waiting time, pedestrians, ambulances, blocked lanes or spill-back.
 *  'expert' - basic plus hand-wired pathways for all eight sensors. A reference point only: the
 *             evolved agent is trained from 'basic', not from 'expert'.
 */
export function priorGenome(noise = 0, seed = 1, level = 'basic') {
  const g = new Float32Array(GENOME_LEN);
  const r = new Rng(seed);
  const win = (f, hid, w) => { g[OFF.win + f * nHid + hid] = w; };
  const rec = (post, pre, w) => { g[OFF.rec + post * N + pre] = w; };
  const expert = level === 'expert';
  for (let k = 0; k < 4; k++) {
    const b = k * OBS.perPhase;
    win(b + 0, NEURON.E(k, 0), 1.6); win(b + 1, NEURON.E(k, 0), 0.5);
    if (expert) {
      win(b + 2, NEURON.E(k, 1), 1.2);
      win(b + 3, NEURON.E(k, 2), 0.8); win(b + 4, NEURON.E(k, 2), 0.9);
      win(b + 5, NEURON.E(k, 3), 3.0);
      win(b + 6, NEURON.I(k, 0), 4.0);
      win(b + 7, NEURON.I(k, 1), 1.5);
    }
    for (let j = 0; j < 4; j++) rec(NEURON.S(k), NEURON.E(k, j), 0.9);
    for (let j = 0; j < 2; j++) rec(NEURON.S(k), NEURON.I(k, j), 1.5);
    win(32 + k, NEURON.G(k), 1.0);
    rec(NEURON.HOLD, NEURON.G(k), 0.5);
  }
  g[OFF.theta + NEURON.DUR] = -0.3;
  if (noise > 0) {
    for (let i = 0; i < nIn * nHid; i++) g[OFF.win + i] += r.normal() * noise * 0.5;
    for (let i = 0; i < N * N; i++) if (recMask[i]) g[OFF.rec + i] += r.normal() * noise * 0.5;
  }
  sanitize(g);
  return g;
}

export function sanitize(g) {
  for (let i = 0; i < N * N; i++) { const k = OFF.rec + i; if (!recMask[i]) g[k] = 0; else if (g[k] < 0) g[k] = 0; else if (g[k] > 4) g[k] = 4; }
  for (let i = 0; i < nIn * nHid; i++) { const k = OFF.win + i; if (g[k] > 6) g[k] = 6; else if (g[k] < -6) g[k] = -6; }
  for (let i = 0; i < N; i++) { const k = OFF.theta + i; if (g[k] > 2) g[k] = 2; else if (g[k] < -2) g[k] = -2; }
  return g;
}
/** Indices a mutation may touch (structurally present weights only). */
export const ACTIVE_IDX = (() => {
  const a = [];
  for (let i = 0; i < nIn * nHid; i++) a.push(OFF.win + i);
  for (let i = 0; i < N * N; i++) if (recMask[i]) a.push(OFF.rec + i);
  for (let i = 0; i < N; i++) a.push(OFF.theta + i);
  return Int32Array.from(a);
})();

// pre-compute sparse incoming lists
const incoming = [];
for (let post = 0; post < N; post++) { const l = []; for (let pre = 0; pre < N; pre++) if (recMask[post * N + pre]) l.push(pre); incoming.push(Int32Array.from(l)); }

export class SignalNet {
  constructor(genome) {
    this.g = genome;
    this.x = new Float32Array(N);
    this.drive = new Float32Array(N);
    this.out = new Float32Array(nOut);
  }
  reset() { this.x.fill(0); }
  forward(input) {
    const { g, x, drive } = this;
    drive.fill(0);
    for (let f = 0; f < nIn; f++) {
      const v = input[f]; if (v === 0) continue;
      const b = OFF.win + f * nHid;
      for (let h = 0; h < nHid; h++) drive[h] += g[b + h] * v;
    }
    const a = NET.alpha;
    for (let s = 0; s < NET.steps; s++) {
      for (let i = 0; i < N; i++) {
        let u = drive[i] - g[OFF.theta + i];
        const inc = incoming[i], rb = OFF.rec + i * N;
        for (let k = 0; k < inc.length; k++) { const pre = inc[k]; u += sign[pre] * g[rb + pre] * x[pre]; }
        const act = i < nHid ? (u < 0 ? 0 : u > 1 ? 1 : u) : (u < 0 ? 0 : u > 3 ? 3 : u);
        x[i] = (1 - a) * x[i] + a * act;
      }
    }
    for (let k = 0; k < nOut; k++) this.out[k] = x[nHid + k];
    return this.out;
  }
}

// ---------------------------------------------------------------------------- controllers
export class FixedController {
  constructor(durations = [24, 8, 24, 8], stagger = 12) { this.dur = durations; this.stagger = stagger; this.kind = 'fixed'; }
  init(sim, node) {
    const total = this.dur.reduce((a, b) => a + b, 0);
    let o = ((node.i + node.j) * this.stagger) % total, p = 0;
    while (o >= this.dur[p]) { o -= this.dur[p]; p++; }
    node.sig.phase = p; node.sig.elapsed = o;
  }
  decide(sim, node) {
    const s = node.sig;
    return s.elapsed + 1e-9 >= this.dur[s.phase] ? (s.phase + 1) % 4 : s.phase;
  }
}

export class ManualController {
  /** @param {NeuralController|null} assist drives the junction until the player takes it over */
  constructor(assist = null) { this.requested = -1; this.kind = 'manual'; this.assist = assist; }
  decide(sim, node) {
    if (this.requested >= 0) return this.requested;
    return this.assist ? this.assist.decide(sim, node) : node.sig.phase;
  }
}

export class NeuralController {
  constructor(genome, kind = 'adaptive') { this.net = new SignalNet(genome); this.kind = kind; this.obs = new Float32Array(OBS.size); this.lastOut = new Float32Array(nOut); this.target = -1; this.trace = null; }
  decide(sim, node) {
    return this.decideFromObs(observe(sim, node, this.obs), node.sig.phase, node.sig.elapsed);
  }
  /** Decision rule shared by the simulator and the vision-driven recommender. */
  decideFromObs(obs, cur, elapsed) {
    const out = this.net.forward(obs);
    this.lastOut.set(out);
    const cont = out[cur] + out[4];
    let best = -1, bs = -1;
    for (let k = 0; k < 4; k++) if (k !== cur && out[k] > bs) { bs = out[k]; best = k; }
    const target = SAFETY.minGreen[cur] + (out[5] / 3) * (SAFETY.maxGreen[cur] - SAFETY.minGreen[cur]);
    this.target = target;
    if (elapsed + 1e-9 < target) return cur;
    return bs > cont ? best : cur;
  }
}

export function controllerFactory(kind, genome) {
  switch (kind) {
    case 'fixed': return () => new FixedController();
    case 'manual': return () => new ManualController(genome ? new NeuralController(genome, 'adaptive') : null);
    case 'adaptive': { const g = genome || priorGenome(); return () => new NeuralController(g, 'adaptive'); }
    case 'evolved': { if (!genome) throw new Error('evolved controller needs a genome'); return () => new NeuralController(genome, 'evolved'); }
    default: throw new Error('unknown controller ' + kind);
  }
}
export const CONTROLLER_LABELS = { fixed: 'Fixed Timer', adaptive: 'Adaptive AI', evolved: 'Evolved AI', manual: 'Manual' };
export { PHASES };
