// A loft held by guide curves (rails) along its sides and by connection
// points (which point of each profile joins which).
//
// OpenCascade's loft takes no rails, so the profiles are resampled here on one
// shared parametrisation: each guide's or connection's point on a profile is at
// the same parameter on every profile, so the loft joins them. Between profiles
// that guides run along, extra sections are added: the two profiles blended,
// then moved so each guide's point lands on its guide - the sides follow the
// guides. Profiles become B-splines (within a ten-thousandth of their size).
import { cast, getOC, isShape3D, type Shape3D, type Wire } from "replicad";
import type { Vec3 } from "../doc/types";
import { add, cross, dot, len, norm, scale, sub } from "../geom";

/** Dense points along a curve, with how far along each is (0…1 of its length). */
interface Curve {
  pts: Vec3[];
  s: number[];
  closed: boolean;
}

function sample(w: Wire, n = 720): Curve {
  const oc = getOC();
  const ad = new oc.BRepAdaptor_CompCurve(w.wrapped, true);
  const pts: Vec3[] = [];
  try {
    const u0 = ad.FirstParameter();
    const u1 = ad.LastParameter();
    for (let i = 0; i <= n; i++) {
      const p = ad.Value(u0 + ((u1 - u0) * i) / n);
      pts.push([p.X(), p.Y(), p.Z()]);
      p.delete();
    }
  } finally {
    ad.delete();
  }
  const s = [0];
  for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + len(sub(pts[i], pts[i - 1])));
  const L = s[s.length - 1] || 1;
  return { pts, s: s.map((x) => x / L), closed: len(sub(pts[0], pts[pts.length - 1])) < 1e-6 * L + 1e-9 };
}

const reversed = (c: Curve): Curve => ({ pts: [...c.pts].reverse(), s: [...c.s].reverse().map((x) => 1 - x), closed: c.closed });

/** The point `f` of the way along (round again past the end of a closed one). */
function at(c: Curve, f: number): Vec3 {
  if (c.closed) f = ((f % 1) + 1) % 1;
  else f = Math.min(1, Math.max(0, f));
  let lo = 0;
  let hi = c.s.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (c.s[m] <= f) lo = m;
    else hi = m;
  }
  const d = c.s[hi] - c.s[lo];
  const t = d > 0 ? (f - c.s[lo]) / d : 0;
  return add(c.pts[lo], scale(sub(c.pts[hi], c.pts[lo]), t));
}

/** Where on the curve is nearest p: how far along, and how far off. */
function nearest(c: Curve, p: Vec3): { f: number; d: number } {
  let best = { f: 0, d: Infinity };
  for (let i = 0; i + 1 < c.pts.length; i++) {
    const a = c.pts[i];
    const ab = sub(c.pts[i + 1], a);
    const l2 = dot(ab, ab);
    const t = l2 > 0 ? Math.min(1, Math.max(0, dot(sub(p, a), ab) / l2)) : 0;
    const d = len(sub(p, add(a, scale(ab, t))));
    if (d < best.d) best = { f: c.s[i] + (c.s[i + 1] - c.s[i]) * t, d };
  }
  return best;
}

/** Where a guide meets a profile: how far along each. */
function meet(rail: Curve, sec: Curve): { onRail: number; onSec: number; d: number } {
  let best = { onRail: 0, onSec: 0, d: Infinity };
  // Coarse, then the best few of the guide's points refined.
  const step = Math.max(1, Math.floor(rail.pts.length / 240));
  const tries: { i: number; d: number }[] = [];
  for (let i = 0; i < rail.pts.length; i += step) tries.push({ i, d: nearest(sec, rail.pts[i]).d });
  tries.sort((a, b) => a.d - b.d);
  for (const { i } of tries.slice(0, 3))
    for (let k = Math.max(0, i - step); k <= Math.min(rail.pts.length - 1, i + step); k++) {
      const q = nearest(sec, rail.pts[k]);
      if (q.d < best.d) best = { onRail: rail.s[k], onSec: q.f, d: q.d };
    }
  // And back: the profile's point onto the guide.
  const back = nearest(rail, at(sec, best.onSec));
  return { onRail: back.f, onSec: best.onSec, d: Math.min(best.d, back.d) };
}

