import type { DocStore } from "../doc/store";
import type { EdgeRef, ExtrudeSource, FaceRef, Feature, PinDef, PlaneDef, SketchEntity, SketchFeature, Vec3 } from "../doc/types";
import type { KernelClient } from "../kernel/client";
import type { RegenResult } from "../kernel/protocol";
import { arrangement, regionRef } from "../sketch/regions";
import type { ToolItem, UI } from "../ui/ui";
import type { PointerHandler } from "../view/input";
import type { Highlight, PickHit, Viewport } from "../view/viewport";

/** Something selected in the viewport. Same shape as a highlight. */
export type Sel = Highlight;

export interface Tool extends PointerHandler {
  readonly id: string;
  /** Sketch being edited, so the viewport can draw it as active. */
  readonly activeSketch?: string;
  /** Feature being created/edited (highlighted in History). */
  readonly editingId?: string;
  enter?(): void;
  exit?(): void;
  /** Return true when the key was handled. */
  key?(e: KeyboardEvent): boolean;
  /** Keys typed while a drag is held (type an exact value; Enter finishes). */
  dragKey?(e: KeyboardEvent): boolean;
  /** Called after every regeneration (committed or preview). */
  refresh?(): void;
}

export interface AppContext {
  readonly store: DocStore;
  readonly kernel: KernelClient;
  readonly view: Viewport;
  readonly ui: UI;
  readonly result: RegenResult | null;
  readonly selection: Sel[];
  setSelection(sel: Sel[]): void;
  setHover(h: Sel | null): void;
  /** null returns to the selection tool. */
  setTool(tool: Tool | null): void;
  /** Show the model as if `features` were the document (live preview). */
  preview(features: Feature[]): Promise<RegenResult | null>;
  /** Current plane of a sketch (sketches on faces follow the face). */
  sketchPlane(id: string): PlaneDef | undefined;
  /** A sketch's curves plus the outline of the face it sits on (what regions are made of). */
  sketchCurves(id: string): SketchEntity[];
  mainTools(): ToolItem[];
  bottomTools(): ToolItem[];
  /** Pin a measurement in 3D (saved with the project). */
  addPin(pin: PinDef): void;
  /** Bodies shown alone, or null when nothing is isolated. */
  readonly isolated: string[] | null;
  isolate(bodies: string[] | null): void;
}

/** Index of the body face matching a stored reference (by centre and normal). */
export function faceIndexOf(app: AppContext, ref: FaceRef): number | null {
  const faces = app.view.body(ref.body)?.faces ?? [];
  let best: { i: number; d: number } | null = null;
  faces.forEach((f, i) => {
    const align = f.normal[0] * ref.normal[0] + f.normal[1] * ref.normal[1] + f.normal[2] * ref.normal[2];
    if (align < 0.99) return;
    const d = Math.hypot(f.center[0] - ref.center[0], f.center[1] - ref.center[1], f.center[2] - ref.center[2]);
    if (!best || d < best.d) best = { i, d };
  });
  return best ? (best as { i: number }).i : null;
}

/**
 * The nearest parallel face of the same body facing the other way, behind a
 * flat face: "total" thickness for push/pull (like the distance to the bottom).
 */
export function oppositeFace(app: AppContext, body: string, face: number): { distance: number; point: Vec3 } | null {
  const b = app.view.body(body);
  const f = b?.faces[face];
  if (!b || !f?.plane) return null;
  let best: number | null = null;
  for (const g of b.faces) {
    if (!g.plane) continue;
    const d = f.normal[0] * g.normal[0] + f.normal[1] * g.normal[1] + f.normal[2] * g.normal[2];
    if (d > -0.999) continue;
    const t = f.normal[0] * (f.center[0] - g.center[0]) + f.normal[1] * (f.center[1] - g.center[1]) + f.normal[2] * (f.center[2] - g.center[2]);
    if (t > 1e-9 && (best === null || t < best)) best = t;
  }
  if (best === null) return null;
  return { distance: best, point: [f.center[0] - f.normal[0] * best, f.center[1] - f.normal[1] * best, f.center[2] - f.normal[2] * best] };
}

export function sameSel(a: Sel, b: Sel): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function hitToSel(h: PickHit | null): Sel | null {
  if (!h) return null;
  const { point: _p, ...rest } = h;
  return rest as Sel;
}

// -------------------------------------------------- selection → references

export function faceRefOf(app: AppContext, s: { body: string; face: number }): FaceRef | null {
  const info = app.view.body(s.body)?.faces[s.face];
  return info ? { body: s.body, center: info.center, normal: info.normal, area: info.area } : null;
}

export function edgeRefOf(app: AppContext, s: { body: string; edge: number }): EdgeRef | null {
  const info = app.view.body(s.body)?.edges[s.edge];
  return info ? { body: s.body, mid: info.mid, dir: info.dir, length: info.length } : null;
}

