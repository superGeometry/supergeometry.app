// Sketch regions → exact OpenCascade geometry (worker only).

import {
  addHolesInFace,
  assembleWire,
  cast,
  getOC,
  makeBSplineApproximation,
  makeCircle,
  makeEllipse,
  makeFace,
  makeLine,
  makeThreePointArc,
  type Edge,
  type Face,
  type Wire,
} from "replicad";
import type { PlaneDef, SketchEntity, Vec2 } from "../doc/types";
import { toWorld } from "../geom";
import { entityPrims, evalPrim, isClosedPrim, SPLINE_PER_SPAN, splineSpanAt, splineSpans, type Prim } from "../sketch/curves";
import { arrangement, resolveRegion, type Arrangement, type Loop, type LoopRef, type Piece, type RegionRef } from "../sketch/regions";

/** Faces for the referenced regions of a sketch (one face per region, holes included). */
export function regionFaces(entities: SketchEntity[], plane: PlaneDef, refs: RegionRef[]): Face[] {
  const arr = arrangement(entities);
  return refs.map((ref) => {
    const r = resolveRegion(arr, ref);
    if (!r) throw new Error("A profile it used no longer exists in its sketch");
    const face = makeFace(loopWire(arr, r.outer, plane));
    // addHolesInFace orients hole wires correctly (makeFace's holes arg does not).
    return r.holes.length ? addHolesInFace(face, r.holes.map((h) => loopWire(arr, h, plane))) : face;
  });
}

/** Outer wire of a region (for sweeps/lofts that need a wire). */
export function regionWire(entities: SketchEntity[], plane: PlaneDef, ref: RegionRef): Wire {
  const arr = arrangement(entities);
  const r = resolveRegion(arr, ref);
  if (!r) throw new Error("A profile it used no longer exists in its sketch");
  return loopWire(arr, r.outer, plane);
}

/** A wire along sketch entities (open or closed), used as a sweep path. */
export function entitiesWire(entities: SketchEntity[], ids: string[], plane: PlaneDef): Wire {
  const edges: Edge[] = [];
  for (const id of ids) {
    const e = entities.find((x) => x.id === id);
    if (!e) throw new Error("A path curve was deleted");
    for (const p of entityPrims(e)) {
      if (p.t === "line") edges.push(makeLine(toWorld(plane, p.a), toWorld(plane, p.b)));
      else if (p.t === "circle" && isClosedPrim(p)) edges.push(makeCircle(p.r, toWorld(plane, p.c), plane.normal));
      else if (p.t === "circle") edges.push(makeThreePointArc(w(plane, evalPrim(p, 0)), w(plane, evalPrim(p, 0.5)), w(plane, evalPrim(p, 1))));
      else edges.push(exactSpline(p, 0, 1, plane) ?? bspline(Array.from({ length: 65 }, (_, i) => evalPrim(p, i / 64)), plane));
    }
  }
  return assembleWire(edges);
}

function loopWire(arr: Arrangement, loop: Loop, plane: PlaneDef): Wire {
  // A loop that is a whole circle/ellipse on its own: use the exact closed curve.
  const prims = new Set(loop.pieces.map((r) => arr.pieces[r.piece].prim));
  if (prims.size === 1) {
    const p = arr.prims[[...prims][0]];
    if (p.t === "circle" && isClosedPrim(p)) return assembleWire([makeCircle(p.r, toWorld(plane, p.c), plane.normal)]);
    if (p.t === "ellipse" && isClosedPrim(p)) {
      const major = p.rx >= p.ry;
      const rot = p.rot + (major ? 0 : Math.PI / 2);
      const xDir = toWorld({ ...plane, origin: [0, 0, 0] }, [Math.cos(rot), Math.sin(rot)]);
      return assembleWire([makeEllipse(Math.max(p.rx, p.ry), Math.min(p.rx, p.ry), toWorld(plane, p.c), plane.normal, xDir)]);
    }
  }
  return assembleWire(
    roundRuns(arr, loop).map((run) =>
      run.length === 1 ? pieceEdge(arr, arr.pieces[run[0].piece], plane) : circleOf(arr, run[0]) ? arcThrough(arr, run, plane) : splineThrough(arr, run, plane),
    ),
  );
}

/** The circle a piece lies on (an arc or a circle of the sketch), if any. */
function circleOf(arr: Arrangement, r: LoopRef): { c: Vec2; r: number } | null {
  const p = arr.prims[arr.pieces[r.piece].prim];
  return p.t === "circle" ? { c: p.c, r: p.r } : null;
}

/**
 * The loop's pieces in runs: pieces next to each other on the same circle
 * (one circle split by a line ending on it, or an arc drawn as two arcs) are
 * one run - one edge, so the side extruded from it is one round face. Each
 * piece its own edge left a line down the round side: later unions and
 * threads failed on it.
 */
