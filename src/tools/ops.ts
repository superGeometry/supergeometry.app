// Solid, transform and construction operations. Each is a FeatureOp:
// pick slots + values + live preview; see featureOp.ts.

import type {
  AxisFeature,
  AxisRef,
  EdgeFeature,
  EdgeRef,
  ExtrudeFeature,
  ExtrudeSource,
  FaceRef,
  ImageFeature,
  LoftFeature,
  MoveFaceFeature,
  PathRef,
  ReplaceFaceFeature,
  ScaleFaceFeature,
  PlaneDef,
  PlaneFeature,
  RevolveFeature,
  ShellFeature,
  SplitFeature,
  SweepFeature,
  TransformFeature,
  Vec3,
} from "../doc/types";
import { add, cross, dot, len, norm, niceStep, scale, sub, xDirFor } from "../geom";
import type { PanelItem } from "../ui/ui";
import { evaluate, fmtLen } from "../units";
import type { ToolPointer } from "../view/input";
import { FeatureOp } from "./featureOp";
import { axisDrag, Handle } from "./handles";
import { axisSlot, directionSlot, facesSlot, pathSlot, planeSlot, pointSlot, sectionsSlot } from "./slots";
import { faceIndexOf, oppositeFace, sourceFrame, targetOf, type AppContext, type Sel } from "./tool";
import { DimWidget } from "./annotate";
import { Gimbal, GIMBAL_AXES, IN_PLANE, SCALE_PARTS, type GimbalPart } from "./gimbal";
import { DragTyping } from "./dragTyping";
import { CopyToggle, linkMode } from "./copyToggle";
import { detachFreeformCopy, freeformBodies } from "../doc/freeformCopies";

type Mode = "auto" | "new" | "join" | "cut";
const MODES = [
  { id: "auto", label: "Auto" },
  { id: "new", label: "New body" },
  { id: "join", label: "Add" },
  { id: "cut", label: "Cut" },
];

function modeChoice(get: () => Mode, set: (m: Mode) => void, rerender: () => void): PanelItem {
  return { type: "choice", options: MODES, value: get(), onChange: (m) => (set(m as Mode), rerender()) };
}

// ------------------------------------------------------------------ extrude

export interface ExtrudeOptions {
  /** Face push/pull: edit the total thickness or the offset. */
  measure?: "total" | "offset";
  distance?: number;
  /** Text being typed when the tool took over (restored into the widget). */
  typed?: string;
  /** The distance as an expression (e.g. a variable, or "wall - 4"). */
  expr?: string;
}

/**
 * Extrude profiles or push/pull a flat face. Drag the arrow or type a value in
 * the dimension next to it; for faces choose Total (thickness to the opposite
 * face) or Offset (how far the face moves). Negative offsets cut.
 */
export class ExtrudeOp extends FeatureOp<ExtrudeFeature> {
  readonly id = "extrude";
  private handle: Handle;
  private frame: { base: Vec3; normal: Vec3 };
  private dragging: { from: ToolPointer; d0: number } | null = null;
  private dim: DimWidget | null = null;
  private measure: "total" | "offset";
  private thick: { distance: number; point: Vec3 } | null = null;

  constructor(app: AppContext, source: ExtrudeSource, existing?: ExtrudeFeature, mode: Mode = "auto", private opts: ExtrudeOptions = {}) {
    // Pushing a face of its own body is an Offset Face step in the history.
    const label = source.kind === "face" && mode !== "new" ? "Offset Face" : undefined;
    super(app, { ...app.store.newIdentity("extrude", label), type: "extrude", source, distance: opts.distance ?? 0, mode, target: targetOf(app, source) }, existing);
    this.frame = sourceFrame(app, this.feature.source);
    this.handle = new Handle(app.view, "arrow");
    if (source.kind === "face") {
      const k = faceIndexOf(app, source.face);
      if (k !== null) this.thick = oppositeFace(app, source.face.body, k);
    }
    this.measure = this.thick ? (opts.measure ?? "total") : "offset";
    if (opts.expr && !existing) this.feature.exprs = { distance: opts.expr };
  }

  /** A variable picked for the value: total thickness = that variable (or the offset, in Offset mode). */
  private useVariable(name: string): void {
    const v = evaluate(name, "length");
    if (v === null) return;
    const total = this.measure === "total" && this.thick;
    const d = total ? v - this.thick!.distance : v;
    this.feature.exprs = { ...(this.feature.exprs ?? {}), distance: total ? `${name} - ${Math.round(this.thick!.distance * 1e6) / 1e6}mm` : name };
    this.setDistance(d);
    this.render();
  }

  enter(): void {
    super.enter();
    this.dim = new DimWidget(this.app.view, {
      // Past the tip of the drag arrow (at the far end of the dimension).
      boxAt: "beyond",
      boxGap: 96,
      dir: this.frame.normal,
      value: this.shown(),
      modes: this.thick ? [{ id: "total", label: "Total" }, { id: "offset", label: "Offset" }] : undefined,
      mode: this.measure,
      onMode: (m) => {
        this.measure = m as "total" | "offset";
        this.dim?.setValue(this.shown());
        this.onDraftChanged();
      },
      onInput: (v) => this.setDistance(this.measure === "total" && this.thick ? v - this.thick.distance : v),
      onCommit: () => this.done(),
      onPin: () => this.pin(),
      variables: this.app.store.doc.variables.map((v) => v.name),
      onVariable: (name) => this.useVariable(name),
      typed: this.opts.typed,
      focus: this.opts.typed !== undefined,
    });
    this.onDraftChanged();
  }

  /** The value the widget shows: total thickness or offset. */
  private shown(): number {
    return this.measure === "total" && this.thick ? this.thick.distance + this.feature.distance : this.feature.distance;
  }

  private dimEnds(): [Vec3, Vec3] {
    const { base, normal } = this.frame;
    const top = add(base, scale(normal, this.feature.distance));
    return this.measure === "total" && this.thick ? [this.thick.point, top] : [base, top];
  }

  private pin(): void {
    const [a, b] = this.dimEnds();
    this.app.addPin({ text: fmtLen(Math.abs(this.shown())), a, b, at: scale(add(a, b), 0.5) });
  }

  get activeSketch(): string | undefined {
    return this.feature.source.kind === "profile" ? this.feature.source.sketch : undefined;
  }

  protected hint(): string {
    return "Drag the arrow or type a distance. Negative values cut.";
  }

  protected items(): PanelItem[] {
    return [
      this.num("Distance", "distance", "length", { onInput: (v) => this.setDistance(v) }),
      modeChoice(() => this.feature.mode, (m) => ((this.feature.mode = m), this.update()), () => this.render()),
    ];
  }

  protected ready(): boolean {
    return this.feature.distance !== 0;
  }

  exit(): void {
    this.handle.dispose();
    this.dim?.dispose();
    super.exit();
  }

  hover(p: ToolPointer | null): void {
    const on = !!p && (!!this.dragging || this.handle.hit(p));
    this.handle.setHot(on);
    this.app.view.canvas.style.cursor = on ? "grab" : "";
    if (!on) super.hover(p);
  }

  down(p: ToolPointer): boolean {
    if (!this.handle.hit(p)) return false;
    this.dragging = { from: p, d0: this.feature.distance };
    this.handle.setHot(true);
    return true;
  }

  drag(p: ToolPointer): void {
    if (!this.dragging) return;
    this.typing.track(p);
    if (this.typing.active) return; // a typed value wins over the pointer
    const { d0, from } = this.dragging;
    const raw = d0 + axisDrag(this.app.view, add(this.frame.base, scale(this.frame.normal, d0)), this.frame.normal, from, p);
    const step = niceStep(this.app.view.cam.worldPerPixel(this.app.view.height) * 4);
    this.setDistance(Math.round(raw / step) * step);
    this.app.ui.setLabel(p.x, p.y, `${this.measure === "total" && this.thick ? "Total " : ""}${fmtLen(this.shown())}  · type a value`);
  }

  up(): void {
    this.dragging = null;
    this.typing.reset();
    this.app.ui.setLabel(0, 0, null);
    this.handle.setHot(false);
  }

  private typing = new DragTyping(this.app);

