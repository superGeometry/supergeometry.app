// Freehand drawing (Spline > Draw): a pencil stroke made into a few clean curves.
//
// A stroke is hundreds of points; drawn as is it would be hundreds of edges.
// Here it is cut at its sharp corners, and each run between corners becomes
// the simplest curve that stays within `tol` of where the pointer went: a
// line, an arc, or a fit spline through as few points as that takes. A closed
// stroke without corners that is round enough becomes a circle.

import type { Vec2 } from "../doc/types";
import { splinePoints } from "./curves";

export type FreehandPiece =
  | { kind: "line"; a: Vec2; b: Vec2 }
  | { kind: "arc"; a: Vec2; m: Vec2; b: Vec2 }
  | { kind: "circle"; center: Vec2; radius: number }
  | { kind: "spline"; points: Vec2[]; closed: boolean };

export interface Freehand {
  pieces: FreehandPiece[];
  /** The stroke ended where it began: the pieces make one closed outline. */
  closed: boolean;
}

const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Distance from p to the segment a-b. */
function segDist(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)) : 0;
  return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t);
}

function length(pts: Vec2[]): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]);
  return L;
}

/** Evenly spaced points along a polyline (the ends kept). */
function resample(pts: Vec2[], step: number): Vec2[] {
  const out: Vec2[] = [pts[0]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const d = dist(a, b);
    let t = step - carry;
    while (t <= d) {
      out.push([a[0] + ((b[0] - a[0]) * t) / d, a[1] + ((b[1] - a[1]) * t) / d]);
      t += step;
    }
    carry = d - (t - step);
  }
  const last = pts[pts.length - 1];
  if (dist(out[out.length - 1], last) > step * 0.3) out.push(last);
  else out[out.length - 1] = last;
  return out;
}

/** Light smoothing (hand jitter), the ends kept unless the stroke is a loop. */
function smooth(pts: Vec2[], loop: boolean, passes = 2): Vec2[] {
  let p = pts;
  const n = p.length;
  for (let k = 0; k < passes; k++) {
    p = p.map((q, i) => {
      if (!loop && (i === 0 || i === n - 1)) return q;
      const a = p[(i - 1 + n) % n];
      const b = p[(i + 1) % n];
      return [(a[0] + 2 * q[0] + b[0]) / 4, (a[1] + 2 * q[1] + b[1]) / 4] as Vec2;
    });
  }
  return p;
}

/** Least-squares circle (Kåsa) through points; null when they are (nearly) straight. */
export function fitCircle(pts: Vec2[]): { c: Vec2; r: number } | null {
  const n = pts.length;
  if (n < 3) return null;
  let mx = 0;
  let my = 0;
  for (const p of pts) (mx += p[0]), (my += p[1]);
  mx /= n;
  my /= n;
  let suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (const p of pts) {
    const u = p[0] - mx;
    const v = p[1] - my;
    suu += u * u;
    svv += v * v;
    suv += u * v;
    suuu += u * u * u;
    svvv += v * v * v;
    suvv += u * v * v;
    svuu += v * u * u;
  }
  const det = suu * svv - suv * suv;
  if (Math.abs(det) < 1e-18 * Math.max(1, suu * svv)) return null;
  const b1 = (suuu + suvv) / 2;
  const b2 = (svvv + svuu) / 2;
  const uc = (b1 * svv - b2 * suv) / det;
  const vc = (b2 * suu - b1 * suv) / det;
  const r = Math.sqrt(uc * uc + vc * vc + (suu + svv) / n);
  return Number.isFinite(r) ? { c: [mx + uc, my + vc], r } : null;
}

/** Indices of the sharp corners of an evenly spaced stroke. */
function corners(p: Vec2[], loop: boolean, k: number, minTurn: number): number[] {
  const n = p.length;
  const turn = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (!loop && (i < k || i > n - 1 - k)) continue;
    const a = p[(i - k + n) % n];
    const b = p[(i + k) % n];
    const q = p[i];
    const a1 = Math.atan2(q[1] - a[1], q[0] - a[0]);
    const a2 = Math.atan2(b[1] - q[1], b[0] - q[0]);
    let d = Math.abs(a2 - a1);
    if (d > Math.PI) d = 2 * Math.PI - d;
    turn[i] = d;
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    if (turn[i] < minTurn) continue;
    // The sharpest spot of the bend (a tie goes to the first).
    let best = true;
    for (let j = -k; j <= k && best; j++) {
      if (!j) continue;
      const m = loop ? (i + j + n) % n : i + j;
      if (m < 0 || m >= n) continue;
      if (turn[m] > turn[i] || (turn[m] === turn[i] && j < 0)) best = false;
    }
    if (best) out.push(i);
  }
  return out;
}

