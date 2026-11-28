import { acceptFor } from "../io/insert";
import { QuickActions } from "./quickActions";
import { isTouchDevice } from "../device";
import { simplifyStroke } from "../sketch/freehand";
import { Box3, BufferGeometry, DoubleSide, Line, LineBasicMaterial, LineDashedMaterial, Mesh, MeshBasicMaterial, Points, PointsMaterial, ShapeUtils, Vector2, Vector3 } from "three";
import type { EdgeLink, ExtrudeSource, FaceRef, OutlineOffset, PlaneDef, PointRef, SketchConstraint, SketchEntity, SketchFeature, SketchFill, SketchRef, SketchRepeat, Vec2, Vec3 } from "../doc/types";
import { add as add3, dot, GROUND, niceStep as niceStepOf, originOnPlane, patternSpacing, planeY, roundSig, scale as scale3, startSize, sub as sub3, toPlane } from "../geom";
import { addForUser, addStrict, constraintError, constraintName, copiedConstraints, LINKED, pointOf, pointsOf, refsOf, lengthFromHeldEnd, setValueStrict, sizeStrict, sizeOf as sizeOfFn, solve, touchingEnds } from "../sketch/constraints";
import { isExpression } from "../ui/ui";
import { caretToEnd, selectAll, textField, type TextField } from "../ui/textField";
import { nearestSnap } from "../sketch/snapPick";
import { arrangement, type Region } from "../sketch/regions";
import { Gimbal, IN_PLANE, type GimbalPart } from "./gimbal";
import { buildConstraints, CONSTRAINT_BUTTONS, constraintGlyph, ConstraintGlyphs, dimOf, distanceOf, existingConstraints, setDim } from "./sketchConstraints";
import { settings } from "../settings";
import { isCoarse, screenClass } from "../device";
import { arcFrom3, closestOnPrim, entityPolylines, entityPrims, evalPrim, splineHeights } from "../sketch/curves";
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
  offsetSeveral,
  splineEnds,
  leanSpline, projectPolyline,
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
import { ExtrudeOp, LoftOp, RevolveOp, SweepOp } from "./ops";
import { splitRegions } from "./select";
import { CopyToggle, copyMode } from "./copyToggle";
import type { PanelItem, ToolItem } from "../ui/ui";
import { evaluate, fmtLen, toDisplay, trim as trimNum, UNIT_LABEL, units } from "../units";
import { showConstraintList, type ConstraintRow } from "./constraintList";
import type { ToolPointer } from "../view/input";
import { dotMaterial, sketchToWorld } from "../view/viewport";
import { FILL_KINDS, FILL_PREFIX, fillCurves, fillUnit, refill, regionAt, withoutFills } from "../sketch/fill";
import { applyRepeats } from "../sketch/repeat";
import { edgeRefOf, edgesOfFace, hitToSel, sourceFrame, sourcesOf, type AppContext, type Sel, type Tool } from "./tool";

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
  | "fill"
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
  select: "Tap a line to set its size: type it in the box beside the line. Tap a second to tie them together. Double-tap picks a whole shape.",
  line: "Tap to place points. Closing a shape ends the line; a double tap ends it sooner.",
  arc: isCoarse ? "Drag from one end of the arc to the other, then drag to bend it." : "Click where the arc starts and ends, then a third point to bend it.",
  spline: "Tap points for the curve to pass through. Tap the first point to close it, or double-tap to stop.",
  rect: "Tap one corner, then the opposite corner.",
  circle: "Tap the centre, then tap again to set the size.",
  ellipse: "Tap the centre, then the end of the long side, then tap to set the width.",
  polygon: "Tap the centre, then where a corner should be.",
  text: "Tap where the text should start, then type it in the card.",
  project: "Tap edges of a body, or lines of another sketch, to copy them here. Double-tap copies a whole sketch.",
  offset: "Tap a line or shape - or an edge of a body - to draw a copy of it a set distance away.",
  fill: "Tap inside a closed shape: it is filled with the pattern. Tap a shape that has one to change it.",
  fillet: "Tap a corner to round it, or two lines that meet. Then drag or type the radius.",
  move: "Tap what to move, then drag the arrows to move it or the ring to turn it, or type.",
  scale: "Tap what to resize, then drag the middle square (an arrow's end: one way only), or type a factor.",
  patternLinear: "Tap what to repeat, then drag an arrow to space the copies, and set how many.",
  patternCircular: "Tap what to repeat (double-tap for a whole shape), then tap the centre to repeat it around.",
  rotate: "Tap what to turn (double-tap: a whole shape), then the point to turn it about, and set the angle.",
  mirror: "Tap a shape, then tap the line to flip it across. Any line works, even one of its own.",
  trim: "Tap the piece of a line to cut away, or swipe across several.",
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
  if (kind === "spline" && memory.spline === "control") return "Tap points that pull the curve towards them. Tap the first to close it, or double-tap to stop.";
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

/** Fill Pattern as it was last used: the next shape filled starts the same. */
// (Its sizes are shares of the shape filled, in hundredths: 5 is about twenty rows across a shape of any size.)
const fillMemory: Omit<SketchFill, "id" | "at"> = { kind: "lines", spacing: 5, angle: 45, size: 8, rel: true };

/**
 * The way each tool draws (Rectangle: Center, Diagonal...) survives a reload:
 * a window drawn all by centre rectangles came back to Diagonal halfway through.
 */
const VARIANTS: Record<string, readonly string[]> = { rect: ["diagonal", "center", "3pt"], circle: ["center", "2pt", "3pt"], arc: ["3pt", "center"], spline: ["fit", "control", "draw"], corner: ["round", "chamfer"], trim: ["cut", "join"] };
try {
  const saved = JSON.parse(localStorage.getItem("sg.sketchVariants") ?? "{}") as Record<string, string>;
  for (const [k, v] of Object.entries(saved)) if (VARIANTS[k]?.includes(v)) (memory as unknown as Record<string, string>)[k] = v;
} catch {
  /* nothing saved, or no storage */
}
/** A tool's way of drawing set from outside (the tutorial's rectangle is drawn corner to corner). */
export function sketchVariant(tool: string, way: string): void {
  if (!VARIANTS[tool]?.includes(way)) return;
  (memory as unknown as Record<string, string>)[tool] = way;
  storeVariants();
}

/** How many sides Polygon draws, set from outside (the tutorial's bolt head is a hexagon). */
export function sketchSides(n: number): void {
  memory.sides = n;
}

function storeVariants(): void {
  try {
    localStorage.setItem("sg.sketchVariants", JSON.stringify(Object.fromEntries(Object.keys(VARIANTS).map((k) => [k, (memory as unknown as Record<string, string>)[k]]))));
  } catch {
    /* private window: just this session */
  }
}

/** A text size has been typed (now or before a reload): until then Text starts at a size that shows in the view. */
// (Declared with no value here on purpose: the size is read from storage above this line, as the file loads.)
var textSizeChosen: boolean | undefined;

/** The text size survives a reload (a ruler's 3.5 mm numbers came back at 10 mm after one). */
function storedTextSize(): number {
  try {
    const v = Number(localStorage.getItem("sg.textSize"));
    if (v > 0) textSizeChosen = true;
    return v > 0 ? v : 10;
  } catch {
    return 10;
  }
}
function storeTextSize(v: number): void {
  textSizeChosen = true;
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
  /** The arc being bent runs smoothly on from these lines (kept tangent to them). */
  tan?: string[];
}

/** Something the cursor can slide along: a line (through p, along d) or a circle. */
type Locus =
  | { kind: "line"; p: Vec2; d: Vec2; label: string; guide?: Vec2; seg?: [Vec2, Vec2]; on?: string; dir?: Snap["dir"]; show?: [Vec2, Vec2]; axis?: 0 | 1 }
  | { kind: "circle"; c: Vec2; r: number; label: string; on?: string; tan?: { curve: string; ok(q: Vec2): boolean }; show?: [Vec2, Vec2] };

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

/** A name as a title: "distance dimension" is "Distance dimension". */
const titled = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const refKey = (r: PointRef) => `${r.e}:${r.p}`;

/**
 * Sketching. First pick a plane (origin planes, a flat face, a construction
 * plane or an existing sketch); the camera then looks straight at it in
 * orthographic and Line is active. Every finished shape commits right away.
 */
/**
 * `len` from `o` at `deg` degrees: square angles exactly (a line typed 80
 * long at 90° ended at x -29.999999999999996, not -30 - and the arc drawn from
 * its end was off by as much).
 */
function along(o: Vec2, deg: number, len: number): Vec2 {
  const turn = ((deg % 360) + 360) % 360;
  const [c, s] = turn === 0 ? [1, 0] : turn === 90 ? [0, 1] : turn === 180 ? [-1, 0] : turn === 270 ? [0, -1] : [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)];
  return [o[0] + c * len, o[1] + s * len];
}

