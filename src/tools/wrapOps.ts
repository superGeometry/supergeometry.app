// Project as Edge and Wrap & Emboss: a sketch (or edges) put onto a body's faces.

import type { EdgeRef, ExtrudeSource, FaceRef, ImprintFeature, PlaneDef, SketchFeature, WrapFeature } from "../doc/types";
import { projectRegions } from "../sketch/edit";
import { arrangement, resolveRegion, type Region } from "../sketch/regions";
import { planeSlot } from "./slots";
import type { PanelItem } from "../ui/ui";
import { FeatureOp, type Slot } from "./featureOp";
import { faceRefOf, type AppContext, type Sel } from "./tool";

/** One face, of a kind `fits` says. */
function faceSlot(app: AppContext, label: string, get: () => FaceRef | null, set: (f: FaceRef, s: Sel) => void, fits: (s: Extract<Sel, { kind: "face" }>) => boolean, rejectHint: string, picked = "1 face", empty = "Tap a face"): Slot {
  let shown: Sel[] = [];
  return {
    label,
    describe: () => (get() ? picked : empty),
    filled: () => !!get(),
    pick: { profiles: false, edges: false, planes: false, axes: false },
    shows: () => shown,
    rejectHint,
    accept(hit) {
      if (hit.kind !== "face") return false;
      const s = { kind: "face" as const, body: hit.body, face: hit.face };
      if (!fits(s)) return false;
      const ref = faceRefOf(app, s);
      if (!ref) return false;
      shown = [s];
      set(ref, s);
      return true;
    },
  };
}

/**
 * Project as Edge. A sketch: its shapes drawn onto the body's faces seen from
 * it, along its normal. Edges: drawn onto a face picked next, along its normal.
 * The faces are split there; nothing else changes.
 */
export class ImprintOp extends FeatureOp<ImprintFeature> {
  readonly id = "imprint";
  private onto: FaceRef | null = null;

  constructor(app: AppContext, from: { source: ExtrudeSource } | { edges: EdgeRef[] }, existing?: ImprintFeature) {
    const source = "source" in from ? from.source : undefined;
    // The body the sketch is on, if it is on one; with only one body, that one.
    const sk = source?.kind === "profile" ? app.store.find<SketchFeature>(source.sketch) : undefined;
    const only = app.view.bodyList.length === 1 ? app.view.bodyList[0].id : "";
    const body = sk?.attachedTo?.body ?? (source?.kind === "face" ? source.face.body : only);
    super(app, { ...app.store.newIdentity("imprint"), type: "imprint", body, ...("source" in from ? { source: from.source } : { edges: from.edges }) }, existing);
    const f = this.feature;
    this.onto = f.face ?? null;
    if (f.source) {
      this.slots = [
        faceSlot(
          app,
          "Onto body",
          () => (f.body ? ({ body: f.body } as FaceRef) : null),
          (_, s) => s.kind === "face" && (f.body = s.body),
          () => true,
          "Tap the body to draw it onto",
          "1 body",
          "Tap a body",
        ),
      ];
    } else {
      this.slots = [
        faceSlot(
          app,
          "Onto face",
          () => this.onto,
          (ref) => ((this.onto = ref), (f.face = ref), (f.body = ref.body)),
          () => true,
          "Tap the face to draw the edges onto",
        ),
      ];
    }
  }

  protected hint(): string {
    if (this.feature.source) return this.feature.body ? "The sketch is drawn onto the faces seen from it: they are split along it." : "Tap the body to draw the sketch onto.";
    return this.onto ? "The edges are drawn onto the face, straight across to it: it is split along them." : "Tap the face to draw the edges onto.";
  }

  protected items(): PanelItem[] {
    return [];
  }
}

/** Wrap & Emboss: a sketch's shapes wrapped round a round face (lengths kept), raised from it or sunk into it. */
export class WrapOp extends FeatureOp<WrapFeature> {
  readonly id = "wrap";
  private onto: FaceRef | null = null;

  constructor(app: AppContext, source: ExtrudeSource, existing?: WrapFeature) {
    super(app, { ...app.store.newIdentity("wrap"), type: "wrap", source, face: { body: "", center: [0, 0, 0], normal: [0, 0, 1], area: 0 }, height: 1 }, existing);
    const f = this.feature;
    this.onto = existing ? existing.face : null;
    this.slots = [
      faceSlot(
        app,
        "Round face",
        () => this.onto,
        (ref) => ((this.onto = ref), (f.face = ref)),
        (s) => !!app.view.body(s.body)?.faces[s.face]?.round,
        "Wrap goes on a round face (a cylinder)",
      ),
    ];
  }

  protected hint(): string {
    if (!this.onto) return "Tap the round face to wrap the sketch round (the sketch on a plane along its axis).";
    return this.feature.height > 0 ? "Wrapped round the face, lengths kept, and raised from it." : "Wrapped round the face, lengths kept, and sunk into it.";
  }

  protected items(): PanelItem[] {
    const f = this.feature;
    return [
      { type: "number", label: "Height", value: Math.abs(f.height), kind: "length", min: 0.01, onInput: (v) => ((f.height = Math.sign(f.height || 1) * Math.max(0.01, Math.abs(v))), this.update()) },
      { type: "toggle", label: "Sink in", value: f.height < 0, onChange: (v) => ((f.height = (v ? -1 : 1) * Math.abs(f.height)), this.render(), this.update()) },
    ];
  }
}

/**
 * Project as Sketch (a sketch's shapes): a new sketch on a plane or flat face
 * picked next, the shapes drawn onto it square to it.
 */
export class ProjectSketchOp extends FeatureOp<SketchFeature> {
  readonly id = "projectSketch";
  private onto: PlaneDef | null = null;

  constructor(app: AppContext, source: Extract<ExtrudeSource, { kind: "profile" }>) {
    super(app, { ...app.store.newIdentity("sketch"), type: "sketch", plane: { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] }, entities: [] });
    const from = app.sketchPlane(source.sketch);
    const arr = arrangement(app.sketchCurves(source.sketch));
    const regions = source.regions.map((r) => resolveRegion(arr, r)).filter((r): r is Region => !!r);
    this.slots = [
      planeSlot(app, "Onto", () => this.onto, (p, face) => {
        this.onto = p;
        const f = this.feature;
        f.plane = p;
        if (face) f.attachedTo = face;
        else delete f.attachedTo;
        f.entities = from ? projectRegions(arr, regions, from, p) : [];
      }),
    ];
  }

  protected hint(): string {
    return this.onto ? "A new sketch on it, the shapes drawn onto it square to it." : "Tap the plane or flat face to draw the shapes onto (or pick XY / XZ / YZ).";
  }

  protected items(): PanelItem[] {
    return [];
  }
}
