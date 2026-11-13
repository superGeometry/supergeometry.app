// Repair: turn a damaged solid (or a pile of faces, an imported mesh) into a
// clean one without changing its shape. A series of fixes, each tried on a
// copy and kept only if it makes the body healthier while its volume and
// size stay the same: tolerances and edge curves rebuilt, faces fixed, gaps
// sewn shut (at growing tolerances), missing flat faces filled from their
// open edges, hair-thin faces dropped and their slot closed, faces split on
// one surface merged, skins made solid, inside-out solids turned round.

import { assembleWire, cast, getOC, makeCompound, makeFace, makeLine, makeThreePointArc, measureArea, type Shape3D, type Wire } from "replicad";
import { measureVolume } from "./ocFree";
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
/**
 * Flat faces with an edge next to nothing in length (the end of a sliver
 * that was closed: two roundings that meet, 4 mm each side of an 8 mm
 * block) made again without it, their outline's two neighbours brought
 * together. Left in, that speck is an edge to pick, and one the engine
 * stumbles on in every later cut and fillet there. Null: none to drop.
 */
function withoutSpecks(s: Shape3D, tol: number): Shape3D | null {
  type P = [number, number, number];
  const far = (p: P, q: P) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  const remade = (w: Wire): Wire => {
    const all = w.edges.map((e) => ({ e, a: e.startPoint.toTuple() as P, b: e.endPoint.toTuple() as P, m: e.pointAt(0.5).toTuple() as P, type: e.geomType as string, speck: e.length < tol, moved: false }));
    const specks = all.filter((x) => x.speck);
    if (!specks.length) return w;
    // The ends that were on a speck: both at its middle now.
    const snap = (p: P): P | null => {
      for (const k of specks) if (far(p, k.a) < tol || far(p, k.b) < tol) return [(k.a[0] + k.b[0]) / 2, (k.a[1] + k.b[1]) / 2, (k.a[2] + k.b[2]) / 2];
      return null;
    };
    const rest = all.filter((x) => !x.speck);
    for (const x of rest) {
      const [a, b] = [snap(x.a), snap(x.b)];
      if (!a && !b) continue;
      if (x.type !== "LINE" && x.type !== "CIRCLE") throw new Error("not a line or an arc");
      x.a = a ?? x.a;
      x.b = b ?? x.b;
      x.moved = true;
    }
    // In order round the outline (each begins where the one before ends).
    const chain = [rest.shift()!];
    while (rest.length) {
      const end = chain[chain.length - 1].b;
      let i = rest.findIndex((x) => far(x.a, end) < tol);
      if (i < 0) {
        i = rest.findIndex((x) => far(x.b, end) < tol);
        if (i < 0) throw new Error("the outline doesn't close");
        [rest[i].a, rest[i].b] = [rest[i].b, rest[i].a];
      }
      chain.push(rest.splice(i, 1)[0]);
    }
    return assembleWire(chain.map((x) => (!x.moved ? x.e : x.type === "LINE" ? makeLine(x.a, x.b) : makeThreePointArc(x.a, x.m, x.b))));
  };
  let any = false;
  const faces = s.faces.map((f) => {
    if (f.geomType !== "PLANE" || !f.edges.some((e) => e.length < tol)) return f.wrapped;
    try {
      const made = makeFace(remade(f.clone().outerWire()), f.clone().innerWires().map(remade));
      any = true;
      return made.wrapped;
    } catch {
      return f.wrapped;
    }
  });
  return any ? sewToSolid(faces, tol) : null;
}

/** Faces on the same surface to within `tol` made one (null: it can't be done). */
function merged(s: Shape3D, tol: number): Shape3D | null {
  const oc = getOC();
  const u = new oc.ShapeUpgrade_UnifySameDomain(s.wrapped, true, true, false);
  try {
    u.SetLinearTolerance(tol);
    u.SetAngularTolerance(1e-5);
    u.Build();
    const made = u.Shape();
    try {
      return cast(made) as Shape3D;
    } finally {
      made.delete();
    }
  } catch {
    return null;
  } finally {
    u.delete();
  }
}

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
      const tol = Math.min(size * 1e-3, Math.max(size * 1e-6, width * 2));
      const closed = sewToSolid(kept, tol);
      if (!closed) return null;
      // The sliver's ends are still there, as edges next to nothing in length on the faces it ended at.
      try {
        const clean = withoutSpecks(closed, tol);
        if (clean && !clean.edges.some((e) => e.length < tol)) {
          // What the sliver lay between is one surface but for its width (the two
          // roundings of a full round: one half cylinder): one face, with no line down it.
          const joined = merged(clean, tol);
          const one = joined && FIXES[0].run(joined, size);
          const v = measureVolume(closed);
          const good = (x: Shape3D) => shapeValid(x) && !openEdges(x).length && Math.abs(measureVolume(x) - v) < Math.abs(v) * 1e-4;
          if (one && one.faces.length < clean.faces.length && good(one)) return one;
          if (good(clean)) return clean;
        }
      } catch {
        // as it is, then
      }
      return closed;
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
