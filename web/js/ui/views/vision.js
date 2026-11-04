// D. Vision Monitor: simulated sensor, uploaded video, or live camera -> detections -> lane counts ->
// congestion -> neural signal recommendation. Real detection runs in the Python backend (YOLOv8 / OpenCV).
import { h, $, fmt, toast, COLORS } from '../util.js';
import { SimView } from '../render.js';
import { NeuralController, priorGenome } from '../../core/controllers.js';
import { OBS, PHASES, SAFETY } from '../../core/sim.js';
import { evolvedGenome } from '../store.js';
import { award } from '../achievements.js';

const ZONES = ['W', 'N', 'E', 'S']; // image side -> approach; W->eastbound(0) N->southbound(1) E->westbound(2) S->northbound(3)
const CLS_COL = { car: '#00f3ff', truck: '#ffb020', bus: '#ff2bd6', motorcycle: '#31ff9a', person: '#ffe66d' };
const sid = Math.random().toString(36).slice(2, 10);

let backendBase = null;
export async function detectBackend(extra) {
  const cands = ['', extra, 'http://127.0.0.1:8765'].filter((x, i, a) => x != null && a.indexOf(x) === i);
  for (const base of cands) {
    try {
      const r = await fetch(base + '/api/health', { signal: AbortSignal.timeout(1500) });
      if (r.ok) { const j = await r.json(); if (j.ok) { backendBase = base; return j; } }
    } catch { /* try next */ }
  }
  backendBase = null;
  return null;
}

