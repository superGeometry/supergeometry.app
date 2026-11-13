// Which step made each face (and so each edge) of a body.
//
// A step built on a face or edge remembers it by where it is and how big it
// is; when an earlier step changes, the best match is taken. With nothing
// better to go on, "best" could be a face of another kind altogether: the
// screw bosses went onto the top of the box when the shell that made the
// floor they stood on was switched off, and a fillet round the bosses' feet
// rounded other edges once the bosses were gone - with no word.
//
// So every face is tagged with the step that made it: a face a step leaves
// as it was, or only trims (a side face cut shorter by a fillet, a wall with
// a hole cut through it), keeps its tag; a face it makes new gets the step's
// id. A reference then looks only among faces from the same step, and when
// there are none, says so instead of guessing.

import { getOC, type Face, type Shape3D } from "replicad";

interface Tagged {
  /** The step that made each face (in the order of shape.faces). */
  steps: string[];
  /** Each face's surface (plane, cylinder, …) as a key, for faces only trimmed. */
  keys: (string | null)[];
  /** Faces by hash, for faces a step left as they were. */
  byHash: Map<number, { face: Face; i: number }[]>;
  /**
   * The step a face used to be put down to, where that was another body's
   * (see tagBody) or a Move's (see movedTags): what projects saved before
   * then name it by.
   */
  alias?: (string | undefined)[];
  /**
   * Where each face is now, against where its step made it: the moves, turns
   * and mirrorings its body has been through since (a 3 x 4 matrix, row by
   * row; none: where it was made).
   */
  moves?: (Moved | undefined)[];
}

/** A 3 x 4 matrix, row by row: where a point is after a move. */
type Moved = number[];
/** First m, then n. */
function then(m: Moved, n: Moved): Moved {
  const out: number[] = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) out.push(n[r * 4] * m[c] + n[r * 4 + 1] * m[4 + c] + n[r * 4 + 2] * m[8 + c]);
    out.push(n[r * 4] * m[3] + n[r * 4 + 1] * m[7] + n[r * 4 + 2] * m[11] + n[r * 4 + 3]);
  }
  return out;
}

/** A point (or a direction a face looks) taken back to where it was before a move. */
export type Back = (v: [number, number, number], direction?: boolean) => [number, number, number];
function backOf(m: Moved): Back {
  const [a, b, c, d, e, f, g, h, i] = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  // The matrix turned back (its inverse).
  const inv = [e * i - f * h, c * h - b * i, b * f - c * e, f * g - d * i, a * i - c * g, c * d - a * f, d * h - e * g, b * g - a * h, a * e - b * d].map((x) => x / det);
  return (v, direction) => {
    // (The way a face looks goes back by the matrix laid on its side: the same thing for a move, a turn, a mirroring.)
    if (direction) return [a * v[0] + d * v[1] + g * v[2], b * v[0] + e * v[1] + h * v[2], c * v[0] + f * v[1] + i * v[2]];
    const q = [v[0] - m[3], v[1] - m[7], v[2] - m[11]];
    return [inv[0] * q[0] + inv[1] * q[1] + inv[2] * q[2], inv[3] * q[0] + inv[4] * q[1] + inv[5] * q[2], inv[6] * q[0] + inv[7] * q[1] + inv[8] * q[2]];
  };
}

const tags = new WeakMap<Shape3D, Tagged>();
const edgeTags = new WeakMap<Shape3D, string[][]>();
const oldEdgeTags = new WeakMap<Shape3D, string[][] | null>();

const r4 = (v: number) => {
  const x = Math.round(v * 1e4) / 1e4;
  return Object.is(x, -0) ? "0" : String(x);
};

