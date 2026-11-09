// Freeform Face: a face of a body made a smooth surface. A grid of points
// lies over the face; tap points to pick them (tap again to let go), then move
// them with the gimbal - its arrows along the face and out of it, its squares
// within a plane, its rings to turn them - or type how far out of the face
// they are. The face's edges stay where they are: the rest of the body doesn't move.

import { BufferAttribute, BufferGeometry, Points } from "three";
import type { FaceFreeformFeature, FaceRef, Vec3 } from "../doc/types";
import { add, cross, dot, len, niceStep, norm, scale, sub, xDirFor } from "../geom";
import { faceGrid } from "../freeform/faceGrid";
import type { PanelItem } from "../ui/ui";
import { fmtLen } from "../units";
import type { ToolPointer } from "../view/input";
import { dotMaterial } from "../view/viewport";
import { isCoarse } from "../device";
import { FeatureOp } from "./featureOp";
import { Gimbal, type GimbalPart } from "./gimbal";
import { axisDrag } from "./handles";
import { faceRefOf, type AppContext, type Sel } from "./tool";

const SEL = 0xffa31a;
const GRIDS = [3, 5, 7, 9];

/** The triangles of face `i` of a body as shown (the grid goes only where the face is). */
function faceTriangles(app: AppContext, body: string, i: number): [Vec3, Vec3, Vec3][] {
  const b = app.view.body(body);
  const g = b?.faceGroups.find((x) => x.face === i);
  if (!b || !g) return [];
  const P = (k: number): Vec3 => [b.positions[3 * k], b.positions[3 * k + 1], b.positions[3 * k + 2]];
  const out: [Vec3, Vec3, Vec3][] = [];
  for (let t = g.start; t < g.start + g.count; t += 3) out.push([P(b.indices[t]), P(b.indices[t + 1]), P(b.indices[t + 2])]);
  return out;
}

export class FaceFreeformOp extends FeatureOp<FaceFreeformFeature> {
  readonly id = "faceFreeform";
  private tris: [Vec3, Vec3, Vec3][] = [];
  private picked = new Set<number>();
  private dots = new Points(new BufferGeometry(), dotMaterial({ color: 0xffffff, size: isCoarse ? 13 : 9 }));
  private marks = new Points(new BufferGeometry(), dotMaterial({ color: SEL, size: isCoarse ? 19 : 14 }));
  private gimbal: Gimbal | null = null;
  private dragging: { part: GimbalPart; from: ToolPointer; start: Vec3[]; center: Vec3 } | null = null;

  /**
   * `face`: the flat face to make freeform. Editing (`existing`): the face it
   * made is found on the body (the grid can be laid again over its outline).
   */
  constructor(app: AppContext, face: Extract<Sel, { kind: "face" }> | null, existing?: FaceFreeformFeature) {
    const ref = (face && !existing && faceRefOf(app, face)) as FaceRef;
    super(app, { ...app.store.newIdentity("faceFreeform"), type: "faceFreeform", face: ref, points: [], grid: 5 }, existing);
    if (existing) {
      const i = app.view.body(existing.face.body)?.faces.findIndex((f) => f.step === existing.id) ?? -1;
      if (i >= 0) this.tris = faceTriangles(app, existing.face.body, i);
    } else if (face) {
      this.tris = faceTriangles(app, face.body, face.face);
      this.layGrid(5);
    }
    this.dots.renderOrder = 70;
    this.marks.renderOrder = 71;
    app.view.overlay.add(this.dots, this.marks);
  }

  private get normal(): Vec3 {
    return this.feature.face.normal;
  }

  /** The face's own directions: along it (two) and out of it. */
  private axes(): Vec3[] {
    const n = norm(this.normal);
    const u = xDirFor(n);
    return [u, norm(cross(n, u)), n];
  }

  /** Points `n` across the face, none moved. */
  private layGrid(n: number): void {
    const f = this.feature.face;
    // (Over a face already shaped, the grid lies on the face as it was: its edges are the same.)
    this.feature.points = faceGrid(this.tris, f.center, f.normal, n).map((at) => ({ at, move: [0, 0, 0] as Vec3 }));
    this.feature.grid = n;
    this.picked.clear();
  }

