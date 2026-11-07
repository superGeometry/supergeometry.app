// Reusable pick slots: axis, plane, direction, path, faces, profiles.

import type { AxisFeature, AxisRef, EdgeRef, ExtrudeSource, FaceRef, PathRef, PlaneDef, SketchFeature, Vec3 } from "../doc/types";
import { cross, dot, len, norm, scale, sub, add, toPlane, toWorld } from "../geom";
import { closestOnPrim, entityPrims } from "../sketch/curves";
import { explode } from "../sketch/edit";
import { arrangement, regionRef } from "../sketch/regions";
import { Vector3 } from "three";
import type { Slot } from "./featureOp";
import { edgeRefOf, faceRefOf, type AppContext, type Sel } from "./tool";

const WORLD_AXES: { label: string; dir: Vec3 }[] = [
  { label: "X", dir: [1, 0, 0] },
  { label: "Y", dir: [0, 1, 0] },
  { label: "Z", dir: [0, 0, 1] },
];

export function axisSlot(app: AppContext, label: string, get: () => AxisRef | null, set: (a: AxisRef) => void): Slot {
  let shown: Sel | null = null;
  let name = "";
  return {
    label,
    describe: () => (get() ? name || "Axis" : "Tap a line, edge or axis"),
    filled: () => !!get(),
    pick: { profiles: false, curves: true, planes: false, axes: true, worldAxes: true },
    presets: [
      ...WORLD_AXES.map((a) => ({ label: a.label, apply: () => ((name = `${a.label} axis`), (shown = null), set({ origin: [0, 0, 0], dir: a.dir })) })),
      // The project's own axes, by name: a thin dashed line far off is hard to
      // tap (a fan's axis tap caught the yoke's edge in front of it).
      ...app.store.features
        .filter((f): f is AxisFeature => f.type === "axis" && !f.suppressed)
        .map((f) => ({ label: f.name, apply: () => ((name = f.name), (shown = { kind: "axis", id: f.id } as Sel), set({ origin: f.origin, dir: f.dir, ref: { kind: "axis" as const, feature: f.id } })) })),
    ],
    shows: () => (shown ? [shown] : []),
    accept(hit) {
      if (hit.kind === "curve") {
        const s = app.store.find<SketchFeature>(hit.sketch);
        const e = s?.entities.find((x) => x.id === hit.entity);
        const plane = app.sketchPlane(hit.sketch);
        if (!s || !plane || !e) return false;
        if (e.kind === "line") {
          const a = toWorld(plane, e.a);
          set({ origin: a, dir: norm(sub(toWorld(plane, e.b), a)), ref: { kind: "sketchLine", sketch: s.id, entity: e.id } });
          name = "Sketch line";
        } else if ((e.kind === "rect" || e.kind === "polygon" || e.kind === "polyline") && hit.point) {
          // The side of a shape that was tapped (a profile drawn against the axis).
          const at = toPlane(plane, hit.point);
          const side = explode(e).reduce((m, x) => (closestOnPrim(entityPrims(x)[0], at).d < closestOnPrim(entityPrims(m)[0], at).d ? x : m));
          if (side.kind !== "line") return false;
          const a = toWorld(plane, side.a);
          set({ origin: a, dir: norm(sub(toWorld(plane, side.b), a)) });
          name = "Side of the shape";
        } else return false;
      } else if (hit.kind === "edge") {
        const info = app.view.body(hit.body)?.edges[hit.edge];
        if (!info) return false;
        if (info.type === "LINE") {
          set({ origin: info.start, dir: info.dir });
          name = "Edge";
        } else if (info.type === "CIRCLE") {
          // A round edge: the line through its centre, square to it — what a
          // circular pattern round a lamp shade or a flange turns about.
          const ax = circleAxis(info.start, info.mid, info.end, info.dir);
          if (!ax) return false;
          set(ax);
          name = "Centre of round edge";
        } else return false;
      } else if (hit.kind === "axis") {
        const ax = app.view.axisOf(hit.id);
        if (!ax) return false;
        // World axes don't move; construction axes are followed by reference.
        const world = ["X", "Y", "Z"].includes(hit.id);
        set({ origin: ax.plane.origin, dir: ax.plane.normal, ...(world ? {} : { ref: { kind: "axis" as const, feature: hit.id } }) });
        name = ax.name;
      } else return false;
      shown = { ...hit } as Sel;
      delete (shown as { point?: unknown }).point;
      return true;
    },
  };
}

