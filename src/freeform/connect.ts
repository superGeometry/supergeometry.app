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
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/**
 * A guide curve as a function of 0..1 (by length): run from the end nearer
 * A's middle, and moved (gradually, end to end) so it starts at A's middle and
 * ends at B's. With `da0`/`db0`: for `ease` along it from each end, eased
 * from the way it leaves A (arrives at B) onto the curve.
 */
export function guideCurve(pts: Vec3[], ca: Vec3, cb: Vec3, da0?: Vec3, db0?: Vec3, ease = 0): (t: number) => Vec3 {
  const p = oriented(pts, ca, cb);
  const acc = [0];
  for (let i = 1; i < p.length; i++) acc.push(acc[i - 1] + len(sub(p[i], p[i - 1])));
  const total = acc[acc.length - 1] || 1;
  const da = sub(ca, p[0]);
  const db = sub(cb, p[p.length - 1]);
  const on = (t: number) => {
    const want = Math.max(0, Math.min(1, t)) * total;
    let i = 1;
    while (i < p.length - 1 && acc[i] < want) i++;
    const f = Math.max(0, Math.min(1, acc[i] > acc[i - 1] ? (want - acc[i - 1]) / (acc[i] - acc[i - 1]) : 0));
    // Smoothly through the points (Catmull-Rom), not straight from one to the
    // next: the corners between straight pieces read as turns far too tight.
    const P0 = p[Math.max(0, i - 2)];
    const P1 = p[i - 1];
    const P2 = p[i];
    const P3 = p[Math.min(p.length - 1, i + 1)];
    const f2 = f * f;
    const f3 = f2 * f;
    const q = mul(add(add(mul(P1, 2), mul(sub(P2, P0), f)), add(mul(add(sub(mul(P0, 2), mul(P1, 5)), sub(mul(P2, 4), P3)), f2), mul(add(sub(mul(P1, 3), P0), sub(P3, mul(P2, 3))), f3))), 0.5);
    const s = want / total;
    return add(q, add(mul(da, 1 - s), mul(db, s)));
  };
  if (!da0 || !db0 || !(ease > 0)) return on;
  // Near each end, a smooth curve from straight out of the face onto the
  // guide (meeting it going its way): the bridge leaves the face square, with no kink.
  const w = Math.min(0.45, ease / total);
  const slope = (t: number) => mul(sub(on(t + 1e-4), on(t - 1e-4)), w / 2e-4);
  const hermite = (p0: Vec3, t0: Vec3, p1: Vec3, t1: Vec3) => (s: number) =>
    add(add(mul(p0, 2 * s ** 3 - 3 * s ** 2 + 1), mul(t0, s ** 3 - 2 * s ** 2 + s)), add(mul(p1, -2 * s ** 3 + 3 * s ** 2), mul(t1, s ** 3 - s ** 2)));
  const ta = slope(w);
  const tb = slope(1 - w);
  const startA = hermite(ca, mul(unit(da0), len(ta)), on(w), ta);
  const intoB = hermite(on(1 - w), tb, cb, mul(unit(db0), -len(tb)));
  return (t: number) => (t < w ? startA(t / w) : t > 1 - w ? intoB((t - (1 - w)) / w) : on(t));
}

/** The bridge's two outlines: points round each, from its middle, as they lie at that end. */
export interface Rings {
  a: Vec3[];
  b: Vec3[];
}

interface Frame {
  r: Vec3;
  s: Vec3;
  t: Vec3;
}

/**
 * `n` + 1 points along a curve, and at each the directions across it carried
 * along from the start without twisting about the curve (double reflection) -
 * the way the sweep carries the bridge's outline.
 */
