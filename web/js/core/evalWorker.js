// Worker entry shared by browsers (Web Worker, module) and Node (worker_threads).
// Evaluates a chunk of genomes on a list of scenario specs and posts back fitness + metrics.
import { evalGenome } from './evolve.js';

const handle = (msg) => {
  const results = msg.genomes.map((g) => {
    const r = evalGenome(g ? Float32Array.from(g) : null, msg.specs, msg.weights, msg.kind || 'evolved');
    return r;
  });
  return { id: msg.id, results };
};

if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof process === 'undefined') {
  self.onmessage = (e) => self.postMessage(handle(e.data));
} else {
  const { parentPort } = await import('node:worker_threads');
  parentPort.on('message', (m) => parentPort.postMessage(handle(m)));
}
