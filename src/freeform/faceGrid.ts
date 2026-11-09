// The cage Freeform Face shapes a flat face with: a grid of quads over the
// face whose border runs round the face's edge (on a rectangle, a plain grid;
// on a round or odd-shaped face, a grid stretched to fit it). The border
// points stay where they are - the face's edges don't move - and the inside
// points are moved like any freeform cage's.

import type { Vec3 } from "../doc/types";
import { cross, dot, norm, sub, xDirFor } from "../geom";
import type { Cage } from "./cage";

type P2 = [number, number];

/** The outer outline of a set of triangles, in order (anticlockwise about `normal`), in the plane's 2D. */
function outline(tris: [Vec3, Vec3, Vec3][], uv: (p: Vec3) => P2): P2[] {
  const key = (p: P2) => `${Math.round(p[0] * 1e5)},${Math.round(p[1] * 1e5)}`;
  const at = new Map<string, P2>();
  const uses = new Map<string, number>();
  const dir = new Map<string, string>();
  for (const t of tris) {
    const q = t.map(uv);
    // Each triangle anticlockwise in the plane.
    const area = (q[1][0] - q[0][0]) * (q[2][1] - q[0][1]) - (q[2][0] - q[0][0]) * (q[1][1] - q[0][1]);
    if (Math.abs(area) < 1e-14) continue;
    const r = area > 0 ? q : [q[0], q[2], q[1]];
    for (let k = 0; k < 3; k++) {
      const a = key(r[k]);
      const b = key(r[(k + 1) % 3]);
      if (a === b) continue;
      at.set(a, r[k]);
      const e = a < b ? `${a}|${b}` : `${b}|${a}`;
      uses.set(e, (uses.get(e) ?? 0) + 1);
      dir.set(`${a}>${b}`, b);
    }
  }
  // Border edges (used once), followed head to tail.
  const next = new Map<string, string>();
  for (const [k, b] of dir) {
    const a = k.slice(0, k.indexOf(">"));
    const e = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (uses.get(e) === 1) next.set(a, b);
  }
  const loops: P2[][] = [];
  const seen = new Set<string>();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const loop: P2[] = [];
    let k: string | undefined = start;
    while (k && !seen.has(k)) {
      seen.add(k);
      loop.push(at.get(k)!);
      k = next.get(k);
    }
    if (loop.length >= 3) loops.push(loop);
  }
  const signed = (l: P2[]) => l.reduce((s, p, i) => s + p[0] * l[(i + 1) % l.length][1] - l[(i + 1) % l.length][0] * p[1], 0) / 2;
  // The outer one: the biggest (anticlockwise).
  loops.sort((a, b) => Math.abs(signed(b)) - Math.abs(signed(a)));
  const outer = loops[0] ?? [];
  return signed(outer) < 0 ? outer.reverse() : outer;
}

