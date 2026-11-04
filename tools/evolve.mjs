// Offline neuroevolution run. Writes web/data/evolved.json (champion genome + full training history).
// Usage: node tools/evolve.mjs [generations=150] [population=96] [seed=5] [workers=auto]
import fs from 'node:fs';
import os from 'node:os';
import { Evolution, genomeToJSON } from '../web/js/core/evolve.js';
import { EvalPool, nodeSpawner } from '../web/js/core/pool.js';
import { GENOME_LEN, STRUCTURE } from '../web/js/core/controllers.js';

const gens = +process.argv[2] || 150, pop = +process.argv[3] || 96, seed = +process.argv[4] || 5;
const workers = +process.argv[5] || Math.max(2, os.cpus().length - 2);
const pool = new EvalPool(await nodeSpawner(), workers);
const ev = new Evolution({ seed, popSize: pop, mutRate: 0.02, mutStep: 0.15, rotateEvery: 20, setBlocks: 2, evaluator: pool.evaluate });
const t0 = performance.now();
const history = [];
for (let g = 0; g < gens; g++) {
  const r = await ev.step();
  history.push({
    gen: r.gen, best: +r.best.toFixed(3), mean: +r.mean.toFixed(3), median: +r.median.toFixed(3), worst: +r.worst.toFixed(3),
    fixed: +r.fixed.toFixed(3), basic: +r.prior.toFixed(3), sigma: +r.sigma.toFixed(3),
    bestMetrics: r.bestMetrics, fixedMetrics: r.fixedMetrics, basicMetrics: r.priorMetrics,
  });
  if (g % 10 === 0 || g === gens - 1) console.log(`gen ${g} best ${r.best.toFixed(2)} mean ${r.mean.toFixed(2)} basic ${r.prior.toFixed(2)} fixed ${r.fixed.toFixed(2)} (${((performance.now() - t0) / 1000).toFixed(0)}s)`);
}
const champ = await ev.champion(10);
pool.terminate();
const out = {
  meta: {
    generations: gens, population: pop, seed, genomeLength: GENOME_LEN, synapses: STRUCTURE.synapses,
    validationFitness: champ.fitness, candidates: champ.candidates, trainedAt: new Date().toISOString(),
    wallSeconds: Math.round((performance.now() - t0) / 1000), startedFrom: 'basic seed wiring',
  },
  genome: genomeToJSON(champ.genome),
  history,
};
fs.mkdirSync(new URL('../web/data/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('../web/data/evolved.json', import.meta.url), JSON.stringify(out));
console.log('wrote web/data/evolved.json, validation fitness', champ.fitness.toFixed(2));
