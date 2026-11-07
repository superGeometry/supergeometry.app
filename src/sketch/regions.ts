// Planar arrangement of sketch curves → selectable regions.
//
// All curves are split where they cross, the pieces form a planar graph, and
// every bounded face of that graph is a region (with holes for anything nested
// inside it). This is what lets overlapping shapes be extruded piece by piece.

import type { SketchEntity, Vec2 } from "../doc/types";
import { closestOnPrim, entityPrims, evalPrim, isClosedPrim, pointInPoly, polyArea, polyCentroid, primSegments, samplePrim, type Prim } from "./curves";

export interface Piece {
  prim: number;
  t0: number;
  t1: number;
  n0: number;
  n1: number;
  /** Polyline from node n0 to node n1 (endpoints are the node positions). */
  poly: Vec2[];
}

export interface LoopRef {
  piece: number;
  reversed: boolean;
}

export interface Loop {
  pieces: LoopRef[];
  poly: Vec2[];
}

export interface Region {
  index: number;
  outer: Loop;
  holes: Loop[];
  area: number;
  centroid: Vec2;
  /** The ids of the curves round it (outline and holes), sorted. */
  curves: string[];
  /** For each of those, where along that curve the outline runs (its pieces' middles, averaged). */
  spots: number[];
}

export interface Arrangement {
  prims: Prim[];
  nodes: Vec2[];
  pieces: Piece[];
  regions: Region[];
}

export type { RegionRef } from "../doc/types";
import type { RegionRef } from "../doc/types";

const cache = new Map<string, Arrangement>();

/** Regions of a sketch. Memoised on the entity list, so callers can call freely. */
export function arrangement(entities: SketchEntity[]): Arrangement {
  const key = JSON.stringify(entities);
  const hit = cache.get(key);
  if (hit) return hit;
  const result = compute(entities.filter((e) => !e.construction));
  cache.set(key, result);
  if (cache.size > 64) cache.delete(cache.keys().next().value!);
  return result;
}

export function regionRef(r: Region): RegionRef {
  return { c: r.centroid, a: r.area, k: r.curves, s: r.spots };
}

/**
 * The region best matching a stored reference (survives edits that move it a
 * bit). Outlined by the same curves: the closest of those, however far it
 * moved - a sketch driven by variables can move a piece a long way (an arm's
 * round end, 40 mm up when the arm was made longer, was "no longer there").
 */
export function resolveRegion(arr: Arrangement, ref: RegionRef): Region | null {
  const scale = Math.sqrt(Math.max(ref.a, 1e-9));
  const score = (r: Region) => Math.hypot(r.centroid[0] - ref.c[0], r.centroid[1] - ref.c[1]) / scale + Math.abs(Math.log((r.area + 1e-12) / (ref.a + 1e-12)));
  if (ref.k?.length) {
    const key = ref.k.join(",");
    const same = arr.regions.filter((r) => r.curves.join(",") === key);
    // Several outlined by the same curves (a circle's half inside a strip and
    // the half outside it): which stretch of those curves, then size, then place.
    if (same.length === 1) return same[0];
    if (same.length > 1) {
      const along = (r: Region) => (ref.s?.length === r.spots.length ? r.spots.reduce((t, v, i) => t + Math.abs(v - ref.s![i]), 0) : 0);
      return same.reduce((a, b) => (along(b) * 10 + sizeScore(b, ref) + score(b) * 0.1 < along(a) * 10 + sizeScore(a, ref) + score(a) * 0.1 ? b : a));
    }
  }
  let best: { r: Region; s: number } | null = null;
  for (const r of arr.regions) {
    const s = score(r);
    if (!best || s < best.s) best = { r, s };
  }
  return best && best.s < 3 ? best.r : null;
}

const sizeScore = (r: Region, ref: RegionRef) => Math.abs(Math.log((r.area + 1e-12) / (ref.a + 1e-12)));