function roundRuns(arr: Arrangement, loop: Loop): LoopRef[][] {
  const refs = loop.pieces;
  const n = refs.length;
  const size = Math.max(1, ...arr.prims.map((p) => (p.t === "circle" ? p.r : 0)));
  const same = (i: number, j: number) => {
    const a = circleOf(arr, refs[i]);
    const b = circleOf(arr, refs[j]);
    if (a && b) return Math.hypot(a.c[0] - b.c[0], a.c[1] - b.c[1]) < size * 1e-9 && Math.abs(a.r - b.r) < size * 1e-9;
    // One spline, on from where the last piece of it stopped.
    const pi = arr.pieces[refs[i].piece];
    const pj = arr.pieces[refs[j].piece];
    if (pi.prim !== pj.prim || arr.prims[pi.prim].t !== "spline" || refs[i].reversed !== refs[j].reversed) return false;
    const gap = refs[i].reversed ? pi.t0 - pj.t1 : pj.t0 - pi.t1;
    return Math.abs(gap - Math.round(gap)) < 1e-9;
  };
  if (n < 2) return refs.map((r) => [r]);
  // Start where a run starts (not halfway round one).
  let s = 0;
  while (s < n && same((s + n - 1) % n, s)) s++;
  if (s === n) return [refs]; // the whole loop is one circle
  const runs: LoopRef[][] = [];
  for (let k = 0; k < n; k++) {
    const i = (s + k) % n;
    if (k > 0 && same((i + n - 1) % n, i)) runs[runs.length - 1].push(refs[i]);
    else runs.push([refs[i]]);
  }
  return runs;
}

/** One edge along a run of pieces of the same spline (its exact cubic spans). */
function splineThrough(arr: Arrangement, run: LoopRef[], plane: PlaneDef): Edge {
  const fwd = run[0].reversed ? [...run].reverse() : run;
  const first = arr.pieces[fwd[0].piece];
  const last = arr.pieces[fwd[fwd.length - 1].piece];
  const p = arr.prims[first.prim];
  let t1 = last.t1;
  while (t1 <= first.t0 + 1e-12) t1 += 1;
  const a = first.poly[0];
  const b = last.poly[last.poly.length - 1];
  const poly = fwd.flatMap((r, k) => (k ? arr.pieces[r.piece].poly.slice(1) : arr.pieces[r.piece].poly));
  return exactSpline(p, first.t0, t1, plane, a, b) ?? bspline(poly, plane);
}

