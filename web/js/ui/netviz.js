// Visualisation of the SignalNet agent: sensors -> phase-module interneurons -> output neurons.
import { NET, NEURON, STRUCTURE } from '../core/controllers.js';
import { OBS } from '../core/sim.js';
import { fitCanvas } from './util.js';

const { nIn, nHid, nOut, n: N } = NET;
const OFF = { win: 0, rec: nIn * nHid };
const FEATURES = ['queue', 'density', 'wait', 'peds', 'ped wait', 'ambulance', 'blocked', 'downstream'];
const OUT_LABELS = ['EW thru', 'EW left', 'NS thru', 'NS left', 'hold', 'duration'];
const PHASE_COL = ['#00f3ff', '#a35bff', '#3d7bff', '#ff2bd6'];

function layout(w, h) {
  const pad = 26, inX = 70, outX = w - 78, hx0 = w * 0.3, hx1 = w * 0.72;
  const inputs = [], hidden = [], outputs = [];
  const band = (h - 2 * pad) / 4;
  for (let p = 0; p < 4; p++) for (let f = 0; f < 8; f++) inputs.push({ x: inX, y: pad + p * band + 6 + f * ((band - 12) / 7) });
  // globals: current-phase one-hot (4), time in phase, congestion -> compact column on the far left
  for (let g = 0; g < 6; g++) inputs.push({ x: inX - 44, y: pad + 20 + g * 22 });
  for (let k = 0; k < 4; k++) {
    for (let j = 0; j < 6; j++) hidden[NEURON.E(k, 0) + j] = { x: hx0 + (j % 3) * ((hx1 - hx0 - 60) / 2), y: pad + k * band + 12 + Math.floor(j / 3) * (band - 28), k };
    hidden[NEURON.G(k)] = { x: hx1 + 4, y: pad + k * band + band / 2, k };
  }
  const ob = (h - 2 * pad) / 6;
  for (let o = 0; o < nOut; o++) outputs.push({ x: outX, y: pad + ob * (o + 0.5) });
  return { inputs, hidden, outputs };
}

/** @param {Float32Array} genome  @param {{x?:Float32Array, obs?:Float32Array}} live */
export function drawNet(canvas, genome, live = {}) {
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  if (!genome) return;
  const L = layout(w, h);
  const x = live.x, obs = live.obs;
  const pos = (i) => (i < nHid ? L.hidden[i] : L.outputs[i - nHid]);
  const act = (i) => (x ? Math.min(1, x[i] / (i < nHid ? 1 : 2)) : 0.25);
  const curve = (a, b, col, alpha, wd) => {
    ctx.strokeStyle = col; ctx.globalAlpha = alpha; ctx.lineWidth = wd;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.bezierCurveTo(a.x + (b.x - a.x) * 0.5, a.y, a.x + (b.x - a.x) * 0.5, b.y, b.x, b.y); ctx.stroke();
  };
  // sensor -> interneuron synapses
  for (let f = 0; f < 32; f++) {
    const a = L.inputs[f], v = obs ? obs[f] : 0.3;
    for (let hn = 0; hn < nHid; hn++) {
      const wgt = genome[OFF.win + f * nHid + hn];
      if (Math.abs(wgt) < 0.3) continue;
      const strength = Math.min(1, Math.abs(wgt) / 3);
      curve(a, L.hidden[hn], wgt > 0 ? '#00f3ff' : '#ff2bd6', (0.08 + 0.5 * strength) * (obs ? 0.25 + v : 1), 0.6 + strength);
    }
  }
  for (let f = 32; f < nIn; f++) {
    const a = L.inputs[f];
    for (let hn = 0; hn < nHid; hn++) {
      const wgt = genome[OFF.win + f * nHid + hn];
      if (Math.abs(wgt) < 0.3) continue;
      curve(a, L.hidden[hn], wgt > 0 ? '#00f3ff' : '#ff2bd6', 0.18, 0.7);
    }
  }
  // recurrent synapses
  for (let post = 0; post < N; post++) for (let pre = 0; pre < N; pre++) {
    if (!STRUCTURE.recMask[post * N + pre]) continue;
    const wgt = genome[OFF.rec + post * N + pre] * STRUCTURE.sign[pre];
    if (Math.abs(wgt) < 0.2) continue;
    const a = pos(pre), b = pos(post), on = x ? x[pre] : 0.4;
    curve(a, b, wgt > 0 ? '#31ff9a' : '#ff3b5c', Math.min(0.75, 0.06 + Math.abs(wgt) * 0.22 * (0.3 + on)), 0.6 + Math.min(2, Math.abs(wgt)));
  }
  ctx.globalAlpha = 1;
  // nodes
  ctx.font = '10px "Cascadia Mono", monospace'; ctx.textAlign = 'right';
  for (let p = 0; p < 4; p++) {
    ctx.fillStyle = PHASE_COL[p]; ctx.textAlign = 'left'; ctx.fillText(['EW thru', 'EW left', 'NS thru', 'NS left'][p], 4, L.inputs[p * 8].y - 8);
  }
  for (let f = 0; f < nIn; f++) {
    const a = L.inputs[f], v = obs ? obs[f] : 0.25;
    ctx.fillStyle = `rgba(0,243,255,${0.12 + 0.88 * Math.min(1, v)})`; ctx.strokeStyle = 'rgba(0,243,255,.5)'; ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.arc(a.x, a.y, 3.4, 0, 6.3); ctx.fill(); ctx.stroke();
    if (f < 32) { ctx.fillStyle = '#566089'; ctx.textAlign = 'left'; if (f % 8 < 8) ctx.fillText(FEATURES[f % 8], a.x + 8, a.y + 3); }
  }
  ctx.fillStyle = '#566089'; ctx.textAlign = 'left';
  ctx.fillText('phase now / time / load', 4, 14);
  for (let i = 0; i < nHid; i++) {
    const a = L.hidden[i]; if (!a) continue;
    const inh = STRUCTURE.sign[i] < 0, v = act(i);
    ctx.fillStyle = inh ? `rgba(255,43,214,${0.15 + 0.85 * v})` : `rgba(49,255,154,${0.12 + 0.88 * v})`;
    ctx.strokeStyle = inh ? '#ff2bd6' : '#31ff9a'; ctx.lineWidth = 1.1;
    ctx.shadowColor = ctx.strokeStyle; ctx.shadowBlur = 4 + 10 * v;
    ctx.beginPath(); ctx.arc(a.x, a.y, 5.2, 0, 6.3); ctx.fill(); ctx.stroke(); ctx.shadowBlur = 0;
  }
  ctx.textAlign = 'left'; ctx.fillStyle = '#566089';
  ctx.fillText('interneurons (green excitatory / pink inhibitory)', L.hidden[0].x - 8, h - 6);
  for (let o = 0; o < nOut; o++) {
    const a = L.outputs[o], v = x ? Math.min(1, x[nHid + o] / 2.5) : 0.3;
    const col = o < 4 ? PHASE_COL[o] : '#ffb020';
    ctx.fillStyle = col + Math.round(40 + 215 * v).toString(16).padStart(2, '0'); ctx.strokeStyle = col; ctx.lineWidth = 1.4;
    ctx.shadowColor = col; ctx.shadowBlur = 4 + 14 * v;
    ctx.beginPath(); ctx.arc(a.x, a.y, 8, 0, 6.3); ctx.fill(); ctx.stroke(); ctx.shadowBlur = 0;
    ctx.fillStyle = '#c9d3ff'; ctx.textAlign = 'left'; ctx.fillText(OUT_LABELS[o], a.x + 13, a.y + 3);
  }
  void OBS;
}
