// Neuroevolution for the SignalNet agent.
// Methodology borrowed from Fly Dungeon: tournament selection over the current population,
// Gaussian mutation with rare random resets, elitism, and adaptive step size.
// Fitness is measured by actually running the traffic simulator, never estimated.
import { Rng, hashSeed } from './rng.js';
import { buildScenario, SCENARIOS } from './scenarios.js';
import { Sim } from './sim.js';
import { controllerFactory, priorGenome, sanitize, ACTIVE_IDX, GENOME_LEN, STRUCTURE } from './controllers.js';

export const DEFAULT_WEIGHTS = { delay: 1.0, queue: 0.5, thru: 0.8, ped: 1.0, emerg: 1.2, sw: 0.15 };
export const FITNESS_TERMS = {
  delay: { label: 'Waiting time', hint: 'mean stopped time per vehicle' },
  queue: { label: 'Queue length', hint: 'mean stopped vehicles per intersection' },
  thru: { label: 'Throughput', hint: 'share of vehicles not yet through' },
  ped: { label: 'Pedestrian wait', hint: 'mean wait before WALK' },
  emerg: { label: 'Emergency delay', hint: 'mean delay of ambulances' },
  sw: { label: 'Signal switching', hint: 'phase changes per hour' },
};

/** Lower is better. Returns total cost and per-term breakdown. */
export function costOf(m, w = DEFAULT_WEIGHTS) {
  const parts = {
    delay: w.delay * (m.avgWait / 40),
    queue: w.queue * (m.avgQueue / 10),
    thru: w.thru * (1 - m.completionRate),
    ped: w.ped * (m.pedWait / 30),
    emerg: m.emergCount ? w.emerg * (m.emergDelay / 30) : 0,
    sw: w.sw * (m.switchesPerHour / 200),
  };
  let c = 0;
  for (const k in parts) c += parts[k];
  return { cost: c, parts };
}
export const fitnessOf = (cost) => 100 / (1 + cost);

/**
 * Scenario specs for one generation (identical for every individual => fair comparison).
 * They are the real presets with jittered load/skew, so training matches what is benchmarked,
 * but the seeds never overlap with the benchmark seeds (1001+).
 */
export function trainingSpecs(gen, base = 5000, opts = {}) {
  const r = new Rng(hashSeed(base, gen, 3));
  const j = (x, lo = 0.85, hi = 1.15) => x * r.range(lo, hi);
  const sd = (k) => base + gen * 11 + k;
  const P = SCENARIOS;
  const specs = [
    { id: 'rush', seed: sd(1), over: { rate: j(P.rush.rate), ns: j(P.rush.ns), ew: j(P.rush.ew) } },
    { id: 'ambulance', seed: sd(2), over: { rate: j(P.ambulance.rate) } },
    { id: gen % 2 ? 'incident' : 'school', seed: sd(3), over: { rate: j(gen % 2 ? P.incident.rate : P.school.rate) } },
    { id: 'grid2', seed: sd(4), over: { rate: j(P.grid2.rate), ns: j(P.grid2.ns), ew: j(P.grid2.ew) } },
  ];
  if (!opts.light) specs.push({ id: gen % 2 ? 'storm' : 'grid3', seed: sd(5), over: { rate: j(P[gen % 2 ? 'storm' : 'grid3'].rate) } });
  return specs;
}

export function evalGenome(genome, specs, weights = DEFAULT_WEIGHTS, kind = 'evolved') {
  const fac = controllerFactory(kind, genome);
  let total = 0;
  const parts = {}, metrics = [];
  for (const sp of specs) {
    const sim = new Sim(buildScenario(sp.id, sp.seed, sp.over), fac);
    sim.runToEnd();
    const m = sim.summary();
    metrics.push(m);
    const c = costOf(m, weights);
    total += c.cost;
    for (const k in c.parts) parts[k] = (parts[k] || 0) + c.parts[k];
  }
  const n = specs.length;
  for (const k in parts) parts[k] /= n;
  return { cost: total / n, fitness: fitnessOf(total / n), parts, metrics };
}

export const evalFixed = (specs, weights = DEFAULT_WEIGHTS) => evalGenome(null, specs, weights, 'fixed');

export function aggregate(ms) {
  const o = {};
  const keys = ['avgWait', 'avgDelay', 'avgQueue', 'maxQueue', 'throughput', 'completionRate', 'pedWait', 'emergDelay', 'switchesPerHour', 'signalEfficiency'];
  for (const k of keys) o[k] = ms.reduce((a, m) => a + m[k], 0) / ms.length;
  return o;
}

// ---------------------------------------------------------------------------- GA
export class Evolution {
  /**
   * @param {object} o { popSize, elites, seed, weights, startFrom: 'prior'|'random', light, evaluator }
   * evaluator(genomes, specs, weights) -> Promise<Array<{cost,fitness,parts,metrics}>>
   */
  constructor(o = {}) {
    this.popSize = o.popSize || 48;
    this.elites = o.elites ?? 4;
    this.rng = new Rng(o.seed || 1);
    this.weights = { ...DEFAULT_WEIGHTS, ...(o.weights || {}) };
    this.startFrom = o.startFrom || 'prior';
    this.seedBase = 5000 + (o.seed || 1) * 1000;
    this.evaluator = o.evaluator || (async (gs, specs, w) => gs.map((g) => evalGenome(g, specs, w)));
    this.light = !!o.light;
    this.rotateEvery = o.rotateEvery ?? 12;
    this.setBlocks = o.setBlocks ?? 2;
    this.mutRate = o.mutRate ?? 0.08;
    this.mutStep = o.mutStep ?? 0.28;
    this.gen = 0;
    this.sigma = 1;
    this.history = [];
    this.bestEver = null;
    this.prior = priorGenome();
    this.pop = this.initPop();
  }

