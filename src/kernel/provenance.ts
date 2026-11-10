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
   * (see tagBody): what projects saved before then name it by.
   */
  alias?: (string | undefined)[];
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
  const hashes = new Map<number, { face: Face; step: string; key: string | null; alias?: string }[]>();
  const byKey = new Map<string, { step: string; alias?: string }>();
  for (const s of from) {
    const t = tags.get(s);
    if (!t || s === shape) continue;
    for (const list of t.byHash.values())
      for (const { face, i } of list) {
        const h = face.hashCode;
        hashes.set(h, [...(hashes.get(h) ?? []), { face, step: t.steps[i], key: t.keys[i], alias: t.alias?.[i] }]);
      }
    t.keys.forEach((k, i) => k && !byKey.has(k) && byKey.set(k, { step: t.steps[i], alias: t.alias?.[i] }));
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
  faces.forEach((face, i) => {
    const h = face.hashCode;
    out.byHash.set(h, [...(out.byHash.get(h) ?? []), { face, i }]);
    const same = hashes.get(h)?.find((x) => x.face.isSame(face));
    if (same) {
      out.steps.push(same.step);
      out.keys.push(same.key);
      alias.push(same.alias);
      return;
    }
    const key = surfaceKey(face);
    out.keys.push(key);
    const kept = key ? byKey.get(key) : undefined;
    out.steps.push(kept?.step ?? step);
    alias.push(kept ? kept.alias : key ? oldKey.get(key) : undefined);
  });
  if (alias.some((a) => a !== undefined)) out.alias = alias;
  tags.set(shape, out);
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
export type OriginOf = (face: Face) => string | null;
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
  const out = shape.faces.map((face, i) => {
    const of = originOf.get(steps[i]);
    if (!of) return undefined;
    try {
      return of(face) ?? undefined;
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
  tags.set(copy, { steps: t.steps, keys: t.keys, byHash, alias: t.alias });
}
