// Direct face editing with booleans: offset a face (neighbours extend along their
// own surfaces), move/tilt a flat face, delete a face (neighbours close the gap).
//
// The trick: near face F the body equals E ∩ "behind F", where E is the
// intersection of the *extended* neighbouring surfaces — each taken on the side
// the body is on (planes → half-spaces, cylinders → infinite cylinders). Changing
// F then only means adding/removing the right slab of E.

import { assembleWire, basicFaceExtrusion, getOC, loft, makeBSplineApproximation, makeCylinder, makeLine, makePolygon, measureArea, measureVolume, cast, Vector, type Face, type Shape3D } from "replicad";
import type { PlaneDef, Vec3 } from "../doc/types";
import { add, cross, dist, dot, len, norm, scale, sub, xDirFor } from "../geom";

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
  for (const g of neighbours(body, F)) {
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
    }
    // Other surface types are left unbounded (rare next to a face being edited).
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
    try {
      return aroundBlends(body, F, blends, to);
    } catch {
      // Couldn't rebuild the fillets: fall back to editing straight through them.
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
    b = deleteFace(b, g);
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
      const m = tup(e.pointAt(0.5));
      return on(m, p1) && on(m, p2);
    });
    if (!edges.length) throw new Error("edge lost");
    b = b.fillet(bl.r, (finder) => finder.inList(edges)) as Shape3D;
  }
  return sanity(body, b);
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
  const { p, n } = onFace(body, F);
  const q = sub(p, scale(n, sizeOf(body) * 1e-3));
  const E = extendedRegion(body, F, q, L);
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
  if (F.geomType === "PLANE" && needsContinuation(body, F)) {
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
  // q: just inside the material next to the face.
  const { p, n } = onFace(body, F);
  const q = sub(p, scale(n, sizeOf(body) * 1e-3));
  const E = extendedRegion(body, F, q, L);
  const ring = infiniteCylinder(cy, Math.max(cy.r, r2), L).cut(infiniteCylinder(cy, Math.min(cy.r, r2), L));
  const slab = E.intersect(ring);
  if (isEmpty(slab)) throw new Error("Nothing to offset");
  return sanity(body, d > 0 ? body.fuse(slab) : body.cut(slab));
}

/** Remove a face; its neighbours extend to close the gap (fillets, chamfers, holes). */
export function deleteFace(body: Shape3D, F: Face): Shape3D {
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
  // Surfaces rebuilt from samples match the originals only to ~1e-9 relative.
  u.SetLinearTolerance(sizeOf(body) * 1e-6);
  u.SetAngularTolerance(1e-6);
  u.Build();
  return cast(u.Shape()) as Shape3D;
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
