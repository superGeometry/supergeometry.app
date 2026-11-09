// Connect: a smooth freeform bridge between two faces. A tube of cage rings
// runs from one face's outline to the other's along a curve that leaves each
// face straight out of it; its outline turns gradually from one face's shape
// into the other's. Each end goes a little way into its body (so joining it
// seals) and is closed with a flat cap of quads.

import type { Vec3 } from "../doc/types";
import { windingAgrees, flipFaces, selfCrossings, type Cage } from "./cage";

/** One end: the face's outline (any order), its middle and outward normal; how far the end may go into its body. */
export interface BridgeEnd {
  ring: Vec3[];
  center: Vec3;
  normal: Vec3;
  depth: number;
}

export interface BridgeOptions {
  /** How far the curve bows out of each face (1: a third of the gap, like a smooth S). */
  bulge: number;
  /** The bridge's outline as a fraction of the face's (1: the face's own edge). */
  size: number;
}

/** Points round each ring (the border of a 5 × 5 cap grid). */
export const RING = 16;

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3): Vec3 => mul(a, 1 / (len(a) || 1));

/** `n` points evenly spaced (by length) round a closed polyline. */
export function resampleLoop(pts: Vec3[], n = RING): Vec3[] {
  const seg = pts.map((p, i) => len(sub(pts[(i + 1) % pts.length], p)));
  const total = seg.reduce((s, x) => s + x, 0);
  const out: Vec3[] = [];
  let i = 0;
  let acc = 0;
  for (let k = 0; k < n; k++) {
    const want = (total * k) / n;
    while (i < pts.length - 1 && acc + seg[i] < want) acc += seg[i++];
    const t = seg[i] > 0 ? (want - acc) / seg[i] : 0;
    out.push(add(pts[i], mul(sub(pts[(i + 1) % pts.length], pts[i]), t)));
  }
  return out;
}

/** Turn v the least way that takes unit direction a onto unit direction b. */
function carry(v: Vec3, a: Vec3, b: Vec3): Vec3 {
  const ax = cross(a, b);
  const s = len(ax);
  const c = dot(a, b);
  if (s < 1e-12) return c > 0 ? v : mul(v, -1);
  const k = mul(ax, 1 / s);
  // Rodrigues.
  return add(add(mul(v, c), mul(cross(k, v), s)), mul(k, dot(k, v) * (1 - c)));
}

/**
 * Cage points whose smooth ring (each point a sixth of each neighbour, two
 * thirds itself) passes through the targets: the bridge's outline comes out
 * the face's size, not shrunk.
 */
function unsmoothRing(t: [number, number][]): [number, number][] {
  let q = t.map((p) => [...p] as [number, number]);
  const n = t.length;
  for (let it = 0; it < 40; it++) {
    q = q.map((p, i) => {
      const a = q[(i + n - 1) % n];
      const b = q[(i + 1) % n];
      const s = [(a[0] + 4 * p[0] + b[0]) / 6, (a[1] + 4 * p[1] + b[1]) / 6];
      return [p[0] + t[i][0] - s[0], p[1] + t[i][1] - s[1]] as [number, number];
    });
  }
  return q;
}

/** The 5 × 5 cap grid's border, in order round it: (row, col) for each ring point. */
const BORDER: [number, number][] = [
  ...[0, 1, 2, 3].map((c) => [0, c] as [number, number]),
  ...[0, 1, 2, 3].map((r) => [r, 4] as [number, number]),
  ...[4, 3, 2, 1].map((c) => [4, c] as [number, number]),
  ...[4, 3, 2, 1].map((r) => [r, 0] as [number, number]),
];

/**
 * The bridge; when the curve turns too tight for the outline's width (the
 * tube would pass through itself on the inside of the bend), the same bridge
 * with a longer straight run out of each face, until it doesn't.
 */
export function bridgeCage(a: BridgeEnd, b: BridgeEnd, o: BridgeOptions): Cage {
  let first: Cage | null = null;
  for (const reach of [1, 1.5, 2.2, 3.2]) {
    const c = bridgeTry(a, b, o, reach);
    if (!selfCrossings(c, 2, 1).length) return c;
    first ??= c;
  }
  return first!;
}

