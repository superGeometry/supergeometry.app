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
  /**
   * The curves round it (their ids, sorted): a shape moved far by a variable
   * (an arm made 40 mm longer) is still found by what outlines it.
   */
  k?: string[];
  /**
   * Along each of those curves, where the outline runs (which side of the
   * curve, as a place along it): the two halves of a circle split by a strip
   * have the same curves and the same area, but not the same stretch of circle.
   */
  s?: number[];
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
  /** The step that made the face (only faces made by it are matched; none left: it's gone). */
  step?: string;
  /**
   * Which of that step's faces it is: the sketch curve it was made from (a
   * side of an extrusion), or the end of it. Where the face is can change
   * (the sketch redrawn, the holes moved past each other); this doesn't.
   */
  curve?: string;
}

export interface EdgeRef {
  body: string;
  mid: Vec3;
  dir: Vec3;
  length: number;
  /** The steps that made the faces either side of it (sorted). */
  steps?: string[];
  /** Which faces of those steps it lies between (their curves, see FaceRef; sorted). */
  curves?: string[];
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
   * After the History's breakpoint: off until the breakpoint is removed (the
   * model as it was there). These steps are kept last; new ones go before them.
   */
  rolledBack?: boolean;
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
  | "dim"
  | "pattern";

/**
 * Sketch constraint. Geometry refs: `pts` (points) and `curves` (entity ids).
 * Dimensions ("distance", "dim") carry a value, optionally driven by `expr`.
 */
export interface SketchConstraint {
  id: string;
  type: ConstraintType;
  pts?: PointRef[];
  curves?: string[];
  /** dim: which size - length, radius, diameter, w, h, rx, ry, angle. */
  prop?: string;
  value?: number;
  expr?: string;
  /** fix: where the point is held. pattern: the copy's offset (move), or the centre it turns round (turn). */
  at?: Vec2;
  /** pattern: "turn" - the copy is the original turned `value` degrees round `at`; else moved by `at`. */
  turn?: boolean;
}

export interface SketchFeature extends FeatureBase {
  type: "sketch";
  plane: PlaneDef;
  /** When drawn on a body face, the sketch follows that face when it moves. */
  attachedTo?: FaceRef;
  entities: SketchEntity[];
  constraints?: SketchConstraint[];
  /**
   * Offsets of the outline of the face it's drawn on (a lid's lip 2 mm in
   * from the rim): made again from the face as it is on every rebuild, so
   * they follow it when it changes size. Their curves are "lnk-<id>-<n>".
   */
  outlineOffsets?: OutlineOffset[];
  /**
   * Curves of the sketch that follow an edge of a body (projected from it):
   * put where that edge is on every rebuild, the sketch's dimensions to them
   * kept - a hole 10 mm from the wall of another part stays 10 mm from it.
   * Their ids begin "ref-".
   */
  links?: EdgeLink[];

  /** What was done in the sketch, in order (shown under it in History); repeats are counted. */
  log?: { op: string; n: number }[];
}

export interface ExtrudeFeature extends FeatureBase {
  type: "extrude";
  source: ExtrudeSource;
  distance: number;
  /** auto: join `target` when distance > 0, cut it when < 0; new body without a target. */
  mode: "auto" | "new" | "join" | "cut" | "intersect";
  target?: string;
  /**
   * How big the far end is, as a fraction of the shape (1 or missing: straight
   * sides; 0.5: half size; near 0: to a point - a spire, a pyramid, a cone).
   */
  taper?: number;
  /** Both ways from the shape: `distance` each side (a boss through its middle plane). */
  symmetric?: boolean;
  /**
   * Where it ends: `distance` (missing too), through everything there is
   * (`distance` only gives the way: its sign), or up to `to` - a face (flat or
   * round, followed as its body changes) or a plane.
   */
  extent?: "distance" | "through" | "to";
  to?: { face?: FaceRef; plane?: PlaneDef };
  /** It starts this far from the shape, along its normal (missing: at the shape). */
  start?: number;
  /** Degrees the sides lean in (negative: out) towards the far end - a draft, as for a mould. */
  draft?: number;
}

