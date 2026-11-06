// Direct face editing with booleans: offset a face (neighbours extend along their
// own surfaces), move/tilt a flat face, delete a face (neighbours close the gap).
//
// The trick: near face F the body equals E ∩ "behind F", where E is the
// intersection of the *extended* neighbouring surfaces — each taken on the side
// the body is on (planes → half-spaces, cylinders → infinite cylinders). Changing
// F then only means adding/removing the right slab of E.

import { assembleWire, basicFaceExtrusion, getOC, loft, makeBSplineApproximation, makeCylinder, makeLine, makePolygon, makeSphere, measureArea, measureVolume, cast, Vector, type Face, type Shape3D } from "replicad";
import type { PlaneDef, Vec3 } from "../doc/types";
import { add, cross, dist, dot, len, norm, scale, sub, xDirFor } from "../geom";
import { subShapes } from "./health";

interface Cyl {
  c: Vec3;
  a: Vec3;
  r: number;
  /** +1: material inside (boss), −1: material outside (hole). */
  s: number;
}

const tup = (v: { toTuple(): number[] }) => v.toTuple() as Vec3;

function sizeOf(body: Shape3D): number {
  const bb = body.boundingBox;
  return Math.hypot(bb.width, bb.height, bb.depth) || 1;
}

// Each helper solid gets a slightly different size: when two of them end on the
// same far-away plane, the booleans split surfaces and they no longer re-merge.
let jitter = 0;
const vary = (L: number) => L * (1 + 0.0137 * (jitter = (jitter + 1) % 37));

/** Solid on the positive side of a plane, big enough for `L`. */
export function halfSpace(plane: PlaneDef, L0: number): Shape3D {
  const L = vary(L0);
  const x = norm(plane.xDir);
  const y = cross(plane.normal, x);
  const o = plane.origin;
  const corner = (u: number, v: number): Vec3 => add(o, add(scale(x, u * L), scale(y, v * L)));
  // Off-centre on purpose (see `vary`).
  const face = makePolygon([corner(-1.09, -0.93), corner(0.97, -0.93), corner(0.97, 1.05), corner(-1.09, 1.05)]);
  return basicFaceExtrusion(face, new Vector(plane.normal).multiply(L));
}

/** Axis, radius and orientation of a cylindrical face (from surface samples). */
export function cylinderOf(f: Face): Cyl | null {
  if (f.geomType !== "CYLINDRE") return null;
  // pointOnSurface takes UV normalised to the face's bounds.
  const at = (u: number, v: number) => {
    const p = tup(f.pointOnSurface(u, v));
    return { p, n: norm(tup(f.normalAt(p))) };
  };
  // Two points at the same height, apart around the axis.
  const s1 = at(0.25, 0.5);
  const s2 = at(0.6, 0.5);
  const ax = cross(s1.n, s2.n);
  if (len(ax) < 1e-9) return null;
  const a = norm(ax);
  const dn = len(sub(s1.n, s2.n));
  const r = len(sub(s1.p, s2.p)) / (dn || 1);
  // Normals point away from the axis on a boss, towards it in a hole.
  const cOut = sub(s1.p, scale(s1.n, r));
  const cIn = add(s1.p, scale(s1.n, r));
  const out2 = sub(s2.p, scale(s2.n, r));
  const s = dist(cOut, out2) < dist(cIn, add(s2.p, scale(s2.n, r))) ? 1 : -1;
  const c = s > 0 ? cOut : cIn;
  return { c, a, r, s };
}

/**
 * A point that lies on face F itself (its center may be off the face — e.g. on
 * a cylinder's axis or inside a ring) and the outward normal there.
 */
export function onFace(body: Shape3D, F: Face): { p: Vec3; n: Vec3 } {
  // Curved faces: the middle of the face's own parameter range sits well inside
  // it (a fillet's mid-arc), away from the edges where its neighbours start.
  if (F.geomType !== "PLANE") {
    const p = tup(F.pointOnSurface(0.5, 0.5));
    return { p, n: norm(tup(F.normalAt(p))) };
  }
  let t = F.triangulation();
  if (!t || !t.trianglesIndexes.length) {
    body.mesh({ tolerance: sizeOf(body) * 1e-3, angularTolerance: 0.3 });
    t = F.triangulation();
  }
  if (t && t.trianglesIndexes.length) {
    // Centroid of the biggest triangle: well inside the face.
    const v = (i: number): Vec3 => [t!.vertices[3 * i], t!.vertices[3 * i + 1], t!.vertices[3 * i + 2]];
    let best: Vec3 = v(0);
    let area = -1;
    for (let k = 0; k < t.trianglesIndexes.length; k += 3) {
      const [a, b, c] = [0, 1, 2].map((j) => v(t!.trianglesIndexes[k + j]));
      const ar = len(cross(sub(b, a), sub(c, a)));
      if (ar > area) {
        area = ar;
        best = scale(add(add(a, b), c), 1 / 3);
      }
    }
    return { p: best, n: norm(tup(F.normalAt(best))) };
  }
  const p = tup(F.pointOnSurface(0.5, 0.5));
  return { p, n: norm(tup(F.normalAt(p))) };
}

/** The exact plane of a flat face (a surface point, not a mesh point). */
export function planeOf(F: Face): PlaneDef {
  const origin = tup(F.pointOnSurface(0.5, 0.5));
  const normal = norm(tup(F.normalAt(origin)));
  return { origin, normal, xDir: xDirFor(normal) };
}

function infiniteCylinder(cy: Cyl, r: number, L0: number): Shape3D {
  const L = vary(L0);
  return makeCylinder(r, 2 * L, sub(cy.c, scale(cy.a, L)), cy.a) as Shape3D;
}

/** Faces sharing an edge with F. */
function neighbours(body: Shape3D, F: Face): Face[] {
  const edges = F.edges;
  return body.faces.filter((g) => !g.isSame(F) && g.edges.some((e) => edges.some((fe) => fe.isSame(e))));
}

/**
 * E: the region bounded by F's neighbours' extended surfaces, each on the side
 * that contains `q` (a point just inside the body under F). Bounded by a box.
 */
