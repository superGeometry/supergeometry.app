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
  iterTopo,
  makeBSplineApproximation,
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
  measureVolume,
  revolution,
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
import { add, cross, dist, dot, len, norm, scale, sub, toWorld, xDirFor } from "../geom";
import { projectPolyline } from "../sketch/edit";
import { cageToShape } from "./freeform";
import { deepCopy, hairThin, openEdges, shapeValid, subShapes } from "./health";
import { healthOf, repairShape } from "./repair";
export { shapeValid } from "./health";
import { deleteFaces, isClosed, selfCrossings, subdivide } from "../freeform/cage";
import { useSafeBooleans } from "./safeBooleans";
import { cylinderOf, deleteFace, editNotes, hasBlends, offsetFace, planeOf, replaceFacePlane, sizeOf, unify } from "./faceEdit";
import { threadDepth } from "./threads";
import { entitiesWire, regionFaces, regionWire, withFittedSplines } from "./sketchGeom";
import type { BodyMesh, ConstructionInfo, EdgeInfo, ExportFormat, FaceInfo, FeatureError, RegenResult } from "./protocol";

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

interface CacheEntry {
  key: string;
  ctx: Ctx;
  error?: string;
  /** Worked, but had to give something up (shown on the step in History). */
  note?: string;
}

const meshCache = new WeakMap<Shape3D, BodyMesh>();
const importCache = new Map<string, Shape3D>();
let cache: CacheEntry[] = [];

// ------------------------------------------------------------------ public API

export async function exportBodies(features: Feature[], format: ExportFormat, only?: string[]): Promise<Blob> {
  const { ctx, numbers } = await run(features);
  const shapes = [...ctx.bodies.entries()].filter(([id]) => !only || only.includes(id));
  if (shapes.length === 0) throw new Error("Nothing to export");
  const names = bodyNames(features, [...ctx.bodies.keys()], numbers);
  if (format === "mesh") {
    // As fine as the STL (the view's own mesh is coarser, for speed).
    const out = shapes.map(([id, s]) => {
      const m = s.mesh({ tolerance: PRINT_TOLERANCE, angularTolerance: PRINT_ANGLE });
      return { id, positions: m.vertices, indices: m.triangles };
    });
    return new Blob([JSON.stringify(out)], { type: "application/json" });
  }
  return format === "step"
    ? exportSTEP(shapes.map(([id, shape]) => ({ shape, name: names.get(id)! })))
    : await makeCompound(shapes.map(([, s]) => s.clone())).blobSTL({ binary: true, tolerance: PRINT_TOLERANCE, angularTolerance: PRINT_ANGLE });
}

/**
 * How finely a mesh for printing (STL, 3MF) follows curved surfaces: within
 * 0.01 mm, and a facet per 0.05 rad (under 3°). Slicers draw each facet flat,
 * so round faces showed as polygons at the view's coarser setting.
 */
const PRINT_TOLERANCE = 0.01;
const PRINT_ANGLE = 0.05;

