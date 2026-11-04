// B. Live Simulation: interactive junction/grid with manual and AI control.
import { h, fmt, $, COLORS, CTRL_COLORS, toast } from '../util.js';
import { createDualView } from '../render3d.js';
import { lineChart } from '../charts.js';
import { PHASES, SAFETY } from '../../core/sim.js';
import { SCENARIOS, SCENARIO_ORDER, HEADING_NAMES } from '../../core/scenarios.js';
import { CONTROLLER_LABELS } from '../../core/controllers.js';
import { isUnlocked } from '../progress.js';

const KINDS = ['fixed', 'adaptive', 'evolved', 'manual'];

export function createLive(ctx) {
  const { world } = ctx;
  const root = h('section', { class: 'view', id: 'view-live' });
  root.innerHTML = `
  <div class="split">
    <div class="stack">
      <div class="card">
        <div class="card-h"><h2>Live intersection</h2>
          <div class="row tight">
            <label class="fld" style="flex-direction:row;align-items:center;gap:8px">Scenario <select id="l-scn"></select></label>
            <button class="btn sm" id="l-reseed" title="Same scenario, different random traffic">New seed</button>
          </div></div>
        <div class="stage stage-lg"><canvas id="l-canvas"></canvas>
          <div class="hud"><span class="chip" id="l-h1"></span><span class="chip" id="l-h2"></span><span class="chip" id="l-h3"></span></div></div>
        <div class="row" style="margin-top:10px">
          <div class="seg" id="l-mode"></div>
          <div class="spacer"></div>
          <button class="btn" id="l-play">Pause</button>
          <div class="seg" id="l-speed"></div>
          <button class="btn" id="l-reset">Restart</button>
        </div>
      </div>
      <div class="card"><div class="card-h"><h2>Signal timeline</h2><span class="sub" id="l-tl-sub"></span></div><canvas class="chart sm" id="l-tl" style="height:84px"></canvas>
        <div class="legend-inline" id="l-tl-leg"></div></div>
      <div class="grid cols-2">
        <div class="card"><div class="card-h"><h2>Queue</h2><span class="sub">stopped vehicles</span></div><canvas class="chart sm" id="l-ch-q"></canvas></div>
        <div class="card"><div class="card-h"><h2>Average waiting</h2><span class="sub">seconds</span></div><canvas class="chart sm" id="l-ch-w"></canvas></div>
      </div>
    </div>
    <div class="stack">
      <div class="card" id="l-signal"></div>
      <div class="card"><div class="card-h"><h2>Lane queues</h2><span class="sub" id="l-lane-sub"></span></div><div class="lane-bars" id="l-lanes"></div></div>
      <div class="card"><h2>Live metrics</h2><div id="l-metrics" style="margin-top:8px"></div></div>
      <div class="card"><h2>Inject an event</h2><div class="row" style="margin-top:8px">
        <button class="btn" id="l-amb">Ambulance</button><button class="btn" id="l-acc">Accident</button><button class="btn" id="l-ped">Pedestrian surge</button><button class="btn" id="l-sur">Traffic surge</button></div></div>
    </div>
  </div>`;

  const view = createDualView($('#l-canvas', root).parentElement, $('#l-canvas', root), { onSelect: () => api.panels(true) });
  const scn = $('#l-scn', root);
  const fillScn = () => {
    scn.replaceChildren();
    SCENARIO_ORDER.forEach((id) => { const ok = isUnlocked('scenario', id); scn.append(h('option', { value: id, disabled: !ok }, (ok ? '' : '\u{1F512} ') + SCENARIOS[id].name)); });
    scn.value = world.scenarioId;
  };
  scn.onchange = () => { world.setScenario(scn.value); view.setSim(world.sim); api.panels(true); };
  $('#l-reseed', root).onclick = () => { world.reseed(); view.setSim(world.sim); };
  const mode = $('#l-mode', root);
  for (const k of KINDS) mode.append(h('button', { 'data-k': k, onclick: () => { if (k === 'evolved' && !isUnlocked('controller', 'evolved')) return toast('Clear mission 2 to unlock Evolved AI.', 'err'); world.setKind(k); view.setSim(world.sim); api.panels(true); } }, CONTROLLER_LABELS[k]));
  const speed = $('#l-speed', root);
  for (const sp of [1, 2, 4, 8, 16]) speed.append(h('button', { 'data-s': sp, onclick: () => { world.runner.speed = sp; api.panels(true); } }, sp + 'x'));
  $('#l-play', root).onclick = () => { world.runner.paused = !world.runner.paused; api.panels(true); };
  $('#l-reset', root).onclick = () => { world.reset(); view.setSim(world.sim); };
  const sel = () => world.sim.nodes[view.selected] || world.sim.nodes[0];
  $('#l-amb', root).onclick = () => world.inject('ambulance', sel().id);
  $('#l-acc', root).onclick = () => world.inject('accident', sel().id);
  $('#l-ped', root).onclick = () => world.inject('peds', sel().id);
  $('#l-sur', root).onclick = () => world.inject('surge', sel().id);

  let acc = 0;
  const api = {
    id: 'live', title: 'Live Simulation', root,
    show() { fillScn(); view.setSim(world.sim); this.panels(true); },
    hide() {},
    refresh() { fillScn(); view.setSim(world.sim); },
    tick(dt, frac) {
      view.draw(frac);
      acc += dt; if (acc < 0.25) return; acc = 0;
      this.panels(false);
    },
    panels(force) {
      const s = world.sim, n = sel();
      scn.value = world.scenarioId;
      mode.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.k === world.kind));
      speed.querySelectorAll('button').forEach((b) => b.classList.toggle('on', +b.dataset.s === world.runner.speed));
      $('#l-play', root).textContent = world.runner.paused ? 'Resume' : 'Pause';
      const t = s.t;
      $('#l-h1', root).textContent = `${SCENARIOS[world.scenarioId].name} · ${s.nx}x${s.ny}`;
      $('#l-h2', root).textContent = `sim ${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
      const lsc = world.liveScore();
      if (lsc) $('#l-h3', root).textContent = `score ${lsc.score} \u00b7 wait ${lsc.i.avgWait >= 0 ? '-' : '+'}${Math.abs(lsc.i.avgWait).toFixed(0)}% vs fixed`; else
      $('#l-h3', root).textContent = `${s.nodes.length > 1 ? 'J' + (n.id + 1) + ' selected' : 'single junction'}`;
      this.signalPanel(n);
      this.lanePanel(n);
      this.metricPanel(s);
      this.timeline(n);
      lineChart($('#l-ch-q', root), { series: [{ name: 'queue', color: COLORS.amber, data: world.series.queue, fill: true }], xLabel: 'simulated seconds' });
      lineChart($('#l-ch-w', root), { series: [{ name: 'wait', color: CTRL_COLORS[world.kind], data: world.series.wait, fill: true }], xLabel: 'simulated seconds' });
      void force;
    },
    signalPanel(n) {
      const sg = n.sig, el = $('#l-signal', root), manual = world.kind === 'manual';
      const stateTxt = sg.state === 'green' ? `GREEN ${sg.elapsed.toFixed(1)} s` : sg.state === 'amber' ? `AMBER ${sg.timer.toFixed(1)} s` : `ALL-RED ${sg.timer.toFixed(1)} s`;
      const minLeft = Math.max(0, SAFETY.minGreen[sg.phase] - sg.elapsed);
      let note = '';
      if (sg.state === 'green' && sg.pending >= 0) note = sg.clearT > 0 && n.pedCross.some((c) => c.length) ? 'Pedestrian clearance in progress' : 'Switch committed';
      else if (sg.state === 'green' && minLeft > 0) note = `Minimum green: ${minLeft.toFixed(1)} s left`;
      else if (sg.state === 'green') note = 'Free to change';
      el.innerHTML = `<div class="card-h"><h2>Signal control</h2><span class="chip ${sg.state === 'green' ? 'on' : 'off'}"><i class="dot"></i>${stateTxt}</span></div>
        <div class="sm muted" style="margin-bottom:8px">${world.sim.nodes.length > 1 ? 'Junction J' + (n.id + 1) + ' &middot; ' : ''}${note}</div>
        <div class="phase-row" id="l-phases"></div>
        <div class="xs muted" style="margin-top:8px">${manual ? 'Click a phase to request it. The safety layer decides when it can start.' : 'Phases are chosen by the ' + CONTROLLER_LABELS[world.kind] + ' controller.'}</div>`;
      const row = $('#l-phases', el);
      PHASES.forEach((p) => {
        const b = h('button', { class: 'phase-btn' + (sg.phase === p.id ? ' cur' : '') + (sg.pending === p.id ? ' pend' : ''), disabled: !manual, onclick: () => { n.ctrl.requested = p.id; toast(`Requested ${p.name}`); } }, h('b', {}, p.short), p.name);
        row.append(b);
      });
      if (manual && n.ctrl.requested < 0) n.ctrl.requested = sg.phase;
    },
    lanePanel(n) {
      const el = $('#l-lanes', root); el.replaceChildren();
      for (let hd = 0; hd < 4; hd++) for (let lane = 0; lane < 2; lane++) {
        const arr = n.inLinks[hd].lanes[lane];
        let q = 0, crashed = false; for (const v of arr) { if (v.crashed) crashed = true; else if (v.state === 'link' && v.v < 1) q++; }
        const phase = (hd % 2 === 0 ? 0 : 2) + lane, green = n.sig.phase === phase && n.sig.state === 'green';
        el.append(h('div', { class: 'lane' }, h('span', {}, `${HEADING_NAMES[hd].slice(0, 5)} ${lane ? 'left' : 'thru'}`),
          h('div', { class: 'pbar' }, h('i', { style: `width:${Math.min(100, (q / 12) * 100)}%` })),
          h('span', { class: 'mono ' + (crashed ? 'bad' : green ? 'good' : '') }, crashed ? '!!' : String(q))));
      }
      $('#l-lane-sub', root).textContent = `${n.pedQ.reduce((a, c) => a + c.length, 0)} pedestrians waiting`;
    },
    metricPanel(s) {
      const m = s.summary();
      const rows = [
        ['Avg waiting time', fmt(m.avgWait, 1) + ' s'], ['Avg vehicle delay', fmt(m.avgDelay, 1) + ' s'], ['Max queue (one approach)', m.maxQueue + ' veh'],
        ['Vehicles processed', `${m.throughput} of ${m.spawned}`], ['Pedestrian wait', fmt(m.pedWait, 1) + ' s'],
        ['Emergency delay', m.emergCount ? fmt(m.emergDelay, 1) + ' s' : '-'], ['Signal efficiency', (m.signalEfficiency * 100).toFixed(0) + ' %'], ['Phase changes / h', m.switchesPerHour.toFixed(0)],
      ];
      $('#l-metrics', root).innerHTML = `<table class="t"><tbody>${rows.map((r) => `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join('')}</tbody></table>`;
    },
    timeline(n) {
      const log = world.phaseLog[n.id] || [];
      const canvas = $('#l-tl', root), ctxc = canvas.getContext('2d');
      const w = canvas.clientWidth, hh = canvas.clientHeight, dpr = Math.min(2, window.devicePixelRatio || 1);
      if (canvas.width !== w * dpr) { canvas.width = w * dpr; canvas.height = hh * dpr; }
      ctxc.setTransform(dpr, 0, 0, dpr, 0, 0); ctxc.clearRect(0, 0, w, hh);
      const span = 240, t1 = world.sim.t, t0 = t1 - span;
      const cols = [COLORS.cyan, COLORS.purple, COLORS.blue, COLORS.magenta];
      const segs = log.map((e, i) => ({ a: e.t, b: log[i + 1] ? log[i + 1].t : t1, p: e.phase }));
      if (!segs.length || segs[0].a > t0) segs.unshift({ a: Math.max(0, t0), b: segs.length ? segs[0].a : t1, p: n.sig.phase });
      for (const s of segs) {
        const x0 = Math.max(0, ((s.a - t0) / span) * w), x1 = Math.min(w, ((s.b - t0) / span) * w);
        if (x1 <= 0) continue;
        ctxc.fillStyle = cols[s.p] + 'cc'; ctxc.fillRect(x0, 8, Math.max(1, x1 - x0 - 1), hh - 26);
      }
      ctxc.fillStyle = '#8a93b8'; ctxc.font = '10px "Cascadia Mono", monospace'; ctxc.fillText(`-${span}s`, 2, hh - 4); ctxc.textAlign = 'right'; ctxc.fillText('now', w - 2, hh - 4);
      $('#l-tl-leg', root).innerHTML = PHASES.map((p, i) => `<span><i style="display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;background:${cols[i]}"></i>${p.name}</span>`).join('');
      $('#l-tl-sub', root).textContent = `${n.sig.switches} phase changes`;
    },
  };
  return api;
}
