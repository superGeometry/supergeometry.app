// Pure sketch-editing operations (no UI): trim, extend, offset, fillet,
// transforms, projection of 3D edges, and text outlines.

import type { PlaneDef, SketchConstraint, SketchEntity, Vec2, Vec3 } from "../doc/types";
import { roundSig, toPlane } from "../geom";
import { constraintError, pointOf, pointsOf, refsOf } from "./constraints";
import { arcFrom3, closestOnPrim, entityCorners, entityPrims, evalPrim, isClosedPrim, primSegments, samplePrim, type Prim } from "./curves";

export function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

// ------------------------------------------------------------- transforms

export type Xf = (p: Vec2) => Vec2;

export const translateXf = (dx: number, dy: number): Xf => (p) => [p[0] + dx, p[1] + dy];
export const rotateXf = (c: Vec2, ang: number): Xf => {
  const cs = Math.cos(ang);
  const sn = Math.sin(ang);
  return (p) => [c[0] + (p[0] - c[0]) * cs - (p[1] - c[1]) * sn, c[1] + (p[0] - c[0]) * sn + (p[1] - c[1]) * cs];
};
export const scaleXf = (c: Vec2, k: number): Xf => (p) => [c[0] + (p[0] - c[0]) * k, c[1] + (p[1] - c[1]) * k];
export const mirrorXf = (a: Vec2, b: Vec2): Xf => {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy || 1;
  return (p) => {
    const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
    const fx = a[0] + dx * t;
    const fy = a[1] + dy * t;
    return [2 * fx - p[0], 2 * fy - p[1]];
  };
};

/** Apply a point transform to an entity, keeping its kind where possible. */
export function transformEntity(e: SketchEntity, xf: Xf, newId = false): SketchEntity {
  const id = newId ? uid() : e.id;
  const base = { id, construction: e.construction };
  const o = xf([0, 0]);
  const ux = xf([1, 0]);
  const k = Math.hypot(ux[0] - o[0], ux[1] - o[1]); // uniform scale factor
  const rot = Math.atan2(ux[1] - o[1], ux[0] - o[0]);
  const vy = xf([0, 1]);
  const mirrored = (ux[0] - o[0]) * (vy[1] - o[1]) - (ux[1] - o[1]) * (vy[0] - o[0]) < 0;
  switch (e.kind) {
    case "line":
      return { ...base, kind: "line", a: xf(e.a), b: xf(e.b) };
    case "arc":
      return { ...base, kind: "arc", a: xf(e.a), m: xf(e.m), b: xf(e.b) };
    case "circle":
      return { ...base, kind: "circle", center: xf(e.center), radius: e.radius * k };
    case "ellipse":
      return { ...base, kind: "ellipse", center: xf(e.center), rx: e.rx * k, ry: e.ry * k, rotation: mirrored ? rot - e.rotation : e.rotation + rot };
    case "spline":
      return { ...base, kind: "spline", points: e.points.map(xf), closed: e.closed, mode: e.mode };
    case "rect":
      return { ...base, kind: "rect", center: xf(e.center), w: e.w * k, h: e.h * k, rotation: mirrored ? rot - e.rotation : e.rotation + rot };
    case "polygon": {
      const corner = xf(entityCorners(e)[0]);
      const c = xf(e.center);
      return { ...base, kind: "polygon", center: c, radius: e.radius * k, sides: e.sides, angle: Math.atan2(corner[1] - c[1], corner[0] - c[0]) };
    }
    case "polyline":
      return { ...base, kind: "polyline", points: e.points.map(xf), closed: e.closed };
  }
}

/** Characteristic points: endpoints, midpoints, centres (for snapping). */
export function guidePoints(e: SketchEntity): { p: Vec2; kind: "end" | "mid" | "center" }[] {
  const out: { p: Vec2; kind: "end" | "mid" | "center" }[] = [];
  switch (e.kind) {
    case "line":
      out.push({ p: e.a, kind: "end" }, { p: e.b, kind: "end" }, { p: [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2], kind: "mid" });
      break;
    case "arc": {
      out.push({ p: e.a, kind: "end" }, { p: e.b, kind: "end" });
      const c = arcFrom3(e.a, e.m, e.b);
      if (c) out.push({ p: c.c, kind: "center" });
      break;
    }
    case "circle":
    case "ellipse":
      out.push({ p: e.center, kind: "center" });
      for (const p of entityPrims(e)) for (const t of [0, 0.25, 0.5, 0.75]) out.push({ p: evalPrim(p, t), kind: "end" });
      break;
    case "spline":
      e.points.forEach((p) => out.push({ p, kind: "end" }));
      break;
    case "rect":
    case "polygon":
    case "polyline": {
      const pts = entityCorners(e);
      pts.forEach((p) => out.push({ p, kind: "end" }));
      for (let i = 0; i < pts.length - (e.kind === "polyline" && !e.closed ? 1 : 0); i++) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        out.push({ p: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], kind: "mid" });
      }
      if (e.kind !== "polyline") out.push({ p: e.center, kind: "center" });
    }
  }
  return out;
}

// -------------------------------------------------------- trim & extend

/** Turn rects/polygons/polylines into separate lines (needed before trimming one side). */
export function explode(e: SketchEntity): SketchEntity[] {
  if (e.kind !== "rect" && e.kind !== "polygon" && e.kind !== "polyline") return [e];
  return entityPrims(e).map((p) => ({ id: uid(), kind: "line", a: (p as { a: Vec2 }).a, b: (p as { b: Vec2 }).b, construction: e.construction }));
}

/** Parameters where other entities cross primitive `p`. */
function crossings(p: Prim, others: Prim[]): number[] {
  const ts: number[] = [];
  const n = Math.max(primSegments(p), 1) * 4;
  const A = Array.from({ length: n + 1 }, (_, i) => evalPrim(p, i / n));
  for (const q of others) {
    const m = Math.max(primSegments(q), 1) * 4;
    const B = Array.from({ length: m + 1 }, (_, i) => evalPrim(q, i / m));
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < m; j++) {
        const h = segHit2(A[i], A[i + 1], B[j], B[j + 1]);
        if (!h) continue;
        // The samples only find it roughly: put it exactly on both curves.
        const [t] = refineCrossing(p, q, (i + h[0]) / n, (j + h[1]) / m);
        if (t >= -1e-9 && t <= 1 + 1e-9) ts.push(Math.min(1, Math.max(0, t)));
      }
    }
    // A curve that ends right on p (e.g. an arc left by an earlier trim) counts
    // as a crossing there: its samples may stop just short of p's.
    if (!isClosedPrim(q)) {
      const size = Math.max(1, ...A.map((v) => Math.max(Math.abs(v[0]), Math.abs(v[1]))));
      for (const E of [evalPrim(q, 0), evalPrim(q, 1)]) {
        const c = closestOnPrim(p, E);
        if (c.d < size * 1e-7) ts.push(c.t);
      }
    }
  }
  return ts.sort((a, b) => a - b);
}

/**
 * Newton on P(t) = Q(s): a crossing found between samples, moved exactly onto
 * both curves (round curves are only approximated by their samples - a cut
 * there would leave a hair-thin gap). Straight pieces are exact already.
 */
function refineCrossing(p: Prim, q: Prim, t: number, s: number): [number, number] {
  const round = (x: Prim) => x.t === "circle" || x.t === "ellipse";
  if (!round(p) && !round(q)) return [t, s];
  const t0 = t;
  const s0 = s;
  const h = 1e-7;
  for (let it = 0; it < 30; it++) {
    const P = evalPrim(p, t);
    const Q = evalPrim(q, s);
    const fx = P[0] - Q[0];
    const fy = P[1] - Q[1];
    const Pt = evalPrim(p, t + h);
    const Qs = evalPrim(q, s + h);
    const a = (Pt[0] - P[0]) / h;
    const c = (Pt[1] - P[1]) / h;
    const b = -(Qs[0] - Q[0]) / h;
    const d = -(Qs[1] - Q[1]) / h;
    const det = a * d - b * c;
    if (Math.abs(det) < 1e-14) break;
    const dt = (d * fx - b * fy) / det;
    const ds = (-c * fx + a * fy) / det;
    t -= dt;
    s -= ds;
    if (Math.abs(dt) < 1e-15 && Math.abs(ds) < 1e-15) break;
  }
  // Wandered off to some other crossing (or nowhere): keep the rough one.
  if (!Number.isFinite(t) || !Number.isFinite(s) || Math.abs(t - t0) > 0.05 || Math.abs(s - s0) > 0.05) return [t0, s0];
  return [t, s];
}

/** Where segments ab and cd cross: fractions along each (null if they don't). */
function segHit2(a: Vec2, b: Vec2, c: Vec2, d: Vec2): [number, number] | null {
  const rx = b[0] - a[0];
  const ry = b[1] - a[1];
  const sx = d[0] - c[0];
  const sy = d[1] - c[1];
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-14) return null;
  const qx = c[0] - a[0];
  const qy = c[1] - a[1];
  const u = (qx * sy - qy * sx) / den;
  const v = (qx * ry - qy * rx) / den;
  return u >= -1e-9 && u <= 1 + 1e-9 && v >= -1e-9 && v <= 1 + 1e-9 ? [u, v] : null;
}

function segHit(a: Vec2, b: Vec2, c: Vec2, d: Vec2): number | null {
  const rx = b[0] - a[0];
  const ry = b[1] - a[1];
  const sx = d[0] - c[0];
  const sy = d[1] - c[1];
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-14) return null;
  const qx = c[0] - a[0];
  const qy = c[1] - a[1];
  const u = (qx * sy - qy * sx) / den;
  const v = (qx * ry - qy * rx) / den;
  return u >= -1e-9 && u <= 1 + 1e-9 && v >= -1e-9 && v <= 1 + 1e-9 ? u : null;
}

