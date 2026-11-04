// Campaign definition, scoring and unlock rules. Every number here derives from measured simulation results.
import { store, levelInfo } from './store.js';
import { SCENARIO_ORDER, SCENARIOS } from '../core/scenarios.js';

/** improvement (%) of `b` over baseline `a`; positive = better. */
const imp = (a, b, lowerIsBetter = true) => (a === 0 && b === 0 ? 0 : ((lowerIsBetter ? a - b : b - a) / Math.max(1e-9, Math.abs(a))) * 100);

/** Compute all improvements of the player's run vs the fixed-timer run (same seed, same demand). */
export function compareRuns(base, mine) {
  return {
    avgWait: imp(base.avgWait, mine.avgWait),
    avgQueue: imp(base.avgQueue, mine.avgQueue),
    maxQueue: imp(base.maxQueue, mine.maxQueue),
    throughput: imp(base.throughput, mine.throughput, false),
    pedWait: base.pedWait > 0 ? imp(base.pedWait, mine.pedWait) : 0,
    emergDelay: base.emergCount && base.emergDelay > 0 ? imp(base.emergDelay, mine.emergDelay) : 0,
    avgDelay: imp(base.avgDelay, mine.avgDelay),
  };
}

const clip = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 0-1000 efficiency score. 500 == exactly as good as the Fixed Timer. */
export function scoreOf(i, mine) {
  const parts = [[i.avgWait, 0.4], [i.avgQueue, 0.15], [i.throughput * 3, 0.15], [i.pedWait, 0.15]];
  if (mine.emergCount) parts.push([i.emergDelay, 0.15]); else parts.push([i.avgWait, 0.15]);
  let s = 0;
  for (const [v, w] of parts) s += clip(v, -50, 50) * w;
  return Math.round(clip(500 + s * 10, 0, 1000));
}

// Seeds were chosen with tools/calibrate.mjs so each mission is winnable (Adaptive earns >=1 star, Evolved >=2).
export const MISSIONS = [
  {
    id: 'calm', scenario: 'calm', seed: 316, title: 'First Light', xp: 60,
    brief: 'Early morning, light traffic. Prove that an adaptive controller is not just for rush hour: stop wasting green on empty approaches.',
    objectives: [
      { label: 'Cut average waiting time by 15%', test: (i) => i.avgWait >= 15 },
      { label: 'Cut average queue length by 20%', test: (i) => i.avgQueue >= 20 },
      { label: 'Cut pedestrian waiting by 15%', test: (i) => i.pedWait >= 15 },
    ],
  },
  {
    id: 'rush', scenario: 'rush', seed: 315, title: 'Rush Hour', xp: 90,
    brief: 'A heavy north-south commuter wave. The fixed timer gives both streets equal time; the street with the queue should get more.',
    objectives: [
      { label: 'Cut average waiting time by 10%', test: (i) => i.avgWait >= 10 },
      { label: 'Process at least 2% more vehicles', test: (i) => i.throughput >= 2 },
      { label: 'Cut average waiting time by 25%', test: (i) => i.avgWait >= 25 },
    ],
  },
  {
    id: 'school', scenario: 'school', seed: 319, title: 'School Run', xp: 110, unlocks: 'Evolved AI',
    brief: 'Parents, kids, buses. Pedestrians must be served promptly and safely, with no one stranded waiting for minutes.',
    objectives: [
      { label: 'Cut pedestrian waiting by 25%', test: (i) => i.pedWait >= 25 },
      { label: 'No pedestrian waits longer than 75 s', test: (i, m) => m.pedMaxWait <= 75 },
      { label: 'Also cut vehicle waiting by 10%', test: (i) => i.avgWait >= 10 },
    ],
  },
  {
    id: 'ambulance', scenario: 'ambulance', seed: 304, title: 'Ambulance Corridor', xp: 140,
    brief: 'Four ambulances cross a busy junction. Clear their approach early, but never cut the amber or all-red clearance.',
    objectives: [
      { label: 'Cut emergency response delay by 30%', test: (i) => i.emergDelay >= 30 },
      { label: 'Keep average waiting time no worse than the fixed timer', test: (i) => i.avgWait >= 0 },
      { label: 'Cut emergency response delay by 55%', test: (i) => i.emergDelay >= 55 },
    ],
  },
  {
    id: 'incident', scenario: 'incident', seed: 305, title: 'Crash on Main St', xp: 160,
    brief: 'A collision blocks the main lane mid-rush. Dead lanes attract green time from naive controllers.',
    objectives: [
      { label: 'Cut average waiting time by 5%', test: (i) => i.avgWait >= 5 },
      { label: 'Cut average queue length by 8%', test: (i) => i.avgQueue >= 8 },
      { label: 'Cut average waiting time by 15%', test: (i) => i.avgWait >= 15 },
    ],
  },
  {
    id: 'grid2', scenario: 'grid2', seed: 307, title: 'Twin Junction', xp: 190, unlocks: '2x2 grid',
    brief: 'Two coupled junctions: what leaves one arrives at the next. Avoid spilling queues back into the neighbour.',
    objectives: [
      { label: 'Cut average waiting time by 8%', test: (i) => i.avgWait >= 8 },
      { label: 'Process at least 2% more vehicles', test: (i) => i.throughput >= 2 },
      { label: 'Cut average waiting time by 18%', test: (i) => i.avgWait >= 18 },
    ],
  },
  {
    id: 'grid3', scenario: 'grid3', seed: 302, title: 'Downtown Grid', xp: 230, unlocks: '3x3 grid',
    brief: 'Nine junctions at peak demand. This is the regime where fixed timers gridlock.',
    objectives: [
      { label: 'Cut average waiting time by 8%', test: (i) => i.avgWait >= 8 },
      { label: 'Process at least 3% more vehicles', test: (i) => i.throughput >= 3 },
      { label: 'Cut pedestrian waiting by 20%', test: (i) => i.pedWait >= 20 },
    ],
  },
  {
    id: 'storm', scenario: 'storm', seed: 307, title: 'Gridlock Storm', xp: 300,
    brief: 'Peak demand, pedestrians, ambulances and a crash, all at once on the full grid. The final exam.',
    objectives: [
      { label: 'Cut average waiting time by 5%', test: (i) => i.avgWait >= 5 },
      { label: 'Cut emergency response delay by 15%', test: (i) => i.emergDelay >= 15 },
      { label: 'Process at least 3% more vehicles', test: (i) => i.throughput >= 3 },
    ],
  },
];
export const missionById = (id) => MISSIONS.find((m) => m.id === id);

