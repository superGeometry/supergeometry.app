// More ways to make a construction plane. Each one does what its name says:
//   Through 3 Points               – three corners / points of the model.
//   On Curve at Point              – across a curve (normal = the curve's direction there).
//   Perpendicular to Edge at Point – same, on a body edge, at the point you pick on it.
//   Through Edge at Angle          – contains a straight edge, turned about it from a face.
//   Parallel to Face at Point      – a face's direction, moved to a point.
// The plane is worked out from the picks and kept (it can be redone from History).

import { Vector3 } from "three";
import type { PlaneDef, PlaneFeature, Vec3 } from "../doc/types";
import { add, cross, dot, len, norm, scale, sub, xDirFor } from "../geom";
import { entityPolylines } from "../sketch/curves";
import { sketchToWorld } from "../view/viewport";
import type { PanelItem } from "../ui/ui";
import type { PickHit } from "../view/viewport";
import { FeatureOp, type Slot } from "./featureOp";
import { planeSlot, pointSlot } from "./slots";
import type { AppContext, Sel } from "./tool";

/** A curve picked at a point: the point on it and its direction there. */
interface CurvePick {
  at: Vec3;
  tangent: Vec3;
  /** Straight (a line / straight edge): its two ends. */
  line?: [Vec3, Vec3];
  sel: Sel;
}

function nearestOnPolyline(pts: Vec3[], q: Vec3): { at: Vec3; tangent: Vec3 } | null {
  let best: { at: Vec3; tangent: Vec3; d: number } | null = null;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const ab = sub(b, a);
    const L2 = dot(ab, ab);
    if (L2 < 1e-18) continue;
    const t = Math.max(0, Math.min(1, dot(sub(q, a), ab) / L2));
    const p = add(a, scale(ab, t));
    const d = len(sub(q, p));
    if (!best || d < best.d) best = { at: p, tangent: norm(ab), d };
  }
  return best && { at: best.at, tangent: best.tangent };
}

/** A body edge or a sketch curve under a tap, as a curve picked at that point. */
function curvePick(app: AppContext, hit: PickHit): CurvePick | null {
  if (hit.kind === "face") {
    // A tap just beside an edge lands on the face: take the edge it was meant for.
    const b = app.view.body(hit.body);
    if (!b) return null;
    let best: { edge: number; at: Vec3; d: number } | null = null;
    for (const g of b.edgeGroups) {
      const pts: Vec3[] = [];
      for (let i = g.start; i < g.start + g.count; i++) pts.push([b.edgePositions[i * 3], b.edgePositions[i * 3 + 1], b.edgePositions[i * 3 + 2]]);
      const near = nearestOnPolyline(pts, hit.point);
      if (!near) continue;
      const d = len(sub(near.at, hit.point));
      if (!best || d < best.d) best = { edge: g.edge, at: near.at, d };
    }
    if (!best) return null;
    const a = app.view.toScreen(new Vector3(...best.at));
    const q = app.view.toScreen(new Vector3(...hit.point));
    if (!a || !q || Math.hypot(a[0] - q[0], a[1] - q[1]) > 28) return null;
    return curvePick(app, { kind: "edge", body: hit.body, edge: best.edge, point: hit.point });
  }
  if (hit.kind === "edge") {
    const b = app.view.body(hit.body);
    const g = b?.edgeGroups.find((x) => x.edge === hit.edge);
    const info = b?.edges[hit.edge];
    if (!b || !g || !info) return null;
    const pts: Vec3[] = [];
    for (let i = g.start; i < g.start + g.count; i++) pts.push([b.edgePositions[i * 3], b.edgePositions[i * 3 + 1], b.edgePositions[i * 3 + 2]]);
    const near = nearestOnPolyline(pts, hit.point);
    if (!near) return null;
    // Straight when the middle lies on the line between the ends.
    const straight = len(sub(info.start, info.end)) > 1e-9 && Math.abs(len(sub(info.start, info.end)) - info.length) < info.length * 1e-4;
    return { ...near, line: straight ? [info.start, info.end] : undefined, sel: { kind: "edge", body: hit.body, edge: hit.edge } };
  }
  if (hit.kind === "curve") {
    const plane = app.sketchPlane(hit.sketch);
    const e = app.sketchCurves(hit.sketch).find((x) => x.id === hit.entity);
    if (!plane || !e) return null;
    for (const poly of entityPolylines(e)) {
      const pts = poly.map((q) => sketchToWorld(plane, q).toArray() as Vec3);
      const near = nearestOnPolyline(pts, hit.point);
      if (near) return { ...near, line: e.kind === "line" ? [pts[0], pts[pts.length - 1]] : undefined, sel: { kind: "curve", sketch: hit.sketch, entity: hit.entity } };
    }
  }
  return null;
}

function curveSlot(app: AppContext, label: string, get: () => CurvePick | null, set: (c: CurvePick) => void, straightOnly = false): Slot {
  return {
    label,
    describe: () => (get() ? (get()!.line ? "Straight edge" : "Curve") : straightOnly ? "Tap a straight edge or line" : "Tap an edge or curve where the plane goes"),
    filled: () => !!get(),
    pick: { profiles: false, curves: true, planes: false, edges: true, vertices: false },
    rejectHint: straightOnly ? "Tap a straight edge or sketch line" : "Tap an edge or a sketch curve",
    shows: () => (get() ? [get()!.sel] : []),
    accept(hit) {
      const c = curvePick(app, hit);
      if (!c || (straightOnly && !c.line)) return false;
      set(c);
      return true;
    },
  };
}