function compute(entities: SketchEntity[]): Arrangement {
  const prims = entities.flatMap(entityPrims);
  const empty: Arrangement = { prims, nodes: [], pieces: [], regions: [] };
  if (!prims.length) return empty;

  // ---- discretise
  const samples = prims.map((p) => {
    const n = primSegments(p);
    const ts = Array.from({ length: n + 1 }, (_, i) => i / n);
    return { ts, pts: ts.map((t) => evalPrim(p, t)) };
  });
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of samples)
    for (const [x, y] of s.pts) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  const size = Math.hypot(maxX - minX, maxY - minY) || 1;
  const eps = size * 1e-7;

  // ---- intersections (sweep over segments sorted by min x)
  interface Seg {
    p: number;
    i: number;
    a: Vec2;
    b: Vec2;
    x0: number;
    x1: number;
    y0: number;
    y1: number;
  }
  const segs: Seg[] = [];
  samples.forEach((s, p) => {
    for (let i = 0; i < s.pts.length - 1; i++) {
      const a = s.pts[i];
      const b = s.pts[i + 1];
      segs.push({ p, i, a, b, x0: Math.min(a[0], b[0]) - eps, x1: Math.max(a[0], b[0]) + eps, y0: Math.min(a[1], b[1]) - eps, y1: Math.max(a[1], b[1]) + eps });
    }
  });
  segs.sort((u, v) => u.x0 - v.x0);
  const splits: number[][] = prims.map(() => []);
  const tParam = (p: number, i: number, u: number) => samples[p].ts[i] + (samples[p].ts[i + 1] - samples[p].ts[i]) * u;
  for (let i = 0; i < segs.length; i++) {
    const A = segs[i];
    for (let j = i + 1; j < segs.length && segs[j].x0 <= A.x1; j++) {
      const B = segs[j];
      if (B.y0 > A.y1 || B.y1 < A.y0) continue;
      if (A.p === B.p) continue; // self-intersections are ignored
      // Lines lying on each other (e.g. drawn over a face's edge): each is split
      // where the other one ends, and the doubled pieces merge below.
      const lap = overlap(A.a, A.b, B.a, B.b, eps);
      if (lap) {
        for (const u of lap[0]) splits[A.p].push(tParam(A.p, A.i, u));
        for (const v of lap[1]) splits[B.p].push(tParam(B.p, B.i, v));
        continue;
      }
      const hit = segHit(A.a, A.b, B.a, B.b, eps);
      if (!hit) continue;
      let ta = tParam(A.p, A.i, hit[0]);
      let tb = tParam(B.p, B.i, hit[1]);
      [ta, tb] = refine(prims[A.p], prims[B.p], ta, tb);
      splits[A.p].push(ta);
      splits[B.p].push(tb);
    }
  }

  // ---- pieces
  const nodes: Vec2[] = [];
  const nodeOf = (pt: Vec2): number => {
    const tol = eps * 50;
    for (let k = 0; k < nodes.length; k++) if (Math.abs(nodes[k][0] - pt[0]) < tol && Math.abs(nodes[k][1] - pt[1]) < tol) return k;
    nodes.push(pt);
    return nodes.length - 1;
  };
  let pieces: Piece[] = [];
  prims.forEach((p, pi) => {
    const closed = isClosedPrim(p);
    let ts = [...splits[pi]].map((t) => Math.min(1, Math.max(0, t))).sort((a, b) => a - b);
    if (closed) {
      ts = ts.map((t) => (t >= 1 - 1e-9 ? 0 : t)).sort((a, b) => a - b);
      if (ts.length === 0) ts = [0, 0.5];
      else if (ts.length === 1) ts.push(ts[0] + 0.5 > 1 ? ts[0] - 0.5 : ts[0] + 0.5), ts.sort((a, b) => a - b);
    } else {
      ts.unshift(0);
      ts.push(1);
    }
    const uniq = ts.filter((t, k) => k === 0 || t - ts[k - 1] > 1e-9);
    const bounds: [number, number][] = [];
    for (let k = 0; k < uniq.length - 1; k++) bounds.push([uniq[k], uniq[k + 1]]);
    if (closed) bounds.push([uniq[uniq.length - 1], uniq[0] + 1]);
    for (const [t0, t1] of bounds) {
      const a = evalPrim(p, t0 % 1);
      const b = evalPrim(p, t1 > 1 ? t1 - 1 : t1);
      const poly = closed && t1 > 1 ? [...samplePrim(p, t0, 1).slice(0, -1), ...samplePrim(p, 0, t1 - 1)] : samplePrim(p, t0, t1);
      if (polyLength(poly) < eps * 10) continue;
      const n0 = nodeOf(a);
      const n1 = nodeOf(b);
      poly[0] = nodes[n0];
      poly[poly.length - 1] = nodes[n1];
      pieces.push({ prim: pi, t0, t1, n0, n1, poly });
    }
  });

  // ---- the same stretch drawn twice counts once
  {
    const seen = new Map<string, Vec2>();
    pieces = pieces.filter((pc) => {
      const key = pc.n0 < pc.n1 ? `${pc.n0}:${pc.n1}` : `${pc.n1}:${pc.n0}`;
      const mid = pc.poly[Math.floor(pc.poly.length / 2)];
      const m = pc.poly.length > 2 ? mid : [(pc.poly[0][0] + pc.poly[1][0]) / 2, (pc.poly[0][1] + pc.poly[1][1]) / 2] as Vec2;
      for (const [k, q] of seen) if (k.split("#")[0] === key && Math.hypot(q[0] - m[0], q[1] - m[1]) < eps * 1e3) return false;
      seen.set(`${key}#${seen.size}`, m);
      return true;
    });
  }

  // ---- drop dangling pieces (they can't bound a region)
  for (;;) {
    const deg = new Array(nodes.length).fill(0);
    for (const pc of pieces) {
      deg[pc.n0]++;
      deg[pc.n1]++;
    }
    const keep = pieces.filter((pc) => deg[pc.n0] > 1 && deg[pc.n1] > 1);
    if (keep.length === pieces.length) break;
    pieces = keep;
  }
  if (!pieces.length) return { prims, nodes, pieces, regions: [] };

  // ---- half-edge traversal
  const H = pieces.length * 2;
  const from = (h: number) => (h % 2 === 0 ? pieces[h >> 1].n0 : pieces[h >> 1].n1);
  const hpoly = (h: number) => (h % 2 === 0 ? pieces[h >> 1].poly : [...pieces[h >> 1].poly].reverse());
  const angleOf = (h: number) => {
    const pl = hpoly(h);
    const a = pl[0];
    const b = pl[1];
    const c = pl[Math.min(2, pl.length - 1)];
    const main = Math.atan2(b[1] - a[1], b[0] - a[0]);
    // Tie-break tangent pieces by where they head next.
    const next = Math.atan2(c[1] - a[1], c[0] - a[0]);
    return main + angleDiff(main, next) * 1e-3;
  };
  const out: number[][] = nodes.map(() => []);
  for (let h = 0; h < H; h++) out[from(h)].push(h);
  const ang = new Float64Array(H);
  for (let h = 0; h < H; h++) ang[h] = angleOf(h);
  for (const list of out) list.sort((x, y) => ang[x] - ang[y]);
  const next = (h: number) => {
    const twin = h ^ 1;
    const list = out[from(twin)];
    const k = list.indexOf(twin);
    return list[(k - 1 + list.length) % list.length];
  };
  const seen = new Uint8Array(H);
  const cycles: { hs: number[]; poly: Vec2[]; area: number }[] = [];
  for (let h0 = 0; h0 < H; h0++) {
    if (seen[h0]) continue;
    const hs: number[] = [];
    let h = h0;
    let guard = 0;
    while (!seen[h] && guard++ < H + 1) {
      seen[h] = 1;
      hs.push(h);
      h = next(h);
    }
    const poly: Vec2[] = [];
    for (const x of hs) poly.push(...hpoly(x).slice(0, -1));
    cycles.push({ hs, poly, area: polyArea(poly) });
  }

  // ---- components (union-find over nodes)
  const parent = nodes.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (const pc of pieces) parent[find(pc.n0)] = find(pc.n1);
  const comp = (c: { hs: number[] }) => find(from(c.hs[0]));

  const minArea = eps * eps * 100;
  const faces = cycles.filter((c) => c.area > minArea);
  const outers = cycles.filter((c) => c.area <= minArea);
  const holes = new Map<(typeof faces)[number], typeof outers>();
  for (const o of outers) {
    const p = o.poly[0];
    let best: (typeof faces)[number] | null = null;
    for (const f of faces) {
      if (comp(f) === comp(o)) continue;
      if (!pointInPoly(p, f.poly)) continue;
      if (!best || f.area < best.area) best = f;
    }
    if (best) holes.set(best, [...(holes.get(best) ?? []), o]);
  }

  const toLoop = (c: { hs: number[]; poly: Vec2[] }): Loop => ({
    pieces: c.hs.map((h) => ({ piece: h >> 1, reversed: h % 2 === 1 })),
    poly: c.poly,
  });
  // Each primitive's place among its curve's own (a rectangle's four sides: 0-3).
  const seenOf = new Map<string, number>();
  const primOrdinal = prims.map((p) => {
    const k = p.src ?? "";
    const i = seenOf.get(k) ?? 0;
    seenOf.set(k, i + 1);
    return i;
  });
  const regions: Region[] = faces.map((f, index) => {
    const hs = holes.get(f) ?? [];
    const holeArea = hs.reduce((s, o) => s + Math.abs(o.area), 0);
    const area = f.area - holeArea;
    // Area-weighted centroid of the face minus its holes.
    const c0 = polyCentroid(f.poly);
    let cx = c0[0] * f.area;
    let cy = c0[1] * f.area;
    for (const o of hs) {
      const ch = polyCentroid(o.poly);
      cx -= ch[0] * Math.abs(o.area);
      cy -= ch[1] * Math.abs(o.area);
    }
    const outer = toLoop(f);
    const inner = hs.map(toLoop);
    const loopPieces = [outer, ...inner].flatMap((l) => l.pieces.map((p) => pieces[p.piece]));
    const curves = [...new Set(loopPieces.map((p) => prims[p.prim].src ?? ""))].filter(Boolean).sort();
    // Where along each curve: which of its parts (a rectangle's side, …) plus how far along that part.
    const spots = curves.map((id) => {
      const ps = loopPieces.filter((p) => prims[p.prim].src === id);
      return ps.reduce((t, p) => t + primOrdinal[p.prim] + (p.t0 + p.t1) / 2, 0) / ps.length;
    });
    return { index, outer, holes: inner, area, centroid: [cx / area, cy / area], curves, spots };
  });
  return { prims, nodes, pieces, regions };
}

