// Solid, transform and construction operations. Each is a FeatureOp:
// pick slots + values + live preview; see featureOp.ts.

import type { ThreadFeature } from "../doc/types";
import { fillEdgeKey } from "../doc/types";
import { defaultPitch, threadLabel } from "../kernel/threads";
import type { AxisFeature, AxisKind, AxisRef, ConnectFeature, EdgeFeature, EdgeRef, ExtrudeFeature, ExtrudeSource, FaceRef, FillFeature, FillToPlaneFeature, ImageFeature, LoftFeature, MoveFaceFeature, PathRef, PlaneDef, PlaneFeature, ReplaceFaceFeature, RevolveFeature, ScaleFaceFeature, ShellFeature, SketchFeature, SplitFeature, SweepFeature, TransformFeature, Vec3 } from "../doc/types";
import { FRONT, GROUND, RIGHT, add, cross, dot, len, norm, niceStep, patternSpacing, roundSig, scale, startSize, sub, xDirFor } from "../geom";
import type { PanelItem, ToolItem } from "../ui/ui";
import { QuickActions } from "./quickActions";
import { evaluate, fmtLen } from "../units";
import type { ToolPointer } from "../view/input";
import { FeatureOp, type Slot } from "./featureOp";
import { axisDrag, Handle } from "./handles";
import { axisSlot, chainThrough, curvesSlot, directionSlot, faceOfName, facesSlot, pathSlot, planeSlot, pointSlot, sectionsSlot } from "./slots";
import { edgeRefOf, edgesOfFace, faceIndexOf, faceRefOf, goneRefs, oppositeFace, sourceFrame, targetOf, type AppContext, type Sel } from "./tool";
import { SketchTool } from "./sketch";
import { screenClass } from "../device";
import { faceBeforeShell } from "./shellFace";
import { entityPolylines } from "../sketch/curves";
import { arrangement, drawnRegions, regionRef } from "../sketch/regions";
import { DimWidget } from "./annotate";
import { Ghost, ringGhost, rowGhost } from "./ghost";
import { Gimbal, GIMBAL_AXES, IN_PLANE, SCALE_PARTS, type GimbalPart } from "./gimbal";
import type { PickHit } from "../view/viewport";
import { DragTyping, type DragTypingTarget } from "./dragTyping";
import { isTouchDevice } from "../device";
import { CopyToggle, copyMode, linkMode } from "./copyToggle";
import { detachFreeformCopy, freeformBodies } from "../doc/freeformCopies";

type Mode = "auto" | "new" | "join" | "cut" | "intersect";
const MODES = [
  { id: "auto", label: "Auto" },
  { id: "new", label: "New body" },
  { id: "join", label: "Add" },
  { id: "cut", label: "Cut" },
  { id: "intersect", label: "Intersect" },
];

/** Any body in the project: with none, a new shape can only be a body of its own (no Operation to choose). */
const anyBody = (app: AppContext, self?: string) => app.view.bodyList.some((b) => b.id !== self);  // (its own preview is not one)

/**
 * The result choice, "Operation"; `plain`: without Intersect (a tool that only
 * adds, cuts or stands alone). `auto`: what Auto does here now ("Cut", "Add",
 * "New body") - said on its option.
 */
function modeChoice<M extends Mode>(get: () => M, set: (m: M) => void, rerender: () => void, plain = false, auto?: () => string): PanelItem {
  const effect = auto?.();
  const options = (plain ? MODES.filter((m) => m.id !== "intersect") : MODES).map((m) => (m.id === "auto" && effect ? { id: m.id, label: `Auto: ${effect}` } : m));
  const now = get();
  return { type: "choice", label: "Operation", options, value: now, onChange: (m) => (set(m as M), rerender()) };
}

/** What Auto does for a revolve, sweep or loft: adds to the body it is drawn on, else a body of its own. */
const autoAddsOrNew = (target: string | undefined) => (target ? "Add" : "New body");

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
/** The last extrude distance used: a new one from the Extrude button starts there. */
/**
 * `chosen`: the Operation chosen by hand for a shape of a sketch - the next shapes of that sketch start with it.
 * (Several shapes of one sketch made bodies one after another: New body had to be chosen again for each, where
 * a shape touched the body made before and Auto would add to it.) Of that sketch only: a Cut chosen once does
 * not wait in ambush for an extrude somewhere else.
 */
export const lastExtrude: { distance: number; set?: boolean; chosen?: { sketch: string; mode: ExtrudeFeature["mode"] } } = { distance: 10 };

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
    // Auto by the way it goes: + a new body (or added to the body it is drawn on), - a cut.
    if (!existing) (this.feature.byDirection = true), (this.feature.separate = true);
    // (Started with no Operation asked for, on a sketch one was chosen for by hand: that one.)
    const kept = lastExtrude.chosen;
    if (!existing && mode === "auto" && source.kind === "profile" && kept && kept.sketch === source.sketch && kept.mode !== "auto") this.feature.mode = kept.mode;
    this.frame = sourceFrame(app, this.feature.source);
    this.handle = new Handle(app.view, "arrow");
    if (this.feature.extent === "to") this.slots = [this.upToSlot()];
    if (source.kind === "face") {
      const k = faceIndexOf(app, source.face);
      if (k !== null) this.thick = oppositeFace(app, source.face.body, k);
    }
    this.measure = this.thick ? (opts.measure ?? "total") : "offset";
    // A digit typed on a selected face: the value so far (Total: the wall it leaves).
    if (opts.typed !== undefined && opts.distance === undefined && !existing) {
      const v = Number(opts.typed);
      if (Number.isFinite(v) && v > 0) this.feature.distance = this.measure === "total" && this.thick ? v - this.thick.distance : v;
    }
    if (opts.expr && !existing) this.feature.exprs = { distance: opts.expr };
    // Typed (on the face, before the tool started) as a formula: kept as one.
    else if (opts.typed && !existing) this.typedInto("distance", opts.typed, (t) => (this.thick && this.measure === "total" ? `${t} - ${Math.round(this.thick.distance * 1e6) / 1e6}mm` : t));
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
    // A new one: the other tools that can start from the same shape, beside it
    // in the column (drag the arrow: Extrude; tap one of these: that tool).
    if (this.offsetsFace()) {
      // Offset Face: the face moves (its neighbours follow) - not an extrusion, so none of those tools.
      this.app.ui.setTools([
        ...(screenClass() === "phone" ? [{ id: "cancel", label: "Cancel", icon: "close" as const, shortcut: "Esc", run: () => this.cancel() }] : []),
        { id: "offsetFace", label: "Offset Face", icon: "offsetFace", active: true, sub: "drag the arrow", run: () => {} },
      ]);
    } else if (!this.existing) {
      const src = this.feature.source;
      const sections: ExtrudeSource[] = src.kind === "profile" ? src.regions.map((r) => ({ ...src, regions: [r] })) : [src];
      this.app.ui.setTools([
        ...(screenClass() === "phone" ? [{ id: "cancel", label: "Cancel", icon: "close" as const, shortcut: "Esc", run: () => this.cancel() }] : []),
        { id: "extrude", label: "Extrude", icon: "extrude", active: true, sub: "drag the arrow", run: () => {} },
        { id: "revolve", label: "Revolve", icon: "revolve", run: () => this.app.setTool(new RevolveOp(this.app, src)) },
        { id: "sweep", label: "Sweep", icon: "sweep", run: () => this.app.setTool(new SweepOp(this.app, src)) },
        { id: "loft", label: "Loft", icon: "loft", sub: "then tap the next shape", run: () => this.app.setTool(new LoftOp(this.app, sections, [])) },
      ]);
    }
    // From a sketch: the new solid is see-through while you size it, so the profile stays in view.
    if (this.feature.source.kind === "profile") this.app.view.setGhost(true);
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
      onInput: (v, text) => {
        const total = this.measure === "total" && this.thick;
        this.typedInto("distance", text, (t) => (total ? `${t} - ${Math.round(this.thick!.distance * 1e6) / 1e6}mm` : t));
        this.setDistance(total ? v - this.thick!.distance : v);
      },
      onCommit: () => this.done(),
      onPin: () => this.pin(),
      variables: this.app.store.doc.variables.map((v) => v.name),
      onVariable: (name) => this.useVariable(name),
      typed: this.opts.typed,
      focus: this.opts.typed !== undefined,
    });
    this.onDraftChanged();
    this.showOps();
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

  /** A face of its own body pushed or pulled: Offset Face (the face moves; the faces around it follow). */
  private offsetsFace(): boolean {
    const src = this.feature.source;
    return src.kind === "face" && this.feature.mode !== "new" && this.feature.target === src.face.body;
  }

  protected hint(): string {
    if (this.offsetsFace()) return "Drag the arrow or type a distance to push or pull the face. The faces around it follow.";
    if (this.feature.extent === "through") return "It goes through every body in its way. Flip direction turns it the other way.";
    if (this.feature.extent === "to") return "It stops at the face or plane picked (a round face too).";
    // (A bin drafted 5 came out narrowing to the top: which way a sign leans wasn't said.)
    if (this.feature.draft) return `Draft ${Math.abs(this.feature.draft)}°: the sides lean ${this.feature.draft > 0 ? "in" : "out"}. A ${this.feature.draft > 0 ? "minus angle leans them out" : "plus angle leans them in"}.`;
    if (this.feature.symmetric) return "Symmetric: the distance goes each way from the shape - type half the whole width.";
    // (Auto goes by the way it is pulled: which way does what.)
    if (this.feature.mode !== "auto") return "Drag the arrow or type a distance.";
    if (!this.feature.byDirection) return "Drag the arrow or type a distance; - cuts.";
    return this.feature.target || this.feature.source.kind === "face" ? "Drag the arrow or type a distance: out adds, in cuts." : anyBody(this.app, this.feature.id) ? "Drag the arrow or type a distance: + a new body, - a cut." : "Drag the arrow or type a distance.";
  }

  protected items(): PanelItem[] {
    const src = this.feature.source;
    // Symmetric: what's typed goes each way (30 typed made a clamp 60 wide, the box said "Distance").
    const distance = this.num(this.feature.symmetric && !this.offsetsFace() ? "Each side" : "Distance", "distance", "length", { onInput: (v) => this.setDistance(v), inBox: true });
    // (No Join / Cut / New or taper: those make it an extrusion.)
    if (this.offsetsFace()) return [distance];
    const ext = this.feature.extent ?? "distance";
    return [
      ...(ext === "distance" ? [distance] : []),
      ...this.extentItems(),
      // One side, or both ways from the shape (the distance each side).
      {
        type: "choice" as const,
        label: "Sides",
        options: [
          { id: "one", label: "One side" },
          { id: "sym", label: "Symmetric" },
        ],
        value: this.feature.symmetric ? "sym" : "one",
        onChange: (id: string) => {
          this.feature.symmetric = id === "sym" || undefined;
          this.setHint();
          this.render();
          this.update();
          this.showOps();
        },
      },
      ...(anyBody(this.app, this.feature.id) ? [modeChoice(
        () => this.feature.mode,
        (m) => {
          const s = this.feature.source;
          if (!this.existing && s.kind === "profile") lastExtrude.chosen = { sketch: s.sketch, mode: m };
          this.setMode(m);
        },
        () => this.render(),
        false,
        () => (this.shownEffect = this.autoEffect()),
      )] : []),
      // Every shape in the sketch at once (a scale, lettering: hundreds of them,
      // far too many to tap) - holes stay holes.
      ...(src.kind === "profile" && !this.existing ? [{ type: "button" as const, label: "All shapes", onClick: () => this.allShapes() }] : []),
      ...this.startDraftItems(),
      // Lean the sides in towards a smaller end (a spire, a pyramid) - no angle to work out.
      // How big the far end is, in % of the shape: 100 none, 0 to a point. A
      // value box: type it, or press on it and drag left / right.
      {
        type: "number" as const,
        label: "Taper end %",
        value: Math.round((this.feature.taper ?? 1) * 1000) / 10,
        kind: "number" as const,
        min: 0,
        // With variables (a shade's mouth over its neck: "shadeR / neckR * 100"): kept as the
        // fraction it stands for ("(…) / 100"), shown as typed.
        expr: /^\((.*)\) \/ 100$/.exec(this.feature.exprs?.taper ?? "")?.[1] ?? (this.feature.exprs?.taper ? `(${this.feature.exprs.taper}) * 100` : undefined),
        onExpr: (x: string | null) => this.typedInto("taper", x ?? "", (t) => `(${t}) / 100`),
        onInput: (v: number) => {
          // Up to 10 times as big (a lamp shade from a narrow neck flares more than 3 times).
          const t = Math.min(1000, v) / 100;
          this.feature.taper = Math.abs(t - 1) < 1e-9 ? undefined : t;
          this.onDraftChanged();
        },
      },
    ];
  }

  private setMode(m: Mode): void {
    this.feature.mode = m;
    // Through all with no way picked yet: a cut goes into the body.
    if (this.feature.extent === "through" && !this.throughFlipped) this.feature.distance = this.throughInto(m) ? -1 : 1;
    // A new body from a face (a spire on a tower): its own height is what's typed,
    // not the total through the body - 68 typed came out 102 down into the tower.
    if (m === "new" && this.measure === "total") {
      this.measure = "offset";
      this.dim?.setMode("offset");
      this.dim?.setValue(this.shown());
    }
    this.update();
    this.showOps();
  }

  /**
   * From a body's face (pushed or pulled, or a sketch drawn on it): what it can
   * do, as round buttons beside the face on the far side from the arrow - out,
   * Add or New body; in, Cut, Intersect or New body. The one it does now is
   * lit; a tap makes it that. Made again only when the way or the choice changes.
   */
  private ops: QuickActions | null = null;
  private opsSig = "";

  private showOps(): void {
    const f = this.feature;
    const fromFace = (f.source.kind === "face" || !!f.target) && (f.extent ?? "distance") === "distance" && !f.symmetric;
    const out = f.distance >= 0;
    const now = f.mode === "auto" ? ({ Add: "join", Cut: "cut", "New body": "new" } as Record<string, Mode>)[this.autoEffect()] ?? "auto" : f.mode;
    const sig = fromFace && f.distance !== 0 ? `${out}|${now}` : "";
    if (sig === this.opsSig) return;
    this.opsSig = sig;
    this.ops?.dispose();
    this.ops = null;
    if (!sig) return;
    const pick = (m: Mode) => () => {
      this.setMode(m);
      this.setHint();
      this.render();
    };
    const items: ToolItem[] = (
      out
        ? [
            { id: "join", label: "Add", icon: "union" },
            { id: "new", label: "New body", icon: "newBody" },
          ]
        : [
            { id: "cut", label: "Cut", icon: "subtract" },
            { id: "intersect", label: "Intersect", icon: "intersect" },
            { id: "new", label: "New body", icon: "newBody" },
          ]
    ).map((it) => ({ ...it, icon: it.icon as ToolItem["icon"], active: it.id === now, run: pick(it.id as Mode) }));
    const n = this.frame.normal;
    this.ops = QuickActions.of(this.app.view, items, this.frame.base, { facing: out ? n : [-n[0], -n[1], -n[2]], hideBack: false });
  }

  /** Quick buttons switched on or off in Settings: these come, or go, at once (Operation on the line says the same). */
  quickSwitched(): void {
    this.opsSig = "?";
    this.showOps();
  }

  /**
   * Where it ends (a set distance, through everything, or up to a face or
   * plane), where it starts, and how much its sides lean (a draft).
   */
  private extentItems(): PanelItem[] {
    const f = this.feature;
    const ext = f.extent ?? "distance";
    return [
      {
        type: "choice" as const,
        label: "Ends",
        // (Through all: through the bodies there are - with none, not offered.)
        options: [
          { id: "distance", label: "Distance" },
          ...(ext === "through" || anyBody(this.app, f.id) ? [{ id: "through", label: "Through all" }] : []),
          { id: "to", label: "Up to" },
        ],
        value: ext,
        onChange: (id: string) => this.setExtent(id as "distance" | "through" | "to"),
      },
      // Through all: which way (the arrow's).
      ...(ext === "through"
        ? [{ type: "button" as const, label: "Flip direction", onClick: () => ((this.throughFlipped = true), (f.distance = -(f.distance || 1)), this.onDraftChanged(), this.render(), this.update()) }]
        : []),
    ];
  }

  /** Where it starts (from the shape, along its normal) and how far its sides lean. */
  private startDraftItems(): PanelItem[] {
    const f = this.feature;
    return [
      this.num("Start", "start", "length", { onInput: (v) => ((f.start = v || undefined), this.onDraftChanged(), this.update()) }),
      this.num("Draft angle", "draft", "angle", { onInput: (v) => ((f.draft = v || undefined), this.update()) }),
    ];
  }

  /** Flip direction pressed: Through all goes the way the user chose, whatever the mode. */
  private throughFlipped = false;

  /** Through all with no way picked: into the body for a cut, or for Auto on a body's face (it faces out). */
  private throughInto(mode: ExtrudeFeature["mode"]): boolean {
    if (mode === "cut") return true;
    if (mode !== "auto") return false;
    const src = this.feature.source;
    const sk = src.kind === "profile" ? this.app.store.find<SketchFeature>(src.sketch) : undefined;
    return !!sk?.attachedTo && dot(sk.attachedTo.normal, sk.plane.normal) > 0.5;
  }

  private setExtent(ext: "distance" | "through" | "to"): void {
    const f = this.feature;
    f.extent = ext === "distance" ? undefined : ext;
    if (ext !== "to") f.to = undefined;
    // Up to: a face or plane to pick (the next tap takes it).
    this.slots = ext === "to" ? [this.upToSlot()] : [];
    this.active = ext === "to" && !f.to ? 0 : -1;
    if (ext === "to" && f.symmetric) f.symmetric = undefined;
    // (No extrude made yet to go by: a quarter of the size of what is there.)
    if (ext === "distance" && !f.distance) f.distance = lastExtrude.set ? lastExtrude.distance : startSize(sceneSize(this.app), 0.25, lastExtrude.distance);
    // Through all, no way picked yet: a cut goes into the body (a sketch on a
    // face faces out of it: a hole "through all" went off into the air, cut nothing).
    // (So does Auto on a body's face: up off it, Through all only made a tower 350 high.)
    if (ext === "through" && !this.throughFlipped && (!f.distance || this.throughInto(f.mode))) f.distance = this.throughInto(f.mode) ? -1 : 1;
    this.onDraftChanged();
    this.render();
    this.update();
    this.showOps();
  }

  /** Up to: any face of a body (flat or round), or a plane. */
  private upToSlot(): Slot {
    let shown: Sel | null = null;
    let name = this.feature.to?.face ? "Face" : this.feature.to?.plane ? "Plane" : "";
    const take = (to: { face?: FaceRef; plane?: PlaneDef }, label: string, sel: Sel | null) => {
      this.feature.to = to;
      name = label;
      shown = sel;
    };
    return {
      label: "Up to",
      describe: () => (this.feature.to ? name || "Face" : "Tap a face or a plane"),
      filled: () => !!(this.feature.to?.face || this.feature.to?.plane),
      originPlanes: true,
      rejectHint: "Tap a face of a body, or a plane",
      pick: { profiles: false, edges: false, planes: true },
      presets: [
        ...["XY", "XZ", "YZ"].map((id) => ({ label: id, apply: () => take({ plane: this.app.view.planeOf(id)! }, `${id} plane`, null) })),
        ...this.app.view.construction.planes.map((c) => ({ label: c.name, apply: () => take({ plane: c.plane }, c.name, null) })),
      ],
      shows: () => (shown ? [shown] : []),
      accept: (hit) => {
        if (hit.kind === "plane") {
          const p = this.app.view.planeOf(hit.id);
          if (!p) return false;
          take({ plane: p }, ["XY", "XZ", "YZ"].includes(hit.id) ? `${hit.id} plane` : "Plane", { kind: "plane", id: hit.id });
          return true;
        }
        if (hit.kind === "face") {
          const ref = faceRefOf(this.app, hit);
          if (!ref) return false;
          take({ face: ref }, "Face", { kind: "face", body: hit.body, face: hit.face });
          return true;
        }
        return false;
      },
    };
  }

  private allShapes(): void {
    const src = this.feature.source;
    if (src.kind !== "profile") return;
    // What was drawn (not the outline of the face the sketch is on).
    const drawn = this.app.store.find<SketchFeature>(src.sketch)?.entities ?? [];
    const regs = drawnRegions(arrangement(this.app.sketchCurves(src.sketch)), arrangement(drawn));
    if (!regs.length) return;
    this.feature.source = { ...src, regions: regs.map(regionRef) };
    this.frame = sourceFrame(this.app, this.feature.source);
    this.app.setSelection(regs.map((r) => ({ kind: "profile" as const, sketch: src.sketch, region: r.index })));
    this.app.ui.toast(`${regs.length} shapes`);
    this.onDraftChanged();
  }

  protected ready(): boolean {
    const ext = this.feature.extent ?? "distance";
    if (ext === "to") return !!(this.feature.to?.face || this.feature.to?.plane);
    return ext === "through" || this.feature.distance !== 0;
  }

  exit(): void {
    this.exited = true;
    this.handle.dispose();
    this.dim?.dispose();
    this.ops?.dispose();
    this.ops = null;
    this.opsSig = "";
    this.app.view.setGhost(false);
    super.exit();
  }

  hover(p: ToolPointer | null): void {
    const on = !!p && (!!this.dragging || this.handle.hit(p));
    this.handle.setHot(on);
    this.app.view.canvas.style.cursor = on ? "grab" : "";
    if (!on) super.hover(p);
  }

  /**
   * Another region of the same sketch tapped while the arrow is still at 0
   * (on a phone a tapped region opens Extrude straight away): it joins the
   * profile - tapped again, it leaves. So several regions go up together.
   */
  tap(p: ToolPointer, count = 1): void {
    // The second tap of a double tap on a shape: open its sketch to edit it
    // (the first tap already opened Extrude, which took the second as "leave
    // the profile" - double-tapping to edit a shape worked only now and then).
    if (count >= 2 && this.feature.distance === 0 && this.feature.source.kind === "profile") {
      // On its outline or inside it (the middle of a 7 × 2 blade section is
      // too far from its edges for a finger): the piece of it nearest the tap.
      // (Worked out on the sketch's plane: its curves aren't picked while Extrude is open.)
      const sk = this.app.store.doc.features.find((f): f is SketchFeature => f.id === (this.feature.source as { sketch: string }).sketch && f.type === "sketch");
      const at = sk && this.app.view.rayToPlane(p.x, p.y, sk.plane);
      if (sk && at) {
        const y = cross(sk.plane.normal, sk.plane.xDir);
        const d = sub(at, sk.plane.origin);
        const uv = [dot(d, sk.plane.xDir), dot(d, y)];
        let best: { id: string; d: number } | null = null;
        for (const e of sk.entities)
          for (const poly of entityPolylines(e))
            for (let i = 1; i < poly.length; i++) {
              const [a, b] = [poly[i - 1], poly[i]];
              const ab = [b[0] - a[0], b[1] - a[1]];
              const t = Math.max(0, Math.min(1, ((uv[0] - a[0]) * ab[0] + (uv[1] - a[1]) * ab[1]) / (ab[0] ** 2 + ab[1] ** 2 || 1)));
              const dd = Math.hypot(a[0] + ab[0] * t - uv[0], a[1] + ab[1] * t - uv[1]);
              if (!best || dd < best.d) best = { id: e.id, d: dd };
            }
        if (best) {
          const tool = new SketchTool(this.app, { sketchId: sk.id });
          this.app.setSelection([]);
          this.app.setTool(tool);
          tool.preselect([best.id]);
          return;
        }
      }
    }
    if (this.feature.distance === 0 && this.regionTap(p)) return;
    super.tap(p);
  }

  /** (Extrude takes another shape by a tap until it has been pulled.) */
  protected addsRegions(): boolean {
    return this.feature.distance === 0;
  }

  protected regionsChanged(): void {
    this.frame = sourceFrame(this.app, this.feature.source);
  }

  /** When a tap on a shape opened it (straight away); not when a drag of its arrow did. */
  private openedAt = -Infinity;

  /** Opened by a tap: a second tap right after is the double tap's (not a grab of the arrow). */
  markTapped(): this {
    this.openedAt = performance.now();
    return this;
  }

  /**
   * The tool open, the shape or the face it pulls dragged by itself (not its arrow): that drag pulls it, as it does
   * before the tool is open. (On a phone a tap on a shape opens Extrude at once: the next thing a hand does is drag
   * the shape - which turned the view.)
   */
  dragStart(p: ToolPointer): boolean {
    if (this.dragging || this.feature.extent === "to" || this.feature.extent === "through") return false;
    const src = this.feature.source;
    const hit = this.app.view.pick(p.x, p.y, { planes: false, axes: false, edgeTolPx: p.tol });
    const mine = src.kind === "profile" ? hit?.kind === "profile" && hit.sketch === src.sketch : hit?.kind === "face" && hit.body === src.face.body && faceIndexOf(this.app, src.face) === hit.face;
    if (!mine) return false;
    this.dragging = { from: p, d0: this.feature.distance };
    this.handle.setHot(true);
    return true;
  }

  /** Started by dragging the face or shape itself: the press that opened this drags it, wherever on it it is. */
  private grabbed = false;
  grabAnywhere(): this {
    this.grabbed = true;
    return this;
  }

  down(p: ToolPointer): boolean {
    if (this.grabbed) {
      this.grabbed = false;
      this.dragging = { from: p, d0: this.feature.distance };
      this.handle.setHot(true);
      return true;
    }
    if (!this.handle.hit(p)) return false;
    // The second tap of a double tap on a small shape lands on the arrow just
    // drawn there: a tap still (to open the sketch), not a grab of the arrow.
    if (this.feature.distance === 0 && performance.now() - this.openedAt < 450) return false;
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
    this.typedInto("distance", "");
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

  /** What Auto does with the extrude as it is now. */
  private autoEffect(): string {
    const f = this.feature;
    const into = f.distance < 0;
    // On a face of a body (a sketch on it, or the face itself pushed): out adds to it, in cuts it.
    if (f.target || f.source.kind === "face") return into ? "Cut" : "Add";
    // On its own: going - it cuts what it runs into (a new body if nothing); + a new body (made before: a cut either way).
    if (!f.byDirection) return this.app.view.bodyList.length ? "Cut or new" : "New body";
    return into && this.app.view.bodyList.length ? "Cut" : "New body";
  }

  /** What the Operation row says Auto does, as it was last drawn. */
  private shownEffect = "";
  private exited = false;

  private setDistance(d: number): void {
    this.feature.distance = d;
    // Auto now does the other thing (dragged through the shape's plane, or
    // typed below 0): the Operation says so. (Against what it says, not the
    // distance before: the box writes the value in first - -8 typed for a
    // pocket cut it, the Operation still said "Auto: Add".)
    // (Typed in the window's own box: once it's left - drawn again now, the
    // window would be rebuilt under the finger, the box with what's typed gone.)
    if (this.feature.mode === "auto" && this.autoEffect() !== this.shownEffect) {
      const typing = document.activeElement instanceof HTMLElement && document.activeElement.closest("#panel") ? document.activeElement : null;
      if (typing) typing.addEventListener("blur", () => !this.exited && this.render(), { once: true });
      else queueMicrotask(() => this.render());
    }
    this.app.ui.updatePanelValues([d]);
    this.dim?.setValue(this.shown());
    this.update();
    this.showOps();
  }

  protected onDraftChanged(): void {
    this.handle.set(add(this.frame.base, scale(this.frame.normal, this.feature.distance)), this.frame.normal);
    const [a, b] = this.dimEnds();
    this.dim?.set(a, b);
  }

  protected done(): void {
    // Nothing pulled: nothing made. (Up to a face or plane, or through all, has
    // no distance of its own: Done there made nothing and said nothing.)
    // (A shape from a sketch left at 0 - Symmetric's box is "Each side", and
    // a 60 meant for it went nowhere: Done closed without a word.)
    if (this.feature.distance === 0 && (this.feature.extent ?? "distance") === "distance") {
      if (!this.existing && this.feature.source.kind === "profile") this.app.ui.toast(`Nothing made: the ${this.feature.symmetric ? "distance each side" : "distance"} was 0`);
      return this.app.setTool(null);
    }
    if (!this.existing && this.feature.source.kind === "profile") (lastExtrude.distance = this.feature.distance), (lastExtrude.set = true);
    super.done();
  }

}

