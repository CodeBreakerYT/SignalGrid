// JS side of the JS<->Python parity check: prints net outputs for a deterministic observation sequence.
import fs from 'node:fs';
import { SignalNet } from '../web/js/core/controllers.js';
const g = Float32Array.from(JSON.parse(fs.readFileSync(new URL('../web/data/evolved.json', import.meta.url))).genome);
const net = new SignalNet(g), res = [];
for (let k = 0; k < 6; k++) { const o = new Float32Array(38); for (let i = 0; i < 38; i++) o[i] = ((i * 7 + k * 13) % 11) / 11; res.push(Array.from(net.forward(o))); }
console.log(JSON.stringify(res));