export function extendedRegion(body: Shape3D, F: Face, q: Vec3, L: number): Shape3D {
  const c = body.boundingBox.center as Vec3;
  // Bounding box, bigger than the other tools so no faces coincide with theirs.
  const big = () => halfSpace({ origin: sub(c, [0, 0, 1.5 * L]), xDir: [1, 0, 0], normal: [0, 0, 1] }, 3 * L);
  const keep: Shape3D[] = [];
  const remove: Shape3D[] = [];
  const nb = neighbours(body, F);
  for (const g of nb) {
    if (g.geomType === "PLANE") {
      const { origin: p, normal: n } = planeOf(g);
      // Keep the side of g's plane that contains q.
      const side = dot(sub(q, p), n) < 0 ? scale(n, -1) : n;
      keep.push(halfSpace({ origin: p, normal: side, xDir: xDirFor(side) }, L));
    } else if (g.geomType === "CYLINDRE") {
      const cy = cylinderOf(g);
      if (!cy) continue;
      const rel = sub(q, cy.c);
      const radial = len(sub(rel, scale(cy.a, dot(rel, cy.a))));
      (radial < cy.r ? keep : remove).push(infiniteCylinder(cy, cy.r, L));
    } else {
      // Any other surface (a twisted corner patch where a chamfer meets a
      // fillet, a lofted side) has no one way to carry on: the flat faces
      // round it do, and bound the region there. Left open, it would run off
      // out of the part.
      for (const h of neighbours(body, g)) {
        if (h.geomType !== "PLANE" || h.isSame(F) || nb.some((x) => x.isSame(h))) continue;
        const { origin: hp, normal: hn } = planeOf(h);
        const hs = dot(sub(q, hp), hn) < 0 ? scale(hn, -1) : hn;
        keep.push(halfSpace({ origin: hp, normal: hs, xDir: xDirFor(hs) }, L));
      }
    }
  }
  let E = keep.length ? keep[0] : big();
  for (const k of keep.slice(1)) E = E.intersect(k);
  for (const r of remove) E = E.cut(r);
  return E;
}

/**
 * Replace flat face F's plane with `to` (move/tilt); neighbours extend or trim.
 * Round blends (fillets) on F are taken off first and put back at the same
 * radius afterwards — extending a fillet's cylinder through the body would
 * carve a tunnel into it.
 */
export function replaceFacePlane(body: Shape3D, F: Face, to: PlaneDef): Shape3D {
  if (F.geomType !== "PLANE") throw new Error("Only flat faces can be moved or tilted");
  const blends = blendsOf(body, F);
  if (blends.length) {
    // Never straight through a fillet: that leaves its old round face standing
    // in the body (a tunnel or a wall where the fillet was).
    try {
      return aroundBlends(body, F, blends, to);
    } catch {
      // A fillet running along this face can't be gone through; one that only ends on it can.
      if (blends.some((b) => b.sides[0] === null)) throw new Error("This face can't be moved cleanly around its fillet — try a smaller value, or remove the fillet first");
    }
  }
  // A face with inward corners moved straight along its normal: edge by edge
  // (the half-space trick would clip it to its convex part).
  const old = planeOf(F);
  const nn = norm(to.normal);
  if (Math.abs(dot(nn, old.normal)) > 1 - 1e-9 && !convexFace(F)) {
    const d = dot(sub(to.origin, old.origin), old.normal);
    if (Math.abs(d) < 1e-12) return body;
    try {
      return offsetByContinuation(body, F, d);
    } catch {
      // fall back below
    }
  }
  return replacePlaneDirect(body, F, to);
}

interface Blend {
  r: number;
  /** The two flat faces the fillet runs between; `null` stands for the face being moved. */
  sides: [PlaneDef | null, PlaneDef];
  /** The blend's own signature, to find it again after earlier edits. */
  sig: { center: Vec3; area: number };
}

/** Is cylinder `cy` tangent to plane `pl` (a fillet's support face)? */
function tangentTo(cy: Cyl, pl: PlaneDef, tol: number): boolean {
  return Math.abs(dot(cy.a, pl.normal)) < 1e-6 && Math.abs(Math.abs(dot(sub(cy.c, pl.origin), pl.normal)) - cy.r) < cy.r * 1e-4 + tol;
}

/**
 * Fillets touching F: round faces next to it that run between two flat faces
 * (F itself may be one of them). They get taken off and put back around an edit.
 */
function blendsOf(body: Shape3D, F: Face): Blend[] {
  const tol = sizeOf(body) * 1e-7;
  const out: Blend[] = [];
  for (const g of neighbours(body, F)) {
    if (g.geomType !== "CYLINDRE") continue;
    const cy = cylinderOf(g);
    if (!cy) continue;
    const supports = neighbours(body, g).filter((h) => h.geomType === "PLANE" && tangentTo(cy, planeOf(h), tol));
    if (supports.length !== 2) continue;
    const planes = supports.map((h) => (h.isSame(F) ? null : planeOf(h)));
    // Keep F (if it is one) first.
    const sides = (planes[1] === null ? [planes[1], planes[0]] : planes) as [PlaneDef | null, PlaneDef];
    if (sides[1] === null) continue;
    out.push({ r: cy.r, sides, sig: { center: tup(g.center), area: measureArea(g) } });
  }
  return out;
}