export async function regenerate(features: Feature[]): Promise<RegenResult> {
  const t0 = performance.now();
  const { ctx, errors, numbers, notes } = await run(features);
  const names = bodyNames(features, [...ctx.bodies.keys()], numbers);
  const meshes: BodyMesh[] = [];
  for (const [id, shape] of ctx.bodies) {
    try {
      meshes.push(meshBody(id, names.get(id)!, shape));
    } catch (err) {
      errors.push({ featureId: baseId(id), message: `Could not display body: ${errorText(err)}` });
    }
  }
  const sketchPlanes: Record<string, PlaneDef> = {};
  const sketchBoundaries: Record<string, SketchEntity[]> = {};
  for (const [id, s] of ctx.sketches) {
    sketchPlanes[id] = s.plane;
    if (s.boundary.length) sketchBoundaries[id] = s.boundary;
  }
  return { bodies: meshes, errors, notes, sketchPlanes, sketchBoundaries, planes: [...ctx.planes.values()], axes: [...ctx.axes.values()], ms: performance.now() - t0 };
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

async function run(features: Feature[]) {
  useSafeBooleans();
  const errors: FeatureError[] = [];
  const notes: FeatureError[] = [];
  let ctx: Ctx = { bodies: new Map(), sketches: new Map(), planes: new Map(), axes: new Map(), freeforms: new Map(), sweeps: new Map() };
  let key = "";
  const next: CacheEntry[] = [];
  let hit = true;

  for (let i = 0; i < features.length; i++) {
    const f = features[i];
    // Chained hashes, not the text itself: a key holding every step's JSON
    // grew with the square of the project (an import's megabytes in each one).
    key = chainKey(key, JSON.stringify(f));
    const cached: CacheEntry | undefined = hit && cache[i]?.key === key ? cache[i] : undefined;
    hit = !!cached;
    let entry: CacheEntry;
    if (cached) {
      entry = cached;
    } else {
      const out: Ctx = { bodies: new Map(ctx.bodies), sketches: new Map(ctx.sketches), planes: new Map(ctx.planes), axes: new Map(ctx.axes), freeforms: new Map(ctx.freeforms), sweeps: new Map(ctx.sweeps) };
      entry = { key, ctx: out };
      if (!f.suppressed) {
        try {
          editNotes.length = 0;
          // An edit works on copies of the bodies it may touch: OpenCascade is
          // allowed to adjust the shapes it is given, and the earlier steps'
          // results (kept in the cache) must never change - not even when this
          // step fails. Bodies it leaves alone get their originals back.
          const copies = new Map<string, Shape3D>();
          if (GUARDED.has(f.type)) {
            for (const id of touchedBodies(f, ctx)) {
              const b = out.bodies.get(id);
              if (!b || out.freeforms.has(id)) continue;
              const c = deepCopy(b);
              copies.set(id, c);
              out.bodies.set(id, c);
            }
          }
          await apply(f, out);
          for (const [id, c] of copies) if (out.bodies.get(id) === c) out.bodies.set(id, ctx.bodies.get(id)!);
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
              const kept = guardEdit(before, after, !NO_SPLIT.has(f.type) && !inPlace);
              // Cut away to dust: the body is gone.
              if (kept) out.bodies.set(id, kept);
              else out.bodies.delete(id);
            }
          }
          if (editNotes.length) entry.note = [...new Set(editNotes)].join(" ");
          // Anything but a move/scale changing a freeform body makes it an ordinary body.
          if (f.type !== "freeform" && f.type !== "transform") for (const id of [...out.freeforms.keys()]) if (out.bodies.get(id) !== ctx.bodies.get(id)) out.freeforms.delete(id);
        } catch (err) {
          entry.error = errorText(err);
          entry.ctx = { ...ctx, sketches: f.type === "sketch" ? new Map(ctx.sketches).set(f.id, { ...f, boundary: [] }) : ctx.sketches };
        }
      }
    }
    if (entry.error) errors.push({ featureId: f.id, message: entry.error });
    if (entry.note && !entry.error) notes.push({ featureId: f.id, message: entry.note });
    ctx = entry.ctx;
    next.push(entry);
  }
  cache = next;
  lastBodies = ctx.bodies;
  // Bodies are numbered in the order they first appeared (a body that's
  // deleted later keeps its number used, so the others don't change names).
  const numbers = new Map<string, number>();
  for (const e of next) for (const id of e.ctx.bodies.keys()) if (!numbers.has(id)) numbers.set(id, numbers.size + 1);
  return { ctx, errors, numbers, notes };
}