/** Remove the piece of `id` under `at` that lies between crossings. Returns the new entity list. */
export function trim(entities: SketchEntity[], id: string, at: Vec2): SketchEntity[] {
  let list = entities;
  let target = list.find((e) => e.id === id);
  if (!target) return entities;
  // Straight-sided shapes: trim the one side that was tapped.
  if (target.kind === "rect" || target.kind === "polygon" || target.kind === "polyline") {
    const parts = explode(target);
    list = list.flatMap((e) => (e.id === id ? parts : [e]));
    target = parts.reduce((best, e) => (closestOnPrim(entityPrims(e)[0], at).d < closestOnPrim(entityPrims(best)[0], at).d ? e : best));
  }
  const prim = entityPrims(target)[0];
  const others = list.filter((e) => e.id !== target!.id && !e.construction).flatMap(entityPrims);
  const ts = crossings(prim, others).filter((t, i, a) => i === 0 || t - a[i - 1] > 1e-6);
  const tap = closestOnPrim(prim, at).t;
  const closed = isClosedPrim(prim);
  const keep: [number, number][] = [];
  if (closed) {
    if (ts.length < 2) return list.filter((e) => e.id !== target!.id);
    // The removed piece is between the crossings around the tap (cyclically).
    let lo = ts[ts.length - 1] - 1;
    let hi = ts[0];
    for (let i = 0; i < ts.length - 1; i++) if (tap >= ts[i] && tap <= ts[i + 1]) ((lo = ts[i]), (hi = ts[i + 1]));
    if (tap > ts[ts.length - 1]) ((lo = ts[ts.length - 1]), (hi = ts[0] + 1));
    keep.push([hi, lo + 1]);
  } else {
    const cuts = [0, ...ts.filter((t) => t > 1e-6 && t < 1 - 1e-6), 1];
    for (let i = 0; i < cuts.length - 1; i++) if (!(tap >= cuts[i] && tap <= cuts[i + 1])) keep.push([cuts[i], cuts[i + 1]]);
  }
  const pieces = keep.map(([t0, t1]) => {
    const piece = pieceEntity(prim, t0, t1, target!.construction);
    // An end that wasn't cut stays exactly where it was (not re-evaluated).
    if (!closed && (piece.kind === "line" || piece.kind === "arc") && (target!.kind === "line" || target!.kind === "arc")) {
      if (t0 === 0) piece.a = target!.a;
      if (t1 === 1) piece.b = target!.b;
    }
    return piece;
  });
  // The piece that keeps the start (or the only one left) keeps the curve's id,
  // so what's tied to it stays tied (see carryConstraints).
  if (pieces.length) {
    const i = closed ? 0 : Math.max(0, keep.findIndex(([t0]) => t0 === 0));
    pieces[i] = { ...pieces[i], id: target.id };
  }
  return list.flatMap((e) => (e.id === target!.id ? pieces : [e]));
}

/** Entity for part [t0, t1] of a primitive (t may exceed 1 for closed curves). */
function pieceEntity(p: Prim, t0: number, t1: number, construction?: boolean): SketchEntity {
  const at = (t: number) => evalPrim(p, isClosedPrim(p) && p.t !== "spline" ? t : Math.min(1, t > 1 ? t - 1 : t));
  if (p.t === "line") return { id: uid(), kind: "line", a: at(t0), b: at(t1), construction };
  if (p.t === "circle") return { id: uid(), kind: "arc", a: at(t0), m: at((t0 + t1) / 2), b: at(t1), construction };
  // Ellipses and splines: keep shape as a fit spline through samples.
  const n = 12;
  const pts = Array.from({ length: n + 1 }, (_, i) => at(t0 + ((t1 - t0) * i) / n));
  return { id: uid(), kind: "spline", points: pts, closed: false, mode: "fit", construction };
}

/**
 * Extend the end of a line or arc nearest `at` to the next curve it would hit:
 * a line straight on, an arc along its own circle.
 */
export function extend(entities: SketchEntity[], id: string, at: Vec2): SketchEntity[] | null {
  const e = entities.find((x) => x.id === id);
  if (!e || (e.kind !== "line" && e.kind !== "arc")) return null;
  const endB = Math.hypot(at[0] - e.b[0], at[1] - e.b[1]) < Math.hypot(at[0] - e.a[0], at[1] - e.a[1]);
  const others = entities.filter((x) => x.id !== id && !x.construction).flatMap(entityPrims);
  let path: Prim;
  if (e.kind === "line") {
    const from = endB ? e.b : e.a;
    const other = endB ? e.a : e.b;
    const dx = from[0] - other[0];
    const dy = from[1] - other[1];
    const L = Math.hypot(dx, dy) || 1;
    // Far enough to pass everything in the sketch (and short enough to refine on).
    let reach = 1;
    for (const x of entities) for (const p of pointsOf(x)) reach = Math.max(reach, Math.hypot(p.at[0] - from[0], p.at[1] - from[1]));
    for (const q of others) for (let i = 0; i <= 8; i++) {
      const p = evalPrim(q, i / 8);
      reach = Math.max(reach, Math.hypot(p[0] - from[0], p[1] - from[1]));
    }
    reach *= 3;
    path = { t: "line", a: from, b: [from[0] + (dx / L) * reach, from[1] + (dy / L) * reach], src: "" };
  } else {
    const c = arcFrom3(e.a, e.m, e.b);
    if (!c) return null;
    // On round its circle from that end, the way the arc runs, up to its other end.
    const dir = endB ? Math.sign(c.sweep) : -Math.sign(c.sweep);
    const start = endB ? c.a0 + c.sweep : c.a0;
    path = { t: "circle", c: c.c, r: c.r, a0: start, sweep: dir * (2 * Math.PI - Math.abs(c.sweep)), src: "" };
  }
  const ts = crossings(path, others).filter((t) => t > 1e-9);
  if (!ts.length) return null;
  const to = evalPrim(path, ts[0]);
  if (e.kind === "line") return entities.map((x) => (x.id === id ? { ...e, ...(endB ? { b: to } : { a: to }) } : x));
  return entities.map((x) => (x.id === id ? moveEnd(e, endB ? "b" : "a", to) : x));
}

/** Which end of an open curve the pick is nearer to ("a" or "b"); null for closed curves. */
export function endNear(e: SketchEntity, at: Vec2): "a" | "b" | null {
  const se = splineEnds(e);
  if (se) return Math.hypot(at[0] - se[0][0], at[1] - se[0][1]) <= Math.hypot(at[0] - se[1][0], at[1] - se[1][1]) ? "a" : "b";
  if (e.kind !== "line" && e.kind !== "arc") return null;
  return Math.hypot(at[0] - e.a[0], at[1] - e.a[1]) <= Math.hypot(at[0] - e.b[0], at[1] - e.b[1]) ? "a" : "b";
}

type Carrier = { kind: "line"; p: Vec2; d: Vec2 } | { kind: "circle"; c: Vec2; r: number };

type Piece = Extract<SketchEntity, { kind: "line" | "arc" | "spline" }>;

/** Where an open spline starts and ends (its real curve ends). */
export function splineEnds(e: SketchEntity): [Vec2, Vec2] | null {
  if (e.kind !== "spline" || e.closed || e.points.length < 2) return null;
  const p = entityPrims(e)[0];
  return [evalPrim(p, 0), evalPrim(p, 1)];
}

/** The same curve run the other way. */
function reverseIf(e: SketchEntity, rev: boolean): SketchEntity {
  if (!rev) return e;
  if (e.kind === "line" || e.kind === "arc") return { ...e, a: e.b, b: e.a } as SketchEntity;
  if (e.kind === "spline") return { ...e, points: [...e.points].reverse() };
  return e;
}

/** Point on a circle in the direction of q. */
function towards(c: Vec2, q: Vec2, r: number): Vec2 {
  const L = Math.hypot(q[0] - c[0], q[1] - c[1]) || 1;
  return [c[0] + ((q[0] - c[0]) / L) * r, c[1] + ((q[1] - c[1]) / L) * r];
}

/** A spline end's tangent as a line carrier (to carry it on straight). */
function splineEndCarrier(e: SketchEntity, end: "a" | "b"): Carrier | null {
  if (e.kind !== "spline") return null;
  const p = entityPrims(e)[0];
  const q = evalPrim(p, end === "a" ? 0 : 1);
  const r = evalPrim(p, end === "a" ? 0.01 : 0.99);
  return { kind: "line", p: q, d: [q[0] - r[0], q[1] - r[1]] };
}

function carrierOf(e: SketchEntity): Carrier | null {
  if (e.kind === "line") return { kind: "line", p: e.a, d: [e.b[0] - e.a[0], e.b[1] - e.a[1]] };
  if (e.kind === "arc") {
    const c = arcFrom3(e.a, e.m, e.b);
    return c ? { kind: "circle", c: c.c, r: c.r } : null;
  }
  return null;
}

/** Where two infinite lines / full circles cross. */
function carrierCrossings(u: Carrier, v: Carrier): Vec2[] {
  if (u.kind === "circle" && v.kind === "line") return carrierCrossings(v, u);
  if (u.kind === "line" && v.kind === "line") {
    const det = u.d[0] * v.d[1] - u.d[1] * v.d[0];
    if (Math.abs(det) < 1e-12 * (Math.hypot(...u.d) * Math.hypot(...v.d) || 1)) return [];
    const t = ((v.p[0] - u.p[0]) * v.d[1] - (v.p[1] - u.p[1]) * v.d[0]) / det;
    return [[u.p[0] + u.d[0] * t, u.p[1] + u.d[1] * t]];
  }
  if (u.kind === "line" && v.kind === "circle") {
    const L = Math.hypot(...u.d) || 1;
    const d: Vec2 = [u.d[0] / L, u.d[1] / L];
    const f: Vec2 = [u.p[0] - v.c[0], u.p[1] - v.c[1]];
    const b = f[0] * d[0] + f[1] * d[1];
    const disc = b * b - (f[0] * f[0] + f[1] * f[1] - v.r * v.r);
    if (disc < -1e-12) return [];
    const s = Math.sqrt(Math.max(0, disc));
    return [-b - s, -b + s].map((t) => [u.p[0] + d[0] * t, u.p[1] + d[1] * t] as Vec2);
  }
  if (u.kind === "circle" && v.kind === "circle") {
    const dx = v.c[0] - u.c[0];
    const dy = v.c[1] - u.c[1];
    const D = Math.hypot(dx, dy);
    if (D < 1e-12 || D > u.r + v.r + 1e-9 || D < Math.abs(u.r - v.r) - 1e-9) return [];
    const a = (u.r * u.r - v.r * v.r + D * D) / (2 * D);
    const h = Math.sqrt(Math.max(0, u.r * u.r - a * a));
    const m: Vec2 = [u.c[0] + (dx * a) / D, u.c[1] + (dy * a) / D];
    return [
      [m[0] - (dy * h) / D, m[1] + (dx * h) / D],
      [m[0] + (dy * h) / D, m[1] - (dx * h) / D],
    ];
  }
  return [];
}