  private where(i: number): Vec3 {
    const p = this.feature.points[i];
    return add(add(this.feature.face.center, p.at), p.move);
  }

  protected hint(): string {
    if (!this.feature.points.length) return "This face is too small for a grid of points - pick a bigger face";
    return this.picked.size ? "Move the picked points with the gimbal (arrows, squares, rings), or type how far out of the face they are. Tap points to pick more." : "Tap points on the face to pick them (tap again to let go), then move them. The face's edges stay put.";
  }

  protected ready(): boolean {
    return this.feature.points.length > 0;
  }

  /** How far the picked points are out of the face (their average). */
  private height(): number {
    const ids = [...this.picked];
    if (!ids.length) return 0;
    return ids.reduce((s, i) => s + dot(this.feature.points[i].move, this.normal), 0) / ids.length;
  }

  protected items(): PanelItem[] {
    const items: PanelItem[] = [];
    // Another grid starts over (nothing moved).
    if (this.tris.length)
      items.push({
        type: "choice",
        label: "Points across",
        options: GRIDS.map((n) => ({ id: String(n), label: String(n) })),
        value: String(this.feature.grid ?? ""),
        onChange: (v) => {
          const moved = this.feature.points.some((p) => len(p.move) > 1e-9);
          this.layGrid(Number(v));
          if (moved) this.app.ui.toast("A new grid: the points start flat again");
          this.render();
          this.update();
        },
      });
    items.push({
      type: "choice",
      options: [
        { id: "all", label: "Pick all" },
        { id: "none", label: "Pick none" },
        { id: "flat", label: "Flatten" },
      ],
      value: "",
      onChange: (v) => {
        if (v === "all") this.feature.points.forEach((_, i) => this.picked.add(i));
        else if (v === "none") this.picked.clear();
        // The picked points back onto the face (all of them when none are picked).
        else for (const i of this.picked.size ? this.picked : this.feature.points.keys()) this.feature.points[i].move = [0, 0, 0];
        this.render();
        this.update();
      },
    });
    if (this.picked.size) items.push({ type: "number", label: "Height", value: this.height(), kind: "length", onInput: (v) => this.setHeight(v) });
    return items;
  }

  /** The picked points this far out of the face (keeping any move along it). */
  private setHeight(h: number): void {
    for (const i of this.picked) {
      const m = this.feature.points[i].move;
      this.feature.points[i].move = add(m, scale(this.normal, h - dot(m, this.normal)));
    }
    this.app.ui.updatePanelValues([h]);
    this.update();
  }

  private centroid(ids: number[]): Vec3 {
    return scale(ids.reduce((s, i) => add(s, this.where(i)), [0, 0, 0] as Vec3), 1 / ids.length);
  }

  protected onDraftChanged(): void {
    const all = this.feature.points.map((_, i) => this.where(i));
    const set = (o: Points, pts: Vec3[]) => {
      o.geometry.setAttribute("position", new BufferAttribute(new Float32Array(pts.flat()), 3));
      o.geometry.computeBoundingSphere();
    };
    set(this.dots, all);
    set(this.marks, [...this.picked].map((i) => all[i]));
    const ids = [...this.picked];
    if (!ids.length) {
      this.gimbal?.dispose();
      this.gimbal = null;
    } else {
      this.gimbal ??= new Gimbal(this.app.view, { axes: this.axes() });
      this.gimbal.setCenter(this.centroid(ids));
    }
    this.app.view.requestRender();
  }

  /** The point under the pointer (on screen), if any. */
  private pointAt(p: ToolPointer): number | null {
    let best: { i: number; d: number } | null = null;
    this.feature.points.forEach((_, i) => {
      const s = this.app.view.toScreen(this.where(i));
      if (!s) return;
      const d = Math.hypot(s[0] - p.x, s[1] - p.y);
      if (d < Math.max(18, p.tol) && (!best || d < best.d)) best = { i, d };
    });
    return (best as { i: number } | null)?.i ?? null;
  }

  hover(p: ToolPointer | null): void {
    const part = p && !this.dragging ? (this.gimbal?.hit(p) ?? null) : null;
    if (!this.dragging) this.gimbal?.setHot(part);
    this.app.view.canvas.style.cursor = part || (p && this.pointAt(p) !== null) ? "pointer" : "";
  }

