// Offset Edge: a line on a flat face, parallel to a straight edge at a
// distance, running across the face from one side of its outline to the other
// - cut back where it would run past the face, carried on where it would stop
// short. Works on the meshes the kernel sends (the face's triangles tell what
// is inside it, the body's edges where its outline is), so it needs no kernel
// call. Pure: tests/offsetedge.test.ts.

import type { PlaneDef, Vec2, Vec3 } from "../doc/types";
import { dot, len, norm, scale, sub, toPlane, toWorld } from "../geom";
import type { BodyMesh } from "../kernel/protocol";

export interface OffsetLine {
  /** Ends of the line, in the world. */
  a: Vec3;
  b: Vec3;
  /** The same in the face's plane (sketch coordinates). */
  a2: Vec2;
  b2: Vec2;
}

/**
 * The line parallel to edge `ea`-`eb`, `d` from it on face `face` of `body`
 * (towards the face's middle when d > 0), from the face's outline to its
 * outline. A string says why there is none.
 */
export function offsetLineOnFace(body: BodyMesh, face: number, plane: PlaneDef, ea: Vec3, eb: Vec3, d: number): OffsetLine | string {
  const n = norm(plane.normal);
  const dir0 = sub(eb, ea);
  if (len(dir0) < 1e-9) return "That edge has no length";
  // The edge as seen on the face's plane: it has to run along the face.
  const along = sub(dir0, scale(n, dot(dir0, n)));
  if (len(along) < len(dir0) * 0.9999) return "The edge has to run along the face (parallel to it)";
  const e2a = toPlane(plane, ea);
  const e2b = toPlane(plane, eb);
  const u = norm2(sub2(e2b, e2a));
  let perp: Vec2 = [-u[1], u[0]];
  // Positive distances go into the face (towards its middle).
  const tris = faceTriangles(body, face, plane);
  if (!tris.length) return "That face has no surface to draw on";
  const mid = centroid(tris);
  if (dot2(sub2(mid, e2a), perp) < 0) perp = [-perp[0], -perp[1]];
  const p0 = add2(e2a, scale2(perp, d));
  // Where the line crosses the face's outline (the body's edges lying in its plane).
  const size = Math.max(...tris.flat().map((p) => Math.hypot(p[0] - mid[0], p[1] - mid[1])), 1e-6);
  const tol = size * 1e-6;
  const ts: number[] = [];
  for (const g of body.edgeGroups) {
    const info = body.edges[g.edge];
    const pts: Vec2[] = [];
    let flat = true;
    for (let i = g.start; i < g.start + g.count; i++) {
      const w: Vec3 = [body.edgePositions[i * 3], body.edgePositions[i * 3 + 1], body.edgePositions[i * 3 + 2]];
      if (Math.abs(dot(sub(w, plane.origin), n)) > size * 1e-4) {
        flat = false;
        break;
      }
      pts.push(toPlane(plane, w));
    }
    if (!flat || pts.length < 2) continue;
    // A round edge: crossed exactly on its circle (not on the chord drawn for it).
    const circle = info?.type === "CIRCLE" ? circleIn(plane, info.start, info.mid, info.end) : null;
    for (let k = 0; k + 1 < pts.length; k++) {
      const t = crossSegment(p0, u, pts[k], pts[k + 1], tol);
      if (t === null) continue;
      ts.push(circle ? nearest(onCircle(p0, u, circle), t) : t);
    }
  }
  ts.sort((x, y) => x - y);
  const cuts = ts.filter((t, i) => i === 0 || t - ts[i - 1] > tol);
  // The spans between crossings that lie on the face, joined where they meet.
  const spans: [number, number][] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const m = (cuts[i] + cuts[i + 1]) / 2;
    if (!inside(tris, add2(p0, scale2(u, m)), tol)) continue;
    const last = spans[spans.length - 1];
    if (last && Math.abs(last[1] - cuts[i]) <= tol) last[1] = cuts[i + 1];
    else spans.push([cuts[i], cuts[i + 1]]);
  }
  if (!spans.length) return "At that distance the line misses the face";
  // The span beside the edge (where the edge's middle is, moved over).
  const tm = dot2(sub2(scale2(add2(e2a, e2b), 0.5), e2a), u) + dot2(sub2(e2a, p0), u);
  const gap = (s: [number, number]) => (tm < s[0] ? s[0] - tm : tm > s[1] ? tm - s[1] : 0);
  const best = spans.reduce((x, y) => (gap(y) < gap(x) ? y : x));
  const a2 = add2(p0, scale2(u, best[0]));
  const b2 = add2(p0, scale2(u, best[1]));
  return { a: toWorld(plane, a2), b: toWorld(plane, b2), a2, b2 };
}

