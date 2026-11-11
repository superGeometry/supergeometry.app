import { isTouchDevice } from "../device";
import { simplifyStroke } from "../sketch/freehand";
import { Box3, BufferGeometry, Line, LineBasicMaterial, LineDashedMaterial, Points, PointsMaterial, Vector3 } from "three";
import type { EdgeLink, FaceRef, PlaneDef, PointRef, SketchConstraint, SketchEntity, SketchFeature, Vec2, Vec3 } from "../doc/types";
import { add as add3, dot, GROUND, niceStep as niceStepOf, originOnPlane, patternSpacing, planeY, roundSig, scale as scale3, sub as sub3, toPlane } from "../geom";
import { addForUser, addStrict, constraintError, constraintName, LINKED, pointOf, pointsOf, refsOf, setValueStrict, sizeOf as sizeOfFn, solve, touchingEnds } from "../sketch/constraints";
import { isExpression } from "../ui/ui";
import { nearestSnap } from "../sketch/snapPick";
import { arrangement } from "../sketch/regions";
import { Gimbal, IN_PLANE, type GimbalPart } from "./gimbal";
import { buildConstraints, CONSTRAINT_BUTTONS, ConstraintGlyphs, dimOf, distanceOf, existingConstraints, setDim } from "./sketchConstraints";
import { settings } from "../settings";
import { isCoarse, screenClass } from "../device";
import { arcFrom3, closestOnPrim, entityPolylines, entityPrims } from "../sketch/curves";
import {
  offsetChain,
  outlineOffsetCurves,
  defaultOffset,
  connectedChain,
  angleLines,
  explode,
  explodeJoined,
  alignOne,
  alignShape,
  endNear,
  joinCollinear,
  extend,
  joinEnds,
  splitAny,
  carryConstraints,
  centreArc,
  chamferConstraints,
  chamferCorner,
  chamferEnds,
  lineMeet,
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
import type { TextAlign } from "../sketch/textLayout";
import { DragTyping } from "./dragTyping";
import { DimWidget } from "./annotate";
import { PatternBox } from "./patternBox";
import { axisDrag, Handle } from "./handles";
import { ExtrudeOp } from "./ops";
import { CopyToggle, copyMode } from "./copyToggle";
import type { PanelItem, ToolItem } from "../ui/ui";
import { evaluate, fmtLen, trim as trimNum } from "../units";
import type { ToolPointer } from "../view/input";
import { dotMaterial, sketchToWorld } from "../view/viewport";
import { edgeRefOf, hitToSel, sourceFrame, sourcesOf, type AppContext, type Sel, type Tool } from "./tool";

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

/** Polygon variants by side count. */
const POLYGON_NAMES: Record<number, string> = { 3: "Triangle", 4: "Square", 5: "Pentagon", 6: "Hexagon", 8: "Octagon" };

/** Asked once curves are picked and the turn still needs its centre. */
const CENTRE_HINT = {
  patternCircular: "Now tap the centre to repeat them around. It snaps to line ends, middles and centres.",
  rotate: "Now tap the point to turn them around. It snaps to line ends, middles and centres.",
};

const HINTS: Record<Kind, string> = {
  select: "Tap a line or curve to change its size. Double-tap to pick a whole shape.",
  line: "Tap to place points. Tap the first point again to close the shape, or double-tap to stop.",
  arc: isCoarse ? "Drag from one end of the arc to the other, then drag to bend it." : "Click where the arc starts and ends, then a third point to bend it.",
  spline: "Tap points for the curve to pass through. Tap the first point to close it, or double-tap to stop.",
  rect: "Tap one corner, then the opposite corner.",
  circle: "Tap the centre, then tap again to set the size.",
  ellipse: "Tap the centre, then the end of the long side, then tap to set the width.",
  polygon: "Tap the centre, then where a corner should be.",
  text: "Tap where the text should start, then type it in the card.",
  project: "Tap edges of a body, or lines of another sketch, to copy them into this sketch. Double-tap copies a whole sketch.",
  offset: "Tap a line or shape to draw a copy of it a set distance away.",
  fillet: "Tap a corner to round it, or two lines that meet. Then drag or type the radius.",
  move: "Tap what to move, then drag the arrows to move it or the ring to turn it (or type exact values).",
  scale: "Tap what to resize, then drag the middle square (or an arrow's square end for one way only), or type how many times bigger.",
  patternLinear: "Tap what to repeat, then drag an arrow to space the copies, and set how many.",
  patternCircular: "Tap what to repeat (double-tap for a whole shape), then tap the centre to repeat it around.",
  rotate: "Tap what to turn (double-tap for a whole shape), then tap the point to turn it around, and set the angle.",
  mirror: "Tap a shape, then tap the line to flip it across. Any line works, even one of its own.",
  trim: "Tap the piece of a line to cut away, or swipe across several pieces. (Join: tap a line to merge it with the one it continues.)",
  align: "Tap the line to move, then the line it should line up with.",
  extend: "Tap a line near the end to lengthen, then tap the line it should reach.",
  delete: "Tap lines or shapes to delete them.",
  split: "Tap a line or arc to cut it in two at its middle.",
};

/**
 * Does segment from→to run alongside line a–b - nearly the same direction
 * (within 10°), off its line, and beside it for a good part (not just carrying
 * on past its end, which is how a line is extended)?
 */
function runsAlongside(a: Vec2, b: Vec2, from: Vec2, to: Vec2, minOff: number): boolean {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (len < 1e-12) return false;
  const d: Vec2 = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
  const u: Vec2 = [to[0] - from[0], to[1] - from[1]];
  const lu = Math.hypot(u[0], u[1]);
  if (lu < 1e-12) return false;
  if (Math.abs(d[0] * u[1] - d[1] * u[0]) / lu > Math.sin((10 * Math.PI) / 180)) return false;
  const off = Math.abs((from[0] - a[0]) * d[1] - (from[1] - a[1]) * d[0]);
  if (off <= minOff) return false;
  const t0 = (from[0] - a[0]) * d[0] + (from[1] - a[1]) * d[1];
  const t1 = (to[0] - a[0]) * d[0] + (to[1] - a[1]) * d[1];
  const overlap = Math.min(Math.max(t0, t1), len) - Math.max(Math.min(t0, t1), 0);
  return overlap > 0.2 * Math.abs(t1 - t0);
}

/** The hint for a tool, as its chosen variant works. */
function hintOf(kind: Kind): string {
  if (kind === "arc" && memory.arc === "center") return "Tap the centre, then where the arc starts, then where it ends.";
  if (kind === "rect" && memory.rect === "center") return "Tap the centre, then a corner.";
  if (kind === "rect" && memory.rect === "3pt") return "Tap two corners along one side, then tap to set the width.";
  if (kind === "circle" && memory.circle === "2pt") return "Tap two points on opposite sides of the circle.";
  if (kind === "circle" && memory.circle === "3pt") return "Tap three points on the circle's edge.";
  if (kind === "fillet" && memory.corner === "chamfer") return "Tap a corner where two lines meet to cut it off straight.";
  if (kind === "spline" && memory.spline === "control") return "Tap points that pull the curve towards them (it passes through the first and last). Tap the first point to close it, or double-tap to stop.";
  if (kind === "trim" && memory.trim === "join") return "Tap a line to merge it with the one it continues.";
  if (kind === "spline" && memory.spline === "draw") return isTouchDevice ? "Draw with one finger, like a pencil (two move the view). End where you began to close it." : "Press and drag to draw, like a pencil. End where you began to close it.";
  return HINTS[kind];
}

/** How a spline's points are taken (Draw makes fit splines). */
const splineMode = (): "fit" | "control" => (memory.spline === "control" ? "control" : "fit");

/** "2 lines, 1 curve" - what a freehand stroke was made into. */
function describePieces(es: SketchEntity[]): string {
  const n = (k: string) => es.filter((e) => e.kind === k).length;
  const part = (c: number, one: string, many: string) => (c ? `${c} ${c === 1 ? one : many}` : "");
  return [part(n("line"), "line", "lines"), part(n("arc"), "arc", "arcs"), part(n("circle"), "circle", "circles"), part(n("spline"), "curve", "curves")].filter(Boolean).join(", ");
}

const memory = { arc: "3pt" as "3pt" | "center", circle: "center" as "center" | "2pt" | "3pt", corner: "round" as "round" | "chamfer", textFont: "roboto", trim: "cut" as "cut" | "join", offsetMode: "chain" as "edge" | "chain", pattern: "patternLinear" as "patternLinear" | "patternCircular", rect: "diagonal" as "diagonal" | "center" | "3pt", spline: "fit" as "fit" | "control" | "draw", sides: 6, fillet: 2, offset: 2, textSize: storedTextSize(), textAlign: "left" as TextAlign };

/** The text size survives a reload (a ruler's 3.5 mm numbers came back at 10 mm after one). */
function storedTextSize(): number {
  try {
    const v = Number(localStorage.getItem("sg.textSize"));
    return v > 0 ? v : 10;
  } catch {
    return 10;
  }
}
function storeTextSize(v: number): void {
  try {
    localStorage.setItem("sg.textSize", String(v));
  } catch {
    /* private window: just this session */
  }
}

interface Snap {
  uv: Vec2;
  /** Where the pointer really was (before snapping). */
  raw?: Vec2;
  label?: string;
  guides?: [Vec2, Vec2][];
  /** Snapped onto an existing sketch point (drawing then adds a Coincident constraint). */
  ref?: PointRef;
  /** On these curves (a point on a line/circle/arc: kept on it). */
  on?: string[];
  /** The middle of this line (kept there). */
  mid?: string;
  /** The line being drawn runs parallel / at right angles to this line. */
  dir?: { type: "parallel" | "perpendicular"; curve: string };
  /** A point of the model (a corner, a round end's centre): drawing there stays there. */
  model?: boolean;
}

/** Something the cursor can slide along: a line (through p, along d) or a circle. */
type Locus =
  | { kind: "line"; p: Vec2; d: Vec2; label: string; guide?: Vec2; seg?: [Vec2, Vec2]; on?: string; dir?: Snap["dir"]; show?: [Vec2, Vec2]; axis?: 0 | 1 }
  | { kind: "circle"; c: Vec2; r: number; label: string; on?: string };

function nearestOnLocus(L: Locus, q: Vec2): Vec2 {
  if (L.kind === "circle") {
    const dx = q[0] - L.c[0];
    const dy = q[1] - L.c[1];
    const l = Math.hypot(dx, dy) || 1;
    return [L.c[0] + (dx / l) * L.r, L.c[1] + (dy / l) * L.r];
  }
  const t = (q[0] - L.p[0]) * L.d[0] + (q[1] - L.p[1]) * L.d[1];
  return [L.p[0] + L.d[0] * t, L.p[1] + L.d[1] * t];
}

/** Where two loci cross, nearest to q (null: they don't). */
function crossLoci(A: Locus, B: Locus, q: Vec2): Vec2 | null {
  if (A.kind === "circle" && B.kind === "circle") return null;
  if (A.kind === "line" && B.kind === "line") {
    const den = A.d[0] * B.d[1] - A.d[1] * B.d[0];
    if (Math.abs(den) < 1e-6) return null;
    const t = ((B.p[0] - A.p[0]) * B.d[1] - (B.p[1] - A.p[1]) * B.d[0]) / den;
    return [A.p[0] + A.d[0] * t, A.p[1] + A.d[1] * t];
  }
  const Ln = (A.kind === "line" ? A : B) as Extract<Locus, { kind: "line" }>;
  const C = (A.kind === "circle" ? A : B) as Extract<Locus, { kind: "circle" }>;
  const f: Vec2 = [Ln.p[0] - C.c[0], Ln.p[1] - C.c[1]];
  const b = f[0] * Ln.d[0] + f[1] * Ln.d[1];
  const disc = b * b - (f[0] * f[0] + f[1] * f[1] - C.r * C.r);
  if (disc < 0) return null;
  const pts = [-b - Math.sqrt(disc), -b + Math.sqrt(disc)].map((t) => [Ln.p[0] + Ln.d[0] * t, Ln.p[1] + Ln.d[1] * t] as Vec2);
  return pts.sort((x, y) => Math.hypot(x[0] - q[0], x[1] - q[1]) - Math.hypot(y[0] - q[0], y[1] - q[1]))[0];
}

const unit2 = (v: Vec2): Vec2 => {
  const l = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / l, v[1] / l];
};

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
  /** The length typed while drawing as a formula (with variables), for the value it gave. */
  private lenExpr: { v: number; text: string } | null = null;
  /** A size typed into the card as a variable ("bore", "wall*2"): kept on its dimension, so it follows the variable. */
  private lockExprs: Record<string, { v: number; text: string }> = {};
  private selected = new Set<string>();
  private construction = false;
  private edit: {
    pivot?: Vec2;
    mirrorLine?: [Vec2, Vec2];
    picking?: "pivot" | "mirror" | "refA" | "refB";
    /** Scale by reference: the point that stays put and the second point (their distance becomes what's typed). */
    refA?: Vec2;
    refB?: Vec2;
    offsetOf?: string;
    /** Where the face's outline was tapped (an offset of it is linked to it). */
    offsetAt?: Vec2;
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
  /** Where the shape's first point snapped (kept on that curve / middle). */
  private startSnap: Snap | null = null;
  /** How the first point of what's being drawn snapped (tap or press). */
  private firstSnap: Snap | null = null;

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
  /** Outline of the face this sketch sits on, and its linked offsets (snaps, trims against; not editable as curves). */
  private get boundary(): SketchEntity[] {
    const id = this.sketchId ?? this.pending?.id;
    return id ? this.app.sketchCurves(id).filter((e) => e.id.startsWith("bnd-") || e.id.startsWith("lnk-")) : [];
  }
  /** Just the face's own outline. */
  private get outline(): SketchEntity[] {
    return this.boundary.filter((e) => e.id.startsWith("bnd-"));
  }
  private withoutBoundary(es: SketchEntity[]): SketchEntity[] {
    return es.filter((e) => !e.id.startsWith("bnd-") && !e.id.startsWith("lnk-"));
  }

  /** Swipe trim: cut the piece under this spot (live; committed when the swipe ends). */
  private swipeAt(p: ToolPointer): void {
    const uv = this.uvAt(p);
    if (!uv || !this.sketchId || !this.swipe) return;
    // Hit-tested against the curves as they are now (the view's picking still
    // sees them as they were a moment ago, before the last cut).
    const cur = this.swipe.now ?? this.entities;
    const tol = this.app.view.cam.worldPerPixel(this.app.view.height) * Math.max(6, p.tol * 0.6);
    let best: { id: string; d: number } | null = null;
    for (const e of [...cur, ...this.boundary]) {
      if (e.construction && !cur.includes(e)) continue;
      const d = Math.min(...entityPrims(e).map((pr) => closestOnPrim(pr, uv).d));
      if (d < tol && (!best || d < best.d)) best = { id: e.id, d };
    }
    if (!best) return;
    const next = this.trimHere(cur, best.id, uv);
    if (next.length === cur.length && next.every((x, i) => x === cur[i])) return;
    this.swipe.cut++;
    this.swipe.now = next;
    const id = this.sketchId;
    this.app.store.transient((doc) => {
      const f = doc.features.find((x) => x.id === id);
      if (f?.type === "sketch") f.entities = next;
    });
  }

  /** Trim with the face's own edges in play: what's left of a trimmed face edge becomes a sketch curve. */
  private trimHere(entities: SketchEntity[], id: string, uv: Vec2): SketchEntity[] {
    const bnd = new Map(this.boundary.map((e) => [e.id, e]));
    const out = trim([...entities, ...this.boundary], id, uv).map((e) => (e.id.startsWith("bnd-") && bnd.get(e.id) !== e ? { ...e, id: uid() } : e));
    return this.withoutBoundary(out);
  }

  // ------------------------------------------------------------ lifecycle

  enter(): void {
    document.body.classList.remove("sketch-compact");
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
        // A flat face of the model right in front, facing the camera: sketch on
        // that (looking at the back wall from Back, the sketch went on the
        // origin plane through the middle of the building instead).
        // The one seen most over the screen (the middle can be a roof slope or
        // empty sky: from Right, the sketch went through the middle of the nave).
        const view = this.app.view;
        const ins = view.coveredInsets();
        const count = new Map<string, { n: number; body: string; face: number }>();
        for (let i = 0; i < 9; i++)
          for (let j = 0; j < 9; j++) {
            const x = view.width * (ins.left + ((1 - ins.left - ins.right) * (i + 0.5)) / 9);
            const y = view.height * (ins.top + ((1 - ins.top - ins.bottom) * (j + 0.5)) / 9);
            const hit = view.pick(x, y, { edges: false, vertices: false, planes: false, profiles: false, axes: false, images: false, edgeTolPx: 0 });
            if (hit?.kind !== "face") continue;
            const k = `${hit.body}#${hit.face}`;
            const c = count.get(k) ?? { n: 0, body: hit.body, face: hit.face };
            c.n++;
            count.set(k, c);
          }
        let best = [...count.values()]
          .filter((c) => {
            const f = view.body(c.body)?.faces[c.face];
            return !!f?.plane && dot(f.normal, normal) > 0.9999;
          })
          .sort((a, b) => b.n - a.n)[0];
        // A thin one the grid's points all missed (a 3 mm slab's front, seen
        // from Front: the sketch went through the origin behind it): a face
        // square to the view whose middle shows, the biggest.
        if (!best) {
          let most = 0;
          // (A hidden body's faces don't show: the tap check below leaves them out.)
          for (const id of (this.app.result?.bodies ?? []).map((b) => b.id)) {
            view.body(id)?.faces.forEach((f, i) => {
              if (!f.plane || dot(f.normal, normal) <= 0.9999 || f.area <= most) return;
              const q = view.toScreen(f.center);
              if (!q) return;
              const hit = view.pick(q[0], q[1], { edges: false, vertices: false, planes: false, profiles: false, axes: false, images: false, edgeTolPx: 0 });
              if (hit?.kind === "face" && hit.body === id && hit.face === i) {
                most = f.area;
                best = { n: 1, body: id, face: i };
              }
            });
          }
        }
        const info = best && view.body(best.body)?.faces[best.face];

        if (best && info?.plane) {
          this.plane = originOnPlane({ origin: info.plane.origin, normal: info.plane.normal, xDir });
          this.attachedTo = { body: best.body, center: info.center, normal: info.normal, area: info.area, ...(info.step ? { step: info.step } : {}), ...(info.curve ? { curve: info.curve } : {}) };
          this.app.ui.toast("Sketching on the face in front of you");
        } else if (view.construction.planes.some((c) => Math.abs(dot(c.plane.normal, normal)) > 0.9999)) {
          // Planes of the project's own face this way (a blade's tip plane,
          // seen from the top): pick one in the card, not the origin plane.
          this.phase = "plane";
          this.plane = null;
        } else {
          // Which one, in the names the plane buttons use: "the origin plane" left people guessing.
          const name = ["YZ (side)", "XZ (front)", "XY (floor)"][k];
          this.app.ui.toast(this.app.store.features.some((f) => f.type === "extrude" || f.type === "revolve" || f.type === "import") ? `Sketching on ${name}, through the origin. For a face of the model: Exit, then tap the face first.` : `Sketching on ${name}`);
        }
      }
    }
    if (this.phase === "plane") {
      this.app.view.setOriginPlanesVisible(true);
      this.app.ui.setHint("Tap a plane or a flat face to draw on.");
      // The three origin planes as buttons too: in a 3D view they overlap near
      // the origin, and a tap meant for the floor can land on the front plane.
      const pick = (id: string) => () => {
        const pl = this.app.view.planeOf(id);
        if (!pl || this.phase !== "plane") return;
        this.plane = pl;
        this.app.ui.showPanel(null);
        this.beginDrawing();
      };
      this.app.ui.showPanel({
        title: "Sketch on",
        items: [
          { type: "button", label: "XY (floor)", onClick: pick("XY") },
          { type: "button", label: "XZ (front)", onClick: pick("XZ") },
          { type: "button", label: "YZ (side)", onClick: pick("YZ") },
          // The project's own planes by name: on a phone a plane 211 up is a
          // thin sheet among the bodies, easy to miss with a finger.
          ...this.app.view.construction.planes.map((c) => ({ type: "button" as const, label: c.name, onClick: pick(c.id) })),
        ],
      });
      this.updateMenu();
    } else this.beginDrawing();
  }

  exit(): void {
    this.regionArrow?.handle.dispose();
    this.regionArrow = null;
    // A fillet being sized is kept (before the constraint UI goes away).
    this.finishFillet();
    this.clearOverlays();
    this.gimbal?.dispose();
    this.gimbal = null;
    this.scaleGimbal?.dispose();
    this.scaleGimbal = null;
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
    this.refDim?.dispose();
    this.refDim = null;
    settings.offChange(this.onSettings);
    this.listening = false;
    document.body.classList.remove("sketching", "sketch-compact");
    this.app.view.setOriginPlanesVisible(false);
    this.app.view.grid.setPlane(GROUND);
    this.app.view.cam.setOrtho(this.prevOrtho);
    this.app.ui.showPanel(null);
    this.app.ui.setLabel(0, 0, null);
    this.app.ui.setHint(null);
    this.app.setSelection([]);
    // Left without drawing: the outline asked for (fetchOutline) goes with it.
    if (this.pending && !this.sketchId) void this.app.preview([...this.app.store.features]);
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
    // Beside the column like the other windows, growing upwards from its button
    // (its bottom lines up with the button's) - so it stays clear of the panel below.
    const bottom = btn ? btn.bottom : col.bottom;
    const top = bottom - bar.offsetHeight;
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
    // The constraints themselves are in the card of what's selected - just the
    // ones that fit it, one tap each (a column of mostly greyed-out buttons sat
    // on top of that card).
    const note = document.createElement("div");
    note.className = "cbar-note";
    note.textContent = "Tap lines or points: the constraints that fit show in their card. Tap a badge on the sketch to change or delete it.";
    this.bar.append(auto, glyphs, note);
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
  private setLinesAngle(id1: string, id2: string, deg: number, expr?: string): void {
    const r = angleLines(this.entities, id1, id2, deg);
    if (!r) return;
    const swap = (p: string) => (p === "a" ? "b" : p === "b" ? "a" : p);
    const remap = (c: SketchConstraint): SketchConstraint => (c.pts ? { ...c, pts: c.pts.map((q) => (r.swapped.includes(q.e) ? { ...q, p: swap(q.p) } : q)) } : c);
    const same = (c: SketchConstraint) => c.type === "dim" && c.prop === "angle" && c.curves?.length === 2 && c.curves.includes(id1) && c.curves.includes(id2);
    const res = addStrict(r.entities, this.constraints.filter((c) => !same(c)).map(remap), [{ id: uid(), type: "dim" as const, curves: [id1, id2], prop: "angle", value: deg, ...(expr ? { expr } : {}) }], { fixed: new Set([id1]) });
    if (!res.ok) return this.refused();
    this.commit(res.result.entities, res.constraints);
  }

  private refusedAt = 0;

  /** A new constraint (or size) that the ones already there don't allow: nothing changes. */
  private refused(): void {
    // Typing a value digit by digit: say it once, not on every key.
    if (performance.now() - this.refusedAt < 2000) return;
    this.refusedAt = performance.now();
    this.app.ui.toast("That contradicts constraints already on the sketch - remove one first (Constraints → tap it → Delete)", "error");
  }

  /** Constraints on the selected curves (any that names one of them): sizes, angles, joins, locks. */
  private selectionConstraints(): SketchConstraint[] {
    const ids = this.selected;
    return this.constraints.filter((c) => refsOf(c).some((r) => ids.has(r)));
  }

  /**
   * The constraints that fit what's selected, as one-tap chips in its card:
   * only those that apply (no greyed-out list). One already on it is lit -
   * tap it again to take it off. The selection stays, so several can be
   * added in a row.
   */
  private constraintChips(): PanelItem[] {
    if (this.kind !== "select" || (!this.selected.size && !this.selPts.length)) return [];
    const curves = this.pickedCurves();
    const chips: Extract<PanelItem, { type: "chips" }>["chips"] = [];
    for (const b of CONSTRAINT_BUTTONS) {
      // Curves whose ends touch but aren't joined (their constraints deleted):
      // Coincident joins them all again, in one tap.
      const gaps = b.type === "coincident" && !this.selPts.length ? this.endGaps() : [];
      if (gaps.length) {
        chips.push({ label: gaps.length > 1 ? `Coincident (${gaps.length})` : "Coincident", glyph: b.glyph, title: `Join the ends that touch (Shift+${b.key})`, onClick: () => this.addConstraint(b.type) });
        continue;
      }
      const have = existingConstraints(b.type, this.constraints, this.selPts, curves);
      const built = have.length ? [] : buildConstraints(b.type, this.selPts, curves);
      if (!have.length && !built.length) continue;
      // H/V says which one it is (the line's nearer to one or the other).
      const t = b.type === "hv" ? (have[0] ?? built[0]).type : b.type;
      const label = b.type === "hv" ? (t === "horizontal" ? "Horizontal" : "Vertical") : have.length && b.type === "fix" ? "Unlock" : b.label;
      const glyph = b.type === "hv" ? (t === "horizontal" ? "H" : "V") : have.length && b.type === "fix" ? "🔓" : b.glyph;
      chips.push({
        label,
        glyph,
        on: have.length > 0,
        title: have.length ? `Remove ${label.toLowerCase()} (Shift+${b.key})` : `${label} (Shift+${b.key})`,
        onClick: () => (have.length ? this.removeConstraints(have) : this.addConstraint(b.type)),
      });
    }
    return chips.length ? [{ type: "chips", label: "Constraints", chips }] : [];
  }

  /**
   * Explode: the rectangle / polygon becomes its sides as lines, still joined
   * at the corners (a rectangle's stay square, its width and height become
   * two sides' lengths) - the same lines a corner drag makes. The lines are
   * selected, so their card (and Delete constraints, to free them) is right there.
   */
  private explodeShape(id: string): void {
    const e = this.entities.find((x) => x.id === id);
    const out = e && explodeJoined(e, this.constraints, uid);
    if (!out) return;
    this.commit(this.entities.flatMap((x) => (x.id === id ? out.lines : [x])), out.constraints);
    this.selected = new Set(out.lines.map((l) => l.id));
    for (const l of out.lines) this.pickSeq.set(l.id, ++this.seq);
    this.selPts = [];
    this.selectionChanged();
    this.app.ui.toast(`${out.lines.length} lines, joined at the corners`);
  }

  /** Ends of the selected curves sitting on another end without being joined. */
  private endGaps(): [PointRef, PointRef][] {
    return this.selected.size ? touchingEnds(this.entities, this.constraints, this.selected) : [];
  }

  /** "Delete constraints (n)" for the selection's card, when it has any. */
  private deleteConstraintsItem(): PanelItem[] {
    const n = this.selectionConstraints().length;
    if (!n) return [];
    return [
      {
        type: "button",
        label: `Delete constraints (${n})`,
        icon: "constraints",
        onClick: () => {
          const list = this.selectionConstraints();
          this.removeConstraints(list);
          this.app.ui.toast(`${list.length} constraint${list.length === 1 ? "" : "s"} removed - the shape stays as it is, free to change`);
        },
      },
    ];
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
    let text: string | undefined = existing?.expr;
    this.distDim = new DimWidget(this.app.view, {
      value: existing?.value ?? v,
      typed: existing?.expr,
      boxAt: "side",
      onInput: (x, t) => {
        typed = x > 0 ? x : null;
        text = t;
      },
      onCommit: () => this.setDistance(typed ?? existing?.value ?? v, text && isExpression(text) ? text : undefined),
    });
    this.distDim.set(w(a), w(b));
  }

  /** Upsert the Distance constraint of the selection; the first-picked side stays put. */
  private setDistance(value: number, expr?: string): void {
    const curves = this.pickedCurves();
    const pts = [...this.selPts];
    const old = new Set(existingConstraints("distance", this.constraints, pts, curves).map((c) => c.id));
    const c: SketchConstraint = { id: uid(), type: "distance", pts, ...(curves.length ? { curves: curves.map((e) => e.id) } : {}), value, ...(expr ? { expr } : {}) };
    const first = this.firstPicked();
    const res = addStrict(this.entities, this.constraints.filter((x) => !old.has(x.id)), [c], first ? { fixed: new Set([first]) } : {});
    if (!res.ok) return this.refused();
    this.commit(res.result.entities, res.constraints);
    if (this.app.store.problems.length) this.app.ui.toast(this.app.store.problems[0], "error");
    this.refreshDistanceDim();
  }

  /**
   * Selected curves in the order they were picked (the first one is the
   * reference: it stays put; the others adapt to it) - by the pick order kept
   * for each tap, not by how the selection happens to be stored.
   */
  private pickedCurves(): SketchEntity[] {
    const ids = [...this.selected];
    const at = new Map(ids.map((id, i) => [id, this.pickSeq.get(id) ?? -1e9 + i]));
    ids.sort((a, b) => at.get(a)! - at.get(b)!);
    return ids.flatMap((id) => this.entities.filter((e) => e.id === id));
  }

  private addConstraint(type: (typeof CONSTRAINT_BUTTONS)[number]["type"]): void {
    // Coincident on curves: join every end that touches another (they're already
    // on the same spot, so nothing moves).
    const gaps = type === "coincident" && !this.selPts.length ? this.endGaps() : [];
    if (gaps.length) {
      this.commit(this.entities, [...this.constraints, ...gaps.map(([a, b]): SketchConstraint => ({ id: uid(), type: "coincident", pts: [a, b] }))]);
      this.app.ui.toast(gaps.length === 1 ? "Joined (coincident)" : `Joined ${gaps.length} ends (coincident)`);
      return this.selectionChanged();
    }
    const curves = this.pickedCurves();
    let cs = buildConstraints(type, this.selPts, curves);
    // Lock holds points where they are now.
    if (type === "fix") cs = cs.map((c) => (c.type === "fix" ? { ...c, at: pointOf(this.entities.find((e) => e.id === c.pts![0].e)!, c.pts![0].p) ?? [0, 0] } : c));
    if (!cs.length) return this.app.ui.toast("That constraint doesn't fit the selection");
    // The first thing picked is the reference: it stays, the others adapt to it.
    const first = this.firstPicked();
    // Equal: a size dimension on the curves picked after the first would fight it - drop those.
    const others = new Set(curves.slice(1).map((e) => e.id));
    const kept = type === "equal" ? this.constraints.filter((c) => !(c.type === "dim" && c.curves?.length === 1 && others.has(c.curves[0]) && ["length", "radius", "diameter"].includes(c.prop ?? ""))) : this.constraints;
    // It goes in: the existing constraints in its way (an angle, a parallel...) give way and are named.
    const res = addForUser(this.entities, kept, cs, first);
    if (!res.ok) return this.app.ui.toast("Locked points stop that - unlock them first (select, then Unlock)", "error");
    this.commit(res.result.entities, res.constraints);
    if (this.app.store.problems.length) this.app.ui.toast(this.app.store.problems[0], "error");
    else if (res.removed.length) this.app.ui.toast(`Replaced ${[...new Set(res.removed.map(constraintName))].join(", ")}`);
    // The selection stays: its card shows the new one lit (tap again to take it
    // off), and another can be added straight away.
    this.selectionChanged();
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
    // Strict, like a new constraint: a value the sketch can't take isn't taken.
    const res = setValueStrict(this.entities, this.constraints, id, v, expr ?? undefined);
    if (!res) return this.refused();
    this.commit(res.result.entities, res.constraints);
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
    // On a face, or a sketch opened again: what's drawn on comes to the free part of the screen
    // (centred on the old view, an end face ended up under the tool column on a phone).
    const focus = this.focusBox(p);
    if (focus) this.app.view.cam.fit(focus, true, this.app.view.coveredInsets(), true);
    this.fetchOutline();
  }

  /**
   * The id and name the sketch gets once something's drawn: a new sketch on a
   * face asks for the face's outline under it straight away, so Offset (and
   * Trim, snaps) can use the face's edge before the first line is drawn.
   */
  private pending: { id: string; name: string } | null = null;

  private fetchOutline(): void {
    if (this.sketchId || !this.attachedTo || !this.plane) return;
    this.pending ??= this.app.store.newIdentity("sketch");
    const f: SketchFeature = { ...this.pending, type: "sketch", plane: this.plane, attachedTo: this.attachedTo, entities: [], constraints: [] };
    void this.app.preview([...this.app.store.features, f]);
  }

  /** The sketch's drawing (or the face it's on), a little roomy, for the camera to bring into view. */
  private focusBox(p: PlaneDef): Box3 | null {
    const pts: Vec2[] = [];
    for (const e of this.entities) for (const poly of entityPolylines(e)) pts.push(...poly);
    let lo: Vec2, hi: Vec2;
    if (pts.length) {
      lo = [Math.min(...pts.map((q) => q[0])), Math.min(...pts.map((q) => q[1]))];
      hi = [Math.max(...pts.map((q) => q[0])), Math.max(...pts.map((q) => q[1]))];
    } else if (this.attachedTo) {
      const c = toPlane(p, this.attachedTo.center);
      const r = Math.sqrt(this.attachedTo.area) / 2;
      lo = [c[0] - r, c[1] - r];
      hi = [c[0] + r, c[1] + r];
    } else return null;
    const pad = Math.max(hi[0] - lo[0], hi[1] - lo[1]) * 0.25 + 1;
    const box = new Box3();
    for (const u of [lo[0] - pad, hi[0] + pad]) for (const v of [lo[1] - pad, hi[1] + pad]) box.expandByPoint(sketchToWorld(p, [u, v]));
    return box;
  }

  // ---------------------------------------------------------------- menu

  private updateMenu(): void {
    const app = this.app;
    const exit: ToolItem = { id: "exit", label: "Exit Sketch", icon: "exit", shortcut: "Esc", pulse: this.exitPulse, run: () => app.setTool(null) };
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
      run: () => this.pickTool(kind),
      // Variants: the first tap draws with the one used last; tap again for the list.
      variantsWhenActive: true,
      ...extra,
    });
    const icons: Partial<Record<Kind, string>> = { rect: "rect", trim: "trim", arc: "arc", circle: "circle", fillet: "sketchFillet" };
    const variant = <T extends string>(kind: Kind, key: "rect" | "spline" | "trim" | "arc" | "circle" | "corner", options: [T, string][]): ToolItem[] =>
      options.map(([v, l]) => ({ id: `${kind}-${v}`, label: l, icon: icons[kind] ?? "spline", active: memory[key] === v, run: () => (((memory as unknown as Record<string, string>)[key] = v), this.setKind(kind)) }) as ToolItem);
    app.ui.setTools([
      exit,
      { id: "---1", label: "", icon: "line" },
      t("select", "Select", "pointer", "V"),
      t("line", "Line", "line", "L"),
      t("arc", "Arc", "arc", "A", { sub: memory.arc === "center" ? "Center" : "3 Points", children: variant("arc", "arc", [["3pt", "3 Points"], ["center", "Center"]]) }),
      t("spline", "Spline", "spline", "I", { sub: memory.spline === "fit" ? "Fit" : memory.spline === "draw" ? "Draw" : "Control", children: variant("spline", "spline", [["fit", "Fit points"], ["control", "Control points"], ["draw", "Draw (freehand)"]]) }),
      t("rect", "Rectangle", "rect", "R", { sub: { diagonal: "Diagonal", center: "Center", "3pt": "3 Points" }[memory.rect], children: variant("rect", "rect", [["center", "Center"], ["diagonal", "Diagonal"], ["3pt", "3 Points"]]) }),
      t("circle", "Circle", "circle", "C", { sub: { center: "Center", "2pt": "2 Points", "3pt": "3 Points" }[memory.circle], children: variant("circle", "circle", [["center", "Center"], ["2pt", "2 Points"], ["3pt", "3 Points"]]) }),
      t("ellipse", "Ellipse", "ellipse"),
      t("polygon", "Polygon", "polygon", "G", {
        sub: POLYGON_NAMES[memory.sides] ?? `${memory.sides} sides`,
        // The usual ones a tap away (any other count: type it on the drawing).
        children: [3, 4, 5, 6, 8].map((n) => ({ id: `polygon-${n}`, label: POLYGON_NAMES[n], icon: "polygon" as const, active: memory.sides === n, run: () => ((memory.sides = n), this.setKind("polygon")) })),
      }),
      t("text", "Text", "text"),
      t("project", "Project", "project", "P"),
      t("offset", "Offset Edge", "offset", "O"),
      // Modify tools.
      t("fillet", memory.corner === "chamfer" ? "Chamfer" : "Fillet", "sketchFillet", undefined, { sub: memory.corner === "chamfer" ? "Straight" : "Round", children: variant("fillet", "corner", [["round", "Fillet (round)"], ["chamfer", "Chamfer (straight)"]]) }),
      t("mirror", "Mirror", "mirror"),
      t("trim", "Trim", "trim", "T", { sub: memory.trim === "cut" ? "Cut" : "Join", children: variant("trim", "trim", [["cut", "Cut"], ["join", "Join lines"]]) }),
      t("align", "Align", "alignLine"),
      t("extend", "Extend", "extend", "E"),
      t("split", "Split", "splitLine"),
      t("move", "Move/Rotate", "move", "M"),
      // Turned about a point tapped (a tie rod a quarter way round the axis
      // centre): the code had it, the menu didn't.
      t("rotate", "Rotate About", "rotateAxis", undefined, { sub: "a point you tap" }),
      t("scale", "Scale", "scale", "S"),
      {
        ...t(memory.pattern, "Pattern", memory.pattern),
        id: "pattern",
        run: () => this.setKind(memory.pattern),
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

  /**
   * A tool tapped in the column. The one already in use: (phones) its names
   * come back, or go again - what you're drawing carries on. Another: switch.
   */
  private pickTool(kind: Kind): void {
    if (kind === this.kind && this.phase === "draw") {
      // Something under way: tapping its tool again ends it (the next tap
      // starts a new line - "double-tap to stop" is hard to hit on a phone).
      if (this.pts.length) {
        this.resetDrawing();
        this.refreshPreview();
        this.updatePanel();
        return;
      }
      document.body.classList.toggle("sketch-compact");
      return;
    }
    this.setKind(kind);
  }

  setKind(kind: Kind): void {
    // Phones: once a tool is picked the column shows just icons (names are back on the next sketch).
    document.body.classList.add("sketch-compact");
    // A shape tapped (its extrude arrow up) and then Project: its outline is what gets projected.
    if (kind === "project" && this.regionArrow && this.sketchId) {
      const arr = arrangement(this.app.sketchCurves(this.sketchId));
      for (const s of this.regionArrow.sel) if (s.kind === "profile") for (const id of arr.regions[s.region]?.curves ?? []) if (!id.startsWith("bnd-")) this.selected.add(id);
    }
    this.hideRegionArrow();
    // Another tool picked: still sketching, Exit Sketch calms down.
    if (kind !== "select") this.exitPulse = false;
    // The last line's length box (touch, numpad on) belongs to Line: it goes
    // (keeping what was typed) - it stayed up in Select, holding the numpad.
    if (kind !== "line") this.closeLineBox();
    // Project with curves of this sketch already picked: those are what gets
    // projected - next it only asks where to.
    this.projectOut = kind === "project" ? this.entities.filter((e) => this.selected.has(e.id)).map((e) => e.id) : [];
    this.kind = kind;
    this.pts = [];
    this.locks = {};
    // A new tool starts a new chain: a line drawn after an arc was tied to the
    // end of the line before the arc (and the solver dragged both across).
    this.lastLineId = this.chainFirstId = null;
    this.startRef = this.startSnap = this.firstSnap = null;
    this.arcM = this.arcBend = null;
    this.typedThisShape = false;
    this.edit.picking = kind === "mirror" ? undefined : this.edit.picking;
    this.edit.offsetOf = undefined;
    this.edit.extendFrom = this.edit.alignFrom = undefined;
    this.edit.filletFrom = undefined;
    // A circular pattern always asks for its centre.
    if (kind === "patternCircular" || kind === "rotate") this.edit.pivot = undefined;
    // Move starts from nothing (it shared ΔX with the linear pattern's spacing:
    // an ellipse only meant to be turned 20° also moved 10 across).
    if (kind === "move") ((this.edit.dx = 0), (this.edit.dy = 0), (this.edit.moveRot = 0));
    // A linear pattern starts with its first copy just clear of the selection.
    if (kind === "patternLinear") this.autoPatternSpacing();
    this.finishFillet();
    this.clearPreviewJoin();
    this.edit.mirrorLine = undefined;
    this.edit.refA = this.edit.refB = undefined;
    if (this.edit.picking === "refA" || this.edit.picking === "refB") this.edit.picking = undefined;
    this.refreshRefDim();
    // Editing tools keep the selection; drawing tools start clean.
    if (!["move", "scale", "patternLinear", "patternCircular", "rotate", "mirror", "select", "delete", "align", "project"].includes(kind)) this.selected.clear();
    // Align with a line already selected: that's the one that moves - next, what to align it with.
    // (A whole shape selected: tap its edge to align, then the line.)
    let alignHint: string | undefined;
    if (kind === "align" && this.selected.size === 1 && this.entities.find((e) => e.id === [...this.selected][0])?.kind === "line") {
      this.edit.alignFrom = [...this.selected][0];
      this.selected.clear();
      alignHint = "Now tap the line it should line up with.";
    } else if (kind === "align" && this.selected.size > 1) alignHint = "Tap the side of the shape to line up, then the line it should line up with. The whole shape moves.";
    this.clearOverlays();
    this.hideLineDim();
    this.refreshDistanceDim();
    this.showSelection();
    this.updateMenu();
    this.updatePanel();
    this.setHint(kind === "project" && this.projectOut.length ? "Now tap a flat face or plane, parallel to this sketch, to copy them onto (or tap more lines)" : this.wantsCentre ? CENTRE_HINT[kind as "rotate" | "patternCircular"] : alignHint);
    if (kind === "align" && this.edit.alignFrom) this.app.setSelection([{ kind: "curve", sketch: this.sketchId ?? "", entity: this.edit.alignFrom }]);
  }

  private setHint(extra?: string): void {
    const hint = this.phase === "plane" ? "Tap a plane or a flat face to draw on." : extra ?? hintOf(this.kind);
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
    this.liveKeys = [];
    const lockOf = new Map<PanelItem, string>();
    const lock = (key: string, label: string, kind: "length" | "angle" | "int" = "length", value?: number): PanelItem => {
      const it: PanelItem = {
      type: "number",
      label,
      // What it is with the pointer where it is now (it follows the pointer until typed).
      value: this.locks[key] ?? value ?? this.liveValue(key, this.lockedCursor()) ?? 0,
      kind,
        onInput: (v) => {
          this.locks[key] = v;
          this.refreshPreview();
        },
        onExpr: (text) => {
          if (text && isExpression(text)) this.lockExprs[key] ={ v: evaluate(text, kind === "angle" ? "angle" : "length") ?? NaN, text };
          else delete this.lockExprs[key];
        },
      };
      lockOf.set(it, key);
      return it;
    };
    const selCount = this.selected.size;
    const apply = (label: string, fn: () => void): PanelItem => ({ type: "button", label, icon: "check", onClick: fn, primary: true });
    // A finger lands a few pixels off and the grid there can be 5 px a step:
    // where the first point is, typed (X / Y), right after it's tapped.
    const firstAt = (): PanelItem[] =>
      isTouchDevice && this.pts.length === 1
        ? ([0, 1] as const).map((i) => ({
            type: "number" as const,
            label: i ? "Y" : "X",
            value: Math.round(this.pts[0][i] * 100) / 100,
            kind: "length" as const,
            onInput: (v: number) => {
              this.pts[0] = i ? [this.pts[0][0], v] : [v, this.pts[0][1]];
              // Typed: no longer on what it snapped to.
              this.startRef = this.startSnap = this.firstSnap = null;
              // Nor does the finger's spot say which way a typed size goes: an
              // ellipse's Length went up because the tap had snapped 2 below
              // the centre typed. With no pointer, it goes along X (0°).
              if (isTouchDevice) this.cursor = null;
              this.refreshPreview();
            },
          }))
        : [];
    switch (k) {
      case "line":
        // With the numpad, the length is typed in the box by the line itself.
        // (Already in the box on the line: not repeated in the list beside it.)
        if (this.pts.length && !settings.value.numpad && !isTouchDevice) items.push({ ...lock("len", "Length"), inBox: true } as PanelItem);
        // A finger can't hover: after the first tap there's no line to type a
        // length on (and the next point is often off the screen) - so the card
        // takes the length and the direction (0° right, 90° up), Done places it.
        // Or how far across and up it goes: a slope ("in 10, up 12") with no angle to work out.
        else if (this.pts.length && isTouchDevice) items.push(...firstAt(), lock("len", "Length"), lock("ang", "Angle", "angle"), lock("dx", "Across"), lock("dy", "Up"));
        break;
      case "arc":
        // By its centre, on a phone: where the centre is, the radius and where
        // it starts, then where it ends (degrees, 0° right, round anticlockwise)
        // - a nacelle's lip round a centre at 257 snapped to 260.
        // (Every device: values can be typed while it's drawn, not only once it's made.)
        if (memory.arc === "center") {
          if (this.pts.length === 1) items.push(...firstAt(), lock("r", "Radius"), lock("a0", "Start angle", "angle"));
          else if (this.pts.length === 2) items.push(lock("a1", "End angle", "angle"));
        } else if (this.pts.length === 1) items.push(...firstAt(), lock("len", "Length"), lock("ang", "Angle", "angle"));
        else if (this.pts.length === 2) items.push(lock("r", "Radius"));
        break;
      case "rect":
        if (this.pts.length === 1 && memory.rect !== "3pt") items.push(...firstAt(), lock("w", "Width"), lock("h", "Height"));
        else if (this.pts.length === 1) items.push(...firstAt(), lock("len", "Width"), lock("ang", "Angle", "angle"));
        else if (this.pts.length === 2 && memory.rect === "3pt") items.push(lock("h", "Height"));
        break;
      case "circle":
        if (this.pts.length === 1 && memory.circle !== "3pt") items.push(...firstAt(), lock("r", "Diameter"));
        else if (this.pts.length === 1) items.push(...firstAt(), lock("len", "Length"), lock("ang", "Angle", "angle"));
        break;
      case "polygon":
        items.push({ type: "number", label: "Sides", value: memory.sides, kind: "int", min: 3, onInput: (v) => ((memory.sides = Math.max(3, Math.min(64, v))), this.refreshPreview(), this.updateMenu()) });
        if (this.pts.length === 1) items.push(...firstAt(), lock("r", "Radius"));
        break;
      case "spline":
        // The point just placed, typed exactly (no grid gets every point).
        if (isTouchDevice && this.pts.length)
          items.push(
            ...([0, 1] as const).map((i) => ({
              type: "number" as const,
              label: i ? "Y" : "X",
              value: Math.round(this.pts[this.pts.length - 1][i] * 100) / 100,
              kind: "length" as const,
              onInput: (v: number) => {
                const q = this.pts[this.pts.length - 1];
                this.pts[this.pts.length - 1] = i ? [q[0], v] : [v, q[1]];
                this.refreshPreview();
              },
            })),
          );
        break;
      case "ellipse":
        if (this.pts.length === 1) items.push(...firstAt(), lock("rx", "Length"));
        if (this.pts.length === 2) items.push(lock("ry", "Width"));
        break;
      case "text":
        if (this.pts.length === 1) {
          ui.showPanel({
            title: "Text",
            items: [
              // Where the tapped point is (typed, it moves the text exactly) and
              // how the text sits on it: numbers along a ruler are centred on their tick.
              { type: "number", label: "X", value: Math.round(this.pts[0][0] * 100) / 100, kind: "length", onInput: (v) => ((this.pts[0] = [v, this.pts[0][1]]), this.refreshPreview()) },
              { type: "number", label: "Y", value: Math.round(this.pts[0][1] * 100) / 100, kind: "length", onInput: (v) => ((this.pts[0] = [this.pts[0][0], v]), this.refreshPreview()) },
              { type: "choice", label: "Align", options: [{ id: "left", label: "Left" }, { id: "center", label: "Centre" }, { id: "right", label: "Right" }], value: memory.textAlign, onChange: (id) => ((memory.textAlign = id as TextAlign), this.refreshPreview()) },
              { type: "number", label: "Size", value: memory.textSize, kind: "length", min: 0.001, onInput: (v) => ((memory.textSize = v), storeTextSize(v), this.refreshPreview()) },
              // The font: the bundled ones and any imported.
              { type: "choice", label: "Font", list: true, options: FONTS.map((f) => ({ id: f.id, label: f.name })), value: memory.textFont, onChange: (id) => ((memory.textFont = id), this.refreshPreview()) },
              { type: "button", label: "Import font…", icon: "insert", onClick: () => void this.importFontFile() },
            ],
            onDone: () => this.commitText(),
            onCancel: () => this.setKind("text"),
          });
          this.addTextInput();
          this.setHint("Type the text in the card, then tap Done.");
          return;
        }
        break;
      case "fillet":
        items.push({ type: "number", label: memory.corner === "chamfer" ? "Distance" : "Radius", value: memory.fillet, kind: "length", min: 0.0001, onInput: (v) => (memory.fillet = v) });
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
          // Exact moves (dragging is all a finger can do otherwise).
          { type: "number", label: "ΔX", value: this.edit.dx, kind: "length", onInput: (v) => ((this.edit.dx = v), this.refreshPreview()) },
          { type: "number", label: "ΔY", value: this.edit.dy, kind: "length", onInput: (v) => ((this.edit.dy = v), this.refreshPreview()) },
          { type: "number", label: "Rotate", value: this.edit.moveRot, kind: "angle", onInput: (v) => ((this.edit.moveRot = v), this.refreshPreview()) },
          { type: "toggle", label: "Copy", value: this.edit.copy, onChange: (v) => ((this.edit.copy = v), this.updatePanel()) },
          apply(`Apply (${selCount})`, () => this.applyTransform()),
        );
        break;
      case "scale": {
        // By reference: two points, then the distance they should be apart.
        const { refA: ra, refB: rb } = this.edit;
        const d0 = this.refDistance();
        const at = items.length;
        this.refIndex = { factor: at, distance: d0 ? at + 3 : -1 };
        items.push(
          { type: "number", label: "Factor", value: this.edit.factor, kind: "number", min: 0.0001, onInput: (v) => ((this.edit.factor = v), this.refreshPreview(), this.refreshRefDim()) },
          { type: "slot", label: "Reference: stays put", value: ra ? `${trimNum(ra[0])}, ${trimNum(ra[1])}` : "Tap a point", active: this.edit.picking === "refA", filled: !!ra, onClick: () => ((this.edit.picking = "refA"), this.updatePanel()) },
          { type: "slot", label: "Second point", value: rb ? `${trimNum(rb[0])}, ${trimNum(rb[1])}` : "Tap a point", active: this.edit.picking === "refB", filled: !!rb, onClick: () => ((this.edit.picking = ra ? "refB" : "refA"), this.updatePanel()) },
          ...(d0 ? [{ type: "number", label: "Distance", value: d0 * this.edit.factor, kind: "length", min: 0.0001, onInput: (v: number) => this.setRefDistance(v) } as PanelItem] : []),
          { type: "toggle", label: "Copy", value: this.edit.copy, onChange: (v) => ((this.edit.copy = v), this.updatePanel()) },
          apply(`Apply (${selCount})`, () => this.applyTransform()),
        );
        this.refreshRefDim();
        break;
      }
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
          // Each from the values as they are now (not as when the panel opened:
          // a spacing typed after the direction used to put the old direction back).
          { type: "number", label: "Spacing", value: spacing, kind: "length", onInput: (v) => setPolar(v, Math.hypot(this.edit.dx, this.edit.dy) > 1e-12 ? (Math.atan2(this.edit.dy, this.edit.dx) * 180) / Math.PI : (this.patDirDeg ?? dirDeg)) },
          { type: "number", label: "Direction", value: dirDeg, kind: "angle", onInput: (v) => ((this.patDirDeg = v), setPolar(Math.hypot(this.edit.dx, this.edit.dy), v)) },
          apply(`Apply (${selCount})`, () => this.applyTransform()),
        );
        break;
      }
      case "patternCircular":
      case "rotate":
        items.push(
          { type: "slot", label: k === "rotate" ? "Turn around" : "Center", value: this.edit.pivot ? `${trimNum(this.edit.pivot[0])}, ${trimNum(this.edit.pivot[1])}` : k === "patternCircular" ? "Tap the centre" : "Tap a point", active: this.edit.picking === "pivot" || this.wantsCentre, filled: !!this.edit.pivot, onClick: () => ((this.edit.picking = "pivot"), this.updatePanel()) },
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
        // Points only: what can be done with them - join, lock, a distance...
        if (selCount === 0 && this.selPts.length)
          return ui.showPanel({
            title: this.selPts.length === 1 ? "Point" : `${this.selPts.length} points`,
            items: [...this.constraintChips(), ...this.deleteConstraintsItem()],
            onDone: () => this.clearSelection(),
          });
        if (selCount > 1) {
          // Two lines: the angle of the second picked against the first.
          const [l1, l2] = this.pickedCurves();
          let typed: string | null = null;
          const had = l1 && l2 ? this.constraints.find((c) => c.type === "dim" && c.prop === "angle" && c.curves?.length === 2 && c.curves.includes(l1.id) && c.curves.includes(l2.id))?.expr : undefined;
          const angle: PanelItem[] =
            selCount === 2 && l1?.kind === "line" && l2?.kind === "line"
              ? [{ type: "number", label: "Angle", value: this.angleBetween(l1.id, l2.id), kind: "angle", expr: had, onExpr: (x) => (typed = x), onInput: (v) => this.setLinesAngle(l1.id, l2.id, v, typed && isExpression(typed) ? typed : undefined) }]
              : [];
          if (selCount === 2 && l1?.kind === "line" && l2?.kind === "line") this.showAngleBox(l1, l2);
          return ui.showPanel({
            title: `${selCount} curves`,
            items: [
              ...angle,
              ...this.constraintChips(),
              { type: "button", label: "Construction", icon: "construction", onClick: () => this.toggleConstruction() },
              ...this.deleteConstraintsItem(),
              { type: "button", label: "Delete", icon: "trash", onClick: () => this.deleteSelected() },
            ],
          });
        }
        break;
    }
    // A shape being drawn with a size typed in the card: Enter (or Done) puts it
    // there - typing Width 100, Height 150 and pressing Enter did nothing; it
    // still waited for a second tap, which on a phone lands wherever the finger is.
    const typed = this.pts.length > 0 && ["rect", "circle", "polygon", "ellipse", "line", "arc"].includes(k);
    // Phones: no card over the drawing while a shape is drawn - its values
    // (X / Y of the first point, Length, Angle, Radius…) wait behind a small
    // Values chip, and the finished curve's card shows when it's tapped in
    // Select. A spline keeps its Done beside the chip.
    if (!this.pts.length) this.valuesOpen = false;
    else if (!this.valuesOpen && (typed || k === "spline") && items.length && screenClass() === "phone") {
      this.liveKeys = [];
      ui.showPanel({
        title: titleOf(k),
        items: [{ type: "button", label: "Values", icon: "numpad", onClick: () => ((this.valuesOpen = true), this.updatePanel(), this.refreshPreview()) }],
        onDone: k === "spline" && this.pts.length >= 2 ? () => this.finishSpline(false) : undefined,
      });
      return;
    }
    // The size fields follow the pointer (refreshPreview) until one is typed.
    this.liveKeys = items.filter((it) => it.type === "number").map((it) => lockOf.get(it) ?? null);
    ui.showPanel(items.length ? { title: k === "fillet" && memory.corner === "chamfer" ? "Chamfer" : titleOf(k), items, onCancel: this.pts.length ? () => this.resetDrawing() : undefined, onDone: k === "spline" && this.pts.length >= 2 ? () => this.finishSpline(false) : typed ? () => this.finishTyped() : undefined } : null);
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
    // Focus now, inside the tap: a phone only opens its keyboard for a focus
    // made during the tap, and keys typed straight away must land here.
    this.textTyped = false;
    input.focus();
    input.select();
    input.addEventListener("input", () => (this.textTyped = true), { once: true });
  }
  /** Something was typed into the text box since it opened (else the last text is still there, selected). */
  private textTyped = false;

  // -------------------------------------------------------------- pointer

  hover(p: ToolPointer | null): void {
    if (p && this.phase === "plane") {
      // Show which plane / face / sketch a tap would pick.
      const hit = this.app.view.pick(p.x, p.y, { edges: false, vertices: false, planes: true, planesFirst: true, profiles: true, edgeTolPx: 0 });
      const ok = hit && (hit.kind === "plane" || hit.kind === "profile" || (hit.kind === "face" && !!this.app.view.body(hit.body)?.faces[hit.face]?.plane));
      this.app.setHover(ok ? hitToSel(hit) : null);
      return;
    }
    // The pointer left the view: its snap hint ("Aligned", "Midpoint"...) goes
    // with it - it stayed up, stuck where the pointer last was.
    if (!p && this.phase === "draw") this.app.ui.clearPointerLabel();
    if (!p || this.phase !== "draw" || this.dragging || this.sdrag) return;
    if (this.kind === "patternLinear" && this.patGimbal) {
      const g = this.patGimbal.hit(p);
      this.patGimbal.setHot(g ?? (this.patDrag ? ({ kind: "axis", i: this.patDrag.axis as 0 | 1 }) : null));
      if (g) return this.app.setHover(null);
    }
    if (this.kind === "select") {
      const onArrow = !!this.regionArrow?.handle.hit(p);
      this.regionArrow?.handle.setHot(onArrow);
      this.app.view.canvas.style.cursor = onArrow ? "grab" : "";
      if (onArrow) return this.app.setHover(null);
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
      if (!this.edit.picking && !this.wantsCentre) return;
      // Waiting for the centre: where the tap would land (snapped), not a curve to pick.
      if (this.wantsCentre) this.app.setHover(null);
    }
    if (this.kind === "project") {
      const hit = this.app.view.pick(p.x, p.y, { profiles: false, planes: false, axes: false, edgeTolPx: p.tol });
      this.app.setHover(
        hit?.kind === "edge" ? { kind: "edge", body: hit.body, edge: hit.edge } : hit?.kind === "curve" ? { kind: "curve", sketch: hit.sketch, entity: hit.entity } : null,
      );
      return;
    }
    this.cursor = this.snap(p);
    this.refreshPreview(p);
  }

  down(p: ToolPointer): boolean {
    if (this.phase !== "draw") return false;
    // The extrude arrow of a tapped shape, grabbed: only now does Extrude start
    // (the sketch closes), and this same drag sizes it.
    if (this.regionArrow?.handle.hit(p)) return this.extrudeFromArrow(p);
    if (this.kind === "patternLinear" && this.startPatternDrag(p)) return true;
    // Drags (the gimbal's too) start once the pointer moves (dragStart): a
    // gimbal grabbed on the press took every tap near it - with a point picked
    // by mistake, Move/Rotate could select nothing (Apply (0)).
    if (this.kind === "select") return false;
    if (this.kind === "scale" && this.startScaleDrag(p)) return true;
    // Spline > Draw: the press starts a pencil stroke (a mouse's right / middle drag still turns / moves the view).
    if (this.kind === "spline" && memory.spline === "draw") return this.startStroke(p);
    // Arc with both ends placed: a drag anywhere bends it (no need to hit a spot).
    if (this.kind === "arc" && this.pts.length === 2 && this.arcM) {
      const uv = this.uvAt(p);
      if (!uv) return false;
      this.arcBend = { from: uv, m0: this.arcM, x: p.x, y: p.y, moved: false };
      return true;
    }
    // Phones/tablets/pens, a line under way: the next point follows the finger
    // while it's down (with its length showing) and is placed where it's lifted.
    if (this.kind === "line" && this.pts.length && p.type !== "mouse") {
      const s = this.snap(p);
      if (!s) return false;
      this.cursor = s;
      this.pressPlace = true;
      this.refreshPreview(p);
      return true;
    }
    if (!["line", "rect", "circle", "polygon", "ellipse", "arc"].includes(this.kind) || this.pts.length) return false;
    const s = this.snap(p);
    if (!s) return false;
    this.stopExitPulse();
    this.pts = [s.uv];
    this.downAt = { x: p.x, y: p.y };
    this.firstSnap = s;
    // Joined to what it snapped to, like a tapped first point.
    this.startRef = s.ref ?? null;
    this.startSnap = s;
    this.cursor = s;
    this.dragging = true;
    this.updatePanel();
    return true;
  }

  drag(p: ToolPointer): void {
    if (this.swipe) {
      // Along the way from the last spot (a quick swipe skips over thin curves otherwise).
      const { x, y } = this.swipe.last;
      const n = Math.max(1, Math.ceil(Math.hypot(p.x - x, p.y - y) / 6));
      for (let i = 1; i <= n; i++) this.swipeAt({ ...p, x: x + ((p.x - x) * i) / n, y: y + ((p.y - y) * i) / n });
      this.swipe.last = { x: p.x, y: p.y };
      return;
    }
    if (this.stroke) return this.strokeTo(p);
    if (this.patDrag) return this.dragPattern(p);
    if (this.scaleDrag) return this.dragScale(p);
    if (this.arcBend) {
      if (Math.hypot(p.x - this.arcBend.x, p.y - this.arcBend.y) > 8) this.arcBend.moved = true;
      if (!this.arcBend.moved) return;
      const uv = this.uvAt(p);
      if (uv) this.arcM = [this.arcBend.m0[0] + uv[0] - this.arcBend.from[0], this.arcBend.m0[1] + uv[1] - this.arcBend.from[1]];
      return this.refreshPreview();
    }
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
  /** A finger is down placing a line's next point (placed when it lifts). */
  private pressPlace = false;

  /** A second finger came down to pinch: whatever was being placed isn't. */
  breakOff(): void {
    // A second finger: the stroke was the start of a pinch, not a drawing.
    if (this.stroke) {
      this.stroke = null;
      this.clearOverlays();
    }
    // The first point was being dragged out: it isn't placed either.
    if (this.dragging && !this.pressPlace && this.pts.length === 1) this.pts = [];
    this.pressPlace = false;
    this.dragging = false;
    this.typing.reset();
    this.app.ui.setLabel(0, 0, null);
    this.refreshPreview();
  }
  /** A value was typed for the shape being drawn (Enter then advances/places it). */
  private typedThisShape = false;

  /** Dimensions that can be typed while dragging the current shape. */
  private lockKeys(): string[] {
    switch (this.kind) {
      case "line":
        return ["len"];
      case "rect":
        // By three points: the first side (length, angle), then the height.
        return memory.rect === "3pt" ? (this.pts.length === 1 ? ["len", "ang"] : ["h"]) : ["w", "h"];
      case "circle":
        return memory.circle === "3pt" ? (this.pts.length === 1 ? ["len", "ang"] : []) : ["r"];
      case "arc":
        // By its centre: radius and start angle, then the end angle; by three
        // points: the chord (length, angle), then the radius.
        if (memory.arc === "center") return this.pts.length === 1 ? ["r", "a0"] : ["a1"];
        return this.pts.length === 1 ? ["len", "ang"] : ["r"];
      case "polygon":
        // Tab: radius → number of sides.
        return ["r", "sides"];
      case "ellipse":
        return this.pts.length === 1 ? ["rx"] : ["ry"];
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
    if (this.swipe) {
      const sw = this.swipe;
      this.swipe = null;
      this.app.setHover(null);
      // One step for the whole swipe; constraints follow what's left.
      if (sw.cut && sw.now) this.commit(sw.now, carryConstraints(sw.base, sw.now, this.constraints));
      return;
    }
    if (this.stroke) return this.endStroke(p);
    if (this.patDrag) return this.endPatternDrag();
    if (this.scaleDrag) {
      // The factor stays in the panel: Apply (or an empty tap) scales.
      this.scaleDrag = null;
      this.app.ui.setLabel(0, 0, null);
      this.refreshGimbal();
      return;
    }
    if (this.arcBend) {
      // Let go after a drag: the arc is placed with that bend. A tap (no drag):
      // it passes through the point tapped.
      const moved = this.arcBend.moved;
      this.arcBend = null;
      const s = moved ? null : this.snap(p);
      // A radius typed: the tap only says which side it bends (it used to drop the radius).
      if (s && this.kind === "arc" && this.locks.r !== undefined) {
        this.cursor = s;
        this.addPoint(s.uv, 1);
        return;
      }
      const m = moved ? this.arcM : (s?.uv ?? null);
      if (m) {
        this.locks = {};
        this.cursor = { uv: m };
        this.addPoint(m, 1);
      }
      return;
    }
    if (this.sdrag) return this.endGeometryDrag();
    this.dragging = false;
    this.typing.reset();
    this.lockIndex = 0;
    if (this.ignoreUp) {
      this.ignoreUp = false;
      return;
    }
    // The finger lifted: the line's next point goes where it was let go
    // (the same spot twice in a row ends the chain, like a double-tap).
    if (this.pressPlace) {
      this.pressPlace = false;
      if (this.cursor) this.addPoint(this.cursor.uv, 1);
      return;
    }
    if (!this.pts.length || !this.cursor) return;
    // A drag places the second point; a tap waits for it. (Measured from where
    // the finger went down, not from the point it snapped to: a tap a fingertip
    // from a corner snapped there and counted as a drag back to the finger -
    // a line of no length, and nothing could be drawn near that corner.)
    const a = this.downAt ?? this.app.view.toScreen(sketchToWorld(this.plane!, this.pts[0]));
    this.downAt = null;
    const ax = Array.isArray(a) ? a[0] : a?.x;
    const ay = Array.isArray(a) ? a[1] : a?.y;
    if (ax !== undefined && ay !== undefined && Math.hypot(ax - p.x, ay - p.y) > 12) this.addPoint(this.cursor.uv, 1);
  }

  // ------------------------------------------- Spline > Draw (freehand)

  /** The pencil stroke under way: its points (sketch units) and what its start snapped to. */
  private stroke: { pts: Vec2[]; startRef: PointRef | null; last: { x: number; y: number }; frame: number } | null = null;

  private startStroke(p: ToolPointer): boolean {
    // Onto an existing point only (the grid would kink the stroke's start).
    const s = this.snap(p);
    const uv = s?.ref ? s.uv : this.uvAt(p);
    if (!uv) return false;
    this.resetDrawing();
    this.stroke = { pts: [uv], startRef: s?.ref ?? null, last: { x: p.x, y: p.y }, frame: 0 };
    return true;
  }

  private strokeTo(p: ToolPointer): void {
    const st = this.stroke!;
    // Every pixel or so is plenty (the simplifier thins it anyway).
    if (Math.hypot(p.x - st.last.x, p.y - st.last.y) < 1.5) return;
    const uv = this.uvAt(p);
    if (!uv) return;
    st.pts.push(uv);
    st.last = { x: p.x, y: p.y };
    // One redraw per frame, however often the pointer reports.
    st.frame ||= requestAnimationFrame(() => {
      if (this.stroke !== st) return;
      st.frame = 0;
      this.clearOverlays();
      this.drawGhosts([{ id: "stroke", kind: "polyline", points: st.pts, closed: false }]);
      this.app.view.requestRender();
    });
  }

  private endStroke(p: ToolPointer): void {
    const st = this.stroke!;
    this.stroke = null;
    if (st.frame) cancelAnimationFrame(st.frame);
    this.clearOverlays();
    // The end snaps onto an existing point (not the grid).
    const s = this.snap(p);
    let endRef: PointRef | null = null;
    if (s?.ref && st.pts.length > 1) {
      st.pts.push(s.uv);
      endRef = s.ref;
    }
    const wpp = this.app.view.cam.worldPerPixel(this.app.view.height);
    const { pieces, closed } = simplifyStroke(st.pts, wpp * 2.5, wpp * 18);
    if (!pieces.length) return this.refreshPreview();
    const es: SketchEntity[] = pieces.map((x) => (x.kind === "spline" ? { id: uid(), kind: "spline", points: x.points, closed: x.closed, mode: "fit" } : { id: uid(), ...x }) as SketchEntity);
    const startP = (e: SketchEntity): PointRef | null => (e.kind === "line" || e.kind === "arc" ? { e: e.id, p: "a" } : e.kind === "spline" && !e.closed ? { e: e.id, p: "k0" } : null);
    const endP = (e: SketchEntity): PointRef | null => (e.kind === "line" || e.kind === "arc" ? { e: e.id, p: "b" } : e.kind === "spline" && !e.closed ? { e: e.id, p: `k${e.points.length - 1}` } : null);
    const cs: SketchConstraint[] = [];
    const co = (a: PointRef | null, b: PointRef | null) => a && b && cs.push({ id: uid(), type: "coincident", pts: [a, b] });
    // The pieces stay joined where one ends and the next begins (and round the loop).
    for (let i = 1; i < es.length; i++) co(endP(es[i - 1]), startP(es[i]));
    if (closed && es.length) co(endP(es[es.length - 1]), startP(es[0]));
    // Started / ended on an existing point: tied to it.
    if (settings.value.autoConstrain && !closed) {
      co(startP(es[0]), st.startRef);
      co(endP(es[es.length - 1]), endRef);
    }
    this.commitAdd(es, cs);
    this.app.ui.toast(`Drawn: ${describePieces(es)}`);
  }

  /** What an arc's second tap (its other end) snapped to. */
  private secondRef: PointRef | null = null;

  /** Where the finger / pointer went down for the shape being started. */
  private downAt: { x: number; y: number } | null = null;

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
    const refs = this.joinCorners(this.dragRefs(this.selected, this.selPts));
    if (!refs.length) return false;
    const c = toPlane(this.plane!, this.gimbal.origin);
    this.sdrag = { kind: "gimbal", part, from: p, refs, center: c, last: { d: [0, 0], ang: 0 } };
    this.gimbal.setHot(part);
    return true;
  }

  /** Press on a curve/point and move: drag it (a tap without moving selects it instead). */
  /** Trim by swiping: the curves as the swipe began, and the last pointer spot. */
  private swipe: { base: SketchEntity[]; last: { x: number; y: number }; cut: number; now?: SketchEntity[] } | null = null;

  dragStart(p: ToolPointer): boolean {
    if (this.phase === "draw" && (this.kind === "select" || this.kind === "move") && this.startGimbalDrag(p)) return true;
    // Trim (Cut): a swipe that starts on a curve trims every piece it crosses
    // (one undo step). A swipe from empty space still moves the view.
    if (this.phase === "draw" && this.kind === "trim" && memory.trim === "cut" && this.sketchId) {
      if (!this.curveAt(p)) return false;
      this.swipe = { base: this.entities, last: { x: p.x, y: p.y }, cut: 0 };
      this.swipeAt(p);
      return true;
    }
    if (this.phase !== "draw" || this.kind !== "select") return false;
    const hit = this.app.view.pick(p.x, p.y, { curves: this.sketchId ?? true, profiles: false, bodies: false, planes: false, axes: false, images: false, edgeTolPx: p.tol });
    const from = this.uvAt(p);
    if (!from || !hit || (hit.kind !== "point" && hit.kind !== "curve") || hit.sketch !== this.sketchId) return false;
    // Dragging something unselected drags just that; a selected thing drags the whole selection.
    const isSel = hit.kind === "curve" ? this.selected.has(hit.entity) : this.selPts.some((r) => r.e === hit.entity && r.p === hit.p);
    const refs = this.joinCorners(isSel ? this.dragRefs(this.selected, this.selPts) : hit.kind === "curve" ? this.dragRefs([hit.entity], []) : this.dragRefs([], [{ e: hit.entity, p: hit.p }]));
    if (!refs.length) return false;
    this.sdrag = { kind: "points", from, refs };
    return true;
  }

  /**
   * A corner of a rectangle or polygon about to be dragged: the shape becomes
   * lines joined at its corners first (same undo step as the drag), so only
   * that corner and its two sides move - a rectangle stretches, staying square.
   */
  private joinCorners(refs: DragRef[]): DragRef[] {
    const ids = new Set(refs.filter((d) => /^k\d+$/.test(d.ref.p)).map((d) => d.ref.e));
    let es = this.entities;
    let cs = this.constraints;
    const maps: ((r: PointRef) => PointRef | null)[] = [];
    for (const id of ids) {
      const e = es.find((x) => x.id === id);
      const out = e && explodeJoined(e, cs, uid);
      if (!out) continue;
      es = es.flatMap((x) => (x.id === id ? out.lines : [x]));
      cs = out.constraints;
      maps.push(out.ref);
      if (this.selected.delete(id)) for (const l of out.lines) this.selected.add(l.id);
    }
    if (!maps.length || !this.sketchId) return refs;
    const map = (r: PointRef): PointRef | null => maps.reduce<PointRef | null>((q, f) => (q ? f(q) : null), r);
    this.selPts = this.selPts.map(map).filter((r): r is PointRef => !!r);
    const sid = this.sketchId;
    this.app.store.transient((doc) => {
      const f = doc.features.find((x) => x.id === sid);
      if (f?.type === "sketch") {
        f.entities = es;
        f.constraints = cs.length ? cs : undefined;
      }
    });
    const out = new Map<string, DragRef>();
    for (const d of refs) {
      const r = map(d.ref);
      if (r) out.set(refKey(r), { ref: r, at: d.at });
    }
    return [...out.values()];
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
      const d = this.snapDrop(dr.refs, [uv[0] - dr.from[0], uv[1] - dr.from[1]], p);
      this.moveRefs(dr.refs, (q) => [q[0] + d[0], q[1] + d[1]]);
      this.app.ui.setLabel(p.x, p.y, this.dropOn ? "Joins here" : `${fmtLen(Math.hypot(...d))}`);
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
    else d = this.snapDrop(dr.refs, [snap(d[0]), snap(d[1])], p);
    this.applyGimbal(d, 0);
    this.app.ui.setLabel(p.x, p.y, this.dropOn ? "Joins here" : `${fmtLen(Math.hypot(...d))}  · type a value`);
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
    // Somewhere the constraints can't follow: stay at the last good place
    // (unless the sketch was already off before the drag - then just follow).
    if (!r.ok && constraintError(base, this.constraints) < r.error) return;
    const id = this.sketchId;
    this.app.store.transient((doc) => {
      const f = doc.features.find((x) => x.id === id);
      if (f?.type === "sketch") f.entities = r.entities;
    });
  }

  private dragBase: SketchEntity[] | null = null;

  /** A single point being dragged onto another point: where it would join (Coincident on release). */
  private dropOn: PointRef | null = null;

  /**
   * One point dragged near another curve's point: it snaps exactly onto it
   * (and joins it when let go). Returns the drag offset to use.
   */
  private snapDrop(refs: DragRef[], d: Vec2, p: ToolPointer): Vec2 {
    this.dropOn = null;
    if (refs.length !== 1 || !this.plane) return d;
    const r0 = refs[0];
    const base = this.dragBase ?? this.entities;
    const tol = Math.max(12, p.tol);
    let best: { q: Vec2; ref: PointRef; dist: number } | null = null;
    for (const e of base) {
      if (e.id === r0.ref.e) continue;
      for (const q of pointsOf(e)) {
        // Already on it (joined before the drag): not a new place to drop.
        if (Math.hypot(q.at[0] - r0.at[0], q.at[1] - r0.at[1]) < 1e-9) continue;
        const sc = this.app.view.toScreen(sketchToWorld(this.plane, q.at));
        if (!sc) continue;
        const dist = Math.hypot(sc[0] - p.x, sc[1] - p.y);
        if (dist < tol && (!best || dist < best.dist)) best = { q: q.at, ref: { e: e.id, p: q.p }, dist };
      }
    }
    if (!best) return d;
    this.dropOn = best.ref;
    return [best.q[0] - r0.at[0], best.q[1] - r0.at[1]];
  }

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
    const moved = this.sdrag && (this.sdrag.kind === "points" || this.sdrag.kind === "gimbal") ? this.sdrag.refs : [];
    const drop = this.dropOn;
    this.dropOn = null;
    this.sdrag = null;
    this.dragBase = null;
    this.typing.reset();
    this.app.ui.setLabel(0, 0, null);
    // Dropped onto another point: they're joined (Coincident) - if the constraints allow it.
    if (drop && moved.length === 1) {
      const c: SketchConstraint = { id: uid(), type: "coincident", pts: [moved[0].ref, drop] };
      const res = addStrict(this.entities, this.constraints, [c]);
      if (res.ok) {
        this.commit(res.result.entities, res.constraints);
        this.app.ui.toast("Joined (coincident)");
      } else this.commit(this.entities);
    } else this.commit(this.entities);
    // One undo step for the whole drag.
    this.gimbal?.setHot(null);
    this.refreshGimbal();
  }

  /** The sketch gimbal sits at the centre of the selection (Select tool only). */
  private scaleGimbal: Gimbal | null = null;
  private scaleDrag: { from: ToolPointer; part: GimbalPart; f0: number; center: Vec2; size: number } | null = null;

  /** Scale tool: cube handles on the selection - drag one out or in to scale (or type the factor). */
  private refreshScaleGimbal(): void {
    const sel = this.entities.filter((e) => this.selected.has(e.id));
    const show = this.kind === "scale" && this.phase === "draw" && sel.length > 0 && !this.scaleDrag;
    if (!show) {
      if (!this.scaleDrag) {
        this.scaleGimbal?.dispose();
        this.scaleGimbal = null;
      }
      return;
    }
    const plane = this.plane!;
    this.scaleGimbal ??= new Gimbal(this.app.view, { axes: [plane.xDir, planeY(plane), plane.normal], parts: (q) => q.kind === "center" || (q.kind === "axis" && q.i < 2), cubes: true });
    this.scaleGimbal.setCenter(sketchToWorld(plane, centroidOf(sel)).toArray() as Vec3);
  }

  private startScaleDrag(p: ToolPointer): boolean {
    const part = this.scaleGimbal?.hit(p);
    if (!part || !this.scaleGimbal || !this.plane) return false;
    const sel = this.entities.filter((e) => this.selected.has(e.id));
    const c = centroidOf(sel);
    // How big the selection is (from its centre): the drag is measured against it.
    const size = Math.max(1e-6, ...sel.flatMap((e) => entityPolylines(e).flat()).map((q) => Math.hypot(q[0] - c[0], q[1] - c[1])));
    this.scaleDrag = { from: p, part, f0: this.edit.factor, center: c, size };
    this.scaleGimbal.setHot(part);
    return true;
  }

  private dragScale(p: ToolPointer): void {
    const dr = this.scaleDrag!;
    const view = this.app.view;
    const plane = this.plane!;
    let d: number;
    if (dr.part.kind === "axis") {
      const dir = dr.part.i === 0 ? plane.xDir : planeY(plane);
      d = axisDrag(view, sketchToWorld(plane, dr.center).toArray() as Vec3, dir, dr.from, p);
    } else d = (dr.from.y - p.y) * view.cam.worldPerPixel(view.height); // centre: up grows, down shrinks
    let f = Math.max(0.01, dr.f0 * (1 + d / dr.size));
    if (!p.shift) f = Math.max(0.01, Math.round(f * 100) / 100);
    this.edit.factor = f;
    this.app.ui.updatePanelValues([f]);
    this.app.ui.setLabel(p.x, p.y, `×${f}`);
    this.refreshPreview();
  }

  private refreshGimbal(): void {
    this.refreshScaleGimbal();
    // Select and Move/Rotate: a gimbal on the selection (drag to move or turn it).
    const show = (this.kind === "select" || this.kind === "move") && this.phase === "draw" && (this.selected.size > 0 || this.selPts.length > 0) && !this.sdrag;
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
   * the box (a drag never orbits in a sketch - that's the right button).
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
    for (const id of picked) if (!this.selected.has(id)) (this.selected.add(id), this.pickSeq.set(id, ++this.seq));
    this.selectionChanged();
  }

  /** Right-click: end the current chain/shape (and keep what's drawn). */
  context(p?: ToolPointer): void {
    if (this.kind === "spline" && this.pts.length >= 2) return this.finishSpline(false);
    if (this.pts.length) return this.resetDrawing();
    // Right-click on empty space, in any tool: let go of everything picked
    // (selection, a half-done Offset / Extend / Fillet / Align, a Pattern centre).
    if (!p || !this.curveAt(p)) {
      // Each right-click goes one step back: what's picked or half done, then
      // the drawing tool (back to Select), then out of the sketch.
      const pending = !!this.filletEdit || !!(this.edit.offsetOf || this.edit.extendFrom || this.edit.alignFrom || this.edit.filletFrom || this.edit.pivot || this.edit.picking || this.edit.refA) || !!this.selConstraint || this.selected.size > 0 || this.selPts.length > 0;
      if (!pending) {
        if (this.kind !== "select") return this.setKind("select");
        return this.app.setTool(null);
      }
      if (this.filletEdit) this.cancelFillet();
      this.edit.offsetOf = this.edit.extendFrom = this.edit.alignFrom = this.edit.filletFrom = undefined;
      this.edit.pivot = undefined;
      this.edit.picking = undefined;
      // Scale by reference: its points go too (and a factor only they had set).
      if (this.edit.refA) ((this.edit.refA = this.edit.refB = undefined), (this.edit.factor = 1), this.refreshRefDim(), this.refreshPreview());
      if (this.selConstraint) this.deselectConstraint();
      this.clearSelection();
      this.setHint();
      return;
    }
    if (this.selected.size || this.selPts.length) this.clearSelection();
  }

  tap(p: ToolPointer, count: number): void {
    if (this.phase === "plane") return this.pickPlane(p);
    if (this.edit.picking) return this.pickForEdit(p);
    // A tap on empty space finishes what's waiting for Apply (like elsewhere).
    // (Not while a turn still needs its centre: that tap is the centre.)
    const needsCentre = (this.kind === "rotate" || this.kind === "patternCircular") && !this.edit.pivot;
    if (this.isSelectionTool() && this.selected.size && this.transformPending() && !needsCentre && !this.curveAt(p) && !p.shift) {
      this.applyTransform();
      // Done with it: nothing left selected, so the next empty tap doesn't do it again.
      return this.clearSelection();
    }
    // A constraint mark, with nothing of the drawing under the tap: select that constraint.
    if (this.kind === "select" && !this.curveAt(p)) {
      const c = this.glyphs?.hitAt(p.x, p.y);
      if (c) return this.selectConstraint(c);
    }
    switch (this.kind) {
      case "select":
      case "move":
      case "scale":
      case "patternLinear":
        return this.tapSelect(p, count);
      case "patternCircular":
      case "rotate":
        // With curves selected and no centre yet, the tap places the centre (snapping to points).
        if (this.selected.size && !this.edit.pivot && !p.shift) {
          const s = this.snap(p);
          if (s) this.edit.pivot = s.uv;
          this.updatePanel();
          this.refreshPreview();
          return this.setHint(this.kind === "rotate" ? "Set the angle, then Apply. Tap the Center field to move the centre." : "Set the count and angle, then Apply. Tap the Center field to move the centre.");
        }
        return this.tapSelect(p, count);
      case "mirror":
        return this.tapSelect(p, count);
      case "delete":
        return this.tapCurve(p, (id) => this.commit(this.entities.filter((e) => e.id !== id)));
      case "trim":
        if (memory.trim === "join") return this.tapCurve(p, (id, uv) => this.tapJoin(id, uv));
        return this.tapCurve(p, (id, uv) => this.commitEdit(this.trimHere(this.entities, id, uv)));
      case "align":
        return this.tapCurve(p, (id, uv) => this.tapAlign(id, uv));
      case "extend":
        return this.tapCurve(p, (id, uv) => this.tapExtend(id, uv));
      case "split":
        return this.tapCurve(p, (id, uv) => this.tapSplit(id, uv, p.shift));
      case "offset":
        // The face's own edge too (it isn't a curve of the sketch the view picks) -
        // also when an offset of it made before runs close by and the tap is
        // nearer the edge (a second lip line 2 mm further in).
        {
          const c = this.curveAt(p);
          const o = this.outlineAt(p);
          const link = c?.id.startsWith("lnk-") ? this.boundary.find((x) => x.id === c.id) : undefined;
          const nearer = o && link && o.d <= Math.min(...entityPrims(link).map((pr) => closestOnPrim(pr, o.uv).d));
          if (o && (!c || nearer)) {
            memory.offset = -Math.abs(defaultOffset(o.e));
            this.edit.offsetAt = o.uv;
            this.edit.offsetOf = o.e.id;
            this.updatePanel();
            this.refreshPreview();
            return;
          }
        }
        return this.tapCurve(p, (id, uv) => {
          if (id.startsWith("lnk-")) return this.app.ui.toast("That's an offset of the face's edge already - tap it in Select to change its distance");
          // The face's own edge: its whole outline, offset inward to start, and
          // linked - it's made again from the face when the face changes.
          if (id.startsWith("bnd-")) {
            const e = this.outline.find((x) => x.id === id);
            if (e) memory.offset = -Math.abs(defaultOffset(e));
            this.edit.offsetAt = uv;
          } else {
            // A tenth of the curve tapped (keeping the side it went last time).
            const e = this.entities.find((x) => x.id === id);
            if (e) memory.offset = (memory.offset < 0 ? -1 : 1) * defaultOffset(e);
          }
          this.edit.offsetOf = id;
          this.updatePanel();
          this.refreshPreview();
        });
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
    // Text placed, its box not focused yet (typed straight after the tap): the
    // keys are the text, not shortcuts - "1" then Enter used to be lost.
    if (this.kind === "text" && this.pts.length === 1) {
      const box = document.querySelector<HTMLInputElement>("#panel .text-input");
      if (box && document.activeElement !== box) {
        if (e.key.length === 1) {
          if (!this.textTyped) box.value = "";
          box.value += e.key;
          this.textTyped = true;
          this.text = box.value;
          this.refreshPreview();
          box.focus();
          return true;
        }
        if (e.key === "Enter") {
          void this.commitText();
          return true;
        }
      }
    }
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
          kind: key === "ang" || key === "a0" || key === "a1" ? "angle" : key === "sides" ? "number" : "length",
          show: key === "len" && this.lineDim ? (text, bad) => this.lineDim?.setText(text, bad) : undefined,
          apply: (v) => this.applyLock(key, v),
          commit: () => {
            // Enter moves on to the next size - except the polygon's side count (Tab only).
            if (this.lockIndex < keys.length - 1 && keys[this.lockIndex + 1] !== "sides") {
              this.lockIndex++;
              this.setHint(`Now type the ${{ ang: "angle", h: "height", sides: "number of sides", a0: "start angle", a1: "end angle", r: "radius" }[keys[this.lockIndex]] ?? "next value"} (or Enter to keep it), then Enter.`);
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
      this.plane = originOnPlane(info.plane);
      this.attachedTo = { body: hit.body, center: info.center, normal: info.normal, area: info.area, ...(info.step ? { step: info.step } : {}), ...(info.curve ? { curve: info.curve } : {}) };

    } else if (hit.kind === "profile") {
      // Tapping an existing sketch continues it.
      this.sketchId = hit.sketch;
      this.plane = this.app.sketchPlane(hit.sketch) ?? null;
    } else return;
    this.app.ui.showPanel(null);
    // Say which plane it is (an origin plane tapped in 3D is easy to mistake).
    if (hit.kind === "plane") this.app.ui.toast(`Sketching on ${hit.id === "XY" ? "XY (floor)" : hit.id === "XZ" ? "XZ (front)" : hit.id === "YZ" ? "YZ (side)" : "the plane"}`);
    this.beginDrawing();
  }

  // -------------------------------------------------------------- snapping

  private snap(p: ToolPointer): Snap | null {
    const s = this.snapAt(p);
    if (s && !s.raw) {
      const w = this.plane && this.app.view.rayToPlane(p.x, p.y, this.plane);
      if (w) s.raw = toPlane(this.plane!, w);
    }
    return s;
  }

  private snapAt(p: ToolPointer): Snap | null {
    const plane = this.plane;
    if (!plane) return null;
    const w = this.app.view.rayToPlane(p.x, p.y, plane);
    if (!w) return null;
    const raw = toPlane(plane, w);
    if (p.shift) return { uv: raw };
    const s = settings.value.snap;
    const view = this.app.view;
    const screen = (uv: Vec2) => view.toScreen(sketchToWorld(plane, uv));
    // A finger covers what it lands on and can't nudge: on touch screens snap
    // reach stays near a fingertip's own error (~14 px), not 25 - placing text
    // beside a ruler's ticks, every tap jumped onto a tick end.
    const touch = p.type === "touch";
    const tol = touch ? p.tol * 0.8 : p.tol * 1.4;

    // The origin is a guide point like the others: with them switched off it
    // must not pull taps either (numbers placed along a ruler near the origin
    // all jumped onto it - a fingertip's reach is ~20 px on a phone).
    // Drawn on it: held there (a line from the origin, sized later, slid its start off it).
    const cands: { p: Vec2; label: string; ref?: PointRef; mid?: string; model?: boolean }[] = s.guidePoints ? [{ p: [0, 0], label: "Origin", model: true }] : [];
    if (s.guidePoints) {
      for (const e of this.entities) {
        // Named points first (they can be constrained), then midpoints etc.
        for (const q of pointsOf(e)) cands.push({ p: q.at, label: q.p === "c" ? "Center" : "Endpoint", ref: { e: e.id, p: q.p } });
        for (const g of guidePoints(e)) if (g.kind === "mid") cands.push({ p: g.p, label: "Midpoint", mid: e.kind === "line" ? e.id : undefined });
      }
      for (const e of this.boundary) for (const g of guidePoints(e)) cands.push({ p: g.p, label: g.kind === "mid" ? "Midpoint" : "Edge point" });
      for (const q of this.pts) cands.push({ p: q, label: "Point" });
    }
    if (s.points3d) {
      for (const b of view.bodyList) {
        for (const e of b.edges) {
          for (const v of [e.start, e.end]) {
            const off = Math.abs((v[0] - plane.origin[0]) * plane.normal[0] + (v[1] - plane.origin[1]) * plane.normal[1] + (v[2] - plane.origin[2]) * plane.normal[2]);
            if (off < 1e-4 || s.distantEdges) cands.push({ p: toPlane(plane, v), label: "3D point", model: off < 1e-4 });
          }
          // A full circle's centre (the end of a round rod, a hole): only its
          // rim used to snap, so a line started "at the end of the stem" began
          // on its side.
          if (e.type === "CIRCLE" && Math.hypot(e.start[0] - e.end[0], e.start[1] - e.end[1], e.start[2] - e.end[2]) < 1e-6) {
            const c: Vec3 = [(e.start[0] + e.mid[0]) / 2, (e.start[1] + e.mid[1]) / 2, (e.start[2] + e.mid[2]) / 2];
            const off = Math.abs((c[0] - plane.origin[0]) * plane.normal[0] + (c[1] - plane.origin[1]) * plane.normal[1] + (c[2] - plane.origin[2]) * plane.normal[2]);
            if (off < 1e-4 || s.distantEdges) cands.push({ p: toPlane(plane, c), label: "Center", model: off < 1e-4 });
          }
        }
      }
    }
    // Drawing a line: it mustn't be pulled onto a line it runs alongside (a
    // parallel line drawn close to another collapsed onto it on phones, where
    // the snap reach is a fingertip wide) - unless it carries on along that line.
    const drawFrom = this.kind === "line" && this.pts.length ? this.pts[this.pts.length - 1] : null;
    const wppPx = view.cam.worldPerPixel(view.height);
    const alongside = (a: Vec2, b: Vec2, to: Vec2): boolean => !!drawFrom && runsAlongside(a, b, drawFrom, to, wppPx * 2);
    const lineOf = new Map<string, Extract<SketchEntity, { kind: "line" }>>();
    for (const e of this.entities) if (e.kind === "line") lineOf.set(e.id, e);
    const reach: { p: Vec2; label: string; d: number; ref?: PointRef; mid?: string; model?: boolean }[] = [];
    for (const c of cands) {
      // An end of a line the new one would run alongside: joining it would make a sliver.
      const owner = c.ref && lineOf.get(c.ref.e);
      if (owner && alongside(owner.a, owner.b, c.p)) continue;
      const sc = screen(c.p);
      if (!sc) continue;
      reach.push({ ...c, d: Math.hypot(sc[0] - p.x, sc[1] - p.y) });
    }
    // (Two on one spot: the one a drawing there can be kept on.)
    const best = nearestSnap(reach, tol);
    if (best) return { uv: [...best.p] as Vec2, label: best.label, ref: best.ref, mid: best.mid, model: best.model };

    // Nothing to land on: lines and curves to slide along - straight across from
    // a point, on a curve, a line's extension, parallel or square to a line. Near
    // two of them: where they cross.
    const wpp = view.cam.worldPerPixel(view.height);
    const loci: Locus[] = [];
    if (s.guideLines) {
      for (const c of s.guidePoints ? cands : [{ p: [0, 0] as Vec2 }]) {
        loci.push({ kind: "line", p: c.p, d: [0, 1], label: "Vertical", guide: c.p, axis: 0 });
        loci.push({ kind: "line", p: c.p, d: [1, 0], label: "Horizontal", guide: c.p, axis: 1 });
      }
    }
    if (s.guidePoints) loci.push(...this.curveLoci());
    // A line being drawn: parallel or square to another line.
    const from = this.kind === "line" && this.pts.length ? this.pts[this.pts.length - 1] : null;
    if (from && s.guideLines) {
      const own = new Set(this.entities.map((e) => e.id));
      for (const e of [...this.entities, ...this.boundary]) {
        if (e.kind !== "line") continue;
        const d = unit2([e.b[0] - e.a[0], e.b[1] - e.a[1]]);
        // Level and upright are already there (straight across from the last point).
        if (Math.abs(d[0]) < 1e-6 || Math.abs(d[1]) < 1e-6) continue;
        const curve = own.has(e.id) ? e.id : "";
        loci.push({ kind: "line", p: from, d, label: "Parallel", guide: from, show: [e.a, e.b], dir: curve ? { type: "parallel", curve } : undefined });
        loci.push({ kind: "line", p: from, d: [-d[1], d[0]], label: "Perpendicular", guide: from, show: [e.a, e.b], dir: curve ? { type: "perpendicular", curve } : undefined });
      }
    }
    // How far (in pixels) the cursor is from each; a line's own length counts as
    // "on line", past its ends as "extension" (not too far out).
    const lt = touch ? p.tol * 0.6 : p.tol;
    const near: { L: Locus; q: Vec2; d: number; label: string; ext?: Vec2 }[] = [];
    for (const L of loci) {
      const q = nearestOnLocus(L, raw);
      const d = Math.hypot(q[0] - raw[0], q[1] - raw[1]) / wpp;
      if (d >= lt) continue;
      // On (or past the end of) a line the new line runs alongside: not a place to land.
      if (L.kind === "line" && L.seg && alongside(L.seg[0], L.seg[1], q)) continue;
      let label = L.label;
      let ext: Vec2 | undefined;
      if (L.kind === "line" && L.seg) {
        const [a, b] = L.seg;
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const t = (q[0] - a[0]) * L.d[0] + (q[1] - a[1]) * L.d[1];
        if (t < 0 || t > len) {
          // Off the end: only real lines extend (and not halfway across the screen).
          if (L.label !== "On line") continue;
          const end = t < 0 ? a : b;
          if (Math.hypot(q[0] - end[0], q[1] - end[1]) / wpp > 400) continue;
          label = "Extension";
          ext = end;
        }
      }
      // A direction from the last point: only ahead of it, and not right on top of it.
      if (L.kind === "line" && L.dir !== undefined && Math.hypot(q[0] - L.p[0], q[1] - L.p[1]) / wpp < 20) continue;
      near.push({ L, q, d, label, ext });
    }
    // Curves and extensions win a tie over the straight-across guides (they're what you aimed at).
    const rank = (n: (typeof near)[number]) => n.d - (n.L.kind === "circle" || (n.L.kind === "line" && n.L.seg) ? 2 : 0);
    near.sort((a, b) => rank(a) - rank(b));

    const out: Snap = { uv: raw, guides: [] };
    const used: typeof near = [];
    if (near.length) {
      const A = near[0];
      used.push(A);
      out.uv = A.q;
      // A second one close by: where the two cross.
      let bestX: { n: (typeof near)[number]; x: Vec2; d: number } | null = null;
      for (const n of near.slice(1)) {
        if (n.L === A.L) continue;
        const x = crossLoci(A.L, n.L, raw);
        if (!x) continue;
        const d = Math.hypot(x[0] - raw[0], x[1] - raw[1]) / wpp;
        if (d < lt * 1.3 && (!bestX || d < bestX.d)) bestX = { n, x, d };
      }
      if (bestX) {
        used.push(bestX.n);
        out.uv = bestX.x;
      }
    }
    // Grid along a straight-across guide (and everywhere when there's none).
    if (s.grid && used.length < 2) {
      // Finer than the drawn grid when zoomed in: its lines jump 1 → 10 mm, and
      // at 10 mm apart (90 px on a phone) a tap at 152 still landed on 150.
      // About what a fingertip can tell apart (8 px), rounded to 1 / 5 / 10.
      const step = settings.value.gridLocked ? view.grid.step : Math.min(view.grid.step, niceStepOf(wpp * 8));
      const g = (v: number) => Math.round(v / step) * step;
      const only = used[0]?.L;
      if (!only) out.uv = [g(out.uv[0]), g(out.uv[1])];
      else if (only.kind === "line" && only.axis === 0) out.uv = [out.uv[0], g(out.uv[1])];
      else if (only.kind === "line" && only.axis === 1) out.uv = [g(out.uv[0]), out.uv[1]];
    }
    if (!used.length) return out;
    const labels = used.map((n) => n.label);
    out.label = labels.includes("Vertical") && labels.includes("Horizontal") ? "Aligned" : [...new Set(labels)].join(" · ");
    out.on = used.map((n) => n.L.on).filter((x): x is string => !!x);
    for (const n of used) {
      const L = n.L;
      if (L.kind === "line" && L.guide) out.guides!.push([L.guide, out.uv]);
      if (n.ext) out.guides!.push([n.ext, out.uv]);
      if (L.kind === "line" && L.show) out.guides!.push(L.show);
      if (L.kind === "line" && L.dir) out.dir = L.dir;
    }
    return out;
  }

  /** The sketch's curves as things to slide along - built once per change of the sketch, not on every move. */
  private lociCache: { ents: SketchEntity[]; bnd: unknown; loci: Locus[] } | null = null;
  private curveLoci(): Locus[] {
    const c = this.lociCache;
    // (The face outline is rebuilt as a new list each time: compare what's in it - it's short.)
    const bndSrc = JSON.stringify(this.boundary);
    if (c && c.ents === this.entities && c.bnd === bndSrc) return c.loci;
    const loci: Locus[] = [];
    const own = new Set(this.entities.map((e) => e.id));
    for (const e of [...this.entities, ...this.boundary]) {
      const mine = own.has(e.id) ? e.id : undefined;
      if (e.kind === "line") {
        const d = unit2([e.b[0] - e.a[0], e.b[1] - e.a[1]]);
        loci.push({ kind: "line", p: e.a, d, label: "On line", seg: [e.a, e.b], on: mine });
      } else if (e.kind === "circle") loci.push({ kind: "circle", c: e.center, r: e.radius, label: "On circle", on: mine });
      else if (e.kind === "arc") {
        const a = arcFrom3(e.a, e.m, e.b);
        if (a) loci.push({ kind: "circle", c: a.c, r: a.r, label: "On arc", on: mine });
      } else {
        // Sides of rectangles and polygons, and splines/ellipses piece by piece.
        for (const poly of entityPolylines(e))
          for (let i = 0; i + 1 < poly.length; i++) {
            const a = poly[i];
            const b = poly[i + 1];
            if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-9) continue;
            loci.push({ kind: "line", p: a, d: unit2([b[0] - a[0], b[1] - a[1]]), label: "On curve", seg: [a, b] });
          }
      }
    }
    this.lociCache = { ents: this.entities, bnd: bndSrc, loci };
    return loci;
  }

  /** Constraints that keep a drawn point where it snapped (on a curve, a line's middle). */
  /** An existing end or centre exactly at p (a typed point landing on it), not the line being drawn. */
  private typedEndOn(p: Vec2, not: string): PointRef | null {
    for (const e of this.entities) {
      if (e.id === not || e.id === this.lastLineId) continue;
      for (const q of pointsOf(e)) if (Math.hypot(q.at[0] - p[0], q.at[1] - p[1]) < 1e-6) return { e: e.id, p: q.p };
    }
    // The last line's start (the chain coming back on itself): its end is this line's start.
    const last = this.lastLineId ? this.entities.find((e) => e.id === this.lastLineId) : undefined;
    if (last?.kind === "line" && Math.hypot(last.a[0] - p[0], last.a[1] - p[1]) < 1e-6) return { e: last.id, p: "a" };
    return null;
  }

  private snapKeeps(s: Snap | null | undefined, at: PointRef): SketchConstraint[] {
    if (!s || !settings.value.autoConstrain) return [];
    const cs: SketchConstraint[] = [];
    if (s.mid) cs.push({ id: uid(), type: "midpoint", pts: [at], curves: [s.mid] });
    // Started on the model (the centre of a socket, a corner): held there - a
    // radius typed later slid the whole drawing a millimetre off it.
    if (s.model) cs.push({ id: uid(), type: "fix", pts: [at], at: [...s.uv] as Vec2 });
    for (const c of s.on ?? []) cs.push({ id: uid(), type: "coincident", pts: [at], curves: [c] });
    return cs;
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
    // The first side of a 3-point rectangle / circle / arc: a length and angle, like a line.
    const firstSide = this.pts.length === 1 && ((this.kind === "arc" && memory.arc !== "center") || (this.kind === "rect" && memory.rect === "3pt") || (this.kind === "circle" && memory.circle === "3pt"));
    if (firstSide) {
      if (L.len === undefined && L.ang === undefined) return c;
      const ang = L.ang !== undefined ? (L.ang * Math.PI) / 180 : Math.atan2(c[1] - a[1], c[0] - a[0]);
      const len = L.len ?? Math.hypot(c[0] - a[0], c[1] - a[1]);
      return [a[0] + Math.cos(ang) * len, a[1] + Math.sin(ang) * len];
    }
    if (this.pts.length === 2 && ((this.kind === "arc" && memory.arc !== "center" && L.r !== undefined) || (this.kind === "rect" && memory.rect === "3pt" && L.h !== undefined))) {
      const [p0, p1] = this.pts;
      const d = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) || 1;
      const n: Vec2 = [-(p1[1] - p0[1]) / d, (p1[0] - p0[0]) / d];
      // The pointer's side of the chord. On a phone there's no pointer: it's
      // still on the end just tapped, on the chord itself - then the side the
      // bend preview shows (a counterweight's R72 typed came out bulging up,
      // the preview had it down).
      const towards = (q: Vec2) => (q[0] - p0[0]) * n[0] + (q[1] - p0[1]) * n[1];
      const side = (Math.abs(towards(c)) > d * 1e-9 ? Math.sign(towards(c)) : 0) || (this.arcM ? Math.sign(towards(this.arcM)) : 0) || 1;
      if (this.kind === "rect") return [p1[0] + n[0] * side * L.h, p1[1] + n[1] * side * L.h];
      // Arc through both ends with that radius, bulging the pointer's way (the
      // short way round, unless the pointer is further out than the radius).
      const h = d / 2;
      const r = Math.max(L.r, h);
      const mid: Vec2 = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
      const far = Math.abs((c[0] - mid[0]) * n[0] + (c[1] - mid[1]) * n[1]) > r;
      const s = far ? r + Math.sqrt(r * r - h * h) : r - Math.sqrt(r * r - h * h);
      return [mid[0] + n[0] * side * s, mid[1] + n[1] * side * s];
    }
    switch (this.kind) {
      case "line": {
        // Typed across / up: exactly there (what isn't typed stays put).
        if (L.dx !== undefined || L.dy !== undefined) return [last[0] + (L.dx ?? 0), last[1] + (L.dy ?? 0)];
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
        // (Circle by two points: the second point is the diameter away.)
        const r = this.kind === "circle" ? (memory.circle === "2pt" ? L.r : L.r / 2) : L.r;
        const ang = Math.atan2(c[1] - a[1], c[0] - a[0]);
        return [a[0] + Math.cos(ang) * r, a[1] + Math.sin(ang) * r];
      }
      case "arc": {
        if (memory.arc !== "center") return c;
        const deg = (x: number) => (x * Math.PI) / 180;
        // (A length typed in the box on the radius line is the radius.)
        if (this.pts.length === 1 && (L.r !== undefined || L.a0 !== undefined || L.len !== undefined)) {
          const r = L.r ?? L.len ?? Math.hypot(c[0] - a[0], c[1] - a[1]);
          const ang = L.a0 !== undefined ? deg(L.a0) : Math.atan2(c[1] - a[1], c[0] - a[0]);
          return [a[0] + Math.cos(ang) * r, a[1] + Math.sin(ang) * r];
        }
        if (this.pts.length === 2 && L.a1 !== undefined) {
          const r = Math.hypot(this.pts[1][0] - a[0], this.pts[1][1] - a[1]);
          return [a[0] + Math.cos(deg(L.a1)) * r, a[1] + Math.sin(deg(L.a1)) * r];
        }
        return c;
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
   * by it - type it on the numpad; the line keeps its direction.
   */
  private lineBox: { id: string; widget: DimWidget; value: number; edited: boolean; expr?: string } | null = null;

  private showLineBox(id: string): void {
    this.closeLineBox();
    const l = this.entities.find((e) => e.id === id);
    if (l?.kind !== "line" || !this.plane) return;
    const len = Math.hypot(l.b[0] - l.a[0], l.b[1] - l.a[1]);
    const widget = new DimWidget(this.app.view, {
      value: len,
      // Beside it; a short line's box goes behind its start (it covered the
      // corner where the next line starts: the tap there went into the box).
      boxAt: "clear",
      focus: true,
      onInput: (v, text) => {
        if (v <= 0) return;
        this.resizeLine(id, v);
        // A formula (with variables) stays linked to them.
        this.lineBox!.expr = isExpression(text) ? text.trim() : undefined;
      },
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
    this.commit(this.entities, [...cs, { id: uid(), type: "dim", curves: [b.id], prop: "length", value: len, ...(b.expr ? { expr: b.expr } : {}) }]);
  }

  /** The snapped first point sits on a line the new line (to `end`) runs alongside. */
  private startedAlongside(s: Snap, end: Vec2, reversed = false): boolean {
    const raw = s.raw!;
    if (Math.hypot(raw[0] - s.uv[0], raw[1] - s.uv[1]) < 1e-12) return false;
    const ids = new Set([...(s.on ?? []), ...(s.ref ? [s.ref.e] : [])]);
    const wpp = this.app.view.cam.worldPerPixel(this.app.view.height);
    // (reversed: s is the end, `end` the start - the run is the same either way.)
    for (const e of this.entities) if (e.kind === "line" && ids.has(e.id) && (reversed ? runsAlongside(e.a, e.b, end, raw, -1) : runsAlongside(e.a, e.b, raw, end, wpp * 2))) return true;
    return false;
  }

  private addPoint(uv: Vec2, count: number): void {
    this.stopExitPulse();
    // Drawing started: (phones) the tool column shrinks to its icons.
    document.body.classList.add("sketch-compact");
    // The next tap finishes the length being typed for the line before.
    if (this.lineBox) this.closeLineBox();
    const c = this.lockedCursor() ?? uv;
    let pt = this.pts.length ? c : uv;
    const k = this.kind;
    const locked = Object.keys(this.locks).length > 0;
    // A typed size moves the point off whatever it snapped to.
    let snapRef = locked ? undefined : this.cursor?.ref;
    if (!this.pts.length) this.startRef = snapRef ?? null;
    if (!this.pts.length) this.startSnap = locked ? null : this.cursor;
    if (!this.pts.length) this.firstSnap = this.cursor;
    if (k === "line") {
      if (count >= 2 || (this.pts.length && samePt(pt, this.pts[this.pts.length - 1]))) return this.resetDrawing();
      if (this.pts.length) {
        // The first line of a chain: if its start was pulled onto a line it runs
        // alongside (a parallel line drawn close to another, on a phone), the
        // start goes back where the finger was - not onto that line.
        if (this.pts.length === 1 && this.firstSnap?.raw && this.startedAlongside(this.firstSnap, pt)) {
          this.pts[0] = this.firstSnap.raw;
          this.startRef = null;
          this.startSnap = null;
          // The end too, if it was caught by that line (it looked like carrying on from it).
          const end = this.cursor;
          if (!locked && end?.raw && this.startedAlongside({ ...end, raw: end.raw }, this.pts[0], true)) {
            pt = end.raw;
            snapRef = undefined;
            this.cursor = { uv: end.raw };
          }
        }
        const start = this.pts[0];
        const a = this.pts[this.pts.length - 1];
        const id = uid();
        const cs: SketchConstraint[] = [];
        const co = (p: PointRef, q: PointRef): SketchConstraint => ({ id: uid(), type: "coincident", pts: [p, q] });
        // A chain stays joined; the rest (snaps, H/V) only with Auto constrain on.
        const auto = settings.value.autoConstrain;
        if (this.lastLineId) cs.push(co({ e: this.lastLineId, p: "b" }, { e: id, p: "a" }));
        else if (this.startRef && auto) cs.push(co(this.startRef, { e: id, p: "a" }));
        else if (this.pts.length === 1) cs.push(...this.snapKeeps(this.startSnap, { e: id, p: "a" }));
        const closes = this.pts.length > 1 && samePt(pt, start) && this.chainFirstId;
        if (closes) cs.push(co({ e: id, p: "b" }, { e: this.chainFirstId!, p: "a" }));
        else if (snapRef && auto) cs.push(co({ e: id, p: "b" }, snapRef));
        else if (!locked) cs.push(...this.snapKeeps(this.cursor, { e: id, p: "b" }));
        else {
          // Typed to end exactly where another line already ends (a nose's
          // outline typed round back to the first line's start): joined there,
          // as a tap on that end would be. It was left loose, and the next
          // size changed slid the typed run off it, opening the outline.
          const on = this.typedEndOn(pt, id);
          if (on) cs.push(co({ e: id, p: "b" }, on));
        }
        if (auto && Math.abs(pt[1] - a[1]) < 1e-9) cs.push({ id: uid(), type: "horizontal", curves: [id] });
        else if (auto && Math.abs(pt[0] - a[0]) < 1e-9) cs.push({ id: uid(), type: "vertical", curves: [id] });
        else if (auto && !locked && this.cursor?.dir) cs.push({ id: uid(), type: this.cursor.dir.type, curves: [id, this.cursor.dir.curve] });
        // Typed values become driving dimensions (across / up: as its length and angle).
        if (this.locks.dx !== undefined || this.locks.dy !== undefined) {
          this.locks.len = Math.hypot(pt[0] - a[0], pt[1] - a[1]);
          this.locks.ang = (Math.atan2(pt[1] - a[1], pt[0] - a[0]) * 180) / Math.PI;
        }
        if (this.locks.len !== undefined) {
          const expr = this.lenExpr?.v === this.locks.len ? this.lenExpr.text : undefined;
          cs.push({ id: uid(), type: "dim", curves: [id], prop: "length", value: this.locks.len, ...(expr ? { expr } : {}) });
        }
        this.lenExpr = null;
        if (this.locks.ang !== undefined && !cs.some((x) => x.type === "horizontal" || x.type === "vertical")) cs.push({ id: uid(), type: "dim", curves: [id], prop: "angle", value: this.locks.ang });
        this.commitAdd([{ id, kind: "line", a, b: pt }], cs);
        this.lastLineId = id;
        this.chainFirstId ??= id;
        // Closing the chain on its first point ends it.
        // The outline closed: the drawing tool lets go (Select), so the next drag turns the view.
        if (closes || (this.pts.length > 1 && samePt(pt, start))) return this.shapeClosed();
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
      // Arc, third point: through where it was tapped (or the bend dragged to).
      // (An arc's second tap is its other end: what it snapped to is kept.)
      if (this.pts.length === 1) this.secondRef = snapRef ?? null;
      this.pts.push(pt);
      // (Centre arcs have no bend: their third tap is where they end.)
      if (k === "arc" && memory.arc === "3pt" && this.pts.length === 2) this.arcM = this.defaultArcMid(this.pts[0], this.pts[1]);
      if (k === "arc" && (memory.arc !== "3pt" || this.pts.length !== 2)) this.arcM = null;
      const need = k === "arc" || k === "ellipse" || (k === "rect" && memory.rect === "3pt") || (k === "circle" && memory.circle === "3pt") ? 3 : 2;
      if (this.pts.length >= need) {
        const e = this.buildShape(this.pts);
        const cs: SketchConstraint[] = [];
        if (e) {
          const L = this.locks;
          // Typed with a variable ("bore"): the dimension keeps it, so it follows the variable.
          const dim = (prop: string, key: string) => {
            const value = L[key];
            if (value === undefined) return;
            const x = this.lockExprs[key];
            cs.push({ id: uid(), type: "dim", curves: [e.id], prop, value, ...(x && Math.abs(x.v - value) < 1e-9 ? { expr: x.text } : {}) });
          };
          if (e.kind === "rect") {
            // The typed Width and Height are the whole rectangle's, in every mode
            // (a centre rectangle typed 100 × 150 used to come out 200 × 300).
            dim("w", memory.rect === "3pt" ? "len" : "w");
            dim("h", "h");
          }
          // An arc's typed radius (a centre arc's in the box on its radius line too) is kept as a dimension.
          if (e.kind === "arc") dim("radius", memory.arc === "center" && L.r === undefined ? "len" : "r");
          if (e.kind === "circle") dim("diameter", "r");
          if (e.kind === "polygon") dim("radius", "r");
          if (e.kind === "ellipse") (dim("dx", "rx"), dim("dy", "ry"));
          this.lockExprs = {};
          // A centre placed on an existing point stays on it.
          const centred = (e.kind === "circle" && memory.circle === "center") || e.kind === "polygon" || e.kind === "ellipse" || (e.kind === "rect" && memory.rect === "center") || (e.kind === "arc" && memory.arc === "center");
          if (settings.value.autoConstrain && centred && this.startRef) {
            cs.push({ id: uid(), type: "coincident", pts: [{ e: e.id, p: "c" }, this.startRef] });
          } else if (centred && e.kind !== "rect") cs.push(...this.snapKeeps(this.startSnap, { e: e.id, p: "c" }));
          // An arc between two points it was tapped on stays joined to them (it
          // came loose when its radius was typed: nothing tied its ends).
          if (e.kind === "arc" && memory.arc === "3pt" && settings.value.autoConstrain) {
            if (this.startRef) cs.push({ id: uid(), type: "coincident", pts: [{ e: e.id, p: "a" }, this.startRef] });
            if (this.secondRef) cs.push({ id: uid(), type: "coincident", pts: [{ e: e.id, p: "b" }, this.secondRef] });
          }
          this.secondRef = null;
        }
        this.pts = [];
        this.locks = {};
        this.typedThisShape = false;
        this.app.ui.setLabel(0, 0, null);
        if (e) this.commitAdd([e], cs);
        // A closed shape: back to Select (an arc is open - keep drawing them).
        if (e && e.kind !== "arc") return this.shapeClosed();
      }
    }
    this.updatePanel();
    this.refreshPreview();
  }

  /** Done / Enter in the card: the shape at its typed size (the first point is where it was tapped). */
  private finishTyped(): void {
    if (!this.pts.length) return;
    if (!Object.keys(this.locks).length) return this.app.ui.toast(document.querySelector("input.invalid") ? "That size can't be read - try a number like 20.8, or 36/sqrt(3)" : "Type a size first (or tap where it should end)");
    // No pointer to go by (a phone): the typed size from the first point, up and to the right.
    if (!this.cursor) this.cursor = { uv: [...this.pts[0]] as Vec2 };
    this.addPoint(this.cursor!.uv, 1);
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
    const shut = closed && this.pts.length >= 3;
    if (this.pts.length >= 2) this.commitAdd([{ id: uid(), kind: "spline", points: this.pts, closed: shut, mode: splineMode() }]);
    if (shut) return this.shapeClosed();
    this.resetDrawing();
  }

  /** A shape was closed: the drawing tool is put down (Select), ready to turn the view and extrude it. */
  private shapeClosed(): void {
    this.resetDrawing();
    this.setKind("select");
    // Done drawing, most likely: Exit Sketch pulses (until the next thing is drawn).
    this.exitPulse = true;
    this.updateMenu();
  }

  /** Exit Sketch pulsing: a shape was just closed, nothing drawn since. */
  private exitPulse = false;

  private stopExitPulse(): void {
    if (!this.exitPulse) return;
    this.exitPulse = false;
    this.updateMenu();
  }

  /** Arc being drawn: its middle point so far (both ends placed). */
  private arcM: Vec2 | null = null;
  /** Arc being bent by a drag: where the drag began, and the middle then. */
  private arcBend: { from: Vec2; m0: Vec2; x: number; y: number; moved: boolean } | null = null;

  /**
   * A first guess at the arc's bend from a to b: carrying on smoothly from
   * the line or arc it starts on (tangent), else a gentle bow to the left.
   */
  private defaultArcMid(a: Vec2, b: Vec2): Vec2 {
    const c: Vec2 = [b[0] - a[0], b[1] - a[1]];
    const L = Math.hypot(...c);
    const bow: Vec2 = [(a[0] + b[0]) / 2 - c[1] * 0.3, (a[1] + b[1]) / 2 + c[0] * 0.3];
    if (L < 1e-12) return bow;
    // The direction a curve ending at a arrives in.
    let t: Vec2 | null = null;
    for (const e of this.entities) {
      if (e.kind === "line") {
        if (samePt(e.b, a)) t = [e.b[0] - e.a[0], e.b[1] - e.a[1]];
        else if (samePt(e.a, a)) t = [e.a[0] - e.b[0], e.a[1] - e.b[1]];
      } else if (e.kind === "arc") {
        const k = arcFrom3(e.a, e.m, e.b);
        if (!k) continue;
        const end = samePt(e.b, a) ? e.b : samePt(e.a, a) ? e.a : null;
        if (!end) continue;
        // Tangent at that end, pointing out of the arc.
        const r: Vec2 = [end[0] - k.c[0], end[1] - k.c[1]];
        // (Pointing away from the arc's own middle.)
        let tt: Vec2 = [-r[1], r[0]];
        if ((e.m[0] - end[0]) * tt[0] + (e.m[1] - end[1]) * tt[1] > 0) tt = [-tt[0], -tt[1]];
        t = tt;
      }
      if (t) break;
    }
    if (!t) return bow;
    const tl = Math.hypot(...t);
    if (tl < 1e-12) return bow;
    const u: Vec2 = [t[0] / tl, t[1] / tl];
    // Circle through a and b, tangent to u at a: its centre is on the normal at a.
    const n: Vec2 = [-u[1], u[0]];
    const nc = n[0] * c[0] + n[1] * c[1];
    if (Math.abs(nc) < 1e-9 * L) return bow; // straight on: no arc does that
    const rad = (L * L) / (2 * nc);
    const ctr: Vec2 = [a[0] + n[0] * rad, a[1] + n[1] * rad];
    const R = Math.abs(rad);
    const mid: Vec2 = [(a[0] + b[0]) / 2 - ctr[0], (a[1] + b[1]) / 2 - ctr[1]];
    const ml = Math.hypot(...mid);
    // Going on along u first: the short way round if u leans towards b, else the long way.
    const sign = u[0] * c[0] + u[1] * c[1] >= 0 ? 1 : -1;
    if (ml < 1e-9 * L) return [ctr[0] + u[0] * R, ctr[1] + u[1] * R];
    return [ctr[0] + (sign * mid[0] * R) / ml, ctr[1] + (sign * mid[1] * R) / ml];
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
        if (memory.arc === "center") return centreArc(id, a, b, c, this.locks.a1 !== undefined);
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
        if (!b) return null;
        if (memory.circle === "3pt") {
          // Two points so far: the chord; the third puts the circle through all three.
          if (!c) return Math.hypot(b[0] - a[0], b[1] - a[1]) > 1e-9 ? { id, kind: "line", a, b } : null;
          const k = arcFrom3(a, b, c);
          return k ? { id, kind: "circle", center: k.c, radius: k.r } : null;
        }
        if (memory.circle === "2pt") {
          const r = Math.hypot(b[0] - a[0], b[1] - a[1]) / 2;
          return r > 1e-9 ? { id, kind: "circle", center: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], radius: r } : null;
        }
        const r = Math.hypot(b[0] - a[0], b[1] - a[1]);
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
        return pts.length >= 2 ? { id, kind: "spline", points: pts, closed: false, mode: splineMode() } : null;
    }
    return null;
  }

  /**
   * Undo / Redo while drawing: the shape under way stops - a line chain went
   * on from the point of the line just undone (and was tied to that line).
   */
  stopDrawing(): void {
    if (this.pts.length) this.resetDrawing();
  }

  /**
   * Undo while points are being placed that aren't in the drawing yet (a
   * spline, an arc's ends): the last point goes. True when that was the undo.
   */
  undoPoint(): boolean {
    if (!this.pts.length || this.kind === "line") return false;
    this.pts.pop();
    if (!this.pts.length) this.resetDrawing();
    this.updatePanel();
    this.refreshPreview();
    return true;
  }

  private resetDrawing(): void {
    this.pts = [];
    this.arcM = null;
    this.arcBend = null;
    this.locks = {};
    this.lastLineId = null;
    this.chainFirstId = null;
    this.startRef = null;
    this.startSnap = null;
    this.firstSnap = null;
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
  /** The pattern direction typed (kept while the spacing is 0). */
  private patDirDeg: number | null = null;

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
    this.updateLiveValues(c);
    // A length box on the first side of a 3-point shape (or an arc's radius) stays up.
    let keepLineDim = false;
    if (["line", "arc", "rect", "circle", "polygon", "ellipse", "spline"].includes(this.kind) && this.pts.length && c) {
      const pts = this.kind === "line" ? [this.pts[this.pts.length - 1], c] : [...this.pts, c];
      const e = this.buildShape(pts);
      const yellow = 0xffc23d;
      // Arc by its centre: the centre shows from the first tap on.
      if (this.kind === "arc" && memory.arc === "center") this.drawCentreMark(this.pts[0]);
      // Arc, both ends placed and nothing to aim with (touch, or being bent): the bend so far.
      if (this.kind === "arc" && this.pts.length === 2 && this.arcM && (isCoarse || this.arcBend)) {
        const [a, b] = this.pts;
        if (arcFrom3(a, this.arcM, b)) ghosts.push({ id: "arc-preview", kind: "arc", a, m: this.arcM, b });
      } else if (this.kind === "arc" && memory.arc === "3pt" && this.pts.length === 1 && e?.kind === "line") {
        // Arc, first end placed: a dashed arc to the pointer shows what's coming (the bend comes with the third tap).
        const [a, b] = [e.a, e.b];
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (L > 1e-9) {
          const m: Vec2 = [(a[0] + b[0]) / 2 - ((b[1] - a[1]) / L) * L * 0.3, (a[1] + b[1]) / 2 + ((b[0] - a[0]) / L) * L * 0.3];
          this.drawGhosts([{ id: "arc-preview", kind: "arc", a, m, b }], yellow, true);
        }
        // Its chord's length can be typed in the box (or in the card), like a line's.
        this.showLineDim(a, b);
        keepLineDim = true;
      } else if (this.kind === "arc" && memory.arc === "center" && this.pts.length === 1 && e?.kind === "line") {
        // Centre placed: the circle the arc will lie on, dashed, and its radius (typed in the box).
        const r = Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]);
        if (r > 1e-9) this.drawGhosts([{ id: "arc-circle", kind: "circle", center: e.a, radius: r }], yellow, true);
        this.showLineDim(e.a, e.b);
        keepLineDim = true;
      } else if (e?.kind === "line" && this.pts.length === 1 && ((this.kind === "rect" && memory.rect === "3pt") || (this.kind === "circle" && memory.circle === "3pt"))) {
        // 3-point rectangle / circle, first point placed: a dashed guide to the
        // second (the side, or the chord - with the circle on it as a diameter).
        const ghosts: SketchEntity[] = [{ ...e, id: "first-side" }];
        const r = Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]) / 2;
        if (this.kind === "circle" && r > 1e-9) ghosts.push({ id: "chord-circle", kind: "circle", center: [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2], radius: r });
        this.drawGhosts(ghosts, yellow, true);
        this.showLineDim(e.a, e.b);
        keepLineDim = true;
      } else if (e?.kind === "line" && this.kind === "line" && phoneScreen() && !this.dragging && this.pts.length >= 1) {
        // Touch, a line just placed and its length being typed: no next segment
        // trailing to where the finger was (it only gets in the way) - the next tap places it.
        this.hideLineDim();
      } else if (e?.kind === "line") this.showLineDim(e.a, e.b);
      else {
        if (e) ghosts.push(e);
        label = dimLabel(e, pts);
      }
    }
    if (!keepLineDim && !(this.kind === "line" && this.pts.length && c)) this.hideLineDim();
    if (this.kind === "text" && this.pts.length) {
      void textEntities(this.text || " ", this.pts[0], memory.textSize, 0, memory.textFont, memory.textAlign).then((es) => {
        if (this.kind !== "text" || !this.pts.length) return;
        this.drawGhosts(es);
      });
    }
    if (this.kind === "offset" && this.edit.offsetOf) ghosts.push(...this.offsetResult());
    if (this.isSelectionTool() && this.selected.size) ghosts.push(...this.transformed(true));
    // Rotate About: the point it turns around, and the path the selection's centre takes round it.
    if ((this.kind === "rotate" || this.kind === "patternCircular") && this.edit.pivot && this.selected.size) {
      const pv = this.edit.pivot;
      this.drawCentreMark(pv);
      const c = centroidOf(this.entities.filter((e) => this.selected.has(e.id)));
      const r = Math.hypot(c[0] - pv[0], c[1] - pv[1]);
      const sweep = ((this.kind === "rotate" ? this.edit.angle : this.edit.patAngle) * Math.PI) / 180;
      if (r > 1e-9 && Math.abs(sweep) > 1e-9) {
        const a0 = Math.atan2(c[1] - pv[1], c[0] - pv[0]);
        const at = (t: number): Vec2 => [pv[0] + r * Math.cos(a0 + sweep * t), pv[1] + r * Math.sin(a0 + sweep * t)];
        const n = Math.max(8, Math.ceil(Math.abs(sweep) / 0.1));
        this.drawGhosts([
          { id: "rot-radius", kind: "line", a: pv, b: c },
          { id: "rot-path", kind: "polyline", points: Array.from({ length: n + 1 }, (_, i) => at(i / n)), closed: false },
        ], 0x9fb4d6, true);
      }
    }
    this.drawGhosts(ghosts);
    // Mirror: the axis (picked, or the line under the pointer) with a mirror mark on it.
    if (this.kind === "mirror" && this.selected.size) {
      let axis = this.edit.mirrorLine ?? null;
      if (!axis && p) {
        const c = this.curveAt(p);
        const e = c && [...this.entities, ...this.boundary].find((x) => x.id === c.id);
        if (e?.kind === "line") {
          axis = [e.a, e.b];
          // What it would make, mirrored over that line.
          this.drawGhosts(this.entities.filter((y) => this.selected.has(y.id)).map((x: SketchEntity) => transformEntity(x, mirrorXf(e.a, e.b), false)));
        }
      }
      if (axis) this.drawMirrorAxis(axis);
    }
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

  /** Size fields of the card (by number-field index): which lock each one shows, or null. */
  private liveKeys: (string | null)[] = [];
  /** Phones: the drawing tool's values card opened from its small Values chip (closed again when the shape is done). */
  private valuesOpen = false;

  /** The size a lock key stands for, with the next point at `c` (what the card shows before it's typed). */
  private liveValue(key: string, c: Vec2 | null): number | undefined {
    const a = this.pts[0];
    if (!a || !c) return undefined;
    const last = this.pts[this.pts.length - 1];
    const deg = (x: number) => Math.round(((x * 180) / Math.PI) * 1e4) / 1e4;
    // Not moved off the point just placed (a finger lifted there): the shape as it starts (an ellipse half as wide as long).
    const still = this.pts.length > 1 && Math.hypot(c[0] - last[0], c[1] - last[1]) < 1e-12;
    const e = this.buildShape(still ? this.pts : [...this.pts, c]);
    switch (key) {
      case "len":
        return Math.hypot(c[0] - last[0], c[1] - last[1]);
      case "ang":
        return deg(Math.atan2(c[1] - last[1], c[0] - last[0]));
      case "dx":
        return c[0] - last[0];
      case "dy":
        return c[1] - last[1];
      case "w":
        return e?.kind === "rect" ? e.w : undefined;
      case "h":
        return e?.kind === "rect" ? e.h : undefined;
      case "r":
        if (this.kind === "circle") return memory.circle === "2pt" ? Math.hypot(c[0] - a[0], c[1] - a[1]) : 2 * Math.hypot(c[0] - a[0], c[1] - a[1]);
        if (this.kind === "arc" && memory.arc !== "center") return e?.kind === "arc" ? arcFrom3(e.a, e.m, e.b)?.r : undefined;
        return Math.hypot(c[0] - a[0], c[1] - a[1]);
      case "a0":
      case "a1": {
        const t = deg(Math.atan2(c[1] - a[1], c[0] - a[0]));
        return t < 0 ? t + 360 : t;
      }
      case "rx":
        return 2 * Math.hypot(c[0] - a[0], c[1] - a[1]);
      case "ry":
        return e?.kind === "ellipse" ? 2 * e.ry : undefined;
    }
    return undefined;
  }

  /** The card's size fields, as the pointer moves: what each would be (a typed one stays). */
  private updateLiveValues(c: Vec2 | null): void {
    if (!this.liveKeys.some((k) => k)) return;
    this.app.ui.updatePanelValues(this.liveKeys.map((k) => (k ? (this.locks[k] ?? this.liveValue(k, c)) : undefined)) as number[]);
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
    // The next line is under way: only its length shows - the box of the line
    // before goes (unless something was typed into it).
    if (this.lineBox && !this.lineBox.edited) this.closeLineBox();
    const w = (q: Vec2) => sketchToWorld(plane, q, 0.02).toArray() as Vec3;
    this.lineDim ??= new DimWidget(this.app.view, {
      solidColor: 0xffc23d,
      boxAt: "side",
      value: len,
      onInput: (v, text) => {
        if (v <= 0) return;
        this.locks.len = v;
        this.lenExpr = isExpression(text) ? { v, text: text.trim() } : null;
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

  /** The mirror axis: a long dash-dot line, and a pair of arrowheads facing it at the middle. */
  private drawMirrorAxis([a, b]: [Vec2, Vec2]): void {
    const d: Vec2 = [b[0] - a[0], b[1] - a[1]];
    const L = Math.hypot(...d);
    if (L < 1e-12) return;
    const u: Vec2 = [d[0] / L, d[1] / L];
    const n: Vec2 = [-u[1], u[0]];
    const wpp = this.app.view.cam.worldPerPixel(this.app.view.height);
    const ext = Math.max(L * 0.25, wpp * 40);
    const m: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const s = wpp * 14;
    const P = (x: number, y: number): Vec2 => [m[0] + u[0] * x + n[0] * y, m[1] + u[1] * x + n[1] * y];
    const COLOR = 0xc77dff;
    this.drawGhosts([{ id: "mirror-axis", kind: "line", a: [a[0] - u[0] * ext, a[1] - u[1] * ext], b: [b[0] + u[0] * ext, b[1] + u[1] * ext] }], COLOR, true);
    // ▶|◀ : two triangles pointing at the axis from either side.
    this.drawGhosts(
      [
        { id: "mirror-l", kind: "polyline", closed: true, points: [P(-s * 0.6, s * 1.6), P(s * 0.6, s * 1.6), P(0, s * 0.35)] },
        { id: "mirror-r", kind: "polyline", closed: true, points: [P(-s * 0.6, -s * 1.6), P(s * 0.6, -s * 1.6), P(0, -s * 0.35)] },
      ],
      COLOR,
    );
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

  /** A point marker (an arc's centre while it's drawn). */
  private drawCentreMark(q: Vec2): void {
    const m = new Points(new BufferGeometry().setFromPoints([sketchToWorld(this.plane!, q, 0.02)]), dotMaterial({ color: 0xffc23d, size: 9 }));
    m.renderOrder = 10;
    this.addOverlay(m);
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

  /** An edit that changed curves: their constraints follow (or go, where they no longer hold). */
  private commitEdit(entities: SketchEntity[]): void {
    this.commit(entities, carryConstraints(this.entities, entities, this.constraints));
  }

  private commit(entities: SketchEntity[], constraints: SketchConstraint[] = this.constraints, follow: EdgeLink[] = []): void {
    // The shapes change: a picked region's arrow would point at the old one.
    this.hideRegionArrow();
    const store = this.app.store;
    // Curves that follow a body's edge: one moved, cut or copied here is a
    // curve of the sketch like any other from now on (it would jump back to the edge).
    const follows = new Map([...(this.sketch?.links ?? []), ...follow].map((l) => [l.id, l]));
    if (follows.size || entities.some((e) => e.id.startsWith(LINKED))) {
      const was = new Map(this.entities.map((e) => [e.id, e]));
      const plain = (e: SketchEntity) => JSON.stringify({ ...e, construction: undefined });
      const seen = new Set<string>();
      const renamed = new Map<string, string>();
      let freed = 0;
      entities = entities.map((e) => {
        if (!e.id.startsWith(LINKED)) return e;
        const old = was.get(e.id);
        if (follows.has(e.id) && !seen.has(e.id) && (!old || old === e || plain(old) === plain(e))) {
          seen.add(e.id);
          return e;
        }
        const id = uid();
        if (!seen.has(e.id) && !renamed.has(e.id)) renamed.set(e.id, id);
        if (old && follows.has(e.id)) freed++;
        return { ...e, id };
      });
      if (renamed.size) {
        const re = (id: string) => (seen.has(id) ? id : (renamed.get(id) ?? id));
        constraints = constraints.map((c) => ({ ...c, ...(c.pts ? { pts: c.pts.map((p) => ({ ...p, e: re(p.e) })) } : {}), ...(c.curves ? { curves: c.curves.map(re) } : {}) }));
        this.selected = new Set([...this.selected].map(re));
      }
      if (freed) this.app.ui.toast("Changed here, it no longer follows the body's edge");
    }
    const links = [...follows.values()].filter((l) => entities.some((e) => e.id === l.id));
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
    const patch = { entities, constraints: cs.length ? cs : undefined, log, links: links.length ? links : undefined };
    if (this.sketchId && this.sketch) {
      store.update(this.sketchId, patch);
    } else {
      const f: SketchFeature = { ...(this.pending ?? store.newIdentity("sketch")), type: "sketch", plane: this.plane!, attachedTo: this.attachedTo, ...patch };
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
    const es = await textEntities(this.text, this.pts[0], memory.textSize, 0, memory.textFont, memory.textAlign);
    this.commitAdd(es);
    this.resetDrawing();
  }

  // --------------------------------------------------------- edit tools

  private isSelectionTool(): boolean {
    return ["move", "scale", "patternLinear", "patternCircular", "rotate", "mirror"].includes(this.kind);
  }

  /** The edge of the face this sketch is on, under the pointer (it's drawn by the body, not the sketch). */
  private outlineAt(p: ToolPointer): { e: SketchEntity; uv: Vec2; d: number } | null {
    const uv = this.uvAt(p);
    if (!uv) return null;
    const tol = this.app.view.cam.worldPerPixel(this.app.view.height) * Math.max(8, p.tol);
    let best: { e: SketchEntity; d: number } | null = null;
    for (const e of this.outline) {
      const d = Math.min(...entityPrims(e).map((pr) => closestOnPrim(pr, uv).d));
      if (d < tol && (!best || d < best.d)) best = { e, d };
    }
    return best ? { e: best.e, uv, d: best.d } : null;

  }

  private curveAt(p: ToolPointer): { id: string; uv: Vec2 } | null {

    const hit = this.app.view.pick(p.x, p.y, { curves: this.sketchId ?? true, profiles: false, bodies: false, planes: false, axes: false, edgeTolPx: p.tol });
    // A point (end, centre…) stands for its curve here - small shapes are mostly points when zoomed out.
    if ((hit?.kind !== "curve" && hit?.kind !== "point") || hit.sketch !== this.sketchId) return null;
    const w = this.app.view.rayToPlane(p.x, p.y, this.plane!);
    return { id: hit.entity, uv: w ? toPlane(this.plane!, w) : [0, 0] };
  }

  /**
   * Extend in two taps: the half of the first curve, then the half of the
   * second - both picked ends run along their own line/circle until they meet.
   */
  /** Align's first pick, as a line: the line, or the side of a shape that was tapped. */
  private alignEdge: Extract<SketchEntity, { kind: "line" }> | null = null;

  private tapAlign(id: string, uv: Vec2): void {
    const all = [...this.entities, ...this.boundary];
    const e = all.find((x) => x.id === id);
    // A line, or the side of a rectangle / polygon / outline that was tapped.
    const side = sideNear(e, uv);
    if (!side) return this.app.ui.toast("Align works on lines and the sides of shapes");
    const first = this.edit.alignFrom;
    if (!first) {
      if (id.startsWith("bnd-")) return this.app.ui.toast("Pick a line of this sketch to move (face edges stay)");
      this.edit.alignFrom = id;
      this.alignEdge = side;
      // A shape (not a lone line): it moves as a whole - with the rest of the selection it's part of.
      if (e?.kind !== "line") this.selected.add(id);
      else if (!this.selected.has(id)) this.selected.clear();
      this.showSelection();
      this.app.setSelection([{ kind: "curve", sketch: this.sketchId ?? "", entity: id }]);
      return this.setHint("Now tap the line to align it with (the first one moves).");
    }
    const edge = this.alignEdge ?? (all.find((x) => x.id === first) as Extract<SketchEntity, { kind: "line" }> | undefined);
    this.edit.alignFrom = undefined;
    this.alignEdge = null;
    this.app.setSelection([]);
    this.setHint();
    if (first === id || !edge || edge.kind !== "line") return;
    // A whole shape (several curves selected, or a rectangle / polygon): it moves as one.
    const shape = (this.selected.size > 1 && this.selected.has(first)) || all.find((x) => x.id === first)?.kind !== "line" ? new Set([...this.selected, first]) : null;
    this.selected.clear();
    this.showSelection();
    const res = shape ? alignShape(this.entities, this.constraints, shape, edge, side) : alignOne(this.entities, this.constraints, first, side);
    if (!res) return this.app.ui.toast("Those lines can't be aligned");
    this.commit(res.entities, res.constraints);
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
      this.setHint("Now tap the line it should reach (or the same line again to reach the next one).");
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
      if (next) this.commitEdit(this.withoutBoundary(next));
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
    const ents = this.withoutBoundary(next);
    this.commit(ents, carryConstraints(this.entities, ents, keep));
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
    // Curves split where the grid crosses them (nearest the tap); lines and the
    // sides of shapes in half (Shift: right where tapped).
    const view = this.app.view;
    const step = settings.value.gridLocked ? settings.value.gridStep : niceStepOf(view.cam.worldPerPixel(view.height) * 4);
    const out = splitAny(this.entities, id, uv, step, atTap, uid);
    if (!out) return this.app.ui.toast("Tap a curve to split it");
    const second = out.parts[out.parts.length - 1];
    const cs = this.constraints.flatMap((c): SketchConstraint[] => {
      // A shape taken apart (or a curve turned into another kind): its old sizes and point refs no longer fit.
      if (out.exploded && (c.curves?.includes(id) || c.pts?.some((r) => r.e === id))) return [];
      // A length dimension no longer fits half a line.
      if (c.type === "dim" && c.curves?.[0] === id && c.prop === "length") return [];
      // The far end now belongs to the second piece.
      const pts = c.pts?.map((r) => (r.e === id && r.p === "b" && second !== id ? { e: second, p: "b" } : r));
      return [{ ...c, ...(pts ? { pts } : {}) }];
    });
    // The pieces stay joined end to end.
    const made = out.entities.filter((e) => out.parts.includes(e.id));
    for (const x of made)
      for (const y of made) {
        if (x === y || !(x.kind === "line" || x.kind === "arc") || !(y.kind === "line" || y.kind === "arc")) continue;
        if (samePt(x.b, y.a)) cs.push({ id: uid(), type: "coincident", pts: [{ e: x.id, p: "b" }, { e: y.id, p: "a" }] });
      }
    this.commit(out.entities, cs);
  }

  private tapSelect(p: ToolPointer, count = 1): void {
    if (this.selConstraint) this.deselectConstraint();
    // Points can be picked in the Select tool (for constraints and dragging) - but a
    // double tap is always "the whole shape", even when it lands near a corner.
    if (this.kind === "select" && count < 2) {
      const hit = this.app.view.pick(p.x, p.y, { curves: this.sketchId ?? true, profiles: false, bodies: false, planes: false, axes: false, images: false, edgeTolPx: p.tol });
      // A finger lands roughly: a point near the end of a line only counts when
      // the tap is right on it (else it's the line - picking two lines to set
      // their angle shouldn't turn into picking their shared corner).
      const onPoint = (() => {
        if (hit?.kind !== "point") return false;
        const e = this.entities.find((x) => x.id === hit.entity);
        const q = e && pointOf(e, hit.p);
        const sc = q && this.app.view.toScreen(sketchToWorld(this.plane!, q));
        return !sc || Math.hypot(sc[0] - p.x, sc[1] - p.y) < Math.max(10, p.tol * 0.7) || !this.curveAt(p);
      })();
      if (hit?.kind === "point" && hit.sketch === this.sketchId && onPoint) {
        const r = { e: hit.entity, p: hit.p };
        const i = this.selPts.findIndex((x) => refKey(x) === refKey(r));
        if (i >= 0) this.selPts.splice(i, 1);
        else (this.selPts.push(r), this.pickSeq.set(refKey(r), ++this.seq));
        return this.selectionChanged();
      }
    }
    // Inside a closed shape and not right on its outline (a finger's reach is
    // wide - half of it): the shape itself, with its extrude arrow.
    if (this.kind === "select" && count < 2 && !p.shift && !this.curveAt({ ...p, tol: p.tol * 0.5 }) && this.tapRegion(p)) return;
    const c = this.curveAt(p);
    // Mirror: with something selected, the next line tapped (even one of the
    // selection) is the mirror axis - Shift+tap adds to the selection instead.
    // (Anything else tapped joins the selection: on a phone, with no Shift, a
    // second circle to mirror was refused as "not a straight line".)
    const tappedLine = c && [...this.entities, ...this.boundary].find((x) => x.id === c.id && x.kind === "line");
    if (c && this.kind === "mirror" && this.selected.size && !p.shift && count < 2 && tappedLine?.kind === "line" && !this.selected.has(c.id)) {
      this.edit.mirrorLine = [tappedLine.a, tappedLine.b];
      return this.applyTransform();
    }
    // …or an axis (the upright one through the origin, for a shape drawn on one
    // side): it used to clear the selection.
    if (!c && this.kind === "mirror" && this.selected.size && !p.shift) {
      const line = this.axisLineAt(p);
      if (line) {
        this.edit.mirrorLine = line;
        return this.applyTransform();
      }
    }
    // Double tap (or Mirror's first tap): the whole shape the curve belongs to (joined end to end).
    if (c && (count >= 2 || (this.kind === "mirror" && !this.selected.size && !p.shift))) {
      const chain = connectedChain(this.entities, c.id);
      for (const l of chain?.links ?? [{ id: c.id }]) if (!this.selected.has(l.id)) (this.selected.add(l.id), this.pickSeq.set(l.id, ++this.seq));
      return this.selectionChanged();
    }
    if (!c) {
      // Inside a closed shape (Select tool): the shape is picked and its extrude
      // arrow shows - the sketch stays open; only dragging the arrow extrudes.
      if (this.kind === "select" && count < 2 && this.tapRegion(p)) return;
      // Empty space: deselect; with nothing selected, an editing tool goes back to Select.
      if (this.regionArrow) this.hideRegionArrow();
      if (this.selected.size || this.selPts.length) this.clearSelection();
      else if (this.kind !== "select") this.setKind("select");
      return;
    }
    if (this.selected.has(c.id)) this.selected.delete(c.id);
    else (this.selected.add(c.id), this.pickSeq.set(c.id, ++this.seq));
    this.selectionChanged();
  }

  /** A tapped closed shape of this sketch: its profile, and the arrow that extrudes it. */
  private regionArrow: { sel: Sel[]; handle: Handle } | null = null;

  /** Tap inside a closed shape: pick it (again: let it go) and show its extrude arrow. */
  private tapRegion(p: ToolPointer): boolean {
    if (!this.sketchId) return false;
    const hit = this.app.view.pick(p.x, p.y, { curves: false, profiles: true, bodies: false, planes: false, axes: false, images: false, edges: false, vertices: false, edgeTolPx: 0 });
    if (hit?.kind !== "profile" || hit.sketch !== this.sketchId) return false;
    const s = hitToSel(hit);
    if (!s || s.kind !== "profile") return false;
    const same = this.regionArrow?.sel.some((x) => x.kind === "profile" && x.region === s.region);
    if (this.selected.size || this.selPts.length) this.clearSelection();
    if (same) {
      this.hideRegionArrow();
      return true;
    }
    this.showRegionArrow([s]);
    return true;
  }

  private showRegionArrow(sel: Sel[]): void {
    const src = sourcesOf(this.app, sel)[0];
    if (!src) return this.hideRegionArrow();
    const fr = sourceFrame(this.app, src);
    const handle = this.regionArrow?.handle ?? new Handle(this.app.view, "arrow");
    handle.set(fr.base, fr.normal);
    this.regionArrow = { sel, handle };
    this.app.setSelection(sel);
    this.setHint("Drag the arrow to pull the shape into 3D.");
  }

  private hideRegionArrow(): void {
    if (!this.regionArrow) return;
    this.regionArrow.handle.dispose();
    this.regionArrow = null;
    this.app.setSelection([]);
    this.setHint();
  }

  /** The arrow dragged: Extrude takes over (at 0, following this drag). */
  private extrudeFromArrow(p: ToolPointer): boolean {
    const sel = this.regionArrow!.sel;
    const src = sourcesOf(this.app, sel)[0];
    this.hideRegionArrow();
    if (!src) return false;
    const op = new ExtrudeOp(this.app, src, undefined, "auto", { distance: 0 });
    this.app.setTool(op);
    this.app.setSelection(sel);
    return op.down(p);
  }

  /** The spacing a linear pattern was given on its own (null once typed / dragged). */
  private patAuto: number | null = null;

  /** Spacing = the selection's size along the pattern's direction, plus a fifth (copies don't overlap it). */
  private autoPatternSpacing(): void {
    const L = Math.hypot(this.edit.dx, this.edit.dy);
    const dir: Vec2 = L > 1e-12 ? [this.edit.dx / L, this.edit.dy / L] : [Math.cos(this.patAng), Math.sin(this.patAng)];
    let lo = Infinity;
    let hi = -Infinity;
    for (const e of this.entities)
      if (this.selected.has(e.id))
        for (const poly of entityPolylines(e))
          for (const q of poly) {
            const t = q[0] * dir[0] + q[1] * dir[1];
            lo = Math.min(lo, t);
            hi = Math.max(hi, t);
          }
    const s = patternSpacing(hi > lo ? hi - lo : 0, L > 1e-12 ? L : 10);
    this.edit.dx = dir[0] * s;
    this.edit.dy = dir[1] * s;
    this.patAuto = s;
  }

  /** Rotate About / Circular Pattern with curves picked and no centre yet: the next tap is the centre. */
  private get wantsCentre(): boolean {
    return (this.kind === "rotate" || this.kind === "patternCircular") && this.selected.size > 0 && !this.edit.pivot;
  }

  private selectionChanged(): void {
    // A pattern's spacing that wasn't set by hand follows what's selected.
    if (this.kind === "patternLinear" && this.patAuto !== null && Math.abs(Math.hypot(this.edit.dx, this.edit.dy) - this.patAuto) < 1e-9) this.autoPatternSpacing();
    if (this.regionArrow && (this.selected.size || this.selPts.length)) this.hideRegionArrow();
    this.updateMenu();
    this.refreshDistanceDim();
    this.showSelection();
    this.updatePanel();
    this.refreshPreview();
    this.refreshConstraintUI();
    if (this.wantsCentre) this.setHint(CENTRE_HINT[this.kind as "rotate" | "patternCircular"]);
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

  /** A world / construction axis under the pointer, lying along the sketch plane, as a line in it. */
  private axisLineAt(p: ToolPointer): [Vec2, Vec2] | null {
    // X/Y on the ground, Z on an upright sketch, …
    // Axes only: a model edge along the same line (a revolved casing's seam,
    // under a flange's centre line) was caught instead.
    const hit = this.app.view.pick(p.x, p.y, { curves: false, profiles: false, bodies: false, edges: false, vertices: false, images: false, planes: false, axes: true, worldAxes: true, edgeTolPx: p.tol });
    const ax = hit?.kind === "axis" ? this.app.view.axisOf(hit.id) : undefined;
    const plane = this.plane!;
    if (!ax || Math.abs(dot(ax.plane.normal, plane.normal)) > 1e-6) return null;
    const o = ax.plane.origin;
    const d = ax.plane.normal;
    return [toPlane(plane, o), toPlane(plane, [o[0] + d[0], o[1] + d[1], o[2] + d[2]])];
  }

  /** Scale by reference: the distance between the two points as they are now (0: not both picked). */
  private refDistance(): number {
    const { refA: a, refB: b } = this.edit;
    return a && b ? Math.hypot(b[0] - a[0], b[1] - a[1]) : 0;
  }

  /** Scale by reference: the distance typed - the factor that makes it so. */
  private setRefDistance(v: number): void {
    const d0 = this.refDistance();
    if (!d0 || !(v > 0)) return;
    this.edit.factor = v / d0;
    this.refreshPreview();
    this.refreshRefDim();
    if (this.refIndex) {
      const vals: number[] = [];
      vals[this.refIndex.factor] = this.edit.factor;
      if (this.refIndex.distance >= 0) vals[this.refIndex.distance] = v;
      this.app.ui.updatePanelValues(vals);
    }
  }

  private refIndex: { factor: number; distance: number } | null = null;
  private refDim: DimWidget | null = null;

  /** Scale by reference: the dimension between the two points (where the second ends up), its value box ready to type into. */
  private refreshRefDim(): void {
    const { refA: a, refB: b } = this.edit;
    const d0 = this.refDistance();
    if (this.kind !== "scale" || this.phase !== "draw" || !a || !b || d0 < 1e-12) {
      this.refDim?.dispose();
      this.refDim = null;
      return;
    }
    const k = this.edit.factor;
    this.refDim ??= new DimWidget(this.app.view, {
      value: d0 * k,
      focus: true,
      onInput: (v) => this.setRefDistance(v),
      onCommit: () => this.applyTransform(),
    });
    const w = (q: Vec2) => sketchToWorld(this.plane!, q, 0.02).toArray() as Vec3;
    this.refDim.set(w(a), w([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k]));
  }

  private pickForEdit(p: ToolPointer): void {
    if (this.edit.picking === "refA" || this.edit.picking === "refB") {
      const s = this.snap(p);
      if (!s) return;
      if (this.edit.picking === "refA") {
        this.edit.refA = s.uv;
        this.edit.refB = undefined;
        // Nothing selected: the whole sketch scales.
        if (!this.selected.size) {
          this.selected = new Set(this.entities.map((e) => e.id));
          this.showSelection();
        }
        this.edit.picking = "refB";
        this.setHint("Tap the second point, then type how far apart they should be.");
      } else {
        if (this.edit.refA && Math.hypot(s.uv[0] - this.edit.refA[0], s.uv[1] - this.edit.refA[1]) < 1e-9) return this.app.ui.toast("Tap a point away from the first one");
        this.edit.refB = s.uv;
        this.edit.factor = 1;
        this.edit.picking = undefined;
        this.setHint("Type how far apart the two points should be, then Enter.");
      }
      this.updatePanel();
      this.refreshPreview();
      return;
    }
    if (this.edit.picking === "pivot") {
      const s = this.snap(p);
      if (s) this.edit.pivot = s.uv;
    } else if (this.edit.picking === "mirror") {
      const c = this.curveAt(p);
      const e = c && this.entities.find((x) => x.id === c.id);
      if (e?.kind === "line") this.edit.mirrorLine = [e.a, e.b];
      else {
        const line = this.axisLineAt(p);
        if (!line) return this.app.ui.toast("Pick a straight line or an axis in the sketch plane");
        this.edit.mirrorLine = line;
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
        // By reference: about the point that stays put.
        const c = this.edit.refA && this.edit.refB ? this.edit.refA : centroidOf(sel);
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
    // Mirroring across one of the shape's own edges: that edge maps onto itself - don't double it.
    const ml = this.edit.mirrorLine;
    if (this.kind === "mirror" && ml) {
      const d: Vec2 = [ml[1][0] - ml[0][0], ml[1][1] - ml[0][1]];
      const L = Math.hypot(...d) || 1;
      const onAxis = (q: Vec2) => Math.abs((q[0] - ml[0][0]) * d[1] - (q[1] - ml[0][1]) * d[0]) / L < 1e-7 * Math.max(1, L);
      results = results.filter((e) => !(e.kind === "line" && onAxis(e.a) && onAxis(e.b)));
    }
    const keepOriginals = this.kind === "patternLinear" || this.kind === "patternCircular" || ((this.kind === "mirror" ? this.edit.mirrorCopy : this.edit.copy));
    const base = keepOriginals ? this.entities : this.entities.filter((e) => !this.selected.has(e.id));
    // Moved (not copied): ties between what moves and what stays let go, and
    // so do pins holding the moved curves in place - an arch's circle snapped
    // to its window's corner dragged the window along when moved to the middle.
    let cons = this.constraints;
    if (!keepOriginals) {
      const moved = new Set(results.map((e) => e.id));
      cons = cons.filter((c) => {
        const ids = [...(c.curves ?? []), ...(c.pts ?? []).map((q) => q.e)];
        const inMoved = ids.some((i) => moved.has(i));
        if (c.type === "fix") return !inMoved;
        return !(inMoved && ids.some((i) => !moved.has(i)));
      });
    }
    // Scaled: the sizes held by dimensions scale with it (angles stay) - or
    // the dimensions would pull the curves back to their old size.
    if (this.kind === "scale") {
      const k = this.edit.factor;
      const out = new Set(results.map((e) => e.id));
      const sel = this.entities.filter((e) => this.selected.has(e.id));
      const xf = scaleXf(this.edit.refA && this.edit.refB ? this.edit.refA : centroidOf(sel), k);
      const ids = (x: SketchConstraint) => [...(x.curves ?? []), ...(x.pts ?? []).map((q) => q.e)];
      // (Copies have new ids: the constraints stay with the originals.)
      if (!keepOriginals)
        cons = cons.map((x) => {
          const on = ids(x);
          if (!on.length || !on.every((i) => out.has(i))) return x;
          if ((x.type === "dim" && x.prop !== "angle") || x.type === "distance") return { ...x, value: (x.value ?? 0) * k, expr: undefined };
          if (x.type === "fix" && x.at) return { ...x, at: xf(x.at) };
          return x;
        });
      // By reference: done with the points, and the factor they gave isn't kept for the next scale.
      if (this.edit.refA) this.edit.factor = 1;
      this.edit.refA = this.edit.refB = undefined;
      if (this.edit.picking === "refA" || this.edit.picking === "refB") this.edit.picking = undefined;
    }
    this.commit([...base, ...results], cons);
    if (this.kind === "scale") {
      this.refreshRefDim();
      this.updatePanel();
    }
    if (!keepOriginals) {
      this.selected = new Set(results.map((e) => e.id));
      this.showSelection();
    }
    this.refreshPreview();
  }

  /** New curves the offset would add (one curve, or the whole chain in Chain mode). */
  private offsetResult(): SketchEntity[] {
    const id = this.edit.offsetOf;
    if (id?.startsWith("bnd-") && this.edit.offsetAt) return outlineOffsetCurves(this.outline, [{ id: "new", distance: memory.offset, at: this.edit.offsetAt }]);
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
    // Of the face's outline: kept as a link to it, not as curves of their own.
    if (this.edit.offsetOf?.startsWith("bnd-") && this.edit.offsetAt) {
      const link = { id: uid(), distance: memory.offset, at: this.edit.offsetAt };
      // (Nothing drawn on it yet: the sketch is made with the offset in it - one step.)
      if (!this.sketchId) {
        const f: SketchFeature = { ...(this.pending ?? this.app.store.newIdentity("sketch")), type: "sketch", plane: this.plane!, attachedTo: this.attachedTo, entities: [], constraints: [], outlineOffsets: [link] };
        this.app.store.add(f);
        this.sketchId = f.id;
      } else {
        const sid = this.sketchId;
        this.app.store.commit((d) => {
          const f = d.features.find((x) => x.id === sid);
          if (f?.type === "sketch") f.outlineOffsets = [...(f.outlineOffsets ?? []), link];
        });
      }

      this.app.ui.toast("Offset of the face's edge: it follows the face when the face changes size");
      this.edit.offsetOf = this.edit.offsetAt = undefined;
      return this.resetDrawing();
    }

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
   * Fillet / Chamfer: tap the two lines (they needn't touch; the halves tapped
   * are kept) or two sides of a rectangle / polygon. The rounded corner
   * appears at a tenth of the first line's length; type its size, Enter.
   */
  private tapFillet(p: ToolPointer): void {
    // A tap while the last one's radius is showing keeps it - and, on another
    // corner, rounds that one too (four corners took eight taps).
    const kept = !!this.filletEdit;
    if (kept) this.finishFillet();
    const base = this.entities;
    // Two lines are asked for (not the point they share): a finger on a corner
    // can't tell which corner, a line it can. The first one's length sets the
    // starting size: a tenth of it.
    const firstLen = (id: string, at: Vec2) => {
      const e = base.find((x) => x.id === id);
      const side = e && sideNear(e, at);
      return side ? Math.hypot(side.b[0] - side.a[0], side.b[1] - side.a[1]) : 0;
    };
    if (!this.edit.filletFrom) {
      // A corner tapped (where two lines meet, a rectangle's or polygon's
      // corner): rounded at once, a tenth of its shorter side.
      const corner = this.cornerAt(p);
      if (corner) {
        const tol = this.app.view.cam.worldPerPixel(this.app.view.height) * 0.5 + 1e-6;
        const make = (r: number) => (memory.corner === "chamfer" ? chamferCorner(base, corner.at, r, tol) : filletCorner(base, corner.at, r, tol));
        const r0 = corner.side > 0 ? roundSig(corner.side * 0.1) : memory.fillet;
        if (make(r0)) {
          memory.fillet = r0;
          this.updatePanel();
          return this.startFillet(make);
        }
      }
      const c = this.curveAt(p);
      // (Empty space after a fillet: it's kept, that's all.)
      if (!c) return kept ? undefined : this.tapEmpty();
      if (!sideNear(base.find((x) => x.id === c.id), c.uv)) return this.app.ui.toast("Pick a line (or a side of a rectangle / polygon)");
      this.edit.filletFrom = { id: c.id, at: c.uv };
      const L = firstLen(c.id, c.uv);
      if (L > 0) memory.fillet = roundSig(L * 0.1);
      this.updatePanel();
      this.app.setSelection([{ kind: "curve", sketch: this.sketchId ?? "", entity: c.id }]);
      return this.setHint("Now tap the other line.");
    }
    const first = this.edit.filletFrom;
    const c = this.curveAt(p);
    if (!c) return this.tapEmpty();
    this.edit.filletFrom = undefined;
    this.clearPreviewJoin();
    this.app.setSelection([]);
    // Two sides of one rectangle / polygon: the corner between them.
    if (c.id === first.id) {
      const e = base.find((x) => x.id === c.id);
      const s1 = e && sideNear(e, first.at);
      const s2 = e && sideNear(e, c.uv);
      const corner = s1 && s2 && [s1.a, s1.b].find((q) => samePt(q, s2.a) || samePt(q, s2.b));
      if (!corner || (s1 && s2 && samePt(s1.a, s2.a) && samePt(s1.b, s2.b))) return this.app.ui.toast("Tap two sides that meet at a corner");
      const tol = this.app.view.cam.worldPerPixel(this.app.view.height) * 0.5 + 1e-6;
      return this.startFillet((r) => (memory.corner === "chamfer" ? chamferCorner(base, corner, r, tol) : filletCorner(base, corner, r, tol)));
    }
    // Two lines: the ends that meet are the ones nearest where they cross
    // (not the halves tapped - any spot on a line picks it).
    const l1 = base.find((x) => x.id === first.id);
    const l2 = base.find((x) => x.id === c.id);
    let at1 = first.at;
    let at2 = c.uv;
    if (l1?.kind === "line" && l2?.kind === "line") {
      const x = lineMeet(l1, l2);
      if (x) {
        const near = (l: typeof l1): Vec2 => (Math.hypot(l.a[0] - x[0], l.a[1] - x[1]) <= Math.hypot(l.b[0] - x[0], l.b[1] - x[1]) ? l.a : l.b);
        // Just inside the line from that end, so it reads as "that end".
        const inside = (l: typeof l1): Vec2 => {
          const e = near(l);
          const o = e === l.a ? l.b : l.a;
          return [e[0] + (o[0] - e[0]) * 0.01, e[1] + (o[1] - e[1]) * 0.01];
        };
        at1 = inside(l1);
        at2 = inside(l2);
      }
    }
    this.startFillet((r) => (memory.corner === "chamfer" ? chamferEnds(base, { id: first.id, at: at1 }, { id: c.id, at: at2 }, r) : filletEnds(base, { id: first.id, at: at1 }, { id: c.id, at: at2 }, r)));
  }

  /**
   * The corner under the pointer (within a finger's reach): an end two lines
   * share, or a corner of a rectangle / polygon / outline - and the length of
   * its shorter side there.
   */
  private cornerAt(p: ToolPointer): { at: Vec2; side: number } | null {
    if (!this.plane) return null;
    const w = this.app.view.rayToPlane(p.x, p.y, this.plane);
    if (!w) return null;
    const uv = toPlane(this.plane, w);
    let reach = this.app.view.cam.worldPerPixel(this.app.view.height) * Math.max(8, p.tol);
    let best: Vec2 | null = null;
    const polys = this.entities.filter((e) => e.kind === "line" || e.kind === "rect" || e.kind === "polygon" || e.kind === "polyline").flatMap((e) => entityPolylines(e));
    for (const poly of polys)
      for (const q of poly) {
        const d = Math.hypot(q[0] - uv[0], q[1] - uv[1]);
        if (d < reach) ((reach = d), (best = q));
      }
    if (!best) return null;
    const at: Vec2 = best;
    const near = (q: Vec2) => Math.hypot(q[0] - at[0], q[1] - at[1]) < 1e-7;
    let side = Infinity;
    let sides = 0;
    for (const poly of polys)
      for (let i = 0; i + 1 < poly.length; i++)
        if (near(poly[i]) || near(poly[i + 1])) {
          side = Math.min(side, Math.hypot(poly[i + 1][0] - poly[i][0], poly[i + 1][1] - poly[i][1]));
          sides++;
        }
    // A free end of one line is no corner.
    return sides >= 2 ? { at, side: Number.isFinite(side) ? side : 0 } : null;
  }

  private filletEdit: { make: (r: number) => SketchEntity[] | null; widget: DimWidget; base: SketchEntity[]; baseIds: Set<string> } | null = null;

  /** Show the fillet with the last radius and a focused radius box to type into. */
  private startFillet(make: (r: number) => SketchEntity[] | null): void {
    if (!make(memory.fillet)) return this.app.ui.toast(memory.corner === "chamfer" ? "Can't chamfer these (distance too big, parallel, or not two lines)" : "Can't fillet these (radius too big, parallel, or not curves meeting at a corner)");
    const widget = new DimWidget(this.app.view, {
      value: memory.fillet,
      boxAt: "beyond",
      focus: true,
      onInput: (v) => v > 0 && this.applyFillet(v),
      onCommit: () => this.finishFillet(),
    });
    this.filletEdit = { make, widget, base: this.entities, baseIds: new Set(this.entities.map((e) => e.id)) };
    this.applyFillet(memory.fillet);
    this.setHint(memory.corner === "chamfer" ? "Type how far back to cut each line, then Enter (or tap anywhere)." : "Type the radius, then Enter (or tap anywhere).");
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
    // A chamfer: the distance runs from one cut back to the old corner.
    const cutLine = next.find((e) => e.kind === "line" && !fe.baseIds.has(e.id) && memory.corner === "chamfer");
    if (cutLine?.kind === "line") {
      const side = next.find((e): e is Extract<SketchEntity, { kind: "line" }> => e.kind === "line" && e.id !== cutLine.id && (samePt(e.a, cutLine.a) || samePt(e.b, cutLine.a)));
      const other = next.find((e): e is Extract<SketchEntity, { kind: "line" }> => e.kind === "line" && e.id !== cutLine.id && (samePt(e.a, cutLine.b) || samePt(e.b, cutLine.b)));
      const corner = side && other && lineMeet(side, other);
      if (corner) fe.widget.set(sketchToWorld(this.plane!, cutLine.a).toArray() as Vec3, sketchToWorld(this.plane!, corner).toArray() as Vec3);
    }
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
    // A rectangle / polygon rounded at a corner came apart into lines: its own
    // constraints go, and its sides stay joined where they meet.
    const now = new Set(this.entities.map((e) => e.id));
    const gone = new Set([...fe.baseIds].filter((id) => !now.has(id)));
    let cs = this.constraints.filter((c) => !(c.curves?.some((id) => gone.has(id)) || c.pts?.some((r) => gone.has(r.e))));
    if (gone.size) {
      const sides = this.entities.filter((e): e is Extract<SketchEntity, { kind: "line" }> => e.kind === "line" && !fe.baseIds.has(e.id));
      for (const x of sides)
        for (const y of sides)
          if (x !== y && samePt(x.b, y.a)) cs = [...cs, { id: uid(), type: "coincident", pts: [{ e: x.id, p: "b" }, { e: y.id, p: "a" }] }];
    }
    // One undo step for the whole fillet; the arc stays tangent and joined to its lines.
    this.commit(this.entities, memory.corner === "chamfer" ? chamferConstraints(this.entities, cs, fe.baseIds) : filletConstraints(this.entities, cs, fe.baseIds));
    this.setHint();
    // The card shows the size just used (it may have been typed in the box on the corner).
    this.updatePanel();
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

  /** Curves of this sketch picked to project out: next, the plane or face they go to. */
  private projectOut: string[] = [];

  /** Where the picked curves of this sketch go: a plane or face parallel to it. */
  private projectOutTo(target: PlaneDef): void {
    const from = this.plane!;
    if (Math.abs(dot(from.normal, target.normal)) < 1 - 1e-6) return this.app.ui.toast("That isn't parallel to this sketch - tap a plane or flat face facing the same way", "error");
    // This sketch's own axes, moved straight across onto the target: the curves keep their coordinates.
    const d = dot(sub3(target.origin, from.origin), from.normal);
    if (Math.abs(d) < 1e-9) return this.app.ui.toast("That's this sketch's own plane - tap a parallel plane or face away from it", "error");
    const plane: PlaneDef = { origin: add3(from.origin, scale3(from.normal, d)), xDir: from.xDir, normal: from.normal };
    const ids = new Set(this.projectOut);
    const entities = this.entities.filter((e) => ids.has(e.id)).map((e) => ({ ...structuredClone(e), id: uid() }) as SketchEntity);
    if (!entities.length) return;
    const ident = this.app.store.newIdentity("sketch");
    this.app.store.add({ ...ident, type: "sketch", plane, entities, constraints: [] });
    this.projectOut = [];
    this.selected.clear();
    this.showSelection();
    this.setHint();
    this.app.ui.toast(`Projected ${entities.length === 1 ? "1 curve" : `${entities.length} curves`} to ${ident.name}`);
  }

  private tapProject(p: ToolPointer): void {
    // A curve of this sketch: picked to project out (to a parallel plane or face, tapped next).
    const own = this.sketchId ? this.app.view.pick(p.x, p.y, { curves: this.sketchId, profiles: false, bodies: false, planes: false, axes: false, images: false, edgeTolPx: p.tol }) : null;
    const hit = own?.kind === "curve" && own.sketch === this.sketchId ? own : this.app.view.pick(p.x, p.y, { profiles: false, planes: true, axes: false, edgeTolPx: p.tol });
    if (hit?.kind === "curve" && hit.sketch === this.sketchId) {
      const i = this.projectOut.indexOf(hit.entity);
      if (i >= 0) this.projectOut.splice(i, 1);
      else this.projectOut.push(hit.entity);
      this.selected = new Set(this.projectOut);
      this.showSelection();
      return this.setHint(this.projectOut.length ? "Now tap a flat face or plane, parallel to this sketch, to copy them onto (or tap more lines)" : undefined);
    }
    if (this.projectOut.length) {
      if (hit?.kind === "plane") {
        const pl = this.app.view.planeOf(hit.id);
        if (pl) return this.projectOutTo(pl);
      }
      if (hit?.kind === "face" || hit?.kind === "edge") {
        const b = this.app.view.body(hit.body);
        const face = hit.kind === "face" ? b?.faces[hit.face] : undefined;
        if (face?.plane) return this.projectOutTo(face.plane);
      }
      return this.app.ui.toast("Tap a plane or a flat face parallel to this sketch");
    }
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
    if (!e) return;
    // It follows that edge from now on, if the edge is there when this sketch
    // is made (the steps that made it come before the sketch).
    const ref = edgeRefOf(this.app, hit);
    const order = this.app.store.features.map((f) => f.id);
    const at = this.sketchId ? order.indexOf(this.sketchId) : order.length;
    const before = (step: string) => order.indexOf(step) >= 0 && order.indexOf(step) < at;
    if (!ref?.steps?.length || !ref.steps.every(before)) return this.commitAdd([e]);
    const id = `${LINKED}${uid()}`;
    this.commit([...this.entities, { ...e, id, ...(this.construction ? { construction: true } : {}) }], this.constraints, [{ id, edge: ref }]);
    this.app.ui.toast("It follows that edge when the body changes");
  }

  // ------------------------------------------------- single-entity sizes

  /** An offset of the face's edge (linked to it): its distance, which side, or delete it. */
  private showLinkPanel(curve: string): void {
    const linkId = curve.slice(4, curve.lastIndexOf("-"));
    const sid = this.sketchId;
    const link = this.sketch?.outlineOffsets?.find((o) => o.id === linkId);
    if (!sid || !link) return;
    const change = (fn: (list: NonNullable<SketchFeature["outlineOffsets"]>) => NonNullable<SketchFeature["outlineOffsets"]>) =>
      this.app.store.commit((d) => {
        const f = d.features.find((x) => x.id === sid);
        if (f?.type !== "sketch") return;
        const next = fn(f.outlineOffsets ?? []);
        f.outlineOffsets = next.length ? next : undefined;
      });
    const setDistance = (v: number) => change((list) => list.map((o) => (o.id === linkId ? { ...o, distance: v } : o)));
    this.app.ui.showPanel({
      title: "Offset of the face's edge",
      items: [
        { type: "number", label: "Distance", value: link.distance, kind: "length", onInput: (v) => v !== 0 && setDistance(v) },
        { type: "button", label: "Flip", icon: "flip", onClick: () => (setDistance(-link.distance), this.clearSelection()) },
        {
          type: "button",
          label: "Delete",
          icon: "trash",
          onClick: () => {
            change((list) => list.filter((o) => o.id !== linkId));
            this.clearSelection();
          },
        },
      ],
      onDone: () => this.clearSelection(),
    });
    this.setHint("It follows the face's edge when the face changes size. Negative: inside the edge.");
  }

  /** A curve that follows a body's edge: letting it go (it becomes a curve of the sketch), or deleting it. */
  private showFollowPanel(id: string): void {
    const gone = (keep: boolean) => {
      this.commit(this.entities.flatMap((x) => (x.id !== id ? [x] : keep ? [{ ...x, id: uid() }] : [])));
      this.clearSelection();
    };
    this.app.ui.showPanel({
      title: "Follows a body's edge",
      items: [
        { type: "button", label: "Unlink", icon: "line", onClick: () => gone(true) },
        { type: "button", label: "Delete", icon: "trash", onClick: () => gone(false) },
      ],
      onDone: () => this.clearSelection(),
    });
    this.setHint("It stays on that edge when the body changes. Dimension the sketch to it and the sketch follows too.");
  }

  private showSizePanel(): void {
    const id = [...this.selected][0];
    if (id?.startsWith("lnk-")) return this.showLinkPanel(id);
    if (id?.startsWith(LINKED) && this.sketch?.links?.some((l) => l.id === id)) return this.showFollowPanel(id);

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
          // Strict: a size the other constraints don't allow isn't taken.
          const next = setDim(base, id, prop, v, expr);
          const added = next.filter((c) => !base.includes(c));
          // An angle typed in (0 to make it level) goes in like the H/V button: what's in its way gives way.
          if (kind === "angle") {
            const ra = addForUser(this.entities, next.filter((c) => base.includes(c)), added);
            if (!ra.ok) return this.refused();
            this.commit(ra.result.entities, ra.constraints);
            if (ra.removed.length) this.app.ui.toast(`Replaced ${[...new Set(ra.removed.map(constraintName))].join(", ")}`);
            return;
          }
          const res = addStrict(this.entities, next.filter((c) => base.includes(c)), added);
          if (!res.ok) return this.refused();
          this.commit(this.entities, res.constraints);
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
        // Turned by an angle typed (a blade section 30° to the flow): the
        // rectangle had one, the ellipse didn't - and Move/Rotate is a long way round.
        items.push(dimField("Length", "dx"), dimField("Width", "dy"), {
          type: "number",
          label: "Angle",
          value: Math.round(((((e.rotation * 180) / Math.PI) % 180) + 180) % 180 * 1e6) / 1e6,
          kind: "angle",
          onInput: (v) => set({ rotation: (v * Math.PI) / 180 }),
        });
        break;
      case "polygon":
        items.push(dimField("Radius", "radius"), { type: "number", label: "Sides", value: e.sides, kind: "int", min: 3, onInput: (v) => set({ sides: Math.max(3, Math.min(64, v)) }) });
        break;
      case "arc":
        items.push(dimField("Radius", "radius"));
        break;
    }
    items.push(
      ...this.constraintChips(),
      { type: "toggle", label: "Construction", value: !!e.construction, onChange: () => this.toggleConstruction() },
      ...(e.kind === "rect" || e.kind === "polygon" ? [{ type: "button", label: "Explode", icon: "line", onClick: () => this.explodeShape(id) } as PanelItem] : []),
      ...this.deleteConstraintsItem(),
      { type: "button", label: "Delete", icon: "trash", onClick: () => this.deleteSelected() },
    );
    this.app.ui.showPanel({ title: titleOf(e.kind as Kind), items, onDone: () => this.clearSelection() });
    // An arc or circle: its radius (diameter for a circle) in a box right by it - type to change it.
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
        // A size set by a formula shows it (and keeps it: typed with variables, it stays linked to them).
        typed: field.expr,
        boxAt: "beyond",
        onInput: (v, text) => {
          field.onExpr?.(text);
          field.onInput(v);
        },
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
   * - type a new angle (the second line turns), or pin it as a measurement.
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
      // A variable or a sum typed ("tilt", "90-a") stays: the angle follows it.
      onInput: (v, text) => this.setLinesAngle(l1.id, l2.id, v, text && isExpression(text) ? text : undefined),
      onCommit: () => this.clearSelection(),
      onPin: () => this.app.addPin({ text: `${trimNum(this.angleBetween(l1.id, l2.id), 2)}°`, at: w }),
    });
    this.angleDim.set(w, w);
  }

  private angleDim: DimWidget | null = null;
}

/** A phone-sized screen (where a trailing preview line only gets in the way). */
function phoneScreen(): boolean {
  return screenClass() === "phone";
}

function titleOf(k: string): string {
  const t: Record<string, string> = { patternLinear: "Pattern – Linear", patternCircular: "Pattern – Circular", rotate: "Rotate About", rect: "Rectangle", offset: "Offset Edge", polyline: "Outline" };
  return t[k] ?? k[0].toUpperCase() + k.slice(1);
}

function sizeOfEntity(e: SketchEntity, prop: string): number {
  return sizeOfFn(e, prop) ?? 0;
}

/** The straight piece of a curve nearest a point: a line itself, or the side of a rectangle / polygon / outline. */
function sideNear(e: SketchEntity | undefined, at: Vec2): Extract<SketchEntity, { kind: "line" }> | null {
  if (!e) return null;
  if (e.kind === "line") return e;
  if (e.kind !== "rect" && e.kind !== "polygon" && e.kind !== "polyline") return null;
  const sides = explode(e).filter((x): x is Extract<SketchEntity, { kind: "line" }> => x.kind === "line");
  if (!sides.length) return null;
  return sides.reduce((m, x) => (closestOnPrim(entityPrims(x)[0], at).d < closestOnPrim(entityPrims(m)[0], at).d ? x : m));
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
