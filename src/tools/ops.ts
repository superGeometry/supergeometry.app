// Solid, transform and construction operations. Each is a FeatureOp:
// pick slots + values + live preview; see featureOp.ts.

import type { ThreadFeature } from "../doc/types";
import { defaultPitch, threadLabel } from "../kernel/threads";
import type { AxisFeature, AxisRef, ConnectFeature, EdgeFeature, EdgeRef, ExtrudeFeature, ExtrudeSource, FaceRef, FillToPlaneFeature, ImageFeature, LoftFeature, MoveFaceFeature, PathRef, PlaneDef, PlaneFeature, ReplaceFaceFeature, RevolveFeature, ScaleFaceFeature, ShellFeature, SketchFeature, SplitFeature, SweepFeature, TransformFeature, Vec3 } from "../doc/types";
import { FRONT, GROUND, RIGHT, add, cross, dot, len, norm, niceStep, patternSpacing, roundSig, scale, sub, xDirFor } from "../geom";
import type { PanelItem } from "../ui/ui";
import { evaluate, fmtLen } from "../units";
import type { ToolPointer } from "../view/input";
import { FeatureOp, type Slot } from "./featureOp";
import { axisDrag, Handle } from "./handles";
import { axisSlot, directionSlot, facesSlot, pathSlot, planeSlot, pointSlot, sectionsSlot } from "./slots";
import { faceIndexOf, faceRefOf, goneRefs, oppositeFace, sourceFrame, targetOf, type AppContext, type Sel } from "./tool";
import { SketchTool } from "./sketch";
import { screenClass } from "../device";
import { faceBeforeShell } from "./shellFace";
import { entityPolylines } from "../sketch/curves";
import { arrangement, drawnRegions, regionRef } from "../sketch/regions";
import { DimWidget } from "./annotate";
import { Gimbal, GIMBAL_AXES, IN_PLANE, SCALE_PARTS, type GimbalPart } from "./gimbal";
import { DragTyping, type DragTypingTarget } from "./dragTyping";
import { isTouchDevice } from "../device";
import { CopyToggle, copyMode, linkMode } from "./copyToggle";
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
/** The last extrude distance used: a new one from the Extrude button starts there. */
export const lastExtrude = { distance: 10 };

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
    return "Drag the arrow or type a distance to make it 3D. A negative distance cuts into the body.";
  }

  protected items(): PanelItem[] {
    const src = this.feature.source;
    const distance = this.num("Distance", "distance", "length", { onInput: (v) => this.setDistance(v), inBox: true });
    // (No Join / Cut / New or taper: those make it an extrusion.)
    if (this.offsetsFace()) return [distance];
    return [
      distance,
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
          this.render();
          this.update();
        },
      },
      modeChoice(
        () => this.feature.mode,
        (m) => {
          this.feature.mode = m;
          // A new body from a face (a spire on a tower): its own height is what's typed,
          // not the total through the body - 68 typed came out 102 down into the tower.
          if (m === "new" && this.measure === "total") {
            this.measure = "offset";
            this.dim?.setMode("offset");
            this.dim?.setValue(this.shown());
          }
          this.update();
        },
        () => this.render(),
      ),
      // Every shape in the sketch at once (a scale, lettering: hundreds of them,
      // far too many to tap) - holes stay holes.
      ...(src.kind === "profile" && !this.existing ? [{ type: "button" as const, label: "All shapes", onClick: () => this.allShapes() }] : []),
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
    return this.feature.distance !== 0;
  }

  exit(): void {
    this.handle.dispose();
    this.dim?.dispose();
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

  down(p: ToolPointer): boolean {
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
    if (!this.existing && this.feature.source.kind === "profile") lastExtrude.distance = this.feature.distance;
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

  /** Text typed on the selected edges before the tool took over (restored into the size box). */
  private typed?: string;

  constructor(app: AppContext, kind: "fillet" | "chamfer", edges: EdgeRef[], existing?: EdgeFeature, variable?: string, typed?: string) {
    // Started from a variable: the size is that variable (and follows it when it changes).
    // Started by typing: the first digit is the size so far.
    const t = typed !== undefined && !variable ? Number(typed) : NaN;
    const v = variable ? evaluate(variable, "length") : t > 0 ? t : null;
    super(app, { ...app.store.newIdentity(kind), type: kind, edges, radius: v ?? 1, ...(variable && v !== null ? { exprs: { radius: variable } } : {}) }, existing);
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
  }

  private names: { fillet: string; chamfer: string };

  /** Fillets sit outside the edge (+), chamfers inside (−): dragging across the edge switches. */
  private signed(): number {
    return this.feature.type === "fillet" ? this.feature.radius : -this.feature.radius;
  }

  protected hint(): string {
    return this.feature.type === "fillet" ? "Drag the dot or type a size to round the edge. Tap more edges to round them too." : "Drag the dot or type a size to cut the edge off at a slant. Tap more edges to add them.";
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
      ...(fillet ? [this.num("Corner setback", "setback", "length", { min: 0 })] : []),
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
    if (!hit) return this.done();
    if (hit.kind !== "edge") return;
    const info = this.app.view.body(hit.body)?.edges[hit.edge];
    if (!info) return;
    const i = this.feature.edges.findIndex((e) => e.body === hit.body && Math.hypot(...sub(e.mid, info.mid)) < 1e-6);
    if (i >= 0) this.feature.edges.splice(i, 1);
    else this.feature.edges.push({ body: hit.body, mid: info.mid, dir: info.dir, length: info.length, ...(info.steps ? { steps: info.steps } : {}) });

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
    this.typedInto("radius", "");
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
    return "Set how far the shape spins around the axis (360° is a full turn). Drag the arrow along the axis to make a spring.";
  }

  protected items(): PanelItem[] {
    return [
      this.num("Angle", "angle", "angle"),
      this.num("Travel", "travel", "length", { onInput: (v) => this.setTravel(v), inBox: true }),
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

  protected items(): PanelItem[] {
    return [
      { type: "number", label: "End size", value: this.feature.scale ?? 1, kind: "number", min: 0.01, onInput: (v) => ((this.feature.scale = v > 0 ? v : 1), this.update()) },
      { type: "number", label: "Twist", value: this.feature.twist ?? 0, kind: "angle", onInput: (v) => ((this.feature.twist = v || undefined), this.update()) },
      modeChoice(() => this.feature.mode, (m) => ((this.feature.mode = m), this.update()), () => this.render()),
    ];
  }
}

// -------------------------------------------------------------------- loft

export class LoftOp extends FeatureOp<LoftFeature> {
  readonly id = "loft";

  constructor(app: AppContext, sections: ExtrudeSource[], initial: Sel[], existing?: LoftFeature) {
    super(app, { ...app.store.newIdentity("loft"), type: "loft", sections, ruled: false, mode: "new" }, existing);
    this.slots = [sectionsSlot(app, () => this.feature.sections, (s) => (this.feature.sections = s), initial)];
    if (existing?.guide) this.slots.push(this.guideSlot());
  }

  /** The optional guide: a curve the body follows from profile to profile. */
  private guideSlot() {
    return { ...pathSlot(this.app, () => this.feature.guide ?? null, (p) => (this.feature.guide = p)), label: "Guide" };
  }

  protected hint(): string {
    if (this.feature.guide) return "The body follows the guide through each shape. Tap more curves to make the guide longer.";
    return "Tap the shapes in order: the body passes through each one.";
  }

  protected items(): PanelItem[] {
    const f = this.feature;
    const guided = this.slots.length > 1;
    return [
      ...(f.closed || guided ? [] : [{ type: "toggle" as const, label: "Straight sides", value: f.ruled, onChange: (v: boolean) => ((f.ruled = v), this.render(), this.update()) }]),
      { type: "toggle", label: "Closed loop", value: !!f.closed, onChange: (v) => ((f.closed = v || undefined), this.render(), this.update()) },
      {
        type: "button",
        label: guided ? "Remove guide" : "Add guide",
        icon: guided ? "close" : "sweep",
        onClick: () => {
          if (guided) {
            this.slots.length = 1;
            f.guide = undefined;
            this.active = -1;
          } else {
            this.slots.push(this.guideSlot());
            this.active = 1;
          }
          this.render();
          this.update();
        },
      },
      modeChoice(() => this.feature.mode, (m) => ((this.feature.mode = m), this.update()), () => this.render()),
    ];
  }
}

// ------------------------------------------------------------------- shell

export class ShellOp extends FeatureOp<ShellFeature> {
  readonly id = "shell";

  /** The body's faces before it's hollowed (the screen shows the preview once a face is picked). */
  private original: FaceRef[];

  constructor(app: AppContext, body: string, faces: FaceRef[], existing?: ShellFeature) {
    super(app, { ...app.store.newIdentity("shell"), type: "shell", body, faces, thickness: 1 }, existing);
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
    return "Tap the faces to leave open, and set how thick the walls are.";
  }

  protected items(): PanelItem[] {
    return [this.num("Thickness", "thickness", "length", { min: 0.0001, onInput: (v) => this.setThickness(v), inBox: true })];
  }

  /** The wall thickness, typed on the (first) open face. */
  private dim: DimWidget | null = null;

  private setThickness(v: number): void {
    if (!(v > 0)) return;
    this.feature.thickness = v;
    this.app.ui.updatePanelValues([v]);
    this.dim?.setValue(v);
    this.update();
  }

  protected onDraftChanged(): void {
    const f = this.feature.faces[0];
    if (!f) {
      this.dim?.dispose();
      this.dim = null;
      return;
    }
    this.dim ??= new DimWidget(this.app.view, {
      noLine: true,
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
  }

  exit(): void {
    this.dim?.dispose();
    this.dim = null;
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
  ) {
    const center = pivot ?? bodyCenter(app, bodies);
    const op: TransformFeature["op"] =
      kind === "scale"
        ? { kind: "scale", center, factor: 1 }
        : kind === "mirror"
          ? { kind: "mirror", plane: { origin: [0, 0, 0], xDir: [0, 1, 0], normal: [1, 0, 0] } }
          : kind === "linear"
            ? { kind: "linear", dir: [1, 0, 0], spacing: patternSpacing(bodyExtent(app, bodies, [1, 0, 0]), 20), count: 3 }
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
      if (doc.materials) d.materials = doc.materials;
    });
    this.app.setTool(null);
    this.app.setSelection(f.bodies.map((b) => ({ kind: "body" as const, body: ids.get(`${f.id}:${b}:0`) ?? `${f.id}:${b}:0` })));
  }

  protected hint(): string {
    switch (this.kind) {
      case "move":
        return "Drag an arrow to slide it, an arc to turn it, or type exact values. Tap empty space when done.";
      case "mirror":
        return "The body is flipped across the plane. A copy is made unless you turn Copy off.";
      case "translate":
        return "Tap a point on the body, then the point it should move to.";
      default:
        return ({ rotate: "Set the angle to turn the body around the axis.", linear: "Set how many copies and how far apart, along the direction.", circular: "Set how many copies to place around the axis." } as Record<string, string>)[this.kind] ?? `${TITLES[this.kind]}: set the values, then tap empty space.`;
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
    const copy: PanelItem[] = this.feature.copy && !this.existing ? [copyToggle, link] : [copyToggle];
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
      this.app.ui.toast("One rotation axis per move - press Done, then rotate around the next axis");
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
      this.boxAt(p, fmtLen(d));
    } else if (part.kind === "plane" || part.kind === "center") {
      // Move in the plane of the square (or the screen plane for the centre).
      const n: Vec3 = part.kind === "plane" ? GIMBAL_AXES[part.i] : (view.cam.viewDir().toArray() as Vec3);
      const plane = { origin: dr.center, normal: n, xDir: xDirFor(n) };
      const a = view.rayToPlane(dr.from.x, dr.from.y, plane);
      const b = view.rayToPlane(p.x, p.y, plane);
      if (!a || !b) return;
      const d = sub(b, a);
      o.translate = add(dr.t0, [snap(d[0]), snap(d[1]), snap(d[2])]);
      this.boxAt(p, fmtLen(len(sub(o.translate, dr.t0))));
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
      this.boxAt(p, `${Math.round(total * 10) / 10}°`);
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
        if (part.kind === "ring") o.rotate = { origin: this.center, axis: GIMBAL_AXES[part.i], angle: dr.a0 + v };
        else if (part.kind === "axis") o.translate = add(dr.t0, scale(GIMBAL_AXES[part.i], v));
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
      ? "Drag one handle to stretch the body that way, or the centre to resize it evenly. Type a number while dragging (2 = twice)."
      : "Drag a handle to resize. Type a number while dragging (2 = twice as big).";
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
    if (o.kind !== "scale" || this.d0 < 1e-9) return [];
    return [
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

function axisName(a?: Vec3): string {
  return ["X", "Y", "Z"][a ? Math.max(0, axisIndex(a)) : 2];
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
    return "Drag the arrows to place the image. Set its width and how see-through it is in the card.";
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
      f.offset = 0;
      f.plane = { origin: add(add(this.pivot, rot(sub(b.origin, this.pivot))), d), xDir: norm(rot(b.xDir)), normal: norm(rot(b.normal)) };
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
    this.plane = existing?.plane ?? plane ?? null;
    this.slots = [planeSlot(app, "Split with", () => this.plane, (p) => ((this.plane = p), (this.feature.plane = p)))];
  }

  protected hint(): string {
    return "The body is cut in two where the plane crosses it.";
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
      : "Bend: how far the bridge bows out of the faces. Tap a sketch curve (a spline from face to face) to have it follow that instead.";
  }

  protected items(): PanelItem[] {
    const f = this.feature;
    return [
      modeChoice(() => f.mode, (m) => (f.mode = m), () => (this.render(), this.update())),
      // Without a guide it bows out by Bend; with one, the guide can be let go again.
      ...(f.guide
        ? [{ type: "button" as const, label: "No guide", icon: "close" as const, onClick: () => ((f.guide = undefined), this.render(), this.update()) }]
        : [{ type: "slider" as const, label: "Bend", value: f.bulge ?? 1, min: 0.2, max: 2.5, step: 0.05, show: (v: number) => v.toFixed(2), onInput: (v: number) => ((f.bulge = v), this.update()) }]),
      { type: "slider", label: "Size", value: f.size ?? 1, min: 0.1, max: 1, step: 0.01, show: (v) => `${Math.round(v * 100)}%`, onInput: (v) => ((f.size = v), this.update()) },
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

export class PlaneOp extends FeatureOp<PlaneFeature> {
  readonly id = "plane";
  private base: PlaneDef | null = null;

  constructor(app: AppContext, base: PlaneDef | null, face: FaceRef | undefined, existing?: PlaneFeature) {
    super(app, { ...app.store.newIdentity("plane"), type: "plane", kind: "offset", plane: base ?? { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] }, face, offset: 10 }, existing);
    this.base = existing ? existing.plane : base;
    this.slots = [planeSlot(app, "From", () => this.base, (p, f) => ((this.base = p), (this.feature.plane = p), (this.feature.face = f)))];
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
    return "Tap two facing faces or planes: the new plane goes halfway between them.";
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

export const planeFromNormal = (origin: Vec3, normal: Vec3): PlaneDef => ({ origin, normal: norm(normal), xDir: xDirFor(norm(normal)) });
