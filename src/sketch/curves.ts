// Sketch curve math, shared by the UI and the kernel worker.
// Every sketch entity is broken into primitives (line / circular arc /
// elliptical arc / spline) that can be evaluated at a parameter t ∈ [0, 1].

import type { SketchEntity, Vec2 } from "../doc/types";

export type Prim =
  | { t: "line"; a: Vec2; b: Vec2; src: string }
  | { t: "circle"; c: Vec2; r: number; a0: number; sweep: number; src: string }
  | { t: "ellipse"; c: Vec2; rx: number; ry: number; rot: number; a0: number; sweep: number; src: string }
  | { t: "spline"; pts: Vec2[]; closed: boolean; src: string; ctrl?: SplineDef };

/** The points a spline was drawn with (its samples are 16 per span of these). */
export interface SplineDef {
  points: Vec2[];
  closed: boolean;
  mode: "fit" | "control";
}

export const SPLINE_PER_SPAN = 16;

const TAU = Math.PI * 2;

export function evalPrim(p: Prim, t: number): Vec2 {
  switch (p.t) {
    case "line":
      return [p.a[0] + (p.b[0] - p.a[0]) * t, p.a[1] + (p.b[1] - p.a[1]) * t];
    case "circle": {
      const ang = p.a0 + p.sweep * t;
      return [p.c[0] + p.r * Math.cos(ang), p.c[1] + p.r * Math.sin(ang)];
    }
    case "ellipse": {
      const ang = p.a0 + p.sweep * t;
      const x = p.rx * Math.cos(ang);
      const y = p.ry * Math.sin(ang);
      const c = Math.cos(p.rot);
      const s = Math.sin(p.rot);
      return [p.c[0] + x * c - y * s, p.c[1] + x * s + y * c];
    }
    case "spline": {
      const n = p.pts.length - 1;
      const f = Math.min(Math.max(t, 0), 1) * n;
      const i = Math.min(Math.floor(f), n - 1);
      const u = f - i;
      const a = p.pts[i];
      const b = p.pts[i + 1];
      return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
    }
  }
}

export function isClosedPrim(p: Prim): boolean {
  if (p.t === "circle" || p.t === "ellipse") return Math.abs(Math.abs(p.sweep) - TAU) < 1e-9;
  if (p.t === "spline") return p.closed;
  return false;
}

/** Number of straight segments used to approximate a primitive. */
export function primSegments(p: Prim): number {
  switch (p.t) {
    case "line":
      return 1;
    case "circle":
    case "ellipse":
      return Math.max(6, Math.ceil((Math.abs(p.sweep) / TAU) * 96));
    case "spline":
      return p.pts.length - 1;
  }
}

/** Break an entity into primitives. Construction geometry still yields prims (for drawing). */
export function entityPrims(e: SketchEntity): Prim[] {
  const src = e.id;
  switch (e.kind) {
    case "line":
      return [{ t: "line", a: e.a, b: e.b, src }];
    case "arc": {
      const arc = arcFrom3(e.a, e.m, e.b);
      if (!arc) return [{ t: "line", a: e.a, b: e.b, src }];
      return [{ t: "circle", c: arc.c, r: arc.r, a0: arc.a0, sweep: arc.sweep, src }];
    }
    case "circle":
      return [{ t: "circle", c: e.center, r: e.radius, a0: 0, sweep: TAU, src }];
    case "ellipse":
      return [{ t: "ellipse", c: e.center, rx: e.rx, ry: e.ry, rot: e.rotation, a0: 0, sweep: TAU, src }];
    case "spline":
      return [{ t: "spline", pts: splinePoints(e.points, e.closed, e.mode), closed: e.closed && e.points.length > 2, src, ...(e.points.length > 2 ? { ctrl: { points: e.points, closed: e.closed, mode: e.mode } } : {}) }];
    case "rect":
    case "polygon":
    case "polyline": {
      const pts = entityCorners(e);
      const closed = e.kind !== "polyline" || e.closed;
      const out: Prim[] = [];
      for (let i = 0; i < pts.length - (closed ? 0 : 1); i++) {
        out.push({ t: "line", a: pts[i], b: pts[(i + 1) % pts.length], src });
      }
      return out;
    }
  }
}

