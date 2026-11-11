// Sketches put onto a body's faces: Project as Edge (the curves drawn onto the
// faces they land on, the faces split along them) and Wrap & Emboss (a sketch's
// shapes wrapped round a round face, raised from it or sunk into it).

import { cast, draw, getOC, makeCompound, makeLine, makeVertex, type Drawing, type Edge, type Face, type Shape3D } from "replicad";
import type { Vec3 } from "../doc/types";
import { cross, dist, dot, len, norm, scale, sub } from "../geom";
import { cylinderOf } from "./faceEdit";
import { measureVolume } from "./ocFree";

const tup = (v: { toTuple(): number[] }) => v.toTuple() as Vec3;

type Src = { face: Face; normal: Vec3 }[];

/** A body's size: its bounding box's diagonal, and its middle. */
function sizeOf(body: Shape3D): { d: number; c: Vec3 } {
  const bb = body.boundingBox;
  const c = bb.center as unknown as number[];
  return { d: Math.hypot(bb.width, bb.height, bb.depth), c: [c[0], c[1], c[2]] };
}

/**
 * Project as Edge: curves (a sketch's outlines, or edges) drawn onto the body
 * along a direction, the faces split along them. Which of the lines found are
 * kept is `keep`'s to say (those seen from the sketch, those on one face).
 * Nothing else changes: the new edges are there to push, pull, fillet or
 * sketch from.
 */
export function imprint(body: Shape3D, curves: Edge[], dir: Vec3, keep: (e: Edge) => boolean): Shape3D {
  const oc = getOC();
  const { d: D, c: mid } = sizeOf(body);
  const n = norm(dir);
  const kept: Edge[] = [];
  const progress = new oc.Message_ProgressRange();
  const sec = new oc.BRepAlgoAPI_Section();
  try {
    // Each curve swept both ways through the whole body: where those walls cross the body's faces.
    const walls = curves.map((e) => {
      const far = D + dist(tup(e.pointAt(0.5)), mid) + 1;
      const v = new oc.gp_Vec(n[0] * 2 * far, n[1] * 2 * far, n[2] * 2 * far);
      const pr = new oc.BRepPrimAPI_MakePrism(e.clone().translate(scale(n, -far)).wrapped, v, false, true);
      try {
        return cast(pr.Shape());
      } finally {
        pr.delete();
        v.delete();
      }
    });
    sec.Init1(body.wrapped);
    sec.Init2(makeCompound(walls as never).wrapped);
    sec.Build(progress);
    const cut = cast(sec.Shape());
    for (const e of "edges" in cut ? (cut.edges as Edge[]) : []) if (keep(e)) kept.push(e);
  } finally {
    sec.delete();
    progress.delete();
  }
  if (!kept.length) throw new Error("Nothing lands on the body's faces seen from there");
  return splitFaces(body, kept);
}

/** The lines seen from a sketch's plane (through o, square to n): not on the far side, nor behind other faces. */
export function seenFrom(body: Shape3D, o: Vec3, n: Vec3): (e: Edge) => boolean {
  const eps = Math.max(1e-4, sizeOf(body).d * 1e-5);
  return (e) => seen(e, o, norm(n), body, eps);
}

/** The lines on one face. */
export function onFace(body: Shape3D, F: Face): (e: Edge) => boolean {
  const oc = getOC();
  const eps = Math.max(1e-4, sizeOf(body).d * 1e-5);
  return (e) => {
    const ds = new oc.BRepExtrema_DistShapeShape(makeVertex(tup(e.pointAt(0.5))).wrapped, F.wrapped);
    try {
      return ds.IsDone() && ds.Value() < eps;
    } finally {
      ds.delete();
    }
  };
}

/**
 * Whether an edge is seen from the sketch's plane: nothing of the body between
 * them along the normal (a step just off the edge towards the plane is in the
 * open, and so is the way on to the plane).
 */
