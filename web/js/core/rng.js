// Small seeded PRNG (mulberry32). Every scenario draws from its own streams so that
// demand is identical no matter which controller runs.
export class Rng {
  constructor(seed) { this.a = seed >>> 0; }
  next() {
    this.a = (this.a + 0x6d2b79f5) | 0;
    let t = Math.imul(this.a ^ (this.a >>> 15), 1 | this.a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a, b) { return a + (b - a) * this.next(); }
  int(n) { return Math.floor(this.next() * n); }
  pick(arr) { return arr[this.int(arr.length)]; }
  exp(rate) { return -Math.log(1 - this.next()) / rate; }
  normal() {
    let u = 0, v = 0;
    while (u === 0) u = this.next();
    while (v === 0) v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}
export const hashSeed = (...xs) => xs.reduce((h, x) => Math.imul(h ^ (x | 0), 0x9e3779b1) >>> 0, 0x811c9dc5);