/** Move one end of a line/arc to `to` (an arc keeps its circle and its other end). */
function moveEnd(e: SketchEntity, end: "a" | "b", to: Vec2): SketchEntity {
  if (e.kind === "line") return { ...e, [end]: to };
  if (e.kind === "spline" && !e.closed) {
    // The end fit point moves there.
    const pts = [...e.points];
    pts[end === "a" ? 0 : pts.length - 1] = to;
    return { ...e, points: pts };
  }
  if (e.kind !== "arc") return e;
  const c = arcFrom3(e.a, e.m, e.b);
  if (!c) return e;
  const ang = (q: Vec2) => Math.atan2(q[1] - c.c[1], q[0] - c.c[0]);
  const a = end === "a" ? to : e.a;
  const b = end === "b" ? to : e.b;
  // Keep the arc's turning direction; the new mid point halves the new sweep.
  const dir = Math.sign(c.sweep) || 1;
  let sweep = ang(b) - ang(a);
  while (dir > 0 && sweep <= 1e-9) sweep += 2 * Math.PI;
  while (dir < 0 && sweep >= -1e-9) sweep -= 2 * Math.PI;
  const t = ang(a) + sweep / 2;
  return { ...e, a, b, m: [c.c[0] + c.r * Math.cos(t), c.c[1] + c.r * Math.sin(t)] };
}

/**
 * Extend (or trim) two open curves so the picked ends meet: each pick says
 * which end (the half that was tapped). Lines run along their direction,
 * arcs along their circle. Picking both halves of one arc closes it into a circle.
 */
export function joinEnds(entities: SketchEntity[], first: { id: string; at: Vec2 }, second: { id: string; at: Vec2 }): SketchEntity[] | null {
  const e1 = entities.find((x) => x.id === first.id);
  const e2 = entities.find((x) => x.id === second.id);
  if (!e1 || !e2) return null;
  const end1 = endNear(e1, first.at);
  const end2 = endNear(e2, second.at);
  if (!end1 || !end2) return null;
  if (e1.id === e2.id) {
    if (e1.kind !== "arc" || end1 === end2) return null;
    const c = arcFrom3(e1.a, e1.m, e1.b);
    if (!c) return null;
    const circle: SketchEntity = { id: e1.id, kind: "circle", center: c.c, radius: c.r, construction: e1.construction };
    return entities.map((x) => (x.id === e1.id ? circle : x));
  }
  // A spline end carries on along its end tangent.
  const k1 = carrierOf(e1) ?? splineEndCarrier(e1, end1);
  const k2 = carrierOf(e2) ?? splineEndCarrier(e2, end2);
  if (!k1 || !k2) return null;
  const endPt = (e: SketchEntity, k: "a" | "b"): Vec2 => splineEnds(e)?.[k === "a" ? 0 : 1] ?? (e as Extract<SketchEntity, { kind: "line" | "arc" }>)[k];
  const p1 = endPt(e1, end1);
  const p2 = endPt(e2, end2);
  // A line running into a spline (as it is, or carried on): it stops on the spline itself.
  if ((e1.kind === "spline") !== (e2.kind === "spline")) {
    const [ln, lnEnd, sp] = e1.kind === "spline" ? [e2, end2, e1] : [e1, end1, e2];
    if (ln.kind === "line") {
      const from = ln[lnEnd];
      const other = lnEnd === "a" ? ln.b : ln.a;
      const L = Math.hypot(from[0] - other[0], from[1] - other[1]) || 1;
      const dir: Vec2 = [(from[0] - other[0]) / L, (from[1] - other[1]) / L];
      const A: Vec2 = [other[0] - dir[0] * 1e6, other[1] - dir[1] * 1e6];
      const B: Vec2 = [from[0] + dir[0] * 1e6, from[1] + dir[1] * 1e6];
      const pts = samplePrim(entityPrims(sp)[0], 0, 1);
      let best: Vec2 | null = null;
      let bd = Infinity;
      for (let i = 0; i < pts.length - 1; i++) {
        const u = segHit(A, B, pts[i], pts[i + 1]);
        if (u === null) continue;
        const q: Vec2 = [A[0] + (B[0] - A[0]) * u, A[1] + (B[1] - A[1]) * u];
        const dd = Math.hypot(q[0] - from[0], q[1] - from[1]);
        if (dd < bd) [bd, best] = [dd, q];
      }
      if (best) return entities.map((x) => (x.id === ln.id ? moveEnd(ln, lnEnd, best!) : x));
    }
  }
  const cands = carrierCrossings(k1, k2);
  if (!cands.length) return null;
  // The meeting point nearest both picked ends.
  const cost = (q: Vec2) => Math.hypot(q[0] - p1[0], q[1] - p1[1]) + Math.hypot(q[0] - p2[0], q[1] - p2[1]);
  const to = cands.reduce((m, q) => (cost(q) < cost(m) ? q : m), cands[0]);
  // A spline carries on to the meeting point (it becomes its new end point).
  const reach = (e: SketchEntity, end: "a" | "b"): SketchEntity => {
    if (e.kind !== "spline") return moveEnd(e, end, to);
    return { ...e, points: end === "a" ? [to, ...e.points] : [...e.points, to] };
  };
  return entities.map((x) => (x.id === e1.id ? reach(e1, end1) : x.id === e2.id ? reach(e2, end2) : x));
}

/**
 * Cut a line or arc in two: at its midpoint, or at the point nearest `at`.
 * The second piece gets `newId`; returns null for other curves.
 */
export function splitEntity(entities: SketchEntity[], id: string, newId: string, at?: Vec2): SketchEntity[] | null {
  const e = entities.find((x) => x.id === id);
  if (!e) return null;
  if (e.kind === "line") {
    const d: Vec2 = [e.b[0] - e.a[0], e.b[1] - e.a[1]];
    const L2 = d[0] * d[0] + d[1] * d[1];
    let t = 0.5;
    if (at && L2 > 0) t = ((at[0] - e.a[0]) * d[0] + (at[1] - e.a[1]) * d[1]) / L2;
    if (!(t > 1e-6 && t < 1 - 1e-6)) return null;
    const m: Vec2 = [e.a[0] + d[0] * t, e.a[1] + d[1] * t];
    return entities.flatMap((x) => (x.id === id ? [{ ...e, b: m }, { ...e, id: newId, a: m }] : [x]));
  }
  if (e.kind === "arc") {
    const c = arcFrom3(e.a, e.m, e.b);
    if (!c) return null;
    let t = 0.5;
    if (at) {
      const ang = Math.atan2(at[1] - c.c[1], at[0] - c.c[0]);
      let f = (ang - c.a0) / c.sweep;
      // Bring the angle into the arc's own sweep.
      const turn = (2 * Math.PI) / Math.abs(c.sweep);
      while (f < 0) f += turn;
      while (f > 1 && f - turn >= 0) f -= turn;
      t = f;
    }
    if (!(t > 1e-6 && t < 1 - 1e-6)) return null;
    const pt = (u: number): Vec2 => [c.c[0] + c.r * Math.cos(c.a0 + c.sweep * u), c.c[1] + c.r * Math.sin(c.a0 + c.sweep * u)];
    const m = pt(t);
    return entities.flatMap((x) => (x.id === id ? [{ ...e, m: pt(t / 2), b: m }, { ...e, id: newId, a: m, m: pt((1 + t) / 2) }] : [x]));
  }
  return null;
}

/**
 * Where the grid (lines every `step`) crosses curve `e`, nearest to `at`; or
 * simply the curve's point nearest `at` if no grid line crosses it.
 */
export function gridPointOn(e: SketchEntity, at: Vec2, step: number): Vec2 {
  let best: { p: Vec2; d: number } | null = null;
  const consider = (p: Vec2) => {
    const d = Math.hypot(p[0] - at[0], p[1] - at[1]);
    if (!best || d < best.d) best = { p, d };
  };
  for (const prim of entityPrims(e)) {
    const n = Math.max(primSegments(prim), 1) * 4;
    const poly = Array.from({ length: n + 1 }, (_, i) => evalPrim(prim, i / n));
    for (let i = 0; i < n; i++) {
      const [a, b] = [poly[i], poly[i + 1]];
      for (const k of [0, 1] as const) {
        if (Math.abs(b[k] - a[k]) < 1e-12) continue;
        const lo = Math.min(a[k], b[k]);
        const hi = Math.max(a[k], b[k]);
        for (let g = Math.ceil(lo / step) * step; g <= hi; g += step) {
          // Onto the curve itself (not the straight piece between samples): halve the step until it sits on the grid line.
          let t0 = i / n;
          let t1 = (i + 1) / n;
          const f = (t: number) => evalPrim(prim, t)[k] - g;
          let f0 = f(t0);
          for (let it = 0; it < 50; it++) {
            const tm = (t0 + t1) / 2;
            const fm = f(tm);
            if (Math.sign(fm) === Math.sign(f0)) ((t0 = tm), (f0 = fm));
            else t1 = tm;
          }
          consider(evalPrim(prim, (t0 + t1) / 2));
        }
      }
    }
  }
  if (best) return (best as { p: Vec2 }).p;
  const prim = entityPrims(e)[0];
  return prim ? closestOnPrim(prim, at).pt : at;
}

/**
 * Split any curve where it's tapped. Lines: in half (or right at `at` with
 * `exact`). Straight-sided shapes (rectangle, polygon, outline): they come
 * apart into lines and the tapped side is split in half. Curves (arcs,
 * circles, ellipses, splines): where the grid crosses them, nearest the tap.
 * Returns the new list and the ids of the pieces.
 */