export function planeSlot(app: AppContext, label: string, get: () => PlaneDef | null, set: (p: PlaneDef, face?: FaceRef) => void): Slot {
  let shown: Sel | null = null;
  let name = "";
  return {
    label,
    describe: () => (get() ? name || "Plane" : "Tap a plane or flat face"),
    originPlanes: true,
    rejectHint: "Tap a flat face or a plane (or pick XY / XZ / YZ)",
    filled: () => !!get(),
    pick: { profiles: false, edges: false, planes: true },
    // The project's own planes by name too (Replace Face onto a plane 320 up:
    // a thin sheet among the bodies, easy to miss with a finger).
    presets: [
      ...["XY", "XZ", "YZ"].map((id) => ({ label: id, apply: () => ((name = `${id} plane`), (shown = null), set(app.view.planeOf(id)!)) })),
      ...app.view.construction.planes.map((c) => ({ label: c.name, apply: () => ((name = c.name), (shown = null), set(c.plane)) })),
    ],
    shows: () => (shown ? [shown] : []),
    accept(hit) {
      if (hit.kind === "plane") {
        const p = app.view.planeOf(hit.id);
        if (!p) return false;
        set(p);
        name = ["XY", "XZ", "YZ"].includes(hit.id) ? `${hit.id} plane` : "Plane";
        shown = { kind: "plane", id: hit.id };
        return true;
      }
      if (hit.kind === "face") {
        const info = app.view.body(hit.body)?.faces[hit.face];
        if (!info?.plane) return false;
        set(info.plane, faceRefOf(app, hit) ?? undefined);
        name = "Face";
        shown = { kind: "face", body: hit.body, face: hit.face };
        return true;
      }
      return false;
    },
  };
}

/** A direction: an edge, an axis, a face normal, or X/Y/Z. */
export function directionSlot(app: AppContext, label: string, get: () => Vec3 | null, set: (d: Vec3) => void): Slot {
  let shown: Sel | null = null;
  let name = "";
  return {
    label,
    describe: () => (get() ? name || "Direction" : "Tap an edge, axis or face"),
    filled: () => !!get(),
    pick: { profiles: false, planes: false, axes: true, worldAxes: true },
    presets: WORLD_AXES.map((a) => ({ label: a.label, apply: () => ((name = a.label), (shown = null), set(a.dir)) })),
    shows: () => (shown ? [shown] : []),
    accept(hit) {
      if (hit.kind === "edge") {
        const info = app.view.body(hit.body)?.edges[hit.edge];
        if (!info) return false;
        set(info.dir);
        name = "Edge";
        shown = { kind: "edge", body: hit.body, edge: hit.edge };
      } else if (hit.kind === "face") {
        const info = app.view.body(hit.body)?.faces[hit.face];
        if (!info) return false;
        set(info.normal);
        name = "Face normal";
        shown = { kind: "face", body: hit.body, face: hit.face };
      } else if (hit.kind === "axis") {
        const ax = app.view.axisOf(hit.id);
        if (!ax) return false;
        set(ax.plane.normal);
        name = ax.name;
        shown = { kind: "axis", id: hit.id };
      } else return false;
      return true;
    },
  };
}

/** Sweep path: sketch curves (one sketch) or body edges. */
export function pathSlot(app: AppContext, get: () => PathRef | null, set: (p: PathRef) => void): Slot {
  return {
    label: "Path",
    multi: true,
    describe: () => {
      const p = get();
      if (!p) return "Tap curves or edges";
      return p.kind === "sketch" ? `${p.entities.length} curve${p.entities.length > 1 ? "s" : ""}` : `${p.edges.length} edge${p.edges.length > 1 ? "s" : ""}`;
    },
    filled: () => !!get(),
    pick: { profiles: false, curves: true, planes: false, axes: false },
    shows: () => {
      const p = get();
      if (!p) return [];
      if (p.kind === "sketch") return p.entities.map((entity) => ({ kind: "curve", sketch: p.sketch, entity }) as Sel);
      return [];
    },
    accept(hit) {
      const p = get();
      if (hit.kind === "curve") {
        if (p?.kind === "sketch" && p.sketch === hit.sketch) {
          const has = p.entities.includes(hit.entity);
          set({ ...p, entities: has ? p.entities.filter((e) => e !== hit.entity) : [...p.entities, hit.entity] });
        } else {
          // The first tap takes the whole run the curve is part of (a stem
          // drawn as line, arc, line: one tap, not three — the short pieces
          // are hard to hit with a finger). Tapping a piece again drops it.
          const ents = app.store.find<SketchFeature>(hit.sketch)?.entities ?? [];
          const run = chainThrough(ents, hit.entity);
          set({ kind: "sketch", sketch: hit.sketch, entities: run });
          if (run.length > 1) app.ui.toast(`${run.length} joined curves — tap one to leave it out`);
        }
        return true;
      }
      if (hit.kind === "edge") {
        const ref = edgeRefOf(app, hit);
        if (!ref) return false;
        const edges: EdgeRef[] = p?.kind === "edges" ? [...p.edges, ref] : [ref];
        set({ kind: "edges", edges });
        return true;
      }
      return false;
    },
  };
}