const centroidOf = (ps: Vec3[]): Vec3 => scale(ps.reduce((a, p) => add(a, p), [0, 0, 0] as Vec3), 1 / Math.max(1, ps.length));
const centroid = (c: Curve): Vec3 => scale(c.pts.slice(0, -1).reduce((a, p) => add(a, p), [0, 0, 0] as Vec3), 1 / Math.max(1, c.pts.length - 1));
/** Which way round a closed curve runs (Newell's normal, its size the area). */
function winding(c: Curve): Vec3 {
  let n: Vec3 = [0, 0, 0];
  for (let i = 0; i + 1 < c.pts.length; i++) n = add(n, cross(c.pts[i], c.pts[i + 1]));
  return n;
}

interface Anchor {
  /** A guide's index, or -1 for connection points. */
  rail: number;
  /** How far along each profile. */
  a: number[];
  /** How far along the guide, at each profile. */
  r: number[];
}

/** Does a section turn sharply anywhere (more than 20° from one point to the next)? */
function sharp(rows: Vec3[][]): boolean {
  const cos20 = Math.cos((20 * Math.PI) / 180);
  for (const row of rows)
    for (let j = 0; j < row.length; j++) {
      const a = sub(row[j], row[(j - 1 + row.length) % row.length]);
      const b = sub(row[(j + 1) % row.length], row[j]);
      if (len(a) > 0 && len(b) > 0 && dot(norm(a), norm(b)) < cos20) return true;
    }
  return false;
}

/**
 * The loft from its grid of points (a row per section, the same number round
 * each): one smooth side through them, the two ends capped flat with the
 * side's own end curves, sewn into a solid.
 */
function gridSolid(rows: Vec3[][], size: number): Shape3D {
  const oc = getOC();
  const nu = rows.length;
  const nv = rows[0].length + 1;
  const gc: { delete(): void }[] = [];
  const keep = <T extends { delete(): void }>(x: T): T => (gc.push(x), x);
  try {
    const grid = keep(new oc.NCollection_Array2_gp_Pnt(1, nu, 1, nv));
    rows.forEach((row, i) => {
      for (let j = 0; j < nv; j++) {
        const p = keep(new oc.gp_Pnt(...row[j % row.length]));
        grid.SetValue(i + 1, j + 1, p);
      }
    });
    // Through the points exactly (fitted within a tolerance, a square's corners came out rounded).
    // Smooth profiles: through the points, smooth (C2) all round. Profiles with
    // sharp corners (a square): fitted allowing a kink, so the corners stay
    // sharp - interpolated, they rippled 0.3 % of the size out past them.
    const fit = keep(sharp(rows) ? new oc.GeomAPI_PointsToBSplineSurface(grid, 3, 3, oc.GeomAbs_Shape.GeomAbs_C0, size * 1e-5) : new oc.GeomAPI_PointsToBSplineSurface());
    if (!sharp(rows)) fit.Interpolate(grid, false);
    const surf = fit.Surface();
    const sew = keep(new oc.BRepBuilderAPI_Sewing(size * 1e-6, true, true, true, false));
    const side = keep(new oc.BRepBuilderAPI_MakeFace(surf, 1e-6));
    sew.Add(side.Face());
    for (const [u, row] of [[surf.UKnot(1), rows[0]], [surf.UKnot(surf.NbUKnots()), rows[nu - 1]]] as const) {
      const edge = keep(new oc.BRepBuilderAPI_MakeEdge(surf.UIso(u)));
      const wire = keep(new oc.BRepBuilderAPI_MakeWire(edge.Edge()));
      // On the profile's own plane (from its points).
      const c = centroidOf(row);
      const n = norm(row.reduce((a, p, j) => add(a, cross(sub(p, c), sub(row[(j + 1) % row.length], c))), [0, 0, 0] as Vec3));
      const pln = keep(new oc.gp_Pln(keep(new oc.gp_Pnt(...c)), keep(new oc.gp_Dir(...n))));
      const cap = keep(new oc.BRepBuilderAPI_MakeFace(pln, wire.Wire(), true));
      if (!cap.IsDone()) throw new Error("A profile isn't flat: the loft's end can't be closed");
      sew.Add(cap.Face());
    }
    const progress = keep(new oc.Message_ProgressRange());
    sew.Perform(progress);
    const sewed = sew.SewedShape();
    if (sewed.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_SHELL) throw new Error("These profiles can't be lofted along those guides");
    const fix = keep(new oc.ShapeFix_Solid());
    const solid = cast(fix.SolidFromShell(oc.TopoDS.Shell(sewed)));
    if (!isShape3D(solid)) throw new Error("These profiles can't be lofted along those guides");
    return solid;
  } finally {
    for (const o of gc.reverse()) o.delete();
  }
}