function aroundBlends(body: Shape3D, F: Face, blends: Blend[], to: PlaneDef): Shape3D {
  const fp = planeOf(F);
  let b = body;
  // 1. Take the fillets off (their faces meet in sharp edges again).
  for (const bl of blends) {
    const g = findFace(b, (h) => h.geomType === "CYLINDRE", bl.sig.center, bl.sig.area);
    if (!g) throw new Error("blend lost");
    try {
      b = takeOffBlend(b, g);
    } catch {
      // That way can't (a fillet between faces at an odd angle): as if it was never there.
      b = deleteFaces(b, [g]);
    }
  }
  // 2. Move the face, now bounded by flat neighbours only.
  const F1 = findFace(b, (h) => h.geomType === "PLANE" && Math.abs(dot(planeOf(h).normal, fp.normal)) > 1 - 1e-9 && Math.abs(dot(sub(planeOf(h).origin, fp.origin), fp.normal)) < sizeOf(b) * 1e-7, tup(F.center), measureArea(F));
  if (!F1) throw new Error("face lost");
  b = replacePlaneDirect(b, F1, to);
  // 3. Round the edges between each fillet's two faces again, same radius.
  const moved: PlaneDef = { ...to, normal: norm(to.normal) };
  const tol = sizeOf(b) * 1e-6;
  const on = (m: Vec3, pl: PlaneDef) => Math.abs(dot(sub(m, pl.origin), norm(pl.normal))) < tol;
  for (const bl of blends) {
    const p1 = bl.sides[0] ?? moved;
    const p2 = bl.sides[1];
    const edges = b.edges.filter((e) => {
      // All along it, not just its middle (another edge's middle can happen to sit on both planes).
      return [0.15, 0.5, 0.85].every((t) => {
        const m = tup(e.pointAt(t));
        return on(m, p1) && on(m, p2);
      });
    });
    if (!edges.length) throw new Error("edge lost");
    try {
      b = b.fillet(bl.r, (finder) => finder.inList(edges)) as Shape3D;
    } catch {
      // It doesn't fit any more (the faces got too small for it): the edge stays sharp, and History says so.
      editNotes.push(`The ${fmtR(bl.r)} fillet next to this face doesn't fit any more, so that edge is sharp now.`);
    }
  }
  return sanity(body, b);
}

/** Things an edit had to give up on without failing (shown as a note on the step in History). */
export const editNotes: string[] = [];
const fmtR = (r: number) => `R${Math.round(r * 1000) / 1000} mm`;

/** Does F have fillets on it (it's moved around them, never straight through)? */
export function hasBlends(body: Shape3D, F: Face): boolean {
  // Only fillets that run along F (F is one of the two faces they round off):
  // one that just ends on F is fine to push straight past.
  return F.geomType === "PLANE" && blendsOf(body, F).some((b) => b.sides[0] === null);
}

/** The face that passes `ok`, nearest a remembered centre (and area). */
function findFace(body: Shape3D, ok: (f: Face) => boolean, center: Vec3, area: number): Face | null {
  let best: { f: Face; s: number } | null = null;
  const size = Math.sqrt(area) || 1;
  for (const f of body.faces) {
    if (!ok(f)) continue;
    const s = dist(tup(f.center), center) / size + Math.abs(Math.log((measureArea(f) + 1e-12) / (area + 1e-12)));
    if (!best || s < best.s) best = { f, s };
  }
  return best?.f ?? null;
}

function replacePlaneDirect(body: Shape3D, F: Face, to: PlaneDef): Shape3D {
  const L = sizeOf(body) * 4;
  const E = faceColumn(body, F, L);
  const behind = (pl: PlaneDef) => halfSpace({ ...pl, normal: scale(pl.normal, -1), xDir: xDirFor(scale(pl.normal, -1)) }, L);
  const front = (pl: PlaneDef) => halfSpace(pl, L);
  const old = planeOf(F);
  const neu: PlaneDef = { ...to, normal: norm(to.normal), xDir: xDirFor(norm(to.normal)) };
  let out = body;
  const grow = E.intersect(front(old)).intersect(behind(neu));
  if (!isEmpty(grow)) out = out.fuse(grow);
  const shrink = E.intersect(behind(old)).intersect(front(neu));
  if (!isEmpty(shrink)) out = out.cut(shrink);
  return sanity(body, out);
}

/**
 * The space a face's neighbours enclose around it, carried on along their
 * own surfaces. A face with inward corners (an L, a notch cut into it) isn't
 * one convex piece: its neighbours' surfaces cut its plane into cells, and the
 * face is exactly the cells it covers — so take each of those (points spread
 * over the face tell which) and join them.
 */
function faceColumn(body: Shape3D, F: Face, L: number): Shape3D {
  const { p, n } = onFace(body, F);
  const lift = sizeOf(body) * 1e-3;
  const q0 = sub(p, scale(n, lift));
  if (F.geomType === "PLANE" && convexFace(F)) return extendedRegion(body, F, q0, L);
  const tol = sizeOf(body) * 1e-6;
  const sides = neighbours(body, F).map((g): ((q: Vec3) => number) | null => {
    if (g.geomType === "PLANE") {
      const pl = planeOf(g);
      return (q) => dot(sub(q, pl.origin), pl.normal);
    }
    if (g.geomType === "CYLINDRE") {
      const cy = cylinderOf(g);
      if (!cy) return null;
      return (q) => {
        const rel = sub(q, cy.c);
        return len(sub(rel, scale(cy.a, dot(rel, cy.a)))) - cy.r;
      };
    }
    return null;
  });
  let t = F.triangulation();
  if (!t || !t.trianglesIndexes.length) {
    body.mesh({ tolerance: sizeOf(body) * 1e-3, angularTolerance: 0.3 });
    t = F.triangulation();
  }
  if (!t || !t.trianglesIndexes.length) return extendedRegion(body, F, q0, L);
  const v = (i: number): Vec3 => [t!.vertices[3 * i], t!.vertices[3 * i + 1], t!.vertices[3 * i + 2]];
  const cells = new Map<string, Vec3>();
  for (let k = 0; k < t.trianglesIndexes.length; k += 3) {
    const [a, b, c] = [0, 1, 2].map((j) => v(t!.trianglesIndexes[k + j]));
    // The middle and near each corner: a triangle may straddle a line where a neighbour's surface crosses the face.
    for (const [wa, wb, wc] of [[1 / 3, 1 / 3, 1 / 3], [0.8, 0.1, 0.1], [0.1, 0.8, 0.1], [0.1, 0.1, 0.8]]) {
      const on = add(add(scale(a, wa), scale(b, wb)), scale(c, wc));
      // Just inside the material: along the face's own normal there (a round face's turns).
      let nq = n;
      if (F.geomType !== "PLANE")
        try {
          nq = norm(tup(F.normalAt(on)));
        } catch {
          continue;
        }
      const q = sub(on, scale(nq, lift));
      const ds = sides.map((f) => (f ? f(q) : 0));
      if (ds.some((d, i) => sides[i] && Math.abs(d) < tol)) continue;
      const key = ds.map((d, i) => (!sides[i] ? "" : d < 0 ? "-" : "+")).join("");
      if (!cells.has(key)) cells.set(key, q);
    }
  }
  if (cells.size <= 1) return extendedRegion(body, F, q0, L);
  let E: Shape3D | null = null;
  for (const q of cells.values()) {
    const c = extendedRegion(body, F, q, L);
    E = E ? E.fuse(c) : c;
  }
  return E!;
}

