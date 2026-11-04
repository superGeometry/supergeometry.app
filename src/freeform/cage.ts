// Freeform control cages and Catmull–Clark subdivision (pure math, no OCCT).
//
// A cage is a quad mesh. The smooth shape is its subdivision surface; after a
// few levels every cage quad has become an n×n grid of points ("patch") that
// the kernel interpolates with one B-spline surface. Neighbouring patches share
// their boundary points exactly, so the surfaces sew into a clean shell/solid.

import type { Vec3 } from "../doc/types";

export interface Cage {
  verts: Vec3[];
  /** Quads, as vertex indices in order around the face. */
  faces: [number, number, number, number][];
}

export type CagePrimitive = "box" | "plane" | "cylinder" | "sphere";

// ------------------------------------------------------------- primitives

/** Box of w×d×h centred on the XY plane at `at` (bottom on z = at.z), n faces per side. */
export function boxCage(size: Vec3 = [40, 40, 40], n = 2, at: Vec3 = [0, 0, 0]): Cage {
  const pts = new Map<string, number>();
  const verts: Vec3[] = [];
  const faces: Cage["faces"] = [];
  const vid = (p: Vec3) => {
    const k = p.map((x) => Math.round(x * 1e6)).join(",");
    let i = pts.get(k);
    if (i === undefined) {
      i = verts.push(p) - 1;
      pts.set(k, i);
    }
    return i;
  };
  // Unit cube [-1, 1]³; each side is an n×n grid, wound so normals point out.
  const sides: { o: Vec3; u: Vec3; v: Vec3 }[] = [
    { o: [-1, -1, 1], u: [2, 0, 0], v: [0, 2, 0] }, // top
    { o: [-1, 1, -1], u: [2, 0, 0], v: [0, -2, 0] }, // bottom
    { o: [-1, -1, -1], u: [2, 0, 0], v: [0, 0, 2] }, // front (−y)
    { o: [1, 1, -1], u: [-2, 0, 0], v: [0, 0, 2] }, // back (+y)
    { o: [1, -1, -1], u: [0, 2, 0], v: [0, 0, 2] }, // right (+x)
    { o: [-1, 1, -1], u: [0, -2, 0], v: [0, 0, 2] }, // left (−x)
  ];
  const place = (q: Vec3): Vec3 => [at[0] + (q[0] * size[0]) / 2, at[1] + (q[1] * size[1]) / 2, at[2] + ((q[2] + 1) * size[2]) / 2];
  for (const { o, u, v } of sides) {
    const P = (i: number, j: number): Vec3 => [o[0] + (u[0] * i + v[0] * j) / n, o[1] + (u[1] * i + v[1] * j) / n, o[2] + (u[2] * i + v[2] * j) / n];
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) faces.push([vid(P(i, j)), vid(P(i + 1, j)), vid(P(i + 1, j + 1)), vid(P(i, j + 1))]);
  }
  // Positions are placed after de-duplication (keys use the unit cube).
  return { verts: verts.map(place), faces };
}

/** Sphere of diameter `d`: a box cage pushed onto a sphere. */
export function sphereCage(d = 40, at: Vec3 = [0, 0, 0]): Cage {
  const c = boxCage([2, 2, 2], 2, [0, 0, -1]);
  // A cage a little bigger than the sphere: subdivision shrinks it.
  const r = (d / 2) * 1.22;
  return { faces: c.faces, verts: c.verts.map((p) => {
    const l = Math.hypot(...p) || 1;
    return [at[0] + (p[0] / l) * r, at[1] + (p[1] / l) * r, at[2] + d / 2 + (p[2] / l) * r];
  }) };
}

/** Flat n×n sheet of w×d on the XY plane at `at` (an open surface). */
export function planeCage(size: [number, number] = [40, 40], n = 4, at: Vec3 = [0, 0, 0]): Cage {
  const verts: Vec3[] = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) verts.push([at[0] + (i / n - 0.5) * size[0], at[1] + (j / n - 0.5) * size[1], at[2]]);
  const id = (i: number, j: number) => j * (n + 1) + i;
  const faces: Cage["faces"] = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) faces.push([id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j + 1)]);
  return { verts, faces };
}

