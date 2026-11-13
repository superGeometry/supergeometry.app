// The geometry kernel. This (with sketchGeom.ts) is the ONLY code that knows
// about OpenCascade / replicad; worker.ts exposes it to the UI via protocol.ts.
//
// replicad gotchas, learned the hard way:
//  - makeCompound(), translate(), rotate(), mirror(), scale() DELETE their input.
//    Shapes here live on in the feature cache, so always clone first.

import {
  basicFaceExtrusion,
  exportSTEP,
  getOC,
  genericSweep,
  importSTEP,
  loft,
  makeCompound,
  makeBox,
  iterTopo,
  makeBSplineApproximation,
  makeBezierCurve,
  makeThreePointArc,
  makeVertex,
  makeSphere,
  makeCircle,
  makeLine,
  makeCylinder,
  makeHelix,
  isShape3D,
  makeFace,
  cast,
  makePolygon,
  makeSolid,
  measureArea,
  measureDistanceBetween,
  ProjectionCamera,
  revolution,
  Solid,
  Vector,
  assembleWire,
  type AnyShape,
  type Edge,
  type Face,
  type Shape3D,
  type Wire,
} from "replicad";
import type {
  AxisRef,
  EdgeRef,
  ExtrudeSource,
  FaceRef,
  Feature,
  PathRef,
  PlaneDef,
  SketchEntity,
  SketchFeature,
  Vec3,
} from "../doc/types";
import { fillEdgeKey } from "../doc/types";
import { add, cross, dist, dot, len, norm, scale, sub, toWorld, xDirFor } from "../geom";
import { outlineOffsetCurves, projectPolyline } from "../sketch/edit";
import { solveFine } from "../sketch/constraints";
import { carried } from "../sketch/follow";

import { cageToShape } from "./freeform";
import { arcSpine, evenly, gentle, guideCurve, oriented, plainSpine, slideAxis, slidingSpine, smoothed } from "../freeform/connect";
import { deepCopy, hairThin, meshVolume, openEdges, shapeValid, subShapes } from "./health";
import { healthOf, isHealthy, repairShape } from "./repair";
export { shapeValid } from "./health";
import { applyPlan, boundaryEdges, cachedPlan, deleteFaces, isClosed, selfCrossings, subdivide } from "../freeform/cage";
import { useSafeBooleans, withoutInternals } from "./safeBooleans";
import { useReleases } from "./release";
import { areaProperties, measureArea as trueArea, measureVolume, normalOnEdge, surfaceAt, volumeProperties } from "./ocFree";
import { binarySTL, faceTriangles, meshEdgeLines, meshFaces, meshOff, type FaceMesh } from "./meshing";
import { loftInLine } from "./loftAlign";
import { railLoft } from "./loftRails";
import { edgeOrigins, edgeSteps, faceAliases, faceOrigins, faceSteps, inheritTags, movedTags, oldEdgeSteps, sameSteps, seamEdges, setOrigins, tagBody, type OriginOf } from "./provenance";
import { closestOnEntity } from "../sketch/regions";

import { cylinderOf, deleteFace,
 deleteFaces as deleteBodyFaces, editNotes, freeformFace, sameSizesAgain, sheetFace, hasBlends, offsetFace, onFace as pointOnFace, planeOf, replaceFacePlane, sizeOf, unify } from "./faceEdit";
import { threadDepth } from "./threads";
import { anchorOf, freeformFaces, meshViews, viewEdge } from "./viewLines";
import { entitiesWire, regionFaces, regionHoleWires, regionWire, withFittedSplines } from "./sketchGeom";
import { stretchShape } from "./stretch";
import { imprint, onFace as linesOnFace, seenFrom, wrapOnto } from "./wrap";
import type { BodyHealth, BodyMesh, BodyProps, ProjectedView, ViewBody, ViewEdge, ViewSpec, ConstructionInfo, EdgeInfo, ExportFormat, FaceInfo, FeatureError, RegenResult } from "./protocol";

type Bodies = Map<string, Shape3D>;
type SketchState = SketchFeature & { boundary: SketchEntity[] };

const allCurves = (s: SketchState): SketchEntity[] => [...s.entities, ...s.boundary];

interface Ctx {
  bodies: Bodies;
  sketches: Map<string, SketchState>;
  planes: Map<string, ConstructionInfo>;
  axes: Map<string, ConstructionInfo>;
  /**
   * Bodies that are still a freeform cage moved/scaled by an affine map: they can
   * be rebuilt exactly (e.g. stretched along X/Y/Z, which other bodies can't be).
   */
  freeforms: Map<string, { feature: Extract<Feature, { type: "freeform" }>; m: Affine }>;
  /** The paths sweeps ran along (by sweep): an offset of a sweep's end follows its path back. */
  sweeps: Map<string, Wire>;
}

/**
 * What a step read of the model before it, as it ran: so that when an
 * earlier step changes, a step that read nothing of what changed is not
 * rebuilt - its result is put on the model as it is now.
 */
interface Reads {
  /** Each thing it asked for ("bodies|id") and what it got (undefined: not there). */
  one: Map<string, unknown>;
  /** Kinds it looked through all of (any change among them is a change for it). */
  all: Set<keyof Ctx>;
  written: Set<string>;
}
let reading: Reads | null = null;
const KINDS = ["bodies", "sketches", "planes", "axes", "freeforms", "sweeps"] as const;
const rawGet = <V>(m: Map<string, V>, k: string): V | undefined => Map.prototype.get.call(m, k) as V | undefined;
const rawHas = (m: Map<string, unknown>, k: string): boolean => Map.prototype.has.call(m, k) as boolean;
const rawEntries = <V>(m: Map<string, V>): [string, V][] => [...(Map.prototype.entries.call(m) as IterableIterator<[string, V]>)];

/** A map of the model (its bodies, sketches…) that notes what a step reads of it. */
class Noted<V> extends Map<string, V> {
  private live = false;
  constructor(readonly kind: keyof Ctx, from?: Map<string, V>) {
    super();
    if (from) for (const [k, v] of rawEntries(from)) super.set(k, v);
    this.live = true;
  }
  private saw(k: string, v: unknown): void {
    const key = `${this.kind}|${k}`;
    if (reading && !reading.written.has(key) && !reading.one.has(key)) reading.one.set(key, v);
  }
  get(k: string): V | undefined {
    const v = super.get(k);
    this.saw(k, v);
    return v;
  }
  has(k: string): boolean {
    this.saw(k, super.get(k));
    return super.has(k);
  }
  set(k: string, v: V): this {
    if (this.live) reading?.written.add(`${this.kind}|${k}`);
    return super.set(k, v);
  }
  delete(k: string): boolean {
    reading?.written.add(`${this.kind}|${k}`);
    return super.delete(k);
  }
  clear(): void {
    reading?.all.add(this.kind);
    super.clear();
  }
  get size(): number {
    reading?.all.add(this.kind);
    return super.size;
  }
  keys(): MapIterator<string> {
    reading?.all.add(this.kind);
    return super.keys();
  }
  values(): MapIterator<V> {
    reading?.all.add(this.kind);
    return super.values();
  }
  entries(): MapIterator<[string, V]> {
    reading?.all.add(this.kind);
    return super.entries();
  }
  forEach(fn: (value: V, key: string, map: Map<string, V>) => void, thisArg?: unknown): void {
    reading?.all.add(this.kind);
    super.forEach(fn, thisArg);
  }
  [Symbol.iterator](): MapIterator<[string, V]> {
    reading?.all.add(this.kind);
    return super[Symbol.iterator]();
  }
}
/** The model for the next step to work on: a copy to change, the one before it left as it is. */
function fork(ctx: Ctx): Ctx {
  return {
    bodies: new Noted("bodies", ctx.bodies),
    sketches: new Noted("sketches", ctx.sketches),
    planes: new Noted("planes", ctx.planes),
    axes: new Noted("axes", ctx.axes),
    freeforms: new Noted("freeforms", ctx.freeforms),
    sweeps: new Noted("sweeps", ctx.sweeps),
  };
}
/** How many steps the last rebuild ran, took as they were (nothing before them changed), or put back (nothing they read changed). */
export const rebuildStats = { ran: 0, kept: 0, reused: 0 };

interface CacheEntry {
  key: string;
  ctx: Ctx;
  /** The step, and its values as text (hashed): the same step, unchanged? */
  id?: string;
  json?: string;
  /** What it read of the model before it, that model, and what it changed in it. */
  reads?: Reads;
  input?: Ctx;
  delta?: [keyof Ctx, string, unknown, boolean][];
  /** The steps switched off when it ran (a failed step's words depend on it). */
  off?: string;
  error?: string;
  /** Worked, but had to give something up (shown on the step in History). */
  note?: string;
  /** Which of its faces a face is (see provenance.ts): for steps made from a sketch. */
  origin?: OriginOf;
}

const meshCache = new WeakMap<Shape3D, BodyMesh>();
/** The Freeform Face steps of the project being rebuilt (their faces are patches of one smooth surface). */
let smoothSteps = new Set<string>();
/** The next mesh's key (see BodyMesh.key). */
let meshKey = 1;
const importCache = new Map<string, Shape3D>();
let cache: CacheEntry[] = [];
/**
 * The saved project's steps, kept while a step is being changed (its previews
 * fill `cache`): Cancel goes back to them at once, not after a rebuild of
 * every step after the one that was open.
 */
let savedCache: CacheEntry[] = [];
/** The project with its threads left plain, as drawings draw it (kept apart from `cache`). */
let drawingCache: CacheEntry[] = [];
/** While drawings rebuild into `drawingCache`: the model's own steps, for the ones before its first thread. */
let alsoCache: CacheEntry[] = [];

/**
 * The engine itself broke down on a step (out of memory, a fault inside
 * OpenCascade): nothing it holds can be trusted after that. Whoever runs the
 * engine loads a fresh one, calls `resetKernel`, and asks again - the step
 * that did it is remembered (by its key) and refused with words from then on.
 */
export class KernelFault extends Error {
  constructor(readonly featureId: string) {
    super("The geometry engine broke down and has to be restarted");
  }
}
const FAULT_TEXT = "This step made the geometry engine run out of memory or break down (a value far too big, or too small?) - change its values, or delete it";
/** Steps (by key) that broke the engine: not tried again. */
const crashed = new Map<string, string>();
/**
 * Steps the engine broke down on once. The first time may be the engine's
 * memory having filled up over a long session (it never gives any back), so
 * the step gets a second go on the fresh engine; only if that breaks too is it the step.
 */
const suspects = new Set<string>();
function blame(key: string): void {
  if (crashed.size > 200) crashed.clear();
  if (suspects.size > 200) suspects.clear();
  if (suspects.has(key)) crashed.set(key, FAULT_TEXT);
  else suspects.add(key);
}

/** Is this the engine breaking down (not a step that merely can't be done)? */
export function isFault(err: unknown): boolean {
  if (err instanceof KernelFault) return true;
  if (typeof WebAssembly !== "undefined" && err instanceof WebAssembly.RuntimeError) return true;
  const text = err instanceof Error ? `${err.name} ${err.message}` : typeof err === "string" ? err : "";
  return /memory access out of bounds|out of memory|unreachable|table index is out of bounds|null function or function signature mismatch|Aborted\(|Maximum call stack|Expected null or instance of|Cannot pass deleted object|BindingError/i.test(text);
}

/** After a fresh OpenCascade was loaded: everything made with the old one is dropped. */
export function resetKernel(): void {
  cache = [];
  savedCache = [];
  drawingCache = [];
  lastBodies = new Map();
  importCache.clear();
  sketchWas.clear();
}

/**
 * `work`, and if the engine breaks down in it: a fresh engine (`reload` loads
 * OpenCascade again) and once more, the step that did it now refused.
 */
export async function withFreshKernel<T>(reload: () => Promise<void>, work: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await work();
    } catch (err) {
      if (!isFault(err) || attempt >= 3) throw err;
      await reload();
      resetKernel();
    }
  }
}

/** Is a step as it was last rebuilt, and everything it read of the model then still what is there now? */
function unchangedFor(was: CacheEntry, json: string, ctx: Ctx, off: string): boolean {
  if (was.json !== json || !was.reads || !was.delta || !was.input) return false;
  // (What a failed step says can depend on which steps are switched off.)
  if (was.error && was.off !== off) return false;
  for (const [key, value] of was.reads.one) {
    const at = key.indexOf("|");
    if (rawGet(ctx[key.slice(0, at) as keyof Ctx] as Map<string, unknown>, key.slice(at + 1)) !== value) return false;
  }
  for (const kind of was.reads.all) {
    const [a, b] = [rawEntries(ctx[kind] as Map<string, unknown>), was.input[kind] as Map<string, unknown>];
    if (a.length !== rawEntries(b).length || a.some(([k, v]) => rawGet(b, k) !== v || !rawHas(b, k))) return false;
  }
  return true;
}

/** The furthest from the origin a body may reach (mm): past it OpenCascade's own tolerances stop meaning anything. */
const MAX_REACH = 1e7;

/** A step's vectors, where the file should hold [x, y, z] (or [x, y]). */
const VECTOR_KEYS = new Set(["origin", "xDir", "normal", "dir", "mid", "center", "translate", "factors"]);
/** A step's lists (the bodies it works on, its tools, edges, faces...): a list where the file has one at all. */
const LIST_KEYS = new Set(["tools", "bodies", "edges", "faces", "regions", "sections", "entities"]);
/**
 * Is a step's saved data broken (a damaged file, or one written by something
 * else): a vector that isn't numbers, a number that is missing from a list of them?
 */
function damaged(v: unknown, key = "", depth = 0): boolean {
  if (v === null || typeof v !== "object") return (VECTOR_KEYS.has(key) || LIST_KEYS.has(key)) && v !== undefined;
  if (Array.isArray(v)) {
    const numbers = v.some((x) => typeof x === "number");
    if (numbers && !v.every((x) => typeof x === "number" && Number.isFinite(x))) return true;
    if (VECTOR_KEYS.has(key) && (!numbers || v.length < 2 || v.length > 3)) return true;
    if (numbers) return false;
    return v.some((x) => damaged(x, "", depth + 1));
  }
  if (VECTOR_KEYS.has(key) || LIST_KEYS.has(key)) return true;
  for (const [k, x] of Object.entries(v)) {
    // (An imported file's bytes, a sketch's history: not values of the step.)
    if (depth === 0 && (k === "data" || k === "log")) continue;
    if (damaged(x, k, depth + 1)) return true;
  }
  return false;
}
const DAMAGED_TEXT = "This step's saved values are damaged or incomplete - open it and set them again, or delete it";

// ------------------------------------------------------------------ public API

/** Each body's volume, area, centre of mass and box, measured on the solid (for its mass, in BIM). */
export async function bodyProperties(features: Feature[]): Promise<BodyProps[]> {
  const { ctx, numbers } = await run(features);
  const names = bodyNames(features, [...ctx.bodies.keys()], numbers);
  return [...ctx.bodies.entries()].map(([id, s]) => {
    let volume = 0;
    let center: Vec3 = [0, 0, 0];
    try {
      const p = volumeProperties(s);
      volume = Math.abs(p.volume);
      center = p.centerOfMass;
    } catch {
      // an open surface: no volume
    }
    let area = 0;
    try {
      area = trueArea(s);
    } catch {
      area = 0;
    }
    const [lo, hi] = s.boundingBox.bounds as [Vec3, Vec3];
    return { id, name: names.get(id) ?? id, volume, area, center, box: [lo, hi] };
  });
}

/** Each body's health: valid, closed, solids, faces, volume (for checking a model from the console or the command line). */
export async function bodyHealth(features: Feature[]): Promise<BodyHealth[]> {
  const { ctx, numbers } = await run(features);
  const names = bodyNames(features, [...ctx.bodies.keys()], numbers);
  return [...ctx.bodies.entries()].map(([id, s]) => healthReport(id, names.get(id) ?? id, s));
}

/** One body's health (also for tests and scripts that hold the solid). */
export function healthReport(id: string, name: string, s: Shape3D): BodyHealth {
  const h = healthOf(s);
  let edges = 0;
  let box: [Vec3, Vec3] = [[0, 0, 0], [0, 0, 0]];
  try {
    edges = s.edges.length;
    box = s.boundingBox.bounds as [Vec3, Vec3];
  } catch {
    // a broken shape: what healthOf found is the news
  }
  return { id, name, ...h, edges, box, healthy: isHealthy(h) };
}

/**
 * Drawings: the bodies seen along each view's direction, with hidden line
 * removal (OpenCascade's exact HLR), each body's edges kept apart so a balloon
 * can point at it. Edges come out as SVG path data in mm, y down.
 */
export async function projectViews(features: Feature[], views: ViewSpec[], only?: string[], method: "auto" | "exact" | "mesh" = "auto"): Promise<ProjectedView[]> {
  // Threads are drawn the way drawings show them (ISO 6410): the plain round
  // face, and a thin line at the thread's depth. Modelled, a valve's six
  // threads took the hidden line removal minutes.
  const threads = features.filter((f): f is Extract<Feature, { type: "thread" }> => f.type === "thread" && !f.suppressed);
  let ctx: Ctx;
  if (!threads.length) ctx = (await run(features)).ctx;
  else {
    const keep = cache;
    cache = drawingCache;
    alsoCache = keep;
    try {
      ctx = (await run(features.map((f) => (f.type === "thread" && !f.suppressed ? { ...f, suppressed: true } : f)))).ctx;
    } finally {
      drawingCache = cache;
      cache = keep;
      alsoCache = [];
    }
  }
  const bodies = [...ctx.bodies.entries()].filter(([id]) => !only || only.includes(id));
  const marks = threadMarks(threads, ctx);
  const withMarks = (out: ProjectedView[], views: ViewSpec[]) => {
    out.forEach((pv, k) =>
      pv.bodies.forEach((vb) => {
        for (const m of marks.filter((m) => m.body === vb.id)) {
          const line = threadLines(m, views[k], vb.edges);
          if (!line) continue;
          if (line.seen) vb.tangent += line.d;
          else vb.hidden += line.d;
        }
      }),
    );
    return out;
  };
  // Section views: the bodies cut, each on its own.
  const plain = views.filter((v) => !v.cut);
  const drawn = new Map<ViewSpec, ProjectedView>();
  if (plain.length) withMarks(drawViews(bodies, plain, method), plain).forEach((pv, k) => drawn.set(plain[k], pv));
  for (const v of views) if (v.cut) drawn.set(v, sectionView(bodies, v, method));
  return views.map((v) => drawn.get(v)!);
}

/**
 * A section view: each body cut by the plane through `cut` square to the
 * view, the part between the eye and the plane taken off. The faces the cut
 * makes come back as closed outlines, to hatch; hidden lines aren't drawn in
 * a section (ISO 128-40).
 */
function sectionView(bodies: [string, Shape3D][], v: ViewSpec, method: "auto" | "exact" | "mesh"): ProjectedView {
  const d = norm(v.dir as Vec3);
  const look = scale(d, -1);
  const X = norm(v.xAxis as Vec3);
  const Y = cross(d, X);
  const at = v.cut as Vec3;
  const to2 = (p: Vec3): [number, number] => [dot(p, X), -dot(p, Y)];
  const cut: [string, Shape3D][] = [];
  const faces = new Map<string, string>();
  for (const [id, s] of bodies) {
    let part: Shape3D;
    try {
      part = s.intersect(halfSpace({ origin: at, xDir: xDirFor(look), normal: look }, s));
    } catch {
      continue;
    }
    if (isEmpty(part)) continue;
    cut.push([id, part]);
    let path = "";
    for (const face of part.faces) {
      if (face.geomType !== "PLANE") continue;
      const pl = planeOf(face);
      if (Math.abs(Math.abs(dot(pl.normal, look)) - 1) > 1e-6 || Math.abs(dot(sub(pl.origin, at), look)) > 1e-4) continue;
      path += closedLoops(face.edges.map((e) => edgePoints(e).map(to2)));
    }
    if (path) faces.set(id, path);
  }
  if (!cut.length) return { id: v.id, bodies: [], box: null };
  const [pv] = drawViews(cut, [{ ...v, cut: undefined }], method);
  for (const b of pv.bodies) {
    b.hidden = "";
    delete b.under;
    const f = faces.get(b.id);
    if (f) b.section = f;
  }
  return pv;
}

/** An edge's points in space: its ends for a line, more along a curve. */
function edgePoints(e: Edge): Vec3[] {
  const oc = getOC();
  const ad = new oc.BRepAdaptor_Curve(e.wrapped as never);
  try {
    const u0 = ad.FirstParameter();
    const u1 = ad.LastParameter();
    const at = (u: number): Vec3 => {
      const p = ad.Value(u);
      const r: Vec3 = [p.X(), p.Y(), p.Z()];
      p.delete();
      return r;
    };
    if (ad.GetType() === oc.GeomAbs_CurveType.GeomAbs_Line) return [at(u0), at(u1)];
    let length = 0;
    for (let i = 1; i <= 8; i++) length += dist(at(u0 + ((u1 - u0) * (i - 1)) / 8), at(u0 + ((u1 - u0) * i) / 8));
    const n = Math.max(8, Math.min(96, Math.ceil(length / 0.5)));
    return Array.from({ length: n + 1 }, (_, i) => at(u0 + ((u1 - u0) * i) / n));
  } finally {
    ad.delete();
  }
}

/** Edges (as point runs, any order and way round) joined end to end into closed outlines: SVG path data. */
export function closedLoops(runs: [number, number][][]): string {
  const left = runs.filter((r) => r.length > 1);
  const same = (a: [number, number], b: [number, number]) => Math.abs(a[0] - b[0]) < 1e-3 && Math.abs(a[1] - b[1]) < 1e-3;
  let d = "";
  while (left.length) {
    const loop = [...left.shift()!];
    for (let grew = true; grew && !same(loop[0], loop[loop.length - 1]); ) {
      grew = false;
      const end = loop[loop.length - 1];
      const i = left.findIndex((r) => same(r[0], end) || same(r[r.length - 1], end));
      if (i < 0) break;
      const r = left.splice(i, 1)[0];
      loop.push(...(same(r[0], end) ? r : [...r].reverse()).slice(1));
      grew = true;
    }
    d += loop.map((p, i) => `${i ? "L" : "M"}${r3(p[0])} ${r3(p[1])}`).join("") + "Z";
  }
  return d;
}

/** Views drawn the usual way: exact hidden line removal, or from the meshes for freeform or very big models. */
function drawViews(bodies: [string, Shape3D][], views: ViewSpec[], method: "auto" | "exact" | "mesh"): ProjectedView[] {
  // Freeform faces (or a great many faces) take the exact hidden line removal
  // seconds to minutes a view: those models are drawn from their meshes.
  const meshes = bodies.map(([id, s]) => ({ id, shape: s, mesh: drawingMesh(id, s) }));
  const faces = meshes.reduce((n, m) => n + m.mesh.faces.length, 0);
  const free = meshes.reduce((n, m) => n + freeformFaces(m.mesh), 0);
  const how = method === "auto" ? (free > 0 || faces > 600 ? "mesh" : "exact") : method;
  if (how === "mesh") return meshViews(meshes, views);
  const oc = getOC();
  return views.map((v) => {
    const cam = new ProjectionCamera([0, 0, 0], v.dir, v.xAxis);
    const algo = new oc.HLRBRep_Algo();
    for (const [, s] of bodies) algo.Add(s.wrapped, 0);
    const projector = new oc.HLRAlgo_Projector(cam.wrapped);
    algo.Projector(projector);
    algo.Update();
    algo.Hide();
    const out = new oc.HLRBRep_HLRToShape(algo);
    let lo: [number, number] = [Infinity, Infinity];
    let hi: [number, number] = [-Infinity, -Infinity];
    // Hidden edges lying exactly under seen ones (the back of a box, seen
    // straight on) are left out: they would only be drawn over.
    const drawn = new Set<string>();
    const key = (a: [number, number], b: [number, number]) => {
      const [p, q] = [`${r3(a[0])} ${r3(a[1])}`, `${r3(b[0])} ${r3(b[1])}`].sort();
      return `${p}|${q}`;
    };
    const result: ViewBody[] = bodies.map(([id, s]) => {
      const seen: [number, number][][] = [];
      const edges: ViewEdge[] = [];
      const paths = (parts: unknown[], keep: boolean) => {
        let d = "";
        for (const part of parts) {
          const shape = part as { IsNull(): boolean };
          if (shape.IsNull()) continue;
          for (const e of (cast(shape as never) as AnyShape).edges) {
            oc.BRepLib.BuildCurves3d(e.wrapped as never);
            const { pts, kind } = edgeSamples(e);
            const k = key(pts[0], pts[pts.length - 1]);
            if (keep) drawn.add(k);
            else if (pts.length === 2 && drawn.has(k)) continue;
            for (const p of pts) {
              lo = [Math.min(lo[0], p[0]), Math.min(lo[1], p[1])];
              hi = [Math.max(hi[0], p[0]), Math.max(hi[1], p[1])];
            }
            if (keep) {
              seen.push(pts);
              const edge = viewEdge(kind, pts);
              if (edge) edges.push(edge);
            }
            d += pts.map((p, i) => `${i ? "L" : "M"}${r3(p[0])} ${r3(p[1])}`).join("");
          }
        }
        return d;
      };
      const w = s.wrapped;
      const visible = paths([out.VCompound(w), out.OutLineVCompound(w)], true);
      const tangent = paths([out.Rg1LineVCompound(w)], true);
      return { id, visible, tangent, hidden: "", anchor: anchorOf(seen), edges };
    });
    // Hidden edges once every body's seen ones are known. A body hidden
    // whole (inside a housing) still gets a spot a balloon can point at.
    bodies.forEach(([, s], i) => {
      let d = "";
      const under: [number, number][][] = [];
      for (const part of [out.HCompound(s.wrapped), out.OutLineHCompound(s.wrapped)]) {
        if (part.IsNull()) continue;
        for (const e of (cast(part) as AnyShape).edges) {
          oc.BRepLib.BuildCurves3d(e.wrapped as never);
          const { pts } = edgeSamples(e);
          if (pts.length === 2 && drawn.has(key(pts[0], pts[1]))) continue;
          if (!result[i].anchor) under.push(pts);
          d += pts.map((p, j) => `${j ? "L" : "M"}${r3(p[0])} ${r3(p[1])}`).join("");
        }
      }
      result[i].hidden = d;
      if (!result[i].anchor && under.length) result[i].under = anchorOf(under);
    });
    out.delete();
    projector.delete();
    algo.delete();
    cam.delete();
    return { id: v.id, bodies: result, box: lo[0] <= hi[0] ? [lo, hi] : null };
  });
}

const r3 = (n: number) => String(Math.round(n * 1000) / 1000);

/** A thread as a drawing marks it: its round face's axis and length, and the radius of its thin line. */
type ThreadMark = { body: string; c: Vec3; a: Vec3; r: number; rc: number; t0: number; t1: number };

/** Where the threads are, on the plain bodies (a face that moved since its thread step is left unmarked). */
function threadMarks(threads: Extract<Feature, { type: "thread" }>[], ctx: Ctx): ThreadMark[] {
  const out: ThreadMark[] = [];
  for (const f of threads) {
    const body = ctx.bodies.get(f.face.body);
    if (!body) continue;
    try {
      const face = threadTarget(body, f);
      const cy = cylinderOf(face);
      if (!cy) continue;
      const a = norm(cy.a);
      const ts: number[] = [];
      for (const e of face.edges) for (const k of [0, 0.5, 1]) ts.push(dot(sub(e.pointAt(k).toTuple() as Vec3, cy.c), a));
      const inside = cy.s < 0;
      const depth = threadDepth(f.pitch, inside);
      out.push({ body: f.face.body, c: cy.c, a, r: cy.r, rc: inside ? cy.r + depth : cy.r - depth, t0: Math.min(...ts), t1: Math.max(...ts) });
    } catch {
      // Not found: no mark.
    }
  }
  return out;
}

/**
 * A thread's thin line in a view, as path data: along its axis, two lines at
 * the thread's depth (seen where the round face's outline is); looking down
 * it, three quarters of a circle (seen where its edge circle is).
 */
function threadLines(m: ThreadMark, v: ViewSpec, edges: ViewEdge[]): { d: string; seen: boolean } | null {
  const d = norm(v.dir);
  const X = norm(v.xAxis);
  const Y = cross(d, X);
  const to2 = (p: Vec3): [number, number] => [dot(p, X), -dot(p, Y)];
  const along = Math.abs(dot(m.a, d));
  const tol = Math.max(0.02, m.r * 0.02);
  if (along < 1e-6) {
    const p0 = to2(add(m.c, scale(m.a, m.t0)));
    const p1 = to2(add(m.c, scale(m.a, m.t1)));
    const u = norm([p1[0] - p0[0], p1[1] - p0[1], 0]);
    const n: [number, number] = [-u[1], u[0]];
    let path = "";
    let seen = false;
    for (const sgn of [1, -1]) {
      const off = (p: [number, number], r: number): [number, number] => [p[0] + n[0] * r * sgn, p[1] + n[1] * r * sgn];
      // The round face's outline on this side, among the seen straight edges.
      const o0 = off(p0, m.r);
      const across = (q: [number, number]) => Math.abs((q[0] - o0[0]) * n[0] + (q[1] - o0[1]) * n[1]);
      if (edges.some((e) => !("m" in e) && across(e.a) < tol && across(e.b) < tol)) seen = true;
      const [a, b] = [off(p0, m.rc), off(p1, m.rc)];
      path += `M${r3(a[0])} ${r3(a[1])}L${r3(b[0])} ${r3(b[1])}`;
    }
    return { d: path, seen };
  }
  if (along > 1 - 1e-6) {
    // The end the view looks at.
    const near = dot(m.a, d) > 0 ? m.t0 : m.t1;
    const c = to2(add(m.c, scale(m.a, near)));
    const seen = edges.some((e) => "m" in e && Math.abs(e.r - m.r) < tol && Math.hypot(e.c[0] - c[0], e.c[1] - c[1]) < tol);
    const n = 48;
    const pts = Array.from({ length: n + 1 }, (_, i) => {
      const t = (i / n) * 1.5 * Math.PI;
      return [c[0] + m.rc * Math.cos(t), c[1] - m.rc * Math.sin(t)];
    });
    return { d: pts.map((p, i) => `${i ? "L" : "M"}${r3(p[0])} ${r3(p[1])}`).join(""), seen };
  }
  return null;
}

/**
 * Points along a projected edge (y flipped, for the paper): a line's two
 * ends, a curve sampled finely enough to print - read from one curve adaptor
 * (a drawing of a big assembly has thousands of edges).
 */
function edgeSamples(e: Edge): { pts: [number, number][]; kind: "line" | "circle" | "other" } {
  const oc = getOC();
  const ad = new oc.BRepAdaptor_Curve(e.wrapped as never);
  try {
    const T = oc.GeomAbs_CurveType;
    const type = ad.GetType();
    const u0 = ad.FirstParameter();
    const u1 = ad.LastParameter();
    const at = (u: number): [number, number] => {
      const p = ad.Value(u);
      const r: [number, number] = [p.X(), -p.Y()];
      p.delete();
      return r;
    };
    if (type === T.GeomAbs_Line) return { pts: [at(u0), at(u1)], kind: "line" };
    // As many points as its length asks for (one every half millimetre, 8 to 96).
    let len = 0;
    let prev = at(u0);
    for (let i = 1; i <= 8; i++) {
      const q = at(u0 + ((u1 - u0) * i) / 8);
      len += Math.hypot(q[0] - prev[0], q[1] - prev[1]);
      prev = q;
    }
    const n = Math.max(8, Math.min(96, Math.ceil(len / 0.5)));
    return { pts: Array.from({ length: n + 1 }, (_, i) => at(u0 + ((u1 - u0) * i) / n)), kind: type === T.GeomAbs_Circle ? "circle" : "other" };
  } finally {
    ad.delete();
  }
}

export async function exportBodies(features: Feature[], format: ExportFormat, only?: string[]): Promise<Blob> {
  const { ctx, numbers } = await run(features);
  const shapes = [...ctx.bodies.entries()].filter(([id]) => !only || only.includes(id));
  if (shapes.length === 0) throw new Error("Nothing to export");
  const names = bodyNames(features, [...ctx.bodies.keys()], numbers);
  if (format === "mesh") {
    // As fine as the STL (the view's own mesh is coarser, for speed).
    const out = shapes.map(([id, s]) => {
      const m = printMesh(s);
      return { id, positions: Array.from(m.vertices), indices: Array.from(m.triangles) };
    });
    return new Blob([JSON.stringify(out)], { type: "application/json" });
  }
  if (format === "step") return exportSTEP(shapes.map(([id, shape]) => ({ shape, name: names.get(id)! })));
  // (Written here from the bodies' own meshes: OpenCascade's writer meshes them
  // all as one shape first - gigabytes for a body of thousands of faces.)
  return new Blob([binarySTL(shapes.map(([, s]) => printMesh(s))) as BlobPart], { type: "application/sla" });
}

