// The persistent "city" simulation shared by the Command Center and the Live Simulation views.
import { buildScenario, SCENARIOS } from '../core/scenarios.js';
import { Sim, PHASES } from '../core/sim.js';
import { controllerFactory, priorGenome, CONTROLLER_LABELS } from '../core/controllers.js';
import { SimRunner } from './render.js';
import { evolvedGenome } from './store.js';
import { compareRuns, scoreOf } from './progress.js';
import { award } from './achievements.js';

/** `assist`: manual junctions are driven by the seed agent until the player takes them over. */
export function factoryFor(kind, { assist = false } = {}) {
  if (kind === 'evolved') {
    const g = evolvedGenome();
    return g ? controllerFactory('evolved', g) : controllerFactory('adaptive');
  }
  if (kind === 'expert') return controllerFactory('adaptive', priorGenome(0, 1, 'expert'));
  if (kind === 'manual') return controllerFactory('manual', assist ? priorGenome() : undefined);
  return controllerFactory(kind);
}

export class World {
  constructor() {
    this.scenarioId = 'grid3'; this.kind = 'evolved'; this.seed = 2026;
    this.feed = []; this.series = { wait: [], queue: [], thr: [] };
    this.build();
  }

  build(scenarioId = this.scenarioId, kind = this.kind, seed = this.seed, extra = this.extra || {}) {
    this.extra = extra;
    this.scenarioId = scenarioId; this.kind = kind; this.seed = seed;
    const keepSpeed = this.runner?.speed ?? 2, keepPaused = this.runner?.paused ?? false;
    this.sim = new Sim(buildScenario(scenarioId, seed, { duration: 1e6, ...extra }), factoryFor(kind));
    this.ghost = new Sim(buildScenario(scenarioId, seed, { duration: 1e6, ...extra }), controllerFactory('fixed'));
    this.ghostValid = kind !== 'fixed';
    this.runner = new SimRunner(this.sim);
    this.runner.speed = keepSpeed; this.runner.paused = keepPaused;
    this.phaseLog = {};
    this.feed = []; this.log('info', `Scenario "${SCENARIOS[scenarioId].name}" started under ${CONTROLLER_LABELS[kind]}`);
    this.lastSample = 0; this.lastAch = 0;
    this.series = { wait: [], queue: [], thr: [] };
  }

  log(kind, text) { this.feed.unshift({ kind, text, t: this.sim ? this.sim.t : 0 }); if (this.feed.length > 40) this.feed.pop(); }

  reset() { this.build(); }
  setSkew(skew) { this.build(this.scenarioId, this.kind, this.seed, { skew }); this.log('info', 'Demand re-weighted from the vision monitor: ' + skew.map((v) => v.toFixed(2)).join(' / ')); }
  setKind(kind) { this.build(this.scenarioId, kind, this.seed); }
  setScenario(id) { this.build(id, this.kind, this.seed, {}); }
  reseed() { this.build(this.scenarioId, this.kind, (this.seed * 1103515245 + 12345) % 100000); }

  tick(realDt) {
    const frac = this.runner.advance(realDt);
    let g = 0;
    while (this.ghost.t < this.sim.t - 1e-9 && g++ < 800) this.ghost.step();
    this.ghost.events.length = 0;
    this.consume();
    this.checkAchievements();
    return frac;
  }

  consume() {
    const ev = this.sim.events;
    for (const e of ev) {
      if (e.type === 'incident') this.log('bad', `Collision on ${['E', 'S', 'W', 'N'][e.h]} approach of J${e.node.id + 1}: one lane blocked`);
      else if (e.type === 'cleared') this.log('good', `Wreck cleared at J${e.node.id + 1}`);
      else if (e.type === 'phase') { const a = (this.phaseLog[e.node.id] ||= []); a.push({ t: e.t, phase: e.phase }); if (a.length > 60) a.shift(); }
      else if (e.type === 'exit' && e.v.emerg) this.log('info', `Ambulance cleared the network (+${(e.t - e.v.tSpawn - e.v.freeT).toFixed(0)}s over free-flow)`);
    }
    ev.length = 0;
    const s = this.sim;
    if (s.t - this.lastSample >= 5) {
      this.lastSample = s.t;
      const last = s.series[s.series.length - 1];
      if (last) {
        const push = (a, v) => { a.push([s.t, v]); if (a.length > 160) a.shift(); };
        push(this.series.wait, last.wait); push(this.series.queue, last.queue); push(this.series.thr, last.done / (s.t / 3600));
      }
    }
  }

  /** Live score vs the Fixed Timer ghost that is fed identical traffic (null until it means something). */
  liveScore() {
    if (!this.ghostValid || this.sim.t < 90 || this.kind === 'fixed') return null;
    const a = this.ghost.summary(), b = this.sim.summary(), i = compareRuns(a, b);
    return { score: scoreOf(i, b), i, base: a, mine: b };
  }

  checkAchievements() {
    if (this.sim.t < 120 || Math.floor(this.sim.t) % 10 || this.sim.t - this.lastAch < 5) return;
    this.lastAch = this.sim.t;
    const ls = this.liveScore();
    if (!ls) return;
    if (ls.i.avgWait >= 15) award('flow15');
    if (ls.i.avgWait >= 30) award('flow30');
    if (ls.i.pedWait >= 30) award('walker');
    if (this.sim.nodes.length >= 9 && ls.i.avgWait >= 10) award('grid');
    if (ls.mine.emergCount && ls.i.emergDelay >= 30) award('siren');
  }

  inject(type, nodeId = 0) {
    this.ghostValid = false;
    const s = this.sim;
    if (type === 'ambulance') { const e = s.injectEmergency(); this.log('warn', `Ambulance dispatched from the ${['west', 'north', 'east', 'south'][e.h]} edge`); }
    else if (type === 'accident') { s.injectIncident(nodeId); }
    else if (type === 'peds') { s.injectPedSurge(nodeId); this.log('warn', `Pedestrian surge at J${nodeId + 1}`); }
    else if (type === 'surge') {
      const n = 40;
      for (let k = 0; k < n; k++) {
        const e = s.sc.entries[k % s.sc.entries.length];
        const d = { id: 800000 + s.spawned + k, t: s.t + k * 0.8, e, type: 'car', route: [0, 0, 0], jitter: 1, emerg: false };
        s.spawned++;
        s.sources.get(`${e.j * s.nx + e.i}:${e.h}`).push(s.makeVehicle(d, d.t));
      }
      this.log('warn', `Traffic surge: +${n} vehicles entering the network`);
    }
  }
}

export function phaseName(p) { return PHASES[p].name; }