/** Does a flat face's outline turn the same way at every corner (no inward corners, no holes)? */
export function convexFace(F: Face): boolean {
  if (F.clone().innerWires().length) return false;
  const n = planeOf(F).normal;
  const edges = F.clone().outerWire().edges;
  if (edges.length < 3) return true;
  // The outline as points in order (curved edges sampled), walked end to end.
  const tol = 1e-6 * (1 + len(tup(F.center)) + Math.sqrt(measureArea(F)));
  const pts: Vec3[] = [];
  const used = new Set<number>();
  let at = tup(edges[0].startPoint);
  for (let step = 0; step < edges.length; step++) {
    const k = edges.findIndex((e, i) => !used.has(i) && (dist(tup(e.startPoint), at) < tol || dist(tup(e.endPoint), at) < tol));
    if (k < 0) return false;
    used.add(k);
    const e = edges[k];
    const rev = dist(tup(e.startPoint), at) >= tol;
    const m = e.geomType === "LINE" ? 1 : 8;
    for (let j = 0; j < m; j++) pts.push(tup(e.pointAt(rev ? 1 - j / m : j / m)));
    at = tup(rev ? e.startPoint : e.endPoint);
  }
  let sign = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const c = pts[(i + 2) % pts.length];
    const t = dot(cross(sub(b, a), sub(c, b)), n);
    if (Math.abs(t) < tol * tol) continue;
    if (sign && Math.sign(t) !== sign) return false;
    sign = Math.sign(t);
  }
  return true;
}

/**
 * Neighbours that the half-space trick can't extend: curved surfaces other
 * than cylinders standing straight on F (cones, lofted and revolved sides…).
 */
function needsContinuation(body: Shape3D, F: Face): boolean {
  const n = planeOf(F).normal;
  return neighbours(body, F).some((g) => {
    if (g.geomType === "PLANE") return false;
    if (g.geomType === "CYLINDRE") {
      const cy = cylinderOf(g);
      // Upright walls, or fillets running along F (taken off and put back).
      return !cy || (Math.abs(Math.abs(dot(cy.a, n)) - 1) > 1e-6 && Math.abs(dot(cy.a, n)) > 1e-6);
    }
    return true;
  });
}

/**
 * Offset flat face F by d when its neighbours are curved: each point of F's
 * outline carries on along its neighbour surface (the way that surface is
 * heading there) until it is d further out; the slab between the old and the
 * new outline is added (d > 0) or taken away (d < 0).
 */
function offsetByContinuation(body: Shape3D, F: Face, d: number): Shape3D {
  const fp = planeOf(F);
  const n = fp.normal;
  const size = sizeOf(body);
  const tol = size * 1e-6;
  const nbrs = neighbours(body, F);
  // F's outline as a loop of edges, end to end.
  const edges = F.clone().outerWire().edges;
  const ends = (e: { startPoint: { toTuple(): number[] }; endPoint: { toTuple(): number[] } }): [Vec3, Vec3] => [e.startPoint.toTuple() as Vec3, e.endPoint.toTuple() as Vec3];
  const order: { k: number; rev: boolean }[] = [{ k: 0, rev: false }];
  const used = new Set([0]);
  let at = ends(edges[0])[1];
  while (used.size < edges.length) {
    const k = edges.findIndex((e, i) => !used.has(i) && ends(e).some((q) => dist(q, at) < tol * 10));
    if (k < 0) throw new Error("outline not closed");
    used.add(k);
    const [a, b] = ends(edges[k]);
    const rev = dist(b, at) < dist(a, at);
    order.push({ k, rev });
    at = rev ? a : b;
  }
  // Where a point on edge k goes: along its neighbour, across the edge, out of F's plane.
  // Cutting: the cutter reaches a hair past the walls and above F, so no sliver stays on the coincident surfaces.
  const eps = d < 0 ? size * 1e-4 : 0;
  const outward = (k: number, t: number): Vec3 => {
    const e = edges[k];
    const g = nbrs.find((h) => h.edges.some((he) => he.isSame(e)))!;
    const ng = norm(tup(g.normalAt(tup(e.pointAt(t)))));
    const flat = sub(ng, scale(n, dot(ng, n)));
    return len(flat) < 1e-9 ? [0, 0, 0] : scale(norm(flat), eps);
  };
  const movedAt = (k: number, t: number): Vec3 => {
    const e = edges[k];
    const g = nbrs.find((h) => h.edges.some((he) => he.isSame(e)));
    if (!g) throw new Error("no neighbour");
    const p = tup(e.pointAt(t));
    const dt = 1e-3;
    const tangent = norm(sub(tup(e.pointAt(Math.min(1, t + dt))), tup(e.pointAt(Math.max(0, t - dt)))));
    // Just inside the edge on g: its normal there (exactly on the edge it can be the other face's).
    const ng = norm(tup(g.normalAt(p)));
    let dir = norm(cross(ng, tangent));
    if (dot(dir, n) < 0) dir = scale(dir, -1);
    const rise = dot(dir, n);
    if (rise < 0.15) throw new Error("neighbour runs along the face");
    return add(add(p, scale(dir, d / rise)), outward(k, t));
  };
  const liftedAt = (k: number, t: number): Vec3 => add(add(tup(edges[k].pointAt(t)), scale(n, eps)), outward(k, t));
  // Corners: shared by two edges, moved the same way for both (halfway between their two estimates).
  const m = order.length;
  const corner: Vec3[] = order.map(({ k, rev }, i) => {
    const prev = order[(i - 1 + m) % m];
    const a = movedAt(k, rev ? 1 : 0);
    const b = movedAt(prev.k, prev.rev ? 0 : 1);
    return scale(add(a, b), 0.5);
  });
  const lowerCorner: Vec3[] = order.map(({ k, rev }) => liftedAt(k, rev ? 1 : 0));
  const lowerEdges = eps
    ? order.map(({ k, rev }, i) => {
        // Cutting: F's outline nudged up and out (see eps).
        const c0 = lowerCorner[i];
        const c1 = lowerCorner[(i + 1) % m];
        if (edges[k].geomType === "LINE") return makeLine(c0, c1);
        const pts: Vec3[] = [];
        for (let j = 0; j <= 24; j++) pts.push(liftedAt(k, rev ? 1 - j / 24 : j / 24));
        pts[0] = c0;
        pts[24] = c1;
        return makeBSplineApproximation(pts, { tolerance: size * 1e-6, degMax: 5, degMin: 2 });
      })
    : order.map(({ k }) => edges[k].clone());
  const upperEdges = order.map(({ k, rev }, i) => {
    const e = edges[k];
    const c0 = corner[i];
    const c1 = corner[(i + 1) % m];
    if (e.geomType === "LINE") return makeLine(c0, c1);
    // A curved edge: a smooth curve through its moved points.
    const pts: Vec3[] = [];
    for (let j = 0; j <= 24; j++) pts.push(movedAt(k, rev ? 1 - j / 24 : j / 24));
    pts[0] = c0;
    pts[24] = c1;
    return makeBSplineApproximation(pts, { tolerance: size * 1e-6, degMax: 5, degMin: 2 });
  });
  const a = assembleWire(lowerEdges);
  const b = assembleWire(upperEdges);
  const slab = loft(d > 0 ? [a, b] : [b, a], { ruled: true });
  const out = d > 0 ? body.fuse(slab) : body.cut(slab);
  return sanity(body, out);
}

