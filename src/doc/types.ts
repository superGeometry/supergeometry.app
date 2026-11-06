// The project file format. Everything the user builds is a list of features;
// geometry is always regenerated from these, which is what makes history editable.

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

/** A plane in world space. xDir and normal are unit vectors, perpendicular. */
export interface PlaneDef {
  origin: Vec3;
  xDir: Vec3;
  normal: Vec3;
}

interface EntityBase {
  id: string;
  /** Construction geometry is drawn dashed and never forms regions. */
  construction?: boolean;
}

export type SketchEntity = EntityBase &
  (
    | { kind: "line"; a: Vec2; b: Vec2 }
    /** Arc through a (start), m (any point on it) and b (end). */
    | { kind: "arc"; a: Vec2; m: Vec2; b: Vec2 }
    | { kind: "circle"; center: Vec2; radius: number }
    | { kind: "ellipse"; center: Vec2; rx: number; ry: number; rotation: number }
    | { kind: "spline"; points: Vec2[]; closed: boolean; mode: "fit" | "control" }
    | { kind: "rect"; center: Vec2; w: number; h: number; rotation: number }
    | { kind: "polygon"; center: Vec2; radius: number; sides: number; angle: number }
    | { kind: "polyline"; points: Vec2[]; closed: boolean }
  );

export type EntityKind = SketchEntity["kind"];

/** A sketch region, referenced by where it is rather than an index (see regions.ts). */
export interface RegionRef {
  c: Vec2;
  a: number;
}

/**
 * Geometric signature of a face. Features store this instead of a face index so
 * the reference survives edits to earlier features (see docs/ARCHITECTURE.md).
 */
export interface FaceRef {
  body: string;
  center: Vec3;
  normal: Vec3;
  area: number;
}

export interface EdgeRef {
  body: string;
  mid: Vec3;
  dir: Vec3;
  length: number;
}

export type ExtrudeSource =
  | { kind: "profile"; sketch: string; regions: RegionRef[] }
  | { kind: "face"; face: FaceRef };

interface FeatureBase {
  id: string;
  name: string;
  /** Suppressed features are skipped during regeneration. */
  suppressed?: boolean;
  /**
   * Parametric values: field path → expression (e.g. "distance": "depth*2").
   * The number at that path is recomputed from the expression on every change.
   */
  exprs?: Record<string, string>;
}

/** A point of a sketch entity: "a"/"b" ends, "m" arc mid, "c" centre, "k<i>" i-th corner/point. */
export interface PointRef {
  e: string;
  p: string;
}

export type ConstraintType =
  | "coincident"
  | "horizontal"
  | "vertical"
  | "parallel"
  | "perpendicular"
  | "equal"
  | "tangent"
  | "concentric"
  | "midpoint"
  | "symmetric"
  | "fix"
  | "distance"
  | "dim";

/**
 * Sketch constraint. Geometry refs: `pts` (points) and `curves` (entity ids).
 * Dimensions ("distance", "dim") carry a value, optionally driven by `expr`.
 */
export interface SketchConstraint {
  id: string;
  type: ConstraintType;
  pts?: PointRef[];
  curves?: string[];
  /** dim: which size — length, radius, diameter, w, h, rx, ry, angle. */
  prop?: string;
  value?: number;
  expr?: string;
  /** fix: where the point is held. */
  at?: Vec2;
}

export interface SketchFeature extends FeatureBase {
  type: "sketch";
  plane: PlaneDef;
  /** When drawn on a body face, the sketch follows that face when it moves. */
  attachedTo?: FaceRef;
  entities: SketchEntity[];
  constraints?: SketchConstraint[];
  /** What was done in the sketch, in order (shown under it in History); repeats are counted. */
  log?: { op: string; n: number }[];
}