/** Cylinder of diameter d and height h standing on `at`: 8 around, `rows` up, quad caps. */
export function cylinderCage(d = 40, h = 40, rows = 2, at: Vec3 = [0, 0, 0]): Cage {
  const N = 8;
  const r = (d / 2) * 1.08;
  const verts: Vec3[] = [];
  const ring = (k: number) => k * N;
  for (let k = 0; k <= rows; k++)
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      verts.push([at[0] + Math.cos(a) * r, at[1] + Math.sin(a) * r, at[2] + (k / rows) * h]);
    }
  const faces: Cage["faces"] = [];
  for (let k = 0; k < rows; k++)
    for (let i = 0; i < N; i++) {
      const a = ring(k) + i;
      const b = ring(k) + ((i + 1) % N);
      faces.push([a, b, b + N, a + N]);
    }
  // Caps: a 2×2 grid of quads each, closing the bottom and top rings.
  capGrid(verts, faces, ring(0), N, at[2], false, at);
  capGrid(verts, faces, ring(rows), N, at[2] + h, true, at);
  return { verts, faces };
}

/**
 * Close an 8-point rim with a 2×2 grid of quads: its corners are rim points
 * 1, 3, 5, 7, its edge midpoints rim 0, 2, 4, 6, and a new centre point.
 */
function capGrid(verts: Vec3[], faces: Cage["faces"], R: number, N: number, z: number, up: boolean, at: Vec3): void {
  const c = verts.push([at[0], at[1], z]) - 1;
  // 2×2 grid: corner points = rim 1, 3, 5, 7; edge mid points = rim 0, 2, 4, 6; centre = c.
  for (let q = 0; q < 4; q++) {
    const mid0 = R + ((2 * q) % N);
    const corner = R + ((2 * q + 1) % N);
    const mid1 = R + ((2 * q + 2) % N);
    const quad: [number, number, number, number] = [c, mid0, corner, mid1];
    faces.push(up ? quad : [quad[0], quad[3], quad[2], quad[1]]);
  }
}

export function primitiveCage(kind: CagePrimitive, at: Vec3 = [0, 0, 0]): Cage {
  switch (kind) {
    case "box":
      return boxCage([40, 40, 40], 2, at);
    case "plane":
      return planeCage([60, 60], 4, at);
    case "cylinder":
      return cylinderCage(40, 40, 2, at);
    case "sphere":
      return sphereCage(40, at);
  }
}

// ------------------------------------------------------------ subdivision

/** The subdivided surface: points, and per cage face the (n+1)×(n+1) grid of point indices. */
export interface Subdivided {
  points: Vec3[];
  /** grids[f][i][j]: point index; i runs from the face's corner 0 towards 1, j towards 3. */
  grids: number[][][];
  /** Size of each grid side in cells (2^levels). */
  n: number;
}

const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul3 = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];