/** A face's surface, the same however much of it the face covers (null: no key for this kind). */
function surfaceKey(face: Face): string | null {
  const oc = getOC();
  const s = new oc.BRepAdaptor_Surface(face.wrapped, true);
  try {
    const T = oc.GeomAbs_SurfaceType;
    const type = s.GetType();
    // A direction either way round (a face's orientation can flip in an edit).
    const dir = (d: { X(): number; Y(): number; Z(): number }) => {
      let v = [d.X(), d.Y(), d.Z()];
      const k = v.findIndex((x) => Math.abs(x) > 1e-9);
      if (k >= 0 && v[k] < 0) v = v.map((x) => -x);
      return v;
    };
    // The point of a line through p along d nearest the origin.
    const foot = (p: number[], d: number[]) => {
      const t = p[0] * d[0] + p[1] * d[1] + p[2] * d[2];
      return [p[0] - t * d[0], p[1] - t * d[1], p[2] - t * d[2]];
    };
    const pt = (p: { X(): number; Y(): number; Z(): number }) => [p.X(), p.Y(), p.Z()];
    if (type === T.GeomAbs_Plane) {
      const pl = s.Plane();
      const n = dir(pl.Axis().Direction());
      const p = pt(pl.Location());
      return `P ${n.map(r4)} ${r4(n[0] * p[0] + n[1] * p[1] + n[2] * p[2])}`;
    }
    if (type === T.GeomAbs_Cylinder) {
      const cy = s.Cylinder();
      const d = dir(cy.Axis().Direction());
      return `C ${d.map(r4)} ${foot(pt(cy.Location()), d).map(r4)} ${r4(cy.Radius())}`;
    }
    if (type === T.GeomAbs_Sphere) {
      const sp = s.Sphere();
      return `S ${pt(sp.Location()).map(r4)} ${r4(sp.Radius())}`;
    }
    if (type === T.GeomAbs_Cone) {
      const co = s.Cone() as any;
      const d = dir(co.Axis().Direction());
      return `K ${d.map(r4)} ${pt(co.Apex()).map(r4)} ${r4(Math.abs(co.SemiAngle()))}`;
    }
    if (type === T.GeomAbs_Torus) {
      const to = s.Torus() as any;
      const d = dir(to.Axis().Direction());
      return `T ${d.map(r4)} ${pt(to.Location()).map(r4)} ${r4(to.MajorRadius())} ${r4(to.MinorRadius())}`;
    }
    return null;
  } catch {
    return null;
  } finally {
    s.delete();
  }
}

/**
 * Tag the faces of a body a step made or changed. `from`: the bodies it was
 * made from (the same body before the step, and those the step worked on).
 *
 * `others`: bodies that were there but had no part in it. A new face on the
 * same plane as a face of one of them (every body standing on the ground, a
 * block as tall as the one beside it) used to be put down to that body's
 * step: change that body and steps on this one lost their faces. It is this
 * step's now; the old answer is kept beside it, for projects saved with it.
 */
export function tagBody(shape: Shape3D, step: string, from: Shape3D[], others: Shape3D[] = []): void {
  if (tags.has(shape)) return;
  const hashes = new Map<number, { face: Face; step: string; key: string | null; alias?: string; move?: Moved }[]>();
  const byKey = new Map<string, { step: string; alias?: string; move?: Moved }>();
  for (const s of from) {
    const t = tags.get(s);
    if (!t || s === shape) continue;
    for (const list of t.byHash.values())
      for (const { face, i } of list) {
        const h = face.hashCode;
        hashes.set(h, [...(hashes.get(h) ?? []), { face, step: t.steps[i], key: t.keys[i], alias: t.alias?.[i], move: t.moves?.[i] }]);
      }
    t.keys.forEach((k, i) => k && !byKey.has(k) && byKey.set(k, { step: t.steps[i], alias: t.alias?.[i], move: t.moves?.[i] }));
  }
  const oldKey = new Map<string, string>();
  for (const s of others) {
    const t = tags.get(s);
    if (!t || s === shape || from.includes(s)) continue;
    t.keys.forEach((k, i) => k && !oldKey.has(k) && oldKey.set(k, t.alias?.[i] ?? t.steps[i]));
  }
  const faces = shape.faces;
  const out: Tagged = { steps: [], keys: [], byHash: new Map() };
  const alias: (string | undefined)[] = [];
  const moves: (Moved | undefined)[] = [];
  faces.forEach((face, i) => {
    const h = face.hashCode;
    out.byHash.set(h, [...(out.byHash.get(h) ?? []), { face, i }]);
    const same = hashes.get(h)?.find((x) => x.face.isSame(face));
    if (same) {
      out.steps.push(same.step);
      out.keys.push(same.key);
      alias.push(same.alias);
      moves.push(same.move);
      return;
    }
    const key = surfaceKey(face);
    out.keys.push(key);
    const kept = key ? byKey.get(key) : undefined;
    out.steps.push(kept?.step ?? step);
    alias.push(kept ? kept.alias : key ? oldKey.get(key) : undefined);
    moves.push(kept?.move);
  });
  if (alias.some((a) => a !== undefined)) out.alias = alias;
  if (moves.some((m) => m !== undefined)) out.moves = moves;
  tags.set(shape, out);
}