function seen(e: Edge, o: Vec3, n: Vec3, body: Shape3D, eps: number): boolean {
  const oc = getOC();
  const pm = tup(e.pointAt(0.5));
  const h = dot(sub(pm, o), n);
  if (Math.abs(h) < 2 * eps) return true;
  const sg = Math.sign(h);
  const q = sub(pm, scale(n, sg * eps));
  const pp = sub(pm, scale(n, h - sg * eps));
  const seg = makeLine(q, pp);
  const ds = new oc.BRepExtrema_DistShapeShape(seg.wrapped, body.wrapped);
  try {
    return ds.IsDone() && ds.Value() > eps * 0.05;
  } finally {
    ds.delete();
  }
}

/** The body's faces split along edges lying on them (one solid still). */
function splitFaces(body: Shape3D, edges: Edge[]): Shape3D {
  const oc = getOC();
  const sp = new oc.BRepAlgoAPI_Splitter();
  const args = new oc.NCollection_List_TopoDS_Shape();
  const tools = new oc.NCollection_List_TopoDS_Shape();
  const progress = new oc.Message_ProgressRange();
  try {
    args.Append(body.wrapped);
    tools.Append(makeCompound(edges).wrapped);
    sp.SetArguments(args);
    sp.SetTools(tools);
    sp.Build(progress);
    if (!sp.IsDone()) throw new Error("The faces couldn't be split along the sketch");
    const out = cast(sp.Shape()) as Shape3D;
    const solids = out.constructor.name === "Solid" ? [out] : ((out as unknown as { solids?: Shape3D[] }).solids ?? []);
    if (solids.length !== 1) throw new Error("The faces couldn't be split along the sketch");
    return solids[0];
  } finally {
    sp.delete();
    args.delete();
    tools.delete();
    progress.delete();
  }
}

/**
 * Wrap & Emboss: the sketch's shapes wrapped round a round face, lengths kept
 * (a line along the sketch goes as far round the face), then raised from it
 * (height > 0) or sunk into it (height < 0) square to the face. The sketch is
 * on a plane along the face's axis (touching it, or anywhere beside it): where
 * the plane is nearest the axis is where the wrap starts from.
 */
export function wrapOnto(body: Shape3D, round: Face, src: Src, height: number): Shape3D {
  if (Math.abs(height) < 1e-6) throw new Error("Height is zero");
  const cy = cylinderOf(round);
  if (!cy) throw new Error("Wrap goes on a round face (a cylinder)");
  const oc = getOC();
  const ad = new oc.BRepAdaptor_Surface(round.wrapped, true);
  const cyl = ad.Cylinder();
  const pos = cyl.Position();
  const Loc: Vec3 = [pos.Location().X(), pos.Location().Y(), pos.Location().Z()];
  const X = norm([pos.XDirection().X(), pos.XDirection().Y(), pos.XDirection().Z()]);
  const Z = norm([pos.Direction().X(), pos.Direction().Y(), pos.Direction().Z()]);
  const r = cyl.Radius();
  ad.delete();
  // The way the face's U goes round (replicad turns a left-handed one round).
  const Y = cross(Z, X);
  const n = norm(src[0].normal);
  if (Math.abs(dot(n, Z)) > 1e-6) throw new Error("Draw the sketch on a plane along the round face's axis");
  const o = tup(src[0].face.center);
  // The plane's nearest point to the axis: where the wrap starts.
  let R0 = sub(o, Loc);
  R0 = sub(R0, scale(Z, dot(R0, Z)));
  if (len(R0) < 1e-9) R0 = n;
  R0 = norm(R0);
  const T = cross(Z, R0);
  const theta0 = (Math.atan2(dot(R0, Y), dot(R0, X)) + 2 * Math.PI) % (2 * Math.PI);
  const map = (p: Vec3): [number, number] => [r * theta0 + dot(sub(p, Loc), T), dot(sub(p, Loc), Z)];

  const solids: Shape3D[] = [];
  for (const { face } of src) {
    const loops = [face.clone().outerWire(), ...face.clone().innerWires()].map((w) => chain(w.edges as Edge[]));
    const all = loops.flat().flatMap((e) => [0, 0.5, 1].map((t) => map(e.at(t))[0]));
    const [lo, hi] = [Math.min(...all), Math.max(...all)];
    if (hi - lo > 2 * Math.PI * r - 1e-6) throw new Error("The sketch is longer than the way round the face");
    const shift = lo < 0 ? 2 * Math.PI * r : 0;
    const m = (p: Vec3): [number, number] => {
      const q = map(p);
      return [q[0] + shift, q[1]];
    };
    const drawings = loops.map((loop) => loopDrawing(loop, m));
    let dr = drawings[0];
    for (const h of drawings.slice(1)) dr = dr.cut(h);
    const sk = dr.sketchOnFace(round, "original") as unknown as { faces?: () => Face; face?: () => Face };
    const onFace = sk.faces ? sk.faces() : sk.face!();
    solids.push(thicken(onFace, height, cy));
  }
  let out = body;
  for (const s of solids) out = (height > 0 ? out.fuse(s) : out.cut(s)) as Shape3D;
  return out;
}

