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

/**
 * Each subdivided point moved onto the smooth (limit) surface itself: the
 * surface the patches are fitted through. Fitting through these instead of
 * the control points keeps neighbouring patches meeting smoothly (no faint
 * creases along their borders) and puts the surface where the shape really is.
 *
 * Inside: (n²·p + 4·Σ edge neighbours + Σ diagonal neighbours) / (n(n+5)).
 * Along an open border: (prev + 4·p + next) / 6. Corners of a sheet stay.
 */
export function limitPoints(s: Subdivided): Vec3[] {
  const P = s.points;
  const quads: number[][] = [];
  for (const g of s.grids) for (let i = 0; i < s.n; i++) for (let j = 0; j < s.n; j++) quads.push([g[i][j], g[i + 1][j], g[i + 1][j + 1], g[i][j + 1]]);
  const ekey = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
  const edgeCount = new Map<string, number>();
  for (const q of quads) for (let k = 0; k < 4; k++) edgeCount.set(ekey(q[k], q[(k + 1) % 4]), (edgeCount.get(ekey(q[k], q[(k + 1) % 4])) ?? 0) + 1);
  const nbE = P.map(() => new Set<number>());
  const nbF = P.map(() => [] as number[]);
  const border = P.map(() => [] as number[]);
  const faces = P.map(() => 0);
  for (const q of quads)
    for (let k = 0; k < 4; k++) {
      const v = q[k];
      const a = q[(k + 1) % 4];
      const b = q[(k + 3) % 4];
      nbE[v].add(a).add(b);
      nbF[v].push(q[(k + 2) % 4]);
      faces[v]++;
      if (edgeCount.get(ekey(v, a)) === 1) border[v].push(a);
      if (edgeCount.get(ekey(v, b)) === 1) border[v].push(b);
    }
  return P.map((p, v) => {
    if (!faces[v]) return p;
    const bd = [...new Set(border[v])];
    if (bd.length) {
      // On an open border: a corner (one face) stays; otherwise the border curve's point.
      if (faces[v] === 1 || bd.length !== 2) return p;
      return [0, 1, 2].map((k) => (P[bd[0]][k] + 4 * p[k] + P[bd[1]][k]) / 6) as Vec3;
    }
    const n = nbE[v].size;
    if (n !== faces[v]) return p; // not a simple fan (shouldn't happen)
    const out: Vec3 = [p[0] * n * n, p[1] * n * n, p[2] * n * n];
    for (const e of nbE[v]) for (let k = 0; k < 3; k++) out[k] += 4 * P[e][k];
    for (const f of nbF[v]) for (let k = 0; k < 3; k++) out[k] += P[f][k];
    const d = n * (n + 5);
    return [out[0] / d, out[1] / d, out[2] / d];
  });
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
 * The same smooth shape with a cage twice as fine (one Catmull–Clark step:
 * the subdivision surface doesn't change). Old points keep their indices.
 */
export function refineCage(cage: Cage): Cage {
  const s = subdivide(cage, 1);
  const faces: Cage["faces"] = [];
  for (const g of s.grids) for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) faces.push([g[i][j], g[i + 1][j], g[i + 1][j + 1], g[i][j + 1]]);
  return compact({ verts: s.points, faces });
}

/**
 * Fill a hole with any number of edges. An odd hole can't be closed with
 * quads alone (every quad adds an even number of edge ends), so the cage is
 * first made twice as fine — same shape, and the hole then has twice as many
 * edges. Returns the new cage and whether it had to be refined.
 */
export function fillHole(cage: Cage, loop: number[]): { cage: Cage; refined: boolean } | null {
  if (loop.length >= 4 && loop.length % 2 === 0) {
    const c = fillLoop(cage, loop);
    return c && { cage: c, refined: false };
  }
  if (loop.length < 3) return null;
  const fine = refineCage(cage);
  // Old points keep their numbers (compact keeps the order): find the hole again by one of its points.
  const rim = boundaryEdges(fine);
  const loops = holeLoops(fine, new Set(rim.map(([a, b]) => ekey(a, b))));
  const ring = loops.find((l) => l.includes(loop[0]) && l.includes(loop[1]));
  if (!ring) return null;
  const c = fillLoop(fine, ring);
  return c && { cage: c, refined: true };
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

/** A run of open-border edges, as its points in order (a hole's rim: closed). */
export interface Chain {
  verts: number[];
  closed: boolean;
}

/**
 * The chosen border edges (keys from cageEdgeKey) grouped into runs: each run
 * is a closed rim, or an open string of edges end to end.
 */
export function borderChains(cage: Cage, chosen: Set<string>): Chain[] {
  const edges = boundaryEdges(cage).filter(([a, b]) => chosen.has(ekey(a, b)));
  const nb = new Map<number, number[]>();
  for (const [a, b] of edges) {
    nb.set(a, [...(nb.get(a) ?? []), b]);
    nb.set(b, [...(nb.get(b) ?? []), a]);
  }
  const used = new Set<string>();
  const out: Chain[] = [];
  const walk = (start: number): Chain => {
    const verts = [start];
    let v = start;
    for (;;) {
      const next = (nb.get(v) ?? []).find((w) => !used.has(ekey(v, w)));
      if (next === undefined) return { verts, closed: false };
      used.add(ekey(v, next));
      if (next === start) return { verts, closed: true };
      verts.push(next);
      v = next;
    }
  };
  // Open runs start at an end (a point with one chosen edge); what's left are rims.
  for (const [v, ws] of nb) if (ws.length === 1 && ws.some((w) => !used.has(ekey(v, w)))) out.push(walk(v));
  for (const [a, b] of edges) if (!used.has(ekey(a, b))) out.push(walk(a));
  return out.filter((c) => c.verts.length >= 2);
}

/** Two cages as one (the second's points renumbered after the first's). */
export function joinCages(a: Cage, b: Cage): { cage: Cage; offset: number } {
  const o = a.verts.length;
  return { cage: { verts: [...a.verts, ...b.verts], faces: [...a.faces, ...b.faces.map((f) => f.map((v) => v + o) as Cage["faces"][number])] }, offset: o };
}

/**
 * Connect two runs of border edges with a strip of quads (two edges → one
 * quad, like making a face from four points; two rims → a tube). Both runs
 * need the same number of edges; the second is turned and shifted so the
 * quads line up with the shape of the edges (no twist). The new faces are
 * wound to match the faces along the first run. Returns null if the runs
 * don't fit (different counts, sharing points, too short).
 */
export function bridgeChains(cage: Cage, A: Chain, B: Chain): Cage | null {
  if (A.closed !== B.closed) return null;
  const edgesOf = (c: Chain) => (c.closed ? c.verts.length : c.verts.length - 1);
  const n = edgesOf(A);
  if (n < 1 || edgesOf(B) !== n) return null;
  if (A.verts.some((v) => B.verts.includes(v))) return null;
  const P = (v: number) => cage.verts[v];
  const d = (p: number, q: number) => Math.hypot(P(p)[0] - P(q)[0], P(p)[1] - P(q)[1], P(p)[2] - P(q)[2]);
  const m = A.verts.length;
  // Best match of B to A: either direction, and (rims) any starting point.
  let best: number[] = B.verts;
  let bestCost = Infinity;
  for (const dir of [B.verts, [...B.verts].reverse()])
    for (let s = 0; s < (A.closed ? m : 1); s++) {
      const cand = A.closed ? dir.map((_, i) => dir[(i + s) % m]) : dir;
      let cost = 0;
      for (let i = 0; i < m; i++) cost += d(A.verts[i], cand[i]);
      if (cost < bestCost) ((bestCost = cost), (best = cand));
    }
  const quads: Cage["faces"] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % m;
    quads.push([A.verts[i], A.verts[j], best[j], best[i]]);
  }
  // Winding: each border edge on A must run the other way round in its new
  // face than in the face it already has.
  const dirOf = new Map<string, [number, number]>();
  for (const f of cage.faces) for (let k = 0; k < 4; k++) dirOf.set(ekey(f[k], f[(k + 1) % 4]), [f[k], f[(k + 1) % 4]]);
  const [a0, a1] = [A.verts[0], A.verts[1 % m]];
  const had = dirOf.get(ekey(a0, a1));
  const flip = !!had && had[0] === a0 && had[1] === a1;
  return { verts: cage.verts, faces: [...cage.faces, ...quads.map((q) => (flip ? ([q[3], q[2], q[1], q[0]] as Cage["faces"][number]) : q))] };
}

/** Do the faces along run B now meet their new neighbours wound the right way round? */
export function windingAgrees(cage: Cage): boolean {
  const seen = new Set<string>();
  for (const f of cage.faces)
    for (let k = 0; k < 4; k++) {
      const key = `${f[k]}>${f[(k + 1) % 4]}`;
      if (seen.has(key)) return false; // the same edge, the same way, twice
      seen.add(key);
    }
  return true;
}

/** Turn the given faces inside out (their points the other way round). */
export function flipFaces(cage: Cage, which: (i: number) => boolean): Cage {
  return { verts: cage.verts, faces: cage.faces.map((f, i) => (which(i) ? ([f[0], f[3], f[2], f[1]] as Cage["faces"][number]) : f)) };
}

/**
 * Where each open-border cage edge runs on the smooth surface: the point
 * halfway along it (to match a picked edge of the finished body to its cage edge).
 */
export function borderEdgeMids(cage: Cage): { e: [number, number]; at: Vec3 }[] {
  const s = subdivide(cage, 3);
  const P = limitPoints(s);
  const h = s.n / 2;
  const out: { e: [number, number]; at: Vec3 }[] = [];
  const border = new Set(boundaryEdges(cage).map(([a, b]) => ekey(a, b)));
  cage.faces.forEach((f, fi) => {
    const g = s.grids[fi];
    const sides: [number, number, number][] = [
      [f[0], f[1], g[h][0]],
      [f[1], f[2], g[s.n][h]],
      [f[2], f[3], g[h][s.n]],
      [f[3], f[0], g[0][h]],
    ];
    for (const [a, b, mid] of sides) if (border.has(ekey(a, b))) out.push({ e: [a, b], at: P[mid] });
  });
  return out;
}

export { ekey as cageEdgeKey };