/** One arc along a run of pieces on the same circle (a whole circle if it closes). */
function arcThrough(arr: Arrangement, run: LoopRef[], plane: PlaneDef): Edge {
  const pts: Vec2[] = [];
  for (const r of run) {
    const poly = arr.pieces[r.piece].poly;
    const seq = r.reversed ? [...poly].reverse() : poly;
    pts.push(...(pts.length ? seq.slice(1) : seq));
  }
  const a = pts[0];
  const b = pts[pts.length - 1];
  const c = circleOf(arr, run[0])!;
  if (Math.hypot(a[0] - b[0], a[1] - b[1]) < c.r * 1e-9) return makeCircle(c.r, toWorld(plane, c.c), plane.normal);
  // Through the ends (shared with the neighbours) and the point halfway along.
  const lens = [0];
  for (let i = 1; i < pts.length; i++) lens.push(lens[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const half = lens[lens.length - 1] / 2;
  const i = Math.max(1, lens.findIndex((l) => l >= half));
  const t = (half - lens[i - 1]) / Math.max(1e-300, lens[i] - lens[i - 1]);
  const q: Vec2 = [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
  // Onto the circle (the polyline's chord sags inside it).
  const d = Math.hypot(q[0] - c.c[0], q[1] - c.c[1]) || 1;
  const m: Vec2 = [c.c[0] + ((q[0] - c.c[0]) * c.r) / d, c.c[1] + ((q[1] - c.c[1]) * c.r) / d];
  return makeThreePointArc(w(plane, a), w(plane, m), w(plane, b));
}

function pieceEdge(arr: Arrangement, pc: Piece, plane: PlaneDef): Edge {
  const p = arr.prims[pc.prim];
  const a = pc.poly[0];
  const b = pc.poly[pc.poly.length - 1];
  switch (p.t) {
    case "line":
      return makeLine(w(plane, a), w(plane, b));
    case "circle":
      // Through the (shared) end nodes, so neighbouring pieces meet exactly.
      return makeThreePointArc(w(plane, a), w(plane, evalPrim(p, (pc.t0 + pc.t1) / 2)), w(plane, b));
    default:
      return exactSpline(p, pc.t0, pc.t1, plane, a, b) ?? bspline(pc.poly, plane);
  }
}

/**
 * The spline exactly as drawn, from parameter t0 to t1: each span of the
 * sketch spline is a cubic, so it becomes one Bezier piece of a C1 B-spline -
 * no fitting, so no ripples (in revolves and lofts especially).
 * `a`/`b` pin the ends onto the arrangement's nodes so neighbours meet.
 */
function exactSpline(p: Prim, t0: number, t1: number, plane: PlaneDef, a?: Vec2, b?: Vec2): Edge | null {
  if (p.t !== "spline" || !p.ctrl || approxOnly) return null;
  const spans = splineSpans(p.ctrl);
  const n = p.pts.length - 1;
  if (n !== spans * SPLINE_PER_SPAN) return null;
  // Closed pieces can run past the seam (t1 > 1).
  const f0 = t0 * spans;
  const f1 = t1 * spans;
  if (f1 - f0 < 1e-9) return null;
  // Span s (wrapping round a closed spline) at local parameter u.
  const spanAt = (s: number, u: number): Vec2 => splineSpanAt(p.ctrl!, ((s % spans) + spans) % spans, u);
  // Break at the span joints inside [f0, f1].
  const cuts = [f0];
  for (let k = Math.floor(f0) + 1; k < f1 - 1e-9; k++) if (k > f0 + 1e-9) cuts.push(k);
  cuts.push(f1);
  const poles: Vec2[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const [u0, u1] = [cuts[i], cuts[i + 1]];
    // A cubic through four of its own points is that cubic: solve for its Bezier.
    // (Sampled inside the span, so a joint isn't read from the next span's formula.)
    const s = Math.min(Math.floor(u0 + 1e-9), Math.ceil(u1 - 1e-9) - 1);
    const q = [0, 1 / 3, 2 / 3, 1].map((x) => spanAt(s, u0 + (u1 - u0) * x - s));
    const P0 = q[0];
    const P3 = q[3];
    const A: Vec2 = [27 * q[1][0] - 8 * P0[0] - P3[0], 27 * q[1][1] - 8 * P0[1] - P3[1]];
    const B: Vec2 = [27 * q[2][0] - P0[0] - 8 * P3[0], 27 * q[2][1] - P0[1] - 8 * P3[1]];
    const P1: Vec2 = [(2 * A[0] - B[0]) / 18, (2 * A[1] - B[1]) / 18];
    const P2: Vec2 = [(2 * B[0] - A[0]) / 18, (2 * B[1] - A[1]) / 18];
    if (i === 0) poles.push(P0);
    poles.push(P1, P2, P3);
  }
  if (a) poles[0] = a;
  if (b) poles[poles.length - 1] = b;
  const oc = getOC();
  const m = cuts.length - 1;
  const arr = new oc.NCollection_Array1_gp_Pnt(1, poles.length);
  const knots = new oc.NCollection_Array1_double(1, m + 1);
  const mults = new oc.NCollection_Array1_int(1, m + 1);
  try {
    poles.forEach((q, i) => {
      const w3 = w(plane, q);
      const pt = new oc.gp_Pnt(w3[0], w3[1], w3[2]);
      arr.SetValue(i + 1, pt);
      pt.delete();
    });
    // Knots spaced like the spline's own parameter (centripetal for fit
    // points): then the pieces join smoothly in parameter too, and the
    // repeated joins can be thinned to C1 - revolves need a smooth profile.
    const ctrl = p.ctrl;
    const n = ctrl.points.length;
    const at = (i: number) => ctrl.points[ctrl.closed ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i))];
    const spanLen = (sIdx: number) => {
      if (ctrl.mode !== "fit") return 1;
      const s0 = ((sIdx % spans) + spans) % spans;
      const a0 = at(s0);
      const a1 = at(s0 + 1);
      return Math.max(1e-9, Math.sqrt(Math.hypot(a1[0] - a0[0], a1[1] - a0[1])));
    };
    let t = 0;
    for (let i = 0; i <= m; i++) {
      if (i > 0) {
        const [u0, u1] = [cuts[i - 1], cuts[i]];
        t += (u1 - u0) * spanLen(Math.floor(u0 + 1e-9));
      }
      knots.SetValue(i + 1, t);
      mults.SetValue(i + 1, i === 0 || i === m ? 4 : 3);
    }
    const curve = new oc.Geom_BSplineCurve(arr, knots, mults, 3, false);
    const tol = 1e-6 * Math.max(1, ...poles.map((q) => Math.hypot(q[0], q[1])));
    for (let i = 2; i <= m; i++) curve.RemoveKnot(i, 2, tol);
    const mk = new oc.BRepBuilderAPI_MakeEdge(curve);
    const edge = cast(mk.Edge()) as Edge;
    mk.delete();
    return edge;
  } catch {
    return null;
  } finally {
    arr.delete();
    knots.delete();
    mults.delete();
  }
}

/** Splines as close fits instead of their exact curves (a fallback when an exact one won't build). */
let approxOnly = false;

export function withFittedSplines<T>(fn: () => T): T {
  approxOnly = true;
  try {
    return fn();
  } finally {
    approxOnly = false;
  }
}

function bspline(pts: Vec2[], plane: PlaneDef): Edge {
  // Thin out dense samples; the approximation is smooth anyway.
  const step = Math.max(1, Math.floor(pts.length / 48));
  const kept = pts.filter((_, i) => i % step === 0 || i === pts.length - 1);
  if (kept.length < 3) return makeLine(w(plane, kept[0]), w(plane, kept[kept.length - 1]));
  return makeBSplineApproximation(kept.map((q) => w(plane, q)), { tolerance: 1e-4, degMax: 5, degMin: 2 });
}

const w = (plane: PlaneDef, q: Vec2) => toWorld(plane, q);