/**
 * A body's mesh for printing - of a copy of it: meshed itself, the body kept
 * those triangles (ten times the view's, megabytes on a part of a few hundred
 * faces) for as long as it was there, and every later copy of it carried them.
 * Kept here with the body instead, for the next file made of it.
 */
const printMeshes = new WeakMap<Shape3D, FaceMesh>();
function printMesh(s: Shape3D): FaceMesh {
  let m = printMeshes.get(s);
  if (!m) printMeshes.set(s, (m = meshFaces(deepCopy(s), PRINT_TOLERANCE, PRINT_ANGLE)));
  return m;
}

/**
 * How finely a mesh for printing (STL, 3MF) follows curved surfaces: within
 * 0.01 mm, and a facet per 0.05 rad (under 3°). Slicers draw each facet flat,
 * so round faces showed as polygons at the view's coarser setting.
 */
const PRINT_TOLERANCE = 0.01;
const PRINT_ANGLE = 0.05;

export async function regenerate(features: Feature[], saved = false): Promise<RegenResult> {
  const t0 = performance.now();
  const { ctx, errors, numbers, notes, whole } = await run(features, saved);
  const names = bodyNames(features, [...ctx.bodies.keys()], numbers);
  const meshes: BodyMesh[] = [];
  for (const [id, shape] of ctx.bodies) {
    try {
      meshes.push(meshBody(id, names.get(id)!, shape));
    } catch (err) {
      if (isFault(err)) {
        // The last step that changed this body is the one whose result can't be shown.
        let k = cache.length - 1;
        while (k > 0 && cache[k - 1].ctx.bodies.get(id) === shape) k--;
        if (cache[k]) blame(cache[k].key);
        throw new KernelFault(features[k]?.id ?? baseId(id));
      }
      errors.push({ featureId: baseId(id), message: `Could not display body: ${errorText(err)}` });
    }
  }
  const sketchPlanes: Record<string, PlaneDef> = {};
  const sketchBoundaries: Record<string, SketchEntity[]> = {};
  // Sketches that follow a body: their curves where the engine put them (the page takes them as the sketch's own).
  let sketchEntities: Record<string, SketchEntity[]> | undefined;
  const asGiven = new Map(features.map((f) => [f.id, f]));
  for (const [id, s] of ctx.sketches) {
    sketchPlanes[id] = s.plane;
    if (s.boundary.length) sketchBoundaries[id] = s.boundary;
    const f = asGiven.get(id);
    if (f?.type === "sketch" && f.links?.length && s.entities !== f.entities && JSON.stringify(s.entities) !== JSON.stringify(f.entities)) (sketchEntities ??= {})[id] = s.entities;
  }
  return { bodies: meshes, errors, notes, sketchPlanes, sketchBoundaries, ...(sketchEntities ? { sketchEntities } : {}), ...(whole ? { whole } : {}), planes: [...ctx.planes.values()], axes: [...ctx.axes.values()], ms: performance.now() - t0 };
}

/**
 * Replay features in order. Results are cached per feature, keyed by the JSON
 * of every feature up to it, so editing feature k only rebuilds k onwards.
 */
/** The solids of the last rebuild (for tests that check the real geometry, not just its mesh). */
let lastBodies: Map<string, Shape3D> = new Map();
export function debugBodies(): Map<string, Shape3D> {
  return lastBodies;
}

async function run(features: Feature[], saved = false) {
  useSafeBooleans();
  useReleases();
  // Steps after the History's breakpoint: off, like suppressed ones.
  if (features.some((f) => f.rolledBack)) features = features.map((f) => (f.rolledBack && !f.suppressed ? { ...f, suppressed: true } : f));
  const errors: FeatureError[] = [];
  const notes: FeatureError[] = [];
  let ctx: Ctx = fork({ bodies: new Map(), sketches: new Map(), planes: new Map(), axes: new Map(), freeforms: new Map(), sweeps: new Map() });
  switchedOff = new Set(features.filter((f) => f.suppressed).map((f) => f.id));
  const off = [...switchedOff].sort().join();
  // The steps as last rebuilt (by step, wherever in the list they are now).
  const before = new Map<string, CacheEntry>();
  for (const e of [...cache, ...savedCache, ...alsoCache]) if (e.id && !before.has(e.id)) before.set(e.id, e);
  rebuildStats.ran = rebuildStats.kept = rebuildStats.reused = 0;
  smoothSteps = new Set(features.filter((f) => f.type === "faceFreeform").map((f) => f.id));
  let key = "";
  const next: CacheEntry[] = [];
  let hit = true;
  // Which of a step's faces is which, for the steps so far (a step looking for
  // the face it was built on asks; so does the mesh, for what gets picked next).
  const origins = new Map<string, OriginOf>();
  setOrigins(origins);

  for (let i = 0; i < features.length; i++) {
    const f = features[i];
    // Chained hashes, not the text itself: a key holding every step's JSON
    // grew with the square of the project (an import's megabytes in each one).
    // (A step's `whole` is what it worked out the first time, taken in by the
    // page: not a change to build again for.)
    const text = JSON.stringify((f.type === "boolean" || f.type === "delete") && f.whole ? { ...f, whole: undefined } : f, shortBig);
    const json = `${hash53(text, 3)}.${text.length}`;
    key = chainKey(key, text);
    const cached: CacheEntry | undefined = !hit ? undefined : cache[i]?.key === key ? cache[i] : savedCache[i]?.key === key ? savedCache[i] : alsoCache[i]?.key === key ? alsoCache[i] : undefined;
    hit = !!cached;
    let entry: CacheEntry;
    const was = before.get(f.id);
    if (cached) {
      entry = cached;
      rebuildStats.kept++;
    } else if (was && !f.suppressed && !crashed.has(key) && unchangedFor(was, json, ctx, off)) {
      // Something before it changed, but nothing it read: its result as it was, on the model as it is now.
      const out = fork(ctx);
      for (const [kind, k, v, there] of was.delta!) {
        if (there) Map.prototype.set.call(out[kind], k, v);
        else Map.prototype.delete.call(out[kind], k);
      }
      entry = { ...was, key, ctx: out, input: ctx };
      rebuildStats.reused++;
    } else {
      const out = fork(ctx);
      entry = { key, ctx: out, id: f.id, json, off, input: ctx };
      rebuildStats.ran++;
      if (!f.suppressed) {
        const reads: Reads = { one: new Map(), all: new Set(), written: new Set() };
        entry.reads = reads;
        try {
          editNotes.length = 0;
          sameSizesAgain();
          if (crashed.has(key)) throw new Error(crashed.get(key));
          if (damaged(f)) throw new Error(DAMAGED_TEXT);
          reading = reads;
          const touched = touchedBodies(f, ctx);
          // An edit works on copies of the bodies it may touch: OpenCascade is
          // allowed to adjust the shapes it is given, and the earlier steps'
          // results (kept in the cache) must never change - not even when this
          // step fails. Bodies it leaves alone get their originals back.
          const copies = new Map<string, Shape3D>();
          if (GUARDED.has(f.type)) {
            for (const id of touched) {
              const b = out.bodies.get(id);
              if (!b || out.freeforms.has(id)) continue;
              const c = deepCopy(b);
              inheritTags(b, c);
              // (The same shape: its volume is known - a big body's, measured
              // again on every step's copy, was a quarter of a small cut's time.)
              const v = volumes.get(b);
              if (v !== undefined) volumes.set(c, v);
              copies.set(id, c);
              out.bodies.set(id, c);
            }
          }
          await apply(f, out);
          entry.origin = originsOf(f, out);
          reading = null;
          if (entry.origin) origins.set(f.id, entry.origin);
          for (const [id, c] of copies) if (out.bodies.get(id) === c) out.bodies.set(id, ctx.bodies.get(id)!);
          // Nothing kilometres across, or away: a typo (a size with six noughts
          // too many), and more than the engine or the view can work with.
          for (const [id, after] of out.bodies) {
            if (after === ctx.bodies.get(id)) continue;
            const [lo, hi] = after.boundingBox.bounds;
            const reach = Math.max(...lo.map(Math.abs), ...hi.map(Math.abs));
            // (An empty result has an upside-down box: left to the checks below.)
            if (lo[0] <= hi[0] && !(reach < MAX_REACH)) throw new Error("This would reach more than 10 km from the origin - check its values (a typo?)");
            // ...and nothing scaled away to a speck (a factor of 0.0000008).
            if (lo[0] <= hi[0] && Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) < 1e-4) throw new Error("This would be smaller than a ten-thousandth of a mm - check its values (a typo?)");
          }
          // Every edit of a solid ends in one: checked (and tidied) before it counts.
          if (GUARDED.has(f.type)) {
            for (const [id, after] of [...out.bodies]) {
              const before = ctx.bodies.get(id);
              if (after === before) continue;
              // A freeform left as an open surface (a sheet) isn't a solid to check; a solid
              // freeform is - its edits are checked like any body's.
              if (before && (out.freeforms.has(id) || ctx.freeforms.has(id)) && !subShapes(before, "SOLID").length) continue;
              // Offsetting a face of the body itself is a face move: it doesn't split it either.
              const inPlace = f.type === "extrude" && f.source.kind === "face" && f.mode !== "new" && f.target === f.source.face.body;
              let kept: Shape3D | null;
              try {
                kept = guardEdit(before, after, !NO_SPLIT.has(f.type) && !inPlace);
              } catch (err) {
                // A shell that came out torn or broken: its walls ran into each other ("would tear the body open" said nothing of walls).
                if (f.type !== "shell" || isFault(err)) throw err;
                throw new Error(/break the body into pieces/.test(errorText(err)) ? SHELL_LOOSE : WALLS_CLASH);
              }
              // Cut away to dust: the body is gone.
              if (kept) out.bodies.set(id, kept);
              else out.bodies.delete(id);
            }
          }
          // Which step made each face: kept from what it was made from, this step's own otherwise.
          // (Bodies the step names; the others were only there - see tagBody.)
          const named = touchedBodies(f, ctx, false);
          const from = [...named.map((id) => ctx.bodies.get(id)!), ...named.flatMap((id) => (copies.has(id) ? [copies.get(id)!] : []))];
          const others = touched.filter((id) => !named.includes(id)).map((id) => ctx.bodies.get(id)!);
          for (const [id, body] of out.bodies) {
            const was = ctx.bodies.get(id);
            if (body !== was) tagBody(body, f.id, was ? [was, ...from] : from, was ? others.filter((o) => o !== was) : others);
          }
          if (editNotes.length) entry.note = [...new Set(editNotes)].join(" ");
          // Anything but a move/scale changing a freeform body makes it an ordinary body.
          if (f.type !== "freeform" && f.type !== "transform") for (const id of [...out.freeforms.keys()]) if (out.bodies.get(id) !== ctx.bodies.get(id)) out.freeforms.delete(id);
        } catch (err) {
          reading = null;
          if (isFault(err)) {
            blame(key);
            console.error(err);
            throw new KernelFault(f.id);
          }
          entry.error = errorText(err);
          const sketches = f.type === "sketch" ? new Noted("sketches", ctx.sketches) : ctx.sketches;
          if (f.type === "sketch") Map.prototype.set.call(sketches, f.id, { ...f, boundary: [] });
          entry.ctx = { ...ctx, sketches };
        }
        // What it changed in the model (and each of those as it was is something it went by).
        entry.delta = [];
        for (const kind of KINDS) {
          const [a, b] = [entry.ctx[kind] as Map<string, unknown>, ctx[kind] as Map<string, unknown>];
          if (a === b) continue;
          for (const k of new Set([...rawEntries(a).map((x) => x[0]), ...rawEntries(b).map((x) => x[0])])) {
            if (rawGet(a, k) === rawGet(b, k) && rawHas(a, k) === rawHas(b, k)) continue;
            entry.delta.push([kind, k, rawGet(a, k), rawHas(a, k)]);
            if (!reads.one.has(`${kind}|${k}`)) reads.one.set(`${kind}|${k}`, rawGet(b, k));
          }
        }
      }
    }
    if (entry.origin) origins.set(f.id, entry.origin);
    if (entry.error) errors.push({ featureId: f.id, message: entry.error });
    if (entry.note && !entry.error) notes.push({ featureId: f.id, message: entry.note });
    ctx = entry.ctx;
    next.push(entry);
  }
  cache = next;
  if (saved) savedCache = next;
  lastBodies = ctx.bodies;
  // Steps that don't say yet which patterns they used whole: as they were made.
  let whole: Record<string, string[]> | undefined;
  features.forEach((f, i) => {
    if ((f.type !== "boolean" && f.type !== "delete") || f.whole || f.suppressed) return;
    const ids: unknown = f.type === "boolean" ? f.tools : f.bodies;
    const there = next[i]?.input?.bodies;
    // (Not for a step that failed: its saved values may be damaged.)
    if (there && !next[i].error && Array.isArray(ids) && ids.every((x) => typeof x === "string")) (whole ??= {})[f.id] = wholeOf(ids, new Set(rawEntries(there).map(([k]) => k)));
  });
  // Bodies are numbered in the order they first appeared (a body that's
  // deleted later keeps its number used, so the others don't change names).
  const numbers = new Map<string, number>();
  for (const e of next) for (const id of e.ctx.bodies.keys()) if (!numbers.has(id)) numbers.set(id, numbers.size + 1);
  return { ctx, errors, numbers, notes, whole };
}

