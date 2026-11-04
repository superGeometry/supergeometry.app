// Sketch constraint solver: every entity is a short parameter vector; each
// constraint is one or more residuals; Levenberg–Marquardt drives them to zero
// while a weak pull towards the current shape keeps under-constrained sketches
// from wandering (so the result is the smallest change that satisfies them).

import type { ConstraintType, PointRef, SketchConstraint, SketchEntity, Vec2 } from "../doc/types";
import { arcFrom3, entityCorners } from "./curves";

// ------------------------------------------------------------- parameters

/** Entity → flat parameter list (and back). */
function params(e: SketchEntity): number[] {
  switch (e.kind) {
    case "line":
      return [...e.a, ...e.b];
    case "arc":
      return [...e.a, ...e.m, ...e.b];
    case "circle":
      return [...e.center, e.radius];
    case "ellipse":
      return [...e.center, e.rx, e.ry, e.rotation];
    case "rect":
      return [...e.center, e.w, e.h, e.rotation];
    case "polygon":
      return [...e.center, e.radius, e.angle];
    case "spline":
    case "polyline":
      return e.points.flat();
  }
}

function withParams(e: SketchEntity, x: number[]): SketchEntity {
  switch (e.kind) {
    case "line":
      return { ...e, a: [x[0], x[1]], b: [x[2], x[3]] };
    case "arc":
      return { ...e, a: [x[0], x[1]], m: [x[2], x[3]], b: [x[4], x[5]] };
    case "circle":
      return { ...e, center: [x[0], x[1]], radius: Math.abs(x[2]) };
    case "ellipse":
      return { ...e, center: [x[0], x[1]], rx: Math.abs(x[2]), ry: Math.abs(x[3]), rotation: x[4] };
    case "rect":
      return { ...e, center: [x[0], x[1]], w: Math.abs(x[2]), h: Math.abs(x[3]), rotation: x[4] };
    case "polygon":
      return { ...e, center: [x[0], x[1]], radius: Math.abs(x[2]), angle: x[3] };
    case "spline":
    case "polyline": {
      const pts: Vec2[] = [];
      for (let i = 0; i < x.length; i += 2) pts.push([x[i], x[i + 1]]);
      return { ...e, points: pts };
    }
  }
}

/** Named points of an entity (what constraints can grab). */
export function pointsOf(e: SketchEntity): { p: string; at: Vec2 }[] {
  switch (e.kind) {
    case "line":
      return [{ p: "a", at: e.a }, { p: "b", at: e.b }];
    case "arc": {
      const c = arcFrom3(e.a, e.m, e.b);
      return [{ p: "a", at: e.a }, { p: "b", at: e.b }, ...(c ? [{ p: "c", at: c.c }] : [])];
    }
    case "circle":
    case "ellipse":
      return [{ p: "c", at: e.center }];
    case "rect":
    case "polygon":
      return [{ p: "c", at: e.center }, ...entityCorners(e).map((at, i) => ({ p: `k${i}`, at }))];
    case "spline":
    case "polyline":
      return e.points.map((at, i) => ({ p: `k${i}`, at }));
  }
}

export function pointOf(e: SketchEntity, p: string): Vec2 | null {
  return pointsOf(e).find((q) => q.p === p)?.at ?? null;
}

/** Size of an entity by name, for dimension constraints and size fields. */
export function sizeOf(e: SketchEntity, prop: string): number | null {
  switch (prop) {
    case "length":
      if (e.kind === "line") return Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]);
      return null;
    case "radius":
    case "diameter": {
      const r = e.kind === "circle" || e.kind === "polygon" ? e.radius : e.kind === "arc" ? (arcFrom3(e.a, e.m, e.b)?.r ?? null) : null;
      return r === null ? null : prop === "diameter" ? 2 * r : r;
    }
    case "w":
      return e.kind === "rect" ? e.w : null;
    case "h":
      return e.kind === "rect" ? e.h : null;
    case "rx":
      return e.kind === "ellipse" ? e.rx : null;
    case "ry":
      return e.kind === "ellipse" ? e.ry : null;
    // Ellipse axis lengths (full widths, like a circle's diameter).
    case "dx":
      return e.kind === "ellipse" ? 2 * e.rx : null;
    case "dy":
      return e.kind === "ellipse" ? 2 * e.ry : null;
    case "angle":
      return e.kind === "line" ? (Math.atan2(e.b[1] - e.a[1], e.b[0] - e.a[0]) * 180) / Math.PI : null;
  }
  return null;
}

