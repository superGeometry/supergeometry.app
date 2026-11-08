// Where each variable acts on the model, for its tag in the view (pure logic).
//
// A variable is used by a sketch dimension, a step's value (an extrude's
// distance, a turn's angle…) or another variable. Each use gets a spot: on
// the dimension, at the top of the extrusion, at the turn's pivot. The spot
// then follows the moves and turns made later to the body it's on, so a tag
// sits on the arm where the arm is now, not where it was sketched.

import { add, scale, toWorld } from "../geom";
import { applyAffine, stepAffine } from "./freeformCopies";
import { kindOfPath } from "./params";
import type { Feature, PlaneDef, SketchConstraint, SketchEntity, Variable, Vec2, Vec3 } from "./types";

export type VarKind = "length" | "angle" | "number";

export interface VarUse {
  /** The step (or sketch) that uses it. */
  feature: string;
  /** What in it: a value's path, or a sketch dimension's id. */
  where: string;
  kind: VarKind;
}

/** The kernel's answer, as far as tags need it. */
export interface AnchorWorld {
  sketchPlanes: Record<string, PlaneDef>;
  bodies: { id: string; positions: ArrayLike<number> }[];
  planes?: { id: string; plane: PlaneDef }[];
}

const UNIT_WORDS = new Set(["mm", "cm", "m", "in", "ft"]);

/** The variable names in an expression ("2*kR + 3 mm" → kR). */
export function namesIn(expr: string): string[] {
  const out: string[] = [];
  for (const m of expr.matchAll(/[a-z_][a-z0-9_]*/gi)) {
    // A unit after a number ("3 mm", "3mm") is no name.
    const before = expr.slice(0, m.index).trimEnd();
    if (UNIT_WORDS.has(m[0].toLowerCase()) && /[\d.)]$/.test(before)) continue;
    if (!out.includes(m[0])) out.push(m[0]);
  }
  return out;
}

/** Every use of every variable (steps and sketch dimensions; not other variables). */
export function usesOf(features: readonly Feature[]): Map<string, VarUse[]> {
  const out = new Map<string, VarUse[]>();
  const add1 = (name: string, u: VarUse) => {
    const l = out.get(name) ?? [];
    l.push(u);
    out.set(name, l);
  };
  for (const f of features) {
    if (f.suppressed) continue;
    for (const [path, expr] of Object.entries(f.exprs ?? {})) for (const n of namesIn(expr)) add1(n, { feature: f.id, where: path, kind: kindOfPath(path) });
    if (f.type === "sketch")
      for (const c of f.constraints ?? []) if (c.expr) for (const n of namesIn(c.expr)) add1(n, { feature: f.id, where: c.id, kind: c.prop === "angle" ? "angle" : "length" });
  }
  return out;
}

/**
 * Length, angle or plain number: its unit ("40 mm"), else how it's used,
 * else what it's made from (p1 = baseH + post is a length).
 */
export function kindOfVariable(name: string, variables: readonly Variable[], uses: Map<string, VarUse[]>, seen = new Set<string>()): VarKind {
  // Its own unit first ("55 mm" is a length, even used in a ratio).
  const v = variables.find((x) => x.name === name);
  if (v && /\d\s*(mm|cm|m|in|ft|"|')(?![a-z])/i.test(v.expr)) return "length";
  if (v && /°/.test(v.expr)) return "angle";
  const u = uses.get(name);
  if (u?.length) {
    const kinds = new Set(u.map((x) => x.kind));
    return kinds.has("angle") && kinds.size === 1 ? "angle" : kinds.has("length") ? "length" : [...kinds][0];
  }
  if (!v) return "number";
  seen.add(name);
  for (const n of namesIn(v.expr)) if (!seen.has(n)) {
    const k = kindOfVariable(n, variables, uses, seen);
    if (k !== "number") return k;
  }
  return "number";
}

/** The variables a variable is made from (directly). */
export function madeFrom(name: string, variables: readonly Variable[]): string[] {
  const v = variables.find((x) => x.name === name);
  return v ? namesIn(v.expr).filter((n) => variables.some((x) => x.name === n)) : [];
}

/** A sketch dimension's spot, in the sketch (like its label's). */
function dimSpot(c: SketchConstraint, entities: readonly SketchEntity[]): Vec2 | null {
  const e = entities.find((x) => x.id === c.curves?.[0]);
  if (!e) return null;
  const turn = (center: Vec2, rot: number, off: Vec2): Vec2 => [center[0] + off[0] * Math.cos(rot) - off[1] * Math.sin(rot), center[1] + off[0] * Math.sin(rot) + off[1] * Math.cos(rot)];
  switch (e.kind) {
    case "line":
      return [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2];
    case "circle":
    case "polygon":
      return [e.center[0] + e.radius * Math.SQRT1_2, e.center[1] + e.radius * Math.SQRT1_2];
    case "rect":
      return turn(e.center, e.rotation, c.prop === "w" ? [0, -e.h / 2] : c.prop === "h" ? [e.w / 2, 0] : [0, 0]);
    case "ellipse":
      return turn(e.center, e.rotation, c.prop === "ry" ? [0, e.ry] : [e.rx, 0]);
    case "arc":
      return e.m;
    default:
      return "points" in e ? (e.points[0] ?? null) : null;
  }
}

/** A string body id a step works on, if it has one. */
function bodyOf(f: Feature): string | null {
  const x = f as unknown as Record<string, unknown>;
  if (typeof x.target === "string") return x.target;
  if (typeof x.body === "string") return x.body;
  if (Array.isArray(x.bodies) && typeof x.bodies[0] === "string") return x.bodies[0];
  const ref = (Array.isArray(x.edges) ? x.edges[0] : x.face) as { body?: string } | undefined;
  return ref?.body ?? null;
}

/** The middle of a body as it is now (its box). */
function bodyMiddle(world: AnchorWorld, id: string): Vec3 | null {
  const b = world.bodies.find((x) => x.id === id);
  if (!b || b.positions.length < 3) return null;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < b.positions.length; i += 3)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], b.positions[i + k]);
      hi[k] = Math.max(hi[k], b.positions[i + k]);
    }
  return [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2) as Vec3;
}

