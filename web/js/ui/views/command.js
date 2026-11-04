// A. Command Center: city-level overview of the running simulation and the AI controller.
import { h, fmt, $, COLORS, CTRL_COLORS } from '../util.js';
import { createDualView } from '../render3d.js';
import { lineChart, sparkline, legend } from '../charts.js';
import { PHASES, SAFETY } from '../../core/sim.js';
import { SCENARIOS, SCENARIO_ORDER } from '../../core/scenarios.js';
import { CONTROLLER_LABELS, GENOME_LEN, STRUCTURE, NET } from '../../core/controllers.js';
import { data, evolvedSource } from '../store.js';
import { improvement, METRICS } from '../../core/bench.js';

const KINDS = ['fixed', 'adaptive', 'evolved'];

export function createCommand(ctx) {
  const { world } = ctx;
  const root = h('section', { class: 'view', id: 'view-command' });
  root.innerHTML = `
  <div class="grid cols-4" id="c-kpis">
    <div class="card kpi"><div class="lab">Active intersections</div><div class="val" id="k-nodes">-</div><div class="delta muted" id="k-nodes-d"></div></div>
    <div class="card kpi"><div class="lab">Network congestion</div><div class="val" id="k-cong">-</div><div class="delta" id="k-cong-d"></div><canvas id="sp-cong"></canvas></div>
    <div class="card kpi"><div class="lab">Avg waiting time</div><div class="val" id="k-wait">-</div><div class="delta muted">per vehicle, incl. queued outside</div><canvas id="sp-wait"></canvas></div>
    <div class="card kpi"><div class="lab">Vehicle throughput</div><div class="val" id="k-thr">-</div><div class="delta muted" id="k-thr-d"></div><canvas id="sp-thr"></canvas></div>
  </div>
  <div class="split" style="margin-top:14px">
    <div class="stack">
      <div class="card">
        <div class="card-h"><h2>City map</h2><div class="row tight">
          <label class="fld" style="flex-direction:row;align-items:center;gap:8px">Scenario <select id="c-scn"></select></label>
          <div class="seg" id="c-mode"></div>
        </div></div>
        <div class="stage stage-lg" id="c-stage"><canvas id="c-canvas"></canvas>
          <div class="hud"><span class="chip" id="c-h1"></span><span class="chip" id="c-h2"></span></div>
          <div class="corner chip" style="background:rgba(5,7,16,.8)">drag to pan &middot; wheel to zoom &middot; double-click to reset</div></div>
      </div>
      <div class="grid cols-2">
        <div class="card"><div class="card-h"><h2>Queue length</h2><span class="sub">stopped vehicles, whole network</span></div><canvas class="chart sm" id="c-ch-q"></canvas></div>
        <div class="card"><div class="card-h"><h2>Average waiting</h2><span class="sub">seconds per vehicle</span></div><canvas class="chart sm" id="c-ch-w"></canvas></div>
      </div>
    </div>
    <div class="stack">
      <div class="card" id="c-ai"></div>
      <div class="card"><h2>Safety envelope</h2><div class="sm muted" style="margin:6px 0 8px">Enforced for every controller. The AI proposes, the safety layer disposes.</div><div id="c-safe"></div></div>
      <div class="card"><div class="card-h"><h2>Event feed</h2></div><div id="c-feed" class="sm" style="max-height:200px;overflow-y:auto"></div></div>
    </div>
  </div>
  <div class="card" style="margin-top:14px" id="c-headline"></div>`;

  const view = createDualView($('#c-canvas', root).parentElement, $('#c-canvas', root), { onSelect: () => {} });
  const scn = $('#c-scn', root);
  SCENARIO_ORDER.forEach((id) => scn.append(h('option', { value: id }, SCENARIOS[id].name)));
  scn.onchange = () => { world.setScenario(scn.value); view.setSim(world.sim); };
  const mode = $('#c-mode', root);
  for (const k of KINDS) mode.append(h('button', { 'data-k': k, onclick: () => { world.setKind(k); view.setSim(world.sim); ctx.refresh(); } }, CONTROLLER_LABELS[k]));

  let lastUi = 0;
  const spCong = [], spWait = [], spThr = [];

  const api = {
    id: 'command', title: 'Command Center', root,
    show() { view.setSim(world.sim); scn.value = world.scenarioId; this.renderHeadline(); },
    hide() {},
    refresh() { view.setSim(world.sim); scn.value = world.scenarioId; },
    tick(dt, frac) {
      view.draw(frac);
      lastUi += dt;
      if (lastUi < 0.4) return;
      lastUi = 0;
      this.updatePanels();
    },
    updatePanels() {
      const s = world.sim, st = s.summary();
      const stopped = s.nodeQueueTotal(), cap = s.nodes.length * 26;
      const cong = Math.min(1, stopped / cap);
      const level = cong < 0.12 ? ['Free flow', 'good'] : cong < 0.3 ? ['Light', 'good'] : cong < 0.55 ? ['Moderate', 'warn'] : cong < 0.8 ? ['Heavy', 'bad'] : ['Gridlock', 'bad'];
      $('#k-nodes', root).innerHTML = `${s.nodes.length}<small>online</small>`;
      const green = s.nodes.filter((n) => n.sig.state === 'green').length;
      $('#k-nodes-d', root).textContent = `${green} green / ${s.nodes.length - green} clearing`;
      $('#k-cong', root).innerHTML = `${(cong * 100).toFixed(0)}<small>%</small>`;
      $('#k-cong-d', root).innerHTML = `<span class="${level[1]}">${level[0]}</span> &middot; ${stopped} stopped`;
      $('#k-wait', root).innerHTML = `${fmt(st.avgWait, 1)}<small>s</small>`;
      const thr = s.t > 20 ? st.throughput / (s.t / 3600) : 0;
      $('#k-thr', root).innerHTML = `${thr.toFixed(0)}<small>veh/h</small>`;
      $('#k-thr-d', root).textContent = `${st.throughput} vehicles processed, ${st.inSystem} in network`;
      spCong.push(cong); spWait.push(st.avgWait); spThr.push(thr);
      for (const a of [spCong, spWait, spThr]) if (a.length > 90) a.shift();
      sparkline($('#sp-cong', root), spCong, COLORS.amber); sparkline($('#sp-wait', root), spWait, COLORS.cyan); sparkline($('#sp-thr', root), spThr, COLORS.green);
      $('#c-h1', root).textContent = `${SCENARIOS[world.scenarioId].name} · ${s.nx}x${s.ny}`;
      const t = s.t; $('#c-h2', root).textContent = `sim ${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')} · x${world.runner.speed}`;
      $$mode(root, world.kind);
      lineChart($('#c-ch-q', root), { series: [{ name: 'queue', color: COLORS.amber, data: world.series.queue, fill: true }], xLabel: 'simulated seconds' });
      lineChart($('#c-ch-w', root), { series: [{ name: 'wait', color: CTRL_COLORS[world.kind] || COLORS.cyan, data: world.series.wait, fill: true }], xLabel: 'simulated seconds' });
      this.renderAI(); this.renderSafety(); this.renderFeed();
    },
    renderAI() {
      const n = world.sim.nodes[view.selected] || world.sim.nodes[0], c = n.ctrl, el = $('#c-ai', root);
      const kind = world.kind;
      const dot = `<i class="dot" style="color:${CTRL_COLORS[kind]}"></i>`;
      const net = c.net ? `<div class="sm muted">SignalNet &middot; ${NET.nIn} sensors &rarr; ${NET.nHid} interneurons &rarr; ${NET.nOut} outputs &middot; ${STRUCTURE.synapses} recurrent synapses &middot; ${GENOME_LEN} genes</div>` : '<div class="sm muted">No learning: fixed 24/8/24/8 s green splits with a staggered offset.</div>';
      let dec = '';
      if (c.lastOut) {
        const o = c.lastOut;
        dec = `<div class="stack" style="gap:5px;margin-top:8px"><div class="xs muted">Phase preference (junction J${n.id + 1})</div>` +
          PHASES.map((p, i) => `<div class="lane" style="grid-template-columns:86px 1fr 40px"><span>${p.name}</span><div class="pbar"><i style="width:${Math.min(100, (o[i] / 2.5) * 100)}%;background:${i === n.sig.phase ? COLORS.green : COLORS.blue}"></i></div><span class="mono">${o[i].toFixed(2)}</span></div>`).join('') +
          `<div class="xs muted">hold ${o[4].toFixed(2)} &middot; target green ${c.target ? c.target.toFixed(0) : '-'} s</div></div>`;
      }
      const ls = world.liveScore();
      const scoreHtml = ls ? `<div class="row" style="margin:8px 0;padding:10px;border:1px solid var(--line);border-radius:10px;background:var(--panel2)"><div style="width:64px;height:64px;border-radius:50%;display:grid;place-items:center;background:conic-gradient(${ls.score >= 500 ? COLORS.green : COLORS.red} ${ls.score * 0.36}deg, rgba(255,255,255,.08) 0)"><div style="width:50px;height:50px;border-radius:50%;background:#0b0e1a;display:grid;place-items:center" class="mono"><b>${ls.score}</b></div></div><div class="sm"><b>City score</b> vs Fixed Timer<br><span class="${ls.i.avgWait >= 0 ? 'good' : 'bad'}">waiting ${ls.i.avgWait >= 0 ? '-' : '+'}${Math.abs(ls.i.avgWait).toFixed(0)}%</span> &middot; <span class="${ls.i.pedWait >= 0 ? 'good' : 'bad'}">pedestrians ${ls.i.pedWait >= 0 ? '-' : '+'}${Math.abs(ls.i.pedWait).toFixed(0)}%</span><div class="xs muted">500 = parity. A hidden Fixed Timer city runs the same traffic.</div></div></div>` : `<div class="xs muted" style="margin:8px 0">${world.kind === 'fixed' ? 'Fixed Timer is the baseline.' : world.ghostValid ? 'Collecting data for the live score (90 s)...' : 'Live score paused: an injected event means the baseline traffic no longer matches.'}</div>`;
      el.innerHTML = `<div class="card-h"><h2>AI controller</h2><span class="chip on">${dot}${CONTROLLER_LABELS[kind]}</span></div>${net}${scoreHtml}
        <div class="sm" style="margin-top:6px">Genome source: <b>${kind === 'evolved' ? evolvedSource() : kind === 'adaptive' ? 'hand-wired seed' : 'n/a'}</b></div>${dec}
        <div class="sm muted" style="margin-top:8px">Selected J${n.id + 1}: <b style="color:var(--text)">${PHASES[n.sig.phase].name}</b> ${n.sig.state}${n.sig.pending >= 0 ? ' &rarr; ' + PHASES[n.sig.pending].name : ''} &middot; ${n.sig.switches} phase changes</div>`;
    },
    renderSafety() {
      const s = world.sim; let violMin = 0;
      const rows = [
        ['Minimum green', `${SAFETY.minGreen[0]} s through / ${SAFETY.minGreen[1]} s left`],
        ['Amber transition', `${SAFETY.amber} s`],
        ['All-red clearance', `${SAFETY.allRed} s`],
        ['Pedestrian clearance', `up to ${SAFETY.pedClearMax} s after last WALK`],
        ['Max green / starvation', `${SAFETY.maxGreen[0]} s / ${SAFETY.starve} s`],
      ];
      $('#c-safe', root).innerHTML = rows.map((r) => `<div class="row" style="justify-content:space-between;padding:3px 0;border-bottom:1px solid rgba(255,255,255,.04)"><span class="sm">${r[0]}</span><span class="row tight"><span class="mono sm">${r[1]}</span><span class="badge cyan">enforced</span></span></div>`).join('');
      void violMin; void s;
    },
    renderFeed() {
      $('#c-feed', root).innerHTML = world.feed.slice(0, 14).map((f) => `<div style="padding:3px 0;border-bottom:1px solid rgba(255,255,255,.04)"><span class="mono dim xs">${Math.floor(f.t / 60)}:${String(Math.floor(f.t % 60)).padStart(2, '0')}</span> <span class="${f.kind === 'bad' ? 'bad' : f.kind === 'good' ? 'good' : f.kind === 'warn' ? 'warn' : ''}">${f.text}</span></div>`).join('') || '<span class="muted">No events yet.</span>';
    },
    renderHeadline() {
      const el = $('#c-headline', root), b = data.benchmarks;
      if (!b) { el.innerHTML = '<h2>Measured results</h2><p class="muted">Benchmark file not found. Run <code>node tools/benchmark.mjs</code> or open Analytics to run it in the browser.</p>'; return; }
      const mk = (key) => METRICS.find((m) => m.key === key);
      const o = b.overall, cells = ['avgWait', 'pedWait', 'emergDelay', 'signalEfficiency'].map((k) => {
        const m = mk(k), a = improvement(o.fixed[k], o.adaptive[k], m), e = improvement(o.fixed[k], o.evolved[k], m);
        const cl = (v) => (v >= 0 ? 'good' : 'bad');
        return `<div class="card kpi" style="background:var(--panel2)"><div class="lab">${m.label}</div>
          <div class="sm" style="margin-top:6px">Fixed <b class="mono">${fmt(o.fixed[k], m.fmt)}</b>${m.unit}</div>
          <div class="sm">Adaptive <b class="mono">${fmt(o.adaptive[k], m.fmt)}</b> <span class="${cl(a)}">${a >= 0 ? '-' : '+'}${Math.abs(a).toFixed(0)}%</span></div>
          <div class="sm">Evolved <b class="mono">${fmt(o.evolved[k], m.fmt)}</b> <span class="${cl(e)}">${e >= 0 ? '-' : '+'}${Math.abs(e).toFixed(0)}%</span></div></div>`;
      }).join('');
      el.innerHTML = `<div class="card-h"><h2>Measured results</h2><span class="sub">${b.seeds.length} held-out seeds x ${Object.keys(b.scenarios).length} scenarios, identical demand for every controller &middot; <b>simulated</b></span></div><div class="grid cols-4">${cells}</div>
        <div class="row" style="margin-top:10px"><button class="btn primary" id="c-to-an">Open full analytics</button><button class="btn" id="c-to-lab">Evolve your own agent</button></div>`;
      $('#c-to-an', el).onclick = () => ctx.nav('analytics'); $('#c-to-lab', el).onclick = () => ctx.nav('lab');
    },
  };
  return api;
}

function $$mode(root, kind) {
  root.querySelectorAll('#c-mode button').forEach((b) => b.classList.toggle('on', b.dataset.k === kind));
}
void legend;