/**
 * Loft through closed profiles (in order), held by guide curves along its
 * sides and by connection points (one point near each profile per connection).
 * (Its sides are always smooth: Straight sides doesn't apply.)
 */
export function railLoft(wires: Wire[], rails: Wire[], connections: Vec3[][]): Shape3D {
  let secs = wires.map((w) => sample(w));
  if (secs.some((c) => !c.closed)) throw new Error("Guide curves and connection points need closed profiles");
  const size = Math.max(...secs.map((c) => Math.max(...c.pts.map((p) => len(sub(p, centroid(c)))))), 1e-6);
  // All one way round, seen down the loft.
  const axis = norm(sub(centroid(secs[secs.length - 1]), centroid(secs[0])));
  secs = secs.map((c) => (dot(winding(c), axis) < 0 ? reversed(c) : c));

  const anchors: Anchor[] = [];
  const railCurves = rails.map((w) => sample(w, 1200));
  const tol = Math.max(size * 0.03, 0.05);
  railCurves.forEach((rc, k) => {
    const m = secs.map((sec) => meet(rc, sec));
    const off = m.findIndex((x) => x.d > tol);
    if (off >= 0) throw new Error(`Guide curve ${k + 1} doesn't touch profile ${off + 1}: each guide must run through every profile`);
    anchors.push({ rail: k, a: m.map((x) => x.onSec), r: m.map((x) => x.onRail) });
  });
  for (const [k, pts] of connections.entries()) {
    if (pts.length !== secs.length) throw new Error(`Connection ${k + 1} needs a point on every profile`);
    anchors.push({ rail: -1, a: secs.map((sec, i) => nearest(sec, pts[i]).f), r: [] });
  }
  if (!anchors.length) throw new Error("Add a guide curve or a connection");

  // Round each profile from the first anchor; the anchors must come in the same order on all.
  anchors.sort((x, y) => x.a[0] - y.a[0]);
  const rel = (i: number, k: number) => (((anchors[k].a[i] - anchors[0].a[i]) % 1) + 1) % 1;
  for (let i = 1; i < secs.length; i++)
    for (let k = 1; k < anchors.length; k++)
      if (rel(i, k) <= rel(i, k - 1)) throw new Error("The guides or connections cross over between profiles: they must go round each profile in the same order");

  // The same number of points between each two anchors on every profile.
  const N = 160;
  const counts = anchors.map((_, k) => Math.max(3, Math.round(N * ((k + 1 < anchors.length ? rel(0, k + 1) : 1) - rel(0, k)))));
  const start = counts.map((_, k) => counts.slice(0, k).reduce((a, b) => a + b, 0));
  const total = counts.reduce((a, b) => a + b, 0);
  const resampled = secs.map((sec, i) => {
    const out: Vec3[] = [];
    anchors.forEach((an, k) => {
      const from = an.a[i];
      const to = from + ((k + 1 < anchors.length ? rel(i, k + 1) : 1) - rel(i, k));
      for (let m = 0; m < counts[k]; m++) out.push(at(sec, from + ((to - from) * m) / counts[k]));
    });
    return out;
  });

  // Between profiles: sections that follow the guides.
  const railAnchors = anchors.map((an, k) => ({ an, idx: start[k] })).filter((x) => x.an.rail >= 0);
  const sections: Vec3[][] = [resampled[0]];
  for (let i = 0; i + 1 < resampled.length; i++) {
    {
      const M = railAnchors.length ? 6 : 3;
      for (let m = 1; m <= M; m++) {
        const t = m / (M + 1);
        const P = resampled[i].map((p, j) => add(p, scale(sub(resampled[i + 1][j], p), t)));
        if (!railAnchors.length) {
          sections.push(P);
          continue;
        }
        const moves = railAnchors.map(({ an, idx }) => ({ idx, d: sub(at(railCurves[an.rail], an.r[i] + (an.r[i + 1] - an.r[i]) * t), P[idx]) }));
        // Each point moved as the guides either side of it are, by how near it is to each.
        sections.push(
          P.map((p, j) => {
            if (moves.length === 1) return add(p, moves[0].d);
            let q = moves.length - 1;
            for (let k = 0; k < moves.length; k++) if (moves[k].idx <= j) q = k;
            const a = moves[q];
            const b = moves[(q + 1) % moves.length];
            const span = (b.idx - a.idx + total) % total || total;
            const w = ((j - a.idx + total) % total) / span;
            return add(p, add(scale(a.d, 1 - w), scale(b.d, w)));
          }),
        );
      }
    }
    sections.push(resampled[i + 1]);
  }

  return gridSolid(sections, size);
}