  dragKey(e: KeyboardEvent): boolean {
    const dr = this.dragging;
    if (!dr) return false;
    return this.typing.key(e, {
      kind: "length",
      apply: (v) => this.setDistance(this.measure === "total" && this.thick ? v - this.thick.distance : v),
      commit: () => ((this.dragging = null), this.done()),
      cancel: () => this.setDistance(dr.d0),
    });
  }

  private setDistance(d: number): void {
    this.feature.distance = d;
    this.app.ui.updatePanelValues([d]);
    this.dim?.setValue(this.shown());
    this.update();
  }

  protected onDraftChanged(): void {
    this.handle.set(add(this.frame.base, scale(this.frame.normal, this.feature.distance)), this.frame.normal);
    const [a, b] = this.dimEnds();
    this.dim?.set(a, b);
  }

  protected done(): void {
    if (this.feature.distance === 0) return this.app.setTool(null);
    super.done();
  }
}

// ---------------------------------------------------------- fillet/chamfer

export class EdgeOp extends FeatureOp<EdgeFeature> {
  readonly id: string;
  private handle: Handle;
  private origin: Vec3;
  private axis: Vec3;
  private dragging: { from: ToolPointer; r0: number } | null = null;

  constructor(app: AppContext, kind: "fillet" | "chamfer", edges: EdgeRef[], existing?: EdgeFeature, variable?: string) {
    // Started from a variable: the size is that variable (and follows it when it changes).
    const v = variable ? evaluate(variable, "length") : null;
    super(app, { ...app.store.newIdentity(kind), type: kind, edges, radius: v ?? 1, ...(variable && v !== null ? { exprs: { radius: variable } } : {}) }, existing);
    this.id = kind;
    this.names = { fillet: existing?.type === "fillet" ? existing.name : app.store.newIdentity("fillet").name, chamfer: existing?.type === "chamfer" ? existing.name : app.store.newIdentity("chamfer").name };
    const e = this.feature.edges[0];
    this.origin = e.mid;
    this.axis = outwardOf(app, e) ?? (() => {
      const view = app.view.camera.position.clone().sub(app.view.cam.target).normalize().toArray() as Vec3;
      const perp = norm(cross(cross(e.dir, view), e.dir));
      return dot(perp, view) < 0 ? scale(perp, -1) : perp;
    })();
    this.handle = new Handle(app.view, "dot");
  }

  private names: { fillet: string; chamfer: string };

  /** Fillets sit outside the edge (+), chamfers inside (−): dragging across the edge switches. */
  private signed(): number {
    return this.feature.type === "fillet" ? this.feature.radius : -this.feature.radius;
  }

  protected hint(): string {
    return `Drag the dot or type a ${this.feature.type === "fillet" ? "radius" : "distance"}. Tap more edges to add them.`;
  }

  protected items(): PanelItem[] {
    return [this.num(this.feature.type === "fillet" ? "Radius" : "Distance", "radius", "length", { min: 0.0001, onInput: (v) => this.setRadius(v) })];
  }

  enter(): void {
    super.enter();
    this.app.setSelection(this.edgeSels());
  }

  exit(): void {
    this.handle.dispose();
    super.exit();
  }

  /** Tapping edges while filleting adds/removes them. */
  tap(p: ToolPointer): void {
    const hit = this.app.view.pick(p.x, p.y, { edgeTolPx: p.tol, profiles: false, planes: false, axes: false, vertices: false });
    if (!hit) return this.done();
    if (hit.kind !== "edge") return;
    const info = this.app.view.body(hit.body)?.edges[hit.edge];
    if (!info) return;
    const i = this.feature.edges.findIndex((e) => e.body === hit.body && Math.hypot(...sub(e.mid, info.mid)) < 1e-6);
    if (i >= 0) this.feature.edges.splice(i, 1);
    else this.feature.edges.push({ body: hit.body, mid: info.mid, dir: info.dir, length: info.length });
    this.app.setSelection(this.edgeSels());
    this.update();
  }

  hover(): void {}

  private edgeSels(): Sel[] {
    return this.feature.edges.flatMap((e) => {
      const b = this.app.view.body(e.body);
      const k = b?.edges.findIndex((x) => Math.hypot(...sub(x.mid, e.mid)) < 1e-6) ?? -1;
      return k >= 0 ? [{ kind: "edge", body: e.body, edge: k } as Sel] : [];
    });
  }

  protected ready(): boolean {
    return this.feature.edges.length > 0;
  }

  /** Started by dragging the dot on the edge itself: the size grows from the edge. */
  private fromEdge = false;

  /** The next press (the one that opened this from the edge's dot) drags from zero. */
  grabFromEdge(): this {
    this.fromEdge = true;
    return this;
  }

  down(p: ToolPointer): boolean {
    const first = this.fromEdge && !this.existing;
    this.fromEdge = false;
    if (first) {
      this.dragging = { from: p, r0: 0 };
      return true;
    }
    if (!this.handle.hit(p)) return false;
    this.dragging = { from: p, r0: this.signed() };
    return true;
  }

  drag(p: ToolPointer): void {
    if (!this.dragging) return;
    this.typing.track(p);
    if (this.typing.active) return;
    const { r0, from } = this.dragging;
    const raw = r0 + axisDrag(this.app.view, add(this.origin, scale(this.axis, r0)), this.axis, from, p);
    const step = niceStep(this.app.view.cam.worldPerPixel(this.app.view.height) * 3);
    // Outward: a fillet; pulled in past the edge: a chamfer.
    const kind = raw >= 0 ? "fillet" : "chamfer";
    if (kind !== this.feature.type) {
      this.feature.type = kind;
      this.feature.name = this.names[kind];
      this.render();
    }
    this.setRadius(Math.max(step, Math.round(Math.abs(raw) / step) * step));
    this.app.ui.setLabel(p.x, p.y, `${kind === "fillet" ? "Fillet" : "Chamfer"} ${fmtLen(this.feature.radius)}  · type a value`);
  }

  up(): void {
    this.dragging = null;
    this.typing.reset();
    this.app.ui.setLabel(0, 0, null);
  }

  private typing = new DragTyping(this.app);

  dragKey(e: KeyboardEvent): boolean {
    const dr = this.dragging;
    if (!dr) return false;
    return this.typing.key(e, {
      kind: "length",
      apply: (v) => v > 0 && this.setRadius(v),
      commit: () => ((this.dragging = null), this.done()),
      cancel: () => this.setRadius(dr.r0),
    });
  }

  private setRadius(r: number): void {
    this.feature.radius = r;
    this.app.ui.updatePanelValues([r]);
    this.update();
  }

  protected onDraftChanged(): void {
    this.handle.set(add(this.origin, scale(this.axis, this.signed())));
  }
}

/** Away from the material at an edge: between the normals of the two flat faces it joins. */
function outwardOf(app: AppContext, e: EdgeRef): Vec3 | null {
  const b = app.view.body(e.body);
  if (!b) return null;
  const tol = Math.max(1e-6, e.length * 1e-4);
  const ns = b.faces.filter((f) => f.plane && Math.abs(dot(f.normal, e.dir)) < 1e-4 && Math.abs(dot(f.normal, sub(e.mid, f.center))) < tol).map((f) => f.normal);
  if (ns.length < 2) return null;
  const sum = add(ns[0], ns[1]);
  return len(sum) < 1e-6 ? null : norm(sum);
}

// ----------------------------------------------------------------- revolve

export class RevolveOp extends FeatureOp<RevolveFeature> {
  readonly id = "revolve";
  private axisSet = false;

  constructor(app: AppContext, source: ExtrudeSource, existing?: RevolveFeature) {
    super(app, { ...app.store.newIdentity("revolve"), type: "revolve", source, axis: { origin: [0, 0, 0], dir: [0, 0, 1] }, angle: 360, mode: "auto", target: targetOf(app, source) }, existing);
    this.axisSet = !!existing;
    this.slots = [axisSlot(app, "Axis", () => (this.axisSet ? this.feature.axis : null), (a) => ((this.feature.axis = a), (this.axisSet = true)))];
  }

  get activeSketch(): string | undefined {
    return this.feature.source.kind === "profile" ? this.feature.source.sketch : undefined;
  }

  private handle: Handle | null = null;
  private dim: DimWidget | null = null;
  private dragging: { from: ToolPointer; t0: number } | null = null;
  private typing = new DragTyping(this.app);