/**
 * A run between two corners, as one curve within tol. `exact`: the points lie
 * on the true curve (a font's outline, not a hand's wobble) - lines and arcs
 * must keep to tol itself.
 */
export function fitRun(run: Vec2[], tol: number, exact = false): FreehandPiece {
  const a = run[0];
  const b = run[run.length - 1];
  const L = length(run);
  const chord = dist(a, b);
  // Straight enough (a freehand line wobbles a little more than the tolerance).
  const lineTol = exact ? tol : Math.min(Math.max(tol * 1.6, L * 0.015), tol * 4);
  if (chord > 0 && run.every((p) => segDist(p, a, b) <= lineTol)) return { kind: "line", a, b };
  // Round enough: an arc (not almost a full turn, and not a huge flat one).
  const c = fitCircle(run);
  if (c && c.r < chord * 20 + L) {
    const arcTol = exact ? tol : Math.min(Math.max(tol * 1.5, c.r * 0.02), tol * 2.5);
    if (run.every((p) => Math.abs(dist(p, c.c) - c.r) <= arcTol)) {
      let sweep = 0;
      for (let i = 1; i < run.length; i++) {
        const t0 = Math.atan2(run[i - 1][1] - c.c[1], run[i - 1][0] - c.c[0]);
        const t1 = Math.atan2(run[i][1] - c.c[1], run[i][0] - c.c[0]);
        let d = t1 - t0;
        if (d > Math.PI) d -= 2 * Math.PI;
        if (d < -Math.PI) d += 2 * Math.PI;
        sweep += d;
      }
      if (Math.abs(sweep) < Math.PI * 1.75 && Math.abs(sweep) > 0.2) {
        const onC = (p: Vec2): Vec2 => {
          const d = dist(p, c.c) || 1;
          return [c.c[0] + ((p[0] - c.c[0]) * c.r) / d, c.c[1] + ((p[1] - c.c[1]) * c.r) / d];
        };
        // Ends stay where they were drawn (they join the next piece); the middle on the circle.
        return { kind: "arc", a, m: onC(run[Math.floor(run.length / 2)]), b };
      }
    }
  }
  return { kind: "spline", points: fitSpline(run, false, tol), closed: false };
}

/**
 * As few fit points as keep the spline within tol of the stroke: start from a
 * handful and add the stroke point where the spline strays furthest, until it
 * doesn't.
 */
export function fitSpline(run: Vec2[], loop: boolean, tol: number): Vec2[] {
  const n = run.length;
  // Too few points to thin out (a tiny curve): all of them.
  if (n <= (loop ? 4 : 3)) return run.slice();
  const PER = 12;
  const idx: number[] = loop ? [0, 1, 2, 3].map((i) => Math.floor((i * n) / 4)) : [0, Math.floor(n / 2), n - 1];
  // The worst stroke point (and how far): each one measured against the spans
  // around its own (the curve near it), not the whole curve - long strokes stay quick.
  const worst = (ix: number[]): [number, number] => {
    let curve = splinePoints(ix.map((i) => run[i]), loop, "fit", PER);
    // Down to its two ends: a straight span (sampled like the others).
    if (curve.length === 2) curve = Array.from({ length: PER + 1 }, (_, k) => [curve[0][0] + ((curve[1][0] - curve[0][0]) * k) / PER, curve[0][1] + ((curve[1][1] - curve[0][1]) * k) / PER] as Vec2);
    const spans = loop ? ix.length : ix.length - 1;
    let w = -1;
    let wd = tol;
    let s = 0;
    for (let i = 0; i < n; i++) {
      while (s < ix.length - 1 && i >= ix[s + 1]) s++;
      if (i === ix[s]) continue;
      let d = Infinity;
      for (let t = s - 1; t <= s + 1; t++) {
        const sp = loop ? (t + spans) % spans : t;
        if (sp < 0 || sp >= spans) continue;
        for (let k = sp * PER + 1; k <= (sp + 1) * PER; k++) d = Math.min(d, segDist(run[i], curve[k - 1], curve[k]));
      }
      if (d > wd) (wd = d), (w = i);
    }
    return [w, wd];
  };
  for (let guard = 0; guard < n; guard++) {
    const [w] = worst(idx);
    if (w < 0) break;
    idx.push(w);
    idx.sort((x, y) => x - y);
  }
  // Then drop every point the curve can do without (adding the worst point
  // first crowds them where the stroke bends).
  const keep = loop ? 3 : 2;
  for (let j = loop ? 0 : 1; j < idx.length - (loop ? 0 : 1) && idx.length > keep; ) {
    const without = idx.filter((_, m) => m !== j);
    if (worst(without)[0] < 0) idx.splice(j, 1);
    else j++;
  }
  return idx.map((i) => run[i]);
}

