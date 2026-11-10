// Curves of a sketch that follow a body's edge have moved (the body changed):
// what is dimensioned to them is carried along before the sketch is solved
// again. A distance says how far, not which side: a pin 8 mm from a wall that
// moved 40 mm was left on the wall's other side, 8 mm from it there.
import type { SketchConstraint, SketchEntity, Vec2 } from "../doc/types";
import { refsOf } from "./constraints";
import { transformEntity } from "./edit";

/** Where a curve is, as one point (a line's middle, a circle's centre, the mean of a curve's points). */
function middle(e: SketchEntity): Vec2 {
  switch (e.kind) {
    case "line":
      return [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2];
    case "arc":
      return [(e.a[0] + e.m[0] + e.b[0]) / 3, (e.a[1] + e.m[1] + e.b[1]) / 3];
    case "spline":
    case "polyline": {
      const n = Math.max(1, e.points.length);
      return [e.points.reduce((s, p) => s + p[0], 0) / n, e.points.reduce((s, p) => s + p[1], 0) / n];
    }
    default:
      return e.center;
  }
}

/**
 * `now` (the sketch with its edge-following curves where the edges are now)
 * with the other curves moved along: each group of curves tied together by
 * constraints is shifted by what the followed curves it is tied to moved.
 * A line that moved along itself (the edge got longer) shifts nothing.
 */
export function carried(old: SketchEntity[], now: SketchEntity[], constraints: SketchConstraint[], held: Set<string>): SketchEntity[] {
  const was = new Map(old.map((e) => [e.id, e]));
  // What each followed curve asks of what is tied to it: a shift along a direction (a line: square to it), or a shift outright.
  const asks = new Map<string, { n?: Vec2; v: Vec2 }>();
  for (const e of now) {
    const o = was.get(e.id);
    if (!held.has(e.id) || !o || o === e) continue;
    const [m0, m1] = [middle(o), middle(e)];
    if (o.kind === "line" && e.kind === "line") {
      const L = Math.hypot(o.b[0] - o.a[0], o.b[1] - o.a[1]) || 1;
      const n: Vec2 = [-(o.b[1] - o.a[1]) / L, (o.b[0] - o.a[0]) / L];
      const d = n[0] * (m1[0] - o.a[0]) + n[1] * (m1[1] - o.a[1]);
      asks.set(e.id, { n, v: [n[0] * d, n[1] * d] });
    } else asks.set(e.id, { v: [m1[0] - m0[0], m1[1] - m0[1]] });
  }
  if (!asks.size) return now;
  // Groups of free curves tied to each other.
  const parent = new Map<string, string>();
  const find = (a: string): string => {
    let r = a;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
    parent.set(a, r);
    return r;
  };
  const ids = new Set(now.map((e) => e.id));
  for (const c of constraints) {
    const free = refsOf(c).filter((id) => ids.has(id) && !held.has(id));
    for (const id of free) find(id);
    for (let i = 1; i < free.length; i++) parent.set(find(free[0]), find(free[i]));
  }
  // The shift that best gives each group what its followed curves ask (least squares, the smallest such shift).
  const sums = new Map<string, { a: number; b: number; c: number; x: number; y: number; seen: Set<string> }>();
  for (const c of constraints) {
    const refs = refsOf(c);
    const free = refs.find((id) => ids.has(id) && !held.has(id));
    if (!free) continue;
    const root = find(free);
    let s = sums.get(root);
    if (!s) sums.set(root, (s = { a: 0, b: 0, c: 0, x: 0, y: 0, seen: new Set() }));
    for (const id of refs) {
      const ask = asks.get(id);
      if (!ask || s.seen.has(id)) continue;
      s.seen.add(id);
      // (n n^T) t = n d for a line; t = v otherwise.
      const [nx, ny] = ask.n ?? [1, 0];
      if (ask.n) {
        s.a += nx * nx;
        s.b += nx * ny;
        s.c += ny * ny;
      } else {
        s.a += 1;
        s.c += 1;
      }
      s.x += ask.v[0];
      s.y += ask.v[1];
    }
  }
  const shift = new Map<string, Vec2>();
  for (const [root, s] of sums) {
    if (!s.seen.size) continue;
    const k = 1e-9;
    const [a, b, c] = [s.a + k, s.b, s.c + k];
    const det = a * c - b * b;
    const t: Vec2 = [(c * s.x - b * s.y) / det, (a * s.y - b * s.x) / det];
    if (Math.hypot(t[0], t[1]) > 1e-9) shift.set(root, t);
  }
  if (!shift.size) return now;
  return now.map((e) => {
    const t = !held.has(e.id) && parent.has(e.id) ? shift.get(find(e.id)) : undefined;
    return t ? transformEntity(e, (p) => [p[0] + t[0], p[1] + t[1]]) : e;
  });
}
