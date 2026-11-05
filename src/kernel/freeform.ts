// Freeform cage → OpenCascade shape: each subdivided cage quad becomes one
// bicubic B-spline face interpolating its grid of points; faces are sewn and,
// when the cage is closed, made into a solid.

import { cast, getOC, measureVolume, type Shape3D } from "replicad";
import { cubicKnots, interpolateGrid } from "../freeform/bspline";
import { isClosed, limitPoints, subdivide, type Cage } from "../freeform/cage";

export interface Thicken {
  thickness: number;
  side: "up" | "down" | "both";
}

export function cageToShape(cage: Cage, levels = 3, thicken?: Thicken): Shape3D {
  if (!cage.faces.length) throw new Error("The freeform has no faces");
  const oc = getOC();
  const s = subdivide(cage, levels);
  // Fitted through points on the smooth surface itself (see limitPoints).
  s.points = limitPoints(s);
  const N = s.n + 1;
  const tol = Math.max(1e-4, sizeOf(s.points) * 1e-5);
  const sewing = new oc.BRepBuilderAPI_Sewing(tol, true, true, true, false);
  const gc: { delete(): void }[] = [sewing];
  // Shared by every patch: same size, same uniform parameters.
  const k = cubicKnots(N);
  const uKnots = new oc.NCollection_Array1_double(1, k.knots.length);
  const uMults = new oc.NCollection_Array1_int(1, k.mults.length);
  k.knots.forEach((x, i) => uKnots.SetValue(i + 1, x));
  k.mults.forEach((x, i) => uMults.SetValue(i + 1, x));
  gc.push(uKnots, uMults);
  for (const g of s.grids) {
    // Our own uniform interpolation: patches with the same border points get
    // identical border curves, so they sew exactly.
    const poles = interpolateGrid(g.map((row) => row.map((i) => s.points[i])));
    const arr = new oc.NCollection_Array2_gp_Pnt(1, N, 1, N);
    gc.push(arr);
    for (let i = 0; i < N; i++)
      for (let j = 0; j < N; j++) {
        const p = poles[i][j];
        const pt = new oc.gp_Pnt(p[0], p[1], p[2]);
        arr.SetValue(i + 1, j + 1, pt);
        pt.delete();
      }
    const surf = new oc.Geom_BSplineSurface(arr, uKnots, uKnots, uMults, uMults, 3, 3, false, false);
    const mk = new oc.BRepBuilderAPI_MakeFace(surf, 1e-6);
    gc.push(mk);
    sewing.Add(mk.Face());
  }
  sewing.Perform();
  const sewed = sewing.SewedShape();
  try {
    if (isClosed(cage)) {
      if (sewed.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_SHELL) throw new Error("The freeform surfaces didn't close up into one piece");
      const fix = new oc.ShapeFix_Solid();
      gc.push(fix);
      const solid = cast(fix.SolidFromShell(oc.TopoDS.Shell(sewed)));
      return solid as Shape3D;
    }
    if (thicken && thicken.thickness > 0) return thickenSheet(sewed, thicken);
    return cast(sewed) as Shape3D;
  } finally {
    for (const o of gc) o.delete();
  }
}

/** An open sheet → a solid: grown along its normals (up), against them (down) or half each way. */
function thickenSheet(sheet: unknown, { thickness: t, side }: Thicken): Shape3D {
  const oc = getOC();
  const thick = (d: number): Shape3D => {
    const mk = new oc.BRepOffsetAPI_MakeThickSolid();
    try {
      mk.MakeThickSolidBySimple(sheet as never, d);
      const solid = cast(mk.Shape()) as Shape3D;
      // Growing along the normals comes out inside-out: turn it the right way.
      return measureVolume(solid) < 0 ? (cast(solid.wrapped.Reversed()) as Shape3D) : solid;
    } finally {
      mk.delete();
    }
  };
  if (side === "up") return thick(t);
  if (side === "down") return thick(-t);
  return thick(t / 2).fuse(thick(-t / 2));
}

function sizeOf(pts: number[][]): number {
  let lo = [Infinity, Infinity, Infinity];
  let hi = [-Infinity, -Infinity, -Infinity];
  for (const p of pts) {
    lo = lo.map((v, k) => Math.min(v, p[k]));
    hi = hi.map((v, k) => Math.max(v, p[k]));
  }
  return Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1;
}
