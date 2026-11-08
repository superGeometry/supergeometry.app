// Move or copy a whole finished sketch to another plane: a gimbal on the
// sketch (its blue arrow goes along the sketch's normal - a parallel plane -
// the red and green ones slide it within its plane). With Copy on, the
// original stays and the copy is a new sketch; tap empty space or Done.

import type { Feature, PlaneDef, SketchFeature, Vec3 } from "../doc/types";
import { add, cross, dot, len, niceStep, norm, scale, sub } from "../geom";
import type { PanelItem } from "../ui/ui";
import { fmtLen } from "../units";
import type { ToolPointer } from "../view/input";
import { copyMode } from "./copyToggle";
import { DragTyping } from "./dragTyping";
import { FeatureOp } from "./featureOp";
import { Gimbal, type GimbalPart } from "./gimbal";
import { axisDrag } from "./handles";
import type { AppContext } from "./tool";

export class SketchMoveOp extends FeatureOp<SketchFeature> {
  readonly id = "sketchMove";
  private gimbal: Gimbal;
  private source: SketchFeature;
  private base: PlaneDef;
  private axes: Vec3[];
  /** Where the sketch goes, from where it is (world). */
  private d: Vec3 = [0, 0, 0];
  private copy: boolean;
  private dragging: { from: ToolPointer; part: GimbalPart; d0: Vec3 } | null = null;
  private typing: DragTyping;
  private center: Vec3;

  constructor(app: AppContext, sketchId: string, at: Vec3, copy = true) {
    const src = app.store.find<SketchFeature>(sketchId)!;
    const plane = app.sketchPlane(sketchId) ?? src.plane;
    const draft: SketchFeature = { ...structuredClone(src), ...app.store.newIdentity("sketch"), plane, attachedTo: undefined };
    delete draft.attachedTo;
    super(app, draft);
    this.source = src;
    this.base = plane;
    this.copy = copy;
    this.center = at;
    const y = cross(plane.normal, plane.xDir);
    this.axes = [norm(plane.xDir), norm(y), norm(plane.normal)];
    // Slide in the plane or along its normal; no turning.
    this.gimbal = new Gimbal(app.view, { axes: this.axes, parts: (p) => p.kind !== "ring" });
    this.gimbal.setCenter(at);
    this.typing = new DragTyping(app);
  }

  protected hint(): string {
    return "Drag the blue arrow to move the sketch forward or back, or red and green to slide it. Tap empty space when done.";
  }

  protected items(): PanelItem[] {
    const along = dot(this.d, this.axes[2]);
    const set = (k: number, v: number) => {
      this.d = add(sub(this.d, scale(this.axes[k], dot(this.d, this.axes[k]))), scale(this.axes[k], v));
      this.update();
    };
    return [
      { type: "number", label: "Distance", value: along, kind: "length", onInput: (v) => set(2, v) },
      {
        type: "toggle",
        label: "Copy",
        value: this.copy,
        onChange: (v) => {
          this.copy = v;
          copyMode.on = v;
          this.render();
          this.update();
        },
      },
    ];
  }

  protected ready(): boolean {
    return len(this.d) > 1e-9;
  }

  /** The moved plane (the sketch's curves come along unchanged). */
  private plane(): PlaneDef {
    return { ...this.base, origin: add(this.base.origin, this.d) };
  }

  protected featuresWith(): Feature[] {
    const list = [...this.app.store.features];
    if (this.copy) return [...list, { ...this.feature, plane: this.plane() }];
    const i = list.findIndex((f) => f.id === this.source.id);
    const moved: SketchFeature = { ...this.source, plane: this.plane() };
    delete moved.attachedTo;
    list[i] = moved;
    return list;
  }

  protected onDraftChanged(): void {
    this.gimbal.setCenter(add(this.center, this.d));
    this.app.ui.updatePanelValues([dot(this.d, this.axes[2]), dot(this.d, this.axes[0]), dot(this.d, this.axes[1])]);
  }

  protected done(): void {
    if (!this.ready()) return this.app.setTool(null);
    const plane = this.plane();
    if (this.copy) {
      const f = { ...this.feature, plane };
      this.app.store.add(f);
    } else {
      const id = this.source.id;
      // Moved off the face it was drawn on: it keeps its own plane from now on.
      this.app.store.commit((doc) => {
        const s = doc.features.find((x) => x.id === id);
        if (s?.type === "sketch") {
          s.plane = plane;
          delete s.attachedTo;
        }
      });
    }
    this.app.setTool(null);
    this.app.ui.toast(this.copy ? `Copied to “${this.feature.name}”, ${fmtLen(dot(this.d, this.axes[2]))} away` : "Sketch moved");
  }

  exit(): void {
    this.gimbal.dispose();
    super.exit();
  }

  hover(p: ToolPointer | null): void {
    this.gimbal.setHot(p && !this.dragging ? this.gimbal.hit(p) : (this.dragging?.part ?? null));
  }

  down(p: ToolPointer): boolean {
    const part = this.gimbal.hit(p);
    if (!part) return false;
    this.dragging = { from: p, part, d0: [...this.d] as Vec3 };
    this.gimbal.setHot(part);
    return true;
  }

  drag(p: ToolPointer): void {
    const dr = this.dragging;
    if (!dr) return;
    this.typing.track(p);
    if (this.typing.active) return;
    const view = this.app.view;
    const step = niceStep(view.cam.worldPerPixel(view.height) * 4);
    const snap = (v: number) => (p.shift ? v : Math.round(v / step) * step);
    const at = add(this.center, dr.d0);
    if (dr.part.kind === "axis") {
      const dir = this.axes[dr.part.i];
      const v = snap(axisDrag(view, at, dir, dr.from, p));
      this.d = add(dr.d0, scale(dir, v));
      this.app.ui.setLabel(p.x, p.y, `${fmtLen(v)}  · type a value`);
    } else {
      const n: Vec3 = dr.part.kind === "plane" ? this.axes[dr.part.i] : (view.cam.viewDir().toArray() as Vec3);
      const pl = { origin: at, normal: n, xDir: this.axes[(dr.part.kind === "plane" ? dr.part.i + 1 : 0) % 3] };
      const a = view.rayToPlane(dr.from.x, dr.from.y, pl);
      const b = view.rayToPlane(p.x, p.y, pl);
      if (!a || !b) return;
      const m = sub(b, a);
      // Snapped along the sketch's own axes.
      const q = this.axes.map((ax) => snap(dot(m, ax)));
      this.d = add(dr.d0, add(add(scale(this.axes[0], q[0]), scale(this.axes[1], q[1])), scale(this.axes[2], q[2])));
      this.app.ui.setLabel(p.x, p.y, fmtLen(len(sub(this.d, dr.d0))));
    }
    this.update();
  }

  up(): void {
    this.dragging = null;
    this.typing.reset();
    this.app.ui.setLabel(0, 0, null);
    this.gimbal.setHot(null);
    // The panel stays: change the values or Copy, drag again, or tap empty space.
    this.render();
  }

  dragKey(e: KeyboardEvent): boolean {
    const dr = this.dragging;
    if (!dr || dr.part.kind !== "axis") return false;
    const dir = this.axes[dr.part.i];
    return this.typing.key(e, {
      kind: "length",
      apply: (v) => ((this.d = add(dr.d0, scale(dir, v))), this.update()),
      commit: () => ((this.dragging = null), this.gimbal.setHot(null), this.done()),
      cancel: () => ((this.d = [...dr.d0] as Vec3), this.update()),
    });
  }
}
