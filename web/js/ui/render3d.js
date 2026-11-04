// 3D city view (Three.js): orbit/zoom/click-to-select, instanced vehicles, glowing signal heads,
// pedestrians, neon skyline and floating queue counters. Reads the same Sim state as the 2D view.
import * as THREE from 'three';
import { OrbitControls } from '../../vendor/three/OrbitControls.js';
import { GEO, DT, poseOf } from '../core/sim.js';
import { DIRS } from '../core/scenarios.js';
import { SimView } from './render.js';

const SIGC = { green: 0x31ff9a, amber: 0xffb020, red: 0xff3b5c };
const CAR = [0x4cc9f0, 0x7b8cff, 0xb388ff, 0x3ddc97, 0x5eead4, 0x93c5fd, 0xc4b5fd, 0x67e8f9];
const MAXV = 900, MAXP = 400;
const rv = (h) => [-DIRS[h][1], DIRS[h][0]];

export class Sim3D {
  constructor(host, { onSelect } = {}) {
    this.host = host; this.onSelect = onSelect; this.selected = 0; this.sim = null; this.ok = false;
    try {
      this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    } catch { return; }
    this.ok = true;
    const r = this.renderer;
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    r.setClearColor(0x05060d); r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 1.15;
    this.canvas = r.domElement; this.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
    host.append(this.canvas);
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x05060d, 0.0016);
    this.camera = new THREE.PerspectiveCamera(48, 1, 1, 3000);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true; this.controls.dampingFactor = 0.08; this.controls.maxPolarAngle = Math.PI * 0.48; this.controls.minDistance = 25;
    this.scene.add(new THREE.HemisphereLight(0x6f8cff, 0x120a24, 0.9));
    const sun = new THREE.DirectionalLight(0xb7c8ff, 1.1); sun.position.set(-120, 200, 80); this.scene.add(sun);
    this.dyn = new THREE.Group(); this.scene.add(this.dyn);
    this.ray = new THREE.Raycaster(); this.ndc = new THREE.Vector2();
    let down = null;
    this.canvas.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
    this.canvas.addEventListener('pointerup', (e) => { if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) < 5) this.pick(e); down = null; });
    this.userMoved = false;
    this.controls.addEventListener('start', () => { this.userMoved = true; });
    this.labels = new Map(); this.tick = 0;
  }

  setSim(sim) {
    if (!this.ok) return;
    this.sim = sim;
    this.selected = Math.min(this.selected, sim.nodes.length - 1);
    this.build();
    this.preset('orbit');
  }

  preset(kind) {
    const s = this.sim, cx = ((s.nx - 1) * s.S) / 2, cz = ((s.ny - 1) * s.S) / 2, span = Math.max(s.nx, s.ny) * s.S + 120;
    this.controls.target.set(cx, 0, cz);
    if (kind === 'top') this.camera.position.set(cx, span * 1.05, cz + 1);
    else this.camera.position.set(cx - span * 0.3, span * 0.5, cz + span * 0.62);
    this.controls.update(); this.userMoved = false;
  }

  build() {
    const s = this.sim;
    while (this.dyn.children.length) { const o = this.dyn.children.pop(); o.traverse?.((m) => { m.geometry?.dispose(); if (m.material?.map) m.material.map.dispose(); m.material?.dispose?.(); }); }
    this.labels.clear();
    const ext = GEO.L + GEO.half + 14;
    const x0 = -ext, z0 = -ext, x1 = (s.nx - 1) * s.S + ext, z1 = (s.ny - 1) * s.S + ext;
    // ground texture painted with the 2D renderer (roads, markings, crosswalks)
    const px = 2048, cv = document.createElement('canvas'); cv.width = px; cv.height = Math.round((px * (z1 - z0)) / (x1 - x0));
    const sv = new SimView(cv, { interactive: false }); sv.setSim(s);
    sv.paintStatic(cv, { x0, y0: z0, x1, y1: z1 });
    const tex = new THREE.CanvasTexture(cv); tex.anisotropy = 8; tex.colorSpace = THREE.SRGBColorSpace;
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, metalness: 0.1 }));
    ground.rotation.x = -Math.PI / 2; ground.position.set((x0 + x1) / 2, 0, (z0 + z1) / 2); this.dyn.add(ground); this.ground = ground;
    const base = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.MeshBasicMaterial({ color: 0x05060d }));
    base.rotation.x = -Math.PI / 2; base.position.y = -0.2; this.dyn.add(base);
    const grid = new THREE.GridHelper(1600, 80, 0x143a52, 0x0b1626); grid.position.set((x0 + x1) / 2, -0.1, (z0 + z1) / 2); this.dyn.add(grid);
    this.buildSkyline(x0, z0, x1, z1);
    // vehicles
    const box = new THREE.BoxGeometry(1, 1, 1);
    this.vBody = new THREE.InstancedMesh(box, new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.5, emissive: 0x111122 }), MAXV);
    this.vCab = new THREE.InstancedMesh(box, new THREE.MeshStandardMaterial({ color: 0x0b1020, roughness: 0.15, metalness: 0.8 }), MAXV);
    this.vLight = new THREE.InstancedMesh(box, new THREE.MeshBasicMaterial({ color: 0xffffff }), MAXV);
    for (const m of [this.vBody, this.vCab, this.vLight]) { m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); m.frustumCulled = false; m.count = 0; this.dyn.add(m); }
    this.vBody.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAXV * 3), 3);
    this.vLight.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAXV * 3), 3);
    this.pedM = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.35, 0.35, 1.7, 8), new THREE.MeshBasicMaterial({ color: 0xff9bf0 }), MAXP);
    this.pedM.frustumCulled = false; this.pedM.count = 0; this.dyn.add(this.pedM);
    // signals
    this.sig = [];
    for (const n of s.nodes) {
      const heads = [];
      for (let h = 0; h < 4; h++) {
        const d = DIRS[h], r = rv(h);
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.3, 9, 8), new THREE.MeshStandardMaterial({ color: 0x1a2038 }));
        const bx = n.cx - d[0] * (GEO.half + 1.5) + r[0] * 8.6, bz = n.cy - d[1] * (GEO.half + 1.5) + r[1] * 8.6;
        pole.position.set(bx, 4.5, bz); this.dyn.add(pole);
        const lamps = [0, 1].map((k) => { const m = new THREE.Mesh(new THREE.SphereGeometry(0.85, 12, 12), new THREE.MeshBasicMaterial({ color: SIGC.red })); m.position.set(bx, 9.6 + k * 2, bz); this.dyn.add(m); return m; });
        const bars = [0, 1].map((lane) => {
          const lat0 = lane === 0 ? 3.6 : 0.2, lat1 = lane === 0 ? 6.9 : 3.4;
          const m = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.25, lat1 - lat0), new THREE.MeshBasicMaterial({ color: SIGC.red }));
          const lat = (lat0 + lat1) / 2; m.position.set(n.cx - d[0] * GEO.half + r[0] * lat, 0.18, n.cy - d[1] * GEO.half + r[1] * lat);
          m.rotation.y = -Math.atan2(d[1], d[0]); this.dyn.add(m); return m;
        });
        heads.push({ lamps, bars });
      }
      const ring = new THREE.Mesh(new THREE.RingGeometry(GEO.half * 1.55, GEO.half * 1.7, 48), new THREE.MeshBasicMaterial({ color: 0x00f3ff, transparent: true, opacity: 0.55, side: THREE.DoubleSide }));
      ring.rotation.x = -Math.PI / 2; ring.position.set(n.cx, 0.3, n.cy); ring.visible = false; this.dyn.add(ring);
      this.sig.push({ heads, ring });
    }
    this.size();
  }

  buildSkyline(x0, z0, x1, z1) {
    const s = this.sim, geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.3, emissive: 0x0a1230 });
    const items = [];
    let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const road = GEO.half + 3;
    // blocks between road arms
    const xs = [], zs = [];
    for (let i = 0; i < s.nx; i++) xs.push(i * s.S); for (let j = 0; j < s.ny; j++) zs.push(j * s.S);
    const ex = [x0 - 120, ...xs, x1 + 120], ez = [z0 - 120, ...zs, z1 + 120];
    for (let a = 0; a < ex.length - 1; a++) for (let b = 0; b < ez.length - 1; b++) {
      const bx0 = ex[a] + (a === 0 ? 0 : road), bx1 = ex[a + 1] - (a === ex.length - 2 ? 0 : road), bz0 = ez[b] + (b === 0 ? 0 : road), bz1 = ez[b + 1] - (b === ez.length - 2 ? 0 : road);
      const outer = a === 0 || b === 0 || a === ex.length - 2 || b === ez.length - 2;
      const cols = outer ? 5 : 3, rows = outer ? 5 : 3;
      for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
        const cw = (bx1 - bx0) / cols, ch = (bz1 - bz0) / rows;
        const cx = bx0 + cw * (i + 0.5), cz = bz0 + ch * (j + 0.5);
        if (Math.abs(cx - Math.max(x0, Math.min(x1, cx))) < 0 ) continue;
        // keep clear of the drivable area
        const inRoadX = xs.some((x) => Math.abs(cx - x) < road + cw * 0.5) && cz > z0 && cz < z1, inRoadZ = zs.some((z) => Math.abs(cz - z) < road + ch * 0.5) && cx > x0 && cx < x1;
        if (inRoadX || inRoadZ) continue;
        if (rnd() < 0.3) continue;
        const hgt = (outer ? 10 : 5) + rnd() * (outer ? 34 : 14);
        items.push({ x: cx, z: cz, w: Math.max(6, cw * (0.4 + rnd() * 0.3)), d: Math.max(6, ch * (0.4 + rnd() * 0.3)), h: hgt, c: [0x1b2448, 0x241b48, 0x14304a, 0x2a1840][Math.floor(rnd() * 4)], e: [0x00f3ff, 0xa35bff, 0xff2bd6, 0x3d7bff][Math.floor(rnd() * 4)] });
      }
    }
    const im = new THREE.InstancedMesh(geo, mat, items.length), cap = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ color: 0xffffff }), items.length);
    const m4 = new THREE.Matrix4(), col = new THREE.Color();
    items.forEach((b, i) => {
      m4.compose(new THREE.Vector3(b.x, b.h / 2, b.z), new THREE.Quaternion(), new THREE.Vector3(b.w, b.h, b.d)); im.setMatrixAt(i, m4); im.setColorAt(i, col.setHex(b.c));
      m4.compose(new THREE.Vector3(b.x, b.h + 0.25, b.z), new THREE.Quaternion(), new THREE.Vector3(b.w + 0.4, 0.5, b.d + 0.4)); cap.setMatrixAt(i, m4); cap.setColorAt(i, col.setHex(b.e));
    });
    this.dyn.add(im, cap);
  }

  size() {
    if (!this.ok) return;
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (w < 4 || h < 4) return;
    if (this.w !== w || this.h !== h) { this.w = w; this.h = h; this.renderer.setSize(w, h, false); this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); }
  }

  pick(e) {
    const r = this.canvas.getBoundingClientRect();
    this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.camera);
    const hit = new THREE.Vector3();
    if (!this.ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit)) return;
    let best = null, bd = 1e9;
    for (const n of this.sim.nodes) { const d = Math.hypot(n.cx - hit.x, n.cy - hit.z); if (d < bd) { bd = d; best = n; } }
    if (best && bd < 70) { this.selected = best.id; if (this.onSelect) this.onSelect(best); }
  }

  label(key, text, x, z, color) {
    let l = this.labels.get(key);
    if (!l) {
      const c = document.createElement('canvas'); c.width = 128; c.height = 64;
      const t = new THREE.CanvasTexture(c);
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false, depthTest: false }));
      sp.scale.set(14, 7, 1); sp.renderOrder = 10; this.dyn.add(sp); l = { sp, c, t, text: '' }; this.labels.set(key, l);
    }
    if (l.text !== text + color) {
      l.text = text + color; const g = l.c.getContext('2d'); g.clearRect(0, 0, 128, 64);
      if (text) { g.fillStyle = 'rgba(5,7,16,.8)'; g.beginPath(); g.roundRect(30, 12, 68, 40, 10); g.fill(); g.strokeStyle = color; g.lineWidth = 3; g.stroke(); g.fillStyle = color; g.font = '700 28px monospace'; g.textAlign = 'center'; g.fillText(text, 64, 41); }
      l.t.needsUpdate = true;
    }
    l.sp.visible = !!text; l.sp.position.set(x, 15, z);
  }

  /** frac: progress to the next sim step (extrapolation, same as 2D). */
  draw(frac = 1) {
    if (!this.ok || !this.sim) return;
    this.size();
    const sim = this.sim, t = sim.t, m4 = this.m4 ||= new THREE.Matrix4(), q = this.q ||= new THREE.Quaternion(), pos = this.pos ||= new THREE.Vector3(), sc = this.scl ||= new THREE.Vector3(), eul = this.eul ||= new THREE.Euler(), col = this.col ||= new THREE.Color();
    let n = 0;
    for (const link of sim.links) for (const arr of link.lanes) for (const v of arr) {
      if (n >= MAXV) break;
      const adv = v.crashed ? 0 : -v.v * DT * frac, p = poseOf(sim, link, v, v.s + adv);
      const hgt = v.type === 'bus' ? 3.4 : v.type === 'truck' ? 3.0 : v.type === 'emerg' ? 2.2 : 1.45;
      eul.set(0, -p.a, 0); q.setFromEuler(eul);
      pos.set(p.x, hgt / 2 + 0.25, p.y); sc.set(v.len * 1.1, hgt, v.w * 1.25);
      m4.compose(pos, q, sc); this.vBody.setMatrixAt(n, m4);
      let c = CAR[v.id % CAR.length];
      if (v.type === 'truck') c = 0xffb020; else if (v.type === 'bus') c = 0xff2bd6; else if (v.type === 'emerg') c = 0xf4f7ff; if (v.crashed) c = 0xff3b5c;
      this.vBody.setColorAt(n, col.setHex(c));
      // cabin
      const cx = Math.cos(p.a) * v.len * 0.1, cz = Math.sin(p.a) * v.len * 0.1;
      pos.set(p.x + cx, hgt * 0.78 + 0.25, p.y + cz); sc.set(v.len * 0.45, hgt * 0.42, v.w * 0.92); m4.compose(pos, q, sc); this.vCab.setMatrixAt(n, m4);
      // roof light bar: red when braking, siren when emergency, hazard when crashed
      let lc = v.v < 0.6 ? 0xff3b5c : 0x223344;
      if (v.type === 'emerg') lc = Math.floor(t * 6) % 2 ? 0xff3b5c : 0x3d7bff; else if (v.crashed) lc = Math.floor(t * 3) % 2 ? 0xffb020 : 0xff3b5c;
      pos.set(p.x - Math.cos(p.a) * (v.len / 2 - 0.1), 0.9 + 0.25, p.y - Math.sin(p.a) * (v.len / 2 - 0.1)); sc.set(0.25, 0.35, v.w * 0.8); m4.compose(pos, q, sc); this.vLight.setMatrixAt(n, m4);
      this.vLight.setColorAt(n, col.setHex(lc));
      n++;
    }
    for (const m of [this.vBody, this.vCab, this.vLight]) { m.count = n; m.instanceMatrix.needsUpdate = true; }
    this.vBody.instanceColor.needsUpdate = true; this.vLight.instanceColor.needsUpdate = true;
    // pedestrians
    let pc = 0;
    for (const nd of sim.nodes) for (let c = 0; c < 4; c++) {
      const d = DIRS[c], r = rv(c), bx = nd.cx - d[0] * (GEO.half - 2), bz = nd.cy - d[1] * (GEO.half - 2);
      nd.pedQ[c].slice(0, 8).forEach((_, i) => { if (pc < MAXP) { const lat = (i % 2 ? 1 : -1) * (GEO.half + 1.6 + (i >> 1) * 0.9); pos.set(bx + r[0] * lat, 1.1, bz + r[1] * lat); m4.makeTranslation(pos.x, pos.y, pos.z); this.pedM.setMatrixAt(pc++, m4); } });
      for (const p of nd.pedCross[c]) if (pc < MAXP) { const prog = Math.min(1, (t - p.start) / (p.end - p.start)), lat = p.dir * (-GEO.half + 2 * GEO.half * prog); m4.makeTranslation(bx + r[0] * lat + d[0] * (p.off * 2 - 1), 1.1, bz + r[1] * lat + d[1] * (p.off * 2 - 1)); this.pedM.setMatrixAt(pc++, m4); }
    }
    this.pedM.count = pc; this.pedM.instanceMatrix.needsUpdate = true;
    // signals + labels
    sim.nodes.forEach((nd, i) => {
      const S = this.sig[i], sg = nd.sig;
      S.ring.visible = nd.id === this.selected && sim.nodes.length > 1; if (S.ring.visible) S.ring.material.opacity = 0.35 + 0.25 * Math.sin(t * 4);
      for (let h = 0; h < 4; h++) {
        const link = nd.inLinks[h];
        for (let lane = 0; lane < 2; lane++) {
          const ph = (h % 2 === 0 ? 0 : 2) + lane; let c = SIGC.red;
          if (sg.phase === ph) c = sg.state === 'green' ? SIGC.green : sg.state === 'amber' ? SIGC.amber : SIGC.red;
          S.heads[h].bars[lane].material.color.setHex(c); S.heads[h].lamps[lane].material.color.setHex(c);
        }
        const d = DIRS[h], q2 = link.stopped || 0;
        this.label(`${nd.id}:${h}`, q2 >= 2 ? String(q2) : '', nd.cx - d[0] * (GEO.half + 14), nd.cy - d[1] * (GEO.half + 14), q2 > 9 ? '#ff3b5c' : q2 > 5 ? '#ffb020' : '#00f3ff');
      }
    });
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}