/** The face's triangles, in its plane. */
function faceTriangles(body: BodyMesh, face: number, plane: PlaneDef): [Vec2, Vec2, Vec2][] {
  const out: [Vec2, Vec2, Vec2][] = [];
  const v = (i: number): Vec2 => toPlane(plane, [body.positions[i * 3], body.positions[i * 3 + 1], body.positions[i * 3 + 2]]);
  for (const g of body.faceGroups) {
    if (g.face !== face) continue;
    for (let k = g.start; k + 2 < g.start + g.count; k += 3) out.push([v(body.indices[k]), v(body.indices[k + 1]), v(body.indices[k + 2])]);
  }
  return out;
}

function centroid(tris: [Vec2, Vec2, Vec2][]): Vec2 {
  let ax = 0;
  let ay = 0;
  let w = 0;
  for (const [a, b, c] of tris) {
    const area = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
    ax += ((a[0] + b[0] + c[0]) / 3) * area;
    ay += ((a[1] + b[1] + c[1]) / 3) * area;
    w += area;
  }
  return w > 0 ? [ax / w, ay / w] : tris[0][0];
}

function inside(tris: [Vec2, Vec2, Vec2][], p: Vec2, tol: number): boolean {
  for (const [a, b, c] of tris) {
    const d = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
    if (Math.abs(d) < 1e-18) continue;
    const s = ((p[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (p[1] - a[1])) / d;
    const t = ((b[0] - a[0]) * (p[1] - a[1]) - (p[0] - a[0]) * (b[1] - a[1])) / d;
    const e = tol / Math.sqrt(Math.abs(d));
    if (s >= -e && t >= -e && s + t <= 1 + e) return true;
  }
  return false;
}

/** Where line p + t·u crosses segment q0-q1 (t), or null. */
function crossSegment(p: Vec2, u: Vec2, q0: Vec2, q1: Vec2, tol: number): number | null {
  const w = sub2(q1, q0);
  const den = u[0] * w[1] - u[1] * w[0];
  const lw = Math.hypot(w[0], w[1]);
  if (Math.abs(den) < 1e-12 * Math.max(1, lw)) return null; // along the line: its ends are other edges' crossings
  const r = sub2(q0, p);
  const t = (r[0] * w[1] - r[1] * w[0]) / den;
  const s = (r[0] * u[1] - r[1] * u[0]) / den;
  const e = lw > 0 ? tol / lw : 0;
  return s >= -e && s <= 1 + e ? t : null;
}

interface Circle2 {
  c: Vec2;
  r: number;
}

/** The circle a round edge lies on, in the plane (a whole circle: start = end, mid across from it). */
function circleIn(plane: PlaneDef, start: Vec3, mid: Vec3, end: Vec3): Circle2 | null {
  const [a, m, b] = [start, mid, end].map((p) => toPlane(plane, p));
  let c: Vec2;
  if (Math.hypot(...sub2(a, b)) < 1e-6) c = scale2(add2(a, m), 0.5);
  else {
    // Circumcentre of start, mid, end.
    const d = 2 * (a[0] * (m[1] - b[1]) + m[0] * (b[1] - a[1]) + b[0] * (a[1] - m[1]));
    if (Math.abs(d) < 1e-12) return null;
    const sq = (p: Vec2) => p[0] * p[0] + p[1] * p[1];
    c = [(sq(a) * (m[1] - b[1]) + sq(m) * (b[1] - a[1]) + sq(b) * (a[1] - m[1])) / d, (sq(a) * (b[0] - m[0]) + sq(m) * (a[0] - b[0]) + sq(b) * (m[0] - a[0])) / d];
  }
  const r = Math.hypot(...sub2(m, c));
  return r > 0 ? { c, r } : null;
}

function onCircle(p: Vec2, u: Vec2, k: Circle2): number[] {
  const f = sub2(p, k.c);
  const b = dot2(f, u);
  const disc = b * b - (dot2(f, f) - k.r * k.r);
  if (disc < 0) return [];
  const s = Math.sqrt(disc);
  return [-b - s, -b + s];
}

function nearest(ts: number[], t: number): number {
  return ts.length ? ts.reduce((x, y) => (Math.abs(y - t) < Math.abs(x - t) ? y : x)) : t;
}

const sub2 = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const add2 = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
const scale2 = (a: Vec2, s: number): Vec2 => [a[0] * s, a[1] * s];
const dot2 = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1];
const norm2 = (a: Vec2): Vec2 => {
  const l = Math.hypot(a[0], a[1]);
  return [a[0] / l, a[1] / l];
};
