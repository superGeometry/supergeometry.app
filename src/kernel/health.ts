// Health checks for solids, shared by the engine's edit guard and the repair tool.

import { cast, getOC, measureArea, type Edge, type Shape3D } from "replicad";
import { meshFaces } from "./meshing";

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
    return validNow(shape.wrapped);
  } catch {
    return true;
  }
}

/**
 * OpenCascade's check of a shape, made now (nothing remembered). Its checker
 * keeps what it found on every face, edge and corner, and deleting it doesn't
 * give that back: each check of an everyday body left over half a megabyte
 * behind for good. A plate of 35 faces checked 3 000 times took the engine
 * from 100 MB to 1.9 GB - and every edit checks its result, so a long session
 * ran the engine out of memory. Pointed at nothing before it goes, the checker
 * lets go of it all.
 */
export function validNow(wrapped: unknown): boolean {
  const oc = getOC();
  const check = new oc.BRepCheck_Analyzer(wrapped as never, true, false, false);
  try {
    return (check as unknown as { IsValid(): boolean }).IsValid();
  } finally {
    const builder = new oc.TopoDS_Builder();
    const nothing = new oc.TopoDS_Compound();
    try {
      builder.MakeCompound(nothing);
      check.Init(nothing, false);
    } catch {
      // As it is: the check itself is done.
    }
    builder.delete();
    nothing.delete();
    check.delete();
  }
}


/**
 * Edges with a face on one side only (gaps), by index. Worked out once per
 * shape, like the checks below: every edit asks it of the body as it was
 * before, which is the same body on each move of a drag.
 */
const openCache = new WeakMap<Shape3D, number[]>();
export function openEdges(shape: Shape3D): number[] {
  let known = openCache.get(shape);
  if (!known) openCache.set(shape, (known = findOpenEdges(shape)));
  return known;
}

function findOpenEdges(shape: Shape3D): number[] {
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
 * clone() only wraps the same shape again), its faces and edges in the same
 * order. Written out and read back. The kernel's own copier ("moving" it
 * nowhere with copying on) keeps every piece of the shape and of the copy,
 * and can't be made to let go of them (release.ts): each edit of a step that
 * works on a copy - a fillet's size dragged - lost a whole body for good.
 * What is read from a file is held by its handle alone. (The mesh goes out
 * and in with it, and is taken off: a copy has none.)
 */
let copies = 0;
export function deepCopy(s: Shape3D): Shape3D {
  const oc = getOC();
  const name = `/copy-${copies++}.bin`;
  const progress = new oc.Message_ProgressRange();
  const read = new oc.TopoDS_Shape();
  try {
    if (oc.BinTools.Write(s.wrapped, name, progress) && oc.BinTools.Read(read, name, progress) && !read.IsNull()) {
      oc.BRepTools.Clean(read, true);
      return cast(read) as Shape3D;
    }
  } catch (err) {
    // (The engine itself breaking down is not a copy that couldn't be made.)
    if (typeof WebAssembly !== "undefined" && err instanceof WebAssembly.RuntimeError) throw err;
  } finally {
    try {
      oc.FS.unlink(name);
    } catch {
      // never written
    }
    progress.delete();
    read.delete();
  }
  // The old way, if it can't be written.
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
  for (; ex.More(); ex.Next()) {
    const item = ex.Current();
    out.push(kind === "SOLID" ? oc.TopoDS.Solid(item) : oc.TopoDS.Shell(item));
    item.delete();
  }
  ex.delete();
  return out;
}

/** How many faces are next to nothing in area (once per shape: every face's area is slow on curved faces). */
const thinCache = new WeakMap<Shape3D, number>();
export function hairThin(s: Shape3D): number {
  let known = thinCache.get(s);
  if (known === undefined) thinCache.set(s, (known = countHairThin(s)));
  return known;
}

function countHairThin(s: Shape3D): number {
  const areas = s.faces.map((f) => measureArea(f));
  const total = areas.reduce((a, b) => a + b, 0);
  return areas.filter((a) => a < total * 1e-7).length;
}

/** A solid's volume counted from a mesh of it (coarse, so the view's own finer mesh still gets made). */
export function meshVolume(s: Shape3D, size: number): number {
  const m = meshFaces(s, size * 1e-3, 0.3);
  const p = m.vertices;
  const t = m.triangles;
  let v = 0;
  for (let k = 0; k < t.length; k += 3) {
    const [i, j, l] = [3 * t[k], 3 * t[k + 1], 3 * t[k + 2]];
    v += p[i] * (p[j + 1] * p[l + 2] - p[j + 2] * p[l + 1]) - p[i + 1] * (p[j] * p[l + 2] - p[j + 2] * p[l]) + p[i + 2] * (p[j] * p[l + 1] - p[j + 1] * p[l]);
  }
  return v / 6;
}
