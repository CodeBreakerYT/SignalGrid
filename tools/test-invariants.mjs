// Safety + physics invariants, checked at every simulation step for every controller.
import { buildScenario, SCENARIO_ORDER } from '../web/js/core/scenarios.js';
import { Sim, SAFETY, DT, PHASES } from '../web/js/core/sim.js';
import { controllerFactory, priorGenome } from '../web/js/core/controllers.js';
let fails = 0; const fail = (m) => { fails++; if (fails < 25) console.log('FAIL', m); };
for (const id of SCENARIO_ORDER) for (const kind of ['fixed', 'adaptive', 'adaptive-noisy']) {
  const g = kind === 'adaptive-noisy' ? priorGenome(1.5, 9) : undefined;
  const sim = new Sim(buildScenario(id, 7), controllerFactory(kind === 'fixed' ? 'fixed' : 'adaptive', g));
  const track = sim.nodes.map(() => ({ state: 'green', phase: 0, greenAt: 0, amberAt: 0, redAt: 0, boxBefore: new Set() }));
  let steps = 0;
  while (sim.t < sim.sc.duration) {
    // snapshot vehicles that are in link state with s>0 before the step
    const before = new Map();
    for (const l of sim.links) for (const a of l.lanes) for (const v of a) if (v.state === 'link') before.set(v, l);
    const prevSig = sim.nodes.map((n) => ({ state: n.sig.state, phase: n.sig.phase, elapsed: n.sig.elapsed }));
    sim.step(); steps++;
    sim.nodes.forEach((n, i) => {
      const p = prevSig[i], s = n.sig;
      if (p.state === 'green' && s.state === 'amber' && p.elapsed + 1e-6 < SAFETY.minGreen[p.phase]) fail(`${id}/${kind} min green violated ${p.elapsed} < ${SAFETY.minGreen[p.phase]}`);
      if (p.state === 'green' && s.state === 'amber') for (const c of PHASES[p.phase].walk) if (n.pedCross[c].length && s.clearT < SAFETY.pedClearMax - 0.3 && n.pedCross[c].some(x => x.end > sim.t + 0.01)) fail(`${id}/${kind} amber while pedestrians crossing`);
      if (p.state === 'amber' && s.state === 'green') fail('amber->green directly');
      if (p.state === 'green' && s.state === 'green' && p.phase !== s.phase) fail('phase jump w/o clearance');
      if (p.state === 'allred' && s.state === 'green' && s.elapsed > 0.01) fail('green elapsed not reset');
      if (s.elapsed > SAFETY.maxGreen[s.phase] + SAFETY.pedClearMax + 3 && s.state === 'green' && sim.demandOf(n, (s.phase + 1) % 4) + sim.demandOf(n, (s.phase + 2) % 4) + sim.demandOf(n, (s.phase + 3) % 4) > 0) fail(`${id}/${kind} max green exceeded ${s.elapsed}`);
    });
    // red-light running: vehicle that entered box this step must have had green/amber
    for (const [v, l] of before) {
      if (v.state === 'box') {
        const sg = l.node.sig, ph = (l.h % 2 === 0 ? 0 : 2) + v.lane;
        if (!(sg.phase === ph && (sg.state === 'green' || sg.state === 'amber'))) fail(`${id}/${kind} red-light entry t=${sim.t.toFixed(1)} state=${sg.state} phase=${sg.phase} need=${ph}`);
      }
    }
    // overlap
    if (steps % 8 === 0) for (const l of sim.links) for (const a of l.lanes) for (let k = 1; k < a.length; k++) {
      const gap = a[k].s - a[k - 1].s - a[k - 1].len;
      if (gap < -1.5) fail(`${id}/${kind} overlap gap=${gap.toFixed(2)} link ${l.key}`);
      if (a[k].s < a[k - 1].s) fail('order broken');
    }
  }
  const m = sim.summary();
  console.log(`${id.padEnd(9)} ${kind.padEnd(15)} ok  thr=${m.throughput}/${m.spawned} wait=${m.avgWait.toFixed(1)}`);
}
console.log(fails ? `\n${fails} FAILURES` : '\nALL INVARIANTS HELD');
process.exit(fails ? 1 : 0);