/** Offset a face along its normal: flat faces move, cylinders change radius. */
export function offsetFace(body: Shape3D, F: Face, d: number): Shape3D {
  // Curved neighbours, or a face with inward corners (a zigzag, an L): the
  // half-space trick would clip it to its convex part, so each edge carries on
  // along its own neighbour instead.
  if (F.geomType === "PLANE" && (needsContinuation(body, F) || !convexFace(F))) {
    try {
      return offsetByContinuation(body, F, d);
    } catch {
      // fall through to the plane trick
    }
  }
  if (F.geomType === "PLANE") {
    const { origin, normal } = planeOf(F);
    return replaceFacePlane(body, F, { origin: add(origin, scale(normal, d)), normal, xDir: xDirFor(normal) });
  }
  const cy = cylinderOf(F);
  if (!cy) throw new Error("Offset works on flat and cylindrical faces");
  const r2 = cy.r + cy.s * d;
  if (r2 <= 1e-6) throw new Error("That offset would remove the whole round face");
  const L = sizeOf(body) * 4;
  // Bounded by its neighbours carried on (a round face swept past half a turn
  // isn't one wedge: the cells it covers, joined).
  const E = faceColumn(body, F, L);
  const ring = infiniteCylinder(cy, Math.max(cy.r, r2), L).cut(infiniteCylinder(cy, Math.min(cy.r, r2), L));
  const slab = E.intersect(ring);
  if (isEmpty(slab)) throw new Error("Nothing to offset");
  if (d < 0) return sanity(body, body.cut(slab));
  let out = body.fuse(slab);
  // Past where the round face ended there may be no material under it: the
  // ring added there would leave a hollow groove (its inside, on the old
  // surface, open to the air). Fill what's under those pieces too.
  const tol = sizeOf(body) * 1e-6;
  const onOld = (g: Face) => g.geomType === "CYLINDRE" && samples(g).every((p) => Math.abs(radial(p) - cy.r) < tol * 10);
  const radial = (p: Vec3) => {
    const rel = sub(p, cy.c);
    return len(sub(rel, scale(cy.a, dot(rel, cy.a))));
  };
  const left = out.faces.filter(onOld);
  if (left.length) {
    const under = E.intersect(infiniteCylinder(cy, cy.r, L)).cut(out);
    const pieces = isEmpty(under) ? [] : subShapes(under, "SOLID").map((x: any) => cast(x) as Shape3D);
    for (const piece of pieces) {
      const touches = piece.faces.some((g) => onOld(g) && left.some((h) => dist(tup(g.center), tup(h.center)) < tol * 100 && Math.abs(measureArea(g) - measureArea(h)) < measureArea(h) * 1e-3 + tol));
      if (touches) out = out.fuse(piece);
    }
  }
  return sanity(body, out);
}

/** Remove a face; its neighbours extend to close the gap (fillets, chamfers, holes). */
/**
 * Delete a face as if it had never been there: its neighbours carry on along
 * their own surfaces until they meet. A face that's part of a fillet (or any
 * smooth blend) that can't go on its own takes the whole blend with it.
 */
export function deleteFace(body: Shape3D, F: Face): Shape3D {
  try {
    return deleteFaces(body, samePieces(body, F));
  } catch (err) {
    const chain = blendChain(body, F);
    if (chain.length > 1) {
      try {
        return deleteFaces(body, chain);
      } catch {
        // try the whole fillet below
      }
    }
    // A fillet put on several edges at once meets itself at mitred corners
    // (no smooth run): all its pieces of the same radius go together.
    const group = filletGroup(body, F);
    if (group.length > chain.length) return deleteFaces(body, group);
    throw err;
  }
}

/**
 * F and the faces next to it on the very same surface (one round surface is
 * often split in two along its seam): they're one face to the user.
 */
function samePieces(body: Shape3D, F: Face): Face[] {
  const tol = sizeOf(body) * 1e-6;
  const out: Face[] = [F];
  // A round surface cut in pieces (by a seam, or a hole through a fillet) is
  // one feature wherever its pieces are; flat ones only where they touch (two
  // separate faces in one plane are often unrelated).
  const pool = F.geomType === "PLANE" ? null : body.faces;
  for (let i = 0; i < out.length; i++)
    for (const g of pool ?? neighbours(body, out[i])) {
      if (g.geomType !== F.geomType || out.some((x) => x.isSame(g))) continue;
      if (samples(g).every((q) => offSurface(F, q) < tol)) out.push(g);
    }
  return out;
}

/** Radius of a round face (cylinder), or null. */
function radiusOf(f: Face): number | null {
  return cylinderOf(f)?.r ?? null;
}

/**
 * The pieces of one fillet: F's smooth chain, plus round faces of the same
 * radius it meets (at a mitre) — and theirs, and so on.
 */
