// Repeatable traffic scenarios. All randomness (arrivals, routes, vehicle types, pedestrians,
// emergencies, incidents) is drawn from the scenario seed ONLY, so Fixed / Adaptive / Evolved
// controllers face exactly the same demand.
import { Rng, hashSeed } from './rng.js';

export const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]]; // heading 0=E 1=S 2=W 3=N (screen coords, y down)
export const HEADING_NAMES = ['Eastbound', 'Southbound', 'Westbound', 'Northbound'];
export const MOVE = { T: 0, L: 1, R: 2 };

export const VTYPES = {
  car: { len: 4.5, v0: 12.5, w: 1.9 },
  truck: { len: 8.5, v0: 10.5, w: 2.4 },
  bus: { len: 11, v0: 10, w: 2.5 },
  emerg: { len: 6, v0: 16, w: 2.1 },
};

// rate: vehicles / hour / entry road. ns / ew multipliers skew the demand. ped: pedestrians / hour / crosswalk.
export const SCENARIOS = {
  calm: {
    id: 'calm', name: 'Quiet Morning', blurb: 'Light, balanced traffic. Adaptive control should not make things worse.',
    nx: 1, ny: 1, duration: 600, rate: 240, ns: 1, ew: 1, profile: 'flat', ped: 40, emergencies: 0, incidents: [], difficulty: 1,
  },
  rush: {
    id: 'rush', name: 'Rush Hour', blurb: 'Heavy north-south commuter wave building over ten minutes.',
    nx: 1, ny: 1, duration: 600, rate: 520, ns: 1.35, ew: 0.75, profile: 'rush', ped: 60, emergencies: 0, incidents: [], difficulty: 2,
  },
  school: {
    id: 'school', name: 'School Run', blurb: 'Moderate cars but many pedestrians. Crossings must stay safe and fast.',
    nx: 1, ny: 1, duration: 600, rate: 380, ns: 1, ew: 1, profile: 'pulse', ped: 420, emergencies: 0, incidents: [], difficulty: 2,
  },
  ambulance: {
    id: 'ambulance', name: 'Ambulance Corridor', blurb: 'Dense traffic with four emergency vehicles crossing the junction.',
    nx: 1, ny: 1, duration: 600, rate: 430, ns: 1.1, ew: 0.9, profile: 'flat', ped: 60, emergencies: 4, incidents: [], difficulty: 3,
  },
  incident: {
    id: 'incident', name: 'Crash on Main St', blurb: 'A collision blocks the main lane mid-rush. Do not waste green on a dead lane.',
    nx: 1, ny: 1, duration: 600, rate: 480, ns: 1.25, ew: 0.8, profile: 'rush', ped: 60, emergencies: 0,
    incidents: [{ t: 150, i: 0, j: 0, h: 1, lane: 0, dur: 120 }], difficulty: 3,
  },
  grid2: {
    id: 'grid2', name: 'Twin Junction', blurb: 'A 2x2 block of connected intersections under steady load.',
    nx: 2, ny: 2, duration: 480, rate: 420, ns: 1.1, ew: 0.9, profile: 'rush', ped: 60, emergencies: 0, incidents: [], difficulty: 3,
  },
  grid3: {
    id: 'grid3', name: 'Downtown Grid', blurb: 'Nine coupled intersections at peak. Spillback and coordination matter.',
    nx: 3, ny: 3, duration: 600, rate: 460, ns: 1.15, ew: 0.9, profile: 'rush', ped: 80, emergencies: 0, incidents: [], difficulty: 4,
  },
  storm: {
    id: 'storm', name: 'Gridlock Storm', blurb: 'Peak demand, pedestrians, ambulances and a crash on a 3x3 grid.',
    nx: 3, ny: 3, duration: 600, rate: 500, ns: 1.2, ew: 0.9, profile: 'rush', ped: 150, emergencies: 3,
    incidents: [{ t: 180, i: 1, j: 1, h: 1, lane: 0, dur: 120 }], difficulty: 5,
  },
};
export const SCENARIO_ORDER = ['calm', 'rush', 'school', 'ambulance', 'incident', 'grid2', 'grid3', 'storm'];

