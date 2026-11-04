// Level design helper: for each campaign mission, list seeds on which the Adaptive / Evolved agent earn stars.
// The campaign seeds in web/js/ui/progress.js were picked from this output so every mission is winnable.
import fs from 'node:fs';
import { MISSIONS, evaluateMission } from '../web/js/ui/progress.js';
import { runOne } from '../web/js/core/bench.js';
import { genomeFromJSON } from '../web/js/core/evolve.js';

const evo = genomeFromJSON(JSON.parse(fs.readFileSync(new URL('../web/data/evolved.json', import.meta.url))).genome);
const lo = +process.argv[2] || 300, n = +process.argv[3] || 24;
for (const m of MISSIONS) {
  const rows = [];
  for (let seed = lo; seed < lo + n; seed++) {
    const f = runOne(m.scenario, seed, 'fixed').summary;
    const a = evaluateMission(m, f, runOne(m.scenario, seed, 'adaptive').summary);
    const e = evaluateMission(m, f, runOne(m.scenario, seed, 'evolved', evo).summary);
    rows.push({ seed, a: a.stars, e: e.stars, as: a.score, es: e.score });
  }
  const good = rows.filter((r) => r.a >= 1 && r.e >= 2).sort((x, y) => y.e - x.e || y.es - x.es).slice(0, 4);
  console.log(m.id.padEnd(10), 'winnable seeds (adaptive>=1, evolved>=2):', good.map((r) => `${r.seed}[a${r.a} e${r.e} ${r.as}/${r.es}]`).join('  ') || 'NONE', `| adaptive passes ${rows.filter((r) => r.a >= 1).length}/${n}, evolved passes ${rows.filter((r) => r.e >= 1).length}/${n}`);
}