async function apply(f: Feature, ctx: Ctx): Promise<void> {
  const { bodies } = ctx;
  switch (f.type) {
    case "sketch": {
      const plane = f.attachedTo ? followFace(f, bodies) : f.onPlane ? followPlane(f, ctx) : f.plane;
      // On a face, the face outline takes part in regions: a line across the face splits it.
      const outline = f.attachedTo ? faceBoundary(f.attachedTo, plane, bodies) : [];
      // Offsets of the outline, made from it as it is now (they follow the face).
      const boundary = [...outline, ...outlineOffsetCurves(outline, f.outlineOffsets)];
      // Curves that follow a body's edge go where it is now, the rest by its dimensions to them.
      const entities = f.links?.length ? followEdges(f, plane, bodies) : f.entities;
      const state: SketchState = { ...f, entities, plane, boundary };
      // The same sketch as last time, to the last digit (the page took the
      // curves the engine moved as the sketch's own): it is that one, and
      // the steps made from it have nothing new to read.
      const text = JSON.stringify(state);
      const was = sketchWas.get(f.id);
      if (was?.text === text) ctx.sketches.set(f.id, was.state);
      else {
        sketchWas.set(f.id, { text, state });
        ctx.sketches.set(f.id, state);
      }
      return;
    }

    case "extrude": {
      const ext = f.extent ?? "distance";
      if (ext === "distance" && Math.abs(f.distance) < 1e-6) throw new Error("Distance is zero");
      if (ext === "to" && f.symmetric) throw new Error("Up to works one way only - switch Sides back to One side");
      if (ext === "to" && !f.to?.face && !f.to?.plane) throw new Error("Pick the face or plane it goes up to");
      // Where it starts: at the shape, or `start` from it along its normal.
      const startFaces = () => {
        const src = sourceFaces(f.source, ctx);
        return f.start ? src.map(({ face, normal }) => ({ face: face.clone().translate(scale(normal, f.start!)) as Face, normal })) : src;
      };
      // Up to: the face (where it is now) or the plane it stops at.
      const upTo = ext === "to" ? extrudeTarget(f.to!, ctx) : null;
      // How far: the distance, or far enough to come out of everything (the way the distance's sign says, or towards the target).
      let distance = f.distance;
      if (ext === "through" && !ctx.bodies.size) throw new Error("Through all goes through the bodies there are - there are none yet: set a Distance");
      if (ext !== "distance") {
        const src = startFaces();
        const reach = reachOf(ctx, src.map((s) => s.face as unknown as Shape3D), upTo?.shape);
        const n = src[0]?.normal ?? [0, 0, 1];
        const c = src[0]?.face.center.toTuple() as Vec3 | undefined;
        const way = upTo && c ? Math.sign(dot(sub(upTo.point, c), n)) || 1 : Math.sign(f.distance) || 1;
        distance = way * reach;
      }
      const plain = ext === "distance" && !f.start && !f.draft;
      // Pushing/pulling a face of its own body offsets it: the neighbouring faces
      // extend along their own surfaces (a round side stays round).
      const tapered = f.taper !== undefined && Math.abs(f.taper - 1) > 1e-9;
      if (tapered && f.symmetric) throw new Error("Taper works one way only - switch Sides back to One side");
      if (tapered) {
        // Sides leaning in (or out): each shape's outline to a scaled copy at the far end.
        // Pieces that meet are one shape first: a circle drawn on a small face
        // is split by the face's outline into a disc and a ring round it (the
        // ring was refused as "a shape with a hole", and each piece would have
        // shrunk towards its own middle).
        if (ext !== "distance" || f.draft) throw new Error("Taper end % works with a set distance and no draft - set Taper end back to 100%");
        const src = startFaces();
        const parts = mergedFaces(src.map((s) => s.face), src[0]?.normal ?? [0, 0, 1]).map((face) => ({ face, normal: src[0].normal })).map(({ face, normal }) => {
          // (replicad's outerWire() and innerWires() free the face they're asked
          // of: they're asked of copies.)
          const c = face.center.toTuple() as Vec3;
          if (face.clone().innerWires().length) throw new Error("Taper works on shapes without holes");
          const w0 = face.clone().outerWire();
          const k = Math.max(0.002, f.taper!);
          // Straight-edged shapes: flat sides (a loft makes them curved surfaces,
          // and then nothing that needs a flat face - sketch on it, move it - works).
          const flat = taperedPrism(face, c, normal, k, distance);
          if (flat) return flat;
          const w1 = w0.clone().scale(k, c).translate(scale(normal, distance));
          try {
            return loft([w0, w1], { ruled: true }) as Shape3D;
          } catch {
            throw new Error("This shape can't be tapered");
          }
        });
        combine(f.id, f.mode, f.target, fuseAll(parts), distance < 0, ctx);
        return;
      }
      if (plain && f.source.kind === "face" && f.mode !== "new" && f.mode !== "intersect" && f.target === f.source.face.body && !f.symmetric) {
        const body = need(bodies, f.target);
        const face = resolveFace(body, f.source.face);
        const d = f.mode === "cut" ? -Math.abs(f.distance) : f.mode === "join" ? Math.abs(f.distance) : f.distance;
        // The end of a sweep pushed in: shortened along its path, the new end
        // square to the path there (not the old end's plane slid along).
        const trimmed = d < 0 ? trimSweepEnd(body, face, -d, ctx) : null;
        if (trimmed) {
          bodies.set(f.target, staysClosed(body, trimmed));
          return;
        }
        try {
          const out = staysClosed(body, offsetFace(body, face, d));
          // Hair-thin faces left behind (a face pushed over a fillet): a straight push is cleaner.
          if (face.geomType === "PLANE" && slivers(out) > slivers(body)) throw new Error("slivers");
          bodies.set(f.target, out);
          return;
        } catch (err) {
          // Faces whose neighbours don't enclose them still get a straight push -
          // but not one with a fillet on it (the old fillet would stay standing).
          if (face.geomType !== "PLANE" || hasBlends(body, face)) throw err;
        }
      }
      // Symmetric: from `distance` behind the shape to `distance` in front.
      const parts = startFaces().map(({ face, normal }) => {
        const straight = f.symmetric ? basicFaceExtrusion(face.clone().translate(scale(normal, -distance)), new Vector(normal).multiply(2 * distance)) : basicFaceExtrusion(face, new Vector(normal).multiply(distance));
        // Draft: the sides lean from the shape's own plane (both ways from it, symmetric).
        return f.draft ? drafted(straight, scale(normal, Math.sign(distance) || 1), face.center.toTuple() as Vec3, f.draft) : straight;
      });
      let solid = fuseAll(parts);
      // Up to: what goes past the face or plane is cut off.
      if (upTo) solid = trimmedTo(solid, upTo, startFaces()[0]?.face.center.toTuple() as Vec3);
      // Auto: other bodies the extrusion runs into get cut through. Drawn on
      // its own (no body it belongs to), it then only cuts - no new body.
      if (f.mode === "auto") {
        const hit = overlapping(solid, ctx, f.target);
        for (const id of hit) {
          const cut = checkedBoolean("cut", need(bodies, id), solid);
          if (isEmpty(cut)) bodies.delete(id);
          else bodies.set(id, cut);
          ctx.freeforms.delete(id);
        }
        if (hit.length && !f.target) return;
      }
      combine(f.id, f.mode, f.target, solid, distance < 0, ctx);
      return;
    }

    case "revolve": {
      if (Math.abs(f.angle) < 1e-6) throw new Error("Angle is zero");
      const axis = resolveAxis(f.axis, ctx);
      if (f.travel && Math.abs(f.travel) > 1e-9) {
        // Moving along the axis while turning: a helical sweep (threads, springs).
        const parts = withHoles(f.source, ctx, (w) => helicalSweep(w, axis.origin, norm(axis.dir), f.angle, f.travel!));
        combine(f.id, f.mode, f.target, fuseAll(parts), false, ctx);
        return;
      }
      if (Math.abs(f.angle) > 360 + 1e-6) throw new Error("More than one turn needs a Travel along the axis (or it overlaps itself)");
      const whole = Math.abs(Math.abs(f.angle) - 360) < 1e-6;
      const turnFace = (face: Face): Shape3D => {
        // A whole ellipse turned all the way round is a ring with one face and
        // no edges: later unions break it (a combustor ring took one fuel
        // nozzle, then came out inside out). Two halves, joined, are sound.
        if (whole && face.edges.length === 1 && face.edges[0].geomType === "ELLIPSE") {
          const half = revolution(face, axis.origin, axis.dir, 180) as Shape3D;
          return half.fuse(half.clone().rotate(180, axis.origin, axis.dir));
        }
        return revolution(face, axis.origin, axis.dir, f.angle) as Shape3D;
      };
      // A shape across the axis turns into itself (the kernel only said it
      // "could not compute this").
      for (const { face } of sourceFaces(f.source, ctx)) if (crossesAxis(face, axis.origin, norm(axis.dir))) throw new Error("The shape crosses the axis - it has to stay on one side of it (touching it is fine)");
      const turn = () => sourceFaces(f.source, ctx).map(({ face }) => turnFace(face));
      let parts: Shape3D[];
      try {
        parts = turn();
      } catch {
        // A profile whose exact spline won't turn (it touches the axis awkwardly): a close fit does.
        parts = withFittedSplines(turn);
      }
      combine(f.id, f.mode, f.target, fuseAll(parts), false, ctx);
      return;
    }

    case "sweep": {
      const spine = pathWire(f.path, ctx);
      // The profile keeps its turn round the path as it goes (OpenCascade's
      // corrected Frenet), not the path's own Frenet frame: that one flips
      // half a turn where a bend changes side (an S curve) and is undefined
      // where the path runs straight, so the tube broke into pieces that
      // jumped sideways there - a profile off the path's centre most of all.
      const k = f.scale ?? 1;
      if (!(k > 0)) throw new Error("The end size must be more than 0");
      const twist = f.twist ?? 0;
      const parallel = f.orientation === "parallel";
      if (parallel && Math.abs(twist) > 1e-9) throw new Error("A twist turns the profile with the path: set Orientation to Normal to path");
      const corner = f.corner === "mitre" ? "right" : "round";
      // Moved onto the path: its centre to the path's nearer end, turned square to the path there.
      const place = f.position === "start" ? onPathStart(sourceFaces(f.source, ctx), spine) : null;
      // Along a straight line square to the profiles, from one of its ends,
      // unturned and the same size all the way: an extrusion, made as one (the
      // sweep's faces looked the same but wouldn't take a chamfer round a
      // gear's teeth that the extrusion's took).
      const ends = Math.abs(k - 1) < 1e-9 && Math.abs(twist) < 1e-9 && !place ? straightRun(spine) : null;
      if (ends) {
        const faces = sourceFaces(f.source, ctx);
        const [a, b] = ends;
        const L = dist(a, b);
        const runs = faces.map(({ face, normal }) => {
          const n = norm(normal);
          if (len(cross(norm(sub(b, a)), n)) > 1e-9) return null;
          const o = face.center.toTuple() as Vec3;
          if (Math.abs(dot(sub(a, o), n)) < L * 1e-9) return sub(b, a);
          if (Math.abs(dot(sub(b, o), n)) < L * 1e-9) return sub(a, b);
          return null;
        });
        if (runs.every((r) => r)) {
          const parts = faces.map(({ face }, i) => basicFaceExtrusion(face, new Vector(runs[i]!)) as Shape3D);
          combine(f.id, f.mode, f.target, fuseAll(parts), false, ctx);
          ctx.sweeps.set(f.id, spine);
          return;
        }
      }
      const scaled = Math.abs(k - 1) > 1e-9;
      const twisted = Math.abs(twist) > 1e-9;
      // Facing the same way all along, the profile has no thickness where the
      // path runs in the profile's own plane (up a post, then sideways): that
      // leg came out missing without a word, or as a body "damaged", and a
      // ring's never came back at all (the engine hung). Said, before it's tried.
      if (parallel) {
        const src = sourceFaces(f.source, ctx);
        const facing = place ? norm(spine.tangentAt(dist(src[0].face.center.toTuple() as Vec3, spine.startPoint.toTuple() as Vec3) <= dist(src[0].face.center.toTuple() as Vec3, spine.endPoint.toTuple() as Vec3) ? 0 : 1).toTuple() as Vec3) : norm(src[0]?.normal ?? [0, 0, 1]);
        if (runsAcross(spine, facing) > 0.02) throw new Error("Facing the same way, the profile slides along its own plane on part of this path and has no thickness there - turn the profile to face along that part, or set Orientation to Normal to path");
      }
      // One profile along one path is one solid. Round a sharp corner of the
      // path a profile that changes size, or turns as it goes, came out in two
      // pieces run through each other (or broken): said as what it is.
      const corners = (scaled || twisted) && sharpCorners(spine);
      const cornerTrouble = () =>
        new Error(`A profile that ${scaled && twisted ? "changes size and turns" : scaled ? "changes size" : "turns"} as it goes can't get round a sharp corner of the path - round the corner (a small fillet in the path's sketch), or set ${scaled && twisted ? "End size back to 100% and Twist to 0" : scaled ? "End size back to 100%" : "Twist back to 0"}`);
      const whole = (part: Shape3D): Shape3D => {
        const pieces = subShapes(part, "SOLID").length;
        if (pieces === 1 && !(corners && !shapeValid(part))) return part;
        if (corners) throw cornerTrouble();
        if (twisted) throw new Error("The twist didn't build along this path - try a smoother path (no sharp corners) or less twist");
        throw new Error("The sweep came apart along this path - try a smoother path (no sharp corners, no tight turns)");
      };
      // (With holes - a tube: each wire's sweep may be sound and the one cut from the other still not.)
      const made = () => withHoles(f.source, ctx, (w0, outer0) => {
        const w = place ? place(w0) : w0;
        const outer = place ? place(outer0) : outer0;
        const law = scaled ? scaleLaw(spine, k) : null;
        if (parallel) return whole(flatFaces(fixedSweep(w, spine, corner, law)));
        // A circle round the path's start, square to it, is the same twisted or not (a gear's bore): swept
        // plainly it stays a true cylinder (twisted, a spline with a winding seam that threads couldn't use).
        if (!twisted || roundAboutPath(w, spine)) return whole(flatFaces(genericSweep(w, spine, { frenet: false, transitionMode: corner, law }) as Shape3D));
        // Twisted: the profile's sideways direction follows a curve wound round the path.
        const reach = Math.max(1, len(sub(...(outer.boundingBox.bounds as [Vec3, Vec3]))));
        try {
          return whole(flatFaces(genericSweep(w, spine, { auxiliarySpine: twistGuide(spine, twist, reach), transitionMode: "right", law }) as Shape3D));
        } catch (err) {
          if (err instanceof Error && /Could not sweep/.test(err.message)) throw new Error("The twist didn't build along this path - try a smoother path (no sharp corners) or less twist");
          throw err;
        }
      });
      let parts: Shape3D[];
      try {
        parts = made();
      } catch (err) {
        if (!corners || isFault(err) || (err instanceof Error && /sharp corner/.test(err.message))) throw err;
        throw cornerTrouble();
      }
      if (corners && parts.some((part) => subShapes(part, "SOLID").length !== 1 || !shapeValid(part))) throw cornerTrouble();
      combine(f.id, f.mode, f.target, fuseAll(parts), false, ctx);
      ctx.sweeps.set(f.id, spine);
      return;
    }

    case "loft": {
      if (f.sections.length < 2) throw new Error("Pick at least two profiles");
      // Each section's own plane (a profile's sketch, or the face).
      const frames = f.sections.map((s) => sectionFrame(s, ctx));
      let order = f.sections.map((_, i) => i);
      const n0 = frames[0].normal;
      // Parallel sections go in their order along the normal, whatever order they were picked in
      // (a loft that doubles back on itself isn't a solid).
      if (!f.closed && !f.guide && frames.every((fr) => Math.abs(dot(fr.normal, n0)) > 0.999)) {
        const h = (i: number) => dot(sub(frames[i].origin, frames[0].origin), n0);
        order.sort((a, b) => h(a) - h(b));
        for (let k = 1; k < order.length; k++) if (Math.abs(h(order[k]) - h(order[k - 1])) < 1e-6) throw new Error("Two profiles lie on the same plane: loft needs them one above another");
      }
      // The same profile picked twice counts once.
      order = order.filter((i, k) => k === 0 || JSON.stringify(f.sections[i]) !== JSON.stringify(f.sections[order[k - 1]]));
      if (order.length < 2) throw new Error("Pick at least two different profiles");
      let wires = order.map((i) => sourceWires(f.sections[i], ctx)[0]);
      if ((f.startContinuity || f.endContinuity) && !f.guide && !f.closed) {
        if (f.ruled) throw new Error("Straight sides can't also leave a profile smoothly: switch off Straight sides");
        const nrm = order.map((i) => frames[i].normal);
        wires = withEndPulls(wires, nrm, f.startContinuity, f.startWeight ?? 1, f.endContinuity, f.endWeight ?? 1);
      }
      let shape: Shape3D;
      if (f.rails?.length || f.connections?.length) {
        if (f.guide || f.closed) throw new Error("Guide curves and connections can't be used with a centre line or a closed loop");
        const rails = (f.rails ?? []).map((r) => pathWire(r, ctx));
        const conns = (f.connections ?? []).map((c) => order.map((i) => c[i]));
        shape = railLoft(wires, rails, conns);
      } else if (f.guide || f.closed) {
        if (f.closed && wires.length < 3 && !f.guide) throw new Error("A closed loop needs at least three profiles");
        shape = loftAlong(wires, f.guide ? pathWire(f.guide, ctx) : null, !!f.closed);
      } else
        try {
          // One smooth side where the sections' starts are in line already (see loftAlign.ts).
          const inLine = loftInLine(wires, f.ruled);
          shape = inLine && shapeValid(inLine) && volumeOf(inLine) > 0 ? inLine : loft(wires, { ruled: f.ruled });
        } catch {
          throw new Error("These profiles can't be lofted together");
        }
      combine(f.id, f.mode, f.target, shape, false, ctx);
      return;
    }

    case "fillet":
    case "chamfer": {
      const byBody = new Map<string, EdgeRef[]>();
      for (const e of f.edges) byBody.set(e.body, [...(byBody.get(e.body) ?? []), e]);
      for (const [bodyId, refs] of byBody) {
        const body = need(bodies, bodyId);
        // (An edge next to nothing in length - the end of a sliver, picked with the
        // rest of a face's outline before such ends were cleared away - isn't one to round.)
        const real = refs.filter((r) => r.length > 1e-4);
        // A sliver of a picked run gone (a blade's root cut short where the hub's seam
        // crossed it, moved when the blade did) is skipped: the round runs on along the
        // smooth run it was part of. A whole edge gone still says so.
        const picked = real.length ? real : refs;
        const longest = Math.max(...picked.map((r) => r.length));
        const found = picked.map((r) => {
          try {
            return resolveEdge(body, r, true);
          } catch (err) {
            if (err instanceof Error && err.message === EDGE_GONE && r.length < longest * 0.05) return null;
            throw err;
          }
        });
        const edges = found.filter((e): e is Edge => !!e);
        if (!edges.length) throw new Error(EDGE_GONE);
        if (edges.length < found.length) editNotes.push(`${found.length - edges.length} tiny piece${found.length - edges.length > 1 ? "s" : ""} of the edges it was built on ${found.length - edges.length > 1 ? "are" : "is"} gone - the rest are ${f.type === "fillet" ? "rounded" : "chamfered"}.`);
        let result: Shape3D | null = null;
        // Two-Distance chamfer: each edge's first distance runs along one of
        // its two faces (Flip: the other one), the second along the other.
        const d2 = f.type === "chamfer" && f.distance2 !== undefined && f.distance2 > 0 ? f.distance2 : null;
        const sideOf = (e: Edge): Face => {
          const two = body.faces.filter((fc) => fc.edges.some((x) => x.isSame(e)));
          if (!two.length) throw new Error("That edge has no face beside it to measure the chamfer along");
          return two[f.flip && two.length > 1 ? 1 : 0];
        };
        const twoDistance = (r: number) =>
          body.chamfer((e: Edge) => (edges.some((x) => x.isSame(e)) ? { distances: [r, (d2! * r) / f.radius] as [number, number], selectedFace: (finder) => finder.inList([sideOf(e)]) } : null));
        // Variable fillet: the radius runs evenly from one end of each edge to the other.
        const r2 = f.type === "fillet" && f.radius2 !== undefined && f.radius2 > 0 && Math.abs(f.radius2 - f.radius) > 1e-9 ? f.radius2 : null;
        const variable = (r: number) =>
          body.fillet((e: Edge) => {
            if (!edges.some((x) => x.isSame(e))) return null;
            const ends: [number, number] = [r, (r2! * r) / f.radius];
            return f.flip ? [ends[1], ends[0]] : ends;
          });
        if (f.type === "fillet" && f.g2 && (r2 || f.chord)) throw new Error("Smooth (G2) takes one radius - set Type to Constant and Size to Radius");
        const edge = (r: number) =>
          f.type === "fillet" && f.g2 ? g2Fillet(body, edges, r) : f.type === "fillet" ? (f.chord ? chordFillet(body, edges, r, r2 ? (r2 * r) / f.radius : r, !!f.flip) : r2 ? variable(r) : body.fillet(r, (finder) => finder.inList(edges))) : d2 ? twoDistance(r) : body.chamfer(r, (finder) => finder.inList(edges));
        try {
          result = edge(f.radius);
        } catch (err) {
          if (err instanceof Error && !/WebAssembly|kernel/i.test(err.message)) throw err;
          // Exactly the size that uses up a face (4 mm on both edges of an
          // 8 mm block: a full round): the two roundings meet with nothing
          // between, and that exact case fails where 3.999 works. A hair
          // less gives the same shape, to a millionth of a millimetre.
          for (const k of [1 - 1e-6, 1 - 1e-5, 1 - 1e-4]) {
            try {
              result = edge(f.radius * k);
              break;
            } catch {
              // a bit less again
            }
          }
        }
        // Too big for a face beside it (OpenCascade gives up): built as a true round that
        // cuts on through that face's far edge (overflow: keep surface).
        if (!result && f.type === "fillet" && !f.g2 && !r2 && !f.chord) {
          try {
            result = blendFillet(body, edges, f.radius, false);
            editNotes.push("The round was too big for a face beside it, so it cuts on through that face's far edge (still exactly round).");
          } catch {
            result = null;
          }
        }
        if (result && f.type === "fillet" && !f.g2 && (f.setback ?? 0) > 0) result = setbackCorners(result, edges, f.setback!, f.radius * Math.max(1, r2 ? r2 / f.radius : 1));
        if (!result) {
          const what = f.type === "fillet" ? "radius" : "distance";
          throw new Error(`That ${f.type} doesn't fit here - the ${what} is too big for the faces around ${edges.length > 1 ? "those edges" : "that edge"}. Try a smaller ${what}.`);
        }
        bodies.set(bodyId, result);
      }
      return;
    }

    case "shell": {
      const body = need(bodies, f.body);
      let faces = f.faces.map((r) => resolveFace(body, r));
      // Every face picked (a ball's one round face) leaves no wall to keep: hollow it sealed instead.
      if (faces.length && body.faces.every((g) => faces.some((h) => h.isSame(g)))) {
        faces = [];
        editNotes.push("Every face of the body was picked, so there's no opening: it's hollow inside, sealed. Pick fewer faces for an opening.");
      }
      // A freeform: drop the picked cage faces and thicken the rest inward -
      // exact, where shelling its smooth surfaces is unreliable.
      const ff = ctx.freeforms.get(f.body);
      if (ff && faces.length) {
        bodies.set(f.body, shellFreeform(ff, faces, Math.abs(f.thickness)));
        ctx.freeforms.delete(f.body);
        return;
      }
      // Positive thickness shells inward (negative grows outward with rounded corners).
      const t = Math.abs(f.thickness);
      const v0 = Math.abs(measureVolume(body));
      const hollowed = (s: Shape3D | null): s is Shape3D => !!s && Math.abs(Math.abs(measureVolume(s)) - v0) > 1e-6 * v0;
      // A shell to trust: hollow, a sound solid, a wall behind every face it
      // kept and nothing left deep inside. OpenCascade can "succeed" without
      // hollowing anything, or hollowing only a corner of it - or hollow it
      // and leave a wall out: where two faces are closer together than two
      // walls (a pocket 1.7 mm from a hole, 1 mm walls) it dropped the
      // pocket's walls without a word, the pocket a window into the hollow.
      const kept = body.faces.filter((g) => !faces.some((h) => h.isSame(g)));
      const gaps = openEdges(body).length;
      const good = (s: Shape3D | null): s is Shape3D => hollowed(s) && shapeValid(s) && openEdges(s).length <= gaps && wallsStand(body, s, kept, t) && hollowInside(body, s, kept, t);
      // The ways there are, in turn: in one step (no face picked: that gives
      // only the inner core back - a battery case came out solid); hollowed
      // with an offset copy of the body, the openings cut through (many-faced
      // shapes trip the one-step shell); and that a hair thicker - a wall
      // exactly as thick as the corners are round (2 mm walls in a box with
      // 2 mm corners) has inside corners that shrink to nothing, and that
      // exact case defeats both: a hair thicker gives the sharp inside corner
      // it should have.
      const ways: (() => Shape3D | null)[] = [
        () => {
          if (!faces.length) return null;
          try {
            return body.shell(t, (finder) => finder.inList(faces));
          } catch {
            return null;
          }
        },
        () => shellByOffset(body, faces, t),
        ...(faces.length ? [1 + 1e-4, 1 + 1e-3].map((k) => () => shellByOffset(body, faces, t * k)) : []),
      ];
      let out: Shape3D | null = null;
      let rough: Shape3D | null = null;
      for (const way of ways) {
        const made = way();
        if (good(made)) {
          out = made;
          break;
        }
        // (Hollow, but torn or broken: put right below, if nothing better comes.)
        if (hollowed(made)) rough ??= made;
      }
      if (!out && rough) {
        // Put right as any edit's result is - and then held to the same: a
        // broken shell "repaired" came out sound and a sixth too light, the
        // walls round two bores gone.
        const fixed = repairShape(rough, { maxSolids: Math.max(1, subShapes(body, "SOLID").length) });
        if (fixed && good(fixed.shape)) {
          if (fixed.fixes.length) editNotes.push(`Repaired automatically: ${fixed.fixes.join(", ")}.`);
          out = fixed.shape;
        }
      }
      // (A pocket or a blind hole cut into the face being opened hangs from that face alone.)
      const loose = faces.some((g) => g.clone().innerWires().length > 0);
      if (!out) throw new Error(!rough ? "Shell didn't work on this shape (try a smaller thickness)" : loose ? `${WALLS_CLASH} - or what is cut into the opened face would be left standing loose (open another face)` : WALLS_CLASH);
      bodies.set(f.body, out);
      return;
    }

    case "boolean": {
      let target = need(bodies, f.target);
      const toolIds = bodyList(f.tools, bodies, "tools", f.whole);
      const solidsIn = (x: Shape3D) => [...iterTopo(x.wrapped, "solid")].length;
      // Subtract: every tool at once - joined, then one tolerant cut checked by
      // its volume. Cut one by one, eight vents round a lamp shade left it with
      // no solid after the sixth, and the message blamed an "open surface".
      if (f.op === "subtract" && toolIds.length) {
        const tools = toolIds.map((t) => need(bodies, t));
        if (!solidsIn(target) || tools.some((t) => !solidsIn(t)))
          throw new Error("One of these is an open surface (e.g. a freeform with a hole), not a solid. Close it first: tap an edge of the hole → Fill hole, or give it a Thickness - then Union.");
        const all = fuseAll(tools.map((t) => t.clone()));
        let out = fuzzyBoolean("cut", target, all);
        if (!solidsIn(out) || !booleanVolumeOk("cut", target, all, out)) {
          const plain = target.cut(all);
          if (solidsIn(plain) && booleanVolumeOk("cut", target, all, plain)) out = plain;
          else if (isEmpty(out) && isEmpty(plain)) throw new Error("The result is empty");
          else throw new Error("Subtracting these didn't work out - the geometry engine lost the shape. Try the tools one or two at a time");
        }
        // The tolerant cut can leave faces that don't meet up where the plain one
        // is clean (a direction switch's slot through the housing's shelled top).
        else if (!shapeValid(out) && shapeValid(target)) {
          try {
            const plain = target.cut(all);
            if (solidsIn(plain) && shapeValid(plain) && booleanVolumeOk("cut", target, all, plain)) out = plain;
          } catch {
            // No plain cut either (it can come back empty): the tolerant one goes on to be checked.
          }
        }
        if (!f.keepTools) for (const t of toolIds) bodies.delete(t);
        // Kept as it was: the result is a body of its own.
        bodies.set(f.keepTarget ? f.id : f.target, out);
        return;
      }
      let open: number | undefined;
      for (const t of toolIds) {
        const tool = need(bodies, t);
        const solids = (x: Shape3D) => [...iterTopo(x.wrapped, "solid")].length;
        // An open freeform (a surface with a hole) isn't a solid: nothing to join into.
        if (!solids(target) || !solids(tool))
          throw new Error("One of these is an open surface (e.g. a freeform with a hole), not a solid. Close it first: tap an edge of the hole → Fill hole, or give it a Thickness - then Union.");
        const before = f.op === "union" ? solids(target) + solids(tool) : 0;
        const prev = target;
        target = f.op === "union" ? target.fuse(tool) : f.op === "subtract" ? target.cut(tool) : target.intersect(tool);
        // A join that leaves a gap (a coil wound round a hollowed cowl: one
        // edge left open where the two met): the tolerant join closes it.
        if (f.op === "union") {
          open ??= openEdges(prev).length;
          let now = openEdges(target).length;
          if (now > open + openEdges(tool).length) {
            try {
              const fz = fuzzyBoolean("fuse", prev, tool);
              const nz = openEdges(fz).length;
              if (nz < now && booleanVolumeOk("fuse", prev, tool, fz)) [target, now] = [fz, nz];
            } catch {
              // keep the plain result: the usual checks speak for it
            }
          }
          open = now;
        }
        // A union joins: a body that doesn't touch would only be grouped with it, not joined.
        if (f.op === "union" && solids(target) >= before) throw new Error("These bodies don't touch - Union needs them to overlap or touch (move one onto the other first)");
        if (!(f.op === "intersect" && f.keepTools)) bodies.delete(t);
      }
      if (isEmpty(target)) throw new Error("The result is empty");
      bodies.set(f.op === "intersect" && f.keepTarget ? f.id : f.target, target);
      return;
    }

    case "transform":
      transform(f, ctx);
      return;

    case "split": {
      const body = need(bodies, f.body);
      // Several planes, or bodies, at once: every piece they cut it into. The
      // biggest stays the body; the others are new ones.
      if (f.planes?.length || f.tools?.length || f.noPlane) {
        const planes = [...(f.noPlane ? [] : [f.plane]), ...(f.planes ?? [])];
        const tools = (f.tools ?? []).filter((t) => t !== f.body).map((t) => need(bodies, t));
        if (!planes.length && !tools.length) throw new Error("Pick a plane or a body to split it with");
        const pieces = splitAll(body, planes, tools);
        if (pieces.length < 2) throw new Error("Nothing it's split with cuts through the body");
        bodies.set(f.body, pieces[0]);
        pieces.slice(1).forEach((p, k) => bodies.set(k ? `${f.id}:${k + 1}` : f.id, p));
        return;
      }
      const half = halfSpace(f.plane, body);
      let a: Shape3D | null = null, b: Shape3D | null = null;
      try {
        a = body.intersect(half);
        b = body.cut(half);
      } catch {
        // Faces lying on the plane (a coil's end drawn on it) can stop the
        // plain split: the tolerant one treats them as on it.
      }
      // A plane crossing a round face's seam twice (the top off a ball turned
      // round the pipe's axis) gives the plain split an empty, broken half,
      // with no error: the halves must be sound and add up to the body.
      const whole = Math.abs(volumeOf(body));
      const sound = (s: Shape3D | null) => !!s && !isEmpty(s) && shapeValid(s);
      const addsUp = () => Math.abs(Math.abs(volumeOf(a!)) + Math.abs(volumeOf(b!)) - whole) <= Math.max(1e-9, whole * 1e-4);
      if (!sound(a) || !sound(b) || !addsUp()) {
        a = fuzzyBoolean("common", body, half);
        b = fuzzyBoolean("cut", body, half);
      }
      const [inside, outside] = [a as Shape3D, b as Shape3D];
      if (isEmpty(inside) || isEmpty(outside)) throw new Error("The plane doesn't cut through the body");
      bodies.set(f.body, outside);
      bodies.set(f.id, inside);
      return;
    }

    case "plane": {
      let plane = f.plane;
      if (f.face) {
        const body = bodies.get(f.face.body);
        if (body) {
          const info = faceInfo(resolveFace(body, f.face));
          if (info.plane) plane = { ...info.plane, xDir: dot(info.plane.normal, f.plane.normal) > 0.999 ? f.plane.xDir : info.plane.xDir };
        }
      }
      plane = { ...plane, origin: add(plane.origin, scale(plane.normal, f.offset)) };
      // (Older projects: how it was made, from its name.)
      const kind = f.kind ?? (/^Midplane/.test(f.name) ? "mid" : /3 Points/.test(f.name) ? "3pt" : /Perp/.test(f.name) ? "perp" : /on Curve/.test(f.name) ? "curve" : /Angle/.test(f.name) ? "angle" : /Parallel/.test(f.name) ? "parallel" : "offset");
      ctx.planes.set(f.id, { id: f.id, name: f.name, plane, kind });
      return;
    }

    case "axis":
      ctx.axes.set(f.id, { id: f.id, name: f.name, plane: { origin: f.origin, normal: norm(f.dir), xDir: xDirFor(norm(f.dir)) } });
      return;

    case "import": {
      let shape = importCache.get(f.data);
      if (!shape) {
        const bytes = Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0));
        const blob = new Blob([bytes]);
        try {
          shape = (f.format === "step" ? await importSTEP(blob) : readSTL(bytes)) as Shape3D;
        } catch (err) {
          // (The engine itself breaking down is for whoever runs it - it was
          // taken for a file that couldn't be read, and the broken engine kept.
          // A mesh too big says so in its own words.)
          if (isFault(err) || err instanceof TooBig) throw err;
          // (OpenCascade's own words were "This shape has not type, it is null".)
          throw new Error(f.format === "step" ? "This STEP file couldn't be read - it may be damaged" : "This STL file couldn't be read");
        }
        if (isEmpty(shape)) throw new Error("The file contains no solid geometry");
        importCache.set(f.data, shape);
      }
      bodies.set(f.id, shape);
      return;
    }

    case "delete":
      for (const b of bodyList(f.bodies, bodies, "bodies", f.whole)) bodies.delete(b);
      return;

    case "image":
      return; // drawn by the UI only

    case "freeform":
      bodies.set(f.id, freeformShape(f, AFFINE_ID));
      ctx.freeforms.set(f.id, { feature: f, m: AFFINE_ID });
      return;

    case "scaleFace": {
      const body = need(bodies, f.face.body);
      bodies.set(f.face.body, staysClosed(body, scaleFace(body, resolveFace(body, f.face), f.u, f.factors)));
      return;
    }

    case "faceFreeform": {
      const body = need(bodies, f.face.body);
      const face = resolveFace(body, f.face);
      if (!f.cage?.verts?.length) throw new Error("Made before Freeform Face had a cage: tap the face, Edit Freeform, and shape it again");
      // The cage follows the face (an earlier step moved it).
      const c = face.center.toTuple() as Vec3;
      const cage = { faces: f.cage.faces, verts: f.cage.verts.map((v) => add(c, v)) };
      const n = norm(face.normalAt().toTuple() as Vec3);
      // Through the cage's surface twice as fine as the cage; if the face
      // can't be filled through that many points (a fine cage on an outline
      // with inward corners), through the cage's own.
      if (!faceCagePoints(cage, n, false)) return;
      // The cage's own smooth surface, its border on the face's edges. (A cage
      // whose border doesn't follow the edges - laid before it did - or a
      // body that won't close round it: fitted through its points instead.)
      try {
        bodies.set(f.face.body, staysClosed(body, sheetFace(body, face, cage)));
        return;
      } catch (err) {
        if (isFault(err) || (err instanceof Error && /holes in them/.test(err.message))) throw err;
      }
      let last: unknown;
      for (const fine of [true, false]) {
        const pts = faceCagePoints(cage, n, fine);
        if (!pts) return;
        try {
          bodies.set(f.face.body, staysClosed(body, freeformFace(body, face, onFace(face, pts))));
          return;
        } catch (err) {
          if (isFault(err)) throw err;
          last = err;
        }
      }
      throw last;
    }

    case "replaceFace": {
      const body = need(bodies, f.face.body);
      const face = resolveFace(body, f.face);
      // Follow the target face if it's still there; else the plane as saved.
      let plane = f.plane;
      if (f.target) {
        const tb = bodies.get(f.target.body);
        const tf = tb && (() => {
          try {
            return resolveFace(tb, f.target!);
          } catch {
            return null;
          }
        })();
        if (tf?.geomType === "PLANE") plane = planeOf(tf);
      }
      // Keep the face pointing the way it pointed (outward).
      const n0 = planeOf(face).normal;
      const n = dot(plane.normal, n0) < 0 ? scale(plane.normal, -1) : plane.normal;
      bodies.set(f.face.body, staysClosed(body, replaceFacePlane(body, face, { origin: plane.origin, normal: n, xDir: xDirFor(n) })));
      return;
    }

    case "thread": {
      const body = need(bodies, f.face.body);
      bodies.set(f.face.body, threadFace(body, threadTarget(body, f), f.pitch, !!f.left));
      return;
    }

    case "imprint": {
      const body = need(bodies, f.body);
      if (f.source) {
        const src = sourceFaces(f.source, ctx);
        if (!src.length) throw new Error("Nothing to project");
        const n = src[0].normal;
        bodies.set(f.body, imprint(body, src.flatMap((s) => s.face.edges), n, seenFrom(body, src[0].face.center.toTuple() as Vec3, n)));
        return;
      }
      if (!f.edges?.length || !f.face) throw new Error("Pick the edges, then the face to project them onto");
      const F = resolveFace(body, f.face);
      const curves = f.edges.map((r) => resolveEdge(need(bodies, r.body), r));
      bodies.set(f.body, imprint(body, curves, F.normalAt(F.center).toTuple() as Vec3, linesOnFace(body, F)));
      return;
    }

    case "wrap": {
      const body = need(bodies, f.face.body);
      const round = resolveFace(body, f.face, (g) => g.geomType === "CYLINDRE");
      bodies.set(f.face.body, wrapOnto(body, round, sourceFaces(f.source, ctx), f.height));
      return;
    }

    case "connect": {
      const [ra, rb] = f.faces;
      const A = need(bodies, ra.body);
      const B = need(bodies, rb.body);
      const fa = resolveFace(A, ra);
      const fb = resolveFace(B, rb);
      if (ra.body === rb.body && fa.isSame(fb)) throw new Error("Pick two different faces to connect");
      const m = f.mode === "auto" ? "join" : f.mode;
      const size = f.size ?? 1;
      // Cut between two faces of one body: a tunnel, into the faces (else out of them).
      const inward = m === "cut" && ra.body === rb.body;
      // Cutting a face's whole outline out: the cutter a hair wider, so no sliver stays on the walls beside it.
      const cutSize = m === "cut" && !inward && size > 0.99 ? size * 1.002 : size;
      const ea = bridgeEnd(A, fa, cutSize, inward, m !== "new");
      const eb = bridgeEnd(B, fb, cutSize, inward, m !== "new");
      const reach = Math.max(ea.reach, eb.reach);
      // The bridge's outline at each end (the fold check carries them along the curve).
      const rings = { a: ea.ring, b: eb.ring };
      let along: (t: number) => Vec3;
      // Turning with its curve, the outline never runs back over itself (the
      // bridge folding through itself: a solid no join or cut can use). Where
      // it would - `slide`: the way the outline keeps facing instead, all the
      // way, sliding along the curve without turning.
      let sound = true;
      let slide: Vec3 | undefined;
      // Points taken along the curve for the sweep's path (two arcs: more, or the
      // path fitted through them wavers where the arcs meet and the sweep breaks).
      let samples = 60;
      if (f.guide) {
        // Eased onto the guide over a longer stretch when it leaves the face
        // steeply; where the guide itself turns tighter than the bridge is
        // wide, rounded off a little at a time until it fits.
        const drawn = curvePoints(pathWire(f.guide, ctx).wrapped, 200);
        const fit = (pts: Vec3[]) => [1.5, 2.5, 3.5, 5].map((k) => guideCurve(pts, ea.center, eb.center, ea.dir, eb.dir, k * reach)).find((c) => gentle(c, rings));
        let pts = oriented(evenly(drawn, 60), ea.center, eb.center);
        let found = fit(pts);
        for (let k = 0; k < 40 && !found; k++) found = fit((pts = smoothed(pts, 10, ea.dir, eb.dir)));
        along = found ?? guideCurve(drawn, ea.center, eb.center, ea.dir, eb.dir, 1.5 * reach);
        sound = !!found;
        if (!sound) slide = slideAxis(along, ea.dir, scale(eb.dir, -1), reach) ?? undefined;
      } else {
        const plain = plainSpine(ea.center, ea.dir, eb.center, eb.dir, f.bulge ?? 1, rings);
        along = plain.along;
        sound = plain.gentle;
        if (!sound) {
          // Faces too wide for how close they are (or how far to the side of
          // each other): two arcs - the gentlest way from one to the other -
          // or, facing each other, a bridge that slides along the plain curve.
          const arcs = arcSpine(ea.center, ea.dir, eb.center, eb.dir);
          if (arcs && gentle(arcs, rings)) (along = arcs), (sound = true), (samples = 180);
          else {
            const sliding = slidingSpine(ea.center, ea.dir, eb.center, eb.dir, f.bulge ?? 1, reach);
            if (sliding) (along = sliding.along), (slide = sliding.axis);
          }
        }
      }
      // Into both bodies (one, when both faces are on it).
      const into = (bridge: Shape3D) => {
        combine(f.id, m, ra.body, bridge, false, ctx);
        if (rb.body !== ra.body) {
          if (m === "join") {
            combine(f.id, "join", ra.body, need(bodies, rb.body), false, ctx);
            bodies.delete(rb.body);
            ctx.freeforms.delete(rb.body);
          } else combine(f.id, "cut", rb.body, bridge, false, ctx);
        }
        ctx.freeforms.delete(ra.body);
      };
      try {
        const made = sweepBridge(ea, eb, along, { guided: !!f.guide, exact: true, slide, samples });
        if (m === "new") {
          bodies.set(f.id, made.shape);
          return;
        }
        if (!made.exact) return into(made.shape);
        // Starting on the faces' very edges, its walls lie on the bodies' own:
        // where joining (or cutting) that fails, the bridge made the other way
        // (a little inside the edges) - on the bodies as they were.
        const was = [ra.body, rb.body].map((id) => [id, bodies.get(id), ctx.freeforms.get(id)] as const);
        try {
          into(made.shape);
        } catch (err) {
          if (isFault(err)) throw err;
          for (const [id, body, ff] of was) {
            if (body) bodies.set(id, body);
            if (ff) ctx.freeforms.set(id, ff);
          }
          into(sweepBridge(ea, eb, along, { guided: !!f.guide, exact: false, slide, samples }).shape);
        }
      } catch (err) {
        // On a curve too tight for it the bridge runs through itself: whatever
        // went wrong with it after that, this is why.
        if (isFault(err) || sound || slide) throw err;
        throw new Error(bridgeFailed(!!f.guide));
      } finally {
        for (const e of [ea, eb]) (e.outline.delete(), e.rim.delete());
      }
      return;
    }

    case "fill": {
      bodies.set(f.id, fillNetwork(f, ctx));
      return;
    }

    case "fillToPlane": {
      const sheet = need(bodies, f.body);
      bodies.set(f.body, fillToPlane(sheet, f.plane));
      ctx.freeforms.delete(f.body);
      return;
    }

    case "repair": {
      for (const id of f.bodies) {
        const body = need(bodies, id);
        const r = repairShape(body);
        if (!r) throw new Error(`This body can't be made a clean solid: ${whatsWrong(healthOf(body))}`);
        editNotes.push(r.fixes.length ? `Repaired: ${r.fixes.join(", ")}.` : "Nothing to repair - it's a clean solid already.");
        bodies.set(id, r.shape);
      }
      return;
    }

    case "deleteGeom": {
      const start = need(bodies, f.body);
      let body = start;
      // Picked together, taken out together: a slot's two walls and floor close
      // up as one gap (one wall alone has nothing to close it).
      let together: Shape3D | null = null;
      if (f.faces.length > 1) {
        try {
          together = deleteBodyFaces(body, f.faces.map((r) => resolveFace(body, r)));
        } catch {
          together = null;
        }
      }
      if (together) body = together;
      else for (const r of f.faces) body = deleteFace(body, resolveFace(body, r));
      for (const r of f.edges) body = deleteEdge(body, r);
      for (const v of f.vertices) body = deleteVertex(body, v);
      bodies.set(f.body, staysClosed(start, body));
      return;
    }

    case "moveFace": {
      const r = f.rotate && Math.abs(f.rotate.angle) > 1e-9 ? f.rotate : undefined;
      const move = (p: Vec3) => add(r ? rotateAbout(p, r.origin, r.axis, r.angle) : p, f.translate);
      const turn = (n: Vec3) => (r ? norm(sub(rotateAbout(add(r.origin, n), r.origin, r.axis, r.angle), r.origin)) : n);
      if (f.face) {
        const body = need(bodies, f.face.body);
        const face = resolveFace(body, f.face);
        const { origin, normal } = planeOf(face);
        // Slid within its own plane, or turned about its normal: its corners
        // move and the faces round it follow (a plane alone can't show that -
        // the face stayed where it was).
        const nn = norm(normal);
        const slide = sub(f.translate, scale(nn, dot(f.translate, nn)));
        const twist = !!r && Math.abs(dot(norm(r.axis), nn)) > 1e-6;
        if (len(slide) > 1e-9 || twist) {
          const size = Math.hypot(body.boundingBox.width, body.boundingBox.height, body.boundingBox.depth) || 1;
          const loop = faceLoop(face, size * 1e-6);
          const out = loop ? movePolyhedronPoints(body, loop.map((v) => [v, move(v)] as [Vec3, Vec3])) : null;
          if (!out) throw new Error("Sliding or turning a face within its plane works on bodies of flat, straight-edged faces - push or tilt it instead");
          bodies.set(f.face.body, staysClosed(body, out));
          return;
        }
        const n = turn(normal);
        bodies.set(f.face.body, staysClosed(body, replaceFacePlane(body, face, { origin: move(origin), normal: n, xDir: xDirFor(n) })));
        return;
      }
      if (f.vertex) {
        if (ctx.freeforms.has(f.vertex.body)) throw new Error("A freeform's shape comes from its cage: use Edit Freeform to move its points");
        const body = need(bodies, f.vertex.body);
        bodies.set(f.vertex.body, staysClosed(body, moveVertex(body, f.vertex.at, move(f.vertex.at))));
        return;
      }
      if (!f.edge) throw new Error("Nothing to move");
      const eb = need(bodies, f.edge.body);
      bodies.set(f.edge.body, staysClosed(eb, moveEdge(eb, f.edge, move)));
      return;
    }
  }
}

// ------------------------------------------------------------ affine maps

/** x' = A x + t, as [a00 a01 a02 t0, a10 a11 a12 t1, a20 a21 a22 t2]. */
type Affine = number[];
const AFFINE_ID: Affine = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
const applyAffine = (m: Affine, p: Vec3): Vec3 => [0, 1, 2].map((r) => m[r * 4] * p[0] + m[r * 4 + 1] * p[1] + m[r * 4 + 2] * p[2] + m[r * 4 + 3]) as Vec3;
/** First m, then n. */
function affineThen(m: Affine, n: Affine): Affine {
  const out: number[] = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) out.push(n[r * 4] * m[c] + n[r * 4 + 1] * m[4 + c] + n[r * 4 + 2] * m[8 + c]);
    out.push(n[r * 4] * m[3] + n[r * 4 + 1] * m[7] + n[r * 4 + 2] * m[11] + n[r * 4 + 3]);
  }
  return out;
}
const scaleAbout = (c: Vec3, k: Vec3): Affine => [k[0], 0, 0, c[0] * (1 - k[0]), 0, k[1], 0, c[1] * (1 - k[1]), 0, 0, k[2], c[2] * (1 - k[2])];

/** The affine map that a point map `f` is (it must be one). */
function affineFrom(f: (p: Vec3) => Vec3): Affine {
  const o = f([0, 0, 0]);
  const cols = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((e) => sub(f(e as Vec3), o));
  return [0, 1, 2].flatMap((r) => [cols[0][r], cols[1][r], cols[2][r], o[r]]);
}

/** The affine map of a move/scale/mirror step (null for patterns). */
function opAffine(op: Extract<Feature, { type: "transform" }>["op"]): Affine | null {
  const fromPoints = affineFrom;
  switch (op.kind) {
    case "move": {
      const r = op.rotate && Math.abs(op.rotate.angle) > 1e-9 ? op.rotate : null;
      return fromPoints((p) => add(r ? rotateAbout(p, r.origin, r.axis, r.angle) : p, op.translate));
    }
    case "scale":
      return scaleAbout(op.center, [op.factor, op.factor, op.factor]);
    case "scaleXYZ":
      return scaleAbout(op.center, op.factors);
    case "mirror": {
      const k = norm(op.plane.normal);
      return fromPoints((p) => sub(p, scale(k, 2 * dot(sub(p, op.plane.origin), k))));
    }
    default:
      return null;
  }
}

/** Shell a freeform: remove the cage quads under the picked faces, thicken the sheet inward. */
function shellFreeform(ff: { feature: Extract<Feature, { type: "freeform" }>; m: Affine }, faces: Face[], t: number): Shape3D {
  const cage = { faces: ff.feature.cage.faces, verts: ff.feature.cage.verts.map((v) => applyAffine(ff.m, v)) };
  // Each body face is one cage quad's patch: match by the patch's middle point.
  const sub3 = subdivide(cage, 3);
  const mid = sub3.n / 2;
  const centres = sub3.grids.map((g) => sub3.points[g[mid][mid]]);
  const drop = new Set<number>();
  for (const face of faces) {
    const c = face.center.toTuple() as Vec3;
    let best = 0;
    centres.forEach((q, i) => {
      if (dist(q, c) < dist(centres[best], c)) best = i;
    });
    drop.add(best);
  }
  if (drop.size >= cage.faces.length) throw new Error("Shell needs at least one face to stay");
  const open = deleteFaces(cage, [...drop]);
  // Closed cages face outward, so "down" (against the normals) is inward.
  return cageToShape(open, 3, { thickness: t, side: "down" });
}

/** A freeform's shape with its cage mapped by m (thickness grows with the overall scale). */
function freeformShape(f: Extract<Feature, { type: "freeform" }>, m: Affine): Shape3D {
  const cage = { faces: f.cage.faces, verts: f.cage.verts.map((v) => applyAffine(m, v)) };
  const det = Math.abs(m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8]) + m[2] * (m[4] * m[9] - m[5] * m[8]));
  const thicken = f.thickness ? { thickness: f.thickness * Math.cbrt(det || 1), side: f.thickSide ?? "up" } : undefined;
  return checkedFreeform(cage, thicken);
}

/**
 * A freeform's body, only if it's a clean one: a surface that passes through
 * itself (a cage point pulled through the body) or collapses (points on top
 * of each other) would make a solid every later edit trips over.
 */
