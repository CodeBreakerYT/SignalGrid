// Reproducible benchmark: Fixed vs Adaptive vs Evolved (+ hand-wired expert reference) on held-out seeds.
// Usage: node tools/benchmark.mjs [seedsPerScenario=8]
import fs from 'node:fs';
import { compare, METRICS, improvement } from '../web/js/core/bench.js';
import { genomeFromJSON } from '../web/js/core/evolve.js';
import { SCENARIO_ORDER } from '../web/js/core/scenarios.js';

const evo = JSON.parse(fs.readFileSync(new URL('../web/data/evolved.json', import.meta.url), 'utf8'));
const n = +process.argv[2] || 8;
const seeds = Array.from({ length: n }, (_, i) => 1001 + i);
const kinds = ['fixed', 'adaptive', 'evolved', 'expert'];
const res = await compare({ scenarios: SCENARIO_ORDER, seeds, kinds, evolved: genomeFromJSON(evo.genome) });
res.meta = {
  generatedAt: new Date().toISOString(), seeds, simulated: true,
  note: 'All numbers are measured inside the SignalGrid simulator on seeds never used for training. They are not real-world measurements.',
  evolution: evo.meta,
};
fs.writeFileSync(new URL('../web/data/benchmarks.json', import.meta.url), JSON.stringify(res));
const f = (v, m) => v.toFixed(m.fmt);
for (const id of SCENARIO_ORDER) {
  console.log(`\n## ${res.scenarios[id].name}`);
  for (const m of METRICS.slice(0, 7)) console.log(m.label.padEnd(26), ['fixed', 'adaptive', 'evolved'].map((k) => f(res.scenarios[id].controllers[k][m.key].mean, m).padStart(8)).join(' '));
}
console.log('\n## OVERALL (mean of scenario means)');
for (const m of METRICS) {
  const o = res.overall;
  console.log(m.label.padEnd(26), kinds.map((k) => f(o[k][m.key], m).padStart(8)).join(' '),
    '  adaptive vs fixed', improvement(o.fixed[m.key], o.adaptive[m.key], m).toFixed(1) + '%', ' evolved vs fixed', improvement(o.fixed[m.key], o.evolved[m.key], m).toFixed(1) + '%');
}