export interface ExtrudeFeature extends FeatureBase {
  type: "extrude";
  source: ExtrudeSource;
  distance: number;
  /** auto: join `target` when distance > 0, cut it when < 0; new body without a target. */
  mode: "auto" | "new" | "join" | "cut";
  target?: string;
  /**
   * How big the far end is, as a fraction of the shape (1 or missing: straight
   * sides; 0.5: half size; near 0: to a point — a spire, a pyramid, a cone).
   */
  taper?: number;
}

export interface EdgeFeature extends FeatureBase {
  type: "fillet" | "chamfer";
  edges: EdgeRef[];
  radius: number;
}

export interface BooleanFeature extends FeatureBase {
  type: "boolean";
  op: "union" | "subtract" | "intersect";
  target: string;
  tools: string[];
}

export interface DeleteFeature extends FeatureBase {
  type: "delete";
  bodies: string[];
}

/**
 * An axis in space. When `ref` is set the axis follows that sketch line or
 * construction axis; origin/dir are the fallback (and the value at creation).
 */
export interface AxisRef {
  origin: Vec3;
  dir: Vec3;
  ref?: { kind: "sketchLine"; sketch: string; entity: string } | { kind: "axis"; feature: string };
}

export type PathRef = { kind: "sketch"; sketch: string; entities: string[] } | { kind: "edges"; edges: EdgeRef[] };

type BodyMode = "auto" | "new" | "join" | "cut";

export interface RevolveFeature extends FeatureBase {
  type: "revolve";
  source: ExtrudeSource;
  axis: AxisRef;
  /** Degrees (more than 360 winds round again: with travel, a thread or spring). */
  angle: number;
  /** Distance moved along the axis over the whole angle (0: a plain revolve). */
  travel?: number;
  mode: BodyMode;
  target?: string;
}

export interface SweepFeature extends FeatureBase {
  type: "sweep";
  source: ExtrudeSource;
  path: PathRef;
  mode: BodyMode;
  target?: string;
}

export interface LoftFeature extends FeatureBase {
  type: "loft";
  sections: ExtrudeSource[];
  ruled: boolean;
  mode: BodyMode;
  target?: string;
}

export interface ShellFeature extends FeatureBase {
  type: "shell";
  body: string;
  /** Faces to open (removed); may be empty for a hollow closed body. */
  faces: FaceRef[];
  thickness: number;
}

/** Move/rotate/scale/mirror/pattern bodies. With `copy`, the originals stay. */
export interface TransformFeature extends FeatureBase {
  type: "transform";
  bodies: string[];
  copy: boolean;
  /**
   * A copy that stays connected to its original: a freeform copy keeps being
   * built from the original's cage, so shaping one shapes both. Unlinked
   * freeform copies become freeforms of their own.
   */
  link?: boolean;
  op:
    | { kind: "move"; translate: Vec3; rotate?: { origin: Vec3; axis: Vec3; angle: number } }
    | { kind: "scale"; center: Vec3; factor: number }
    /** Different factors along X, Y and Z (freeform bodies: rebuilt from their cage). */
    | { kind: "scaleXYZ"; center: Vec3; factors: Vec3 }
    | { kind: "mirror"; plane: PlaneDef }
    | { kind: "linear"; dir: Vec3; spacing: number; count: number }
    | { kind: "circular"; axis: AxisRef; count: number; angle: number };
}

export interface SplitFeature extends FeatureBase {
  type: "split";
  body: string;
  plane: PlaneDef;
}

/** Construction plane. Optionally follows a face (offset along its normal). */
export interface PlaneFeature extends FeatureBase {
  type: "plane";
  plane: PlaneDef;
  face?: FaceRef;
  offset: number;
}

export interface AxisFeature extends FeatureBase {
  type: "axis";
  origin: Vec3;
  dir: Vec3;
}

/** A body imported from a file. The file content travels inside the project. */
export interface ImportFeature extends FeatureBase {
  type: "import";
  format: "step" | "stl";
  fileName: string;
  /** Base64 of the file. */
  data: string;
}

