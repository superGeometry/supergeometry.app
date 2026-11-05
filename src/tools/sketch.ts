import { BufferGeometry, Line, LineBasicMaterial, LineDashedMaterial, Points, PointsMaterial, Vector3 } from "three";
import type { FaceRef, PlaneDef, PointRef, SketchConstraint, SketchEntity, SketchFeature, Vec2, Vec3 } from "../doc/types";
import { dot, GROUND, niceStep as niceStepOf, planeY, toPlane } from "../geom";
import { addResolving, pointOf, pointsOf, refsOf, sizeOf as sizeOfFn, solve } from "../sketch/constraints";
import { isExpression } from "../ui/ui";
import { Gimbal, IN_PLANE, type GimbalPart } from "./gimbal";
import { buildConstraints, buttonEnabled, CONSTRAINT_BUTTONS, ConstraintGlyphs, dimOf, distanceOf, existingConstraints, setDim } from "./sketchConstraints";
import { settings } from "../settings";
import { arcFrom3, entityPolylines } from "../sketch/curves";
import {
  offsetChain,
  connectedChain,
  angleLines,
  explode,
  alignLine,
  endNear,
  joinCollinear,
  extend,
  joinEnds,
  splitEntity,
  filletConstraints,
  filletEnds,
  filletCorner,
  guidePoints,
  mirrorXf,
  offsetEntity,
  projectPolyline,
  rotateXf,
  scaleXf,
  transformEntity,
  translateXf,
  trim,
  uid,
} from "../sketch/edit";
import { FONTS, importFont, textEntities } from "../sketch/text";
import { DragTyping } from "./dragTyping";
import { DimWidget } from "./annotate";
import { PatternBox } from "./patternBox";
import { axisDrag } from "./handles";
import { CopyToggle, copyMode } from "./copyToggle";
import type { PanelItem, ToolItem } from "../ui/ui";
import { fmtLen, trim as trimNum } from "../units";
import type { ToolPointer } from "../view/input";
import { dotMaterial, sketchToWorld } from "../view/viewport";
import { hitToSel, type AppContext, type Tool } from "./tool";

export type SketchKind = Kind;
type Kind =
  | "split"
  | "select"
  | "line"
  | "arc"
  | "spline"
  | "rect"
  | "circle"
  | "ellipse"
  | "polygon"
  | "text"
  | "project"
  | "offset"
  | "fillet"
  | "move"
  | "scale"
  | "patternLinear"
  | "patternCircular"
  | "rotate"
  | "mirror"
  | "trim"
  | "extend"
  | "align"
  | "delete";

const HINTS: Record<Kind, string> = {
  select: "Tap curves to select them and edit their size. Double-tap selects a whole shape.",
  line: "Tap points to draw lines. Tap the first point to close; double-tap or Enter to stop.",
  arc: "Tap the arc's two endpoints, then a third point to bend it.",
  spline: "Tap points the curve passes through. Tap the first point to close; double-tap or Enter to finish.",
  rect: "Tap (or drag) two opposite corners.",
  circle: "Tap the center, then the radius.",
  ellipse: "Tap the center, the end of the long axis, then the width.",
  polygon: "Tap the center, then a corner.",
  text: "Tap where the text should start.",
  project: "Tap body edges or curves of other sketches to project them here (double-tap: the whole sketch).",
  offset: "Tap a curve to offset it.",
  fillet: "Tap a corner where two lines meet.",
  move: "Tap curves to select, then type the offset and Apply.",
  scale: "Tap curves to select, then set the factor and Apply.",
  patternLinear: "Tap curves to select, then set count and spacing.",
  patternCircular: "Tap curves to select (double-tap for a whole shape), then tap the centre to turn them around.",
  rotate: "Tap curves to select, set the pivot and angle.",
  mirror: "Tap a shape to select it (Shift+tap: single curves), then tap the line to mirror it across — any line, even one of its own edges.",
  trim: "Tap the part of a curve to cut away (between crossings). Join mode: tap a line to merge it with the line on the same axis it touches.",
  align: "Tap the line to move, then the line it should line up with (the first one moves onto the second one's axis).",
  extend: "Tap the half of a line or arc whose end should move, then the half of the curve it should meet. Tap the same half twice to extend to the next curve.",
  delete: "Tap curves to delete them.",
  split: "Tap a line or arc to cut it in two at its midpoint (or at a point you tap on it while holding Shift).",
};

const memory = { textFont: "roboto", trim: "cut" as "cut" | "join", offsetMode: "chain" as "edge" | "chain", pattern: "patternLinear" as "patternLinear" | "patternCircular", rect: "diagonal" as "diagonal" | "center" | "3pt", spline: "fit" as "fit" | "control", sides: 6, fillet: 2, offset: 2, textSize: 10 };

interface Snap {
  uv: Vec2;
  label?: string;
  guides?: [Vec2, Vec2][];
  /** Snapped onto an existing sketch point (drawing then adds a Coincident constraint). */
  ref?: PointRef;
}

/** A point being dragged and where it started. */
interface DragRef {
  ref: PointRef;
  at: Vec2;
}

const refKey = (r: PointRef) => `${r.e}:${r.p}`;

/**
 * Sketching. First pick a plane (origin planes, a flat face, a construction
 * plane or an existing sketch); the camera then looks straight at it in
 * orthographic and Line is active. Every finished shape commits right away.
 */
export class SketchTool implements Tool {
  readonly id = "sketch";
  private phase: "plane" | "draw";
  private kind: Kind = "line";
  private sketchId: string | null;
  private plane: PlaneDef | null;
  private attachedTo?: FaceRef;
  private pts: Vec2[] = [];
  private cursor: Snap | null = null;
  private dragging = false;
  private locks: Record<string, number> = {};
  private selected = new Set<string>();
  private construction = false;
  private edit: {
    pivot?: Vec2;
    mirrorLine?: [Vec2, Vec2];
    picking?: "pivot" | "mirror";
    offsetOf?: string;
    /** Extend: the first curve half picked (its nearer end will meet the second pick). */
    extendFrom?: { id: string; at: Vec2 };
    /** Align: the line that will move. */
    alignFrom?: string;
    /** Fillet: first line half picked (two-tap fillet, like Extend). */
    filletFrom?: { id: string; at: Vec2 };
    dx: number;
    dy: number;
    /** Move/Rotate's rotation, Rotate Around Axis's angle, Pattern's total angle (degrees). */
    moveRot: number;
    angle: number;
    patAngle: number;
    factor: number;
    count: number;
    copy: boolean;
    /** Mirror keeps the original by default (its own switch, not Move's Copy). */
    mirrorCopy: boolean;
  } = { dx: 10, dy: 0, moveRot: 0, angle: 90, patAngle: 360, factor: 2, count: 3, copy: false, mirrorCopy: true };
  private text = "Text";
  private overlays: (Line | Points)[] = [];
  private prevOrtho = false;
  /** Selected sketch points (curves are in `selected`). */
  private selPts: PointRef[] = [];
  private gimbal: Gimbal | null = null;
  private copyToggle: CopyToggle | null = null;
  private glyphs: ConstraintGlyphs | null = null;
  private bar: HTMLElement | null = null;
  private selConstraint: string | null = null;
  /** Live edit of geometry: dragging points/curves, or the sketch gimbal. */
  private sdrag:
    | { kind: "points"; from: Vec2; refs: DragRef[] }
    | { kind: "gimbal"; part: GimbalPart; from: ToolPointer; refs: DragRef[]; center: Vec2; last: { d: Vec2; ang: number } }
    | { kind: "pivot"; line: string }
    | null = null;
  /**
   * One line selected: where its rotation pivot sits along it (0 = start,
   * 0.5 = middle, 1 = end). Drag the gimbal's centre to move it.
   */
  private pivotT: { line: string; t: number } | null = null;
  /** Where the current line chain started (for Coincident constraints). */
  private startRef: PointRef | null = null;

  private get constraints(): SketchConstraint[] {
    return this.sketch?.constraints ?? [];
  }

  constructor(
    private app: AppContext,
    opts: { sketchId?: string; plane?: PlaneDef; attachedTo?: FaceRef } = {},
  ) {
    this.sketchId = opts.sketchId ?? null;
    this.plane = opts.sketchId ? (app.sketchPlane(opts.sketchId) ?? null) : (opts.plane ?? null);
    this.attachedTo = opts.attachedTo;
    this.phase = this.plane ? "draw" : "plane";
    if (opts.sketchId) this.kind = "select";
  }

  get activeSketch(): string | undefined {
    return this.sketchId ?? undefined;
  }
  get editingId(): string | undefined {
    return this.sketchId ?? undefined;
  }

  private get sketch(): SketchFeature | undefined {
    return this.sketchId ? this.app.store.find<SketchFeature>(this.sketchId) : undefined;
  }
  private get entities(): SketchEntity[] {
    return this.sketch?.entities ?? [];
  }
  /** Outline of the face this sketch sits on (snaps, trims against; not editable). */
  private get boundary(): SketchEntity[] {
    return this.sketchId ? this.app.sketchCurves(this.sketchId).filter((e) => e.id.startsWith("bnd-")) : [];
  }
  private withoutBoundary(es: SketchEntity[]): SketchEntity[] {
    return es.filter((e) => !e.id.startsWith("bnd-"));
  }

  // ------------------------------------------------------------ lifecycle

  enter(): void {
    this.prevOrtho = this.app.view.cam.ortho;
    // Already looking straight at the model along an axis (Top, Front, Right, …):
    // sketch on that origin plane, facing the camera, without asking.
    if (this.phase === "plane") {
      const cam = this.app.view.cam;
      const d = cam.viewDir().toArray() as Vec3;
      const k = d.findIndex((x) => Math.abs(x) > 0.9999);
      if (k >= 0) {
        const normal: Vec3 = [0, 0, 0];
        normal[k] = -Math.sign(d[k]);
        const right = new Vector3().setFromMatrixColumn(cam.camera.matrixWorld, 0).toArray() as Vec3;
        const r = right.findIndex((x, i) => i !== k && Math.abs(x) > 0.9);
        const xDir: Vec3 = [0, 0, 0];
        if (r >= 0) xDir[r] = Math.sign(right[r]);
        else xDir[(k + 1) % 3] = 1;
        this.plane = { origin: [0, 0, 0], normal, xDir };
        this.phase = "draw";
      }
    }
    if (this.phase === "plane") {
      this.app.view.setOriginPlanesVisible(true);
      this.app.ui.setHint("Select a plane or a flat face to sketch on.");
      this.updateMenu();
    } else this.beginDrawing();
  }

  exit(): void {
    // A fillet being sized is kept (before the constraint UI goes away).
    this.finishFillet();
    this.clearOverlays();
    this.gimbal?.dispose();
    this.gimbal = null;
    this.patGimbal?.dispose();
    this.patGimbal = null;
    this.patBox?.dispose();
    this.patBox = null;
    this.sizeDim?.dispose();
    this.sizeDim = null;
    this.angleDim?.dispose();
    this.angleDim = null;
    this.closeLineBox();
    this.copyToggle?.dispose();
    this.copyToggle = null;
    this.glyphs?.dispose();
    this.glyphs = null;
    this.bar?.remove();
    this.bar = null;
    window.removeEventListener("resize", this.placeBar);
    this.hideLineDim();
    this.clearPreviewJoin();
    this.distDim?.dispose();
    this.distDim = null;
    settings.offChange(this.onSettings);
    this.listening = false;
    document.body.classList.remove("sketching");
    this.app.view.setOriginPlanesVisible(false);
    this.app.view.grid.setPlane(GROUND);
    this.app.view.cam.setOrtho(this.prevOrtho);
    this.app.ui.showPanel(null);
    this.app.ui.setLabel(0, 0, null);
    this.app.ui.setHint(null);
    this.app.setSelection([]);
  }

  refresh(): void {
    if (this.sketchId) this.plane = this.app.sketchPlane(this.sketchId) ?? this.plane;
    for (const id of [...this.selected]) if (!this.entities.some((e) => e.id === id)) this.selected.delete(id);
    this.selPts = this.selPts.filter((r) => this.entities.some((e) => e.id === r.e));
    if (this.selConstraint && !this.constraints.some((c) => c.id === this.selConstraint)) this.selConstraint = null;
    this.showSelection();
    this.refreshConstraintUI();
  }

  private listening = false;
  private onSettings = () => this.refreshConstraintUI();

  /**
   * The constraint column sits next to the right-hand bar with the same gap the
   * tool column keeps from Items, its top level with the Constraints button.
   */
  private placeBar = () => {
    const bar = this.bar;
    if (!bar) return;
    const col = document.getElementById("right-col")!.getBoundingClientRect();
    const btn = document.querySelector(".right-btn.sketch-only")?.getBoundingClientRect();
    const GAP = 8;
    // An open popover (snapping, units…) sits by the column too: go left of it.
    const pop = document.getElementById("popover")!;
    const left = pop.hidden ? col.left : Math.min(col.left, pop.getBoundingClientRect().left);
    bar.style.right = `${window.innerWidth - left + GAP}px`;
    const top = btn ? btn.top : col.top;
    // Keep it on screen when the window is short.
    bar.style.top = `${Math.max(8, Math.min(top, window.innerHeight - bar.offsetHeight - 8))}px`;
  };

  /** Constraint column (enabled per selection) and badges on the geometry. */
  private refreshConstraintUI(): void {
    if (this.phase !== "draw" || !this.plane) return;
    this.glyphs ??= new ConstraintGlyphs(this.app.view, (id) => this.selectConstraint(id));
    this.glyphs.selected = this.selConstraint;
    this.glyphs.set(this.plane, this.entities, this.constraints);
    this.glyphs.setVisible(settings.value.showConstraintGlyphs);
    document.body.classList.add("sketching");
    if (!this.listening) {
      this.listening = true;
      settings.onChange(this.onSettings);
    }
    // The column is toggled from the right-hand bar (Constraints button).
    if (!settings.value.showConstraints) {
      this.bar?.remove();
      this.bar = null;
      return;
    }
    if (!this.bar) {
      this.bar = document.createElement("div");
      this.bar.id = "constraint-bar";
      this.bar.addEventListener("pointerdown", (e) => e.stopPropagation());
      document.body.append(this.bar);
      window.addEventListener("resize", this.placeBar);
    }
    const curves = this.pickedCurves();
    this.bar.innerHTML = "";
    const auto = document.createElement("button");
    auto.className = `cbar-toggle${settings.value.autoConstrain ? " on" : ""}`;
    auto.innerHTML = `<span class="cl">Auto constrain</span><span class="switch"></span>`;
    auto.title = "Add horizontal/vertical/coincident constraints automatically while drawing";
    auto.addEventListener("click", () => settings.set("autoConstrain", !settings.value.autoConstrain));
    const glyphs = document.createElement("button");
    glyphs.className = `cbar-toggle${settings.value.showConstraintGlyphs ? " on" : ""}`;
    glyphs.innerHTML = `<span class="cl">Show constraints</span><span class="switch"></span>`;
    glyphs.title = "Show or hide the constraint badges and dimensions on the sketch";
    glyphs.addEventListener("click", () => settings.set("showConstraintGlyphs", !settings.value.showConstraintGlyphs));
    this.bar.append(auto, glyphs, document.createElement("hr"));
    for (const b of CONSTRAINT_BUTTONS) {
      const btn = document.createElement("button");
      // Already on the selection: shown as on; tapping removes it (Lock becomes Unlock).
      const have = this.selected.size || this.selPts.length ? existingConstraints(b.type, this.constraints, this.selPts, curves) : [];
      const label = have.length && b.type === "fix" ? "Unlock" : b.label;
      btn.innerHTML = `<span class="cl">${label} <kbd>⇧${b.key}</kbd></span><span class="cg">${have.length && b.type === "fix" ? "🔓" : b.glyph}</span>`;
      btn.classList.toggle("on", have.length > 0);
      btn.disabled = !have.length && !buttonEnabled(b.type, this.selPts, curves);
      btn.title = have.length ? `Remove ${b.label.toLowerCase()} (${have.length})` : btn.disabled ? `${b.label}: select the right points/curves first` : b.label;
      btn.addEventListener("click", () => (have.length ? this.removeConstraints(have) : this.addConstraint(b.type)));
      this.bar.append(btn);
    }
    this.placeBar();
  }

  /** Angle (degrees, 0–180) of line 2 against line 1, measured as setLinesAngle sets it. */
  private angleBetween(id1: string, id2: string): number {
    const r = angleLines(this.entities, id1, id2, 0);
    const l1 = this.entities.find((e) => e.id === id1);
    const l2 = this.entities.find((e) => e.id === id2);
    if (!r || l1?.kind !== "line" || l2?.kind !== "line") return 0;
    // Orientation as angleLines would set it: away from the meeting point.
    const o1 = r.swapped.includes(id1) ? [l1.a[0] - l1.b[0], l1.a[1] - l1.b[1]] : [l1.b[0] - l1.a[0], l1.b[1] - l1.a[1]];
    const o2 = r.swapped.includes(id2) ? [l2.a[0] - l2.b[0], l2.a[1] - l2.b[1]] : [l2.b[0] - l2.a[0], l2.b[1] - l2.a[1]];
    const a = Math.abs(Math.atan2(o1[0] * o2[1] - o1[1] * o2[0], o1[0] * o2[0] + o1[1] * o2[1]));
    return Math.round(((a * 180) / Math.PI) * 1e4) / 1e4;
  }

