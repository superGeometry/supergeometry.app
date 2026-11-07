// Sketch constraint solver: every entity is a short parameter vector; each
// constraint is one or more residuals; Levenberg–Marquardt drives them to zero
// while a weak pull towards the current shape keeps under-constrained sketches
// from wandering (so the result is the smallest change that satisfies them).

import type { ConstraintType, PointRef, SketchConstraint, SketchEntity, Vec2 } from "../doc/types";
import { arcFrom3, entityCorners } from "./curves";

// ------------------------------------------------------------- parameters

/**
 * Entity → flat parameter list (and back). Arcs are solved as centre, radius,
 * start angle and sweep: three points on a circle have a spare direction (the
 * middle one sliding along it) that slows the solver down, and can turn the
 * arc inside out; with angles it keeps its way round.
 */
function params(e: SketchEntity): number[] {
  switch (e.kind) {
    case "line":
      return [...e.a, ...e.b];
    case "arc": {
      const c = arcFrom3(e.a, e.m, e.b);
      return c ? [c.c[0], c.c[1], c.r, c.a0, c.sweep] : [...e.a, ...e.m, ...e.b];
    }
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

/** Length per unit of each parameter (1 for coordinates, the radius for angles). */
function pullScale(e: SketchEntity, p: number[]): number[] {
  const r = (v: number) => Math.max(Math.abs(v), 1e-9);
  switch (e.kind) {
    case "arc":
      return p.length === 5 ? [1, 1, 1, r(p[2]), r(p[2])] : p.map(() => 1);
    case "ellipse":
      return [1, 1, 1, 1, r(Math.max(e.rx, e.ry))];
    case "rect":
      return [1, 1, 1, 1, r(Math.hypot(e.w, e.h) / 2)];
    case "polygon":
      return [1, 1, 1, r(e.radius)];
    default:
      return p.map(() => 1);
  }
}

function withParams(e: SketchEntity, x: number[]): SketchEntity {
  switch (e.kind) {
    case "line":
      return { ...e, a: [x[0], x[1]], b: [x[2], x[3]] };
    case "arc": {
      if (x.length === 6) return { ...e, a: [x[0], x[1]], m: [x[2], x[3]], b: [x[4], x[5]] };
      const [cx, cy, r, a0, sw] = x;
      const at = (t: number): Vec2 => [cx + r * Math.cos(t), cy + r * Math.sin(t)];
      return { ...e, a: at(a0), m: at(a0 + sw / 2), b: at(a0 + sw) };
    }
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
  /** Time it may take (ms); past it, what it has is the answer (and likely not met). */
  budget?: number;
}

export interface SolveResult {
  entities: SketchEntity[];
  /** Largest remaining residual (≈0 when every constraint is met). */
  error: number;
  ok: boolean;
}

/**
 * Solve constraints; returns updated entities (unchanged ones are kept).
 * Groups of curves that no constraint links are solved apart (a sketch of
 * twenty rectangles is twenty small problems, not one big one), and a group
 * whose constraints are already met, with nothing dragged in it, isn't touched.
 */
export function solve(entities: SketchEntity[], constraints: SketchConstraint[], opts: SolveOptions = {}): SolveResult {
  const ids = new Set(entities.map((e) => e.id));
  const live = constraints.filter((c) => refsOf(c).every((id) => ids.has(id)));
  const drags = opts.drag ?? [];
  if (!live.length && !drags.length) return { entities, error: 0, ok: true };
  // Union–find over curves linked by a constraint (fixed curves don't link: they don't move).
  const parent = new Map<string, string>();
  const find = (a: string): string => {
    let r = a;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
    parent.set(a, r);
    return r;
  };
  const join = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  const moving = (id: string) => !opts.fixed?.has(id);
  for (const c of live) {
    const r = refsOf(c).filter(moving);
    for (const id of r) find(id);
    for (let i = 1; i < r.length; i++) join(r[0], r[i]);
  }
  for (const d of drags) if (moving(d.ref.e)) find(d.ref.e);
  const groups = new Map<string, { cs: SketchConstraint[]; drag: typeof drags }>();
  const groupOf = (root: string) => {
    let g = groups.get(root);
    if (!g) groups.set(root, (g = { cs: [], drag: [] }));
    return g;
  };
  // Constraints on nothing that may move: either already met, or they can't be.
  const stuck: SketchConstraint[] = [];
  for (const c of live) {
    const r = refsOf(c).filter(moving);
    if (r.length) groupOf(find(r[0])).cs.push(c);
    else stuck.push(c);
  }
  for (const d of drags) if (moving(d.ref.e)) groupOf(find(d.ref.e)).drag.push(d);
  if (groups.size <= 1 && !stuck.length) return solveGroup(entities, live, opts);
  const byId = new Map(entities.map((e) => [e.id, e]));
  let error = constraintError(entities, stuck);
  let ok = error < 1e-9 * Math.max(1, ...entities.flatMap((e) => pointsOf(e).map((p) => Math.max(Math.abs(p.at[0]), Math.abs(p.at[1])))));
  for (const g of groups.values()) {
    if (!g.drag.length && constraintError(entities, g.cs) < 1e-12) continue;
    const need = new Set<string>([...g.cs.flatMap(refsOf), ...g.drag.map((d) => d.ref.e)]);
    const r = solveGroup(entities.filter((e) => need.has(e.id)), g.cs, { ...opts, drag: g.drag });
    for (const e of r.entities) byId.set(e.id, e);
    error = Math.max(error, r.error);
    ok &&= r.ok;
  }
  return { entities: entities.map((e) => byId.get(e.id) ?? e), error, ok };
}

function solveGroup(entities: SketchEntity[], live: SketchConstraint[], opts: SolveOptions): SolveResult {
  if (!live.length && !opts.drag?.length) return { entities, error: 0, ok: true };
  // Only entities that take part move; everything else is left as is.
  const involved = new Set<string>(live.flatMap(refsOf));
  for (const d of opts.drag ?? []) involved.add(d.ref.e);
  for (const id of opts.fixed ?? []) involved.delete(id);
  const movers = entities.filter((e) => involved.has(e.id));
  const offsets: number[] = [];
  const counts: number[] = [];
  // How much each parameter's change counts in the pull towards the start: in
  // lengths, so turning an arc by an angle costs what its ends travel (else
  // arcs would spin round freely instead of the sketch keeping its shape).
  const per: number[] = [];
  const x0: number[] = [];
  for (const e of movers) {
    const p = params(e);
    offsets.push(x0.length);
    counts.push(p.length);
    per.push(...pullScale(e, p));
    x0.push(...p);
  }
  const byId = new Map(entities.map((e) => [e.id, e]));
  const build = (x: number[]) => {
    const m = new Map(byId);
    movers.forEach((e, i) => m.set(e.id, withParams(e, x.slice(offsets[i], offsets[i] + counts[i]))));
    return m;
  };
  const scale = Math.max(1, ...x0.map(Math.abs));
  const drags = opts.drag ?? [];
  // Which constraints (and drags) each moving entity takes part in: nudging one
  // parameter only changes those rows, so the Jacobian is built from just them.
  const moverOf = new Map(movers.map((e, i) => [e.id, i]));
  const usedBy: number[][] = movers.map(() => []);
  live.forEach((c, ci) => {
    for (const id of new Set(refsOf(c))) {
      const i = moverOf.get(id);
      if (i !== undefined) usedBy[i].push(ci);
    }
  });
  const dragsOf: number[][] = movers.map(() => []);
  drags.forEach((d, di) => {
    const i = moverOf.get(d.ref.e);
    if (i !== undefined) dragsOf[i].push(di);
  });

  /** Residuals, laid out per constraint then per drag (rows found from the start). */
  const evalAll = (m: Map<string, SketchEntity>, withDrag: boolean) => {
    const get = (id: string) => m.get(id);
    const parts = live.map((c) => residuals(c, get));
    const dr = withDrag ? drags.map((d) => dragRes(m, d)) : [];
    return { parts, dr };
  };
  const dragRes = (m: Map<string, SketchEntity>, d: { ref: PointRef; to: Vec2 }) => {
    const e = m.get(d.ref.e);
    const p = e && pointOf(e, d.ref.p);
    // The drag target is "soft but strong": constraints still win where they conflict.
    return p ? [(p[0] - d.to[0]) * 0.3, (p[1] - d.to[1]) * 0.3] : [0, 0];
  };
  const errorAt = (x: number[]) => {
    let worst = 0;
    for (const r of evalAll(build(x), false).parts) for (const v of r) worst = Math.max(worst, Number.isFinite(v) ? Math.abs(v) : Infinity);
    return worst;
  };
  const start = evalAll(build(x0), true);
  // A drag frame must keep up with the finger; a typed value can take a moment.
  const deadline = performance.now() + (opts.budget ?? (drags.length ? 40 : 800));
  /** Fraction of the step dx that keeps every arc's change within about its size. */
  const stepLimit = (x: number[], dx: number[]) => {
    let f = 1;
    movers.forEach((e, i) => {
      const o = offsets[i];
      if (e.kind === "arc" && counts[i] === 5) {
        const r = Math.max(Math.abs(x[o + 2]), Math.abs(x0[o + 2]));
        const move = Math.max(Math.abs(dx[o]), Math.abs(dx[o + 1]), Math.abs(dx[o + 2]));
        if (move > 0.5 * r) f = Math.min(f, (0.5 * r) / move);
        const turn = Math.max(Math.abs(dx[o + 3]), Math.abs(dx[o + 4]));
        if (turn > 0.5) f = Math.min(f, 0.5 / turn);
      } else if (e.kind === "ellipse" || e.kind === "rect") {
        const turn = Math.abs(dx[o + 4]);
        if (turn > 0.5) f = Math.min(f, 0.5 / turn);
      } else if (e.kind === "polygon") {
        const turn = Math.abs(dx[o + 3]);
        if (turn > 0.5) f = Math.min(f, 0.5 / turn);
      }
    });
    return f;
  };
  const run = (t: number, from: number[]) => {
    let xs = from;
    // On the way (t < 1) near enough is fine; only the end must be exact.
    const it = t < 1 ? 25 : 40;
    if (drags.length) {
      // Pulled towards the pointer (smallest change elsewhere), then put exactly
      // back on the constraints: the target only says where to go, they always win.
      xs = lm(xs, 1e-3, true, t, Math.min(30, it));
      xs = lm(xs, 1e-8, false, t, it);
    } else {
      // A noticeable pull first (smallest change), then almost none (exact constraints).
      xs = lm(xs, 1e-3, false, t, Math.min(30, it));
      xs = lm(xs, 1e-8, false, t, it);
    }
    return xs;
  };
  const t0 = turnsOf(build(x0), live);
  /**
   * The change made in small steps (each from the last), smaller wherever one
   * would flip a corner or arc; one that flips even when tiny is a flip the
   * change really needs. Null if it doesn't get all the way.
   */
  const gradually = (dt0: number, most: number): number[] | null => {
    let xc = x0;
    let t = 0;
    let dt = dt0;
    let turns = t0;
    for (let runs = 0; t < 1 && runs < most && performance.now() < deadline; runs++) {
      const tn = Math.min(1, t + dt);
      const xn = run(tn, xc);
      const tu = turnsOf(build(xn), live);
      if (!sameTurns(turns, tu) && dt > 1 / 256) {
        dt /= 2;
        continue;
      }
      xc = xn;
      t = tn;
      turns = tu;
      dt = Math.min(dt0, dt * 2);
    }
    return t >= 1 ? xc : null;
  };
  const tol = 1e-6 * Math.max(1, scale);
  let xs = run(1, x0);
  // A change can land on a flipped solution (a corner folded the other way, an
  // arc turned inside out); made in small steps it keeps its shape: redo it so.
  // (Not while dragging: each frame goes on from the last, so a flip there is
  // the pointer's doing - and a frame must stay quick.)
  if (!drags.length && !sameTurns(t0, turnsOf(build(xs), live))) {
    const xg = gradually(1 / 16, 60);
    if (xg && errorAt(xg) <= Math.max(errorAt(xs), tol)) xs = xg;
  }
  const m = build(xs);
  const error = errorAt(xs);
  return { entities: entities.map((e) => m.get(e.id) ?? e), error, ok: error < 1e-6 * Math.max(1, scale) };

  /**
   * Levenberg–Marquardt from `from`. `t` < 1 asks for only that part of the
   * way (the rest of the starting residuals is left), for stepping gradually.
   */
  function lm(from: number[], weight: number, withDrag: boolean, t: number, maxIt: number): number[] {
    const keep = 1 - t;
    const flat = (ev: { parts: number[][]; dr: number[][] }) => {
      const out: number[] = [];
      ev.parts.forEach((r, ci) => {
        const s0 = start.parts[ci];
        for (let k = 0; k < r.length; k++) out.push(r[k] - (keep && s0.length === r.length ? s0[k] * keep : 0));
      });
      ev.dr.forEach((r, di) => {
        const s0 = start.dr[di];
        out.push(r[0] - s0[0] * keep, r[1] - s0[1] * keep);
      });
      return out;
    };
    const R = (x: number[]) => {
      const out = flat(evalAll(build(x), withDrag));
      // Weak pull towards the start: picks the smallest change for free directions.
      for (let i = 0; i < x.length; i++) out.push((x[i] - from[i]) * weight * per[i]);
      return out;
    };
    let x = from.slice();
    let m = build(x);
    let ev = evalAll(m, withDrag);
    let r = R(x);
    let cost = dot(r, r);
    let lambda = 1e-3;
    const n = x.length;
    let extra = 0;
    for (let it = 0; it < maxIt + extra && cost > 1e-24 && performance.now() < deadline; it++) {
      // Row where each constraint's / drag's residuals start.
      const rowC: number[] = [];
      let row = 0;
      for (const p of ev.parts) {
        rowC.push(row);
        row += p.length;
      }
      const rowD = ev.dr.map((_, di) => row + di * 2);
      const nRes = r.length;
      // Numeric Jacobian, column by column, from only the rows that parameter
      // touches - kept as the few non-zeros of each row.
      const rows: { j: number; v: number }[][] = Array.from({ length: nRes }, () => []);
      const get = (id: string) => m.get(id);
      for (let i = 0; i < movers.length; i++) {
        const id = movers[i].id;
        const was = m.get(id)!;
        const base = x.slice(offsets[i], offsets[i] + counts[i]);
        for (let k = 0; k < counts[i]; k++) {
          const j = offsets[i] + k;
          const h = 1e-6 * Math.max(1, Math.abs(x[j]), scale * 1e-3);
          const pert = base.slice();
          pert[k] += h;
          m.set(id, withParams(movers[i], pert));
          for (const ci of usedBy[i]) {
            const rp = residuals(live[ci], get);
            const r0 = ev.parts[ci];
            if (rp.length !== r0.length) continue;
            for (let q = 0; q < rp.length; q++) {
              const v = (rp[q] - r0[q]) / h;
              if (v !== 0) rows[rowC[ci] + q].push({ j, v });
            }
          }
          if (withDrag)
            for (const di of dragsOf[i]) {
              const rp = dragRes(m, drags[di]);
              const r0 = ev.dr[di];
              const v0 = (rp[0] - r0[0]) / h;
              const v1 = (rp[1] - r0[1]) / h;
              if (v0 !== 0) rows[rowD[di]].push({ j, v: v0 });
              if (v1 !== 0) rows[rowD[di] + 1].push({ j, v: v1 });
            }
          rows[nRes - n + j].push({ j, v: weight * per[j] });
        }
        m.set(id, was);
      }
      // (JᵀJ + λ diag) dx = -Jᵀ r, from those non-zeros (each residual depends
      // on a handful of parameters), not the whole matrix.
      const A: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
      const g = new Array(n).fill(0);
      for (let i = 0; i < nRes; i++) {
        const row = rows[i];
        const ri = r[i];
        for (let p = 0; p < row.length; p++) {
          const { j: a, v: va } = row[p];
          g[a] -= va * ri;
          const Aa = A[a];
          for (let q = p; q < row.length; q++) Aa[row[q].j] += va * row[q].v;
        }
      }
      for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) A[b][a] = A[a][b];
      let improved = false;
      let gain = 0;
      for (let tries = 0; tries < 8; tries++) {
        const diag = A.map((rowA, i) => rowA[i] * (1 + lambda) + 1e-12);
        let dx = solveSPD(A, diag, g);
        if (!dx) {
          const M = A.map((rowA, i) => rowA.map((v, j) => (i === j ? diag[i] : v)));
          dx = solveLinear(M, g);
        }
        if (!dx) {
          lambda *= 10;
          continue;
        }
        // Curved things are only near-linear within about their own size: a
        // longer step would land somewhere arbitrary (folded, inside out).
        const f = stepLimit(x, dx);
        if (f < 1) {
          for (let i = 0; i < n; i++) dx[i] *= f;
          if (tries === 0) extra = Math.min(extra + 1, 160);
        }
        const xn = x.map((v, i) => v + dx[i]);
        const rn = R(xn);
        const cn = dot(rn, rn);
        if (cn < cost) {
          gain = (cost - cn) / cost;
          x = xn;
          r = rn;
          cost = cn;
          m = build(x);
          ev = evalAll(m, withDrag);
          lambda = Math.max(1e-9, lambda / 3);
          improved = true;
          break;
        }
        lambda *= 10;
      }
      // Done: nothing left to gain.
      if (!improved || gain < 1e-10) break;
    }
    return x;
  }
}

/** Which way each joined corner of two lines turns, and each arc: a flip changes a sign. */
function turnsOf(m: Map<string, SketchEntity>, cs: SketchConstraint[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of m.values()) {
    if (e.kind !== "arc") continue;
    const a = arcFrom3(e.a, e.m, e.b);
    if (a) out.set(e.id, Math.sign(a.sweep));
  }
  // Corners: two lines joined end to end (by a coincident constraint). Legs
  // that are next to nothing don't count - they can tip either way.
  let size = 0;
  for (const e of m.values()) if (e.kind === "line") size = Math.max(size, Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]));
  for (const c of cs) {
    if (c.type !== "coincident" || c.pts?.length !== 2) continue;
    const [p, q] = c.pts;
    const l1 = m.get(p.e);
    const l2 = m.get(q.e);
    if (l1?.kind !== "line" || l2?.kind !== "line" || l1 === l2 || (p.p !== "a" && p.p !== "b") || (q.p !== "a" && q.p !== "b")) continue;
    const o = p.p === "a" ? l1.a : l1.b;
    const u = p.p === "a" ? l1.b : l1.a;
    const v = q.p === "a" ? l2.b : l2.a;
    const lu = Math.hypot(u[0] - o[0], u[1] - o[1]);
    const lv = Math.hypot(v[0] - o[0], v[1] - o[1]);
    if (lu < size * 1e-4 || lv < size * 1e-4) continue;
    const cr = (u[0] - o[0]) * (v[1] - o[1]) - (u[1] - o[1]) * (v[0] - o[0]);
    // Straight-through or folded flat: no clear side.
    if (Math.abs(cr) > lu * lv * 0.02) out.set(c.id, Math.sign(cr));
  }
  return out;
}