async function apply(f: Feature, ctx: Ctx): Promise<void> {
  const { bodies } = ctx;
  switch (f.type) {
    case "sketch": {
      const plane = f.attachedTo ? followFace(f, bodies) : f.plane;
      // On a face, the face outline takes part in regions: a line across the face splits it.
      const boundary = f.attachedTo ? faceBoundary(f.attachedTo, plane, bodies) : [];
      ctx.sketches.set(f.id, { ...f, plane, boundary });
      return;
    }

    case "extrude": {
      if (Math.abs(f.distance) < 1e-6) throw new Error("Distance is zero");
      // Pushing/pulling a face of its own body offsets it: the neighbouring faces
      // extend along their own surfaces (a round side stays round).
      const tapered = f.taper !== undefined && Math.abs(f.taper - 1) > 1e-9;
      if (tapered) {
        // Sides leaning in (or out): each shape's outline to a scaled copy at the far end.
        const parts = sourceFaces(f.source, ctx).map(({ face, normal }) => {
          // (replicad's outerWire() and innerWires() free the face they're asked
          // of: they're asked of copies.)
          const c = face.center.toTuple() as Vec3;
          if (face.clone().innerWires().length) throw new Error("Taper works on shapes without holes");
          const w0 = face.clone().outerWire();
          const k = Math.max(0.002, f.taper!);
          // Straight-edged shapes: flat sides (a loft makes them curved surfaces,
          // and then nothing that needs a flat face - sketch on it, move it - works).
          const flat = taperedPrism(face, c, normal, k, f.distance);
          if (flat) return flat;
          const w1 = w0.clone().scale(k, c).translate(scale(normal, f.distance));
          try {
            return loft([w0, w1], { ruled: true }) as Shape3D;
          } catch {
            throw new Error("This shape can't be tapered");
          }
        });
        combine(f.id, f.mode, f.target, fuseAll(parts), f.distance < 0, ctx);
        return;
      }
      if (f.source.kind === "face" && f.mode !== "new" && f.target === f.source.face.body) {
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
      const parts = sourceFaces(f.source, ctx).map(({ face, normal }) => basicFaceExtrusion(face, new Vector(normal).multiply(f.distance)));
      const solid = fuseAll(parts);
      // Auto: other bodies the extrusion runs into get cut through. Drawn on
      // its own (no body it belongs to), it then only cuts - no new body.
      if (f.mode === "auto") {
        const hit = overlapping(solid, ctx, f.target);
        for (const id of hit) {
          const cut = fuzzyBoolean("cut", need(bodies, id), solid);
          if (isEmpty(cut)) bodies.delete(id);
          else bodies.set(id, cut);
          ctx.freeforms.delete(id);
        }
        if (hit.length && !f.target) return;
      }
      combine(f.id, f.mode, f.target, solid, f.distance < 0, ctx);
      return;
    }

    case "revolve": {
      if (Math.abs(f.angle) < 1e-6) throw new Error("Angle is zero");
      const axis = resolveAxis(f.axis, ctx);
      if (f.travel && Math.abs(f.travel) > 1e-9) {
        // Moving along the axis while turning: a helical sweep (threads, springs).
        const parts = sourceWires(f.source, ctx).map((w) => helicalSweep(w, axis.origin, norm(axis.dir), f.angle, f.travel!));
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
      const parts = sourceWires(f.source, ctx).map((w) => genericSweep(w, spine, { frenet: false, transitionMode: "round" }) as Shape3D);
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
      if (frames.every((fr) => Math.abs(dot(fr.normal, n0)) > 0.999)) {
        const h = (i: number) => dot(sub(frames[i].origin, frames[0].origin), n0);
        order.sort((a, b) => h(a) - h(b));
        for (let k = 1; k < order.length; k++) if (Math.abs(h(order[k]) - h(order[k - 1])) < 1e-6) throw new Error("Two profiles lie on the same plane: loft needs them one above another");
      }
      // The same profile picked twice counts once.
      order = order.filter((i, k) => k === 0 || JSON.stringify(f.sections[i]) !== JSON.stringify(f.sections[order[k - 1]]));
      if (order.length < 2) throw new Error("Pick at least two different profiles");
      const wires = order.map((i) => sourceWires(f.sections[i], ctx)[0]);
      let shape: Shape3D;
      try {
        shape = loft(wires, { ruled: f.ruled });
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
        const edges = refs.map((r) => resolveEdge(body, r));
        let result: Shape3D;
        try {
          result =
            f.type === "fillet"
              ? body.fillet(f.radius, (finder) => finder.inList(edges))
              : body.chamfer(f.radius, (finder) => finder.inList(edges));
        } catch (err) {
          if (err instanceof Error && !/WebAssembly|kernel/i.test(err.message)) throw err;
          const what = f.type === "fillet" ? "radius" : "distance";
          throw new Error(`That ${f.type} doesn't fit here - the ${what} is too big for the faces around ${edges.length > 1 ? "those edges" : "that edge"}. Try a smaller ${what}.`);
        }
        bodies.set(bodyId, result);
      }
      return;
    }

    case "shell": {
      const body = need(bodies, f.body);
      const faces = f.faces.map((r) => resolveFace(body, r));
      // A freeform: drop the picked cage faces and thicken the rest inward -
      // exact, where shelling its smooth surfaces is unreliable.
      const ff = ctx.freeforms.get(f.body);
      if (ff && faces.length) {
        bodies.set(f.body, shellFreeform(ff, faces, Math.abs(f.thickness)));
        ctx.freeforms.delete(f.body);
        return;
      }
      // Positive thickness shells inward (negative grows outward with rounded corners).
      const v0 = Math.abs(measureVolume(body));
      const hollowed = (s: Shape3D | null) => !!s && Math.abs(Math.abs(measureVolume(s)) - v0) > 1e-6 * v0;
      let out: Shape3D | null = null;
      try {
        out = body.shell(Math.abs(f.thickness), (finder) => finder.inList(faces));
      } catch {
        out = null;
      }
      // Many-faced shapes trip the one-step shell: hollow with an offset copy
      // of the body instead, then cut the openings through.
      if (!hollowed(out)) out = shellByOffset(body, faces, Math.abs(f.thickness));
      // OpenCascade can "succeed" without hollowing anything: say so.
      if (!hollowed(out)) throw new Error("Shell didn't work on this shape (try a smaller thickness)");
      bodies.set(f.body, out!);
      return;
    }

    case "boolean": {
      let target = need(bodies, f.target);
      const solidsIn = (x: Shape3D) => [...iterTopo(x.wrapped, "solid")].length;
      // Subtract: every tool at once - joined, then one tolerant cut checked by
      // its volume. Cut one by one, eight vents round a lamp shade left it with
      // no solid after the sixth, and the message blamed an "open surface".
      if (f.op === "subtract" && f.tools.length) {
        const tools = f.tools.map((t) => need(bodies, t));
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
        if (!f.keepTools) for (const t of f.tools) bodies.delete(t);
        // Kept as it was: the result is a body of its own.
        bodies.set(f.keepTarget ? f.id : f.target, out);
        return;
      }
      let open: number | undefined;
      for (const t of f.tools) {
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
      const half = halfSpace(f.plane, body);
      let a: Shape3D, b: Shape3D;
      try {
        a = body.intersect(half);
        b = body.cut(half);
      } catch {
        // Faces lying on the plane (a coil's end drawn on it) can stop the
        // plain split: the tolerant one treats them as on it.
        a = fuzzyBoolean("common", body, half);
        b = fuzzyBoolean("cut", body, half);
      }
      if (isEmpty(a) || isEmpty(b)) throw new Error("The plane doesn't cut through the body");
      bodies.set(f.body, b);
      bodies.set(f.id, a);
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
        shape = (f.format === "step" ? await importSTEP(blob) : readSTL(bytes)) as Shape3D;
        if (isEmpty(shape)) throw new Error("The file contains no solid geometry");
        importCache.set(f.data, shape);
      }
      bodies.set(f.id, shape);
      return;
    }

    case "delete":
      for (const b of f.bodies) bodies.delete(b);
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
      const face = resolveFace(body, f.face);
      bodies.set(f.face.body, threadFace(body, face, f.pitch, !!f.left));
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
      for (const r of f.faces) body = deleteFace(body, resolveFace(body, r));
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

/** The affine map of a move/scale/mirror step (null for patterns). */
function opAffine(op: Extract<Feature, { type: "transform" }>["op"]): Affine | null {
  const fromPoints = (f: (p: Vec3) => Vec3): Affine => {
    const o = f([0, 0, 0]);
    const cols = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((e) => sub(f(e as Vec3), o));
    return [0, 1, 2].flatMap((r) => [cols[0][r], cols[1][r], cols[2][r], o[r]]);
  };
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
  const { origin: c0, normal: n } = planeOf(face);
  const c = face.center.toTuple() as Vec3;
  const u = norm(sub(u0, scale(n, dot(u0, n))));
  const v = cross(n, u);
  void c0;
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
  for (const t of targets) out = replaceFacePlane(out, resolveFace(out, { body: "", center: t.sig.center, normal: t.sig.normal, area: t.sig.area }), t.plane);
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
 * A body of flat, straight-edged faces with some corners moved: every other
 * corner stays exactly where it is. A face whose corners no longer lie in one
 * plane keeps its unmoved part, and the moved corners get triangles (fanned
 * from the unmoved corner before them); coplanar pieces merge again after.
 */
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
  const ok = (r: Shape3D) => {
    const v = Math.abs(measureVolume(r));
    return Number.isFinite(v) && Math.abs(v0 - v - expect) < expect * 0.03;
  };
  // Where the thread starts round the face doesn't matter: if OpenCascade
  // trips on one start (a groove lining up with the face's seams), another
  // is tried.
  for (const phase of [0, 0.37, 0.71]) {
    const start = lo - pitch * (1 + phase);
    const turns = Math.ceil((hi - start) / pitch) + 1;
    // An exact helix (a line wound on a cylinder, not a fitted spline: those
    // drift over many turns and the sweep fails), through the groove's middle.
    const base = add(cy.c, scale(a, start));
    const helix = makeHelix(pitch, pitch * turns, (tip + mouth) / 2, base, a, left);
    const r0 = sub(helix.startPoint.toTuple() as Vec3, base);
    const ur = norm(sub(r0, scale(a, dot(r0, a))));
    const at = (rr: number, t: number): Vec3 => add(add(base, scale(a, t)), scale(ur, rr));
    const profile = makePolygon([at(mouth, -hm), at(tip, 0), at(mouth, hm)]).outerWire();
    let cut: Shape3D;
    try {
      cut = pipeAlong(profile, helix, a).intersect(slab);
    } catch {
      continue;
    }
    for (const fuzzy of [true, false]) {
      try {
        const res = fuzzy ? fuzzyBoolean("cut", body, cut) : body.cut(cut);
        if (ok(res)) return res;
      } catch {
        // the other way, or the next start
      }
    }
  }
  throw new Error("The thread couldn't be cut here - try a slightly different pitch");
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
          // It can come back as a closed shell: make that a solid.
          if (got.constructor.name === "Shell") got = makeSolid([got as never]);
          inner = got as Shape3D;
        }
        if (inner && Math.abs(measureVolume(inner)) > 0) break;
      } catch {
        inner = null;
      }
    }
    if (!inner) return null;
    let skin = body.cut(inner);
    for (const face of faces) {
      if (face.geomType !== "PLANE") return null;
      const n = norm(face.normalAt().toTuple() as Vec3);
      // The opening: the face's outline brought in by the wall thickness.
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

/** Faces (with their outward normal) for a profile or a body face. */
function sourceFaces(src: ExtrudeSource, ctx: Ctx): { face: Face; normal: Vec3 }[] {
  if (src.kind === "profile") {
    const sketch = ctx.sketches.get(src.sketch);
    if (!sketch) throw new Error("Its sketch was deleted");
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
    if (!sketch) throw new Error("Its sketch was deleted");
    return { origin: sketch.plane.origin, normal: norm(sketch.plane.normal) };
  }
  const face = resolveFace(need(ctx.bodies, src.face.body), src.face);
  return { origin: face.center.toTuple() as Vec3, normal: norm(face.normalAt().toTuple() as Vec3) };
}

function sourceWires(src: ExtrudeSource, ctx: Ctx): Wire[] {
  if (src.kind === "profile") {
    const sketch = ctx.sketches.get(src.sketch);
    if (!sketch) throw new Error("Its sketch was deleted");
    return src.regions.map((r) => regionWire(allCurves(sketch), sketch.plane, r));
  }
  return [resolveFace(need(ctx.bodies, src.face.body), src.face).outerWire()];
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
  const m = mode === "auto" ? (target ? (negative ? "cut" : "join") : "new") : mode;
  // Add or Cut picked, with no body named (drawn on the floor, not on a face):
  // it acts on what it runs into - Add on the body it touches, Cut on every
  // body it overlaps. (It used to make a separate body: a nave "added" to its
  // tower stood beside it as Body 2.)
  if (!target && m === "cut") {
    for (const hit of overlapping(solid, ctx)) {
      const t = ctx.bodies.get(hit)!;
      const out = fuzzyBoolean("cut", t, solid);
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
  let result = m === "join" ? fuzzyBoolean("fuse", t, solid) : m === "cut" ? fuzzyBoolean("cut", t, solid) : t;
  if (m === "join" || m === "cut") {
    // OpenCascade can get a boolean wrong without saying so (a thread only just
    // overlapping the core it's joined to): its volume then can't be right.
    const ok = (r: Shape3D) => booleanVolumeOk(m === "join" ? "fuse" : "cut", t, solid, r);
    if (!ok(result)) {
      const plain = m === "join" ? t.fuse(solid) : t.cut(solid);
      if (!ok(plain)) throw new Error(m === "join" ? "Joining these didn't work out - the shapes only just overlap here: let them overlap more" : "This cut didn't work out - the shapes only just overlap here: let them overlap more, or less");
      result = plain;
    }
  }
  if (isEmpty(result)) ctx.bodies.delete(target);
  else ctx.bodies.set(target, result);
}

/**
 * Can this be the volume of a ∪ b (or a − b)? A union is at least the bigger
 * of the two and at most both together; a cut is at most a and at least a − b.
 */
function booleanVolumeOk(op: "fuse" | "cut", a: Shape3D, b: Shape3D, r: Shape3D): boolean {
  try {
    const va = Math.abs(measureVolume(a));
    const vb = Math.abs(measureVolume(b));
    const v = isEmpty(r) ? 0 : measureVolume(r);
    // A big many-faced body measures a little differently once a join splits
    // its faces (a jet engine's casing: 2 to 75 mm³ in 1.9 litres) - more than
    // the name raised on its pylon (158 mm³) could stand under a closer check.
    // A boolean gone wrong is off by about the smaller shape, or more.
    const tol = (va + vb) * 1e-5 + Math.min(va, vb) * 0.6 + 1e-9;
    if (!Number.isFinite(v) || v < -tol) return false;
    return op === "fuse" ? v >= Math.max(va, vb) - tol && v <= va + vb + tol : v <= va + tol && v >= va - vb - tol;
  } catch {
    return true; // can't tell: leave it to the usual checks
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
  try {
    args.Append(a.wrapped);
    tools.Append(b.wrapped);
    algo.SetArguments(args);
    algo.SetTools(tools);
    algo.SetFuzzyValue(tol);
    // (Never adjusting a or b: they're earlier steps' results.)
    algo.SetNonDestructive(true);
    algo.Build(new oc.Message_ProgressRange());
    if (!algo.IsDone()) throw new Error("boolean failed");
    const out = cast(algo.Shape()) as Shape3D;
    // Fuse and cut keep their faces tidy like the usual booleans do.
    return op === "common" ? out : (unify(out, Math.max(sizeOf(a), sizeOf(b))) as Shape3D);
  } catch {
    return op === "cut" ? a.cut(b) : op === "fuse" ? a.fuse(b) : a.intersect(b);
  } finally {
    algo.delete();
    args.delete();
    tools.delete();
  }
}

/** Bodies (other than `skip`) that `solid` really overlaps (not just touches). */
function overlapping(solid: Shape3D, ctx: Ctx, skip?: string): string[] {
  const sb = solid.boundingBox;
  const vs = Math.abs(measureVolume(solid));
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
      if (!isEmpty(common) && Math.abs(measureVolume(common)) > Math.max(1e-9, Math.min(vs, Math.abs(measureVolume(body))) * 1e-6)) out.push(id);
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
        if (!ff) throw new Error("Stretching along X/Y/Z works on freeform bodies only - the geometry engine can't stretch other bodies (use uniform Scale)");
        results.push(freeformShape(ff.feature, affineThen(ff.m, scaleAbout(op.center, op.factors))));
        break;
      }
      case "mirror":
        results.push(body.clone().mirror(op.plane.normal, op.plane.origin));
        break;
      case "linear":
        for (let k = 1; k < op.count; k++) results.push(body.clone().translate(scale(norm(op.dir), op.spacing * k)));
        break;
      case "circular": {
        const ax = resolveAxis(op.axis, ctx);
        const full = Math.abs(Math.abs(op.angle) - 360) < 1e-6;
        const step = op.angle / (full ? op.count : Math.max(1, op.count - 1));
        for (let k = 1; k < op.count; k++) results.push(body.clone().rotate(step * k, ax.origin, ax.dir));
        break;
      }
    }
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
function followFace(f: SketchFeature, bodies: Bodies): PlaneDef {
  const ref = f.attachedTo!;
  const body = bodies.get(ref.body);
  if (!body) return f.plane;
  const face = resolveFace(body, ref);
  const n = norm(face.normalAt().toTuple() as Vec3);
  const c = face.center.toTuple() as Vec3;
  const offset = dot(n, sub(c, f.plane.origin));
  const origin = add(f.plane.origin, scale(n, offset));
  return dot(n, f.plane.normal) > 0.999 ? { ...f.plane, origin } : { origin, normal: n, xDir: xDirFor(n) };
}

// ----------------------------------------------------- geometric references

function faceInfo(face: Face): FaceInfo {
  const center = face.center.toTuple() as Vec3;
  const normal = norm(face.normalAt().toTuple() as Vec3);
  const info: FaceInfo = { center, normal, area: measureArea(face), type: face.geomType };
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

/** Best-matching face for a stored signature (survives upstream edits). */
function resolveFace(body: Shape3D, ref: FaceRef): Face {
  const size = Math.sqrt(ref.area) || 1;
  let best: { face: Face; score: number } | null = null;
  for (const face of body.faces) {
    const fi = faceInfo(face);
    const align = dot(fi.normal, ref.normal);
    if (align < 0.5) continue;
    const score = dist(fi.center, ref.center) / size + (1 - align) * 4 + Math.abs(Math.log((fi.area + 1e-9) / (ref.area + 1e-9)));
    if (!best || score < best.score) best = { face, score };
  }
  if (!best) throw new Error("The face it was built on no longer exists");
  return best.face;
}

function resolveEdge(body: Shape3D, ref: EdgeRef): Edge {
  const size = ref.length || 1;
  let best: { edge: Edge; score: number } | null = null;
  for (const edge of body.edges) {
    const ei = edgeInfo(edge);
    const align = Math.abs(dot(ei.dir, ref.dir));
    const score = dist(ei.mid, ref.mid) / size + (1 - align) * 2 + Math.abs(Math.log((ei.length + 1e-9) / (ref.length + 1e-9)));
    if (!best || score < best.score) best = { edge, score };
  }
  if (!best || best.score > 3) throw new Error("An edge it was built on no longer exists");
  return best.edge;
}

// ------------------------------------------------------------------- meshing

function meshBody(id: string, name: string, shape: Shape3D): BodyMesh {
  const cached = meshCache.get(shape);
  if (cached) return { ...cached, id, name };
  const bb = shape.boundingBox;
  const diag = Math.hypot(bb.width, bb.height, bb.depth) || 1;
  const tolerance = Math.min(0.1, Math.max(0.001, diag * 0.0008));
  const angularTolerance = 0.25;
  const m = shape.mesh({ tolerance, angularTolerance });
  const e = shape.meshEdges({ tolerance, angularTolerance });
  // Group order matches shape.faces / shape.edges order (verified); ids are hashes.
  const mesh: BodyMesh = {
    id,
    name,
    positions: new Float32Array(m.vertices),
    normals: new Float32Array(m.normals),
    indices: new Uint32Array(m.triangles),
    faceGroups: m.faceGroups.map((g, i) => ({ start: g.start, count: g.count, face: i })),
    edgePositions: new Float32Array(e.lines),
    edgeGroups: e.edgeGroups.map((g, i) => ({ start: g.start, count: g.count, edge: i })),
    faces: shape.faces.map(faceInfo),
    edges: shape.edges.map(edgeInfo),
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
function touchedBodies(f: Feature, ctx: Ctx): string[] {
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
  if ((f.type === "extrude" || f.type === "revolve" || f.type === "sweep" || f.type === "loft") && mode && mode !== "new") for (const id of ctx.bodies.keys()) named.add(id);
  return [...named].filter((id) => ctx.bodies.has(id));
}

/** Edits that change a solid in place (their results are checked). */
const GUARDED = new Set<string>(["extrude", "revolve", "sweep", "loft", "boolean", "fillet", "chamfer", "shell", "moveFace", "scaleFace", "replaceFace", "deleteGeom", "split"]);
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
  const v0 = before ? Math.abs(measureVolume(before)) : 0;
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
  const signed = solids.map((x) => measureVolume(cast(x) as Shape3D));
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
  if (measureVolume(after) < 0) {
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
 * An STL file as a body. OpenCascade's reader hands back a compound holding
 * the mesh's shell (replicad's importSTL wanted the shell itself and threw on
 * every file - the app's own STL exports too). One closed shell: a solid, its
 * flat triangles merged; anything else stays loose faces for Repair to close.
 */
function readSTL(bytes: Uint8Array): Shape3D {
  const oc = getOC();
  const name = `stl-${Math.random().toString(36).slice(2)}.stl`;
  oc.FS.writeFile(`/${name}`, bytes);
  const reader = new oc.StlAPI_Reader();
  const read = new oc.TopoDS_Shell();
  try {
    if (!reader.Read(read, name)) throw new Error("This STL file couldn't be read");
    const shells = [...iterTopo(read, "shell")];
    if (shells.length === 1) {
      try {
        const unify = new oc.ShapeUpgrade_UnifySameDomain(shells[0], true, true, false);
        unify.Build();
        const merged = unify.Shape();
        unify.delete();
        const mk = new oc.BRepBuilderAPI_MakeSolid();
        for (const sh of iterTopo(merged, "shell")) mk.Add(oc.TopoDS.Shell(sh));
        const solid = cast(mk.Solid()) as Shape3D;
        mk.delete();
        let v = measureVolume(solid);
        if (v < 0) {
          oc.BRepLib.OrientClosedSolid(solid.wrapped);
          v = measureVolume(solid);
        }
        if (v > 0 && !openEdges(solid).length) return solid;
      } catch {
        // fall through: loose faces
      }
    }
    return cast(read) as Shape3D;
  } finally {
    oc.FS.unlink(`/${name}`);
    reader.delete();
  }
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
  if (err instanceof Error) return err.message;
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
        fn = norm(f.normalAt(f.pointOnSurface(u, w)).toTuple() as Vec3);
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