export interface EdgeFeature extends FeatureBase {
  type: "fillet" | "chamfer";
  edges: EdgeRef[];
  radius: number;
  /** Chamfer, Two-Distance: the second distance (along the other face); missing: equal distances. */
  distance2?: number;
  /** Chamfer, Two-Distance: the first distance goes along the other face of each edge.
   *  Fillet, Variable: the start and end radii swap ends. */
  flip?: boolean;
  /** Fillet, Variable: the radius at each edge's other end (it runs evenly from radius to this); missing: one radius. */
  radius2?: number;
  /** Fillet: the sizes are chord widths (straight across the round, face to face), not radii. */
  chord?: boolean;
  /** Fillet: a smooth (G2) blend, its bend easing in from flat at both faces, not a circular round. */
  g2?: boolean;
  /** Fillet: where three or more rounded edges meet, they stop this far from the corner and a smooth patch joins them (0 or missing: the usual corner). */
  setback?: number;
}

export interface BooleanFeature extends FeatureBase {
  type: "boolean";
  op: "union" | "subtract" | "intersect";
  target: string;
  tools: string[];
  /** Subtract / Intersect: the body changed stays as it was too (the result is a new body). */
  keepTarget?: boolean;
  /** Subtract / Intersect: the bodies it was changed with stay. */
  keepTools?: boolean;
  /**
   * Patterns it used whole (`<pattern step>:<original body>`): the original and
   * every copy there was when it was made. They stay whole when the pattern's
   * count changes. Worked out by the engine the first time it runs (see bodyList).
   */
  whole?: string[];
}

export interface DeleteFeature extends FeatureBase {
  type: "delete";
  bodies: string[];
  /**
   * Patterns it used whole (`<pattern step>:<original body>`): the original and
   * every copy there was when it was made. They stay whole when the pattern's
   * count changes. Worked out by the engine the first time it runs (see bodyList).
   */
  whole?: string[];
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

type BodyMode = "auto" | "new" | "join" | "cut" | "intersect";

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
  /** The profile's size at the path's end, as a multiple of its size at the start (1 = same size). */
  scale?: number;
  /** Degrees the profile turns round the path from start to end, evenly along it (0 or missing: none). */
  twist?: number;
  /** Where the profile starts: where it is (auto), or moved onto the path's nearer end, square to it (start). */
  position?: "auto" | "start";
  /** The profile turns with the path (normal, the default) or keeps facing the same way (parallel). */
  orientation?: "normal" | "parallel";
  /** At a sharp corner of the path: rounded (the default) or mitred. */
  corner?: "round" | "mitre";
}

export interface LoftFeature extends FeatureBase {
  type: "loft";
  sections: ExtrudeSource[];
  ruled: boolean;
  mode: BodyMode;
  target?: string;
  /** Goes on from the last profile back round to the first (a ring, no ends). */
  closed?: boolean;
  /** A curve the body follows from profile to profile (its centre line). */
  guide?: PathRef;
  /** How the body leaves the first profile and meets the last: straight out of it (G1, tangent) or smoother still (G2); missing: free. */
  startContinuity?: "g1" | "g2";
  endContinuity?: "g1" | "g2";
  /** How far that pull reaches (1: a quarter of the way to the next profile). */
  startWeight?: number;
  endWeight?: number;
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
    /** `ref`: scaled by reference - the two points picked (center is the first), the distance typed between them. */
    | { kind: "scale"; center: Vec3; factor: number; ref?: [Vec3, Vec3] }
    /** Different factors along X, Y and Z (freeforms rebuilt from their cage, other bodies face by face). */
    | { kind: "scaleXYZ"; center: Vec3; factors: Vec3 }
    | { kind: "mirror"; plane: PlaneDef }
    | { kind: "linear"; dir: Vec3; spacing: number; count: number }
    | { kind: "circular"; axis: AxisRef; count: number; angle: number };
}

export interface SplitFeature extends FeatureBase {
  type: "split";
  body: string;
  plane: PlaneDef;
  /** More planes to cut along at once. */
  planes?: PlaneDef[];
  /** Bodies it's cut with, along their surfaces (they stay as they are). */
  tools?: string[];
  /** Cut only with the tools: `plane` isn't one. */
  noPlane?: boolean;
}

/** Construction plane. Optionally follows a face (offset along its normal). */
/** How a construction plane was made (its mark on screen says so). */
export type PlaneKind = "offset" | "mid" | "3pt" | "curve" | "perp" | "angle" | "parallel";