/** Faces of one body (e.g. faces to open in Shell). */
export function facesSlot(app: AppContext, label: string, get: () => FaceRef[], set: (f: FaceRef[]) => void, optional = false): Slot {
  const picked: Sel[] = [];
  return {
    label,
    multi: true,
    describe: () => (get().length ? `${get().length} face${get().length > 1 ? "s" : ""}` : optional ? "None (closed)" : "Tap faces"),
    filled: () => optional || get().length > 0,
    pick: { profiles: false, edges: false, planes: false, axes: false },
    shows: () => picked,
    // Start the list over: an open face isn't there to be tapped again (when
    // editing a shell, a wrong one couldn't be taken out).
    get presets() {
      return get().length ? [{ label: "Clear", apply: () => ((picked.length = 0), set([])) }] : [];
    },
    accept(hit) {
      if (hit.kind !== "face") return false;
      const ref = faceRefOf(app, hit);
      if (!ref) return false;
      const i = picked.findIndex((s) => s.kind === "face" && s.body === hit.body && s.face === hit.face);
      if (i >= 0) {
        picked.splice(i, 1);
        set(get().filter((_, k) => k !== i));
      } else {
        picked.push({ kind: "face", body: hit.body, face: hit.face });
        set([...get(), ref]);
      }
      return true;
    },
  };
}

/** Profiles / flat faces for loft sections. */
export function sectionsSlot(app: AppContext, get: () => ExtrudeSource[], set: (s: ExtrudeSource[]) => void, initial: Sel[]): Slot {
  const picked: Sel[] = [...initial];
  return {
    label: "Profiles",
    multi: true,
    describe: () => `${get().length} picked${get().length < 2 ? " — tap more" : ""}`,
    filled: () => get().length >= 2,
    pick: { edges: false, planes: false, axes: false },
    shows: () => picked,
    accept(hit) {
      if (hit.kind === "profile") {
        const r = arrangement(app.sketchCurves(hit.sketch)).regions[hit.region];
        if (!r) return false;
        // Tapped again: take it back out.
        const i = picked.findIndex((p) => p.kind === "profile" && p.sketch === hit.sketch && p.region === hit.region);
        const ref = regionRef(r);
        if (i >= 0) {
          picked.splice(i, 1);
          set(get().filter((s) => !(s.kind === "profile" && s.sketch === hit.sketch && s.regions.length === 1 && Math.hypot(s.regions[0].c[0] - ref.c[0], s.regions[0].c[1] - ref.c[1]) < 1e-6)));
          return true;
        }
        picked.push({ kind: "profile", sketch: hit.sketch, region: hit.region });
        set([...get(), { kind: "profile", sketch: hit.sketch, regions: [ref] }]);
        return true;
      }
      if (hit.kind === "face") {
        const ref = faceRefOf(app, hit);
        if (!ref || !app.view.body(hit.body)?.faces[hit.face]?.plane) return false;
        const i = picked.findIndex((p) => p.kind === "face" && p.body === hit.body && p.face === hit.face);
        if (i >= 0) {
          picked.splice(i, 1);
          set(get().filter((s) => !(s.kind === "face" && s.face.body === ref.body && Math.hypot(...(sub3(s.face.center, ref.center) as [number, number, number])) < 1e-6)));
          return true;
        }
        picked.push({ kind: "face", body: hit.body, face: hit.face });
        set([...get(), { kind: "face", face: ref }]);
        return true;
      }
      return false;
    },
  };
}

const sub3 = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/**
 * A point: a corner, a point on an edge (its ends and middle snap), a face
 * (its centre snaps), a sketch point or curve, or a plane.
 */