  /**
   * Turn the second picked line to `deg` against the first, about its end
   * nearest the first line, and keep it there with an angle dimension.
   */
  private setLinesAngle(id1: string, id2: string, deg: number): void {
    const r = angleLines(this.entities, id1, id2, deg);
    if (!r) return;
    const swap = (p: string) => (p === "a" ? "b" : p === "b" ? "a" : p);
    const remap = (c: SketchConstraint): SketchConstraint => (c.pts ? { ...c, pts: c.pts.map((q) => (r.swapped.includes(q.e) ? { ...q, p: swap(q.p) } : q)) } : c);
    const same = (c: SketchConstraint) => c.type === "dim" && c.prop === "angle" && c.curves?.length === 2 && c.curves.includes(id1) && c.curves.includes(id2);
    const res = addResolving(r.entities, this.constraints.filter((c) => !same(c)).map(remap), [{ id: uid(), type: "dim" as const, curves: [id1, id2], prop: "angle", value: deg }], { fixed: new Set([id1]) });
    this.commit(res.result.ok ? res.result.entities : r.entities, res.constraints);
    this.toastReplaced(res.removed);
  }

  /** Say which constraints a new one replaced. */
  private toastReplaced(removed: SketchConstraint[]): void {
    if (!removed.length) return;
    const names = [...new Set(removed.map((c) => (c.type === "dim" ? `${c.prop ?? "size"} dimension` : c.type)))].join(", ");
    this.app.ui.toast(`Replaced ${removed.length === 1 ? "a" : removed.length} constraint${removed.length > 1 ? "s" : ""} it contradicted (${names})`);
  }

  private removeConstraints(list: SketchConstraint[]): void {
    const ids = new Set(list.map((c) => c.id));
    this.commit(this.entities, this.constraints.filter((c) => !ids.has(c.id)));
    this.refreshConstraintUI();
    this.updatePanel();
  }

  /** When each curve id / point key was picked (the earliest is the reference). */
  private pickSeq = new Map<string, number>();
  private seq = 0;

  private firstPicked(): string | undefined {
    const cands = [...[...this.selected].map((id) => ({ e: id, k: id })), ...this.selPts.map((r) => ({ e: r.e, k: refKey(r) }))];
    cands.sort((a, b) => (this.pickSeq.get(a.k) ?? 0) - (this.pickSeq.get(b.k) ?? 0));
    return cands[0]?.e;
  }

  private distDim: DimWidget | null = null;

  /**
   * Two points, or a point and a line, selected: show their distance in a box.
   * Type a value + Enter (or just Enter) to make it a Distance constraint.
   */
  private refreshDistanceDim(): void {
    this.distDim?.dispose();
    this.distDim = null;
    if (this.kind !== "select" || !this.plane) return;
    const curves = this.pickedCurves();
    const pts = this.selPts;
    const v = distanceOf(pts, curves, this.entities);
    if (v === null) return;
    const P = (r: PointRef) => pointOf(this.entities.find((x) => x.id === r.e)!, r.p)!;
    const a = P(pts[0]);
    let b: Vec2;
    if (pts.length === 2) b = P(pts[1]);
    else {
      const l = curves[0] as Extract<SketchEntity, { kind: "line" }>;
      const d: Vec2 = [l.b[0] - l.a[0], l.b[1] - l.a[1]];
      const t = ((a[0] - l.a[0]) * d[0] + (a[1] - l.a[1]) * d[1]) / (d[0] * d[0] + d[1] * d[1] || 1);
      b = [l.a[0] + d[0] * t, l.a[1] + d[1] * t];
    }
    const existing = existingConstraints("distance", this.constraints, pts, curves)[0];
    const w = (q: Vec2) => sketchToWorld(this.plane!, q, 0.02).toArray() as Vec3;
    let typed: number | null = null;
    this.distDim = new DimWidget(this.app.view, {
      value: existing?.value ?? v,
      boxAt: "side",
      onInput: (x) => (typed = x > 0 ? x : null),
      onCommit: () => this.setDistance(typed ?? existing?.value ?? v),
    });
    this.distDim.set(w(a), w(b));
  }

  /** Upsert the Distance constraint of the selection; the first-picked side stays put. */
  private setDistance(value: number): void {
    const curves = this.pickedCurves();
    const pts = [...this.selPts];
    const old = new Set(existingConstraints("distance", this.constraints, pts, curves).map((c) => c.id));
    const c: SketchConstraint = { id: uid(), type: "distance", pts, ...(curves.length ? { curves: curves.map((e) => e.id) } : {}), value };
    const first = this.firstPicked();
    const res = addResolving(this.entities, this.constraints.filter((x) => !old.has(x.id)), [c], first ? { fixed: new Set([first]) } : {});
    this.commit(res.result.ok ? res.result.entities : this.entities, res.constraints);
    this.toastReplaced(res.removed);
    if (this.app.store.problems.length) this.app.ui.toast(this.app.store.problems[0], "error");
    this.refreshDistanceDim();
  }

  /** Selected curves in the order they were picked. */
  private pickedCurves(): SketchEntity[] {
    return [...this.selected].flatMap((id) => this.entities.filter((e) => e.id === id));
  }

  private addConstraint(type: (typeof CONSTRAINT_BUTTONS)[number]["type"]): void {
    const curves = this.pickedCurves();
    let cs = buildConstraints(type, this.selPts, curves);
    // Lock holds points where they are now.
    if (type === "fix") cs = cs.map((c) => (c.type === "fix" ? { ...c, at: pointOf(this.entities.find((e) => e.id === c.pts![0].e)!, c.pts![0].p) ?? [0, 0] } : c));
    if (!cs.length) return this.app.ui.toast("That constraint doesn't fit the selection");
    // The first thing picked is the reference: it stays, the others adapt to it.
    const first = this.firstPicked();
    // Equal: a size dimension on the curves picked after the first would fight it — drop those.
    const others = new Set(curves.slice(1).map((e) => e.id));
    const kept = type === "equal" ? this.constraints.filter((c) => !(c.type === "dim" && c.curves?.length === 1 && others.has(c.curves[0]) && ["length", "radius", "diameter"].includes(c.prop ?? ""))) : this.constraints;
    // A new constraint wins over ones it contradicts (they're replaced); others stay.
    const res = addResolving(this.entities, kept, cs, first && type !== "fix" ? { fixed: new Set([first]) } : {});
    this.commit(res.result.ok ? res.result.entities : this.entities, res.constraints);
    this.toastReplaced(res.removed);
    if (this.app.store.problems.length) this.app.ui.toast(this.app.store.problems[0], "error");
    this.clearSelection();
  }

  private selectConstraint(id: string): void {
    this.selConstraint = id;
    this.selected.clear();
    this.selPts = [];
    this.showSelection();
    this.refreshConstraintUI();
    const c = this.constraints.find((x) => x.id === id);
    if (!c) return;
    const del = { id: "delete", label: "Delete", icon: "trash" as const, run: () => this.deleteConstraint(id) };
    if (c.type === "dim" || c.type === "distance") {
      const kind = c.prop === "angle" ? "angle" : "length";
      this.app.ui.showPanel({
        title: `${c.prop ?? "distance"} dimension`,
        items: [
          {
            type: "number",
            label: "Value",
            value: c.value ?? 0,
            kind,
            expr: c.expr,
            onExpr: (expr) => (this.pendingExpr = expr),
            onInput: (v) => this.setConstraintValue(id, v),
          },
        ],
        actions: [del],
        onDone: () => this.deselectConstraint(),
      });
      this.app.ui.focusPanel();
    } else {
      this.app.ui.showPanel({ title: `${c.type} constraint`, items: [], actions: [del], onDone: () => this.deselectConstraint() });
    }
  }

  private pendingExpr: string | null = null;

  private setConstraintValue(id: string, v: number): void {
    const expr = this.pendingExpr;
    this.pendingExpr = null;
    this.commit(
      this.entities,
      this.constraints.map((c) => (c.id === id ? { ...c, value: v, expr: expr ?? undefined } : c)),
    );
  }

  private deleteConstraint(id: string): void {
    this.commit(this.entities, this.constraints.filter((c) => c.id !== id));
    this.deselectConstraint();
  }

  private deselectConstraint(): void {
    this.selConstraint = null;
    this.app.ui.showPanel(null);
    this.updatePanel();
    this.refreshConstraintUI();
  }

  private beginDrawing(): void {
    this.phase = "draw";
    this.app.view.setOriginPlanesVisible(false);
    const p = this.plane!;
    this.app.view.grid.setPlane(p);
    this.app.view.cam.setOrtho(true);
    // Look straight at the plane, centred on where the camera already looked.
    const uv = toPlane(p, this.app.view.cam.target.toArray() as [number, number, number]);
    this.app.view.cam.lookAlong(p.normal, p.xDir, sketchToWorld(p, uv).toArray() as [number, number, number]);
    this.updateMenu();
    this.updatePanel();
    this.setHint();
    this.refreshConstraintUI();
  }

  // ---------------------------------------------------------------- menu

  private updateMenu(): void {
    const app = this.app;
    const exit: ToolItem = { id: "exit", label: "Exit Sketch", icon: "exit", shortcut: "Esc", run: () => app.setTool(null) };
    if (this.phase === "plane") {
      app.ui.setTools([exit]);
      app.ui.setBottom([]);
      return;
    }
    const t = (kind: Kind, label: string, icon: ToolItem["icon"], shortcut?: string, extra: Partial<ToolItem> = {}): ToolItem => ({
      id: kind,
      label,
      icon,
      shortcut,
      active: this.kind === kind,
      run: () => this.setKind(kind),
      ...extra,
    });
    const variant = <T extends string>(kind: Kind, key: "rect" | "spline" | "trim", options: [T, string][]): ToolItem[] =>
      options.map(([v, l]) => ({ id: `${kind}-${v}`, label: l, icon: kind === "rect" ? "rect" : kind === "trim" ? "trim" : "spline", active: memory[key] === v, run: () => (((memory as unknown as Record<string, string>)[key] = v), this.setKind(kind)) }));
    app.ui.setTools([
      exit,
      { id: "---1", label: "", icon: "line" },
      t("select", "Select", "pointer", "V"),
      t("line", "Line", "line", "L"),
      t("arc", "Arc", "arc", "A"),
      t("spline", "Spline", "spline", "I", { sub: memory.spline === "fit" ? "Fit" : "Control", children: variant("spline", "spline", [["fit", "Fit points"], ["control", "Control points"]]) }),
      t("rect", "Rectangle", "rect", "R", { sub: { diagonal: "Diagonal", center: "Center", "3pt": "3 Points" }[memory.rect], children: variant("rect", "rect", [["center", "Center"], ["diagonal", "Diagonal"], ["3pt", "3 Points"]]) }),
      t("circle", "Circle", "circle", "C"),
      t("ellipse", "Ellipse", "ellipse"),
      t("polygon", "Polygon", "polygon", "G", { sub: `${memory.sides} sides` }),
      t("text", "Text", "text"),
      t("project", "Project", "project", "P"),
      t("offset", "Offset Edge", "offset", "O"),
      // Modify tools.
      t("fillet", "Fillet", "sketchFillet"),
      t("mirror", "Mirror", "mirror"),
      t("trim", "Trim", "trim", "T", { sub: memory.trim === "cut" ? "Cut" : "Join", children: variant("trim", "trim", [["cut", "Cut"], ["join", "Join lines"]]) }),
      t("align", "Align", "alignLine"),
      t("extend", "Extend", "extend", "E"),
      t("split", "Split", "splitLine"),
      t("move", "Move/Rotate", "move", "M"),
      t("scale", "Scale", "scale", "S"),
      {
        ...t(memory.pattern, "Pattern", memory.pattern),
        id: "pattern",
        active: this.kind === "patternLinear" || this.kind === "patternCircular",
        sub: memory.pattern === "patternLinear" ? "Linear" : "Circular",
        children: (["patternLinear", "patternCircular"] as const).map((k) => ({ id: k, label: k === "patternLinear" ? "Linear" : "Circular", icon: k, active: this.kind === k, run: () => ((memory.pattern = k), this.setKind(k)) })),
      },
      // With curves selected, Delete removes them right away; else it's the tap-to-delete tool.
      t("delete", "Delete", "trash", "Del", { run: () => (this.selected.size || this.selPts.length ? this.deleteSelected() : this.setKind("delete")) }),
    ]);
    // With curves selected the button shows (and flips) their type; otherwise the type of new curves.
    const sel = this.entities.filter((e) => this.selected.has(e.id));
    const isCons = sel.length ? sel.every((e) => e.construction) : this.construction;
    const mixed = sel.length > 0 && !isCons && sel.some((e) => e.construction);
    app.ui.setBottom([
      {
        id: "construction",
        label: sel.length ? (isCons ? "Construction" : "Regular") : this.construction ? "Construction" : "Regular",
        // The icon is the line type it is now; ⟲ + the type a tap switches to follow the text.
        icon: isCons ? "lineDashed" : "line",
        trailing: ["swap", isCons ? "line" : "lineDashed"],
        sub: sel.length ? (mixed ? "Mixed · tap to switch" : "Tap to switch") : "New lines · tap to switch",
        active: isCons,
        run: () => this.toggleConstruction(),
      },
      { id: "look", label: "Normal to Sketch", icon: "normal", run: () => this.plane && app.view.cam.lookAlong(this.plane.normal, this.plane.xDir) },
    ]);
  }

  /** Preselect curves (e.g. a profile's boundary when opening Move from a profile). */
  preselect(ids: Iterable<string>, pts: PointRef[] = []): void {
    this.selected = new Set(ids);
    this.selPts = [...pts];
    this.showSelection();
    this.updatePanel();
    this.refreshPreview();
  }

  setKind(kind: Kind): void {
    this.kind = kind;
    this.pts = [];
    this.locks = {};
    this.edit.picking = kind === "mirror" ? undefined : this.edit.picking;
    this.edit.offsetOf = undefined;
    this.edit.extendFrom = this.edit.alignFrom = undefined;
    this.edit.filletFrom = undefined;
    // A circular pattern always asks for its centre.
    if (kind === "patternCircular") this.edit.pivot = undefined;
    this.finishFillet();
    this.clearPreviewJoin();
    this.edit.mirrorLine = undefined;
    // Editing tools keep the selection; drawing tools start clean.
    if (!["move", "scale", "patternLinear", "patternCircular", "rotate", "mirror", "select", "delete"].includes(kind)) this.selected.clear();
    this.clearOverlays();
    this.hideLineDim();
    this.refreshDistanceDim();
    this.showSelection();
    this.updateMenu();
    this.updatePanel();
    this.setHint();
  }

  private setHint(extra?: string): void {
    const hint = this.phase === "plane" ? "Select a plane or a flat face to sketch on." : extra ?? HINTS[this.kind];
    this.app.ui.setHint(hint);
  }

  private toggleConstruction(): void {
    if (this.selected.size) {
      const ids = this.selected;
      const anyOff = this.entities.some((e) => ids.has(e.id) && !e.construction);
      this.commit(this.entities.map((e) => (ids.has(e.id) ? { ...e, construction: anyOff } : e)));
    } else {
      this.construction = !this.construction;
    }
    this.updateMenu();
  }

  // ---------------------------------------------------------------- panel