/** Corner points of straight-sided entities. */
export function entityCorners(e: Extract<SketchEntity, { kind: "rect" | "polygon" | "polyline" }>): Vec2[] {
  if (e.kind === "polyline") return e.points;
  if (e.kind === "polygon") {
    return Array.from({ length: e.sides }, (_, i) => {
      const t = e.angle + (i / e.sides) * TAU;
      return [e.center[0] + e.radius * Math.cos(t), e.center[1] + e.radius * Math.sin(t)] as Vec2;
    });
  }
  const c = Math.cos(e.rotation);
  const s = Math.sin(e.rotation);
  const hw = e.w / 2;
  const hh = e.h / 2;
  return ([
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ] as Vec2[]).map(([x, y]) => [e.center[0] + x * c - y * s, e.center[1] + x * s + y * c] as Vec2);
}

/** Dense polyline for drawing an entity. */
export function entityPolylines(e: SketchEntity): Vec2[][] {
  return entityPrims(e).map((p) => samplePrim(p, 0, 1));
}

export function samplePrim(p: Prim, t0: number, t1: number, segs?: number): Vec2[] {
  const n = segs ?? Math.max(1, Math.ceil(primSegments(p) * Math.abs(t1 - t0)));
  if (p.t === "spline") {
    // Follow the stored samples exactly so pieces line up with the full curve.
    const N = p.pts.length - 1;
    const out: Vec2[] = [evalPrim(p, t0)];
    const lo = Math.min(t0, t1) * N;
    const hi = Math.max(t0, t1) * N;
    const inner: Vec2[] = [];
    for (let i = Math.floor(lo) + 1; i < hi - 1e-9; i++) inner.push(p.pts[i]);
    if (t1 < t0) inner.reverse();
    out.push(...inner, evalPrim(p, t1));
    return out;
  }
  return Array.from({ length: n + 1 }, (_, i) => evalPrim(p, t0 + ((t1 - t0) * i) / n));
}

/** Circle through three points, with the sweep that passes through the middle one. */
export function arcFrom3(a: Vec2, m: Vec2, b: Vec2): { c: Vec2; r: number; a0: number; sweep: number } | null {
  const ax = a[0];
  const ay = a[1];
  const bx = m[0];
  const by = m[1];
  const cx = b[0];
  const cy = b[1];
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-12) return null;
  const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
  const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
  const r = Math.hypot(ax - ux, ay - uy);
  const a0 = Math.atan2(ay - uy, ax - ux);
  const am = Math.atan2(by - uy, bx - ux);
  const a1 = Math.atan2(cy - uy, cx - ux);
  const ccw = (x: number) => ((x % TAU) + TAU) % TAU;
  const toM = ccw(am - a0);
  const toB = ccw(a1 - a0);
  const sweep = toM < toB ? toB : toB - TAU;
  return { c: [ux, uy], r, a0, sweep };
}

/**
 * Densely sampled spline. "fit" passes through the points (centripetal
 * Catmull-Rom); "control" treats them as B-spline control points.
 */
export function splinePoints(pts: Vec2[], closed: boolean, mode: "fit" | "control", perSpan = 16): Vec2[] {
  if (pts.length < 2) return pts.slice();
  if (pts.length === 2) return [pts[0], pts[1]];
  const n = pts.length;
  const get = (i: number): Vec2 => pointAt(pts, i, closed, mode);
  const spans = closed ? n : n - 1;
  const out: Vec2[] = [];
  for (let s = 0; s < spans; s++) {
    for (let k = 0; k < perSpan; k++) {
      const u = k / perSpan;
      out.push(mode === "fit" ? catmull(get(s - 1), get(s), get(s + 1), get(s + 2), u) : bspline(get(s - 1), get(s), get(s + 1), get(s + 2), u));
    }
  }
  if (closed) out.push(out[0]);
  else out.push(pts[n - 1]);
  return out;
}

/** Exact point on span `s` of a spline (each span is one cubic), u in [0, 1]. */
export function splineSpanAt(d: SplineDef, s: number, u: number): Vec2 {
  const get = (i: number): Vec2 => pointAt(d.points, i, d.closed, d.mode);
  return d.mode === "fit" ? catmull(get(s - 1), get(s), get(s + 1), get(s + 2), u) : bspline(get(s - 1), get(s), get(s + 1), get(s + 2), u);
}