/** A reference image placed on a plane (for tracing). */
export interface ImageFeature extends FeatureBase {
  type: "image";
  plane: PlaneDef;
  /** data: URL */
  src: string;
  width: number;
  height: number;
  opacity: number;
}

/**
 * Remove faces/edges/vertices from a body; the surrounding faces extend to
 * close the gap (fillets, chamfers, holes, imprinted edges).
 */
export interface DeleteGeomFeature extends FeatureBase {
  type: "deleteGeom";
  body: string;
  faces: FaceRef[];
  edges: EdgeRef[];
  vertices: Vec3[];
}

/**
 * Move/tilt one flat face — or one straight edge between two flat faces (both
 * faces turn to follow it). The neighbouring faces extend or trim.
 */
export interface MoveFaceFeature extends FeatureBase {
  type: "moveFace";
  face?: FaceRef;
  edge?: EdgeRef;
  /** One corner moves; the flat faces meeting there turn about their far edge to follow. */
  vertex?: { body: string; at: Vec3 };
  translate: Vec3;
  rotate?: { origin: Vec3; axis: Vec3; angle: number };
}

/**
 * A freeform body: a quad control cage whose smooth subdivision surface
 * becomes the body (a solid when the cage is closed, a surface otherwise).
 */
export interface FreeformFeature extends FeatureBase {
  type: "freeform";
  cage: { verts: Vec3[]; faces: [number, number, number, number][] };
  /** Made as an open surface on purpose (a sheet): no "not closed" warning. */
  surface?: boolean;
  /** An open freeform becomes a solid this thick (0 / missing: stays a surface). */
  thickness?: number;
  /** Which way the thickness goes from the surface (its normal side is "up"). */
  thickSide?: "up" | "down" | "both";
}

/**
 * Scale one flat face within its own plane (factors along its u and v axes);
 * the flat faces around it tilt to follow its edges.
 */
export interface ScaleFaceFeature extends FeatureBase {
  type: "scaleFace";
  face: FaceRef;
  /** The face's in-plane u axis (v = normal × u). */
  u: Vec3;
  factors: [number, number];
}

/** Move a flat face onto another plane / flat face (the neighbours follow). */
export interface ReplaceFaceFeature extends FeatureBase {
  type: "replaceFace";
  face: FaceRef;
  plane: PlaneDef;
  /** Follow this face when it moves (else `plane` is used as is). */
  target?: FaceRef;
}

/**
 * Fill to Plane: an open surface (a freeform sheet) becomes a solid by filling
 * the gap down to a plane — sides straight down to it (along its normal), the
 * bottom the surface's outline projected flat onto it.
 */
export interface FillToPlaneFeature extends FeatureBase {
  type: "fillToPlane";
  body: string;
  plane: PlaneDef;
}

/**
 * A screw thread (ISO 60° V) cut into a round face: into a shank drawn at the
 * nominal diameter (outside thread) or a hole drawn at the tap-drill size
 * (inside thread), over the face's whole length.
 */
export interface ThreadFeature extends FeatureBase {
  type: "thread";
  face: FaceRef;
  /** mm per turn. */
  pitch: number;
  /** Left-handed (turns the other way). */
  left?: boolean;
  /** The face as it was picked (for the panel when editing: the face itself is threaded by then). */
  round?: { r: number; hole: boolean };
}

/**
 * Repair bodies: gaps sewn, missing flat faces filled, hair-thin faces
 * removed, faces fixed and merged, inside-out solids turned — the shape
 * itself stays. Turns loose faces (an imported mesh or STEP surface) into a solid.
 */
export interface RepairFeature extends FeatureBase {
  type: "repair";
  bodies: string[];
}