function checkedFreeform(cage: { verts: Vec3[]; faces: [number, number, number, number][] }, thicken?: { thickness: number; side: "up" | "down" | "both" }): Shape3D {
  if (selfCrossings(cage, 2, 1).length) throw new Error("This freeform passes through itself (a cage point pulled through the body, or faces folded over) - pull it back; it shows red while you edit it");
  let shape: Shape3D;
  try {
    shape = cageToShape(cage, 3, thicken);
  } catch (e) {
    if (thicken) throw new Error("That thickness doesn't fit this surface (it folds into itself) - try a thinner one, or the other side");
    throw e;
  }
  const closed = isClosed(cage) || !!thicken;
  const degenerate = "This freeform has collapsed somewhere (cage points on top of each other, or a face squashed flat) - move those points apart";
  if (!shapeValid(shape)) {
    const r = repairShape(shape, { maxSolids: 1 });
    if (!r) throw new Error(thicken ? "That thickness doesn't fit this surface (it folds into itself) - try a thinner one, or the other side" : degenerate);
    editNotes.push(`Repaired automatically: ${r.fixes.join(", ")}.`);
    shape = r.shape;
  }
  if (closed && (subShapes(shape, "SOLID").length !== 1 || !(measureVolume(shape) > 0))) throw new Error(degenerate);
  return shape;
}

/**
 * Scale a flat face within its plane: each flat neighbour turns about its far
 * side so it passes through the face's moved edge (like a taper).
 */
function scaleFace(body: Shape3D, face: Face, u0: Vec3, [su, sv]: [number, number]): Shape3D {
  if (face.geomType !== "PLANE") throw new Error("Scale Face works on flat faces");
  if (su <= 0 || sv <= 0) throw new Error("Scale factors must be positive");
  const { normal: n } = planeOf(face);
  const c = face.center.toTuple() as Vec3;
  const u = norm(sub(u0, scale(n, dot(u0, n))));
  const v = cross(n, u);
  const map = (p: Vec3): Vec3 => {
    const d = sub(p, c);
    return add(c, add(add(scale(u, su * dot(d, u)), scale(v, sv * dot(d, v))), scale(n, dot(d, n))));
  };
  const targets = face.edges.map((edge) => {
    if (edge.geomType !== "LINE") throw new Error("Scale Face needs straight edges (round edges can't taper yet)");
    const g = body.faces.find((x) => !x.isSame(face) && x.edges.some((e) => e.isSame(edge)));
    if (!g) throw new Error("A neighbouring face is missing");
    if (g.geomType !== "PLANE") throw new Error("Scale Face works when the faces around it are flat");
    const a = edge.startPoint.toTuple() as Vec3;
    const b = edge.endPoint.toTuple() as Vec3;
    const a2 = map(a);
    const b2 = map(b);
    const d = norm(sub(b, a));
    const off = (p: Vec3) => len(sub(sub(p, a), scale(d, dot(sub(p, a), d))));
    const pts = g.edges.flatMap((e) => [e.startPoint.toTuple() as Vec3, e.endPoint.toTuple() as Vec3]);
    const far = pts.reduce((m, p) => (off(p) > off(m) ? p : m), pts[0]);
    const old = planeOf(g);
    let nn = norm(cross(sub(b2, a2), sub(far, a2)));
    if (dot(nn, old.normal) < 0) nn = scale(nn, -1);
    return { sig: faceInfo(g), plane: { origin: a2, normal: nn, xDir: xDirFor(nn) } };
  });
  let out = body;
  for (const t of targets) {
    // A side that stays where it is (scaled 1 that way): left alone - it may
    // run the whole length of the part (a lever's side, from the hub to the tip).
    const old = { origin: t.sig.center, normal: norm(t.sig.normal) };
    if (Math.abs(dot(norm(t.plane.normal), old.normal)) > 1 - 1e-12 && Math.abs(dot(sub(t.plane.origin, old.origin), old.normal)) < sizeOf(body) * 1e-9) continue;
    out = replaceFacePlane(out, resolveFace(out, { body: "", center: t.sig.center, normal: t.sig.normal, area: t.sig.area }), t.plane);
  }
  return out;
}

/** Rotate point p about the axis through o along a (degrees). */
function rotateAbout(p: Vec3, o: Vec3, a: Vec3, deg: number): Vec3 {
  const k = norm(a);
  const v = sub(p, o);
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  // Rodrigues' rotation formula.
  const r = add(add(scale(v, c), scale(cross(k, v), s)), scale(k, dot(k, v) * (1 - c)));
  return add(o, r);
}

/**
 * Move a straight edge: each flat face on it turns about its far side so it
 * passes through the edge's new position.
 */
function moveEdge(body: Shape3D, ref: EdgeRef, move: (p: Vec3) => Vec3): Shape3D {
  const edge = resolveEdge(body, ref);
  if (edge.geomType !== "LINE") throw new Error("Only straight edges can be moved");
  const a = edge.startPoint.toTuple() as Vec3;
  const b = edge.endPoint.toTuple() as Vec3;
  const a2 = move(a);
  const b2 = move(b);
  // A body of flat faces: just the edge's two corners move; every other corner
  // stays (bending faces are split) - repeated moves don't drift or pile up.
  const poly = movePolyhedronPoints(body, [[a, a2], [b, b2]]);
  if (poly) return poly;
  const d2 = norm(sub(b2, a2));
  const faces = body.faces.filter((g) => g.edges.some((e) => e.isSame(edge)));
  if (faces.some((g) => g.geomType !== "PLANE")) throw new Error("Only edges between flat faces can be moved");
  const targets = faces.map((g) => {
    const old = planeOf(g);
    // The face's point farthest from the edge stays put.
    const pts = g.edges.flatMap((e) => [e.startPoint.toTuple() as Vec3, e.endPoint.toTuple() as Vec3]);
    const d = norm(sub(b, a));
    const off = (p: Vec3) => len(sub(sub(p, a), scale(d, dot(sub(p, a), d))));
    const far = pts.reduce((m, p) => (off(p) > off(m) ? p : m), pts[0]);
    let n = norm(cross(d2, sub(far, a2)));
    if (dot(n, old.normal) < 0) n = scale(n, -1);
    return { sig: faceInfo(g), plane: { origin: a2, normal: n, xDir: xDirFor(n) } };
  });
  let out = body;
  for (const t of targets) out = replaceFacePlane(out, resolveFace(out, { body: ref.body, center: t.sig.center, normal: t.sig.normal, area: t.sig.area }), t.plane);
  return out;
}

/**
 * Move one corner: every flat face meeting at it turns about its far edge (the
 * one not touching the corner) so it passes through the corner's new place.
 */
function moveVertex(body: Shape3D, at: Vec3, to: Vec3): Shape3D {
  // A body of flat faces moves just the point: faces that would bend are split
  // into a triangle at the corner and the untouched rest.
  const poly = movePolyhedronVertex(body, at, to);
  if (poly) return poly;
  return moveVertexByPlanes(body, at, to);
}

/** Outer loop of a flat, straight-edged face as ordered corners (null if it isn't one). */
function faceLoop(face: Face, tol: number): Vec3[] | null {
  // (outerWire / innerWires use up the face they're called on: ask clones.)
  if (face.geomType !== "PLANE" || face.clone().innerWires().length) return null;
  const edges = face.clone().outerWire().edges;
  if (edges.some((e) => e.geomType !== "LINE")) return null;
  const segs = edges.map((e) => [e.startPoint.toTuple() as Vec3, e.endPoint.toTuple() as Vec3]);
  const loop: Vec3[] = [segs[0][0], segs[0][1]];
  const used = new Set([0]);
  while (used.size < segs.length) {
    const last = loop[loop.length - 1];
    const k = segs.findIndex((sg, i) => !used.has(i) && (dist(sg[0], last) < tol || dist(sg[1], last) < tol));
    if (k < 0) return null;
    used.add(k);
    loop.push(dist(segs[k][0], last) < tol ? segs[k][1] : segs[k][0]);
  }
  if (dist(loop[0], loop[loop.length - 1]) > tol) return null;
  loop.pop();
  // Wind it so its normal is the face's outward normal.
  const n = face.normalAt().toTuple() as Vec3;
  if (dot(polyNormal(loop), n) < 0) loop.reverse();
  return loop;
}

function polyNormal(pts: Vec3[]): Vec3 {
  let n: Vec3 = [0, 0, 0];
  for (let i = 0; i < pts.length; i++) n = add(n, cross(pts[i], pts[(i + 1) % pts.length]));
  return n;
}

function coplanar(pts: Vec3[], tol: number): boolean {
  const n = norm(polyNormal(pts));
  if (!Number.isFinite(n[0]) || len(n) < 0.5) return false;
  return pts.every((p) => Math.abs(dot(sub(p, pts[0]), n)) < tol);
}

function movePolyhedronVertex(body: Shape3D, at: Vec3, to: Vec3): Shape3D | null {
  return movePolyhedronPoints(body, [[at, to]]);
}

/**
 * A straight-edged shape tapered: its outline, the outline scaled about its
 * centre at the far end, and a flat four-sided face between each pair of
 * edges (a scaled edge stays parallel to its original, so each side is flat).
 * Null when the outline isn't all straight lines or it doesn't come out solid.
 */
function taperedPrism(face: Face, c: Vec3, normal: Vec3, k: number, d: number): Shape3D | null {
  const bb = face.boundingBox;
  const size = Math.hypot(bb.width, bb.height, bb.depth) || 1;
  const loop = faceLoop(face, size * 1e-6);
  if (!loop || loop.length < 3) return null;
  const off = scale(normal, d);
  const top = loop.map((p) => add(add(c, scale(sub(p, c), k)), off));
  const n = loop.length;
  const polys: Vec3[][] = [[...loop].reverse(), top];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    polys.push([loop[i], loop[j], top[j], top[i]]);
  }
  try {
    const build = (list: Vec3[][]) => makeSolid(list.map((pl) => makePolygon(pl))) as unknown as Shape3D;
    let solid = build(polys);
    if (measureVolume(solid) < 0) solid = build(polys.map((pl) => [...pl].reverse()));
    const v = measureVolume(solid);
    if (!Number.isFinite(v) || v <= 0 || !shapeValid(solid)) return null;
    return solid;
  } catch {
    return null;
  }
}

/**
 * A body of flat, straight-edged faces with some corners moved: every other
 * corner stays exactly where it is. A face whose corners no longer lie in one
 * plane keeps its unmoved part, and the moved corners get triangles (fanned
 * from the unmoved corner before them); coplanar pieces merge again after.
 */
function movePolyhedronPoints(body: Shape3D, moves: [Vec3, Vec3][]): Shape3D | null {
  const size = Math.hypot(body.boundingBox.width, body.boundingBox.height, body.boundingBox.depth) || 1;
  const tol = size * 1e-6;
  const loops = body.faces.map((f) => faceLoop(f, tol));
  if (loops.some((l) => !l)) return null;
  const movedTo = (p: Vec3): Vec3 | null => moves.find(([a]) => dist(a, p) < tol)?.[1] ?? null;
  const polys: Vec3[][] = [];
  let touched = 0;
  for (const loop of loops as Vec3[][]) {
    const isMoved = loop.map((p) => movedTo(p) !== null);
    if (!isMoved.some(Boolean)) {
      polys.push(loop);
      continue;
    }
    touched++;
    const moved = loop.map((p) => movedTo(p) ?? p);
    if (coplanar(moved, tol * 10)) {
      polys.push(moved);
      continue;
    }
    // Cut triangles off at the moved corners (ear clipping in the face's own
    // plane, so concave faces stay valid); what's left never moved and stays flat.
    const { tris, rest } = clipMovedCorners(loop, isMoved);
    if (rest.length >= 3) polys.push(rest.map((k) => loop[k]));
    for (const t of tris) polys.push(t.map((k) => moved[k]));
  }
  if (!touched) throw new Error("That corner is no longer there");
  // A body of flat faces: this is the way to move its corners. If the result
  // folds through itself, say so - another method would only give a mangled
  // shape (and dragging would jump between the two).
  const folded = "That would fold the faces through each other - move it less far, or another way";
  let solid: Shape3D;
  let v: number;
  try {
    const build = (list: Vec3[][]) => unify(makeSolid(list.map((pl) => makePolygon(pl))) as unknown as Shape3D);
    solid = build(polys);
    v = measureVolume(solid);
    // Inside out: wind every face the other way.
    if (v < 0) {
      solid = build(polys.map((pl) => [...pl].reverse()));
      v = measureVolume(solid);
    }
  } catch {
    throw new Error(folded);
  }
  if (!Number.isFinite(v) || v < 1e-9 * size ** 3 || solid.faces.length < 4 || !shapeValid(solid)) throw new Error(folded);
  return solid;
}

/**
 * Ear clipping of a flat face's loop that removes the moved corners first:
 * triangles holding a moved corner, plus the untouched rest as one polygon.
 */
function clipMovedCorners(loop: Vec3[], isMoved: boolean[]): { tris: number[][]; rest: number[] } {
  const n = norm(polyNormal(loop));
  const x = norm(sub(loop[1], loop[0]));
  const y = cross(n, x);
  const P = loop.map((p) => [dot(sub(p, loop[0]), x), dot(sub(p, loop[0]), y)] as [number, number]);
  const area2 = (a: number, b: number, c: number) => (P[b][0] - P[a][0]) * (P[c][1] - P[a][1]) - (P[b][1] - P[a][1]) * (P[c][0] - P[a][0]);
  const idx = loop.map((_, k) => k);
  const tris: number[][] = [];
  const isEar = (i: number): boolean => {
    const m = idx.length;
    const a = idx[(i + m - 1) % m];
    const b = idx[i];
    const c = idx[(i + 1) % m];
    if (area2(a, b, c) <= 1e-12) return false;
    for (const k of idx) {
      if (k === a || k === b || k === c) continue;
      if (area2(a, b, k) >= -1e-12 && area2(b, c, k) >= -1e-12 && area2(c, a, k) >= -1e-12) return false;
    }
    return true;
  };
  const clip = (i: number) => {
    const m = idx.length;
    tris.push([idx[(i + m - 1) % m], idx[i], idx[(i + 1) % m]]);
    idx.splice(i, 1);
  };
  let guard = loop.length * 4;
  while (idx.length > 3 && idx.some((k) => isMoved[k]) && guard-- > 0) {
    const m = idx.length;
    const order = idx.map((_, i) => i);
    // Ears at a moved corner first, then ears next to one, then any ear.
    const rank = (i: number) => (isMoved[idx[i]] ? 0 : isMoved[idx[(i + 1) % m]] || isMoved[idx[(i + m - 1) % m]] ? 1 : 2);
    order.sort((p, q) => rank(p) - rank(q));
    const ear = order.find(isEar);
    if (ear === undefined) break;
    clip(ear);
  }
  if (idx.some((k) => isMoved[k])) {
    // Down to a triangle (or clipping got stuck): all of it moves.
    if (idx.length === 3) tris.push([...idx]);
    else for (let q = 1; q + 1 < idx.length; q++) tris.push([idx[0], idx[q], idx[q + 1]]);
    return { tris, rest: [] };
  }
  return { tris, rest: idx };
}

function moveVertexByPlanes(body: Shape3D, at: Vec3, to: Vec3): Shape3D {
  const size = Math.hypot(body.boundingBox.width, body.boundingBox.height, body.boundingBox.depth) || 1;
  const tol = size * 1e-6;
  const ends = (e: Edge): Vec3[] => [e.startPoint.toTuple() as Vec3, e.endPoint.toTuple() as Vec3];
  const faces = body.faces.filter((g) => g.edges.some((e) => ends(e).some((p) => dist(p, at) < tol)));
  if (!faces.length) throw new Error("That corner is no longer there");
  if (faces.some((g) => g.geomType !== "PLANE")) throw new Error("Only corners where flat faces meet can be moved");
  const targets = faces.map((g) => {
    const old = planeOf(g);
    // The far edge: both ends away from the corner, the farthest such edge.
    const far = g.edges
      .filter((e) => e.geomType === "LINE" && ends(e).every((p) => dist(p, at) > tol))
      .sort((a, b) => dist(b.pointAt(0.5).toTuple() as Vec3, at) - dist(a.pointAt(0.5).toTuple() as Vec3, at))[0];
    if (!far) throw new Error("Moving this corner needs straight-edged faces around it");
    const [p1, p2] = ends(far);
    let n = norm(cross(sub(p1, to), sub(p2, to)));
    if (len(n) < 1e-9 || !Number.isFinite(n[0])) throw new Error("The corner can't go there (a face would fold flat)");
    if (dot(n, old.normal) < 0) n = scale(n, -1);
    return { sig: faceInfo(g), plane: { origin: to, normal: n, xDir: xDirFor(n) } };
  });
  let out = body;
  for (const t of targets) out = replaceFacePlane(out, resolveFace(out, { body: "", center: t.sig.center, normal: t.sig.normal, area: t.sig.area }), t.plane);
  return out;
}

/**
 * Remove an edge: merge its faces when they lie on one surface, otherwise drop
 * the blend face it bounds (fillet/chamfer) so its neighbours meet again.
 */
function deleteEdge(body: Shape3D, ref: EdgeRef): Shape3D {
  const edge = resolveEdge(body, ref);
  const merged = unify(body);
  if (merged.edges.length < body.edges.length && !hasEdge(merged, ref)) return merged;
  const adjacent = body.faces.filter((g) => g.edges.some((e) => e.isSame(edge)));
  // Try the curved / smaller face first: that's the blend.
  adjacent.sort((a, b) => (a.geomType === "PLANE" ? 1 : 0) - (b.geomType === "PLANE" ? 1 : 0) || measureArea(a) - measureArea(b));
  for (const g of adjacent) {
    try {
      return deleteFace(body, g);
    } catch {
      // try the other face
    }
  }
  throw new Error("This edge can't be removed - the faces around it wouldn't close up");
}

function hasEdge(body: Shape3D, ref: EdgeRef): boolean {
  try {
    const e = edgeInfo(resolveEdge(body, ref));
    return dist(e.mid, ref.mid) < (ref.length || 1) * 1e-3 && Math.abs(e.length - ref.length) < (ref.length || 1) * 1e-3;
  } catch {
    return false;
  }
}

/**
 * A profile turned `angle` degrees about an axis while moving `travel` along
 * it: swept along a helix through the profile's centre, keeping its
 * orientation to the axis (binormal mode), as threads are made.
 */
function helicalSweep(wire: Wire, origin: Vec3, dir: Vec3, angle: number, travel: number): Shape3D {
  const bb = wire.boundingBox;
  const c = bb.center as Vec3;
  // The helix runs through the profile's centre (or, on the axis, its far side).
  const radial = (p: Vec3) => {
    const v = sub(p, origin);
    return sub(v, scale(dir, dot(v, dir)));
  };
  let start = c;
  if (len(radial(c)) < 1e-6 * (1 + bb.width + bb.height + bb.depth)) {
    const far = wire.edges.flatMap((e) => [0, 0.5, 1].map((t) => e.pointAt(t).toTuple() as Vec3)).sort((a, b) => len(radial(b)) - len(radial(a)))[0];
    start = far;
  }
  const turns = Math.abs(angle) / 360;
  const n = Math.max(16, Math.ceil(turns * 48));
  const pts: Vec3[] = [];
  const rel = sub(start, origin);
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const th = (angle * Math.PI * t) / 180;
    // Rodrigues' rotation about the axis, plus the travel so far.
    const v = add(add(scale(rel, Math.cos(th)), scale(cross(dir, rel), Math.sin(th))), scale(dir, dot(dir, rel) * (1 - Math.cos(th))));
    pts.push(add(add(origin, v), scale(dir, travel * t)));
  }
  const spine = assembleWire([makeBSplineApproximation(pts, { tolerance: 1e-5 * (1 + len(rel)), degMax: 5, degMin: 3 })]);
  const oc = getOC();
  const builder = new oc.BRepOffsetAPI_MakePipeShell(spine.wrapped);
  const bi = new oc.gp_Dir(dir[0], dir[1], dir[2]);
  try {
    builder.SetMode(bi);
    builder.Add(wire.wrapped, false, false);
    builder.Build();
    if (!builder.IsDone()) throw new Error("The profile can't be swept round this axis");
    builder.MakeSolid();
    const shape = cast(builder.Shape());
    if (!isShape3D(shape)) throw new Error("The profile can't be swept round this axis");
    return shape;
  } finally {
    builder.delete();
    bi.delete();
  }
}

/**
 * Fill: a surface over a network of curves (BRepOffsetAPI_MakeFilling). The
 * boundary's edges bound it; along a body's edge it can meet that body's face
 * tangentially (G1) or with matching curvature (G2). Guides are curves it
 * passes through. The surface is an open body of its own.
 */
function fillNetwork(f: Extract<Feature, { type: "fill" }>, ctx: Ctx): Shape3D {
  if (!f.boundary.length) throw new Error("Pick the curves or edges round the surface");
  const oc = getOC();
  const orderOf = (c?: string) => (c === "g2" ? oc.GeomAbs_Shape.GeomAbs_G2 : c === "g1" ? oc.GeomAbs_Shape.GeomAbs_G1 : oc.GeomAbs_Shape.GeomAbs_C0);
  // Each body edge: its own continuity, else the one for all.
  const cont = (r?: EdgeRef) => (r && f.edgeContinuity?.[fillEdgeKey(r)]) ?? f.continuity;
  let g2 = f.continuity === "g2";
  const edgesOf = (p: PathRef): Edge[] => {
    if (p.kind === "edges") return p.edges.map((r) => resolveEdge(need(ctx.bodies, r.body), r));
    return pathWire(p, ctx).edges;
  };
  const fill = new oc.BRepOffsetAPI_MakeFilling(3, 15, 2, false, 1e-5, 1e-4, 0.01, 0.1, 8, 9);
  try {
    let n = 0;
    for (const p of f.boundary)
      edgesOf(p).forEach((e, k) => {
        // A body's edge, held to the face beside it (the first one of that body that has it).
        const c = p.kind === "edges" ? cont(p.edges[k]) : undefined;
        if (c === "g2") g2 = true;
        const beside = p.kind === "edges" && c && c !== "g0" ? need(ctx.bodies, p.edges[k].body).faces.find((fc) => fc.edges.some((x) => x.isSame(e))) : undefined;
        if (beside) fill.Add(e.wrapped, beside.wrapped, orderOf(c), true);
        else fill.Add(e.wrapped, oc.GeomAbs_Shape.GeomAbs_C0, true);
        n++;
      });
    const only = n === 1 ? edgesOf(f.boundary[0])[0] : null;
    if (n === 0 || (only && dist(only.startPoint.toTuple() as Vec3, only.endPoint.toTuple() as Vec3) > 1e-6)) throw new Error("The boundary needs curves that close a loop");
    for (const p of f.guides ?? []) for (const e of edgesOf(p)) fill.Add(e.wrapped, oc.GeomAbs_Shape.GeomAbs_C0, false);
    fill.Build(new oc.Message_ProgressRange());
    if (!fill.IsDone()) throw new Error("no fill");
    const made = cast(fill.Shape()) as AnyShape;
    const faces = "faces" in made ? (made as unknown as { faces: Face[] }).faces : [made as unknown as Face];
    if (!faces.length) throw new Error("no fill");
    const builder = new oc.TopoDS_Builder();
    const shell = new oc.TopoDS_Shell();
    builder.MakeShell(shell);
    for (const fc of faces) builder.Add(shell, fc.wrapped);
    builder.delete();
    return cast(shell) as Shape3D;
  } catch (err) {
    if (err instanceof Error && /boundary needs/.test(err.message)) throw err;
    if (g2) throw new Error("Curvature (G2) couldn't be held along these edges - Tangent (G1) can be tried");
    throw new Error("These curves don't make a surface - the boundary must close a loop (end to end), and guides lie across it");
  } finally {
    fill.delete();
  }
}

/** Sweep a profile along a path without turning it (Orientation: Parallel to profile). */
function fixedSweep(wire: Wire, spine: Wire, corner: "round" | "right", law: ReturnType<typeof scaleLaw> | null): Shape3D {
  const oc = getOC();
  const builder = new oc.BRepOffsetAPI_MakePipeShell(spine.wrapped);
  const p = new oc.gp_Pnt(0, 0, 0);
  const d = new oc.gp_Dir(0, 0, 1);
  const ax = new oc.gp_Ax2(p, d);
  try {
    builder.SetMode(ax);
    builder.SetTransitionMode(corner === "right" ? oc.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_RightCorner : oc.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_RoundCorner);
    if (law) builder.SetLaw(wire.wrapped, law, false, false);
    else builder.Add(wire.wrapped, false, false);
    builder.Build();
    if (!builder.IsDone()) throw new Error("The profile can't be swept along this path facing the same way - try Normal to path");
    builder.MakeSolid();
    const shape = cast(builder.Shape());
    if (!isShape3D(shape)) throw new Error("The profile can't be swept along this path facing the same way - try Normal to path");
    return shape;
  } finally {
    builder.delete();
    ax.delete();
    p.delete();
    d.delete();
  }
}

/**
 * Profile Position "start": a function that moves a wire of the profile so
 * the profile's centre is on the path's end nearer to it, and turns it square
 * to the path there (its normal along the path, pointing on along it).
 */
function onPathStart(faces: { face: Face; normal: Vec3 }[], spine: Wire): (w: Wire) => Wire {
  if (!faces.length) return (w) => w;
  const c = faces[0].face.center.toTuple() as Vec3;
  const n = norm(faces[0].normal);
  const a = spine.startPoint.toTuple() as Vec3;
  const b = spine.endPoint.toTuple() as Vec3;
  const atStart = dist(c, a) <= dist(c, b);
  const p = atStart ? a : b;
  // On along the path, from that end.
  let t = norm(spine.tangentAt(atStart ? 0 : 1).toTuple() as Vec3);
  if (!atStart) t = scale(t, -1);
  // The profile's side that faces along the path stays its front (n·t > 0 after turning).
  const from = dot(n, t) < 0 ? scale(n, -1) : n;
  const axis = cross(from, t);
  const s = len(axis);
  const angle = (Math.atan2(s, dot(from, t)) * 180) / Math.PI;
  return (w) => {
    let out = w.clone();
    if (s > 1e-9 && Math.abs(angle) > 1e-9) out = out.rotate(angle, c, scale(axis, 1 / s));
    return out.translate(sub(p, c));
  };
}

/**
 * Loft end continuity: copies of the first (last) profile set a little way
 * along its normal, towards the next one, so the smooth loft leaves it
 * straight out (G1); a second copy further on holds the curve too (G2).
 */
function withEndPulls(wires: Wire[], normals: Vec3[], start: "g1" | "g2" | undefined, sw: number, end: "g1" | "g2" | undefined, ew: number): Wire[] {
  const centre = (w: Wire) => w.boundingBox.center as Vec3;
  const pulls = (w: Wire, n: Vec3, next: Wire, kind: "g1" | "g2", weight: number): Wire[] => {
    const toward = sub(centre(next), centre(w));
    const gap = Math.abs(dot(toward, n)) || len(toward);
    const dir = dot(toward, n) < 0 ? scale(n, -1) : n;
    const d = (gap * 0.25 * Math.max(weight, 0.05)) / (kind === "g2" ? 2 : 1);
    return (kind === "g2" ? [1, 2] : [1]).map((k) => w.clone().translate(scale(dir, d * k)));
  };
  const last = wires.length - 1;
  const head = start ? pulls(wires[0], norm(normals[0]), wires[1], start, sw) : [];
  const tail = end ? pulls(wires[last], norm(normals[last]), wires[last - 1], end, ew).reverse() : [];
  return [wires[0], ...head, ...wires.slice(1, last), ...tail, wires[last]];
}

/** Sweep a profile along a path, keeping it square to `up` (a helix: the profile stays in planes through the axis). */
function pipeAlong(profile: Wire, path: Wire, up: Vec3): Shape3D {
  const oc = getOC();
  const builder = new oc.BRepOffsetAPI_MakePipeShell(path.wrapped);
  const bi = new oc.gp_Dir(up[0], up[1], up[2]);
  try {
    builder.SetMode(bi);
    builder.Add(profile.wrapped, false, false);
    builder.Build();
    if (!builder.IsDone()) throw new Error("The thread's groove couldn't be made");
    builder.MakeSolid();
    const shape = cast(builder.Shape());
    if (!isShape3D(shape)) throw new Error("The thread's groove couldn't be made");
    return shape;
  } finally {
    builder.delete();
    bi.delete();
  }
}

/** Turns of a thread's groove made in one piece (see threadFace). */
const MAX_THREAD_TURNS = 8;

/** The round face a thread step threads. */
function threadTarget(body: Shape3D, f: Extract<Feature, { type: "thread" }>): Face {
  // Only a round face of the kind picked (a hole stays a hole): with the
  // boss its hole was in switched off, the nearest face was the box's
  // rounded corner - threaded, 60 turns of it, for over a minute. And
  // about its size: a shelled box's inside corner is a "hole" too.
  const round = (g: Face) => {
    if (g.geomType !== "CYLINDRE") return false;
    const cy = cylinderOf(g);
    return !!cy && (!f.round || ((cy.s < 0) === f.round.hole && cy.r < f.round.r * 2 && cy.r > f.round.r / 2));
  };
  try {
    return resolveFace(body, f.face, round);
  } catch {
    // Never a round face (a flat one picked): threadFace says threads go on round faces.
    if (!f.round) return resolveFace(body, f.face);
    throw new Error(f.round.hole ? "The hole it was cut in is gone" : "The round face it was cut on is gone");
  }
}

/**
 * Cut an ISO 60° thread into a round face: a V groove swept along a helix
 * round the face's axis (deepest at the minor diameter of a shank, the major
 * of a hole), kept to the face's own length, cut away. Cutting (never adding
 * a ridge) is the reliable way: a ridge only just overlapping its core can
 * come out of OpenCascade wrong without a word.
 */
export function threadFace(body: Shape3D, face: Face, pitch: number, left = false): Shape3D {
  if (face.geomType !== "CYLINDRE") throw new Error("Threads go on round faces (a shank or a hole)");
  if (!(pitch > 0)) throw new Error("The pitch must be more than 0");
  // (Finer than any standard thread: it failed with "try a slightly different pitch".)
  if (pitch < 0.2 - 1e-9) throw new Error("That pitch is too fine - the finest is 0.2 mm");
  const cy = cylinderOf(face);
  if (!cy) throw new Error("Threads go on round faces (a shank or a hole)");
  const inside = cy.s < 0;
  const depth = threadDepth(pitch, inside);
  if (!inside && depth >= cy.r * 0.9) throw new Error("That pitch is too coarse for this diameter");
  const a = norm(cy.a);
  // The face's length along its axis.
  const ts: number[] = [];
  for (const e of face.edges) for (const k of [0, 0.25, 0.5, 0.75, 1]) ts.push(dot(sub(e.pointAt(k).toTuple() as Vec3, cy.c), a));
  const t0 = Math.min(...ts);
  const t1 = Math.max(...ts);
  if (t1 - t0 < pitch) throw new Error("This face is shorter than one turn of the thread");
  // The groove stops just short of both ends: its ends never lie on a face of
  // the body (a groove running out through an end face can make OpenCascade's
  // cut silently do nothing, or take the whole rod), and under a head it
  // mustn't cut into the head anyway.
  const lo = t0 + 0.05 * pitch;
  const hi = t1 - 0.05 * pitch;
  // The groove's section in a plane through the axis: a 60° V from its tip
  // (the thread's depth) opening past the face.
  const out = inside ? -1 : 1;
  const tip = cy.r - out * depth;
  const mouth = cy.r + out * 0.2 * pitch;
  const hm = Math.abs(mouth - tip) * Math.tan(Math.PI / 6);
  // Only along the face (a shank's thread mustn't run into the head).
  const reach = Math.max(cy.r, tip, mouth) + pitch * 2;
  const slab = makeCylinder(reach, hi - lo, add(cy.c, scale(a, lo)), a) as Shape3D;
  const v0 = Math.abs(measureVolume(body));
  // What it must take away: the V inside the face (depth deep, 2·depth·tan30
  // wide at the face) along the helix through its centroid.
  const section = depth * depth * Math.tan(Math.PI / 6);
  const rc = inside ? cy.r + depth / 3 : cy.r - depth / 3;
  const expect = section * Math.hypot(2 * Math.PI * rc, pitch) * ((hi - lo) / pitch);
  // A face that isn't a whole ring (a shank with flats cut along it, a slot
  // across a hole) loses less: what the groove overlaps, if that's no more.
  const ok = (r: Shape3D, cut: Shape3D) => {
    const v = Math.abs(measureVolume(r));
    if (!Number.isFinite(v)) return false;
    if (Math.abs(v0 - v - expect) < expect * 0.03) return true;
    try {
      const want = Math.abs(measureVolume(fuzzyBoolean("common", body, cut)));
      return want > expect * 0.05 && want < expect * 1.03 && Math.abs(v0 - v - want) < want * 0.03;
    } catch {
      return false;
    }
  };
  // Where the thread starts round the face doesn't matter: if OpenCascade
  // trips on one start (a groove lining up with the face's seams), another
  // is tried.
  for (const phase of [0, 0.37, 0.71]) {
    const start = lo - pitch * (1 + phase);
    const turns = Math.ceil((hi - start) / pitch) + 1;
    // An exact helix (a line wound on a cylinder, not a fitted spline: those
    // drift over many turns and the sweep fails), through the groove's middle.
    // Long threads go in pieces of a few whole turns: one 40-turn groove in an
    // M3 boss hole made OpenCascade's cut find nothing to cut (after 40 s).
    // Whole turns, so each piece ends on the very face the next starts on.
    const per = Math.ceil(turns / Math.ceil(turns / MAX_THREAD_TURNS));
    let cut: Shape3D;
    try {
      const pieces: Shape3D[] = [];
      for (let k = 0; k * per < turns; k++) {
        const n = Math.min(per, turns - k * per);
        const base = add(cy.c, scale(a, start + k * per * pitch));
        const helix = makeHelix(pitch, pitch * n, (tip + mouth) / 2, base, a, left);
        const r0 = sub(helix.startPoint.toTuple() as Vec3, base);
        const ur = norm(sub(r0, scale(a, dot(r0, a))));
        const at = (rr: number, t: number): Vec3 => add(add(base, scale(a, t)), scale(ur, rr));
        const profile = makePolygon([at(mouth, -hm), at(tip, 0), at(mouth, hm)]).outerWire();
        pieces.push(pipeAlong(profile, helix, a).intersect(slab));
      }
      cut = pieces.length === 1 ? pieces[0] : (makeCompound(pieces) as unknown as Shape3D);
    } catch {
      continue;
    }
    for (const fuzzy of [true, false]) {
      try {
        const res = fuzzy ? fuzzyBoolean("cut", body, cut) : body.cut(cut);
        if (ok(res, cut)) return res;
      } catch {
        // the other way, or the next start
      }
    }
  }
  // A very fine pitch on a wide face is where this happens: "slightly different" sent people from 0.2 to 0.21.
  throw new Error(pitch < 0.1 * cy.r ? "The thread couldn't be cut here - try a coarser pitch" : "The thread couldn't be cut here - try a slightly different pitch");
}