  protected hint(): string {
    return "Set the angle (360° is a full turn). Drag the arrow on the axis to move along it while turning — with more than 360° that makes a thread or a spring.";
  }

  protected items(): PanelItem[] {
    return [
      this.num("Angle", "angle", "angle"),
      this.num("Travel", "travel", "length", { onInput: (v) => this.setTravel(v) }),
      modeChoice(() => this.feature.mode, (m) => ((this.feature.mode = m), this.update()), () => this.render()),
    ];
  }

  enter(): void {
    super.enter();
    this.onDraftChanged();
  }

  exit(): void {
    this.handle?.dispose();
    this.dim?.dispose();
    super.exit();
  }

  /** Where the profile sits on the axis (the arrow starts there). */
  private axisBase(): Vec3 {
    const { origin, dir } = this.feature.axis;
    const d = norm(dir);
    const c = sourceFrame(this.app, this.feature.source).base;
    return add(origin, scale(d, dot(sub(c, origin), d)));
  }

  protected onDraftChanged(): void {
    if (!this.axisSet) return;
    const d = norm(this.feature.axis.dir);
    const base = this.axisBase();
    const travel = this.feature.travel ?? 0;
    if (!this.handle) {
      this.handle = new Handle(this.app.view, "arrow");
      this.dim = new DimWidget(this.app.view, { boxAt: "beyond", boxGap: 96, dir: d, value: travel, onInput: (v) => this.setTravel(v), onCommit: () => this.done() });
    }
    const tip = add(base, scale(d, travel));
    this.handle.set(tip, travel < 0 ? scale(d, -1) : d);
    this.dim!.set(base, tip);
  }

  private setTravel(v: number): void {
    this.feature.travel = v || undefined;
    // Travelling with just a part of a turn is fine; a full turn is the usual start for a thread.
    this.app.ui.updatePanelValues([this.feature.angle, v]);
    this.dim?.setValue(v);
    this.update();
  }

  hover(p: ToolPointer | null): void {
    const on = !!p && !!this.handle && (!!this.dragging || this.handle.hit(p));
    this.handle?.setHot(on);
    if (!on) super.hover(p);
  }

  down(p: ToolPointer): boolean {
    if (!this.handle?.hit(p)) return false;
    this.dragging = { from: p, t0: this.feature.travel ?? 0 };
    return true;
  }

  drag(p: ToolPointer): void {
    const dr = this.dragging;
    if (!dr) return;
    this.typing.track(p);
    if (this.typing.active) return;
    const d = norm(this.feature.axis.dir);
    const raw = dr.t0 + axisDrag(this.app.view, add(this.axisBase(), scale(d, dr.t0)), d, dr.from, p);
    const step = niceStep(this.app.view.cam.worldPerPixel(this.app.view.height) * 4);
    this.setTravel(Math.round(raw / step) * step);
    this.app.ui.setLabel(p.x, p.y, `Travel ${fmtLen(this.feature.travel ?? 0)}  · type a value`);
  }

  up(): void {
    this.dragging = null;
    this.typing.reset();
    this.app.ui.setLabel(0, 0, null);
    this.handle?.setHot(false);
  }

  dragKey(e: KeyboardEvent): boolean {
    const dr = this.dragging;
    if (!dr) return false;
    return this.typing.key(e, {
      kind: "length",
      apply: (v) => this.setTravel(v),
      commit: () => ((this.dragging = null), this.done()),
      cancel: () => this.setTravel(dr.t0),
    });
  }
}

// ------------------------------------------------------------------- sweep

export class SweepOp extends FeatureOp<SweepFeature> {
  readonly id = "sweep";
  private path: PathRef | null = null;

  constructor(app: AppContext, source: ExtrudeSource, existing?: SweepFeature) {
    super(app, { ...app.store.newIdentity("sweep"), type: "sweep", source, path: { kind: "sketch", sketch: "", entities: [] }, mode: "auto", target: targetOf(app, source) }, existing);
    if (existing) this.path = existing.path;
    this.slots = [pathSlot(app, () => this.path, (p) => ((this.path = p), (this.feature.path = p)))];
  }

  protected hint(): string {
    return "Tap more curves to extend the path. Done when ready.";
  }

  protected items(): PanelItem[] {
    return [modeChoice(() => this.feature.mode, (m) => ((this.feature.mode = m), this.update()), () => this.render())];
  }
}

// -------------------------------------------------------------------- loft

export class LoftOp extends FeatureOp<LoftFeature> {
  readonly id = "loft";

  constructor(app: AppContext, sections: ExtrudeSource[], initial: Sel[], existing?: LoftFeature) {
    super(app, { ...app.store.newIdentity("loft"), type: "loft", sections, ruled: false, mode: "new" }, existing);
    this.slots = [sectionsSlot(app, () => this.feature.sections, (s) => (this.feature.sections = s), initial)];
  }

  protected hint(): string {
    return "Tap profiles in the order the shape should pass through them.";
  }

  protected items(): PanelItem[] {
    return [
      { type: "toggle", label: "Straight sides", value: this.feature.ruled, onChange: (v) => ((this.feature.ruled = v), this.render(), this.update()) },
      modeChoice(() => this.feature.mode, (m) => ((this.feature.mode = m), this.update()), () => this.render()),
    ];
  }
}

// ------------------------------------------------------------------- shell

export class ShellOp extends FeatureOp<ShellFeature> {
  readonly id = "shell";

  constructor(app: AppContext, body: string, faces: FaceRef[], existing?: ShellFeature) {
    super(app, { ...app.store.newIdentity("shell"), type: "shell", body, faces, thickness: 1 }, existing);
    this.slots = [facesSlot(app, "Open faces", () => this.feature.faces, (f) => (this.feature.faces = f), true)];
    this.active = 0;
  }

  enter(): void {
    super.enter();
    this.active = 0;
    this.render();
  }

  protected hint(): string {
    return "Tap faces to remove (open). Set the wall thickness.";
  }

  protected items(): PanelItem[] {
    return [this.num("Thickness", "thickness", "length", { min: 0.0001 })];
  }
}

// --------------------------------------------------------------- transforms

type TransformKind = "move" | "translate" | "rotate" | "scale" | "mirror" | "linear" | "circular";
const TITLES: Record<TransformKind, string> = {
  move: "Move/Rotate",
  translate: "Translate",
  rotate: "Rotate Around Axis",
  scale: "Scale",
  mirror: "Mirror",
  linear: "Pattern – Linear",
  circular: "Pattern – Circular",
};

/** Move/rotate, translate, rotate around axis, scale, mirror and patterns of bodies. */
export class TransformOp extends FeatureOp<TransformFeature> {
  readonly id = "transform";
  private dir: Vec3 | null = null;
  private axis: AxisRef | null = null;
  private plane: PlaneDef | null = null;
  private distance = 10;
  private gimbal: Gimbal | null = null;
  private dragging: { from: ToolPointer; part: GimbalPart; t0: Vec3; a0: number; center: Vec3 } | null = null;
  /** Body centre before this move (rotation pivot; the gimbal sits at centre + translate). */
  private center: Vec3;