export function splitAny(entities: SketchEntity[], id: string, at: Vec2, step: number, exact: boolean, newId: () => string): { entities: SketchEntity[]; parts: string[]; exploded: boolean } | null {
  const e = entities.find((x) => x.id === id);
  if (!e) return null;
  if (e.kind === "line") {
    const n = newId();
    const out = splitEntity(entities, id, n, exact ? at : undefined);
    return out && { entities: out, parts: [id, n], exploded: false };
  }
  if (e.kind === "rect" || e.kind === "polygon" || e.kind === "polyline") {
    const sides = explode(e);
    const side = sides.reduce((m, x) => (closestOnPrim(entityPrims(x)[0], at).d < closestOnPrim(entityPrims(m)[0], at).d ? x : m));
    const list = entities.flatMap((x) => (x.id === id ? sides : [x]));
    const n = newId();
    const out = splitEntity(list, side.id, n, exact ? at : undefined);
    return out && { entities: out, parts: [...sides.map((x) => x.id), n], exploded: true };
  }
  const P = exact ? closestOnPrim(entityPrims(e)[0], at).pt : gridPointOn(e, at, step);
  if (e.kind === "arc") {
    const n = newId();
    const out = splitEntity(entities, id, n, P);
    return out && { entities: out, parts: [id, n], exploded: false };
  }
  if (e.kind === "circle") {
    // A whole circle: two half circles, meeting at the split point and opposite it.
    const t = Math.atan2(P[1] - e.center[1], P[0] - e.center[0]);
    const pt = (a: number): Vec2 => [e.center[0] + e.radius * Math.cos(a), e.center[1] + e.radius * Math.sin(a)];
    const n = newId();
    const a1: SketchEntity = { id, kind: "arc", a: pt(t), m: pt(t + Math.PI / 2), b: pt(t + Math.PI), construction: e.construction };
    const a2: SketchEntity = { id: n, kind: "arc", a: pt(t + Math.PI), m: pt(t + (3 * Math.PI) / 2), b: pt(t), construction: e.construction };
    return { entities: entities.flatMap((x) => (x.id === id ? [a1, a2] : [x])), parts: [id, n], exploded: true };
  }
  if (e.kind === "ellipse" || e.kind === "spline") {
    // An ellipse becomes a smooth closed spline through 12 of its points first.
    const prim = entityPrims(e)[0];
    let pts: Vec2[];
    let closed: boolean;
    let mode: "fit" | "control" = "fit";
    if (e.kind === "spline") {
      pts = e.points;
      closed = e.closed;
      mode = e.mode;
    } else {
      pts = Array.from({ length: 12 }, (_, i) => evalPrim(prim, i / 12));
      closed = true;
    }
    // The span the point is on (spans run between consecutive points).
    const T = closestOnPrim(prim, P).t;
    const spans = closed ? pts.length : pts.length - 1;
    const s = Math.max(0, Math.min(spans - 1, Math.floor(T * spans + 1e-9)));
    if (closed) {
      // A closed loop opens up at that point (one piece, both ends there).
      const ring = [...pts.slice(s + 1), ...pts.slice(0, s + 1)];
      const open: SketchEntity = { id, kind: "spline", points: [P, ...ring, P], closed: false, mode, construction: e.construction };
      return { entities: entities.map((x) => (x.id === id ? open : x)), parts: [id], exploded: true };
    }
    const n = newId();
    const first: SketchEntity = { id, kind: "spline", points: [...pts.slice(0, s + 1), P], closed: false, mode, construction: e.construction };
    const second: SketchEntity = { id: n, kind: "spline", points: [P, ...pts.slice(s + 1)], closed: false, mode, construction: e.construction };
    return { entities: entities.flatMap((x) => (x.id === id ? [first, second] : [x])), parts: [id, n], exploded: false };
  }
  return null;
}

/**
 * Fillet two lines picked by their halves: first they're extended/trimmed to
 * meet (like `joinEnds`), then the corner is rounded with radius `r`.
 */
export function filletEnds(entities: SketchEntity[], first: { id: string; at: Vec2 }, second: { id: string; at: Vec2 }, r: number): SketchEntity[] | null {
  const e1 = entities.find((x) => x.id === first.id);
  const e2 = entities.find((x) => x.id === second.id);
  if (e1?.kind !== "line" || e2?.kind !== "line" || e1.id === e2.id) return null;
  const joined = joinEnds(entities, first, second);
  if (!joined) return null;
  const end = endNear(e1, first.at)!;
  const corner = (joined.find((x) => x.id === e1.id) as Extract<SketchEntity, { kind: "line" }>)[end];
  const size = Math.max(Math.hypot(e1.b[0] - e1.a[0], e1.b[1] - e1.a[1]), Math.hypot(e2.b[0] - e2.a[0], e2.b[1] - e2.a[1]), 1);
  return filletCorner(joined, corner, r, size * 1e-7);
}

/**
 * Turn line `id2` so it makes `deg` degrees with line `id1`, about its end
 * nearest to line 1. Both lines are re-oriented to point away from where they
 * (would) meet, so their a→b directions span exactly that angle; `swapped`
 * lists lines whose ends were exchanged (point refs a/b must follow).
 */
export function angleLines(entities: SketchEntity[], id1: string, id2: string, deg: number): { entities: SketchEntity[]; swapped: string[] } | null {
  const l1 = entities.find((e) => e.id === id1);
  const l2 = entities.find((e) => e.id === id2);
  if (l1?.kind !== "line" || l2?.kind !== "line" || id1 === id2) return null;
  const d1raw: Vec2 = [l1.b[0] - l1.a[0], l1.b[1] - l1.a[1]];
  const L1 = Math.hypot(...d1raw);
  if (L1 < 1e-12) return null;
  // Pivot: the end of line 2 closest to line 1 (its infinite line).
  const off = (q: Vec2) => Math.abs((q[0] - l1.a[0]) * d1raw[1] - (q[1] - l1.a[1]) * d1raw[0]) / L1;
  const pivotIsA = off(l2.a) <= off(l2.b);
  const pivot = pivotIsA ? l2.a : l2.b;
  const far = pivotIsA ? l2.b : l2.a;
  const d2: Vec2 = [far[0] - pivot[0], far[1] - pivot[1]];
  const L2 = Math.hypot(...d2);
  if (L2 < 1e-12) return null;
  // Line 1 points away from the meeting point (its far end from line 2's pivot).
  const da = Math.hypot(l1.a[0] - pivot[0], l1.a[1] - pivot[1]);
  const db = Math.hypot(l1.b[0] - pivot[0], l1.b[1] - pivot[1]);
  const flip1 = db < da;
  const u: Vec2 = flip1 ? [-d1raw[0] / L1, -d1raw[1] / L1] : [d1raw[0] / L1, d1raw[1] / L1];
  // Keep the side line 2 is on now (counter-clockwise or clockwise from line 1).
  const side = u[0] * d2[1] - u[1] * d2[0] >= 0 ? 1 : -1;
  const t = Math.atan2(u[1], u[0]) + side * (deg * Math.PI) / 180;
  const nf: Vec2 = [pivot[0] + Math.cos(t) * L2, pivot[1] + Math.sin(t) * L2];
  const swapped: string[] = [];
  if (flip1) swapped.push(id1);
  if (!pivotIsA) swapped.push(id2);
  return {
    entities: entities.map((e) => (e.id === id1 && flip1 ? { ...l1, a: l1.b, b: l1.a } : e.id === id2 ? { ...l2, a: pivot, b: nf } : e)),
    swapped,
  };
}

/** A curve with open ends (line/arc), walked in the chain's direction. */
export interface ChainLink {
  id: string;
  /** Walked b→a rather than a→b. */
  reversed: boolean;
}

/**
 * Curves joined end to end with `id` (lines and arcs), in order. `closed`
 * when the last one comes back to where the first started.
 */
export function connectedChain(entities: SketchEntity[], id: string): { links: ChainLink[]; closed: boolean } | null {
  // Lines, arcs and open splines, by their two ends.
  type Open = { id: string; a: Vec2; b: Vec2 };
  const open: Open[] = entities.flatMap((e) => {
    if (e.construction) return [];
    if (e.kind === "line" || e.kind === "arc") return [{ id: e.id, a: e.a, b: e.b }];
    const ends = splineEnds(e);
    return ends ? [{ id: e.id, a: ends[0], b: ends[1] }] : [];
  });
  const start = open.find((e) => e.id === id);
  if (!start) return null;
  const size = Math.max(1, ...open.flatMap((e) => [Math.abs(e.a[0]), Math.abs(e.a[1]), Math.abs(e.b[0]), Math.abs(e.b[1])]));
  const tol = size * 1e-7;
  const same = (p: Vec2, q: Vec2) => Math.hypot(p[0] - q[0], p[1] - q[1]) < tol;
  const used = new Set([start.id]);
  const walk = (from: Vec2): ChainLink[] => {
    const out: ChainLink[] = [];
    let at = from;
    for (;;) {
      const next = open.find((e) => !used.has(e.id) && (same(e.a, at) || same(e.b, at)));
      if (!next) return out;
      used.add(next.id);
      const reversed = !same(next.a, at);
      out.push({ id: next.id, reversed });
      at = reversed ? next.a : next.b;
    }
  };
  const forward = walk(start.b);
  const last = forward.length ? open.find((e) => e.id === forward[forward.length - 1].id)! : start;
  const lastEnd = forward.length ? (forward[forward.length - 1].reversed ? last.a : last.b) : start.b;
  const closed = forward.length > 0 && same(lastEnd, start.a);
  // Not closed: also walk backwards from the start, then flip that part.
  const backward = closed ? [] : walk(start.a).reverse().map((l) => ({ ...l, reversed: !l.reversed }));
  return { links: [...backward, { id: start.id, reversed: false }, ...forward], closed };
}

/**
 * Offset a whole chain (e.g. a closed outline made of lines and arcs) by `d`:
 * each piece moves sideways and neighbours are trimmed/extended to meet again,
 * so a closed shape stays closed. Positive `d` grows a closed shape outward.
 */