function carried(c: (t: number) => Vec3, n: number): { P: Vec3[]; F: Frame[] } {
  const P = Array.from({ length: n + 1 }, (_, i) => c(i / n));
  const T = P.map((_, i) => unit(sub(P[Math.min(n, i + 1)], P[Math.max(0, i - 1)])));
  const seed: Vec3 = Math.abs(T[0][0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  let r = unit(sub(seed, mul(T[0], dot(seed, T[0]))));
  const F: Frame[] = [{ r, s: cross(T[0], r), t: T[0] }];
  for (let i = 0; i < n; i++) {
    const v1 = sub(P[i + 1], P[i]);
    const c1 = dot(v1, v1);
    let next = r;
    if (c1 > 1e-24) {
      const rL = sub(r, mul(v1, (2 / c1) * dot(v1, r)));
      const tL = sub(T[i], mul(v1, (2 / c1) * dot(v1, T[i])));
      const v2 = sub(T[i + 1], tL);
      const c2 = dot(v2, v2);
      next = c2 > 1e-24 ? sub(rL, mul(v2, (2 / c2) * dot(v2, rL))) : rL;
    }
    const t = T[i + 1];
    r = unit(sub(next, mul(t, dot(next, t))));
    F.push({ r, s: cross(t, r), t });
  }
  return { P, F };
}

/**
 * Whether a curve (0..1) never turns tighter than the bridge is wide: at each
 * point its radius more than how far the outline reaches towards the middle
 * of the turn (with a little to spare). Tighter, the outline's inner side
 * runs backwards and the bridge folds through itself. The outline is taken
 * where the sweep has carried it by then - turned with the curve (measured as
 * it lay at the faces, an arch's top went unchecked) - and as far between the
 * two ends' outlines as the point is along the curve (A's at A, B's at B).
 */
export function gentle(c: (t: number) => Vec3, rings: Rings, spare = 1.1): boolean {
  const N = 200;
  const { P, F } = carried(c, N);
  const across = (ring: Vec3[], f: Frame) => ring.map((p): Vec3 => [dot(p, f.r), dot(p, f.s), dot(p, f.t)]);
  const ends = [across(rings.a, F[0]), across(rings.b, F[N])];
  const h = 1 / N;
  for (let i = 1; i < N; i++) {
    const v = mul(sub(P[i + 1], P[i - 1]), 1 / (2 * h));
    const a = mul(add(sub(P[i + 1], mul(P[i], 2)), P[i - 1]), 1 / (h * h));
    const k = len(cross(v, a));
    if (k < 1e-12) continue;
    // Towards the middle of the turn: the part of `a` across the curve.
    const n = unit(sub(a, mul(v, dot(v, a) / dot(v, v))));
    const f = F[i];
    const nl: Vec3 = [dot(n, f.r), dot(n, f.s), dot(n, f.t)];
    const [ra, rb] = ends.map((ring) => ring.reduce((m, p) => Math.max(m, dot(p, nl)), 0));
    if (len(v) ** 3 / k < spare * (ra + (rb - ra) * (i / N))) return false;
  }
  return true;
}

/** A curve from `ca` to `cb` that leaves along `na` and arrives against `nb`, each held for `lead`. */
function hermite(ca: Vec3, na: Vec3, cb: Vec3, nb: Vec3, lead: number): (t: number) => Vec3 {
  const T0 = mul(unit(na), lead);
  const T1 = mul(unit(nb), -lead);
  return (t: number) => {
    const h00 = 2 * t ** 3 - 3 * t ** 2 + 1;
    const h10 = t ** 3 - 2 * t ** 2 + t;
    const h01 = -2 * t ** 3 + 3 * t ** 2;
    const h11 = t ** 3 - t ** 2;
    return add(add(mul(ca, h00), mul(T0, h10)), add(mul(cb, h01), mul(T1, h11)));
  };
}

/**
 * With no guide: a curve from A's middle to B's that leaves A along `na` and
 * arrives at B against `nb`, bowing out by `bulge` (1: plain) - but never
 * turning tighter than the bridge is wide (see gentle): a tighter turn folds
 * the bridge's inside, however little the bulge. `gentle` false: none of
 * these curves is (the faces too close, or too far to the side of each other,
 * for their width) - the plain one, for the caller to do better by.
 */
export function plainSpine(ca: Vec3, na: Vec3, cb: Vec3, nb: Vec3, bulge: number, rings: Rings): { along: (t: number) => Vec3; gentle: boolean } {
  const gap = len(sub(cb, ca)) || 1;
  // The bulge asked for, else the nearest to it (more, or less) that turns gently enough.
  const want = gap * Math.max(0.05, bulge);
  for (let k = 0; k < 40; k++)
    for (const lead of k ? [want * 1.06 ** k, want / 1.06 ** k] : [want]) {
      const c = hermite(ca, na, cb, nb, lead);
      if (gentle(c, rings)) return { along: c, gentle: true };
    }
  return { along: hermite(ca, na, cb, nb, want), gentle: false };
}

/**
 * Two arcs of circles, one out of A along `na` and one into B against `nb`,
 * meeting smoothly half way: of the ways from one face to the other this
 * turns the least tightly (well less than the plain curve at its tightest),
 * so it fits where that one would fold. Null where there is none (B straight
 * behind A).
 */
export function arcSpine(ca: Vec3, na: Vec3, cb: Vec3, nb: Vec3): ((t: number) => Vec3) | null {
  const T0 = unit(na);
  const T1 = unit(mul(nb, -1));
  const v = sub(cb, ca);
  const vv = dot(v, v);
  if (vv < 1e-18) return null;
  // (Equal chords: the corner points ca + d T0 and cb - d T1 are d from the ends and 2d apart.)
  const q = 1 - dot(T0, T1);
  const vt = dot(v, add(T0, T1));
  let d: number;
  if (q < 1e-9) {
    const ahead = dot(v, T0);
    if (ahead <= 1e-9) return null;
    d = vv / (4 * ahead);
  } else d = (-vt + Math.sqrt(vt * vt + 2 * q * vv)) / (2 * q);
  if (!(d > 1e-9) || !Number.isFinite(d)) return null;
  const J = mul(add(add(ca, mul(T0, d)), sub(cb, mul(T1, d))), 0.5);
  // The arc from A, leaving along T, to B: its length, and the point `s` along it.
  const arc = (A: Vec3, T: Vec3, B: Vec3) => {
    const w = sub(B, A);
    const ahead = dot(w, T);
    const side = sub(w, mul(T, ahead));
    const off = len(side);
    if (off < 1e-9 * (len(w) || 1)) return { length: Math.abs(ahead), at: (s: number) => add(A, mul(T, s * Math.sign(ahead || 1))) };
    const n = mul(side, 1 / off);
    const r = dot(w, w) / (2 * off);
    return { length: r * 2 * Math.atan2(off, ahead), at: (s: number) => add(A, mul(add(mul(T, Math.sin(s / r)), mul(n, 1 - Math.cos(s / r))), r)) };
  };
  const out = arc(ca, T0, J);
  const back = arc(cb, mul(T1, -1), J);
  const total = out.length + back.length;
  if (!(total > 0)) return null;
  return (t: number) => {
    const s = Math.max(0, Math.min(1, t)) * total;
    return s <= out.length ? out.at(s) : back.at(total - s);
  };
}

/**
 * For a bridge too wide to turn with its curve (it would fold): the direction
 * its outline can keep facing instead, all the way, sliding along the curve
 * without turning - a sheared bridge, thinner where the curve leans. Only
 * where both ends face nearly the same way (`ta`, `tb`: the way the curve
 * leaves A and arrives at B), the curve never runs across that direction (the
 * bridge would thin to nothing), and it gets further along it than the two
 * outlines lean apart (`reach`: how far they reach from their middles).
 */
export function slideAxis(c: (t: number) => Vec3, ta: Vec3, tb: Vec3, reach: number, least = 0.2): Vec3 | null {
  const a = unit(ta);
  const b = unit(tb);
  const cos = dot(a, b);
  if (cos < 0.94) return null;
  const d = unit(add(a, b));
  if (dot(sub(c(1), c(0)), d) < 2 * reach * Math.sqrt(Math.max(0, 1 - cos * cos))) return null;
  const N = 200;
  let prev = c(0);
  for (let i = 1; i <= N; i++) {
    const p = c(i / N);
    const step = sub(p, prev);
    const L = len(step);
    if (L > 1e-12 && dot(step, d) / L < least) return null;
    prev = p;
  }
  return d;
}

/** The plain curve (its bulge as asked, else the nearest less of it) that a bridge can slide along (see slideAxis). */
export function slidingSpine(ca: Vec3, na: Vec3, cb: Vec3, nb: Vec3, bulge: number, reach: number): { along: (t: number) => Vec3; axis: Vec3 } | null {
  const gap = len(sub(cb, ca)) || 1;
  const want = gap * Math.max(0.05, bulge);
  for (let k = 0; k < 40; k++) {
    const c = hermite(ca, na, cb, nb, want / 1.06 ** k);
    const axis = slideAxis(c, na, mul(nb, -1), reach);
    if (axis) return { along: c, axis };
  }
  return null;
}

/** `n` points evenly along a polyline (by length), its ends kept. */
export function evenly(pts: Vec3[], n: number): Vec3[] {
  const acc = [0];
  for (let i = 1; i < pts.length; i++) acc.push(acc[i - 1] + len(sub(pts[i], pts[i - 1])));
  const total = acc[acc.length - 1];
  if (!(total > 0)) return pts;
  const out: Vec3[] = [];
  let i = 1;
  for (let k = 0; k < n; k++) {
    const want = (total * k) / (n - 1);
    while (i < pts.length - 1 && acc[i] < want) i++;
    const f = acc[i] > acc[i - 1] ? Math.max(0, Math.min(1, (want - acc[i - 1]) / (acc[i] - acc[i - 1]))) : 0;
    out.push(add(pts[i - 1], mul(sub(pts[i], pts[i - 1]), f)));
  }
  return out;
}

/** A guide's points run from the end nearer A to the end nearer B. */
export function oriented(pts: Vec3[], ca: Vec3, cb: Vec3): Vec3[] {
  return len(sub(pts[0], ca)) + len(sub(pts[pts.length - 1], cb)) <= len(sub(pts[pts.length - 1], ca)) + len(sub(pts[0], cb)) ? pts : [...pts].reverse();
}

/**
 * A polyline (run from A to B) rounded off `passes` times - each point
 * towards its neighbours' middle - its ends kept, and still leaving the first
 * along `da` and arriving at the last against `db` (held by points out past
 * each end that don't move): its tight turns open out, its ends stay square.
 */
export function smoothed(pts: Vec3[], passes: number, da: Vec3, db: Vec3): Vec3[] {
  const step = len(sub(pts[1], pts[0])) || 1;
  const n = pts.length;
  const before = Array.from({ length: n }, (_, k) => sub(pts[0], mul(unit(da), step * (n - k))));
  const after = Array.from({ length: n }, (_, k) => add(pts[n - 1], mul(unit(db), step * (k + 1))));
  let p = [...before, ...pts, ...after];
  const fixed = (i: number) => i <= n || i >= 2 * n - 1;
  for (let k = 0; k < passes; k++) p = p.map((q, i) => (fixed(i) ? q : mul(add(add(p[i - 1], p[i + 1]), mul(q, 2)), 0.25)));
  return p.slice(n, 2 * n);
}
