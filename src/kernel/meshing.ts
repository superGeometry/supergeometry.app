// A body as triangles and lines: for the view, for a printed file, and for the
// checks that go by a mesh.

import { getOC, type Face, type Shape3D } from "replicad";
import { Earcut } from "three/src/extras/Earcut.js";

/** A body's faces as triangles. `faceGroups[i]` is where face i's corners are in `triangles` (the body's faces in their own order). */
export interface FaceMesh {
  vertices: Float32Array;
  normals: Float32Array;
  triangles: Uint32Array;
  faceGroups: { start: number; count: number }[];
}

/** A body's edges as lines. `edgeGroups[i]` is where edge i's points are in `lines` (the body's edges in their own order). */
export interface EdgeLines {
  lines: Float32Array;
  edgeGroups: { start: number; count: number }[];
}

/**
 * Faces meshed in one go. OpenCascade's mesher keeps its working notes on every
 * face and edge of what it is given until all of it is done, tens of kilobytes
 * each: a body of 4 500 faces took the engine's memory from 100 MB to 1.3 GB
 * (and memory once taken is never given back), one of 40 000 - a scanned part
 * sewn into a solid - to the 4 GB a browser allows, where the engine breaks.
 * The same faces a few hundred at a time are the same triangles in the same
 * order, a little sooner, and the memory doesn't move.
 */
const LOT = 300;

/**
 * Outlines (the face's own, and one for each hole) from which a flat face is
 * cut into triangles here instead of by OpenCascade, whose mesher takes time
 * and memory by the square of a face's holes: a plate's two faces with 100
 * holes 0.3 s, with 400 holes 5 s and 700 MB - and again for every print file
 * and every check that wants a point on such a face. Here: a few milliseconds.
 */