/** A selected profile or flat face as something extrude/revolve/… can use. */
export function sourcesOf(app: AppContext, sel: Sel[]): ExtrudeSource[] {
  const out: ExtrudeSource[] = [];
  const bySketch = new Map<string, number[]>();
  for (const s of sel) {
    if (s.kind === "profile") bySketch.set(s.sketch, [...(bySketch.get(s.sketch) ?? []), s.region]);
    if (s.kind === "face") {
      const f = faceRefOf(app, s);
      if (f) out.push({ kind: "face", face: f });
    }
  }
  for (const [sketch, idx] of bySketch) {
    if (!app.store.find<SketchFeature>(sketch)) continue;
    const regions = arrangement(app.sketchCurves(sketch)).regions;
    out.unshift({ kind: "profile", sketch, regions: idx.map((i) => regions[i]).filter(Boolean).map(regionRef) });
  }
  return out;
}

/**
 * A point on a curved face (its centre is off the face — on a cylinder's axis)
 * and the normal there: the mesh vertex nearest the centre on the side facing the viewer.
 */
export function faceAnchor(app: AppContext, body: string, face: number): { base: Vec3; normal: Vec3 } | null {
  const b = app.view.body(body);
  const g = b?.faceGroups.find((x) => x.face === face);
  const info = b?.faces[face];
  if (!b || !g || !info) return null;
  const view = app.view.cam.viewDir().toArray() as Vec3;
  let best: { base: Vec3; normal: Vec3; score: number } | null = null;
  // The way out of the material, from each triangle's winding (the stored
  // vertex normals point the wrong way on faces OpenCascade keeps reversed,
  // e.g. a hole's wall — the arrow then pointed into the material).
  const P = (i: number): Vec3 => {
    const v = b.indices[i] * 3;
    return [b.positions[v], b.positions[v + 1], b.positions[v + 2]];
  };
  for (let i = g.start; i + 2 < g.start + g.count; i += 3) {
    const [a, c, e] = [P(i), P(i + 1), P(i + 2)];
    const u: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const w: Vec3 = [e[0] - a[0], e[1] - a[1], e[2] - a[2]];
    const cr: Vec3 = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const L = Math.hypot(...cr);
    if (L < 1e-12) continue;
    const n: Vec3 = [cr[0] / L, cr[1] / L, cr[2] / L];
    const p: Vec3 = [(a[0] + c[0] + e[0]) / 3, (a[1] + c[1] + e[1]) / 3, (a[2] + c[2] + e[2]) / 3];
    const facing = n[0] * view[0] + n[1] * view[1] + n[2] * view[2];
    const d = Math.hypot(p[0] - info.center[0], p[1] - info.center[1], p[2] - info.center[2]);
    const score = d + (facing > 0 ? 1e6 : 0);
    if (!best || score < best.score) best = { base: p, normal: n, score };
  }
  return best && { base: best.base, normal: best.normal };
}

/** Point + normal of a source, for placing handles. */
export function sourceFrame(app: AppContext, src: ExtrudeSource): { base: Vec3; normal: Vec3 } {
  if (src.kind === "face") {
    const k = faceIndexOf(app, src.face);
    const info = k !== null ? app.view.body(src.face.body)?.faces[k] : undefined;
    if (k !== null && info && !info.plane) return faceAnchor(app, src.face.body, k) ?? { base: src.face.center, normal: src.face.normal };
    return { base: src.face.center, normal: src.face.normal };
  }
  const plane = app.sketchPlane(src.sketch);
  if (!plane) return { base: [0, 0, 0], normal: [0, 0, 1] };
  const c = src.regions[0]?.c ?? [0, 0];
  const y: Vec3 = [
    plane.normal[1] * plane.xDir[2] - plane.normal[2] * plane.xDir[1],
    plane.normal[2] * plane.xDir[0] - plane.normal[0] * plane.xDir[2],
    plane.normal[0] * plane.xDir[1] - plane.normal[1] * plane.xDir[0],
  ];
  return {
    base: [plane.origin[0] + plane.xDir[0] * c[0] + y[0] * c[1], plane.origin[1] + plane.xDir[1] * c[0] + y[1] * c[1], plane.origin[2] + plane.xDir[2] * c[0] + y[2] * c[1]],
    normal: plane.normal,
  };
}

/** Body that a source "sits on" (joins/cuts default to it). */
export function targetOf(app: AppContext, src: ExtrudeSource): string | undefined {
  if (src.kind === "face") return src.face.body;
  return app.store.find<SketchFeature>(src.sketch)?.attachedTo?.body;
}

/** Bodies referenced by the selection (faces/edges/vertices count for their body). */
export function bodiesOf(sel: Sel[]): string[] {
  const ids = sel.flatMap((s) => (s.kind === "body" || s.kind === "face" || s.kind === "edge" || s.kind === "vertex" ? [s.body] : []));
  return [...new Set(ids)];
}