export function createVision(ctx) {
  const { world } = ctx;
  const root = h('section', { class: 'view', id: 'view-vision' });
  root.innerHTML = `
  <div class="split">
    <div class="stack">
      <div class="card">
        <div class="card-h"><h2>Camera feed</h2><div class="seg" id="v-mode"><button data-m="sim" class="on">Simulated</button><button data-m="video">Uploaded video</button><button data-m="cam">Live camera</button><button data-m="carla">CARLA</button></div></div>
        <div class="stage stage-lg"><canvas id="v-canvas"></canvas><div class="hud"><span class="chip" id="v-c1"></span><span class="chip" id="v-c2"></span></div></div>
        <div id="v-controls" class="row" style="margin-top:10px"></div>
        <div class="callout" id="v-note" style="margin-top:10px"></div>
      </div>
      <details class="card"><summary style="cursor:pointer;color:var(--cyan);letter-spacing:.1em;text-transform:uppercase;font-size:13px">Advanced: approach zones</summary><div style="margin-top:10px">
        <div class="grid cols-3"><label class="fld">Junction centre X<input type="range" id="v-cx" min="25" max="75" value="50"></label><label class="fld">Junction centre Y<input type="range" id="v-cy" min="25" max="75" value="50"></label><label class="fld">Ignore radius<input type="range" id="v-r" min="0" max="30" value="8"></label></div></div>
    </div>
    <div class="stack">
      <div class="card" id="v-counts"></div>
      <div class="card" id="v-lanes"></div>
      <div class="card" id="v-ai"></div>
    </div>
  </div>`;

  const canvas = $('#v-canvas', root), simView = new SimView(canvas, { interactive: false });
  const vid = h('video', { playsinline: true, loop: true });
  vid.muted = true;
  const carlaCv = document.createElement('canvas'); let carlaLive = false, carlaState = null, carlaBusy = false;
  const srcW = () => (mode === 'carla' ? carlaCv.width : vid.videoWidth), srcH = () => (mode === 'carla' ? carlaCv.height : vid.videoHeight), srcEl = () => (mode === 'carla' ? carlaCv : vid);
  let mode = new URLSearchParams(location.search).get('mode') || 'sim', health = null, stream = null, objUrl = null;
  let last = null, busy = false, lastSend = 0, fpsEst = 0, agentKind = 'evolved';
  const zonesHist = [], stoppedSince = new Map();
  const agent = { ctrl: null, phase: 0, since: 0, kind: '' };
  let lastRec = null, acc = 0, accidentUntil = 0;
  const conf = { v: 0.3, people: true, fps: 5 };

  const modeBtns = $('#v-mode', root).querySelectorAll('button');
  modeBtns.forEach((b) => { b.onclick = () => setMode(b.dataset.m); });
  for (const id of ['v-cx', 'v-cy', 'v-r']) $('#' + id, root).oninput = () => {};

  async function refreshHealth() {
    health = await detectBackend(ctx.store.get().backendUrl);
    ctx.setBackend(health);
    return health;
  }

  function stopMedia() {
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    vid.pause(); vid.removeAttribute('src'); vid.srcObject = null;
    if (objUrl) { URL.revokeObjectURL(objUrl); objUrl = null; }
    last = null; zonesHist.length = 0; stoppedSince.clear();
    fetch((backendBase || '') + '/api/reset?session=' + sid, { method: 'POST' }).catch(() => {});
  }

  function setMode(m) {
    stopMedia(); mode = m;
    modeBtns.forEach((b) => b.classList.toggle('on', b.dataset.m === m));
    const c = $('#v-controls', root); c.replaceChildren();
    const note = $('#v-note', root);
    if (m === 'sim') {
      simView.setSim(world.sim);
      note.className = 'callout'; note.innerHTML = '<b>Simulated camera</b> (ground truth). Use Uploaded video for YOLO.';
    } else {
      note.className = 'callout warn';
      note.innerHTML = health ? `<b>${health.backend.toUpperCase()}</b> detection running locally.` : '<b>Backend offline.</b> Run <code>python -m backend</code>.';
      if (m === 'carla') {
        note.className = 'callout'; note.innerHTML = health ? '<b>CARLA feed.</b> Start it with <code>scripts/run_carla_demo.ps1</code>.' : '<b>Backend offline.</b> Run <code>python -m backend</code>.';
      } else if (m === 'video') {
        const file = h('input', { type: 'file', accept: 'video/*', class: 'hidden', onchange: (e) => loadFile(e.target.files[0]) });
        const drop = h('div', { class: 'drop', style: 'flex:1', onclick: () => file.click() }, 'Drop a traffic video here or click to choose (MP4 / WebM). Static camera works best.');
        drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); }; drop.ondragleave = () => drop.classList.remove('over');
        drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); loadFile(e.dataTransfer.files[0]); };
        c.append(drop, file, h('button', { class: 'btn', id: 'v-pp', onclick: () => (vid.paused ? vid.play() : vid.pause()) }, 'Play / Pause'), h('input', { type: 'range', id: 'v-seek', min: 0, max: 1000, value: 0, style: 'flex:1;min-width:120px', oninput: (e) => { if (vid.duration) vid.currentTime = (e.target.value / 1000) * vid.duration; } }));
      } else {
        c.append(h('button', { class: 'btn primary', onclick: startCam }, 'Start camera'), h('button', { class: 'btn', onclick: () => setMode('cam') }, 'Stop'));
      }
      c.append(h('label', { class: 'fld', style: 'flex-direction:row;align-items:center;gap:6px' }, 'Confidence', h('input', { type: 'range', min: 10, max: 80, value: 30, style: 'width:90px', oninput: (e) => { conf.v = e.target.value / 100; } })),
        h('label', { class: 'fld', style: 'flex-direction:row;align-items:center;gap:6px' }, 'Pedestrians', h('input', { type: 'checkbox', checked: true, onchange: (e) => { conf.people = e.target.checked; } })));
    }
  }

  function loadFile(f) {
    if (!f) return;
    if (!health) return toast('Start the Python backend first (python -m backend).', 'err');
    stopMedia(); objUrl = URL.createObjectURL(f); vid.src = objUrl;
    vid.onloadeddata = () => { vid.play().catch(() => toast('Press Play / Pause to start the video.')); toast(`Loaded ${f.name}`, 'good'); };
    vid.onerror = () => toast('The browser cannot play this video format. Try MP4 (H.264) or WebM.', 'err');
  }
  async function startCam() {
    if (!health) return toast('Start the Python backend first (python -m backend).', 'err');
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 } });
      vid.srcObject = stream; await vid.play();
    } catch (e) { toast('Camera unavailable: ' + (e.message || e.name), 'err'); }
  }

  // ---------------------------------------------------------------- analysis
  const grab = document.createElement('canvas');
  async function pullCarla() {
    if (carlaBusy || !backendBase && backendBase !== '') return;
    carlaBusy = true;
    try {
      const r = await fetch(backendBase + '/api/carla/frame.jpg?' + Date.now());
      if (r.ok) { const bmp = await createImageBitmap(await r.blob()); carlaCv.width = bmp.width; carlaCv.height = bmp.height; carlaCv.getContext('2d').drawImage(bmp, 0, 0); carlaLive = true; }
      else carlaLive = false;
      const st = await (await fetch(backendBase + '/api/carla/state')).json(); carlaState = st.live ? st.state : null;
    } catch { carlaLive = false; }
    carlaBusy = false;
  }

  async function sendFrame() {
    if (busy || !health || !srcW() || (mode !== 'carla' && vid.paused)) return;
    const now = performance.now();
    if (now - lastSend < 1000 / conf.fps) return;
    busy = true; const dt = now - lastSend; lastSend = now;
    try {
      const sc = Math.min(1, 960 / srcW()); grab.width = Math.round(srcW() * sc); grab.height = Math.round(srcH() * sc);
      grab.getContext('2d').drawImage(srcEl(), 0, 0, grab.width, grab.height);
      const blob = await new Promise((r) => grab.toBlob(r, 'image/jpeg', 0.75));
      const t = mode === 'video' ? vid.currentTime : now / 1000;
      const res = await fetch(`${backendBase}/api/analyze?session=${sid}&t=${t.toFixed(3)}&conf=${conf.v}&people=${conf.people ? 1 : 0}`, { method: 'POST', body: blob });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.status);
      const j = await res.json(); j.sx = grab.width / j.w;
      if (j.detections.length >= 8) award('eye');
      last = j; fpsEst = 0.8 * fpsEst + 0.2 * (1000 / Math.max(dt, 1));
      const nowS = performance.now() / 1000;
      for (const d of j.detections) { if (d.stopped) { if (!stoppedSince.has(d.id)) stoppedSince.set(d.id, nowS); } else stoppedSince.delete(d.id); }
      if (j.accident) accidentUntil = nowS + 4;
    } catch (e) { if (!String(e).includes('Abort')) { toast('Vision backend error: ' + e.message, 'err'); health = null; ctx.setBackend(null); } }
    busy = false;
  }

  /** zone index 0..3 for a point (fractions of image), or -1 inside the ignore radius. */
  function zoneOf(fx, fy) {
    const cx = $('#v-cx', root).value / 100, cy = $('#v-cy', root).value / 100, r = $('#v-r', root).value / 100;
    const dx = fx - cx, dy = fy - cy;
    if (Math.hypot(dx, dy) < r) return -1;
    return Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 0 : 2) : (dy < 0 ? 1 : 3);
  }

  function measure() {
    const z = ZONES.map(() => ({ n: 0, queue: 0, wait: 0, ped: 0, veh: 0 }));
    const nowS = performance.now() / 1000;
    let cam = null;
    if (mode === 'sim') {
      const s = world.sim;
      for (const link of s.links) { const zz = z[[0, 1, 2, 3].map((h) => h)[link.h]]; for (const arr of link.lanes) for (const v of arr) { if (v.crashed || v.state !== 'link') continue; zz.n++; zz.veh++; if (v.v < 1) { zz.queue++; zz.wait = Math.max(zz.wait, v.stopT); } } }
      // sim headings: 0 eastbound approaches from the W side of the image
      z.forEach((q, i) => { const n = s.nodes.length; q.n = Math.round(q.n / n); q.veh = q.n; q.queue = Math.round(q.queue / n); void i; });
      for (const nd of s.nodes) for (let c = 0; c < 4; c++) z[c].ped += nd.pedQ[c].length / s.nodes.length + nd.pedCross[c].length / s.nodes.length;
      cam = { w: 1, h: 1 };
    } else if (last) {
      for (const d of last.detections) {
        const fx = (d.box[0] + d.box[2]) / 2 / last.w, fy = (d.box[1] + d.box[3]) / 2 / last.h, zi = zoneOf(fx, fy);
        if (zi < 0) continue;
        if (d.cls === 'person') { z[zi].ped++; continue; }
        z[zi].n++; z[zi].veh++;
        if (d.stopped) { z[zi].queue++; z[zi].wait = Math.max(z[zi].wait, nowS - (stoppedSince.get(d.id) ?? nowS)); }
      }
    }
    return { z, cam };
  }

  function observation(z) {
    const o = new Float32Array(OBS.size);
    // phase p serves lanes: 0 EW-thru (zones W,E), 1 EW-left, 2 NS-thru (zones N,S), 3 NS-left
    const sets = [[0, 2], [0, 2], [1, 3], [1, 3]], pedSets = [[1, 3], [], [0, 2], []];
    for (let p = 0; p < 4; p++) {
      const left = p % 2 === 1, share = left ? 0.15 : 0.85; // single camera cannot see lanes: assumed 85/15 split
      let q = 0, n = 0, w = 0, ped = 0;
      for (const zi of sets[p]) { q += z[zi].queue * share; n += z[zi].n * share; w = Math.max(w, z[zi].wait); }
      for (const zi of pedSets[p]) ped += z[zi].ped;
      const b = p * OBS.perPhase;
      o[b] = Math.min(1, q / 14); o[b + 1] = Math.min(1, n / 18); o[b + 2] = Math.min(1, w / 60); o[b + 3] = Math.min(1, ped / 8);
    }
    o[32 + agent.phase] = 1; o[36] = Math.min(1, agent.since / 60);
    o[37] = Math.min(1, z.reduce((a, q) => a + q.n, 0) / 60);
    return o;
  }

  function recommend(z) {
    const kind = agentKind;
    if (!agent.ctrl || agent.kind !== kind) { agent.ctrl = new NeuralController(kind === 'evolved' ? evolvedGenome() || priorGenome() : priorGenome()); agent.kind = kind; agent.phase = 0; agent.since = 0; }
    agent.since += 1;
    const obs = observation(z);
    const want = agent.ctrl.decideFromObs(obs, agent.phase, agent.since);
    if (want !== agent.phase && agent.since >= SAFETY.minGreen[agent.phase]) { agent.phase = want; agent.since = 0; }
    lastRec = { out: Array.from(agent.ctrl.lastOut), target: agent.ctrl.target };
  }

  // ---------------------------------------------------------------- drawing + panels
  /** Detection styling after the reference monitor: class-coloured box, corner brackets, filled tag with confidence. */
  function drawOverlay(c2, w, hh, ox, oy, sw, sh, boxes) {
    c2.font = '600 11px "Cascadia Mono", monospace';
    for (const b of boxes) {
      const col = CLS_COL[b.cls] || '#fff', x = ox + b.x * sw, y = oy + b.y * sh, bw = b.w * sw, bh = b.h * sh, tk = Math.max(6, Math.min(14, bw * 0.25));
      c2.strokeStyle = col; c2.lineWidth = 1.5; c2.globalAlpha = 0.55; c2.strokeRect(x, y, bw, bh); c2.globalAlpha = 1;
      c2.lineWidth = 3; c2.shadowColor = col; c2.shadowBlur = 8; c2.beginPath();
      for (const [cx2, cy2, dx, dy] of [[x, y, 1, 1], [x + bw, y, -1, 1], [x, y + bh, 1, -1], [x + bw, y + bh, -1, -1]]) { c2.moveTo(cx2 + dx * tk, cy2); c2.lineTo(cx2, cy2); c2.lineTo(cx2, cy2 + dy * tk); }
      c2.stroke(); c2.shadowBlur = 0;
      const tw = c2.measureText(b.tag).width + 8;
      c2.fillStyle = col; c2.fillRect(x, y - 15, tw, 15); c2.fillStyle = '#0a0612'; c2.fillText(b.tag, x + 4, y - 4);
      if (b.stopped) { c2.strokeStyle = '#ff3b5c'; c2.lineWidth = 1.2; c2.setLineDash([3, 3]); c2.strokeRect(x - 3, y - 3, bw + 6, bh + 6); c2.setLineDash([]); c2.fillStyle = '#ff3b5c'; c2.fillRect(x, y + bh, 44, 12); c2.fillStyle = '#fff'; c2.fillText('QUEUE', x + 3, y + bh + 10); }
    }
    void w; void hh;
  }

  function draw(frac) {
    if (mode === 'sim') {
      if (simView.sim !== world.sim) simView.setSim(world.sim);
      simView.draw(frac);
      if (!simView.cam) return;
      const c2 = canvas.getContext('2d');
      const boxes = [];
      const s = world.sim;
      for (const link of s.links) for (const arr of link.lanes) for (const v of arr) {
        if (v.state !== 'link' || v.s > 80) continue;
        const [px, py] = simView.toScreen(link.node.cx - [1, 0, -1, 0][link.h] * (7 + v.s) + 0, link.node.cy - [0, 1, 0, -1][link.h] * (7 + v.s));
        const sz = Math.max(10, v.len * simView.cam.scale * 1.1);
        boxes.push({ x: px - sz / 2, y: py - sz / 2, w: sz, h: sz, cls: v.emerg ? 'bus' : v.type === 'truck' ? 'truck' : v.type === 'bus' ? 'bus' : 'car', tag: v.emerg ? 'ambulance' : v.type, stopped: v.v < 1 });
      }
      drawOverlay(c2, 0, 0, 0, 0, 1, 1, boxes.slice(0, 120));
      return;
    }
    const w = canvas.clientWidth, hh = canvas.clientHeight, dpr = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(hh * dpr); }
    const c2 = canvas.getContext('2d'); c2.setTransform(dpr, 0, 0, dpr, 0, 0);
    c2.fillStyle = '#05060d'; c2.fillRect(0, 0, w, hh);
    if (!srcW()) { c2.fillStyle = '#566089'; c2.font = '14px sans-serif'; c2.textAlign = 'center'; c2.fillText(mode === 'video' ? 'Load a video to begin' : mode === 'carla' ? 'Waiting for CARLA: run python -m carla_link.bridge --camera --backend http://127.0.0.1:8765' : 'Start the camera to begin', w / 2, hh / 2); c2.textAlign = 'left'; return; }
    const sc = Math.min(w / srcW(), hh / srcH()), dw = srcW() * sc, dh = srcH() * sc, ox = (w - dw) / 2, oy = (hh - dh) / 2;
    c2.drawImage(srcEl(), ox, oy, dw, dh);
    // zones
    const cx = $('#v-cx', root).value / 100, cy = $('#v-cy', root).value / 100, r = $('#v-r', root).value / 100;
    c2.strokeStyle = 'rgba(163,91,255,.55)'; c2.setLineDash([5, 5]); c2.lineWidth = 1;
    c2.beginPath(); c2.moveTo(ox, oy); c2.lineTo(ox + cx * dw, oy + cy * dh); c2.moveTo(ox + dw, oy); c2.lineTo(ox + cx * dw, oy + cy * dh); c2.moveTo(ox, oy + dh); c2.lineTo(ox + cx * dw, oy + cy * dh); c2.moveTo(ox + dw, oy + dh); c2.lineTo(ox + cx * dw, oy + cy * dh); c2.stroke();
    c2.beginPath(); c2.arc(ox + cx * dw, oy + cy * dh, r * Math.min(dw, dh), 0, 6.3); c2.stroke(); c2.setLineDash([]);
    c2.fillStyle = 'rgba(163,91,255,.8)'; c2.font = '600 12px sans-serif';
    c2.fillText('W', ox + 8, oy + dh / 2); c2.fillText('N', ox + dw / 2, oy + 16); c2.fillText('E', ox + dw - 16, oy + dh / 2); c2.fillText('S', ox + dw / 2, oy + dh - 8);
    if (last) {
      const boxes = last.detections.map((d) => ({ x: d.box[0] / last.w, y: d.box[1] / last.h, w: (d.box[2] - d.box[0]) / last.w, h: (d.box[3] - d.box[1]) / last.h, cls: d.cls, tag: `${d.cls} ${Math.round(d.conf * 100)}% #${d.id}`, stopped: d.stopped }));
      drawOverlay(c2, w, hh, ox, oy, dw, dh, boxes);
      if (last.accident && performance.now() / 1000 < accidentUntil) {
        const [x1, y1, x2, y2] = last.accident.box; c2.strokeStyle = '#ff3b5c'; c2.lineWidth = 4; c2.strokeRect(ox + (x1 / last.w) * dw, oy + (y1 / last.h) * dh, ((x2 - x1) / last.w) * dw, ((y2 - y1) / last.h) * dh);
        c2.fillStyle = '#ff3b5c'; c2.font = '700 14px sans-serif'; c2.fillText('ACCIDENT?', ox + (x1 / last.w) * dw, oy + (y1 / last.h) * dh - 8);
      }
    }
    if (mode === 'video' && vid.duration) { const sk = $('#v-seek', root); if (sk && document.activeElement !== sk) sk.value = (vid.currentTime / vid.duration) * 1000; }
  }

  function panels() {
    const { z } = measure();
    recommend(z);
    const total = z.reduce((a, q) => a + q.n, 0), queue = z.reduce((a, q) => a + q.queue, 0), peds = z.reduce((a, q) => a + q.ped, 0);
    const cong = total ? Math.min(1, (queue / Math.max(total, 1)) * 0.6 + Math.min(1, total / 40) * 0.4) : 0;
    const lvl = cong < 0.2 ? ['Free flow', 'good'] : cong < 0.45 ? ['Moderate', 'warn'] : ['Congested', 'bad'];
    const src = mode === 'sim' ? 'simulated ground truth' : last ? `${last.backend.toUpperCase()} · ${last.ms} ms · ${fpsEst.toFixed(1)} fps` : 'waiting for frames';
    $('#v-c1', root).textContent = src;
    $('#v-c2', root).textContent = mode === 'sim' ? 'sim camera' : (health ? 'backend online' : 'backend offline');
    const cnt = mode === 'sim' ? null : last?.counts;
    $('#v-counts', root).innerHTML = `<div class="card-h"><h2>Detection counts</h2><span class="badge ${mode === 'sim' ? 'sim' : 'cyan'}">${mode === 'sim' ? 'ground truth' : 'measured'}</span></div>
      <div class="grid cols-3" style="gap:8px">${(cnt ? ['car', 'truck', 'bus', 'motorcycle', 'person'].map((k) => [k, cnt[k] || 0]) : [['vehicles', total], ['queued', queue], ['pedestrians', Math.round(peds)]]).map(([k, v]) => `<div class="kpi card" style="padding:8px 10px;background:var(--panel2)"><div class="lab">${k}</div><div class="val" style="font-size:20px">${v}</div></div>`).join('')}</div>
      <div class="row" style="margin-top:10px"><span class="chip ${lvl[1] === 'good' ? 'on' : lvl[1] === 'warn' ? 'off' : 'err'}"><i class="dot"></i>${lvl[0]} (${(cong * 100).toFixed(0)}%)</span>
      ${last?.accident && performance.now() / 1000 < accidentUntil ? '<span class="chip err"><i class="dot"></i>possible accident</span>' : '<span class="chip">no accident detected</span>'}</div>`;
    $('#v-lanes', root).innerHTML = `<div class="card-h"><h2>Lane-wise estimate</h2><span class="sub">per approach</span></div><div class="lane-bars">${z.map((q, i) => `<div class="lane" style="grid-template-columns:70px 1fr 74px"><span>${['Eastbound', 'Southbound', 'Westbound', 'Northbound'][i]}</span><div class="pbar"><i style="width:${Math.min(100, (q.n / 14) * 100)}%"></i></div><span class="mono">${Math.round(q.n)} / ${Math.round(q.queue)} q</span></div>`).join('')}</div><div class="xs muted" style="margin-top:6px">vehicles in zone / of which queued (stopped). Pedestrians waiting: ${peds.toFixed(0)}</div>`;
    const rec = lastRec;
    const cs = mode === 'carla' && carlaState ? `<div class="callout good" style="margin-bottom:8px"><b>CARLA ${carlaState.policy === 'ai' ? 'Evolved AI' : 'Fixed Timer'}</b> controlling real lights: phase ${carlaState.phase} ${carlaState.state} &middot; t=${carlaState.t}s &middot; ${carlaState.crossed} vehicles through &middot; avg wait ${carlaState.avgWait}s &middot; ${carlaState.switches} phase changes</div>` : '';
    $('#v-ai', root).innerHTML = cs + `<div class="card-h"><h2>Signal recommendation</h2><div class="seg" id="v-ak"><button data-k="adaptive" class="${agentKind === 'adaptive' ? 'on' : ''}">Adaptive</button><button data-k="evolved" class="${agentKind === 'evolved' ? 'on' : ''}">Evolved</button></div></div>
      <div class="sm">The neural agent reads the camera counts exactly like simulator sensors and proposes: <b style="color:var(--green)">${PHASES[agent.phase].name}</b> <span class="muted">(${agent.since}s)</span></div>
      ${rec ? `<div class="stack" style="gap:4px;margin-top:8px">${PHASES.map((p, i) => `<div class="lane" style="grid-template-columns:86px 1fr 40px"><span>${p.name}</span><div class="pbar"><i style="width:${Math.min(100, rec.out[i] / 2.5 * 100)}%;background:${i === agent.phase ? COLORS.green : COLORS.blue}"></i></div><span class="mono">${rec.out[i].toFixed(2)}</span></div>`).join('')}</div>` : ''}
      <div class="row" style="margin-top:10px"><button class="btn" id="v-apply">Apply measured demand to Live Simulation</button></div>`;
    $('#v-ak', root).querySelectorAll('button').forEach((b) => { b.onclick = () => { agentKind = b.dataset.k; }; });
    $('#v-apply', root).onclick = () => {
      const tot = z.reduce((a, q) => a + q.n, 0);
      if (tot < 3) return toast('Not enough vehicles in view to estimate demand.', 'err');
      const skew = z.map((q) => Math.min(2.2, Math.max(0.4, (q.n / tot) * 4)));
      world.setSkew(skew); ctx.nav('live'); toast('Live Simulation now uses the measured approach mix.', 'good');
    };
  }

  const api = {
    id: 'vision', title: 'Vision Monitor', root,
    async show() { await refreshHealth(); setMode(mode); },
    hide() { vid.pause(); },
    refresh() {},
    tick(dt, frac) {
      draw(frac);
      if (mode === 'carla') pullCarla();
      if (mode !== 'sim') sendFrame();
      acc += dt; if (acc > 1) { acc = 0; panels(); }
    },
  };
  return api;
}