  private updatePanel(): void {
    const ui = this.app.ui;
    this.sizeDim?.dispose();
    this.sizeDim = null;
    this.angleDim?.dispose();
    this.angleDim = null;
    const items: PanelItem[] = [];
    const k = this.kind;
    const lock = (key: string, label: string, kind: "length" | "angle" | "int" = "length", value?: number): PanelItem => ({
      type: "number",
      label,
      value: this.locks[key] ?? value ?? 0,
      kind,
      onInput: (v) => {
        this.locks[key] = v;
        this.refreshPreview();
      },
    });
    const selCount = this.selected.size;
    const apply = (label: string, fn: () => void): PanelItem => ({ type: "button", label, icon: "check", onClick: fn });
    switch (k) {
      case "line":
        // With the numpad, the length is typed in the box by the line itself.
        if (this.pts.length && !settings.value.numpad) items.push(lock("len", "Length"));
        break;
      case "rect":
        if (this.pts.length === 1 && memory.rect !== "3pt") items.push(lock("w", "Width"), lock("h", "Height"));
        break;
      case "circle":
        if (this.pts.length === 1) items.push(lock("r", "Diameter"));
        break;
      case "polygon":
        items.push({ type: "number", label: "Sides", value: memory.sides, kind: "int", min: 3, onInput: (v) => ((memory.sides = Math.max(3, Math.min(64, v))), this.refreshPreview(), this.updateMenu()) });
        if (this.pts.length === 1) items.push(lock("r", "Radius"));
        break;
      case "ellipse":
        if (this.pts.length === 1) items.push(lock("rx", "Length"));
        if (this.pts.length === 2) items.push(lock("ry", "Width"));
        break;
      case "text":
        if (this.pts.length === 1) {
          ui.showPanel({
            title: "Text",
            items: [
              { type: "number", label: "Size", value: memory.textSize, kind: "length", min: 0.001, onInput: (v) => ((memory.textSize = v), this.refreshPreview()) },
              // The font: the bundled ones and any imported.
              { type: "choice", label: "Font", list: true, options: FONTS.map((f) => ({ id: f.id, label: f.name })), value: memory.textFont, onChange: (id) => ((memory.textFont = id), this.refreshPreview()) },
              { type: "button", label: "Import font…", icon: "insert", onClick: () => void this.importFontFile() },
            ],
            onDone: () => this.commitText(),
            onCancel: () => this.setKind("text"),
          });
          this.addTextInput();
          return;
        }
        break;
      case "fillet":
        items.push({ type: "number", label: "Radius", value: memory.fillet, kind: "length", min: 0.0001, onInput: (v) => (memory.fillet = v) });
        break;
      case "offset":
        // Edge: just the tapped curve. Chain: the whole connected outline, kept closed.
        items.push({ type: "choice", options: [{ id: "edge", label: "Edge" }, { id: "chain", label: "Chain" }], value: memory.offsetMode, onChange: (m) => ((memory.offsetMode = m as "edge" | "chain"), this.updatePanel(), this.refreshPreview()) });
        if (this.edit.offsetOf) {
          items.push({ type: "number", label: "Distance", value: memory.offset, kind: "length", onInput: (v) => ((memory.offset = v), this.refreshPreview()) });
          items.push({ type: "button", label: "Flip", icon: "flip", onClick: () => ((memory.offset = -memory.offset), this.updatePanel(), this.refreshPreview()) });
          items.push(apply("Apply", () => this.applyOffset()));
        }
        break;
      case "move":
        items.push(
          { type: "number", label: "Δ X", value: this.edit.dx, kind: "length", onInput: (v) => ((this.edit.dx = v), this.refreshPreview()) },
          { type: "number", label: "Δ Y", value: this.edit.dy, kind: "length", onInput: (v) => ((this.edit.dy = v), this.refreshPreview()) },
          { type: "number", label: "Rotate", value: this.edit.moveRot, kind: "angle", onInput: (v) => ((this.edit.moveRot = v), this.refreshPreview()) },
          { type: "toggle", label: "Copy", value: this.edit.copy, onChange: (v) => ((this.edit.copy = v), this.updatePanel()) },
          apply(`Apply (${selCount})`, () => this.applyTransform()),
        );
        break;
      case "scale":
        items.push({ type: "number", label: "Factor", value: this.edit.factor, kind: "number", min: 0.0001, onInput: (v) => ((this.edit.factor = v), this.refreshPreview()) }, { type: "toggle", label: "Copy", value: this.edit.copy, onChange: (v) => ((this.edit.copy = v), this.updatePanel()) }, apply(`Apply (${selCount})`, () => this.applyTransform()));
        break;
      case "patternLinear": {
        // Count, spacing and the direction it runs (the arrows show it; drag one to set both).
        const spacing = Math.hypot(this.edit.dx, this.edit.dy);
        const dirDeg = spacing > 1e-12 ? (Math.atan2(this.edit.dy, this.edit.dx) * 180) / Math.PI : 0;
        const setPolar = (sp: number, deg: number) => {
          const a = (deg * Math.PI) / 180;
          this.edit.dx = Math.cos(a) * sp;
          this.edit.dy = Math.sin(a) * sp;
          this.refreshPreview();
        };
        items.push(
          { type: "number", label: "Count", value: this.edit.count, kind: "int", min: 2, onInput: (v) => ((this.edit.count = v), this.refreshPreview()) },
          { type: "number", label: "Spacing", value: spacing, kind: "length", onInput: (v) => setPolar(v, dirDeg) },
          { type: "number", label: "Direction", value: dirDeg, kind: "angle", onInput: (v) => setPolar(Math.hypot(this.edit.dx, this.edit.dy), v) },
          apply(`Apply (${selCount})`, () => this.applyTransform()),
        );
        break;
      }
      case "patternCircular":
      case "rotate":
        items.push(
          { type: "slot", label: "Center", value: this.edit.pivot ? `${trimNum(this.edit.pivot[0])}, ${trimNum(this.edit.pivot[1])}` : k === "patternCircular" ? "Tap the centre" : "Origin (tap to set)", active: this.edit.picking === "pivot", filled: !!this.edit.pivot, onClick: () => ((this.edit.picking = "pivot"), this.updatePanel()) },
          ...(k === "patternCircular" ? [{ type: "number", label: "Count", value: this.edit.count, kind: "int", min: 2, onInput: (v: number) => ((this.edit.count = v), this.refreshPreview()) } as PanelItem] : []),
          k === "patternCircular"
            ? { type: "number", label: "Angle", value: this.edit.patAngle, kind: "angle", onInput: (v) => ((this.edit.patAngle = v), this.refreshPreview()) }
            : { type: "number", label: "Angle", value: this.edit.angle, kind: "angle", onInput: (v) => ((this.edit.angle = v), this.refreshPreview()) },
          ...(k === "rotate" ? [{ type: "toggle", label: "Copy", value: this.edit.copy, onChange: (v: boolean) => ((this.edit.copy = v), this.updatePanel()) } as PanelItem] : []),
          apply(`Apply (${selCount})`, () => this.applyTransform()),
        );
        break;
      case "mirror":
        items.push(
          { type: "slot", label: "Mirror line", value: this.edit.mirrorLine ? "Line" : "Tap a line or axis", active: this.edit.picking === "mirror", filled: !!this.edit.mirrorLine, onClick: () => ((this.edit.picking = "mirror"), this.updatePanel()) },
          { type: "toggle", label: "Copy", value: this.edit.mirrorCopy, onChange: (v) => ((this.edit.mirrorCopy = v), this.updatePanel()) },
          apply(`Apply (${selCount})`, () => this.applyTransform()),
        );
        break;
      case "select":
        if (selCount === 1) return this.showSizePanel();
        if (selCount > 1) {
          // Two lines: the angle of the second picked against the first.
          const [l1, l2] = this.pickedCurves();
          const angle: PanelItem[] =
            selCount === 2 && l1?.kind === "line" && l2?.kind === "line"
              ? [{ type: "number", label: "Angle", value: this.angleBetween(l1.id, l2.id), kind: "angle", onInput: (v) => this.setLinesAngle(l1.id, l2.id, v) }]
              : [];
          if (selCount === 2 && l1?.kind === "line" && l2?.kind === "line") this.showAngleBox(l1, l2);
          return ui.showPanel({
            title: `${selCount} curves`,
            items: [
              ...angle,
              { type: "button", label: "Construction", icon: "construction", onClick: () => this.toggleConstruction() },
              { type: "button", label: "Delete", icon: "trash", onClick: () => this.deleteSelected() },
            ],
          });
        }
        break;
    }
    // Select and the edit tools show the step just done; tapping it selects what it made.
    const lastLog = this.sketch?.log?.at(-1);
    const drawing = ["line", "arc", "spline", "rect", "circle", "ellipse", "polygon", "text"].includes(k);
    const made = this.lastMade.filter((id) => this.entities.some((e) => e.id === id));
    if (lastLog && !drawing) {
      items.push({
        type: "button",
        label: `Select last: ${lastLog.op}${lastLog.n > 1 ? ` ×${lastLog.n}` : ""}`,
        icon: "pointer",
        onClick: () => {
          if (!made.length) return this.app.ui.toast("Nothing from that step to select");
          if (this.kind !== "select" && !this.isSelectionTool()) this.setKind("select");
          this.selected = new Set(made);
          this.selPts = [];
          this.selectionChanged();
        },
      });
    }
    ui.showPanel(items.length ? { title: titleOf(k), items, onCancel: this.pts.length ? () => this.resetDrawing() : undefined } : null);
  }