  randomGenome() {
    const g = new Float32Array(GENOME_LEN);
    for (const i of ACTIVE_IDX) g[i] = this.rng.normal() * 0.6;
    return sanitize(g);
  }

  initPop() {
    const pop = [];
    for (let i = 0; i < this.popSize; i++) {
      if (this.startFrom === 'random') pop.push(this.randomGenome());
      else pop.push(i === 0 ? priorGenome() : priorGenome(0.15 + 0.85 * (i / this.popSize), this.rng.int(1e9)));
    }
    return pop;
  }

  mutate(g, sigma) {
    const c = Float32Array.from(g), r = this.rng;
    for (let k = 0; k < ACTIVE_IDX.length; k++) {
      const i = ACTIVE_IDX[k];
      const x = r.next();
      if (x < 0.008) c[i] = r.normal() * 0.6; // rare random reset
      else if (x < this.mutRate) c[i] += r.normal() * this.mutStep * sigma;
    }
    return sanitize(c);
  }

  crossover(a, b) {
    const c = Float32Array.from(a), r = this.rng;
    for (let k = 0; k < ACTIVE_IDX.length; k++) if (r.next() < 0.5) c[ACTIVE_IDX[k]] = b[ACTIVE_IDX[k]];
    return c;
  }

  tournament(ranked, k = 3) {
    let best = null;
    for (let i = 0; i < k; i++) { const c = ranked[this.rng.int(ranked.length)]; if (!best || c.fitness > best.fitness) best = c; }
    return best;
  }

  /** Training scenarios for a generation: a fixed block that rotates every few generations (less noise than fresh scenarios each time). */
  specsFor(gen) {
    const block = Math.floor(gen / this.rotateEvery), specs = [];
    for (let i = 0; i < this.setBlocks; i++) specs.push(...trainingSpecs(block * this.setBlocks + i, this.seedBase, { light: this.light }));
    return specs;
  }

  /** Run one generation; returns the stats record. */
  async step() {
    const specs = this.specsFor(this.gen);
    const res = await this.evaluator(this.pop, specs, this.weights);
    const ranked = this.pop.map((g, i) => ({ g, ...res[i] })).sort((a, b) => b.fitness - a.fitness);
    const fx = evalFixed(specs, this.weights), pr = evalGenome(this.prior, specs, this.weights, 'adaptive');
    this.top = ranked.slice(0, 8).map((r) => ({ fitness: r.fitness, m: aggregate(r.metrics), parts: r.parts, genome: r.g }));
    const fits = ranked.map((r) => r.fitness);
    const mean = fits.reduce((a, b) => a + b, 0) / fits.length;
    const rec = {
      gen: this.gen, best: fits[0], mean, median: fits[fits.length >> 1], worst: fits[fits.length - 1],
      fixed: fx.fitness, prior: pr.fitness, parts: ranked[0].parts, sigma: this.sigma, fits: fits.slice(),
      bestGenome: Float32Array.from(ranked[0].g),
      bestMetrics: aggregate(ranked[0].metrics), fixedMetrics: aggregate(fx.metrics), priorMetrics: aggregate(pr.metrics),
    };
    const prevBest = this.history.length ? this.history[this.history.length - 1].best : -1;
    this.sigma = Math.min(2.2, Math.max(0.35, this.sigma * (rec.best > prevBest ? 1.08 : 0.95)));
    this.history.push(rec);
    if (!this.bestEver || rec.best > this.bestEver.fitness) this.bestEver = { fitness: rec.best, gen: this.gen, genome: Float32Array.from(ranked[0].g) };

    const next = [];
    for (let i = 0; i < this.elites; i++) next.push(Float32Array.from(ranked[i].g));
    while (next.length < this.popSize) {
      const pa = this.tournament(ranked), pb = this.tournament(ranked);
      const child = this.rng.next() < 0.4 ? this.crossover(pa.g, pb.g) : Float32Array.from(pa.g);
      next.push(this.mutate(child, this.sigma * (0.5 + this.rng.next())));
    }
    this.pop = next;
    this.gen++;
    return rec;
  }

  /** Re-evaluate top candidates on fresh, held-out scenarios and return the most robust champion. */
  async champion(cands = 8, valSeed = 777) {
    const pool = [];
    if (this.bestEver) pool.push(this.bestEver.genome);
    for (const h of this.history.slice(-4)) pool.push(h.bestGenome);
    for (let i = 0; pool.length < cands && i < this.pop.length; i++) pool.push(this.pop[i]);
    const specs = [];
    for (let k = 0; k < 4; k++) specs.push(...trainingSpecs(1000 + k, valSeed, { light: this.light }));
    const res = await this.evaluator(pool, specs, this.weights);
    let bi = 0;
    res.forEach((r, i) => { if (r.fitness > res[bi].fitness) bi = i; });
    return { genome: Float32Array.from(pool[bi]), fitness: res[bi].fitness, candidates: res.map((r) => r.fitness) };
  }
}

export const genomeToJSON = (g) => Array.from(g, (x) => Math.round(x * 1e5) / 1e5);
export const genomeFromJSON = (a) => Float32Array.from(a);
export { STRUCTURE };