export function offsetChain(entities: SketchEntity[], id: string, d: number): SketchEntity[] | null {
  const chain = connectedChain(entities, id);
  if (!chain) return null;
  const byId = new Map(entities.map((e) => [e.id, e]));
  // Walk direction: flip pieces walked backwards so every piece runs along the chain.
  const pieces = chain.links.map((l) => reverseIf(byId.get(l.id)!, l.reversed) as Piece);
  // Outward is to the right of a counter-clockwise loop (offsetEntity goes left).
  let side = 1;
  if (chain.closed) {
    const poly = pieces.flatMap((e) => (e.kind === "arc" ? [e.a, e.m] : e.kind === "spline" ? samplePrim(entityPrims(e)[0], 0, 1).slice(0, -1) : [e.a]));
    let area = 0;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      area += p[0] * q[1] - q[0] * p[1];
    }
    side = area > 0 ? -1 : 1;
  }
  // offsetEntity moves lines to their left but arcs always outward: an arc
  // turning left (counter-clockwise) has its left side towards its centre.
  const leftOf = (e: Piece) => (e.kind === "arc" && (arcFrom3(e.a, e.m, e.b)?.sweep ?? 0) > 0 ? -1 : 1);
  const endOf = (e: Piece, k: "a" | "b"): Vec2 => (e.kind === "spline" ? splineEnds(e)![k === "a" ? 0 : 1] : e[k]);
  const lenOf = (e: Piece) => (e.kind === "line" ? Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]) : 1);
  let size = 1;
  for (const e of pieces) for (const k of ["a", "b"] as const) size = Math.max(size, Math.abs(endOf(e, k)[0]), Math.abs(endOf(e, k)[1]));
  // Pieces that would shrink past nothing (a fillet offset inward beyond its
  // radius, a side squeezed out between its neighbours) drop out, and their
  // neighbours meet straight away - like a CAD offset, not an inside-out loop.
  let alive = pieces.map((_, i) => i);
  let out: Piece[] = [];
  for (let round = 0; round <= pieces.length; round++) {
    if (alive.length < (chain.closed ? 2 : 1)) return null;
    const moved = alive.map((i) => offsetEntity(pieces[i], leftOf(pieces[i]) * side * d) as Piece | null);
    const gone = alive.filter((_, k) => !moved[k]);
    if (gone.length) {
      alive = alive.filter((i) => !gone.includes(i));
      continue;
    }
    out = moved as Piece[];
    // Re-join neighbours where their offset carriers cross, nearest the original corner.
    const n = out.length;
    for (let i = 0; i < (chain.closed ? n : n - 1); i++) {
      const j = (i + 1) % n;
      const k1 = carrierOf(out[i]);
      const k2 = carrierOf(out[j]);
      const corner = endOf(pieces[alive[i]], "b");
      let meet: Vec2 | null = null;
      if (k1 && k2) {
        const cands = carrierCrossings(k1, k2);
        if (cands.length) meet = cands.reduce((m, q) => (Math.hypot(q[0] - corner[0], q[1] - corner[1]) < Math.hypot(m[0] - corner[0], m[1] - corner[1]) ? q : m), cands[0]);
      } else if (k1 || k2) {
        // A spline next to a line/arc: the spline's offset end, brought onto the other's carrier.
        const k = (k1 ?? k2)!;
        const q = k1 ? endOf(out[j], "a") : endOf(out[i], "b");
        meet = k.kind === "line" ? projectOnLine(q, k.p, [k.p[0] + k.d[0], k.p[1] + k.d[1]]) : towards(k.c, q, k.r);
      } else {
        // Two splines: halfway between their offset ends.
        const p = endOf(out[i], "b");
        const q = endOf(out[j], "a");
        meet = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
      }
      // Neighbours that no longer meet (parallel after a piece between them went): no outline.
      if (!meet && alive[j] !== (alive[i] + 1) % pieces.length) return null;
      // Tangent neighbours (e.g. line into a fillet) already meet: keep the offset end.
      if (!meet) meet = endOf(out[i], "b");
      out[i] = moveEnd(out[i], "b", meet) as (typeof out)[number];
      out[j] = moveEnd(out[j], "a", meet) as (typeof out)[number];
    }
    // Turned round or squeezed to nothing: that piece goes, and again.
    const flipped = alive.filter((src, k) => {
      const o = out[k];
      const e = pieces[src];
      if (o.kind === "line" && e.kind === "line") {
        const dot = (o.b[0] - o.a[0]) * (e.b[0] - e.a[0]) + (o.b[1] - o.a[1]) * (e.b[1] - e.a[1]);
        return dot <= 0 || lenOf(o) < size * 1e-9;
      }
      if (o.kind === "arc" && e.kind === "arc") {
        const c0 = arcFrom3(e.a, e.m, e.b);
        const c1 = arcFrom3(o.a, o.m, o.b);
        return !c0 || !c1 || Math.sign(c0.sweep) !== Math.sign(c1.sweep) || Math.abs(c1.sweep) > Math.abs(c0.sweep) + Math.PI / 2 || Math.hypot(o.b[0] - o.a[0], o.b[1] - o.a[1]) < size * 1e-9;
      }
      return false;
    });
    if (!flipped.length) break;
    alive = alive.filter((i) => !flipped.includes(i));
  }
  // Straight pieces: what still runs closer to the outline than the distance
  // (across a narrow spike or neck it swung past the far side) is cut away -
  // the offset never crosses the original.
  if (out.every((e) => e.kind === "line") && pieces.every((e) => e.kind === "line")) {
    const clean = cleanLineOffset(pieces as Extract<SketchEntity, { kind: "line" }>[], out as Extract<SketchEntity, { kind: "line" }>[], d, chain.closed);
    if (!clean) return null;
    return [...entities, ...clean.map((e) => ({ ...e, id: uid() }))];
  }
  return [...entities, ...out.map((e) => ({ ...e, id: uid() }))];
}

/**
 * The offset of straight pieces, cut where it crosses itself, keeping only the
 * parts at least the distance from the original (and, for a closed outline, on
 * the side it was offset to) - joined up again into one or more outlines.
 * `grow` > 0: a closed outline grows (the offset is outside it).
 */
function cleanLineOffset(orig: LineE[], off: LineE[], grow: number, closed: boolean): LineE[] | null {
  const d = Math.abs(grow);
  let size = 1;
  for (const e of [...orig, ...off]) for (const q of [e.a, e.b]) size = Math.max(size, Math.abs(q[0]), Math.abs(q[1]));
  const eps = size * 1e-9;
  const distSeg = (q: Vec2, a: Vec2, b: Vec2) => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(a[0] + dx * t - q[0], a[1] + dy * t - q[1]);
  };
  const distOrig = (q: Vec2) => Math.min(...orig.map((o) => distSeg(q, o.a, o.b)));
  const poly = orig.map((o) => o.a);
  const inside = (q: Vec2) => {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      if (yi > q[1] !== yj > q[1] && q[0] < ((xj - xi) * (q[1] - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  // Where each offset piece crosses the others (and the original, which it must not run past).
  const cuts: number[][] = off.map(() => [0, 1]);
  const cross = (a: Vec2, b: Vec2, c: Vec2, e: Vec2): [number, number] | null => {
    const r: Vec2 = [b[0] - a[0], b[1] - a[1]];
    const s: Vec2 = [e[0] - c[0], e[1] - c[1]];
    const den = r[0] * s[1] - r[1] * s[0];
    if (Math.abs(den) < 1e-15 * (Math.hypot(...r) * Math.hypot(...s) || 1)) return null;
    const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den;
    const u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
    return t > 1e-12 && t < 1 - 1e-12 && u >= -1e-12 && u <= 1 + 1e-12 ? [t, u] : null;
  };
  for (let i = 0; i < off.length; i++) {
    for (let j = 0; j < off.length; j++) {
      if (i === j) continue;
      const x = cross(off[i].a, off[i].b, off[j].a, off[j].b);
      if (x) cuts[i].push(x[0]);
    }
    for (const o of orig) {
      const x = cross(off[i].a, off[i].b, o.a, o.b);
      if (x) cuts[i].push(x[0]);
    }
  }
  const at = (e: LineE, t: number): Vec2 => [e.a[0] + (e.b[0] - e.a[0]) * t, e.a[1] + (e.b[1] - e.a[1]) * t];
  // The parts that are far enough (and on the right side), each with its piece's index.
  const kept: { a: Vec2; b: Vec2; src: number }[] = [];
  off.forEach((e, i) => {
    const ts = [...new Set(cuts[i])].sort((x, y) => x - y);
    for (let k = 0; k + 1 < ts.length; k++) {
      const p = at(e, ts[k]);
      const q = at(e, ts[k + 1]);
      if (Math.hypot(q[0] - p[0], q[1] - p[1]) < eps * 10) continue;
      const mid = at(e, (ts[k] + ts[k + 1]) / 2);
      if (distOrig(mid) < d * (1 - 1e-6)) continue;
      if (closed && inside(mid) !== grow < 0) continue;
      kept.push({ a: p, b: q, src: i });
    }
  });
  if (!kept.length) return null;
  // Nothing was cut away: as it was.
  if (kept.length === off.length && kept.every((k, i) => k.src === i)) return off;
  // Join the parts end to end again (in the offset's own direction), and merge
  // the parts of one piece that follow each other straight on.
  const tol = Math.max(eps * 1e3, d * 1e-7);
  const same = (p: Vec2, q: Vec2) => Math.hypot(p[0] - q[0], p[1] - q[1]) < tol;
  const used = new Set<number>();
  const out: LineE[] = [];
  for (let s = 0; s < kept.length; s++) {
    if (used.has(s)) continue;
    const path: (typeof kept)[number][] = [];
    let cur = s;
    while (cur >= 0 && !used.has(cur)) {
      used.add(cur);
      const k = kept[cur];
      const last = path[path.length - 1];
      if (last && last.src === k.src && same(last.b, k.a)) last.b = k.b;
      else path.push({ ...k });
      cur = kept.findIndex((x, j) => !used.has(j) && same(x.a, k.b));
    }
    // A loop's first and last parts of the same piece: one line.
    if (path.length > 1 && path[0].src === path[path.length - 1].src && same(path[path.length - 1].b, path[0].a)) {
      path[0].a = path[path.length - 1].a;
      path.pop();
    }
    // Scraps that don't join into an outline (a closed offset is loops only).
    if (closed && !(path.length >= 2 && same(path[path.length - 1].b, path[0].a))) continue;
    for (const k of path) out.push({ ...off[k.src], a: k.a, b: k.b });
  }
  return out.length ? out : null;
}

// --------------------------------------------------------------- offset

/**
 * The offset distance to start with for a curve: a tenth of its size (a line's
 * length, an arc's, a circle's diameter, a box's smaller side), rounded - so it
 * shows on a sketch of any size (a fixed 2 mm was invisible on a 10 m one).
 */
export function defaultOffset(e: SketchEntity): number {
  let size = 0;
  switch (e.kind) {
    case "line":
      size = Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]);
      break;
    case "arc": {
      const c = arcFrom3(e.a, e.m, e.b);
      size = c ? c.r * Math.abs(c.sweep) : Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]);
      break;
    }
    case "circle":
    case "polygon":
      size = 2 * e.radius;
      break;
    case "ellipse":
      size = 2 * Math.min(e.rx, e.ry);
      break;
    case "rect":
      size = Math.min(e.w, e.h);
      break;
    case "spline":
    case "polyline": {
      const pts = e.kind === "spline" ? samplePrim(entityPrims(e)[0], 0, 1) : e.points;
      for (let i = 1; i < pts.length; i++) size += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      break;
    }
  }
  return size > 0 ? roundSig(size * 0.1) : 1;
}