/**
 * A spot carried through the steps after `from` that move the body it's on:
 * moves, turns and mirrors (not copies); joined into another body, it goes
 * with that one from then on.
 */
function carried(p: Vec3, body: string | null, features: readonly Feature[], from: number): Vec3 {
  if (!body) return p;
  const on = new Set([body]);
  let q = p;
  for (let i = from + 1; i < features.length; i++) {
    const g = features[i];
    if (g.suppressed) continue;
    if (g.type === "transform" && !g.copy && g.bodies.some((b) => on.has(b))) {
      const m = stepAffine(g.op);
      if (m) q = applyAffine(m, q);
    } else if (g.type === "boolean" && g.tools.some((t) => on.has(t))) on.add(g.target);
  }
  return q;
}

/** Where one use is in the view now (null: nowhere to show it). */
export function useSpot(u: VarUse, features: readonly Feature[], world: AnchorWorld): Vec3 | null {
  const i = features.findIndex((f) => f.id === u.feature);
  const f = features[i];
  if (!f) return null;
  if (f.type === "sketch") {
    const c = f.constraints?.find((x) => x.id === u.where);
    const at = c && dimSpot(c, f.entities);
    if (!at) return null;
    const p = toWorld(world.sketchPlanes[f.id] ?? f.plane, at);
    // A construction line is no part of a body: it stays where it was drawn
    // (the post's height, up the post - not swung out with the arm).
    if (f.entities.find((e) => e.id === c.curves?.[0])?.construction) return p;
    // On the body made from this sketch (the first step that uses it), and with it from then on.
    const j = features.findIndex((g) => "source" in g && (g.source as { sketch?: string }).sketch === f.id);
    if (j < 0) return p;
    const g = features[j];
    return carried(p, bodyOf(g) ?? g.id, features, j);
  }
  if (f.type === "extrude") {
    const src = f.source;
    let base: Vec3 | null = null;
    let n: Vec3 | null = null;
    if (src.kind === "profile") {
      const pl = world.sketchPlanes[src.sketch] ?? (features.find((g) => g.id === src.sketch) as { plane?: PlaneDef } | undefined)?.plane;
      const r = src.regions[0];
      if (pl && r) [base, n] = [toWorld(pl, r.c), pl.normal];
    } else [base, n] = [src.face.center, src.face.normal];
    if (!base || !n) return null;
    // At the far end (where the arrow is): that's what distance and taper size.
    return carried(add(base, scale(n, f.distance)), f.target ?? f.id, features, i);
  }
  if (f.type === "transform" && f.op.kind === "move" && f.op.rotate) {
    // A turn: at its pivot (it turns about it, so the turn itself doesn't move it).
    return carried(f.op.rotate.origin, f.bodies[0] ?? null, features, i);
  }
  const plane = world.planes?.find((x) => x.id === f.id);
  if (plane) return plane.plane.origin;
  const b = bodyOf(f);
  return b ? bodyMiddle(world, b) : null;
}

export interface VarTag {
  name: string;
  kind: VarKind;
  /** Where its tag goes (its first use that has a spot), null: not on the model. */
  at: Vec3 | null;
  /** Its other uses' spots. */
  others: Vec3[];
  /** The variables it's made from. */
  from: string[];
}

/** One tag per variable. */
export function variableTags(variables: readonly Variable[], features: readonly Feature[], world: AnchorWorld): VarTag[] {
  const uses = usesOf(features);
  return variables.map((v) => {
    // Its tag at the use that says most where it acts: a turn's pivot, then a
    // step's value, then a dimension of the shape, then a construction line.
    const rank = (u: VarUse) => {
      const f = features.find((g) => g.id === u.feature);
      if (f?.type === "transform") return 0;
      if (f?.type !== "sketch") return 1;
      const c = f.constraints?.find((x) => x.id === u.where);
      return f.entities.find((e) => e.id === c?.curves?.[0])?.construction ? 3 : 2;
    };
    const ordered = [...(uses.get(v.name) ?? [])].sort((a, b) => rank(a) - rank(b));
    const spots = ordered.map((u) => useSpot(u, features, world)).filter((p): p is Vec3 => !!p && p.every(Number.isFinite));
    return { name: v.name, kind: kindOfVariable(v.name, variables, uses), at: spots[0] ?? null, others: spots.slice(1), from: madeFrom(v.name, variables) };
  });
}