function sameTurns(a: Map<string, number>, b: Map<string, number>): boolean {
  for (const [k, v] of a) {
    const w = b.get(k);
    if (w !== undefined && w !== v) return false;
  }
  return true;
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

/**
 * Cholesky for the symmetric positive definite normal equations, keeping to
 * each row's envelope (from its first non-zero): sketch parameters link mostly
 * to their neighbours, so this is far less work than full elimination.
 * Null if the matrix turns out not positive definite.
 */
function solveSPD(A: number[][], diag: number[], b: number[]): number[] | null {
  // A holds the upper triangle (A[j][i], j ≤ i); diag replaces its diagonal.
  const n = b.length;
  const first = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let f = i;
    for (let j = 0; j < i; j++)
      if (A[j][i] !== 0) {
        f = j;
        break;
      }
    first[i] = f;
  }
  const L: Float64Array[] = A.map(() => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    const Li = L[i];
    for (let j = first[i]; j <= i; j++) {
      const Lj = L[j];
      let sum = j === i ? diag[i] : A[j][i];
      for (let k = Math.max(first[i], first[j]); k < j; k++) sum -= Li[k] * Lj[k];
      if (j === i) {
        if (!(sum > 0)) return null;
        Li[i] = Math.sqrt(sum);
      } else Li[j] = sum / Lj[j];
    }
  }
  // L y = b, then Lᵀ x = y.
  const y = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let sum = b[i];
    for (let k = first[i]; k < i; k++) sum -= L[i][k] * y[k];
    y[i] = sum / L[i][i];
  }
  const x = y.slice();
  for (let i = n - 1; i >= 0; i--) {
    x[i] /= L[i][i];
    const xi = x[i];
    for (let k = first[i]; k < i; k++) x[k] -= L[i][k] * xi;
  }
  return x.every(Number.isFinite) ? x : null;
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