/** Direction of a straight entity (line), or null. */
function dirOf(e: SketchEntity): Vec2 | null {
  if (e.kind !== "line") return null;
  return [e.b[0] - e.a[0], e.b[1] - e.a[1]];
}

/** Centre and radius of round entities. */
function roundOf(e: SketchEntity): { c: Vec2; r: number } | null {
  if (e.kind === "circle") return { c: e.center, r: e.radius };
  if (e.kind === "arc") {
    const a = arcFrom3(e.a, e.m, e.b);
    return a ? { c: a.c, r: a.r } : null;
  }
  return null;
}

// --------------------------------------------------------------- residuals

type Lookup = (id: string) => SketchEntity | undefined;

/** Residuals of one constraint (empty if it refers to something missing). */
function residuals(c: SketchConstraint, get: Lookup): number[] {
  const P = (r: PointRef) => {
    const e = get(r.e);
    return e ? pointOf(e, r.p) : null;
  };
  const E = (i: number) => (c.curves?.[i] ? get(c.curves[i]) : undefined);
  const unit = (v: Vec2) => {
    const l = Math.hypot(v[0], v[1]) || 1;
    return [v[0] / l, v[1] / l] as Vec2;
  };
  switch (c.type) {
    case "coincident": {
      const [a, b] = (c.pts ?? []).map(P);
      if (a && b) return [a[0] - b[0], a[1] - b[1]];
      // Point on a curve.
      const e = E(0);
      if (a && e) return [distToEntity(a, e)];
      return [];
    }
    case "horizontal":
    case "vertical": {
      const e = E(0);
      const d = e && dirOf(e);
      if (d) return [c.type === "horizontal" ? d[1] : d[0]];
      const [a, b] = (c.pts ?? []).map(P);
      if (a && b) return [c.type === "horizontal" ? a[1] - b[1] : a[0] - b[0]];
      return [];
    }
    case "parallel":
    case "perpendicular": {
      const [d1, d2] = [E(0), E(1)].map((e) => (e ? dirOf(e) : null));
      if (!d1 || !d2) return [];
      const u = unit(d1);
      const v = unit(d2);
      return [c.type === "parallel" ? u[0] * v[1] - u[1] * v[0] : u[0] * v[0] + u[1] * v[1]];
    }
    case "equal": {
      const [e1, e2] = [E(0), E(1)];
      if (!e1 || !e2) return [];
      const s = (e: SketchEntity) => sizeOf(e, e.kind === "line" ? "length" : "radius");
      const a = s(e1);
      const b = s(e2);
      return a !== null && b !== null ? [a - b] : [];
    }
    case "tangent": {
      const [e1, e2] = [E(0), E(1)];
      if (!e1 || !e2) return [];
      const r1 = roundOf(e1);
      const r2 = roundOf(e2);
      const line = e1.kind === "line" ? e1 : e2.kind === "line" ? e2 : null;
      const round = r1 ?? r2;
      if (line && round) return [distPointLine(round.c, line.a, line.b) - round.r];
      if (r1 && r2) {
        const d = Math.hypot(r1.c[0] - r2.c[0], r1.c[1] - r2.c[1]);
        // External tangency unless one contains the other.
        return [Math.min(Math.abs(d - (r1.r + r2.r)), Math.abs(d - Math.abs(r1.r - r2.r)))];
      }
      return [];
    }
    case "concentric": {
      const c1 = E(0) && centreOf(E(0)!);
      const c2 = E(1) && centreOf(E(1)!);
      return c1 && c2 ? [c1[0] - c2[0], c1[1] - c2[1]] : [];
    }
    case "midpoint": {
      const a = c.pts?.[0] && P(c.pts[0]);
      const e = E(0);
      if (!a || e?.kind !== "line") return [];
      return [a[0] - (e.a[0] + e.b[0]) / 2, a[1] - (e.a[1] + e.b[1]) / 2];
    }
    case "symmetric": {
      const [a, b] = (c.pts ?? []).map(P);
      const e = E(0);
      if (!a || !b || e?.kind !== "line") return [];
      const m: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const d = unit(dirOf(e)!);
      // Midpoint on the line, and a–b perpendicular to it.
      return [distPointLineSigned(m, e.a, e.b), (b[0] - a[0]) * d[0] + (b[1] - a[1]) * d[1]];
    }
    case "fix": {
      const a = c.pts?.[0] && P(c.pts[0]);
      return a && c.at ? [a[0] - c.at[0], a[1] - c.at[1]] : [];
    }
    case "distance": {
      if (c.value === undefined) return [];
      // Point to line: perpendicular distance.
      if (c.pts?.length === 1 && c.curves?.length === 1) {
        const p = P(c.pts[0]);
        const l = E(0);
        return p && l?.kind === "line" ? [distPointLine(p, l.a, l.b) - c.value] : [];
      }
      const [a, b] = (c.pts ?? []).map(P);
      return a && b ? [Math.hypot(a[0] - b[0], a[1] - b[1]) - c.value] : [];
    }
    case "dim": {
      const e = E(0);
      if (!e || !c.prop || c.value === undefined) return [];
      if (c.prop === "angle" && c.curves?.length === 2) {
        const d1 = dirOf(e);
        const d2 = E(1) && dirOf(E(1)!);
        if (!d1 || !d2) return [];
        const ang = Math.atan2(d1[0] * d2[1] - d1[1] * d2[0], d1[0] * d2[0] + d1[1] * d2[1]);
        return [wrap(Math.abs(ang) - (c.value * Math.PI) / 180)];
      }
      const s = sizeOf(e, c.prop);
      if (s === null) return [];
      return c.prop === "angle" ? [wrap(((s - c.value) * Math.PI) / 180)] : [s - c.value];
    }
  }
}