  constructor(
    app: AppContext,
    private kind: TransformKind,
    bodies: string[],
    existing?: TransformFeature,
    /** Gimbal/rotation pivot (e.g. a selected vertex); default the bodies' centre. */
    pivot?: Vec3,
    /** Move makes a copy (the gimbal's Copy switch). */
    copy = false,
  ) {
    const center = pivot ?? bodyCenter(app, bodies);
    const op: TransformFeature["op"] =
      kind === "scale"
        ? { kind: "scale", center, factor: 1 }
        : kind === "mirror"
          ? { kind: "mirror", plane: { origin: [0, 0, 0], xDir: [0, 1, 0], normal: [1, 0, 0] } }
          : kind === "linear"
            ? { kind: "linear", dir: [1, 0, 0], spacing: 20, count: 3 }
            : kind === "circular"
              ? { kind: "circular", axis: { origin: [0, 0, 0], dir: [0, 0, 1] }, count: 6, angle: 360 }
              : { kind: "move", translate: [0, 0, 0], rotate: { origin: center, axis: [0, 0, 1], angle: 0 } };
    const label = kind === "linear" || kind === "circular" ? "Pattern" : TITLES[kind].split(" ")[0].replace("/Rotate", "");
    super(app, { ...app.store.newIdentity("transform", copy ? "Copy" : label), type: "transform", bodies, copy: kind === "mirror" || copy, op }, existing);
    const o = this.feature.op;
    if (existing) {
      if (o.kind === "mirror") this.plane = o.plane;
      if (o.kind === "linear") this.dir = o.dir;
      if (o.kind === "circular") this.axis = o.axis;
      if (o.kind === "move" && o.rotate) this.axis = { origin: o.rotate.origin, dir: o.rotate.axis };
    }
    if (kind === "mirror") this.slots = [planeSlot(app, "Mirror plane", () => this.plane, (p) => ((this.plane = p), ((this.feature.op as { plane: PlaneDef }).plane = p)))];
    if (kind === "linear")
      this.slots = [directionSlot(app, "Direction", () => this.dir, (d) => ((this.dir = norm(d)), this.applyDir()))];
    // Translate: from a point on it to where that point should go (size unchanged).
    if (kind === "translate")
      this.slots = [
        pointSlot(app, "From point", () => this.from, (p) => ((this.from = p), this.applyPoints())),
        pointSlot(app, "To point", () => this.to, (p) => ((this.to = p), this.applyPoints())),
      ];
    if (kind === "circular" || kind === "rotate")
      this.slots = [axisSlot(app, "Axis", () => this.axis, (a) => ((this.axis = a), this.applyAxis()))];
    this.center = o.kind === "move" && o.rotate ? o.rotate.origin : center;
    if (copy && !existing && linkMode.on) this.feature.link = true;
    if (kind === "move") {
      this.gimbal = new Gimbal(app.view);
      const g = this.gimbal;
      this.copyToggle = new CopyToggle(app.view, () => g.origin, (on) => ((this.feature.copy = on), (this.feature.link = on && linkMode.on ? true : undefined), this.render(), this.update()));
    }
  }

  private copyToggle: CopyToggle | null = null;
  private from: Vec3 | null = null;
  private to: Vec3 | null = null;

  private applyPoints(): void {
    const o = this.feature.op;
    if (o.kind === "move" && this.from && this.to) {
      o.translate = sub(this.to, this.from);
      o.rotate = undefined;
    }
  }

  /** A finished copy is selected, gimbal and all, so the next drag copies it again. */
  protected done(): void {
    const f = this.feature;
    const copied = f.copy && this.ready() && !this.existing && (this.kind === "move" || this.kind === "rotate" || this.kind === "translate" || this.kind === "mirror" || this.kind === "scale");
    if (!copied) return super.done();
    if (f.link) f.link = true;
    else delete f.link;
    // Unlinked copies of freeforms: freeforms of their own (editing one leaves the other alone).
    let doc = { ...this.app.store.doc, features: [...this.app.store.features, f] };
    const ids = new Map<string, string>();
    if (!f.link) {
      const tracked = freeformBodies(doc.features);
      for (const b of f.bodies) {
        const body = `${f.id}:${b}:0`;
        if (!tracked.has(body)) continue;
        const out = detachFreeformCopy(doc, body, this.app.store.newIdentity("freeform").id + ids.size);
        if (out) ((doc = out.doc), ids.set(body, out.id));
      }
    }
    this.app.store.commit((d) => {
      d.features = doc.features;
      d.names = doc.names;
      d.hidden = doc.hidden;
      if (doc.colors) d.colors = doc.colors;
    });
    this.app.setTool(null);
    this.app.setSelection(f.bodies.map((b) => ({ kind: "body" as const, body: ids.get(`${f.id}:${b}:0`) ?? `${f.id}:${b}:0` })));
  }

  protected hint(): string {
    switch (this.kind) {
      case "move":
        return "Drag an arrow, square or arc of the gimbal — or type exact values. Tap empty space when done.";
      case "mirror":
        return "Mirror creates a copy unless you turn Copy off.";
      case "translate":
        return "Tap a point on the body (a corner, edge or face), then the point it should move to.";
      default:
        return `${TITLES[this.kind]}: set the values, then Done.`;
    }
  }

  private applyDir(): void {
    const o = this.feature.op;
    if (o.kind === "linear" && this.dir) o.dir = this.dir;
    if (this.kind === "translate" && o.kind === "move" && this.dir) o.translate = scale(this.dir, this.distance);
  }

  private applyAxis(): void {
    const o = this.feature.op;
    if (o.kind === "circular" && this.axis) o.axis = this.axis;
    if (o.kind === "move" && this.axis) o.rotate = { origin: this.axis.origin, axis: this.axis.dir, angle: o.rotate?.angle ?? 90 };
  }

  protected items(): PanelItem[] {
    const o = this.feature.op;
    const up = () => this.update();
    const copyToggle: PanelItem = { type: "toggle", label: "Copy", value: this.feature.copy, onChange: (v) => ((this.feature.copy = v), this.render(), up()) };
    // With Copy on: Link keeps the copy connected to its original (a freeform
    // copy then changes when either is shaped); off, it is a body of its own.
    const link: PanelItem = {
      type: "toggle",
      label: "Link",
      value: !!this.feature.link,
      onChange: (v) => {
        linkMode.on = v;
        this.feature.link = v;
        this.render();
      },
    };
    const copy: PanelItem[] = this.feature.copy && !this.existing ? [copyToggle, link] : [copyToggle];
    switch (o.kind) {
      case "scaleXYZ":
        return [];
      case "move":
        if (this.kind === "translate") return [...(["X", "Y", "Z"] as const).map((l, i): PanelItem => this.num(`Δ${l}`, `op.translate.${i}`, "length")), ...copy];
        if (this.kind === "rotate") return [{ type: "number", label: "Angle", value: o.rotate?.angle ?? 0, kind: "angle", onInput: (v) => ((o.rotate = { ...(o.rotate ?? { origin: [0, 0, 0], axis: [0, 0, 1] }), angle: v }), up()) }, ...copy];
        return [
          ...(["X", "Y", "Z"] as const).map((l, i): PanelItem => this.num(`Δ${l}`, `op.translate.${i}`, "length")),
          o.rotate
            ? this.num(`Rotate ${axisName(o.rotate.axis)}`, "op.rotate.angle", "angle")
            : { type: "number", label: "Rotate Z", value: 0, kind: "angle", onInput: (v) => ((o.rotate = { origin: this.center, axis: [0, 0, 1], angle: v }), up()) },
          ...copy,
        ];
      case "scale":
        return [this.num("Factor", "op.factor", "number", { min: 0.0001 }), ...copy];
      case "mirror":
        return [...copy];
      case "linear":
        return [
          this.num("Count", "op.count", "int", { min: 2 }),
          this.num("Spacing", "op.spacing", "length"),
        ];
      case "circular":
        return [
          this.num("Count", "op.count", "int", { min: 2 }),
          this.num("Angle", "op.angle", "angle"),
        ];
    }
  }

  protected ready(): boolean {
    const o = this.feature.op;
    // An untouched move is not worth a history step.
    if (this.kind === "move" && o.kind === "move" && len(o.translate) < 1e-9 && !o.rotate?.angle && !this.feature.copy) return false;
    return super.ready() && this.feature.bodies.length > 0;
  }

  exit(): void {
    this.gimbal?.dispose();
    this.copyToggle?.dispose();
    super.exit();
  }

  protected onDraftChanged(): void {
    const o = this.feature.op;
    if (this.gimbal && o.kind === "move") this.gimbal.setCenter(add(this.center, o.translate));
  }

  hover(p: ToolPointer | null): void {
    if (this.gimbal) this.gimbal.setHot(p && !this.dragging ? this.gimbal.hit(p) : this.dragging?.part ?? null);
    else super.hover(p);
  }

  down(p: ToolPointer): boolean {
    const o = this.feature.op;
    const part = this.gimbal?.hit(p);
    if (!part || o.kind !== "move") return false;
    // A different rotation axis than the one already used: start from the current angle 0 on that axis.
    if (part.kind === "ring" && o.rotate && o.rotate.angle && axisIndex(o.rotate.axis) !== part.i) {
      this.app.ui.toast("One rotation axis per move — press Done, then rotate around the next axis");
      return true;
    }
    this.dragging = { from: p, part, t0: [...o.translate] as Vec3, a0: o.rotate?.angle ?? 0, center: add(this.center, o.translate) };
    this.gimbal!.setHot(part);
    return true;
  }