/**
 * Add constraints strictly: they go in only if everything still works out
 * together. A new constraint that contradicts existing ones is refused
 * (nothing already there is taken away).
 */
export function addStrict(
  entities: SketchEntity[],
  existing: SketchConstraint[],
  added: SketchConstraint[],
  opts: SolveOptions = {},
): { ok: boolean; constraints: SketchConstraint[]; result: SolveResult } {
  const all = [...existing, ...added];
  const r = solveFine(entities, all, opts);
  return r.ok ? { ok: true, constraints: all, result: r } : { ok: false, constraints: existing, result: r };
}

function curveSize(e: SketchEntity): number {
  switch (e.kind) {
    case "line":
      return Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]);
    case "circle":
    case "polygon":
      return e.radius;
    case "arc": {
      // Its length: a nearly full arc has almost no chord but is no crumb; one
      // that sweeps next to nothing is.
      const c = arcFrom3(e.a, e.m, e.b);
      return c ? c.r * Math.abs(c.sweep) : 0;
    }
    case "rect":
      return Math.min(e.w, e.h);
    case "ellipse":
      return Math.min(e.rx, e.ry);
    default:
      return 1;
  }
}

/**
 * Solve, and only call it met if no curve had to shrink to nothing for it
 * (a line of zero length "is" horizontal and vertical at once - that's not a sketch).
 */