/** Offset copy of an entity (outward for closed shapes, to the left for open ones). */
export function offsetEntity(e: SketchEntity, d: number): SketchEntity | null {
  const base = { id: uid(), construction: e.construction };
  switch (e.kind) {
    case "circle":
      return e.radius + d > 0 ? { ...base, kind: "circle", center: e.center, radius: e.radius + d } : null;
    case "ellipse":
      return e.rx + d > 0 && e.ry + d > 0 ? { ...base, kind: "ellipse", center: e.center, rx: e.rx + d, ry: e.ry + d, rotation: e.rotation } : null;
    case "rect":
      return e.w + 2 * d > 0 && e.h + 2 * d > 0 ? { ...base, kind: "rect", center: e.center, w: e.w + 2 * d, h: e.h + 2 * d, rotation: e.rotation } : null;
    case "polygon": {
      const r = e.radius + d / Math.cos(Math.PI / e.sides);
      return r > 0 ? { ...base, kind: "polygon", center: e.center, radius: r, sides: e.sides, angle: e.angle } : null;
    }
    case "line": {
      const dx = e.b[0] - e.a[0];
      const dy = e.b[1] - e.a[1];
      const L = Math.hypot(dx, dy) || 1;
      const nx = (-dy / L) * d;
      const ny = (dx / L) * d;
      return { ...base, kind: "line", a: [e.a[0] + nx, e.a[1] + ny], b: [e.b[0] + nx, e.b[1] + ny] };
    }
    case "arc": {
      const c = arcFrom3(e.a, e.m, e.b);
      if (!c) return null;
      const k = (c.r + d) / c.r;
      if (k <= 0) return null;
      const s = scaleXf(c.c, k);
      return { ...base, kind: "arc", a: s(e.a), m: s(e.m), b: s(e.b) };
    }
    case "spline":
    case "polyline": {
      const pts = e.kind === "spline" ? samplePrim(entityPrims(e)[0], 0, 1) : e.points;
      const closed = e.closed;
      const sign = closed && signedArea(pts) < 0 ? -1 : 1;
      const out = pts.map((p, i) => {
        const prev = pts[i === 0 ? (closed ? pts.length - 2 : 0) : i - 1];
        const next = pts[i === pts.length - 1 ? (closed ? 1 : i) : i + 1];
        const tx = next[0] - prev[0];
        const ty = next[1] - prev[1];
        const L = Math.hypot(tx, ty) || 1;
        // Outward for CCW closed curves = to the right of travel.
        return [p[0] + (ty / L) * d * sign * (closed ? 1 : -1), p[1] - (tx / L) * d * sign * (closed ? 1 : -1)] as Vec2;
      });
      // Enough fit points to follow the curve closely (four per original span).
      const n = Math.max(24, (e.kind === "spline" ? e.points.length : 6) * 4 + 1);
      return e.kind === "spline" ? { ...base, kind: "spline", points: thin(closed ? out.slice(0, -1) : out, n), closed, mode: "fit" } : { ...base, kind: "polyline", points: out, closed };
    }
  }
}

function signedArea(p: Vec2[]): number {
  let a = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += (p[j][0] + p[i][0]) * (p[j][1] - p[i][1]);
  return -a / 2;
}

function thin(pts: Vec2[], n: number): Vec2[] {
  if (pts.length <= n) return pts;
  const step = (pts.length - 1) / (n - 1);
  return Array.from({ length: n }, (_, i) => pts[Math.round(i * step)]);
}

// --------------------------------------------------------------- fillet

/**
 * Round the corner nearest `at` where two lines meet. Rects/polygons are
 * turned into lines first. Returns null if no corner is near.
 */
export function filletCorner(entities: SketchEntity[], at: Vec2, radius: number, tol: number): SketchEntity[] | null {
  let list = entities.flatMap((e) => (e.kind === "rect" || e.kind === "polygon" || e.kind === "polyline" ? cornerNear(e, at, tol) ? explode(e) : [e] : [e]));
  const lines = list.filter((e): e is Extract<SketchEntity, { kind: "line" }> => e.kind === "line");
  const ends: { e: (typeof lines)[number]; end: "a" | "b" }[] = [];
  for (const e of lines) for (const end of ["a", "b"] as const) if (Math.hypot(e[end][0] - at[0], e[end][1] - at[1]) < tol) ends.push({ e, end });
  if (ends.length < 2) return roundCorner(list, at, radius, tol);
  const [p, q] = ends;
  const corner = p.e[p.end];
  const farP = p.e[p.end === "a" ? "b" : "a"];
  const farQ = q.e[q.end === "a" ? "b" : "a"];
  const u = unit(sub2(farP, corner));
  const v = unit(sub2(farQ, corner));
  const cos = u[0] * v[0] + u[1] * v[1];
  const half = Math.acos(Math.max(-1, Math.min(1, cos))) / 2;
  if (half < 1e-3 || Math.PI / 2 - half < 1e-3) return null;
  const dist = radius / Math.tan(half);
  if (dist > Math.hypot(...sub2(farP, corner)) || dist > Math.hypot(...sub2(farQ, corner))) return null;
  const tp: Vec2 = [corner[0] + u[0] * dist, corner[1] + u[1] * dist];
  const tq: Vec2 = [corner[0] + v[0] * dist, corner[1] + v[1] * dist];
  const bis = unit([u[0] + v[0], u[1] + v[1]]);
  const cdist = radius / Math.sin(half);
  const c: Vec2 = [corner[0] + bis[0] * cdist, corner[1] + bis[1] * cdist];
  const mid: Vec2 = [c[0] - bis[0] * radius, c[1] - bis[1] * radius];
  list = list.map((e) => (e === p.e ? { ...p.e, [p.end]: tp } : e === q.e ? { ...q.e, [q.end]: tq } : e));
  list.push({ id: uid(), kind: "arc", a: tp, m: mid, b: tq, construction: p.e.construction });
  return list;
}

/**
 * Fillet where a line meets an arc, or two arcs meet: the rounding circle sits
 * at `radius` from both (offset carriers crossing), on the side where it
 * touches both curves on their own length, nearest the corner.
 */
