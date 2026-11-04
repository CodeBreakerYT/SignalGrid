// C. AI Evolution Lab: watch real neuroevolution run in Web Workers, inspect the agent's "brain",
// compare against baselines on the training mix, and deploy the champion as the Evolved AI.
import { h, $, fmt, toast, COLORS, CTRL_COLORS } from '../util.js';
import { lineChart, swarmChart, groupBars, legend } from '../charts.js';
import { drawNet } from '../netviz.js';
import { SimView, SimRunner } from '../render.js';
import { Sim } from '../../core/sim.js';
import { buildScenario } from '../../core/scenarios.js';
import { NeuralController, priorGenome, GENOME_LEN, STRUCTURE, NET } from '../../core/controllers.js';
import { Evolution, DEFAULT_WEIGHTS, FITNESS_TERMS, genomeToJSON, genomeFromJSON, evalGenome } from '../../core/evolve.js';
import { EvalPool, browserSpawner } from '../../core/pool.js';
import { data, store, evolvedGenome } from '../store.js';
import { award } from '../achievements.js';

export function createLab(ctx) {
  const root = h('section', { class: 'view', id: 'view-lab' });
  root.innerHTML = `
  <div class="callout" style="margin-bottom:14px"><b>What is evolving?</b> A ${NET.nIn}-sensor, ${NET.nHid}-interneuron, ${NET.nOut}-output rate network (${GENOME_LEN} genes, ${STRUCTURE.synapses} recurrent synapses) with excitatory/inhibitory neurons and
    the same activation dynamics as the Fly Dungeon brain. It is <b>inspired by</b> that connectome-style architecture, it is <b>not</b> the fruit-fly connectome and is not trained on it. Fitness is measured by running the traffic simulator.</div>
  <div class="split">
    <div class="stack">
      <div class="card">
        <div class="card-h"><h2>Evolution run</h2><div class="row tight"><span class="chip" id="e-gen">gen 0</span><span class="chip" id="e-best">best -</span><span class="chip" id="e-gain">-</span><span class="chip" id="e-src"></span></div></div>
        <div class="row">
          <button class="btn primary" id="e-run">Start evolving</button><button class="btn" id="e-step">Step 1 generation</button>
          <button class="btn" id="e-reset">New run</button><div class="spacer"></div>
          <button class="btn primary" id="e-deploy" disabled>Deploy best as Evolved AI</button><button class="btn sm" id="e-shipped">Use shipped champion</button>
        </div>
        <div class="progress" style="margin-top:10px"><div class="pbar"><i id="e-prog" style="width:0%"></i></div><div class="xs muted" id="e-status" style="margin-top:4px"></div></div>
      </div>
      <div class="card"><div class="card-h"><h2>Fitness progression</h2><span class="sub" id="e-fit-sub"></span></div><canvas class="chart lg" id="e-ch-fit"></canvas><div id="e-leg"></div></div>
      <div class="grid cols-2">
        <div class="card"><div class="card-h"><h2>Population</h2><span class="sub">every agent, every generation</span></div><canvas class="chart" id="e-ch-swarm"></canvas></div>
        <div class="card"><div class="card-h"><h2>Evolved vs baseline</h2><span class="sub">training mix, measured</span></div><canvas class="chart" id="e-ch-cmp"></canvas><div id="e-leg2"></div></div>
      </div>
      <div class="card"><div class="card-h"><h2>Top agents this generation</h2></div><div class="scroll-x" id="e-top"></div></div>
    </div>
    <div class="stack">
      <div class="card"><div class="card-h"><h2>Neural agent</h2><div class="seg" id="e-who"><button data-w="adaptive">Seed</button><button data-w="best" class="on">Best</button><button data-w="shipped">Shipped</button></div></div>
        <canvas id="e-net" style="width:100%;height:460px;display:block"></canvas>
        <div class="xs muted">Sensors (left) feed phase-module interneurons; outputs (right) score the four phases plus a hold bias and a green-duration target. Brightness = live activity in the preview below.</div></div>
      <div class="card"><div class="card-h"><h2>Watch this agent drive</h2><span class="sub" id="e-prev-sub"></span></div>
        <div class="stage stage-sm"><canvas id="e-prev"></canvas></div></div>
      <div class="card"><div class="card-h"><h2>Fitness function</h2><button class="btn sm" id="e-w-reset">Reset</button></div>
        <div class="xs muted" style="margin-bottom:8px">Higher fitness = lower weighted cost. Change the weights to evolve a different personality.</div><div class="stack" style="gap:7px" id="e-weights"></div>
        <div id="e-parts" style="margin-top:10px"></div></div>
      <div class="card"><h2>Run settings</h2><div class="stack" style="gap:8px;margin-top:8px">
        <label class="fld">Population <div class="slider-row" style="grid-template-columns:1fr 38px"><input type="range" id="e-pop" min="16" max="96" step="8" value="48"><output id="e-pop-o">48</output></div></label>
        <label class="fld">Start from <select id="e-start"><option value="prior">Seed agent (Adaptive AI wiring)</option><option value="random">Random wiring</option></select></label>
        <div class="xs muted" id="e-pool-note"></div></div></div>
    </div>
  </div>`;

  const prev = new SimView($('#e-prev', root), { interactive: false });
  let ev = null, pool = null, running = false, busy = false, who = 'best', weights = { ...DEFAULT_WEIGHTS }, showShipped = true;
  let previewSim = null, previewRunner = null, previewKey = '';

  // ---- fitness weight sliders
  const wbox = $('#e-weights', root);
  for (const [k, t] of Object.entries(FITNESS_TERMS)) {
    const max = k === 'sw' ? 1 : 2.5;
    const out = h('output', {}, weights[k].toFixed(2));
    const inp = h('input', { type: 'range', min: 0, max, step: 0.05, value: weights[k], oninput: () => { weights[k] = +inp.value; out.textContent = (+inp.value).toFixed(2); if (ev) ev.weights = { ...weights }; }, title: t.hint, 'data-k': k });
    wbox.append(h('div', { class: 'slider-row' }, h('span', { title: t.hint }, t.label), inp, out));
  }
  $('#e-w-reset', root).onclick = () => { weights = { ...DEFAULT_WEIGHTS }; wbox.querySelectorAll('input').forEach((i) => { i.value = weights[i.dataset.k]; i.nextSibling.textContent = weights[i.dataset.k].toFixed(2); }); if (ev) ev.weights = { ...weights }; };
  $('#e-pop', root).oninput = (e) => { $('#e-pop-o', root).textContent = e.target.value; };
  $('#e-who', root).querySelectorAll('button').forEach((b) => { b.onclick = () => { who = b.dataset.w; $('#e-who', root).querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); previewKey = ''; }; });

  function ensurePool() {
    if (pool !== null) return pool;
    try {
      const n = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
      pool = new EvalPool(browserSpawner(), n);
      $('#e-pool-note', root).textContent = `${n} Web Workers evaluate agents in parallel.`;
    } catch (e) {
      pool = false;
      $('#e-pool-note', root).textContent = 'Web Workers unavailable here (serve over http://). Using the UI thread with a reduced scenario mix.';
    }
    return pool;
  }

  function newRun() {
    const p = ensurePool();
    const popSize = +$('#e-pop', root).value;
    const seed = (Math.random() * 1e6) | 0;
    ev = new Evolution({
      popSize, seed, weights, startFrom: $('#e-start', root).value, light: !p, mutRate: 0.02, mutStep: 0.15, rotateEvery: 15, setBlocks: 2,
      evaluator: p ? p.evaluate : async (gs, specs, w) => { const out = []; for (const g of gs) { out.push(evalGenome(g, specs, w)); await new Promise((r) => setTimeout(r, 0)); } return out; },
    });
    showShipped = false; previewKey = '';
    draw();
    return ev;
  }

  async function oneGen() {
    if (busy) return;
    busy = true;
    try {
      if (!ev) newRun();
      const t0 = performance.now();
      $('#e-status', root).textContent = `Evaluating ${ev.popSize} agents on ${ev.specsFor(ev.gen).length} scenarios each (generation ${ev.gen + 1})...`;
      await ev.step();
      $('#e-status', root).textContent = `Generation ${ev.gen} took ${((performance.now() - t0) / 1000).toFixed(1)} s`;
      $('#e-deploy', root).disabled = false;
      draw();
    } catch (e) { console.error(e); toast('Evolution error: ' + e.message, 'err'); running = false; syncRun(); }
    busy = false;
  }

  async function loop() { while (running) { await oneGen(); await new Promise((r) => setTimeout(r, 30)); } }
  const syncRun = () => { $('#e-run', root).textContent = running ? 'Pause evolving' : (ev && ev.gen ? 'Resume evolving' : 'Start evolving'); };
  $('#e-run', root).onclick = () => { running = !running; syncRun(); if (running) loop(); };
  $('#e-step', root).onclick = () => { if (!running) oneGen(); };
  $('#e-reset', root).onclick = () => { running = false; syncRun(); newRun(); $('#e-deploy', root).disabled = true; $('#e-status', root).textContent = 'New population created.'; };
  $('#e-deploy', root).onclick = () => {
    if (!ev || !ev.history.length) return;
    const g = ev.bestEver.genome, st = store.get();
    st.userGenome = genomeToJSON(g); st.userGenomeMeta = { gen: ev.bestEver.gen, fitness: ev.bestEver.fitness, at: Date.now() }; store.save();
    toast(`Deployed generation ${ev.bestEver.gen} agent as the Evolved AI (fitness ${ev.bestEver.fitness.toFixed(1)}).`, 'good');
    award('evo'); ctx.refresh(); draw();
  };
  $('#e-shipped', root).onclick = () => { const st = store.get(); st.userGenome = null; st.userGenomeMeta = null; store.save(); toast('Evolved AI reset to the shipped champion.'); ctx.refresh(); draw(); };

  function currentGenome() {
    if (who === 'adaptive') return priorGenome();
    if (who === 'shipped') return data.evolved ? genomeFromJSON(data.evolved.genome) : null;
    if (ev && ev.bestEver) return ev.bestEver.genome;
    return evolvedGenome();
  }

  function draw() {
    const hist = ev ? ev.history : [];
    const shipped = data.evolved?.history || [];
    const useShipped = !hist.length && shipped.length;
    const hh = useShipped ? shipped : hist;
    $('#e-gen', root).textContent = ev ? `gen ${ev.gen}` : `shipped run: ${shipped.length} gens`;
    const last = hh[hh.length - 1];
    if (last) {
      $('#e-best', root).textContent = `best ${last.best.toFixed(1)}`;
      const base = last.fixed, gain = ((last.best - base) / base) * 100;
      $('#e-gain', root).innerHTML = `<span class="${gain >= 0 ? 'good' : 'bad'}">${gain >= 0 ? '+' : ''}${gain.toFixed(1)}% vs Fixed</span>`;
    }
    $('#e-src', root).textContent = useShipped ? 'offline run (shipped)' : 'live run';
    $('#e-fit-sub', root).textContent = useShipped ? `shipped offline run · ${data.evolved.meta.population} agents · ${data.evolved.meta.generations} generations` : '';
    const mk = (key) => hh.map((r) => [r.gen, r[key]]);
    const series = [
      { name: 'Best agent', color: COLORS.cyan, data: mk('best'), fill: true },
      { name: 'Population mean', color: COLORS.purple, data: mk('mean') },
      { name: 'Adaptive seed (baseline)', color: CTRL_COLORS.adaptive, data: mk(useShipped ? 'basic' : 'prior'), dash: [5, 4], width: 1.6 },
      { name: 'Fixed Timer (baseline)', color: CTRL_COLORS.fixed, data: mk('fixed'), dash: [2, 3], width: 1.6 },
    ];
    lineChart($('#e-ch-fit', root), { series, xLabel: 'generation', yLabel: 'fitness (higher = better)' });
    $('#e-leg', root).innerHTML = legend(series);
    if (hist.length) swarmChart($('#e-ch-swarm', root), hist); else swarmChart($('#e-ch-swarm', root), []);
    const bm = last ? (useShipped ? last.bestMetrics : last.bestMetrics) : null;
    if (last && bm) {
      const fm = last.fixedMetrics, pm = last.priorMetrics || last.basicMetrics;
      const rows = [['Avg wait (s)', 'avgWait'], ['Avg queue (veh)', 'avgQueue'], ['Ped. wait (s)', 'pedWait'], ['Emergency (s)', 'emergDelay']].map(([l, k]) => ({ label: l, values: [
        { v: fm[k], color: CTRL_COLORS.fixed, text: fm[k].toFixed(1) }, { v: pm[k], color: CTRL_COLORS.adaptive, text: pm[k].toFixed(1) }, { v: bm[k], color: CTRL_COLORS.evolved, text: bm[k].toFixed(1) }] }));
      groupBars($('#e-ch-cmp', root), rows);
      $('#e-leg2', root).innerHTML = legend([{ name: 'Fixed', color: CTRL_COLORS.fixed }, { name: 'Adaptive seed', color: CTRL_COLORS.adaptive }, { name: 'Best evolved', color: CTRL_COLORS.evolved }]);
    }
    // top agents
    if (ev && ev.top) {
      $('#e-top', root).innerHTML = `<table class="t"><thead><tr><th>#</th><th>Fitness</th><th>Wait s</th><th>Queue</th><th>Ped s</th><th>Emerg s</th><th>Done %</th><th>Chg/h</th></tr></thead><tbody>${ev.top.map((a, i) => `<tr class="${i === 0 ? 'hl' : ''}"><td>${i + 1}</td><td>${a.fitness.toFixed(2)}</td><td>${a.m.avgWait.toFixed(1)}</td><td>${a.m.avgQueue.toFixed(1)}</td><td>${a.m.pedWait.toFixed(1)}</td><td>${a.m.emergDelay.toFixed(1)}</td><td>${(a.m.completionRate * 100).toFixed(0)}</td><td>${a.m.switchesPerHour.toFixed(0)}</td></tr>`).join('')}</tbody></table>`;
      const parts = ev.top[0].parts, tot = Object.values(parts).reduce((a, b) => a + b, 0) || 1;
      $('#e-parts', root).innerHTML = `<div class="xs muted" style="margin-bottom:4px">Cost breakdown of the best agent</div>` + Object.entries(parts).map(([k, v]) => `<div class="lane" style="grid-template-columns:100px 1fr 44px"><span>${FITNESS_TERMS[k].label}</span><div class="pbar"><i style="width:${(v / tot) * 100}%;background:linear-gradient(90deg,${COLORS.purple},${COLORS.cyan})"></i></div><span class="mono">${v.toFixed(2)}</span></div>`).join('');
    } else {
      $('#e-top', root).innerHTML = '<div class="muted sm">Start a run to see the leaderboard. Meanwhile the charts show the offline run that produced the shipped champion.</div>';
    }
    const src = store.get().userGenomeMeta;
    $('#e-prog', root).style.width = ev ? Math.min(100, (ev.gen / 60) * 100) + '%' : '0%';
    if (!$('#e-status', root).textContent) $('#e-status', root).textContent = src ? `Your deployed agent: generation ${src.gen}, fitness ${src.fitness.toFixed(1)}.` : 'Using the shipped champion as Evolved AI until you deploy your own.';
  }

  let acc = 0;
  const api = {
    id: 'lab', title: 'AI Evolution Lab', root,
    show() { draw(); previewKey = ''; },
    hide() {},
    refresh() { draw(); },
    tick(dt) {
      const g = currentGenome();
      const key = who + (ev ? ev.gen : 'x') + (g ? g[7] : '');
      if (g && key !== previewKey) {
        previewKey = key;
        previewSim = new Sim(buildScenario('rush', 77, { duration: 1e6 }), () => new NeuralController(g, 'evolved'));
        previewRunner = new SimRunner(previewSim); previewRunner.speed = 4; prev.setSim(previewSim);
        $('#e-prev-sub', root).textContent = { adaptive: 'seed agent', best: 'best of your run', shipped: 'shipped champion' }[who] + ' · Rush Hour · 4x';
      }
      if (previewRunner) { const f = previewRunner.advance(dt); prev.draw(f); }
      acc += dt;
      if (acc > 0.12 && g) { acc = 0; const c = previewSim?.nodes[0]?.ctrl; drawNet($('#e-net', root), g, { x: c?.net?.x, obs: c?.obs }); }
    },
  };
  void lineChart;
  return api;
}
