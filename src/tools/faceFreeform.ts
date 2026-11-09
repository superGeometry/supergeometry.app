// Freeform Face: a face of a body made a smooth surface. A grid of points
// lies over the face; tap points to pick them (tap again to let go), drag the
// arrow (or type a height) to pull them out of the face or push them in. The
// face's edges stay where they are - the rest of the body doesn't move.

import { BufferAttribute, BufferGeometry, Points } from "three";
import type { FaceFreeformFeature, FaceRef, Vec3 } from "../doc/types";
import { add, dot, niceStep, scale } from "../geom";
import { faceGrid } from "../freeform/faceGrid";
import type { PanelItem } from "../ui/ui";
import { fmtLen } from "../units";
import type { ToolPointer } from "../view/input";
import { dotMaterial } from "../view/viewport";
import { isCoarse } from "../device";
import { FeatureOp } from "./featureOp";
import { axisDrag, Handle } from "./handles";
import { faceRefOf, type AppContext, type Sel } from "./tool";

const SEL = 0xffa31a;
const GRIDS = [3, 5, 7, 9];

/** The face's triangles as shown (for the grid: points only where the face is). */
function faceTriangles(app: AppContext, s: Extract<Sel, { kind: "face" }>): [Vec3, Vec3, Vec3][] {
  const b = app.view.body(s.body);
  const g = b?.faceGroups.find((x) => x.face === s.face);
  if (!b || !g) return [];
  const P = (k: number): Vec3 => [b.positions[3 * k], b.positions[3 * k + 1], b.positions[3 * k + 2]];
  const out: [Vec3, Vec3, Vec3][] = [];
  for (let t = g.start; t < g.start + g.count; t += 3) out.push([P(b.indices[t]), P(b.indices[t + 1]), P(b.indices[t + 2])]);
  return out;
}

export class FaceFreeformOp extends FeatureOp<FaceFreeformFeature> {
  readonly id = "faceFreeform";
  private tris: [Vec3, Vec3, Vec3][];
  private grid: number;
  private picked = new Set<number>();
  private dots = new Points(new BufferGeometry(), dotMaterial({ color: 0xffffff, size: isCoarse ? 13 : 9 }));
  private marks = new Points(new BufferGeometry(), dotMaterial({ color: SEL, size: isCoarse ? 19 : 14 }));
  private handle: Handle;
  private dragging: { from: ToolPointer; start: Vec3[]; base: Vec3 } | null = null;

  constructor(app: AppContext, face: Extract<Sel, { kind: "face" }> | null, existing?: FaceFreeformFeature) {
    const ref = (face && faceRefOf(app, face)) as FaceRef;
    super(app, { ...app.store.newIdentity("faceFreeform"), type: "faceFreeform", face: ref, points: [] }, existing);
    this.tris = face ? faceTriangles(app, face) : [];
    this.grid = existing ? 0 : 5;
    if (!existing) this.layGrid(5);
    this.handle = new Handle(app.view, "arrow");
    this.dots.renderOrder = 70;
    this.marks.renderOrder = 71;
    app.view.overlay.add(this.dots, this.marks);
  }

  private get normal(): Vec3 {
    return this.feature.face.normal;
  }

  /** Points `n` across the face, none moved. */
  private layGrid(n: number): void {
    this.grid = n;
    const f = this.feature.face;
    this.feature.points = faceGrid(this.tris, f.center, f.normal, n).map((at) => ({ at, move: [0, 0, 0] as Vec3 }));
    this.picked.clear();
  }

  private where(i: number): Vec3 {
    const p = this.feature.points[i];
    return add(add(this.feature.face.center, p.at), p.move);
  }

  protected hint(): string {
    if (!this.feature.points.length) return "This face is too small for a grid of points - pick a bigger face";
    return this.picked.size ? "Drag the arrow (or type a height) to pull the picked points out or push them in. Tap points to pick more." : "Tap points on the face to pick them (tap again to let go), then drag the arrow. The face's edges stay put.";
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
    // Another grid starts over (nothing moved); an edited step keeps its own.
    if (!this.existing || this.grid)
      items.push({ type: "choice", label: "Points across", options: GRIDS.map((n) => ({ id: String(n), label: String(n) })), value: String(this.grid), onChange: (v) => (this.layGrid(Number(v)), this.render(), this.update()) });
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

  /** The picked points this far out of the face (keeping any sideways move). */
  private setHeight(h: number): void {
    for (const i of this.picked) {
      const m = this.feature.points[i].move;
      this.feature.points[i].move = add(m, scale(this.normal, h - dot(m, this.normal)));
    }
    this.app.ui.updatePanelValues([h]);
    this.update();
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
    const mid = ids.length ? scale(ids.reduce((s, i) => add(s, all[i]), [0, 0, 0] as Vec3), 1 / ids.length) : null;
    this.handle.set(mid ?? this.feature.face.center, this.normal);
    this.handle.setVisible(!!mid);
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
    const on = !!p && this.picked.size > 0 && (!!this.dragging || this.handle.hit(p));
    this.handle.setHot(on);
    this.app.view.canvas.style.cursor = on || (p && this.pointAt(p) !== null) ? "pointer" : "";
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
    if (!this.picked.size || !this.handle.hit(p)) return false;
    const ids = [...this.picked];
    const base = scale(ids.reduce((s, i) => add(s, this.where(i)), [0, 0, 0] as Vec3), 1 / ids.length);
    this.dragging = { from: p, start: this.feature.points.map((q) => q.move), base };
    this.handle.setHot(true);
    return true;
  }

  drag(p: ToolPointer): void {
    const dr = this.dragging;
    if (!dr) return;
    const raw = axisDrag(this.app.view, dr.base, this.normal, dr.from, p);
    const step = niceStep(this.app.view.cam.worldPerPixel(this.app.view.height) * 4);
    const d = Math.round(raw / step) * step;
    for (const i of this.picked) this.feature.points[i].move = add(dr.start[i], scale(this.normal, d));
    this.app.ui.updatePanelValues([this.height()]);
    this.app.ui.setLabel(p.x, p.y, `${d >= 0 ? "+" : ""}${fmtLen(d)}`);
    this.update();
  }

  up(): void {
    this.dragging = null;
    this.handle.setHot(false);
    this.app.ui.setLabel(0, 0, null);
  }

  exit(): void {
    this.handle.dispose();
    this.app.view.overlay.remove(this.dots, this.marks);
    this.dots.geometry.dispose();
    this.marks.geometry.dispose();
    this.app.view.canvas.style.cursor = "";
    super.exit();
  }
}
