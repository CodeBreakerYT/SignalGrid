// App shell: navigation, shared world, main animation loop.
import { $, h, icon, toast } from './util.js';
import { store, loadData, levelInfo, data } from './store.js';
import { World } from './world.js';
import { createLive } from './views/live.js';
import { createLab } from './views/lab.js';
import { createVision, detectBackend } from './views/vision.js';
import { createAnalytics } from './views/analytics.js';

await loadData();
const world = new World();
world.runner.speed = 2;

const ctx = {
  world, store,
  nav: (id) => go(id),
  refresh: () => views.forEach((v) => v.refresh && v.refresh()),
  updateXp,
  setBackend(info) {
    const chip = $('#backendchip');
    chip.className = 'chip ' + (info ? 'on' : 'off');
    chip.querySelector('span').textContent = info ? `Vision: ${info.backend.toUpperCase()}` : 'Vision backend offline';
    chip.title = info ? `${info.weights} on ${info.device}` : 'Run: python -m backend';
  },
};

const views = [createLive(ctx), createLab(ctx), createVision(ctx), createAnalytics(ctx)];
const ICONS = { command: 'command', live: 'sim', lab: 'lab', vision: 'vision', analytics: 'chart', missions: 'flag' };
const LABELS = { command: 'Command Center', live: 'Simulation', lab: 'Training Lab', vision: 'Vision Monitor', analytics: 'Results', missions: 'Missions' };
const nav = $('#navlinks');
for (const v of views) {
  $('#views').append(v.root);
  nav.append(h('button', { class: 'navbtn', 'data-v': v.id, onclick: () => go(v.id), html: icon(ICONS[v.id]) + `<span>${LABELS[v.id]}</span>` }));
}

let active = null;
function go(id) {
  const v = views.find((x) => x.id === id) || views[0];
  id = v.id;
  if (active && active.hide) active.hide();
  active = v;
  views.forEach((x) => x.root.classList.toggle('active', x === v));
  nav.querySelectorAll('.navbtn').forEach((b) => b.classList.toggle('active', b.dataset.v === v.id));
  $('#viewtitle').textContent = LABELS[v.id];
  $('#nav').classList.remove('open');
  if (location.hash !== '#' + id) history.replaceState(null, '', '#' + id);
  v.show && v.show();
  $('#views').scrollTop = 0;
}
$('#navtoggle').onclick = () => $('#nav').classList.toggle('open');
window.addEventListener('hashchange', () => go(location.hash.slice(1) || 'live'));

function updateXp() {
  const st = store.get(), li = levelInfo(st.xp);
  $('#xpcard').innerHTML = `<div class="row" style="justify-content:space-between"><b>Level ${li.level}</b><span class="mono xs muted">${st.xp} XP</span></div><div class="pbar" style="margin-top:6px"><i style="width:${li.frac * 100}%"></i></div>`;
  $('#topinfo').innerHTML = `<span class="badge sim">simulated</span>`;
}
updateXp();
detectBackend(store.get().backendUrl).then((i) => ctx.setBackend(i));

let prev = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - prev) / 1000); prev = now;
  try {
    const frac = world.tick(dt);
    if (active && !document.hidden) active.tick(dt, frac);
  } catch (e) { console.error('frame error', e); }
  requestAnimationFrame(frame);
}
// optional deep-link parameters (used for screenshots / demos): ?scenario=rush&kind=evolved&warm=150#live
const q = new URLSearchParams(location.search);
if (q.get('scenario')) world.setScenario(q.get('scenario'));
if (q.get('kind')) world.setKind(q.get('kind'));
if (+q.get('seed')) world.build(world.scenarioId, world.kind, +q.get('seed'));
if (+q.get('warm')) { world.sim.run(+q.get('warm')); world.ghost.run(+q.get('warm')); world.consume(); }
go(location.hash.slice(1) || 'live');
requestAnimationFrame(frame);
window.signalgrid = { world, go, store, views, step: (dt = 0.1) => { world.tick(dt); active.tick(dt, 0); } }; // handy for debugging in the console
void toast;
