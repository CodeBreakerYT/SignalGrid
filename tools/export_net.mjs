// Exports the agent's fixed wiring so the Python/CARLA bridge runs the exact same network.
import fs from 'node:fs';
import { NET, STRUCTURE } from '../web/js/core/controllers.js';
import { SAFETY } from '../web/js/core/sim.js';
const syn = [];
for (let i = 0; i < STRUCTURE.recMask.length; i++) if (STRUCTURE.recMask[i]) syn.push(i);
fs.writeFileSync(new URL('../web/data/net_structure.json', import.meta.url), JSON.stringify({ nIn: NET.nIn, nHid: NET.nHid, nOut: NET.nOut, alpha: NET.alpha, steps: NET.steps, sign: Array.from(STRUCTURE.sign), recMask: syn, safety: SAFETY }));
console.log('exported', syn.length, 'synapses');
