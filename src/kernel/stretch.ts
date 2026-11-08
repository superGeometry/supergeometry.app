// Stretch a solid along X / Y / Z by different amounts (worker only).
//
// The geometry engine's own tool for that (a general transform) isn't in our
// build, so the body is rebuilt face by face: flat faces stay flat (their
// edges stretched - straight ones exactly), curved faces and edges are fitted
// again as B-splines through closely spaced points of the stretched shape
// (a circle becomes an ellipse, a cylinder an elliptic one). Then the faces
// are sewn back into a solid.

import { cast, getOC, measureArea, type Shape3D } from "replicad";
import type { Vec3 } from "../doc/types";
import { healthOf, isHealthy, repairShape } from "./repair";
import { cubicKnots, interpolateGrid } from "../freeform/bspline";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Volume to a relative accuracy of 1e-6 (the default estimate can be several % out on fitted surfaces). */
function exactVolume(s: Shape3D): number {
  const oc = getOC();
  const props = new oc.GProp_GProps();
  try {
    oc.BRepGProp.VolumeProperties(s.wrapped, props, 1e-6, true, false);
    return props.Mass();
  } finally {
    props.delete();
  }
}

export function stretchShape(shape: Shape3D, center: Vec3, k: Vec3): Shape3D {
  const oc = getOC();
  const bb = shape.boundingBox.bounds;
  const size = Math.max(1e-9, Math.hypot(bb[1][0] - bb[0][0], bb[1][1] - bb[0][1], bb[1][2] - bb[0][2]) * Math.max(...k));
  const fitTol = size * 1e-6;
  const gc: { delete(): void }[] = [];
  const keep = <T extends { delete(): void }>(o: T): T => (gc.push(o), o);
  const map = (p: any): any => keep(new oc.gp_Pnt(center[0] + (p.X() - center[0]) * k[0], center[1] + (p.Y() - center[1]) * k[1], center[2] + (p.Z() - center[2]) * k[2]));

  // Each edge once (shared by two faces): the same new edge on both sides.
  const done: { old: any; made: any }[] = [];
  const edgeOf = (e: any): any => {
    for (const d of done) if (d.old.IsSame(e)) return d.made;
    const c = keep(new oc.BRepAdaptor_Curve(e));
    const u0 = c.FirstParameter();
    const u1 = c.LastParameter();
    let made: any;
    if (c.GetType() === oc.GeomAbs_CurveType.GeomAbs_Line) {
      made = keep(new oc.BRepBuilderAPI_MakeEdge(map(c.Value(u0)), map(c.Value(u1)))).Edge();
    } else {
      const n = c.GetType() === oc.GeomAbs_CurveType.GeomAbs_Circle || c.GetType() === oc.GeomAbs_CurveType.GeomAbs_Ellipse ? 33 : 65;
      const pts = keep(new oc.NCollection_Array1_gp_Pnt(1, n));
      const par = keep(new oc.NCollection_Array1_double(1, n));
      for (let i = 0; i < n; i++) {
        const u = u0 + ((u1 - u0) * i) / (n - 1);
        pts.SetValue(i + 1, map(c.Value(u)));
        par.SetValue(i + 1, u);
      }
      const fit = keep(new oc.GeomAPI_PointsToBSpline(pts, par, 3, 8, oc.GeomAbs_Shape.GeomAbs_C2, fitTol));
      made = keep(new oc.BRepBuilderAPI_MakeEdge(fit.Curve())).Edge();
    }
    // Built along the curve's own direction: oriented as the original was.
    done.push({ old: e, made });
    return made;
  };

  const wireOf = (w: any): any | null => {
    const list = keep(new oc.NCollection_List_TopoDS_Shape());
    const ex = keep(new oc.TopExp_Explorer(w, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE));
    for (; ex.More(); ex.Next()) {
      const e = oc.TopoDS.Edge(ex.Current());
      if (oc.BRep_Tool.Degenerated(e)) continue;
      const fwd = oc.TopoDS.Edge(e.Oriented(oc.TopAbs_Orientation.TopAbs_FORWARD));
      list.Append(edgeOf(fwd).Oriented(e.Orientation()));
    }
    const mk = keep(new oc.BRepBuilderAPI_MakeWire());
    mk.Add(list);
    return mk.IsDone() ? mk.Wire() : null;
  };

  /**
   * How many grid points each way: enough to follow how much the surface
   * turns that way (16 a half turn) - a thread's flank winds round a dozen
   * times along its length, a flat strip not at all.
   */
  const samples = (s: any, u0: number, u1: number, uv: { VMin: number; VMax: number }): [number, number] => {
    const turning = (at: (t: number) => any) => {
      const n = 240;
      let total = 0;
      let prev: Vec3 | null = null;
      let last = at(0);
      for (let i = 1; i <= n; i++) {
        const q = at(i / n);
        const d: Vec3 = [q.X() - last.X(), q.Y() - last.Y(), q.Z() - last.Z()];
        const l = Math.hypot(...d);
        if (l > 1e-12) {
          if (prev) total += Math.acos(Math.max(-1, Math.min(1, (d[0] * prev[0] + d[1] * prev[1] + d[2] * prev[2]) / l)));
          prev = [d[0] / l, d[1] / l, d[2] / l];
        }
        last = q;
      }
      return total;
    };
    const count = (turn: number) => Math.max(17, Math.min(481, Math.ceil(turn / (Math.PI / 16)) + 1));
    let tu = 0;
    let tv = 0;
    for (const f of [0.1, 0.5, 0.9]) {
      tu = Math.max(tu, turning((t) => s.Value(u0 + (u1 - u0) * t, uv.VMin + (uv.VMax - uv.VMin) * f)));
      tv = Math.max(tv, turning((t) => s.Value(u0 + (u1 - u0) * f, uv.VMin + (uv.VMax - uv.VMin) * t)));
    }
    return [count(tu), count(tv)];
  };

  /**
   * The stretched surface with the original's parameters: a bicubic B-spline
   * through the stretched points of a uniform (u, v) grid, its knots on the
   * face's own (u, v) range.
   */
  const sameParams = (s: any, uv: { UMin: number; UMax: number; VMin: number; VMax: number }): any => {
    const [NU, NV] = samples(s, uv.UMin, uv.UMax, uv);
    const grid: Vec3[][] = [];
    for (let i = 0; i < NU; i++) {
      const row: Vec3[] = [];
      for (let j = 0; j < NV; j++) {
        const q = map(s.Value(uv.UMin + ((uv.UMax - uv.UMin) * i) / (NU - 1), uv.VMin + ((uv.VMax - uv.VMin) * j) / (NV - 1)));
        row.push([q.X(), q.Y(), q.Z()]);
      }
      grid.push(row);
    }
    const poles = interpolateGrid(grid);
    const arr = keep(new oc.NCollection_Array2_gp_Pnt(1, NU, 1, NV));
    for (let i = 0; i < NU; i++) for (let j = 0; j < NV; j++) arr.SetValue(i + 1, j + 1, keep(new oc.gp_Pnt(...poles[i][j])));
    const knots = (n: number, a: number, b: number) => {
      const kn = cubicKnots(n);
      const k = keep(new oc.NCollection_Array1_double(1, kn.knots.length));
      kn.knots.forEach((x, i) => k.SetValue(i + 1, a + (b - a) * x));
      const m = keep(new oc.NCollection_Array1_int(1, kn.mults.length));
      kn.mults.forEach((x, i) => m.SetValue(i + 1, x));
      return [k, m];
    };
    const [ku, mu] = knots(NU, uv.UMin, uv.UMax);
    const [kv, mv] = knots(NV, uv.VMin, uv.VMax);
    return new oc.Geom_BSplineSurface(arr, ku, kv, mu, mv, 3, 3, false, false);
  };

  /** Every face stretched and sewn together: one closed skin (or null). */
  const build = (split: boolean): any | null => {
    const sewing = keep(new oc.BRepBuilderAPI_Sewing(size * 1e-5, true, true, true, false));
    const fx = keep(new oc.TopExp_Explorer(shape.wrapped, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE));
    for (; fx.More(); fx.Next()) {
      const face0 = oc.TopoDS.Face(fx.Current());
      const orient = face0.Orientation();
      const face = oc.TopoDS.Face(face0.Oriented(oc.TopAbs_Orientation.TopAbs_FORWARD));
      const s = keep(new oc.BRepAdaptor_Surface(face, true));
      const outer = oc.BRepTools.OuterWire(face);
      const wires: any[] = [];
      const wx = keep(new oc.TopExp_Explorer(face, oc.TopAbs_ShapeEnum.TopAbs_WIRE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE));
      for (; wx.More(); wx.Next()) wires.push(oc.TopoDS.Wire(wx.Current()));
      const inner = wires.filter((w) => !w.IsSame(outer));
      let made: any;
      if (s.GetType() === oc.GeomAbs_SurfaceType.GeomAbs_Plane) {
        // Flat stays flat: the plane through the stretched point, its normal
        // stretched the inverse way (normals go by the inverse transpose).
        const pl = s.Plane();
        const n = pl.Axis().Direction();
        const nn: Vec3 = [n.X() / k[0], n.Y() / k[1], n.Z() / k[2]];
        const gpl = keep(new oc.gp_Pln(map(pl.Location()), keep(new oc.gp_Dir(nn[0], nn[1], nn[2]))));
        const ow = wireOf(outer);
        if (!ow) throw new Error("wire");
        const mk = keep(new oc.BRepBuilderAPI_MakeFace(gpl, ow, true));
        for (const w of inner) {
          const iw = wireOf(w);
          if (iw) mk.Add(iw);
        }
        made = mk.Face();
      } else {
        const uv = oc.BRepTools.UVBounds(face);
        // The stretched surface over [u0, u1] × the face's v range, fitted through a grid of points.
        const fitted = (u0: number, u1: number) => {
          const [nu, nv] = samples(s, u0, u1, uv);
          const grid = keep(new oc.NCollection_Array2_gp_Pnt(1, nu, 1, nv));
          for (let i = 0; i < nu; i++)
            for (let j = 0; j < nv; j++) grid.SetValue(i + 1, j + 1, map(s.Value(u0 + ((u1 - u0) * i) / (nu - 1), uv.VMin + ((uv.VMax - uv.VMin) * j) / (nv - 1))));
          return keep(new oc.GeomAPI_PointsToBSplineSurface(grid, 3, 8, oc.GeomAbs_Shape.GeomAbs_C2, fitTol)).Surface();
        };
        // The face covers its whole parameter rectangle (a cylinder's side, a
        // fillet): the new surface as it is. Otherwise cut to its stretched edges.
        const whole = keep(new oc.BRepBuilderAPI_MakeFace(oc.BRep_Tool.Surface(face), uv.UMin, uv.UMax, uv.VMin, uv.VMax, 1e-7)).Face();
        const a0 = measureArea(cast(face) as never);
        const a1 = measureArea(cast(whole) as never);
        if (Math.abs(a0 - a1) <= Math.max(a0, a1) * 1e-6) {
          if (split) {
            // In two halves (a sphere: one face, closed round and pinched at
            // its poles, didn't sew into a closed skin on its own).
            const mid = (uv.UMin + uv.UMax) / 2;
            for (const [a, b] of [[uv.UMin, mid], [mid, uv.UMax]]) sewing.Add(keep(new oc.BRepBuilderAPI_MakeFace(fitted(a, b), 1e-7)).Face().Oriented(orient));
            continue;
          }
          made = keep(new oc.BRepBuilderAPI_MakeFace(fitted(uv.UMin, uv.UMax), 1e-7)).Face();
        } else {
          // Cut to its edges: the new surface keeps the old one's parameters
          // (interpolated through the stretched points at the same u, v), so
          // the face's own outline in (u, v) still fits it - a round side's
          // seam too, which an outline projected onto it got wrong.
          const surf = sameParams(s, uv);
          // A face on the new surface for the outline fixer to work on.
          const host = keep(new oc.BRepBuilderAPI_MakeFace(surf, 1e-7)).Face();
          const outline = (w: any) => {
            // The pieces as they come (a thread's pieces meet only to within
            // the model's own tolerance, more than a new corner allows), then
            // joined up by the wire fixer.
            const builder = keep(new oc.TopoDS_Builder());
            const wire = new oc.TopoDS_Wire();
            builder.MakeWire(wire);
            const ex = keep(new oc.TopExp_Explorer(w, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE));
            for (; ex.More(); ex.Next()) {
              const e = oc.TopoDS.Edge(ex.Current());
              if (oc.BRep_Tool.Degenerated(e)) continue;
              // Its outline on this face, in (u, v) (each side of a seam its own).
              const pc = keep(new oc.BRepAdaptor_Curve2d(e, face));
              const mk = keep(new oc.BRepBuilderAPI_MakeEdge(pc.Curve(), surf, pc.FirstParameter(), pc.LastParameter()));
              if (!mk.IsDone()) throw new Error("outline edge");
              const ne = mk.Edge();
              oc.BRepLib.BuildCurve3d(ne, size * 1e-7, oc.GeomAbs_Shape.GeomAbs_C1, 14, 0);
              builder.Add(wire, ne.Oriented(e.Orientation()));
            }
            const fw = keep(new oc.ShapeFix_Wire(wire, host, size * 1e-6));
            fw.FixConnected(size * 1e-4);
            return fw.Wire();
          };
          const mk = keep(new oc.BRepBuilderAPI_MakeFace(surf, outline(outer), true));
          for (const w of inner) mk.Add(outline(w));
          const fix = keep(new oc.ShapeFix_Face(mk.Face()));
          fix.SetPrecision(size * 1e-7);
          fix.Perform();
          made = fix.Face();
        }
      }
      sewing.Add(made.Oriented(orient));
    }
    sewing.Perform(keep(new oc.Message_ProgressRange()));
    const sewed = sewing.SewedShape();
    return sewed.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_SHELL ? sewed : null;
  };

  try {
    const shell = build(false) ?? build(true);
    if (!shell) throw new Error("its faces didn't close up");
    const fixSolid = keep(new oc.ShapeFix_Solid());
    let solid = cast(fixSolid.SolidFromShell(oc.TopoDS.Shell(shell))) as Shape3D;
    let v = exactVolume(solid);
    if (v < 0) {
      solid = cast(solid.wrapped.Reversed()) as Shape3D;
      v = -v;
    }
    // A stretch multiplies the volume by kx·ky·kz: anything else went wrong.
    // (Measured closely: the quick estimate was 7% out on a fitted elliptic side.)
    const want = Math.abs(exactVolume(shape)) * k[0] * k[1] * k[2];
    if (Math.abs(v - want) > want * 2e-3) throw new Error(`volume ${v} vs ${want}`);
    // A face cut to its stretched edges can come out a little off (a sliver
    // where it meets its neighbour): the repair tidies it, same shape.
    if (!isHealthy(healthOf(solid))) {
      const fixed = repairShape(solid, { maxSolids: 1, volume: want });
      if (!fixed || !isHealthy(healthOf(fixed.shape))) throw new Error("the stretched faces don't join cleanly");
      solid = fixed.shape;
    }
    return solid;
  } catch (e) {
    throw new Error(`This body couldn't be stretched along one direction (${(e as Error).message ?? e})`);
  } finally {
    for (const o of gc.reverse()) {
      try {
        o.delete();
      } catch {
        // already freed with its owner
      }
    }
  }
}
