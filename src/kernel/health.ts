// Health checks for solids, shared by the engine's edit guard and the repair tool.

import { cast, getOC, measureArea, type Edge, type Shape3D } from "replicad";

/** OpenCascade's own check (self-crossing faces, bad edges…). */
const validCache = new WeakMap<Shape3D, boolean>();
export function shapeValid(shape: Shape3D): boolean {
  const known = validCache.get(shape);
  if (known !== undefined) return known;
  const ok = checkValid(shape);
  validCache.set(shape, ok);
  return ok;
}

function checkValid(shape: Shape3D): boolean {
  try {
    const oc = getOC();
    const check = new oc.BRepCheck_Analyzer(shape.wrapped, true, false, false);
    const ok = (check as unknown as { IsValid(): boolean }).IsValid();
    check.delete();
    return ok;
  } catch {
    return true;
  }
}


export function openEdges(shape: Shape3D): number[] {
  const edges = shape.edges;
  const buckets = new Map<number, { e: Edge; i: number; n: number }[]>();
  edges.forEach((e, i) => {
    const h = e.hashCode;
    buckets.set(h, [...(buckets.get(h) ?? []), { e, i, n: 0 }]);
  });
  const oc = getOC();
  for (const f of shape.faces) {
    for (const fe of f.edges) {
      const m = buckets.get(fe.hashCode)?.find((x) => x.e.isSame(fe));
      // A seam (cylinder/torus) belongs to its face twice but is listed once.
      if (m) m.n += oc.BRep_Tool.IsClosed(fe.wrapped, f.wrapped) ? 2 : 1;
    }
  }
  // A pole (where a revolved profile touches the axis) is a point-edge, not a gap.
  return [...buckets.values()].flat().filter((x) => x.n < 2 && !oc.BRep_Tool.Degenerated(x.e.wrapped)).map((x) => x.i);
}

/**
 * A real copy: its own topology and its own curves and surfaces (replicad's
 * clone() only wraps the same shape again). Made by "moving" it nowhere with
 * copying on.
 */
export function deepCopy(s: Shape3D): Shape3D {
  const oc = getOC();
  const t = new oc.gp_Trsf();
  const mk = new oc.BRepBuilderAPI_Transform(s.wrapped, t, true, false);
  try {
    return cast(mk.ModifiedShape(s.wrapped)) as Shape3D;
  } finally {
    mk.delete();
    t.delete();
  }
}

export function subShapes(s: Shape3D, kind: "SOLID" | "SHELL"): any[] {
  const oc = getOC();
  const ex = new oc.TopExp_Explorer(s.wrapped, kind === "SOLID" ? oc.TopAbs_ShapeEnum.TopAbs_SOLID : oc.TopAbs_ShapeEnum.TopAbs_SHELL, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  const out: any[] = [];
  for (; ex.More(); ex.Next()) out.push(kind === "SOLID" ? oc.TopoDS.Solid(ex.Current()) : oc.TopoDS.Shell(ex.Current()));
  ex.delete();
  return out;
}

export function hairThin(s: Shape3D): number {
  const areas = s.faces.map((f) => measureArea(f));
  const total = areas.reduce((a, b) => a + b, 0);
  return areas.filter((a) => a < total * 1e-7).length;
}
