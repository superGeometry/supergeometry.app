// Repair: turn a damaged solid (or a pile of faces, an imported mesh) into a
// clean one without changing its shape. A series of fixes, each tried on a
// copy and kept only if it makes the body healthier while its volume and
// size stay the same: tolerances and edge curves rebuilt, faces fixed, gaps
// sewn shut (at growing tolerances), missing flat faces filled from their
// open edges, hair-thin faces dropped and their slot closed, faces split on
// one surface merged, skins made solid, inside-out solids turned round.

import { assembleWire, cast, getOC, makeCompound, makeFace, measureArea, measureVolume, type Shape3D } from "replicad";
import { unify } from "./faceEdit";
import { deepCopy, hairThin, meshVolume, openEdges, shapeValid, subShapes } from "./health";

export interface Health {
  valid: boolean;
  solids: number;
  shells: number;
  openEdges: number;
  thin: number;
  volume: number;
  faces: number;
}

export function healthOf(s: Shape3D): Health {
  const h: Health = { valid: false, solids: 0, shells: 0, openEdges: 0, thin: 0, volume: 0, faces: 0 };
  try {
    h.faces = s.faces.length;
    h.valid = shapeValid(s);
    h.solids = subShapes(s, "SOLID").length;
    h.shells = subShapes(s, "SHELL").length;
    h.openEdges = openEdges(s).length;
    h.thin = hairThin(s);
    h.volume = h.solids ? measureVolume(s) : 0;
  } catch {
    h.valid = false;
  }
  return h;
}

export interface RepairOptions {
  /** How many separate solids it may be (default: any). */
  maxSolids?: number;
  /** The volume it should keep (default: its own, when it has one). */
  volume?: number;
}

/** A clean solid: valid, closed, no hair-thin faces, real volume. */
export function isHealthy(h: Health, o: RepairOptions = {}): boolean {
  return h.valid && h.solids >= 1 && (!o.maxSolids || h.solids <= o.maxSolids) && h.openEdges === 0 && h.thin === 0 && h.volume > 0;
}

/** How broken (0: healthy) - to tell whether a fix helped. */
function badness(h: Health, o: RepairOptions): number {
  return (h.valid ? 0 : 1000) + (h.solids ? 0 : 400) + (o.maxSolids && h.solids > o.maxSolids ? 300 : 0) + (h.volume > 0 ? 0 : 200) + Math.min(h.openEdges, 50) * 4 + Math.min(h.thin, 50) * 2;
}

function sizeOf(s: Shape3D): number {
  try {
    const b = s.boundingBox;
    return Math.hypot(b.width, b.height, b.depth) || 1;
  } catch {
    return 1;
  }
}

// ------------------------------------------------------------- the fixes

type Fix = { label: string; run: (s: Shape3D, size: number) => Shape3D | null };

/** Faces → shell(s) by sewing at `tol`; every closed shell → a solid (turned outward). */
function sewToSolid(faces: unknown[], tol: number): Shape3D | null {
  const oc = getOC();
  const sw = new oc.BRepBuilderAPI_Sewing(tol, true, true, true, false);
  try {
    for (const f of faces) sw.Add(f as never);
    sw.Perform(new oc.Message_ProgressRange());
    const sewed = cast(sw.SewedShape()) as Shape3D;
    const shells = subShapes(sewed, "SHELL");
    if (!shells.length) return null;
    const solids: unknown[] = [];
    for (const sh of shells) {
      const fix = new oc.ShapeFix_Solid();
      try {
        const solid = fix.SolidFromShell(sh);
        oc.BRepLib.OrientClosedSolid(oc.TopoDS.Solid(solid));
        solids.push(solid);
      } finally {
        fix.delete();
      }
    }
    if (solids.length === 1) return cast(solids[0] as never) as Shape3D;
    return makeCompound(solids.map((x) => cast(x as never))) as Shape3D;
  } catch {
    return null;
  } finally {
    sw.delete();
  }
}

const facesOf = (s: Shape3D) => s.faces.map((f) => f.wrapped);

/** Chains of open edges into closed loops → flat faces filling them (holes where a face is missing). */
function fillFlatHoles(s: Shape3D, size: number): unknown[] {
  const open = openEdges(s).map((i) => s.edges[i]);
  if (!open.length) return [];
  const tol = size * 1e-6;
  const ends = open.map((e) => [e.startPoint.toTuple(), e.endPoint.toTuple()] as [number, number, number][]);
  const same = (p: number[], q: number[]) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < tol;
  const used = new Set<number>();
  const out: unknown[] = [];
  for (let start = 0; start < open.length; start++) {
    if (used.has(start)) continue;
    const loop = [start];
    used.add(start);
    let tip = ends[start][1];
    for (let guard = 0; guard < open.length && !same(tip, ends[start][0]); guard++) {
      const k = open.findIndex((_, i) => !used.has(i) && (same(ends[i][0], tip) || same(ends[i][1], tip)));
      if (k < 0) break;
      used.add(k);
      loop.push(k);
      tip = same(ends[k][0], tip) ? ends[k][1] : ends[k][0];
    }
    if (!same(tip, ends[start][0])) continue;
    try {
      // Only flat holes: a face is guessed, never a curved one.
      const face = makeFace(assembleWire(loop.map((i) => open[i])));
      if (face.geomType === "PLANE") out.push(face.wrapped);
    } catch {
      // not a closed flat loop
    }
  }
  return out;
}

