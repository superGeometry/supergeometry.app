// Where the marks of a sketch's constraints go on the drawing (pure: the curves and the constraints in, the marks
// out - the view puts them on screen: tools/sketchConstraints.ts).
//
// A small mark for each constraint, on every curve or point it ties; a dimension as a dimension. One mark of a kind
// at a place: constraints of one kind that meet at one spot share it.

import type { SketchConstraint, SketchEntity, Vec2 } from "../doc/types";
import { pointOf } from "./constraints";
import { arcFrom3 } from "./curves";

/** How a dimension is drawn: between two points (its line set off to one side), on a round, or between two ways. */
export type DimShape =
  | { kind: "span"; a: Vec2; b: Vec2; out: Vec2 }
  | { kind: "round"; c: Vec2; rim: Vec2; across: boolean }
  | { kind: "angle"; v: Vec2; d1: Vec2; d2: Vec2 };

/** A mark, in the sketch's own space. */
export interface PlacedMark {
  /** Its chip: the constraint's id, and which of the things it ties this mark is on. */
  key: string;
  c: SketchConstraint;
  /** The other constraints of its kind at this place: the mark is theirs too. */
  also: SketchConstraint[];
  at: Vec2;
  dir: Vec2;
  dist: number;
  shape?: DimShape;
}