export function solveFine(entities: SketchEntity[], constraints: SketchConstraint[], opts: SolveOptions = {}): SolveResult {
  const r = solve(entities, constraints, opts);
  // Against the sketch's size before and after (a curve made huge can crush another).
  const extent = (e: SketchEntity) => (e.kind === "rect" ? Math.max(e.w, e.h) : e.kind === "ellipse" ? Math.max(e.rx, e.ry) : curveSize(e));
  const scale = Math.max(1e-9, ...entities.map(extent), ...r.entities.map(extent));
  // One that was already tiny may stay so, but not shrink further towards nothing.
  const ok = r.ok && r.entities.every((e, i) => curveSize(e) > scale * 1e-6 || curveSize(e) >= curveSize(entities[i]) * 0.99);
  return { ...r, ok };
}

/** A dimension's new value, strictly: refused (null) if the sketch can't take it. */
export function setValueStrict(entities: SketchEntity[], constraints: SketchConstraint[], id: string, value: number, expr?: string): { constraints: SketchConstraint[]; result: SolveResult } | null {
  const c = constraints.find((x) => x.id === id);
  if (!c) return null;
  const next = { ...c, value, expr };
  const r = addStrict(entities, constraints.filter((x) => x !== c), [next]);
  if (!r.ok) return null;
  // Keep the constraint where it was in the list.
  return { constraints: constraints.map((x) => (x === c ? next : x)), result: r.result };
}