/** Catmull–Clark, `levels` times. Boundary edges (open sheets) stay sharp B-spline curves. */
export function subdivide(cage: Cage, levels = 3): Subdivided {
  let points = cage.verts.map((p) => [...p] as Vec3);
  let grids = cage.faces.map((f) => [
    [f[0], f[3]],
    [f[1], f[2]],
  ]);
  let n = 1;
  for (let lvl = 0; lvl < levels; lvl++) {
    // Every current cell (quad) and the edges between grid points.
    const quads: number[][] = [];
    for (const g of grids) for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) quads.push([g[i][j], g[i + 1][j], g[i + 1][j + 1], g[i][j + 1]]);
    const ekey = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
    const edgeFaces = new Map<string, number[]>();
    quads.forEach((q, qi) => {
      for (let k = 0; k < 4; k++) {
        const key = ekey(q[k], q[(k + 1) % 4]);
        const l = edgeFaces.get(key);
        if (l) l.push(qi);
        else edgeFaces.set(key, [qi]);
      }
    });
    const facePt = quads.map((q) => mul3(q.reduce((s, i) => add3(s, points[i]), [0, 0, 0] as Vec3), 0.25));
    // New point list: old vertices (moved), then edge points, then face points.
    const next: Vec3[] = [];
    const edgeIdx = new Map<string, number>();
    const faceIdx: number[] = [];
    // Edge points.
    const edgePos = new Map<string, Vec3>();
    for (const [key, fs] of edgeFaces) {
      const [a, b] = key.split(",").map(Number);
      const mid = mul3(add3(points[a], points[b]), 0.5);
      edgePos.set(key, fs.length === 2 ? mul3(add3(add3(points[a], points[b]), add3(facePt[fs[0]], facePt[fs[1]])), 0.25) : mid);
    }
    // Vertex points.
    const vFaces = new Map<number, number[]>();
    const vEdges = new Map<number, string[]>();
    quads.forEach((q, qi) => q.forEach((v) => vFaces.set(v, [...(vFaces.get(v) ?? []), qi])));
    for (const key of edgeFaces.keys()) for (const v of key.split(",").map(Number)) vEdges.set(v, [...(vEdges.get(v) ?? []), key]);
    const moved = points.map((p, v) => {
      const es = vEdges.get(v);
      const fs = vFaces.get(v);
      if (!es || !fs) return p;
      const boundary = es.filter((k) => edgeFaces.get(k)!.length === 1);
      if (boundary.length >= 2) {
        // Boundary: a cubic B-spline along the border; a corner (two faces meet at an angle) stays put.
        if (fs.length === 1) return p;
        const others = boundary.slice(0, 2).map((k) => {
          const [a, b] = k.split(",").map(Number);
          return points[a === v ? b : a];
        });
        return add3(mul3(p, 0.75), mul3(add3(others[0], others[1]), 0.125));
      }
      const m = es.length;
      const F = mul3(fs.reduce((s, f) => add3(s, facePt[f]), [0, 0, 0] as Vec3), 1 / fs.length);
      const R = mul3(es.reduce((s, k) => {
        const [a, b] = k.split(",").map(Number);
        return add3(s, mul3(add3(points[a], points[b]), 0.5));
      }, [0, 0, 0] as Vec3), 1 / m);
      return mul3(add3(add3(F, mul3(R, 2)), mul3(p, m - 3)), 1 / m);
    });
    next.push(...moved);
    for (const [key, pos] of edgePos) edgeIdx.set(key, next.push(pos) - 1);
    for (const fp of facePt) faceIdx.push(next.push(fp) - 1);
    // New grids, twice as fine.
    let qi = 0;
    const N = 2 * n;
    grids = grids.map((g) => {
      const ng: number[][] = Array.from({ length: N + 1 }, () => new Array<number>(N + 1));
      for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) ng[2 * i][2 * j] = g[i][j];
      for (let i = 0; i <= n; i++) for (let j = 0; j < n; j++) ng[2 * i][2 * j + 1] = edgeIdx.get(ekey(g[i][j], g[i][j + 1]))!;
      for (let i = 0; i < n; i++) for (let j = 0; j <= n; j++) ng[2 * i + 1][2 * j] = edgeIdx.get(ekey(g[i][j], g[i + 1][j]))!;
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) ng[2 * i + 1][2 * j + 1] = faceIdx[qi++];
      return ng;
    });
    points = next;
    n = N;
  }
  return { points, grids, n };
}

/** Triangles of the subdivided surface (for the live preview). */
export function previewMesh(s: Subdivided): { positions: Float32Array; normals: Float32Array; indices: Uint32Array } {
  const positions = new Float32Array(s.points.flat());
  const idx: number[] = [];
  for (const g of s.grids)
    for (let i = 0; i < s.n; i++)
      for (let j = 0; j < s.n; j++) {
        const a = g[i][j];
        const b = g[i + 1][j];
        const c = g[i + 1][j + 1];
        const d = g[i][j + 1];
        idx.push(a, b, c, a, c, d);
      }
  // Smooth normals: area-weighted average of the triangles around each point.
  const nrm = new Float32Array(positions.length);
  for (let t = 0; t < idx.length; t += 3) {
    const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]].map((k) => s.points[k]);
    const u: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    for (const k of [idx[t], idx[t + 1], idx[t + 2]]) for (let q = 0; q < 3; q++) nrm[k * 3 + q] += n[q];
  }
  for (let k = 0; k < nrm.length; k += 3) {
    const l = Math.hypot(nrm[k], nrm[k + 1], nrm[k + 2]) || 1;
    nrm[k] /= l;
    nrm[k + 1] /= l;
    nrm[k + 2] /= l;
  }
  return { positions, normals: nrm, indices: new Uint32Array(idx) };
}

/** Cage edges (each once), for drawing and picking. */
export function cageEdges(cage: Cage): [number, number][] {
  const seen = new Set<string>();
  const out: [number, number][] = [];
  for (const f of cage.faces)
    for (let k = 0; k < 4; k++) {
      const a = f[k];
      const b = f[(k + 1) % 4];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      if (!seen.has(key)) (seen.add(key), out.push([a, b]));
    }
  return out;
}

/** Does every cage edge have two faces (a closed shape → a solid)? */
export function isClosed(cage: Cage): boolean {
  const count = new Map<string, number>();
  for (const f of cage.faces)
    for (let k = 0; k < 4; k++) {
      const a = f[k];
      const b = f[(k + 1) % 4];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      count.set(key, (count.get(key) ?? 0) + 1);
    }
  return [...count.values()].every((c) => c === 2);
}