const PROFILES = {
  flat: () => 1,
  rush: (t, T) => { const x = t / T; return x < 0.25 ? 0.55 + 0.55 * (x / 0.25) : x < 0.8 ? 1.1 : 1.1 - (x - 0.8) * 2.5; },
  pulse: (t, T) => 0.8 + 0.5 * Math.sin((t / T) * Math.PI * 4) ** 2,
};
const PROFILE_MAX = { flat: 1, rush: 1.1, pulse: 1.3 };

export function entryLinks(nx, ny) {
  const out = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) for (let h = 0; h < 4; h++) {
    const pi = i - DIRS[h][0], pj = j - DIRS[h][1];
    if (pi < 0 || pj < 0 || pi >= nx || pj >= ny) out.push({ i, j, h });
  }
  return out;
}

function makeRoute(rng, nx, ny, e, straightOnly) {
  const route = [];
  let { i, j, h } = e;
  for (let k = 0; k < 14; k++) {
    const r = rng.next();
    const m = straightOnly ? MOVE.T : r < 0.7 ? MOVE.T : r < 0.85 ? MOVE.L : MOVE.R;
    route.push(m);
    h = m === MOVE.T ? h : m === MOVE.L ? (h + 3) % 4 : (h + 1) % 4;
    i += DIRS[h][0]; j += DIRS[h][1];
    if (i < 0 || j < 0 || i >= nx || j >= ny) break;
  }
  return route;
}

/** Build a fully resolved scenario instance: precomputed demand, pedestrians, incidents. */
export function buildScenario(id, seed = 1, overrides = {}) {
  const base = SCENARIOS[id];
  if (!base) throw new Error('Unknown scenario ' + id);
  const sc = { ...base, ...overrides, seed };
  const T = sc.duration;
  const entries = entryLinks(sc.nx, sc.ny);
  const rng = new Rng(hashSeed(seed, 11, id.length));
  const demand = [];
  const prof = PROFILES[sc.profile], pmax = PROFILE_MAX[sc.profile];
  let vid = 0;
  for (const e of entries) {
    const mul = (e.h % 2 === 0 ? sc.ew : sc.ns) * (sc.skew ? sc.skew[e.h] : 1);
    const lmax = (sc.rate * mul * pmax) / 3600;
    if (lmax <= 0) continue;
    let t = 0;
    for (;;) {
      t += rng.exp(lmax);
      if (t >= T) break;
      if (rng.next() > (prof(t, T) / pmax)) continue;
      const q = rng.next();
      const type = q < 0.84 ? 'car' : q < 0.95 ? 'truck' : 'bus';
      demand.push({ t, e, type, route: makeRoute(rng, sc.nx, sc.ny, e, false), jitter: rng.range(0.92, 1.06), emerg: false });
    }
  }
  // emergency vehicles: deterministic times, random entry, straight route
  const erng = new Rng(hashSeed(seed, 23));
  for (let k = 0; k < sc.emergencies; k++) {
    const t = ((k + 0.7) / sc.emergencies) * T * 0.88 + erng.range(-10, 10);
    const e = erng.pick(entries);
    demand.push({ t: Math.max(20, t), e, type: 'emerg', route: makeRoute(erng, sc.nx, sc.ny, e, true), jitter: 1, emerg: true });
  }
  demand.sort((a, b) => a.t - b.t);
  demand.forEach((d) => { d.id = vid++; });

  // pedestrians
  const peds = [];
  const prng = new Rng(hashSeed(seed, 37));
  if (sc.ped > 0) {
    const lmax = (sc.ped * pmax) / 3600;
    for (let j = 0; j < sc.ny; j++) for (let i = 0; i < sc.nx; i++) for (let c = 0; c < 4; c++) {
      let t = 0;
      for (;;) {
        t += prng.exp(lmax);
        if (t >= T) break;
        if (prng.next() > prof(t, T) / pmax) continue;
        peds.push({ t, i, j, c, dur: prng.range(8.5, 12) });
      }
    }
    peds.sort((a, b) => a.t - b.t);
  }
  sc.demand = demand;
  sc.peds = peds;
  sc.entries = entries;
  return sc;
}

export function scenarioSummary(sc) {
  const byType = {};
  for (const d of sc.demand) byType[d.type] = (byType[d.type] || 0) + 1;
  return { vehicles: sc.demand.length, pedestrians: sc.peds.length, emergencies: sc.emergencies, incidents: sc.incidents.length, byType };
}
