// The grid of points over a flat face that Freeform Face shapes it with:
// evenly spaced across the face, only where the face is (an L-shaped or round
// face gets the points inside it), and not right at its edges (they stay put).

import type { Vec3 } from "../doc/types";
import { cross, dot, norm, sub, xDirFor } from "../geom";

/**
 * Points (relative to `center`) on the face made of `tris`, about `n` across
 * its longer side.
 */
export function faceGrid(tris: [Vec3, Vec3, Vec3][], center: Vec3, normal: Vec3, n = 5): Vec3[] {
  const u = xDirFor(normal);
  const v = norm(cross(normal, u));
  const uv = (p: Vec3): [number, number] => [dot(sub(p, center), u), dot(sub(p, center), v)];
  const flat = tris.map((t) => t.map(uv) as [[number, number], [number, number], [number, number]]);
  let lo = [Infinity, Infinity];
  let hi = [-Infinity, -Infinity];
  for (const t of flat)
    for (const p of t) {
      lo = [Math.min(lo[0], p[0]), Math.min(lo[1], p[1])];
      hi = [Math.max(hi[0], p[0]), Math.max(hi[1], p[1])];
    }
  const w = hi[0] - lo[0];
  const h = hi[1] - lo[1];
  if (!(w > 0 && h > 0)) return [];
  // Square cells, n of them across the longer side.
  const cell = Math.max(w, h) / (n + 1);
  const nu = Math.max(1, Math.round(w / cell) - 1);
  const nv = Math.max(1, Math.round(h / cell) - 1);
  const inside = (x: number, y: number) =>
    flat.some(([a, b, c]) => {
      const d1 = (x - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (y - b[1]);
      const d2 = (x - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (y - c[1]);
      const d3 = (x - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (y - a[1]);
      return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
    });
  const m = cell * 0.4;
  const out: Vec3[] = [];
  for (let i = 1; i <= nu; i++)
    for (let j = 1; j <= nv; j++) {
      const x = lo[0] + (w * i) / (nu + 1);
      const y = lo[1] + (h * j) / (nv + 1);
      if (![[0, 0], [m, 0], [-m, 0], [0, m], [0, -m]].every(([dx, dy]) => inside(x + dx, y + dy))) continue;
      out.push([u[0] * x + v[0] * y, u[1] * x + v[1] * y, u[2] * x + v[2] * y]);
    }
  return out;
}