export class SketchTool implements Tool {
  readonly id = "sketch";
  private phase: "plane" | "draw";
  private kind: Kind = "line";
  private sketchId: string | null;
  private plane: PlaneDef | null;
  private attachedTo?: FaceRef;
  /** The construction plane it's drawn on (the sketch follows it). */
  private onPlane?: string;
  /** A construction plane of the project (not an origin plane): the sketch is linked to it. */
  private linkPlane(id: string): void {
    this.onPlane = this.app.store.find(id)?.type === "plane" ? id : undefined;
  }
  private pts: Vec2[] = [];
  private cursor: Snap | null = null;
  private dragging = false;
  private locks: Record<string, number> = {};
  /** The length typed while drawing as a formula (with variables), for the value it gave. */
  private lenExpr: { v: number; text: string } | null = null;
  /** A size typed into the card as a variable ("bore", "wall*2"): kept on its dimension, so it follows the variable. */
  private lockExprs: Record<string, { v: number; text: string }> = {};
  /** The first point's X / Y typed with a variable (a centre held there, following it). */
  private firstExprs: ({ v: number; text: string } | undefined)[] = [];
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
    /** Offset of a curve that is itself an offset of the face's edge: that first offset. */
    offsetLink?: OutlineOffset;
    /** Where the face's outline was tapped (an offset of it is linked to it). */
    offsetAt?: Vec2;
    /** Where a curve of the sketch was tapped for an offset (its drag handle sits there). */
    offsetGrip?: Vec2;
    /** Offset Edge on a body's edge: the edge tapped (its curve was brought into the sketch as a dashed guide, and that is what is offset). */
    offsetEdge?: { body: string; edge: number };
    /** ... and the guides brought in for it (the edge's own, and with Chain the rest of its face's outline). */
    offsetGuides?: string[];
    /** Offset Edge, Edge: more edges tapped after the first, offset with it (each: the curve, where it was tapped, and - of a face's outline - the body's edge there). */
    offsetMore?: { id: string; at: Vec2; edge?: { body: string; edge: number } | null }[];
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
    /** A pattern's count typed with a variable or a formula: the pattern follows it. */
    countExpr?: string;
    factor: number;
    count: number;
    copy: boolean;
    /** Mirror keeps the original by default (its own switch, not Move's Copy). */
    mirrorCopy: boolean;
  } = { dx: 10, dy: 0, moveRot: 0, angle: 90, patAngle: 360, factor: 2, count: 3, copy: false, mirrorCopy: true };
  private text = "Text";
  private overlays: (Line | Points | Mesh)[] = [];
  private prevOrtho = false;
  /** Selected sketch points (curves are in `selected`). */
  private selPts: PointRef[] = [];
  private gimbal: Gimbal | null = null;
  /** The gimbal has its arrow off the plane (points of a spline are picked). */
  private gimbalLifts = false;
  private copyToggle: CopyToggle | null = null;
  private glyphs: ConstraintGlyphs | null = null;
  private bar: HTMLElement | null = null;
  private selConstraint: string | null = null;
  /** Live edit of geometry: dragging points/curves, or the sketch gimbal. */
  private sdrag:
    | { kind: "points"; from: Vec2; refs: DragRef[] }
    | { kind: "gimbal"; part: GimbalPart; from: ToolPointer; refs: DragRef[]; center: Vec2; last: { d: Vec2; ang: number } }
    | { kind: "pivot"; line: string }
    /** Points of a spline pulled off the sketch's plane (the gimbal's third arrow): each one's height as it began. */
    | { kind: "lift"; from: ToolPointer; origin: Vec3; pts: { e: string; i: number; z0: number }[]; dz: number }
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
    opts: { sketchId?: string; plane?: PlaneDef; attachedTo?: FaceRef; onPlane?: string; kind?: Kind } = {},
  ) {
    this.sketchId = opts.sketchId ?? null;
    this.plane = opts.sketchId ? (app.sketchPlane(opts.sketchId) ?? null) : (opts.plane ?? null);
    this.attachedTo = opts.attachedTo;
    this.onPlane = opts.onPlane;
    this.phase = this.plane ? "draw" : "plane";
    if (opts.sketchId) this.kind = "select";
    // Started by its key (L, C, R…): that drawing tool, once the plane is picked.
    if (opts.kind) this.kind = opts.kind;
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
    // (Only flat for a view of the cube's: perspective is what to go back to. A sketch stays flat when turned.)
    this.prevOrtho = this.app.view.cam.ortho && !this.app.view.cam.flatForNow;
    this.app.view.cam.flatForNow = false;
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
          this.app.ui.toast("Sketching on the face in front of you. For another: the tick, Exit, then tap that face and Sketch.");
        } else if (view.construction.planes.some((c) => Math.abs(dot(c.plane.normal, normal)) > 0.9999)) {
          // Planes of the project's own face this way (a blade's tip plane,
          // seen from the top): pick one in the card, not the origin plane.
          this.phase = "plane";
          this.plane = null;
        } else {
          // Which one, in the names the plane buttons use: "the origin plane" left people guessing.
          const name = ["YZ (side)", "XZ (front)", "XY (floor)"][k];
          this.app.ui.toast(this.app.store.features.some((f) => f.type === "extrude" || f.type === "revolve" || f.type === "import") ? `Sketching on ${name}, through the origin. For a face of the model: the tick, Exit, then tap the face first.` : `Sketching on ${name}`);
        }
      }
    }
    if (this.phase === "plane") this.showPlaneChoice();
    else this.beginDrawing();
  }

  private showPlaneChoice(): void {
    {
      this.app.view.setOriginPlanesVisible(true);
      // (With the wheels, the card's plane buttons are on the options wheel, out
      // of sight: the floor is mostly behind the front plane from the usual
      // view, and a tap for it took the front - said where the names are.)
      this.app.ui.setHint("Tap a plane or a flat face to draw on.");
      // The three origin planes as buttons too: in a 3D view they overlap near
      // the origin, and a tap meant for the floor can land on the front plane.
      const pick = (id: string) => () => {
        const pl = this.app.view.planeOf(id);
        if (!pl || this.phase !== "plane") return;
        this.plane = pl;
        this.linkPlane(id);
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
    }
  }

  exit(): void {
    this.clearQuick();
    this.closePickBox();
    this.dropOffsetGrip();
    this.regionArrow?.handle.dispose();
    this.regionArrow = null;
    this.regionQuick?.dispose();
    this.regionQuick = null;
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
    this.hideSizeTags();
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
    this.glyphs ??= new ConstraintGlyphs(this.app.view, {
      click: (id) => this.selectConstraint(id),
      text: (id) => {
        const c = this.constraints.find((x) => x.id === id);
        if (!c || c.value === undefined) return "";
        return c.expr ?? (c.prop === "angle" ? trimNum(c.value, 2) : trimNum(toDisplay(c.value), 3));
      },
      edit: (id, text) => this.typeConstraintValue(id, text),
    });
    this.glyphs.selected = this.selConstraint;
    this.glyphs.setFocus(this.kind === "select" ? this.selected : []);
    this.glyphs.set(this.plane, this.entities, this.constraints);
    this.glyphs.setVisible(settings.value.showConstraintGlyphs);
    this.glyphs.setTappable(this.kind === "select");
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
    // Which of two things a constraint leaves where it is.
    const anchor = document.createElement("button");
    anchor.className = "cbar-toggle";
    const last = settings.value.sketchAnchor === "last";
    anchor.innerHTML = `<span class="cl">Stays put: ${last ? "last picked" : "first picked"}</span>`;
    anchor.title = "When a constraint joins two things, which one stays where it is (the other moves to it)";
    anchor.addEventListener("click", () => settings.set("sketchAnchor", last ? "first" : "last"));
    // The constraints themselves are in the card of what's selected - just the
    // ones that fit it, one tap each (a column of mostly greyed-out buttons sat
    // on top of that card).
    const note = document.createElement("div");
    note.className = "cbar-note";
    note.textContent = "Tap lines or points: the constraints that fit show in their card. Tap a badge on the sketch to change or delete it.";
    this.bar.append(auto, glyphs, anchor, note);
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
    this.app.ui.toast("That contradicts constraints already on the sketch - remove one first (Constraints → tap the one in use)", "error");
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
    const shown = new Set<string>();
    const lit = new Set<string>();
    for (const b of CONSTRAINT_BUTTONS) {
      // Curves whose ends touch but aren't joined (their constraints deleted):
      // Coincident joins them all again, in one tap.
      const gaps = b.type === "coincident" && !this.selPts.length ? this.endGaps() : [];
      if (gaps.length) {
        chips.push({ label: gaps.length > 1 ? `Coincident (${gaps.length})` : "Coincident", glyph: b.glyph, title: `Join the ends that touch (Shift+${b.key})`, onClick: () => this.addConstraint(b.type) });
        continue;
      }
      const have = existingConstraints(b.type, this.constraints, this.selPts, curves);
      for (const c of have) shown.add(c.id), lit.add(c.type);
      const built = have.length ? [] : buildConstraints(b.type, this.selPts, curves, this.entities);
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
    // In use on the pick, with something not picked: a line's Tangent to an arc, with the line alone picked. (Only
    // those between what is picked were lit: the list of those in use had none of them.) Sizes are in List all.
    const other = new Map<string, SketchConstraint[]>();
    // (Not a second Tangent beside the one lit for the picked pair: the arc's Tangent to a line not picked is in List all.)
    // (Nor what ties a copy to its original - a pattern's, a mirror's, an offset's: no constraint to take off with a
    // tap. They stood here as "follow" and "pattern (6)", and one tap unlinked every copy. Nor a distance to
    // something not picked: a size. All of them are in List all, by name, each with its own bin.)
    const listed = (c: SketchConstraint) => c.type === "dim" || c.type === "distance" || c.type === "pattern" || c.type === "follow";
    for (const c of this.selectionConstraints()) if (!listed(c) && !shown.has(c.id) && !lit.has(c.type)) other.set(c.type, [...(other.get(c.type) ?? []), c]);
    for (const [type, list] of other) {
      const b = CONSTRAINT_BUTTONS.find((x) => x.type === type || (x.type === "hv" && (type === "horizontal" || type === "vertical")));
      const name = type === "horizontal" ? "Horizontal" : type === "vertical" ? "Vertical" : type === "fix" ? "Lock" : (b?.label ?? type);
      const glyph = type === "horizontal" ? "H" : type === "vertical" ? "V" : b?.glyph;
      chips.push({ label: list.length > 1 ? `${name} (${list.length})` : name, glyph, on: true, title: `Remove ${name.toLowerCase()}`, onClick: () => this.removeConstraints(list) });
    }
    // The whole list of those on the pick (each with its bin, sizes to type over), with the ones in use.
    const n = this.selectionConstraints().length;
    if (n) chips.push({ label: `List all (${n})`, used: true, title: "Every constraint on the pick, each to delete", onClick: () => this.openConstraintList() });
    return chips.length ? [{ type: "chips", label: "Constraints", chips, split: ["In use (tap to take off)", "Add"] }] : [];
  }

  /**
   * Explode: the rectangle / polygon becomes its sides as lines, still joined
   * at the corners (a rectangle's stay square, its width and height become
   * two sides' lengths) - the same lines a corner drag makes. The lines are
   * selected, so their card (and Constraints, to free them) is right there.
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


  private openConstraintList(): void {
    showConstraintList({
      title: "Constraints",
      rows: () => this.selectionConstraints().map((c) => this.constraintRow(c)),
      setValue: (id, text) => this.typeConstraintValue(id, text),
      remove: (id) => this.removeConstraints(this.constraints.filter((c) => c.id === id)),
      removeAll: () => {
        const list = this.selectionConstraints();
        this.removeConstraints(list);
        this.app.ui.toast(`${list.length} constraint${list.length === 1 ? "" : "s"} removed - the shape stays as it is, free to change`);
      },
      point: (id) => this.glyphs?.setPointed(id),
    });
  }

  /** A size typed for a dimension (in the list, or at the dimension itself): true if the sketch took it. */
  private typeConstraintValue(id: string, text: string): boolean {
    const c = this.constraints.find((x) => x.id === id);
    if (!c) return false;
    const v = evaluate(text, c.prop === "angle" ? "angle" : "length");
    if (v === null || (c.prop !== "angle" && !(v > 0))) return false;
    const before = this.constraints;
    this.pendingExpr = isExpression(text) ? text.trim() : null;
    this.setConstraintValue(id, v);
    // (Refused - it contradicts another: said by a toast, the old size stays.)
    if (this.constraints === before) return false;
    // The card on screen says the new size too (it kept the old one: entered again from there, the old size came back).
    if (this.selConstraint === id) this.selectConstraint(id, false);
    else if (!this.selConstraint) this.updatePanel();
    return true;
  }

  /** One constraint as a row of the list: its name, what else it involves, its size if it has one. */
  private constraintRow(c: SketchConstraint): ConstraintRow {
    const SIZES: Record<string, string> = { length: "Length", radius: "Radius", diameter: "Diameter", w: "Width", h: "Height", rx: "Radius across", ry: "Radius up", dx: "Width", dy: "Height", angle: "Angle" };
    const NAMES: Partial<Record<SketchConstraint["type"], string>> = { fix: "Lock", symmetric: "Symmetry", distance: "Distance", pattern: "Pattern link" };
    const name =
      c.type === "dim" ? (SIZES[c.prop ?? ""] ?? "Size") : c.type === "follow" ? (c.how?.mirror ? "Mirror link" : "Offset link") : (NAMES[c.type] ?? c.type[0].toUpperCase() + c.type.slice(1));
    // What it ties the pick to: the other curves it names, by kind.
    const KINDS: Record<string, string> = { line: "a line", circle: "a circle", arc: "an arc", rect: "a rectangle", polygon: "a polygon", ellipse: "an ellipse", spline: "a curve", polyline: "a shape", point: "a point", text: "text" };
    const others = [...new Set(refsOf(c))].filter((id) => !this.selected.has(id)).map((id) => this.entities.find((e) => e.id === id));
    const kinds = [...new Set(others.map((e) => (e ? (KINDS[e.kind] ?? "a curve") : "something deleted")))];
    const note = c.type === "dim" && c.held ? "kept by Lock" : kinds.length ? `with ${kinds.join(" and ")}` : c.type === "fix" ? "held where it is" : "";
    const sized = (c.type === "dim" || c.type === "distance") && c.value !== undefined && !c.held;
    const angle = c.prop === "angle";
    return {
      id: c.id,
      glyph: constraintGlyph(c),
      name,
      note,
      ...(sized ? { value: { text: c.expr ?? (angle ? trimNum(c.value!, 2) : trimNum(toDisplay(c.value!), 3)), unit: angle ? "°" : UNIT_LABEL[units()] } } : {}),
    };
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

  /** The anchored one (the setting): the first picked, or the last. */
  private anchorPicked(): string | undefined {
    if (settings.value.sketchAnchor !== "last") return this.firstPicked();
    const cands = [...[...this.selected].map((id) => ({ e: id, k: id })), ...this.selPts.map((r) => ({ e: r.e, k: refKey(r) }))];
    cands.sort((a, b) => (this.pickSeq.get(a.k) ?? 0) - (this.pickSeq.get(b.k) ?? 0));
    return cands[cands.length - 1]?.e;
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
    // (Two lines: from the second's middle, square across to the first.)
    const second = curves[1] as Extract<SketchEntity, { kind: "line" }> | undefined;
    const a: Vec2 = pts.length ? P(pts[0]) : [(second!.a[0] + second!.b[0]) / 2, (second!.a[1] + second!.b[1]) / 2];
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

  /** The lock holding this one point where it is, if any. */
  private heldAt(pr: PointRef): SketchConstraint | undefined {
    return this.constraints.find((c) => c.type === "fix" && c.pts?.length === 1 && !c.curves?.length && c.pts[0].e === pr.e && c.pts[0].p === pr.p);
  }

  /** A point's X or Y typed (with a variable it follows it): it's locked there. */
  private placePoint(pr: PointRef, i: 0 | 1, v: number, expr: string | null): void {
    const owner = this.entities.find((x) => x.id === pr.e);
    const p = owner && pointOf(owner, pr.p);
    if (!p) return;
    const old = this.heldAt(pr);
    const at: Vec2 = old?.at ? [old.at[0], old.at[1]] : [p[0], p[1]];
    at[i] = v;
    const atExpr = [...(old?.atExpr ?? [null, null])];
    atExpr[i] = expr;
    const c: SketchConstraint = { id: old?.id ?? uid(), type: "fix", pts: [pr], at, ...(atExpr.some((x) => x) ? { atExpr } : {}) };
    const res = addStrict(this.entities, this.constraints.filter((x) => x !== old), [c]);
    if (!res.ok) return this.refused();
    this.commit(res.result.entities, res.constraints);
    if (this.app.store.problems.length) this.app.ui.toast(this.app.store.problems[0], "error");
    this.updatePanel();
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
    let cs = buildConstraints(type, this.selPts, curves, this.entities);
    // Tangent where the two meet end to end but aren't joined: joined too. Tangent alone keeps a line's endless
    // run touching the arc's circle, and the arc's end slid off the line's end as soon as anything moved.
    // (Only between the curves picked.)
    if (type === "tangent" && cs.length && !this.selPts.length) cs = [...this.endGaps().filter(([a, b]) => this.selected.has(a.e) && this.selected.has(b.e)).map(([a, b]): SketchConstraint => ({ id: uid(), type: "coincident", pts: [a, b] })), ...cs];
    // Lock holds points where they are now.
    if (type === "fix") cs = cs.map((c) => (c.type === "fix" ? { ...c, at: pointOf(this.entities.find((e) => e.id === c.pts![0].e)!, c.pts![0].p) ?? [0, 0] } : c));
    if (!cs.length) return this.app.ui.toast("That constraint doesn't fit the selection");
    // The anchored thing (first picked, or last - the setting) is the reference: it stays, the others adapt to it.
    const first = this.anchorPicked();
    // Equal: a size dimension on the curves picked after the first would fight it - drop those.
    const others = new Set(curves.slice(1).map((e) => e.id));
    const kept = type === "equal" ? this.constraints.filter((c) => !(c.type === "dim" && c.curves?.length === 1 && others.has(c.curves[0]) && ["length", "radius", "diameter"].includes(c.prop ?? ""))) : this.constraints;
    // It goes in: the existing constraints in its way (an angle, a parallel...) give way and are named.
    const res = addForUser(this.entities, kept, cs, first);
    // (Said as it is: locks in the way, or - with none - the shape itself.)
    if (!res.ok) return this.app.ui.toast(this.constraints.some((c) => c.type === "fix") ? "Locked points stop that - unlock them first (select, then Unlock)" : "That can't be done with the shape as it is constrained - take a constraint off it first", "error");
    this.commit(res.result.entities, res.constraints);
    if (this.app.store.problems.length) this.app.ui.toast(this.app.store.problems[0], "error");
    else if (res.removed.length) this.app.ui.toast(`Replaced ${[...new Set(res.removed.map(constraintName))].join(", ")}`);
    // The selection stays: its card shows the new one lit (tap again to take it
    // off), and another can be added straight away.
    this.selectionChanged();
  }

  private selectConstraint(id: string, type = true): void {
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
        title: titled(`${c.prop ?? "distance"} dimension`),
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
      // Its size is typed where it is, on the drawing (the card keeps its Delete, and the size for a formula).
      if (type) this.glyphs?.beginEdit(id);
    } else {
      this.app.ui.showPanel({ title: titled(c.type === "fix" ? "lock" : c.type === "symmetric" ? "symmetry" : `${c.type} constraint`), items: [], actions: [del], onDone: () => this.deselectConstraint() });
    }
  }

  private pendingExpr: string | null = null;

  private lengthFromHeldEnd(id: string, v: number): SketchEntity[] {
    return lengthFromHeldEnd(this.entities, this.constraints, id, v);
  }

  private setConstraintValue(id: string, v: number): void {
    const expr = this.pendingExpr;
    this.pendingExpr = null;
    const c = this.constraints.find((x) => x.id === id);
    const from = c?.type === "dim" && c.prop === "length" && c.curves?.length === 1 ? this.lengthFromHeldEnd(c.curves[0], v) : this.entities;
    // Strict, like a new constraint: a value the sketch can't take isn't taken.
    const res = setValueStrict(from, this.constraints, id, v, expr ?? undefined);
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
    const f: SketchFeature = { ...this.pending, type: "sketch", plane: this.plane, attachedTo: this.attachedTo, onPlane: this.onPlane, entities: [], constraints: [] };
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

  /** How many curves and points are picked now (the sentence bar offers what can be done with them). */
  get pickedCount(): number {
    return this.selected.size + this.selPts.length;
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
    const variant = <T extends string>(kind: Kind, key: "rect" | "spline" | "trim" | "arc" | "circle" | "corner", options: [T, string, string?][]): ToolItem[] =>
      options.map(([v, l, s]) => ({ id: `${kind}-${v}`, label: l, ...(s ? { brief: s } : {}), icon: icons[kind] ?? "spline", active: memory[key] === v, run: () => (((memory as unknown as Record<string, string>)[key] = v), storeVariants(), this.setKind(kind)) }) as ToolItem);
    app.ui.setTools([
      exit,
      // (No Other plane for a new empty sketch: Exit leaves nothing behind, and Sketch again goes where it is wanted.)
      { id: "---1", label: "", icon: "line" },
      t("select", "Select", "pointer", "V"),
      // An empty sketch with no drawing tool on: Line is the next step (it, and Draw round it, pulse).
      t("line", "Line", "line", "L", { pulse: !this.entities.length && this.kind === "select" }),
      t("arc", "Arc", "arc", "A", { sub: memory.arc === "center" ? "Center" : "3 Points", children: variant("arc", "arc", [["3pt", "3 Points"], ["center", "Center"]]) }),
      t("spline", "Spline", "spline", "I", { sub: memory.spline === "fit" ? "Fit" : memory.spline === "draw" ? "Draw" : "Control", children: variant("spline", "spline", [["fit", "Fit points", "Fit"], ["control", "Control points", "Control"], ["draw", "Draw (freehand)", "Freehand"]]) }),
      t("rect", "Rectangle", "rect", "R", { sub: { diagonal: "Diagonal", center: "Center", "3pt": "3 Points" }[memory.rect], children: variant("rect", "rect", [["center", "Center"], ["diagonal", "Diagonal"], ["3pt", "3 Points"]]) }),
      t("circle", "Circle", "circle", "C", { sub: { center: "Center", "2pt": "2 Points", "3pt": "3 Points" }[memory.circle], children: variant("circle", "circle", [["center", "Center"], ["2pt", "2 Points"], ["3pt", "3 Points"]]) }),
      t("ellipse", "Ellipse", "ellipse"),
      t("polygon", "Polygon", "polygon", "G", {
        sub: POLYGON_NAMES[memory.sides] ?? `${memory.sides} sides`,
        // The usual ones a tap away (any other count: type it on the drawing).
        children: [3, 4, 5, 6, 8].map((n) => ({ id: `polygon-${n}`, label: POLYGON_NAMES[n], icon: (n === 6 ? "polygon" : `polygon${n}`) as "polygon" | "polygon3" | "polygon4" | "polygon5" | "polygon8", active: memory.sides === n, run: () => ((memory.sides = n), this.setKind("polygon")) })),
      }),
      t("text", "Text", "text"),
      t("project", "Project", "project", "P"),
      t("offset", "Offset Edge", "offset", "O"),
      t("fill", "Fill Pattern", "hatch", undefined, { sub: "lines or shapes in a closed shape" }),
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
        children: (["patternLinear", "patternCircular"] as const).map((k) => ({ id: k, label: k === "patternLinear" ? "Linear" : "Circular", icon: k, active: memory.pattern === k, run: () => ((memory.pattern = k), this.setKind(k)) })),
      },
      // With curves selected, Delete removes them right away; else it's the tap-to-delete tool.
      t("delete", "Delete", "trash", "Del", { run: () => (this.selected.size || this.selPts.length ? this.deleteSelected() : this.setKind("delete")) }),
    ]);
    // With curves selected the button shows (and flips) their type; otherwise the type of new curves.
    const sel = this.entities.filter((e) => this.selected.has(e.id));
    const isCons = sel.length ? sel.every((e) => e.construction) : this.construction;
    const mixed = sel.length > 0 && !isCons && sel.some((e) => e.construction);
    app.ui.setBottom([
      // (Curves picked: their own Construction switch is with them - not a second one here.)
      ...(sel.length ? [] : [{
        id: "construction",
        // (Named for what it switches, lit while on: "Regular" alone said nothing on the wheel.)
        label: "Construction",
        // The icon is the line type it is now; ⟲ + the type a tap switches to follow the text.
        icon: isCons ? "lineDashed" : "line",
        trailing: ["swap", isCons ? "line" : "lineDashed"],
        sub: sel.length ? (mixed ? "Mixed · tap to switch" : "Tap to switch") : "New lines · tap to switch",
        active: isCons,
        run: () => this.toggleConstruction(),
      } as ToolItem]),
      { id: "look", label: "Sketch view", icon: "normal", run: () => this.plane && app.view.cam.lookAlong(this.plane.normal, this.plane.xDir) },
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
    this.glyphs?.setTappable(kind === "select");
    this.pts = [];
    this.locks = {};
    // A new tool starts a new chain: a line drawn after an arc was tied to the
    // end of the line before the arc (and the solver dragged both across).
    this.lastLineId = this.chainFirstId = null;
    this.startRef = this.startSnap = this.firstSnap = null;
    this.arcM = this.arcBend = null;
    this.typedThisShape = false;
    this.edit.picking = kind === "mirror" ? undefined : this.edit.picking;
    this.edit.offsetOf = this.edit.offsetEdge = this.edit.offsetGrip = this.edit.offsetMore = undefined;
    this.lightEdges(null);
    this.dropOffsetGrip();
    this.fillAt = this.fillId = this.fillHot = null;
    this.edit.extendFrom = this.edit.alignFrom = undefined;
    this.edit.filletFrom = undefined;
    // A circular pattern always asks for its centre.
    if (kind === "patternCircular" || kind === "rotate") this.edit.pivot = undefined;
    // Move starts from nothing (it shared ΔX with the linear pattern's spacing:
    // an ellipse only meant to be turned 20° also moved 10 across).
    if (kind === "move") ((this.edit.dx = 0), (this.edit.dy = 0), (this.edit.moveRot = 0));
    // A linear pattern starts with its first copy just clear of the selection.
    if (kind === "patternLinear") this.autoPatternSpacing();
    // Text, no size typed yet: a twentieth of the height of what the view shows (10 mm letters on a sketch two
    // metres across were a speck, and on one 5 mm across they filled the screen).
    if (kind === "text" && !textSizeChosen) memory.textSize = startSize(this.app.view.cam.worldPerPixel(this.app.view.height) * this.app.view.height, 0.05, 10);
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
    const hint = this.phase === "plane" ? "Tap a plane or a flat face to draw on." : extra ?? this.stepHint() ?? this.journeyHint() ?? hintOf(this.kind);
    this.app.ui.setHint(hint);
  }

  /**
   * The first shape on its way, step by step, saying what pulses: Line on
   * an empty sketch, then Exit once a shape is closed.
   */
  private journeyHint(): string | undefined {
    // (The sentence bar: Exit is at the end of the line, the drawing tools are under Draw.)
    if (document.body.classList.contains("sentence-ui")) {
      if (this.exitPulse && this.kind === "select") return "Shape closed. Tap Exit (pulsing): its arrow is ready to pull it into 3D.";
      if (!this.entities.length && this.kind === "select") return "Tap Draw, then Line: tap points, and end on the first one to close the shape.";
    }
    if (this.exitPulse && this.kind === "select") return "Shape closed. Tap Exit Sketch (pulsing) - then pull the shape into 3D.";
    if (this.entities.length) return undefined;
    if (this.kind === "select") return "Tap Line (pulsing), then tap points - end on the first one to close the shape.";
    if (this.kind === "line" && !this.pts.length) return "Line is on: tap points on the grid, and end on the first one to close the shape.";
    return undefined;
  }

  /**
   * What's next once a shape's first point is down ("Tap the centre, then a
   * corner" stayed up after the centre was tapped: had it taken?).
   */
  private stepHint(): string | undefined {
    if (this.pts.length !== 1) return undefined;
    const typed = isTouchDevice ? "or type it in Values" : "or type it";
    const k = this.kind;
    if (k === "rect" && memory.rect === "center") return `Centre placed. Now tap a corner, ${typed}.`;
    if (k === "rect" && memory.rect === "diagonal") return `First corner placed. Now tap the opposite corner, ${typed}.`;
    if (k === "circle" && memory.circle === "center") return `Centre placed. Now tap a point on the edge, ${typed}.`;
    if (k === "polygon") return `Centre placed. Now tap a corner, ${typed}.`;
    if (k === "ellipse") return `Centre placed. Now tap the end of one axis, ${typed}.`;
    return undefined;
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

  /**
   * A line picked that has no length set: its length in a box beside it, to type right there (the Length field is
   * down on the tool's line, a long way from the line on a big screen). Typed and entered, it becomes the line's
   * length - a driving dimension, shown on the sketch from then on (and typed into there). A line that has its
   * length already shows that dimension, which takes typing the same way.
   */
  private pickBox: { id: string; widget: DimWidget; typed: { v: number; text: string } | null } | null = null;
  private closePickBox(): void {
    this.pickBox?.widget.dispose();
    this.pickBox = null;
  }
  private refreshPickBox(): void {
    const id = this.kind === "select" && this.phase === "draw" && this.plane && this.selected.size === 1 && !this.selPts.length ? [...this.selected][0] : null;
    const l = id && !id.startsWith(LINKED) ? this.entities.find((e) => e.id === id) : null;
    if (!id || l?.kind !== "line" || dimOf(this.constraints, id, "length")) return this.closePickBox();
    const len = Math.hypot(l.b[0] - l.a[0], l.b[1] - l.a[1]);
    if (len < 1e-9) return this.closePickBox();
    if (this.pickBox?.id !== id) {
      this.closePickBox();
      const box: NonNullable<SketchTool["pickBox"]> = {
        id,
        typed: null,
        widget: new DimWidget(this.app.view, {
          value: len,
          boxAt: "side",
          noLine: true,
          onInput: (v, text) => {
            if (v > 0) box.typed = { v, text };
          },
          onCommit: () => this.applyPickBox(),
        }),
      };
      this.pickBox = box;
    }
    const w = (q: Vec2) => sketchToWorld(this.plane!, q, 0.02).toArray() as Vec3;
    // Beside the line a quarter of the way along it: its middle is where the arrows to move it are.
    this.pickBox.widget.set(w(l.a), w([(l.a[0] + l.b[0]) / 2, (l.a[1] + l.b[1]) / 2]));
    if (!this.pickBox.typed) this.pickBox.widget.setValue(len);
  }
  private applyPickBox(): void {
    const b = this.pickBox;
    if (!b?.typed) return;
    const { v, text } = b.typed;
    b.typed = null;
    const base = this.constraints;
    const next = setDim(base, b.id, "length", v, isExpression(text) ? text.trim() : null);
    const added = next.filter((c) => !base.includes(c));
    // (As the Length field does it: the end joined to another line stays, and what the line has nothing to do with.)
    const from = this.lengthFromHeldEnd(b.id, v);
    const res = sizeStrict(from, next.filter((c) => base.includes(c)), added, [b.id]);
    if (!res.ok) {
      this.refreshPickBox();
      return this.refused();
    }
    this.opLabel = "Line length";
    this.commit(res.result.entities, res.constraints);
    // (It has its length now: the box goes, the dimension on the sketch is there in its place.)
    this.refreshPickBox();
  }

  private updatePanel(): void {
    this.refreshPickBox();
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
      ...(this.locks[key] === undefined && value === undefined ? { follows: true } : {}),
        onInput: (v) => {
          this.locks[key] = v;
          // A polygon's size is one or the other: to a corner, or across the flats.
          if (key === "r") delete this.locks.af;
          if (key === "af") delete this.locks.r;
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
    // (Not where the first point is, typed X and Y: on a phone they crowded the line before the sizes that matter.)
    switch (k) {
      case "line":
        // With the numpad, the length is typed in the box by the line itself.
        // (Already in the box on the line: not repeated in the list beside it.)
        if (this.pts.length && !settings.value.numpad && !isTouchDevice) items.push({ ...lock("len", "Length"), inBox: true } as PanelItem);
        // A finger can't hover: after the first tap there's no line to type a
        // length on (and the next point is often off the screen) - so the card
        // takes the length and the direction (0° right, 90° up), Done places it.
        // (Only those two: the first point's X and Y, and how far across and up, made six values on a phone's line.)
        else if (this.pts.length && isTouchDevice) items.push(lock("len", "Length"), lock("ang", "Angle", "angle"));
        break;
      case "arc":
        // By its centre, on a phone: where the centre is, the radius and where
        // it starts, then where it ends (degrees, 0° right, round anticlockwise)
        // - a nacelle's lip round a centre at 257 snapped to 260.
        // (Every device: values can be typed while it's drawn, not only once it's made.)
        if (memory.arc === "center") {
          if (this.pts.length === 1) items.push(lock("r", "Radius"), lock("a0", "Start angle", "angle"));
          else if (this.pts.length === 2) items.push(lock("a1", "End angle", "angle"));
        } else if (this.pts.length === 1) items.push(lock("len", "Length"), lock("ang", "Angle", "angle"));
        else if (this.pts.length === 2) items.push(lock("r", "Radius"));
        break;
      case "rect":
        if (this.pts.length === 1 && memory.rect !== "3pt") items.push(lock("w", "Width"), lock("h", "Height"));
        else if (this.pts.length === 1) items.push(lock("len", "Width"), lock("ang", "Angle", "angle"));
        else if (this.pts.length === 2 && memory.rect === "3pt") items.push(lock("h", "Height"));
        break;
      case "circle":
        if (this.pts.length === 1 && memory.circle !== "3pt") items.push(lock("r", "Diameter"));
        else if (this.pts.length === 1) items.push(lock("len", "Length"), lock("ang", "Angle", "angle"));
        break;
      case "polygon":
        items.push({ type: "number", label: "Sides", value: memory.sides, kind: "int", min: 3, onInput: (v) => ((memory.sides = Math.max(3, Math.min(64, v))), this.refreshPreview(), this.updateMenu()) });
        // (Its Radius only: Across flats beside it was a second size for the same thing.)
        if (this.pts.length === 1) items.push(lock("r", "Radius"));
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
        if (this.pts.length === 1) items.push(lock("rx", "Length"));
        if (this.pts.length === 2) items.push(lock("ry", "Width"));
        break;
      case "text":
        if (this.pts.length === 1) {
          ui.showPanel({
            title: "Text",
            items: [
              // Where the tapped point is (typed, it moves the text exactly) and
              // how the text sits on it: numbers along a ruler are centred on their tick.
              // (X and Y in its window only: on the bottom line they stood before the things that are set more often.)
              { type: "number", label: "X", value: Math.round(this.pts[0][0] * 100) / 100, kind: "length", aside: true, onInput: (v) => ((this.pts[0] = [v, this.pts[0][1]]), this.refreshPreview()) },
              { type: "number", label: "Y", value: Math.round(this.pts[0][1] * 100) / 100, kind: "length", aside: true, onInput: (v) => ((this.pts[0] = [this.pts[0][0], v]), this.refreshPreview()) },
              { type: "choice", label: "Align", options: [{ id: "left", label: "Left" }, { id: "center", label: "Centre" }, { id: "right", label: "Right" }], value: memory.textAlign, onChange: (id) => ((memory.textAlign = id as TextAlign), this.refreshPreview()) },
              { type: "number", label: "Size", value: memory.textSize, kind: "length", min: 0.001, onInput: (v) => ((memory.textSize = v), storeTextSize(v), this.refreshPreview()) },
              // The font: the bundled ones and any imported.
              { type: "choice", label: "Font", list: true, options: FONTS.map((f) => ({ id: f.id, label: f.name })), value: memory.textFont, onChange: (id) => ((memory.textFont = id), this.refreshPreview()) },
              { type: "button", label: "Import font…", icon: "insert", onClick: () => void this.importFontFile() },
            ],
            onDone: () => this.doneTool(),
            onCancel: () => this.setKind("text"),
          });
          this.addTextInput();
          this.setHint("Type the text on the line at the bottom, then tap Done.");
          return;
        }
        break;
      case "fillet":
        // (Typed here while a corner is being sized: that corner takes it - it
        // only set the next one's, and the corner kept its tenth of a side.)
        items.push({
          type: "number",
          label: memory.corner === "chamfer" ? "Distance" : "Radius",
          value: memory.fillet,
          kind: "length",
          min: 0.0001,
          onInput: (v) => {
            memory.fillet = v;
            if (!this.filletEdit) return;
            this.filletEdit.widget.setValue(v);
            this.applyFillet(v);
          },
        });
        break;
      case "fill": {
        // The pattern, then its sizes: shares of the shape filled, in hundredths (see SketchFill.rel). Each change is
        // put in at once on the shape tapped - nothing to apply.
        const kind = FILL_KINDS.find((k) => k.id === fillMemory.kind) ?? FILL_KINDS[0];
        items.push({ type: "choice", label: "Pattern", options: FILL_KINDS.map((k) => ({ id: k.id, label: k.label })), value: fillMemory.kind, onChange: (k) => ((fillMemory.kind = k as SketchFill["kind"]), this.fillChanged()) });
        items.push({ type: "number", label: kind.lines ? "Spacing %" : "Gap %", value: fillMemory.spacing, kind: "number", min: 0.01, onInput: (v) => ((fillMemory.spacing = v), this.fillChanged()) });
        if (kind.sized) items.push({ type: "number", label: kind.lines ? (kind.id === "zigzag" ? "Tooth %" : "Wave %") : "Size %", value: fillMemory.size, kind: "number", min: 0.01, onInput: (v) => ((fillMemory.size = v), this.fillChanged()) });
        items.push({ type: "number", label: "Angle", value: fillMemory.angle, kind: "angle", onInput: (v) => ((fillMemory.angle = v), this.fillChanged()) });
        if (this.fillAt && this.sketch?.fills?.some((f) => f.id === this.fillId)) items.push({ type: "button", label: "Remove pattern", icon: "trash", onClick: () => this.applyFill(true) });
        break;
      }
      case "offset":
        // Edge: just the tapped curve. Chain: the whole connected outline, kept closed.
        items.push({ type: "choice", options: [{ id: "edge", label: "Edge" }, { id: "chain", label: "Chain" }], value: memory.offsetMode, onChange: (m) => {
          memory.offsetMode = m as "edge" | "chain";
          this.edit.offsetMore = undefined;
          // (A body's edge was tapped: Chain is the whole outline of its face, brought in now.)
          if (this.edit.offsetEdge && m === "chain") return this.offsetFromEdge(this.edit.offsetEdge, this.edit.offsetAt);
          if (this.edit.offsetEdge) this.lightEdges(this.edit.offsetEdge);
          // (Of the face's own outline: still inside it - one edge and the whole loop count their sides differently.)
          if (this.edit.offsetOf?.startsWith("bnd-")) (memory.offset = this.inward(Math.abs(memory.offset))), this.lightEdges(this.outlineEdge);
          this.updatePanel();
          this.refreshPreview();
        } });
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
          { type: "number", label: "Count", value: this.edit.count, kind: "int", min: 2, expr: this.edit.countExpr, onExpr: (e) => (this.edit.countExpr = e ?? undefined), onInput: (v) => ((this.edit.count = v), this.refreshPreview()) },
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
          ...(k === "patternCircular" ? [{ type: "number", label: "Count", value: this.edit.count, kind: "int", min: 2, expr: this.edit.countExpr, onExpr: (e: string | null) => (this.edit.countExpr = e ?? undefined), onInput: (v: number) => ((this.edit.count = v), this.refreshPreview()) } as PanelItem] : []),
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
        if (selCount === 0 && this.selPts.length) {
          // One point: where it is, typed (with a variable it follows it - a
          // handle's centre at "Ws/2 - S/2"). Typed, it's locked there.
          const pr = this.selPts[0];
          const owner = this.entities.find((x) => x.id === pr.e);
          const at = this.selPts.length === 1 && owner ? pointOf(owner, pr.p) : null;
          const held = this.heldAt(pr);
          let typed: string | null = null;
          const xy: PanelItem[] = at
            ? ([0, 1] as const).map((i) => ({
                type: "number" as const,
                label: i ? "Y" : "X",
                value: Math.round((held?.at ?? at)[i] * 1e6) / 1e6,
                kind: "length" as const,
                expr: held?.atExpr?.[i] ?? undefined,
                onExpr: (x: string) => (typed = x),
                onInput: (v: number) => {
                  const t = typed && isExpression(typed) ? typed : null;
                  typed = null;
                  this.placePoint(pr, i, v, t);
                },
              }))
            : [];
          // A spline's point: how far off the plane it is, typed (the gimbal's third arrow drags it).
          const lift = this.liftable();
          const height: PanelItem[] =
            lift?.length === 1
              ? [{ type: "number", label: "Height", value: lift[0].z0, kind: "length", onInput: (v: number) => (this.liftPoints([{ ...lift[0], z0: 0 }], v, true), this.refreshGimbal(), this.updatePanel()) }]
              : lift
                ? [{ type: "button", label: "Flat on the plane", icon: "plane", onClick: () => (this.liftPoints(lift.map((q) => ({ ...q, z0: 0 })), 0, true), this.refreshGimbal(), this.updatePanel()) }]
                : [];
          return ui.showPanel({
            title: this.selPts.length === 1 ? (lift ? "Spline point" : "Point") : `${this.selPts.length} points`,
            items: [...xy, ...height, ...this.constraintChips()],
            onDone: () => this.clearSelection(),
          });
        }
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
    // (Length, Angle, Radius…) wait behind a small
    // Values chip, and the finished curve's card shows when it's tapped in
    // Select. A spline keeps its Done beside the chip.
    if (!this.pts.length) this.valuesOpen = false;
    else if (!this.valuesOpen && (typed || k === "spline") && items.length && screenClass() === "phone") {
      this.liveKeys = [];
      ui.showPanel({
        title: titleOf(k),
        items: [{ type: "button", label: "Values", icon: "numpad", onClick: () => ((this.valuesOpen = true), this.updatePanel(), this.refreshPreview()) }],
        onDone: () => this.doneTool(),
      });
      return;
    }
    // The size fields follow the pointer (refreshPreview) until one is typed.
    this.liveKeys = items.filter((it) => it.type === "number").map((it) => lockOf.get(it) ?? null);
    this.liveLabels = new Map();
    for (const it of items) {
      const key = it.type === "number" ? lockOf.get(it) : undefined;
      if (key && it.type === "number") this.liveLabels.set(key, { label: it.label, angle: it.kind === "angle" });
    }
    // A tool that is on (not Select): the tick does what it has set up and puts it down, Cancel drops what is under
    // way. (There with nothing to set too, while something is under way: a spline's points drawn with a mouse had no
    // tick of their own, and the line's tick threw them away.)
    const pending = k !== "select" && this.pendingWork();
    ui.showPanel(items.length || pending ? { title: k === "fillet" && memory.corner === "chamfer" ? "Chamfer" : titleOf(k), items, onCancel: pending ? () => this.dropWork() : undefined, onDone: k !== "select" ? () => this.doneTool() : undefined } : null);
  }

  /** Has the tool that is on something under way: a point placed, a curve picked for it, values set and not applied? */
  private pendingWork(): boolean {
    const e = this.edit;
    if (this.pts.length || this.filletEdit) return true;
    if (e.offsetOf || e.extendFrom || e.alignFrom || e.filletFrom) return true;
    // Curves picked for a move, a turn, a mirror or a pattern, with something set for it.
    return this.isSelectionTool() && this.selected.size > 0 && (this.transformPending() || !!e.pivot);
  }

  /** Cancel while a tool is on: what it has under way is dropped. (Curves picked for a pattern or a move: the tool is put down, they stay picked.) */
  private dropWork(): void {
    if (this.isSelectionTool()) return this.setKind("select");
    this.resetDrawing();
    this.refreshPreview();
  }

  /**
   * The tick while a tool is on. What the tool has set up is done - a typed size put in, a spline made of its
   * points, the text set down, an offset or a pattern applied - and the tool is put down, so Draw, Modify,
   * Transform and Delete are on the line again. (Enter does the first half and leaves the tool on, for the next.)
   */
  private doneTool(): void {
    const k = this.kind;
    if (k === "text") {
      if (!this.pts.length || !this.text.trim()) return this.setKind("select");
      return void this.commitText().then(() => this.kind === "text" && this.setKind("select"));
    }
    if (k === "spline") {
      if (this.pts.length >= 2) this.finishSpline(false);
      return this.setKind("select");
    }
    if (k === "line" || k === "rect" || k === "circle" || k === "arc" || k === "polygon" || k === "ellipse") {
      // A size typed for the shape (or being typed, its values open on a phone): put in. The shape is made; a
      // line carries on from there.
      if (this.pts.length && (Object.keys(this.locks).length || this.valuesOpen || document.querySelector("input.invalid"))) return this.finishTyped();
      return this.setKind("select");
    }
    if (k === "offset" && this.edit.offsetOf) {
      this.applyOffset();
      // (It could not be made: said, and still there to change.)
      if (this.edit.offsetOf) return;
    } else if (this.isSelectionTool() && this.selected.size && this.transformPending()) this.applyTransform();
    this.setKind("select");
  }

  /** Pick a .ttf / .otf / .woff file and use it for the text. */
  private async importFontFile(): Promise<void> {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = acceptFor(".ttf,.otf,.woff,font/ttf,font/otf,font/woff");
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
    const input = textField("text-input");
    // A finger: the last text shows as the placeholder (Enter keeps it) and
    // typing starts afresh - selected to type over, it brought up the phone's
    // Cut / Copy bar.
    if (matchMedia("(pointer: fine)").matches) input.value = this.text;
    else input.placeholder = this.text;
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
    selectAll(input);
    input.addEventListener("input", () => (this.textTyped = true), { once: true });
  }
  /** Something was typed into the text box since it opened (else the last text is still there, selected). */
  private textTyped = false;

  // -------------------------------------------------------------- pointer

  hover(p: ToolPointer | null): void {
    if (p) this.pen = p.type === "pen";
    // Where the pointer is: what is typed, and the sizes of the shape being drawn, show by it. (Only a drag said
    // where: a size typed with the mouse just moved showed in the top left corner of the page.)
    if (p) this.typing.track(p);
    this.tagAt = p && p.type !== "touch" ? { x: p.x, y: p.y } : this.tagAt;
    if (this.offsetGrip) {
      const over = !!p && this.offsetGrip.arrows.some((h) => h.hit(p));
      this.offsetGrip.arrows.forEach((h) => h.setHot(over));
      if (over) return this.app.setHover(null);
    }
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
    if (!p && this.fillHot) ((this.fillHot = null), this.refreshPreview());
    if (!p || this.phase !== "draw" || this.dragging || this.sdrag) return;
    // Drawing: the plain arrow, whatever Select's arrows left (a hand).
    if (this.kind !== "select" && this.app.view.canvas.style.cursor) this.app.view.canvas.style.cursor = "";
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
      // Offset Edge takes an edge of a body too: it lights up under the pointer, as a curve of the sketch does.
      if (this.kind === "offset" && !onCurve) {
        const edge = this.app.view.pick(p.x, p.y, { profiles: false, planes: false, axes: false, curves: false, edgeTolPx: p.tol });
        if (edge?.kind === "edge") this.app.setHover({ kind: "edge", body: edge.body, edge: edge.edge });
      }
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
    if (this.kind === "fill") {
      // Fill Pattern: the closed shape under the pointer lights up - that is what a tap fills. (No snap dot: no
      // point is placed, and the dot said one would be.)
      this.cursor = null;
      const uv = this.uvAt(p);
      const hot = uv ? this.fillRegionAt(uv) : null;
      if (hot !== this.fillHot) ((this.fillHot = hot), this.refreshPreview());
      return;
    }
    this.cursor = this.snap(p);
    this.refreshPreview(p);
  }

  down(p: ToolPointer): boolean {
    this.pen = p.type === "pen";
    if (this.phase !== "draw") return false;
    // The extrude arrow of a tapped shape, grabbed: only now does Extrude start
    // (the sketch closes), and this same drag sizes it.
    if (this.regionArrow?.handle.hit(p)) return this.extrudeFromArrow(p);
    // The offset's double arrow, grabbed: this drag sets how far it goes (and to which side).
    if (this.offsetGrip?.arrows.some((h) => h.hit(p))) return (this.offsetGrip.dragging = true);
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
    this.setHint();
    // (Drawn now, its dot with it: a finger that only tapped left nothing on the grid where the centre went. No size
    // label by the finger: there is no size yet.)
    this.refreshPreview();
    return true;
  }

  drag(p: ToolPointer): void {
    if (this.offsetGrip?.dragging) return this.dragOffset(p);
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
    this.tagAt = p.type === "touch" ? null : { x: p.x, y: p.y };
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
    if (this.offsetGrip?.dragging) {
      this.offsetGrip.dragging = false;
      // (The line at the bottom shows the distance it was left at.)
      return this.updatePanel();
    }
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
      const own = e.kind === "ellipse" && e.sweep !== undefined ? pointsOf(e) : e.kind === "circle" || e.kind === "ellipse" || e.kind === "rect" || e.kind === "polygon" ? pointsOf(e).filter((q) => q.p === "c") : pointsOf(e).filter((q) => q.p !== "c");
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
    // The arrow off the plane: the picked points of a spline go up or down with it (the curve then runs through
    // space - a sweep's path, a loft's guide).
    if (part.kind === "axis" && part.i === 2) {
      const pts = this.liftable();
      if (!pts) return false;
      this.sdrag = { kind: "lift", from: p, origin: [...this.gimbal.origin] as Vec3, pts, dz: 0 };
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
    if (dr.kind === "lift") {
      const view = this.app.view;
      const step = niceStepOf(view.cam.worldPerPixel(view.height) * 4);
      const raw = axisDrag(view, dr.origin, this.plane!.normal, dr.from, p);
      const dz = p.shift ? raw : Math.round(raw / step) * step;
      this.liftPoints(dr.pts, dz);
      dr.dz = dz;
      const n = this.plane!.normal;
      this.gimbal?.setCenter([dr.origin[0] + n[0] * dz, dr.origin[1] + n[1] * dz, dr.origin[2] + n[2] * dz]);
      const now = dr.pts.length === 1 ? dr.pts[0].z0 + dz : dz;
      this.app.ui.setLabel(p.x, p.y, dr.pts.length === 1 ? `${fmtLen(now)} off the plane` : `${dz >= 0 ? "+" : ""}${fmtLen(dz)}`);
      return;
    }
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
    // (Points of a spline up off the plane: the gimbal stays up there with them as they slide.)
    const lift = this.liftable();
    const up = lift ? lift.reduce((s, q) => s + q.z0, 0) / lift.length : 0;
    const nrm = this.plane!.normal;
    const flat = sketchToWorld(this.plane!, [c[0] + d[0], c[1] + d[1]]).toArray() as Vec3;
    this.gimbal?.setCenter([flat[0] + nrm[0] * up, flat[1] + nrm[1] * up, flat[2] + nrm[2] * up]);
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

  /** Only points of splines picked (no curve, no other point): those can go off the plane. Each with its height now. */
  private liftable(): { e: string; i: number; z0: number }[] | null {
    if (this.selected.size || !this.selPts.length) return null;
    const out: { e: string; i: number; z0: number }[] = [];
    for (const r of this.selPts) {
      const e = this.entities.find((x) => x.id === r.e);
      const m = /^k(\d+)$/.exec(r.p);
      // (Not a curve that follows a body's edge: that one is where the edge is.)
      if (e?.kind !== "spline" || !m || e.id.startsWith(LINKED)) return null;
      const i = Number(m[1]);
      if (i >= e.points.length) return null;
      out.push({ e: e.id, i, z0: splineHeights(e)?.[i] ?? 0 });
    }
    return out;
  }

  /** Those points `dz` higher than they began (shown as it goes; kept when the drag ends, or at once with `keep`). */
  private liftPoints(pts: { e: string; i: number; z0: number }[], dz: number, keep = false): void {
    if (!this.sketchId) return;
    const base = this.dragBase ?? this.entities;
    if (!keep) this.dragBase ??= base;
    const next = base.map((e) => {
      const mine = pts.filter((q) => q.e === e.id);
      if (e.kind !== "spline" || !mine.length) return e;
      const z = e.z && e.z.length === e.points.length ? [...e.z] : e.points.map(() => 0);
      for (const q of mine) z[q.i] = Math.round((q.z0 + dz) * 1e9) / 1e9;
      // (All of it back on the plane: a flat spline again, as it was drawn.)
      const { z: _was, ...flat } = e;
      return z.some((v) => Math.abs(v) > 1e-12) ? { ...e, z } : (flat as SketchEntity);
    });
    if (keep) return this.commit(next);
    const id = this.sketchId;
    this.app.store.transient((doc) => {
      const f = doc.features.find((x) => x.id === id);
      if (f?.type === "sketch") f.entities = next;
    });
  }

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
      // (The copy keeps what held its curves together: joined corners, level and upright lines, sizes.)
      const all = [...base, ...copies];
      this.commit(all, [...this.constraints, ...copiedConstraints(this.constraints, new Map(moved.map((e, i) => [e.id, copies[i].id])), all, uid)]);
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
      this.clearQuick();
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
    // Points of a spline: the arrow off the plane too, and the gimbal where they are (up off the plane with them).
    const lift = this.liftable();
    if (this.gimbal && this.gimbalLifts !== !!lift) {
      this.gimbal.dispose();
      this.gimbal = null;
      this.copyToggle?.dispose();
      this.copyToggle = null;
    }
    // (Said once as the arrow comes: seen straight on, it points at the eye and can't be dragged.)
    if (lift && !this.gimbalLifts) this.setHint("A spline's point can leave the plane: turn the view and drag the third arrow, or type its Height.");
    else if (!lift && this.gimbalLifts) this.setHint();
    this.gimbalLifts = !!lift;
    this.gimbal ??= new Gimbal(this.app.view, { axes: [plane.xDir, planeY(plane), plane.normal], parts: lift ? (p) => IN_PLANE(p) || (p.kind === "axis" && p.i === 2) : IN_PLANE });
    const g = this.gimbal;
    this.copyToggle ??= new CopyToggle(this.app.view, () => g.origin);
    const up = lift ? lift.reduce((s, q) => s + q.z0, 0) / lift.length : 0;
    const centre = sketchToWorld(plane, c).toArray() as Vec3;
    const at: Vec3 = [centre[0] + plane.normal[0] * up, centre[1] + plane.normal[1] * up, centre[2] + plane.normal[2] * up];
    this.gimbal.setCenter(at);
    this.showQuick(at);
  }

  /** Quick actions beside the picked curves and points (the gimbal moves them): Construction / Regular, Delete. */
  private quick: QuickActions | null = null;
  private quickSig = "";

  private showQuick(at: Vec3): void {
    // (Switched off in Settings: none - nor are the constraints that fit worked out each time the gimbal is placed.)
    if (!settings.value.quickButtons) return this.clearQuick();
    const sel = this.entities.filter((e) => this.selected.has(e.id));
    const cons = sel.length > 0 && sel.every((e) => e.construction);
    // (Made again only when the pick, its type or its place changed: this runs while it is dragged.)
    // (And when a constraint is put on or taken off: its button's list says which are on.)
    const sig = `${[...this.selected].join()}|${this.selPts.map((r) => r.e + r.p).join()}|${cons}|${at.map((v) => v.toFixed(4)).join()}|${this.constraints.map((c) => c.id).join()}`;
    if (sig === this.quickSig && this.quick) return;
    this.clearQuick();
    this.quickSig = sig;
    // The constraints that fit what is picked (the same as on the line), a tap away beside it.
    const chips = this.constraintChips().flatMap((p) => (p.type === "chips" ? p.chips : []));
    const constraints: ToolItem[] = chips.length
      ? [{ id: "constraints", label: "Constraints", icon: "constraints", children: chips.map((c, i): ToolItem => ({ id: `constraint-${i}`, label: c.label, icon: "constraints", glyph: c.glyph, active: !!c.on, run: () => c.onClick() })) }]
      : [];
    const items: ToolItem[] = [
      ...(sel.length ? [{ id: "construction", label: cons ? "Regular" : "Construction", icon: cons ? "line" : "lineDashed", run: () => this.toggleConstruction() } as ToolItem] : []),
      ...constraints,
      { id: "delete", label: "Delete", icon: "trash", run: () => this.deleteSelected() },
    ];
    this.quick = QuickActions.show(this.app.view, sel.length ? "curve" : "point", items, at, { gap: 110 });
  }

  private clearQuick(): void {
    this.quick?.dispose();
    this.quick = null;
    this.quickSig = "";
  }

  /** Quick buttons switched on or off in Settings: the ones beside what is picked are made again, or go. */
  quickSwitched(): void {
    this.clearQuick();
    this.refreshGimbal();
    const sel = this.regionArrow?.sel;
    const src = sel && sourcesOf(this.app, sel)[0];
    if (sel && src) this.showRegionQuick(sel, src, sourceFrame(this.app, src));
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
    // Whatever the box touches is picked - a curve does not have to be all inside it.
    const cuts = (p: [number, number], q: [number, number]): boolean => {
      // (A piece of a curve crosses the box when it crosses one of its four sides.)
      const side = (ax: number, ay: number, bx: number, by: number) => {
        const d = (q[0] - p[0]) * (by - ay) - (q[1] - p[1]) * (bx - ax);
        if (Math.abs(d) < 1e-12) return false;
        const s = ((ax - p[0]) * (by - ay) - (ay - p[1]) * (bx - ax)) / d;
        const u = ((ax - p[0]) * (q[1] - p[1]) - (ay - p[1]) * (q[0] - p[0])) / d;
        return s >= 0 && s <= 1 && u >= 0 && u <= 1;
      };
      return side(x0, y0, x1, y0) || side(x1, y0, x1, y1) || side(x1, y1, x0, y1) || side(x0, y1, x0, y0);
    };
    const touched = (poly: Vec2[]): boolean => {
      const s = poly.map((q) => this.app.view.toScreen(sketchToWorld(this.plane!, q)));
      if (poly.some(inside)) return true;
      for (let i = 0; i + 1 < s.length; i++) if (s[i] && s[i + 1] && cuts(s[i] as [number, number], s[i + 1] as [number, number])) return true;
      return false;
    };
    const picked = this.entities.filter((e) => entityPolylines(e).some(touched)).map((e) => e.id);
    if (!add) {
      this.selected.clear();
      this.selPts = [];
    }
    for (const id of picked) if (!this.selected.has(id)) (this.selected.add(id), this.pickSeq.set(id, ++this.seq));
    this.selectionChanged();
  }

  /** Ctrl + A: every curve of the sketch (the drawing tool put down for Select, nothing half drawn). */
  selectAll(): boolean {
    if (this.phase !== "draw" || !this.plane || !this.entities.length) return false;
    if (this.pts.length) this.resetDrawing();
    if (this.kind !== "select" && !this.isSelectionTool()) this.setKind("select");
    this.selPts = [];
    for (const e of this.entities) if (!this.selected.has(e.id)) (this.selected.add(e.id), this.pickSeq.set(e.id, ++this.seq));
    this.selectionChanged();
    return true;
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
      this.edit.offsetOf = this.edit.offsetEdge = this.edit.extendFrom = this.edit.alignFrom = this.edit.filletFrom = undefined;
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
    // A double tap on something drawn, with the sketch seen at a slant: the view turns to face the sketch.
    if (count === 2 && this.plane && !this.pts.length && this.curveAt(p)) {
      const d = this.app.view.cam.viewDir();
      const n = this.plane.normal;
      if (Math.abs(d.x * n[0] + d.y * n[1] + d.z * n[2]) < 0.999) this.app.view.cam.lookAlong(n, this.plane.xDir);
    }
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
      case "fill": {
        // Inside a closed shape: it is filled at once, as the pattern is set now - one tap, and its sizes can be
        // changed after. (It took a second tap, on Apply, for the pattern to stay.) One with a pattern already:
        // that pattern, to change.
        const uv = this.uvAt(p);
        const region = uv && this.fillRegionAt(uv);
        if (!uv || !region) return void this.app.ui.toast("Tap inside a closed shape");
        const had = (this.sketch?.fills ?? []).find((f) => this.fillRegionAt(f.at)?.index === region.index);
        if (had) {
          // (Its sizes as shares of the shape: one made in mm is shown as what that comes to.)
          const k = had.rel ? 1 : 1 / fillUnit(region);
          Object.assign(fillMemory, { kind: had.kind, spacing: had.spacing * k, angle: had.angle, size: had.size * k, rel: true });
          this.fillAt = had.at;
          this.fillId = had.id;
          this.updatePanel();
          this.refreshPreview();
          return this.setHint("Change its pattern or its sizes: it follows at once. Or Remove pattern.");
        }
        this.fillAt = uv;
        this.fillId = uid();
        // (Not put in - too fine, or nothing fits: said, and it is this shape's still, once a size is changed.)
        if (!this.applyFill()) (this.updatePanel(), this.refreshPreview());
        return;
      }
      case "offset":
        // The face's own edge too (it isn't a curve of the sketch the view picks) -
        // also when an offset of it made before runs close by and the tap is
        // nearer the edge (a second lip line 2 mm further in).
        {
          // (Edge, with an offset set up: another edge tapped goes with it.)
          if (this.addOffsetEdge(p)) return;
          const c = this.curveAt(p);
          const o = this.outlineAt(p);
          const link = c?.id.startsWith("lnk-") ? this.boundary.find((x) => x.id === c.id) : undefined;
          const nearer = o && link && o.d <= Math.min(...entityPrims(link).map((pr) => closestOnPrim(pr, o.uv).d));
          if (o && (!c || nearer)) {
            this.edit.offsetMore = undefined;
            this.edit.offsetAt = o.uv;
            this.edit.offsetOf = o.e.id;
            memory.offset = this.inward(Math.abs(defaultOffset(o.e)));
            const under = this.app.view.pick(p.x, p.y, { profiles: false, planes: false, axes: false, curves: false, edgeTolPx: p.tol });
            this.outlineEdge = under?.kind === "edge" ? { body: under.body, edge: under.edge } : null;
            this.lightEdges(this.outlineEdge);
            this.edit.offsetEdge = undefined;
            this.updatePanel();
            this.refreshPreview();
            return;
          }
          // An edge of a body that is no curve of this sketch (the sketch is on a plane, or the edge is another
          // face's): tapped, it is offset all the same - its curve comes in as a dashed guide that follows it.
          // (Its dashed guide from an offset made before counts as the edge, not as a curve of the sketch.)
          if (!c || this.entities.some((e) => e.id === c.id && e.construction)) {
            const hit = this.app.view.pick(p.x, p.y, { profiles: false, planes: false, axes: false, curves: false, edgeTolPx: p.tol });
            if (hit?.kind === "edge") return this.offsetFromEdge({ body: hit.body, edge: hit.edge }, this.uvAt(p) ?? undefined);
          }
        }
        return this.tapCurve(p, (id, uv) => {
          this.edit.offsetMore = undefined;
          // An offset of the face's edge, offset again: another offset of that same edge, this much further from it
          // - it follows the face too. (It was
          // refused: "an offset of the face's edge already".)
          if (id.startsWith("lnk-")) {
            const link = this.sketch?.outlineOffsets?.find((l) => id.startsWith(`lnk-${l.id}-`));
            const e = this.boundary.find((x) => x.id === id);
            if (!link || !e) return this.app.ui.toast("That line can't be offset here");
            this.edit.offsetLink = link;
            this.edit.offsetOf = id;
            this.edit.offsetAt = uv;
            this.edit.offsetEdge = this.edit.offsetGrip = undefined;
            // (Further from the edge, the way the first offset went.)
            memory.offset = (link.distance < 0 ? -1 : 1) * Math.abs(defaultOffset(e));
            this.lightEdges(null);
            this.updatePanel();
            this.refreshPreview();
            return this.setHint("Another offset of the same edge: set how much further, then Apply. Flip: the other side.");
          }
          // The face's own edge: its whole outline, offset inward to start, and
          // linked - it's made again from the face when the face changes.
          if (id.startsWith("bnd-")) {
            const e = this.outline.find((x) => x.id === id);
            this.edit.offsetAt = uv;
            this.edit.offsetOf = id;
            if (e) memory.offset = this.inward(Math.abs(defaultOffset(e)));
          } else {
            // A tenth of the curve tapped (keeping the side it went last time).
            const e = this.entities.find((x) => x.id === id);
            if (e) memory.offset = (memory.offset < 0 ? -1 : 1) * defaultOffset(e);
            this.edit.offsetGrip = uv;
          }
          this.edit.offsetOf = id;
          this.edit.offsetEdge = undefined;
          this.lightEdges(null);
          this.updatePanel();
          this.refreshPreview();
          if (memory.offsetMode === "edge") this.setHint("Set the distance (Flip for the other side). Tap more edges to offset them with it; then the tick.");
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
      const box = document.querySelector<TextField>("#panel .text-input");
      if (box && document.activeElement !== box) {
        if (e.key.length === 1) {
          if (!this.textTyped) box.value = "";
          box.value += e.key;
          this.textTyped = true;
          this.text = box.value;
          this.refreshPreview();
          box.focus();
          caretToEnd(box);
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
      // (Tab alone moves on to the next size, as it does once something is typed: the tags by the pointer show which.)
      const routed = this.typing.active || starts || (k === "enter" && this.typedThisShape) || (k === "tab" && keys.length > 1);
      if (routed) {
        const key = keys[this.lockIndex];
        this.typedThisShape = true;
        const used = this.typing.key(e, {
          kind: key === "ang" || key === "a0" || key === "a1" ? "angle" : key === "sides" ? "number" : "length",
          show: key === "len" && this.lineDim ? (text, bad) => this.lineDim?.setText(text, bad) : this.tagsShown ? () => (this.app.ui.setLabel(0, 0, null), this.updateSizeTags(this.lockedCursor())) : undefined,
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
          // (Round and round: Tab on the last size goes back to the first.)
          next: () => (keys.length > 1 ? ((this.lockIndex = (this.lockIndex + 1) % keys.length), true) : false),
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
      this.linkPlane(hit.id);
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
    if (hit.kind === "plane") this.app.ui.toast(`Sketching on ${hit.id === "XY" ? "XY (floor)" : hit.id === "XZ" ? "XZ (front)" : hit.id === "YZ" ? "YZ (side)" : (this.app.store.features.find((f) => f.id === hit.id)?.name ?? "the plane")}`);
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
    // An arc's bend being placed, an end of it on a line's end: the bend that runs smoothly on from that line.
    for (const t of this.arcTangents()) loci.push({ kind: "circle", c: t.c, r: t.r, label: "Tangent", tan: { curve: t.curve, ok: t.ok }, show: t.show });
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
      // (The other half of a tangent circle is the arc doubling back along its line.)
      if (L.kind === "circle" && L.tan && !L.tan.ok(q)) continue;
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
    const rank = (n: (typeof near)[number]) => n.d - (n.L.kind === "circle" && n.L.tan ? 4 : n.L.kind === "circle" || (n.L.kind === "line" && n.L.seg) ? 2 : 0);
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
    // Landed on a tangent bend that is the other line's tangent bend too (both ends as far from the corner: a
    // true round): tangent to both.
    if (used.some((n) => n.L.kind === "circle" && n.L.tan))
      for (const n of near) {
        const L = n.L;
        if (used.includes(n) || L.kind !== "circle" || !L.tan) continue;
        if (Math.abs(Math.hypot(out.uv[0] - L.c[0], out.uv[1] - L.c[1]) - L.r) < L.r * 1e-6 && L.tan.ok(out.uv)) used.push(n);
      }
    // Grid along a straight-across guide (and everywhere when there's none).
    if (s.grid && used.length < 2) {
      // The grid's own squares, as they are drawn (the smallest at least a fingertip's 8 px wide): what is seen is
      // what is snapped to. (It went to a finer lattice than the lines shown.)
      const step = view.grid.step;
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
      if (L.kind === "circle" && L.show) out.guides!.push(L.show);
      if (L.kind === "circle" && L.tan) out.tan = [...(out.tan ?? []), L.tan.curve];
    }
    return out;
  }

  /**
   * A three-point arc with both ends placed, an end of it on the end of a line: the one bend that runs smoothly on
   * from that line (the circle through both ends that touches the line there). Its centre and radius, the middle
   * of the arc, a stretch of the line carried on (to show what it is tangent to), and whether a point of the
   * circle is on the arc's side of it (the other side would double back along the line).
   */
  private arcTangents(): { curve: string; c: Vec2; r: number; m: Vec2; show: [Vec2, Vec2]; ok(q: Vec2): boolean }[] {
    if (this.kind !== "arc" || memory.arc !== "3pt" || this.pts.length !== 2) return [];
    const out: ReturnType<SketchTool["arcTangents"]> = [];
    const ends: [PointRef | null, Vec2, Vec2][] = [
      [this.startRef, this.pts[0], this.pts[1]],
      [this.secondRef, this.pts[1], this.pts[0]],
    ];
    for (const [ref, P, Q] of ends) {
      if (!ref || (ref.p !== "a" && ref.p !== "b")) continue;
      const line = this.entities.find((e) => e.id === ref.e);
      if (line?.kind !== "line") continue;
      const far = ref.p === "a" ? line.b : line.a;
      const len = Math.hypot(P[0] - far[0], P[1] - far[1]);
      if (len < 1e-9) continue;
      // The line's direction, on through its end.
      const d: Vec2 = [(P[0] - far[0]) / len, (P[1] - far[1]) / len];
      const n: Vec2 = [-d[1], d[0]];
      const w: Vec2 = [Q[0] - P[0], Q[1] - P[1]];
      const chord = Math.hypot(w[0], w[1]);
      const across = w[0] * n[0] + w[1] * n[1];
      // (The other end straight ahead on the line: no arc, a straight line.)
      if (chord < 1e-9 || Math.abs(across) < chord * 1e-6) continue;
      const t = (chord * chord) / (2 * across);
      const c: Vec2 = [P[0] + n[0] * t, P[1] + n[1] * t];
      const r = Math.abs(t);
      // Which way round the arc goes: leaving P along the line's direction.
      const turn = Math.sign((P[0] - c[0]) * d[1] - (P[1] - c[1]) * d[0]) || 1;
      const aP = Math.atan2(P[1] - c[1], P[0] - c[0]);
      const swept = (q: Vec2) => {
        const a = (Math.atan2(q[1] - c[1], q[0] - c[0]) - aP) * turn;
        return ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      };
      const whole = swept(Q);
      const am = aP + (turn * whole) / 2;
      out.push({
        curve: line.id,
        c,
        r,
        m: [c[0] + r * Math.cos(am), c[1] + r * Math.sin(am)],
        show: [P, [P[0] + d[0] * chord * 0.6, P[1] + d[1] * chord * 0.6]],
        ok: (q) => {
          const a = swept(q);
          return a > whole * 0.02 && a < whole * 0.98;
        },
      });
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
      const len = L.len ?? Math.hypot(c[0] - a[0], c[1] - a[1]);
      if (L.ang !== undefined) return along(a, L.ang, len);
      const ang = Math.atan2(c[1] - a[1], c[0] - a[0]);
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
        if (L.len !== undefined) len = L.len;
        if (L.ang !== undefined) return along(last, L.ang, len);
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
        const af = this.kind === "polygon" && L.af !== undefined ? L.af / (2 * Math.cos(Math.PI / memory.sides)) : undefined;
        if (L.r === undefined && af === undefined) return c;
        // A circle's typed size is its diameter; a polygon's, its radius (or across its flats).
        // (Circle by two points: the second point is the diameter away.)
        const r = af ?? (this.kind === "circle" ? (memory.circle === "2pt" ? L.r! : L.r! / 2) : L.r!);
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
        // Closed: it ends on the first point itself (not 3e-15 off it, as a typed 180° left it).
        if (closes) pt = [...start] as Vec2;
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
        // Ending on a point already drawn (another curve's end): if that closes a
        // shape - one drawn in pieces, after an arc, or carried on from an end
        // after a stop - the line tool lets go too, as closing on its own first
        // point does. (It kept drawing: the next tap meant to turn the view
        // started another line.)
        const regionsBefore = !closes && this.sketchId && (snapRef ?? this.typedEndOn(pt, id)) ? arrangement(this.app.sketchCurves(this.sketchId)).regions.length : -1;
        this.commitAdd([{ id, kind: "line", a, b: pt }], cs);
        this.lastLineId = id;
        this.chainFirstId ??= id;
        // Closing the chain on its first point ends it.
        // The outline closed: the drawing tool lets go (Select), so the next drag turns the view.
        if (closes || (this.pts.length > 1 && samePt(pt, start))) return this.shapeClosed();
        if (regionsBefore >= 0 && this.sketchId && arrangement(this.app.sketchCurves(this.sketchId)).regions.length > regionsBefore) return this.shapeClosed();
        // Touch: its length in a box right away, for the numpad.
        // (A pen too, numpad or not: tap the line's end, then type its length.)
        if ((settings.value.numpad || this.pen) && this.locks.len === undefined) queueMicrotask(() => this.showLineBox(id));
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
          // (Typed across its flats: kept as the radius that makes it.)
          if (e.kind === "polygon" && L.r === undefined && L.af !== undefined) cs.push({ id: uid(), type: "dim", curves: [e.id], prop: "radius", value: e.radius });
          if (e.kind === "ellipse") (dim("dx", "rx"), dim("dy", "ry"));
          this.lockExprs = {};
          // A centre placed on an existing point stays on it.
          const centred = (e.kind === "circle" && memory.circle === "center") || e.kind === "polygon" || e.kind === "ellipse" || (e.kind === "rect" && memory.rect === "center") || (e.kind === "arc" && memory.arc === "center");
          if (settings.value.autoConstrain && centred && this.startRef) {
            cs.push({ id: uid(), type: "coincident", pts: [{ e: e.id, p: "c" }, this.startRef] });
          } else if (centred && e.kind !== "rect") cs.push(...this.snapKeeps(this.startSnap, { e: e.id, p: "c" }));
          // The centre's X / Y typed with a variable (a handle at "Ws/2 - S/2"):
          // held there, and it follows the variable (it was worked out once and forgotten).
          const c0 = this.pts[0];
          const atExpr = [0, 1].map((i) => {
            const x = this.firstExprs[i];
            return x && Math.abs(x.v - c0[i]) < 1e-9 ? x.text : null;
          });
          if (centred && atExpr.some((x) => x)) cs.push({ id: uid(), type: "fix", pts: [{ e: e.id, p: "c" }], at: [c0[0], c0[1]], atExpr });
          this.firstExprs = [];
          // An arc between two points it was tapped on stays joined to them (it
          // came loose when its radius was typed: nothing tied its ends).
          if (e.kind === "arc" && memory.arc === "3pt" && settings.value.autoConstrain) {
            if (this.startRef) cs.push({ id: uid(), type: "coincident", pts: [{ e: e.id, p: "a" }, this.startRef] });
            if (this.secondRef) cs.push({ id: uid(), type: "coincident", pts: [{ e: e.id, p: "b" }, this.secondRef] });
            // Bent to run smoothly on from a line (the Tangent snap): it stays that way.
            for (const curve of new Set(this.cursor?.tan ?? [])) cs.push({ id: uid(), type: "tangent", curves: [curve, e.id] });
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
    if (k === "rect" || k === "circle" || k === "polygon" || k === "ellipse") this.setHint();
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
    if (this.kind === "fill" && this.fillAt) return void this.applyFill();
    if (this.isSelectionTool() && this.selected.size) return this.applyTransform();
    // A size typed: placed as Done would (the first point typed on a phone
    // leaves no pointer to go by - the shape went, before).
    if (this.pts.length && Object.keys(this.locks).length) return this.finishTyped();
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
    // (And the guide says so: Exit, pulsing, is next.)
    this.setHint();
  }

  /** Exit Sketch pulsing: a shape was just closed, nothing drawn since. */
  private exitPulse = false;

  /** The sketch whose shape was just closed (nothing drawn since): left now, that shape is the one to pull into 3D. */
  get justClosed(): string | null {
    return this.exitPulse && this.sketchId ? this.sketchId : null;
  }

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
    this.edit.offsetOf = this.edit.offsetEdge = this.edit.offsetGrip = this.edit.offsetMore = undefined;
    this.lightEdges(null);
    this.dropOffsetGrip();
    this.edit.extendFrom = this.edit.alignFrom = undefined;
    this.edit.filletFrom = undefined;
    this.cancelFillet();
    this.clearPreviewJoin();
    this.clearOverlays();
    this.hideLineDim();
    this.hideSizeTags();
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
    this.placeOffsetGrip();
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
      // Arc, both ends placed: the bends that run smoothly on from the lines it ends on, dashed - where to aim.
      if (this.kind === "arc" && this.pts.length === 2) {
        const [a, b] = this.pts;
        const tangents = this.arcTangents().map((t, i): SketchEntity => ({ id: `arc-tangent-${i}`, kind: "arc", a, m: t.m, b }));
        if (tangents.length) this.drawGhosts(tangents, yellow, true);
      }
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
    // The points a shape has so far, each a yellow dot: on a phone a rectangle's centre was not shown once the finger
    // came up (the dot went with the finger, and nothing else was drawn till the next tap).
    if (["arc", "rect", "circle", "polygon", "ellipse", "spline"].includes(this.kind) && this.pts.length) {
      const m = new Points(new BufferGeometry().setFromPoints(this.pts.map((q) => sketchToWorld(this.plane!, q, 0.015))), dotMaterial({ color: 0xffc23d, size: 10 }));
      m.renderOrder = 10;
      this.addOverlay(m);
    }
    if (this.kind === "text" && this.pts.length) {
      void textEntities(this.text || " ", this.pts[0], memory.textSize, 0, memory.textFont, memory.textAlign).then((es) => {
        if (this.kind !== "text" || !this.pts.length) return;
        this.drawGhosts(es);
      });
    }
    if (this.kind === "offset" && this.edit.offsetOf) ghosts.push(...this.offsetResult());
    if (this.kind === "fill" && this.fillHot) this.drawRegion(this.fillHot);
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
    if (settings.value.showGuidePoints && this.kind !== "fill") {
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
      case "af":
        return 2 * Math.hypot(c[0] - a[0], c[1] - a[1]) * Math.cos(Math.PI / memory.sides);
      case "rx":
        return 2 * Math.hypot(c[0] - a[0], c[1] - a[1]);
      case "ry":
        return e?.kind === "ellipse" ? 2 * e.ry : undefined;
    }
    return undefined;
  }

  /** The card's size fields, as the pointer moves: what each would be (a typed one stays). */
  private updateLiveValues(c: Vec2 | null): void {
    this.updateSizeTags(c);
    if (!this.liveKeys.some((k) => k)) return;
    this.app.ui.updatePanelValues(this.liveKeys.map((k) => (k ? (this.locks[k] ?? this.liveValue(k, c)) : undefined)) as number[]);
  }

  // ------------------------------------------------------------ size tags
  // The sizes of the shape being drawn, in small tags by the pointer (a mouse, or a pen hovering): what each is
  // now, the one a typed number goes to lit, a typed one held. They take no taps (the click under them
  // places the point). A line has its own length box along it instead (see showLineDim).
  private liveLabels = new Map<string, { label: string; angle: boolean }>();
  private tagAt: { x: number; y: number } | null = null;
  private sizeTags: HTMLDivElement | null = null;
  private sizeTagsKey = "";

  private hideSizeTags(): void {
    this.sizeTags?.remove();
    this.sizeTags = null;
    this.sizeTagsKey = "";
  }

  /** The sizes that can be typed for the shape as it is now: shown by the pointer? (Not a line's: its box is on it.) */
  private get tagsShown(): boolean {
    const keys = this.lockKeys();
    // (Not in the tutorial: its sizes are set for the learner, and a tag would sit over the lit spot.)
    return this.phase === "draw" && this.pts.length > 0 && !!this.tagAt && !this.dragging && keys.length > 0 && keys[0] !== "len" && !document.body.classList.contains("tut-on");
  }

  private updateSizeTags(c: Vec2 | null): void {
    if (!this.tagsShown || !c) return this.hideSizeTags();
    const keys = this.lockKeys();
    const active = keys[Math.min(this.lockIndex, keys.length - 1)];
    const parts = keys.map((key) => {
      const info = this.liveLabels.get(key) ?? { label: key === "sides" ? "Sides" : key, angle: false };
      const v = key === "sides" ? memory.sides : (this.locks[key] ?? this.liveValue(key, c));
      const typing = key === active && this.typing.active;
      const text = typing ? `${this.typing.text}▌` : v === undefined ? "" : key === "sides" ? String(v) : info.angle ? `${+v.toFixed(2)}°` : fmtLen(v);
      return { key, label: info.label, text, on: key === active, held: key in this.locks };
    });
    // Drawn again only when what it says changed (it is asked for on every move of the pointer).
    const sig = JSON.stringify(parts);
    if (!this.sizeTags) {
      this.sizeTags = document.createElement("div");
      this.sizeTags.className = "size-tags";
      document.body.append(this.sizeTags);
      this.sizeTagsKey = "";
    }
    if (sig !== this.sizeTagsKey) {
      this.sizeTagsKey = sig;
      this.sizeTags.replaceChildren(
        ...parts.map((part) => {
          const tag = document.createElement("span");
          tag.className = `size-tag${part.on ? " on" : ""}${part.held ? " held" : ""}`;
          const name = document.createElement("i");
          name.textContent = part.label;
          const value = document.createElement("b");
          value.textContent = part.text;
          tag.append(name, value);
          return tag;
        }),
      );
      if (keys.length > 1) {
        const tab = document.createElement("span");
        tab.className = "size-tab";
        tab.textContent = "Tab";
        this.sizeTags.append(tab);
      }
    }
    // Below right of the pointer; the other side of it where that runs off the screen.
    const r = this.app.view.canvas.getBoundingClientRect();
    const w = this.sizeTags.offsetWidth;
    const h = this.sizeTags.offsetHeight;
    let x = r.left + this.tagAt!.x + 20;
    let y = r.top + this.tagAt!.y + 18;
    if (x + w > innerWidth - 8) x = r.left + this.tagAt!.x - 20 - w;
    if (y + h > innerHeight - 8) y = r.top + this.tagAt!.y - 18 - h;
    this.sizeTags.style.transform = `translate(${Math.round(Math.max(8, x))}px, ${Math.round(Math.max(8, y))}px)`;
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
  /** The last pointer was a pen (it hovers: see showLineDim). */
  private pen = false;

  /** Length of the line being drawn: dimension line with arrows + a box you can type into. */
  private showLineDim(a: Vec2, b: Vec2): void {
    const plane = this.plane!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-9) return this.hideLineDim();
    // A pen hovering on to the next point: the box of the line just placed
    // stays to type in (it went the moment the pen moved) - the next line's
    // length is typed once it's placed, the same way.
    if (this.pen && this.kind === "line" && this.lineBox && !this.dragging) return this.hideLineDim();
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

  private addOverlay(o: Line | Points | Mesh): void {
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
    if (k === "fill") return "Fill Pattern";
    return titleOf(k);
  }

  /**
   * The tutorial's: the circle or polygon drawn last put exactly where it was meant - its middle at `centre`, its
   * rim (a corner, of a polygon) at `edge`, both in the model's space. What the taps tied it to is let go: it is
   * where it is by its numbers.
   */
  exact(kind: "circle" | "polygon", centre: Vec3, edge: Vec3): void {
    if (!this.plane) return;
    const e = [...this.entities].reverse().find((x) => x.kind === kind);
    if (!e || (e.kind !== "circle" && e.kind !== "polygon")) return;
    const c = toPlane(this.plane, centre);
    const b = toPlane(this.plane, edge);
    const radius = Math.hypot(b[0] - c[0], b[1] - c[1]);
    const angle = Math.atan2(b[1] - c[1], b[0] - c[0]);
    const turn = e.kind === "polygon" ? Math.abs(Math.sin((e.angle - angle) * e.sides * 0.5)) : 0;
    if (Math.hypot(e.center[0] - c[0], e.center[1] - c[1]) < 1e-9 && Math.abs(e.radius - radius) < 1e-9 && turn < 1e-9) return;
    const next: SketchEntity = e.kind === "polygon" ? { ...e, center: c, radius, angle } : { ...e, center: c, radius };
    this.commit(
      this.entities.map((x) => (x.id === e.id ? next : x)),
      this.constraints.filter((k) => !JSON.stringify(k).includes(e.id)),
    );
  }

  /** An edit that changed curves: their constraints follow (or go, where they no longer hold). */
  private commitEdit(entities: SketchEntity[]): void {
    this.commit(entities, carryConstraints(this.entities, entities, this.constraints));
  }

  private commit(entities: SketchEntity[], constraints: SketchConstraint[] = this.constraints, follow: EdgeLink[] = [], fills: SketchFill[] | undefined = this.sketch?.fills, repeats: SketchRepeat[] | undefined = this.sketch?.repeats): void {
    // (A pattern that follows a count, all its originals deleted: it is no more - its copies stay as plain curves.)
    if (repeats?.length) repeats = repeats.filter((r) => r.src.some((id) => entities.some((e) => e.id === id)));
    // The shapes change: a picked region's arrow would point at the old one.
    this.hideRegionArrow();
    // Fill patterns follow their shapes: made again when the sketch's own curves change (or the fills do).
    if (fills?.length || entities.some((e) => e.id.startsWith(FILL_PREFIX))) {
      const same = fills === this.sketch?.fills && JSON.stringify(withoutFills(entities)) === JSON.stringify(withoutFills(this.entities));
      if (!same) entities = refill(entities, fills);
    }
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
    // What the step made or changed, kept with its line in History: picked there, the sketch opens with those
    // curves picked, to change them.
    const was = new Map(this.entities.map((e) => [e.id, e]));
    const touched = entities.filter((e) => !was.has(e.id) || JSON.stringify(was.get(e.id)) !== JSON.stringify(e)).map((e) => e.id);
    // (A constraint or a size put on: the curves it is on.)
    const had = new Set(this.constraints.map((c) => c.id));
    for (const c of cs) if (!had.has(c.id)) touched.push(...refsOf(c));
    const keep = (ids: string[]) => [...new Set(ids)].filter((id) => entities.some((e) => e.id === id)).slice(-80);
    if (last?.op === op) {
      log[log.length - 1] = { op, n: last.n + 1, ids: keep([...(last.ids ?? []), ...touched]) };
      this.lastMade = [...this.lastMade, ...made];
    } else {
      log.push({ op, n: 1, ids: keep(touched) });
      this.lastMade = made;
    }
    // Curves that follow another sketch's: kept while they are as they were put (one reshaped here is its own curve).
    const wasNow = new Map(this.entities.map((e) => [e.id, e]));
    const refs = [...(this.sketch?.refs ?? []).filter((r) => wasNow.get(r.id) === entities.find((e) => e.id === r.id) || JSON.stringify(wasNow.get(r.id)) === JSON.stringify(entities.find((e) => e.id === r.id))), ...this.newRefs].filter((r) => entities.some((e) => e.id === r.id));
    this.newRefs = [];
    const patch = { entities, constraints: cs.length ? cs : undefined, log, links: links.length ? links : undefined, fills: fills?.length ? fills : undefined, repeats: repeats?.length ? repeats : undefined, refs: refs.length ? refs : undefined };
    if (this.sketchId && this.sketch) {
      store.update(this.sketchId, patch);
    } else {
      // (No plane yet: nothing stored - a sketch without one broke every project switch after it.)
      if (!this.plane) return;
      const f: SketchFeature = { ...(this.pending ?? store.newIdentity("sketch")), type: "sketch", plane: this.plane, attachedTo: this.attachedTo, onPlane: this.onPlane, ...patch };
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
      this.edit.extendFrom = this.edit.alignFrom = this.edit.filletFrom = this.edit.offsetOf = this.edit.offsetEdge = undefined;
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
        // (Where it is drawn: a spline's point may be up off the plane.)
        const up = (e && /^k\d+$/.test(hit.p) ? splineHeights(e)?.[Number(hit.p.slice(1))] : 0) ?? 0;
        const nrm = this.plane!.normal;
        const at = q && (sketchToWorld(this.plane!, q).toArray() as Vec3);
        const sc = at && this.app.view.toScreen([at[0] + nrm[0] * up, at[1] + nrm[1] * up, at[2] + nrm[2] * up]);
        return !sc || Math.hypot(sc[0] - p.x, sc[1] - p.y) < Math.max(10, p.tol * 0.7) || !this.curveAt(p);
      })();
      if (hit?.kind === "point" && hit.sketch === this.sketchId && onPoint) {
        const r = { e: hit.entity, p: hit.p };
        const i = this.selPts.findIndex((x) => refKey(x) === refKey(r));
        if (i >= 0) this.selPts.splice(i, 1);
        else (this.selPts.push(r), this.pickSeq.set(refKey(r), ++this.seq));
        // A point of a spline that is itself picked (it was picked to show its points): the pick is now that point,
        // not the whole curve with it - the gimbal moves the point (and can take it off the plane), not the curve.
        if (i < 0 && !p.shift && this.selected.has(r.e) && this.entities.find((x) => x.id === r.e)?.kind === "spline") this.selected.delete(r.e);
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
    // side): it used to clear the selection. A shape near the axis only wins
    // when the tap is right on it (a slot 5 from the axis, zoomed out, was let
    // go instead of mirrored).
    if (this.kind === "mirror" && this.selected.size && !p.shift && (!c || (count < 2 && !this.curveAt({ ...p, tol: p.tol * 0.4 })))) {
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
    // Each shape tapped joins the ones picked (one arrow pulls them all); tapped again, it leaves.
    const had = this.regionArrow?.sel ?? [];
    const same = had.some((x) => x.kind === "profile" && x.region === s.region);
    if (this.selected.size || this.selPts.length) this.clearSelection();
    const next = same ? had.filter((x) => !(x.kind === "profile" && x.region === s.region)) : [...had, s];
    if (!next.length) {
      this.hideRegionArrow();
      return true;
    }
    this.showRegionArrow(next);
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
    this.showRegionQuick(sel, src, fr);
  }

  /**
   * What the shape tapped can be made into, beside it: each leaves the sketch and starts on the shapes picked. With
   * Quick buttons switched off (Settings) there are none: the arrow pulls the shape up, the other three are under
   * Create once the sketch is left, and the guide text says so.
   */
  private showRegionQuick(sel: Sel[], src: ExtrudeSource, fr: { base: Vec3; normal: Vec3 }): void {
    const app = this.app;
    const start = (make: () => Tool) => () => {
      this.hideRegionArrow();
      app.setTool(make());
      app.setSelection(sel);
    };
    this.regionQuick?.dispose();
    this.regionQuick = QuickActions.of(
      app.view,
      [
        { id: "extrude", label: "Extrude", icon: "extrude", run: start(() => new ExtrudeOp(app, src, undefined, "auto", { distance: 0 })) },
        { id: "revolve", label: "Revolve", icon: "revolve", run: start(() => new RevolveOp(app, src)) },
        { id: "sweep", label: "Sweep", icon: "sweep", run: start(() => new SweepOp(app, src)) },
        { id: "loft", label: "Loft", icon: "loft", run: start(() => new LoftOp(app, sourcesOf(app, sel).flatMap(splitRegions), sel)) },
      ],
      fr.base,
      { facing: fr.normal, gap: 70 },
    );
    this.setHint(this.regionQuick ? "Drag the arrow to pull the shape into 3D, or pick what to make of it." : "Drag the arrow to pull the shape into 3D. Revolve, Sweep and Loft: tap Exit, then Create.");
  }

  /** The tools for the shape tapped in the sketch (Extrude, Revolve, Sweep, Loft), beside it. */
  private regionQuick: QuickActions | null = null;

  private hideRegionArrow(): void {
    this.regionQuick?.dispose();
    this.regionQuick = null;
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
    // (The body edges an offset is being made from stay lit with whatever is picked: the sketch draws its picks again
    // whenever it is rebuilt, and they went out the moment the edge's guide came in.)
    if (!this.sketchId) return void (this.offsetLit.length && this.app.setSelection(this.offsetLit));
    this.app.setSelection([
      ...[...this.selected].map((entity) => ({ kind: "curve" as const, sketch: this.sketchId!, entity })),
      ...this.selPts.map((r) => ({ kind: "point" as const, sketch: this.sketchId!, entity: r.e, p: r.p })),
      ...this.offsetPicked().map((entity) => ({ kind: "curve" as const, sketch: this.sketchId!, entity })),
      ...this.offsetLit,
    ]);
    // (Their constraints' marks stand out, and what those tie them to shows faintly.)
    this.glyphs?.setFocus(this.kind === "select" ? this.selected : []);
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

  /**
   * A pattern's copies, each tied to its original (in the order transformed()
   * makes them: every selected curve, once per step).
   */
  private patternLinks(results: SketchEntity[]): SketchConstraint[] {
    if (this.kind !== "patternLinear" && this.kind !== "patternCircular") return [];
    const sel = this.entities.filter((e) => this.selected.has(e.id));
    if (!sel.length) return [];
    const full = Math.abs(Math.abs(this.edit.patAngle) - 360) < 1e-6;
    const step = this.edit.patAngle / (full ? this.edit.count : Math.max(1, this.edit.count - 1));
    return results.map((e, i) => {
      const k = Math.floor(i / sel.length) + 1;
      const base = { id: uid(), type: "pattern" as const, curves: [sel[i % sel.length].id, e.id] };
      return this.kind === "patternLinear" ? { ...base, at: [this.edit.dx * k, this.edit.dy * k] as Vec2 } : { ...base, turn: true, at: this.edit.pivot ?? ([0, 0] as Vec2), value: step * k };
    });
  }

  private applyTransform(): void {
    if (!this.selected.size) return this.app.ui.toast("Select curves first");
    if (this.kind === "patternCircular" && !this.edit.pivot) return this.app.ui.toast("Tap the centre of the pattern first");
    if (this.kind === "mirror" && !this.edit.mirrorLine) return this.app.ui.toast("Pick the mirror line");
    let results = this.transformed(false);
    // (Each curve picked and what was made of it, in that order: a copy takes its original's constraints.)
    const from = this.entities.filter((e) => this.selected.has(e.id));
    const made = results;
    // Mirroring across one of the shape's own edges: that edge maps onto itself - don't double it.
    const ml = this.edit.mirrorLine;
    if (this.kind === "mirror" && ml) {
      const d: Vec2 = [ml[1][0] - ml[0][0], ml[1][1] - ml[0][1]];
      const L = Math.hypot(...d) || 1;
      const onAxis = (q: Vec2) => Math.abs((q[0] - ml[0][0]) * d[1] - (q[1] - ml[0][1]) * d[0]) / L < 1e-7 * Math.max(1, L);
      results = results.filter((e) => !(e.kind === "line" && onAxis(e.a) && onAxis(e.b)));
    }
    const keepOriginals = this.kind === "patternLinear" || this.kind === "patternCircular" || ((this.kind === "mirror" ? this.edit.mirrorCopy : this.edit.copy));
    // A copy exactly on a curve already there (the same mirror tapped twice) is not added again.
    if (keepOriginals) {
      const sig = (e: SketchEntity) => JSON.stringify({ ...e, id: undefined, construction: undefined }, (_k, v) => (typeof v === "number" ? Math.round(v * 1e6) / 1e6 + 0 : v));
      const there = new Set(this.entities.map(sig));
      results = results.filter((e) => !there.has(sig(e)));
      if (!results.length) return this.app.ui.toast("Those copies are there already");
    }
    // A pattern whose count was typed with a variable: kept with the sketch, its copies made again whenever the
    // count comes to another number (asked for: a sketch pattern's count from a variable).
    if ((this.kind === "patternLinear" || this.kind === "patternCircular") && this.edit.countExpr) {
      const rep: SketchRepeat = {
        id: uid(),
        src: this.entities.filter((e) => this.selected.has(e.id)).map((e) => e.id),
        kind: this.kind === "patternLinear" ? "linear" : "circular",
        count: this.edit.count,
        countExpr: this.edit.countExpr,
        ...(this.kind === "patternLinear" ? { step: [this.edit.dx, this.edit.dy] as Vec2 } : { at: this.edit.pivot ?? ([0, 0] as Vec2), angle: this.edit.patAngle }),
      };
      const repeats = [...(this.sketch?.repeats ?? []), rep];
      const made = applyRepeats(this.entities, this.constraints, repeats, true);
      if (made) this.commit(made.entities, made.constraints, [], undefined, repeats);
      this.app.ui.toast(`This pattern follows ${rep.countExpr}: change it, and the copies change`);
      this.refreshPreview();
      return;
    }
    // A pattern's copies stay linked to their originals: change one, and the copies follow.
    const links = this.patternLinks(results);
    // So do mirrored copies: each stays its original's mirror image across the line it was flipped over.
    if (this.kind === "mirror" && keepOriginals && ml) {
      const sel = this.entities.filter((e) => this.selected.has(e.id));
      const all = this.transformed(false);
      const sig = (e: SketchEntity) => JSON.stringify({ ...e, id: undefined });
      const kept = new Map(results.map((e) => [sig(e), e.id]));
      all.forEach((e, i) => {
        const id = kept.get(sig(e));
        const src = sel[i];
        if (id && src && e.kind === src.kind && e.kind !== "spline" && e.kind !== "polyline") links.push({ id: uid(), type: "follow", curves: [src.id, id], how: { mirror: [[ml[0][0], ml[0][1]], [ml[1][0], ml[1][1]]] } });
      });
    }
    const base = keepOriginals ? this.entities : this.entities.filter((e) => !this.selected.has(e.id));
    // A copy that stands by itself - moved, turned or scaled with Copy on - keeps what held its curves together:
    // joined corners, level and upright lines, sizes. (A pattern's copies and a mirror's follow their originals.)
    if (keepOriginals && (this.kind === "move" || this.kind === "rotate" || this.kind === "scale") && made.length === from.length) {
      const kept = new Set(results);
      const ids = new Map<string, string>();
      from.forEach((e, i) => kept.has(made[i]) && ids.set(e.id, made[i].id));
      links.push(...copiedConstraints(this.constraints, ids, [...base, ...results], uid));
    }
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
    this.commit([...base, ...results], [...cons, ...links]);
    if (this.kind === "scale") {
      this.refreshRefDim();
      this.updatePanel();
    }
    if (!keepOriginals) {
      this.selected = new Set(results.map((e) => e.id));
      this.showSelection();
    }
    // Mirrored as a copy: done with that shape - the next line tapped doesn't mirror it again, and the card says so.
    if (this.kind === "mirror" && keepOriginals) {
      this.clearSelection();
      this.edit.mirrorLine = undefined;
      this.updatePanel();
    }
    this.refreshPreview();
  }

  /** New curves the offset would add (one curve, or the whole chain in Chain mode). */
  /** Fill Pattern: a point in the shape tapped, and the fill being set there (a new one, or the shape's own). */
  private fillAt: Vec2 | null = null;
  private fillId: string | null = null;

  /** The fill as its values are now, and the curves that makes (null: no closed shape there any more). */
  private fillNow(): { fill: SketchFill; curves: SketchEntity[]; tooMany?: boolean } | null {
    if (!this.fillAt || !this.fillId) return null;
    const fill: SketchFill = { id: this.fillId, at: this.fillAt, ...fillMemory };
    const got = fillCurves(this.entities, fill);
    return got ? { fill, ...got } : null;
  }

  /**
   * The pattern put in the sketch (or taken out of it). It stays the one being set - a size changed next is its -
   * and the tool stays on for the next shape. False: it could not be put in (said why).
   */
  private applyFill(remove = false): boolean {
    const now = this.fillNow();
    const others = (this.sketch?.fills ?? []).filter((f) => f.id !== this.fillId);
    if (!remove) {
      if (!now) return this.app.ui.toast("That shape is no longer closed"), false;
      if (now.tooMany) return this.app.ui.toast("That is too fine: thousands of curves. Make the spacing bigger."), false;
      if (!now.curves.length) return this.app.ui.toast("Nothing fits in the shape at these sizes. Make them smaller."), false;
    }
    this.opLabel = remove ? "Remove pattern" : "Fill Pattern";
    this.commit(this.entities, this.constraints, [], remove ? others : [...others, now!.fill]);
    if (remove) this.fillAt = this.fillId = null;
    this.updatePanel();
    this.refreshPreview();
    this.setHint(remove ? "Pattern removed. Tap inside a closed shape to fill it." : "Filled. Change its pattern or sizes here, or tap another shape. Exit the sketch to extrude the strips.");
    return true;
  }

  /** Its pattern or one of its sizes changed: the shape being set is filled again at once (nothing to apply). */
  private fillChanged(): void {
    if (this.fillAt && this.applyFill()) return;
    this.updatePanel();
    this.refreshPreview();
  }

  /** Fill Pattern: the closed shape under the pointer (lit: a tap fills it). */
  private fillHot: Region | null = null;
  /** The sketch's closed shapes - its own curves, fills' left out - for the curves as they are (asked on every move of the pointer). */
  private fillShapes: { of: SketchEntity[]; regions: Region[] } | null = null;
  private fillRegionAt(uv: Vec2): Region | null {
    if (this.fillShapes?.of !== this.entities) this.fillShapes = { of: this.entities, regions: arrangement(withoutFills(this.entities)).regions };
    return regionAt(this.fillShapes.regions, uv);
  }

  /** A closed shape lit: tinted, its outline drawn over. */
  private drawRegion(r: Region): void {
    const plane = this.plane!;
    const loops = [r.outer.poly, ...r.holes.map((h) => h.poly)];
    const flat = (lift: number) => loops.flat().map((q) => sketchToWorld(plane, q, lift));
    const faces = ShapeUtils.triangulateShape(r.outer.poly.map((q) => new Vector2(q[0], q[1])), r.holes.map((h) => h.poly.map((q) => new Vector2(q[0], q[1]))));
    const geo = new BufferGeometry().setFromPoints(flat(0.012));
    geo.setIndex(faces.flat());
    const tint = new Mesh(geo, new MeshBasicMaterial({ color: 0x7fb2ff, transparent: true, opacity: 0.3, depthTest: false, side: DoubleSide }));
    tint.renderOrder = 8;
    this.addOverlay(tint);
    for (const loop of loops) {
      const line = new Line(new BufferGeometry().setFromPoints([...loop, loop[0]].map((q) => sketchToWorld(plane, q, 0.02))), new LineBasicMaterial({ color: 0x7fb2ff, depthTest: false }));
      line.renderOrder = 9;
      this.addOverlay(line);
    }
  }

  private offsetResult(): SketchEntity[] {
    const id = this.edit.offsetOf;
    // (Of the face's own outline: Edge is just the edge tapped, Chain the whole loop it is part of.)
    if (id?.startsWith("bnd-") && this.edit.offsetAt) {
      const also = this.offsetExtras().map((m) => m.at);
      return outlineOffsetCurves(this.outline, [{ id: "new", distance: memory.offset, at: this.edit.offsetAt, ...(memory.offsetMode === "edge" ? { single: true, ...(also.length ? { also } : {}) } : {}) }]);
    }
    // (Of an offset of the face's edge: that edge offset again, this much further than the first.)
    if (id?.startsWith("lnk-") && this.edit.offsetLink) {
      const first = this.edit.offsetLink;
      return outlineOffsetCurves(this.outline, [{ ...first, id: "new", distance: first.distance + memory.offset }]);
    }
    const src = this.entities.find((e) => e.id === id);
    if (!id || !src) return [];
    // (From a body's edge: the guide it is made from is dashed, the offset is a curve like any other.)
    const real = (es: SketchEntity[]) => (this.edit.offsetEdge ? es.map((e) => ({ ...e, construction: this.construction || undefined })) : es);
    if (memory.offsetMode === "chain" && (src.kind === "line" || src.kind === "arc" || (src.kind === "spline" && !src.closed) || (src.kind === "ellipse" && src.sweep !== undefined))) {
      // (A chain is walked along the sketch's own curves, not its dashed ones: the guides of this edge count as its own here.)
      const guides = new Set(this.edit.offsetEdge ? (this.edit.offsetGuides ?? []) : []);
      const pool = guides.size ? this.entities.map((e) => (guides.has(e.id) ? { ...e, construction: undefined } : e)) : this.entities;
      const all = offsetChain(pool, id, memory.offset);
      if (all) return real(all.slice(pool.length));
    }
    // Edge, with more edges tapped: all of them at this distance - those that join end to end as one run, their
    // corners kept (not the whole outline, as Chain takes).
    const more = this.offsetExtras().map((m) => this.entities.find((e) => e.id === m.id)).filter((e): e is SketchEntity => !!e);
    if (more.length) {
      const made = offsetSeveral([src, ...more], memory.offset);
      // (Dashed ones only: what is made of them is dashed too.)
      return [src, ...more].every((e) => e.construction) ? made.map((e) => ({ ...e, construction: true })) : made;
    }
    const o = offsetEntity(src, memory.offset);
    return o ? real([o]) : [];
  }

  /** Offset Edge, Edge: the edges tapped after the first, while an offset of a curve of the sketch or of the face's outline is set up. */
  private offsetExtras(): { id: string; at: Vec2; edge?: { body: string; edge: number } | null }[] {
    const of = this.edit.offsetOf;
    return this.kind === "offset" && memory.offsetMode === "edge" && of && !of.startsWith("lnk-") && !this.edit.offsetEdge ? (this.edit.offsetMore ?? []) : [];
  }

  /** ... and all of them that are curves of the sketch, the first too, once there is more than one (shown picked). */
  private offsetPicked(): string[] {
    const more = this.offsetExtras();
    const of = this.edit.offsetOf;
    return more.length && of && !of.startsWith("bnd-") ? [of, ...more.map((m) => m.id)] : [];
  }

  /**
   * Offset Edge, Edge, with an offset set up and another edge tapped: that edge goes with it (tapped again, it is
   * let go) - several edges at one distance, where Chain takes the whole outline. True: the tap was that.
   */
  private addOffsetEdge(p: ToolPointer): boolean {
    const seed = this.edit.offsetOf;
    if (this.kind !== "offset" || memory.offsetMode !== "edge" || !seed || seed.startsWith("lnk-") || this.edit.offsetEdge) return false;
    const outline = seed.startsWith("bnd-");
    const c = this.curveAt(p);
    const own = !!c && !c.id.startsWith("bnd-") && !c.id.startsWith("lnk-");
    let hit: { id: string; at: Vec2; edge?: { body: string; edge: number } | null };
    if (outline) {
      // (Of the face's own outline: another of its edges - not a curve drawn on the face.)
      const o = own ? null : this.outlineAt(p);
      if (!o) return false;
      const under = this.app.view.pick(p.x, p.y, { profiles: false, planes: false, axes: false, curves: false, edgeTolPx: p.tol });
      hit = { id: o.e.id, at: o.uv, edge: under?.kind === "edge" ? { body: under.body, edge: under.edge } : null };
    } else {
      if (!c || !own) return false;
      hit = { id: c.id, at: c.uv };
    }
    const more = this.offsetExtras();
    if (hit.id === seed) {
      // The first one tapped again: let go, and the next of them is the first. (Alone: as ever - it starts over.)
      if (!more.length) return false;
      const [next, ...rest] = more;
      this.edit.offsetOf = next.id;
      if (outline) ((this.edit.offsetAt = next.at), (this.outlineEdge = next.edge ?? null));
      else this.edit.offsetGrip = next.at;
      this.edit.offsetMore = rest;
      this.dropOffsetGrip();
    } else this.edit.offsetMore = more.some((m) => m.id === hit.id) ? more.filter((m) => m.id !== hit.id) : [...more, hit];
    this.lightEdges(outline ? this.outlineEdge : null);
    this.showSelection();
    this.updatePanel();
    this.refreshPreview();
    const n = this.offsetExtras().length + 1;
    this.setHint(n > 1 ? `${n} edges, offset together. Tap another to add it, one of them again to let it go; then the tick.` : "Set the distance (Flip for the other side). Tap more edges to offset them with it; then the tick.");
    return true;
  }

  /**
   * The offset's handle: a double arrow on the new curve, across from where
   * the curve it is made from was tapped, and the distance in a box beside it.
   * Dragged, it sets how far the offset goes - through the curve to the other
   * side too; the box takes a typed distance (Enter applies the offset).
   */
  private offsetGrip: { arrows: [Handle, Handle]; box: DimWidget; from: Vec2; n: Vec2; dragging: boolean } | null = null;

  private dropOffsetGrip(): void {
    const g = this.offsetGrip;
    if (!g) return;
    g.arrows.forEach((h) => h.dispose());
    g.box.dispose();
    this.offsetGrip = null;
  }

  /** The curve an offset is being made from (of the sketch, or the face's outline). */
  private offsetSource(): SketchEntity | undefined {
    const id = this.edit.offsetOf;
    return id ? (id.startsWith("bnd-") ? this.outline.find((e) => e.id === id) : id.startsWith("lnk-") ? this.boundary.find((e) => e.id === id) : this.entities.find((e) => e.id === id)) : undefined;
  }

  /** Put the handle where the offset is now (made when an offset starts, gone when it ends). */
  private placeOffsetGrip(): void {
    const src = this.kind === "offset" && this.phase === "draw" && this.plane ? this.offsetSource() : undefined;
    const made = src ? this.offsetResult() : [];
    if (!src || !this.plane || !made.length) return this.dropOffsetGrip();
    const plane = this.plane;
    let g = this.offsetGrip;
    if (!g || !g.dragging) {
      // Across from where it was tapped: the nearest point of the curve, and the way square to it there.
      const tapped = this.edit.offsetGrip ?? this.edit.offsetAt;
      let best: { pt: Vec2; n: Vec2; d: number } | null = null;
      for (const pr of entityPrims(src)) {
        const c = closestOnPrim(pr, tapped ?? evalPrim(pr, 0.5));
        if (best && c.d >= best.d) continue;
        const a = evalPrim(pr, Math.max(0, c.t - 1e-3));
        const b = evalPrim(pr, Math.min(1, c.t + 1e-3));
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        best = { pt: c.pt, n: [-(b[1] - a[1]) / L, (b[0] - a[0]) / L], d: c.d };
      }
      if (!best) return this.dropOffsetGrip();
      if (!g) {
        const box = new DimWidget(this.app.view, {
          value: Math.abs(memory.offset),
          boxAt: "beyond",
          boxGap: 34,
          onInput: (v) => v > 0 && ((memory.offset = (memory.offset < 0 ? -1 : 1) * v), this.refreshPreview(), this.updatePanel()),
          onCommit: () => this.applyOffset(),
        });
        g = this.offsetGrip = { arrows: [new Handle(this.app.view, "arrow", 34), new Handle(this.app.view, "arrow", 34)], box, from: best.pt, n: best.n, dragging: false };
      }
      g.from = best.pt;
      g.n = best.n;
    }
    // Where the new curve is, square across from there (which side, and how far).
    let far = 0;
    let gap = Infinity;
    for (const e of made)
      for (const pr of entityPrims(e)) {
        const c = closestOnPrim(pr, g.from);
        if (c.d < gap) (gap = c.d), (far = (c.pt[0] - g.from[0]) * g.n[0] + (c.pt[1] - g.from[1]) * g.n[1]);
      }
    const side = far < 0 ? -1 : 1;
    const at: Vec2 = [g.from[0] + g.n[0] * far, g.from[1] + g.n[1] * far];
    const w = (uv: Vec2) => sketchToWorld(plane, uv).toArray() as Vec3;
    const o = w([0, 0]);
    const tip = w([g.n[0] * side, g.n[1] * side]);
    const dir: Vec3 = [tip[0] - o[0], tip[1] - o[1], tip[2] - o[2]];
    g.arrows[0].set(w(at), dir);
    g.arrows[1].set(w(at), [-dir[0], -dir[1], -dir[2]]);
    g.box.set(w(g.from), w(at));
    // (Not while it is being typed into: the box is the one saying the distance then.)
    if (!document.activeElement?.closest?.(".dim-widget")) g.box.setValue(Math.abs(memory.offset));
  }

  /** The handle dragged: the offset goes to where the pointer is, square across from the curve - either side of it. */
  private dragOffset(p: ToolPointer): void {
    const g = this.offsetGrip;
    const uv = this.uvAt(p);
    if (!g || !uv) return;
    const want = (uv[0] - g.from[0]) * g.n[0] + (uv[1] - g.from[1]) * g.n[1];
    const d = Math.abs(want);
    if (d < 1e-6) return;
    const target: Vec2 = [g.from[0] + g.n[0] * want, g.from[1] + g.n[1] * want];
    // (Which sign of the distance is that side depends on the curve and on Edge or Chain: the one that lands nearer is it.)
    let best: { v: number; miss: number } | null = null;
    for (const v of [d, -d]) {
      memory.offset = v;
      let miss = Infinity;
      for (const e of this.offsetResult()) for (const pr of entityPrims(e)) miss = Math.min(miss, closestOnPrim(pr, target).d);
      if (!best || miss < best.miss) best = { v, miss };
    }
    memory.offset = roundSig(best!.v);
    g.box.setValue(Math.abs(memory.offset));
    this.refreshPreview();
  }

  /**
   * An offset of the face's own outline that starts inside the face (a lip, a
   * pocket's edge), as a distance with its sign: the whole loop goes inward
   * with a minus; one edge alone goes to its left, so the side the middle of
   * the face is on is found.
   */
  private inward(d: number): number {
    const e = this.outline.find((x) => x.id === this.edit.offsetOf);
    if (memory.offsetMode === "chain" || !e) return -d;
    const ends = this.outline.flatMap((x) => (x.kind === "line" || x.kind === "arc" ? [x.a, x.b] : x.kind === "spline" ? [x.points[0], x.points[x.points.length - 1]] : x.kind === "ellipse" && x.sweep !== undefined ? pointsOf(x).filter((q) => q.p !== "c").map((q) => q.at) : x.kind === "circle" || x.kind === "ellipse" ? [x.center] : []));
    if (!ends.length) return -d;
    const mid: Vec2 = [ends.reduce((s, p) => s + p[0], 0) / ends.length, ends.reduce((s, p) => s + p[1], 0) / ends.length];
    const far = (sign: number) => {
      const o = offsetEntity(e, sign * d);
      if (!o) return Infinity;
      return Math.min(...entityPrims(o).map((pr) => closestOnPrim(pr, mid).d));
    };
    return far(1) <= far(-1) ? d : -d;
  }

  /**
   * Offset Edge on an edge of a body: the edge's curve is brought into the
   * sketch as a dashed guide (it follows the edge when the body changes, where
   * the edge is there before the sketch) and that guide is what is offset.
   * Chain: every edge of the flat face the edge is on that faces the sketch,
   * so the whole outline goes together.
   */
  /** The edges an offset from this body edge takes: the edge itself, or with Chain every edge of the flat face it is on that faces the sketch. */
  private edgesFor(hit: { body: string; edge: number }): number[] {
    const b = this.app.view.body(hit.body);
    if (!b || !this.plane || memory.offsetMode !== "chain") return [hit.edge];
    const n = this.plane.normal;
    const facing = (i: number) => Math.abs(b.faces[i].normal[0] * n[0] + b.faces[i].normal[1] * n[1] + b.faces[i].normal[2] * n[2]);
    const on = b.faces.map((_, i) => i).filter((i) => b.faces[i].plane && edgesOfFace(this.app, hit.body, i).includes(hit.edge));
    const best = on.sort((x, y) => facing(y) - facing(x))[0];
    return best !== undefined && facing(best) > 0.5 ? edgesOfFace(this.app, hit.body, best) : [hit.edge];
  }

  /** The face's own edge tapped for an offset (to light it, and its whole outline with Chain). */
  private outlineEdge: { body: string; edge: number } | null = null;
  /** The body edges an offset is being made from, lit while it is set up (what was tapped - a finger has no pointer to hover with). */
  private offsetLit: Sel[] = [];
  private lightEdges(hit: { body: string; edge: number } | null): void {
    const more = hit || this.offsetExtras().length ? this.offsetExtras().flatMap((m) => (m.edge ? [{ kind: "edge" as const, body: m.edge.body, edge: m.edge.edge }] : [])) : [];
    if (!hit && !more.length && !this.offsetLit.length) return;
    this.offsetLit = [...(hit ? this.edgesFor(hit).map((edge) => ({ kind: "edge" as const, body: hit.body, edge })) : []), ...more];
    this.showSelection();
  }

  private offsetFromEdge(hit: { body: string; edge: number }, at?: Vec2): void {
    const b = this.app.view.body(hit.body);
    if (!b || !this.plane) return;
    const edges = this.edgesFor(hit);
    const order = this.app.store.features.map((f) => f.id);
    const here = this.sketchId ? order.indexOf(this.sketchId) : order.length;
    const before = (step: string) => order.indexOf(step) >= 0 && order.indexOf(step) < here;
    const ends = (e: SketchEntity): Vec2[] => (e.kind === "line" || e.kind === "arc" ? [e.a, e.b] : e.kind === "spline" ? [e.points[0], e.points[e.points.length - 1]] : e.kind === "ellipse" && e.sweep !== undefined ? pointsOf(e).filter((q) => q.p !== "c").map((q) => q.at) : e.kind === "circle" || e.kind === "ellipse" ? [e.center] : []);
    const near = (p: Vec2, q: Vec2) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-6;
    const added: SketchEntity[] = [];
    const links: EdgeLink[] = [];
    const guides: string[] = [];
    let seed: string | undefined;
    for (const edge of edges) {
      const g = b.edgeGroups.find((x) => x.edge === edge);
      if (!g) continue;
      const pts: Vec3[] = [];
      for (let i = g.start; i < g.start + g.count; i++) if ((i - g.start) % 2 === 0 || i === g.start + g.count - 1) pts.push([b.edgePositions[i * 3], b.edgePositions[i * 3 + 1], b.edgePositions[i * 3 + 2]]);
      const ref = edgeRefOf(this.app, { body: hit.body, edge });
      const free = !ref?.steps?.length || !ref.steps.every(before) || !(b.edges[edge].was ?? []).every(before);
      const e = projectPolyline(pts, this.plane, b.edges[edge].type, free);
      // (Seen end on from here - a point: nothing to offset.)
      if (!e) continue;
      // Already in the sketch (projected before, or tapped a moment ago): that curve is the guide.
      const mine = ends(e);
      const had = [...this.entities, ...added].find((x) => x.kind === e.kind && ends(x).length === mine.length && (mine.every((p, k) => near(p, ends(x)[k])) || mine.every((p, k) => near(p, ends(x)[mine.length - 1 - k]))));
      const id = had?.id ?? (free ? uid() : `${LINKED}${uid()}`);
      if (!had) {
        added.push({ ...e, id, construction: true });
        if (!free && ref) links.push({ id, edge: ref });
      }
      guides.push(id);
      if (edge === hit.edge) seed = id;
    }
    if (!seed) return this.app.ui.toast("That edge is seen end on from this sketch: nothing to offset");
    if (added.length) this.commit([...this.entities, ...added], this.constraints, links);
    const src = this.entities.find((e) => e.id === seed);
    if (!src) return;
    this.edit.offsetEdge = hit;
    this.edit.offsetGuides = guides;
    this.edit.offsetMore = undefined;
    this.edit.offsetAt = at;
    this.edit.offsetOf = seed;
    // (A whole outline starts inside it - a lip, a pocket's edge - as the face's own outline does; one edge keeps the side it went last.)
    memory.offset = (memory.offsetMode === "chain" && guides.length > 1 ? -1 : memory.offset < 0 ? -1 : 1) * Math.abs(defaultOffset(src));
    this.updatePanel();
    this.refreshPreview();
    this.lightEdges(hit);
    this.setHint("Set the distance (Flip: the other side), then Apply. The dashed line is the body's edge.");
  }

  private applyOffset(): void {
    const made = this.offsetResult();
    if (!made.length) return this.app.ui.toast("That offset would collapse the curve");
    // Of an offset of the face's edge: one more offset of that edge, kept as a link to it like the first.
    if (this.edit.offsetOf?.startsWith("lnk-") && this.edit.offsetLink && this.sketchId) {
      const first = this.edit.offsetLink;
      const link: OutlineOffset = { id: uid(), distance: first.distance + memory.offset, at: first.at, ...(first.single ? { single: true } : {}) };
      const sid = this.sketchId;
      this.app.store.commit((d) => {
        const f = d.features.find((x) => x.id === sid);
        if (f?.type === "sketch") f.outlineOffsets = [...(f.outlineOffsets ?? []), link];
      });
      this.app.ui.toast("Offset again: it follows the face too");
      this.edit.offsetOf = this.edit.offsetAt = this.edit.offsetEdge = this.edit.offsetLink = undefined;
      return this.resetDrawing();
    }
    // Of the face's outline: kept as a link to it, not as curves of their own.
    if (this.edit.offsetOf?.startsWith("bnd-") && this.edit.offsetAt) {
      const also = this.offsetExtras().map((m) => m.at);
      const link = { id: uid(), distance: memory.offset, at: this.edit.offsetAt, ...(memory.offsetMode === "edge" ? { single: true, ...(also.length ? { also } : {}) } : {}) };
      // (Nothing drawn on it yet: the sketch is made with the offset in it - one step.)
      if (!this.sketchId) {
        const f: SketchFeature = { ...(this.pending ?? this.app.store.newIdentity("sketch")), type: "sketch", plane: this.plane!, attachedTo: this.attachedTo, onPlane: this.onPlane, entities: [], constraints: [], outlineOffsets: [link] };
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
      this.edit.offsetOf = this.edit.offsetAt = this.edit.offsetEdge = undefined;
      return this.resetDrawing();
    }

    // Chain pieces stay joined to each other.
    const cs: SketchConstraint[] = [];
    // An offset follows what it was made from: the original given another size or place (a dimension typed, a
    // variable, a step changed in History), the offset is its offset still. One curve: wholly its offset. An
    // outline's pieces: each on its original's offset, trimmed to its neighbours as they were made.
    {
      const d = memory.offset;
      const srcId = this.edit.offsetOf;
      const src = this.entities.find((e) => e.id === srcId);
      const linkable = (e: SketchEntity) => e.kind === "line" || e.kind === "arc" || e.kind === "circle" || e.kind === "rect" || e.kind === "polygon" || e.kind === "ellipse";
      // (An ellipse's offset is a spline: no ellipse is the same distance from another all round. It follows it too.)
      if (made.length === 1 && src && linkable(src) && (made[0].kind === src.kind || src.kind === "ellipse") && JSON.stringify({ ...offsetEntity(src, d), id: "" }) === JSON.stringify({ ...made[0], id: "", construction: src.construction })) {
        cs.push({ id: uid(), type: "follow", curves: [src.id, made[0].id], how: { offset: d } });
      } else {
        const tol = 1e-6 * Math.max(1, Math.abs(d));
        const mid = (e: SketchEntity): Vec2 | null => (e.kind === "line" ? [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2] : e.kind === "arc" ? e.m : null);
        const pool = this.entities.filter((e) => e.kind === "line" || e.kind === "arc");
        for (const piece of made) {
          const m = mid(piece);
          if (!m) continue;
          let found: { id: string; d: number } | null = null;
          for (const s of pool) {
            if (s.kind !== piece.kind) continue;
            for (const sign of [1, -1]) {
              const want = offsetEntity(s, sign * Math.abs(d));
              if (!want) continue;
              const on =
                want.kind === "line" && piece.kind === "line"
                  ? Math.abs(closestOnPrim(entityPrims({ ...want, a: [2 * want.a[0] - want.b[0], 2 * want.a[1] - want.b[1]], b: [2 * want.b[0] - want.a[0], 2 * want.b[1] - want.a[1]] })[0], m).d) < tol && Math.abs((piece.b[0] - piece.a[0]) * (want.b[1] - want.a[1]) - (piece.b[1] - piece.a[1]) * (want.b[0] - want.a[0])) < tol * Math.max(1, Math.hypot(want.b[0] - want.a[0], want.b[1] - want.a[1]) * Math.hypot(piece.b[0] - piece.a[0], piece.b[1] - piece.a[1]))
                  : want.kind === "arc" && piece.kind === "arc"
                    ? (() => {
                        const [w, q] = [arcFrom3(want.a, want.m, want.b), arcFrom3(piece.a, piece.m, piece.b)];
                        return !!w && !!q && Math.hypot(w.c[0] - q.c[0], w.c[1] - q.c[1]) < tol && Math.abs(w.r - q.r) < tol;
                      })()
                    : false;
              if (on) found = { id: s.id, d: sign * Math.abs(d) };
              if (found) break;
            }
            if (found) break;
          }
          if (found) cs.push({ id: uid(), type: "follow", curves: [found.id, piece.id], how: { offset: found.d, loose: true } });
        }
      }
    }
    // (A spline among them - a spline's offset, or that of part of an ellipse - is joined by its end points too: it
    // was left loose, and the outline came apart there at the first drag.)
    const tip = (e: SketchEntity, last: boolean): { p: string; at: Vec2 } | null => {
      if (e.kind === "line" || e.kind === "arc") return { p: last ? "b" : "a", at: last ? e.b : e.a };
      const ends = splineEnds(e);
      if (!ends || e.kind !== "spline") return null;
      const k = last ? e.points.length - 1 : 0;
      // (Only where the curve does end on its end point.)
      return Math.hypot(e.points[k][0] - ends[last ? 1 : 0][0], e.points[k][1] - ends[last ? 1 : 0][1]) < 1e-9 ? { p: `k${k}`, at: e.points[k] } : null;
    };
    for (let i = 0; i < made.length; i++) {
      const [a, b] = [made[i], made[(i + 1) % made.length]];
      const [ta, tb] = [tip(a, true), tip(b, false)];
      if (made.length > 1 && a !== b && ta && tb && Math.hypot(ta.at[0] - tb.at[0], ta.at[1] - tb.at[1]) < 1e-9) cs.push({ id: uid(), type: "coincident", pts: [{ e: a.id, p: ta.p }, { e: b.id, p: tb.p }] });
    }
    this.commitAdd(made, cs);
    this.edit.offsetOf = this.edit.offsetEdge = undefined;
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
  /** Curves projected from another sketch, to be kept as following it (taken with the next commit). */
  private newRefs: SketchRef[] = [];

  private projectCurves(sketch: string, entities: SketchEntity[], follow = false): SketchEntity[] {
    const from = this.app.sketchPlane(sketch);
    const to = this.plane!;
    if (!from) return [];
    if (Math.abs(dot(from.normal, to.normal)) > 1 - 1e-9) {
      // Parallel planes: the same shapes, moved (and turned) into this plane. They follow the sketch they come
      // from: that one changed (from History, by a variable), these are put where its curves are now.
      const made = entities.map((e) => transformEntity(e, (uv) => toPlane(to, sketchToWorld(from, uv).toArray() as Vec3), true));
      if (follow && sketch !== this.sketchId) made.forEach((e, i) => this.newRefs.push({ id: e.id, sketch, entity: entities[i].id }));
      return made;
    }
    return entities.flatMap((e) =>
      entityPolylines(e).flatMap((pl) => {
        const out = projectPolyline(pl.map((uv) => sketchToWorld(from, uv).toArray() as Vec3), to, e.kind === "line" ? "LINE" : "", true);
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
        this.commitAdd(this.projectCurves(hit.sketch, all.filter((e) => e.id !== last.entity), true));
        return this.app.ui.toast("Projected the whole sketch");
      }
      const one = all.filter((e) => e.id === hit.entity);
      if (!one.length) return;
      this.projectedFrom = { sketch: hit.sketch, entity: hit.entity, at: Date.now() };
      this.commitAdd(this.projectCurves(hit.sketch, one, true));
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
    // It follows that edge from now on, if the edge is there when this sketch
    // is made (the steps that made it come before the sketch).
    const ref = edgeRefOf(this.app, hit);
    const order = this.app.store.features.map((f) => f.id);
    const at = this.sketchId ? order.indexOf(this.sketchId) : order.length;
    const before = (step: string) => order.indexOf(step) >= 0 && order.indexOf(step) < at;
    // (And the Move its body went through since, if any: the edge is only there, where it is, after that.)
    const free = !ref?.steps?.length || !ref.steps.every(before) || !(b.edges[hit.edge].was ?? []).every(before);
    // (A free copy: with as few points as hold it. One that follows the edge: the edge's own shape, its two ends showing.)
    const e = projectPolyline(pts, this.plane!, b.edges[hit.edge].type, free);
    if (!e) return;
    if (free) return this.commitAdd([e]);
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
      // (Unlinked, it is the user's own curve: with only the points it needs, not the 24 the edge's shape was kept in.)
      this.commit(this.entities.flatMap((x) => (x.id !== id ? [x] : keep ? [leanSpline({ ...x, id: uid() })] : [])));
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
          const from = prop === "length" ? this.lengthFromHeldEnd(id, v) : this.entities;
          // (What the size has nothing to do with stays where it is, if the sketch can take it that way.)
          const res = sizeStrict(from, next.filter((c) => base.includes(c)), added, [id]);
          if (!res.ok) return this.refused();
          this.commit(res.result.entities, res.constraints);
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
      { type: "toggle", label: "Construction", icon: "construction", value: !!e.construction, onChange: () => this.toggleConstruction() },
      ...(e.kind === "rect" || e.kind === "polygon" ? [{ type: "button", label: "Explode", icon: "line", onClick: () => this.explodeShape(id) } as PanelItem] : []),
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
  const t: Record<string, string> = { patternLinear: "Pattern – Linear", patternCircular: "Pattern – Circular", rotate: "Rotate About", rect: "Rectangle", offset: "Offset Edge", fill: "Fill Pattern", polyline: "Outline" };
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
