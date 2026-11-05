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
import { arrangement, resolveRegion, type Arrangement, type Loop, type Piece, type RegionRef } from "../sketch/regions";

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
  return assembleWire(loop.pieces.map((r) => pieceEdge(arr, arr.pieces[r.piece], plane)));
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
 * sketch spline is a cubic, so it becomes one Bezier piece of a C1 B-spline —
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
    // repeated joins can be thinned to C1 — revolves need a smooth profile.
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