/**
 * Two collinear, overlapping segments → where (as fractions along each) the
 * other one's ends fall inside it. Null when they don't lie on each other.
 */
function overlap(a: Vec2, b: Vec2, c: Vec2, d: Vec2, eps: number): [number[], number[]] | null {
  const rx = b[0] - a[0];
  const ry = b[1] - a[1];
  const sx = d[0] - c[0];
  const sy = d[1] - c[1];
  const lu = Math.hypot(rx, ry);
  const lv = Math.hypot(sx, sy);
  if (lu < eps || lv < eps) return null;
  if (Math.abs(rx * sy - ry * sx) > lu * lv * 1e-6) return null;
  // Both ends of cd on the line through ab?
  const off = (p: Vec2) => Math.abs((p[0] - a[0]) * ry - (p[1] - a[1]) * rx) / lu;
  if (off(c) > eps * 10 || off(d) > eps * 10) return null;
  const along = (p: Vec2, o: Vec2, x: number, y: number, l: number) => ((p[0] - o[0]) * x + (p[1] - o[1]) * y) / (l * l);
  const inside = (u: number, l: number) => u > (eps * 10) / l && u < 1 - (eps * 10) / l;
  const ua = [along(c, a, rx, ry, lu), along(d, a, rx, ry, lu)].filter((u) => inside(u, lu));
  const vb = [along(a, c, sx, sy, lv), along(b, c, sx, sy, lv)].filter((v) => inside(v, lv));
  const lo = Math.min(along(c, a, rx, ry, lu), along(d, a, rx, ry, lu));
  const hi = Math.max(along(c, a, rx, ry, lu), along(d, a, rx, ry, lu));
  if (hi < 0 || lo > 1) return null;
  return [ua, vb];
}