/** A shell in pieces: what was cut into the opened face hung from that face alone. */
const SHELL_LOOSE = "Opening this face would leave what is cut into it (a pocket, a blind hole) standing loose from the rest - open another face";
const WALLS_CLASH =
  "Walls this thick don't fit everywhere: somewhere two faces are closer together than two walls (a hole near a side, a pocket near a hole), and their walls would run into each other - try a thinner wall";

/**
 * Does a shell have a wall behind every face it kept? Small cubes half a wall
 * deep behind spots spread over each face (all of a cube within a wall's
 * thickness of the face, so in the wall wherever it is in the body): as much
 * of the cubes must be in the shell as is in the body. (Two joins with all
 * the cubes at once; 600 cubes at most, shared out among the faces.)
 */
function wallsStand(body: Shape3D, shell: Shape3D, kept: Face[], t: number): boolean {
  if (!kept.length || !(t > 0)) return true;
  try {
    const each = Math.max(1, Math.min(6, Math.floor(600 / kept.length)));
    const every = Math.ceil(kept.length / 600);
    const h = t / 6;
    const at: Vec3[] = [];
    for (const [i, g] of kept.entries()) {
      if (i % every) continue;
      for (const { p, n } of spotsOn(body, g, each)) at.push(sub(p, scale(n, t / 2)));
    }
    if (!at.length) return true;
    const probes = cubesAt(at, h);
    const inBody = body.intersect(probes);
    const want = isEmpty(inBody) ? 0 : Math.abs(measureVolume(inBody));
    if (!(want > 0)) return true;
    const inShell = shell.intersect(probes);
    const got = isEmpty(inShell) ? 0 : Math.abs(measureVolume(inShell));
    return got >= want * (1 - 1e-3);
  } catch {
    // Can't tell: the usual checks speak for it.
    return true;
  }
}

/**
 * Cubes `2h` across, one about each point, as one shape. One cube is made and
 * the others are that cube moved (a handle each): made one by one, every cube
 * stayed in the kernel for good (release.ts) - 250 of them with each check of
 * a 40-face part's shell, megabytes with every move of a drag.
 */
function cubesAt(at: Vec3[], h: number): Shape3D {
  const oc = getOC();
  const first = makeBox([at[0][0] - h, at[0][1] - h, at[0][2] - h], [at[0][0] + h, at[0][1] + h, at[0][2] + h]) as Shape3D;
  if (at.length === 1) return first;
  const cubes: Shape3D[] = [first];
  for (const p of at.slice(1)) {
    const move = new oc.gp_Trsf();
    const by = new oc.gp_Vec(p[0] - at[0][0], p[1] - at[0][1], p[2] - at[0][2]);
    move.SetTranslation(by);
    const place = new oc.TopLoc_Location(move);
    const moved = first.wrapped.Moved(place, true);
    try {
      cubes.push(cast(moved) as Shape3D);
    } finally {
      for (const x of [move, by, place, moved]) x.delete();
    }
  }
  return makeCompound(cubes) as unknown as Shape3D;
}

/** Up to `n` points spread over a face (the middles of triangles of its mesh, taken evenly through them), each with the face's outward normal there. */
function spotsOn(body: Shape3D, face: Face, n: number): { p: Vec3; n: Vec3 }[] {
  const one = () => [pointOnFace(body, face)];
  if (n <= 1) return one();
  const tri = faceTriangles(face, sizeOf(body));
  if (!tri) return one();
  const count = tri.trianglesIndexes.length / 3;
  const v = (i: number): Vec3 => [tri!.vertices[3 * i], tri!.vertices[3 * i + 1], tri!.vertices[3 * i + 2]];
  const out: { p: Vec3; n: Vec3 }[] = [];
  for (let k = 0; k < Math.min(n, count); k++) {
    const at = Math.floor(((k + 0.5) * count) / Math.min(n, count)) * 3;
    const [a, b, c] = [0, 1, 2].map((j) => v(tri!.trianglesIndexes[at + j]));
    const p = scale(add(add(a, b), c), 1 / 3);
    try {
      out.push({ p, n: norm(face.normalAt(p).toTuple() as Vec3) });
    } catch {
      // (A spot the surface gives no normal at: the others will do.)
    }
  }
  return out.length ? out : one();
}

/**
 * Is a shell hollow where it should be? Spots three walls deep behind its
 * faces that are well clear of every face of the body (more than two walls:
 * past the sharpest inside corner a shell can have) must be empty - a shell
 * that hollowed one corner of a part and left the rest solid passed for one.
 */
function hollowInside(body: Shape3D, shell: Shape3D, kept: Face[], t: number): boolean {
  if (!kept.length || !(t > 0)) return true;
  try {
    const skin = subShapes(body, "SHELL");
    if (!skin.length) return true;
    const every = Math.ceil(kept.length / 40);
    const h = t / 6;
    const at: Vec3[] = [];
    // (One measurer for each skin, asked about every spot: one made for each
    // spot kept what it worked out about the whole skin, for good - release.ts.)
    const oc = getOC();
    const far = skin.map((sk) => {
      const d = new oc.BRepExtrema_DistShapeShape();
      d.LoadS1(sk);
      return d;
    });
    try {
      for (const [i, g] of kept.entries()) {
        if (i % every) continue;
        const { p, n } = pointOnFace(body, g);
        const q = sub(p, scale(n, 3 * t));
        const point = makeVertex(q);
        let near = Infinity;
        for (const d of far) {
          d.LoadS2(point.wrapped);
          d.Perform();
          near = Math.min(near, d.Value());
        }
        if (near < 2.1 * t) continue;
        at.push(q);
      }
    } finally {
      for (const d of far) d.delete();
    }
    if (!at.length) return true;
    const probes = cubesAt(at, h);
    const inBody = body.intersect(probes);
    const deep = isEmpty(inBody) ? 0 : Math.abs(measureVolume(inBody));
    if (!(deep > 0)) return true;
    const left = shell.intersect(probes);
    return (isEmpty(left) ? 0 : Math.abs(measureVolume(left))) <= deep * 1e-3;
  } catch {
    // Can't tell: the usual checks speak for it.
    return true;
  }
}

/**
 * Shell without BRepOffsetAPI_MakeThickSolid: body − (body offset inward by t)
 * leaves a closed skin; each removed flat face then gets a hole cut through
 * it (its outline shrunk by t, pushed through the skin).
 */
function shellByOffset(body: Shape3D, faces: Face[], t: number): Shape3D | null {
  const oc = getOC();
  const off = new oc.BRepOffsetAPI_MakeOffsetShape();
  try {
    const src = unify(body);
    let inner: Shape3D | null = null;
    for (const join of [oc.GeomAbs_JoinType.GeomAbs_Intersection, oc.GeomAbs_JoinType.GeomAbs_Arc]) {
      try {
        off.PerformByJoin(src.wrapped, -t, 1e-6, oc.BRepOffset_Mode.BRepOffset_Skin, true, false, join, false, new oc.Message_ProgressRange());
        if (off.IsDone()) {
          let got = cast(off.Shape());
          // It can come back as a closed shell: make that a solid. (Asked of the
          // shape itself - class names are renamed in the app's build, so a
          // constructor.name test never matched there and the cut came out null.)
          if (got.wrapped.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_SHELL) got = makeSolid([got as never]);
          inner = got as Shape3D;
        }
        if (inner && Math.abs(measureVolume(inner)) > 0) break;
      } catch {
        inner = null;
      }
    }
    if (!inner) return null;
    const tol = sizeOf(body) * 1e-6;
    // The openings: the hollow's own floor behind each opened face, carried on
    // out through the wall (the hollow and its way out, cut away as one). So
    // what stands in the hollow there keeps its walls right down to the
    // opening - a bore through the floor, its tube: cut by the face's outline
    // brought in, as it was, the tube ended a wall and a half short of it.
    let hollow: Shape3D = inner;
    const byOutline: { face: Face; n: Vec3 }[] = [];
    for (const face of faces) {
      if (face.geomType !== "PLANE") return null;
      const n = norm(face.normalAt().toTuple() as Vec3);
      const at = face.pointOnSurface(0.5, 0.5).toTuple() as Vec3;
      const floors = inner.faces.filter((g) => {
        if (g.geomType !== "PLANE" || dot(norm(g.normalAt().toTuple() as Vec3), n) < 1 - 1e-6) return false;
        const { p } = pointOnFace(inner!, g);
        if (Math.abs(dot(sub(p, at), n) + t) > tol * 10) return false;
        // (Another face of the body on the same plane, not opened: its floor stays.)
        return measureDistanceBetween(makeVertex(add(p, scale(n, t))), face) < tol * 10;
      });
      if (!floors.length) byOutline.push({ face, n });
      for (const g of floors) hollow = hollow.fuse(basicFaceExtrusion(g.clone(), new Vector(scale(n, t * 1.5))) as Shape3D);
    }
    let skin = body.cut(hollow);
    for (const { face, n } of byOutline) {
      // (No such floor found: the face's outline brought in by the wall thickness, pushed through.)
      const wire = face.clone().outerWire().offset2D(-t, "intersection");
      const start = new Vector(scale(n, t * 0.5));
      const hole = basicFaceExtrusion(makeFace(wire).translate(start), new Vector(scale(n, -t * 2)));
      skin = skin.cut(hole);
    }
    return skin;
  } catch {
    return null;
  } finally {
    off.delete();
  }
}

/** Remove a vertex that only splits an edge or face (merges what it separates). */
function deleteVertex(body: Shape3D, at: Vec3): Shape3D {
  const merged = unify(body);
  const tol = 1e-6 * (Math.hypot(body.boundingBox.width, body.boundingBox.height, body.boundingBox.depth) || 1);
  const still = merged.edges.some((e) => dist(e.startPoint.toTuple() as Vec3, at) < tol || dist(e.endPoint.toTuple() as Vec3, at) < tol);
  if (still) throw new Error("This corner can't be removed - it's where faces meet");
  return merged;
}

// ------------------------------------------------------------ feature helpers

/** Steps switched off in this rebuild (a step made from one says so, not "deleted"). */
let switchedOff = new Set<string>();
const noSketch = (id: string) => new Error(switchedOff.has(id) ? "Its sketch is switched off - turn it back on in History" : "Its sketch was deleted");

/** Faces (with their outward normal) for a profile or a body face. */
function sourceFaces(src: ExtrudeSource, ctx: Ctx): { face: Face; normal: Vec3 }[] {
  if (src.kind === "profile") {
    const sketch = ctx.sketches.get(src.sketch);
    if (!sketch) throw noSketch(src.sketch);
    return regionFaces(allCurves(sketch), sketch.plane, src.regions).map((face) => ({ face, normal: sketch.plane.normal }));
  }
  const face = resolveFace(need(ctx.bodies, src.face.body), src.face);
  if (face.geomType !== "PLANE") throw new Error("Only flat faces can be used here");
  return [{ face, normal: norm(face.normalAt().toTuple() as Vec3) }];
}

/** Plane of a loft section. */
function sectionFrame(src: ExtrudeSource, ctx: Ctx): { origin: Vec3; normal: Vec3 } {
  if (src.kind === "profile") {
    const sketch = ctx.sketches.get(src.sketch);
    if (!sketch) throw noSketch(src.sketch);
    return { origin: sketch.plane.origin, normal: norm(sketch.plane.normal) };
  }
  const face = resolveFace(need(ctx.bodies, src.face.body), src.face);
  return { origin: face.center.toTuple() as Vec3, normal: norm(face.normalAt().toTuple() as Vec3) };
}

function sourceWires(src: ExtrudeSource, ctx: Ctx): Wire[] {
  if (src.kind === "profile") {
    const sketch = ctx.sketches.get(src.sketch);
    if (!sketch) throw noSketch(src.sketch);
    return src.regions.map((r) => regionWire(allCurves(sketch), sketch.plane, r));
  }
  return [resolveFace(need(ctx.bodies, src.face.body), src.face).outerWire()];
}

/**
 * Each profile's body made from its outline, its holes made the same way and
 * cut out (a sweep or a coil only follows a wire: a gear's bore or a tube's
 * inside was filled in). `make` gets the outline too, to size things by it.
 */
function withHoles(src: ExtrudeSource, ctx: Ctx, make: (w: Wire, outer: Wire) => Shape3D): Shape3D[] {
  const outers = sourceWires(src, ctx);
  let holes: Wire[][];
  if (src.kind === "profile") {
    const sketch = ctx.sketches.get(src.sketch)!;
    holes = src.regions.map((r) => regionHoleWires(allCurves(sketch), sketch.plane, r));
  } else holes = [resolveFace(need(ctx.bodies, src.face.body), src.face).innerWires()];
  return outers.map((w, i) => {
    const body = make(w, w);
    const cuts = (holes[i] ?? []).map((h) => make(h, w));
    return cuts.length ? body.cut(fuseAll(cuts)) : body;
  });
}

function pathWire(path: PathRef, ctx: Ctx): Wire {
  if (path.kind === "sketch") {
    const sketch = ctx.sketches.get(path.sketch);
    if (!sketch) throw new Error("The path sketch was deleted");
    return entitiesWire(sketch.entities, path.entities, sketch.plane);
  }
  const edges: Edge[] = path.edges.map((r) => resolveEdge(need(ctx.bodies, r.body), r));
  return assembleWire(edges);
}

/** A wire's points in order along it, close together (curves sampled finely). */
function wirePoints(w: Wire): Vec3[] {
  const pts: Vec3[] = [];
  for (const e of w.edges) {
    const n = e.geomType === "LINE" ? 1 : 200;
    let seg: Vec3[] = [];
    for (let i = 0; i <= n; i++) seg.push(e.pointAt(i / n).toTuple() as Vec3);
    // Edges run end to end, each its own way round.
    if (pts.length && dist(seg[seg.length - 1], pts[pts.length - 1]) < dist(seg[0], pts[pts.length - 1])) seg = seg.reverse();
    if (pts.length === 0 && w.edges.length > 1) {
      const next = w.edges[1];
      const ends = [next.pointAt(0).toTuple() as Vec3, next.pointAt(1).toTuple() as Vec3];
      const near = (p: Vec3) => Math.min(...ends.map((q) => dist(p, q)));
      if (near(seg[0]) < near(seg[seg.length - 1])) seg = seg.reverse();
    }
    pts.push(...(pts.length ? seg.slice(1) : seg));
  }
  return pts;
}

/**
 * Face F of `body` is the end of a sweep (square to its path's end, the path
 * ending on it): cut `by` off along the path, so the tube is that much
 * shorter and its new end is square to the path where it now ends. A disc
 * wider than the end is swept along that last piece of the path (starting a
 * little past the end) and cut away. Null when F isn't a sweep's end.
 */
function trimSweepEnd(body: Shape3D, F: Face, by: number, ctx: Ctx): Shape3D | null {
  if (F.geomType !== "PLANE" || !ctx.sweeps.size) return null;
  const { origin, normal } = planeOf(F);
  const bb = F.boundingBox;
  const size = Math.hypot(bb.width, bb.height, bb.depth);
  const c = F.center.toTuple() as Vec3;
  for (const spine of ctx.sweeps.values()) {
    const all = wirePoints(spine);
    // Every place the path passes through F's plane heading out through F
    // (the end itself, or where an earlier push left it): the one at F. On an
    // S-bend the plane cuts the path elsewhere too.
    const side = (p: Vec3) => dot(sub(p, origin), normal);
    const tolPlane = size * 0.05 + 1e-6;
    let best: { pts: Vec3[]; out: Vec3; d: number } | null = null;
    for (const way of [all, [...all].reverse()]) {
      for (let k = 0; k < way.length - 1; k++) {
        const a0 = side(way[k]);
        const a1 = side(way[k + 1]);
        if (!(a0 >= -tolPlane && a1 < a0 && a1 <= tolPlane)) continue;
        const out = norm(sub(way[k], way[k + 1]));
        if (Math.abs(dot(out, normal)) < 0.98) continue;
        // (The sweep turns its profile square to the path: a profile drawn a
        // little off square ends on a plane a hair off the path's end.)
        const t0 = a0 <= tolPlane && k === 0 ? 0 : Math.min(1, Math.max(0, a0 / (a0 - a1)));
        const q = add(way[k], scale(sub(way[k + 1], way[k]), t0));
        const d = dist(q, c);
        if (d <= size && (!best || d < best.d)) best = { pts: [q, ...way.slice(k + 1)], out, d };
      }
    }
    if (best) {
      const { pts, out } = best;
      const p0 = pts[0];
      // The piece of path to take off: from the end, `by` along it.
      const piece: Vec3[] = [p0];
      let run = 0;
      let i = 1;
      for (; i < pts.length; i++) {
        const step = dist(pts[i - 1], pts[i]);
        if (run + step >= by) {
          const t = (by - run) / step;
          piece.push(add(pts[i - 1], scale(sub(pts[i], pts[i - 1]), t)));
          run = by;
          break;
        }
        run += step;
        piece.push(pts[i]);
      }
      if (run < by - 1e-9 || i >= pts.length - 1) throw new Error("That's as long as the sweep's whole path or more - it would remove it");
      // Straight line pieces stay a line; a curve is fitted through its points.
      const straight = piece.every((p) => len(sub(sub(p, p0), scale(norm(sub(piece[piece.length - 1], p0)), dot(sub(p, p0), norm(sub(piece[piece.length - 1], p0)))))) < size * 1e-6);
      const lead = size * 0.05 + 1e-3;
      const start = add(p0, scale(out, lead));
      const curve = straight || piece.length < 4 ? makeLine(p0, piece[piece.length - 1]) : makeBSplineApproximation(piece, { tolerance: size * 1e-4 + 1e-6, degMax: 5, degMin: 2 });
      const path = assembleWire([makeLine(start, p0), curve]);
      let reach0 = 0;
      for (const e of F.edges) for (let j = 0; j <= 16; j++) reach0 = Math.max(reach0, dist(e.pointAt(j / 16).toTuple() as Vec3, p0));
      const r = reach0 * 1.1 + size * 0.02;
      const disc = assembleWire([makeCircle(r, start, scale(out, -1))]);
      const cutter = genericSweep(disc, path, { frenet: false, transitionMode: "round" }) as Shape3D;
      const result = fuzzyBoolean("cut", body, cutter);
      if (isEmpty(result)) throw new Error("That would remove the whole sweep");
      return result;
    }
  }
  return null;
}

function resolveAxis(a: AxisRef, ctx: Ctx): { origin: Vec3; dir: Vec3 } {
  if (a.ref?.kind === "sketchLine") {
    const s = ctx.sketches.get(a.ref.sketch);
    const e = s?.entities.find((x) => x.id === (a.ref as { entity: string }).entity);
    if (s && e?.kind === "line") {
      const p = toWorld(s.plane, e.a);
      return { origin: p, dir: norm(sub(toWorld(s.plane, e.b), p)) };
    }
  }
  if (a.ref?.kind === "axis") {
    const ax = ctx.axes.get(a.ref.feature);
    if (ax) return { origin: ax.plane.origin, dir: ax.plane.normal };
  }
  return { origin: a.origin, dir: norm(a.dir) };
}

/** Put a new solid into the model: new body, or join/cut a target. */
function combine(id: string, mode: string, target: string | undefined, solid: Shape3D, negative: boolean, ctx: Ctx): void {
  // (A mode that isn't one - a damaged file: the body was left as it was, and nothing said so.)
  if (typeof mode === "string" && !["auto", "new", "join", "cut", "intersect"].includes(mode)) throw new Error(DAMAGED_TEXT);
  const m = mode === "auto" ? (target ? (negative ? "cut" : "join") : "new") : mode;
  // Add or Cut picked, with no body named (drawn on the floor, not on a face):
  // it acts on what it runs into - Add on the body it touches, Cut on every
  // body it overlaps. (It used to make a separate body: a nave "added" to its
  // tower stood beside it as Body 2.)
  if (!target && m === "cut") {
    for (const hit of overlapping(solid, ctx)) {
      const t = ctx.bodies.get(hit)!;
      const out = checkedBoolean("cut", t, solid);
      if (isEmpty(out)) ctx.bodies.delete(hit);
      else ctx.bodies.set(hit, out);
      ctx.freeforms.delete(hit);
    }
    return;
  }
  // Intersect: only what's in both stays - of the body named, or (none named) of every body it overlaps.
  if (m === "intersect") {
    const hits = target ? [target] : overlapping(solid, ctx);
    if (!hits.length) throw new Error("It overlaps no body - Intersect keeps only what's in both");
    for (const hit of hits) {
      const out = fuzzyBoolean("common", need(ctx.bodies, hit), solid);
      if (isEmpty(out)) ctx.bodies.delete(hit);
      else ctx.bodies.set(hit, out);
      ctx.freeforms.delete(hit);
    }
    return;
  }
  if (!target && m === "join") target = touching(solid, ctx)[0];
  if (m === "new" || !target) {
    ctx.bodies.set(id, solid);
    return;
  }
  const t = need(ctx.bodies, target);
  const result = m === "join" ? checkedBoolean("fuse", t, solid) : m === "cut" ? checkedBoolean("cut", t, solid) : t;
  if (isEmpty(result)) ctx.bodies.delete(target);
  else ctx.bodies.set(target, result);
}

/**
 * A join or a cut held to a volume it can have. OpenCascade can get a boolean
 * wrong without saying so (a thread only just overlapping the core it's
 * joined to): its volume then can't be right - the plain way is tried, and
 * if that's wrong too, said. (Every cut and join of a new solid goes through
 * here: one aimed at a body, and one that takes whatever it runs into.)
 */
function checkedBoolean(op: "fuse" | "cut", t: Shape3D, solid: Shape3D): Shape3D {
  const result = fuzzyBoolean(op, t, solid);
  if (booleanVolumeOk(op, t, solid, result)) return result;
  const plain = op === "fuse" ? t.fuse(solid) : t.cut(solid);
  if (!booleanVolumeOk(op, t, solid, plain)) throw new Error(op === "fuse" ? "Joining these didn't work out - the shapes only just overlap here: let them overlap more" : "This cut didn't work out - the shapes only just overlap here: let them overlap more, or less");
  return plain;
}

/**
 * A shape's (signed) volume, worked out once per shape: a cut asks for its
 * body's, its tool's and its result's in several checks, and again for the
 * same body on every move of a drag - slow on a freeform's curved faces.
 * (A shape turned right way out in place is measured again, not looked up.)
 */
const volumes = new WeakMap<Shape3D, number>();
function volumeOf(s: Shape3D): number {
  let v = volumes.get(s);
  if (v === undefined) {
    v = measureVolume(s);
    volumes.set(s, v);
  }
  return v;
}

/**
 * Can this be the volume of a ∪ b (or a − b)? A union is at least the bigger
 * of the two and at most both together; a cut is at most a and at least a − b.
 */
function booleanVolumeOk(op: "fuse" | "cut", a: Shape3D, b: Shape3D, r: Shape3D): boolean {
  try {
    const va = Math.abs(volumeOf(a));
    const vb = Math.abs(volumeOf(b));
    const v = isEmpty(r) ? 0 : volumeOf(r);
    // A big many-faced body measures a little differently once a join splits
    // its faces (a jet engine's casing: 2 to 75 mm³ in 1.9 litres) - more than
    // the name raised on its pylon (158 mm³) could stand under a closer check.
    // A boolean gone wrong is off by about the smaller shape, or more.
    const fits = (va: number, vb: number, v: number) => {
      const tol = (va + vb) * 1e-5 + Math.min(va, vb) * 0.6 + 1e-9;
      if (!Number.isFinite(v) || v < -tol) return false;
      return op === "fuse" ? v >= Math.max(va, vb) - tol && v <= va + vb + tol : v <= va + tol && v >= va - vb - tol;
    };
    if (fits(va, vb, v)) return true;
    // The measured volume can be off by far more than a small tool on some
    // curved faces (a shelled loft: 455 mm³ either way on a drill's housing),
    // and differently once a cut splits a face near them - two terminal slots
    // (120 mm³) "took" 920. Counted from meshes, it's the true change - asked
    // only of a sound cut (a thread's failed joins, meshed, took 10 s each).
    if (op !== "cut" || isEmpty(r) || !shapeValid(r)) return false;
    const size = Math.max(sizeOf(a), sizeOf(b));
    return fits(Math.abs(meshVolume(a, size)), Math.abs(meshVolume(b, size)), meshVolume(r, size));
  } catch {
    return true; // can't tell: leave it to the usual checks
  }
}


/**
 * Flat pieces of one plane that meet, joined into one face each (pieces apart
 * stay apart): each lifted into a thin slab, the slabs joined, and the joined
 * slab's top brought back down (OpenCascade doesn't merge loose faces).
 */
function mergedFaces(faces: Face[], normal: Vec3): Face[] {
  if (faces.length < 2) return faces;
  try {
    const n = norm(normal);
    const h = Math.max(1e-3, Math.max(...faces.map((f) => sizeOf(f as unknown as Shape3D))) * 0.01);
    const slab = unify(fuseAll(faces.map((f) => basicFaceExtrusion(f, new Vector(scale(n, h))))));
    const top = slab.faces.filter((f) => f.geomType === "PLANE" && dot(norm(f.normalAt().toTuple() as Vec3), n) > 0.9999);
    const level = Math.max(...top.map((f) => dot(f.center.toTuple() as Vec3, n)));
    const out = top.filter((f) => Math.abs(dot(f.center.toTuple() as Vec3, n) - level) < h * 0.01).map((f) => f.translate(scale(n, -h)) as Face);
    return out.length ? out : faces;
  } catch {
    return faces;
  }
}

/**
 * A boolean that treats surfaces within a small tolerance as the same (OCCT's
 * fuzzy option): geometry built from a body's own edges lines up with it.
 */
function fuzzyBoolean(op: "cut" | "fuse" | "common", a: Shape3D, b: Shape3D): Shape3D {
  const oc = getOC();
  const tol = Math.max(1e-7, sizeOf(a) * 1e-6);
  const algo = op === "cut" ? new oc.BRepAlgoAPI_Cut() : op === "fuse" ? new oc.BRepAlgoAPI_Fuse() : new oc.BRepAlgoAPI_Common();
  const args = new oc.NCollection_List_TopoDS_Shape();
  const tools = new oc.NCollection_List_TopoDS_Shape();
  const progress = new oc.Message_ProgressRange();
  try {
    args.Append(a.wrapped);
    tools.Append(b.wrapped);
    algo.SetArguments(args);
    algo.SetTools(tools);
    algo.SetFuzzyValue(tol);
    // (Never adjusting a or b: they're earlier steps' results.)
    algo.SetNonDestructive(true);
    algo.Build(progress);
    if (!algo.IsDone()) throw new Error("boolean failed");
    // (The kernel's handle to what it made is given back once the body has its own: release.ts.)
    const made = algo.Shape();
    let out: Shape3D;
    try {
      out = cast(withoutInternals(made)) as Shape3D;
    } finally {
      made.delete();
    }
    // Fuse and cut keep their faces tidy like the usual booleans do.
    return op === "common" ? out : (unify(out, Math.max(sizeOf(a), sizeOf(b))) as Shape3D);
  } catch (err) {
    // (The engine itself breaking down is not a boolean to try another way.)
    if (isFault(err)) throw err;
    try {
      return op === "cut" ? a.cut(b) : op === "fuse" ? a.fuse(b) : a.intersect(b);
    } catch {
      // Neither way gave a shape (OpenCascade's "shape is null"): say so plainly.
      throw new Error("The geometry engine couldn't work this out where these meet - try moving one a little");
    }
  } finally {
    algo.delete();
    args.delete();
    tools.delete();
    progress.delete();
  }
}

/** Is the face flat (every point on one plane, every normal the same)? */
function isFlat(face: Face, tol: number): boolean {
  try {
    const mid = surfaceAt(face, 0.5, 0.5);
    const n0 = norm(mid.n);
    const o = mid.p;
    for (let i = 0; i <= 4; i++)
      for (let j = 0; j <= 4; j++) {
        const { p, n } = surfaceAt(face, i / 4, j / 4);
        if (Math.abs(dot(sub(p, o), n0)) > tol) return false;
        if (len(cross(norm(n), n0)) > 1e-7) return false;
      }
    return true;
  } catch {
    return false;
  }
}

/** The cylinder a face lies on (its axis and radius), if it's one: every normal square to one direction, meeting one line. */
function cylinderFit(face: Face, tol: number): { c: Vec3; a: Vec3; r: number } | null {
  const P: Vec3[] = [];
  const N: Vec3[] = [];
  for (let i = 0; i <= 4; i++)
    for (let j = 0; j <= 4; j++) {
      const { p, n } = surfaceAt(face, i / 4, j / 4);
      P.push(p);
      N.push(norm(n));
    }
  // The axis: square to the two normals furthest apart.
  let best = 0;
  let a: Vec3 = [0, 0, 0];
  for (let k = 1; k < N.length; k++) {
    const c = cross(N[0], N[k]);
    if (len(c) > best) [best, a] = [len(c), c];
  }
  if (best < 1e-3) return null;
  a = norm(a);
  if (N.some((n) => Math.abs(dot(n, a)) > 1e-7)) return null;
  // Where the normals at 0 and the furthest one meet (seen along the axis): the centre.
  const k = N.findIndex((n) => len(cross(N[0], n)) === best);
  const flat = (p: Vec3) => sub(p, scale(a, dot(p, a)));
  const [p0, pk, n0, nk] = [flat(P[0]), flat(P[k]), flat(N[0]), flat(N[k])];
  // p0 + t n0 = pk + s nk: solved in the plane square to the axis.
  const w = sub(pk, p0);
  const den = dot(cross(n0, nk), a);
  if (Math.abs(den) < 1e-9) return null;
  const t = dot(cross(w, nk), a) / den;
  const c = add(p0, scale(n0, t));
  const r = Math.abs(t);
  if (P.some((p) => Math.abs(len(sub(flat(p), c)) - r) > tol * 10)) return null;
  return { c, a, r };
}

/** The face rebuilt on a true cylinder, within its own edges (null if that doesn't work out). */
function asCylinder(face: Face, cyl: { c: Vec3; a: Vec3; r: number }, size: number): Face | null {
  const oc = getOC();
  const L = size * 4 + cyl.r;
  const solid = makeCylinder(cyl.r, 2 * L, sub(cyl.c, scale(cyl.a, L)), cyl.a);
  const side = solid.faces.find((g) => g.geomType === "CYLINDRE");
  if (!side) return null;
  const surface = oc.BRep_Tool.Surface(side.wrapped);
  const wires = [face.clone().outerWire(), ...face.clone().innerWires()];
  const maker = new oc.BRepBuilderAPI_MakeFace(surface, wires[0].wrapped, true);
  try {
    for (const w of wires.slice(1)) maker.Add(w.wrapped);
    if (!maker.IsDone()) return null;
    const fix = new oc.ShapeFix_Face(maker.Face());
    try {
      fix.Perform();
      fix.FixOrientation();
      const out = cast(fix.Face()) as Face;
      return out.geomType === "CYLINDRE" && Math.abs(measureArea(out) - measureArea(face)) < Math.max(1e-9, measureArea(face) * 1e-5) ? out : null;
    } finally {
      fix.delete();
    }
  } finally {
    maker.delete();
  }
}

