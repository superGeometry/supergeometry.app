// Offset Edge: a straight edge picked, then a flat face: a line on that face,
// parallel to the edge at the distance typed, from one side of the face's
// outline to the other (cut back where it would run past the face, carried on
// where it would stop short). It's made as a sketch on the face, so it splits
// the face into regions to extrude, cut or offset. The line itself is worked
// out in offsetEdgeGeom.ts.

import type { PlaneDef, SketchFeature, Vec3 } from "../doc/types";
import type { BodyMesh } from "../kernel/protocol";
import type { PanelItem } from "../ui/ui";
import { FeatureOp, type Slot } from "./featureOp";
import { offsetLineOnFace } from "./offsetEdgeGeom";
import { faceRefOf, type AppContext, type Sel } from "./tool";

interface EdgePick {
  start: Vec3;
  end: Vec3;
  sel: Sel;
}

interface FacePick {
  body: BodyMesh;
  face: number;
  plane: PlaneDef;
  sel: Sel;
}

const placeholder = (): PlaneDef => ({ origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] });

export class OffsetEdgeOp extends FeatureOp<SketchFeature> {
  readonly id = "offsetEdge";
  private edge: EdgePick | null = null;
  private face: FacePick | null = null;
  private distance = 5;
  /** Why there's no line (the edge across the face, the line off it). */
  private problem: string | null = null;

  /** Started from an edge (Offset Edge) or from the face (Offset from Edge): the other is tapped next. */
  constructor(app: AppContext, start?: { body: string; edge: number }, onFace?: { body: string; face: number }) {
    super(app, { ...app.store.newIdentity("sketch", "Offset Edge"), type: "sketch", plane: placeholder(), entities: [], log: [{ op: "Offset Edge", n: 1 }] });
    if (start) this.takeEdge(start.body, start.edge);
    if (onFace) this.takeFace(onFace.body, onFace.face);
    this.slots = [this.edgeSlot(), this.faceSlot()];
    this.finishWhenPicked = false;
  }

  private takeEdge(body: string, edge: number): boolean {
    const info = this.app.view.body(body)?.edges[edge];
    if (!info || info.type !== "LINE") return false;
    this.edge = { start: info.start, end: info.end, sel: { kind: "edge", body, edge } };
    this.sync();
    return true;
  }

  private edgeSlot(): Slot {
    return {
      label: "Edge",
      describe: () => (this.edge ? "Straight edge" : "Tap a straight edge"),
      filled: () => !!this.edge,
      pick: { profiles: false, planes: false, edges: true, vertices: false, curves: false },
      rejectHint: "Tap a straight edge of a body",
      shows: () => (this.edge ? [this.edge.sel] : []),
      accept: (hit) => hit.kind === "edge" && this.takeEdge(hit.body, hit.edge),
    };
  }

  private faceSlot(): Slot {
    return {
      label: "On face",
      describe: () => (this.face ? "Face" : "Tap the flat face to draw on"),
      filled: () => !!this.face,
      pick: { profiles: false, planes: false, edges: false, vertices: false, curves: false },
      rejectHint: "Tap a flat face",
      shows: () => (this.face ? [this.face.sel] : []),
      accept: (hit) => hit.kind === "face" && this.takeFace(hit.body, hit.face),
    };
  }

  private takeFace(id: string, face: number): boolean {
    const body = this.app.view.body(id);
    const plane = body?.faces[face]?.plane;
    if (!body || !plane) return false;
    this.face = { body, face, plane, sel: { kind: "face", body: id, face } };
    const ref = faceRefOf(this.app, { body: id, face });
    if (ref) this.feature.attachedTo = ref;
    this.feature.plane = plane;
    this.sync();
    return true;
  }

  /** The line from the picks and the distance, into the sketch. */
  private sync(): void {
    this.problem = null;
    if (!this.edge || !this.face) return;
    const l = offsetLineOnFace(this.face.body, this.face.face, this.face.plane, this.edge.start, this.edge.end, this.distance);
    if (typeof l === "string") {
      this.problem = l;
      this.feature.entities = [];
      return;
    }
    this.feature.entities = [{ id: "offset", kind: "line", a: l.a2, b: l.b2 }];
  }

  protected ready(): boolean {
    return super.ready() && !this.problem && this.feature.entities.length > 0;
  }

  protected items(): PanelItem[] {
    return [
      {
        type: "number",
        label: "Distance",
        value: this.distance,
        kind: "length",
        onInput: (v) => {
          this.distance = v;
          this.sync();
          this.update();
        },
      },
    ];
  }

  protected hint(): string {
    if (this.problem) return `⚠ ${this.problem}`;
    if (!this.edge) return this.face ? "Tap a straight edge: the line on this face runs alongside it." : "Tap a straight edge: the line runs alongside it.";
    if (!this.face) return "Tap the flat face to draw the line on.";
    return "The line runs across the face, edge to edge. Type the distance (below 0: the other side of the edge).";
  }
}
