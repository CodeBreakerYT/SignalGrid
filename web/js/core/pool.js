// Parallel evaluator: splits a population across workers. `spawn()` must return an object with
// postMessage(msg) and a way to receive replies, abstracted here as a tiny adapter.
export class EvalPool {
  /** @param {() => {post:(m:any)=>void, onmessage:(fn:(m:any)=>void)=>void, terminate:()=>void}} spawn */
  constructor(spawn, size) {
    this.size = size;
    this.workers = [];
    this.pending = new Map();
    this.nextId = 1;
    for (let i = 0; i < size; i++) {
      const w = spawn();
      w.onmessage((m) => { const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); p(m.results); } });
      this.workers.push(w);
    }
  }

  evaluate = async (genomes, specs, weights, kind = 'evolved') => {
    const n = this.workers.length;
    const chunks = Array.from({ length: n }, () => []);
    genomes.forEach((g, i) => chunks[i % n].push(i));
    const out = new Array(genomes.length);
    await Promise.all(chunks.map((idxs, wi) => {
      if (!idxs.length) return null;
      return new Promise((resolve) => {
        const id = this.nextId++;
        this.pending.set(id, (results) => { idxs.forEach((gi, k) => { out[gi] = results[k]; }); resolve(); });
        this.workers[wi].post({ id, genomes: idxs.map((i) => genomes[i]), specs, weights, kind });
      });
    }));
    return out;
  };

  terminate() { this.workers.forEach((w) => w.terminate()); this.workers = []; }
}

export function browserSpawner() {
  const url = new URL('./evalWorker.js', import.meta.url);
  return () => {
    const w = new Worker(url, { type: 'module' });
    return { post: (m) => w.postMessage(m), onmessage: (fn) => { w.onmessage = (e) => fn(e.data); }, terminate: () => w.terminate() };
  };
}

export async function nodeSpawner() {
  const { Worker } = await import('node:worker_threads');
  const url = new URL('./evalWorker.js', import.meta.url);
  return () => {
    const w = new Worker(url);
    return { post: (m) => w.postMessage(m), onmessage: (fn) => w.on('message', fn), terminate: () => w.terminate() };
  };
}