  tap(p: ToolPointer): void {
    const i = this.pointAt(p);
    if (i === null) return super.tap(p);
    if (this.picked.has(i)) this.picked.delete(i);
    else this.picked.add(i);
    this.render();
    this.onDraftChanged();
  }

  down(p: ToolPointer): boolean {
    const part = this.gimbal?.hit(p);
    if (!part || !this.gimbal) return false;
    // Another point right under the finger: a tap on it, not a drag of the gimbal's middle.
    if (part.kind === "center" || part.kind === "plane") {
      const i = this.pointAt(p);
      if (i !== null && !this.picked.has(i)) return false;
    }
    const ids = [...this.picked];
    // One point turned about itself wouldn't move: it turns about the face's middle.
    const center = part.kind === "ring" && ids.length === 1 ? this.feature.face.center : this.gimbal.origin;
    this.dragging = { part, from: p, start: this.feature.points.map((q) => q.move), center };
    this.gimbal.setHot(part);
    return true;
  }

  drag(p: ToolPointer): void {
    const dr = this.dragging;
    if (!dr) return;
    const view = this.app.view;
    const AX = this.axes();
    const step = niceStep(view.cam.worldPerPixel(view.height) * 4);
    const snap = (v: number) => (p.shift ? v : Math.round(v / step) * step);
    let d: Vec3 = [0, 0, 0];
    let deg = 0;
    let label = "";
    const part = dr.part;
    if (part.kind === "axis") {
      const t = snap(axisDrag(view, dr.center, AX[part.i], dr.from, p));
      d = scale(AX[part.i], t);
      label = `${t >= 0 ? "+" : ""}${fmtLen(t)}`;
    } else if (part.kind === "plane" || part.kind === "center") {
      const n = part.kind === "plane" ? AX[part.i] : (view.cam.viewDir().toArray() as Vec3);
      const plane = { origin: dr.center, normal: n, xDir: xDirFor(n) };
      const a = view.rayToPlane(dr.from.x, dr.from.y, plane);
      const b = view.rayToPlane(p.x, p.y, plane);
      if (!a || !b) return;
      d = sub(b, a).map(snap) as Vec3;
      label = fmtLen(len(d));
    } else {
      const axis = AX[part.i];
      const c = view.toScreen(dr.center);
      if (!c) return;
      const ang = (q: { x: number; y: number }) => Math.atan2(q.y - c[1], q.x - c[0]);
      const facing = dot(axis, view.cam.viewDir().toArray() as Vec3) < 0 ? 1 : -1;
      deg = ((-(ang(p) - ang(dr.from)) * 180) / Math.PI) * facing;
      deg = ((deg + 540) % 360) - 180;
      if (!p.shift) deg = Math.round(deg);
      label = `${deg}°`;
    }
    const t = (deg * Math.PI) / 180;
    const axis = part.kind === "ring" ? AX[part.i] : null;
    const base = this.feature.face.center;
    for (const i of this.picked) {
      const pt = this.feature.points[i];
      let q = add(add(base, pt.at), dr.start[i]);
      if (axis && deg) {
        // Rodrigues: turned about the axis through the centre.
        const v = sub(q, dr.center);
        q = add(dr.center, add(add(scale(v, Math.cos(t)), scale(cross(axis, v), Math.sin(t))), scale(axis, dot(axis, v) * (1 - Math.cos(t)))));
      }
      pt.move = sub(add(q, d), add(base, pt.at));
    }
    this.app.ui.updatePanelValues([this.height()]);
    this.app.ui.setLabel(p.x, p.y, label);
    this.update();
  }

  up(): void {
    this.dragging = null;
    this.gimbal?.setHot(null);
    this.app.ui.setLabel(0, 0, null);
  }

  exit(): void {
    this.gimbal?.dispose();
    this.gimbal = null;
    this.app.view.overlay.remove(this.dots, this.marks);
    this.dots.geometry.dispose();
    this.marks.geometry.dispose();
    this.app.view.canvas.style.cursor = "";
    super.exit();
  }
}