function segHit(a: Vec2, b: Vec2, c: Vec2, d: Vec2, eps: number): [number, number] | null {
  const rx = b[0] - a[0];
  const ry = b[1] - a[1];
  const sx = d[0] - c[0];
  const sy = d[1] - c[1];
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-18) return null; // parallel / collinear overlaps ignored
  const qx = c[0] - a[0];
  const qy = c[1] - a[1];
  const u = (qx * sy - qy * sx) / den;
  const v = (qx * ry - qy * rx) / den;
  const lu = Math.hypot(rx, ry) || 1;
  const lv = Math.hypot(sx, sy) || 1;
  const tu = eps / lu;
  const tv = eps / lv;
  if (u < -tu || u > 1 + tu || v < -tv || v > 1 + tv) return null;
  return [Math.min(1, Math.max(0, u)), Math.min(1, Math.max(0, v))];
}

/** Newton-refine an intersection on the exact curves. */
function refine(p: Prim, q: Prim, t: number, s: number): [number, number] {
  if (p.t === "spline" && q.t === "spline") return [t, s];
  const h = 1e-7;
  for (let k = 0; k < 8; k++) {
    const P = evalPrim(p, t);
    const Q = evalPrim(q, s);
    const fx = P[0] - Q[0];
    const fy = P[1] - Q[1];
    if (Math.abs(fx) + Math.abs(fy) < 1e-12) break;
    const Pt = evalPrim(p, Math.min(1, t + h));
    const Qs = evalPrim(q, Math.min(1, s + h));
    const a = (Pt[0] - P[0]) / h;
    const c = (Pt[1] - P[1]) / h;
    const b = -(Qs[0] - Q[0]) / h;
    const d = -(Qs[1] - Q[1]) / h;
    const det = a * d - b * c;
    if (Math.abs(det) < 1e-14) break;
    const dt = (d * fx - b * fy) / det;
    const ds = (-c * fx + a * fy) / det;
    t = Math.min(1, Math.max(0, t - dt));
    s = Math.min(1, Math.max(0, s - ds));
  }
  return [t, s];
}

