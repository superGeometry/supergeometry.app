// Giving memory back to the kernel.
//
// This build of OpenCascade does not let go of most things when they are
// deleted: `delete()` on a shape's handle, an explorer, a boolean, a checker
// marks it deleted on this side and leaves it whole on the other. A deleted
// handle still counted as a user of its shape, so no body the engine ever
// made was freed, and each tool kept all it had worked out: the engine's
// memory only grew - by a megabyte or so with every rebuild of an everyday
// part - until it was replaced with a fresh one (worker.ts), every step built
// again from nothing. (Read off the kernel's memory: five handles to a box
// deleted, the box still had its five users; emptied first, none.)
//
// So each such thing is told to let go just before it is deleted - here, for
// its whole class, which covers the deleting done by replicad as well.

import { getOC } from "replicad";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The kernels (one at a time: a fresh one after a breakdown) whose classes are done. */
const done = new WeakSet<object>();

/** The last handle to its object, not deleted yet? (A handle can be cloned: the object goes with the last.) */
function last(handle: any): boolean {
  if (handle.isDeleted()) return false;
  const record = handle[Object.getOwnPropertyNames(handle)[0]];
  return !record?.count || record.count.value === 1;
}

export function useReleases(): void {
  const oc = getOC() as any;
  if (done.has(oc)) return;
  done.add(oc);
  const nothing = new oc.TopoDS_Shape();
  const ANY = oc.TopAbs_ShapeEnum.TopAbs_SHAPE;
  const before = (name: string, release: (handle: any) => void): void => {
    const proto = oc[name]?.prototype;
    if (!proto || typeof proto.delete !== "function") return;
    const remove = proto.delete as (this: unknown) => unknown;
    proto.delete = function (this: any) {
      if (last(this)) {
        try {
          release(this);
        } catch {
          // Deleted as it is.
        }
      }
      return remove.call(this);
    };
  };
  // A shape's handle (a face's, an edge's... are its kinds): emptied, it no longer uses the shape.
  before("TopoDS_Shape", (h) => h.Nullify());
  // An explorer keeps the shape it went through.
  before("TopExp_Explorer", (h) => h.Init(nothing, ANY, ANY));
  // A boolean keeps all it worked out about where its shapes meet (165 KB for
  // a hole through a block) - cleared - and the bodies it was given and the
  // body it made, which it has no way to be told to drop: it is given a last
  // job instead, one point less another, and holds those two points from then on.
  const [a, b] = [new oc.gp_Pnt(0, 0, 0), new oc.gp_Pnt(1, 0, 0)];
  const speck = (p: unknown) => {
    const list = new oc.NCollection_List_TopoDS_Shape();
    list.Append(new oc.BRepBuilderAPI_MakeVertex(p).Vertex());
    return list;
  };
  const [one, other] = [speck(a), speck(b)];
  const progress = new oc.Message_ProgressRange();
  for (const name of ["BRepAlgoAPI_Cut", "BRepAlgoAPI_Fuse", "BRepAlgoAPI_Common", "BRepAlgoAPI_Section", "BRepAlgoAPI_Splitter"])
    before(name, (h) => {
      h.Clear();
      h.SetArguments(one);
      h.SetTools(other);
      h.Build(progress);
      h.Clear();
    });
}