export interface PlaneFeature extends FeatureBase {
  type: "plane";
  plane: PlaneDef;
  face?: FaceRef;
  offset: number;
  kind?: PlaneKind;
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
 * Move/tilt one flat face - or one straight edge between two flat faces (both
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
  /** Edited with symmetry across this plane (kept for the next edit, and shown). */
  symmetry?: { origin: Vec3; normal: Vec3 };
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
 * the gap down to a plane - sides straight down to it (along its normal), the
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
 * removed, faces fixed and merged, inside-out solids turned - the shape
 * itself stays. Turns loose faces (an imported mesh or STEP surface) into a solid.
 */
/**
 * Connect: a smooth freeform bridge from one face to another (of two bodies,
 * or of one), made again from the faces on every rebuild. Like an extrude it
 * joins the bodies (Add / Auto), cuts its way through them (Cut), or is a
 * body of its own (New body).
 */
/**
 * A face of a body made freeform: its edges stay where they are, and the face
 * becomes a smooth surface through a grid of points over it - some of them
 * pulled out of it or pushed in.
 */
export interface FaceFreeformFeature extends FeatureBase {
  type: "faceFreeform";
  face: FaceRef;
  /**
   * The cage shaping it, laid over the face: points relative to the face's
   * middle (so it follows the face when an earlier step moves it). Its border
   * runs round the face's edge and stays there; the inside points are moved.
   */
  cage: { verts: Vec3[]; faces: [number, number, number, number][] };
  /** How many cells across the cage was laid (3, 5, 7, 9). */
  grid?: number;
}

export interface ConnectFeature extends FeatureBase {
  type: "connect";
  faces: [FaceRef, FaceRef];
  mode: "auto" | "new" | "join" | "cut";
  /** How far the bridge bows out of each face (1: plain; 0: straight across). */
  bulge?: number;
  /** Its outline, as a fraction of the faces' (1: their own edges). */
  size?: number;
  /** A curve the bridge follows from one face to the other (a sketch spline, say). */
  guide?: PathRef;
}

export interface RepairFeature extends FeatureBase {
  type: "repair";
  bodies: string[];
}

/**
 * Project as Edge: curves drawn onto a body's faces, the faces split along
 * them - a sketch's shapes along its normal (onto the faces seen from it), or
 * edges along a face's normal (onto that face).
 */
export interface ImprintFeature extends FeatureBase {
  type: "imprint";
  body: string;
  source?: ExtrudeSource;
  edges?: EdgeRef[];
  /** With edges: the face they are projected onto. */
  face?: FaceRef;
}

/**
 * Wrap & Emboss: a sketch's shapes wrapped round a round face (lengths kept),
 * raised from it (height > 0) or sunk into it (height < 0).
 */
export interface WrapFeature extends FeatureBase {
  type: "wrap";
  source: ExtrudeSource;
  face: FaceRef;
  height: number;
}

/**
 * Fill: a surface stretched over a network of curves - the boundary (sketch
 * curves and body edges that close a loop) and guide curves inside it that
 * it passes through.
 */
export interface FillFeature extends FeatureBase {
  type: "fill";
  boundary: PathRef[];
  guides?: PathRef[];
  /** Along body edges: just touching (G0), tangent to the face there (G1) or curving on with it (G2). Sketch curves are always G0. */
  continuity?: "g0" | "g1" | "g2";
}

export type Feature =
  | FillFeature
  | ImprintFeature
  | WrapFeature
  | ConnectFeature
  | FaceFreeformFeature
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
  /** BIM: the material of each body (a material id, by body id). */
  materials?: Record<string, string>;
  /** BIM: the project's own materials (beside the library's). */
  customMaterials?: MaterialDef[];
  /** BIM: what the title block of the technical sheet and the drawings says. */
  info?: ProjectInfo;
  /** BIM: the project's one drawing, as projects saved before there could be several had it (read as the first of `drawings`). */
  drawing?: DrawingOptions;
  /** BIM: the project's drawings, each its own sheet. */
  drawings?: DrawingOptions[];
}

/** The drawing sheet: paper size, projection method, scale (missing: the largest that fits), what it shows. */
export interface DrawingOptions {
  /** Which drawing of the project it is. */
  id?: string;
  /** The sheet's title (missing: the project's name). */
  title?: string;
  size?: "A4" | "A3" | "A2" | "A1" | "A0" | "ANSI A" | "ANSI B" | "ANSI C" | "ANSI D" | "ANSI E";
  portrait?: boolean;
  angle?: "first" | "third";
  scale?: number;
  hidden?: boolean;
  /** Old projects: the isometric view on or off (now in `views`). */
  iso?: boolean;
  /** Which views are drawn (missing: all four). */
  views?: { front?: boolean; top?: boolean; side?: boolean; iso?: boolean };
  /** The bodies drawn (missing: every body shown). */
  bodies?: string[];
  /** simple / table (with the parts list) / block (with a revision table): a block in the corner; horizontal: a strip along the bottom; vertical: a column down the right, with a revision table. */
  titleBlock?: "none" | "border" | "simple" | "table" | "block" | "horizontal" | "vertical";
  /** The revision table (Block and Vertical title blocks). */
  revisions?: DrawingRevision[];
  dateFormat?: "iso" | "dmy" | "mdy";
  units?: "mm" | "cm" | "m" | "in";
  /** Decimals shown in dimensions. */
  precision?: number;
  /** Decimals shown in angles. */
  anglePrecision?: number;
  comma?: boolean;
  /** Line widths, mm. */
  lines?: { visible?: number; hidden?: number; dims?: number; center?: number; section?: number };
  balloons?: boolean;
  /** The overall sizes dimensioned by themselves. */
  overall?: boolean;
  /** What was changed on an overall size, by its id (overall-width, overall-height, overall-depth): where it sits, its text, taken off. */
  overallDims?: Record<string, OverallEdit>;
  /** Views moved by hand: mm on the paper, by view. */
  moved?: Record<string, [number, number]>;
  dims?: DrawingDim[];
  notes?: DrawingNote[];
  /** Views added by hand: base views and projections. */
  extra?: DrawingView[];
  /** The isometric view's own scale (missing: picked to fit). */
  isoScale?: number;
  /** Pictures put on the sheet (a logo, a photo). */
  images?: DrawingImage[];
  sections?: DrawingSection[];
  details?: DrawingDetail[];
  /** Centre marks and centrelines. */
  marks?: DrawingMark[];
}

/**
 * A section view (A-A): the model cut along a line drawn on another view,
 * seen square to the cut, lined up with that view.
 */
export interface DrawingSection {
  id: string;
  letter: string;
  /** The view the cut line is on, and the line (that view's coordinates: model mm, y down). */
  view: string;
  a: [number, number];
  b: [number, number];
  /** The way the eye looks, on that view (a unit vector square to the line): where its arrows point. */
  look: [number, number];
  /** How far its middle is from its view's edge (mm on the paper). */
  gap: number;
}

/** Which way a base view looks at the model: a side, or an isometric corner (front/back, right/left). */
export type ViewOrient = "front" | "back" | "top" | "bottom" | "left" | "right" | "iso-fr" | "iso-fl" | "iso-br" | "iso-bl";

/**
 * A view added by hand: a base view (seen from any side or corner, put
 * anywhere), or one projected from another view - square on, lined up with
 * it, or from a corner (an isometric one).
 */
export interface DrawingView {
  id: string;
  /** A base view: the way it looks. */
  orient?: ViewOrient;
  /** A projection: the view it is projected from, and the way it goes from it on the paper (one of eight). */
  view?: string;
  dir?: [number, number];
  /** Projected square on: how far its middle is from its view's edge (mm on the paper). */
  gap?: number;
  /** A base view or an isometric projection: where its middle is on the paper. */
  at?: [number, number];
  /** Its own scale (missing: the sheet's; a lined-up projection always has its view's). */
  scale?: number;
}

/** A picture on the sheet (mm on the paper), kept as a data URL. */
export interface DrawingImage {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  src: string;
}

/** A detail view (B): a circle of another view drawn bigger. */
export interface DrawingDetail {
  id: string;
  letter: string;
  view: string;
  /** The circle (the view's coordinates). */
  c: [number, number];
  r: number;
  /** Its scale (missing: twice its view's). */
  scale?: number;
  /** Where its middle is on the paper. */
  at: [number, number];
}

/** A centre mark on a circle, or a centreline from a to b (a view's coordinates). */
export interface DrawingMark {
  id: string;
  view: string;
  /** cross: an intersection mark - where two edges would meet (a corner rounded off), `c`, from the near ends `a` and `b`. */
  kind: "center" | "line" | "cross";
  c?: [number, number];
  r?: number;
  a?: [number, number];
  b?: [number, number];
}

/** An overall size moved or given text by hand (the rest follows the model). */
export interface OverallEdit extends DimText {
  offset?: number;
  slide?: number;
  /** Taken off (Overall sizes, switched off and on, brings it back). */
  hidden?: boolean;
}

/** What a dimension adds to its value: text before and after, a tolerance. */
export interface DimText {
  prefix?: string;
  suffix?: string;
  /** Symmetrical (± up), deviation (+up / -down), limits (the largest and smallest sizes), basic (boxed). */
  tol?: { kind: "sym" | "dev" | "limits" | "basic"; up?: number; down?: number };
}

/**
 * A dimension put on a drawing: its points in its view's own coordinates
 * (model mm, y down), so it stays on its edge at any scale or place of the view.
 */
export interface DrawingDim extends DimText {
  id: string;
  view: string;
  /** Angle: from ray c→a to ray c→b, its arc `offset` mm (on the paper) from c. */
  kind: "length" | "distance" | "radius" | "diameter" | "angle";
  a: [number, number];
  b?: [number, number];
  /** Circle (radius, diameter): its centre and radius. */
  c?: [number, number];
  r?: number;
  /** How far out from what it measures (mm on the paper); for a circle, past it. */
  offset: number;
  /** Circle: the leader's direction (radians). */
  angle?: number;
  /** A length or distance: its value moved along its line from the middle (mm on the paper, towards b); past an end, the line runs out to it. */
  slide?: number;
  /** An arc's angle: a point on the arc, so the angle goes round the way the arc does (past 180° too). */
  through?: [number, number];
  /** A min-max distance: the nearest and the farthest points of the two things it was measured between (a and b are one pair). */
  minmax?: { min: [[number, number], [number, number]]; max: [[number, number], [number, number]] };
  /** A min-max distance showing the farthest. */
  max?: boolean;
}

/** A note on the sheet (mm on the paper). */
export interface DrawingNote {
  id: string;
  x: number;
  y: number;
  text: string;
  /** What it points at: a point on a view (that view's coordinates), its leader drawn to it. */
  to?: { view: string; p: [number, number] };
}

/** A row of a drawing's revision table. */
export interface DrawingRevision {
  rev: string;
  note?: string;
  date?: string;
  by?: string;
}

/** The title block: who made it, for whom, which revision. */
export interface ProjectInfo {
  author?: string;
  company?: string;
  number?: string;
  revision?: string;
}

/**
 * A real material (see src/bim/materials.ts). Strengths in MPa, stiffness in
 * GPa, density in kg/m³, conductivity in W/(m·K), specific heat in J/(kg·K),
 * expansion in µm/(m·K). What isn't known is left out.
 */
export interface MaterialDef {
  id: string;
  name: string;
  category: string;
  /** The standard the grade is defined in (or the data comes from). */
  standard?: string;
  note?: string;
  /** How a body of it shows: "#rrggbb", and how see-through (glass). */
  color: string;
  opacity?: number;
  density: number;
  youngs?: number;
  poisson?: number;
  yield?: number;
  tensile?: number;
  compressive?: number;
  bending?: number;
  expansion?: number;
  conductivity?: number;
  specificHeat?: number;
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
  /** A subfolder: the folder it sits in (missing: at the top). */
  parent?: string;
}

export function emptyDoc(): ProjectDoc {
  return { format: "super", version: 2, name: "Untitled", features: [], variables: [], views: [], units: "mm", hidden: [], pins: [], names: {} };
}

/** A sketch curve that follows a body's edge (see SketchFeature.links). */
export interface EdgeLink {
  /** The curve. */
  id: string;
  edge: EdgeRef;
}

/** An offset of a face outline in a sketch on that face (see SketchFeature.outlineOffsets). */
export interface OutlineOffset {
  id: string;
  /** Positive grows a closed outline outward, negative goes inside it. */
  distance: number;
  /** Where the outline was tapped (sketch coordinates): the loop nearest it is offset. */
  at: Vec2;
}