type Run = { at: (t: number) => Vec3; kind: string };

/** A wire's edges one after another, each the way the loop goes. */
function chain(edges: Edge[]): Run[] {
  const left = edges.map((e) => ({ e, a: tup(e.startPoint), b: tup(e.endPoint) }));
  const out: Run[] = [];
  let end: Vec3 | null = null;
  while (left.length) {
    let i = 0;
    let flip = false;
    if (end) {
      let best = Infinity;
      left.forEach((x, k) => {
        const [da, db] = [dist(x.a, end!), dist(x.b, end!)];
        if (da < best) [best, i, flip] = [da, k, false];
        if (db < best) [best, i, flip] = [db, k, true];
      });
    }
    const { e, a, b } = left.splice(i, 1)[0];
    const at = (t: number) => tup(e.pointAt(flip ? 1 - t : t));
    out.push({ at, kind: e.geomType });
    end = flip ? a : b;
  }
  return out;
}

/** A loop in the unrolled face (lengths round it, heights along it): lines stay lines, circles circles. */
function loopDrawing(loop: Run[], m: (p: Vec3) => [number, number]): Drawing {
  let pen = draw(m(loop[0].at(0)));
  for (const run of loop) {
    const closed = dist(run.at(0), run.at(1)) < 1e-9;
    if (run.kind === "LINE") pen = pen.lineTo(m(run.at(1)));
    else if (run.kind === "CIRCLE") {
      if (closed) pen = pen.threePointsArcTo(m(run.at(0.5)), m(run.at(0.25))).threePointsArcTo(m(run.at(1)), m(run.at(0.75)));
      else pen = pen.threePointsArcTo(m(run.at(1)), m(run.at(0.5)));
    } else for (let k = 1; k <= 32; k++) pen = pen.lineTo(m(run.at(k / 32)));
  }
  return pen.close();
}

/** A face on the round face made solid: `height` out from it (away from the material) or into it. */
function thicken(face: Face, height: number, cy: { s: number }): Shape3D {
  const oc = getOC();
  // Away from the axis on a boss raised, or a hole sunk; towards it otherwise.
  const want = Math.sign(height) * cy.s;
  const make = (k: number): Shape3D | null => {
    const th = new oc.BRepOffsetAPI_MakeThickSolid();
    try {
      th.MakeThickSolidBySimple(face.wrapped, k);
      if (!th.IsDone()) return null;
      let s = cast(th.Shape()) as Shape3D;
      if (measureVolume(s) < 0) s = cast(s.wrapped.Reversed()) as Shape3D;
      return s;
    } catch {
      return null;
    } finally {
      th.delete();
    }
  };
  // Made both ways: the one away from the axis is the bigger (it lies further out). (Not
  // told by its centre of mass: a slab bent round an arc has that nearer the axis than it is.)
  const both = [make(Math.abs(height)), make(-Math.abs(height))];
  if (both[0] && both[1]) {
    const [a, b] = both.map((s) => measureVolume(s!));
    const outer = a > b ? both[0] : both[1];
    const inner = a > b ? both[1] : both[0];
    return want > 0 ? outer! : inner!;
  }
  throw new Error("The wrapped shape couldn't be made solid");
}