function wrap(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

function centreOf(e: SketchEntity): Vec2 | null {
  if (e.kind === "circle" || e.kind === "ellipse" || e.kind === "rect" || e.kind === "polygon") return e.center;
  return roundOf(e)?.c ?? null;
}

function distPointLine(p: Vec2, a: Vec2, b: Vec2): number {
  return Math.abs(distPointLineSigned(p, a, b));
}

function distPointLineSigned(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l = Math.hypot(dx, dy) || 1;
  return ((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / l;
}

function distToEntity(p: Vec2, e: SketchEntity): number {
  if (e.kind === "line") return distPointLineSigned(p, e.a, e.b);
  const r = roundOf(e);
  if (r) return Math.hypot(p[0] - r.c[0], p[1] - r.c[1]) - r.r;
  return 0;
}

// ------------------------------------------------------------------ solver

export interface SolveOptions {
  /** Points to pull towards a target (dragging), with a strong weight. */
  drag?: { ref: PointRef; to: Vec2 }[];
  /** Entities that must not move (e.g. the face outline). */
  fixed?: Set<string>;
}

export interface SolveResult {
  entities: SketchEntity[];
  /** Largest remaining residual (≈0 when every constraint is met). */
  error: number;
  ok: boolean;
}

/** Solve constraints; returns updated entities (unchanged ones are kept). */
export function solve(entities: SketchEntity[], constraints: SketchConstraint[], opts: SolveOptions = {}): SolveResult {
  const live = constraints.filter((c) => refsOf(c).every((id) => entities.some((e) => e.id === id)));
  if (!live.length && !opts.drag?.length) return { entities, error: 0, ok: true };
  // Only entities that take part move; everything else is left as is.
  const involved = new Set<string>(live.flatMap(refsOf));
  for (const d of opts.drag ?? []) involved.add(d.ref.e);
  for (const id of opts.fixed ?? []) involved.delete(id);
  const movers = entities.filter((e) => involved.has(e.id));
  const offsets: number[] = [];
  const x0: number[] = [];
  for (const e of movers) {
    offsets.push(x0.length);
    x0.push(...params(e));
  }
  const byId = new Map(entities.map((e) => [e.id, e]));
  const build = (x: number[]) => {
    const m = new Map(byId);
    movers.forEach((e, i) => m.set(e.id, withParams(e, x.slice(offsets[i], offsets[i] + params(e).length))));
    return m;
  };
  const scale = Math.max(1, ...x0.map(Math.abs));
  // Two passes: a noticeable pull first (smallest change), then almost none (exact constraints).
  let xs = x0;
  for (const w of [1e-3, 1e-8]) xs = lm(xs, w);
  const m = build(xs);
  const get = (id: string) => m.get(id);
  const error = Math.max(0, ...live.flatMap((c) => residuals(c, get).map(Math.abs)));
  return { entities: entities.map((e) => m.get(e.id) ?? e), error, ok: error < 1e-6 * Math.max(1, scale) };

  function lm(start: number[], weight: number): number[] {
  const x0 = start;
  const R = (x: number[]) => {
    const m = build(x);
    const get = (id: string) => m.get(id);
    const out: number[] = [];
    for (const c of live) out.push(...residuals(c, get));
    for (const d of opts.drag ?? []) {
      const e = m.get(d.ref.e);
      const p = e && pointOf(e, d.ref.p);
      // The drag target is "soft but strong": constraints still win where they conflict.
      if (p) out.push((p[0] - d.to[0]) * 0.3, (p[1] - d.to[1]) * 0.3);
    }
    // Weak pull towards the start: picks the smallest change for free directions.
    for (let i = 0; i < x.length; i++) out.push((x[i] - x0[i]) * weight);
    return out;
  };
  let x = x0.slice();
  let r = R(x);
  let cost = dot(r, r);
  let lambda = 1e-3;
  const n = x.length;
  for (let it = 0; it < 60 && cost > 1e-20; it++) {
    // Numeric Jacobian.
    const J: number[][] = [];
    for (let j = 0; j < n; j++) {
      const h = 1e-6 * Math.max(1, Math.abs(x[j]), scale * 1e-3);
      const xp = x.slice();
      xp[j] += h;
      const rp = R(xp);
      J.push(rp.map((v, i) => (v - r[i]) / h));
    }
    // (JᵀJ + λ diag) dx = -Jᵀ r
    const A: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
    const g = new Array(n).fill(0);
    for (let a = 0; a < n; a++) {
      for (let b = a; b < n; b++) {
        let s = 0;
        const Ja = J[a];
        const Jb = J[b];
        for (let i = 0; i < r.length; i++) s += Ja[i] * Jb[i];
        A[a][b] = A[b][a] = s;
      }
      let s = 0;
      for (let i = 0; i < r.length; i++) s += J[a][i] * r[i];
      g[a] = -s;
    }
    let improved = false;
    for (let tries = 0; tries < 8; tries++) {
      const M = A.map((row, i) => row.map((v, j) => (i === j ? v * (1 + lambda) + 1e-12 : v)));
      const dx = solveLinear(M, g);
      if (!dx) {
        lambda *= 10;
        continue;
      }
      const xn = x.map((v, i) => v + dx[i]);
      const rn = R(xn);
      const cn = dot(rn, rn);
      if (cn < cost) {
        x = xn;
        r = rn;
        cost = cn;
        lambda = Math.max(1e-9, lambda / 3);
        improved = true;
        break;
      }
      lambda *= 10;
    }
    if (!improved) break;
  }
  return x;
  }
}

/** Entity ids a constraint refers to. */
export function refsOf(c: SketchConstraint): string[] {
  return [...(c.pts ?? []).map((p) => p.e), ...(c.curves ?? [])];
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** Gaussian elimination with partial pivoting. */
function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-18) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      if (!f) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

// ------------------------------------------------------------- utilities

/** Which constraints the current selection allows (for enabling buttons). */
export function applicable(type: ConstraintType, pts: PointRef[], curves: SketchEntity[]): boolean {
  const lines = curves.filter((e) => e.kind === "line");
  const rounds = curves.filter((e) => e.kind === "circle" || e.kind === "arc");
  switch (type) {
    case "coincident":
      return pts.length === 2 || (pts.length === 1 && curves.length === 1);
    case "horizontal":
    case "vertical":
      return (lines.length === 1 && curves.length === 1 && !pts.length) || (pts.length === 2 && !curves.length);
    case "parallel":
    case "perpendicular":
      return lines.length === 2 && curves.length === 2;
    case "equal":
      return curves.length === 2 && (lines.length === 2 || rounds.length === 2);
    case "tangent":
      return curves.length === 2 && rounds.length >= 1;
    case "concentric":
      return curves.length === 2 && curves.every((e) => e.kind !== "line" && e.kind !== "spline" && e.kind !== "polyline");
    case "midpoint":
      return pts.length === 1 && lines.length === 1 && curves.length === 1;
    case "symmetric":
      return pts.length === 2 && lines.length === 1 && curves.length === 1;
    case "distance":
      return (pts.length === 2 && !curves.length) || (pts.length === 1 && lines.length === 1 && curves.length === 1);
    case "fix":
      // Points, or whole curves (all their points).
      return pts.length >= 1 || curves.length >= 1;
    default:
      return false;
  }
}