function roundCorner(list: SketchEntity[], at: Vec2, radius: number, tol: number): SketchEntity[] | null {
  type End = { e: Extract<SketchEntity, { kind: "line" | "arc" }>; end: "a" | "b" };
  const ends: End[] = [];
  for (const e of list) if (e.kind === "line" || e.kind === "arc") for (const end of ["a", "b"] as const) if (Math.hypot(e[end][0] - at[0], e[end][1] - at[1]) < tol) ends.push({ e, end });
  if (ends.length < 2 || ends[0].e === ends[1].e || !(radius > 0)) return null;
  const [P, Q] = ends;
  const corner = P.e[P.end];
  const k1 = carrierOf(P.e);
  const k2 = carrierOf(Q.e);
  if (!k1 || !k2) return null;
  const shifted = (k: Carrier): Carrier[] => {
    if (k.kind === "line") {
      const L = Math.hypot(...k.d) || 1;
      const n: Vec2 = [(-k.d[1] / L) * radius, (k.d[0] / L) * radius];
      return [{ kind: "line", p: [k.p[0] + n[0], k.p[1] + n[1]], d: k.d }, { kind: "line", p: [k.p[0] - n[0], k.p[1] - n[1]], d: k.d }];
    }
    return [{ kind: "circle", c: k.c, r: k.r + radius }, ...(k.r - radius > 1e-12 ? [{ kind: "circle" as const, c: k.c, r: k.r - radius }] : [])];
  };
  const touch = (k: Carrier, c: Vec2): Vec2 => (k.kind === "line" ? projectOnLine(c, k.p, [k.p[0] + k.d[0], k.p[1] + k.d[1]]) : towards(k.c, c, k.r));
  // Where on the curve a point is, from the corner end (0) to the far end (1); outside → out of range.
  const along = (x: End, q: Vec2): number => {
    const e = x.e;
    if (e.kind === "line") {
      const from = e[x.end];
      const to = x.end === "a" ? e.b : e.a;
      const d: Vec2 = [to[0] - from[0], to[1] - from[1]];
      return ((q[0] - from[0]) * d[0] + (q[1] - from[1]) * d[1]) / (d[0] * d[0] + d[1] * d[1] || 1);
    }
    const c = arcFrom3(e.a, e.m, e.b)!;
    const ang = Math.atan2(q[1] - c.c[1], q[0] - c.c[0]);
    let f = (ang - c.a0) / c.sweep;
    const turn = (2 * Math.PI) / Math.abs(c.sweep);
    while (f < -1e-9) f += turn;
    while (f > 1 + 1e-9 && f - turn >= -1e-9) f -= turn;
    return x.end === "a" ? f : 1 - f;
  };
  /** Direction of travel along a curve at q: towards its corner end ("in") or away from it ("out"). */
  const dirAt = (x: End, q: Vec2, way: "in" | "out"): Vec2 => {
    const e = x.e;
    let d: Vec2;
    if (e.kind === "line") d = unit(x.end === "b" ? [e.b[0] - e.a[0], e.b[1] - e.a[1]] : [e.a[0] - e.b[0], e.a[1] - e.b[1]]);
    else {
      const k = arcFrom3(e.a, e.m, e.b)!;
      const s = Math.sign(k.sweep) * (x.end === "b" ? 1 : -1);
      d = unit([-(q[1] - k.c[1]) * s, (q[0] - k.c[0]) * s]);
    }
    return way === "in" ? d : [-d[0], -d[1]];
  };
  let best: { c: Vec2; tp: Vec2; tq: Vec2; d: number } | null = null;
  for (const u of shifted(k1))
    for (const v of shifted(k2))
      for (const c of carrierCrossings(u, v)) {
        const tp = touch(k1, c);
        const tq = touch(k2, c);
        const fp = along(P, tp);
        const fq = along(Q, tq);
        if (!(fp > 1e-9 && fp < 1 - 1e-9 && fq > 1e-9 && fq < 1 - 1e-9)) continue;
        // It must carry on smoothly: running along P into the corner, the
        // rounding takes over in the same direction and hands over to Q the same way.
        const mid = towards(c, corner, radius);
        const f = arcFrom3(tp, mid, tq);
        if (!f || Math.abs(f.sweep) >= Math.PI) continue;
        const spin = Math.sign(f.sweep);
        const tan = (q: Vec2): Vec2 => unit([-(q[1] - c[1]) * spin, (q[0] - c[0]) * spin]);
        const inP = dirAt(P, tp, "in");
        const outQ = dirAt(Q, tq, "out");
        const tp1 = tan(tp);
        const tq1 = tan(tq);
        if (inP[0] * tp1[0] + inP[1] * tp1[1] < 0.999 || outQ[0] * tq1[0] + outQ[1] * tq1[1] < 0.999) continue;
        const d = Math.hypot(c[0] - corner[0], c[1] - corner[1]);
        if (!best || d < best.d) best = { c, tp, tq, d };
      }
  if (!best) return null;
  const { c, tp, tq } = best;
  // The rounding's middle: the point of its circle nearest the old corner.
  const mid = towards(c, corner, radius);
  const arc: SketchEntity = { id: uid(), kind: "arc", a: tp, m: mid, b: tq, construction: P.e.construction };
  if (!arcFrom3(tp, mid, tq)) return null;
  return [...list.map((e) => (e === P.e ? moveEnd(P.e, P.end, tp) : e === Q.e ? moveEnd(Q.e, Q.end, tq) : e)), arc];
}

function cornerNear(e: Extract<SketchEntity, { kind: "rect" | "polygon" | "polyline" }>, at: Vec2, tol: number): boolean {
  return entityCorners(e).some((p) => Math.hypot(p[0] - at[0], p[1] - at[1]) < tol);
}

const sub2 = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const unit = (a: Vec2): Vec2 => {
  const l = Math.hypot(a[0], a[1]) || 1;
  return [a[0] / l, a[1] / l];
};

// --------------------------------------------------- projection of edges

/**
 * A 3D polyline (e.g. a body edge) flattened onto the sketch plane, as the
 * simplest matching entity: line, circle, arc or spline.
 */
export function projectPolyline(pts3: Vec3[], plane: PlaneDef, type: string): SketchEntity | null {
  const pts = dedupe(pts3.map((p) => toPlane(plane, p)));
  if (pts.length < 2) return null;
  const a = pts[0];
  const b = pts[pts.length - 1];
  const closed = Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6 * (1 + span(pts));
  if (type === "LINE" || pts.length === 2) return { id: uid(), kind: "line", a, b };
  if (type === "CIRCLE") {
    const m = pts[Math.floor(pts.length / 2)];
    const q = pts[Math.floor(pts.length / 3)];
    const c = arcFrom3(pts[0], q, m);
    if (c) {
      // Only a true circle if the projection didn't squash it (plane parallel to the edge's circle).
      const ok = pts.every((p) => Math.abs(Math.hypot(p[0] - c.c[0], p[1] - c.c[1]) - c.r) < c.r * 1e-3);
      if (ok) return closed ? { id: uid(), kind: "circle", center: c.c, radius: c.r } : { id: uid(), kind: "arc", a, m, b };
    }
  }
  const fit = thin(closed ? pts.slice(0, -1) : pts, 24);
  return { id: uid(), kind: "spline", points: fit, closed, mode: "fit" };
}

function dedupe(pts: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-9) out.push(p);
  }
  return out;
}

function span(pts: Vec2[]): number {
  let m = 0;
  for (const p of pts) m = Math.max(m, Math.abs(p[0]), Math.abs(p[1]));
  return m;
}

/**
 * After a fillet: the lines no longer meet at the old corner, so the
 * Coincident that joined them there would pull them back. Replace it with
 * Coincident + Tangent between each line and the new arc.
 */
export function filletConstraints(entities: SketchEntity[], constraints: SketchConstraint[], before: Set<string>): SketchConstraint[] {
  const arcs = entities.filter((e): e is Extract<SketchEntity, { kind: "arc" }> => e.kind === "arc" && !before.has(e.id));
  let cs = constraints;
  for (const arc of arcs) {
    const touching: { e: string; p: "a" | "b"; arcEnd: "a" | "b" }[] = [];
    for (const l of entities)
      if ((l.kind === "line" || l.kind === "arc") && l.id !== arc.id)
        for (const p of ["a", "b"] as const)
          for (const arcEnd of ["a", "b"] as const) if (Math.hypot(l[p][0] - arc[arcEnd][0], l[p][1] - arc[arcEnd][1]) < 1e-9) touching.push({ e: l.id, p, arcEnd });
    if (touching.length < 2) continue;
    const ends = new Set(touching.map((t) => `${t.e}:${t.p}`));
    // Drop constraints that tie these moved ends to each other.
    cs = cs.filter((c) => !(c.type === "coincident" && c.pts?.length === 2 && c.pts.every((q) => ends.has(`${q.e}:${q.p}`))));
    for (const t of touching) {
      cs = [...cs, { id: uid(), type: "coincident", pts: [{ e: t.e, p: t.p }, { e: arc.id, p: t.arcEnd }] }, { id: uid(), type: "tangent", curves: [t.e, arc.id] }];
    }
    // The fillet keeps the radius it was made with (else it floats whenever
    // anything else changes, and a big change can fold the corner over).
    const c = arcFrom3(arc.a, arc.m, arc.b);
    if (c) cs = [...cs, { id: uid(), type: "dim", curves: [arc.id], prop: "radius", value: c.r }];
  }
  return cs;
}

// ------------------------------------------------------------ align / join

type LineE = Extract<SketchEntity, { kind: "line" }>;

const near2 = (p: Vec2, q: Vec2, tol: number) => Math.hypot(p[0] - q[0], p[1] - q[1]) < tol;

/** Where the infinite line p + t·d meets the infinite line through a, b (null if parallel). */
function meetLines(p: Vec2, d: Vec2, a: Vec2, b: Vec2): Vec2 | null {
  const e: Vec2 = [b[0] - a[0], b[1] - a[1]];
  const den = d[0] * e[1] - d[1] * e[0];
  if (Math.abs(den) < 1e-12 * Math.hypot(...d) * Math.hypot(...e)) return null;
  const t = ((a[0] - p[0]) * e[1] - (a[1] - p[1]) * e[0]) / den;
  return [p[0] + d[0] * t, p[1] + d[1] * t];
}

function projectOnLine(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const d: Vec2 = [b[0] - a[0], b[1] - a[1]];
  const l2 = d[0] * d[0] + d[1] * d[1] || 1;
  const t = ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / l2;
  return [a[0] + d[0] * t, a[1] + d[1] * t];
}

/**
 * Align: line `id` moves onto the infinite line of `target` (it ends up lying
 * on it). Lines joined to its ends keep their direction and stretch to follow,
 * like the neighbouring faces of a replaced face.
 */
export function alignLine(entities: SketchEntity[], id: string, target: SketchEntity): SketchEntity[] | null {
  const ln = entities.find((e) => e.id === id);
  if (ln?.kind !== "line" || target.kind !== "line" || target.id === id) return null;
  const [ta, tb] = [target.a, target.b];
  const size = Math.hypot(ln.b[0] - ln.a[0], ln.b[1] - ln.a[1]) + Math.hypot(tb[0] - ta[0], tb[1] - ta[1]);
  const tol = size * 1e-6 + 1e-9;
  const moved = new Map<string, LineE>();
  const ends: Record<"a" | "b", Vec2> = { a: ln.a, b: ln.b };
  for (const k of ["a", "b"] as const) {
    const p = ln[k];
    // A line joined here (not the target itself) slides its end along its own direction.
    const nb = entities.find((e): e is LineE => e.kind === "line" && e.id !== id && e.id !== target.id && !e.construction && (near2(e.a, p, tol) || near2(e.b, p, tol)));
    let q: Vec2 | null = null;
    if (nb) {
      const end = near2(nb.a, p, tol) ? "a" : "b";
      const other = end === "a" ? nb.b : nb.a;
      q = meetLines(other, [p[0] - other[0], p[1] - other[1]], ta, tb);
      if (q) moved.set(nb.id, { ...(moved.get(nb.id) ?? nb), [end]: q });
    }
    ends[k] = q ?? projectOnLine(p, ta, tb);
  }
  if (near2(ends.a, ends.b, tol)) return null;
  return entities.map((e) => (e.id === id ? { ...ln, a: ends.a, b: ends.b } : moved.get(e.id) ?? e));
}

/**
 * Join: line `id` and a line on the same axis that shares one of its ends
 * become a single line. Returns the new entities and the id that was merged away.
 */