/** Number of cubic spans of a spline. */
export function splineSpans(d: SplineDef): number {
  return d.closed ? d.points.length : d.points.length - 1;
}

/**
 * Point i of a spline's list, past the ends too: closed splines wrap; an open
 * spline gets a mirrored point beyond each end, so it starts and ends exactly
 * on its first and last point (control-point splines too - no gap at the
 * ends) and leaves them heading towards the neighbour (a repeated end point
 * would leave it at a tangent of its own making - e.g. along a revolve axis,
 * which can't revolve).
 */
function pointAt(pts: Vec2[], i: number, closed: boolean, _mode: "fit" | "control"): Vec2 {
  const n = pts.length;
  if (closed) return pts[((i % n) + n) % n];
  if (n >= 2) {
    if (i < 0) return [2 * pts[0][0] - pts[1][0], 2 * pts[0][1] - pts[1][1]];
    if (i > n - 1) return [2 * pts[n - 1][0] - pts[n - 2][0], 2 * pts[n - 1][1] - pts[n - 2][1]];
  }
  return pts[Math.max(0, Math.min(n - 1, i))];
}

function catmull(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, u: number): Vec2 {
  // Centripetal parameterisation avoids cusps and self-intersections.
  const d = (a: Vec2, b: Vec2) => Math.max(1e-9, Math.sqrt(Math.hypot(a[0] - b[0], a[1] - b[1])));
  const t0 = 0;
  const t1 = t0 + d(p0, p1);
  const t2 = t1 + d(p1, p2);
  const t3 = t2 + d(p2, p3);
  const t = t1 + (t2 - t1) * u;
  const lerp = (a: Vec2, b: Vec2, ta: number, tb: number): Vec2 => {
    const w = (t - ta) / (tb - ta || 1e-9);
    return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w];
  };
  const a1 = lerp(p0, p1, t0, t1);
  const a2 = lerp(p1, p2, t1, t2);
  const a3 = lerp(p2, p3, t2, t3);
  const b1 = lerp(a1, a2, t0, t2);
  const b2 = lerp(a2, a3, t1, t3);
  return lerp(b1, b2, t1, t2);
}

function bspline(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, u: number): Vec2 {
  const u2 = u * u;
  const u3 = u2 * u;
  const b0 = (1 - 3 * u + 3 * u2 - u3) / 6;
  const b1 = (4 - 6 * u2 + 3 * u3) / 6;
  const b2 = (1 + 3 * u + 3 * u2 - 3 * u3) / 6;
  const b3 = u3 / 6;
  return [b0 * p0[0] + b1 * p1[0] + b2 * p2[0] + b3 * p3[0], b0 * p0[1] + b1 * p1[1] + b2 * p2[1] + b3 * p3[1]];
}

/** Closest parameter on a primitive to a point (coarse sample + refinement). */
export function closestOnPrim(p: Prim, q: Vec2): { t: number; d: number; pt: Vec2 } {
  const n = Math.max(16, primSegments(p) * 2);
  let best = { t: 0, d: Infinity, pt: evalPrim(p, 0) };
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const pt = evalPrim(p, t);
    const d = Math.hypot(pt[0] - q[0], pt[1] - q[1]);
    if (d < best.d) best = { t, d, pt };
  }
  let step = 1 / n;
  for (let k = 0; k < 30; k++) {
    step /= 2;
    for (const t of [best.t - step, best.t + step]) {
      if (t < 0 || t > 1) continue;
      const pt = evalPrim(p, t);
      const d = Math.hypot(pt[0] - q[0], pt[1] - q[1]);
      if (d < best.d) best = { t, d, pt };
    }
  }
  return best;
}

export function polyArea(poly: Vec2[]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j][0] + poly[i][0]) * (poly[j][1] - poly[i][1]);
  return -a / 2;
}

export function polyCentroid(poly: Vec2[]): Vec2 {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const f = poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
    a += f;
    cx += (poly[j][0] + poly[i][0]) * f;
    cy += (poly[j][1] + poly[i][1]) * f;
  }
  if (Math.abs(a) < 1e-12) return poly[0] ?? [0, 0];
  return [cx / (3 * a), cy / (3 * a)];
}

export function pointInPoly(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
