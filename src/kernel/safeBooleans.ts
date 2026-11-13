// OpenCascade's booleans may adjust the shapes they're given (tolerances,
// edges, even the surfaces underneath - shared between a shape and its copies).
// Every earlier step's result is kept and built on, so an edit - even one that
// fails - must never change them. These replace replicad's fuse / cut /
// intersect with the same operations run non-destructively (the inputs are
// left exactly as they were), with the same tidying of same-surface faces.

import { _3DShape, Edge, Face, HASH_CODE_MAX, Shape, cast, getOC, isShape3D } from "replicad";

type Opts = { optimisation?: "none" | "commonFace" | "sameFace"; simplify?: boolean };

function run(kind: "fuse" | "cut" | "common", a: { wrapped: unknown }, b: { wrapped: unknown }, opts: Opts = {}) {
  const oc = getOC();
  const algo = kind === "fuse" ? new oc.BRepAlgoAPI_Fuse() : kind === "cut" ? new oc.BRepAlgoAPI_Cut() : new oc.BRepAlgoAPI_Common();
  const args = new oc.NCollection_List_TopoDS_Shape();
  const tools = new oc.NCollection_List_TopoDS_Shape();
  const progress = new oc.Message_ProgressRange();
  try {
    args.Append(a.wrapped as never);
    tools.Append(b.wrapped as never);
    algo.SetArguments(args);
    algo.SetTools(tools);
    algo.SetNonDestructive(true);
    if (opts.optimisation === "commonFace") algo.SetGlue(oc.BOPAlgo_GlueEnum.BOPAlgo_GlueShift);
    if (opts.optimisation === "sameFace") algo.SetGlue(oc.BOPAlgo_GlueEnum.BOPAlgo_GlueFull);
    algo.Build(progress);
    if (opts.simplify !== false) algo.SimplifyResult(true, true, 0.001);
    // (The kernel's handle to what it made is given back once the body has its own: release.ts.)
    const made = algo.Shape();
    try {
      const out = cast(withoutInternals(made));
      if (!isShape3D(out)) throw new Error(`Could not ${kind} as a 3d shape`);
      return out;
    } finally {
      made.delete();
    }
  } finally {
    algo.delete();
    args.delete();
    tools.delete();
    progress.delete();
  }
}

/**
 * A boolean's result without the edges (and points) it left lying in a face,
 * bounding nothing: where an edge of one shape ran along a face of the other
 * (a prism's corner standing against a block's wall), the join kept it there
 * as a line across the wall - an edge with no face on its other side, taken
 * for a gap ("would tear the body open") though the solid was closed.
 * (Only faces the boolean made anew hold such edges: the shapes it was given
 * stay as they were.)
 */
export function withoutInternals<T>(wrapped: T): T {
  const oc = getOC();
  const INTERNAL = oc.TopAbs_Orientation.TopAbs_INTERNAL;
  const has = (kind: unknown): boolean => {
    const ex = new oc.TopExp_Explorer(wrapped as never, kind as never, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    try {
      for (; ex.More(); ex.Next()) {
        const item = ex.Current();
        const inside = item.Orientation() === INTERNAL;
        item.delete();
        if (inside) return true;
      }
      return false;
    } finally {
      ex.delete();
    }
  };
  try {
    if ((wrapped as { IsNull?: () => boolean } | null)?.IsNull?.() !== false) return wrapped;
    if (has(oc.TopAbs_ShapeEnum.TopAbs_EDGE) || has(oc.TopAbs_ShapeEnum.TopAbs_VERTEX)) oc.BRepTools.RemoveInternals(wrapped as never, false);
  } catch {
    // As it came: the usual checks speak for it.
  }
  return wrapped;
}

let done = false;
export function useSafeBooleans(): void {
  if (done) return;
  done = true;
  const p = _3DShape.prototype as unknown as Record<string, unknown>;
  p.fuse = function (this: { wrapped: unknown }, other: { wrapped: unknown }, opts?: Opts) {
    return run("fuse", this, other, opts);
  };
  p.cut = function (this: { wrapped: unknown }, tool: { wrapped: unknown }, opts?: Opts) {
    return run("cut", this, tool, opts);
  };
  p.intersect = function (this: { wrapped: unknown }, tool: { wrapped: unknown }, opts?: Opts) {
    return run("common", this, tool, opts);
  };
  // A shape's edges and faces, each once, in the order found: replicad checks
  // every new one against all found so far (quadratic - 22 s for the 11 000
  // edges of a ruler with its scale engraved). Same result, by hash first.
  const q = Shape.prototype as unknown as object;
  Object.defineProperty(q, "edges", { configurable: true, get(this: { wrapped: unknown }) {
    const oc = getOC();
    return unique(this.wrapped, oc.TopAbs_ShapeEnum.TopAbs_EDGE, (x) => new Edge(oc.TopoDS.Edge(x as never)));
  } });
  Object.defineProperty(q, "faces", { configurable: true, get(this: { wrapped: unknown }) {
    const oc = getOC();
    return unique(this.wrapped, oc.TopAbs_ShapeEnum.TopAbs_FACE, (x) => new Face(oc.TopoDS.Face(x as never)));
  } });
}

/**
 * The sub-shapes of one kind, each once (the same one met again from another
 * face is skipped), as `wrap` makes them. (The explorer's own handles are
 * deleted here, each of them: left to lie, every one kept its face or edge
 * alive for good - see release.ts.)
 */
function unique<T>(shape: unknown, kind: unknown, wrap: (item: unknown) => T): T[] {
  const oc = getOC();
  const ex = new oc.TopExp_Explorer(shape as never, kind as never, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  const buckets = new Map<number, any[]>();
  const found: any[] = [];
  try {
    for (; ex.More(); ex.Next()) {
      const item = ex.Current();
      const h = oc.ReplicadShapeHasher.HashCode(item, HASH_CODE_MAX);
      const b = buckets.get(h);
      if (b?.some((x) => x.IsSame(item))) {
        item.delete();
        continue;
      }
      if (b) b.push(item);
      else buckets.set(h, [item]);
      found.push(item);
    }
    return found.map(wrap);
  } finally {
    for (const item of found) item.delete();
    ex.delete();
  }
}