/**
 * Faces that are flat but not stored as planes - a straight side swept round
 * an arc is a "surface of revolution" - made planes: they merge with the flat
 * faces either side, and Move / Scale / Replace Face can tilt and trim them
 * (a lever's tip couldn't be narrowed, its bottom couldn't be brought down:
 * "the neighbouring faces don't enclose it"). The shape stays as it was if
 * anything doesn't come out exactly the same.
 */
function flatFaces(s: Shape3D): Shape3D {
  const size = sizeOf(s);
  const tol = size * 1e-7 + 1e-9;
  let changed = false;
  const faces = s.faces.map((f) => {
    if (f.geomType === "PLANE" || f.geomType === "CYLINDRE") return f;
    try {
      if (isFlat(f, tol)) {
        // (outerWire uses up the face it is asked of.)
        const flat = makeFace(f.clone().outerWire(), f.clone().innerWires());
        if (flat.geomType !== "PLANE") return f;
        changed = true;
        return flat;
      }
      // A straight line swept round an arc, along its axis: a cylinder.
      const cyl = cylinderFit(f, tol);
      if (!cyl) return f;
      const round = asCylinder(f, cyl, size);
      if (!round) return f;
      changed = true;
      return round;
    } catch {
      return f;
    }
  });
  if (!changed) return s;
  try {
    const solid = makeSolid(faces) as unknown as Shape3D;
    const v = Math.abs(volumeOf(s));
    if (!shapeValid(solid) || Math.abs(Math.abs(volumeOf(solid)) - v) > Math.max(1e-9, v * 1e-6)) return s;
    return unify(solid, size) as Shape3D;
  } catch {
    return s;
  }
}

/** Bodies (other than `skip`) that `solid` really overlaps (not just touches). */
function overlapping(solid: Shape3D, ctx: Ctx, skip?: string): string[] {
  const sb = solid.boundingBox;
  const vs = Math.abs(volumeOf(solid));
  const out: string[] = [];
  for (const [id, body] of ctx.bodies) {
    if (id === skip) continue;
    const bb = body.boundingBox;
    const apart = [0, 1, 2].some((k) => (bb.bounds[1] as number[])[k] < (sb.bounds[0] as number[])[k] || (bb.bounds[0] as number[])[k] > (sb.bounds[1] as number[])[k]);
    if (apart) continue;
    try {
      // Tolerant: a wall drawn from the body's own edge (projected, offset…) sits a hair
      // off the body's surface, and an exact boolean then finds no overlap at all.
      const common = fuzzyBoolean("common", body, solid);
      if (!isEmpty(common) && Math.abs(measureVolume(common)) > Math.max(1e-9, Math.min(vs, Math.abs(volumeOf(body))) * 1e-6)) out.push(id);
    } catch {
      // can't tell: leave it alone
    }
  }
  return out;
}

/** Bodies the solid overlaps or touches, the most overlapped first. */
function touching(solid: Shape3D, ctx: Ctx): string[] {
  const over = overlapping(solid, ctx);
  const sb = solid.boundingBox;
  const size = Math.max(1e-9, ...[0, 1, 2].map((k) => (sb.bounds[1] as number[])[k] - (sb.bounds[0] as number[])[k]));
  const tol = size * 1e-6 + 1e-7;
  const near: string[] = [];
  for (const [id, body] of ctx.bodies) {
    if (over.includes(id)) continue;
    const bb = body.boundingBox;
    const apart = [0, 1, 2].some((k) => (bb.bounds[1] as number[])[k] < (sb.bounds[0] as number[])[k] - tol || (bb.bounds[0] as number[])[k] > (sb.bounds[1] as number[])[k] + tol);
    if (apart) continue;
    try {
      if (measureDistanceBetween(body, solid) <= tol) near.push(id);
    } catch {
      // can't tell: not counted
    }
  }
  return [...over, ...near];
}

function fuseAll(parts: Shape3D[]): Shape3D {
  if (!parts.length) throw new Error("Nothing to build");
  // In pairs, then pairs of those…: each fuse joins two pieces of about the
  // same size. One by one onto a growing result, the scale of a ruler (170
  // ticks and digits) took over a minute; this way a few seconds.
  let level = parts;
  while (level.length > 1) {
    const next: Shape3D[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? level[i].fuse(level[i + 1]) : level[i]);
    level = next;
  }
  return level[0];
}

function transform(f: Extract<Feature, { type: "transform" }>, ctx: Ctx): void {
  const op = f.op;
  const copies: [string, Shape3D][] = [];
  for (const id of f.bodies) {
    const body = need(ctx.bodies, id);
    const results: Shape3D[] = [];
    switch (op.kind) {
      case "move": {
        let s = body.clone();
        if (op.rotate && Math.abs(op.rotate.angle) > 1e-9) s = s.rotate(op.rotate.angle, op.rotate.origin, op.rotate.axis);
        if (len(op.translate) > 1e-9) s = s.translate(op.translate);
        results.push(s);
        break;
      }
      case "scale":
        if (op.factor <= 0) throw new Error("Scale must be positive");
        results.push(body.clone().scale(op.factor, op.center));
        break;
      case "scaleXYZ": {
        if (op.factors.some((k) => k <= 0)) throw new Error("Scale factors must be positive");
        const ff = ctx.freeforms.get(id);
        const [kx, ky, kz] = op.factors;
        // A freeform is rebuilt from its stretched cage (smooth as ever); any
        // other body is rebuilt face by face, stretched (all three the same: a plain scale).
        if (ff) results.push(freeformShape(ff.feature, affineThen(ff.m, scaleAbout(op.center, op.factors))));
        else if (Math.abs(kx - ky) < 1e-12 && Math.abs(ky - kz) < 1e-12) results.push(body.clone().scale(kx, op.center));
        else results.push(stretchShape(body, op.center, op.factors));
        break;
      }
      case "mirror":
        results.push(body.clone().mirror(op.plane.normal, op.plane.origin));
        break;
      case "linear":
        patternCount(op.count);
        if (Math.abs(op.spacing) < 1e-9 || len(op.dir) < 1e-12) throw new Error("The spacing is zero: the copies would all sit in one place");
        for (let k = 1; k < op.count; k++) results.push(body.clone().translate(scale(norm(op.dir), op.spacing * k)));
        break;
      case "circular": {
        patternCount(op.count);
        if (Math.abs(op.angle) < 1e-9) throw new Error("The angle is zero: the copies would all sit in one place");
        const ax = resolveAxis(op.axis, ctx);
        const full = Math.abs(Math.abs(op.angle) - 360) < 1e-6;
        const step = op.angle / (full ? op.count : Math.max(1, op.count - 1));
        for (let k = 1; k < op.count; k++) results.push(body.clone().rotate(step * k, ax.origin, ax.dir));
        break;
      }
    }
    // Moved without changing shape: its mesh can be this body's, moved.
    const rigid = (k: number): Affine | null => {
      if (op.kind === "move" || op.kind === "mirror") return opAffine(op);
      if (op.kind === "linear") return affineFrom((p) => add(p, scale(norm(op.dir), op.spacing * (k + 1))));
      if (op.kind === "circular") {
        const ax = resolveAxis(op.axis, ctx);
        const full = Math.abs(Math.abs(op.angle) - 360) < 1e-6;
        const step = op.angle / (full ? op.count : Math.max(1, op.count - 1));
        return affineFrom((p) => rotateAbout(p, ax.origin, ax.dir, step * (k + 1)));
      }
      return null;
    };
    results.forEach((s, k) => {
      const m = rigid(k);
      if (!m) return;
      movedFrom.set(s, { from: new WeakRef(body), m, flip: op.kind === "mirror" });
      // (Its faces are still the steps' that made them: see movedTags.)
      movedTags(body, s, f.id, m);
    });
    const isPattern = op.kind === "linear" || op.kind === "circular";
    // A freeform stays rebuildable through moves, scales and mirrors (copies too).
    const ff = ctx.freeforms.get(id);
    const step = ff && !isPattern ? opAffine(op) : null;
    if (isPattern || f.copy) {
      results.forEach((s, k) => copies.push([`${f.id}:${id}:${k}`, s]));
      if (ff && step) ctx.freeforms.set(`${f.id}:${id}:0`, { feature: ff.feature, m: affineThen(ff.m, step) });
    } else {
      ctx.bodies.set(id, results[0]);
      if (ff && step) ctx.freeforms.set(id, { feature: ff.feature, m: affineThen(ff.m, step) });
      else ctx.freeforms.delete(id);
    }
  }
  for (const [id, s] of copies) ctx.bodies.set(id, s);
}

/** Solid filling the positive side of a plane, big enough to contain `body`. */
/** A body cut by planes and other bodies' surfaces at once (OpenCascade's Splitter): the pieces, biggest first. */
function splitAll(body: Shape3D, planes: PlaneDef[], tools: Shape3D[]): Shape3D[] {
  const oc = getOC();
  const sp = new oc.BRepAlgoAPI_Splitter();
  const args = new oc.NCollection_List_TopoDS_Shape();
  const list = new oc.NCollection_List_TopoDS_Shape();
  const progress = new oc.Message_ProgressRange();
  try {
    args.Append(body.wrapped);
    const bb = body.boundingBox;
    for (const plane of planes) {
      // A sheet of the plane wider than the body.
      const L = (Math.hypot(bb.width, bb.height, bb.depth) + dist(bb.center as Vec3, plane.origin)) * 2 + 10;
      const x = plane.xDir;
      const y = cross(plane.normal, x);
      const corner = (u: number, v: number): Vec3 => add(plane.origin, add(scale(x, u * L), scale(y, v * L)));
      list.Append(makePolygon([corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)]).wrapped);
    }
    for (const t of tools) list.Append(t.wrapped);
    sp.SetArguments(args);
    sp.SetTools(list);
    sp.SetFuzzyValue(1e-5);
    sp.Build(progress);
    if (!sp.IsDone()) throw new Error("It couldn't be split with those");
    const pieces = subShapes(cast(sp.Shape()) as Shape3D, "SOLID").map((x) => cast(x) as Shape3D);
    const vol = pieces.map((p) => Math.abs(volumeOf(p)));
    return pieces.map((p, i) => ({ p, v: vol[i] })).filter((x) => x.v > 1e-9).sort((a, b) => b.v - a.v).map((x) => x.p);
  } finally {
    sp.delete();
    args.delete();
    list.delete();
    progress.delete();
  }
}

function halfSpace(plane: PlaneDef, body: Shape3D): Shape3D {
  const bb = body.boundingBox;
  const L = (Math.hypot(bb.width, bb.height, bb.depth) + dist(bb.center as Vec3, plane.origin)) * 2 + 10;
  const x = plane.xDir;
  const y = cross(plane.normal, x);
  const o = plane.origin;
  const corner = (u: number, v: number): Vec3 => add(o, add(scale(x, u * L), scale(y, v * L)));
  const face = makePolygon([corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)]);
  return basicFaceExtrusion(face, new Vector(plane.normal).multiply(L));
}

/** What an extrusion goes up to: the face as it is now (a flat one: its whole plane), or a plane; and a point on it. */
function extrudeTarget(to: { face?: FaceRef; plane?: PlaneDef }, ctx: Ctx): { shape: Shape3D; point: Vec3; plane?: PlaneDef } {
  if (to.face) {
    const face = resolveFace(need(ctx.bodies, to.face.body), to.face);
    // A flat face: its whole plane (an extrusion wider than the face still stops there).
    if (face.geomType === "PLANE") {
      const point = face.center.toTuple() as Vec3;
      const normal = norm(face.normalAt().toTuple() as Vec3);
      return { shape: face as unknown as Shape3D, point, plane: { origin: point, normal, xDir: xDirFor(normal) } };
    }
    return { shape: face as unknown as Shape3D, point: face.center.toTuple() as Vec3 };
  }
  const plane = to.plane!;
  return { shape: makeVertex(plane.origin) as unknown as Shape3D, point: plane.origin, plane };
}

/** Far enough to come out of every body, the shapes and the target: twice everything's span. */
function reachOf(ctx: Ctx, shapes: Shape3D[], extra?: Shape3D): number {
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const s of [...ctx.bodies.values(), ...shapes, ...(extra ? [extra] : [])]) {
    const [a, b] = s.boundingBox.bounds;
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], a[k]);
      hi[k] = Math.max(hi[k], b[k]);
    }
  }
  if (!Number.isFinite(lo[0])) return 1000;
  return Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) * 2 + 10;
}

/** An extrusion stopped at its target: a plane cuts off what's beyond it; a round face splits it and the part at the shape stays. */
function trimmedTo(solid: Shape3D, to: { shape: Shape3D; point: Vec3; plane?: PlaneDef }, from: Vec3): Shape3D {
  if (to.plane) {
    // The half beyond the plane (away from the shape) goes.
    const n = dot(sub(from, to.plane.origin), to.plane.normal) > 0 ? scale(to.plane.normal, -1) : to.plane.normal;
    const beyond = halfSpace({ ...to.plane, normal: n, xDir: xDirFor(n) }, solid);
    const out = fuzzyBoolean("cut", solid, beyond);
    if (isEmpty(out)) throw new Error("Nothing is left before that face or plane - it's behind the shape");
    return out;
  }
  const oc = getOC();
  const sp = new oc.BRepAlgoAPI_Splitter();
  const args = new oc.NCollection_List_TopoDS_Shape();
  const tools = new oc.NCollection_List_TopoDS_Shape();
  const progress = new oc.Message_ProgressRange();
  try {
    args.Append(solid.wrapped);
    tools.Append(to.shape.wrapped);
    sp.SetArguments(args);
    sp.SetTools(tools);
    sp.Build(progress);
    if (!sp.IsDone()) throw new Error("It couldn't be stopped at that face");
    const pieces = subShapes(cast(sp.Shape()) as Shape3D, "SOLID").map((x) => cast(x) as Shape3D);
    if (pieces.length < 2) throw new Error("It doesn't run all the way across that face - pick a face it passes through whole, or a plane");
    // The piece the shape starts from: the one nearest it.
    const at = makeVertex(from) as unknown as Shape3D;
    const d = pieces.map((p) => measureDistanceBetween(p, at));
    const best = Math.min(...d);
    return fuseAll(pieces.filter((_, i) => d[i] <= best + 1e-6));
  } finally {
    sp.delete();
    args.delete();
    tools.delete();
    progress.delete();
  }
}

/** A straight extrusion's sides leaned `deg` degrees in (a draft) towards its far end along `dir`, hinged on the plane through `origin`. */
function drafted(solid: Shape3D, dir: Vec3, origin: Vec3, deg: number): Shape3D {
  const oc = getOC();
  const n = norm(dir);
  const d = new oc.gp_Dir(n[0], n[1], n[2]);
  const at = new oc.gp_Pnt(origin[0], origin[1], origin[2]);
  const pln = new oc.gp_Pln(at, d);
  const mk = new oc.BRepOffsetAPI_DraftAngle(solid.wrapped);
  const progress = new oc.Message_ProgressRange();
  const fail = "These sides can't lean that far - try a smaller draft angle";
  try {
    for (const face of solid.faces) {
      // The ends stay as they are; every side leans.
      if (face.geomType === "PLANE" && Math.abs(dot(norm(face.normalAt().toTuple() as Vec3), n)) > 0.999) continue;
      mk.Add(oc.TopoDS.Face(face.wrapped), d, (DRAFT_SIGN * deg * Math.PI) / 180, pln, true);
      if (!mk.AddDone()) throw new Error(fail);
    }
    mk.Build(progress);
    if (!mk.IsDone()) throw new Error(fail);
    const out = cast(mk.Shape());
    if (!isShape3D(out) || !shapeValid(out)) throw new Error(fail);
    return out;
  } finally {
    mk.delete();
    pln.delete();
    at.delete();
    d.delete();
    progress.delete();
  }
}
/** Which way OpenCascade's draft angle leans (checked in tests: a positive draft narrows the far end). */
const DRAFT_SIGN = 1;

/** Each sketch as it was last made (see the sketch step). */
const sketchWas = new Map<string, { text: string; state: SketchState }>();

/** The same thing, every number within `tol` of the other's. */
function sameNumbers(a: unknown, b: unknown, tol: number): boolean {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= tol;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => sameNumbers(x, b[i], tol));
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object);
    return ka.length === Object.keys(b as object).length && ka.every((k) => sameNumbers((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], tol));
  }
  return a === b;
}

/**
 * A sketch's curves with those that follow a body's edge put where the edge
 * is now (seen straight onto the sketch's plane), and the rest moved by the
 * sketch's dimensions and constraints to them.
 */
function followEdges(f: SketchFeature, plane: PlaneDef, bodies: Bodies): SketchEntity[] {
  const links = new Map(f.links!.map((l) => [l.id, l]));
  let lost = 0;
  let moved = false;
  const entities = f.entities.map((e) => {
    const link = links.get(e.id);
    if (!link) return e;
    let made: SketchEntity | null = null;
    try {
      const edge = resolveEdge(need(bodies, link.edge.body), link.edge);
      made = projectPolyline(Array.from({ length: 25 }, (_, k) => edge.pointAt(k / 24).toTuple() as Vec3), plane, edge.geomType);
    } catch (err) {
      if (isFault(err)) throw err;
    }
    // Gone, or seen end-on from here (a point): the curve stays where it was.
    if (!made) {
      lost++;
      return e;
    }
    // Its ends the way round they were (what is tied to one end stays on that end).
    if ((made.kind === "line" || made.kind === "arc") && e.kind === made.kind) {
      const far = (p: number[], q: number[]) => Math.hypot(p[0] - q[0], p[1] - q[1]);
      if (far(made.a, e.b) + far(made.b, e.a) < far(made.a, e.a) + far(made.b, e.b)) made = { ...made, a: made.b, b: made.a };
    }
    const now = { ...made, id: e.id, ...(e.construction ? { construction: true } : {}) } as SketchEntity;
    if (sameNumbers(e, now, 1e-9)) return e;
    moved = true;
    return now;
  });
  if (lost) editNotes.push(lost === 1 ? "An edge this sketch follows is gone: that curve stays where it was." : `${lost} edges this sketch follows are gone: those curves stay where they were.`);
  if (!moved) return f.entities;
  if (!f.constraints?.length) return entities;
  // What is dimensioned to them goes with them first (a distance doesn't say which side).
  const r = solveFine(carried(f.entities, entities, f.constraints, new Set(links.keys())), f.constraints);
  if (r.ok) return r.entities;
  editNotes.push("The edge this sketch follows moved to where the sketch's dimensions can't all be kept: its other curves stay where they were.");
  return entities;
}

/** The outline of the face a sketch sits on, as sketch curves (ids "bnd-…"). */
function faceBoundary(ref: FaceRef, plane: PlaneDef, bodies: Bodies): SketchEntity[] {
  const body = bodies.get(ref.body);
  if (!body) return [];
  let face: Face;
  try {
    face = resolveFace(body, ref);
  } catch {
    return [];
  }
  if (face.geomType !== "PLANE") return [];
  return face.edges.flatMap((e, i) => {
    const pts = Array.from({ length: 25 }, (_, k) => e.pointAt(k / 24).toTuple() as Vec3);
    const ent = projectPolyline(pts, plane, e.geomType);
    return ent ? [{ ...ent, id: `bnd-${i}` }] : [];
  });
}

/** A sketch drawn on a face moves with that face when earlier features change. */
/** A sketch drawn on a construction plane: where that plane is now (moved along it, or turned with it). */
function followPlane(f: SketchFeature, ctx: Ctx): PlaneDef {
  const p = ctx.planes.get(f.onPlane!)?.plane;
  if (!p) return f.plane;
  const n = norm(p.normal);
  if (Math.abs(dot(n, norm(f.plane.normal))) < 0.9999) return { origin: p.origin, normal: p.normal, xDir: p.xDir };
  // The same way round: the sketch's own origin and X kept, moved onto the plane.
  return { ...f.plane, origin: add(f.plane.origin, scale(n, dot(n, sub(p.origin, f.plane.origin)))) };
}

function followFace(f: SketchFeature, bodies: Bodies): PlaneDef {
  const ref = f.attachedTo!;
  const body = bodies.get(ref.body);
  if (!body) return f.plane;
  let face: Face;
  try {
    face = resolveFace(body, ref);
  } catch {
    // Its face is gone (the step that made it switched off or changed): the
    // sketch stays where it was, and says so - rather than stopping every step after it.
    editNotes.push("The face this sketch was drawn on is gone: it stays where it was. Tap it and pick a face to move it onto one.");
    return f.plane;
  }

  const n = norm(face.normalAt().toTuple() as Vec3);
  const c = face.center.toTuple() as Vec3;
  const offset = dot(n, sub(c, f.plane.origin));
  const origin = add(f.plane.origin, scale(n, offset));
  return dot(n, f.plane.normal) > 0.999 ? { ...f.plane, origin } : { origin, normal: n, xDir: xDirFor(n) };
}

// ----------------------------------------------------- geometric references

/**
 * One end of a Connect bridge: the face's outer edge as points in order, its
 * middle and outward normal, and how far the bridge may go into the body
 * behind it (a third of the face's size, less than half the body's depth
 * there - a 3 mm plate's end doesn't poke out of its back).
 */
/** `n` points along a wire (end to end; a closed one's start not repeated). */
function curvePoints(wire: any, n: number, closed = false): Vec3[] {
  const oc = getOC();
  const curve = new oc.BRepAdaptor_CompCurve(wire, false);
  const out: Vec3[] = [];
  try {
    const a = curve.FirstParameter();
    const b = curve.LastParameter();
    for (let k = 0; k < (closed ? n : n + 1); k++) {
      const p = curve.Value(a + ((b - a) * k) / n);
      out.push([p.X(), p.Y(), p.Z()]);
      p.delete();
    }
  } finally {
    curve.delete();
  }
  return out;
}

interface BridgeEnd {
  center: Vec3;
  /** The way the bridge leaves the face: out of it (into it, for a tunnel). */
  dir: Vec3;
  /** The outline swept (sized, and moved `depth` back against `dir`). */
  outline: any;
  /** The same outline on the face itself. */
  rim: any;
  depth: number;
  /** How far the outline reaches from the middle. */
  reach: number;
  /** Points round the outline (sized), from the middle. */
  ring: Vec3[];
  /** The face's area (sized). */
  area: number;
}

/**
 * One end of Connect's bridge: the face's outline (`size` of it, about its
 * middle), and the same moved a little way into its body when it's to be
 * joined or cut (so the bodies overlap it, not only touch) - never out of the
 * far side.
 */
function bridgeEnd(body: Shape3D, face: Face, size: number, inward: boolean, sink: boolean): BridgeEnd {
  const oc = getOC();
  const info = faceInfo(face);
  const ring = curvePoints(oc.BRepTools.OuterWire(face.wrapped), 64, true);
  const reach = Math.max(...ring.map((p) => dist(p, info.center))) * size;
  const around = ring.map((p) => scale(sub(p, info.center), size));
  const dir = inward ? scale(info.normal, -1) : info.normal;
  // The ends start a little back from the faces so the bridge overlaps what it
  // joins (into the body, but not out of its back; for a tunnel, outside it).
  const [lo, hi] = body.boundingBox.bounds as [Vec3, Vec3];
  let behind = 0;
  for (const x of [lo[0], hi[0]]) for (const y of [lo[1], hi[1]]) for (const z of [lo[2], hi[2]]) behind = Math.max(behind, dot(sub(info.center, [x, y, z]), info.normal));
  const depth = !sink ? 0 : inward ? reach * 0.25 : Math.max(1e-3, Math.min(reach * 0.25, behind * 0.45 || reach * 0.1));
  const t = new oc.gp_Trsf();
  const at = new oc.gp_Pnt(info.center[0], info.center[1], info.center[2]);
  t.SetScale(at, size);
  const move = new oc.gp_Trsf();
  const v = new oc.gp_Vec(-dir[0] * depth, -dir[1] * depth, -dir[2] * depth);
  move.SetTranslation(v);
  const both = move.Multiplied(t);
  const mk = new oc.BRepBuilderAPI_Transform(oc.BRepTools.OuterWire(face.wrapped), both, true);
  const outline = mk.Shape();
  const mr = new oc.BRepBuilderAPI_Transform(oc.BRepTools.OuterWire(face.wrapped), t, true);
  const rim = mr.Shape();
  for (const x of [t, at, move, v, both, mk, mr]) x.delete();
  return { center: info.center, dir, outline, rim, depth, reach, ring: around, area: info.area * size * size };
}

/**
 * Connect's bridge: face A's outline swept along `along` (0..1, from A's
 * middle to B's) turning into face B's - it starts and ends exactly on the
 * faces' edges (as sized by bridgeEnd), and goes on, straight, as far into
 * the bodies as bridgeEnd set it back.
 */
/** Why a bridge couldn't be made (its curve too tight for its width: the usual reason). */
const bridgeFailed = (guided: boolean) =>
  guided
    ? "The bridge can't be made along this curve (it turns too tightly for its width, or twists through itself) - try a gentler curve, or a smaller Size"
    : "The bridge can't be made between these two faces as they are (too close for its width, or outlines too unlike each other) - try a smaller Size or another Bend, or draw a curve for it to follow";

function sweepBridge(a: BridgeEnd, b: BridgeEnd, along: (t: number) => Vec3, how: { guided: boolean; exact: boolean; slide?: Vec3; samples: number }): { shape: Shape3D; exact: boolean } {
  const oc = getOC();
  const { guided, exact, slide, samples } = how;
  // A bridge is at least this big: its smaller end carried straight from one
  // face to the other (sliding, as little of that as the curve may lean). Less,
  // and the sweep went wrong without saying so - turned inside out part of the
  // way, its two halves cancelling (a solid of 128 mm3 for one of 30 000).
  const least = Math.min(a.area, b.area) * dist(a.center, b.center) * 0.15;
  const spine = (lead: boolean) => {
    // In from deep in A, straight out through its face; along the curve; and the same into B.
    const back = (e: BridgeEnd, rev: boolean) => {
      const k = [0, 1, 2, 3].map((i) => (e.depth * (rev ? i : 3 - i)) / 3);
      return lead && e.depth > 0 ? k.filter((x) => x > 0).map((x) => sub(e.center, scale(e.dir, x))) : [];
    };
    const pts = [...back(a, false), ...Array.from({ length: samples + 1 }, (_, i) => along(i / samples)), ...back(b, true)];
    const span = dist(pts[0], pts[pts.length - 1]) + 1;
    return assembleWire([makeBSplineApproximation(pts, { tolerance: span * 1e-4, degMax: 5, degMin: 3 })]);
  };
  const pipe = (path: ReturnType<typeof spine>, sections: (() => any[])[]): Shape3D | null => {
    // The way the outline is carried along: each copes with curves the others don't.
    for (const section of sections)
      for (const mode of slide ? ["slide"] : ["discrete", "corrected"]) {
        let ends: any[];
        try {
          ends = section();
        } catch {
          continue;
        }
        const mk = new oc.BRepOffsetAPI_MakePipeShell(path.wrapped);
        const progress = new oc.Message_ProgressRange();
        try {
          if (mode === "slide") {
            // Every section facing the same way: the outline slides along the curve, not turning with it.
            const x = xDirFor(slide!);
            const o = new oc.gp_Pnt(0, 0, 0);
            const n = new oc.gp_Dir(slide![0], slide![1], slide![2]);
            const vx = new oc.gp_Dir(x[0], x[1], x[2]);
            const ax = new oc.gp_Ax2(o, n, vx);
            mk.SetMode(ax);
            for (const d of [o, n, vx, ax]) d.delete();
          } else if (mode === "discrete") mk.SetDiscreteMode();
          else mk.SetMode(false);
          for (const w of ends) mk.Add(w, false, false);
          mk.Build(progress);
          if (!mk.IsDone()) throw new Error("sweep");
          mk.MakeSolid();
          let s = cast(mk.Shape()) as Shape3D;
          if (measureVolume(s) < 0) s = cast(s.wrapped.Reversed()) as Shape3D;
          if (!shapeValid(s) || !(measureVolume(s) > least)) throw new Error("bad");
          return s;
        } catch {
          /* the next way, or none */
        } finally {
          mk.delete();
          progress.delete();
        }
      }
    return null;
  };
  // Set back into the bodies: from face to face, then each face's outline
  // straight on into its body (a plug). Swept from where it was set back
  // instead, the outline was already part way to the other face's where it
  // left its own - a square end into a small round one started inside the
  // square's edges.
  if (exact && (a.depth > 0 || b.depth > 0)) {
    const plug = (e: BridgeEnd): Shape3D => {
      const mf = new oc.BRepBuilderAPI_MakeFace(oc.TopoDS.Wire(e.rim), true);
      const v = new oc.gp_Vec(-e.dir[0] * e.depth, -e.dir[1] * e.depth, -e.dir[2] * e.depth);
      try {
        if (!mf.IsDone()) throw new Error("not flat");
        const pr = new oc.BRepPrimAPI_MakePrism(mf.Face(), v, true, true);
        const s = cast(pr.Shape()) as Shape3D;
        pr.delete();
        return s;
      } finally {
        mf.delete();
        v.delete();
      }
    };
    const s = pipe(spine(false), [() => [a.rim, b.rim]]);
    if (s) {
      try {
        let out = s;
        for (const e of [a, b]) if (e.depth > 0) out = out.fuse(plug(e));
        if (measureVolume(out) < 0) out = cast(out.wrapped.Reversed()) as Shape3D;
        if (shapeValid(out) && [...iterTopo(out.wrapped, "solid")].length === 1 && measureVolume(out) > measureVolume(s)) return { shape: out, exact: true };
      } catch {
        /* (a curved face, or a plug that won't join) the way below */
      }
    }
  }
  // The faces' own outlines; and, where one can't be turned into the other (a
  // square into an L: not the same number of sides, corners that don't pair
  // up), each as one smooth closed curve through points round it.
  const smooth = (e: BridgeEnd) => {
    const base = sub(e.center, scale(e.dir, e.depth));
    // (A little inside the face's own edge: walls a hair apart from the body's make its join leave gaps.)
    const round = e.ring.map((p) => add(base, scale(p, 0.97)));
    return assembleWire([makeBSplineApproximation([...round, round[0]], { tolerance: Math.max(1e-4, e.reach * 1e-3), degMax: 5, degMin: 3 })]).wrapped;
  };
  const s = pipe(spine(true), [() => [a.outline, b.outline], () => [smooth(a), smooth(b)]]);
  if (s) return { shape: s, exact: false };
  throw new Error(bridgeFailed(guided));
}

/**
 * Points on the smooth surface a Freeform Face cage makes (its border left
 * out: the face's own edges are kept), for the face to be filled through; null
 * when every inside point is still on the face (nothing to do).
 */
/**
 * Those of `pts` that lie over the flat face itself (seen along its normal),
 * clear of its edge. A cage's smooth surface cuts an inward corner of the
 * face's outline (an L's) a little short: the points it has out there, past
 * the edge, would fold the face over when it is filled through them.
 */
function onFace(face: Face, pts: Vec3[]): Vec3[] {
  const n = norm(face.normalAt().toTuple() as Vec3);
  const u = xDirFor(n);
  const v = norm(cross(n, u));
  // (outerWire uses up the face it's called on: a clone.)
  const wire = face.clone().outerWire();
  const loop = curvePoints(wire.wrapped, 600, true).map((p) => [dot(p, u), dot(p, v)]);
  wire.delete();
  const N = loop.length;
  let area = 0;
  for (let a = 0, b = N - 1; a < N; b = a++) area += loop[b][0] * loop[a][1] - loop[a][0] * loop[b][1];
  const margin = Math.sqrt(Math.abs(area) / 2) * 0.01;
  const kept = pts.filter((p) => {
    const x = dot(p, u);
    const y = dot(p, v);
    let inside = false;
    let near = Infinity;
    for (let a = 0, b = N - 1; a < N; b = a++) {
      const [ax, ay] = loop[a];
      const [bx, by] = loop[b];
      if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
      const L = (bx - ax) ** 2 + (by - ay) ** 2;
      const t = L > 0 ? Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / L)) : 0;
      near = Math.min(near, Math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay)));
    }
    return inside && near > margin;
  });
  // (None left - a sliver of a face: as they were, and the fill says what it can't do.)
  return kept.length ? kept : pts;
}

