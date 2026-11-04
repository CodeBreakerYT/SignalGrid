// Progress, unlocks and data loading. Everything gamified is derived from measured simulation results.
import { genomeFromJSON } from '../core/evolve.js';

const KEY = 'signalgrid.v1';
const defaults = () => ({ xp: 0, missions: {}, userGenome: null, userGenomeMeta: null, backendUrl: '', seen: {} });
let state = defaults();
try { state = { ...defaults(), ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { /* private mode etc. */ }

export const store = {
  get: () => state,
  save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* ignore */ } },
  reset() { state = defaults(); this.save(); },
};

export const LEVELS = [0, 150, 400, 750, 1200, 1800, 2600, 3600, 5000];
export function levelInfo(xp) {
  let lvl = 0;
  while (lvl + 1 < LEVELS.length && xp >= LEVELS[lvl + 1]) lvl++;
  const lo = LEVELS[lvl], hi = LEVELS[lvl + 1] ?? lo + 2000;
  return { level: lvl + 1, lo, hi, frac: Math.min(1, (xp - lo) / (hi - lo)) };
}

export const data = { evolved: null, benchmarks: null, ready: false };
export async function loadData() {
  const get = async (u) => { try { const r = await fetch(u, { cache: 'no-cache' }); return r.ok ? await r.json() : null; } catch { return null; } };
  const [e, b] = await Promise.all([get('data/evolved.json'), get('data/benchmarks.json')]);
  data.evolved = e; data.benchmarks = b; data.ready = true;
}
/** Genome used by the "Evolved AI" mode: the player's own deployed champion if present, else the shipped one. */
export function evolvedGenome() {
  if (state.userGenome) return Float32Array.from(state.userGenome);
  return data.evolved ? genomeFromJSON(data.evolved.genome) : null;
}
export const evolvedSource = () => (state.userGenome ? 'your Lab run' : data.evolved ? 'shipped champion' : 'unavailable');