  /** Pick a .ttf / .otf / .woff file and use it for the text. */
  private async importFontFile(): Promise<void> {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".ttf,.otf,.woff,font/ttf,font/otf,font/woff";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        memory.textFont = await importFont(file);
        this.app.ui.toast(`Font “${FONTS.find((f) => f.id === memory.textFont)?.name}” added`);
        this.updatePanel();
        this.refreshPreview();
      } catch {
        this.app.ui.toast("That font file can't be read (use .ttf, .otf or .woff)", "error");
      }
    };
    input.click();
  }

  private addTextInput(): void {
    const panel = document.getElementById("panel")!;
    const input = document.createElement("input");
    input.className = "text-input";
    input.value = this.text;
    input.addEventListener("input", () => ((this.text = input.value), this.refreshPreview()));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.commitText();
      if (e.key === "Escape") this.setKind("text");
      e.stopPropagation();
    });
    panel.querySelector(".panel-fields")?.prepend(input);
    setTimeout(() => input.select(), 0);
  }

  // -------------------------------------------------------------- pointer

  hover(p: ToolPointer | null): void {
    if (p && this.phase === "plane") {
      // Show which plane / face / sketch a tap would pick.
      const hit = this.app.view.pick(p.x, p.y, { edges: false, vertices: false, planes: true, planesFirst: true, profiles: true, edgeTolPx: 0 });
      const ok = hit && (hit.kind === "plane" || hit.kind === "profile" || (hit.kind === "face" && !!this.app.view.body(hit.body)?.faces[hit.face]?.plane));
      this.app.setHover(ok ? hitToSel(hit) : null);
      return;
    }
    if (!p || this.phase !== "draw" || this.dragging || this.sdrag) return;
    if (this.kind === "patternLinear" && this.patGimbal) {
      const g = this.patGimbal.hit(p);
      this.patGimbal.setHot(g ?? (this.patDrag ? ({ kind: "axis", i: this.patDrag.axis as 0 | 1 }) : null));
      if (g) return this.app.setHover(null);
    }
    if (this.kind === "select") {
      const g = this.gimbal?.hit(p) ?? null;
      this.gimbal?.setHot(g);
      if (g) return this.app.setHover(null);
      const hit = this.app.view.pick(p.x, p.y, { curves: this.sketchId ?? true, profiles: false, bodies: false, planes: false, axes: false, images: false, edgeTolPx: p.tol });
      if (hit?.kind === "point" && hit.sketch === this.sketchId) this.app.setHover({ kind: "point", sketch: hit.sketch, entity: hit.entity, p: hit.p });
      else if (hit?.kind === "curve" && hit.sketch === this.sketchId) this.app.setHover({ kind: "curve", sketch: hit.sketch, entity: hit.entity });
      else this.app.setHover(null);
      return;
    }
    if (["trim", "delete", "extend", "offset", "split", "fillet", "align"].includes(this.kind) || this.isSelectionTool()) {
      const hit = this.app.view.pick(p.x, p.y, { curves: this.sketchId ?? true, profiles: false, bodies: false, planes: false, axes: false, edgeTolPx: p.tol });
      const onCurve = hit?.kind === "curve" && hit.sketch === this.sketchId;
      this.app.setHover(onCurve ? { kind: "curve", sketch: hit.sketch, entity: hit.entity } : null);
      // Second pick of Extend/Fillet: show the result as dashed lines before tapping.
      this.previewJoin(onCurve ? this.curveAt(p) : null);
      if (!this.edit.picking) return;
    }
    if (this.kind === "project") {
      const hit = this.app.view.pick(p.x, p.y, { profiles: false, planes: false, axes: false, edgeTolPx: p.tol });
      this.app.setHover(
        hit?.kind === "edge" ? { kind: "edge", body: hit.body, edge: hit.edge } : hit?.kind === "curve" && hit.sketch !== this.sketchId ? { kind: "curve", sketch: hit.sketch, entity: hit.entity } : null,
      );
      return;
    }
    this.cursor = this.snap(p);
    this.refreshPreview(p);
  }

  down(p: ToolPointer): boolean {
    if (this.phase !== "draw") return false;
    if (this.kind === "patternLinear" && this.startPatternDrag(p)) return true;
    // Only the gimbal grabs right away; geometry drags start once the pointer moves (dragStart).
    if (this.kind === "select") return this.startGimbalDrag(p);
    if (!["line", "rect", "circle", "polygon", "ellipse", "arc"].includes(this.kind) || this.pts.length) return false;
    const s = this.snap(p);
    if (!s) return false;
    this.pts = [s.uv];
    this.cursor = s;
    this.dragging = true;
    this.updatePanel();
    return true;
  }

  drag(p: ToolPointer): void {
    if (this.patDrag) return this.dragPattern(p);
    this.typing.track(p);
    if (this.sdrag) return this.dragGeometry(p);
    this.cursor = this.snap(p);
    // Typed sizes stay locked; the pointer still sets the direction.
    this.refreshPreview(this.typing.active ? undefined : p);
  }

  private get typing(): DragTyping {
    return (this._typing ??= new DragTyping(this.app));
  }
  private _typing: DragTyping | null = null;
  private lockIndex = 0;
  private ignoreUp = false;
  /** A value was typed for the shape being drawn (Enter then advances/places it). */
  private typedThisShape = false;

  /** Dimensions that can be typed while dragging the current shape. */
  private lockKeys(): string[] {
    switch (this.kind) {
      case "line":
        return ["len"];
      case "rect":
        return memory.rect === "3pt" ? [] : ["w", "h"];
      case "circle":
        return ["r"];
      case "polygon":
        // Tab: radius → number of sides.
        return ["r", "sides"];
      case "ellipse":
        return ["rx"];
      default:
        return [];
    }
  }

  dragKey(e: KeyboardEvent): boolean {
    if (this.sdrag?.kind === "gimbal") {
      const dr = this.sdrag;
      const ring = dr.part.kind === "ring";
      return this.typing.key(e, {
        kind: ring ? "angle" : "length",
        apply: (v) => {
          // Arrow: along its axis; square/centre: along the direction dragged so far; arc: degrees.
          let d: Vec2 = [0, 0];
          if (dr.part.kind === "axis") d = dr.part.i === 0 ? [v, 0] : [0, v];
          else if (!ring) {
            const l = Math.hypot(...dr.last.d) || 1;
            d = [(dr.last.d[0] / l) * v, (dr.last.d[1] / l) * v];
          }
          this.applyGimbal(d, ring ? (v * Math.PI) / 180 : 0);
        },
        commit: () => this.endGeometryDrag(),
        cancel: () => this.applyGimbal([0, 0], 0),
      });
    }
    const keys = this.lockKeys();
    if (!this.dragging || !this.pts.length || !keys.length) return false;
    const key = keys[this.lockIndex];
    return this.typing.key(e, {
      kind: key === "ang" ? "angle" : key === "sides" ? "number" : "length",
      show: this.kind === "line" ? (text, bad) => this.lineDim?.setText(text, bad) : undefined,
      apply: (v) => this.applyLock(key, v),
      commit: () => {
        // Finish the shape at the typed size; the coming mouse-up must not add a point.
        this.dragging = false;
        this.ignoreUp = true;
        this.lockIndex = 0;
        if (this.cursor) this.addPoint(this.cursor.uv, 1);
      },
      cancel: () => (delete this.locks[key], this.refreshPreview()),
      next: () => (this.lockIndex < keys.length - 1 ? (this.lockIndex++, true) : false),
    });
  }

  up(p: ToolPointer): void {
    if (this.patDrag) return this.endPatternDrag();
    if (this.sdrag) return this.endGeometryDrag();
    this.dragging = false;
    this.typing.reset();
    this.lockIndex = 0;
    if (this.ignoreUp) {
      this.ignoreUp = false;
      return;
    }
    if (!this.pts.length || !this.cursor) return;
    const a = this.app.view.toScreen(sketchToWorld(this.plane!, this.pts[0]));
    // A drag places the second point; a tap waits for it.
    if (a && Math.hypot(a[0] - p.x, a[1] - p.y) > 12) this.addPoint(this.cursor.uv, 1);
  }

  // ------------------------------------------- drag points / curves / gimbal

  private uvAt(p: { x: number; y: number }): Vec2 | null {
    const w = this.plane && this.app.view.rayToPlane(p.x, p.y, this.plane);
    return w ? toPlane(this.plane!, w) : null;
  }

  /** Points that move when these curves/points move (round shapes move by their centre). */
  private dragRefs(curveIds: Iterable<string>, pts: PointRef[]): DragRef[] {
    const out = new Map<string, DragRef>();
    for (const id of curveIds) {
      const e = this.entities.find((x) => x.id === id);
      if (!e) continue;
      const own = e.kind === "circle" || e.kind === "ellipse" || e.kind === "rect" || e.kind === "polygon" ? pointsOf(e).filter((q) => q.p === "c") : pointsOf(e).filter((q) => q.p !== "c");
      for (const q of own) out.set(`${id}:${q.p}`, { ref: { e: id, p: q.p }, at: q.at });
    }
    for (const r of pts) {
      const e = this.entities.find((x) => x.id === r.e);
      const at = e && pointOf(e, r.p);
      if (at) out.set(refKey(r), { ref: r, at });
    }
    return [...out.values()];
  }

  private startGimbalDrag(p: ToolPointer): boolean {
    const part = this.gimbal?.hit(p);
    if (!part || !this.gimbal) return false;
    const line = this.singleLine();
    if (part.kind === "center" && line) {
      this.sdrag = { kind: "pivot", line: line.id };
      this.gimbal.setHot(part);
      return true;
    }
    const refs = this.dragRefs(this.selected, this.selPts);
    if (!refs.length) return false;
    const c = toPlane(this.plane!, this.gimbal.origin);
    this.sdrag = { kind: "gimbal", part, from: p, refs, center: c, last: { d: [0, 0], ang: 0 } };
    this.gimbal.setHot(part);
    return true;
  }

  /** Press on a curve/point and move: drag it (a tap without moving selects it instead). */
  dragStart(p: ToolPointer): boolean {
    if (this.phase !== "draw" || this.kind !== "select") return false;
    const hit = this.app.view.pick(p.x, p.y, { curves: this.sketchId ?? true, profiles: false, bodies: false, planes: false, axes: false, images: false, edgeTolPx: p.tol });
    const from = this.uvAt(p);
    if (!from || !hit || (hit.kind !== "point" && hit.kind !== "curve") || hit.sketch !== this.sketchId) return false;
    // Dragging something unselected drags just that; a selected thing drags the whole selection.
    const isSel = hit.kind === "curve" ? this.selected.has(hit.entity) : this.selPts.some((r) => r.e === hit.entity && r.p === hit.p);
    const refs = isSel ? this.dragRefs(this.selected, this.selPts) : hit.kind === "curve" ? this.dragRefs([hit.entity], []) : this.dragRefs([], [{ e: hit.entity, p: hit.p }]);
    if (!refs.length) return false;
    this.sdrag = { kind: "points", from, refs };
    return true;
  }

  /** The one selected line (no points selected), if that's the selection. */
  private singleLine(): Extract<SketchEntity, { kind: "line" }> | null {
    if (this.selected.size !== 1 || this.selPts.length) return null;
    const e = this.entities.find((x) => this.selected.has(x.id));
    return e?.kind === "line" ? e : null;
  }

  private dragGeometry(p: ToolPointer): void {
    const dr = this.sdrag!;
    if (dr.kind === "pivot") {
      // Slide along the line; snaps to its ends and middle.
      const e = this.entities.find((x) => x.id === dr.line);
      const uv = this.uvAt(p);
      if (e?.kind !== "line" || !uv) return;
      const d: Vec2 = [e.b[0] - e.a[0], e.b[1] - e.a[1]];
      const L2 = d[0] * d[0] + d[1] * d[1] || 1;
      let t = Math.max(0, Math.min(1, ((uv[0] - e.a[0]) * d[0] + (uv[1] - e.a[1]) * d[1]) / L2));
      const px = Math.sqrt(L2) / (this.app.view.cam.worldPerPixel(this.app.view.height) || 1);
      for (const s of [0, 0.5, 1]) if (Math.abs(t - s) * px < 12) t = s;
      this.pivotT = { line: dr.line, t };
      this.gimbal?.setCenter(sketchToWorld(this.plane!, [e.a[0] + d[0] * t, e.a[1] + d[1] * t]).toArray() as Vec3);
      this.app.ui.setLabel(p.x, p.y, t === 0 ? "Pivot: start" : t === 1 ? "Pivot: end" : t === 0.5 ? "Pivot: midpoint" : "Pivot");
      return;
    }
    if (dr.kind === "points") {
      const uv = this.uvAt(p);
      if (!uv) return;
      this.moveRefs(dr.refs, (q) => [q[0] + uv[0] - dr.from[0], q[1] + uv[1] - dr.from[1]]);
      this.app.ui.setLabel(p.x, p.y, `${fmtLen(Math.hypot(uv[0] - dr.from[0], uv[1] - dr.from[1]))}`);
      return;
    }
    if (this.typing.active) return;
    const view = this.app.view;
    const plane = this.plane!;
    const step = niceStepOf(view.cam.worldPerPixel(view.height) * 4);
    const snap = (v: number) => (p.shift ? v : Math.round(v / step) * step);
    if (dr.part.kind === "ring") {
      const c = view.toScreen(sketchToWorld(plane, dr.center));
      if (!c) return;
      const ang = (q: { x: number; y: number }) => Math.atan2(q.y - c[1], q.x - c[0]);
      const facing = dot(plane.normal, view.cam.viewDir().toArray() as Vec3) < 0 ? 1 : -1;
      let deg = ((-(ang(p) - ang(dr.from)) * 180) / Math.PI) * facing;
      deg = ((deg + 540) % 360) - 180;
      const snapped = p.shift ? deg : Math.round(deg / 5) * 5;
      this.applyGimbal([0, 0], (snapped * Math.PI) / 180);
      this.app.ui.setLabel(p.x, p.y, `${snapped}°  · type a value`);
      return;
    }
    const a = this.uvAt(dr.from);
    const b = this.uvAt(p);
    if (!a || !b) return;
    let d: Vec2 = [b[0] - a[0], b[1] - a[1]];
    if (dr.part.kind === "axis") d = dr.part.i === 0 ? [snap(d[0]), 0] : [0, snap(d[1])];
    else d = [snap(d[0]), snap(d[1])];
    this.applyGimbal(d, 0);
    this.app.ui.setLabel(p.x, p.y, `${fmtLen(Math.hypot(...d))}  · type a value`);
  }

  /** Move the gimbal's selection by d (sketch units) and/or rotate it about its centre. */
  private applyGimbal(d: Vec2, ang: number): void {
    const dr = this.sdrag;
    if (dr?.kind !== "gimbal") return;
    dr.last = { d, ang };
    const c = dr.center;
    const cs = Math.cos(ang);
    const sn = Math.sin(ang);
    this.moveRefs(dr.refs, (q) => {
      const x = q[0] - c[0];
      const y = q[1] - c[1];
      return [c[0] + x * cs - y * sn + d[0], c[1] + x * sn + y * cs + d[1]];
    });
    this.gimbal?.setCenter(sketchToWorld(this.plane!, [c[0] + d[0], c[1] + d[1]]).toArray() as Vec3);
    // Copying: the originals stay where they were (drawn there while the copy moves).
    if (copyMode.on && this.dragBase) {
      this.clearOverlays();
      this.drawGhosts(this.dragBase.filter((e) => this.selected.has(e.id)), 0xc9d3e6);
    }
  }

  /** Live: pull the given points to new places; constraints keep the rest consistent. */
  private moveRefs(refs: DragRef[], to: (q: Vec2) => Vec2): void {
    if (!this.sketchId) return;
    const base = this.dragBase ?? this.entities;
    this.dragBase ??= base;
    const r = solve(base, this.constraints, { drag: refs.map((d) => ({ ref: d.ref, to: to(d.at) })) });
    const id = this.sketchId;
    this.app.store.transient((doc) => {
      const f = doc.features.find((x) => x.id === id);
      if (f?.type === "sketch") f.entities = r.entities;
    });
  }

  private dragBase: SketchEntity[] | null = null;

  private endGeometryDrag(): void {
    // Copy on: the moved curves become copies; the originals go back where they were.
    if (this.sdrag?.kind === "gimbal" && copyMode.on && this.dragBase) {
      const base = this.dragBase;
      const moved = this.entities.filter((e) => this.selected.has(e.id));
      const copies = moved.map((e) => ({ ...e, id: uid() }));
      this.sdrag = null;
      this.dragBase = null;
      this.typing.reset();
      this.app.ui.setLabel(0, 0, null);
      this.commit([...base, ...copies]);
      // The copies are selected: the next drag copies them again.
      this.selected = new Set(copies.map((e) => e.id));
      this.selPts = [];
      this.gimbal?.setHot(null);
      return this.selectionChanged();
    }
    if (this.sdrag?.kind === "pivot") {
      this.sdrag = null;
      this.app.ui.setLabel(0, 0, null);
      this.gimbal?.setHot(null);
      return this.refreshGimbal();
    }
    this.sdrag = null;
    this.dragBase = null;
    this.typing.reset();
    this.app.ui.setLabel(0, 0, null);
    // One undo step for the whole drag.
    this.commit(this.entities);
    this.gimbal?.setHot(null);
    this.refreshGimbal();
  }

  /** The sketch gimbal sits at the centre of the selection (Select tool only). */
  private refreshGimbal(): void {
    const show = this.kind === "select" && this.phase === "draw" && (this.selected.size > 0 || this.selPts.length > 0) && !this.sdrag;
    if (!show) {
      this.gimbal?.dispose();
      this.gimbal = null;
      // Hidden while dragging too, so it doesn't jump around.
      this.copyToggle?.dispose();
      this.copyToggle = null;
      return;
    }
    const refs = this.dragRefs(this.selected, this.selPts);
    if (!refs.length) return;
    let c: Vec2 = [refs.reduce((s, r) => s + r.at[0], 0) / refs.length, refs.reduce((s, r) => s + r.at[1], 0) / refs.length];
    // A single line rotates about its chosen pivot (middle by default).
    const line = this.singleLine();
    if (line) {
      const t = this.pivotT?.line === line.id ? this.pivotT.t : 0.5;
      c = [line.a[0] + (line.b[0] - line.a[0]) * t, line.a[1] + (line.b[1] - line.a[1]) * t];
    }
    const plane = this.plane!;
    this.gimbal ??= new Gimbal(this.app.view, { axes: [plane.xDir, planeY(plane), plane.normal], parts: IN_PLANE });
    const g = this.gimbal;
    this.copyToggle ??= new CopyToggle(this.app.view, () => g.origin);
    this.gimbal.setCenter(sketchToWorld(plane, c).toArray() as Vec3);
  }

  /**
   * Left-drag on empty space: window selection of the curves entirely inside
   * the box (a drag never orbits in a sketch — that's the right button).
   */
  box(a: { x: number; y: number }, b: { x: number; y: number }, final: boolean, add: boolean): void {
    if (!final || this.phase !== "draw" || !this.plane || this.pts.length) return;
    if (this.kind !== "select" && !this.isSelectionTool()) return;
    const [x0, x1] = [Math.min(a.x, b.x), Math.max(a.x, b.x)];
    const [y0, y1] = [Math.min(a.y, b.y), Math.max(a.y, b.y)];
    const inside = (q: Vec2) => {
      const s = this.app.view.toScreen(sketchToWorld(this.plane!, q));
      return !!s && s[0] >= x0 && s[0] <= x1 && s[1] >= y0 && s[1] <= y1;
    };
    const picked = this.entities.filter((e) => entityPolylines(e).every((poly) => poly.every(inside))).map((e) => e.id);
    if (!add) {
      this.selected.clear();
      this.selPts = [];
    }
    for (const id of picked) this.selected.add(id);
    this.selectionChanged();
  }

  /** Right-click: end the current chain/shape (and keep what's drawn). */
  context(): void {
    if (this.kind === "spline" && this.pts.length >= 2) return this.finishSpline(false);
    if (this.pts.length) return this.resetDrawing();
    if (this.selected.size || this.selPts.length) this.clearSelection();
  }

  tap(p: ToolPointer, count: number): void {
    if (this.phase === "plane") return this.pickPlane(p);
    if (this.edit.picking) return this.pickForEdit(p);
    if (this.kind === "select" && this.tapSurfaceIn3D(p)) return;
    // A tap on empty space finishes what's waiting for Apply (like elsewhere).
    if (this.isSelectionTool() && this.selected.size && this.transformPending() && !this.curveAt(p) && !p.shift) {
      this.applyTransform();
      // Done with it: nothing left selected, so the next empty tap doesn't do it again.
      return this.clearSelection();
    }
    switch (this.kind) {
      case "select":
      case "move":
      case "scale":
      case "patternLinear":
        return this.tapSelect(p, count);
      case "patternCircular":
        // With curves selected and no centre yet, the tap places the centre (snapping to points).
        if (this.selected.size && !this.edit.pivot && !p.shift) {
          const s = this.snap(p);
          if (s) this.edit.pivot = s.uv;
          this.updatePanel();
          this.refreshPreview();
          return this.setHint("Set the count and angle, then Apply. Tap the Center field to move the centre.");
        }
        return this.tapSelect(p, count);
      case "rotate":
      case "mirror":
        return this.tapSelect(p, count);
      case "delete":
        return this.tapCurve(p, (id) => this.commit(this.entities.filter((e) => e.id !== id)));
      case "trim":
        if (memory.trim === "join") return this.tapCurve(p, (id, uv) => this.tapJoin(id, uv));
        return this.tapCurve(p, (id, uv) => this.commit(this.withoutBoundary(trim([...this.entities, ...this.boundary], id, uv))));
      case "align":
        return this.tapCurve(p, (id) => this.tapAlign(id));
      case "extend":
        return this.tapCurve(p, (id, uv) => this.tapExtend(id, uv));
      case "split":
        return this.tapCurve(p, (id, uv) => this.tapSplit(id, uv, p.shift));
      case "offset":
        return this.tapCurve(p, (id) => ((this.edit.offsetOf = id), this.updatePanel(), this.refreshPreview()));
      case "fillet":
        return this.tapFillet(p);
      case "project":
        return this.tapProject(p);
    }
    const s = this.snap(p);
    if (!s) return;
    this.cursor = s;
    this.addPoint(s.uv, count);
  }

  key(e: KeyboardEvent): boolean {
    if (e.ctrlKey || e.metaKey) return false;
    const k = e.key.toLowerCase();
    // Shift+letter: constraints.
    if (e.shiftKey && k.length === 1) {
      const b = CONSTRAINT_BUTTONS.find((x) => x.key.toLowerCase() === k);
      if (b) {
        const have = existingConstraints(b.type, this.constraints, this.selPts, this.pickedCurves());
        if (have.length) this.removeConstraints(have);
        else this.addConstraint(b.type);
        return true;
      }
    }
    // Two things selected with a distance shown: typing sets it.
    if (this.distDim && /^[0-9.,(]$/.test(e.key)) {
      this.distDim.focusWith(e.key === "," ? "." : e.key);
      return true;
    }
    // Typing while drawing: e.g. line length, Enter, angle, Enter.
    const keys = this.lockKeys();
    if (this.phase === "draw" && this.pts.length && keys.length && !this.dragging) {
      const starts = /^[0-9.,(-]$/.test(e.key);
      const routed = this.typing.active || starts || (k === "enter" && this.typedThisShape);
      if (routed) {
        const key = keys[this.lockIndex];
        this.typedThisShape = true;
        const used = this.typing.key(e, {
          kind: key === "ang" ? "angle" : key === "sides" ? "number" : "length",
          show: this.kind === "line" ? (text, bad) => this.lineDim?.setText(text, bad) : undefined,
          apply: (v) => this.applyLock(key, v),
          commit: () => {
            // Enter moves on to the next size — except the polygon's side count (Tab only).
            if (this.lockIndex < keys.length - 1 && keys[this.lockIndex + 1] !== "sides") {
              this.lockIndex++;
              this.setHint(`Now type the ${{ ang: "angle", h: "height", sides: "number of sides" }[keys[this.lockIndex]] ?? "next value"} (or Enter to keep it), then Enter.`);
              return;
            }
            this.lockIndex = 0;
            this.typedThisShape = false;
            if (this.cursor) this.addPoint(this.cursor.uv, 1);
            this.setHint();
          },
          cancel: () => (delete this.locks[key], this.refreshPreview()),
          next: () => (this.lockIndex < keys.length - 1 ? (this.lockIndex++, true) : false),
        });
        if (used) return true;
      }
    }
    if (k === "escape") {
      // Step out one level: the shape being drawn → the selection → the drawing tool (to Select) → the sketch.
      if (this.pts.length || this.edit.picking || this.edit.offsetOf || this.edit.extendFrom || this.edit.alignFrom || this.edit.filletFrom || this.filletEdit) this.resetDrawing();
      else if (this.selected.size || this.selPts.length) this.clearSelection();
      else if (this.kind !== "select" && this.phase === "draw" && this.sketchId) this.setKind("select");
      else this.app.setTool(null);
      return true;
    }
    if (k === "enter") {
      this.finishByKey();
      return true;
    }
    if ((k === "delete" || k === "backspace") && this.selected.size) {
      this.deleteSelected();
      return true;
    }
    const shortcuts: Record<string, Kind> = { l: "line", a: "arc", i: "spline", r: "rect", c: "circle", g: "polygon", p: "project", o: "offset", m: "move", s: "scale", t: "trim", e: "extend", v: "select" };
    if (shortcuts[k] && this.phase === "draw") {
      this.setKind(shortcuts[k]);
      return true;
    }
    return false;
  }

  // ------------------------------------------------------- plane picking

  private pickPlane(p: ToolPointer): void {
    const hit = this.app.view.pick(p.x, p.y, { edges: false, planes: true, planesFirst: true, profiles: true, edgeTolPx: 0 });
    if (!hit) return;
    if (hit.kind === "plane") {
      this.plane = this.app.view.planeOf(hit.id)!;
    } else if (hit.kind === "face") {
      const info = this.app.view.body(hit.body)?.faces[hit.face];
      if (!info?.plane) return this.app.ui.toast("Pick a flat face");
      this.plane = info.plane;
      this.attachedTo = { body: hit.body, center: info.center, normal: info.normal, area: info.area };
    } else if (hit.kind === "profile") {
      // Tapping an existing sketch continues it.
      this.sketchId = hit.sketch;
      this.plane = this.app.sketchPlane(hit.sketch) ?? null;
    } else return;
    this.beginDrawing();
  }

  // -------------------------------------------------------------- snapping

  private snap(p: ToolPointer): Snap | null {
    const plane = this.plane;
    if (!plane) return null;
    const w = this.app.view.rayToPlane(p.x, p.y, plane);
    if (!w) return null;
    const raw = toPlane(plane, w);
    if (p.shift) return { uv: raw };
    const s = settings.value.snap;
    const view = this.app.view;
    const screen = (uv: Vec2) => view.toScreen(sketchToWorld(plane, uv));
    const tol = p.tol * 1.4;

    const cands: { p: Vec2; label: string; ref?: PointRef }[] = [{ p: [0, 0], label: "Origin" }];
    if (s.guidePoints) {
      for (const e of this.entities) {
        // Named points first (they can be constrained), then midpoints etc.
        for (const q of pointsOf(e)) cands.push({ p: q.at, label: q.p === "c" ? "Center" : "Endpoint", ref: { e: e.id, p: q.p } });
        for (const g of guidePoints(e)) if (g.kind === "mid") cands.push({ p: g.p, label: "Midpoint" });
      }
      for (const e of this.boundary) for (const g of guidePoints(e)) cands.push({ p: g.p, label: g.kind === "mid" ? "Midpoint" : "Edge point" });
      for (const q of this.pts) cands.push({ p: q, label: "Point" });
    }
    if (s.points3d) {
      for (const b of view.bodyList) {
        for (const e of b.edges) {
          for (const v of [e.start, e.end]) {
            const off = Math.abs((v[0] - plane.origin[0]) * plane.normal[0] + (v[1] - plane.origin[1]) * plane.normal[1] + (v[2] - plane.origin[2]) * plane.normal[2]);
            if (off < 1e-4 || s.distantEdges) cands.push({ p: toPlane(plane, v), label: "3D point" });
          }
        }
      }
    }
    let best: { p: Vec2; label: string; d: number; ref?: PointRef } | null = null;
    for (const c of cands) {
      const sc = screen(c.p);
      if (!sc) continue;
      const d = Math.hypot(sc[0] - p.x, sc[1] - p.y);
      if (d < tol && (!best || d < best.d)) best = { ...c, d };
    }
    if (best) return { uv: [...best.p] as Vec2, label: best.label, ref: best.ref };

    const out: Snap = { uv: raw, guides: [] };
    const wpp = view.cam.worldPerPixel(view.height);
    if (s.guideLines) {
      // Align horizontally/vertically with nearby guide points.
      let bu: { v: number; from: Vec2 } | null = null;
      let bv: { v: number; from: Vec2 } | null = null;
      for (const c of cands) {
        const du = Math.abs(raw[0] - c.p[0]) / wpp;
        const dv = Math.abs(raw[1] - c.p[1]) / wpp;
        if (du < tol && (!bu || du < Math.abs(raw[0] - bu.v) / wpp)) bu = { v: c.p[0], from: c.p };
        if (dv < tol && (!bv || dv < Math.abs(raw[1] - bv.v) / wpp)) bv = { v: c.p[1], from: c.p };
      }
      if (bu) out.uv = [bu.v, out.uv[1]];
      if (bv) out.uv = [out.uv[0], bv.v];
      if (bu || bv) out.label = bu && bv ? "Aligned" : bu ? "Vertical" : "Horizontal";
      // Grid-snap only the coordinates that aren't aligned to a guide.
      if (s.grid) {
        const step = view.grid.step;
        out.uv = [bu ? out.uv[0] : Math.round(out.uv[0] / step) * step, bv ? out.uv[1] : Math.round(out.uv[1] / step) * step];
      }
      // Guides run from the reference point straight to the final point.
      if (bu) out.guides!.push([bu.from, out.uv]);
      if (bv) out.guides!.push([bv.from, out.uv]);
      return out;
    }
    if (s.grid) {
      const step = view.grid.step;
      out.uv = [Math.round(out.uv[0] / step) * step, Math.round(out.uv[1] / step) * step];
    }
    return out;
  }

  // -------------------------------------------------------------- drawing

  /** Cursor after applying typed (locked) dimensions. */
  private lockedCursor(): Vec2 | null {
    const c = this.cursor?.uv;
    if (!c) return null;
    const a = this.pts[0];
    const L = this.locks;
    if (!a) return c;
    const last = this.pts[this.pts.length - 1];
    switch (this.kind) {
      case "line": {
        let ang = Math.atan2(c[1] - last[1], c[0] - last[0]);
        let len = Math.hypot(c[0] - last[0], c[1] - last[1]);
        if (L.ang !== undefined) ang = (L.ang * Math.PI) / 180;
        if (L.len !== undefined) len = L.len;
        return [last[0] + Math.cos(ang) * len, last[1] + Math.sin(ang) * len];
      }
      case "rect": {
        if (this.pts.length !== 1) return c;
        const k = memory.rect === "center" ? 0.5 : 1;
        const sx = Math.sign(c[0] - a[0]) || 1;
        const sy = Math.sign(c[1] - a[1]) || 1;
        return [L.w !== undefined ? a[0] + sx * L.w * k : c[0], L.h !== undefined ? a[1] + sy * L.h * k : c[1]];
      }
      case "circle":
      case "polygon": {
        if (L.r === undefined) return c;
        // A circle's typed size is its diameter; a polygon's, its radius.
        const r = this.kind === "circle" ? L.r / 2 : L.r;
        const ang = Math.atan2(c[1] - a[1], c[0] - a[0]);
        return [a[0] + Math.cos(ang) * r, a[1] + Math.sin(ang) * r];
      }
      case "ellipse": {
        if (this.pts.length === 1 && L.rx !== undefined) {
          const ang = Math.atan2(c[1] - a[1], c[0] - a[0]);
          return [a[0] + (Math.cos(ang) * L.rx) / 2, a[1] + (Math.sin(ang) * L.rx) / 2];
        }
        return c;
      }
    }
    return c;
  }

  private lastLineId: string | null = null;
  private chainFirstId: string | null = null;

  /**
   * Touch screens (numpad on): after a line's second tap, its length in a box
   * by it — type it on the numpad; the line keeps its direction.
   */
  private lineBox: { id: string; widget: DimWidget; value: number; edited: boolean } | null = null;

  private showLineBox(id: string): void {
    this.closeLineBox();
    const l = this.entities.find((e) => e.id === id);
    if (l?.kind !== "line" || !this.plane) return;
    const len = Math.hypot(l.b[0] - l.a[0], l.b[1] - l.a[1]);
    const widget = new DimWidget(this.app.view, {
      value: len,
      boxAt: "side",
      focus: true,
      onInput: (v) => v > 0 && this.resizeLine(id, v),
      onCommit: () => this.closeLineBox(),
    });
    this.lineBox = { id, widget, value: len, edited: false };
    this.placeLineBox();
  }

  private placeLineBox(): void {
    const b = this.lineBox;
    const l = b && this.entities.find((e) => e.id === b.id);
    if (!b || l?.kind !== "line") return;
    const w = (q: Vec2) => sketchToWorld(this.plane!, q, 0.02).toArray() as Vec3;
    b.widget.set(w(l.a), w(l.b));
  }

  /** Live: the line gets the typed length (along its direction); the chain carries on from its new end. */
  private resizeLine(id: string, v: number): void {
    const l = this.entities.find((e) => e.id === id);
    if (l?.kind !== "line" || !this.sketchId) return;
    const d: Vec2 = [l.b[0] - l.a[0], l.b[1] - l.a[1]];
    const L = Math.hypot(...d) || 1;
    const nb: Vec2 = [l.a[0] + (d[0] / L) * v, l.a[1] + (d[1] / L) * v];
    const last = this.pts[this.pts.length - 1];
    if (last && samePt(last, l.b)) this.pts[this.pts.length - 1] = nb;
    const sid = this.sketchId;
    this.app.store.transient((doc) => {
      const f = doc.features.find((x) => x.id === sid);
      if (f?.type === "sketch") f.entities = f.entities.map((e) => (e.id === id ? { ...l, b: nb } : e));
    });
    this.lineBox!.value = v;
    this.lineBox!.edited = true;
    this.placeLineBox();
    this.refreshPreview();
  }

  /** Done typing: the length becomes a driving dimension (one undo step). */
  private closeLineBox(): void {
    const b = this.lineBox;
    if (!b) return;
    this.lineBox = null;
    b.widget.dispose();
    const l = this.entities.find((e) => e.id === b.id);
    if (l?.kind !== "line") return;
    // Nothing typed: nothing to record.
    if (!b.edited) return;
    const len = Math.hypot(l.b[0] - l.a[0], l.b[1] - l.a[1]);
    const cs = this.constraints.filter((c) => !(c.type === "dim" && c.prop === "length" && c.curves?.length === 1 && c.curves[0] === b.id));
    this.opLabel = "Line length";
    this.commit(this.entities, [...cs, { id: uid(), type: "dim", curves: [b.id], prop: "length", value: len }]);
  }

  private addPoint(uv: Vec2, count: number): void {
    // The next tap finishes the length being typed for the line before.
    if (this.lineBox) this.closeLineBox();
    const c = this.lockedCursor() ?? uv;
    const pt = this.pts.length ? c : uv;
    const k = this.kind;
    const locked = Object.keys(this.locks).length > 0;
    // A typed size moves the point off whatever it snapped to.
    const snapRef = locked ? undefined : this.cursor?.ref;
    if (!this.pts.length) this.startRef = snapRef ?? null;
    if (k === "line") {
      if (count >= 2 || (this.pts.length && samePt(pt, this.pts[this.pts.length - 1]))) return this.resetDrawing();
      if (this.pts.length) {
        const start = this.pts[0];
        const a = this.pts[this.pts.length - 1];
        const id = uid();
        const cs: SketchConstraint[] = [];
        const co = (p: PointRef, q: PointRef): SketchConstraint => ({ id: uid(), type: "coincident", pts: [p, q] });
        // A chain stays joined; the rest (snaps, H/V) only with Auto constrain on.
        const auto = settings.value.autoConstrain;
        if (this.lastLineId) cs.push(co({ e: this.lastLineId, p: "b" }, { e: id, p: "a" }));
        else if (this.startRef && auto) cs.push(co(this.startRef, { e: id, p: "a" }));
        const closes = this.pts.length > 1 && samePt(pt, start) && this.chainFirstId;
        if (closes) cs.push(co({ e: id, p: "b" }, { e: this.chainFirstId!, p: "a" }));
        else if (snapRef && auto) cs.push(co({ e: id, p: "b" }, snapRef));
        if (auto && Math.abs(pt[1] - a[1]) < 1e-9) cs.push({ id: uid(), type: "horizontal", curves: [id] });
        else if (auto && Math.abs(pt[0] - a[0]) < 1e-9) cs.push({ id: uid(), type: "vertical", curves: [id] });
        // Typed values become driving dimensions.
        if (this.locks.len !== undefined) cs.push({ id: uid(), type: "dim", curves: [id], prop: "length", value: this.locks.len });
        if (this.locks.ang !== undefined && !cs.some((x) => x.type === "horizontal" || x.type === "vertical")) cs.push({ id: uid(), type: "dim", curves: [id], prop: "angle", value: this.locks.ang });
        this.commitAdd([{ id, kind: "line", a, b: pt }], cs);
        this.lastLineId = id;
        this.chainFirstId ??= id;
        // Closing the chain on its first point ends it.
        if (closes || (this.pts.length > 1 && samePt(pt, start))) return this.resetDrawing();
        // Touch: its length in a box right away, for the numpad.
        if (settings.value.numpad && this.locks.len === undefined) queueMicrotask(() => this.showLineBox(id));
      }
      this.pts.push(pt);
      this.locks = {};
      this.typedThisShape = false;
    } else if (k === "spline") {
      if (count >= 2) return this.finishSpline(false);
      if (this.pts.length >= 3 && this.screenDist(pt, this.pts[0]) < 14) return this.finishSpline(true);
      this.pts.push(pt);
    } else if (k === "text") {
      this.pts = [pt];
    } else {
      this.pts.push(pt);
      const need = k === "arc" || k === "ellipse" || (k === "rect" && memory.rect === "3pt") ? 3 : 2;
      if (this.pts.length >= need) {
        const e = this.buildShape(this.pts);
        const cs: SketchConstraint[] = [];
        if (e) {
          const L = this.locks;
          const dim = (prop: string, value?: number) => value !== undefined && cs.push({ id: uid(), type: "dim", curves: [e.id], prop, value });
          if (e.kind === "rect") {
            const f = memory.rect === "center" ? 1 : 1;
            dim("w", L.w !== undefined ? L.w * (memory.rect === "center" ? 2 : 1) * f : undefined);
            dim("h", L.h !== undefined ? L.h * (memory.rect === "center" ? 2 : 1) : undefined);
          }
          if (e.kind === "circle") dim("diameter", L.r);
          if (e.kind === "polygon") dim("radius", L.r);
          if (e.kind === "ellipse") (dim("dx", L.rx), dim("dy", L.ry));
          // A centre placed on an existing point stays on it.
          if (settings.value.autoConstrain && (e.kind === "circle" || e.kind === "polygon" || e.kind === "ellipse" || (e.kind === "rect" && memory.rect === "center")) && this.startRef) {
            cs.push({ id: uid(), type: "coincident", pts: [{ e: e.id, p: "c" }, this.startRef] });
          }
        }
        this.pts = [];
        this.locks = {};
        this.typedThisShape = false;
        this.app.ui.setLabel(0, 0, null);
        if (e) this.commitAdd([e], cs);
      }
    }
    this.updatePanel();
    this.refreshPreview();
  }

  private finishByKey(): void {
    if (this.kind === "spline") return this.finishSpline(false);
    if (this.kind === "text" && this.pts.length) return void this.commitText();
    if (this.kind === "offset" && this.edit.offsetOf) return this.applyOffset();
    if (this.isSelectionTool() && this.selected.size) return this.applyTransform();
    if (this.pts.length && Object.keys(this.locks).length && this.cursor) return this.addPoint(this.cursor.uv, 1);
    this.resetDrawing();
  }

  private finishSpline(closed: boolean): void {
    if (this.pts.length >= 2) this.commitAdd([{ id: uid(), kind: "spline", points: this.pts, closed: closed && this.pts.length >= 3, mode: memory.spline }]);
    this.resetDrawing();
  }

  /** The entity the current points describe (also used for the preview). */
  private buildShape(pts: Vec2[]): SketchEntity | null {
    const [a, b, c] = pts;
    const id = uid();
    switch (this.kind) {
      case "line":
        return b ? { id, kind: "line", a, b } : null;
      case "arc":
        if (!b) return null;
        if (!c) return { id, kind: "line", a, b };
        return arcFrom3(a, c, b) ? { id, kind: "arc", a, m: c, b } : null;
      case "rect": {
        if (!b) return null;
        if (memory.rect === "3pt") {
          const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
          const w = Math.hypot(b[0] - a[0], b[1] - a[1]);
          if (!c) return w > 0 ? { id, kind: "line", a, b } : null;
          // Height = signed distance of c from the a–b edge.
          const h = (c[1] - a[1]) * Math.cos(ang) - (c[0] - a[0]) * Math.sin(ang);
          const center: Vec2 = [(a[0] + b[0]) / 2 - (Math.sin(ang) * h) / 2, (a[1] + b[1]) / 2 + (Math.cos(ang) * h) / 2];
          return Math.abs(h) > 1e-9 ? { id, kind: "rect", center, w, h: Math.abs(h), rotation: ang } : null;
        }
        const center: Vec2 = memory.rect === "center" ? a : [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        const w = Math.abs(b[0] - a[0]) * (memory.rect === "center" ? 2 : 1);
        const h = Math.abs(b[1] - a[1]) * (memory.rect === "center" ? 2 : 1);
        return w > 1e-9 && h > 1e-9 ? { id, kind: "rect", center, w, h, rotation: 0 } : null;
      }
      case "circle": {
        const r = b ? Math.hypot(b[0] - a[0], b[1] - a[1]) : 0;
        return r > 1e-9 ? { id, kind: "circle", center: a, radius: r } : null;
      }
      case "polygon": {
        const r = b ? Math.hypot(b[0] - a[0], b[1] - a[1]) : 0;
        return r > 1e-9 ? { id, kind: "polygon", center: a, radius: r, sides: memory.sides, angle: Math.atan2(b[1] - a[1], b[0] - a[0]) } : null;
      }
      case "ellipse": {
        if (!b) return null;
        const rx = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const rot = Math.atan2(b[1] - a[1], b[0] - a[0]);
        let ry = rx / 2;
        if (c) ry = Math.abs((c[1] - a[1]) * Math.cos(rot) - (c[0] - a[0]) * Math.sin(rot));
        if (this.locks.ry !== undefined) ry = this.locks.ry / 2;
        return rx > 1e-9 && ry > 1e-9 ? { id, kind: "ellipse", center: a, rx, ry, rotation: rot } : null;
      }
      case "spline":
        return pts.length >= 2 ? { id, kind: "spline", points: pts, closed: false, mode: memory.spline } : null;
    }
    return null;
  }

  private resetDrawing(): void {
    this.pts = [];
    this.locks = {};
    this.lastLineId = null;
    this.chainFirstId = null;
    this.startRef = null;
    this.typedThisShape = false;
    this.lockIndex = 0;
    this.typing.reset();
    this.edit.picking = undefined;
    this.edit.offsetOf = undefined;
    this.edit.extendFrom = this.edit.alignFrom = undefined;
    this.edit.filletFrom = undefined;
    this.cancelFillet();
    this.clearPreviewJoin();
    this.clearOverlays();
    this.hideLineDim();
    this.app.ui.setLabel(0, 0, null);
    this.updatePanel();
    this.setHint();
  }

  // -------------------------------------------------------------- preview

  // ----------------------------------------------- linear pattern gimbal

  /** Arrows showing which way a linear pattern runs: drag one to set direction and spacing. */
  private patGimbal: Gimbal | null = null;
  private patDrag: { axis: number; from: ToolPointer; center: Vec2 } | null = null;
  private patBox: PatternBox | null = null;
  private patMeasure: "between" | "total" = "between";

  private selectionCentre(): Vec2 | null {
    const sel = this.entities.filter((e) => this.selected.has(e.id));
    return sel.length ? centroidOf(sel) : null;
  }

  private refreshPatternGimbal(): void {
    const c = this.kind === "patternLinear" && this.phase === "draw" && this.plane ? this.selectionCentre() : null;
    if (!c) {
      this.patGimbal?.dispose();
      this.patGimbal = null;
      this.patBox?.dispose();
      this.patBox = null;
      return;
    }
    const plane = this.plane!;
    // Turned so its first arrow points the way the pattern runs.
    const ang = Math.hypot(this.edit.dx, this.edit.dy) > 1e-12 ? Math.atan2(this.edit.dy, this.edit.dx) : 0;
    const u = sketchToWorld({ ...plane, origin: [0, 0, 0] }, [Math.cos(ang), Math.sin(ang)]).toArray() as Vec3;
    const v = sketchToWorld({ ...plane, origin: [0, 0, 0] }, [-Math.sin(ang), Math.cos(ang)]).toArray() as Vec3;
    if (!this.patGimbal || this.patAng !== ang) {
      this.patGimbal?.dispose();
      this.patGimbal = new Gimbal(this.app.view, { axes: [u, v, plane.normal], parts: (q) => q.kind === "axis" && q.i < 2 });
      this.patAng = ang;
    }
    this.patGimbal.setCenter(sketchToWorld(plane, c).toArray() as Vec3);
  }
  private patAng = 0;

  private startPatternDrag(p: ToolPointer): boolean {
    const part = this.patGimbal?.hit(p);
    const c = this.selectionCentre();
    if (!part || part.kind !== "axis" || !c) return false;
    this.patDrag = { axis: part.i, from: p, center: c };
    this.patBox?.dispose();
    this.patBox = null;
    return true;
  }

  private dragPattern(p: ToolPointer): void {
    const dr = this.patDrag!;
    const plane = this.plane!;
    // The arrow's direction in the sketch.
    const a = this.patAng + (dr.axis === 1 ? Math.PI / 2 : 0);
    const dir2: Vec2 = [Math.cos(a), Math.sin(a)];
    const dirW = sketchToWorld({ ...plane, origin: [0, 0, 0] }, dir2).toArray() as Vec3;
    const view = this.app.view;
    let d = axisDrag(view, sketchToWorld(plane, dr.center).toArray() as Vec3, dirW, dr.from, p);
    const step = niceStepOf(view.cam.worldPerPixel(view.height) * 4);
    if (!p.shift) d = Math.round(d / step) * step;
    if (Math.abs(d) < 1e-12) return;
    // The drag sets the spacing between neighbours (or the whole run, in Total mode).
    const n = Math.max(2, this.edit.count);
    const spacing = this.patMeasure === "total" ? d / (n - 1) : d;
    this.edit.dx = dir2[0] * spacing;
    this.edit.dy = dir2[1] * spacing;
    this.app.ui.setLabel(p.x, p.y, `${fmtLen(Math.abs(d))} · ${n} copies`);
    this.refreshPreview();
  }

  private endPatternDrag(): void {
    this.patDrag = null;
    this.app.ui.setLabel(0, 0, null);
    this.patGimbal?.setHot(null);
    this.refreshPatternGimbal();
    this.updatePanel();
    this.showPatternBox();
  }

  /** Count and spacing, typed right where the pattern is. */
  private showPatternBox(): void {
    const c = this.selectionCentre();
    if (!c || !this.plane) return;
    const spacing = Math.hypot(this.edit.dx, this.edit.dy);
    const n = Math.max(2, this.edit.count);
    this.patBox?.dispose();
    this.patBox = new PatternBox(this.app.view, {
      count: n,
      spacing: this.patMeasure === "total" ? spacing * (n - 1) : spacing,
      measure: this.patMeasure,
      onChange: (v) => {
        this.patMeasure = v.measure;
        this.edit.count = v.count;
        const each = v.measure === "total" ? v.spacing / Math.max(1, v.count - 1) : v.spacing;
        const L = Math.hypot(this.edit.dx, this.edit.dy) || 1;
        const dir: Vec2 = L > 1e-12 && spacing > 1e-12 ? [this.edit.dx / L, this.edit.dy / L] : [Math.cos(this.patAng), Math.sin(this.patAng)];
        this.edit.dx = dir[0] * each;
        this.edit.dy = dir[1] * each;
        this.refreshPreview();
        this.updatePanel();
      },
      onCommit: () => {
        this.patBox?.dispose();
        this.patBox = null;
        this.applyTransform();
      },
    });
    const end: Vec2 = [c[0] + this.edit.dx * (n - 1), c[1] + this.edit.dy * (n - 1)];
    this.patBox.place(sketchToWorld(this.plane, end).toArray() as Vec3);
  }

  private refreshPreview(p?: ToolPointer): void {
    if (this.phase !== "draw" || !this.plane) return;
    this.refreshPatternGimbal();
    this.clearOverlays();
    const ghosts: SketchEntity[] = [];
    let label: string | null = null;
    const c = this.lockedCursor();
    if (["line", "arc", "rect", "circle", "polygon", "ellipse", "spline"].includes(this.kind) && this.pts.length && c) {
      const pts = this.kind === "line" ? [this.pts[this.pts.length - 1], c] : [...this.pts, c];
      const e = this.buildShape(pts);
      // Arc, first end placed: a dashed arc to the pointer shows what's coming (the bend comes with the third tap).
      if (this.kind === "arc" && this.pts.length === 1 && e?.kind === "line") {
        const [a, b] = [e.a, e.b];
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (L > 1e-9) {
          const m: Vec2 = [(a[0] + b[0]) / 2 - ((b[1] - a[1]) / L) * L * 0.3, (a[1] + b[1]) / 2 + ((b[0] - a[0]) / L) * L * 0.3];
          this.drawGhosts([{ id: "arc-preview", kind: "arc", a, m, b }], 0xffc23d, true);
        }
        label = dimLabel(e, pts);
      } else if (e?.kind === "line") this.showLineDim(e.a, e.b);
      else {
        if (e) ghosts.push(e);
        label = dimLabel(e, pts);
      }
    }
    if (!(this.kind === "line" && this.pts.length && c)) this.hideLineDim();
    if (this.kind === "text" && this.pts.length) {
      void textEntities(this.text || " ", this.pts[0], memory.textSize, 0, memory.textFont).then((es) => {
        if (this.kind !== "text" || !this.pts.length) return;
        this.drawGhosts(es);
      });
    }
    if (this.kind === "offset" && this.edit.offsetOf) ghosts.push(...this.offsetResult());
    if (this.isSelectionTool() && this.selected.size) ghosts.push(...this.transformed(true));
    this.drawGhosts(ghosts);
    // Midpoints of lines and sides: snap targets, shown so you can aim for them.
    if (settings.value.showGuidePoints) {
      const mids = [...this.entities, ...this.boundary].flatMap((e) => guidePoints(e).filter((g) => g.kind === "mid").map((g) => sketchToWorld(this.plane!, g.p, 0.01)));
      if (mids.length) {
        const m = new Points(new BufferGeometry().setFromPoints(mids), new PointsMaterial({ color: 0x9fb4d6, size: 6, sizeAttenuation: false, depthTest: false, transparent: true, opacity: 0.85 }));
        m.renderOrder = 9;
        this.addOverlay(m);
      }
    }
    // Snap marker + guide lines.
    if (this.cursor && settings.value.showGuidePoints) {
      const marker = new Points(new BufferGeometry().setFromPoints([sketchToWorld(this.plane, c ?? this.cursor.uv, 0.01)]), dotMaterial({ color: this.cursor.label ? 0x4fd18b : 0xffc23d, size: 11 }));
      marker.renderOrder = 10;
      this.addOverlay(marker);
      for (const [g0, g1] of this.cursor.guides ?? []) {
        const line = new Line(new BufferGeometry().setFromPoints([sketchToWorld(this.plane, g0), sketchToWorld(this.plane, g1)]), new LineDashedMaterial({ color: 0x4fd18b, dashSize: this.app.view.cam.worldPerPixel(this.app.view.height) * 5, gapSize: this.app.view.cam.worldPerPixel(this.app.view.height) * 4, depthTest: false }));
        line.computeLineDistances();
        this.addOverlay(line);
      }
    }
    if (p) {
      const hint = settings.value.showSnapHints && this.cursor?.label ? this.cursor.label : null;
      // While a shape is being drawn its size can be typed.
      const text = [label, hint].filter(Boolean).join("  ·  ");
      this.app.ui.setLabel(p.x, p.y, text ? (label ? `${text}  · type a value` : text) : null);
    }
    this.app.view.requestRender();
  }

  /** A typed size; "sides" (polygon) is a count, not a lock. */
  private applyLock(key: string, v: number): void {
    if (key === "sides") {
      memory.sides = Math.max(3, Math.min(64, Math.round(v)));
      this.updateMenu();
      this.app.ui.updatePanelValues([memory.sides]);
    } else this.locks[key] = v;
    this.refreshPreview();
  }

  private lineDim: DimWidget | null = null;

  /** Length of the line being drawn: dimension line with arrows + a box you can type into. */
  private showLineDim(a: Vec2, b: Vec2): void {
    const plane = this.plane!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-9) return this.hideLineDim();
    const w = (q: Vec2) => sketchToWorld(plane, q, 0.02).toArray() as Vec3;
    this.lineDim ??= new DimWidget(this.app.view, {
      solidColor: 0xffc23d,
      boxAt: "side",
      value: len,
      onInput: (v) => {
        if (v <= 0) return;
        this.locks.len = v;
        this.typedThisShape = true;
        this.refreshPreview();
      },
      onCommit: () => this.placeTyped(),
    });
    this.lineDim.set(w(a), w(b));
    if (this.typing.active) this.lineDim.setText(`${this.typing.text}`);
    else this.lineDim.setValue(len);
  }

  private hideLineDim(): void {
    this.lineDim?.dispose();
    this.lineDim = null;
  }

  /** Enter after typing a size: place the point at that size. */
  private placeTyped(): void {
    this.lockIndex = 0;
    this.typedThisShape = false;
    this.typing.reset();
    if (this.cursor) this.addPoint(this.cursor.uv, 1);
    this.setHint();
  }

  private drawGhosts(es: SketchEntity[], color = 0xffc23d, dashed = false): void {
    const wpp = this.app.view.cam.worldPerPixel(this.app.view.height);
    for (const e of es) {
      for (const poly of entityPolylines(e)) {
        const mat = dashed ? new LineDashedMaterial({ color, depthTest: false, dashSize: wpp * 7, gapSize: wpp * 5 }) : new LineBasicMaterial({ color, depthTest: false });
        const line = new Line(new BufferGeometry().setFromPoints(poly.map((q) => sketchToWorld(this.plane!, q, 0.02))), mat);
        if (dashed) line.computeLineDistances();
        line.renderOrder = 9;
        this.addOverlay(line);
      }
    }
    this.app.view.requestRender();
  }

  private addOverlay(o: Line | Points): void {
    this.overlays.push(o);
    this.app.view.overlay.add(o);
  }

  private clearOverlays(): void {
    for (const o of this.overlays) {
      this.app.view.overlay.remove(o);
      o.geometry.dispose();
    }
    this.overlays = [];
    this.app.view.requestRender();
  }

  private screenDist(a: Vec2, b: Vec2): number {
    const sa = this.app.view.toScreen(sketchToWorld(this.plane!, a));
    const sb = this.app.view.toScreen(sketchToWorld(this.plane!, b));
    return sa && sb ? Math.hypot(sa[0] - sb[0], sa[1] - sb[1]) : Infinity;
  }

  // ------------------------------------------------------------- commits

  /** Save curves (and constraints); constraints on deleted curves are dropped. */
  /** Curves the last step made (Select last picks them). */
  private lastMade: string[] = [];

  /** Name of the step being committed (else it's named after the tool). */
  private opLabel: string | null = null;

  /** The step a commit records in the sketch's log. */
  private stepName(entities: SketchEntity[], constraints: SketchConstraint[]): string {
    if (this.opLabel) return this.opLabel;
    if (JSON.stringify(entities) === JSON.stringify(this.entities)) return JSON.stringify(constraints) === JSON.stringify(this.constraints) ? "Edit" : "Constraint";
    const k = this.kind;
    if (k === "trim") return memory.trim === "join" ? "Join lines" : "Trim";
    if (k === "select") return entities.length < this.entities.length ? "Delete" : "Edit";
    if (k === "text") return "Text";
    return titleOf(k);
  }

  private commit(entities: SketchEntity[], constraints: SketchConstraint[] = this.constraints): void {
    const store = this.app.store;
    const ids = new Set(entities.map((e) => e.id));
    const cs = constraints.filter((c) => refsOf(c).every((id) => ids.has(id)));
    // One line per step in History (repeats of the same step are counted).
    const op = this.stepName(entities, constraints);
    this.opLabel = null;
    const log = [...(this.sketch?.log ?? [])];
    const last = log[log.length - 1];
    // What this step made (kept across repeats of the same step, for "Select last").
    const before = new Set(this.entities.map((e) => e.id));
    const made = entities.filter((e) => !before.has(e.id)).map((e) => e.id);
    if (last?.op === op) {
      log[log.length - 1] = { op, n: last.n + 1 };
      this.lastMade = [...this.lastMade, ...made];
    } else {
      log.push({ op, n: 1 });
      this.lastMade = made;
    }
    const patch = cs.length ? { entities, constraints: cs, log } : { entities, constraints: undefined, log };
    if (this.sketchId && this.sketch) {
      store.update(this.sketchId, patch);
    } else {
      const f: SketchFeature = { ...store.newIdentity("sketch"), type: "sketch", plane: this.plane!, attachedTo: this.attachedTo, ...patch };
      store.add(f);
      this.sketchId = f.id;
    }
    this.refreshConstraintUI();
    // Curves went away: no hover mark, snap point or middle point of theirs stays drawn.
    if (entities.length < before.size) {
      this.app.setHover(null);
      if (this.phase === "draw" && !this.sdrag) this.refreshPreview();
    }
    // Tools with nothing to set show the step just done.
    if (["trim", "extend", "split", "align", "delete", "project"].includes(this.kind)) this.updatePanel();
  }

  private commitAdd(es: SketchEntity[], cs: SketchConstraint[] = []): void {
    this.commit([...this.entities, ...es.map((e) => (this.construction ? { ...e, construction: true } : e))], [...this.constraints, ...cs]);
  }

  private async commitText(): Promise<void> {
    if (!this.pts.length || !this.text.trim()) return;
    const es = await textEntities(this.text, this.pts[0], memory.textSize, 0, memory.textFont);
    this.commitAdd(es);
    this.resetDrawing();
  }

  // --------------------------------------------------------- edit tools

  private isSelectionTool(): boolean {
    return ["move", "scale", "patternLinear", "patternCircular", "rotate", "mirror"].includes(this.kind);
  }

  private curveAt(p: ToolPointer): { id: string; uv: Vec2 } | null {
    const hit = this.app.view.pick(p.x, p.y, { curves: this.sketchId ?? true, profiles: false, bodies: false, planes: false, axes: false, edgeTolPx: p.tol });
    // A point (end, centre…) stands for its curve here — small shapes are mostly points when zoomed out.
    if ((hit?.kind !== "curve" && hit?.kind !== "point") || hit.sketch !== this.sketchId) return null;
    const w = this.app.view.rayToPlane(p.x, p.y, this.plane!);
    return { id: hit.entity, uv: w ? toPlane(this.plane!, w) : [0, 0] };
  }

  /**
   * Extend in two taps: the half of the first curve, then the half of the
   * second — both picked ends run along their own line/circle until they meet.
   */
  private tapAlign(id: string): void {
    const all = [...this.entities, ...this.boundary];
    const e = all.find((x) => x.id === id);
    if (e?.kind !== "line") return this.app.ui.toast("Align works on lines");
    const first = this.edit.alignFrom;
    if (!first) {
      if (id.startsWith("bnd-")) return this.app.ui.toast("Pick a line of this sketch to move (face edges stay)");
      this.edit.alignFrom = id;
      this.app.setSelection([{ kind: "curve", sketch: this.sketchId ?? "", entity: id }]);
      return this.setHint("Now tap the line it should line up with.");
    }
    this.edit.alignFrom = undefined;
    this.app.setSelection([]);
    this.setHint();
    if (first === id) return;
    const next = alignLine(this.entities, first, e);
    if (!next) return this.app.ui.toast("Those lines can't be aligned");
    // Constraints that held the old position would pull it back: keep the rest.
    const moved = new Set(next.filter((x, i) => x !== this.entities[i]).map((x) => x.id));
    this.commit(next, this.constraints.filter((c) => c.type === "coincident" || c.type === "horizontal" || c.type === "vertical" || !refsOf(c).some((r) => moved.has(r))));
  }

  /** Trim's Join mode: a line and the line on its axis it touches become one. */
  private tapJoin(id: string, uv: Vec2): void {
    if (id.startsWith("bnd-")) return this.app.ui.toast("Face edges can't be joined");
    const out = joinCollinear(this.entities, id, uv);
    if (!out) return this.app.ui.toast("No line on the same axis touches this one");
    const joined = out.entities.find((x) => x.id === id)!;
    const old = new Map(this.entities.map((x) => [x.id, x]));
    const ends = [["a", (joined as { a: Vec2 }).a], ["b", (joined as { b: Vec2 }).b]] as const;
    const tol = 1e-6 * (1 + Math.hypot(...((joined as { a: Vec2 }).a)));
    // Point constraints follow the outer ends; ones at the old joint go.
    const cons: SketchConstraint[] = [];
    for (const c of this.constraints) {
      if (c.curves?.some((x) => x === out.removed) || (c.type === "dim" && c.curves?.includes(id))) continue;
      let ok = true;
      const pts = (c.pts ?? []).map((r) => {
        if (r.e !== id && r.e !== out.removed) return r;
        const at = pointOf(old.get(r.e)!, r.p);
        const end = at && ends.find(([, q]) => Math.hypot(q[0] - at[0], q[1] - at[1]) < tol);
        if (!end) ok = false;
        return end ? { e: id, p: end[0] } : r;
      });
      if (!ok) continue;
      // Both points now on the same line end: nothing left to hold together.
      if (pts.length === 2 && pts[0].e === pts[1].e && pts[0].p === pts[1].p) continue;
      cons.push(c.pts ? { ...c, pts } : c);
    }
    this.commit(out.entities, cons);
  }

  private tapExtend(id: string, uv: Vec2): void {
    const first = this.edit.extendFrom;
    const all = [...this.entities, ...this.boundary];
    if (!first) {
      const e = all.find((x) => x.id === id);
      if (!e || !endNear(e, uv)) return this.app.ui.toast("Pick a line, an arc or an open spline");
      this.edit.extendFrom = { id, at: uv };
      this.app.setSelection([{ kind: "curve", sketch: this.sketchId ?? "", entity: id }]);
      this.setHint("Now tap the half of the curve it should meet (or the same half again to extend to the next curve).");
      return;
    }
    this.edit.extendFrom = undefined;
    this.app.setSelection([]);
    this.setHint();
    const a = all.find((x) => x.id === first.id);
    const b = all.find((x) => x.id === id);
    const endA = a && endNear(a, first.at);
    const endB = b && endNear(b, uv);
    // Same half twice: the old one-tap extend, to the next curve in the way.
    if (first.id === id && endA === endB) {
      const next = extend(all, id, uv);
      if (next) this.commit(this.withoutBoundary(next));
      else this.app.ui.toast("Nothing to extend to");
      return;
    }
    const next = joinEnds(all, first, { id, at: uv });
    if (!next) return this.app.ui.toast("These can't meet (parallel, or the circles don't cross)");
    const closed = next.find((x) => x.id === first.id)?.kind === "circle";
    // The ends now touch: keep them together.
    const keep =
      !closed && endA && endB && !first.id.startsWith("bnd-") && !id.startsWith("bnd-")
        ? [...this.constraints, { id: uid(), type: "coincident" as const, pts: [{ e: first.id, p: endA }, { e: id, p: endB }] }]
        : this.constraints;
    this.commit(this.withoutBoundary(next), keep);
  }

  /**
   * Camera turned away from the sketch view: tapping a closed region (not a
   * curve) finishes the sketch and selects that region, with its extrude arrow
   * ready to drag.
   */
  private tapSurfaceIn3D(p: ToolPointer): boolean {
    const view = this.app.view;
    const facing = Math.abs(dot(view.cam.viewDir().toArray() as Vec3, this.plane!.normal));
    if (facing > 0.995 || this.curveAt(p)) return false;
    const hit = view.pick(p.x, p.y, { profiles: true, curves: false, bodies: false, planes: false, axes: false, images: false, edgeTolPx: p.tol });
    if (hit?.kind !== "profile") return false;
    this.app.setTool(null);
    this.app.setSelection([{ kind: "profile", sketch: hit.sketch, region: hit.region }]);
    return true;
  }

  /** Modify tools: a tap on a curve uses it; on empty space it cancels, then goes back to Select. */
  private tapCurve(p: ToolPointer, fn: (id: string, uv: Vec2) => void): void {
    const c = this.curveAt(p);
    if (c) return fn(c.id, c.uv);
    this.tapEmpty();
  }

  /** Has a selection tool something to apply (its values moved off "nothing")? */
  private transformPending(): boolean {
    const e = this.edit;
    switch (this.kind) {
      case "move":
        return Math.abs(e.dx) + Math.abs(e.dy) > 1e-12 || Math.abs(e.moveRot) > 1e-9;
      case "scale":
        return Math.abs(e.factor - 1) > 1e-9;
      case "patternLinear":
        return Math.hypot(e.dx, e.dy) > 1e-12 && e.count > 1;
      case "patternCircular":
        return !!e.pivot && e.count > 1;
      case "rotate":
        return Math.abs(e.angle) > 1e-9;
      case "mirror":
        return !!e.mirrorLine;
      default:
        return false;
    }
  }

  private tapEmpty(): void {
    // Offset waiting for Apply: an empty tap applies it.
    if (this.kind === "offset" && this.edit.offsetOf && this.offsetResult().length) return this.applyOffset();
    if (this.edit.extendFrom || this.edit.alignFrom || this.edit.filletFrom || this.edit.offsetOf) {
      this.edit.extendFrom = this.edit.alignFrom = this.edit.filletFrom = this.edit.offsetOf = undefined;
      this.clearPreviewJoin();
      this.app.setSelection([]);
      this.setHint();
      this.updatePanel();
      this.refreshPreview();
      return;
    }
    this.setKind("select");
  }

  /** Dashed preview of what the second Extend/Fillet pick would make. */
  private previewJoin(c: { id: string; uv: Vec2 } | null): void {
    this.clearPreviewJoin();
    const first = this.kind === "extend" ? this.edit.extendFrom : this.kind === "fillet" ? this.edit.filletFrom : undefined;
    if (!first || !c || !this.plane) return;
    const all = [...this.entities, ...this.boundary];
    const next = this.kind === "extend" ? joinEnds(all, first, { id: c.id, at: c.uv }) : filletEnds(all, first, { id: c.id, at: c.uv }, memory.fillet);
    if (!next) return;
    const old = new Map(all.map((e) => [e.id, JSON.stringify(e)]));
    const changed = next.filter((e) => old.get(e.id) !== JSON.stringify(e));
    const wpp = this.app.view.cam.worldPerPixel(this.app.view.height);
    for (const e of changed)
      for (const poly of entityPolylines(e)) {
        const line = new Line(new BufferGeometry().setFromPoints(poly.map((q) => sketchToWorld(this.plane!, q, 0.03))), new LineDashedMaterial({ color: 0x4fd18b, dashSize: wpp * 6, gapSize: wpp * 4, depthTest: false }));
        line.computeLineDistances();
        line.renderOrder = 10;
        this.joinPreview.push(line);
        this.app.view.overlay.add(line);
      }
    this.app.view.requestRender();
  }

  private joinPreview: Line[] = [];

  private clearPreviewJoin(): void {
    for (const l of this.joinPreview) {
      this.app.view.overlay.remove(l);
      l.geometry.dispose();
    }
    if (this.joinPreview.length) this.app.view.requestRender();
    this.joinPreview = [];
  }

  /** Split: cut a line/arc at its midpoint (Shift: where tapped). The pieces stay joined. */
  private tapSplit(id: string, uv: Vec2, atTap: boolean): void {
    const newId = uid();
    const next = splitEntity(this.entities, id, newId, atTap ? uv : undefined);
    if (!next) return this.app.ui.toast("Split works on lines and arcs");
    const cs = this.constraints.flatMap((c): SketchConstraint[] => {
      // A length dimension no longer fits half a line.
      if (c.type === "dim" && c.curves?.[0] === id && c.prop === "length") return [];
      // The far end now belongs to the second piece.
      const pts = c.pts?.map((r) => (r.e === id && r.p === "b" ? { e: newId, p: "b" } : r));
      return [{ ...c, ...(pts ? { pts } : {}) }];
    });
    cs.push({ id: uid(), type: "coincident", pts: [{ e: id, p: "b" }, { e: newId, p: "a" }] });
    this.commit(next, cs);
  }

  private tapSelect(p: ToolPointer, count = 1): void {
    if (this.selConstraint) this.deselectConstraint();
    // Points can be picked in the Select tool (for constraints and dragging) — but a
    // double tap is always "the whole shape", even when it lands near a corner.
    if (this.kind === "select" && count < 2) {
      const hit = this.app.view.pick(p.x, p.y, { curves: this.sketchId ?? true, profiles: false, bodies: false, planes: false, axes: false, images: false, edgeTolPx: p.tol });
      if (hit?.kind === "point" && hit.sketch === this.sketchId) {
        const r = { e: hit.entity, p: hit.p };
        const i = this.selPts.findIndex((x) => refKey(x) === refKey(r));
        if (i >= 0) this.selPts.splice(i, 1);
        else (this.selPts.push(r), this.pickSeq.set(refKey(r), ++this.seq));
        return this.selectionChanged();
      }
    }
    const c = this.curveAt(p);
    // Mirror: with something selected, the next line tapped (even one of the
    // selection) is the mirror axis — Shift+tap adds to the selection instead.
    if (c && this.kind === "mirror" && this.selected.size && !p.shift && count < 2) {
      const e = [...this.entities, ...this.boundary].find((x) => x.id === c.id);
      if (e?.kind !== "line") return this.app.ui.toast("The mirror axis must be a straight line");
      this.edit.mirrorLine = [e.a, e.b];
      return this.applyTransform();
    }
    // Double tap (or Mirror's first tap): the whole shape the curve belongs to (joined end to end).
    if (c && (count >= 2 || (this.kind === "mirror" && !this.selected.size && !p.shift))) {
      const chain = connectedChain(this.entities, c.id);
      for (const l of chain?.links ?? [{ id: c.id }]) if (!this.selected.has(l.id)) (this.selected.add(l.id), this.pickSeq.set(l.id, ++this.seq));
      return this.selectionChanged();
    }
    if (!c) {
      // Empty space: deselect; with nothing selected, an editing tool goes back to Select.
      if (this.selected.size || this.selPts.length) this.clearSelection();
      else if (this.kind !== "select") this.setKind("select");
      return;
    }
    if (this.selected.has(c.id)) this.selected.delete(c.id);
    else (this.selected.add(c.id), this.pickSeq.set(c.id, ++this.seq));
    this.selectionChanged();
  }

  private selectionChanged(): void {
    this.updateMenu();
    this.refreshDistanceDim();
    this.showSelection();
    this.updatePanel();
    this.refreshPreview();
    this.refreshConstraintUI();
  }

  private clearSelection(): void {
    this.selected.clear();
    this.selPts = [];
    this.selectionChanged();
  }

  private showSelection(): void {
    if (!this.sketchId) return;
    this.app.setSelection([
      ...[...this.selected].map((entity) => ({ kind: "curve" as const, sketch: this.sketchId!, entity })),
      ...this.selPts.map((r) => ({ kind: "point" as const, sketch: this.sketchId!, entity: r.e, p: r.p })),
    ]);
    this.refreshGimbal();
  }

  private deleteSelected(): void {
    const ids = new Set(this.selected);
    // Points picked on their own take their curves along.
    for (const r of this.selPts) ids.add(r.e);
    if (!ids.size) return;
    this.opLabel = "Delete";
    this.commit(this.entities.filter((e) => !ids.has(e.id)));
    this.clearSelection();
    // Nothing of them stays on screen (end and middle points, hover marks).
    this.app.setHover(null);
    this.refreshPreview();
  }

  private pickForEdit(p: ToolPointer): void {
    if (this.edit.picking === "pivot") {
      const s = this.snap(p);
      if (s) this.edit.pivot = s.uv;
    } else if (this.edit.picking === "mirror") {
      const c = this.curveAt(p);
      const e = c && this.entities.find((x) => x.id === c.id);
      if (e?.kind === "line") this.edit.mirrorLine = [e.a, e.b];
      else {
        // Or a world axis lying in the sketch plane (X/Y on the ground, …).
        const hit = this.app.view.pick(p.x, p.y, { curves: false, profiles: false, bodies: false, planes: false, axes: true, worldAxes: true, edgeTolPx: p.tol });
        const ax = hit?.kind === "axis" ? this.app.view.axisOf(hit.id) : undefined;
        const plane = this.plane!;
        if (!ax || Math.abs(dot(ax.plane.normal, plane.normal)) > 1e-6) return this.app.ui.toast("Pick a straight line or an axis in the sketch plane");
        const o = ax.plane.origin;
        const d = ax.plane.normal;
        this.edit.mirrorLine = [toPlane(plane, o), toPlane(plane, [o[0] + d[0], o[1] + d[1], o[2] + d[2]])];
      }
    }
    this.edit.picking = undefined;
    this.updatePanel();
    this.refreshPreview();
  }

  /** Copies/moved versions of the selection for the current transform tool. */
  private transformed(preview: boolean): SketchEntity[] {
    const sel = this.entities.filter((e) => this.selected.has(e.id));
    const pivot = this.edit.pivot ?? [0, 0];
    const deg = (this.edit.angle * Math.PI) / 180;
    const out: SketchEntity[] = [];
    switch (this.kind) {
      case "move": {
        const c = centroidOf(sel);
        const rot = (this.edit.moveRot * Math.PI) / 180;
        for (const e of sel) out.push(transformEntity(transformEntity(e, rotateXf(c, rot), !preview && this.edit.copy), translateXf(this.edit.dx, this.edit.dy)));
        break;
      }
      case "scale": {
        const c = centroidOf(sel);
        for (const e of sel) out.push(transformEntity(e, scaleXf(c, this.edit.factor), !preview && this.edit.copy));
        break;
      }
      case "patternLinear":
        for (let k = 1; k < this.edit.count; k++) for (const e of sel) out.push(transformEntity(e, translateXf(this.edit.dx * k, this.edit.dy * k), true));
        break;
      case "patternCircular": {
        const full = Math.abs(Math.abs(this.edit.patAngle) - 360) < 1e-6;
        const step = ((this.edit.patAngle * Math.PI) / 180) / (full ? this.edit.count : Math.max(1, this.edit.count - 1));
        for (let k = 1; k < this.edit.count; k++) for (const e of sel) out.push(transformEntity(e, rotateXf(pivot, step * k), true));
        break;
      }
      case "rotate":
        for (const e of sel) out.push(transformEntity(e, rotateXf(pivot, deg), !preview && this.edit.copy));
        break;
      case "mirror":
        if (this.edit.mirrorLine) for (const e of sel) out.push(transformEntity(e, mirrorXf(...this.edit.mirrorLine), !preview && this.edit.mirrorCopy));
        break;
    }
    return out;
  }

  private applyTransform(): void {
    if (!this.selected.size) return this.app.ui.toast("Select curves first");
    if (this.kind === "patternCircular" && !this.edit.pivot) return this.app.ui.toast("Tap the centre of the pattern first");
    if (this.kind === "mirror" && !this.edit.mirrorLine) return this.app.ui.toast("Pick the mirror line");
    let results = this.transformed(false);
    // Mirroring across one of the shape's own edges: that edge maps onto itself — don't double it.
    const ml = this.edit.mirrorLine;
    if (this.kind === "mirror" && ml) {
      const d: Vec2 = [ml[1][0] - ml[0][0], ml[1][1] - ml[0][1]];
      const L = Math.hypot(...d) || 1;
      const onAxis = (q: Vec2) => Math.abs((q[0] - ml[0][0]) * d[1] - (q[1] - ml[0][1]) * d[0]) / L < 1e-7 * Math.max(1, L);
      results = results.filter((e) => !(e.kind === "line" && onAxis(e.a) && onAxis(e.b)));
    }
    const keepOriginals = this.kind === "patternLinear" || this.kind === "patternCircular" || ((this.kind === "mirror" ? this.edit.mirrorCopy : this.edit.copy));
    const base = keepOriginals ? this.entities : this.entities.filter((e) => !this.selected.has(e.id));
    this.commit([...base, ...results]);
    if (!keepOriginals) {
      this.selected = new Set(results.map((e) => e.id));
      this.showSelection();
    }
    this.refreshPreview();
  }

  /** New curves the offset would add (one curve, or the whole chain in Chain mode). */
  private offsetResult(): SketchEntity[] {
    const id = this.edit.offsetOf;
    const src = this.entities.find((e) => e.id === id);
    if (!id || !src) return [];
    if (memory.offsetMode === "chain" && (src.kind === "line" || src.kind === "arc" || (src.kind === "spline" && !src.closed))) {
      const all = offsetChain(this.entities, id, memory.offset);
      if (all) return all.slice(this.entities.length);
    }
    const o = offsetEntity(src, memory.offset);
    return o ? [o] : [];
  }

  private applyOffset(): void {
    const made = this.offsetResult();
    if (!made.length) return this.app.ui.toast("That offset would collapse the curve");
    // Chain pieces stay joined to each other.
    const cs: SketchConstraint[] = [];
    for (let i = 0; i < made.length; i++) {
      const a = made[i];
      const b = made[(i + 1) % made.length];
      if (made.length > 1 && (a.kind === "line" || a.kind === "arc") && (b.kind === "line" || b.kind === "arc") && Math.hypot(a.b[0] - b.a[0], a.b[1] - b.a[1]) < 1e-9)
        cs.push({ id: uid(), type: "coincident", pts: [{ e: a.id, p: "b" }, { e: b.id, p: "a" }] });
    }
    this.commitAdd(made, cs);
    this.edit.offsetOf = undefined;
    this.resetDrawing();
  }

  /**
   * Fillet like Extend: tap the halves of two lines (they needn't touch) — or
   * tap right on a corner. The rounded corner appears; type its radius, Enter.
   */
  private tapFillet(p: ToolPointer): void {
    if (this.filletEdit) return this.finishFillet();
    const w = this.app.view.rayToPlane(p.x, p.y, this.plane!);
    if (!w) return;
    const uv = toPlane(this.plane!, w);
    const tol = this.app.view.cam.worldPerPixel(this.app.view.height) * p.tol * 1.5;
    const base = this.entities;
    if (!this.edit.filletFrom) {
      // Right on a corner (two curve ends meet there): round it directly.
      const ends = base.flatMap(guidePoints).filter((g) => g.kind === "end");
      const corner = ends.reduce<{ p: Vec2; d: number } | null>((best, g) => {
        const d = Math.hypot(g.p[0] - uv[0], g.p[1] - uv[1]);
        const meets = ends.filter((h) => Math.hypot(h.p[0] - g.p[0], h.p[1] - g.p[1]) < 1e-6).length >= 2;
        return meets && d < tol && (!best || d < best.d) ? { p: g.p, d } : best;
      }, null);
      if (corner) return this.startFillet((r) => filletCorner(base, corner.p, r, tol * 0.01 + 1e-6));
      const c = this.curveAt(p);
      if (!c) return this.tapEmpty();
      if (base.find((x) => x.id === c.id)?.kind !== "line") return this.app.ui.toast("Pick a line (or tap a corner)");
      this.edit.filletFrom = { id: c.id, at: c.uv };
      this.app.setSelection([{ kind: "curve", sketch: this.sketchId ?? "", entity: c.id }]);
      return this.setHint("Now tap the half of the other line.");
    }
    const first = this.edit.filletFrom;
    const c = this.curveAt(p);
    if (!c) return this.tapEmpty();
    this.edit.filletFrom = undefined;
    this.clearPreviewJoin();
    this.app.setSelection([]);
    this.startFillet((r) => filletEnds(base, first, { id: c.id, at: c.uv }, r));
  }

  private filletEdit: { make: (r: number) => SketchEntity[] | null; widget: DimWidget; base: SketchEntity[]; baseIds: Set<string> } | null = null;

  /** Show the fillet with the last radius and a focused radius box to type into. */
  private startFillet(make: (r: number) => SketchEntity[] | null): void {
    if (!make(memory.fillet)) return this.app.ui.toast("Can't fillet these (radius too big, parallel, or not two lines)");
    const widget = new DimWidget(this.app.view, {
      value: memory.fillet,
      boxAt: "beyond",
      focus: true,
      live: true,
      onInput: (v) => v > 0 && this.applyFillet(v),
      onCommit: () => this.finishFillet(),
    });
    this.filletEdit = { make, widget, base: this.entities, baseIds: new Set(this.entities.map((e) => e.id)) };
    this.applyFillet(memory.fillet);
    this.setHint("Type the radius, then Enter (or tap anywhere).");
  }

  private applyFillet(r: number): void {
    const fe = this.filletEdit;
    const next = fe?.make(r);
    // Too big for these lines: keep the last good fillet, show the value in red.
    fe?.widget.markInvalid(!next);
    if (!fe || !next || !this.sketchId) return;
    memory.fillet = r;
    const id = this.sketchId;
    this.app.store.transient((doc) => {
      const f = doc.features.find((x) => x.id === id);
      if (f?.type === "sketch") f.entities = next;
    });
    // The radius dimension runs from the new arc's centre to its middle.
    const arc = next.find((e) => e.kind === "arc" && !fe.baseIds.has(e.id));
    if (arc?.kind === "arc") {
      const c = arcFrom3(arc.a, arc.m, arc.b);
      if (c) fe.widget.set(sketchToWorld(this.plane!, c.c).toArray() as Vec3, sketchToWorld(this.plane!, arc.m).toArray() as Vec3);
    }
  }

  /** Esc: drop the fillet being sized. */
  private cancelFillet(): void {
    const fe = this.filletEdit;
    if (!fe) return;
    this.filletEdit = null;
    fe.widget.dispose();
    this.commit(fe.base);
    this.setHint();
  }

  private finishFillet(): void {
    const fe = this.filletEdit;
    if (!fe) return;
    this.filletEdit = null;
    fe.widget.dispose();
    // One undo step for the whole fillet; the arc stays tangent and joined to its lines.
    this.commit(this.entities, filletConstraints(this.entities, this.constraints, fe.baseIds));
    this.setHint();
  }

  /** Last curve of another sketch projected (a second tap on it brings the whole sketch). */
  private projectedFrom: { sketch: string; entity: string; at: number } | null = null;

  /** Curves of another sketch → this sketch's plane (straight across, or squashed if tilted). */
  private projectCurves(sketch: string, entities: SketchEntity[]): SketchEntity[] {
    const from = this.app.sketchPlane(sketch);
    const to = this.plane!;
    if (!from) return [];
    if (Math.abs(dot(from.normal, to.normal)) > 1 - 1e-9) {
      // Parallel planes: the same shapes, moved (and turned) into this plane.
      return entities.map((e) => transformEntity(e, (uv) => toPlane(to, sketchToWorld(from, uv).toArray() as Vec3), true));
    }
    return entities.flatMap((e) =>
      entityPolylines(e).flatMap((pl) => {
        const out = projectPolyline(pl.map((uv) => sketchToWorld(from, uv).toArray() as Vec3), to, e.kind === "line" ? "LINE" : "");
        return out ? [out] : [];
      }),
    );
  }

  private tapProject(p: ToolPointer): void {
    const hit = this.app.view.pick(p.x, p.y, { profiles: false, planes: false, axes: false, edgeTolPx: p.tol });
    if (hit?.kind === "curve" && hit.sketch !== this.sketchId) {
      const all = this.app.sketchCurves(hit.sketch).filter((e) => !e.id.startsWith("bnd-") && !e.construction);
      const last = this.projectedFrom;
      if (last && last.sketch === hit.sketch && Date.now() - last.at < 450) {
        // Double tap: the rest of that sketch too (e.g. a whole text).
        this.projectedFrom = null;
        this.commitAdd(this.projectCurves(hit.sketch, all.filter((e) => e.id !== last.entity)));
        return this.app.ui.toast("Projected the whole sketch");
      }
      const one = all.filter((e) => e.id === hit.entity);
      if (!one.length) return;
      this.projectedFrom = { sketch: hit.sketch, entity: hit.entity, at: Date.now() };
      this.commitAdd(this.projectCurves(hit.sketch, one));
      return this.app.ui.toast("Double-tap a curve to project its whole sketch");
    }
    if (hit?.kind !== "edge") return this.app.ui.toast("Tap a body edge or a curve of another sketch");
    const b = this.app.view.body(hit.body);
    const g = b?.edgeGroups.find((x) => x.edge === hit.edge);
    if (!b || !g) return;
    const pts: [number, number, number][] = [];
    for (let i = g.start; i < g.start + g.count; i++) {
      // Segment pairs: take the first point of each pair plus the very last point.
      if ((i - g.start) % 2 === 0 || i === g.start + g.count - 1) pts.push([b.edgePositions[i * 3], b.edgePositions[i * 3 + 1], b.edgePositions[i * 3 + 2]]);
    }
    const e = projectPolyline(pts, this.plane!, b.edges[hit.edge].type);
    if (e) this.commitAdd([e]);
  }

  // ------------------------------------------------- single-entity sizes

  private showSizePanel(): void {
    const id = [...this.selected][0];
    let e = this.entities.find((x) => x.id === id);
    if (!e) return;
    const set = (patch: Partial<SketchEntity>) => {
      this.commit(this.entities.map((x) => (x.id === id ? ({ ...x, ...patch } as SketchEntity) : x)));
      e = this.entities.find((x) => x.id === id) ?? e;
    };
    const items: PanelItem[] = [];
    // Sizes are driving dimensions: they show on the sketch and can use variables (ƒx).
    let pending: string | null = null;
    const dimField = (label: string, prop: string, kind: "length" | "angle" = "length"): PanelItem => {
      const d = dimOf(this.constraints, id, prop);
      return {
        type: "number",
        label,
        value: d?.value ?? sizeOfEntity(e!, prop),
        kind,
        min: kind === "length" ? 0.0001 : undefined,
        expr: d?.expr,
        onExpr: (x) => (pending = x),
        onInput: (v) => {
          const expr = pending && isExpression(pending) ? pending : null;
          pending = null;
          // A diameter replaces a radius dimension (and axis lengths the half-axes), never both.
          const replaced: Record<string, string> = { diameter: "radius", dx: "rx", dy: "ry" };
          const base = this.constraints.filter((c) => !(c.type === "dim" && c.curves?.[0] === id && c.curves.length === 1 && c.prop === replaced[prop]));
          // A size that contradicts other constraints replaces them.
          const next = setDim(base, id, prop, v, expr);
          const added = next.filter((c) => !base.includes(c));
          const res = addResolving(this.entities, next.filter((c) => base.includes(c)), added);
          this.commit(this.entities, res.constraints);
          this.toastReplaced(res.removed);
          if (this.app.store.problems.length) this.app.ui.toast(this.app.store.problems[0], "error");
        },
      };
    };
    switch (e.kind) {
      case "line":
        items.push(dimField("Length", "length"), dimField("Angle", "angle", "angle"));
        break;
      case "rect":
        items.push(
          dimField("Width", "w"),
          dimField("Height", "h"),
          { type: "number", label: "Angle", value: (e.rotation * 180) / Math.PI, kind: "angle", onInput: (v) => set({ rotation: (v * Math.PI) / 180 }) },
        );
        break;
      case "circle":
        items.push(dimField("Diameter", "diameter"));
        break;
      case "ellipse":
        items.push(dimField("Length", "dx"), dimField("Width", "dy"));
        break;
      case "polygon":
        items.push(dimField("Radius", "radius"), { type: "number", label: "Sides", value: e.sides, kind: "int", min: 3, onInput: (v) => set({ sides: Math.max(3, Math.min(64, v)) }) });
        break;
      case "arc":
        items.push(dimField("Radius", "radius"));
        break;
    }
    items.push(
      { type: "toggle", label: "Construction", value: !!e.construction, onChange: () => this.toggleConstruction() },
      ...(e.kind === "rect" || e.kind === "polygon" ? [{ type: "button", label: "Explode", icon: "line", onClick: () => this.commit(this.entities.flatMap((x) => (x.id === id ? explode(x) : [x]))) } as PanelItem] : []),
      { type: "button", label: "Delete", icon: "trash", onClick: () => this.deleteSelected() },
    );
    this.app.ui.showPanel({ title: titleOf(e.kind as Kind), items, onDone: () => this.clearSelection() });
    // An arc or circle: its radius (diameter for a circle) in a box right by it — type to change it.
    if ((e.kind === "arc" || e.kind === "circle") && this.plane) {
      const c = e.kind === "circle" ? { c: e.center, r: e.radius } : arcFrom3(e.a, e.m, e.b);
      if (!c) return;
      const prop = e.kind === "circle" ? "diameter" : "radius";
      const field = dimField(prop === "diameter" ? "Diameter" : "Radius", prop) as Extract<PanelItem, { type: "number" }>;
      // From the centre out through the arc's middle (or the circle's top right).
      const through = e.kind === "arc" ? e.m : ([c.c[0] + c.r * Math.SQRT1_2, c.c[1] + c.r * Math.SQRT1_2] as Vec2);
      const w = (q: Vec2) => sketchToWorld(this.plane!, q, 0.02).toArray() as Vec3;
      this.sizeDim = new DimWidget(this.app.view, {
        value: field.value,
        boxAt: "beyond",
        onInput: (v) => field.onInput(v),
        onCommit: () => this.clearSelection(),
      });
      const start = e.kind === "circle" ? ([2 * c.c[0] - through[0], 2 * c.c[1] - through[1]] as Vec2) : c.c;
      this.sizeDim.set(w(start), w(through));
    }
  }

  /** The radius box beside a selected arc/circle. */
  private sizeDim: DimWidget | null = null;

  /**
   * Two lines selected (not on one axis): their angle in a box where they meet
   * — type a new angle (the second line turns), or pin it as a measurement.
   */
  private showAngleBox(l1: Extract<SketchEntity, { kind: "line" }>, l2: Extract<SketchEntity, { kind: "line" }>): void {
    if (!this.plane) return;
    const d1: Vec2 = [l1.b[0] - l1.a[0], l1.b[1] - l1.a[1]];
    const d2: Vec2 = [l2.b[0] - l2.a[0], l2.b[1] - l2.a[1]];
    const cr = d1[0] * d2[1] - d1[1] * d2[0];
    const L1 = Math.hypot(...d1);
    const L2 = Math.hypot(...d2);
    if (L1 < 1e-12 || L2 < 1e-12) return;
    // On one axis: no angle to show.
    const off = Math.abs((l2.a[0] - l1.a[0]) * d1[1] - (l2.a[1] - l1.a[1]) * d1[0]) / L1;
    if (Math.abs(cr) < 1e-9 * L1 * L2 && off < 1e-6 * (L1 + L2)) return;
    // Where their lines cross (or between them, if parallel).
    let at: Vec2;
    if (Math.abs(cr) > 1e-9 * L1 * L2) {
      const t = ((l2.a[0] - l1.a[0]) * d2[1] - (l2.a[1] - l1.a[1]) * d2[0]) / cr;
      at = [l1.a[0] + d1[0] * t, l1.a[1] + d1[1] * t];
    } else at = [(l1.a[0] + l1.b[0] + l2.a[0] + l2.b[0]) / 4, (l1.a[1] + l1.b[1] + l2.a[1] + l2.b[1]) / 4];
    const deg = this.angleBetween(l1.id, l2.id);
    const w = sketchToWorld(this.plane, at, 0.02).toArray() as Vec3;
    this.angleDim = new DimWidget(this.app.view, {
      value: deg,
      angle: true,
      noLine: true,
      onInput: (v) => this.setLinesAngle(l1.id, l2.id, v),
      onCommit: () => this.clearSelection(),
      onPin: () => this.app.addPin({ text: `${trimNum(this.angleBetween(l1.id, l2.id), 2)}°`, at: w }),
    });
    this.angleDim.set(w, w);
  }

  private angleDim: DimWidget | null = null;
}

function titleOf(k: string): string {
  const t: Record<string, string> = { patternLinear: "Pattern – Linear", patternCircular: "Pattern – Circular", rotate: "Rotate Around Axis", rect: "Rectangle", offset: "Offset Edge", polyline: "Outline" };
  return t[k] ?? k[0].toUpperCase() + k.slice(1);
}

function sizeOfEntity(e: SketchEntity, prop: string): number {
  return sizeOfFn(e, prop) ?? 0;
}

function samePt(a: Vec2, b: Vec2): boolean {
  return Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9;
}

function centroidOf(es: SketchEntity[]): Vec2 {
  const pts = es.flatMap((e) => guidePoints(e).map((g) => g.p));
  if (!pts.length) return [0, 0];
  return [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
}

function dimLabel(e: SketchEntity | null, pts: Vec2[]): string | null {
  if (!e) return null;
  switch (e.kind) {
    case "line": {
      const [a, b] = [e.a, e.b];
      return fmtLen(Math.hypot(b[0] - a[0], b[1] - a[1]));
    }
    case "rect":
      return `${fmtLen(e.w)} × ${fmtLen(e.h)}`;
    case "circle":
      return `⌀ ${fmtLen(2 * e.radius)}`;
    case "polygon":
      return `R ${fmtLen(e.radius)} · ${e.sides} sides (Tab)`;
    case "ellipse":
      return `${fmtLen(2 * e.rx)} × ${fmtLen(2 * e.ry)}`;
    case "arc": {
      const c = arcFrom3(e.a, e.m, e.b);
      return c ? `R ${fmtLen(c.r)}` : null;
    }
    default:
      return pts.length ? `${pts.length} points` : null;
  }
}