/** `n` + 1 points evenly along a polyline (by length), both ends included. */
function resample(pts: P2[], n: number): P2[] {
  const acc = [0];
  for (let i = 1; i < pts.length; i++) acc.push(acc[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = acc[acc.length - 1];
  const out: P2[] = [];
  let i = 1;
  for (let k = 0; k <= n; k++) {
    const want = (total * k) / n;
    while (i < pts.length - 1 && acc[i] < want) i++;
    const f = acc[i] > acc[i - 1] ? (want - acc[i - 1]) / (acc[i] - acc[i - 1]) : 0;
    const t = Math.max(0, Math.min(1, f));
    out.push([pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t]);
  }
  return out;
}

/**
 * Ways to choose the four points of the outline where the grid's sides meet
 * (best first): the face's own
 * outward corners when it has four or more (the four best spread), else
 * spread evenly (a round face).
 */
function fourCorners(loop: P2[], acc: number[], total: number): number[][] {
  const N = loop.length;
  const turn = loop.map((p, i) => {
    const a = loop[(i + N - 1) % N];
    const b = loop[(i + 1) % N];
    const d1 = [p[0] - a[0], p[1] - a[1]];
    const d2 = [b[0] - p[0], b[1] - p[1]];
    // (Signed: turning in, at a corner going into the face like an L's, is negative.)
    return Math.atan2(d1[0] * d2[1] - d1[1] * d2[0], d1[0] * d2[0] + d1[1] * d2[1]);
  });
  // Only outward corners: an inward one (an L's) stays along a side.
  let corners = loop.map((_, i) => i).filter((i) => turn[i] > (25 * Math.PI) / 180);
  if (corners.length > 16) corners = corners.sort((a, b) => turn[b] - turn[a]).slice(0, 16).sort((a, b) => a - b);
  const cand = [...corners];
  // Too few corners: points evenly round it to choose from too.
  if (corners.length < 4)
    for (let k = 0; k < 32; k++) {
      const want = (total * k) / 32;
      let i = 0;
      while (i < N - 1 && acc[i + 1] <= want) i++;
      if (!cand.includes(i)) cand.push(i);
    }
  cand.sort((a, b) => a - b);
  const isCorner = new Set(corners);
  const gap = (i: number, j: number) => (acc[j] - acc[i] + total) % total;
  const all: { q: number[]; score: number }[] = [];
  const C = cand.length;
  for (let a = 0; a < C; a++)
    for (let b = a + 1; b < C; b++)
      for (let c = b + 1; c < C; c++)
        for (let d = c + 1; d < C; d++) {
          const q = [cand[a], cand[b], cand[c], cand[d]];
          const m = Math.min(gap(q[0], q[1]), gap(q[1], q[2]), gap(q[2], q[3]), gap(q[3], q[0]));
          const score = m / total + 0.2 * q.filter((i) => isCorner.has(i)).length;
          all.push({ q, score });
        }
  // Best first (the next ones are tried when a grid on the best won't fit the face).
  return all.sort((a, b) => b.score - a.score).slice(0, 12).map((x) => x.q);
}

/**
 * A cage over the flat face made of `tris` (points relative to `center`):
 * `n` cells across its longer way.
 */
export function faceCage(tris: [Vec3, Vec3, Vec3][], center: Vec3, normal: Vec3, n = 5): Cage | null {
  const nn = norm(normal);
  const u = xDirFor(nn);
  const v = norm(cross(nn, u));
  const uv = (p: Vec3): P2 => [dot(sub(p, center), u), dot(sub(p, center), v)];
  const drawn = outline(tris, uv);
  if (drawn.length < 3) return null;
  // Points along its straight edges too (a triangle's outline is three points:
  // nowhere for a fourth corner of the grid to go but a point along an edge).
  const around = drawn.reduce((t, p, i) => t + Math.hypot(drawn[(i + 1) % drawn.length][0] - p[0], drawn[(i + 1) % drawn.length][1] - p[1]), 0);
  const loop: P2[] = [];
  drawn.forEach((p, i) => {
    const q = drawn[(i + 1) % drawn.length];
    const pieces = Math.max(1, Math.ceil((Math.hypot(q[0] - p[0], q[1] - p[1]) / around) * 32));
    for (let k = 0; k < pieces; k++) loop.push([p[0] + ((q[0] - p[0]) * k) / pieces, p[1] + ((q[1] - p[1]) * k) / pieces]);
  });
  const N = loop.length;
  const acc = [0];
  for (let i = 1; i <= N; i++) acc.push(acc[i - 1] + Math.hypot(loop[i % N][0] - loop[i - 1][0], loop[i % N][1] - loop[i - 1][1]));
  const total = acc[N];
  for (const cs of fourCorners(loop, acc, total)) {
    // The four sides, each from one corner to the next.
    const side = (a: number, b: number): P2[] => {
      const out: P2[] = [];
      for (let i = a; ; i = (i + 1) % N) {
        out.push(loop[i]);
        if (i === b) break;
      }
      return out;
    };
    const sides = [0, 1, 2, 3].map((k) => side(cs[k], cs[(k + 1) % 4]));
    const length = (s: P2[]) => s.reduce((t, p, i) => (i ? t + Math.hypot(p[0] - s[i - 1][0], p[1] - s[i - 1][1]) : 0), 0);
    const Lu = (length(sides[0]) + length(sides[2])) / 2;
    const Lv = (length(sides[1]) + length(sides[3])) / 2;
    const big = Math.max(Lu, Lv);
    const nu = Math.max(2, Math.round((n * Lu) / big));
    const nv = Math.max(2, Math.round((n * Lv) / big));
    const bottom = resample(sides[0], nu);
    const right = resample(sides[1], nv);
    const top = resample(sides[2], nu).reverse();
    const left = resample(sides[3], nv).reverse();
    // Coons: the inside blended from the four sides.
    const id = (i: number, j: number) => j * (nu + 1) + i;
    const at: P2[] = [];
    for (let j = 0; j <= nv; j++)
      for (let i = 0; i <= nu; i++) {
        const s = i / nu;
        const t = j / nv;
        if (j === 0) at.push(bottom[i]);
        else if (j === nv) at.push(top[i]);
        else if (i === 0) at.push(left[j]);
        else if (i === nu) at.push(right[j]);
        else {
          const c = (k: 0 | 1) =>
            (1 - t) * bottom[i][k] + t * top[i][k] + (1 - s) * left[j][k] + s * right[j][k] -
            ((1 - s) * (1 - t) * bottom[0][k] + s * (1 - t) * bottom[nu][k] + (1 - s) * t * top[0][k] + s * t * top[nu][k]);
          at.push([c(0), c(1)]);
        }
      }
    // A face that isn't convex (an L): the blend can put points outside it.
    // Evened out (each inside point to the middle of its four neighbours) a
    // step at a time, till they're all on the face (evened out all the way they
    // can end up outside again); never: null (a coarser grid may do).
    const inside = (p: P2) => {
      let w = false;
      for (let a = 0, b = N - 1; a < N; b = a++) {
        const [pa, pb] = [loop[a], loop[b]];
        if (pa[1] > p[1] !== pb[1] > p[1] && p[0] < ((pb[0] - pa[0]) * (p[1] - pa[1])) / (pb[1] - pa[1]) + pa[0]) w = !w;
      }
      return w;
    };
    const allIn = () => at.every((p, k) => k % (nu + 1) === 0 || k % (nu + 1) === nu || k <= nu || k >= nv * (nu + 1) || inside(p));
    for (let round = 0; round < 400 && !allIn(); round++)
      for (let j = 1; j < nv; j++)
        for (let i = 1; i < nu; i++) {
          const q = [at[id(i - 1, j)], at[id(i + 1, j)], at[id(i, j - 1)], at[id(i, j + 1)]];
          at[id(i, j)] = [(q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4];
        }
    if (!allIn()) continue;
    const verts: Vec3[] = at.map((p) => [u[0] * p[0] + v[0] * p[1], u[1] * p[0] + v[1] * p[1], u[2] * p[0] + v[2] * p[1]]);
    const faces: [number, number, number, number][] = [];
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) faces.push([id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j + 1)]);
    return { verts, faces };
  }
  return null;
}