/**
 * A body moved, turned or mirrored whole - by a Move, or as a pattern's copy
 * (`m`: where each point went; the same faces in the same order). Every face
 * is still the step's that made it, and the same one of that step's faces:
 * it used to become the Move's, so a pick on a moved body knew no more than
 * where its face was - and a Move put in before a step lost the step its
 * picks. What was saved then names the faces by the Move (`step`): kept
 * beside, as the old answer.
 */
export function movedTags(from: Shape3D, moved: Shape3D, step: string, m: number[]): void {
  const t = tags.get(from);
  if (!t || tags.has(moved)) return;
  const faces = moved.faces;
  if (faces.length !== t.steps.length) return;
  const byHash = new Map<number, { face: Face; i: number }[]>();
  faces.forEach((face, i) => byHash.set(face.hashCode, [...(byHash.get(face.hashCode) ?? []), { face, i }]));
  tags.set(moved, {
    steps: t.steps,
    keys: faces.map(surfaceKey),
    byHash,
    alias: faces.map(() => step),
    moves: faces.map((_, i) => (t.moves?.[i] ? then(t.moves[i]!, m) : m)),
  });
}

/** The step each face used to be put down to, where that differs (see tagBody); undefined: none does. */
export function faceAliases(shape: Shape3D): (string | undefined)[] | undefined {
  return tags.get(shape)?.alias;
}

/** The step that made each face of a body (undefined: not tagged). */
export function faceSteps(shape: Shape3D): string[] | undefined {
  return tags.get(shape)?.steps;
}

/** Edge steps as projects saved before faces were told apart from other bodies' name them (undefined: the same as edgeSteps). */
export function oldEdgeSteps(shape: Shape3D): string[][] | undefined {
  const known = oldEdgeTags.get(shape);
  if (known !== undefined) return known ?? undefined;
  const t = tags.get(shape);
  const out = t?.alias ? stepsOfEdges(shape, t.steps.map((s, i) => t.alias![i] ?? s)) : null;
  oldEdgeTags.set(shape, out);
  return out ?? undefined;
}

/** For each edge of a body, the steps of the faces it lies between (sorted; one for a seam). */
export function edgeSteps(shape: Shape3D): string[][] | undefined {
  const known = edgeTags.get(shape);
  if (known) return known;
  const steps = faceSteps(shape);
  if (!steps) return undefined;
  const out = stepsOfEdges(shape, steps);
  edgeTags.set(shape, out);
  return out;
}

function stepsOfEdges(shape: Shape3D, steps: string[]): string[][] {
  const edges = shape.edges;
  const buckets = new Map<number, { i: number; s: Set<string> }[]>();
  edges.forEach((e, i) => buckets.set(e.hashCode, [...(buckets.get(e.hashCode) ?? []), { i, s: new Set<string>() }]));
  shape.faces.forEach((f, fi) => {
    for (const fe of f.edges) {
      const list = buckets.get(fe.hashCode);
      const m = list?.length === 1 ? list[0] : list?.find((x) => edges[x.i].isSame(fe));
      m?.s.add(steps[fi]);
    }
  });
  const out: string[][] = new Array(edges.length).fill(null).map(() => []);
  for (const list of buckets.values()) for (const { i, s } of list) out[i] = [...s].sort();
  return out;
}

/**
 * Which of a step's faces a face is: told from the face itself and what the
 * step was made from (an extrusion's side by the sketch curve under it). One
 * per step that can tell; set by the engine as it replays the steps.
 */
export type OriginOf = (face: Face, back?: Back) => string | null;
let originOf: Map<string, OriginOf> = new Map();
export function setOrigins(of: Map<string, OriginOf>): void {
  originOf = of;
}