export function filletGroup(body: Shape3D, F: Face): Face[] {
  const r = radiusOf(F);
  const out: Face[] = [...blendChain(body, F)];
  if (r === null) return out;
  const tol = r * 1e-4;
  for (let i = 0; i < out.length; i++)
    for (const g of neighbours(body, out[i])) {
      if (g.geomType === "PLANE" || out.some((x) => x.isSame(g))) continue;
      const rg = radiusOf(g);
      if (rg !== null && Math.abs(rg - r) < tol) out.push(...blendChain(body, g).filter((x) => !out.some((y) => y.isSame(x))));
      else if (rg === null && tangentAlong(out[i], g)) out.push(g);
    }
  return out;
}

/**
 * The smooth blend a face belongs to: it and the curved faces running on from
 * it with no crease (a fillet along several edges, its corner pieces).
 */
export function blendChain(body: Shape3D, F: Face): Face[] {
  if (F.geomType === "PLANE") return [F];
  const out: Face[] = [F];
  for (let i = 0; i < out.length; i++) {
    const f = out[i];
    for (const g of neighbours(body, f)) {
      if (g.geomType === "PLANE" || out.some((x) => x.isSame(g))) continue;
      if (tangentAlong(f, g)) out.push(g);
    }
  }
  return out;
}

/** Do two faces meet without a crease (same normal across their shared edge)? */
function tangentAlong(f: Face, g: Face): boolean {
  const shared = f.edges.find((e) => g.edges.some((x) => x.isSame(e)));
  if (!shared) return false;
  try {
    const p = tup(shared.pointAt(0.5));
    const nf = norm(tup(f.normalAt(p)));
    const ng = norm(tup(g.normalAt(p)));
    return dot(nf, ng) > 0.996;
  } catch {
    return false;
  }
}

/** How far a point is from a face's whole (untrimmed, extended) surface. */
function offSurface(f: Face, q: Vec3): number {
  const oc = getOC();
  const pt = new oc.gp_Pnt(q[0], q[1], q[2]);
  try {
    const proj = new oc.GeomAPI_ProjectPointOnSurf(pt, oc.BRep_Tool.Surface(f.wrapped), oc.Extrema_ExtAlgo.Extrema_ExtAlgo_Grad);
    try {
      return proj.NbPoints() ? proj.LowerDistance() : Infinity;
    } finally {
      proj.delete();
    }
  } catch {
    return Infinity;
  } finally {
    pt.delete();
  }
}

/** A few points spread over a face (on its surface). */
function samples(f: Face): Vec3[] {
  const out: Vec3[] = [];
  for (const [u, v] of [[0.5, 0.5], [0.2, 0.3], [0.8, 0.7], [0.3, 0.8], [0.7, 0.2]])
    try {
      out.push(tup(f.pointOnSurface(u, v)));
    } catch {
      /* off the face's range */
    }
  return out;
}

/** Solid on the material side (behind the outward normal) of a face's surface — or null if that can't be made. */
function behind(f: Face, L: number): Shape3D | null {
  if (f.geomType === "PLANE") {
    const { origin, normal } = planeOf(f);
    return halfSpace({ origin, normal: scale(normal, -1), xDir: xDirFor(normal) }, L);
  }
  if (f.geomType === "CYLINDRE") {
    const cy = cylinderOf(f);
    if (!cy) return null;
    const inside = infiniteCylinder(cy, cy.r, L);
    // A boss: the material is inside it; a hole: outside it.
    return cy.s > 0 ? inside : bigBox(L, cy.c).cut(inside);
  }
  if (f.geomType === "SPHERE") {
    const sp = sphereOf(f);
    if (!sp) return null;
    const ball = makeSphere(sp.r).translate(sp.c) as Shape3D;
    return sp.s > 0 ? ball : bigBox(L, sp.c).cut(ball);
  }
  return null;
}

/** The air side of a face's surface (in front of it). */
function inFront(f: Face, L: number): Shape3D | null {
  if (f.geomType === "PLANE") {
    const { origin, normal } = planeOf(f);
    return halfSpace({ origin, normal, xDir: xDirFor(normal) }, L);
  }
  const b = behind(f, L);
  if (!b) return null;
  const c = f.boundingBox.center as Vec3;
  return bigBox(L, c).cut(b);
}

function bigBox(L: number, c: Vec3): Shape3D {
  const h = vary(L);
  return halfSpace({ origin: sub(c, [0, 0, h]), xDir: [1, 0, 0], normal: [0, 0, 1] }, 2 * h);
}

/** Centre, radius and side of a spherical face (from two surface points and their normals). */
function sphereOf(f: Face): { c: Vec3; r: number; s: number } | null {
  const at = (u: number, v: number) => {
    const p = tup(f.pointOnSurface(u, v));
    return { p, n: norm(tup(f.normalAt(p))) };
  };
  const a = at(0.3, 0.4);
  const b = at(0.7, 0.6);
  const dn = len(sub(a.n, b.n));
  if (dn < 1e-9) return null;
  const r = len(sub(a.p, b.p)) / dn;
  const cOut = sub(a.p, scale(a.n, r));
  const cIn = add(a.p, scale(a.n, r));
  const s = dist(cOut, sub(b.p, scale(b.n, r))) < dist(cIn, add(b.p, scale(b.n, r))) ? 1 : -1;
  return { c: s > 0 ? cOut : cIn, r, s };
}

/**
 * Delete faces S together, as if they'd never been there: the gap they leave
 * is closed by their neighbours carried on along their own surfaces. Several
 * ways are tried — fill the space behind every neighbour (an outside fillet,
 * a chamfer, a hole), or take away what's in front of them (an inside fillet,
 * a boss) — bounded by S's own surface where it can be, else by a box round S.
 * One counts only if every face it leaves lies on a surface that was already
 * there (nothing new invented) and S is gone; the smallest change wins.
 */