const LOOPS = 30;

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The shapes whose faces are meshed, and how finely (so its edge lines needn't mesh it again). */
const meshedAt = new WeakMap<object, string>();
/** The edge lines of a body some of whose faces were cut into triangles here: worked out with them. */
const linesReady = new WeakMap<object, { key: string; lines: EdgeLines }>();

/** One explorer for each kernel, pointed at shape after shape (each one made stays in the kernel for good: release.ts). */
const explorers = new WeakMap<object, { ex: any; nothing: any }>();
function explorer(): { ex: any; nothing: any } {
  const oc = getOC() as any;
  let e = explorers.get(oc);
  if (!e) explorers.set(oc, (e = { ex: new oc.TopExp_Explorer(), nothing: new oc.TopoDS_Shape() }));
  return e;
}

/** How many closed outlines a face has (its own, and one for each hole). */
function loopCount(face: { wrapped: unknown }): number {
  const oc = getOC() as any;
  const { ex, nothing } = explorer();
  const ANY = oc.TopAbs_ShapeEnum.TopAbs_SHAPE;
  let n = 0;
  for (ex.Init(face.wrapped, oc.TopAbs_ShapeEnum.TopAbs_WIRE, ANY); ex.More(); ex.Next()) n++;
  ex.Init(nothing, ANY, ANY);
  return n;
}

/** Is this a flat face with so many holes that it is cut into triangles here? */
const manyHoled = (face: Face): boolean => loopCount(face) >= LOOPS && face.geomType === "PLANE";

/** A shape's edges, each once, in the order met - the kernel's own handles: `done()` gives them back. */
function edgesOf(wrapped: unknown): { edges: any[]; at: (edge: any) => number; done: () => void } {
  const oc = getOC() as any;
  const { ex, nothing } = explorer();
  const ANY = oc.TopAbs_ShapeEnum.TopAbs_SHAPE;
  const buckets = new Map<number, number[]>();
  const edges: any[] = [];
  const hash = (x: any): number => oc.ReplicadShapeHasher.HashCode(x, 2147483647);
  for (ex.Init(wrapped, oc.TopAbs_ShapeEnum.TopAbs_EDGE, ANY); ex.More(); ex.Next()) {
    const item = ex.Current();
    const h = hash(item);
    const b = buckets.get(h);
    if (b?.some((i) => edges[i].IsSame(item))) {
      item.delete();
      continue;
    }
    if (b) b.push(edges.length);
    else buckets.set(h, [edges.length]);
    edges.push(item);
  }
  ex.Init(nothing, ANY, ANY);
  return {
    edges,
    at: (edge) => buckets.get(hash(edge))?.find((i) => edges[i].IsSame(edge)) ?? -1,
    done: () => edges.forEach((e) => e.delete()),
  };
}

/** The lines of a shape's edges as the kernel has them (in the order of the shape's edges). */
function readLines(wrapped: unknown, tolerance: number, angularTolerance: number): EdgeLines {
  const raw = (getOC() as any).ReplicadEdgeMeshExtractor.extract(wrapped, tolerance, angularTolerance);
  try {
    const groups = ints(raw.getEdgeGroupsPtr(), raw.getEdgeGroupsSize());
    const edgeGroups: EdgeLines["edgeGroups"] = [];
    for (let i = 0; i < groups.length; i += 3) edgeGroups.push({ start: groups[i], count: groups[i + 1] });
    return { lines: floats(raw.getLinesPtr(), raw.getLinesSize()), edgeGroups };
  } finally {
    raw.delete();
  }
}

/**
 * Edge lines joined end to end into closed outlines (each a run of x, y, z;
 * its last point not its first again). Null: they don't close up.
 */
function outlines(lines: Float32Array[], grain: number): Float32Array[] | null {
  const key = (l: Float32Array, k: number) => `${Math.round(l[k] / grain)},${Math.round(l[k + 1] / grain)},${Math.round(l[k + 2] / grain)}`;
  const out: Float32Array[] = [];
  // (A point given twice running - the kernel's lines have some, where a round face's seam is - is one point.)
  const add = (pts: ArrayLike<number>) => {
    const once: number[] = [];
    const apart = (k: number, j: number) => Math.hypot(pts[k] - once[j], pts[k + 1] - once[j + 1], pts[k + 2] - once[j + 2]) > grain;
    for (let k = 0; k < pts.length; k += 3) if (!once.length || apart(k, once.length - 3)) once.push(pts[k], pts[k + 1], pts[k + 2]);
    const m = once.length;
    if (m >= 6 && Math.hypot(once[m - 3] - once[0], once[m - 2] - once[1], once[m - 1] - once[2]) <= grain) once.length = m - 3;
    if (once.length >= 9) out.push(Float32Array.from(once));
  };
  const ends = new Map<string, number[]>();
  const open: number[] = [];
  lines.forEach((l, i) => {
    if (l.length < 6) return;
    const [a, b] = [key(l, 0), key(l, l.length - 3)];
    if (a === b) {
      // (An edge that closes on itself - a circle - is an outline; one that only goes there and back is nothing.)
      add(l);
      return;
    }
    open.push(i);
    for (const k of [a, b]) ends.set(k, [...(ends.get(k) ?? []), i]);
  });
  const used = new Set<number>();
  for (const first of open) {
    if (used.has(first)) continue;
    used.add(first);
    const pts: number[] = Array.from(lines[first]);
    const start = key(lines[first], 0);
    let tip = key(lines[first], lines[first].length - 3);
    for (let guard = 0; tip !== start; guard++) {
      const next = ends.get(tip)?.find((i) => !used.has(i));
      if (next === undefined || guard > open.length) return null;
      used.add(next);
      const l = lines[next];
      if (key(l, 0) === tip) {
        for (let k = 3; k < l.length; k++) pts.push(l[k]);
        tip = key(l, l.length - 3);
      } else {
        for (let k = l.length - 6; k >= 0; k -= 3) pts.push(l[k], l[k + 1], l[k + 2]);
        tip = key(l, 0);
      }
    }
    add(pts);
  }
  return out;
}

/**
 * A flat face as triangles between the points of its outlines (no points of
 * its own: it meets its neighbours along the very points they have). Null
 * when it doesn't come out as the face's area.
 */
function flatTriangles(loops: Float32Array[], normal: [number, number, number]): FaceMesh | null {
  if (!loops.length) return null;
  const n = normal;
  const l = Math.hypot(n[0], n[1], n[2]);
  if (!(l > 0)) return null;
  // Two directions across the face (x, then y so that x, y, n turn the usual way).
  const a = Math.abs(n[0]) < 0.9 * l ? [1, 0, 0] : [0, 1, 0];
  let x = [a[1] * n[2] - a[2] * n[1], a[2] * n[0] - a[0] * n[2], a[0] * n[1] - a[1] * n[0]];
  const xl = Math.hypot(x[0], x[1], x[2]);
  x = x.map((v) => v / xl);
  const y = [(n[1] * x[2] - n[2] * x[1]) / l, (n[2] * x[0] - n[0] * x[2]) / l, (n[0] * x[1] - n[1] * x[0]) / l];
  const flat = loops.map((p) => {
    const q = new Float64Array((p.length / 3) * 2);
    for (let k = 0, j = 0; k < p.length; k += 3, j += 2) {
      q[j] = p[k] * x[0] + p[k + 1] * x[1] + p[k + 2] * x[2];
      q[j + 1] = p[k] * y[0] + p[k + 1] * y[1] + p[k + 2] * y[2];
    }
    return q;
  });
  const area = (q: Float64Array) => {
    let s = 0;
    for (let j = 0, m = q.length; j < m; j += 2) s += q[j] * q[(j + 3) % m] - q[(j + 2) % m] * q[j + 1];
    return s / 2;
  };
  const areas = flat.map(area);
  // The outline itself is the biggest; the others are its holes.
  let outer = 0;
  areas.forEach((v, i) => Math.abs(v) > Math.abs(areas[outer]) && (outer = i));
  const order = [outer, ...loops.map((_, i) => i).filter((i) => i !== outer)];
  const count = order.reduce((s, i) => s + flat[i].length / 2, 0);
  const data = new Float64Array(count * 2);
  const vertices = new Float32Array(count * 3);
  const holes: number[] = [];
  let at = 0;
  for (const i of order) {
    if (i !== outer) holes.push(at);
    data.set(flat[i], at * 2);
    vertices.set(loops[i], at * 3);
    at += flat[i].length / 2;
  }
  // Earcut leaves out a point that lies on the straight line between its
  // neighbours (and its neighbours include the cuts it makes from hole to
  // hole): a row of square holes lost corners, and the face no longer met the
  // holes' walls at them. So no three points are in line for it - each is
  // moved a hair (for the cutting only) - and what that makes of points truly
  // in line, a triangle with no area, is taken out again below.
  let span = 1e-9;
  for (let j = 0; j < data.length; j++) span = Math.max(span, Math.abs(data[j]));
  const shaken = new Float64Array(data.length);
  for (let j = 0; j < data.length; j++) shaken[j] = data[j] + span * 1e-9 * Math.sin(j * 12.9898 + 4.1414) * 0.5;
  const cut = Earcut.triangulate(shaken as unknown as number[], holes, 2);
  if (cut.length < 3) return null;
  const twice = (p: number, q: number, r: number) => (data[2 * q] - data[2 * p]) * (data[2 * r + 1] - data[2 * p + 1]) - (data[2 * r] - data[2 * p]) * (data[2 * q + 1] - data[2 * p + 1]);
  const far2 = (p: number, q: number) => (data[2 * q] - data[2 * p]) ** 2 + (data[2 * q + 1] - data[2 * p + 1]) ** 2;
  // All turning the way the face looks (they all turn one way: as a whole, not
  // one by one - a triangle with next to no area can't say which way it turns).
  let tris: number[][] = [];
  let turn = 0;
  for (let k = 0; k < cut.length; k += 3) {
    tris.push([cut[k], cut[k + 1], cut[k + 2]]);
    turn += twice(cut[k], cut[k + 1], cut[k + 2]);
  }
  if (turn < 0) tris = tris.map(([p, q, r]) => [p, r, q]);
  // No area: its third corner on its long side, to what a point's seven digits
  // can be out by, and well in from both its ends. (Not a long thin needle
  // between two holes far apart: that one has an area, small as it is.)
  const middle = (t: number[]): [number, number, number] | null => {
    let j = 0;
    for (let m = 1; m < 3; m++) if (far2(t[m], t[(m + 1) % 3]) > far2(t[j], t[(j + 1) % 3])) j = m;
    const [u, v, mid] = [t[j], t[(j + 1) % 3], t[(j + 2) % 3]];
    const long2 = far2(u, v);
    if (Math.abs(twice(u, v, mid)) > Math.sqrt(long2) * span * 4e-7) return null;
    return Math.min(far2(u, mid), far2(v, mid)) > long2 * 1e-6 ? [u, v, mid] : null;
  };
  // Such a triangle is a point lying on the long side of its neighbour: that
  // neighbour is cut in two at the point, and the flat one goes. (Points in a
  // row - the tops of a row of round holes - make a fan of flat triangles:
  // taken from the outside in, each next to a neighbour that has an area. Each
  // is dealt with once: what can't be put right this way stays as it is.)
  const dealt = new Set<string>();
  for (let pass = 0; pass < 4096; pass++) {
    const flatOnes: [number, [number, number, number]][] = [];
    tris.forEach((t, i) => {
      const m = middle(t);
      if (m && !dealt.has([...t].sort((x, y) => x - y).join())) flatOnes.push([i, m]);
    });
    if (!flatOnes.length) break;
    const side = new Map<number, number>();
    tris.forEach((t, i) => {
      for (let j = 0; j < 3; j++) side.set(t[j] * count + t[(j + 1) % 3], i);
    });
    const gone = new Set<number>();
    const more: number[][] = [];
    for (const [i, [u, v, mid]] of flatOnes) {
      if (gone.has(i)) continue;
      const n = side.get(v * count + u);
      if (n === undefined || n === i || gone.has(n)) continue;
      const other = tris[n];
      if (middle(other)) continue;
      const x = other.find((c) => c !== u && c !== v)!;
      dealt.add([...tris[i]].sort((p, q) => p - q).join());
      gone.add(i);
      gone.add(n);
      more.push([v, mid, x], [mid, u, x]);
    }
    if (!gone.size) break;
    tris = [...tris.filter((_, i) => !gone.has(i)), ...more];
  }
  // Along every piece of its outlines there must be a triangle: that is where it meets its neighbours.
  const sides = new Set<number>();
  for (const t of tris) for (let j = 0; j < 3; j++) sides.add(Math.min(t[j], t[(j + 1) % 3]) * count + Math.max(t[j], t[(j + 1) % 3]));
  at = 0;
  for (const i of order) {
    const m = flat[i].length / 2;
    for (let k = 0; k < m; k++) {
      const [p, q] = [at + k, at + ((k + 1) % m)];
      if (!sides.has(Math.min(p, q) * count + Math.max(p, q))) return null;
    }
    at += m;
  }
  const want = Math.abs(areas[outer]) - areas.reduce((sum, v, i) => (i === outer ? sum : sum + Math.abs(v)), 0);
  const triangles = new Uint32Array(tris.length * 3);
  let got = 0;
  tris.forEach((t, i) => {
    got += Math.abs(twice(t[0], t[1], t[2])) / 2;
    triangles.set(t, i * 3);
  });
  if (!(want > 0) || Math.abs(got - want) > want * 1e-4) return null;
  const normals = new Float32Array(count * 3);
  for (let k = 0; k < normals.length; k += 3) normals.set([n[0] / l, n[1] / l, n[2] / l], k);
  return { vertices, normals, triangles, faceGroups: [{ start: 0, count: triangles.length }] };
}

/** One edge's points out of a set of edge lines. */
const lineOf = (e: EdgeLines, i: number): Float32Array => e.lines.subarray(e.edgeGroups[i].start * 3, (e.edgeGroups[i].start + e.edgeGroups[i].count) * 3);

function compoundOf(items: { wrapped: unknown }[]): any {
  const oc = getOC() as any;
  const builder = new oc.TopoDS_Builder();
  const compound = new oc.TopoDS_Compound();
  builder.MakeCompound(compound);
  for (const x of items) builder.Add(compound, x.wrapped);
  builder.delete();
  return compound;
}

// (Views of the engine's memory are made after each call: when it grows, its buffer is a new one.)
const floats = (ptr: number, size: number) => new Float32Array((getOC() as any).wasmMemory.buffer, ptr >>> 0, size).slice();
const ints = (ptr: number, size: number) => new Int32Array((getOC() as any).wasmMemory.buffer, ptr >>> 0, size).slice();
const indices = (ptr: number, size: number) => new Uint32Array((getOC() as any).wasmMemory.buffer, ptr >>> 0, size).slice();

/** The triangles of a shape handed to the mesher whole. */
function read(wrapped: unknown, tolerance: number, angularTolerance: number): FaceMesh {
  const raw = (getOC() as any).ReplicadMeshExtractor.extract(wrapped, tolerance, angularTolerance, false);
  try {
    const groups = ints(raw.getFaceGroupsPtr(), raw.getFaceGroupsSize());
    const faceGroups: FaceMesh["faceGroups"] = [];
    for (let i = 0; i < groups.length; i += 3) faceGroups.push({ start: groups[i], count: groups[i + 1] });
    return {
      vertices: floats(raw.getVerticesPtr(), raw.getVerticesSize()),
      normals: floats(raw.getNormalsPtr(), raw.getNormalsSize()),
      triangles: indices(raw.getTrianglesPtr(), raw.getTrianglesSize()),
      faceGroups,
    };
  } finally {
    raw.delete();
  }
}

/** Meshes one after another as one. */
function joined(parts: FaceMesh[]): FaceMesh {
  if (parts.length === 1) return parts[0];
  const total = (pick: (m: FaceMesh) => { length: number }) => parts.reduce((n, m) => n + pick(m).length, 0);
  const out: FaceMesh = {
    vertices: new Float32Array(total((m) => m.vertices)),
    normals: new Float32Array(total((m) => m.normals)),
    triangles: new Uint32Array(total((m) => m.triangles)),
    faceGroups: [],
  };
  let points = 0;
  let corners = 0;
  for (const m of parts) {
    out.vertices.set(m.vertices, points * 3);
    out.normals.set(m.normals, points * 3);
    for (let k = 0; k < m.triangles.length; k++) out.triangles[corners + k] = m.triangles[k] + points;
    for (const g of m.faceGroups) out.faceGroups.push({ start: g.start + corners, count: g.count });
    points += m.vertices.length / 3;
    corners += m.triangles.length;
  }
  return out;
}

/**
 * A body's faces as triangles, each face's own (none shared across an edge), in
 * the order of `shape.faces`.
 */
export function meshFaces(shape: Shape3D, tolerance: number, angularTolerance: number): FaceMesh {
  const faces = shape.faces;
  meshedAt.set(shape, `${tolerance}/${angularTolerance}`);
  linesReady.delete(shape);
  const flat = faces.map(manyHoled);
  if (flat.some(Boolean)) {
    const made = withFlatFaces(shape, faces, flat, tolerance, angularTolerance);
    if (made) return made;
  }
  if (faces.length <= LOT) return read(shape.wrapped, tolerance, angularTolerance);
  const parts: FaceMesh[] = [];
  for (let i = 0; i < faces.length; i += LOT) {
    const lot = faces.slice(i, i + LOT);
    const group = compoundOf(lot);
    try {
      let part = read(group, tolerance, angularTolerance);
      // A face that came to nothing left out of the count: each on its own, so the others keep their places.
      if (part.faceGroups.length !== lot.length)
        part = joined(
          lot.map((f) => {
            const one = read(f.wrapped, tolerance, angularTolerance);
            return one.faceGroups.length === 1 ? one : { ...one, faceGroups: [{ start: 0, count: one.triangles.length }] };
          }),
        );
      parts.push(part);
    } finally {
      group.delete();
    }
  }
  return joined(parts);
}

/** Faces a few hundred at a time, as triangles (see LOT). */
function inLots(faces: Face[], tolerance: number, angularTolerance: number): FaceMesh[] {
  const parts: FaceMesh[] = [];
  for (let i = 0; i < faces.length; i += LOT) {
    const lot = faces.slice(i, i + LOT);
    const group = compoundOf(lot);
    try {
      const part = read(group, tolerance, angularTolerance);
      if (part.faceGroups.length !== lot.length) throw new Error("a face without triangles");
      parts.push(part);
    } finally {
      group.delete();
    }
  }
  return parts;
}

/**
 * A body with flat faces of very many holes (`flat`): those cut into triangles
 * here, between the points their neighbours' meshes have along their edges;
 * the rest by OpenCascade. Its edge lines are worked out with it (kept for
 * meshEdgeLines). Null when it can't be done this way (the usual way then).
 */
function withFlatFaces(shape: Shape3D, faces: Face[], flat: boolean[], tolerance: number, angularTolerance: number): FaceMesh | null {
  const trash: (() => void)[] = [];
  const rest = faces.filter((_, i) => !flat[i]);
  const others = rest.length ? compoundOf(rest) : null;
  try {
    // The other faces first: their meshes say where the points along the shared edges are.
    for (let i = 0; i < rest.length; i += LOT) {
      const group = compoundOf(rest.slice(i, i + LOT));
      try {
        (getOC() as any).ReplicadMeshExtractor.mesh(group, tolerance, angularTolerance);
      } finally {
        group.delete();
      }
    }
    const theirs: EdgeLines = others ? readLines(others, tolerance, angularTolerance) : { lines: new Float32Array(0), edgeGroups: [] };
    const known = others ? edgesOf(others) : null;
    if (known) trash.push(known.done);
    if (known && known.edges.length !== theirs.edgeGroups.length) return null;
    // Edges with no neighbour but such faces (the fold between two): their own lines.
    const all = edgesOf(shape.wrapped);
    trash.push(all.done);
    const lone = all.edges.filter((e) => !known || known.at(e) < 0);
    let own: EdgeLines | null = null;
    let ownAt: ReturnType<typeof edgesOf> | null = null;
    if (lone.length) {
      const group = compoundOf(lone.map((e) => ({ wrapped: e })));
      try {
        own = readLines(group, tolerance, angularTolerance);
        ownAt = edgesOf(group);
        trash.push(ownAt.done);
        if (ownAt.edges.length !== own.edgeGroups.length) return null;
      } finally {
        group.delete();
      }
    }
    const pointsOf = (edge: any): Float32Array | null => {
      const i = known ? known.at(edge) : -1;
      if (i >= 0) return lineOf(theirs, i);
      const j = ownAt ? ownAt.at(edge) : -1;
      return j >= 0 && own ? lineOf(own, j) : null;
    };
    const box = shape.boundingBox;
    const grain = (Math.hypot(box.width, box.height, box.depth) || 1) * 2e-6;
    // Each face in its place: runs of the others (in lots), the flat ones one by one.
    const parts: FaceMesh[] = [];
    let run: Face[] = [];
    const flush = () => {
      if (run.length) parts.push(...inLots(run, tolerance, angularTolerance));
      run = [];
    };
    for (const [i, face] of faces.entries()) {
      if (!flat[i]) {
        run.push(face);
        continue;
      }
      const mine = edgesOf(face.wrapped);
      let part: FaceMesh | null = null;
      try {
        const lines = mine.edges.map(pointsOf);
        const loops = lines.every(Boolean) ? outlines(lines as Float32Array[], grain) : null;
        part = loops && flatTriangles(loops, face.normalAt().toTuple() as [number, number, number]);
      } finally {
        mine.done();
      }
      if (!part) return null;
      flush();
      parts.push(part);
    }
    flush();
    // The body's edge lines, in the order of its edges.
    const each = all.edges.map(pointsOf);
    if (!each.every(Boolean)) return null;
    const lines = new Float32Array(each.reduce((n, l) => n + l!.length, 0));
    const edgeGroups: EdgeLines["edgeGroups"] = [];
    let at = 0;
    for (const l of each as Float32Array[]) {
      lines.set(l, at * 3);
      edgeGroups.push({ start: at, count: l.length / 3 });
      at += l.length / 3;
    }
    linesReady.set(shape, { key: `${tolerance}/${angularTolerance}`, lines: { lines, edgeGroups } });
    return joined(parts);
  } catch {
    return null;
  } finally {
    for (const done of trash) done();
    others?.delete();
  }
}

/**
 * A body's edges as lines, in the order of `shape.edges` - the lines its faces'
 * triangles meet along (so its faces are meshed first, if they aren't yet).
 */
export function meshEdgeLines(shape: Shape3D, tolerance: number, angularTolerance: number): EdgeLines {
  const oc = getOC() as any;
  const ready = linesReady.get(shape);
  if (ready?.key === `${tolerance}/${angularTolerance}`) return ready.lines;
  if (meshedAt.get(shape) !== `${tolerance}/${angularTolerance}`) {
    // (A body with faces cut into triangles here: its lines come with those.)
    const faces = shape.faces;
    if (faces.some(manyHoled)) {
      meshFaces(shape, tolerance, angularTolerance);
      const made = linesReady.get(shape);
      if (made) return made.lines;
    }
    // (In lots, as above: read off the whole body unmeshed, it is meshed whole.)
    for (let i = 0; faces.length > LOT && i < faces.length; i += LOT) {
      const group = compoundOf(faces.slice(i, i + LOT));
      try {
        oc.ReplicadMeshExtractor.mesh(group, tolerance, angularTolerance);
      } finally {
        group.delete();
      }
    }
    meshedAt.set(shape, `${tolerance}/${angularTolerance}`);
  }
  return readLines(shape.wrapped, tolerance, angularTolerance);
}

/**
 * A body's triangles taken off it again, once whoever asked for them has
 * them. Left on, they stay for as long as the kernel holds the body - and the
 * tool that made a body holds it for good (release.ts): every shape ever
 * shown kept its mesh. Nothing reads them later: each edit works on a copy
 * of the body, which has none, and a face that wants its own asks for them.
 */
export function meshOff(shape: Shape3D): void {
  meshedAt.delete(shape);
  linesReady.delete(shape);
  try {
    (getOC() as any).BRepTools.Clean(shape.wrapped, true);
  } catch {
    // Left as they are.
  }
}

/**
 * One face's own triangles, for what wants points on it: its corners (x, y, z
 * each) and which three make each triangle. Made for that face alone when it
 * has none yet (`size`: its body's, which says how fine) - the whole body used
 * to be meshed for the one face, seconds on a big body - and read out in one
 * go: asked for corner by corner, each corner cost four small things in the
 * kernel that are never given back (release.ts), a megabyte and more with
 * each check of a shell's walls.
 */
export function faceTriangles(face: Face, size: number): { vertices: Float32Array; trianglesIndexes: Uint32Array } | null {
  // (A flat face of very many holes: cut into triangles here, between points along its own edges - see LOOPS.)
  if (manyHoled(face)) {
    const mine = edgesOf(face.wrapped);
    const group = compoundOf(mine.edges.map((e) => ({ wrapped: e })));
    try {
      const own = readLines(group, size * 1e-3, 0.3);
      if (own.edgeGroups.length === mine.edges.length) {
        const loops = outlines(mine.edges.map((_, i) => lineOf(own, i)), size * 2e-6);
        const part = loops && flatTriangles(loops, face.normalAt().toTuple() as [number, number, number]);
        if (part) return { vertices: part.vertices, trianglesIndexes: part.triangles };
      }
    } catch {
      // The usual way.
    } finally {
      mine.done();
      group.delete();
    }
  }
  const raw = (getOC() as any).ReplicadMeshExtractor.extract(face.wrapped, size * 1e-3, 0.3, true);
  try {
    const trianglesIndexes = indices(raw.getTrianglesPtr(), raw.getTrianglesSize());
    if (!trianglesIndexes.length) return null;
    return { vertices: floats(raw.getVerticesPtr(), raw.getVerticesSize()), trianglesIndexes };
  } finally {
    raw.delete();
  }
}

/** Meshes as one binary STL file (each triangle with its own flat normal, as a slicer reads it). */
export function binarySTL(meshes: FaceMesh[]): Uint8Array {
  const count = meshes.reduce((n, m) => n + m.triangles.length / 3, 0);
  const out = new Uint8Array(84 + count * 50);
  const view = new DataView(out.buffer);
  // (80 bytes of heading, never starting "solid": readers take that for the text kind.)
  out.set(new TextEncoder().encode("binary stl"), 0);
  view.setUint32(80, count, true);
  let at = 84;
  for (const m of meshes) {
    const p = m.vertices;
    for (let k = 0; k < m.triangles.length; k += 3) {
      const [a, b, c] = [m.triangles[k] * 3, m.triangles[k + 1] * 3, m.triangles[k + 2] * 3];
      const [ux, uy, uz] = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]];
      const [vx, vy, vz] = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
      let [nx, ny, nz] = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
      const l = Math.hypot(nx, ny, nz);
      if (l > 0) [nx, ny, nz] = [nx / l, ny / l, nz / l];
      view.setFloat32(at, nx, true);
      view.setFloat32(at + 4, ny, true);
      view.setFloat32(at + 8, nz, true);
      for (const [j, i] of [a, b, c].entries()) for (let x = 0; x < 3; x++) view.setFloat32(at + 12 + j * 12 + x * 4, p[i + x], true);
      at += 50;
    }
  }
  return out;
}