export function placeMarks(entities: SketchEntity[], constraints: SketchConstraint[]): PlacedMark[] {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const get = (id: string) => byId.get(id);
  const marks: PlacedMark[] = [];
  const mid = (e: SketchEntity): Vec2 | null => {
    if (e.kind === "line") return [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2];
    if (e.kind === "arc") return e.m;
    if (e.kind === "circle" || e.kind === "ellipse" || e.kind === "rect" || e.kind === "polygon") return e.center;
    return e.points[0] ?? null;
  };
  const inside = shapeCentres(entities);
  const norm = (v: Vec2): Vec2 | null => {
    const l = Math.hypot(v[0], v[1]);
    return l > 1e-9 ? [v[0] / l, v[1] / l] : null;
  };
  // Away from the middle of the shape it belongs to (off the blue fill of a closed one).
  const away = (e: SketchEntity, p: Vec2, fallback: Vec2): Vec2 => {
    const c = inside.get(e.id);
    const d = c && norm([p[0] - c[0], p[1] - c[1]]);
    return d ?? fallback;
  };
  /** A line's side that is away from its shape's middle (square off it). */
  const offLine = (e: SketchEntity & { kind: "line" }): Vec2 => {
    const n = norm([-(e.b[1] - e.a[1]), e.b[0] - e.a[0]]) ?? [0, 1];
    const at: Vec2 = [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2];
    const c0 = inside.get(e.id);
    return c0 && (at[0] - c0[0]) * n[0] + (at[1] - c0[1]) * n[1] < 0 ? [-n[0], -n[1]] : n;
  };
  /** Where a mark for a curve goes, and which way is out there. */
  const onCurve = (e: SketchEntity): { at: Vec2; dir: Vec2 } | null => {
    let at = mid(e);
    if (!at) return null;
    let dir: Vec2 = [Math.SQRT1_2, -Math.SQRT1_2];
    if (e.kind === "line") dir = offLine(e);
    else if (e.kind === "arc") {
      const ac = arcFrom3(e.a, e.m, e.b)?.c;
      dir = away(e, at, (ac && norm([e.m[0] - ac[0], e.m[1] - ac[1]])) ?? dir);
    } else if (e.kind === "circle" || e.kind === "polygon") {
      // Closed round shapes: on the rim at the top right, outside it.
      dir = [Math.SQRT1_2, Math.SQRT1_2];
      at = [e.center[0] + e.radius * dir[0], e.center[1] + e.radius * dir[1]];
    } else if (e.kind === "ellipse" || e.kind === "rect") {
      const [hx, hy] = e.kind === "ellipse" ? [e.rx * Math.SQRT1_2, e.ry * Math.SQRT1_2] : [e.w / 2, e.h / 2];
      const cs = Math.cos(e.rotation);
      const sn = Math.sin(e.rotation);
      at = [e.center[0] + hx * cs - hy * sn, e.center[1] + hx * sn + hy * cs];
      dir = norm([at[0] - e.center[0], at[1] - e.center[1]]) ?? dir;
    } else dir = away(e, at, dir);
    return { at, dir };
  };
  // Several marks at one spot are fanned out (further out) so they stay readable.
  const counts = new Map<string, number>();
  // One mark of a kind at a place: a corner where three lines meet is two "joined" constraints, a line equal to
  // two others two "equal" ones - each showed its own mark there, the same sign twice or three times over. The
  // one mark stands for them all (`also`).
  // ("At a place": as near as the solver brings two joined points together - a ten-thousandth of the drawing's
  // size. Joined ends a hair apart each had a dot, one on the other.)
  let [x0, x1, y0, y1] = [Infinity, -Infinity, Infinity, -Infinity];
  for (const e of entities) {
    const q = mid(e);
    if (!q) continue;
    x0 = Math.min(x0, q[0]);
    x1 = Math.max(x1, q[0]);
    y0 = Math.min(y0, q[1]);
    y1 = Math.max(y1, q[1]);
  }
  const near = Math.max(1e-3, (Number.isFinite(x1 - x0) ? Math.hypot(x1 - x0, y1 - y0) : 0) * 1e-4);
  const there: PlacedMark[] = [];
  const put = (c: SketchConstraint, key: string, at: Vec2, dir: Vec2, shape?: DimShape) => {
    const isDim = c.type === "dim" || c.type === "distance";
    const spot = `${at[0].toFixed(4)},${at[1].toFixed(4)}`;
    if (!isDim) {
      const same = there.find((m) => m.c.type === c.type && Math.hypot(m.at[0] - at[0], m.at[1] - at[1]) < near);
      if (same) {
        if (same.c !== c && !same.also.includes(c)) same.also.push(c);
        return;
      }
    }
    const k = shape ? `d${c.curves?.[0] ?? ""}${shape.kind}${at[0].toFixed(3)},${at[1].toFixed(3)}` : spot;
    const n = counts.get(k) ?? 0;
    counts.set(k, n + 1);
    const mark: PlacedMark = { key, c, also: [], at, dir, dist: isDim ? 22 + n * 22 : 14 + n * 18, shape };
    if (!isDim) there.push(mark);
    marks.push(mark);
  };
  for (const c of constraints) {
    // (A pattern's copies have no badge each: there'd be one on every copy.)
    if (c.type === "pattern" || c.type === "follow") continue;
    // A mark only while everything it ties together is still drawn.
    if (![...(c.pts ?? []).map((p) => p.e), ...(c.curves ?? [])].every((id) => get(id))) continue;
    if (c.type === "dim" || c.type === "distance") {
      const shape = dimShape(c, get, offLine);
      // Rounds about one middle (a ring's two circles): each leader its own way out, so their sizes don't sit
      // on each other.
      if (shape?.kind === "round" && get(c.curves![0])?.kind !== "arc") {
        const k = `o${shape.c[0].toFixed(4)},${shape.c[1].toFixed(4)}`;
        const turn = ((counts.get(k) ?? 0) * 55 * Math.PI) / 180;
        counts.set(k, (counts.get(k) ?? 0) + 1);
        const [x, y] = [shape.rim[0] - shape.c[0], shape.rim[1] - shape.c[1]];
        shape.rim = [shape.c[0] + x * Math.cos(turn) - y * Math.sin(turn), shape.c[1] + x * Math.sin(turn) + y * Math.cos(turn)];
      }
      if (shape) {
        put(c, c.id, shape.kind === "span" ? [(shape.a[0] + shape.b[0]) / 2, (shape.a[1] + shape.b[1]) / 2] : shape.kind === "round" ? shape.rim : shape.v, shape.kind === "span" ? shape.out : [Math.SQRT1_2, Math.SQRT1_2], shape);
        continue;
      }
      // (A size this has no drawing for - an ellipse's: its number by the shape, as before.)
      const e = c.curves?.[0] ? get(c.curves[0]) : c.pts?.[0] ? get(c.pts[0].e) : undefined;
      const spot = e && (c.pts?.length ? { at: pointOf(e, c.pts[0].p), dir: [Math.SQRT1_2, -Math.SQRT1_2] as Vec2 } : onCurve(e));
      if (spot?.at) put(c, c.id, spot.at, spot.dir);
      continue;
    }
    // A mark on every point and every curve it ties (two ends joined at one spot: one mark there).
    const spots: { at: Vec2; dir: Vec2 }[] = [];
    for (const p of c.pts ?? []) {
      const e = get(p.e);
      const at = e ? pointOf(e, p.p) : null;
      if (e && at && !spots.some((s) => Math.hypot(s.at[0] - at[0], s.at[1] - at[1]) < near)) spots.push({ at, dir: away(e, at, [Math.SQRT1_2, -Math.SQRT1_2]) });
    }
    for (const id of c.curves ?? []) {
      const spot = onCurve(get(id)!);
      if (spot && !spots.some((s) => Math.hypot(s.at[0] - spot.at[0], s.at[1] - spot.at[1]) < near)) spots.push(spot);
    }
    spots.forEach((s, k) => put(c, k ? `${c.id}#${k}` : c.id, s.at, s.dir));
  }
  return marks;
}

