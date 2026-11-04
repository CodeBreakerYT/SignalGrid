// Achievements: each is unlocked by a measured result, never by clicking around.
import { store } from './store.js';
import { toast } from './util.js';

export const ACHIEVEMENTS = [
  { id: 'flow15', icon: '\u{1F6A6}', name: 'Green Wave', desc: 'Live: 15% less waiting than the Fixed Timer on identical traffic' },
  { id: 'flow30', icon: '\u26A1', name: 'Traffic Whisperer', desc: 'Live: 30% less waiting than the Fixed Timer' },
  { id: 'walker', icon: '\u{1F6B6}', name: 'Pedestrian First', desc: 'Live: pedestrians wait 30% less than under the Fixed Timer' },
  { id: 'siren', icon: '\u{1F691}', name: 'Siren Whisperer', desc: 'Live: ambulance delay cut by 30%' },
  { id: 'grid', icon: '\u{1F3D9}', name: 'City Planner', desc: 'Beat the Fixed Timer on the full 3x3 grid' },
  { id: 'evo', icon: '\u{1F9EC}', name: 'Evolutionist', desc: 'Deploy an agent you evolved in the Lab' },
  { id: 'eye', icon: '\u{1F441}', name: 'Eagle Eye', desc: 'Run the vision monitor on real video with 8+ detections' },
  { id: 'stars', icon: '\u2B50', name: 'Perfect Run', desc: 'Earn 3 stars on any mission' },
  { id: 'all', icon: '\u{1F3C6}', name: 'Chief Engineer', desc: 'Clear all 8 campaign missions' },
];

export function award(id) {
  const st = store.get();
  const got = (st.seen.ach ||= {});
  if (got[id]) return false;
  got[id] = Date.now(); store.save();
  const a = ACHIEVEMENTS.find((x) => x.id === id);
  if (a) toast(`${a.icon} Achievement unlocked: ${a.name}`, 'good');
  return true;
}