/**
 * Add constraints without being strict about it: if the new ones contradict
 * existing ones, the existing ones they clash with give way (newest first,
 * as few as possible). Ones that agree stay alongside.
 */
export function addResolving(
  entities: SketchEntity[],
  existing: SketchConstraint[],
  added: SketchConstraint[],
  opts: SolveOptions = {},
): { constraints: SketchConstraint[]; removed: SketchConstraint[]; result: SolveResult } {
  const all = [...existing, ...added];
  const solveOk = (cs: SketchConstraint[]) => solveFine(entities, cs, opts);
  const first = solveOk(all);
  if (first.ok) return { constraints: all, removed: [], result: first };
  // Only ones touching what the new constraint touches can be in its way.
  const refs = new Set(added.flatMap(refsOf));
  const near = existing.filter((c) => refsOf(c).some((r) => refs.has(r))).reverse();
  // One is usually enough: try each alone first.
  for (const c of near) {
    const rest = all.filter((x) => x !== c);
    const r = solveOk(rest);
    if (r.ok) return { constraints: rest, removed: [c], result: r };
  }
  // Else take them away one by one until it works out.
  const removed: SketchConstraint[] = [];
  let rest = all;
  for (const c of near) {
    rest = rest.filter((x) => x !== c);
    removed.push(c);
    const r = solveOk(rest);
    if (r.ok) return { constraints: rest, removed, result: r };
  }
  return { constraints: all, removed: [], result: first };
}