export function deleteFaces(body: Shape3D, S: Face[]): Shape3D {
  const size = sizeOf(body);
  const L = size * 4;
  const inS = (g: Face) => S.some((f) => f.isSame(g));
  const N = body.faces.filter((g) => !inS(g) && S.some((f) => neighbours(body, f).some((x) => x.isSame(g))));
  if (!N.length) throw new Error("This face can't be removed — nothing around it to close the gap");
  const kept = body.faces.filter((g) => !inS(g));
  const tol = size * 1e-5;
  // Within the body's own extent (a little more): nothing is filled out into space.
  const bb = body.boundingBox;
  const lo = bb.bounds[0] as number[];
  const hi = bb.bounds[1] as number[];
  // Exactly its box: a fill ending flush with an outer face merges into it (a hair beyond would stick out).
  const pad = 0;
  const boxOf = (a: number[], b: number[]) =>
    basicFaceExtrusion(
      makePolygon([
        [a[0], a[1], a[2]],
        [b[0], a[1], a[2]],
        [b[0], b[1], a[2]],
        [a[0], b[1], a[2]],
      ]),
      new Vector([0, 0, b[2] - a[2]]),
    );
  // Near S: its own box, a little bigger.
  const sLo = [0, 1, 2].map((k) => Math.min(...S.map((f) => f.boundingBox.bounds[0][k])) - size * 1e-3);
  const sHi = [0, 1, 2].map((k) => Math.max(...S.map((f) => f.boundingBox.bounds[1][k])) + size * 1e-3);
  const nearS = boxOf(sLo, sHi);
  // The corner a fillet rounded can stick out past the body's box (faces
  // meeting at an angle other than 90°): S's own size of room round it.
  const room = Math.hypot(sHi[0] - sLo[0], sHi[1] - sLo[1], sHi[2] - sLo[2]);
  const within = boxOf(
    lo.map((v, k) => Math.min(v - pad, sLo[k] - room)),
    hi.map((v, k) => Math.max(v + pad, sHi[k] + room)),
  );

  const meet = (parts: (Shape3D | null)[]): Shape3D | null => {
    let r: Shape3D | null = null;
    for (const p of parts) {
      if (!p) continue;
      r = r ? r.intersect(p) : p;
      if (isEmpty(r)) return null;
    }
    return r;
  };
  /** Behind every neighbour (but `skip`): the space a fill may take. */
  const behindAll = (skip?: Face) => meet([within, ...N.filter((g) => g !== skip).map((g) => behind(g, L))]);
  /** In front of the given neighbours, behind the rest (but `skip`). */
  const frontOf = (front: (g: Face) => boolean, skip?: Face) => {
    let r: Shape3D = within;
    for (const g of N) {
      if (g === skip) continue;
      const b = behind(g, L);
      if (!b) continue;
      r = front(g) ? r.cut(b) : r.intersect(b);
      if (isEmpty(r)) return null;
    }
    return r;
  };
  // Faces S runs smoothly into (a fillet's walls) — not the ones it ends on.
  const tangent = new Set(N.filter((g) => S.some((f) => tangentAlong(f, g))));
  const single = S.length === 1 ? S[0] : null;
  // A round fillet's corner lies beyond its chord — the plane through the two
  // lines where it meets its walls — on the side away from its axis: the
  // space it rounded off is between the fillet and that corner, nowhere else.
  const chord = (): Shape3D | null => {
    if (!single || single.geomType !== "CYLINDRE") return null;
    const cy = cylinderOf(single);
    const walls = [...tangent].filter((g) => g.geomType === "PLANE");
    if (!cy || walls.length !== 2) return null;
    const on = walls.map((g) => single.edges.find((e) => g.edges.some((x) => x.isSame(e))));
    if (on.some((e) => !e)) return null;
    const p1 = tup(on[0]!.pointAt(0.5));
    const p2 = tup(on[1]!.pointAt(0.5));
    let n = cross(cy.a, sub(p2, p1));
    if (len(n) < 1e-12) return null;
    n = norm(n);
    // Away from the axis.
    if (dot(sub(cy.c, p1), n) > 0) n = scale(n, -1);
    return halfSpace({ origin: p1, normal: n, xDir: xDirFor(n) }, L);
  };
  const airOfS = () => (single ? meet([inFront(single, L) ?? nearS, chord()]) : nearS);
  const matOfS = () => (single ? meet([behind(single, L) ?? nearS, chord()]) : nearS);
  const fill = (e: Shape3D | null, bound: Shape3D | null) => (e && bound ? body.fuse(meet([e, bound])!) : null);
  const cut = (e: Shape3D | null, bound: Shape3D | null) => (e && bound ? body.cut(meet([e, bound])!) : null);
  // Each neighbour bounded on the side S itself is on: a fillet's walls from
  // behind (or in front, for an inside one), its end faces towards it —
  // whichever way they face (one may be a pocket's wall facing the fillet).
  const mid = tup(S[0].pointOnSurface(0.5, 0.5));
  const bySide = () => {
    let r: Shape3D = within;
    for (const g of N) {
      const b = behind(g, L);
      if (!b) continue;
      let front = false;
      if (g.geomType === "PLANE") {
        const { origin, normal } = planeOf(g);
        front = dot(sub(mid, origin), normal) > tol;
      }
      r = front ? r.cut(b) : r.intersect(b);
      if (isEmpty(r)) return null;
    }
    return r;
  };
  const candidates: { name: string; make: () => Shape3D | null }[] = [
    { name: "fill by side", make: () => fill(bySide(), airOfS()) },
    { name: "cut by side", make: () => cut(bySide(), matOfS()) },
    // Fill: behind every neighbour, on the air side of S (a fillet's wedge, a chamfer, a hole).
    { name: "fill", make: () => fill(behindAll(), airOfS()) },
    { name: "fill near", make: () => fill(behindAll(), nearS) },
    // Take away: in front of the faces S blends into (and behind the ones it ends on), on S's material side (an inside fillet).
    { name: "cut blend", make: () => (tangent.size ? cut(frontOf((g) => tangent.has(g)), matOfS()) : null) },
    // …or in front of all of them (a boss).
    { name: "cut", make: () => cut(frontOf(() => true), matOfS()) },
    // One neighbour that goes along with S (a blind hole's floor, a boss's top): left out.
    ...N.flatMap((g) => [
      { name: "fill but one", make: () => fill(behindAll(g), airOfS()) },
      { name: "cut but one", make: () => cut(frontOf(() => true, g), matOfS()) },
    ]),
  ];
  const v0 = Math.abs(measureVolume(body));
  let best: { out: Shape3D; change: number } | null = null;
  for (const c of candidates) {
    let out: Shape3D | null = null;
    try {
      out = c.make();
      if (out) out = unify(out);
    } catch {
      out = null;
    }
    if (!out || isEmpty(out)) continue;
    // Nothing new: every face lies on a surface the body already had (S's aside).
    const honest = out.faces.every((g) => {
      const pts = samples(g);
      return kept.some((f) => f.geomType === g.geomType && pts.every((q) => offSurface(f, q) < tol));
    });
    if (!honest) continue;
    // And S is gone: no face left on S's surface that isn't also on a kept one's.
    const left = out.faces.some((g) => {
      const pts = samples(g);
      return S.some((f) => f.geomType === g.geomType && pts.every((q) => offSurface(f, q) < tol)) && !kept.some((f) => f.geomType === g.geomType && pts.every((q) => offSurface(f, q) < tol));
    });
    if (left) continue;
    // The faces S ran smoothly into carry on: they're still there (deleting a
    // fillet never takes away the walls it rounded).
    const walls = [...tangent].every((g) => {
      const pts = samples(g);
      return out!.faces.some((h) => h.geomType === g.geomType && samples(h).every((q) => offSurface(g, q) < tol)) && pts.length > 0;
    });
    if (!walls) continue;
    // Every face that wasn't next to S is still there (on its own surface):
    // deleting a big wall must not just keep some other piece of the part.
    const stays = kept.every((g) => {
      if (N.some((x) => x.isSame(g))) return true;
      // (most of it: a scrap on the same plane doesn't count)
      const on = out!.faces.filter((h) => h.geomType === g.geomType && samples(h).every((q) => offSurface(g, q) < tol));
      return on.reduce((a, h) => a + measureArea(h), 0) >= measureArea(g) * 0.5;
    });
    if (!stays) continue;
    const change = Math.abs(Math.abs(measureVolume(out)) - v0);
    if (!(change > v0 * 1e-9)) continue;
    // Only what was round S changed: what was added or taken away lies within
    // S's own box (a "delete" that carves off half the part isn't one).
    try {
      const reach = room;
      for (const d of [out.cut(body), body.cut(out)]) {
        if (isEmpty(d) || Math.abs(measureVolume(d)) < v0 * 1e-9) continue;
        const db = d.boundingBox.bounds;
        if ([0, 1, 2].some((k) => db[0][k] < sLo[k] - reach || db[1][k] > sHi[k] + reach)) throw new Error("reaches out");
      }
    } catch {
      continue;
    }
    if (!best || change < best.change) best = { out, change };
  }
  if (!best) throw new Error(S.length > 1 ? "This fillet can't be removed — the faces around it don't meet up when carried on" : "This face can't be removed — its neighbours don't close the gap");
  return sanity(body, best.out);
}