export const demoUnlockAll = () => true; // missions/gating are not part of the trimmed UI: everything is available
export function missionState(id) { return store.get().missions[id] || { stars: 0, bestScore: 0, bestXp: 0, runs: 0 }; }
export function missionUnlocked(idx) {
  if (demoUnlockAll() || idx === 0) return true;
  return missionState(MISSIONS[idx - 1].id).stars >= 1;
}
/** Scenario / controller unlock gates shown in Live Simulation and Challenge mode. */
export function isUnlocked(kind, id) {
  if (demoUnlockAll()) return true;
  if (kind === 'scenario') {
    const idx = MISSIONS.findIndex((m) => m.scenario === id);
    return idx < 0 || missionUnlocked(idx);
  }
  if (kind === 'controller') return id !== 'evolved' || missionState('rush').stars >= 1;
  return true;
}

export function evaluateMission(mission, baseSummary, mySummary) {
  const i = compareRuns(baseSummary, mySummary);
  const results = mission.objectives.map((o) => o.test(i, mySummary));
  const stars = results.filter(Boolean).length;
  const score = scoreOf(i, mySummary);
  const diff = SCENARIOS[mission.scenario].difficulty;
  const xp = Math.round(stars * mission.xp * 0.33 + Math.max(0, score - 500) * 0.12 * diff);
  return { improvements: i, results, stars, score, xp };
}

/** Records a campaign result; XP is only granted for improvement over the previous best of that mission. */
export function recordResult(mission, ev, kind) {
  const st = store.get(), prev = missionState(mission.id);
  const gain = Math.max(0, ev.xp - prev.bestXp);
  const before = levelInfo(st.xp).level;
  st.xp += gain;
  st.missions[mission.id] = {
    stars: Math.max(prev.stars, ev.stars), bestScore: Math.max(prev.bestScore, ev.score), bestXp: Math.max(prev.bestXp, ev.xp), runs: prev.runs + 1, bestKind: ev.score > prev.bestScore ? kind : prev.bestKind,
  };
  store.save();
  return { gain, levelUp: levelInfo(st.xp).level > before };
}

export const totalStars = () => MISSIONS.reduce((a, m) => a + missionState(m.id).stars, 0);
export { SCENARIO_ORDER };