/** Largest residual of the constraints on these entities as they are (0 = all met). */
export function constraintError(entities: SketchEntity[], constraints: SketchConstraint[]): number {
  const m = new Map(entities.map((e) => [e.id, e]));
  const get = (id: string) => m.get(id);
  let worst = 0;
  for (const c of constraints) for (const v of residuals(c, get)) worst = Math.max(worst, Number.isFinite(v) ? Math.abs(v) : Infinity);
  return worst;
}

/**
 * One frame of a drag: carry on from the last good frame (small steps solve
 * fast and keep the shape's way round). Where the constraints can't follow the
 * pointer all the way, it goes as far towards it as they allow.
 */
export function followDrag(
  prev: SketchEntity[],
  constraints: SketchConstraint[],
  drag: { ref: PointRef; to: Vec2 }[],
  prevTo: Vec2[] | null,
): { entities: SketchEntity[]; to: Vec2[]; ok: boolean } {
  const r = solveFine(prev, constraints, { drag, budget: 30 });
  if (r.ok || !prevTo) return { entities: r.ok ? r.entities : prev, to: drag.map((d) => d.to), ok: r.ok };
  // Halfway, and halfway again: the furthest point it can still reach.
  let lo = 0;
  let hi = 1;
  let best: SketchEntity[] = prev;
  let bestTo = prevTo;
  for (let i = 0; i < 3; i++) {
    const t = (lo + hi) / 2;
    const to = drag.map((d, k) => [prevTo[k][0] + (d.to[0] - prevTo[k][0]) * t, prevTo[k][1] + (d.to[1] - prevTo[k][1]) * t] as Vec2);
    const q = solveFine(prev, constraints, { drag: drag.map((d, k) => ({ ref: d.ref, to: to[k] })), budget: 8 });
    if (q.ok) {
      lo = t;
      best = q.entities;
      bestTo = to;
    } else hi = t;
  }
  return { entities: best, to: bestTo, ok: lo > 0 };
}