export function pointSlot(app: AppContext, label: string, get: () => Vec3 | null, set: (p: Vec3) => void): Slot {
  let shown: Sel | null = null;
  return {
    label,
    describe: () => {
      const p = get();
      return p ? p.map((v) => Math.round(v * 1000) / 1000).join(", ") : "Tap a corner, edge, face or point";
    },
    filled: () => !!get(),
    pick: { profiles: false, curves: true, planes: true },
    shows: () => (shown ? [shown] : []),
    accept(hit) {
      let at: Vec3 | null = "point" in hit ? hit.point : null;
      if (!at) return false;
      // Snap to the obvious points when close on screen.
      const near = (q: Vec3) => {
        const a = app.view.toScreen(new Vector3(...q));
        const b = app.view.toScreen(new Vector3(...at!));
        return !!a && !!b && Math.hypot(a[0] - b[0], a[1] - b[1]) < 16;
      };
      if (hit.kind === "vertex") {
        at = app.view.vertexOf(hit.body, hit.vertex) ?? at;
        shown = { kind: "vertex", body: hit.body, vertex: hit.vertex };
      } else if (hit.kind === "edge") {
        const e = app.view.body(hit.body)?.edges[hit.edge];
        const snap = e && [e.start, e.end, e.mid].find(near);
        if (snap) at = snap;
        shown = { kind: "edge", body: hit.body, edge: hit.edge };
      } else if (hit.kind === "face") {
        const f = app.view.body(hit.body)?.faces[hit.face];
        if (f?.plane && near(f.center)) at = f.center;
        shown = { kind: "face", body: hit.body, face: hit.face };
      } else shown = null;
      set(at);
      return true;
    },
  };
}

type Ent = SketchFeature["entities"][number];

/** The two ends of an open curve (null for closed shapes). */
function endsOf(e: Ent): [[number, number], [number, number]] | null {
  if (e.kind === "line" || e.kind === "arc") return [e.a as [number, number], e.b as [number, number]];
  if (e.kind === "spline" && !e.closed && e.points.length > 1) return [e.points[0] as [number, number], e.points[e.points.length - 1] as [number, number]];
  if (e.kind === "polyline" && !e.closed && e.points.length > 1) return [e.points[0] as [number, number], e.points[e.points.length - 1] as [number, number]];
  return null;
}

/**
 * The curves joined end to end with `id`, in order along the run — stopping
 * where three or more curves meet (a branch: which way would it go?).
 */
export function chainThrough(entities: Ent[], id: string): string[] {
  const open = entities.filter((e) => !e.construction && endsOf(e));
  const key = (p: [number, number]) => `${Math.round(p[0] * 1e4)},${Math.round(p[1] * 1e4)}`;
  const at = new Map<string, string[]>();
  for (const e of open) for (const p of endsOf(e)!) at.set(key(p), [...(at.get(key(p)) ?? []), e.id]);
  const byId = new Map(open.map((e) => [e.id, e]));
  if (!byId.has(id)) return [id];
  const used = new Set([id]);
  const walk = (from: [number, number]): string[] => {
    const out: string[] = [];
    let p = from;
    for (;;) {
      const there = at.get(key(p)) ?? [];
      if (there.length !== 2) break;
      const next = there.find((x) => !used.has(x));
      if (!next) break;
      used.add(next);
      out.push(next);
      const [a, b] = endsOf(byId.get(next)!)!;
      p = key(a) === key(p) ? b : a;
    }
    return out;
  };
  const [a, b] = endsOf(byId.get(id)!)!;
  const back = walk(a);
  const ahead = walk(b);
  return [...back.reverse(), id, ...ahead];
}

/** The axis of a circle or arc through three of its points (`tangent` at `mid`, for a full circle). */
export function circleAxis(start: Vec3, mid: Vec3, end: Vec3, tangent: Vec3): AxisRef | null {
  const full = len(sub(start, end)) < 1e-6;
  if (full) {
    const c = scale(add(start, mid), 0.5);
    const n = cross(sub(mid, c), tangent);
    return len(n) < 1e-12 ? null : { origin: c, dir: norm(n) };
  }
  // Circumcentre of start, mid, end.
  const a = sub(start, mid);
  const b = sub(end, mid);
  const n = cross(a, b);
  const nn = dot(n, n);
  if (nn < 1e-18) return null;
  const c = add(mid, scale(add(scale(cross(n, a), dot(b, b)), scale(cross(b, n), dot(a, a))), 1 / (2 * nn)));
  return { origin: c, dir: norm(n) };
}
