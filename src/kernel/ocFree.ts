// A face's point and normal at a place on its surface, read straight off it.
//
// face.normalAt(point) finds where the point is on the surface first (a point
// projection), and on a detailed spline surface each projection keeps about
// half a megabyte of the engine's memory for good, freed or not. Tidying a
// gear's outline swept with a twist (362 spline faces, 25 places each) ran
// the engine out of memory (0.2 GB to 3.8 GB) and broke it. Where the place
// on the surface is known, ask there.
import { getOC, type Edge, type Face, type Shape3D } from "replicad";

type Tuple = [number, number, number];
type Vec3 = Tuple;

/** Point and normal (outward, not of unit length) at (s, t), each 0..1 across the face's surface. */
export function surfaceAt(face: Face, s: number, t: number): { p: Tuple; n: Tuple } {
  const oc = getOC();
  const { uMin, uMax, vMin, vMax } = face.UVBounds;
  const p = new oc.gp_Pnt();
  const n = new oc.gp_Vec();
  const g = new oc.BRepGProp_Face(face.wrapped, false);
  try {
    g.Normal(uMin + (uMax - uMin) * s, vMin + (vMax - vMin) * t, p, n);
    return { p: [p.X(), p.Y(), p.Z()], n: [n.X(), n.Y(), n.Z()] };
  } finally {
    g.delete();
    n.delete();
    p.delete();
  }
}

/**
 * A face's normal (of unit length) where one of its edges is, at `s` (0..1)
 * along the edge (as edge.pointAt counts): read through the edge's own curve
 * on the face, so nothing is projected. Null if the edge isn't on the face.
 */
export function normalOnEdge(face: Face, edge: Edge, s: number): Tuple | null {
  const oc = getOC();
  let c: InstanceType<typeof oc.BRepAdaptor_Curve2d> | null = null;
  let uv: { X(): number; Y(): number; delete(): void } | null = null;
  const p = new oc.gp_Pnt();
  const n = new oc.gp_Vec();
  const g = new oc.BRepGProp_Face(face.wrapped, false);
  try {
    c = new oc.BRepAdaptor_Curve2d(edge.wrapped, face.wrapped);
    const t0 = c.FirstParameter();
    uv = c.Value(t0 + (c.LastParameter() - t0) * s);
    g.Normal(uv!.X(), uv!.Y(), p, n);
    const l = Math.hypot(n.X(), n.Y(), n.Z());
    return l > 0 ? [n.X() / l, n.Y() / l, n.Z() / l] : null;
  } catch {
    return null;
  } finally {
    uv?.delete();
    c?.delete();
    g.delete();
    n.delete();
    p.delete();
  }
}

// Volumes and areas, measured to a millionth.
//
// replicad's measureVolume / measureArea integrate each face at a fixed
// fineness, which on many-patched spline faces is well off: a propeller (lofted
// blades, rounded roots) measured 203 698 mm³ for 201 310 (1.2 % over), its
// centre of mass 0.2 mm off its axis. Asked to a relative accuracy instead,
// OpenCascade keeps refining until it's there (about twice the time).
const EPS = 1e-6;
type Measurable = Shape3D | Face;

function props(s: Measurable, kind: "volume" | "area") {
  const oc = getOC();
  const p = new oc.GProp_GProps();
  let ok = true;
  try {
    const err = kind === "volume" ? oc.BRepGProp.VolumeProperties(s.wrapped, p, EPS, false, false) : oc.BRepGProp.SurfaceProperties(s.wrapped, p, EPS, false);
    ok = Number.isFinite(err) && Number.isFinite(p.Mass());
  } catch {
    ok = false;
  }
  if (ok) return p;
  // (Where the adaptive measure won't settle, the plain one.)
  p.delete();
  const q = new oc.GProp_GProps();
  if (kind === "volume") oc.BRepGProp.VolumeProperties(s.wrapped, q, false, false, false);
  else oc.BRepGProp.SurfaceProperties(s.wrapped, q, false, false);
  return q;
}

/** The volume (signed: below 0 for a solid inside out), as replicad's but to a millionth. */
export function measureVolume(s: Measurable): number {
  const p = props(s, "volume");
  try {
    return p.Mass();
  } finally {
    p.delete();
  }
}

/** The area of all its faces, to a millionth. */
export function measureArea(s: Measurable): number {
  const p = props(s, "area");
  try {
    return p.Mass();
  } finally {
    p.delete();
  }
}

/** Volume and centre of mass, to a millionth. */
export function volumeProperties(s: Shape3D): { volume: number; centerOfMass: Vec3 } {
  const p = props(s, "volume");
  const c = p.CentreOfMass();
  try {
    return { volume: p.Mass(), centerOfMass: [c.X(), c.Y(), c.Z()] };
  } finally {
    c.delete();
    p.delete();
  }
}
