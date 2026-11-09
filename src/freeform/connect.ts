// Connect: a smooth bridge from one face to another. The faces' own outlines
// are swept along a curve (the guide the user drew, or one that leaves each
// face straight out of it): the bridge starts and ends exactly on the faces,
// so joined to them it leaves no step.

import type { Vec3 } from "../doc/types";

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3): Vec3 => mul(a, 1 / (len(a) || 1));

/**
 * A guide curve as a function of 0..1 (by length): run from the end nearer
 * A's middle, and moved (gradually, end to end) so it starts at A's middle and
 * ends at B's. With `da0`/`db0`: for `ease` along it from each end, eased
 * from the way it leaves A (arrives at B) onto the curve.
 */
export function guideCurve(pts: Vec3[], ca: Vec3, cb: Vec3, da0?: Vec3, db0?: Vec3, ease = 0): (t: number) => Vec3 {
  const p = len(sub(pts[0], ca)) + len(sub(pts[pts.length - 1], cb)) <= len(sub(pts[pts.length - 1], ca)) + len(sub(pts[0], cb)) ? pts : [...pts].reverse();
  const acc = [0];
  for (let i = 1; i < p.length; i++) acc.push(acc[i - 1] + len(sub(p[i], p[i - 1])));
  const total = acc[acc.length - 1] || 1;
  const da = sub(ca, p[0]);
  const db = sub(cb, p[p.length - 1]);
  const on = (t: number) => {
    const want = Math.max(0, Math.min(1, t)) * total;
    let i = 1;
    while (i < p.length - 1 && acc[i] < want) i++;
    const f = acc[i] > acc[i - 1] ? (want - acc[i - 1]) / (acc[i] - acc[i - 1]) : 0;
    const q = add(p[i - 1], mul(sub(p[i], p[i - 1]), Math.max(0, Math.min(1, f))));
    const s = want / total;
    return add(q, add(mul(da, 1 - s), mul(db, s)));
  };
  if (!da0 || !db0 || !(ease > 0)) return on;
  // Near each end, eased from straight out of the face onto the curve: the
  // bridge leaves the face square, with no kink.
  const w = Math.min(0.45, ease / total);
  const smooth = (x: number) => x * x * (3 - 2 * x);
  return (t: number) => {
    let q = on(t);
    if (t < w) {
      const k = smooth(t / w);
      q = add(mul(add(ca, mul(unit(da0), t * total)), 1 - k), mul(q, k));
    } else if (t > 1 - w) {
      const k = smooth((1 - t) / w);
      q = add(mul(add(cb, mul(unit(db0), (1 - t) * total)), 1 - k), mul(q, k));
    }
    return q;
  };
}

/**
 * Whether a curve (0..1) never turns tighter than the bridge is wide: at each
 * point its radius more than `width(n)`, how far the bridge reaches towards
 * the middle of the turn `n`.
 */
export function gentle(c: (t: number) => Vec3, width: (n: Vec3) => number): boolean {
  const h = 1 / 200;
  for (let i = 1; i < 200; i++) {
    const t = i * h;
    const p0 = c(t - h);
    const p1 = c(t);
    const p2 = c(t + h);
    const v = mul(sub(p2, p0), 1 / (2 * h));
    const a = mul(add(sub(p2, mul(p1, 2)), p0), 1 / (h * h));
    const x: Vec3 = [v[1] * a[2] - v[2] * a[1], v[2] * a[0] - v[0] * a[2], v[0] * a[1] - v[1] * a[0]];
    const k = len(x);
    if (k < 1e-12) continue;
    // Towards the middle of the turn: the part of `a` across the curve.
    const vv = len(v) ** 2;
    const n = unit(sub(a, mul(v, (v[0] * a[0] + v[1] * a[1] + v[2] * a[2]) / vv)));
    if (len(v) ** 3 / k < 1.1 * width(n)) return false;
  }
  return true;
}

/**
 * With no guide: a curve from A's middle to B's that leaves A along `na` and
 * arrives at B against `nb`, bowing out by `bulge` (1: plain) - but never
 * turning tighter than the bridge is wide (`width`, see gentle): a tighter
 * turn folds the bridge's inside, however little the bulge.
 */
export function plainSpine(ca: Vec3, na: Vec3, cb: Vec3, nb: Vec3, bulge: number, width: (n: Vec3) => number = () => 0): (t: number) => Vec3 {
  const gap = len(sub(cb, ca)) || 1;
  const curve = (lead: number) => {
    const T0 = mul(unit(na), lead);
    const T1 = mul(unit(nb), -lead);
    return (t: number) => {
      const h00 = 2 * t ** 3 - 3 * t ** 2 + 1;
      const h10 = t ** 3 - 2 * t ** 2 + t;
      const h01 = -2 * t ** 3 + 3 * t ** 2;
      const h11 = t ** 3 - t ** 2;
      return add(add(mul(ca, h00), mul(T0, h10)), add(mul(cb, h01), mul(T1, h11)));
    };
  };
  // The bulge asked for, else the nearest to it (more, or less) that turns gently enough.
  const want = gap * Math.max(0.05, bulge);
  for (let k = 0; k < 40; k++)
    for (const lead of k ? [want * 1.06 ** k, want / 1.06 ** k] : [want]) if (gentle(curve(lead), width)) return curve(lead);
  return curve(want);
}
