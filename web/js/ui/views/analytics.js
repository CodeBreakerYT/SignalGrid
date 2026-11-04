// E. Analytics: Fixed Timer vs Adaptive AI vs Evolved AI, from the shipped benchmark or re-run live in the browser.
import { h, $, fmt, toast, COLORS, CTRL_COLORS } from '../util.js';
import { groupBars, lineChart, legend } from '../charts.js';
import { METRICS, compare, improvement, runOne } from '../../core/bench.js';
import { SCENARIOS, SCENARIO_ORDER } from '../../core/scenarios.js';
import { CONTROLLER_LABELS } from '../../core/controllers.js';
import { data, evolvedGenome, evolvedSource } from '../store.js';

const KINDS = ['fixed', 'adaptive', 'evolved'];

export function createAnalytics(ctx) {
  const root = h('section', { class: 'view', id: 'view-analytics' });
  root.innerHTML = `
  <div class="card">
    <div class="card-h"><h2>Controller comparison</h2><div class="row tight"><span class="chip" id="a-src"></span><span class="badge sim">simulated</span></div></div>
    <div class="row">
      <label class="fld" style="flex-direction:row;align-items:center;gap:8px">Seeds per scenario <select id="a-seeds"><option>3</option><option selected>5</option><option>8</option></select></label>
      <button class="btn primary" id="a-run">Re-run benchmark in browser</button>
      <button class="btn" id="a-shipped">Show shipped results</button>
      <div class="spacer"></div>
      <button class="btn sm" id="a-json">Download JSON</button><button class="btn sm" id="a-csv">Download CSV</button>
    </div>
    <div class="pbar hidden" id="a-pbar" style="margin-top:10px"><i id="a-prog" style="width:0"></i></div>
    <div class="xs muted" id="a-note" style="margin-top:8px"></div>
  </div>
  <div class="grid cols-4" id="a-cards" style="margin-top:14px"></div>
  <div class="grid cols-2" style="margin-top:14px">
    <div class="card"><div class="card-h"><h2 id="a-t1">Average waiting time</h2><select id="a-metric"></select></div><canvas class="chart lg" id="a-ch1" style="height:340px"></canvas><div id="a-leg"></div></div>
    <div class="card"><div class="card-h"><h2>Time series</h2><div class="row tight"><select id="a-scn"></select><button class="btn sm" id="a-ts">Run</button></div></div>
      <canvas class="chart" id="a-ts1" style="height:150px"></canvas><canvas class="chart" id="a-ts2" style="height:150px;margin-top:6px"></canvas><div id="a-leg2"></div>
      <div class="xs muted" id="a-ts-note"></div></div>
  </div>
  <div class="card" style="margin-top:14px"><div class="card-h"><h2>Detailed results</h2><select id="a-scn2"></select></div><div class="scroll-x" id="a-table"></div></div>`;

  let result = null, sourceLabel = '';
  const scn2 = $('#a-scn2', root), scnTs = $('#a-scn', root), metricSel = $('#a-metric', root);
  for (const el of [scn2, scnTs]) SCENARIO_ORDER.forEach((id) => el.append(h('option', { value: id }, SCENARIOS[id].name)));
  scn2.value = 'rush'; scnTs.value = 'rush';
  METRICS.forEach((m) => metricSel.append(h('option', { value: m.key }, m.label)));
  metricSel.onchange = scn2.onchange = () => render();

  function setResult(r, label) { result = r; sourceLabel = label; render(); }

  function render() {
    if (!result) { $('#a-note', root).textContent = 'No benchmark data. Click "Re-run benchmark in browser".'; return; }
    const meta = result.meta;
    $('#a-src', root).textContent = sourceLabel;
    $('#a-note', root).textContent = `${result.seeds.length} seeds (${result.seeds[0]}..${result.seeds[result.seeds.length - 1]}) x ${Object.keys(result.scenarios).length} scenarios x ${result.kinds.length} controllers. Evolved AI genome: ${sourceLabel.includes('browser') ? evolvedSource() : 'shipped champion'}${meta?.generatedAt ? ' · generated ' + meta.generatedAt.slice(0, 10) : ''}.`;
    const o = result.overall;
    $('#a-cards', root).innerHTML = ['avgWait', 'pedWait', 'emergDelay', 'throughput'].map((k) => {
      const m = METRICS.find((x) => x.key === k);
      const line = (kind) => { const v = improvement(o.fixed[k], o[kind][k], m); return `<div class="row" style="justify-content:space-between"><span class="sm" style="color:${CTRL_COLORS[kind]}">${CONTROLLER_LABELS[kind]}</span><span><b class="mono">${fmt(o[kind][k], m.fmt)}</b><small class="muted"> ${m.unit}</small> ${kind === 'fixed' ? '' : `<span class="${v >= 0 ? 'good' : 'bad'} mono sm">${v >= 0 ? '↓' : '↑'}${Math.abs(v).toFixed(0)}%</span>`.replace(m.lower ? '' : '↓', m.lower ? '' : '↑')}</span></div>`; };
      return `<div class="card kpi"><div class="lab">${m.label}</div><div class="stack" style="gap:3px;margin-top:6px">${KINDS.map(line).join('')}</div><div class="xs muted" style="margin-top:6px">mean over scenarios</div></div>`;
    }).join('');
    // main grouped bars
    const mk = METRICS.find((m) => m.key === metricSel.value) || METRICS[0];
    $('#a-t1', root).textContent = mk.label + (mk.lower ? ' (lower is better)' : ' (higher is better)');
    const rows = SCENARIO_ORDER.filter((id) => result.scenarios[id]).map((id) => ({
      label: SCENARIOS[id].name,
      values: KINDS.map((k) => ({ v: result.scenarios[id].controllers[k][mk.key].mean, color: CTRL_COLORS[k], text: fmt(result.scenarios[id].controllers[k][mk.key].mean, mk.fmt) })),
    }));
    rows.push({ label: 'Overall (mean)', values: KINDS.map((k) => ({ v: o[k][mk.key], color: CTRL_COLORS[k], text: fmt(o[k][mk.key], mk.fmt) })) });
    groupBars($('#a-ch1', root), rows);
    $('#a-leg', root).innerHTML = legend(KINDS.map((k) => ({ name: CONTROLLER_LABELS[k], color: CTRL_COLORS[k] })));
    // table
    const sc = result.scenarios[scn2.value]; if (!sc) return;
    const kinds = result.kinds;
    $('#a-table', root).innerHTML = `<table class="t"><thead><tr><th>${SCENARIOS[scn2.value].name}</th>${kinds.map((k) => `<th style="color:${CTRL_COLORS[k]}">${k === 'expert' ? 'Hand-wired expert (ref.)' : CONTROLLER_LABELS[k]}</th>`).join('')}<th>Evolved vs Fixed</th></tr></thead><tbody>${METRICS.map((m) => {
      const cells = kinds.filter((k) => k !== 'expert').map((k) => sc.controllers[k][m.key].mean);
      const best = m.lower ? Math.min(...cells) : Math.max(...cells);
      const imp = improvement(sc.controllers.fixed[m.key].mean, sc.controllers.evolved[m.key].mean, m);
      return `<tr><td>${m.label} <span class="dim">(${m.unit})</span></td>${kinds.map((k) => { const c = sc.controllers[k][m.key]; const isBest = k !== 'expert' && Math.abs(c.mean - best) < 1e-9 && cells.filter((x) => Math.abs(x - best) < 1e-9).length === 1; return `<td class="${isBest ? 'best' : ''}" style="${k === 'expert' ? 'opacity:.55' : ''}">${fmt(c.mean, m.fmt)} <span class="dim xs">±${fmt(c.std, m.fmt)}</span></td>`; }).join('')}<td class="${imp >= 0 ? 'good' : 'bad'}">${isFinite(imp) && sc.controllers.fixed[m.key].mean ? (imp >= 0 ? '+' : '') + imp.toFixed(1) + '%' : '-'}</td></tr>`;
    }).join('')}</tbody></table>`;
  }

  $('#a-run', root).onclick = async () => {
    const g = evolvedGenome();
    if (!g) return toast('No evolved genome available.', 'err');
    const n = +$('#a-seeds', root).value, seeds = Array.from({ length: n }, (_, i) => 1001 + i);
    const bar = $('#a-pbar', root), prog = $('#a-prog', root); bar.classList.remove('hidden');
    $('#a-run', root).disabled = true;
    try {
      const r = await compare({ seeds, evolved: g, kinds: KINDS, onProgress: (f) => { prog.style.width = (f * 100).toFixed(0) + '%'; }, yieldFn: () => new Promise((res) => setTimeout(res, 0)) });
      r.meta = { generatedAt: new Date().toISOString() };
      setResult(r, 'live browser run');
      toast('Benchmark finished.', 'good');
    } catch (e) { console.error(e); toast('Benchmark failed: ' + e.message, 'err'); }
    bar.classList.add('hidden'); $('#a-run', root).disabled = false;
  };
  $('#a-shipped', root).onclick = () => { if (data.benchmarks) setResult(data.benchmarks, 'shipped benchmark (Node)'); else toast('benchmarks.json not found.', 'err'); };

  const download = (name, text, type) => { const a = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name }); document.body.append(a); a.click(); a.remove(); };
  $('#a-json', root).onclick = () => result && download('signalgrid-benchmark.json', JSON.stringify(result, null, 1), 'application/json');
  $('#a-csv', root).onclick = () => {
    if (!result) return;
    const lines = ['scenario,controller,metric,mean,std'];
    for (const [id, row] of Object.entries(result.scenarios)) for (const [k, c] of Object.entries(row.controllers)) for (const m of METRICS) lines.push(`${id},${k},${m.key},${c[m.key].mean.toFixed(4)},${c[m.key].std.toFixed(4)}`);
    download('signalgrid-benchmark.csv', lines.join('\n'), 'text/csv');
  };

  $('#a-ts', root).onclick = async () => {
    const id = scnTs.value, g = evolvedGenome();
    $('#a-ts', root).disabled = true; $('#a-ts-note', root).textContent = 'Simulating...';
    await new Promise((r) => setTimeout(r, 20));
    const series = {};
    for (const k of KINDS) series[k] = runOne(id, 1001, k, g).series;
    const mkS = (key) => KINDS.map((k) => ({ name: CONTROLLER_LABELS[k], color: CTRL_COLORS[k], data: series[k].map((p) => [p.t, p[key]]) }));
    lineChart($('#a-ts1', root), { series: mkS('queue'), yLabel: 'queue (veh)' });
    lineChart($('#a-ts2', root), { series: mkS('wait'), xLabel: 'simulated seconds', yLabel: 'avg wait (s)' });
    $('#a-leg2', root).innerHTML = legend(mkS('queue'));
    $('#a-ts-note', root).textContent = `${SCENARIOS[id].name}, seed 1001: the same traffic under each controller.`;
    $('#a-ts', root).disabled = false;
  };

  return {
    id: 'analytics', title: 'Analytics', root,
    show() { if (!result && data.benchmarks) setResult(data.benchmarks, 'shipped benchmark (Node)'); else render(); },
    hide() {}, refresh() {}, tick() {},
  };
}