// ------------------------------------------------------------ cage editing

/** Remove faces; points no face uses any more go too (indices are renumbered). */
export function deleteFaces(cage: Cage, faces: number[]): Cage {
  const drop = new Set(faces);
  return compact({ verts: cage.verts, faces: cage.faces.filter((_, i) => !drop.has(i)) });
}

function compact(cage: Cage): Cage {
  const used = [...new Set(cage.faces.flat())].sort((a, b) => a - b);
  const map = new Map(used.map((v, i) => [v, i]));
  return { verts: used.map((v) => cage.verts[v]), faces: cage.faces.map((f) => f.map((v) => map.get(v)!) as Cage["faces"][number]) };
}

const ekey = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);

/** Edges used by only one face (the rim of a sheet or of a hole), as that face winds them. */
export function boundaryEdges(cage: Cage): [number, number][] {
  const count = new Map<string, { n: number; dir: [number, number] }>();
  for (const f of cage.faces)
    for (let k = 0; k < 4; k++) {
      const a = f[k];
      const b = f[(k + 1) % 4];
      const e = count.get(ekey(a, b));
      if (e) e.n++;
      else count.set(ekey(a, b), { n: 1, dir: [a, b] });
    }
  return [...count.values()].filter((e) => e.n === 1).map((e) => e.dir);
}

/**
 * Closed loops among the chosen boundary edges, each walked the opposite way
 * to the face it borders — the winding a new face filling it needs.
 */
export function holeLoops(cage: Cage, chosen: Set<string>): number[][] {
  const edges = boundaryEdges(cage).filter(([a, b]) => chosen.has(ekey(a, b)));
  // Reverse each: from b to a.
  const next = new Map<number, number>();
  for (const [a, b] of edges) next.set(b, a);
  const loops: number[][] = [];
  const seen = new Set<number>();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const loop: number[] = [];
    let v: number | undefined = start;
    while (v !== undefined && !seen.has(v)) {
      seen.add(v);
      loop.push(v);
      v = next.get(v);
    }
    if (v === start && loop.length >= 3) loops.push(loop);
  }
  return loops;
}

/** Fill a hole: 4 edges → one quad; an even number above 4 → quads around a new centre point. */
export function fillLoop(cage: Cage, loop: number[]): Cage | null {
  const n = loop.length;
  if (n === 4) return { verts: cage.verts, faces: [...cage.faces, [loop[0], loop[1], loop[2], loop[3]]] };
  if (n < 4 || n % 2) return null;
  const c = loop.reduce((s, v) => [s[0] + cage.verts[v][0] / n, s[1] + cage.verts[v][1] / n, s[2] + cage.verts[v][2] / n] as Vec3, [0, 0, 0] as Vec3);
  const ci = cage.verts.length;
  const faces = [...cage.faces];
  for (let k = 0; k < n; k += 2) faces.push([ci, loop[k], loop[(k + 1) % n], loop[(k + 2) % n]]);
  return { verts: [...cage.verts, c], faces };
}

/**
 * Bridge two holes with the same number of edges by a ring of quads (e.g. a
 * tunnel between a front and a back opening). The second loop is turned and
 * rotated to line up with the first so the quads don't twist.
 */
export function bridgeLoops(cage: Cage, a: number[], b: number[]): Cage | null {
  const n = a.length;
  if (b.length !== n) return null;
  // Facing holes run opposite ways round: walk b backwards, then pick the start that lines up best.
  const rb = [...b].reverse();
  const d = (p: number, q: number) => Math.hypot(...[0, 1, 2].map((k) => cage.verts[p][k] - cage.verts[q][k]));
  let best = 0;
  let bestCost = Infinity;
  for (let s = 0; s < n; s++) {
    let cost = 0;
    for (let i = 0; i < n; i++) cost += d(a[i], rb[(i + s) % n]);
    if (cost < bestCost) (bestCost = cost), (best = s);
  }
  const B = (i: number) => rb[(i + best) % n];
  const faces = [...cage.faces];
  // Each a-edge (a_i → a_i+1) already runs as the new face needs it; the b side runs back.
  for (let i = 0; i < n; i++) faces.push([a[i], a[(i + 1) % n], B(i + 1), B(i)]);
  return { verts: cage.verts, faces };
}

export { ekey as cageEdgeKey };