export type Feature =
  | FillToPlaneFeature
  | ThreadFeature
  | RepairFeature
  | ScaleFaceFeature
  | ReplaceFaceFeature
  | FreeformFeature
  | DeleteGeomFeature
  | MoveFaceFeature
  | SketchFeature
  | ExtrudeFeature
  | EdgeFeature
  | BooleanFeature
  | DeleteFeature
  | RevolveFeature
  | SweepFeature
  | LoftFeature
  | ShellFeature
  | TransformFeature
  | SplitFeature
  | PlaneFeature
  | AxisFeature
  | ImportFeature
  | ImageFeature;
export type FeatureType = Feature["type"];

export interface Variable {
  name: string;
  /** Expression; may reference other variables. */
  expr: string;
}

export interface SavedView {
  name: string;
  target: Vec3;
  distance: number;
  azimuth: number;
  elevation: number;
  ortho: boolean;
}

export type Units = "mm" | "cm" | "m" | "in" | "ft";

/** A measurement pinned in 3D: a label, optionally with a dimension line a→b. */
export interface PinDef {
  text: string;
  at: Vec3;
  a?: Vec3;
  b?: Vec3;
}

export interface ProjectDoc {
  format: "super";
  version: 2;
  name: string;
  features: Feature[];
  variables: Variable[];
  views: SavedView[];
  units: Units;
  /** Ids of bodies / sketches / planes hidden from the Items panel. */
  hidden: string[];
  pins: PinDef[];
  /** Custom names for bodies (by body id), set from Items. */
  names: Record<string, string>;
  /** Items folders: any bodies / sketches / planes / images, grouped. */
  folders?: ItemFolder[];
  /** History groups: runs of steps next to each other, shown folded under one name. */
  historyGroups?: HistoryGroup[];
  /** Body colours (by body id), "#rrggbb"; missing = the default grey. */
  colors?: Record<string, string>;
  /** See-through bodies: opacity 0–1 by body id (missing: solid). */
  opacity?: Record<string, number>;
}

/** The body colours offered by the Color tool (first = default). */
export const BODY_COLORS: { name: string; hex: string }[] = [
  // Soft, muted tones (easy on the eyes, still easy to tell apart).
  { name: "Grey", hex: "#b9bec7" },
  { name: "Red", hex: "#b9726b" },
  { name: "Orange", hex: "#c29069" },
  { name: "Yellow", hex: "#c4b277" },
  { name: "Green", hex: "#83a67f" },
  { name: "Teal", hex: "#71a39c" },
  { name: "Blue", hex: "#7c98c2" },
  { name: "Violet", hex: "#9a8bc0" },
  { name: "Pink", hex: "#bb8aa9" },
  { name: "Brown", hex: "#93806e" },
];

/** The first, brighter palette → its softer version (projects saved before keep their choice). */
const OLD_COLORS: Record<string, string> = {
  "#e05a4f": "#b9726b",
  "#f08c3a": "#c29069",
  "#e8c547": "#c4b277",
  "#5fbf5a": "#83a67f",
  "#3fb6a8": "#71a39c",
  "#4f8ce0": "#7c98c2",
  "#8a6be0": "#9a8bc0",
  "#e06bb5": "#bb8aa9",
  "#9a7454": "#93806e",
};

/** A saved body colour as it is shown now. */
export function bodyColor(hex: string | undefined): string | undefined {
  return hex && (OLD_COLORS[hex.toLowerCase()] ?? hex);
}

/** The see-through levels offered next to Color (1 = solid). */
export const BODY_OPACITY: { name: string; value: number }[] = [
  { name: "Solid", value: 1 },
  { name: "75%", value: 0.75 },
  { name: "50%", value: 0.5 },
  { name: "25%", value: 0.25 },
];

export interface HistoryGroup {
  id: string;
  name: string;
  /** Feature ids (steps next to each other in History). */
  steps: string[];
}

export interface ItemFolder {
  id: string;
  name: string;
  /** Body ids and feature ids. */
  items: string[];
}

export function emptyDoc(): ProjectDoc {
  return { format: "super", version: 2, name: "Untitled", features: [], variables: [], views: [], units: "mm", hidden: [], pins: [], names: {} };
}