// ---------------------------------------------------------- fillet/chamfer

/**
 * The edges with the other pieces of their circle: a loft from a square to a
 * round mouth has the mouth's circle in five pieces, and one tapped was a
 * quarter of the rim - its fillet could not be made ("would damage the body").
 */
function withCircleKin(app: AppContext, edges: EdgeRef[]): EdgeRef[] {
  const out = [...edges];
  const has = (body: string, m: Vec3) => out.some((e) => e.body === body && Math.hypot(...sub(e.mid, m)) < 1e-6);
  for (const e of edges) {
    const all = app.view.body(e.body)?.edges;
    const me = all?.find((x) => Math.hypot(...sub(x.mid, e.mid)) < 1e-6);
    if (!all || !me || me.type !== "CIRCLE") continue;
    // The circle through its ends and middle (a whole circle, its ends one point, is already whole).
    const a = sub(me.start, me.end), b = sub(me.mid, me.end);
    const n = cross(a, b);
    const nn = dot(n, n);
    if (nn < 1e-12 || Math.hypot(...a) < 1e-6) continue;
    const c = add(me.end, scale(cross(sub(scale(b, dot(a, a)), scale(a, dot(b, b))), n), 1 / (2 * nn)));
    const r = Math.hypot(...sub(me.mid, c));
    const axis = norm(n);
    const tol = 1e-5 * Math.max(1, r);
    const on = (q: Vec3) => Math.abs(Math.hypot(...sub(q, c)) - r) < tol && Math.abs(dot(sub(q, c), axis)) < tol;
    for (const x of all) {
      if (x.type !== "CIRCLE" || !on(x.start) || !on(x.mid) || !on(x.end) || has(e.body, x.mid)) continue;
      out.push({ body: e.body, mid: x.mid, dir: x.dir, length: x.length, ...(x.steps ? { steps: x.steps } : {}) });
    }
  }
  return out;
}

const XYZ: Vec3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

/** The smallest and the largest of the bodies' sizes along X, Y and Z (0: nothing to measure). */
export function bodySizes(app: AppContext, bodies: string[]): { least: number; most: number } {
  const all = XYZ.map((d) => bodyExtent(app, bodies, d)).filter((x) => x > 1e-9);
  return all.length ? { least: Math.min(...all), most: Math.max(...all) } : { least: 0, most: 0 };
}

/** How big what is in the project is: the largest of its sizes along X, Y and Z (0: no body yet). */
export function sceneSize(app: AppContext): number {
  return bodySizes(app, app.view.bodyList.map((b) => b.id)).most;
}

/** The size a fillet or a chamfer starts with on these edges. */
function edgeStartSize(app: AppContext, edges: EdgeRef[]): number {
  let ref = Infinity;
  for (const e of edges) if (e.length > 1e-9) ref = Math.min(ref, e.length);
  for (const b of new Set(edges.map((e) => e.body))) {
    const thin = bodySizes(app, [b]).least;
    if (thin > 0) ref = Math.min(ref, thin);
  }
  return startSize(Number.isFinite(ref) ? ref : 0, 0.1, 1);
}

export class EdgeOp extends FeatureOp<EdgeFeature> {
  readonly id: string;
  private handle: Handle;
  private origin: Vec3;
  private axis: Vec3;
  private dragging: { from: ToolPointer; r0: number; onDot?: boolean; moved?: boolean } | null = null;

  /** Text typed on the selected edges before the tool took over (restored into the size box). */
  private typed?: string;

  constructor(app: AppContext, kind: "fillet" | "chamfer", edges: EdgeRef[], existing?: EdgeFeature, variable?: string, typed?: string) {
    // Started from a variable: the size is that variable (and follows it when it changes).
    // Started by typing: the first digit is the size so far.
    const t = typed !== undefined && !variable ? Number(typed) : NaN;
    const v = variable ? evaluate(variable, "length") : t > 0 ? t : null;
    // Neither: a tenth of the shortest edge picked, or of the body where it is thinner than that - a size that
    // shows on the edge it is put on, small or a metre long.
    const start = v === null && !existing ? edgeStartSize(app, edges) : 1;
    super(app, { ...app.store.newIdentity(kind), type: kind, edges: existing ? edges : withCircleKin(app, edges), radius: v ?? start, ...(variable && v !== null ? { exprs: { radius: variable } } : {}) }, existing);
    if (v === null && !existing) this.startValue = { path: "radius", value: start, left: 6 };
    this.id = kind;
    this.typed = typed;
    this.names = { fillet: existing?.type === "fillet" ? existing.name : app.store.newIdentity("fillet").name, chamfer: existing?.type === "chamfer" ? existing.name : app.store.newIdentity("chamfer").name };
    const e = this.feature.edges[0];
    this.origin = e.mid;
    this.axis = outwardOf(app, e) ?? (() => {
      const view = app.view.camera.position.clone().sub(app.view.cam.target).normalize().toArray() as Vec3;
      const perp = norm(cross(cross(e.dir, view), e.dir));
      return dot(perp, view) < 0 ? scale(perp, -1) : perp;
    })();
    this.handle = new Handle(app.view, "dot");
    this.groupKin(this.feature.edges);
  }

  private names: { fillet: string; chamfer: string };

  /** Fillets sit outside the edge (+), chamfers inside (−): dragging across the edge switches. */
  private signed(): number {
    return this.feature.type === "fillet" ? this.feature.radius : -this.feature.radius;
  }

  protected hint(): string {
    return this.feature.type === "fillet" ? "Drag the dot or type a radius to round the edge. Tap more edges, or a face for all round it." : "Drag the dot or type a size to bevel the edge. Tap more edges, or a face for all round it.";
  }

  protected items(): PanelItem[] {
    const f = this.feature;
    // Fillet: one radius, or one that runs from a start radius to an end one.
    // Chamfer: the same distance along both faces, or a different one along each.
    const fillet = f.type === "fillet";
    const two = fillet ? f.radius2 !== undefined : f.distance2 !== undefined;
    const word = f.chord ? "width" : "radius";
    const size = this.num(fillet ? (two ? `Start ${word}` : f.chord ? "Width" : "Radius") : two ? "Distance 1" : "Distance", "radius", "length", { min: 0.0001, onInput: (v) => this.setRadius(v), inBox: true });
    // Fillet size: the radius, or the chord - straight across the round, face to face.
    // Round (circular) or Smooth (G2: the bend eases in from the faces).
    const blend: PanelItem = {
      type: "choice",
      label: "Blend",
      options: [
        { id: "round", label: "Round" },
        { id: "g2", label: "Smooth (G2)" },
      ],
      value: f.g2 ? "g2" : "round",
      onChange: (id) => {
        f.g2 = id === "g2" || undefined;
        if (f.g2) ((f.radius2 = undefined), (f.chord = undefined), (f.flip = undefined));
        this.render();
        this.update();
      },
    };
    if (fillet && f.g2) return [blend, size];
    const sizeBy: PanelItem[] = fillet
      ? [
          blend,
          {
            type: "choice",
            label: "Size",
            options: [
              { id: "radius", label: "Radius" },
              { id: "chord", label: "Chord width" },
            ],
            value: f.chord ? "chord" : "radius",
            onChange: (id) => {
              f.chord = id === "chord" || undefined;
              this.render();
              this.update();
            },
          },
        ]
      : [];
    return [
      {
        type: "choice",
        label: "Type",
        options: fillet
          ? [
              { id: "equal", label: "Constant" },
              { id: "two", label: "Variable" },
            ]
          : [
              { id: "equal", label: "Equal distance" },
              { id: "two", label: "Two distances" },
            ],
        value: two ? "two" : "equal",
        onChange: (id) => {
          if (id === "two") {
            if (fillet) f.radius2 = f.radius2 ?? roundSig(f.radius / 2);
            else f.distance2 = f.distance2 ?? f.radius;
          } else {
            f.distance2 = undefined;
            f.radius2 = undefined;
            f.flip = undefined;
          }
          this.render();
          this.update();
        },
      },
      ...sizeBy,
      size,
      ...(two
        ? [
            fillet ? this.num(`End ${word}`, "radius2", "length", { min: 0.0001 }) : this.num("Distance 2", "distance2", "length", { min: 0.0001 }),
            { type: "button" as const, label: fillet ? "Flip ends" : "Flip sides", icon: "flip" as const, onClick: () => ((f.flip = !f.flip || undefined), this.update()) },
          ]
        : []),
      // (Setback is for a corner where three rounded edges meet: offered once three are picked, or while it is set.)
      ...(fillet && ((f.edges?.length ?? 0) >= 3 || (f.setback ?? 0) > 0) ? [this.num("Corner setback", "setback", "length", { min: 0 })] : []),
    ];
  }

