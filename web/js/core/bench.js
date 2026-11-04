// Controlled comparison harness: every controller faces identical scenarios (same seed => same demand).
import { buildScenario, SCENARIOS, SCENARIO_ORDER } from './scenarios.js';
import { Sim } from './sim.js';
import { controllerFactory, priorGenome } from './controllers.js';

export const METRICS = [
  { key: 'avgWait', label: 'Avg waiting time', unit: 's', lower: true, fmt: 1 },
  { key: 'avgDelay', label: 'Avg vehicle delay', unit: 's', lower: true, fmt: 1 },
  { key: 'maxQueue', label: 'Max queue length', unit: 'veh', lower: true, fmt: 0 },
  { key: 'avgQueue', label: 'Avg queue / junction', unit: 'veh', lower: true, fmt: 1 },
  { key: 'throughput', label: 'Vehicles processed', unit: 'veh', lower: false, fmt: 0 },
  { key: 'pedWait', label: 'Pedestrian waiting', unit: 's', lower: true, fmt: 1 },
  { key: 'emergDelay', label: 'Emergency response delay', unit: 's', lower: true, fmt: 1 },
  { key: 'signalEfficiency', label: 'Signal efficiency', unit: '%', lower: false, fmt: 0, scale: 100 },
  { key: 'switchesPerHour', label: 'Phase changes / hour', unit: '/h', lower: true, fmt: 0 },
];

export const factoryFor = (kind, evolved) => {
  if (kind === 'expert') return controllerFactory('adaptive', priorGenome(0, 1, 'expert'));
  return controllerFactory(kind, kind === 'evolved' ? evolved : undefined);
};

export function runOne(scenarioId, seed, kind, evolved, overrides) {
  const sim = new Sim(buildScenario(scenarioId, seed, overrides), factoryFor(kind, evolved));
  sim.runToEnd();
  return { summary: sim.summary(), series: sim.series };
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const std = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };

/** Async so the browser UI can show progress without freezing. */
export async function compare({ scenarios = SCENARIO_ORDER, seeds = [1001, 1002, 1003, 1004, 1005], kinds = ['fixed', 'adaptive', 'evolved'], evolved, onProgress, yieldFn }) {
  const out = {};
  let done = 0;
  const total = scenarios.length * seeds.length * kinds.length;
  for (const id of scenarios) {
    const row = { name: SCENARIOS[id].name, controllers: {} };
    for (const kind of kinds) {
      const vals = {};
      for (const m of METRICS) vals[m.key] = [];
      for (const seed of seeds) {
        const { summary } = runOne(id, seed, kind, evolved);
        for (const m of METRICS) vals[m.key].push(summary[m.key] * (m.scale || 1));
        done++;
        if (onProgress) onProgress(done / total, id, kind);
        if (yieldFn) await yieldFn();
      }
      const agg = {};
      for (const m of METRICS) agg[m.key] = { mean: mean(vals[m.key]), std: std(vals[m.key]), values: vals[m.key] };
      row.controllers[kind] = agg;
    }
    out[id] = row;
  }
  return { scenarios: out, seeds, kinds, overall: overall(out, kinds) };
}

function overall(rows, kinds) {
  const o = {};
  for (const kind of kinds) {
    o[kind] = {};
    for (const m of METRICS) {
      const vs = Object.values(rows).map((r) => r.controllers[kind][m.key].mean).filter((v) => !(m.key === 'emergDelay' && v === 0));
      o[kind][m.key] = mean(vs);
    }
  }
  return o;
}

/** Percentage improvement of `b` over `a` for a metric (positive = b is better). */
export function improvement(a, b, metric) {
  if (!a) return 0;
  return ((metric.lower ? a - b : b - a) / Math.abs(a)) * 100;
}