  drag(p: ToolPointer): void {
    const o = this.feature.op;
    const dr = this.dragging;
    if (!dr || o.kind !== "move") return;
    this.typing.track(p);
    if (this.typing.active) return;
    const view = this.app.view;
    const step = niceStep(view.cam.worldPerPixel(view.height) * 4);
    const snap = (v: number) => (p.shift ? v : Math.round(v / step) * step);
    const part = dr.part;
    if (part.kind === "axis") {
      const dir = GIMBAL_AXES[part.i];
      const d = snap(axisDrag(view, dr.center, dir, dr.from, p));
      o.translate = add(dr.t0, scale(dir, d));
      this.app.ui.setLabel(p.x, p.y, fmtLen(d));
    } else if (part.kind === "plane" || part.kind === "center") {
      // Move in the plane of the square (or the screen plane for the centre).
      const n: Vec3 = part.kind === "plane" ? GIMBAL_AXES[part.i] : (view.cam.viewDir().toArray() as Vec3);
      const plane = { origin: dr.center, normal: n, xDir: xDirFor(n) };
      const a = view.rayToPlane(dr.from.x, dr.from.y, plane);
      const b = view.rayToPlane(p.x, p.y, plane);
      if (!a || !b) return;
      const d = sub(b, a);
      o.translate = add(dr.t0, [snap(d[0]), snap(d[1]), snap(d[2])]);
      this.app.ui.setLabel(p.x, p.y, fmtLen(len(sub(o.translate, dr.t0))));
    } else {
      const axis = GIMBAL_AXES[part.i];
      const c = view.toScreen(dr.center);
      if (!c) return;
      const ang = (q: { x: number; y: number }) => Math.atan2(q.y - c[1], q.x - c[0]);
      // Screen y points down, so a visual counter-clockwise turn is a negative atan2 change.
      const facing = dot(axis, view.cam.viewDir().toArray() as Vec3) < 0 ? 1 : -1;
      let deg = (-(ang(p) - ang(dr.from)) * 180) / Math.PI * facing;
      deg = ((deg + 540) % 360) - 180;
      const total = p.shift ? dr.a0 + deg : Math.round((dr.a0 + deg) / 5) * 5;
      o.rotate = { origin: this.center, axis, angle: total };
      this.app.ui.setLabel(p.x, p.y, `${Math.round(total * 10) / 10}°`);
    }
    this.app.ui.updatePanelValues([o.translate[0], o.translate[1], o.translate[2], o.rotate?.angle ?? 0]);
    this.update();
  }

  up(): void {
    const dragged = !!this.dragging;
    this.dragging = null;
    this.typing.reset();
    this.app.ui.setLabel(0, 0, null);
    this.gimbal?.setHot(null);
    // Letting go keeps the tool and its panel: change the values (Copy, Link…),
    // drag again, or tap empty space / Done to finish.
    void dragged;
    this.render();
  }

  private typing = new DragTyping(this.app);

  /** Typed while dragging: distance for arrows/squares/centre, angle for arcs. */
  dragKey(e: KeyboardEvent): boolean {
    const o = this.feature.op;
    const dr = this.dragging;
    if (!dr || o.kind !== "move") return false;
    const part = dr.part;
    const refresh = () => {
      this.app.ui.updatePanelValues([o.translate[0], o.translate[1], o.translate[2], o.rotate?.angle ?? 0]);
      this.update();
    };
    // Squares/centre: along the direction dragged so far.
    const dragDir = norm(sub(o.translate, dr.t0));
    return this.typing.key(e, {
      kind: part.kind === "ring" ? "angle" : "length",
      apply: (v) => {
        if (part.kind === "ring") o.rotate = { origin: this.center, axis: GIMBAL_AXES[part.i], angle: dr.a0 + v };
        else if (part.kind === "axis") o.translate = add(dr.t0, scale(GIMBAL_AXES[part.i], v));
        else if (len(dragDir) > 0.5) o.translate = add(dr.t0, scale(dragDir, v));
        refresh();
      },
      commit: () => ((this.dragging = null), this.gimbal?.setHot(null), this.done()),
      cancel: () => ((o.translate = [...dr.t0] as Vec3), o.rotate && (o.rotate.angle = dr.a0), refresh()),
    });
  }
}

// --------------------------------------------------------- move face/edge

/**
 * Move/rotate just one flat face or one straight edge: the gimbal sits on it,
 * the rest of the body stretches to follow. Only the parts that change the
 * geometry are shown (a face can't slide within its own plane).
 */
export class MoveFaceOp extends FeatureOp<MoveFaceFeature> {
  readonly id = "moveFace";
  private gimbal: Gimbal;
  private axes: Vec3[];
  private center: Vec3;
  private dragging: { from: ToolPointer; part: GimbalPart; t0: Vec3; a0: number; center: Vec3 } | null = null;

  constructor(app: AppContext, target: { face: FaceRef; plane: PlaneDef } | { edge: EdgeRef } | { vertex: { body: string; at: Vec3 } }, existing?: MoveFaceFeature) {
    const isFace = "face" in target;
    const isVertex = "vertex" in target;
    const center = isFace ? target.face.center : isVertex ? target.vertex.at : target.edge.mid;
    super(
      app,
      {
        ...app.store.newIdentity("moveFace", isFace ? "Move Face" : isVertex ? "Move Vertex" : "Move Edge"),
        type: "moveFace",
        ...(isFace ? { face: target.face } : isVertex ? { vertex: target.vertex } : { edge: target.edge }),
        translate: [0, 0, 0],
      },
      existing,
    );
    if (isVertex) {
      // A point just moves (turning it about itself would do nothing).
      this.axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
      this.gimbal = new Gimbal(app.view, { parts: (p) => p.kind !== "ring" });
      this.center = center;
      return;
    }
    if (isFace) {
      const n = norm(target.plane.normal);
      const x = norm(target.plane.xDir);
      this.axes = [x, cross(n, x), n];
    } else {
      const d = norm(target.edge.dir);
      const u = xDirFor(d);
      this.axes = [d, u, cross(d, u)];
    }
    // Face: push along the normal, tilt about the in-plane axes. Edge: move across it, tilt it.
    const parts = isFace
      ? (p: GimbalPart) => (p.kind === "axis" && p.i === 2) || (p.kind === "ring" && p.i < 2)
      : (p: GimbalPart) => (p.kind === "axis" && p.i > 0) || (p.kind === "plane" && p.i === 0) || (p.kind === "ring" && p.i > 0);
    this.gimbal = new Gimbal(app.view, { axes: this.axes, parts });
    this.center = this.feature.rotate?.origin ?? center;
  }

  protected hint(): string {
    return "Drag an arrow to move it, an arc to tilt it — or type a value while dragging.";
  }

  protected items(): PanelItem[] {
    const f = this.feature;
    const xyz = (["X", "Y", "Z"] as const).map((l, i): PanelItem => this.num(`Δ${l}`, `translate.${i}`, "length"));
    if (f.vertex) return xyz;
    return [
      ...xyz,
      f.rotate ? this.num("Tilt", "rotate.angle", "angle") : { type: "number", label: "Tilt", value: 0, kind: "angle", onInput: (v) => ((f.rotate = { origin: this.center, axis: this.axes[0], angle: v }), this.update()) },
    ];
  }

  protected ready(): boolean {
    return len(this.feature.translate) > 1e-9 || Math.abs(this.feature.rotate?.angle ?? 0) > 1e-9;
  }

  exit(): void {
    this.gimbal.dispose();
    super.exit();
  }

  protected onDraftChanged(): void {
    this.gimbal.setCenter(add(this.center, this.feature.translate));
  }

  hover(p: ToolPointer | null): void {
    this.gimbal.setHot(p && !this.dragging ? this.gimbal.hit(p) : (this.dragging?.part ?? null));
  }