  /** The size, typed right at the edge (past the dot). */
  private dim: DimWidget | null = null;

  enter(): void {
    super.enter();
    // Edges it was built on that are gone (it said "pick the edges again"):
    // dropped, so the edges tapped now are what it rounds.
    const gone = this.existing ? goneRefs(this.app, this.feature.edges, this.feature.id) : [];
    if (gone.length) {
      this.feature.edges = this.feature.edges.filter((e) => !gone.includes(e));
      this.app.ui.toast(`${gone.length} of its edges ${gone.length > 1 ? "are" : "is"} gone - tap the edges to ${this.feature.type === "fillet" ? "round" : "cut"} now`);
    }
    this.app.setSelection(this.edgeSels());

    this.dim = new DimWidget(this.app.view, {
      boxAt: "beyond",
      boxGap: 40,
      dir: this.axis,
      value: this.feature.radius,
      onInput: (v, text) => {
        if (!(v > 0)) return;
        this.typedInto("radius", text);
        this.setRadius(v);
      },
      onCommit: () => this.done(),
      typed: this.typed,
      focus: this.typed !== undefined,
      variables: this.app.store.doc.variables.map((v) => v.name),
      onVariable: (name) => {
        const v = evaluate(name, "length");
        if (v === null || v <= 0) return;
        this.feature.exprs = { ...(this.feature.exprs ?? {}), radius: name };
        this.setRadius(v);
        this.render();
      },
    });
    this.onDraftChanged();
  }

  exit(): void {
    this.handle.dispose();
    this.dim?.dispose();
    this.dim = null;
    super.exit();
  }

  /** Tapping edges while filleting adds/removes them. */
  tap(p: ToolPointer): void {
    const hit = this.app.view.pick(p.x, p.y, { edgeTolPx: p.tol, profiles: false, planes: false, axes: false, vertices: false });
    // A picked edge, tapped again: dropped. Its preview has rounded it away
    // (the view shows the result), so it's found by where it was - when it's
    // nearer the finger than any edge the view has there (the lip's other top
    // edge, 6 mm off, tapped, is that one, not the first one again; the
    // chamfer's own new edge beside where the first was is not).
    {
      const shown = hit?.kind === "edge" ? this.app.view.body(hit.body)?.edges[hit.edge] : undefined;
      const hitD = shown ? this.screenDist(shown, p.x, p.y) : Infinity;
      // (A face under the finger: a picked edge counts only right by it - on a
      // plate's 8 mm side, seen at a slant, its rounded top edge was always
      // within a finger's reach, so the side never got added.)
      let again = this.pickedNear(p.x, p.y, Math.min(hit?.kind === "face" ? p.tol / 3 : p.tol, hitD));
      // Or the edge where its preview's rounding meets a face (a 1 mm round's,
      // a hair nearer the finger than the edge it rounds: it was added, not
      // the edge dropped) - along it, the radius off it.
      if (again < 0 && shown) again = this.roundedInto(shown);
      if (again >= 0) {
        this.dropWithKin(again);
        this.app.setSelection(this.edgeSels());
        this.update();
        return;
      }
    }
    if (!hit) return this.done();
    // A face: all the edges round it (a nut's top, its six edges in one tap) -
    // or, all of them picked already, none of them.
    // (What this step's own preview made - a round's border, where it runs
    // out onto a face - isn't an edge of the body it rounds: a block's top,
    // tapped with three of its upright edges picked, brought in the three
    // corner arcs of their rounds as edges to round too.)
    const own = (steps?: string[]) => !!steps?.includes(this.feature.id);
    if (hit.kind === "face") {
      const refs = edgesOfFace(this.app, hit.body, hit.face)
        .filter((k) => !this.app.view.body(hit.body)?.edges[k]?.seam)
        .flatMap((k) => edgeRefOf(this.app, { body: hit.body, edge: k }) ?? []);
      const at = (r: EdgeRef) => this.feature.edges.findIndex((e) => e.body === r.body && Math.hypot(...sub(e.mid, r.mid)) < 1e-6);
      if (!refs.length) return;
      // The face tapped again, as its preview shows it - its edges rounded
      // in, new ones (they were added on top: a gusset's side tapped by
      // mistake couldn't be undone). It's that face when every edge it shows
      // is a picked one's rounded border (or picked itself): those are
      // dropped. (Not the face beside a picked edge: its other edges aren't.)
      const was = refs.map((r) => (at(r) >= 0 ? at(r) : this.roundedInto(r)));
      if (refs.some((r) => at(r) < 0) && was.every((i) => i >= 0)) {
        const drop = new Set(was);
        this.feature.edges = this.feature.edges.filter((_, i) => !drop.has(i));
        this.app.setSelection(this.edgeSels());
        this.update();
        return;
      }
      if (refs.every((r) => at(r) >= 0)) this.feature.edges = this.feature.edges.filter((e) => !refs.some((r) => r.body === e.body && Math.hypot(...sub(e.mid, r.mid)) < 1e-6));
      else {
        // (Not a picked edge's rounded border, as the preview shows it: the
        // face beside a picked edge brought it in as an edge of its own.)
        const kin = withCircleKin(this.app, refs.filter((r) => at(r) < 0 && this.roundedInto(r) < 0 && !own(r.steps)));
        this.groupKin(kin);
        for (const r of kin) if (at(r) < 0) this.feature.edges.push(r);
      }
      this.app.setSelection(this.edgeSels());
      this.update();
      return;
    }
    if (hit.kind !== "edge") return;
    const info = this.app.view.body(hit.body)?.edges[hit.edge];
    if (!info) return;
    // A seam: the line where a round face starts and ends, the same face
    // either side - nothing there to round. (Picked, it broke the step: "an
    // edge it was built on is gone", and a tap again didn't take it out.)
    if (own(info.steps)) return;
    if (info.seam) return this.app.ui.toast("That line is a seam - where a round face starts and ends, no corner there to " + (this.feature.type === "chamfer" ? "chamfer" : "round") + ". Tap a real edge.");
    const i = this.feature.edges.findIndex((e) => e.body === hit.body && Math.hypot(...sub(e.mid, info.mid)) < 1e-6);
    if (i >= 0) this.dropWithKin(i);
    else {
      // (With the rest of its circle, where the circle is in pieces.)
      const have = (m: Vec3) => this.feature.edges.some((e) => e.body === hit.body && Math.hypot(...sub(e.mid, m)) < 1e-6);
      const kin = withCircleKin(this.app, [{ body: hit.body, mid: info.mid, dir: info.dir, length: info.length, ...(info.steps ? { steps: info.steps } : {}) }]);
      this.groupKin(kin);
      for (const r of kin) if (!have(r.mid)) this.feature.edges.push(r);
    }

    this.app.setSelection(this.edgeSels());
    this.update();
  }

  /** The picked straight edge whose preview's round (or cut) `e` is a border of: parallel, the size off it; else -1. */
  private roundedInto(e: { mid: Vec3; dir: Vec3 }): number {
    const r = this.feature.radius;
    const d = norm(e.dir);
    return this.feature.edges.findIndex((x) => {
      const xd = norm(x.dir);
      if (Math.abs(dot(xd, d)) < 0.9999) return false;
      const off = len(cross(sub(e.mid, x.mid), xd));
      // (Along it too: not the next edge over that happens to be in line.)
      return Math.abs(off - r) < 1e-3 * Math.max(1, r) && Math.abs(dot(sub(e.mid, x.mid), xd)) < x.length / 2;
    });
  }

  /** A picked edge dropped, and the other pieces of its circle with it (found before the preview rounded them away). */
  private dropWithKin(i: number): void {
    const key = (e: EdgeRef) => `${e.body}:${e.mid.map((v) => v.toFixed(5)).join(",")}`;
    const group = this.kinGroups.get(key(this.feature.edges[i]));
    this.feature.edges = this.feature.edges.filter((e, j) => j !== i && (group === undefined || this.kinGroups.get(key(e)) !== group));
  }

  /** Which picked edges are pieces of one circle (each piece's key: its group). */
  private kinGroups = new Map<string, number>();

  private groupKin(edges: EdgeRef[]): void {
    const key = (e: EdgeRef) => `${e.body}:${e.mid.map((v) => v.toFixed(5)).join(",")}`;
    for (const e of edges) {
      if (this.kinGroups.has(key(e))) continue;
      const kin = withCircleKin(this.app, [e]);
      if (kin.length < 2) continue;
      const g = this.kinGroups.size + 1;
      for (const k of kin) this.kinGroups.set(key(k), g);
    }
  }

  hover(): void {}

  /**
   * The picked edge (index) within `tol` px of the screen point, by its own
   * line (a straight edge's, or a curved one's middle), or -1. Only while the
   * view shows the preview: otherwise the edge is there to be picked.
   */
  private pickedNear(x: number, y: number, tol: number): number {
    const view = this.app.view;
    let best = -1;
    let bestD = tol;
    this.feature.edges.forEach((e, i) => {
      if (view.body(e.body)?.edges.some((q) => Math.hypot(...sub(q.mid, e.mid)) < 1e-6)) return;
      const dist = this.screenDist(e, x, y);
      if (dist < bestD) [best, bestD] = [i, dist];
    });
    return best;
  }

  /** How far (px) a screen point is from an edge drawn as the line through its middle along its direction. */
  private screenDist(e: { mid: Vec3; dir: Vec3; length?: number }, x: number, y: number): number {
    const view = this.app.view;
    const d = norm(e.dir);
    const half = (e.length ?? 0) / 2;
    const straight = Math.abs(len(e.dir)) > 0 && half > 0;
    const a = view.toScreen(straight ? sub(e.mid, scale(d, half)) : e.mid);
    const b = view.toScreen(straight ? add(e.mid, scale(d, half)) : e.mid);
    if (!a || !b) return Infinity;
    const [vx, vy] = [b[0] - a[0], b[1] - a[1]];
    const l2 = vx * vx + vy * vy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * vx + (y - a[1]) * vy) / l2)) : 0;
    return Math.hypot(x - (a[0] + t * vx), y - (a[1] + t * vy));
  }

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
    this.dragging = { from: p, r0: this.signed(), onDot: true };
    return true;
  }

  drag(p: ToolPointer): void {
    if (!this.dragging) return;
    if (Math.hypot(p.x - this.dragging.from.x, p.y - this.dragging.from.y) > 4) this.dragging.moved = true;
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
    this.typedInto("radius", "");
    this.setRadius(Math.max(step, Math.round(Math.abs(raw) / step) * step));
    this.app.ui.setLabel(p.x, p.y, `${kind === "fillet" ? "Fillet" : "Chamfer"} ${fmtLen(this.feature.radius)}  · type a value`);
  }

  up(): void {
    const d = this.dragging;
    this.dragging = null;
    this.typing.reset();
    this.app.ui.setLabel(0, 0, null);
    // The dot only touched, not dragged: a tap (on a lip 6 mm deep the dot on
    // one top edge sits a finger's width from the other, which took no taps there).
    // (Right on the dot it stays a touch of the dot.)
    const g = d?.onDot && !d.moved ? this.handle.grabPoint() : null;
    if (g && Math.hypot(g[0] - d!.from.x, g[1] - d!.from.y) > 14) this.tap(d!.from);
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
    this.dim?.setValue(r);
    this.update();
  }

  protected onDraftChanged(): void {
    const tip = add(this.origin, scale(this.axis, this.signed()));
    this.handle.set(tip);
    this.dim?.set(this.origin, tip);
    this.dim?.setValue(this.feature.radius);
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
    this.moreRegions = true;
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
    return "Set the angle (360° is a full turn). Drag the arrow along the axis to make a spring.";
  }

  protected items(): PanelItem[] {
    return [
      this.num("Angle", "angle", "angle"),
      this.num("Travel", "travel", "length", { onInput: (v) => this.setTravel(v), inBox: true }),
      ...(anyBody(this.app, this.feature.id) ? [modeChoice(() => this.feature.mode, (m) => ((this.feature.mode = m), this.update()), () => this.render(), false, () => autoAddsOrNew(this.feature.target))] : []),
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
      this.dim = new DimWidget(this.app.view, { boxAt: "beyond", boxGap: 96, dir: d, value: travel, onInput: (v, text) => (this.typedInto("travel", text), this.setTravel(v)), onCommit: () => this.done() });
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
    this.typedInto("travel", "");
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
    this.moreRegions = true;
    this.slots = [pathSlot(app, () => this.path, (p) => ((this.path = p), (this.feature.path = p)))];
  }

  protected hint(): string {
    return "The shape follows the path. Tap more lines to make the path longer.";
  }

  /** The path turns a corner somewhere: more than one piece, or a polyline. */
  private cornered(): boolean {
    const p = this.path;
    if (!p) return false;
    if (p.kind === "edges") return p.edges.length > 1;
    if (p.entities.length > 1) return true;
    const sk = this.app.store.features.find((f) => f.id === p.sketch) as { entities?: { id: string; kind: string }[] } | undefined;
    return sk?.entities?.find((e) => e.id === p.entities[0])?.kind === "polyline";
  }

  protected items(): PanelItem[] {
    // (Nothing to set before there is a path: how the shape goes along it comes once it has one.)
    const p = this.path;
    if (!p || (p.kind === "sketch" ? !p.entities.length : !p.edges.length)) return [];
    return [
      { type: "number", label: "End size", value: this.feature.scale ?? 1, kind: "number", min: 0.01, onInput: (v) => ((this.feature.scale = v > 0 ? v : 1), this.update()) },
      { type: "number", label: "Twist", value: this.feature.twist ?? 0, kind: "angle", onInput: (v) => ((this.feature.twist = v || undefined), this.update()) },
      {
        type: "choice",
        label: "Profile position",
        options: [
          { id: "auto", label: "Where it is" },
          { id: "start", label: "On the path's start" },
        ],
        value: this.feature.position ?? "auto",
        onChange: (v) => ((this.feature.position = v === "start" ? "start" : undefined), this.update()),
      },
      {
        type: "choice",
        label: "Orientation",
        options: [
          { id: "normal", label: "Normal to path" },
          { id: "parallel", label: "Parallel to profile" },
        ],
        value: this.feature.orientation ?? "normal",
        onChange: (v) => ((this.feature.orientation = v === "parallel" ? "parallel" : undefined), this.update()),
      },
      // (Round or mitred where the path turns a corner: only for a path of more than one piece.)
      ...(this.cornered() ? [{
        type: "choice" as const,
        label: "Corners",
        options: [
          { id: "round", label: "Round" },
          { id: "mitre", label: "Mitre" },
        ],
        value: this.feature.corner ?? "round",
        onChange: (v: string) => ((this.feature.corner = v === "mitre" ? "mitre" : undefined), this.update()),
      }] : []),
      ...(anyBody(this.app, this.feature.id) ? [modeChoice(() => this.feature.mode, (m) => ((this.feature.mode = m), this.update()), () => this.render(), false, () => autoAddsOrNew(this.feature.target))] : []),
    ];
  }
}

// -------------------------------------------------------------------- loft

export class LoftOp extends FeatureOp<LoftFeature> {
  readonly id = "loft";

  /** Which optional slots are open: the centre-line guide, guide curves along the sides, connections. */
  private extra: { guide: boolean; rails: boolean; conns: boolean };
  /** A connection being picked: its points so far, one per profile. */
  private pending: Vec3[] = [];

  constructor(app: AppContext, sections: ExtrudeSource[], initial: Sel[], existing?: LoftFeature) {
    super(app, { ...app.store.newIdentity("loft"), type: "loft", sections, ruled: false, mode: "new" }, existing);
    this.extra = { guide: !!existing?.guide, rails: !!existing?.rails?.length, conns: !!existing?.connections?.length };
    this.slots = this.makeSlots(initial);
  }

  private makeSlots(initial: Sel[] = []): Slot[] {
    const first = this.slots[0] ?? sectionsSlot(this.app, () => this.feature.sections, (s) => (this.feature.sections = s), initial);
    return [first, ...(this.extra.guide ? [this.guideSlot()] : []), ...(this.extra.rails ? [this.railsSlot()] : []), ...(this.extra.conns ? [this.connSlot()] : [])];
  }

