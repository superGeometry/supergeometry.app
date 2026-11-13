// A body as triangles and lines: for the view, for a printed file, and for the
// checks that go by a mesh.

import { getOC, type Face, type Shape3D } from "replicad";

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

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The shapes whose faces are meshed, and how finely (so its edge lines needn't mesh it again). */
const meshedAt = new WeakMap<object, string>();

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

/**
 * A body's edges as lines, in the order of `shape.edges` - the lines its faces'
 * triangles meet along (so its faces are meshed first, if they aren't yet).
 */
export function meshEdgeLines(shape: Shape3D, tolerance: number, angularTolerance: number): EdgeLines {
  const oc = getOC() as any;
  if (meshedAt.get(shape) !== `${tolerance}/${angularTolerance}`) {
    // (In lots, as above: read off the whole body unmeshed, it is meshed whole.)
    const faces = shape.faces;
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
  const raw = oc.ReplicadEdgeMeshExtractor.extract(shape.wrapped, tolerance, angularTolerance);
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
 * A body's triangles taken off it again, once whoever asked for them has
 * them. Left on, they stay for as long as the kernel holds the body - and the
 * tool that made a body holds it for good (release.ts): every shape ever
 * shown kept its mesh. Nothing reads them later: each edit works on a copy
 * of the body, which has none, and a face that wants its own asks for them.
 */
export function meshOff(shape: Shape3D): void {
  meshedAt.delete(shape);
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