  down(p: ToolPointer): boolean {
    const part = this.gimbal.hit(p);
    if (!part) return false;
    const r = this.feature.rotate;
    if (part.kind === "ring" && r && r.angle && dot(r.axis, this.axes[part.i]) < 0.999) {
      this.app.ui.toast("One tilt axis per move — press Done, then tilt around the next axis");
      return true;
    }
    this.dragging = { from: p, part, t0: [...this.feature.translate] as Vec3, a0: r?.angle ?? 0, center: add(this.center, this.feature.translate) };
    this.gimbal.setHot(part);
    return true;
  }

  drag(p: ToolPointer): void {
    const f = this.feature;
    const dr = this.dragging;
    if (!dr) return;
    this.typing.track(p);
    if (this.typing.active) return;
    const view = this.app.view;
    const step = niceStep(view.cam.worldPerPixel(view.height) * 4);
    const snap = (v: number) => (p.shift ? v : Math.round(v / step) * step);
    const part = dr.part;
    if (part.kind === "axis") {
      const dir = this.axes[part.i];
      const d = snap(axisDrag(view, dr.center, dir, dr.from, p));
      f.translate = add(dr.t0, scale(dir, d));
      this.app.ui.setLabel(p.x, p.y, `${fmtLen(d)}  · type a value`);
    } else if (part.kind === "center") {
      // Free move in the screen plane.
      const n = view.cam.viewDir().toArray() as Vec3;
      const plane = { origin: dr.center, normal: n, xDir: xDirFor(n) };
      const a = view.rayToPlane(dr.from.x, dr.from.y, plane);
      const b = view.rayToPlane(p.x, p.y, plane);
      if (!a || !b) return;
      const d = sub(b, a);
      f.translate = add(dr.t0, [snap(d[0]), snap(d[1]), snap(d[2])]);
      this.app.ui.setLabel(p.x, p.y, `${fmtLen(len(sub(f.translate, dr.t0)))}  · type a value`);    } else if (part.kind === "plane") {
      const n = this.axes[part.i];
      const plane = { origin: dr.center, normal: n, xDir: xDirFor(n) };
      const a = view.rayToPlane(dr.from.x, dr.from.y, plane);
      const b = view.rayToPlane(p.x, p.y, plane);
      if (!a || !b) return;
      const d = sub(b, a);
      f.translate = add(dr.t0, [snap(d[0]), snap(d[1]), snap(d[2])]);
      this.app.ui.setLabel(p.x, p.y, `${fmtLen(len(sub(f.translate, dr.t0)))}  · type a value`);
    } else if (part.kind === "ring") {
      const axis = this.axes[part.i];
      const c = view.toScreen(dr.center);
      if (!c) return;
      const ang = (q: { x: number; y: number }) => Math.atan2(q.y - c[1], q.x - c[0]);
      const facing = dot(axis, view.cam.viewDir().toArray() as Vec3) < 0 ? 1 : -1;
      let deg = ((-(ang(p) - ang(dr.from)) * 180) / Math.PI) * facing;
      deg = ((deg + 540) % 360) - 180;
      const total = p.shift ? dr.a0 + deg : Math.round(dr.a0 + deg);
      f.rotate = { origin: this.center, axis, angle: total };
      this.app.ui.setLabel(p.x, p.y, `${Math.round(total * 10) / 10}°  · type a value`);
    }
    this.app.ui.updatePanelValues([f.translate[0], f.translate[1], f.translate[2], f.rotate?.angle ?? 0]);
    this.update();
  }

  up(): void {
    this.dragging = null;
    this.typing.reset();
    this.app.ui.setLabel(0, 0, null);
    this.gimbal.setHot(null);
    this.render();
  }

  private typing = new DragTyping(this.app);

  dragKey(e: KeyboardEvent): boolean {
    const f = this.feature;
    const dr = this.dragging;
    if (!dr) return false;
    const part = dr.part;
    const refresh = () => {
      this.app.ui.updatePanelValues([f.translate[0], f.translate[1], f.translate[2], f.rotate?.angle ?? 0]);
      this.update();
    };
    const dragDir = norm(sub(f.translate, dr.t0));
    return this.typing.key(e, {
      kind: part.kind === "ring" ? "angle" : "length",
      apply: (v) => {
        if (part.kind === "ring") f.rotate = { origin: this.center, axis: this.axes[part.i], angle: dr.a0 + v };
        else if (part.kind === "axis") f.translate = add(dr.t0, scale(this.axes[part.i], v));
        else if (len(dragDir) > 0.5) f.translate = add(dr.t0, scale(dragDir, v));
        refresh();
      },
      commit: () => ((this.dragging = null), this.gimbal.setHot(null), this.done()),
      cancel: () => ((f.translate = [...dr.t0] as Vec3), f.rotate && (f.rotate.angle = dr.a0), refresh()),
    });
  }
}

// ------------------------------------------------------------------ scale

/**
 * Scale bodies with the cube-ended scale gimbal: drag the centre (or type) for
 * a uniform factor; in XYZ mode drag one axis to stretch along it.
 * The factor follows the drag: the handle's distance from the centre, relative
 * to where it started.
 */
export class ScaleOp extends FeatureOp<TransformFeature> {
  readonly id = "scale";
  private gimbal: Gimbal;
  private dragging: { part: GimbalPart; from: ToolPointer; k0: Vec3; r0: number } | null = null;
  private typing = new DragTyping(this.app);

  constructor(
    app: AppContext,
    private xyz: boolean,
    bodies: string[],
    existing?: TransformFeature,
  ) {
    const center = bodyCenter(app, bodies);
    const op: TransformFeature["op"] = xyz ? { kind: "scaleXYZ", center, factors: [1, 1, 1] } : { kind: "scale", center, factor: 1 };
    super(app, { ...app.store.newIdentity("transform", xyz ? "Scale XYZ" : "Scale"), type: "transform", bodies, copy: false, op }, existing);
    this.xyz = this.feature.op.kind === "scaleXYZ";
    this.gimbal = new Gimbal(app.view, { cubes: true, parts: this.xyz ? SCALE_PARTS : (p) => p.kind === "center" || p.kind === "axis" });
    this.gimbal.setCenter((this.feature.op as { center: Vec3 }).center);
  }

  private get factors(): Vec3 {
    const o = this.feature.op;
    return o.kind === "scaleXYZ" ? o.factors : o.kind === "scale" ? [o.factor, o.factor, o.factor] : [1, 1, 1];
  }

  private setFactors(k: Vec3): void {
    const o = this.feature.op;
    if (o.kind === "scaleXYZ") o.factors = k;
    else if (o.kind === "scale") o.factor = k[0];
    this.app.ui.updatePanelValues(this.xyz ? k : [k[0]]);
    this.update();
  }

  protected hint(): string {
    return this.xyz
      ? "Drag an axis handle to stretch along it, or the centre for all three — type a factor while dragging. Works on freeform bodies."
      : "Drag a handle (or the centre) to scale — type a factor while dragging (e.g. 2 doubles the size).";
  }

  protected items(): PanelItem[] {
    if (this.xyz) return (["X", "Y", "Z"] as const).map((l, i): PanelItem => this.num(`Scale ${l}`, `op.factors.${i}`, "number", { min: 0.0001 }));
    return [this.num("Factor", "op.factor", "number", { min: 0.0001 }), { type: "toggle", label: "Copy", value: this.feature.copy, onChange: (v) => ((this.feature.copy = v), this.render(), this.update()) }];
  }

  protected ready(): boolean {
    return this.factors.some((k) => Math.abs(k - 1) > 1e-9) || this.feature.copy;
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
    const c = this.app.view.toScreen(this.gimbal.origin);
    // Distance of the press from the centre on screen = "factor 1" for this drag.
    const r0 = c ? Math.max(24, Math.hypot(p.x - c[0], p.y - c[1])) : 60;
    this.dragging = { part, from: p, k0: [...this.factors] as Vec3, r0 };
    this.gimbal.setHot(part);
    return true;
  }