  /** Guide curves along the sides: each a curve tapped (with the curves joined to it end to end), or an edge. */
  private railsSlot(): Slot {
    const f = this.feature;
    const app = this.app;
    const rails = () => f.rails ?? [];
    const set = (r: PathRef[]) => ((f.rails = r.length ? r : undefined), (f.ruled = false));
    return {
      label: "Guide curves",
      multi: true,
      describe: () => (rails().length ? `${rails().length} guide${rails().length > 1 ? "s" : ""}` : "Tap curves that run through every profile"),
      filled: () => true,
      pick: { profiles: false, curves: true, planes: false, axes: false },
      shows: () => rails().flatMap((p) => (p.kind === "sketch" ? p.entities.map((entity) => ({ kind: "curve", sketch: p.sketch, entity }) as Sel) : [])),
      get presets() {
        return rails().length ? [{ label: "Clear", apply: () => set([]) }] : [];
      },
      accept: (hit) => {
        if (hit.kind === "curve") {
          // Tapped again: that guide goes.
          const i = rails().findIndex((p) => p.kind === "sketch" && p.sketch === hit.sketch && p.entities.includes(hit.entity));
          if (i >= 0) return set(rails().filter((_, k) => k !== i)), true;
          const sk = app.store.find<SketchFeature>(hit.sketch);
          const chain = sk?.type === "sketch" ? chainThrough(sk.entities, hit.entity) : [hit.entity];
          set([...rails(), { kind: "sketch", sketch: hit.sketch, entities: chain.length ? chain : [hit.entity] }]);
          return true;
        }
        if (hit.kind === "edge") {
          const ref = edgeRefOf(app, hit);
          if (!ref) return false;
          const same = (p: PathRef) => p.kind === "edges" && JSON.stringify(p.edges[0]) === JSON.stringify(ref);
          set(rails().some(same) ? rails().filter((p) => !same(p)) : [...rails(), { kind: "edges", edges: [ref] }]);
          return true;
        }
        return false;
      },
    };
  }

  /** Connections: a point on each profile in turn (the loft joins them). */
  private connSlot(): Slot {
    const f = this.feature;
    const n = () => f.sections.length;
    const base = pointSlot(this.app, "Connections", () => null, (p) => {
      this.pending.push(p);
      if (this.pending.length >= n()) {
        f.connections = [...(f.connections ?? []), this.pending];
        this.pending = [];
        f.ruled = false;
      }
    });
    const done = () => f.connections?.length ?? 0;
    const pending = () => this.pending;
    const pendingClear = () => (this.pending = []);
    return {
      ...base,
      multi: true,
      describe: () =>
        this.pending.length
          ? `Now a point on profile ${this.pending.length + 1} of ${n()}`
          : done()
            ? `${done()} connection${done() > 1 ? "s" : ""} - tap a point on profile 1 for another`
            : `Tap a point on profile 1 (a corner snaps), then one on each next profile`,
      filled: () => true,
      get presets() {
        return done() || pending().length ? [{ label: "Clear", apply: () => ((f.connections = undefined), (pendingClear())) }] : [];
      },
    };
  }

  private continuityItems(): PanelItem[] {
    const f = this.feature;
    const opts = [
      { id: "free", label: "Free" },
      { id: "g1", label: "Tangent (G1)" },
      { id: "g2", label: "Smooth (G2)" },
    ];
    const end = (which: "start" | "end"): PanelItem[] => {
      const key = which === "start" ? "startContinuity" : "endContinuity";
      const wkey = which === "start" ? "startWeight" : "endWeight";
      const on = f[key];
      return [
        {
          type: "choice",
          label: which === "start" ? "Start" : "End",
          options: opts,
          value: on ?? "free",
          onChange: (v) => ((f[key] = v === "free" ? undefined : (v as "g1" | "g2")), this.render(), this.update()),
        },
        ...(on
          ? [{ type: "slider" as const, label: "Magnitude", value: f[wkey] ?? 1, min: 0.1, max: 3, step: 0.05, show: (v: number) => v.toFixed(2), onInput: (v: number) => ((f[wkey] = v === 1 ? undefined : v), this.update()) }]
          : []),
      ];
    };
    return [...end("start"), ...end("end")];
  }

  /** The optional guide: a curve the body follows from profile to profile. */
  private guideSlot() {
    return { ...pathSlot(this.app, () => this.feature.guide ?? null, (p) => (this.feature.guide = p)), label: "Centre line" };
  }

  protected hint(): string {
    if (this.extra.conns) return "Connections: tap a point on each profile in turn, and the loft joins them there.";
    if (this.extra.rails) return "Guide curves: each runs through every profile and the sides follow it. Tap one again to drop it.";
    if (this.feature.guide) return "The body follows the guide through each shape. Tap more curves to make the guide longer.";
    return "Tap the shapes in order: the body passes through each one.";
  }

  /** An optional slot switched on (and the others it can't go with off) or off. */
  private toggleExtra(k: "guide" | "rails" | "conns"): void {
    const f = this.feature;
    const on = !this.extra[k];
    this.extra[k] = on;
    if (on && k === "guide") (this.extra.rails = this.extra.conns = false), (f.rails = f.connections = undefined), (f.closed = undefined);
    if (on && k !== "guide") (this.extra.guide = false), (f.guide = undefined), (f.closed = undefined);
    if (!on) {
      if (k === "guide") f.guide = undefined;
      if (k === "rails") f.rails = undefined;
      if (k === "conns") (f.connections = undefined), (this.pending = []);
    }
    this.slots = this.makeSlots();
    this.active = on ? this.slots.length - 1 : -1;
    this.render();
    this.update();
  }

  protected items(): PanelItem[] {
    const f = this.feature;
    const guided = this.extra.guide;
    const held = this.extra.rails || this.extra.conns;
    return [
      ...(f.closed || guided || held ? [] : [{ type: "toggle" as const, label: "Straight sides", value: f.ruled, onChange: (v: boolean) => ((f.ruled = v), this.render(), this.update()) }]),
      // (A closed loop needs three shapes at least: with two it would only come back the way it went.)
      ...(held || (f.sections.length < 3 && !f.closed) ? [] : [{ type: "toggle" as const, label: "Closed loop", value: !!f.closed, onChange: (v: boolean) => ((f.closed = v || undefined), this.render(), this.update()) }]),
      // How it leaves the first shape and meets the last (free, tangent, or smoother still).
      ...(f.closed || guided || held || f.ruled ? [] : this.continuityItems()),
      { type: "button", label: guided ? "Remove centre line" : "Centre line", icon: guided ? "close" : "sweep", onClick: () => this.toggleExtra("guide") },
      { type: "button", label: this.extra.rails ? "Remove guide curves" : "Guide curves", icon: this.extra.rails ? "close" : "sweep", onClick: () => this.toggleExtra("rails") },
      { type: "button", label: this.extra.conns ? "Remove connections" : "Connections", icon: this.extra.conns ? "close" : "sweep", onClick: () => this.toggleExtra("conns") },
      ...(anyBody(this.app, this.feature.id) ? [modeChoice(() => this.feature.mode, (m) => ((this.feature.mode = m), this.update()), () => this.render(), false, () => autoAddsOrNew(this.feature.target))] : []),
    ];
  }
}

// ------------------------------------------------------------------- shell

export class ShellOp extends FeatureOp<ShellFeature> {
  readonly id = "shell";

  /** The body's faces before it's hollowed (the screen shows the preview once a face is picked). */
  private original: FaceRef[];

  constructor(app: AppContext, body: string, faces: FaceRef[], existing?: ShellFeature) {
    // (The wall to start with: a twentieth of the body's smallest size - 1 mm on a box 20 across, 50 on one a metre.)
    const start = existing ? 1 : startSize(bodySizes(app, [body]).least, 0.05, 1);
    super(app, { ...app.store.newIdentity("shell"), type: "shell", body, faces, thickness: start }, existing);
    if (!existing) this.startValue = { path: "thickness", value: start, left: 6 };
    this.original = (app.view.body(body)?.faces ?? []).map((f) => ({ body, center: f.center, normal: f.normal, area: f.area, ...(f.step ? { step: f.step } : {}), ...(f.curve ? { curve: f.curve } : {}) }));

    this.slots = [facesSlot(app, "Open faces", () => this.feature.faces, (f) => (this.feature.faces = f.map((r) => this.onOriginal(r))), true)];
    this.active = 0;
  }

  /**
   * A face tapped on the preview, as the face of the body it came from: with
   * one end already open, the next end is seen - and tapped - from inside, on
   * the hollowed preview's inner wall (a core cowl's front stayed shut: that
   * face isn't on the body being shelled). The flat face of the body parallel
   * to it, at most a wall away.
   */
  private onOriginal(r: FaceRef): FaceRef {
    return r.body === this.feature.body ? faceBeforeShell(this.original, r, this.feature.thickness) : r;
  }

  enter(): void {
    super.enter();
    // Faces to open that are gone (it said "pick the face again"): dropped, so the faces tapped now are used.
    const gone = this.existing ? goneRefs(this.app, this.feature.faces, this.feature.id) : [];
    if (gone.length) {
      this.feature.faces = this.feature.faces.filter((f) => !gone.includes(f));
      this.app.ui.toast(`${gone.length} of the faces it opened ${gone.length > 1 ? "are" : "is"} gone - tap the faces to leave open now`);
    }
    this.active = 0;
    this.render();
  }


  protected hint(): string {
    return this.feature.faces.length ? "Drag the arrow into the body, or type, for the wall's thickness. Tap more faces to open them." : "Tap the faces to leave open: an arrow comes up to set how thick the walls are.";
  }

  protected items(): PanelItem[] {
    return [this.num("Thickness", "thickness", "length", { min: 0.0001, onInput: (v) => this.setThickness(v), inBox: true })];
  }

  /** The wall thickness, typed on the open face tapped last - and dragged, by the arrow that points into the body there. */
  private dim: DimWidget | null = null;
  private dimFace = "";
  private handle: Handle | null = null;
  private dragging: { from: ToolPointer; t0: number; at: Vec3; into: Vec3 } | null = null;
  private typing = new DragTyping(this.app);

  hover(p: ToolPointer | null): void {
    const on = !!p && !!this.handle && (!!this.dragging || this.handle.hit(p));
    this.handle?.setHot(on);
    if (!on) super.hover(p);
  }

  down(p: ToolPointer): boolean {
    const f = this.feature.faces[this.feature.faces.length - 1];
    if (!f || !this.handle?.hit(p)) return false;
    this.dragging = { from: p, t0: this.feature.thickness, at: f.center, into: scale(f.normal, -1) };
    return true;
  }