function bridgeTry(a: BridgeEnd, b: BridgeEnd, o: BridgeOptions, reach: number): Cage {
  const nA = unit(a.normal);
  const nB = unit(b.normal);
  // Both outlines anticlockwise seen from outside their face.
  const ccw = (e: BridgeEnd, n: Vec3) => {
    const r = resampleLoop(e.ring);
    let area = 0;
    for (let i = 0; i < r.length; i++) area += dot(cross(sub(r[i], e.center), sub(r[(i + 1) % r.length], e.center)), n);
    return area < 0 ? r.reverse() : r;
  };
  const ringA = ccw(a, nA);
  const ringB = ccw(b, nB);

  // The curve: Hermite from A's middle to B's, leaving A along its normal and
  // arriving at B against its normal.
  const gap = len(sub(b.center, a.center)) || 1;
  // Each end leaves its face straight for at least about its own width: a
  // tighter turn folds the inside of the bend.
  const wide = (e: BridgeEnd) => Math.max(...e.ring.map((p) => len(sub(p, e.center)))) * o.size;
  const lead = Math.max(gap * o.bulge, 1.2 * Math.max(wide(a), wide(b))) * reach;
  const T0 = mul(nA, lead);
  const T1 = mul(nB, -lead);
  const at = (t: number): Vec3 => {
    const h00 = 2 * t ** 3 - 3 * t ** 2 + 1;
    const h10 = t ** 3 - 2 * t ** 2 + t;
    const h01 = -2 * t ** 3 + 3 * t ** 2;
    const h11 = t ** 3 - t ** 2;
    return add(add(mul(a.center, h00), mul(T0, h10)), add(mul(b.center, h01), mul(T1, h11)));
  };
  const along = (t: number): Vec3 => {
    const d = add(add(mul(a.center, 6 * t ** 2 - 6 * t), mul(T0, 3 * t ** 2 - 4 * t + 1)), add(mul(b.center, -6 * t ** 2 + 6 * t), mul(T1, 3 * t ** 2 - 2 * t)));
    return len(d) > 1e-9 ? unit(d) : unit(sub(b.center, a.center));
  };

  // A frame carried along the curve without twisting (each step turned the
  // least way that follows the curve).
  const STEPS = 96;
  const tan: Vec3[] = [];
  const us: Vec3[] = [];
  let u = unit(sub(ringA[0], a.center));
  u = unit(sub(u, mul(nA, dot(u, nA))));
  let prev = nA;
  for (let k = 0; k <= STEPS; k++) {
    const t = along(k / STEPS);
    const tt = k === 0 ? nA : k === STEPS ? mul(nB, -1) : t;
    u = carry(u, prev, tt);
    u = unit(sub(u, mul(tt, dot(u, tt))));
    tan.push(tt);
    us.push(u);
    prev = tt;
  }
  const frame = (t: number) => {
    const k = Math.min(STEPS, Math.max(0, Math.round(t * STEPS)));
    const tt = tan[k];
    const uu = us[k];
    return { t: tt, u: uu, v: cross(tt, uu) };
  };

  // Each outline in its end's frame (A's anticlockwise about the curve; B's
  // reversed to be too), B's turned to line up with A's.
  const fA = frame(0);
  const fB = frame(1);
  const uvA = ringA.map((p) => [dot(sub(p, a.center), fA.u) * o.size, dot(sub(p, a.center), fA.v) * o.size] as [number, number]);
  const rb = [...ringB].reverse();
  const uvB0 = rb.map((p) => [dot(sub(p, b.center), fB.u) * o.size, dot(sub(p, b.center), fB.v) * o.size] as [number, number]);
  const dir = (p: [number, number]) => {
    const l = Math.hypot(p[0], p[1]) || 1;
    return [p[0] / l, p[1] / l];
  };
  let best = 0;
  let bestCost = Infinity;
  for (let s = 0; s < RING; s++) {
    let c = 0;
    for (let i = 0; i < RING; i++) {
      const p = dir(uvA[i]);
      const q = dir(uvB0[(i + s) % RING]);
      c += (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2;
    }
    if (c < bestCost) ((bestCost = c), (best = s));
  }
  const uvB = uvA.map((_, i) => uvB0[(i + best) % RING]);

  // Rings: into A, A's face, along the curve, B's face, into B.
  const size = (uv: [number, number][]) => Math.max(...uv.map((p) => Math.hypot(p[0], p[1])));
  const across = Math.max(size(uvA), size(uvB), 1e-6);
  // Rings spaced along the curve by its length and by how much it turns
  // (closer where it bends).
  const N = 400;
  const dist = [0];
  const bend = [0];
  for (let k = 1; k <= N; k++) {
    const turn = Math.acos(Math.max(-1, Math.min(1, dot(along((k - 1) / N), along(k / N)))));
    const step = len(sub(at(k / N), at((k - 1) / N)));
    dist.push(dist[k - 1] + step + 1.5 * across * turn);
    bend.push(turn / Math.max(step, 1e-9));
  }
  // Where the curve turns tighter than the tube is wide, the tube narrows
  // there (its inside would fold through itself).
  const narrow = (t: number, width: number) => {
    const k = Math.round(t * N);
    let most = 0;
    for (let j = Math.max(1, k - 12); j <= Math.min(N, k + 12); j++) most = Math.max(most, bend[j]);
    return Math.min(1, 0.75 / Math.max(most * width, 1e-9));
  };
  const D = dist[N];
  const inner = Math.max(2, Math.min(22, Math.round(D / (0.8 * across))));
  const tAt = (d: number) => {
    let k = 1;
    while (k < N && dist[k] < d) k++;
    const f = dist[k] > dist[k - 1] ? (d - dist[k - 1]) / (dist[k] - dist[k - 1]) : 0;
    return (k - 1 + Math.max(0, Math.min(1, f))) / N;
  };
  const rings: Vec3[][] = [];
  const ringAt = (c: Vec3, f: { u: Vec3; v: Vec3 }, uv: [number, number][]) => unsmoothRing(uv).map((p) => add(c, add(mul(f.u, p[0]), mul(f.v, p[1]))));
  rings.push(ringAt(sub(a.center, mul(nA, a.depth)), fA, uvA));
  for (let j = 0; j <= inner + 1; j++) {
    const t = tAt((D * j) / (inner + 1));
    const s = t * t * (3 - 2 * t);
    const uv0 = uvA.map((p, i) => [p[0] + (uvB[i][0] - p[0]) * s, p[1] + (uvB[i][1] - p[1]) * s] as [number, number]);
    const k = j === 0 || j === inner + 1 ? 1 : narrow(t, size(uv0));
    const uv = uv0.map((p) => [p[0] * k, p[1] * k] as [number, number]);
    rings.push(ringAt(at(t), frame(t), uv));
  }
  rings.push(ringAt(sub(b.center, mul(nB, b.depth)), fB, uvB));

  // The cage: the tube's quads, then a flat 5 × 5 cap on each end.
  const verts: Vec3[] = rings.flat();
  const faces: [number, number, number, number][] = [];
  const id = (j: number, i: number) => j * RING + (i % RING);
  for (let j = 0; j < rings.length - 1; j++) for (let i = 0; i < RING; i++) faces.push([id(j, i), id(j, i + 1), id(j + 1, i + 1), id(j + 1, i)]);
  const cap = (j: number) => {
    const g: number[][] = Array.from({ length: 5 }, () => new Array(5).fill(-1));
    BORDER.forEach(([r, c], i) => (g[r][c] = id(j, i)));
    // Inside: blended from the border (Coons), on the end ring's plane.
    const P = (r: number, c: number) => verts[g[r][c]];
    for (let r = 1; r < 4; r++)
      for (let c = 1; c < 4; c++) {
        const s = c / 4;
        const t = r / 4;
        const lr = add(mul(P(r, 0), 1 - s), mul(P(r, 4), s));
        const tb = add(mul(P(0, c), 1 - t), mul(P(4, c), t));
        const corners = add(add(mul(P(0, 0), (1 - s) * (1 - t)), mul(P(0, 4), s * (1 - t))), add(mul(P(4, 0), (1 - s) * t), mul(P(4, 4), s * t)));
        verts.push(sub(add(lr, tb), corners));
        g[r][c] = verts.length - 1;
      }
    const out: [number, number, number, number][] = [];
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) out.push([g[r][c], g[r][c + 1], g[r + 1][c + 1], g[r + 1][c]]);
    return out;
  };
  const capA = cap(0);
  const capB = cap(rings.length - 1);
  // Each cap the way round that agrees with the tube.
  const n0 = faces.length;
  const n1 = n0 + capA.length;
  const raw: Cage = { verts, faces: [...faces, ...capA, ...capB] };
  let cage = raw;
  for (const [fa, fb] of [[false, false], [true, false], [false, true], [true, true]]) {
    const c = flipFaces(raw, (i) => (fa && i >= n0 && i < n1) || (fb && i >= n1));
    if (windingAgrees(c)) {
      cage = c;
      break;
    }
  }
  // Outward: the enclosed volume positive.
  let vol = 0;
  for (const f of cage.faces) {
    const [p, q, r, s] = f.map((i) => cage.verts[i]);
    vol += dot(p, cross(q, r)) + dot(p, cross(r, s));
  }
  if (vol < 0) cage = flipFaces(cage, () => true);
  return cage;
}