function polyLength(p: Vec2[]): number {
  let l = 0;
  for (let i = 1; i < p.length; i++) l += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
  return l;
}

function angleDiff(a: number, b: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Parameter + distance of the closest point on any primitive of an entity. */
export function closestOnEntity(e: SketchEntity, q: Vec2): { t: number; d: number; pt: Vec2; prim: number } {
  const prims = entityPrims(e);
  let best = { t: 0, d: Infinity, pt: q, prim: 0 };
  prims.forEach((p, i) => {
    const c = closestOnPrim(p, q);
    if (c.d < best.d) best = { ...c, prim: i };
  });
  return best;
}

function insidePoly(P: Vec2[], q: Vec2): boolean {
  let c = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) if (P[i][1] > q[1] !== P[j][1] > q[1] && q[0] < ((P[j][0] - P[i][0]) * (q[1] - P[i][1])) / (P[j][1] - P[i][1]) + P[i][0]) c = !c;
  return c;
}

/** A point truly inside a region (its centroid may be in a hole: a ring, a "0"). */
export function pointInRegion(r: Region): Vec2 {
  const ok = (q: Vec2) => insidePoly(r.outer.poly, q) && !r.holes.some((h) => insidePoly(h.poly, q));
  if (ok(r.centroid)) return r.centroid;
  const P = r.outer.poly;
  for (let i = 0; i < P.length; i++) {
    const a = P[i];
    const b = P[(i + 1) % P.length];
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const m: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    for (const s of [1e-4 * d, -1e-4 * d, 1e-3, -1e-3]) {
      const q: Vec2 = [m[0] - ((b[1] - a[1]) / d) * s, m[1] + ((b[0] - a[0]) / d) * s];
      if (ok(q)) return q;
    }
  }
  return r.centroid;
}

/**
 * The regions that are material when the sketch is read the usual way: inside
 * an even number of other regions' outlines (a "0" is its ring; the island in
 * its middle is the hole, not a part). Every shape of a scale or a lettering.
 */
export function materialRegions(arr: Arrangement): Region[] {
  return arr.regions.filter((r) => {
    const q = pointInRegion(r);
    let depth = 0;
    for (const o of arr.regions) if (o !== r && insidePoly(o.outer.poly, q)) depth++;
    return depth % 2 === 0;
  });
}

/**
 * "All shapes" in a sketch on a face: the pieces of the whole sketch (the
 * face's outline included, so the regions match what can be tapped) that lie
 * inside what was drawn - by nesting among the drawn shapes alone. With the
 * outline counted, windows drawn on a wall came out as holes in the wall, and
 * the cut took the wall instead of the windows.
 */
export function drawnRegions(all: Arrangement, drawn: Arrangement): Region[] {
  const solid = materialRegions(drawn);
  return all.regions.filter((r) => {
    const q = pointInRegion(r);
    return solid.some((m) => insidePoly(m.outer.poly, q) && !m.holes.some((h) => insidePoly(h.poly, q)));
  });
}