/** How a dimension is drawn, from what it measures; null for a size this has no drawing for. */
function dimShape(c: SketchConstraint, get: (id: string) => SketchEntity | undefined, offLine: (e: SketchEntity & { kind: "line" }) => Vec2): DimShape | null {
  const unit = (v: Vec2): Vec2 | null => {
    const l = Math.hypot(v[0], v[1]);
    return l > 1e-9 ? [v[0] / l, v[1] / l] : null;
  };
  const foot = (p: Vec2, a: Vec2, b: Vec2): Vec2 => {
    const t = ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / ((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2 || 1);
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  };
  if (c.type === "distance") {
    const pts = (c.pts ?? []).map((p) => {
      const e = get(p.e);
      return e ? pointOf(e, p.p) : null;
    });
    const l0 = c.curves?.[0] ? get(c.curves[0]) : undefined;
    const l1 = c.curves?.[1] ? get(c.curves[1]) : undefined;
    let a: Vec2 | null = null;
    let b: Vec2 | null = null;
    let along: Vec2 | null = null;
    if (pts.length === 1 && l0?.kind === "line") {
      // A point from a line: square across to the line, set off along it.
      a = pts[0];
      b = a && foot(a, l0.a, l0.b);
      along = unit([l0.b[0] - l0.a[0], l0.b[1] - l0.a[1]]);
    } else if (!pts.length && l0?.kind === "line" && l1?.kind === "line") {
      a = [(l1.a[0] + l1.b[0]) / 2, (l1.a[1] + l1.b[1]) / 2];
      b = foot(a, l0.a, l0.b);
      along = unit([l0.b[0] - l0.a[0], l0.b[1] - l0.a[1]]);
    } else if (pts.length === 2) {
      [a, b] = pts;
      const u = a && b && unit([b[0] - a[0], b[1] - a[1]]);
      along = u ? [-u[1], u[0]] : null;
    }
    return a && b && along ? { kind: "span", a, b, out: along } : null;
  }
  const e = c.curves?.[0] ? get(c.curves[0]) : undefined;
  if (!e || !c.prop) return null;
  if (c.prop === "length" && e.kind === "line") return { kind: "span", a: e.a, b: e.b, out: offLine(e) };
  if ((c.prop === "w" || c.prop === "h") && e.kind === "rect") {
    const cs = Math.cos(e.rotation);
    const sn = Math.sin(e.rotation);
    const at = (x: number, y: number): Vec2 => [e.center[0] + x * cs - y * sn, e.center[1] + x * sn + y * cs];
    // The width under the rectangle, the height to its right.
    return c.prop === "w" ? { kind: "span", a: at(-e.w / 2, -e.h / 2), b: at(e.w / 2, -e.h / 2), out: [sn, -cs] } : { kind: "span", a: at(e.w / 2, -e.h / 2), b: at(e.w / 2, e.h / 2), out: [cs, sn] };
  }
  if (c.prop === "radius" || c.prop === "diameter") {
    if (e.kind === "circle" || e.kind === "polygon") return { kind: "round", c: e.center, rim: [e.center[0] + e.radius * Math.SQRT1_2, e.center[1] + e.radius * Math.SQRT1_2], across: c.prop === "diameter" };
    if (e.kind === "arc") {
      const round = arcFrom3(e.a, e.m, e.b);
      // (An arc's: out through its own middle, where there is arc to point at.)
      return round ? { kind: "round", c: round.c, rim: e.m, across: false } : null;
    }
    return null;
  }
  if (c.prop === "angle" && e.kind === "line") {
    const d1 = unit([e.b[0] - e.a[0], e.b[1] - e.a[1]]);
    if (!d1) return null;
    const other = c.curves?.[1] ? get(c.curves[1]) : undefined;
    if (!other) return { kind: "angle", v: e.a, d1: [1, 0], d2: d1 };
    if (other.kind !== "line") return null;
    const d2 = unit([other.b[0] - other.a[0], other.b[1] - other.a[1]]);
    if (!d2) return null;
    // Where the two lines meet (run on, if they stop short); each way out from there along its line.
    const den = d1[0] * d2[1] - d1[1] * d2[0];
    if (Math.abs(den) < 1e-9) return null;
    const t = ((other.a[0] - e.a[0]) * d2[1] - (other.a[1] - e.a[1]) * d2[0]) / den;
    const v: Vec2 = [e.a[0] + d1[0] * t, e.a[1] + d1[1] * t];
    const far = (l: { a: Vec2; b: Vec2 }, d: Vec2): Vec2 => (Math.hypot(l.a[0] - v[0], l.a[1] - v[1]) > Math.hypot(l.b[0] - v[0], l.b[1] - v[1]) ? [-d[0], -d[1]] : d);
    return { kind: "angle", v, d1: far(e, d1), d2: far(other, d2) };
  }
  return null;
}

/**
 * The middle of the shape each curve belongs to: curves joined end to end
 * make one shape (a rectangle of four lines, a slot of lines and arcs); a
 * circle, ellipse, rectangle or polygon is its own. Marks go away from it.
 */
function shapeCentres(entities: SketchEntity[]): Map<string, Vec2> {
  const parent = entities.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const ends = (e: SketchEntity): Vec2[] => {
    if (e.kind === "line" || e.kind === "arc") return [e.a, e.b];
    if ((e.kind === "spline" || e.kind === "polyline") && !e.closed && e.points.length) return [e.points[0], e.points[e.points.length - 1]];
    return [];
  };
  // Ends at the same spot (joined): one shape. (Hashed, so big sketches stay quick.)
  const at = new Map<string, number>();
  entities.forEach((e, i) => {
    for (const p of ends(e)) {
      const k = `${p[0].toFixed(5)},${p[1].toFixed(5)}`;
      const j = at.get(k);
      if (j === undefined) at.set(k, i);
      else parent[find(i)] = find(j);
    }
  });
  const samples = (e: SketchEntity): Vec2[] => {
    if (e.kind === "line") return [e.a, e.b];
    if (e.kind === "arc") return [e.a, e.m, e.b];
    if (e.kind === "spline" || e.kind === "polyline") return e.points;
    return [e.center];
  };
  const sum = new Map<number, [number, number, number]>();
  entities.forEach((e, i) => {
    const r = find(i);
    const s = sum.get(r) ?? [0, 0, 0];
    for (const p of samples(e)) (s[0] += p[0]), (s[1] += p[1]), (s[2] += 1);
    sum.set(r, s);
  });
  const out = new Map<string, Vec2>();
  entities.forEach((e, i) => {
    const s = sum.get(find(i))!;
    if (s[2]) out.set(e.id, [s[0] / s[2], s[1] / s[2]]);
  });
  return out;
}