export function joinCollinear(entities: SketchEntity[], id: string, prefer?: Vec2): { entities: SketchEntity[]; removed: string } | null {
  const ln = entities.find((e) => e.id === id);
  if (ln?.kind !== "line") return null;
  const len = Math.hypot(ln.b[0] - ln.a[0], ln.b[1] - ln.a[1]);
  const tol = len * 1e-6 + 1e-9;
  const d: Vec2 = [(ln.b[0] - ln.a[0]) / len, (ln.b[1] - ln.a[1]) / len];
  const onAxis = (p: Vec2) => Math.abs((p[0] - ln.a[0]) * d[1] - (p[1] - ln.a[1]) * d[0]) < tol * 10;
  const cands = entities.filter(
    (e): e is LineE => e.kind === "line" && e.id !== id && !!e.construction === !!ln.construction && onAxis(e.a) && onAxis(e.b) && [e.a, e.b].some((p) => near2(p, ln.a, tol) || near2(p, ln.b, tol)),
  );
  if (!cands.length) return null;
  // Two candidates (one at each end): the one on the side that was tapped.
  const along = (p: Vec2) => (p[0] - ln.a[0]) * d[0] + (p[1] - ln.a[1]) * d[1];
  const pick = prefer && cands.length > 1 ? cands.reduce((x, y) => (Math.abs(along(mid(x)) - along(prefer)) < Math.abs(along(mid(y)) - along(prefer)) ? x : y)) : cands[0];
  const pts = [ln.a, ln.b, pick.a, pick.b].sort((p, q) => along(p) - along(q));
  const joined: LineE = { ...ln, a: pts[0], b: pts[3] };
  return { entities: entities.filter((e) => e.id !== pick.id).map((e) => (e.id === id ? joined : e)), removed: pick.id };
}

function mid(l: LineE): Vec2 {
  return [(l.a[0] + l.b[0]) / 2, (l.a[1] + l.b[1]) / 2];
}

// ------------------------------------------------- constraints after edits

/**
 * Constraints after an edit changed curves (trim, extend, …): ones on points
 * that are still there follow them (to whichever piece now has that point),
 * ones on a curve that was cut go to the pieces of it, and any that no longer
 * hold are dropped - an old length would pull an extended line back, a join
 * to a trimmed-away end would drag it out again.
 */
export function carryConstraints(before: SketchEntity[], after: SketchEntity[], cs: SketchConstraint[]): SketchConstraint[] {
  const old = new Map(before.map((e) => [e.id, e]));
  const now = new Map(after.map((e) => [e.id, e]));
  let size = 1;
  for (const e of after) for (const p of pointsOf(e)) size = Math.max(size, Math.abs(p.at[0]), Math.abs(p.at[1]));
  const tol = size * 1e-7;
  const changed = after.filter((e) => old.get(e.id) !== e);
  const same = (p: Vec2, q: Vec2) => Math.hypot(p[0] - q[0], p[1] - q[1]) < tol;
  /** Curves (new or changed) that lie on the old curve `id`: its pieces. */
  const piecesOf = (id: string): SketchEntity[] => {
    const o = old.get(id);
    if (!o) return [];
    const prims = entityPrims(o);
    return changed.filter((e) => {
      const m = entityPrims(e)[0];
      if (!m) return false;
      const mid = evalPrim(m, 0.5);
      return prims.some((pr) => closestOnPrim(pr, mid).d < tol * 10);
    });
  };
  const out: SketchConstraint[] = [];
  for (const c of cs) {
    let ok = true;
    const pts = c.pts?.map((r) => {
      const was = old.get(r.e);
      const q = was && pointOf(was, r.p);
      const e = now.get(r.e);
      const at = e && pointOf(e, r.p);
      if (at && q && same(at, q)) return r;
      if (!q) return r;
      // That point now belongs to a piece of the curve.
      for (const piece of [...(e ? [e] : []), ...piecesOf(r.e)])
        for (const p of pointsOf(piece)) if (same(p.at, q)) return { e: piece.id, p: p.p };
      ok = false;
      return r;
    });
    const curves = c.curves?.map((id) => {
      if (now.has(id)) return id;
      const ps = piecesOf(id);
      if (!ps.length) ok = false;
      return ps[0]?.id ?? id;
    });
    if (!ok) continue;
    const next: SketchConstraint = { ...c, ...(pts ? { pts } : {}), ...(curves ? { curves } : {}) };
    if (!refsOf(next).every((id) => now.has(id))) continue;
    // Two refs that became the very same point hold nothing.
    if (next.pts?.length === 2 && next.pts[0].e === next.pts[1].e && next.pts[0].p === next.pts[1].p) continue;
    // Only what still holds stays.
    if (constraintError(after, [next]) > tol * 10) continue;
    out.push(next);
  }
  return out;
}

// ------------------------------------------------------ more shapes

/**
 * Arc by its centre: from `start` round to the direction of `toward`, the
 * short way - or anticlockwise (angles typed: 90° to 270° is the left half,
 * where the short way can't tell a half circle's sides apart).
 */
export function centreArc(id: string, c: Vec2, start: Vec2, toward: Vec2, anticlockwise = false): SketchEntity | null {
  const r = Math.hypot(start[0] - c[0], start[1] - c[1]);
  if (r < 1e-9) return null;
  const t0 = Math.atan2(start[1] - c[1], start[0] - c[0]);
  let sw = Math.atan2(toward[1] - c[1], toward[0] - c[0]) - t0;
  if (anticlockwise) {
    while (sw <= 1e-9) sw += 2 * Math.PI;
    while (sw > 2 * Math.PI) sw -= 2 * Math.PI;
  }
  while (!anticlockwise && sw > Math.PI) sw -= 2 * Math.PI;
  while (!anticlockwise && sw < -Math.PI) sw += 2 * Math.PI;
  if (Math.abs(sw) < 1e-6) return null;
  const at = (t: number): Vec2 => [c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)];
  return { id, kind: "arc", a: start, m: at(t0 + sw / 2), b: at(t0 + sw) };
}

/**
 * Chamfer the corner nearest `at` where two lines meet: both are cut back by
 * `dist` and a straight line joins the cuts. Null if a line is too short.
 */
export function chamferCorner(entities: SketchEntity[], at: Vec2, dist: number, tol: number): SketchEntity[] | null {
  const list = entities.flatMap((e) => (e.kind === "rect" || e.kind === "polygon" || e.kind === "polyline" ? (cornerNear(e, at, tol) ? explode(e) : [e]) : [e]));
  const ends: { e: LineE; end: "a" | "b" }[] = [];
  for (const e of list) if (e.kind === "line") for (const end of ["a", "b"] as const) if (Math.hypot(e[end][0] - at[0], e[end][1] - at[1]) < tol) ends.push({ e, end });
  if (ends.length < 2 || !(dist > 0)) return null;
  const [p, q] = ends;
  const corner = p.e[p.end];
  const cut = (x: { e: LineE; end: "a" | "b" }): Vec2 | null => {
    const far = x.e[x.end === "a" ? "b" : "a"];
    const L = Math.hypot(far[0] - corner[0], far[1] - corner[1]);
    if (dist >= L - 1e-9) return null;
    return [corner[0] + ((far[0] - corner[0]) / L) * dist, corner[1] + ((far[1] - corner[1]) / L) * dist];
  };
  const tp = cut(p);
  const tq = cut(q);
  if (!tp || !tq) return null;
  // Lines that carry straight on (no corner): nothing to cut.
  const u = unit(sub2(p.e[p.end === "a" ? "b" : "a"], corner));
  const v = unit(sub2(q.e[q.end === "a" ? "b" : "a"], corner));
  if (Math.abs(u[0] * v[1] - u[1] * v[0]) < 1e-6) return null;
  const chamfer: SketchEntity = { id: uid(), kind: "line", a: tp, b: tq, construction: p.e.construction };
  return [...list.map((e) => (e === p.e ? { ...p.e, [p.end]: tp } : e === q.e ? { ...q.e, [q.end]: tq } : e)), chamfer];
}

/** Two lines picked by their halves: extended/trimmed to meet, then that corner chamfered. */
export function chamferEnds(entities: SketchEntity[], first: { id: string; at: Vec2 }, second: { id: string; at: Vec2 }, dist: number): SketchEntity[] | null {
  const e1 = entities.find((x) => x.id === first.id);
  const e2 = entities.find((x) => x.id === second.id);
  if (e1?.kind !== "line" || e2?.kind !== "line" || e1.id === e2.id) return null;
  const joined = joinEnds(entities, first, second);
  if (!joined) return null;
  const end = endNear(e1, first.at)!;
  const corner = (joined.find((x) => x.id === e1.id) as LineE)[end];
  const size = Math.max(Math.hypot(e1.b[0] - e1.a[0], e1.b[1] - e1.a[1]), Math.hypot(e2.b[0] - e2.a[0], e2.b[1] - e2.a[1]), 1);
  return chamferCorner(joined, corner, dist, size * 1e-7);
}

/** After a chamfer: the cut line is joined to both lines (the old corner's join goes). */
export function chamferConstraints(entities: SketchEntity[], constraints: SketchConstraint[], before: Set<string>): SketchConstraint[] {
  let cs = constraints;
  for (const c of entities) {
    if (c.kind !== "line" || before.has(c.id)) continue;
    const touching: { e: string; p: "a" | "b"; mine: "a" | "b" }[] = [];
    for (const l of entities)
      if (l.kind === "line" && l.id !== c.id)
        for (const p of ["a", "b"] as const) for (const mine of ["a", "b"] as const) if (near2(l[p], c[mine], 1e-9)) touching.push({ e: l.id, p, mine });
    if (touching.length < 2) continue;
    const ends = new Set(touching.map((t) => `${t.e}:${t.p}`));
    cs = cs.filter((k) => !(k.type === "coincident" && k.pts?.length === 2 && k.pts.every((q) => ends.has(`${q.e}:${q.p}`))));
    for (const t of touching) cs = [...cs, { id: uid(), type: "coincident", pts: [{ e: t.e, p: t.p }, { e: c.id, p: t.mine }] }];
  }
  return cs;
}

/** Where the (infinite) lines of two line curves meet. */
export function lineMeet(p: LineE, q: LineE): Vec2 | null {
  return meetLines(p.a, [p.b[0] - p.a[0], p.b[1] - p.a[1]], q.a, q.b);
}
