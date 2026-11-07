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
  try {
    args.Append(a.wrapped as never);
    tools.Append(b.wrapped as never);
    algo.SetArguments(args);
    algo.SetTools(tools);
    algo.SetNonDestructive(true);
    if (opts.optimisation === "commonFace") algo.SetGlue(oc.BOPAlgo_GlueEnum.BOPAlgo_GlueShift);
    if (opts.optimisation === "sameFace") algo.SetGlue(oc.BOPAlgo_GlueEnum.BOPAlgo_GlueFull);
    algo.Build(new oc.Message_ProgressRange());
    if (opts.simplify !== false) algo.SimplifyResult(true, true, 0.001);
    const out = cast(algo.Shape());
    if (!isShape3D(out)) throw new Error(`Could not ${kind} as a 3d shape`);
    return out;
  } finally {
    algo.delete();
    args.delete();
    tools.delete();
  }
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
    return unique(this.wrapped, oc.TopAbs_ShapeEnum.TopAbs_EDGE).map((x) => new Edge(oc.TopoDS.Edge(x)));
  } });
  Object.defineProperty(q, "faces", { configurable: true, get(this: { wrapped: unknown }) {
    const oc = getOC();
    return unique(this.wrapped, oc.TopAbs_ShapeEnum.TopAbs_FACE).map((x) => new Face(oc.TopoDS.Face(x)));
  } });
}

/** The sub-shapes of one kind, each once (the same one met again from another face is skipped). */
function unique(shape: unknown, kind: unknown): any[] {
  const oc = getOC();
  const ex = new oc.TopExp_Explorer(shape as never, kind as never, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  const buckets = new Map<number, any[]>();
  const out: any[] = [];
  try {
    for (; ex.More(); ex.Next()) {
      const item = ex.Current();
      const h = oc.ReplicadShapeHasher.HashCode(item, HASH_CODE_MAX);
      const b = buckets.get(h);
      if (b?.some((x) => x.IsSame(item))) continue;
      if (b) b.push(item);
      else buckets.set(h, [item]);
      out.push(item);
    }
  } finally {
    ex.delete();
  }
  return out;
}