/**
 * The stroke's points (in sketch units, as the pointer went), the tolerance
 * (how far the result may stray, a couple of screen pixels in sketch units)
 * and how near its end must come back to its start to close it.
 */
export function simplifyStroke(raw: Vec2[], tol: number, closeTol = tol * 6): Freehand {
  const none: Freehand = { pieces: [], closed: false };
  // Drop the repeats (a pointer held still reports the same spot).
  const pts: Vec2[] = [];
  for (const p of raw) if (!pts.length || dist(p, pts[pts.length - 1]) > tol * 0.25) pts.push(p);
  if (pts.length < 2) return none;
  const L = length(pts);
  if (L < tol * 4) return none;
  // Back near the start (a hand overshoots it a little: the spot nearest it,
  // in the last part of the stroke, is where the loop closes).
  let closed = false;
  if (pts.length >= 6 && L > closeTol * 4) {
    let j = -1;
    let jd = closeTol;
    let along = 0;
    for (let i = 1; i < pts.length; i++) {
      along += dist(pts[i - 1], pts[i]);
      if (along < L * 0.6) continue;
      const d = dist(pts[i], pts[0]);
      if (d <= jd) (jd = d), (j = i);
    }
    if (j > 0) {
      closed = true;
      pts.length = j + 1;
    }
  }
  // Evenly spaced and lightly smoothed: corners and fits don't depend on how fast it was drawn.
  const step = Math.max(tol, L / 2000);
  let p = resample(pts, step);
  if (closed) {
    // A loop: the gap closed, the last point (= the first) dropped.
    p = resample([...pts, pts[0]], step);
    p.pop();
    if (p.length < 6) return none;
  }
  p = smooth(p, closed);
  const k = Math.max(2, Math.round((tol * 5) / step));
  const cut = corners(p, closed, k, (50 * Math.PI) / 180);

  if (closed && !cut.length) {
    const c = fitCircle(p);
    if (c && p.every((q) => Math.abs(dist(q, c.c) - c.r) <= Math.max(tol * 2, c.r * 0.06))) {
      return { pieces: [{ kind: "circle", center: c.c, radius: c.r }], closed: true };
    }
    return { pieces: [{ kind: "spline", points: fitSpline(p, true, tol), closed: true }], closed: true };
  }

  const runs: Vec2[][] = [];
  if (closed) {
    const n = p.length;
    for (let j = 0; j < cut.length; j++) {
      const s = cut[j];
      const e = cut[(j + 1) % cut.length];
      const run: Vec2[] = [];
      for (let i = s; ; i = (i + 1) % n) {
        run.push(p[i]);
        if (i === e && run.length > 1) break;
      }
      runs.push(run);
    }
  } else {
    const at = [0, ...cut, p.length - 1];
    for (let j = 1; j < at.length; j++) runs.push(p.slice(at[j - 1], at[j] + 1));
  }
  const pieces = runs.filter((r) => r.length >= 2 && length(r) > tol).map((r) => fitRun(r, tol));
  // Each piece starts where the one before it ends (exactly: they are joined).
  for (let i = 1; i < pieces.length; i++) setStart(pieces[i], endOf(pieces[i - 1]));
  if (closed && pieces.length > 1) setStart(pieces[0], endOf(pieces[pieces.length - 1]));
  // (One piece around a loop with one corner, a teardrop: its ends meet.)
  if (closed && pieces.length === 1) setStart(pieces[0], endOf(pieces[0]));
  return { pieces, closed: closed && pieces.length > 0 };
}

export function startOf(e: FreehandPiece): Vec2 {
  return e.kind === "spline" ? e.points[0] : e.kind === "circle" ? e.center : e.a;
}
export function endOf(e: FreehandPiece): Vec2 {
  return e.kind === "spline" ? e.points[e.points.length - 1] : e.kind === "circle" ? e.center : e.b;
}
function setStart(e: FreehandPiece, at: Vec2): void {
  if (e.kind === "spline") e.points[0] = at;
  else if (e.kind !== "circle") e.a = at;
}