const originTags = new WeakMap<Shape3D, (string | undefined)[]>();
/** For each face of a body, which of its step's faces it is (undefined: can't be told). */
export function faceOrigins(shape: Shape3D): (string | undefined)[] | undefined {
  const known = originTags.get(shape);
  if (known) return known;
  const steps = faceSteps(shape);
  if (!steps) return undefined;
  const moves = tags.get(shape)?.moves;
  const out = shape.faces.map((face, i) => {
    const of = originOf.get(steps[i]);
    if (!of) return undefined;
    try {
      // (Told where its step made it: a face moved since is taken back there.)
      return of(face, moves?.[i] ? backOf(moves[i]!) : undefined) ?? undefined;
    } catch {
      return undefined;
    }
  });
  originTags.set(shape, out);
  return out;
}

const edgeOriginTags = new WeakMap<Shape3D, (string[] | undefined)[]>();
/** For each edge, the faces it lies between as "step|origin" (sorted); undefined when one of them can't be told. */
export function edgeOrigins(shape: Shape3D): (string[] | undefined)[] | undefined {
  const known = edgeOriginTags.get(shape);
  if (known) return known;
  const steps = faceSteps(shape);
  const origins = faceOrigins(shape);
  if (!steps || !origins) return undefined;
  const edges = shape.edges;
  const buckets = new Map<number, { i: number; s: Set<string>; all: boolean }[]>();
  edges.forEach((e, i) => buckets.set(e.hashCode, [...(buckets.get(e.hashCode) ?? []), { i, s: new Set<string>(), all: true }]));
  shape.faces.forEach((f, fi) => {
    for (const fe of f.edges) {
      const list = buckets.get(fe.hashCode);
      const m = list?.length === 1 ? list[0] : list?.find((x) => edges[x.i].isSame(fe));
      if (!m) continue;
      if (origins[fi] === undefined) m.all = false;
      else m.s.add(`${steps[fi]}|${origins[fi]}`);
    }
  });
  const out: (string[] | undefined)[] = new Array(edges.length).fill(undefined);
  for (const list of buckets.values()) for (const { i, s, all } of list) out[i] = all && s.size ? [...s].sort() : undefined;
  edgeOriginTags.set(shape, out);
  return out;
}

const seamTags = new WeakMap<Shape3D, boolean[]>();

/**
 * Per edge: it has the same face on both sides (the seam of a cylinder or a
 * sphere). Nothing to round there - a fillet's corner that's gone mustn't
 * land on one (a lid's 4 corner edges all went to its seam when the lid
 * was made round: "radius too big", not "the edges are gone").
 */
export function seamEdges(shape: Shape3D): boolean[] {
  const known = seamTags.get(shape);
  if (known) return known;
  const edges = shape.edges;
  const buckets = new Map<number, { i: number; faces: Set<number> }[]>();
  edges.forEach((e, i) => buckets.set(e.hashCode, [...(buckets.get(e.hashCode) ?? []), { i, faces: new Set<number>() }]));
  shape.faces.forEach((f, fi) => {
    for (const fe of f.edges) {
      const list = buckets.get(fe.hashCode);
      const m = list?.length === 1 ? list[0] : list?.find((x) => edges[x.i].isSame(fe));
      m?.faces.add(fi);
    }
  });
  const out: boolean[] = new Array(edges.length).fill(false);
  for (const list of buckets.values()) for (const { i, faces } of list) out[i] = faces.size === 1;
  seamTags.set(shape, out);
  return out;
}

/** Same steps, as stored in a reference. */

export function sameSteps(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** A copy made face for face (same order): the same tags. */
export function inheritTags(from: Shape3D, copy: Shape3D): void {
  const t = tags.get(from);
  if (!t || tags.has(copy)) return;
  const faces = copy.faces;
  if (faces.length !== t.steps.length) return;
  const byHash = new Map<number, { face: Face; i: number }[]>();
  faces.forEach((face, i) => byHash.set(face.hashCode, [...(byHash.get(face.hashCode) ?? []), { face, i }]));
  tags.set(copy, { steps: t.steps, keys: t.keys, byHash, alias: t.alias, moves: t.moves });
}