/**
 * Hosts a 2D SimView and a 3D Sim3D in one stage with a 3D/2D/top toggle. Exposes the SimView-like
 * API the views use: setSim, draw(frac), selected, onSelect.
 */
export function createDualView(stage, canvas2d, { onSelect } = {}) {
  const v2 = new SimView(canvas2d, { onSelect });
  const v3 = new Sim3D(stage, { onSelect });
  let mode = v3.ok ? '3d' : '2d';
  const bar = document.createElement('div');
  bar.className = 'seg'; bar.style.cssText = 'position:absolute;right:10px;top:10px;z-index:5;background:rgba(5,7,16,.8)';
  const mk = (label, m) => { const b = document.createElement('button'); b.textContent = label; b.onclick = () => set(m); b.dataset.m = m; return b; };
  if (v3.ok) bar.append(mk('3D', '3d'), mk('Top', 'top'), mk('2D', '2d'));
  stage.append(bar);
  function set(m) {
    mode = m; bar.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.m === m));
    canvas2d.style.visibility = m === '2d' ? 'visible' : 'hidden'; if (v3.canvas) v3.canvas.style.visibility = m === '2d' ? 'hidden' : 'visible';
    if (m !== '2d' && v3.sim) v3.preset(m === 'top' ? 'top' : 'orbit');
  }
  const api = {
    v2, v3,
    get selected() { return mode === '2d' ? v2.selected : v3.selected; },
    set selected(v) { v2.selected = v; v3.selected = v; },
    setSim(sim) { v2.setSim(sim); v3.setSim(sim); set(mode); },
    draw(frac) { if (mode === '2d') v2.draw(frac); else v3.draw(frac); },
    get mode() { return mode; },
  };
  const sync = (n) => { v2.selected = n.id; v3.selected = n.id; if (onSelect) onSelect(n); };
  v2.onSelect = sync; v3.onSelect = sync;
  set(mode);
  return api;
}