const placeholder = (): PlaneDef => ({ origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] });

abstract class PlaneFromPicks extends FeatureOp<PlaneFeature> {
  readonly id = "plane";
  constructor(app: AppContext, label: string) {
    super(app, { ...app.store.newIdentity("plane", label), type: "plane", plane: placeholder(), offset: 0 });
  }
  /** The plane the picks make (null: not yet / they don't make one). */
  protected abstract make(): PlaneDef | null;
  protected sync(): void {
    const p = this.make();
    if (p) this.feature.plane = p;
  }
  protected ready(): boolean {
    return super.ready() && !!this.make();
  }
  protected items(): PanelItem[] {
    return [];
  }
}

export class ThreePointPlaneOp extends PlaneFromPicks {
  private pts: (Vec3 | null)[] = [null, null, null];
  constructor(app: AppContext) {
    super(app, "Plane 3 Points");
    this.slots = ["First point", "Second point", "Third point"].map((l, i) => pointSlot(app, l, () => this.pts[i], (p) => ((this.pts[i] = p), this.sync())));
  }
  protected make(): PlaneDef | null {
    const [a, b, c] = this.pts;
    if (!a || !b || !c) return null;
    const n = cross(sub(b, a), sub(c, a));
    if (len(n) < 1e-9 * Math.max(1, len(sub(b, a)) * len(sub(c, a)))) return null;
    return { origin: a, normal: norm(n), xDir: norm(sub(b, a)) };
  }
  protected hint(): string {
    return this.pts.every(Boolean) && !this.make() ? "⚠ The three points are on one line — pick another" : "Tap three points (corners, edge points, sketch points): the plane goes through all of them.";
  }
}

/** On Curve at Point / Perpendicular to Edge at Point: across the curve where it's picked. */
export class CurvePointPlaneOp extends PlaneFromPicks {
  private c: CurvePick | null = null;
  constructor(app: AppContext, private edgesOnly: boolean) {
    super(app, edgesOnly ? "Plane Perp. to Edge" : "Plane on Curve");
    this.slots = [curveSlot(app, edgesOnly ? "Edge (tap where the plane goes)" : "Curve (tap where the plane goes)", () => this.c, (c) => ((this.c = c), this.sync()))];
    this.finishWhenPicked = true;
  }
  protected make(): PlaneDef | null {
    return this.c && { origin: this.c.at, normal: this.c.tangent, xDir: xDirFor(this.c.tangent) };
  }
  protected hint(): string {
    return this.edgesOnly ? "Tap an edge at the point where the plane should cross it (at right angles)." : "Tap a curve or edge where the plane should cross it: it stands across the curve there.";
  }
}

/** Through a straight edge, turned about it from a face or plane by an angle. */
export class EdgeAnglePlaneOp extends PlaneFromPicks {
  private c: CurvePick | null = null;
  private ref: PlaneDef | null = null;
  private angle = 45;
  constructor(app: AppContext) {
    super(app, "Plane at Angle");
    this.slots = [
      curveSlot(app, "Edge (the plane turns about it)", () => this.c, (c) => ((this.c = c), this.sync()), true),
      planeSlot(app, "From face or plane (0°)", () => this.ref, (p) => ((this.ref = p), this.sync())),
    ];
  }
  protected make(): PlaneDef | null {
    if (!this.c?.line) return null;
    const [a, b] = this.c.line;
    const d = norm(sub(b, a));
    // 0°: the reference's direction (a face the edge lies on); without one, upright-ish.
    let n0 = this.ref ? this.ref.normal : xDirFor(d);
    n0 = sub(n0, scale(d, dot(n0, d)));
    if (len(n0) < 1e-9) return null; // edge across the reference: no turning about it
    n0 = norm(n0);
    const t = (this.angle * Math.PI) / 180;
    const n = norm(add(scale(n0, Math.cos(t)), scale(cross(d, n0), Math.sin(t))));
    // Centred on the edge (that's where it's drawn).
    return { origin: scale(add(a, b), 0.5), normal: n, xDir: d };
  }
  protected items(): PanelItem[] {
    return [{ type: "number", label: "Angle", value: this.angle, kind: "angle", onInput: (v) => ((this.angle = v), this.sync(), this.update()) }];
  }
  protected hint(): string {
    return "Tap a straight edge, then the face (or plane) the angle is measured from, and type the angle.";
  }
}

/** A face's (or plane's) direction, moved to a point. */
export class FacePointPlaneOp extends PlaneFromPicks {
  private ref: PlaneDef | null = null;
  private at: Vec3 | null = null;
  constructor(app: AppContext) {
    super(app, "Plane Parallel");
    this.slots = [planeSlot(app, "Parallel to", () => this.ref, (p) => ((this.ref = p), this.sync())), pointSlot(app, "Through point", () => this.at, (p) => ((this.at = p), this.sync()))];
    this.finishWhenPicked = true;
  }
  protected make(): PlaneDef | null {
    return this.ref && this.at ? { ...this.ref, origin: this.at } : null;
  }
  protected hint(): string {
    return "Tap a face or plane, then the point the new plane goes through.";
  }
}