  drag(p: ToolPointer): void {
    const dr = this.dragging;
    if (!dr) return;
    this.typing.track(p);
    if (this.typing.active) return;
    const view = this.app.view;
    const c = view.toScreen(this.gimbal.origin);
    if (!c) return;
    let f: number;
    if (dr.part.kind === "axis") {
      // Along the axis on screen: how far the handle has been pulled out or pushed in.
      const pxPerUnit = view.cam.worldPerPixel(view.height);
      const along = axisDrag(view, this.gimbal.origin, GIMBAL_AXES[dr.part.i], dr.from, p) / pxPerUnit;
      f = (dr.r0 + along) / dr.r0;
    } else f = Math.hypot(p.x - c[0], p.y - c[1]) / dr.r0;
    f = Math.max(0.01, p.shift ? f : Math.round(f * 100) / 100);
    const k = [...dr.k0] as Vec3;
    if (dr.part.kind === "axis" && this.xyz) k[dr.part.i] = dr.k0[dr.part.i] * f;
    else for (let i = 0; i < 3; i++) k[i] = dr.k0[i] * f;
    this.setFactors(k);
    this.app.ui.setLabel(p.x, p.y, `×${(dr.part.kind === "axis" && this.xyz ? k[dr.part.i] : k[0]).toFixed(2)}  · type a value`);
  }

  up(): void {
    this.dragging = null;
    this.typing.reset();
    this.app.ui.setLabel(0, 0, null);
    this.gimbal.setHot(null);
  }

  dragKey(e: KeyboardEvent): boolean {
    const dr = this.dragging;
    if (!dr) return false;
    return this.typing.key(e, {
      kind: "number",
      apply: (v) => {
        if (v <= 0) return;
        const k = [...dr.k0] as Vec3;
        if (dr.part.kind === "axis" && this.xyz) k[dr.part.i] = v;
        else k.fill(v);
        this.setFactors(k);
      },
      commit: () => ((this.dragging = null), this.gimbal.setHot(null), this.done()),
      cancel: () => this.setFactors(dr.k0),
    });
  }
}

/**
 * Scale a flat face within its plane: two in-plane handles (along the face's
 * own axes) and the centre for both at once. The sides tilt to follow.
 */
export class ScaleFaceOp extends FeatureOp<ScaleFaceFeature> {
  readonly id = "scaleFace";
  private gimbal: Gimbal;
  private axes: Vec3[];
  private dragging: { part: GimbalPart; from: ToolPointer; k0: [number, number]; r0: number } | null = null;
  private typing = new DragTyping(this.app);

  constructor(app: AppContext, face: FaceRef, plane: PlaneDef, existing?: ScaleFaceFeature) {
    const n = norm(plane.normal);
    const u = norm(plane.xDir);
    super(app, { ...app.store.newIdentity("scaleFace"), type: "scaleFace", face, u, factors: [1, 1] }, existing);
    const uu = norm(this.feature.u);
    this.axes = [uu, cross(n, uu), n];
    this.gimbal = new Gimbal(app.view, { axes: this.axes, cubes: true, parts: (p) => p.kind === "center" || (p.kind === "axis" && p.i < 2) });
    this.gimbal.setCenter(face.center);
  }

  protected hint(): string {
    return "Drag a handle to scale the face along it, or the centre for both — type a factor while dragging. The sides tilt to follow.";
  }

  protected items(): PanelItem[] {
    return [this.num("Scale U", "factors.0", "number", { min: 0.0001 }), this.num("Scale V", "factors.1", "number", { min: 0.0001 })];
  }

  protected ready(): boolean {
    return this.feature.factors.some((k) => Math.abs(k - 1) > 1e-9);
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
    const c = this.app.view.toScreen(this.gimbal.origin);
    const r0 = c ? Math.max(24, Math.hypot(p.x - c[0], p.y - c[1])) : 60;
    this.dragging = { part, from: p, k0: [...this.feature.factors] as [number, number], r0 };
    return true;
  }

  drag(p: ToolPointer): void {
    const dr = this.dragging;
    if (!dr) return;
    this.typing.track(p);
    if (this.typing.active) return;
    const view = this.app.view;
    const c = view.toScreen(this.gimbal.origin);
    if (!c) return;
    let f: number;
    if (dr.part.kind === "axis") f = (dr.r0 + axisDrag(view, this.gimbal.origin, this.axes[dr.part.i], dr.from, p) / view.cam.worldPerPixel(view.height)) / dr.r0;
    else f = Math.hypot(p.x - c[0], p.y - c[1]) / dr.r0;
    f = Math.max(0.01, p.shift ? f : Math.round(f * 100) / 100);
    const k: [number, number] = [...dr.k0];
    if (dr.part.kind === "axis") k[dr.part.i as 0 | 1] = dr.k0[dr.part.i as 0 | 1] * f;
    else ((k[0] = dr.k0[0] * f), (k[1] = dr.k0[1] * f));
    this.feature.factors = k;
    this.app.ui.updatePanelValues(k);
    this.update();
    this.app.ui.setLabel(p.x, p.y, `×${(dr.part.kind === "axis" ? k[dr.part.i as 0 | 1] : k[0]).toFixed(2)}  · type a value`);
  }

  up(): void {
    this.dragging = null;
    this.typing.reset();
    this.app.ui.setLabel(0, 0, null);
  }

  dragKey(e: KeyboardEvent): boolean {
    const dr = this.dragging;
    if (!dr) return false;
    return this.typing.key(e, {
      kind: "number",
      apply: (v) => {
        if (v <= 0) return;
        const k: [number, number] = [...dr.k0];
        if (dr.part.kind === "axis") k[dr.part.i as 0 | 1] = v;
        else ((k[0] = v), (k[1] = v));
        this.feature.factors = k;
        this.app.ui.updatePanelValues(k);
        this.update();
      },
      commit: () => ((this.dragging = null), this.done()),
      cancel: () => ((this.feature.factors = dr.k0), this.update()),
    });
  }
}

/** Replace a flat face: it moves onto another flat face or plane, the rest follows. */
export class ReplaceFaceOp extends FeatureOp<ReplaceFaceFeature> {
  readonly id = "replaceFace";
  protected finishWhenPicked = true;

  constructor(app: AppContext, face: FaceRef, existing?: ReplaceFaceFeature) {
    super(app, { ...app.store.newIdentity("replaceFace"), type: "replaceFace", face, plane: { origin: face.center, normal: face.normal, xDir: xDirFor(face.normal) } }, existing);
    let picked = !!existing;
    this.slots = [
      planeSlot(app, "Replace with", () => (picked ? this.feature.plane : null), (pl, target) => {
        picked = true;
        this.feature.plane = pl;
        this.feature.target = target;
      }),
    ];
  }

  protected hint(): string {
    return "Tap the face or plane it should move onto.";
  }

  protected items(): PanelItem[] {
    return [];
  }
}

function axisIndex(a: Vec3): number {
  return a.findIndex((v) => Math.abs(v) > 0.99);
}

function axisName(a?: Vec3): string {
  return ["X", "Y", "Z"][a ? Math.max(0, axisIndex(a)) : 2];
}

export function bodyCenter(app: AppContext, bodies: string[]): Vec3 {
  const pts = bodies.flatMap((id) => app.view.body(id)?.faces.map((f) => f.center) ?? []);
  if (!pts.length) return [0, 0, 0];
  return scale(pts.reduce((a, b) => add(a, b), [0, 0, 0] as Vec3), 1 / pts.length);
}

// ------------------------------------------------------------------- image

/** Move / rotate (gimbal), scale and fade a reference image. */
export class ImageOp extends FeatureOp<ImageFeature> {
  readonly id = "image";
  private gimbal: Gimbal;
  private dragging: { from: ToolPointer; part: GimbalPart; origin: Vec3; xDir: Vec3 } | null = null;
  private aspect: number;

  constructor(app: AppContext, existing: ImageFeature) {
    super(app, existing, existing);
    this.aspect = existing.height / existing.width;
    const p = existing.plane;
    this.gimbal = new Gimbal(app.view, { axes: [p.xDir, cross(p.normal, p.xDir), p.normal], parts: IN_PLANE });
  }

  protected hint(): string {
    return "Drag the gimbal to move or rotate the image; set its width and opacity.";
  }

  protected items(): PanelItem[] {
    return [
      this.num("Width", "width", "length", { min: 0.001, onInput: (v) => ((this.feature.height = v * this.aspect), this.update()) }),
      { type: "number", label: "Opacity", value: this.feature.opacity, kind: "number", min: 0.05, onInput: (v) => ((this.feature.opacity = Math.min(1, v)), this.update()) },
    ];
  }

  protected onDraftChanged(): void {
    this.gimbal.setCenter(this.feature.plane.origin);
  }

  exit(): void {
    this.gimbal.dispose();
    super.exit();
  }