function faceCagePoints(cage: { verts: Vec3[]; faces: [number, number, number, number][] }, normal: Vec3, fine = true): Vec3[] | null {
  const border = new Set(boundaryEdges(cage).flat());
  const inside = cage.verts.map((_, i) => i).filter((i) => !border.has(i));
  const o = cage.verts[[...border][0]];
  // All still in the face's plane: the smooth surface is the flat face itself.
  if (!o || !inside.some((i) => Math.abs(dot(sub(cage.verts[i], o), normal)) > 1e-9)) return null;
  // Twice as fine as the cage, as long as that isn't too many to fill through.
  const plan = cachedPlan(cage, !fine || inside.length > 60 ? 0 : 1);
  const pos = applyPlan(plan, cage.verts);
  const { ptr, idx } = plan.rows;
  const out: Vec3[] = [];
  for (let k = 0; k < ptr.length - 1; k++) {
    let onBorder = true;
    for (let t = ptr[k]; t < ptr[k + 1] && onBorder; t++) if (!border.has(idx[t])) onBorder = false;
    if (!onBorder) out.push([pos[3 * k], pos[3 * k + 1], pos[3 * k + 2]]);
  }
  return out;
}

function faceInfo(face: Face): FaceInfo {
  // (Middle and area from one measuring: each face of every body shown was measured twice.)
  const { area, center } = areaProperties(face);
  const normal = norm(face.normalAt().toTuple() as Vec3);
  const info: FaceInfo = { center, normal, area, type: face.geomType };
  if (face.geomType === "PLANE") info.plane = { origin: center, normal, xDir: xDirFor(normal) };
  if (face.geomType === "CYLINDRE") {
    const cy = cylinderOf(face);
    if (cy) info.round = { r: cy.r, hole: cy.s < 0 };
  }
  return info;
}

function edgeInfo(edge: Edge): EdgeInfo {
  const info: EdgeInfo = {
    mid: edge.pointAt(0.5).toTuple() as Vec3,
    dir: norm(edge.tangentAt(0.5).toTuple() as Vec3),
    length: edge.length,
    start: edge.startPoint.toTuple() as Vec3,
    end: edge.endPoint.toTuple() as Vec3,
    type: edge.geomType,
  };
  return info;
}

/**
 * For a step made from a sketch (an extrusion, a revolve): which of its faces
 * a face is - the sketch curve its surface was drawn out of ("line3:0": the
 * curve's id and which piece of it), or an end ("cap:0" on the sketch's plane,
 * "cap:1" away from it, and the curve nearest its middle). Told from the face
 * as it is, so a face trimmed or cut by later steps still says the same.
 */
function originsOf(f: Feature, ctx: Ctx): OriginOf | undefined {
  if ((f.type !== "extrude" && f.type !== "revolve") || f.source.kind !== "profile") return undefined;
  if (f.type === "extrude" && f.taper !== undefined && Math.abs(f.taper - 1) > 1e-9) return undefined;
  const s = ctx.sketches.get(f.source.sketch);
  if (!s) return undefined;
  // The curves round the shapes it was made from (all of the sketch's, when not known).
  const ids = new Set(f.source.regions.flatMap((r) => r.k ?? []));
  const known = f.source.regions.every((r) => r.k?.length);
  const curves = s.entities.filter((e) => !e.construction && (!known || ids.has(e.id)));
  if (!curves.length || curves.length > 400) return undefined;
  const { origin, normal } = s.plane;
  const n = norm(normal);
  const u = norm(s.plane.xDir);
  const v = norm(cross(n, u));
  const flat = (p: Vec3): [number, number] => [dot(sub(p, origin), u), dot(sub(p, origin), v)];
  const nearest = (q: [number, number]) => {
    let best: { key: string; d: number } | null = null;
    for (const e of curves) {
      const c = closestOnEntity(e, q);
      if (!best || c.d < best.d) best = { key: `${e.id}:${c.prim}`, d: c.d };
    }
    return best!;
  };
  const axis = f.type === "revolve" ? resolveAxis(f.axis, ctx) : null;
  return (face, back) => {
    const p = face.pointOnSurface(0.5, 0.5);
    let at = p.toTuple() as Vec3;
    p.delete();
    let fn = face.geomType === "PLANE" ? norm(face.normalAt().toTuple() as Vec3) : null;
    // (A face of a body moved since: taken back to where this step made it.)
    if (back) {
      at = back(at);
      if (fn) fn = norm(back(fn, true));
    }
    if (axis) {
      // An end of a part turn: a flat face the axis lies in.
      if (fn && Math.abs(dot(fn, axis.dir)) < 1e-6 && Math.abs(dot(sub(at, axis.origin), fn)) < 1e-4) return `cap:${Math.abs(dot(fn, n)) > 0.999 ? 0 : 1}`;
      // Turned back into the sketch's plane (either side of the axis).
      const along = dot(sub(at, axis.origin), axis.dir);
      const foot = add(axis.origin, scale(axis.dir, along));
      const r = dist(at, foot);
      const out = norm(cross(n, axis.dir));
      const a = nearest(flat(add(foot, scale(out, r))));
      const b = nearest(flat(add(foot, scale(out, -r))));
      const best = a.d <= b.d ? a : b;
      return best.d < 1e-3 + r * 1e-6 ? best.key : null;
    }
    const q = flat(at);
    const hit = nearest(q);
    if (fn && Math.abs(dot(fn, n)) > 0.999) {
      const h = dot(sub(at, origin), n);
      return `cap:${Math.abs(h) < 1e-4 ? 0 : h > 0 ? 1 : 2}@${hit.key}`;
    }
    return hit.d < 1e-3 ? hit.key : null;
  };
}

/** Best-matching face for a stored signature (survives upstream edits). */
function resolveFace(body: Shape3D, ref: FaceRef, only?: (f: Face) => boolean): Face {
  const size = Math.sqrt(ref.area) || 1;
  let best: { face: Face; score: number } | null = null;
  // Only faces made by the step that made the one picked (see provenance.ts).
  let steps = ref.step ? faceSteps(body) : undefined;
  const faces = body.faces;
  // (Saved when a face on another body's plane was put down to that body's step: found by that.)
  const old = steps && !steps.includes(ref.step!) ? faceAliases(body) : undefined;
  if (old) steps = steps!.map((s, i) => old[i] ?? s);
  if (steps && !faces.some((_, i) => steps![i] === ref.step)) throw new Error(FACE_GONE);
  // The one made from the same sketch curve, if that can be told: wherever it
  // is now. (Cut in two since: the nearer piece, below.)
  const origins = steps && ref.curve ? faceOrigins(body) : undefined;
  const same = origins ? faces.filter((face, i) => steps![i] === ref.step && origins[i] === ref.curve && (!only || only(face))) : [];
  if (same.length === 1) return same[0];
  for (const [i, face] of faces.entries()) {
    if (steps && steps![i] !== ref.step) continue;
    if (same.length && origins![i] !== ref.curve) continue;
    if (only && !only(face)) continue;
    const fi = faceInfo(face);
    const align = dot(fi.normal, ref.normal);
    if (align < 0.5 && !same.length) continue;
    const score = dist(fi.center, ref.center) / size + (1 - align) * 4 + Math.abs(Math.log((fi.area + 1e-9) / (ref.area + 1e-9)));
    if (!best || score < best.score) best = { face, score };
  }
  if (!best) throw new Error(FACE_GONE);
  return best.face;
}

/** What a step says when what it was built on is gone (an earlier step was changed or switched off). */
const FACE_GONE = "The face it was built on is gone (something before it changed). Tap this step and pick the face again.";
const EDGE_GONE = "An edge it was built on is gone (something before it changed). Tap this step and pick the edges again.";

/** `rounding`: for a fillet or chamfer - a seam (nothing to round) is never it. */
/** How far a point is from an edge (its curve, between its ends). */
function pointToEdge(p: Vec3, edge: Edge): number {
  const v = makeVertex(p);
  try {
    return measureDistanceBetween(edge, v);
  } catch {
    return Infinity;
  } finally {
    v.delete();
  }
}

/** The edge (not a seam) whose curve runs through a picked edge's middle, along its direction (else null). */
function edgeByPlace(table: { edges: Edge[]; infoOf(i: number): EdgeInfo }, ref: EdgeRef, refDir: Vec3, seams?: boolean[]): Edge | null {
  let best: { edge: Edge; d: number } | null = null;
  for (const [i, edge] of table.edges.entries()) {
    if (seams?.[i]) continue;
    const ei = table.infoOf(i);
    const tol = Math.max(ref.length, ei.length) * 0.05;
    // (Too far for its middle to be on it at all.)
    if (dist(ei.mid, ref.mid) > ei.length / 2 + tol + 1e-9) continue;
    const d = pointToEdge(ref.mid, edge);
    if (!(d < tol) || (best && d >= best.d)) continue;
    // Along it there: the nearest of a few points on it, its direction.
    let k = 0;
    let kd = Infinity;
    for (let j = 0; j <= 20; j++) {
      const dj = dist(edge.pointAt(j / 20).toTuple() as Vec3, ref.mid);
      if (dj < kd) [k, kd] = [j, dj];
    }
    if (Math.abs(dot(norm(edge.tangentAt(k / 20).toTuple() as Vec3), refDir)) < 0.8) continue;
    best = { edge, d };
  }
  return best?.edge ?? null;
}

/**
 * A body's edges and where each is, measured once. Finding the picked edges of
 * a 300-edge chamfer measured all the body's edges again for each (300 x 1000
 * on a gear), and each measuring leaves engine objects only freed after the
 * rebuild: 1.5 GB, and the next rebuild ran out of memory.
 */
const edgeTables = new WeakMap<Shape3D, { wrapped: unknown; edges: Edge[]; info: (EdgeInfo | undefined)[] }>();
function edgeTable(body: Shape3D): { edges: Edge[]; infoOf(i: number): EdgeInfo } {
  let t = edgeTables.get(body);
  if (!t || t.wrapped !== body.wrapped) {
    const edges = body.edges;
    t = { wrapped: body.wrapped, edges, info: new Array(edges.length) };
    edgeTables.set(body, t);
  }
  const table = t;
  return { edges: table.edges, infoOf: (i) => (table.info[i] ??= edgeInfo(table.edges[i])) };
}

function resolveEdge(body: Shape3D, ref: EdgeRef, rounding = false): Edge {
  const size = ref.length || 1;
  // (Saved directions are of unit length; one that isn't - written by hand, or by a
  // script from a curve's raw tangent - made the likeness below go negative: any edge fitted.)
  const refDir = len(ref.dir) > 1e-12 ? norm(ref.dir) : ref.dir;
  let best: { edge: Edge; score: number } | null = null;
  // A piece of it, or what it's now a piece of (below): only when nothing else is
  // much the same edge - a lid made 20 wider had its corners' rounds go to the
  // long side its old middle now lay on.
  let piece: { edge: Edge; score: number } | null = null;
  // Only edges between faces made by the same steps as the one picked.
  let steps = ref.steps ? edgeSteps(body) : undefined;
  const seams = rounding && steps ? seamEdges(body) : undefined;
  const table = edgeTable(body);
  const all = table.edges;
  // (Saved with a face put down to another body's step: found by that.)
  if (steps && !steps.some((s, i) => sameSteps(s, ref.steps!) && !seams?.[i])) steps = oldEdgeSteps(body) ?? steps;
  if (steps && !all.some((_, i) => sameSteps(steps[i], ref.steps!) && !seams?.[i])) {
    // No edge between faces of those steps now: a later step took the faces over (a blade's
    // root, its face trimmed at the tip when it was one face, not when lofted straight in
    // pieces). Still there if an edge runs through where it was, the same way.
    const there = edgeByPlace(table, ref, refDir, seams);
    if (there) return there;
    throw new Error(EDGE_GONE);
  }
  // The one between the same two faces (by the sketch curves they came from), wherever it is now.
  const origins = steps && ref.curves ? edgeOrigins(body) : undefined;
  const isIt = (i: number) => !!origins?.[i] && sameSteps(origins[i]!, ref.curves!) && !seams?.[i];
  const same = origins ? all.filter((_, i) => isIt(i)) : [];
  if (same.length === 1) return same[0];
  for (const [i, edge] of all.entries()) {
    if (steps && !sameSteps(steps[i], ref.steps!)) continue;
    if (same.length && !isIt(i)) continue;
    if (seams?.[i]) continue;
    const ei = table.infoOf(i);
    const align = Math.min(1, Math.abs(dot(ei.dir, refDir)));
    const like = (1 - align) * 2 + Math.abs(Math.log((ei.length + 1e-9) / (ref.length + 1e-9)));
    // Picked with its steps, the candidates are edges of the same kind: the
    // nearest is it, however far a resize moved it (a 3 mm lid's corner edges,
    // 20 mm out when the lid was made 40 wider, were "gone") - if it's still
    // much the same edge (the lid made round: its 3 mm corners aren't the rim circles).
    if (steps && like > 1.5 && !same.length) {
      // A piece of this edge when picked (a blade's root cut in two where the hub's seam
      // crossed it, whole once the blade moved), or the whole of what's now in pieces:
      // its middle lies on (or right by) this one.
      if (ei.length < ref.length && ei.length > ref.length * 0.05) continue;
      const near = pointToEdge(ref.mid, edge);
      if (!(near < Math.max(ref.length, ei.length) * 0.05)) continue;
      const score = near / size;
      if (!piece || score < piece.score) piece = { edge, score };
      continue;
    }
    const score = dist(ei.mid, ref.mid) / size + like;
    if (!best || score < best.score) best = { edge, score };
  }
  best ??= piece;
  // Without steps, only one close by.
  if (!best || (!steps && best.score > 3)) throw new Error(EDGE_GONE);


  return best.edge;
}

// ------------------------------------------------------------------- meshing

/** The triangles and edge lines of a body, as the view shows them. */
/**
 * Bodies that are another body moved, turned or mirrored (a Move step, a
 * pattern's copies): their mesh is that body's, moved the same way - meshed
 * again, a fan's rotated casing took 3 s, and a pattern meshed every copy.
 * (The faces and edges come in the same order: the shape is the same.)
 */
// (The body it was moved from held weakly: a chain of moves mustn't keep every earlier body alive.)
const movedFrom = new WeakMap<Shape3D, { from: WeakRef<Shape3D>; m: Affine; flip: boolean }>();
function movedMesh(shape: Shape3D) {
  const mv = movedFrom.get(shape);
  const was = mv?.from.deref();
  const src = was && (meshCache.get(was) ?? drawMeshes.get(was));
  if (!mv || !src) return null;
  const { m, flip } = mv;
  const at = (a: Float32Array, normal: boolean) => {
    const out = new Float32Array(a.length);
    for (let i = 0; i < a.length; i += 3) {
      const [x, y, z] = [a[i], a[i + 1], a[i + 2]];
      for (let r = 0; r < 3; r++) out[i + r] = m[r * 4] * x + m[r * 4 + 1] * y + m[r * 4 + 2] * z + (normal ? 0 : m[r * 4 + 3]);
    }
    return out;
  };
  let triangles = src.indices;
  if (flip) {
    // Mirrored: each triangle the other way round, or it faces inward.
    triangles = new Uint32Array(src.indices);
    for (let i = 0; i < triangles.length; i += 3) [triangles[i + 1], triangles[i + 2]] = [triangles[i + 2], triangles[i + 1]];
  }
  return {
    m: { vertices: at(src.positions, false), normals: at(src.normals, true), triangles, faceGroups: src.faceGroups },
    e: { lines: at(src.edgePositions, false), edgeGroups: src.edgeGroups },
  };
}

function meshLines(shape: Shape3D) {
  const moved = movedMesh(shape);
  if (moved) return moved;
  const bb = shape.boundingBox;
  const diag = Math.hypot(bb.width, bb.height, bb.depth) || 1;
  // (Never finer than 1/50 000 of its size: a 100 m arc at 0.1 mm is millions of triangles.)
  const tolerance = Math.max(Math.min(0.1, Math.max(0.001, diag * 0.0008)), diag * 2e-5);
  const angularTolerance = 0.25;
  const m = meshFaces(shape, tolerance, angularTolerance);
  const e = meshEdgeLines(shape, tolerance, angularTolerance);
  meshOff(shape);
  // A face made freeform is many patches, smooth across the lines between
  // them: those lines aren't edges to show or pick (drawn as nothing).
  const made = edgeSteps(shape);
  if (made && smoothSteps.size && e.edgeGroups.reduce((n, g) => n + g.count, 0) * 3 === e.lines.length) {
    const seams = seamEdges(shape);
    e.edgeGroups.forEach((g, i) => {
      if (made[i]?.length !== 1 || !smoothSteps.has(made[i][0]) || seams[i]) return;
      for (let k = 1; k < g.count; k++) for (let c = 0; c < 3; c++) e.lines[(g.start + k) * 3 + c] = e.lines[g.start * 3 + c];
    });
  }
  return { m, e };
}

/**
 * For a drawing: the mesh with only what the drawing reads (the faces' and
 * edges' kinds) - the view's own when it has it. The model drawn without its
 * threads is bodies the view never showed: its full mesh took seconds more.
 */
const drawMeshes = new WeakMap<Shape3D, BodyMesh>();
function drawingMesh(id: string, shape: Shape3D): BodyMesh {
  const have = meshCache.get(shape) ?? drawMeshes.get(shape);
  if (have) return { ...have, id, name: id };
  const { m, e } = meshLines(shape);
  const mesh: BodyMesh = {
    id,
    name: id,
    key: meshKey++,
    positions: new Float32Array(m.vertices),
    normals: new Float32Array(m.normals),
    indices: new Uint32Array(m.triangles),
    faceGroups: m.faceGroups.map((g, i) => ({ start: g.start, count: g.count, face: i })),
    edgePositions: new Float32Array(e.lines),
    edgeGroups: e.edgeGroups.map((g, i) => ({ start: g.start, count: g.count, edge: i })),
    faces: shape.faces.map((f) => ({ type: f.geomType }) as FaceInfo),
    edges: shape.edges.map((x) => ({ type: x.geomType }) as EdgeInfo),
    openEdges: [],
  };
  drawMeshes.set(shape, mesh);
  return mesh;
}

function meshBody(id: string, name: string, shape: Shape3D): BodyMesh {
  const cached = meshCache.get(shape);
  if (cached) return { ...cached, id, name };
  const { m, e } = meshLines(shape);
  // Group order matches shape.faces / shape.edges order (verified); ids are hashes.
  const mesh: BodyMesh = {
    id,
    name,
    key: meshKey++,
    positions: new Float32Array(m.vertices),
    normals: new Float32Array(m.normals),
    indices: new Uint32Array(m.triangles),
    faceGroups: m.faceGroups.map((g, i) => ({ start: g.start, count: g.count, face: i })),
    edgePositions: new Float32Array(e.lines),
    edgeGroups: e.edgeGroups.map((g, i) => ({ start: g.start, count: g.count, edge: i })),
    faces: shape.faces.map((f, i) => ({ ...faceInfo(f), step: faceSteps(shape)?.[i], curve: faceOrigins(shape)?.[i], ...(faceAliases(shape)?.[i] ? { was: faceAliases(shape)![i] } : {}) })),
    edges: shape.edges.map((e, i) => ({ ...edgeInfo(e), steps: edgeSteps(shape)?.[i], curves: edgeOrigins(shape)?.[i], ...(oldEdgeSteps(shape) ? { was: oldEdgeSteps(shape)![i] } : {}) })),

    openEdges: openEdges(shape),
  };
  meshCache.set(shape, mesh);
  return mesh;
}

/**
 * Edges used by fewer than two faces: the body is not closed (watertight)
 * there. Imported meshes and failed operations are the usual cause.
 */
// ------------------------------------------------------------------- helpers

/**
 * A face/edge/corner edit must not tear the body open: when the result has
 * gaps the body didn't have, the step stops with a message instead of
 * leaving a body with holes for the next steps to build on.
 */
/** How many faces are next to nothing in area (leftovers of an edit, not real faces). */
function slivers(s: Shape3D): number {
  const areas = s.faces.map((f) => measureArea(f));
  const total = areas.reduce((a, b) => a + b, 0);
  return areas.filter((a) => a < Math.max(1e-9, total * 1e-7)).length;
}

/**
 * The bodies an edit may change: the ones it names - and, for a solid made
 * from a sketch or face that joins/cuts whatever it runs into, all of them.
 */
function touchedBodies(f: Feature, ctx: Ctx, all = true): string[] {
  const named = new Set<string>();
  const walk = (v: unknown, key = ""): void => {
    if (Array.isArray(v)) return v.forEach((x) => walk(x, key));
    if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, k);
      return;
    }
    if (typeof v === "string" && (key === "body" || key === "bodies" || key === "target" || key === "tools")) named.add(v);
  };
  walk(f);
  const mode = (f as { mode?: string }).mode;
  if (all && (f.type === "extrude" || f.type === "revolve" || f.type === "sweep" || f.type === "loft") && mode && mode !== "new") for (const id of ctx.bodies.keys()) named.add(id);
  return [...named].filter((id) => ctx.bodies.has(id));
}

/** Does a flat shape in a plane through the axis reach both sides of it? */
function crossesAxis(face: Face, origin: Vec3, dir: Vec3): boolean {
  const n = norm(face.normalAt().toTuple() as Vec3);
  if (Math.abs(dot(n, dir)) > 1e-6) return false; // tilted to the axis: not this question
  const side = cross(dir, n);
  let lo = 0, hi = 0;
  for (const e of face.edges)
    for (const k of [0, 0.25, 0.5, 0.75, 1]) {
      const d = dot(sub(e.pointAt(k).toTuple() as Vec3, origin), side);
      lo = Math.min(lo, d);
      hi = Math.max(hi, d);
    }
  const tol = Math.max(1e-6, (hi - lo) * 1e-6);
  return lo < -tol && hi > tol;
}

/**
 * A pattern's count, held to what a phone can build: a typo (3000 for 30)
 * stops at once with a message, not after minutes (and again each time the
 * project is opened).
 */
const MAX_COPIES = 1000;
function patternCount(n: number): void {
  if (!(n >= 1) || !Number.isFinite(n)) throw new Error("The count must be 2 or more");
  if (n > MAX_COPIES) throw new Error(`${Math.round(n)} copies is too many - up to ${MAX_COPIES} at once`);
}

/** Edits that change a solid in place (their results are checked). */
const GUARDED = new Set<string>(["extrude", "revolve", "sweep", "loft", "boolean", "fillet", "chamfer", "shell", "moveFace", "scaleFace", "replaceFace", "deleteGeom", "split", "connect"]);
/** Edits that must not break a body into pieces (cuts and booleans may). */
const NO_SPLIT = new Set<string>(["fillet", "chamfer", "shell", "moveFace", "scaleFace", "replaceFace", "deleteGeom"]);

/**
 * The result of an edit must be a solid like the one it changed: crumbs a
 * cut left behind are swept away, a hollow left as loose surfaces is made a
 * solid, an inside-out one is turned right - and anything still broken
 * (invalid, hair-thin faces, split by an edit that shouldn't split) makes the
 * step stop with a message instead of leaving a damaged body to build on.
 */
function guardEdit(before: Shape3D | undefined, after: Shape3D, mayPart: boolean): Shape3D | null {
  const oc = getOC();
  // A new body (made by this edit): held to being a good solid, like an edited one.
  const was = before ? subShapes(before, "SOLID").length : Math.max(1, subShapes(after, "SOLID").length);
  // Not a solid before (an imported mesh, a sheet): nothing to hold it to.
  if (!was) return after;
  const v0 = before ? Math.abs(volumeOf(before)) : 0;
  let solids = subShapes(after, "SOLID");
  if (!solids.length) {
    // A hollow (outer skin + inner skin) left as loose skins: one solid with a void.
    const shells = subShapes(after, "SHELL");
    if (!shells.length) throw new Error("That edit would leave nothing solid");
    const mk = new oc.BRepBuilderAPI_MakeSolid();
    for (const sh of shells) mk.Add(sh);
    const solid = mk.Solid();
    oc.BRepLib.OrientClosedSolid(solid);
    mk.delete();
    solids = [solid];
    after = cast(solid) as Shape3D;
  }
  // A lump inside out among the others: the cut went wrong.
  // (One solid: the body itself - its volume, worked out once.)
  // (Or a group holding that one solid and nothing else, as a cut gives back: the same volume, likely known already.)
  const one = solids.length === 1 && (after instanceof Solid || [...iterTopo(after.wrapped, "face")].length === [...iterTopo(solids[0], "face")].length);
  const signed = one ? [volumeOf(after)] : solids.map((x) => measureVolume(cast(x) as Shape3D));
  if (solids.length > 1 && signed.some((v) => v < 0) && signed.some((v) => v > 0)) throw new Error("That edit would damage the body - try a different value");
  // Crumbs: lumps far smaller than the rest (left between coincident faces).
  const vols = signed.map((v) => Math.abs(v));
  const total = vols.reduce((a, b) => a + b, 0);
  // All of it cut away but dust: no body left.
  if (before && total < v0 * 1e-6) return null;
  const keep = solids.filter((_, i) => vols[i] > total * 1e-5);
  if (!keep.length) throw new Error("That edit would leave nothing solid");
  if (keep.length < solids.length) {
    if (keep.length === 1) after = cast(keep[0]) as Shape3D;
    else after = makeCompound(keep.map((x) => cast(x))) as Shape3D;
    solids = keep;
  }
  if (!mayPart && solids.length > was) throw new Error("That would break the body into pieces - try a smaller value");
  // Inside out (negative volume): turn it right - on a copy (its faces may be
  // shared with earlier steps' results, which must never change).
  if (volumeOf(after) < 0) {
    after = deepCopy(after);
    solids = subShapes(after, "SOLID");
    for (const x of solids) oc.BRepLib.OrientClosedSolid(x);
    if (measureVolume(after) < 0) throw new Error("That edit would turn the body inside out");
  }
  // Something wrong with it: repaired if that can be done without changing
  // the shape (noted in History); else the step stops with the message.
  const fixOr = (message: string): Shape3D => {
    const r = repairShape(after, { maxSolids: mayPart ? undefined : Math.max(1, was) });
    if (!r) throw new Error(message);
    editNotes.push(`Repaired automatically: ${r.fixes.join(", ")}.`);
    return r.shape;
  };
  // Gaps it didn't have before (an edge with a face on one side only).
  if (openEdges(after).length > (before ? openEdges(before).length : 0)) return fixOr("That edit would tear the body open - try a smaller value, or another face");
  const validBefore = before ? shapeValid(before) : true;
  if (validBefore && !shapeValid(after)) return fixOr("That edit would damage the body (the faces don't meet up) - try a different value");
  const thinBefore = before ? hairThin(before) : 0;
  if (hairThin(after) > thinBefore) {
    // Often just faces left split on one surface: merge them, then look again.
    let merged: Shape3D | null = null;
    try {
      merged = unify(after);
    } catch {
      merged = null;
    }
    if (merged && hairThin(merged) <= thinBefore && (!validBefore || shapeValid(merged))) return merged;
    return fixOr("That edit would leave hair-thin faces - try a slightly different value");
  }
  return after;
}

function staysClosed(before: Shape3D, after: Shape3D): Shape3D {
  if (openEdges(after).length > openEdges(before).length) throw new Error("That would tear the body open - try a smaller value, or another face");
  return after;
}

/**
 * The most triangles a mesh file may have. Every triangle is a face of the
 * body (flat neighbours merged), and a body takes time and memory by its
 * faces: 57 000 triangles come in in 13 s on a desktop, 115 000 in 41 s,
 * 250 000 in a minute and a half (a phone is several times slower, with less
 * memory). More is refused at once, in words: it used to run the engine out
 * of memory, which showed as a step that "broke down".
 */
const MESH_MAX = 250000;
class TooBig extends Error {
  constructor(count: number) {
    super(`This mesh has ${count.toLocaleString("en-US")} triangles - more than can be brought in (up to ${MESH_MAX.toLocaleString("en-US")}). Thin it out in a mesh program first`);
  }
}

/**
 * An STL file as a body. OpenCascade's reader hands back the triangles loose
 * (a pile of faces, no two sharing an edge - replicad's importSTL wanted a
 * shell and threw on every file, the app's own STL exports too). Sewn here:
 * one closed skin is a solid, its flat triangles merged; anything else (open,
 * several lumps) stays loose faces for Repair to close. (The reader used to
 * hand back a shell, and this looked for one: with none to find, every STL
 * came in as loose faces - a block of 12 triangles too - and nothing could be
 * joined to it or cut from it until it was Repaired.)
 */
function readSTL(bytes: Uint8Array): Shape3D {
  const oc = getOC();
  // A binary file is known by its length: 84 bytes and 50 for each triangle
  // it says it has (one with too many isn't read at all). OpenCascade's reader
  // goes by its first 134 bytes instead - binary if one of them is no letter
  // of plain text - and took for text a file with a blank or plain heading
  // whose first triangle's numbers were all such bytes (round sizes and no
  // normal: a 10 mm cube out of a 3MF) - "couldn't be read". Its heading,
  // which nothing reads, is given such a byte.
  let file = bytes;
  if (bytes.length >= 134) {
    const said = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true);
    if (84 + said * 50 === bytes.length) {
      if (said > MESH_MAX) throw new TooBig(said);
      file = bytes.slice();
      file[79] = 0xff;
    }
  }
  const name = `stl-${Math.random().toString(36).slice(2)}.stl`;
  oc.FS.writeFile(`/${name}`, file);
  const reader = new oc.StlAPI_Reader();
  const read = new oc.TopoDS_Shell();
  try {
    if (!reader.Read(read, name)) throw new Error("This STL file couldn't be read");
    const loose = cast(read) as Shape3D;
    // (Counted straight off the shape: replicad's iterTopo checks each one against
    // all before it - 6 of the 10 s ten thousand triangles took to come in.)
    let count = 0;
    const each = new oc.TopExp_Explorer(read, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    for (; each.More(); each.Next()) count++;
    each.delete();
    if (count > MESH_MAX) throw new TooBig(count);
    if (count) {
      const size = sizeOf(loose);
      const sew = new oc.BRepBuilderAPI_Sewing(Math.max(1e-7, size * 1e-7), true, true, true, false);
      const progress = new oc.Message_ProgressRange();
      try {
        sew.Add(read);
        sew.Perform(progress);
        const shells = subShapes(cast(sew.SewedShape()) as Shape3D, "SHELL");
        if (shells.length === 1 && sew.NbFreeEdges() === 0) {
          const mk = new oc.BRepBuilderAPI_MakeSolid();
          mk.Add(shells[0]);
          const made = cast(mk.Solid()) as Shape3D;
          mk.delete();
          // Flat triangles made one face each, as Repair leaves them. A file's
          // numbers are to seven digits, so a corner can be a hair off the
          // plane of the face it now belongs to, which the check calls damage
          // (a faceted ball came in "invalid"): its edges are given that room,
          // as Repair's first step does - or the triangles are kept as they are.
          let solid = unify(made, size);
          if (solid !== made && !shapeValid(solid)) {
            try {
              oc.BRepLib.BuildCurves3d(solid.wrapped);
              oc.BRepLib.SameParameter(solid.wrapped, size * 1e-7, true);
              oc.BRepLib.UpdateTolerances(solid.wrapped, true);
            } catch (err) {
              if (isFault(err)) throw err;
            }
            // (Looked at afresh: what a shape was found to be is remembered.)
            solid = cast(solid.wrapped) as Shape3D;
            if (!shapeValid(solid)) solid = made;
          }
          let v = measureVolume(solid);
          if (v < 0) {
            oc.BRepLib.OrientClosedSolid(solid.wrapped);
            v = measureVolume(solid);
          }
          if (v > 0 && !openEdges(solid).length) {
            // (Measured once: a body of a hundred thousand faces takes seconds to.)
            volumes.set(solid, v);
            return solid;
          }
        }
      } catch (err) {
        if (isFault(err)) throw err;
        // fall through: loose faces
      } finally {
        sew.delete();
        progress.delete();
      }
    }
    return loose;
  } finally {
    oc.FS.unlink(`/${name}`);
    reader.delete();
    read.delete();
  }
}

const copyOf = (id: string) => /^([^:]+:.+):(\d+)$/.exec(id);

/**
 * The patterns a step uses whole: the original and every copy there is now
 * picked (`<pattern step>:<original>`). Some of the copies picked is that many
 * bodies, not the whole pattern.
 */
export function wholeOf(ids: string[], there: Set<string>): string[] {
  const groups = new Map<string, Set<number>>();
  for (const id of ids) {
    const m = copyOf(id);
    if (m) groups.set(m[1], (groups.get(m[1]) ?? new Set()).add(+m[2]));
  }
  const out: string[] = [];
  for (const [prefix, ks] of groups) {
    const original = prefix.slice(prefix.indexOf(":") + 1);
    const all = [...there].filter((k) => k.startsWith(`${prefix}:`) && /^\d+$/.test(k.slice(prefix.length + 1)));
    if (ids.includes(original) && all.length && all.every((k) => ks.has(+k.slice(prefix.length + 1)))) out.push(prefix);
  }
  return out;
}

