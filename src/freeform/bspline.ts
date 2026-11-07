// Uniform cubic B-spline interpolation of a point grid (pure math).
//
// Every freeform patch is an equal-sized grid with the same uniform
// parameters, so the knots and the interpolation matrix are shared - and two
// patches with the same border points get exactly the same border curve.

import type { Vec3 } from "../doc/types";

export interface CubicKnots {
  /** Distinct knot values and their multiplicities (clamped: ends ×4). */
  knots: number[];
  mults: number[];
  /** The full knot vector, for evaluation. */
  full: number[];
}

/** Knots for interpolating m+1 points at uniform parameters (de Boor averaging). */
export function cubicKnots(count: number): CubicKnots {
  const m = count - 1;
  const t = Array.from({ length: count }, (_, k) => k / m);
  const inner: number[] = [];
  for (let j = 1; j <= m - 3; j++) inner.push((t[j] + t[j + 1] + t[j + 2]) / 3);
  const full = [0, 0, 0, 0, ...inner, 1, 1, 1, 1];
  return { knots: [0, ...inner, 1], mults: [4, ...inner.map(() => 1), 4], full };
}

/** Cox–de Boor: value of basis function i (degree 3) at u. */
function basis(full: number[], i: number, u: number): number {
  const N = (j: number, p: number): number => {
    if (p === 0) {
      // The last span includes its right end.
      const last = u === 1 && full[j + 1] === 1 && full[j] < 1;
      return (full[j] <= u && u < full[j + 1]) || last ? 1 : 0;
    }
    const a = full[j + p] - full[j];
    const b = full[j + p + 1] - full[j + 1];
    return (a ? ((u - full[j]) / a) * N(j, p - 1) : 0) + (b ? ((full[j + p + 1] - u) / b) * N(j + 1, p - 1) : 0);
  };
  return N(i, 3);
}

/** Inverse of the interpolation matrix A[k][i] = N_i(t_k) for `count` uniform points. */
const inverses = new Map<number, number[][]>();
function interpolationInverse(count: number): number[][] {
  let inv = inverses.get(count);
  if (inv) return inv;
  const { full } = cubicKnots(count);
  const A = Array.from({ length: count }, (_, k) => Array.from({ length: count }, (_, i) => basis(full, i, k / (count - 1))));
  inv = invert(A);
  inverses.set(count, inv);
  return inv;
}

function invert(A: number[][]): number[][] {
  const n = A.length;
  const M = A.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c];
    for (let k = 0; k < 2 * n; k++) M[c][k] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c];
      if (f) for (let k = 0; k < 2 * n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row) => row.slice(n));
}

/** Poles of the bicubic surface through grid[i][j] (both directions uniform). */
export function interpolateGrid(grid: Vec3[][]): Vec3[][] {
  const rows = grid.length;
  const cols = grid[0].length;
  const iu = interpolationInverse(rows);
  const iv = interpolationInverse(cols);
  // Rows first (along j), then columns (along i).
  const R = grid.map((row) => iv.map((w) => w.reduce((s, x, k) => [s[0] + x * row[k][0], s[1] + x * row[k][1], s[2] + x * row[k][2]] as Vec3, [0, 0, 0] as Vec3)));
  return iu.map((w) => Array.from({ length: cols }, (_, j) => w.reduce((s, x, k) => [s[0] + x * R[k][j][0], s[1] + x * R[k][j][1], s[2] + x * R[k][j][2]] as Vec3, [0, 0, 0] as Vec3)));
}

/** Evaluate the interpolating surface (for tests): S(u, v). */
export function evalSurface(poles: Vec3[][], u: number, v: number): Vec3 {
  const ku = cubicKnots(poles.length).full;
  const kv = cubicKnots(poles[0].length).full;
  const out: Vec3 = [0, 0, 0];
  for (let i = 0; i < poles.length; i++) {
    const bu = basis(ku, i, u);
    if (!bu) continue;
    for (let j = 0; j < poles[0].length; j++) {
      const w = bu * basis(kv, j, v);
      if (!w) continue;
      for (let q = 0; q < 3; q++) out[q] += w * poles[i][j][q];
    }
  }
  return out;
}