  drag(p: ToolPointer): void {
    const dr = this.dragging;
    if (!dr) return;
    this.typing.track(p);
    if (this.typing.active) return;
    const raw = dr.t0 + axisDrag(this.app.view, add(dr.at, scale(dr.into, dr.t0)), dr.into, dr.from, p);
    const step = niceStep(this.app.view.cam.worldPerPixel(this.app.view.height) * 4);
    this.typedInto("thickness", "");
    // (A wall has some thickness: never less than a step.)
    this.setThickness(Math.max(step, Math.round(raw / step) * step));
    this.app.ui.setLabel(p.x, p.y, `Wall ${fmtLen(this.feature.thickness)}  · type a value`);
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
      apply: (v) => this.setThickness(v),
      commit: () => ((this.dragging = null), this.done()),
      cancel: () => this.setThickness(dr.t0),
    });
  }

  private setThickness(v: number): void {
    if (!(v > 0)) return;
    this.feature.thickness = v;
    this.app.ui.updatePanelValues([v]);
    this.dim?.setValue(v);
    this.update();
  }

  protected onDraftChanged(): void {
    // The face tapped last: the one being looked at. (On the first, a duct's
    // top, it was hidden from below when its other end was tapped there -
    // turned away - and the thickness was out of reach.)
    const f = this.feature.faces[this.feature.faces.length - 1];
    if (!f) {
      this.dim?.dispose();
      this.dim = null;
      this.handle?.dispose();
      this.handle = null;
      return;
    }
    // (Another face: the box goes with it, and turns away with it.)
    const key = `${f.body}:${f.center.map((x) => x.toFixed(6))}:${f.normal.map((x) => x.toFixed(6))}`;
    if (this.dim && this.dimFace !== key) {
      this.dim.dispose();
      this.dim = null;
    }
    this.dimFace = key;
    this.dim ??= new DimWidget(this.app.view, {
      noLine: true,
      facing: f.normal,
      value: this.feature.thickness,
      onInput: (v, text) => {
        if (!(v > 0)) return;
        this.typedInto("thickness", text);
        this.setThickness(v);
      },
      onCommit: () => this.done(),
    });
    // Just inside the face: the wall goes inwards from it.
    const a = add(f.center, scale(f.normal, -this.feature.thickness));
    this.dim.set(a, f.center);
    this.dim.setValue(this.feature.thickness);
    // The arrow: at the wall's inner side, pointing further in (dragged in, the wall gets thicker).
    this.handle ??= new Handle(this.app.view, "arrow");
    this.handle.set(a, scale(f.normal, -1));
  }

  exit(): void {
    this.dim?.dispose();
    this.dim = null;
    this.handle?.dispose();
    this.handle = null;
    super.exit();
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
    /** A pattern started from a hole's round wall: the hole is repeated in its body, not the body. */
    hole?: FaceRef,
    /** That hole's radius: the first spacing is three of them (the body's own length would put the next hole off it). */
    holeR?: number,
    /** A mirror or a pattern of features (faces of theirs picked): these steps' work is repeated in the body, not the body. */
    steps?: string[],
  ) {
    const center = pivot ?? bodyCenter(app, bodies);
    const op: TransformFeature["op"] =
      kind === "scale"
        ? { kind: "scale", center, factor: 1 }
        : kind === "mirror"
          ? { kind: "mirror", plane: { origin: [0, 0, 0], xDir: [0, 1, 0], normal: [1, 0, 0] } }
          : kind === "linear"
            ? { kind: "linear", dir: [1, 0, 0], spacing: (hole || steps?.length) && holeR ? Math.max(1, Math.round(holeR * 3 * 100) / 100) : patternSpacing(bodyExtent(app, bodies, [1, 0, 0]), 20), count: 3 }
            : kind === "circular"
              ? { kind: "circular", axis: { origin: [0, 0, 0], dir: [0, 0, 1] }, count: 6, angle: 360 }
              : { kind: "move", translate: [0, 0, 0], rotate: { origin: center, axis: [0, 0, 1], angle: 0 } };
    const label = kind === "linear" || kind === "circular" ? "Pattern" : TITLES[kind].split(" ")[0].replace("/Rotate", "");
    const repeats = !hole && !!steps?.length && (kind === "mirror" || kind === "linear" || kind === "circular");
    super(app, { ...app.store.newIdentity("transform", copy ? "Copy" : hole ? "Hole Pattern" : repeats ? `Feature ${label}` : label), type: "transform", bodies, copy: kind === "mirror" || copy, op, ...(hole && (kind === "linear" || kind === "circular") ? { hole } : {}), ...(repeats ? { steps } : {}) }, existing);
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
    // (A new pattern: linked if Link was left on the last time.)
    if ((kind === "linear" || kind === "circular") && !existing && linkMode.on) this.feature.link = true;
    if (kind === "move") {
      this.gimbal = new Gimbal(app.view);
      this.copyToggle = new CopyToggle(app.view, () => this.gimbal!.origin, (on) => ((this.feature.copy = on), (this.feature.link = on && linkMode.on ? true : undefined), this.render(), this.update()));
    }
  }

  /** A body tapped in Items: added to what's moved / patterned, or (there already) taken out - never the last (that tap does nothing). */
  toggleBody(id: string): boolean {
    const bs = this.feature.bodies;
    const i = bs.indexOf(id);
    if (i >= 0 && bs.length === 1) return true;
    this.feature.bodies = i >= 0 ? bs.filter((b) => b !== id) : [...bs, id];
    this.app.setSelection(this.feature.bodies.map((body) => ({ kind: "body" as const, body })));
    this.app.ui.toast(`${this.feature.bodies.length} bodies`);
    this.render();
    this.update();
    return true;
  }

  /**
   * A body tapped in the view that the plane or direction can't use (the next
   * pip of a row, to mirror with the first): it joins what's moved, as a tap
   * on it in Items does. (The only way was Items; in the view it said "tap a
   * flat face".)
   */
  protected otherBody(body: string): boolean {
    if (this.kind === "move" || this.kind === "translate" || !this.app.view.body(body)) return false;
    return this.toggleBody(body);
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
      if (doc.materials) d.materials = doc.materials;
    });
    this.app.setTool(null);
    this.app.setSelection(f.bodies.map((b) => ({ kind: "body" as const, body: ids.get(`${f.id}:${b}:0`) ?? `${f.id}:${b}:0` })));
  }

  protected hint(): string {
    switch (this.kind) {
      case "move":
        return "Drag an arrow to move it or an arc to turn it, or type. The middle dot is the point it turns about.";
      case "mirror":
        if (this.mirrorDraw) return this.mirrorDraw.from ? "Now tap where the mirror line ends. The mirror stands upright on it." : "Tap where the mirror line starts, on the floor. It catches on the grid, and on corners and edge ends.";
        return this.feature.steps?.length
          ? "Tap the plane to mirror across: the feature is built again on the other side, with everything made on it. It follows the original when that changes."
          : "The body is flipped across the plane. A copy is made unless you turn Copy off.";
      case "translate":
        return "Tap a point on the body, then the point it should move to.";
      default:
        return ({ rotate: "Set the angle to turn the body around the axis.", linear: this.dir ? "Drag the arrow, or type, to set how far apart the copies are; Count is how many." : "Tap an edge, an axis or a face: the copies go along it (point at one to see how, in dashed yellow).", circular: this.axis ? "Drag the dot round the axis, or type, for the angle the copies cover. Count is how many." : "Tap an axis, or a round edge or face: the copies go round it (point at an axis to see how)." } as Record<string, string>)[this.kind] ?? `${TITLES[this.kind]}: set the values, then tap empty space.`;
    }
  }

  private applyDir(): void {
    const o = this.feature.op;
    if (o.kind === "linear" && this.dir) {
      // A new pattern's spacing (not typed yet) follows the direction: the copies just clear of the bodies.
      const was = patternSpacing(bodyExtent(this.app, this.feature.bodies, o.dir), 20);
      if (!this.existing && Math.abs(o.spacing - was) < 1e-9) o.spacing = patternSpacing(bodyExtent(this.app, this.feature.bodies, this.dir), 20);
      o.dir = this.dir;
    }
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
    // (A feature mirrored or patterned in its body: nothing is copied, so no Copy and no Link to set.)
    const inBody = !!this.feature.steps?.length;
    const copy: PanelItem[] = inBody ? [] : this.feature.copy && !this.existing ? [copyToggle, link] : [copyToggle];
    // A pattern's Link: its copies and what they were made from change together afterwards - a hole cut in one is
    // cut in all. Off, each is a body of its own.
    const patternLink: PanelItem = {
      type: "toggle",
      label: "Link",
      value: !!this.feature.link,
      onChange: (v) => {
        linkMode.on = v;
        if (v) this.feature.link = true;
        else delete this.feature.link;
        this.render();
        up();
      },
    };
    // ΔX ΔY ΔZ: when changing a step opened from History, and on touch screens
    // (with a mouse, moving is dragging or typing while dragging - the numbers
    // are clutter there; a finger has no keyboard mid-drag, so exact moves need them).
    const deltas = (): PanelItem[] => (this.existing || isTouchDevice ? (["X", "Y", "Z"] as const).map((l, i): PanelItem => this.num(`Δ${l}`, `op.translate.${i}`, "length")) : []);
    switch (o.kind) {
      case "scaleXYZ":
        return [];
      case "move":
        if (this.kind === "translate") return [...deltas(), ...copy];
        {
          // The angle and the point it turns about can use variables (a joint
          // that turns by "a2" about "p2" high, and moves up when an arm gets
          // longer) - set when it's made, and when it's opened again from History.
          const pivot = (): PanelItem[] => (["X", "Y", "Z"] as const).map((l, i): PanelItem => this.num(`Pivot ${l}`, `op.rotate.origin.${i}`, "length"));
          if (this.kind === "rotate") {
            o.rotate ??= { origin: this.center, axis: [0, 0, 1], angle: 0 };
            return [this.num("Angle", "op.rotate.angle", "angle"), ...(this.axis ? pivot() : []), ...copy];
          }
          return [
            ...deltas(),
            o.rotate
              ? this.num(`Rotate ${axisName(o.rotate.axis)}`, "op.rotate.angle", "angle")
              : { type: "number", label: "Rotate Z", value: 0, kind: "angle", onExpr: (e) => this.setExpr("op.rotate.angle", e), onInput: (v) => ((o.rotate = { origin: this.center, axis: [0, 0, 1], angle: v }), up()) },
            ...(this.existing && o.rotate?.angle ? pivot() : []),
            ...copy,
          ];
        }
      case "scale":
        return [this.num("Factor", "op.factor", "number", { min: 0.0001 }), ...copy];
      case "mirror":
        return [
          // No plane or face where the mirror should be: its line drawn on the floor, with two taps. The mirror
          // stands upright on that line.
          {
            type: "slot",
            label: "Draw mirror line",
            value: this.mirrorDraw ? (this.mirrorDraw.from ? "Tap its end" : "Tap its start") : "Two taps on the floor",
            active: !!this.mirrorDraw,
            filled: false,
            onClick: () => {
              this.mirrorDraw = this.mirrorDraw ? null : { from: null };
              this.mirrorGhost?.dispose();
              this.mirrorGhost = null;
              this.render();
              this.setHint();
            },
          },
          ...copy,
        ];
      case "linear":
        return [
          this.num("Count", "op.count", "int", { min: 2 }),
          this.num("Spacing", "op.spacing", "length"),
          ...(inBody ? [] : [patternLink]),
        ];
      case "circular":
        return [
          this.num("Count", "op.count", "int", { min: 2 }),
          this.num("Angle", "op.angle", "angle"),
          ...(inBody ? [] : [patternLink]),
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
    this.dropPatternGrip();
    this.patGhost?.dispose();
    this.patGhost = null;
    this.mirrorGhost?.dispose();
    this.mirrorGhost = null;
    super.exit();
  }

  // ------------------------------------------------------------ mirror: its line drawn on the floor

  /** Mirror, its line being drawn: the first of its two points once that is tapped. */
  private mirrorDraw: { from: Vec3 | null } | null = null;
  private mirrorGhost: Ghost | null = null;

  /**
   * Where a tap is on the floor (the XY plane), for the mirror's line: a corner of a body, or the end or middle of
   * an edge, where the tap is on one (that point, straight down onto the floor); anywhere else, the grid.
   */
  private floorPoint(p: ToolPointer): Vec3 | null {
    const view = this.app.view;
    const hit = view.pick(p.x, p.y, { edgeTolPx: Math.max(10, p.tol), profiles: false, planes: false, axes: false });
    let at: Vec3 | null = null;
    if (hit?.kind === "vertex") at = view.vertexOf(hit.body, hit.vertex) ?? hit.point;
    else if (hit?.kind === "edge") {
      const e = view.body(hit.body)?.edges[hit.edge];
      const near = (q: Vec3) => {
        const s = view.toScreen(q);
        return !!s && Math.hypot(s[0] - p.x, s[1] - p.y) < 16;
      };
      at = (e && [e.start, e.end, e.mid].find(near)) ?? hit.point;
    }
    if (at) return [at[0], at[1], 0];
    const g = view.rayToPlane(p.x, p.y, { origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] });
    if (!g) return null;
    const step = view.grid.step || 1;
    return [Math.round(g[0] / step) * step, Math.round(g[1] / step) * step, 0];
  }

  /** (While its line is being drawn, the guide says how - not that a plane is still to be picked.) */
  protected setHint(): void {
    if (this.mirrorDraw) return void this.app.ui.setHint(this.hint());
    super.setHint();
  }

  /** The line so far, dashed, from its first point to `to`. */
  private showMirrorLine(to: Vec3 | null): void {
    this.mirrorGhost?.dispose();
    this.mirrorGhost = null;
    const from = this.mirrorDraw?.from;
    if (from && to && len(sub(to, from)) > 1e-9) this.mirrorGhost = new Ghost(this.app.view, [...from, ...to]);
  }

  tap(p: ToolPointer): void {
    const dr = this.mirrorDraw;
    const o = this.feature.op;
    if (!dr || o.kind !== "mirror") return super.tap(p);
    const q = this.floorPoint(p);
    if (!q) return void this.app.ui.toast("Tap where the floor is in view");
    if (!dr.from) {
      dr.from = q;
      this.render();
      this.setHint();
      return;
    }
    if (len(sub(q, dr.from)) < 1e-9) return void this.app.ui.toast("Tap a point away from the first one");
    // Upright on the line: the line runs in it, and so does straight up.
    const along = norm(sub(q, dr.from));
    const plane: PlaneDef = { origin: dr.from, xDir: along, normal: norm(cross(along, [0, 0, 1])) };
    this.plane = plane;
    o.plane = plane;
    this.mirrorDraw = null;
    this.showMirrorLine(null);
    this.render();
    this.update();
    this.setHint();
  }

  // A pattern's size is dragged where the copies are: an arrow on the first copy of a row (how far apart), a dot on
  // the last copy of a ring (the angle they are spread over) - each with its value in a box beside it.
  private patHandle: Handle | null = null;
  private patDim: DimWidget | null = null;
  private patDrag: { from: ToolPointer; v0: number } | null = null;

  private dropPatternGrip(): void {
    this.patHandle?.dispose();
    this.patHandle = null;
    this.patDim?.dispose();
    this.patDim = null;
  }

  /** The ring's frame: the foot of the bodies' centre on the axis, out to the centre, and round. */
  private ring(): { foot: Vec3; d: Vec3; u: Vec3; v: Vec3; r: number } | null {
    if (!this.axis) return null;
    const d = norm(this.axis.dir);
    const foot = add(this.axis.origin, scale(d, dot(sub(this.center, this.axis.origin), d)));
    const out = sub(this.center, foot);
    const r = len(out);
    if (r < 1e-6) return null;
    const u = scale(out, 1 / r);
    return { foot, d, u, v: cross(d, u), r };
  }

  private setSpacing(v: number): void {
    const o = this.feature.op;
    if (o.kind !== "linear" || !(Math.abs(v) > 1e-9)) return;
    o.spacing = v;
    this.app.ui.updatePanelValues([o.count, v]);
    this.patDim?.setValue(v);
    this.update();
  }

  private setSpread(v: number): void {
    const o = this.feature.op;
    if (o.kind !== "circular" || !(Math.abs(v) > 1e-9)) return;
    o.angle = v;
    this.app.ui.updatePanelValues([o.count, v]);
    this.patDim?.setValue(v);
    this.update();
  }

  protected onDraftChanged(): void {
    const o = this.feature.op;
    if (this.gimbal && o.kind === "move") this.gimbal.setCenter(add(this.center, o.translate));
    if (o.kind === "linear" && this.dir) {
      const d = this.dir;
      if (!this.patHandle) {
        this.patHandle = new Handle(this.app.view, "arrow");
        this.patDim = new DimWidget(this.app.view, { boxAt: "beyond", boxGap: 96, dir: d, value: o.spacing, onInput: (v, text) => (this.typedInto("op.spacing", text), this.setSpacing(v)), onCommit: () => this.done() });
      }
      const first = add(this.center, scale(d, o.spacing));
      this.patHandle.set(first, o.spacing < 0 ? scale(d, -1) : d);
      this.patDim!.set(this.center, first);
      this.patDim!.setValue(o.spacing);
    } else if (o.kind === "circular" && this.ring()) {
      const g = this.ring()!;
      // (Where the last copy is: a full turn shares the ring out evenly, a part of one ends on its angle.)
      const full = Math.abs(Math.abs(o.angle) - 360) < 1e-6;
      const last = ((full ? (o.angle * (o.count - 1)) / o.count : o.angle) * Math.PI) / 180;
      const at = add(g.foot, add(scale(g.u, g.r * Math.cos(last)), scale(g.v, g.r * Math.sin(last))));
      if (!this.patHandle) {
        this.patHandle = new Handle(this.app.view, "dot");
        this.patDim = new DimWidget(this.app.view, { boxAt: "beyond", boxGap: 40, angle: true, noLine: true, value: o.angle, onInput: (v, text) => (this.typedInto("op.angle", text), this.setSpread(v)), onCommit: () => this.done() });
      }
      this.patHandle.set(at);
      this.patDim!.set(g.foot, at);
      this.patDim!.setValue(o.angle);
    } else this.dropPatternGrip();
  }

  /** How the pattern would go along what is under the pointer, before its direction (or axis) is picked. */
  private patGhost: Ghost | null = null;
  private patGhostSig = "";
  private lookAhead(p: ToolPointer | null): void {
    const o = this.feature.op;
    const view = this.app.view;
    let segs: number[] = [];
    let sig = "";
    if (p && o.kind === "linear" && !this.dir) {
      const hit = view.pick(p.x, p.y, { edgeTolPx: p.tol, profiles: false, planes: false, axes: true, worldAxes: true });
      const dir = hit?.kind === "axis" ? view.axisOf(hit.id)?.plane.normal : hit?.kind === "edge" ? view.body(hit.body)?.edges[hit.edge]?.dir : hit?.kind === "face" ? view.body(hit.body)?.faces[hit.face]?.normal : undefined;
      if (dir) {
        sig = `l|${dir.map((x) => x.toFixed(4))}|${o.count}`;
        if (sig !== this.patGhostSig) segs = rowGhost(this.app, this.feature.bodies, dir, patternSpacing(bodyExtent(this.app, this.feature.bodies, norm(dir)), 20), o.count);
      }
    } else if (p && o.kind === "circular" && !this.axis) {
      const hit = view.pick(p.x, p.y, { edgeTolPx: p.tol, profiles: false, planes: false, axes: true, worldAxes: true });
      const ax = hit?.kind === "axis" ? view.axisOf(hit.id)?.plane : undefined;
      if (ax) {
        sig = `c|${ax.origin.map((x) => x.toFixed(4))}|${ax.normal.map((x) => x.toFixed(4))}|${o.count}|${o.angle}`;
        if (sig !== this.patGhostSig) segs = ringGhost(this.app, this.feature.bodies, { origin: ax.origin, dir: ax.normal }, o.angle, o.count);
      }
    }
    if (sig === this.patGhostSig) return;
    this.patGhostSig = sig;
    this.patGhost?.dispose();
    this.patGhost = segs.length ? new Ghost(view, segs) : null;
  }

  hover(p: ToolPointer | null): void {
    if (this.mirrorDraw) {
      this.app.setHover(null);
      return this.showMirrorLine(p ? this.floorPoint(p) : null);
    }
    this.lookAhead(p);
    if (this.patHandle) {
      const on = !!p && (!!this.patDrag || this.patHandle.hit(p));
      this.patHandle.setHot(on);
      if (on) return;
    }
    if (this.gimbal) this.gimbal.setHot(p && !this.dragging ? this.gimbal.hit(p) : this.dragging?.part ?? null);
    else super.hover(p);
  }

  /**
   * The ways its gimbal points: X, Y, Z - or, once its middle dot has been put on an edge, a corner or a flat face
   * of a body that does not stand square to them, that part's own ways (along the edge, square to the face).
   */
  private axes: Vec3[] = GIMBAL_AXES;
  /** What the middle dot is over while it is dragged (it turns the gimbal when let go). */
  private pivotOn: PickHit | null = null;

  /** The gimbal turned to what its middle dot was put on (left as it is where that has no ways of its own). */
  private turnTo(hit: PickHit | null, at: Vec3): void {
    const frame = hit ? frameAt(this.app, hit, at) : null;
    if (!frame || !this.gimbal) return;
    const same = frame.every((a, i) => dot(a, this.axes[i]) > 1 - 1e-9);
    if (same) return;
    this.axes = frame;
    const c = this.gimbal.origin;
    this.gimbal.dispose();
    this.gimbal = new Gimbal(this.app.view, { axes: frame });
    this.gimbal.setCenter(c);
    this.app.ui.toast(frame === GIMBAL_AXES ? "The arrows point along X, Y and Z again" : "The arrows now point the way that part does");
  }

  /** Started by dragging the body itself: the press that opened this slides it over the floor (seen from the side: across the screen). */
  private grabbed = false;
  /** The gimbal's middle dot is being moved (the point it turns about), not the body. */
  private pivotDrag = false;
  grabAnywhere(): this {
    this.grabbed = true;
    return this;
  }

  down(p: ToolPointer): boolean {
    const o = this.feature.op;
    if (this.patHandle?.hit(p) && (o.kind === "linear" || o.kind === "circular")) {
      this.patDrag = { from: p, v0: o.kind === "linear" ? o.spacing : o.angle };
      this.patHandle.setHot(true);
      return true;
    }
    const flat = Math.abs(this.app.view.cam.viewDir().z) > 0.25;
    const grabbed = this.grabbed;
    const part: GimbalPart | null | undefined = grabbed ? (flat ? { kind: "plane", i: 2 } : { kind: "center" }) : this.gimbal?.hit(p);
    this.grabbed = false;
    if (!part || o.kind !== "move") return false;
    // The dot in the middle, grabbed: it is the point everything turns about, and it is moved - to a corner, onto
    // an edge or a face (it snaps there), or anywhere - like the centre the view turns about. The body stays.
    if (part.kind === "center" && !grabbed) {
      this.pivotDrag = true;
      this.gimbal!.setHot(part);
      return true;
    }
    // A different rotation axis than the one already used: start from the current angle 0 on that axis.
    if (part.kind === "ring" && o.rotate && o.rotate.angle && !(Math.abs(dot(norm(o.rotate.axis), this.axes[part.i])) > 1 - 1e-9)) {
      this.app.ui.toast("One rotation axis per move - press Done, then rotate around the next axis");
      return true;
    }
    this.dragging = { from: p, part, t0: [...o.translate] as Vec3, a0: o.rotate?.angle ?? 0, center: add(this.center, o.translate) };
    this.gimbal!.setHot(part);
    return true;
  }

  drag(p: ToolPointer): void {
    const o = this.feature.op;
    const pd = this.patDrag;
    if (pd && o.kind === "linear" && this.dir) {
      this.typing.track(p);
      if (this.typing.active) return;
      const raw = pd.v0 + axisDrag(this.app.view, add(this.center, scale(this.dir, pd.v0)), this.dir, pd.from, p);
      const step = niceStep(this.app.view.cam.worldPerPixel(this.app.view.height) * 4);
      this.typedInto("op.spacing", "");
      this.setSpacing(Math.round(raw / step) * step || step);
      this.app.ui.setLabel(p.x, p.y, `${fmtLen(o.spacing)} apart  · type a value`);
      return;
    }
    if (pd && o.kind === "circular") {
      this.typing.track(p);
      if (this.typing.active) return;
      const g = this.ring();
      const at = g && this.app.view.rayToPlane(p.x, p.y, { origin: g.foot, normal: g.d, xDir: g.u });
      if (!g || !at) return;
      const w = sub(at, g.foot);
      // Round the axis from where the bodies are, 0 to 360 (Shift: not snapped to 5 degrees); nearly all the way: a full turn.
      let a = (Math.atan2(dot(w, g.v), dot(w, g.u)) * 180) / Math.PI;
      if (a <= 0) a += 360;
      if (!p.shift) a = Math.round(a / 5) * 5;
      if (a > 357 || a < 1) a = 360;
      this.typedInto("op.angle", "");
      this.setSpread(a);
      this.app.ui.setLabel(p.x, p.y, `${Math.round(a * 10) / 10}°${a === 360 ? " (all the way round)" : ""}  · type a value`);
      return;
    }
    if (this.pivotDrag && o.kind === "move") {
      const view = this.app.view;
      const hit = view.pick(p.x, p.y, { profiles: false, planes: false, axes: false, edgeTolPx: Math.max(10, p.tol) });
      const now = add(this.center, o.translate);
      const n = view.cam.viewDir().toArray() as Vec3;
      const at: Vec3 | null =
        hit?.kind === "vertex" ? (view.vertexOf(hit.body, hit.vertex) ?? hit.point) : hit?.kind === "edge" || hit?.kind === "face" ? hit.point : view.rayToPlane(p.x, p.y, { origin: now, normal: n, xDir: xDirFor(n) });
      if (!at) return;
      this.app.setHover(hit?.kind === "vertex" ? { kind: "vertex", body: hit.body, vertex: hit.vertex } : hit?.kind === "edge" ? { kind: "edge", body: hit.body, edge: hit.edge } : null);
      this.pivotOn = hit && (hit.kind === "vertex" || hit.kind === "edge" || hit.kind === "face") ? hit : null;
      // (Where the dot is shown is the centre moved with the body so far.)
      this.center = sub(at, o.translate);
      if (o.rotate) o.rotate.origin = this.center;
      this.gimbal?.setCenter(at);
      this.app.ui.setLabel(p.x, p.y, hit?.kind === "vertex" ? "Centre: on the corner" : hit?.kind === "edge" ? "Centre: on the edge" : hit?.kind === "face" ? "Centre: on the face" : "Centre");
      if (o.rotate?.angle) this.update();
      return;
    }
    const dr = this.dragging;
    if (!dr || o.kind !== "move") return;
    this.typing.track(p);
    if (this.typing.active) return;
    const view = this.app.view;
    const step = niceStep(view.cam.worldPerPixel(view.height) * 4);
    const snap = (v: number) => (p.shift ? v : Math.round(v / step) * step);
    const part = dr.part;
    if (part.kind === "axis") {
      const dir = this.axes[part.i];
      const d = snap(axisDrag(view, dr.center, dir, dr.from, p));
      o.translate = add(dr.t0, scale(dir, d));
      this.boxAt(p, fmtLen(d));
    } else if (part.kind === "plane" || part.kind === "center") {
      // Move in the plane of the square (or the screen plane for the centre).
      const n: Vec3 = part.kind === "plane" ? this.axes[part.i] : (view.cam.viewDir().toArray() as Vec3);
      const plane = { origin: dr.center, normal: n, xDir: xDirFor(n) };
      const a = view.rayToPlane(dr.from.x, dr.from.y, plane);
      const b = view.rayToPlane(p.x, p.y, plane);
      if (!a || !b) return;
      const d = sub(b, a);
      // (In steps along the gimbal's own ways: along X, Y and Z when it points along them.)
      o.translate = this.axes.reduce((t, ax) => add(t, scale(ax, snap(dot(d, ax)))), [...dr.t0] as Vec3);
      this.boxAt(p, fmtLen(len(sub(o.translate, dr.t0))));
    } else {
      const axis = this.axes[part.i];
      const c = view.toScreen(dr.center);
      if (!c) return;
      const ang = (q: { x: number; y: number }) => Math.atan2(q.y - c[1], q.x - c[0]);
      // Screen y points down, so a visual counter-clockwise turn is a negative atan2 change.
      const facing = dot(axis, view.cam.viewDir().toArray() as Vec3) < 0 ? 1 : -1;
      let deg = (-(ang(p) - ang(dr.from)) * 180) / Math.PI * facing;
      deg = ((deg + 540) % 360) - 180;
      const total = p.shift ? dr.a0 + deg : Math.round((dr.a0 + deg) / 5) * 5;
      o.rotate = { origin: this.center, axis, angle: total };
      this.boxAt(p, `${Math.round(total * 10) / 10}°`);
    }
    this.app.ui.updatePanelValues([o.translate[0], o.translate[1], o.translate[2], o.rotate?.angle ?? 0]);
    this.update();
  }

  up(): void {
    if (this.patDrag) {
      this.patDrag = null;
      this.typing.reset();
      this.app.ui.setLabel(0, 0, null);
      this.patHandle?.setHot(false);
      return;
    }
    if (this.pivotDrag) {
      this.pivotDrag = false;
      this.app.setHover(null);
      this.app.ui.setLabel(0, 0, null);
      this.gimbal?.setHot(null);
      // Put on an edge, a corner or a flat face: the arrows turn to point its way.
      if (this.gimbal) this.turnTo(this.pivotOn, this.gimbal.origin);
      this.pivotOn = null;
      return;
    }
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
  /** What a typed value does to the part being dragged (typed during the drag, or in its value box after). */
  private dragTarget(): DragTypingTarget | null {
    const o = this.feature.op;
    const dr = this.dragging;
    if (!dr || o.kind !== "move") return null;
    const part = dr.part;
    const refresh = () => {
      this.app.ui.updatePanelValues([o.translate[0], o.translate[1], o.translate[2], o.rotate?.angle ?? 0]);
      this.update();
    };
    // Squares/centre: along the direction dragged so far.
    const dragDir = norm(sub(o.translate, dr.t0));
    return {
      kind: part.kind === "ring" ? "angle" : "length",
      apply: (v) => {
        if (part.kind === "ring") o.rotate = { origin: this.center, axis: this.axes[part.i], angle: dr.a0 + v };
        else if (part.kind === "axis") o.translate = add(dr.t0, scale(this.axes[part.i], v));
        else if (len(dragDir) > 0.5) o.translate = add(dr.t0, scale(dragDir, v));
        refresh();
      },
      commit: () => ((this.dragging = null), this.gimbal?.setHot(null), this.done()),
      cancel: () => ((o.translate = [...dr.t0] as Vec3), o.rotate && (o.rotate.angle = dr.a0), refresh()),
    };
  }

  /** The drag's value in a box by the pointer (typeable, and it stays after letting go). */
  private boxAt(p: ToolPointer, text: string): void {
    const t = this.dragTarget();
    if (t) this.typing.box(p, text, t);
  }

  dragKey(e: KeyboardEvent): boolean {
    const pd = this.patDrag;
    const o = this.feature.op;
    if (pd && (o.kind === "linear" || o.kind === "circular")) {
      const set = (v: number) => (o.kind === "linear" ? this.setSpacing(v) : this.setSpread(v));
      return this.typing.key(e, { kind: o.kind === "linear" ? "length" : "angle", apply: set, commit: () => ((this.patDrag = null), this.done()), cancel: () => set(pd.v0) });
    }
    const t = this.dragTarget();
    return !!t && this.typing.key(e, t);
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
      this.axes = MoveFaceOp.edgeAxes(target.edge.dir);
    }
    // Face: push it, slide it in its plane, tilt it, turn it about its normal
    // (a body of flat faces: the faces round it follow). Edge: move across it, tilt it.
    const parts = isFace ? () => true : MoveFaceOp.edgeParts;
    this.gimbal = new Gimbal(app.view, { axes: this.axes, parts });
    this.center = this.feature.rotate?.origin ?? center;
  }

  /** An edge's gimbal: across it, and tilting it (along itself changes nothing). */
  static edgeParts = (p: GimbalPart): boolean => (p.kind === "axis" && p.i > 0) || (p.kind === "plane" && p.i === 0) || (p.kind === "ring" && p.i > 0);

  /** The axes of an edge's gimbal: along it, then two across. */
  static edgeAxes(dir: Vec3): Vec3[] {
    const d = norm(dir);
    const u = xDirFor(d);
    return [d, u, cross(d, u)];
  }

  protected hint(): string {
    return "Drag an arrow to move the face, or an arc to tilt it. You can type a value while dragging.";
  }

  protected items(): PanelItem[] {
    const f = this.feature;
    // ΔX ΔY ΔZ only when changing a step opened from History.
    const xyz = this.existing ? (["X", "Y", "Z"] as const).map((l, i): PanelItem => this.num(`Δ${l}`, `translate.${i}`, "length")) : [];
    if (f.vertex) return xyz;
    return [
      ...xyz,
      f.rotate ? this.num("Tilt", "rotate.angle", "angle") : { type: "number", label: "Tilt", value: 0, kind: "angle", onExpr: (e) => this.setExpr("rotate.angle", e), onInput: (v) => ((f.rotate = { origin: this.center, axis: this.axes[0], angle: v }), this.update()) },
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
      this.app.ui.toast("One tilt axis per move - press Done, then tilt around the next axis");
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
      this.boxAt(p, `${fmtLen(d)}`);
    } else if (part.kind === "center") {
      // Free move in the screen plane.
      const n = view.cam.viewDir().toArray() as Vec3;
      const plane = { origin: dr.center, normal: n, xDir: xDirFor(n) };
      const a = view.rayToPlane(dr.from.x, dr.from.y, plane);
      const b = view.rayToPlane(p.x, p.y, plane);
      if (!a || !b) return;
      const d = sub(b, a);
      f.translate = add(dr.t0, [snap(d[0]), snap(d[1]), snap(d[2])]);
      this.boxAt(p, `${fmtLen(len(sub(f.translate, dr.t0)))}`);    } else if (part.kind === "plane") {
      const n = this.axes[part.i];
      const plane = { origin: dr.center, normal: n, xDir: xDirFor(n) };
      const a = view.rayToPlane(dr.from.x, dr.from.y, plane);
      const b = view.rayToPlane(p.x, p.y, plane);
      if (!a || !b) return;
      const d = sub(b, a);
      f.translate = add(dr.t0, [snap(d[0]), snap(d[1]), snap(d[2])]);
      this.boxAt(p, `${fmtLen(len(sub(f.translate, dr.t0)))}`);
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
      this.boxAt(p, `${Math.round(total * 10) / 10}°`);
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

  /** What a typed value does to the part being dragged (typed during the drag, or in its value box after). */
  private dragTarget(): DragTypingTarget | null {
    const f = this.feature;
    const dr = this.dragging;
    if (!dr) return null;
    const part = dr.part;
    const refresh = () => {
      this.app.ui.updatePanelValues([f.translate[0], f.translate[1], f.translate[2], f.rotate?.angle ?? 0]);
      this.update();
    };
    const dragDir = norm(sub(f.translate, dr.t0));
    return {
      kind: part.kind === "ring" ? "angle" : "length",
      apply: (v) => {
        if (part.kind === "ring") f.rotate = { origin: this.center, axis: this.axes[part.i], angle: dr.a0 + v };
        else if (part.kind === "axis") f.translate = add(dr.t0, scale(this.axes[part.i], v));
        else if (len(dragDir) > 0.5) f.translate = add(dr.t0, scale(dragDir, v));
        refresh();
      },
      commit: () => ((this.dragging = null), this.gimbal.setHot(null), this.done()),
      cancel: () => ((f.translate = [...dr.t0] as Vec3), f.rotate && (f.rotate.angle = dr.a0), refresh()),
    };
  }

  /** The drag's value in a box by the pointer (typeable, and it stays after letting go). */
  private boxAt(p: ToolPointer, text: string): void {
    const t = this.dragTarget();
    if (t) this.typing.box(p, text, t);
  }

  dragKey(e: KeyboardEvent): boolean {
    const t = this.dragTarget();
    return !!t && this.typing.key(e, t);
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
      ? "Drag a handle to stretch the body that way, or the centre to resize it evenly. Or type (2 = twice)."
      : "Drag a handle to resize. Type a number while dragging (2 = twice as big).";
  }

  protected items(): PanelItem[] {
    const ways = this.existing ? [] : [scaleWays(this.app, this.xyz ? "xyz" : "uniform", this.feature.bodies)];
    // (Beside the choice, which says Scale already, each is its letter: the four fit a phone in one row.)
    if (this.xyz) return [...ways, ...(["X", "Y", "Z"] as const).map((l, i): PanelItem => this.num(ways.length ? l : `Scale ${l}`, `op.factors.${i}`, "number", { min: 0.0001 }))];
    return [...ways, this.num("Factor", "op.factor", "number", { min: 0.0001 }), { type: "toggle", label: "Copy", value: this.feature.copy, onChange: (v) => ((this.feature.copy = v), this.render(), this.update()) }];
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
    this.boxAt(p, `×${(dr.part.kind === "axis" && this.xyz ? k[dr.part.i] : k[0]).toFixed(2)}`);
  }

  up(): void {
    this.dragging = null;
    this.typing.reset();
    this.app.ui.setLabel(0, 0, null);
    this.gimbal.setHot(null);
  }

  /** What a typed value does to the part being dragged (typed during the drag, or in its value box after). */
  private dragTarget(): DragTypingTarget | null {
    const dr = this.dragging;
    if (!dr) return null;
    return {
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
    };
  }

  /** The drag's value in a box by the pointer (typeable, and it stays after letting go). */
  private boxAt(p: ToolPointer, text: string): void {
    const t = this.dragTarget();
    if (t) this.typing.box(p, text, t);
  }

  dragKey(e: KeyboardEvent): boolean {
    const t = this.dragTarget();
    return !!t && this.typing.key(e, t);
  }
}

/**
 * Scale by reference: tap two points on the bodies (corners, edges, faces),
 * type what the distance between them should be - the bodies scale about the
 * first point so it is (everything on them with it).
 */
/** The way Scale was used last: it starts that way again. */
export const scaleWay: { kind: "uniform" | "xyz" | "ref" } = { kind: "uniform" };

/**
 * Scale's three ways - evenly, each direction by itself, or two points and the distance they should be - on the line
 * of the tool itself, whichever way it was started. (They were a list under Scale that only some ways in showed:
 * from the line Scale opened by a factor, with nothing to say there were two more.)
 */
function scaleWays(app: AppContext, now: "uniform" | "xyz" | "ref", bodies: string[]): PanelItem {
  return {
    type: "choice",
    label: "Scale",
    lead: true,
    options: [{ id: "uniform", label: "Uniform" }, { id: "xyz", label: "X / Y / Z" }, { id: "ref", label: "By reference" }],
    value: now,
    onChange: (v) => {
      if (v === now) return;
      scaleWay.kind = v as typeof now;
      app.setTool(v === "ref" ? new ScaleRefOp(app, bodies) : new ScaleOp(app, v === "xyz", bodies));
    },
  };
}

export class ScaleRefOp extends FeatureOp<TransformFeature> {
  readonly id = "scale";
  private a: Vec3 | null = null;
  private b: Vec3 | null = null;
  private dim: DimWidget | null = null;

  constructor(app: AppContext, bodies: string[], existing?: TransformFeature) {
    super(app, { ...app.store.newIdentity("transform", "Scale"), type: "transform", bodies, copy: false, op: { kind: "scale", center: [0, 0, 0], factor: 1 } }, existing);
    const o = this.feature.op;
    if (o.kind === "scale" && o.ref) [this.a, this.b] = o.ref;
    this.slots = [
      pointSlot(app, "First point (stays put)", () => this.a, (p) => ((this.a = p), this.placed())),
      pointSlot(app, "Second point", () => this.b, (p) => ((this.b = p), this.placed())),
    ];
  }

  /** Distance between the two points before scaling. */
  private get d0(): number {
    return this.a && this.b ? len(sub(this.b, this.a)) : 0;
  }

  private placed(): void {
    const o = this.feature.op;
    if (o.kind !== "scale" || !this.a) return;
    o.center = this.a;
    if (this.b) o.ref = [this.a, this.b];
  }

  protected hint(): string {
    return "Type the new distance between the two points. The body resizes to match.";
  }

  protected items(): PanelItem[] {
    const o = this.feature.op;
    const ways = this.existing ? [] : [scaleWays(this.app, "ref", this.feature.bodies)];
    if (o.kind !== "scale" || this.d0 < 1e-9) return ways;
    return [
      ...ways,
      { type: "number", label: "Distance", value: this.d0 * o.factor, kind: "length", onInput: (v) => this.setLength(v) },
      this.num("Factor", "op.factor", "number", { min: 0.0001, onInput: () => (this.dim?.setValue(this.d0 * (this.feature.op as { factor: number }).factor), this.update()) }),
    ];
  }

  private setLength(v: number): void {
    const o = this.feature.op;
    if (o.kind !== "scale" || !(v > 0) || this.d0 < 1e-9) return;
    o.factor = v / this.d0;
    this.app.ui.updatePanelValues([v, o.factor]);
    this.update();
  }

  protected ready(): boolean {
    const o = this.feature.op;
    return super.ready() && this.d0 > 1e-9 && o.kind === "scale" && Math.abs(o.factor - 1) > 1e-9;
  }

  /** Both points: the dimension between them, its value box ready to type into. */
  protected onDraftChanged(): void {
    const o = this.feature.op;
    if (!this.a || !this.b || this.d0 < 1e-9 || o.kind !== "scale") {
      this.dim?.dispose();
      this.dim = null;
      return;
    }
    const fresh = !this.dim;
    this.dim ??= new DimWidget(this.app.view, {
      value: this.d0 * o.factor,
      focus: true,
      onInput: (v) => (this.setLength(v), this.app.ui.updatePanelValues([v, (this.feature.op as { factor: number }).factor])),
      onCommit: () => this.done(),
    });
    // Where the second point ends up: the line between them grows with the body.
    this.dim.set(this.a, add(this.a, scale(sub(this.b, this.a), o.factor)));
    if (fresh) this.render();
  }

  exit(): void {
    this.dim?.dispose();
    super.exit();
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
    return "Drag a handle to stretch the face one way, or the centre for both. The sides tilt to follow.";
  }

  protected items(): PanelItem[] {
    // Along which way, said in X / Y / Z when it lines up ("U" and "V" mean
    // nothing to a beginner narrowing a pylon's top along the engine).
    const along = (d: Vec3) => {
      const k = d.findIndex((x) => Math.abs(x) > 0.999);
      return k >= 0 ? ` (along ${"XYZ"[k]})` : "";
    };
    const v = cross(this.feature.face.normal, this.feature.u);
    return [
      this.num(`Scale U${along(this.feature.u)}`, "factors.0", "number", { min: 0.0001 }),
      this.num(`Scale V${along(v)}`, "factors.1", "number", { min: 0.0001 }),
    ];
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
    this.boxAt(p, `×${(dr.part.kind === "axis" ? k[dr.part.i as 0 | 1] : k[0]).toFixed(2)}`);
  }

  up(): void {
    this.dragging = null;
    this.typing.reset();
    this.app.ui.setLabel(0, 0, null);
  }

  /** What a typed value does to the part being dragged (typed during the drag, or in its value box after). */
  private dragTarget(): DragTypingTarget | null {
    const dr = this.dragging;
    if (!dr) return null;
    return {
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
    };
  }

  /** The drag's value in a box by the pointer (typeable, and it stays after letting go). */
  private boxAt(p: ToolPointer, text: string): void {
    const t = this.dragTarget();
    if (t) this.typing.box(p, text, t);
  }

  dragKey(e: KeyboardEvent): boolean {
    const t = this.dragTarget();
    return !!t && this.typing.key(e, t);
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
    return "Tap the face or plane this face should move onto.";
  }

  protected items(): PanelItem[] {
    return [];
  }
}

function axisIndex(a: Vec3): number {
  return a.findIndex((v) => Math.abs(v) > 0.99);
}

/** "X", "Y" or "Z" - or nothing for a line that is none of them (a gimbal turned to a tilted part). */
function axisName(a?: Vec3): string {
  if (!a) return "Z";
  const i = axisIndex(norm(a));
  return i < 0 ? "" : ["X", "Y", "Z"][i];
}

/**
 * The ways a part of a body points, as three lines square to one another for a gimbal put on it:
 *  - a flat face: across it both ways, and square to it;
 *  - a straight edge: along it, and by a flat face it lies on;
 *  - a corner: along two straight edges that meet there (else by a flat face it is on).
 * X, Y and Z themselves when the part stands square to them (so nothing changes for a body built on them); null
 * when the part has no ways of its own (a curved edge on no flat face).
 */
function frameAt(app: AppContext, hit: PickHit, at: Vec3): Vec3[] | null {
  if (hit.kind !== "face" && hit.kind !== "edge" && hit.kind !== "vertex") return null;
  const body = app.view.body(hit.body);
  if (!body) return null;
  const size = Math.max(1e-9, ...body.edges.map((e) => e.length));
  const tol = size * 1e-5;
  const flatOn = (p: Vec3, along?: Vec3) => body.faces.filter((f) => f.plane && Math.abs(dot(sub(p, f.plane.origin), norm(f.plane.normal))) < tol && (!along || Math.abs(dot(norm(f.plane.normal), along)) < 1e-6));
  let x: Vec3 | null = null;
  let z: Vec3 | null = null;
  if (hit.kind === "face") {
    const pl = body.faces[hit.face]?.plane;
    if (!pl) return null;
    x = norm(pl.xDir);
    z = norm(pl.normal);
    // (Along its longest straight edge, where it has one: a face's own "across" is the kernel's choice.)
    const own = body.edges.filter((e) => e.type === "LINE" && e.length > tol && Math.abs(dot(norm(e.dir), z!)) < 1e-6 && Math.abs(dot(sub(e.mid, pl.origin), z!)) < tol).sort((a, b) => b.length - a.length)[0];
    if (own) x = norm(own.dir);
  } else if (hit.kind === "edge") {
    const e = body.edges[hit.edge];
    if (!e) return null;
    if (e.type === "LINE" && e.length > tol) {
      x = norm(sub(e.end, e.start));
      const f = flatOn(e.mid, x)[0];
      z = f?.plane ? norm(f.plane.normal) : norm(cross(x, xDirFor(x)));
    } else {
      const f = flatOn(e.start).find((g) => Math.abs(dot(sub(e.mid, g.plane!.origin), norm(g.plane!.normal))) < tol);
      if (!f?.plane) return null;
      x = norm(f.plane.xDir);
      z = norm(f.plane.normal);
    }
  } else {
    const v = app.view.vertexOf(hit.body, hit.vertex) ?? at;
    const from = body.edges.filter((e) => e.type === "LINE" && e.length > tol && (len(sub(e.start, v)) < tol || len(sub(e.end, v)) < tol)).map((e) => norm(sub(e.end, e.start)));
    const second = from.find((d) => len(cross(from[0], d)) > 1e-3);
    if (from[0] && second) {
      x = from[0];
      z = norm(cross(x, second));
    } else {
      const f = flatOn(v)[0];
      if (!f?.plane) return null;
      z = norm(f.plane.normal);
      x = from[0] && Math.abs(dot(from[0], z)) < 1e-6 ? from[0] : norm(f.plane.xDir);
    }
  }
  if (!x || !z || !(len(x) > 0.5) || !(len(z) > 0.5)) return null;
  // Each arrow keeps the colour of the way it is nearest to: the one that points most upward is the blue one (Z),
  // of the other two the one most along X the red one - a part tilted a little has its arrows where they were.
  const three = [x, norm(cross(z, x)), z];
  const up = three.reduce((m, a) => (Math.abs(a[2]) > Math.abs(m[2]) + 1e-9 ? a : m));
  const zz = up[2] < 0 ? scale(up, -1) : up;
  const rest = three.filter((a) => a !== up);
  const along = Math.abs(rest[0][0]) >= Math.abs(rest[1][0]) - 1e-9 ? rest[0] : rest[1];
  const xx = along[0] < 0 ? scale(along, -1) : along;
  const frame = [xx, norm(cross(zz, xx)), zz];
  // (Square to X, Y and Z, whichever way round: theirs, as it was.)
  const world = frame.every((a) => a.some((c) => Math.abs(Math.abs(c) - 1) < 1e-9));
  return world ? GIMBAL_AXES : frame;
}

/** How far the bodies reach along a direction (their size that way). */
export function bodyExtent(app: AppContext, bodies: string[], dir: Vec3): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (const id of bodies) {
    const p = app.view.body(id)?.positions;
    if (!p) continue;
    for (let i = 0; i < p.length; i += 3) {
      const t = p[i] * dir[0] + p[i + 1] * dir[1] + p[i + 2] * dir[2];
      if (t < lo) lo = t;
      if (t > hi) hi = t;
    }
  }
  return hi > lo ? hi - lo : 0;
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
    return "Drag the arrows to place the image. Its width and how see-through it is are on the line.";
  }

  protected items(): PanelItem[] {
    // Which of the three main planes it stands on, and where its middle is on
    // it (from the origin, as in a sketch there): a side view to trace has to
    // stand up on the front plane at its real size - dragging couldn't turn it
    // off the floor, nor put it anywhere exactly.
    const pl = this.feature.plane;
    const on = ([["floor", GROUND], ["front", FRONT], ["side", RIGHT]] as const).find(([, q]) => Math.abs(dot(q.normal, pl.normal)) > 0.999)?.[0] ?? "";
    const y = cross(pl.normal, pl.xDir);
    const place = (u: number, v: number, base = pl) => {
      const yy = cross(base.normal, base.xDir);
      this.feature.plane = { ...base, origin: add(add(scale(base.xDir, u), scale(yy, v)), scale(base.normal, dot(pl.origin, pl.normal) * (base === pl ? 1 : 0))) };
      this.onDraftChanged();
      this.update();
    };
    const u0 = dot(pl.origin, pl.xDir);
    const v0 = dot(pl.origin, y);
    return [
      { type: "choice", label: "On", options: [{ id: "floor", label: "Floor" }, { id: "front", label: "Front" }, { id: "side", label: "Side" }], value: on, onChange: (id) => (place(u0, v0, { floor: GROUND, front: FRONT, side: RIGHT }[id as "floor"]), this.render()) },
      { type: "number", label: "X", value: u0, kind: "length", onInput: (v) => place(v, dot(this.feature.plane.origin, cross(this.feature.plane.normal, this.feature.plane.xDir))) },
      { type: "number", label: "Y", value: v0, kind: "length", onInput: (v) => place(dot(this.feature.plane.origin, this.feature.plane.xDir), v) },
      this.num("Width", "width", "length", { min: 0.001, onInput: (v) => ((this.feature.height = v * this.aspect), this.update()) }),
      // Fade, as a body's: how see-through, in % (0 = solid; stored as an opacity).
      { type: "number", label: "Fade %", value: Math.round((1 - this.feature.opacity) * 100), kind: "int", min: 0, onInput: (v) => ((this.feature.opacity = 1 - Math.min(95, Math.max(0, v)) / 100), this.update()) },
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

// ------------------------------------------------------------- move plane

/** v turned by ang (radians) about the unit axis k. */
function turn(v: Vec3, k: Vec3, ang: number): Vec3 {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  return add(add(scale(v, c), scale(cross(k, v), s)), scale(k, dot(k, v) * (1 - c)));
}

/**
 * Move / turn a construction plane with its gimbal (its own axes: the plane's
 * x, y and normal). With Copy on, the original stays and a new plane is made;
 * the new one is selected after, so the next drag copies again. A plane that
 * follows a face keeps following it while it's only moved along its normal
 * (its offset changes); any other move makes it a plane of its own.
 */
export class PlaneMoveOp extends FeatureOp<PlaneFeature> {
  readonly id = "plane";
  private gimbal: Gimbal;
  private copyToggle: CopyToggle;
  private typing = new DragTyping(this.app);
  /** The plane at the start (resolved), and where its square is drawn: the pivot. */
  private base: PlaneDef;
  private pivot: Vec3;
  /** The move so far, along the gimbal's axes, and the turn (about one axis at a time). */
  private moved: Vec3 = [0, 0, 0];
  private turned: { axis: Vec3; angle: number } | null = null;
  /** Turned once already (then turned about another axis): no longer on its face. */
  private detached = false;
  private dragging: { from: ToolPointer; part: GimbalPart; t0: Vec3; turned: { axis: Vec3; angle: number } | null } | null = null;
  private copy = copyMode.on;
  private copyId: { id: string; name: string };

  constructor(app: AppContext, existing: PlaneFeature) {
    super(app, existing, existing);
    this.base = app.view.planeOf(existing.id) ?? existing.plane;
    this.pivot = app.view.planeShownAt(existing.id) ?? this.base.origin;
    this.copyId = app.store.newIdentity("plane", "Plane");
    this.gimbal = new Gimbal(app.view, { axes: planeAxes(this.base) });
    this.gimbal.setCenter(this.pivot);
    this.copyToggle = new CopyToggle(app.view, () => this.gimbal.origin, (on) => ((this.copy = on), this.render(), this.update()));
  }

  protected hint(): string {
    return this.copy ? "Drag the arrows to place a copy of the plane. Tap empty space when done." : "Drag the arrows to move or turn the plane. Tap empty space when done.";
  }

  protected items(): PanelItem[] {
    return [{ type: "toggle", label: "Copy", value: this.copy, onChange: (v) => ((this.copy = copyMode.on = v), this.render(), this.update()) }];
  }

  protected ready(): boolean {
    return this.copy || len(this.moved) > 1e-9 || !!this.turned?.angle || this.detached;
  }

  private worldMove(): Vec3 {
    const [ax, ay, an] = planeAxes(this.base);
    return add(add(scale(ax, this.moved[0]), scale(ay, this.moved[1])), scale(an, this.moved[2]));
  }

  /** The plane after the move: turned about the pivot, then moved. */
  private apply(): void {
    const b = this.base;
    const o = this.existing!;
    const t = this.turned;
    const rot = (v: Vec3) => (t && t.angle ? turn(v, t.axis, (t.angle * Math.PI) / 180) : v);
    const d = this.worldMove();
    const f = this.feature;
    if (!this.detached && !t?.angle && Math.hypot(this.moved[0], this.moved[1]) < 1e-9) {
      // Only along the normal: just its offset changes (a plane on a face stays on it).
      f.face = o.face;
      f.plane = o.plane;
      f.offset = o.offset + this.moved[2];
    } else {
      f.face = undefined;
      f.near = undefined;
      f.offset = 0;
      f.plane = { origin: add(add(this.pivot, rot(sub(b.origin, this.pivot))), d), xDir: norm(rot(b.xDir)), normal: norm(rot(b.normal)) };
      // (On its own now: its square where it is put, as big as it was.)
      const size = this.app.view.planeShownSize(o.id);
      f.shown = { at: add(this.pivot, d), ...(size ? { size } : {}) };
    }
    if (f.exprs?.offset) {
      delete f.exprs.offset;
      if (!Object.keys(f.exprs).length) f.exprs = undefined;
    }
    const at = add(this.pivot, d);
    this.gimbal.setCenter(at);
    this.app.view.showPlaneAt(this.copy ? this.copyId.id : o.id, at, o.id);
  }

  protected onDraftChanged(): void {
    this.apply();
  }

  /** With Copy: the moved plane is a new one, the original stays. */
  protected featuresWith() {
    return this.copy ? [...this.app.store.features, this.copied()] : super.featuresWith();
  }

  private copied(): PlaneFeature {
    return { ...structuredClone(this.feature), ...this.copyId, kind: this.feature.kind ?? "offset" };
  }

  protected done(): void {
    if (!this.ready()) return this.app.setTool(null);
    const f = this.copy ? this.copied() : this.feature;
    if (this.copy) this.app.store.add(f);
    else this.app.store.update(f.id, f);
    this.app.setTool(null);
    // Selected, gimbal and all: the next drag moves (or copies) it again.
    this.app.setSelection([{ kind: "plane", id: f.id }]);
  }

  exit(): void {
    this.gimbal.dispose();
    this.copyToggle.dispose();
    super.exit();
  }

  hover(p: ToolPointer | null): void {
    this.gimbal.setHot(p && !this.dragging ? this.gimbal.hit(p) : this.dragging?.part ?? null);
  }

  down(p: ToolPointer): boolean {
    const part = this.gimbal.hit(p);
    if (!part) return false;
    // A turn about another axis than the last one: what's done so far becomes the start.
    if (part.kind === "ring" && this.turned?.angle && len(sub(this.turned.axis, this.gimbal.axes[part.i])) > 1e-6) {
      this.apply();
      this.pivot = add(this.pivot, this.worldMove());
      this.base = this.feature.plane;
      this.moved = [0, 0, 0];
      this.turned = null;
      this.detached = true;
      this.gimbal.dispose();
      this.gimbal = new Gimbal(this.app.view, { axes: planeAxes(this.base) });
      this.gimbal.setCenter(this.pivot);
    }
    this.dragging = { from: p, part, t0: [...this.moved] as Vec3, turned: this.turned && { ...this.turned } };
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
    const part = dr.part;
    const ax = this.gimbal.axes;
    const at = add(this.pivot, add(add(scale(ax[0], dr.t0[0]), scale(ax[1], dr.t0[1])), scale(ax[2], dr.t0[2])));
    if (part.kind === "axis") {
      const d = snap(axisDrag(view, at, ax[part.i], dr.from, p));
      this.moved = [...dr.t0] as Vec3;
      this.moved[part.i] += d;
      this.boxAt(p, fmtLen(d));
    } else if (part.kind === "plane" || part.kind === "center") {
      // In the square's plane (the screen's for the centre).
      const n: Vec3 = part.kind === "plane" ? ax[part.i] : (view.cam.viewDir().toArray() as Vec3);
      const pl = { origin: at, normal: n, xDir: xDirFor(n) };
      const a = view.rayToPlane(dr.from.x, dr.from.y, pl);
      const b = view.rayToPlane(p.x, p.y, pl);
      if (!a || !b) return;
      const d = sub(b, a);
      this.moved = [0, 1, 2].map((i) => dr.t0[i] + snap(dot(d, ax[i]))) as Vec3;
      this.boxAt(p, fmtLen(len(sub(this.moved, dr.t0))));
    } else {
      const axis = ax[part.i];
      const c = view.toScreen(at);
      if (!c) return;
      const ang = (q: { x: number; y: number }) => Math.atan2(q.y - c[1], q.x - c[0]);
      // Screen y points down, so a visual counter-clockwise turn is a negative atan2 change.
      const facing = dot(axis, view.cam.viewDir().toArray() as Vec3) < 0 ? 1 : -1;
      let deg = ((-(ang(p) - ang(dr.from)) * 180) / Math.PI) * facing;
      deg = ((deg + 540) % 360) - 180;
      const a0 = dr.turned?.angle ?? 0;
      this.turned = { axis, angle: p.shift ? a0 + deg : Math.round((a0 + deg) / 5) * 5 };
      this.boxAt(p, `${Math.round(this.turned.angle * 10) / 10}°`);
    }
    this.update();
  }

  up(): void {
    this.dragging = null;
    this.typing.reset();
    this.app.ui.setLabel(0, 0, null);
    this.gimbal.setHot(null);
    this.render();
  }

  /** A value typed while dragging (or in its box after): the distance or angle of that part. */
  private dragTarget(): DragTypingTarget | null {
    const dr = this.dragging;
    if (!dr) return null;
    const part = dr.part;
    const dragDir = norm(sub(this.moved, dr.t0));
    return {
      kind: part.kind === "ring" ? "angle" : "length",
      apply: (v) => {
        if (part.kind === "ring") this.turned = { axis: this.gimbal.axes[part.i], angle: (dr.turned?.angle ?? 0) + v };
        else if (part.kind === "axis") {
          this.moved = [...dr.t0] as Vec3;
          this.moved[part.i] += v;
        } else if (len(dragDir) > 0.5) this.moved = add(dr.t0, scale(dragDir, v));
        this.update();
      },
      commit: () => ((this.dragging = null), this.gimbal.setHot(null), this.done()),
      cancel: () => ((this.moved = [...dr.t0] as Vec3), (this.turned = dr.turned), this.update()),
    };
  }

  private boxAt(p: ToolPointer, text: string): void {
    const t = this.dragTarget();
    if (t) this.typing.box(p, text, t);
  }

  dragKey(e: KeyboardEvent): boolean {
    const t = this.dragTarget();
    return !!t && this.typing.key(e, t);
  }
}

/** A plane's own gimbal axes: its x, its y and its normal. */
export function planeAxes(p: PlaneDef): Vec3[] {
  return [p.xDir, cross(p.normal, p.xDir), p.normal];
}

// ------------------------------------------------------------------- split

export class SplitOp extends FeatureOp<SplitFeature> {
  readonly id = "split";
  private plane: PlaneDef | null = null;

  constructor(app: AppContext, body: string, existing?: SplitFeature, plane?: PlaneDef) {
    super(app, { ...app.store.newIdentity("split"), type: "split", body, plane: plane ?? { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] } }, existing);
    this.plane = existing && !existing.noPlane ? existing.plane : (plane ?? null);
    const f = this.feature;
    const first = planeSlot(app, "Split with", () => this.plane, (p) => ((this.plane = p), (f.plane = p), (f.noPlane = undefined)));
    // More planes at once (a body cut in slices).
    const more = planeSlot(app, "More planes", () => f.planes?.at(-1) ?? null, (p) => (f.planes = [...(f.planes ?? []), p]));
    const own = (b: string) => b === f.id || b.startsWith(`${f.id}:`);
    const tools: Slot = {
      label: "Split with bodies",
      multi: true,
      describe: () => (f.tools?.length ? `${f.tools.length} bod${f.tools.length > 1 ? "ies" : "y"}` : "Optional - tap bodies to cut along"),
      filled: () => true,
      pick: { profiles: false, planes: false, axes: false },
      shows: () => (f.tools ?? []).map((b) => ({ kind: "body" as const, body: b })),
      rejectHint: "Tap another body",
      accept: (hit) => {
        const b = hit.kind === "face" || hit.kind === "edge" || hit.kind === "vertex" ? hit.body : null;
        if (!b || b === f.body || own(b)) return false;
        const t = f.tools ?? [];
        f.tools = t.includes(b) ? t.filter((x) => x !== b) : [...t, b];
        if (!f.tools.length) f.tools = undefined;
        f.noPlane = !this.plane || undefined;
        return true;
      },
    };
    // (Bodies to cut along: only when there is another body to cut along.)
    const others = !!f.tools?.length || app.view.bodyList.some((b) => b.id !== body && !own(b.id));
    this.slots = [
      first,
      { ...more, multi: true, describe: () => (f.planes?.length ? `${f.planes.length} more` : "Optional - tap more planes or flat faces"), filled: () => true },
      ...(others ? [tools] : []),
    ];
  }

  /** A plane, or a body to cut along, is enough. */
  protected ready(): boolean {
    return !!this.plane || !!this.feature.tools?.length;
  }

  protected hint(): string {
    return "The body is cut where the planes and the picked bodies' surfaces cross it. Those bodies stay.";
  }

  protected items(): PanelItem[] {
    return [];
  }
}

// ----------------------------------------------------------------- connect

/**
 * Connect: a smooth freeform bridge from one face to another (of two bodies,
 * or two faces of one), joined to them, cut out of them or a body of its own.
 */
export class ConnectOp extends FeatureOp<ConnectFeature> {
  readonly id = "connect";
  private picked: (Sel | null)[] = [null, null];

  constructor(app: AppContext, faces: Sel[], existing?: ConnectFeature) {
    const refs = faces.flatMap((s) => (s.kind === "face" ? [faceRefOf(app, s)] : [])).filter((r): r is FaceRef => !!r);
    super(app, { ...app.store.newIdentity("connect"), type: "connect", faces: [refs[0], refs[1]] as [FaceRef, FaceRef], mode: "auto", bulge: 1, size: 1 }, existing);
    if (!existing) this.picked = [faces[0] ?? null, faces[1] ?? null];
    const slot = (k: 0 | 1, label: string): Slot => ({
      label,
      describe: () => (this.feature.faces[k] ? "1 face" : "Tap a face"),
      filled: () => !!this.feature.faces[k],
      pick: { profiles: false, edges: false, planes: false, axes: false },
      shows: () => (this.picked[k] ? [this.picked[k]!] : []),
      rejectHint: "Tap a face",
      accept: (hit) => {
        if (hit.kind !== "face") return false;
        const ref = faceRefOf(app, hit);
        if (!ref) return false;
        this.picked[k] = { kind: "face", body: hit.body, face: hit.face };
        this.feature.faces[k] = ref;
        return true;
      },
    });
    // A curve for the bridge to follow (a spline drawn from one face to the
    // other), if there is one: without, it bows from face to face by Bend.
    const guide = pathSlot(app, () => this.feature.guide ?? null, (p) => (this.feature.guide = p));
    this.slots = [slot(0, "From"), slot(1, "To"), { ...guide, label: "Guide", describe: () => (this.feature.guide ? guide.describe() : "None - tap a sketch curve for the bridge to follow") }];
  }

  /** Two faces are enough: the bridge shows at once (the guide is a choice). */
  protected ready(): boolean {
    return !!this.feature.faces[0] && !!this.feature.faces[1];
  }

  protected hint(): string {
    return this.feature.guide
      ? "The bridge runs along the guide from face to face. Size: how big it is against the faces."
      : "Bend: how far the bridge bows out. Or tap a sketch curve for it to follow.";
  }

  protected items(): PanelItem[] {
    const f = this.feature;
    return [
      ...(anyBody(this.app, f.id) ? [modeChoice(() => f.mode, (m) => (f.mode = m), () => (this.render(), this.update()), true)] : []),
      // Without a guide it bows out by Bend; with one, the guide can be let go again.
      ...(f.guide
        ? [{ type: "button" as const, label: "No guide", icon: "close" as const, onClick: () => ((f.guide = undefined), this.render(), this.update()) }]
        : [{ type: "slider" as const, label: "Bend", value: f.bulge ?? 1, min: 0.2, max: 2.5, step: 0.05, show: (v: number) => v.toFixed(2), onInput: (v: number) => ((f.bulge = v), this.update()) }]),
      { type: "slider", label: "Size", value: f.size ?? 1, min: 0.1, max: 1, step: 0.01, show: (v) => `${Math.round(v * 100)}%`, onInput: (v) => ((f.size = v), this.update()) },
    ];
  }
}

// -------------------------------------------------------------------- fill

/**
 * Fill: a surface over a network of curves - a boundary that closes a loop
 * (sketch curves, body edges) and, if wanted, guide curves across it.
 */
export class FillOp extends FeatureOp<FillFeature> {
  readonly id = "fill";

  constructor(app: AppContext, boundary: PathRef[] = [], existing?: FillFeature) {
    super(app, { ...app.store.newIdentity("fill"), type: "fill", boundary }, existing);
    this.slots = [
      curvesSlot(app, "Boundary", () => this.feature.boundary, (p) => (this.feature.boundary = p)),
      curvesSlot(app, "Guides", () => this.feature.guides ?? [], (p) => (this.feature.guides = p.length ? p : undefined), true),
    ];
  }

  protected hint(): string {
    return this.feature.boundary.length ? "Tap curves or edges until they close a loop. A guide is a curve inside it the surface passes through." : "Tap the curves or edges round the surface.";
  }

  protected items(): PanelItem[] {
    const f = this.feature;
    const edges = f.boundary.flatMap((p) => (p.kind === "edges" ? p.edges : []));
    const opts = [
      { id: "g0", label: "Touch (G0)" },
      { id: "g1", label: "Tangent (G1)" },
      { id: "g2", label: "Curvature (G2)" },
    ];
    if (!edges.length) return [];
    const all: PanelItem = {
      type: "choice",
      label: edges.length > 1 ? "At body edges (all)" : "At body edges",
      options: opts,
      value: f.continuity ?? "g0",
      // (Setting all of them clears the ones set edge by edge.)
      onChange: (v) => ((f.continuity = v === "g0" ? undefined : (v as "g1" | "g2")), (f.edgeContinuity = undefined), this.render(), this.update()),
    };
    if (edges.length < 2) return [all];
    const names = this.app.store.doc.names ?? {};
    // Each edge its own (an edge tapped in the list lights up on the model).
    return [
      all,
      ...edges.map(
        (r, i): PanelItem => ({
          type: "choice",
          label: `Edge ${i + 1}${names[r.body] ? ` (${names[r.body]})` : ""}`,
          options: opts,
          value: f.edgeContinuity?.[fillEdgeKey(r)] ?? f.continuity ?? "g0",
          onChange: (v) => {
            const next = { ...(f.edgeContinuity ?? {}), [fillEdgeKey(r)]: v as "g0" | "g1" | "g2" };
            f.edgeContinuity = next;
            this.update();
          },
        }),
      ),
    ];
  }
}

// ------------------------------------------------------------ fill to plane

/**
 * Fill to Plane: an open surface (a freeform sheet) becomes a solid by
 * filling down to a plane - an origin plane, a construction plane or a flat face.
 */
export class FillToPlaneOp extends FeatureOp<FillToPlaneFeature> {
  readonly id = "fillToPlane";
  private plane: PlaneDef | null = null;

  constructor(app: AppContext, body: string, existing?: FillToPlaneFeature, plane?: PlaneDef) {
    super(app, { ...app.store.newIdentity("fillToPlane"), type: "fillToPlane", body, plane: plane ?? { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] } }, existing);
    this.plane = existing?.plane ?? plane ?? null;
    this.slots = [planeSlot(app, "Fill to", () => this.plane, (p) => ((this.plane = p), (this.feature.plane = p)))];
  }

  protected hint(): string {
    return this.plane ? "The space between the face and the plane is filled in." : "Tap the plane or flat face to fill up to.";
  }

  protected items(): PanelItem[] {
    return [];
  }
}

// ------------------------------------------------------------------ thread

/**
 * Thread a round face: a shank drawn at the nominal size gets an outside
 * thread, a hole drawn at the tap-drill size an inside one. The pitch starts
 * at the ISO coarse pitch for the size; the panel shows which size that makes.
 */
/**
 * The pitch (and hand) used last, for its size: the next hole or shank of
 * that size starts with it. Four boss holes at a fine 0.35 were four times
 * typing 0.35 over the standard 0.5.
 */
let lastThread: { r: number; hole: boolean; pitch: number; left?: boolean } | null = null;

export class ThreadOp extends FeatureOp<ThreadFeature> {
  readonly id = "thread";

  private round: { r: number; hole: boolean };

  constructor(app: AppContext, face: FaceRef, round: { r: number; hole: boolean }, existing?: ThreadFeature) {
    const same = lastThread && Math.abs(lastThread.r - round.r) < 1e-6 && lastThread.hole === round.hole ? lastThread : null;
    super(app, { ...app.store.newIdentity("thread"), type: "thread", face, pitch: same?.pitch ?? defaultPitch(round.r * 2, round.hole), round, ...(same?.left ? { left: true } : {}) }, existing);
    this.round = existing?.round ?? round;
  }

  private remember(): void {
    lastThread = { r: this.round.r, hole: this.round.hole, pitch: this.feature.pitch, left: this.feature.left };
  }

  enter(): void {
    super.enter();
    this.update();
  }

  private label(): string {
    return `${threadLabel(this.round.r * 2, this.round.hole, this.feature.pitch)} ${this.round.hole ? "inside" : "outside"} thread${this.feature.left ? ", left-hand" : ""}`;
  }

  protected hint(): string {
    return this.round.hole
      ? `${this.label()}. The thread is cut into the wall of the hole.`
      : `${this.label()}. A smaller pitch makes a finer thread.`;
  }

  protected items(): PanelItem[] {
    return [
      this.num("Pitch", "pitch", "length", { min: 0.05, onInput: (v) => this.setPitch(v) }),
      // How many threads side by side: 1 is a bolt's; 2 to 4, a jar lid's - on in half a turn or a quarter, the
      // crests still a pitch apart.
      { type: "number", label: "Starts", value: this.feature.starts ?? 1, kind: "int", min: 1, onInput: (v) => ((this.feature.starts = v > 1 ? Math.min(8, Math.round(v)) : undefined), this.render(), this.update()) },
      { type: "toggle", label: "Left-hand", value: !!this.feature.left, onChange: (v) => ((this.feature.left = v || undefined), this.remember(), this.render(), this.update()) },
    ];
  }

  protected ready(): boolean {
    return this.feature.pitch > 0;
  }

  private setPitch(v: number): void {
    if (!(v > 0)) return;
    this.feature.pitch = v;
    this.remember();
    this.app.ui.updatePanelValues([v]);
    this.update();
  }
}

// ------------------------------------------------------------ construction

/** The square of the construction plane this one is taken from (a plane offset from a plane is drawn like it); none: an origin plane. */
function squareOf(app: AppContext, base: PlaneDef): PlaneFeature["shown"] {
  const from = app.view.construction.planes.find((c) => Math.abs(dot(sub(c.plane.origin, base.origin), norm(base.normal))) < 1e-6 && Math.abs(dot(norm(c.plane.normal), norm(base.normal))) > 1 - 1e-9);
  if (!from) return undefined;
  const at = app.view.planeShownAt(from.id);
  const size = app.view.planeShownSize(from.id);
  return at && size ? { at, size } : undefined;
}

/** What a plane is made from, by name: "XZ plane", "Plane 02", "Face of Body 1". */
function baseName(app: AppContext, f: PlaneFeature): string | undefined {
  if (f.face) return faceOfName(app, f.face.body);
  const same = (p: PlaneDef) => len(sub(p.origin, f.plane.origin)) < 1e-6 && dot(norm(p.normal), norm(f.plane.normal)) > 1 - 1e-9;
  const origin = ["XY", "XZ", "YZ"].find((id) => {
    const p = app.view.planeOf(id);
    return p && same(p);
  });
  if (origin) return `${origin} plane`;
  return app.view.construction.planes.find((c) => c.id !== f.id && same(c.plane))?.name;
}

export class PlaneOp extends FeatureOp<PlaneFeature> {
  readonly id = "plane";
  private base: PlaneDef | null = null;

  constructor(app: AppContext, base: PlaneDef | null, face: FaceRef | undefined, existing?: PlaneFeature, shown?: PlaneFeature["shown"]) {
    super(app, { ...app.store.newIdentity("plane"), type: "plane", kind: "offset", plane: base ?? { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] }, face, offset: 10 }, existing);
    if (!existing && !face) this.feature.shown = shown ?? (base ? squareOf(app, base) : undefined);
    this.base = existing ? existing.plane : base;
    this.ownOffset = !existing;
    if (!existing) this.feature.offset = this.startOffset(face);
    // Being edited: not from itself, nor from a plane made after it (that
    // one is built from this one, or comes later in the history).
    const at = existing ? app.store.doc.features.findIndex((x) => x.id === existing.id) : -1;
    const skip = (id: string) => {
      const k = app.store.doc.features.findIndex((x) => x.id === id);
      return at >= 0 && k >= at;
    };
    this.slots = [planeSlot(app, "From", () => this.base, (p, f) => ((this.base = p), (this.feature.plane = p), (this.feature.face = f), (this.feature.shown = f ? undefined : squareOf(app, p)), this.ownOffset && (this.feature.offset = this.startOffset(f))), { named: existing ? baseName(app, existing) : undefined, skip })];
  }

  /** The distance is still the one the tool chose (not typed or dragged yet). */
  private ownOffset = false;

  /** How far away the new plane starts: a quarter of the face it is taken from, or of what is in the project. */
  private startOffset(face?: FaceRef): number {
    return startSize(face && face.area > 0 ? Math.sqrt(face.area) : sceneSize(this.app), 0.25, 10);
  }

  private handle: Handle | null = null;
  private dim: DimWidget | null = null;
  private dragging: { from: ToolPointer; d0: number } | null = null;
  private typing = new DragTyping(this.app);

  protected hint(): string {
    return this.base ? "Drag the arrow or type how far away the new plane goes (negative: the other way)." : "Tap a face or plane to start the new plane from.";
  }

  protected items(): PanelItem[] {
    return [this.num("Offset", "offset", "length", { onInput: (v) => this.setOffset(v), inBox: true })];
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
        onInput: (v, text) => (this.typedInto("offset", text), this.setOffset(v)),
        onCommit: () => this.done(),
      });
    }
    const top = add(b.origin, scale(b.normal, this.feature.offset));
    // The arrow keeps pointing out of the face; the value's sign says which side.
    this.handle.set(top, b.normal);
    this.dim!.set(b.origin, top);
  }

  private setOffset(v: number): void {
    this.ownOffset = false;
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
    this.typedInto("offset", "");
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
    super(app, { ...app.store.newIdentity("plane", "Midplane"), type: "plane", kind: "mid", plane: { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] }, offset: 0 });
    const faces: (FaceRef | undefined)[] = [undefined, undefined];
    const apply = () => {
      const m = this.a && this.b ? midplane(this.a, this.b) : null;
      // (Drawn between the two faces, by their size.)
      const near = faces.filter((x): x is FaceRef => !!x);
      this.feature.near = near.length ? near : undefined;
      if (m) this.feature.plane = m;
      else if (this.a && this.b) this.app.ui.toast("The two planes must be parallel");
    };
    this.slots = [
      planeSlot(app, "First", () => this.a, (p, f) => ((this.a = p), (faces[0] = f), apply())),
      planeSlot(app, "Second", () => this.b, (p, f) => ((this.b = p), (faces[1] = f), apply())),
    ];
  }

  protected ready(): boolean {
    return !!(this.a && this.b && midplane(this.a, this.b));
  }

  protected hint(): string {
    return "Tap two facing faces or planes: the new plane goes halfway between them.";
  }

  protected items(): PanelItem[] {
    return [];
  }
}

export class AxisOp extends FeatureOp<AxisFeature> {
  readonly id = "axis";

  constructor(app: AppContext, origin: Vec3, dir: Vec3, existing?: AxisFeature, kind?: AxisKind) {
    super(app, { ...app.store.newIdentity("axis"), type: "axis", origin, dir, ...(kind ? { kind } : {}) }, existing);
  }

  protected hint(): string {
    return "A helper line to turn or mirror around. Type X / Y / Z to move it, then tap empty space.";
  }

  /**
   * Where it passes through, typed: it used to be kept at once through the
   * middle of the face tapped (a fan's axis level with its pivot, 215 up,
   * couldn't be made).
   */
  protected items(): PanelItem[] {
    return [this.num("X", "origin.0", "length"), this.num("Y", "origin.1", "length"), this.num("Z", "origin.2", "length")];
  }

}