/**
 * The bodies a step names, as they are now. A whole pattern picked (the
 * original and every copy - "Whole Pattern") stays whole when the pattern's
 * count changes: 8 vents subtracted, made 10, all 10 are cut (and made 6, the
 * step still works). Which those are is kept with the step (`whole`, worked
 * out when it was made); a step without it goes by what's there now. Copies no
 * longer there are left out with a note, as long as something is left to work with.
 */
function bodyList(ids: string[], bodies: Bodies, what: "tools" | "bodies", given?: string[]): string[] {
  const out: string[] = [];
  // (Only patterns whose original it still names: picks changed by hand since are bodies one by one.)
  const whole = new Set((Array.isArray(given) ? given : wholeOf(ids, new Set(bodies.keys()))).filter((p) => ids.includes(p.slice(p.indexOf(":") + 1))));
  // Copies of copies too (a row of holes, then mirrored: the mirror's copies of the row's copies).
  const add = (id: string) => {
    if (out.includes(id)) return;
    out.push(id);
    for (const p of whole) if (p.slice(p.indexOf(":") + 1) === id) for (const k of [...bodies.keys()]) if (k.startsWith(`${p}:`) && /^\d+$/.test(k.slice(p.length + 1))) add(k);
  };
  for (const id of ids) {
    const m = copyOf(id);
    if (!m || !whole.has(m[1])) add(id);
  }
  const have = [...new Set(out)].filter((id) => bodies.has(id));
  const gone = new Set(out).size - have.length;
  if (!have.length) throw new Error("A body it uses no longer exists");
  if (gone) editNotes.push(`${gone} of the ${what === "tools" ? "bodies it used" : "bodies it named"} no longer exist - it works with the rest.`);
  return have;
}

function need(bodies: Bodies, id: string): Shape3D {
  const b = bodies.get(id);
  if (!b) throw new Error("A body it uses no longer exists");
  return b;
}

function isEmpty(shape: AnyShape): boolean {
  try {
    return (shape as Shape3D).faces.length === 0;
  } catch {
    return true;
  }
}

/** Pattern copies are named `${featureId}:${body}:${k}`. */
function baseId(bodyId: string): string {
  return bodyId.split(":")[0];
}

/**
 * Plain names: Body 1, Body 2… (Surface 1… for open surfaces), numbered in the
 * order the bodies were made; imported files keep their file name.
 */
function bodyNames(features: Feature[], ids: string[], numbers: Map<string, number>): Map<string, string> {
  const isSurface = (x: Feature | undefined) => x?.type === "freeform" && !!x.surface && !x.thickness;
  const order = [...ids].sort((a, b) => (numbers.get(a) ?? 0) - (numbers.get(b) ?? 0));
  const out = new Map<string, string>();
  let bodies = 0;
  let surfaces = 0;
  for (const id of order) {
    const f = features.find((x) => x.id === baseId(id));
    if (f?.type === "import") {
      out.set(id, f.fileName);
      continue;
    }
    // A copy of a surface is a surface too (its id holds the original's).
    const surface = id.split(":").some((part) => isSurface(features.find((x) => x.id === part)));
    out.set(id, surface ? `Surface ${++surfaces}` : `Body ${++bodies}`);
  }
  return out;
}

export function errorText(err: unknown): string {
  // A step whose saved values are missing or the wrong kind (a damaged file, a
  // step from a newer version) trips the code itself: said in words, not "x is not iterable".
  if (err instanceof RangeError && /allocation|array length|Array buffer|too large/i.test(err.message)) return "This is too big to compute (a value far too big?)";
  if (err instanceof TypeError || err instanceof RangeError || err instanceof ReferenceError) {
    console.error(err);
    return DAMAGED_TEXT;
  }
  if (err instanceof Error) return err.message.trim() || "The geometry kernel could not compute this (try other values)";
  // OpenCascade gave up (a raw exception from the kernel): say so in words.
  if (typeof err === "number" || String(err).includes("WebAssembly.Exception") || String(err) === "[object Object]") return "The geometry kernel could not compute this (try other values)";
  return String(err);
}

/** What's wrong with a body, in words (for a repair that couldn't fix it). */
function whatsWrong(h: ReturnType<typeof healthOf>): string {
  const out: string[] = [];
  if (!h.solids) out.push(h.shells ? "it's a surface that doesn't close" : "it has no surface that encloses anything");
  if (h.openEdges) out.push(`${h.openEdges} open edge${h.openEdges > 1 ? "s" : ""} (a gap or a missing curved face)`);
  if (!h.valid) out.push("faces that don't meet up");
  if (h.thin) out.push(`${h.thin} hair-thin face${h.thin > 1 ? "s" : ""}`);
  return out.join(", ") || "it doesn't enclose a volume";
}

/**
 * A step's big values (an imported model's megabytes) as a short fingerprint
 * in the text its key is made from, worked out once per value: hashing them
 * character by character on every rebuild cost 15 ms per 5 MB, every step of
 * a drag.
 */
const bigPrints = new Map<string, string>();
function shortBig(_k: string, v: unknown): unknown {
  if (typeof v !== "string" || v.length < 20_000) return v;
  let p = bigPrints.get(v);
  if (!p) {
    p = `\u0000big:${hash53(v, 11)}.${hash53(v, 13)}.${v.length}`;
    if (bigPrints.size > 64) bigPrints.clear();
    bigPrints.set(v, p);
  }
  return p;
}

/** Key of the steps so far: the previous key and this step's JSON, hashed (two 53-bit hashes, no collisions in practice). */
function chainKey(prev: string, json: string): string {
  return `${hash53(prev + json, 1)}.${hash53(json, 7)}.${json.length}`;
}

/** cyrb53: a fast, well-mixed 53-bit string hash. */
function hash53(str: string, seed: number): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * An open surface filled down to a plane: the surface swept straight towards
 * the plane (along its normal) and past it, then everything beyond the plane
 * cut away - sides straight down, the bottom its outline projected onto the
 * plane. Parts of the surface beyond the plane are left out.
 */
function fillToPlane(sheet: Shape3D, plane: PlaneDef): Shape3D {
  const oc = getOC();
  if (subShapes(sheet, "SOLID").length) throw new Error("Fill to Plane fills an open surface - this body is already a solid");
  if (!sheet.faces.length) throw new Error("This body has no surface to fill from");
  const n = norm(plane.normal);
  // Which side the surface is on (most of it): the fill goes from there to the plane.
  const side = Math.sign(dot(sub(sheet.boundingBox.center as Vec3, plane.origin), n));
  if (!side) throw new Error("The surface lies across the plane - move the plane to one side of it");
  // Seen from the plane, the surface must have some area: a plane side-on to it
  // (facing its edge) has nothing to fill.
  let facing = 0;
  let total = 0;
  // And which way it faces the plane, all over: both ways means it folds back
  // over itself as seen from the plane (the blocks under it overlap).
  let up = 0;
  let down = 0;
  for (const f of sheet.faces) {
    const a = measureArea(f);
    for (const [u, w] of [[0.5, 0.5], [0.15, 0.15], [0.85, 0.15], [0.15, 0.85], [0.85, 0.85]]) {
      let fn: Vec3;
      try {
        fn = norm(surfaceAt(f, u, w).n);
      } catch {
        continue;
      }
      const c = dot(fn, n);
      facing += (Math.abs(c) * a) / 5;
      total += a / 5;
      if (c > 0.02) up += a;
      else if (c < -0.02) down += a;
    }
  }
  const folds = Math.min(up, down) > Math.max(up, down) * 1e-3;
  if (facing < total * 0.3) throw new Error("The plane is side-on to the surface (facing its edge) - pick a plane the surface lies over, like the ground under it");
  const bb = sheet.boundingBox;
  const reach = (Math.hypot(bb.width, bb.height, bb.depth) + Math.abs(dot(sub(bb.center as Vec3, plane.origin), n))) * 2 + 1;
  const v = new oc.gp_Vec(-side * n[0] * reach, -side * n[1] * reach, -side * n[2] * reach);
  const mk = new oc.BRepPrimAPI_MakePrism(sheet.wrapped, v, true, true);
  let swept: Shape3D;
  try {
    swept = cast(mk.Shape()) as Shape3D;
  } finally {
    mk.delete();
    v.delete();
  }
  // The surface's side of the plane only - one cut for the whole sweep.
  const keep = halfSpace(side > 0 ? plane : { ...plane, normal: scale(n, -1) as Vec3 }, swept);
  const cut = swept.intersect(keep);
  if (isEmpty(cut)) throw new Error("The surface doesn't reach over the plane (seen along the plane's normal, there's nothing to fill)");
  // One block per surface patch, side by side: the walls between them (each
  // shared by two blocks) go, and the outside is sewn into one solid.
  const blocks = subShapes(cut, "SOLID").map((x) => cast(x) as Shape3D);
  const seen: { f: Face; n: number }[] = [];
  for (const b of blocks)
    for (const f of b.faces) {
      const had = seen.find((x) => x.f.isSame(f));
      if (had) had.n++;
      else seen.push({ f, n: 1 });
    }
  const outside = seen.filter((x) => x.n === 1).map((x) => x.f.wrapped);
  /** The blocks joined by unions (slow, but right where they overlap). */
  const joinAll = (): Shape3D => {
    try {
      // Each patch's sweep cut on its own (cutting them all at once mixes up the overlaps).
      const own = subShapes(swept, "SOLID").map((x) => (cast(x) as Shape3D).intersect(keep)).filter((x) => !isEmpty(x));
      const j = own.reduce((a, b) => a.fuse(b));
      if (isEmpty(j)) throw new Error("empty");
      return j;
    } catch {
      throw new Error(facing < total * 0.6 ? "The plane is too side-on to the surface - pick a plane the surface lies over, like the ground under it" : "The surface folds back over itself as seen from the plane too much to fill - pick a plane it lies flatter over");
    }
  };
  const size = Math.hypot(bb.width, bb.height, bb.depth);
  const sw = new oc.BRepBuilderAPI_Sewing(size * 1e-7, true, true, true, false);
  let solid: Shape3D;
  try {
    for (const f of outside) sw.Add(f);
    sw.Perform(new oc.Message_ProgressRange());
    const shells = subShapes(cast(sw.SewedShape()) as Shape3D, "SHELL");
    if (shells.length !== 1) solid = joinAll();
    else {
      const fix = new oc.ShapeFix_Solid();
      const made = fix.SolidFromShell(shells[0]);
      fix.delete();
      oc.BRepLib.OrientClosedSolid(oc.TopoDS.Solid(made));
      solid = cast(made) as Shape3D;
    }
  } finally {
    sw.delete();
  }
  // The surface folds back over itself as seen from the plane: the blocks
  // overlap instead of just touching - joined the slow, sure way instead.
  if (folds) solid = joinAll();
  // The bottom (one flat piece per patch) and flat sides become whole faces.
  try {
    solid = unify(solid);
  } catch {
    // keep it as sewn
  }
  const v0 = Math.abs(measureVolume(solid));
  if (!(v0 > reach ** 3 * 1e-12)) throw new Error("There's nothing between the surface and the plane to fill");
  const r = repairShape(solid);
  if (!r) throw new Error("The fill didn't come out as a clean solid (the surface folds back over itself as seen from the plane?)");
  if (r.fixes.length) editNotes.push(`Repaired automatically: ${r.fixes.join(", ")}.`);
  return r.shape;
}

/** A size that runs evenly from 1 at the path's start to k at its end (a sweep's end scale). */
function scaleLaw(spine: Wire, k: number) {
  const oc = getOC();
  const ad = new oc.BRepAdaptor_CompCurve(spine.wrapped, false);
  const t0 = ad.FirstParameter();
  const t1 = ad.LastParameter();
  ad.delete();
  const law = new oc.Law_Linear();
  law.Set(t0, 1, t1, k);
  return law;
}

/**
 * A fillet sized by its chord: the straight width across the round, from one
 * face to the other. Where the faces' outward normals are θ apart, a round of
 * radius r is 2·r·sin(θ/2) across, so r = width / (2·sin(θ/2)), worked out
 * along each edge (faces that meet at a changing angle get a changing radius).
 */
function chordFillet(body: Shape3D, edges: Edge[], c1: number, c2: number, flip: boolean): Shape3D {
  const oc = getOC();
  const builder = new oc.BRepFilletAPI_MakeFillet(body.wrapped, oc.ChFi3d_FilletShape.ChFi3d_Rational);
  try {
    for (const e of edges) {
      const two = body.faces.filter((fc) => fc.edges.some((x) => x.isSame(e)));
      if (two.length < 2) throw new Error("That edge has a face on one side only: there's nothing to round across");
      const N = 9;
      const radii: number[] = [];
      for (let i = 0; i < N; i++) {
        const u = i / (N - 1);
        const n1 = normalOnEdge(two[0], e, u) ?? norm(two[0].normalAt(e.pointAt(u)).toTuple() as Vec3);
        const n2 = normalOnEdge(two[1], e, u) ?? norm(two[1].normalAt(e.pointAt(u)).toTuple() as Vec3);
        const half = len(sub(n1, n2)) / 2; // sin(θ/2)
        if (half < 1e-3) throw new Error("The faces meet almost flat there, so a chord width can't size the round - switch Size to Radius");
        const c = flip ? c2 + (c1 - c2) * u : c1 + (c2 - c1) * u;
        radii.push(c / (2 * half));
      }
      const even = radii.every((r, i) => Math.abs(r - (radii[0] + ((radii[N - 1] - radii[0]) * i) / (N - 1))) < 1e-7 * Math.max(1, radii[0]));
      if (even && Math.abs(radii[0] - radii[N - 1]) < 1e-9) builder.Add(radii[0], e.wrapped);
      else if (even) builder.Add(radii[0], radii[N - 1], e.wrapped);
      else {
        const table = new oc.NCollection_Array1_gp_Pnt2d(1, N);
        radii.forEach((r, i) => {
          const q = new oc.gp_Pnt2d(i / (N - 1), r);
          table.SetValue(i + 1, q);
          q.delete();
        });
        builder.Add(table, e.wrapped);
        table.delete();
      }
    }
    return cast(builder.Shape()) as Shape3D;
  } finally {
    builder.delete();
  }
}

/**
 * How much of a path (as a share of its length) runs across `facing` - in the
 * plane of a profile that faces that way: a profile held facing the same way
 * has no thickness along those parts.
 */
function runsAcross(spine: Wire, facing: Vec3): number {
  let total = 0;
  let across = 0;
  for (const e of spine.edges) {
    const L = e.length as number;
    const n = e.geomType === "LINE" ? 1 : 32;
    for (let i = 0; i < n; i++) {
      const t = norm(e.tangentAt((i + 0.5) / n).toTuple() as Vec3);
      if (Math.abs(dot(t, facing)) < 0.005) across += L / n;
    }
    total += L;
  }
  return total > 0 ? across / total : 0;
}

/** Does a path have a sharp corner (two of its edges meeting at an angle)? */
function sharpCorners(spine: Wire): boolean {
  const edges = spine.edges;
  const size = edges.reduce((sum, e) => sum + (e.length as number), 0) || 1;
  const ends = edges.flatMap((e) => [0, 1].map((u) => ({ e, p: e.pointAt(u).toTuple() as Vec3, t: norm(e.tangentAt(u).toTuple() as Vec3) })));
  for (let i = 0; i < ends.length; i++)
    for (let j = i + 1; j < ends.length; j++) {
      if (ends[i].e === ends[j].e || dist(ends[i].p, ends[j].p) > size * 1e-7) continue;
      // (The same line through the point, whichever way each edge runs: within about two degrees.)
      if (Math.abs(dot(ends[i].t, ends[j].t)) < 0.9994) return true;
    }
  return false;
}

/** A path that runs straight from its start to its end: its ends (else null). */
function straightRun(spine: Wire): [Vec3, Vec3] | null {
  const oc = getOC();
  const ad = new oc.BRepAdaptor_CompCurve(spine.wrapped, true);
  const a = new oc.gp_Pnt();
  const b = new oc.gp_Pnt();
  try {
    ad.D0(ad.FirstParameter(), a);
    ad.D0(ad.LastParameter(), b);
    const p: Vec3 = [a.X(), a.Y(), a.Z()];
    const run = sub([b.X(), b.Y(), b.Z()], p);
    const L = len(run);
    if (L < 1e-9 || spine.edges.some((e) => e.geomType !== "LINE")) return null;
    const d = norm(run);
    for (const e of spine.edges)
      for (const t of [0, 1]) {
        const q = sub(e.pointAt(t).toTuple() as Vec3, p);
        if (len(cross(q, d)) > L * 1e-9) return null;
      }
    return [p, add(p, run)];
  } finally {
    b.delete();
    a.delete();
    ad.delete();
  }
}

/** Every point of the wire as far from the path's start, in the plane square to the path there (a circle round it). */
function roundAboutPath(w: Wire, spine: Wire): boolean {
  const oc = getOC();
  const ad = new oc.BRepAdaptor_CompCurve(spine.wrapped, true);
  const p = new oc.gp_Pnt();
  const v = new oc.gp_Vec();
  try {
    ad.D1(ad.FirstParameter(), p, v);
    const o: Vec3 = [p.X(), p.Y(), p.Z()];
    const t = norm([v.X(), v.Y(), v.Z()]);
    let r = -1;
    const tol = Math.max(1e-9, len(sub(...(w.boundingBox.bounds as [Vec3, Vec3]))) * 1e-7);
    for (const e of w.edges)
      for (let i = 0; i <= 8; i++) {
        const q = sub(e.pointAt(i / 8).toTuple() as Vec3, o);
        if (Math.abs(dot(q, t)) > tol) return false;
        if (r < 0) r = len(q);
        else if (Math.abs(len(q) - r) > tol) return false;
      }
    return r > tol;
  } finally {
    v.delete();
    p.delete();
    ad.delete();
  }
}

/**
 * A curve wound round a sweep's path that turns `deg` degrees from start to
 * end, evenly by length, `reach` out from the path: a sweep that keeps the
 * profile pointing at it twists. It starts from the path's own frame that
 * doesn't spin (rotation minimizing, by double reflection), so a twist of 0
 * would be the plain sweep.
 */
function twistGuide(spine: Wire, deg: number, reach: number): Wire {
  const oc = getOC();
  const ad = new oc.BRepAdaptor_CompCurve(spine.wrapped, true);
  const u0 = ad.FirstParameter();
  const u1 = ad.LastParameter();
  const n = Math.min(600, 64 + Math.ceil((Math.abs(deg) / 360) * 32));
  const pts: Vec3[] = [];
  for (let i = 0; i <= n; i++) {
    const p = ad.Value(u0 + ((u1 - u0) * i) / n);
    pts.push([p.X(), p.Y(), p.Z()]);
    p.delete();
  }
  ad.delete();
  const tan = pts.map((_, i) => norm(sub(pts[Math.min(n, i + 1)], pts[Math.max(0, i - 1)])));
  // Any square-on direction to start with.
  const t0 = tan[0];
  let r = norm(cross(t0, Math.abs(t0[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
  const along = [0];
  for (let i = 1; i <= n; i++) along.push(along[i - 1] + len(sub(pts[i], pts[i - 1])));
  const total = along[n] || 1;
  const out: Vec3[] = [];
  for (let i = 0; i <= n; i++) {
    if (i > 0) {
      const v1 = sub(pts[i], pts[i - 1]);
      const c1 = dot(v1, v1);
      if (c1 > 1e-18) {
        const rL = sub(r, scale(v1, (2 / c1) * dot(v1, r)));
        const tL = sub(tan[i - 1], scale(v1, (2 / c1) * dot(v1, tan[i - 1])));
        const v2 = sub(tan[i], tL);
        const c2 = dot(v2, v2);
        r = norm(c2 > 1e-18 ? sub(rL, scale(v2, (2 / c2) * dot(v2, rL))) : rL);
      }
    }
    const a = ((deg * Math.PI) / 180) * (along[i] / total);
    const b = cross(tan[i], r);
    out.push(add(pts[i], scale(add(scale(r, Math.cos(a)), scale(b, Math.sin(a))), reach)));
  }
  return assembleWire([makeBSplineApproximation(out, { tolerance: reach * 1e-5, degMax: 5, degMin: 3 })]);
}

/**
 * A loft carried along a spine: the guide curve, or (a closed loop with no
 * guide) a smooth closed curve through the profiles' middles in the order
 * they were picked. Each profile sits where it is drawn; the body passes
 * through them in their order along the spine.
 */
function loftAlong(wires: Wire[], guide: Wire | null, closed: boolean): Shape3D {
  const oc = getOC();
  const mid = (w: Wire): Vec3 => {
    const [lo, hi] = w.boundingBox.bounds as [Vec3, Vec3];
    return scale(add(lo, hi), 0.5);
  };
  let spine = guide;
  let order = wires;
  if (!spine) {
    // A closed curve through the middles (Catmull-Rom: through each one, smooth all round).
    const c = wires.map(mid);
    const n = c.length;
    const pts: Vec3[] = [];
    const steps = 24;
    for (let i = 0; i < n; i++) {
      const [p0, p1, p2, p3] = [c[(i - 1 + n) % n], c[i], c[(i + 1) % n], c[(i + 2) % n]];
      for (let k = 0; k < steps; k++) {
        const t = k / steps;
        const t2 = t * t;
        const t3 = t2 * t;
        const w = [-t3 + 2 * t2 - t, 3 * t3 - 5 * t2 + 2, -3 * t3 + 4 * t2 + t, t3 - t2].map((x) => x / 2);
        pts.push(add(add(scale(p0, w[0]), scale(p1, w[1])), add(scale(p2, w[2]), scale(p3, w[3]))));
      }
    }
    pts.push(pts[0]);
    const size = Math.max(...c.map((p) => len(sub(p, c[0]))), 1);
    spine = assembleWire([makeBSplineApproximation(pts, { tolerance: size * 1e-5, degMax: 5, degMin: 3 })]);
  } else {
    // Along a guide: in the order they lie along it.
    const ad = new oc.BRepAdaptor_CompCurve(spine.wrapped, true);
    const u0 = ad.FirstParameter();
    const u1 = ad.LastParameter();
    const samples: Vec3[] = [];
    for (let i = 0; i <= 200; i++) {
      const p = ad.Value(u0 + ((u1 - u0) * i) / 200);
      samples.push([p.X(), p.Y(), p.Z()]);
      p.delete();
    }
    ad.delete();
    const at = (w: Wire) => {
      const m = mid(w);
      let best = 0;
      samples.forEach((p, i) => len(sub(p, m)) < len(sub(samples[best], m)) && (best = i));
      return best;
    };
    order = [...wires].sort((a, b) => at(a) - at(b));
  }
  const builder = new oc.BRepOffsetAPI_MakePipeShell(spine.wrapped);
  try {
    builder.SetMode(false);
    for (const w of order) builder.Add(w.wrapped, false, false);
    if (closed && guide) builder.Add(order[0].wrapped, false, false);
    builder.Build(new oc.Message_ProgressRange());
    if (!builder.IsDone()) throw new Error("no shape");
    builder.MakeSolid();
    const shape = cast(builder.Shape());
    if (!isShape3D(shape)) throw new Error("no solid");
    return shape;
  } catch {
    throw new Error(guide ? "The profiles can't be carried along that guide - each one needs to sit across it" : "These profiles can't be joined into a closed loop");
  } finally {
    builder.delete();
  }
}

/**
 * Smooth (G2) fillets: the blend's bend eases in from nothing at both faces
 * (no line in reflections where it starts), unlike a circular round whose
 * bend starts all at once. Its cross-section is a degree-5 Bezier whose first
 * and last three control points lie in the faces, so it leaves each face flat
 * (curvature 0) and tangent. It starts where a round of the same radius would.
 * Made for straight edges between flat faces (a prism of the corner, cut away
 * or, in an inside corner, added) and full circular edges between a flat face
 * and a cylinder (the same section spun round the axis).
 */
function g2Fillet(body: Shape3D, edges: Edge[], r: number): Shape3D {
  return blendFillet(body, edges, r, true);
}

/**
 * Rounds built from their own cross-section (see g2Fillet): `smooth`, the G2
 * Bezier; otherwise a true circular arc. Made with booleans, the round trims
 * whatever it runs into: a round too big for the face beside it cuts on
 * through that face's far edge, still exactly round (overflow, keep surface).
 */
function blendFillet(body: Shape3D, edges: Edge[], r: number, smooth: boolean): Shape3D {
  const P = (v: { toTuple(): number[] }) => v.toTuple() as Vec3;
  const made: { tool: Shape3D; convex: boolean; along: Vec3 | null }[] = [];
  for (const e of edges) {
    const two = body.faces.filter((fc) => fc.edges.some((x) => x.isSame(e)));
    if (two.length < 2) throw new Error("That edge has a face on one side only: there's nothing to round across");
    const [fa, fb] = two;
    const kinds = [fa.geomType, fb.geomType];
    // A point on the edge, the edge's direction there, and each face's way in from it.
    let at: Vec3;
    let t: Vec3;
    let length = 0;
    let axis: { c: Vec3; dir: Vec3 } | null = null;
    if (e.geomType === "LINE" && kinds.every((k) => k === "PLANE")) {
      const a = P(e.startPoint);
      const b = P(e.endPoint);
      length = len(sub(b, a));
      t = norm(sub(b, a));
      at = a;
    } else if (e.geomType === "CIRCLE" && kinds.includes("PLANE") && kinds.includes("CYLINDRE") && len(sub(P(e.startPoint), P(e.endPoint))) < 1e-7) {
      const [p0, p1, p2] = [0, 1 / 3, 2 / 3].map((u) => P(e.pointAt(u)));
      const n = norm(cross(sub(p1, p0), sub(p2, p0)));
      // The circle's centre: equally far from all three points.
      const ab = sub(p1, p0);
      const ac = sub(p2, p0);
      const abXac = cross(ab, ac);
      const c = add(p0, scale(add(scale(cross(abXac, ab), dot(ac, ac)), scale(cross(ac, abXac), dot(ab, ab))), 1 / (2 * dot(abXac, abXac))));
      axis = { c, dir: n };
      at = p0;
      t = norm(cross(n, sub(p0, c)));
    } else throw new Error(smooth ? "Smooth (G2) works on straight edges between flat faces and on the round edges of cylinders - set Blend to Round for this edge" : "unsupported edge");
    const probe = Math.max(1e-4, r * 1e-3);
    const inward = (face: Face): Vec3 => {
      const nrm = norm(P(face.normalAt(at)));
      let u = norm(cross(nrm, t));
      const q = makeVertex(add(at, scale(u, probe)));
      if (measureDistanceBetween(face, q) > probe * 0.5) u = scale(u, -1);
      q.delete();
      return u;
    };
    const u1 = inward(fa);
    const u2 = inward(fb);
    const n1 = norm(P(fa.normalAt(at)));
    const n2 = norm(P(fb.normalAt(at)));
    const convex = dot(n1, u2) < 0;
    const cosA = Math.max(-1, Math.min(1, dot(u1, u2)));
    const phi = Math.acos(cosA);
    if (phi > Math.PI - 1e-3) throw new Error("The faces meet almost flat there: there's no corner to blend");
    const d = r / Math.tan(phi / 2);
    // The corner's section, pushed past the faces on the side away from the blend (no faces lying on faces).
    const back = convex ? 1 : -1;
    const ext = axis ? 0 : Math.max(d, length * 0.02);
    const O = sub(at, scale(t, ext));
    const A = add(O, scale(u1, d));
    const B = add(O, scale(u2, d));
    // The round's middle: on the bisector, a radius short of its centre.
    const bis = norm(add(u1, u2));
    const curve = smooth
      ? makeBezierCurve([A, add(O, scale(u1, 0.7 * d)), add(O, scale(u1, 0.4 * d)), add(O, scale(u2, 0.4 * d)), add(O, scale(u2, 0.7 * d)), B])
      : makeThreePointArc(A, add(O, scale(bis, r / Math.sin(phi / 2) - r)), B);
    const outB = add(B, scale(n2, back * d));
    const outO = add(O, scale(add(n1, n2), back * d));
    const outA = add(A, scale(n1, back * d));
    const wire = assembleWire([curve, makeLine(B, outB), makeLine(outB, outO), makeLine(outO, outA), makeLine(outA, A)]);
    const section = makeFace(wire);
    const tool = (axis ? revolution(section, axis.c, axis.dir, 360) : basicFaceExtrusion(section, new Vector(scale(t, length + 2 * ext)))) as Shape3D;
    made.push({ tool, convex, along: axis ? null : t });
  }
  // Two rounds side by side that run into each other along their length (both
  // edges of a block narrower than the two of them): that isn't a round that
  // overflows a face, it doesn't fit. (Rounds meeting at a corner are fine.)
  for (let i = 0; i < made.length; i++)
    for (let j = i + 1; j < made.length; j++) {
      const [a, b] = [made[i], made[j]];
      if (!a.along || !b.along || Math.abs(dot(a.along, b.along)) < 0.999) continue;
      const both = a.tool.intersect(b.tool).intersect(body) as Shape3D;
      if (measureVolume(both) > 1e-6 * Math.pow(r, 3)) throw new Error("Those rounds run into each other - make the radius smaller");
    }
  let out = body;
  for (const m of made) out = (m.convex ? out.cut(m.tool) : out.fuse(m.tool)) as Shape3D;
  return out;
}

/**
 * Setback corners: where three or more of the rounded edges meet, the rounds
 * stop `s` from the corner and one smooth patch joins them (it meets every
 * face round it tangentially), instead of the rolling ball's corner. Made by
 * cutting a ball of radius s out of the rounded corner and filling the hole.
 */
function setbackCorners(body: Shape3D, edges: Edge[], s: number, r: number): Shape3D {
  const oc = getOC();
  const P = (v: { toTuple(): number[] }) => v.toTuple() as Vec3;
  // The corners: points where three or more of the edges end.
  const ends = edges.flatMap((e) => [P(e.startPoint), P(e.endPoint)]);
  const tol = 1e-6 * (1 + Math.max(...ends.map((p) => len(p))));
  const corners: Vec3[] = [];
  for (const p of ends) if (!corners.some((c) => len(sub(c, p)) < tol) && ends.filter((q) => len(sub(q, p)) < tol).length >= 3) corners.push(p);
  if (!corners.length) throw new Error("Setback joins corners where three or more rounded edges meet - pick all the edges round a corner");
  if (s < r * 1.8) throw new Error(`The setback needs to be at least ${Math.ceil(r * 1.8 * 100) / 100} for this radius (it must reach past the rounds' own corner)`);
  for (const e of edges) {
    const at = corners.filter((c) => len(sub(c, P(e.startPoint))) < tol || len(sub(c, P(e.endPoint))) < tol).length;
    if (at && len(sub(P(e.endPoint), P(e.startPoint))) < s * at * 1.05) throw new Error("The setback is longer than an edge it runs along - make it smaller");
  }
  let out = body;
  for (const c of corners) {
    const ball = makeSphere(s).translate(c);
    const cut = out.cut(ball) as Shape3D;
    const near = (fc: Face) => fc.geomType === "SPHERE" && Math.abs(len(sub(P(fc.center), c)) - s) < s * 0.5 + tol;
    const hole = cut.faces.filter(near);
    const keep = cut.faces.filter((fc) => !near(fc));
    if (!hole.length) throw new Error("The setback missed the corner");
    // The hole's rim, edge after edge, each held smooth to the face beside it.
    const rim = hole.flatMap((fc) => fc.edges).filter((e) => e.geomType !== "LINE" || len(sub(P(e.startPoint), P(e.endPoint))) > tol);
    const fill = new oc.BRepOffsetAPI_MakeFilling(3, 15, 2, false, 1e-5, 1e-4, 0.01, 0.1, 8, 9);
    try {
      for (const e of rim) {
        const beside = keep.find((fc) => fc.edges.some((x) => x.isSame(e)));
        if (beside) fill.Add(e.wrapped, beside.wrapped, oc.GeomAbs_Shape.GeomAbs_G1, true);
        else fill.Add(e.wrapped, oc.GeomAbs_Shape.GeomAbs_C0, true);
      }
      fill.Build(new oc.Message_ProgressRange());
      if (!fill.IsDone()) throw new Error("no patch");
      const patch = cast(fill.Shape()) as AnyShape;
      const patchFaces = "faces" in patch ? (patch as unknown as { faces: Face[] }).faces : [patch as unknown as Face];
      const made = makeSolid([...keep, ...patchFaces]);
      if (openEdges(made).length > 0 || !shapeValid(made)) throw new Error("leaky");
      out = made;
    } catch {
      throw new Error("The corner patch didn't fit - try a different setback");
    } finally {
      fill.delete();
    }
  }
  return out;
}