/**
 * Take one fillet piece off while moving a face around it (Offset Face): the
 * original fill-or-cut within the piece's own box, which that step is tuned for.
 */
function takeOffBlend(body: Shape3D, F: Face): Shape3D {
  const L = sizeOf(body) * 4;
  const { p, n } = onFace(body, F);
  const q = sub(p, scale(n, sizeOf(body) * 1e-3));
  // Only fill within the face's own box: the gap a face leaves lies inside it, and
  // any slack either falls inside the material or is cut off by a neighbour.
  const b = F.boundingBox;
  const lo = b.bounds[0] as number[];
  const hi = b.bounds[1] as number[];
  const pad = sizeOf(body) * 1e-3;
  const box = makePolygon([
    [lo[0] - pad, lo[1] - pad, lo[2] - pad],
    [hi[0] + pad, lo[1] - pad, lo[2] - pad],
    [hi[0] + pad, hi[1] + pad, lo[2] - pad],
    [lo[0] - pad, hi[1] + pad, lo[2] - pad],
  ]);
  const local = basicFaceExtrusion(box, new Vector([0, 0, hi[2] - lo[2] + 2 * pad]));
  const region = extendedRegion(body, F, q, L).intersect(local);
  // Still has the face (or a copy of it a hair away): that way doesn't close the gap.
  const fn = norm(tup(F.normalAt()));
  const gone = (out: Shape3D) =>
    !out.faces.some((g) => g.geomType === F.geomType && dot(norm(tup(g.normalAt())), fn) > 0.999 && dist(tup(g.center), tup(F.center)) < sizeOf(body) * 0.02);
  // A face on an outside corner (convex fillet, chamfer, hole wall) left material
  // out: fill it back in. One in an inside corner (concave fillet) added material:
  // take it away. Both are tried; the smallest change that removes the face wins.
  const v0 = measureVolume(body);
  const tries: { out: Shape3D; change: number }[] = [];
  for (const make of [() => body.fuse(region), () => body.cut(region)]) {
    try {
      const out = unify(make());
      // Removing a face never needs new faces: one that adds some cut a new shape in.
      if (!isEmpty(out) && gone(out) && out.faces.length < body.faces.length) tries.push({ out, change: Math.abs(measureVolume(out) - v0) });
    } catch {
      // that way doesn't work here
    }
  }
  if (!tries.length) throw new Error("This face can't be removed — its neighbours don't close the gap");
  tries.sort((a, b) => a.change - b.change);
  return sanity(body, tries[0].out);
}

/** Merge faces/edges that lie on the same surface (removes imprinted edges). */
export function unify(body: Shape3D): Shape3D {
  const oc = getOC();
  const u = new oc.ShapeUpgrade_UnifySameDomain(body.wrapped, true, true, false);
  try {
    // Surfaces rebuilt from samples match the originals only to ~1e-9 relative.
    u.SetLinearTolerance(sizeOf(body) * 1e-6);
    u.SetAngularTolerance(1e-6);
    u.Build();
    return cast(u.Shape()) as Shape3D;
  } catch {
    // Merging is tidying only: if OpenCascade can't (a fillet ending on a face split in two), keep the pieces.
    return body;
  } finally {
    u.delete();
  }
}

function isEmpty(s: Shape3D): boolean {
  try {
    return s.faces.length === 0;
  } catch {
    return true;
  }
}

/** Reject results that exploded (an unbounded region leaked out). */
function sanity(before: Shape3D, after: Shape3D): Shape3D {
  if (isEmpty(after)) throw new Error("The result would be empty");
  if (sizeOf(after) > sizeOf(before) * 3 + 1) throw new Error("This change can't be made cleanly here (the neighbouring faces don't enclose it)");
  return unify(after);
}
