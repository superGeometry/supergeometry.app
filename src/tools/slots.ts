// Reusable pick slots: axis, plane, direction, path, faces, profiles.

import type { AxisRef, EdgeRef, ExtrudeSource, FaceRef, PathRef, PlaneDef, SketchFeature, Vec3 } from "../doc/types";
import { norm, sub, toWorld } from "../geom";
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
    presets: WORLD_AXES.map((a) => ({ label: a.label, apply: () => ((name = `${a.label} axis`), (shown = null), set({ origin: [0, 0, 0], dir: a.dir })) })),
    shows: () => (shown ? [shown] : []),
    accept(hit) {
      if (hit.kind === "curve") {
        const s = app.store.find<SketchFeature>(hit.sketch);
        const e = s?.entities.find((x) => x.id === hit.entity);
        const plane = app.sketchPlane(hit.sketch);
        if (!s || !plane || e?.kind !== "line") return false;
        const a = toWorld(plane, e.a);
        set({ origin: a, dir: norm(sub(toWorld(plane, e.b), a)), ref: { kind: "sketchLine", sketch: s.id, entity: e.id } });
        name = "Sketch line";
      } else if (hit.kind === "edge") {
        const info = app.view.body(hit.body)?.edges[hit.edge];
        if (!info || info.type !== "LINE") return false;
        set({ origin: info.start, dir: info.dir });
        name = "Edge";
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
    presets: ["XY", "XZ", "YZ"].map((id) => ({ label: id, apply: () => ((name = `${id} plane`), (shown = null), set(app.view.planeOf(id)!)) })),
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
        } else set({ kind: "sketch", sketch: hit.sketch, entities: [hit.entity] });
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