  hover(p: ToolPointer | null): void {
    this.gimbal.setHot(p && !this.dragging ? this.gimbal.hit(p) : null);
  }

  down(p: ToolPointer): boolean {
    const part = this.gimbal.hit(p);
    if (!part) return false;
    this.dragging = { from: p, part, origin: [...this.feature.plane.origin] as Vec3, xDir: [...this.feature.plane.xDir] as Vec3 };
    return true;
  }

  drag(p: ToolPointer): void {
    const dr = this.dragging;
    if (!dr) return;
    const view = this.app.view;
    const pl = { ...this.feature.plane, origin: dr.origin };
    if (dr.part.kind === "ring") {
      const c = view.toScreen(dr.origin);
      if (!c) return;
      const ang = (q: { x: number; y: number }) => Math.atan2(q.y - c[1], q.x - c[0]);
      const facing = dot(pl.normal, view.cam.viewDir().toArray() as Vec3) < 0 ? 1 : -1;
      const a = -(ang(p) - ang(dr.from)) * facing;
      const y = cross(pl.normal, dr.xDir);
      this.feature.plane = { ...this.feature.plane, xDir: norm(add(scale(dr.xDir, Math.cos(a)), scale(y, Math.sin(a)))) };
    } else {
      const a = view.rayToPlane(dr.from.x, dr.from.y, pl);
      const b = view.rayToPlane(p.x, p.y, pl);
      if (!a || !b) return;
      let d = sub(b, a);
      if (dr.part.kind === "axis") {
        const ax = this.gimbal.axes[dr.part.i];
        d = scale(ax, dot(d, ax));
      }
      this.feature.plane = { ...this.feature.plane, origin: add(dr.origin, d) };
    }
    this.update();
  }

  up(): void {
    this.dragging = null;
    this.gimbal.setHot(null);
  }
}

// ------------------------------------------------------------------- split

export class SplitOp extends FeatureOp<SplitFeature> {
  readonly id = "split";
  private plane: PlaneDef | null = null;

  constructor(app: AppContext, body: string, existing?: SplitFeature, plane?: PlaneDef) {
    super(app, { ...app.store.newIdentity("split"), type: "split", body, plane: plane ?? { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] } }, existing);
    this.plane = existing?.plane ?? plane ?? null;
    this.slots = [planeSlot(app, "Split with", () => this.plane, (p) => ((this.plane = p), (this.feature.plane = p)))];
  }

  protected hint(): string {
    return "The body is cut in two along the plane.";
  }

  protected items(): PanelItem[] {
    return [];
  }
}

// ------------------------------------------------------------ construction

export class PlaneOp extends FeatureOp<PlaneFeature> {
  readonly id = "plane";
  private base: PlaneDef | null = null;

  constructor(app: AppContext, base: PlaneDef | null, face: FaceRef | undefined, existing?: PlaneFeature) {
    super(app, { ...app.store.newIdentity("plane"), type: "plane", plane: base ?? { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] }, face, offset: 10 }, existing);
    this.base = existing ? existing.plane : base;
    this.slots = [planeSlot(app, "From", () => this.base, (p, f) => ((this.base = p), (this.feature.plane = p), (this.feature.face = f)))];
  }

  private handle: Handle | null = null;
  private dim: DimWidget | null = null;
  private dragging: { from: ToolPointer; d0: number } | null = null;
  private typing = new DragTyping(this.app);

  protected hint(): string {
    return this.base ? "Drag the arrow or type the offset (negative goes the other way)." : "Offset the new plane from a face or plane.";
  }

  protected items(): PanelItem[] {
    return [this.num("Offset", "offset", "length", { onInput: (v) => this.setOffset(v) })];
  }

  enter(): void {
    super.enter();
    this.onDraftChanged();
  }

  exit(): void {
    this.handle?.dispose();
    this.dim?.dispose();
    super.exit();
  }

  /** The arrow and value box come out once there's a face or plane to offset from. */
  protected onDraftChanged(): void {
    const b = this.base;
    if (!b) return;
    if (!this.handle) {
      this.handle = new Handle(this.app.view, "arrow");
      this.dim = new DimWidget(this.app.view, {
        boxAt: "beyond",
        boxGap: 96,
        dir: b.normal,
        value: this.feature.offset,
        onInput: (v) => this.setOffset(v),
        onCommit: () => this.done(),
      });
    }
    const top = add(b.origin, scale(b.normal, this.feature.offset));
    // The arrow keeps pointing out of the face; the value's sign says which side.
    this.handle.set(top, b.normal);
    this.dim!.set(b.origin, top);
  }

  private setOffset(v: number): void {
    this.feature.offset = v;
    this.app.ui.updatePanelValues([v]);
    this.dim?.setValue(v);
    this.update();
  }

  hover(p: ToolPointer | null): void {
    const on = !!p && !!this.handle && (!!this.dragging || this.handle.hit(p));
    this.handle?.setHot(on);
    if (!on) super.hover(p);
  }

  down(p: ToolPointer): boolean {
    if (!this.handle?.hit(p)) return false;
    this.dragging = { from: p, d0: this.feature.offset };
    return true;
  }

  drag(p: ToolPointer): void {
    const dr = this.dragging;
    const b = this.base;
    if (!dr || !b) return;
    this.typing.track(p);
    if (this.typing.active) return;
    const raw = dr.d0 + axisDrag(this.app.view, add(b.origin, scale(b.normal, dr.d0)), b.normal, dr.from, p);
    const step = niceStep(this.app.view.cam.worldPerPixel(this.app.view.height) * 4);
    this.setOffset(Math.round(raw / step) * step);
    this.app.ui.setLabel(p.x, p.y, `${fmtLen(this.feature.offset)}  · type a value`);
  }

  up(): void {
    this.dragging = null;
    this.typing.reset();
    this.app.ui.setLabel(0, 0, null);
    this.handle?.setHot(false);
  }

  dragKey(e: KeyboardEvent): boolean {
    const dr = this.dragging;
    if (!dr) return false;
    return this.typing.key(e, {
      kind: "length",
      apply: (v) => this.setOffset(v),
      commit: () => ((this.dragging = null), this.done()),
      cancel: () => this.setOffset(dr.d0),
    });
  }
}

/** Midplane between two parallel planes/faces. */
export function midplane(a: PlaneDef, b: PlaneDef): PlaneDef | null {
  if (Math.abs(dot(a.normal, b.normal)) < 0.999) return null;
  return { ...a, origin: scale(add(a.origin, b.origin), 0.5) };
}

export class MidplaneOp extends FeatureOp<PlaneFeature> {
  readonly id = "plane";
  private a: PlaneDef | null = null;
  private b: PlaneDef | null = null;

  constructor(app: AppContext) {
    super(app, { ...app.store.newIdentity("plane", "Midplane"), type: "plane", plane: { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] }, offset: 0 });
    const apply = () => {
      const m = this.a && this.b ? midplane(this.a, this.b) : null;
      if (m) this.feature.plane = m;
      else if (this.a && this.b) this.app.ui.toast("The two planes must be parallel");
    };
    this.slots = [
      planeSlot(app, "First", () => this.a, (p) => ((this.a = p), apply())),
      planeSlot(app, "Second", () => this.b, (p) => ((this.b = p), apply())),
    ];
  }

  protected ready(): boolean {
    return !!(this.a && this.b && midplane(this.a, this.b));
  }

  protected hint(): string {
    return "A plane halfway between two parallel planes or faces.";
  }

  protected items(): PanelItem[] {
    return [];
  }
}

export class AxisOp extends FeatureOp<AxisFeature> {
  readonly id = "axis";

  constructor(app: AppContext, origin: Vec3, dir: Vec3, existing?: AxisFeature) {
    super(app, { ...app.store.newIdentity("axis"), type: "axis", origin, dir }, existing);
  }

  protected hint(): string {
    return "Construction axis. Done to keep it.";
  }

  protected items(): PanelItem[] {
    return [];
  }

  enter(): void {
    super.enter();
    // Nothing to adjust: commit right away (it stays editable from History).
    this.done();
  }
}

export const planeFromNormal = (origin: Vec3, normal: Vec3): PlaneDef => ({ origin, normal: norm(normal), xDir: xDirFor(norm(normal)) });