const FIXES: Fix[] = [
  {
    label: "rebuilt edge curves and tolerances",
    run: (s, size) => {
      const oc = getOC();
      const c = deepCopy(s);
      try {
        oc.BRepLib.BuildCurves3d(c.wrapped);
      } catch {
        /* overload differs */
      }
      try {
        oc.BRepLib.SameParameter(c.wrapped, size * 1e-7, true);
      } catch {
        /* overload differs */
      }
      try {
        oc.BRepLib.UpdateTolerances(c.wrapped, true);
      } catch {
        /* overload differs */
      }
      return c;
    },
  },
  {
    label: "fixed faces",
    run: (s, size) => {
      const oc = getOC();
      const fixed: unknown[] = [];
      for (const f of s.faces) {
        const fx = new oc.ShapeFix_Face(f.wrapped);
        try {
          fx.SetPrecision(size * 1e-7);
          fx.Perform();
          fixed.push(fx.Face());
        } finally {
          fx.delete();
        }
      }
      return sewToSolid(fixed, size * 1e-7);
    },
  },
  // Gaps between faces: sewn shut, the smallest tolerance that does it.
  ...[1e-6, 1e-5, 1e-4, 1e-3].map((k) => ({ label: "sewed up gaps between faces", run: (s: Shape3D, size: number) => sewToSolid(facesOf(s), size * k) })),
  {
    label: "filled missing flat faces",
    run: (s, size) => {
      const add = fillFlatHoles(s, size);
      return add.length ? sewToSolid([...facesOf(s), ...add], size * 1e-6) : null;
    },
  },
  {
    label: "removed hair-thin faces",
    run: (s, size) => {
      const areas = s.faces.map((f) => measureArea(f));
      const total = areas.reduce((a, b) => a + b, 0);
      const thin = areas.map((a) => a < total * 1e-7);
      if (!thin.some(Boolean)) return null;
      // Their neighbours close the slot: sewn with a tolerance about as wide as the slivers.
      const width = Math.max(...s.faces.filter((_, i) => thin[i]).map((f) => {
        const b = f.boundingBox;
        return Math.min(...[b.width, b.height, b.depth].filter((x) => x > 0), size * 1e-3);
      }));
      const kept = s.faces.filter((_, i) => !thin[i]).map((f) => f.wrapped);
      return sewToSolid(kept, Math.min(size * 1e-3, Math.max(size * 1e-6, width * 2)));
    },
  },
  {
    label: "merged faces split on one surface",
    run: (s) => {
      try {
        return unify(s);
      } catch {
        return null;
      }
    },
  },
  {
    label: "made a solid from its skin",
    run: (s, size) => (subShapes(s, "SOLID").length ? null : sewToSolid(facesOf(s), size * 1e-6)),
  },
  {
    label: "turned it the right way out",
    run: (s) => {
      const oc = getOC();
      if (!(measureVolume(s) < 0)) return null;
      const c = deepCopy(s);
      for (const x of subShapes(c, "SOLID")) oc.BRepLib.OrientClosedSolid(x);
      return c;
    },
  },
];

/** Healthy now: faces left split on one surface (a mesh's triangles) merged, if that keeps it so. */
function tidy(s: Shape3D, h: Health, o: RepairOptions, fixes: string[]): Shape3D {
  try {
    const u = unify(s);
    const hu = healthOf(u);
    if (isHealthy(hu, o) && hu.faces < h.faces && Math.abs(hu.volume - h.volume) <= h.volume * 1e-6) {
      fixes.push("merged faces split on one surface");
      return u;
    }
  } catch {
    /* keep it as it is */
  }
  return s;
}

/**
 * Repair a shape: the fixes are tried in turn on what the last good one left,
 * each kept only if it helps and doesn't change the shape (volume within
 * 0.5%, same size). Returns the repaired shape and what was done, or null if
 * it can't be made a clean solid.
 */
export function repairShape(input: Shape3D, o: RepairOptions = {}): { shape: Shape3D; fixes: string[] } | null {
  let cur = input;
  let h = healthOf(cur);
  if (isHealthy(h, o)) return { shape: cur, fixes: [] };
  const size = sizeOf(input);
  const v0 = o.volume ?? (h.volume > 0 && h.valid ? h.volume : undefined);
  // Not valid: its measured volume can't be trusted, but one counted from a
  // mesh can (when it's closed). Without it, "fixed faces" was free to change
  // the shape: a slot cut into a drill's housing came back 764 mm³ bigger,
  // and the housing split in half later left pieces inside out.
  let m0: number | undefined;
  if (v0 === undefined && h.solids && !h.openEdges) {
    try {
      const m = meshVolume(input, size);
      if (m > 0) m0 = m;
    } catch {
      m0 = undefined;
    }
  }
  const sameShape = (s: Shape3D, hs: Health) => {
    if (Math.abs(sizeOf(s) - size) > size * 1e-3) return false;
    if (m0 !== undefined) {
      try {
        return Math.abs(meshVolume(s, size) - m0) <= m0 * 5e-3;
      } catch {
        return false;
      }
    }
    if (v0 === undefined || !(hs.volume > 0)) return true;
    return Math.abs(hs.volume - v0) <= v0 * 5e-3;
  };
  const fixes: string[] = [];
  // Two rounds: one fix can open the way for another (sewn first, then merged).
  for (let round = 0; round < 2; round++) {
    for (const fix of FIXES) {
      let next: Shape3D | null = null;
      try {
        next = fix.run(cur, size);
      } catch {
        next = null;
      }
      if (!next) continue;
      const hn = healthOf(next);
      if (badness(hn, o) < badness(h, o) && sameShape(next, hn)) {
        cur = next;
        h = hn;
        if (!fixes.includes(fix.label)) fixes.push(fix.label);
        if (isHealthy(h, o)) return { shape: tidy(cur, h, o, fixes), fixes };
      }
    }
  }
  return null;
}
