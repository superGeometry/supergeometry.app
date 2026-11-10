// Messages between the main thread and the kernel worker. This file is the
// whole contract: the UI never touches kernel objects directly.

import type { Feature, PlaneDef, SketchEntity, Vec3 } from "../doc/types";

export interface FaceInfo {
  center: Vec3;
  normal: Vec3;
  area: number;
  /** OpenCascade surface type: PLANE, CYLINDRE (sic), CONE, SPHERE, BSPLINE_SURFACE… */
  type: string;
  /** Set for flat faces: the plane a sketch on this face would use. */
  plane?: PlaneDef;
  /** Set for round (cylindrical) faces: the radius, and whether it's a hole (material outside it). */
  round?: { r: number; hole: boolean };
  /** The step that made it (see provenance.ts). */
  step?: string;
  /** Which of that step's faces it is (the sketch curve it came from; see FaceRef.curve). */
  curve?: string;
}

export interface EdgeInfo {
  mid: Vec3;
  dir: Vec3;
  length: number;
  start: Vec3;
  end: Vec3;
  /** LINE, CIRCLE, ELLIPSE, BSPLINE_CURVE… */
  type: string;
  /** The steps that made the faces either side (sorted). */
  steps?: string[];
  /** Which faces of those steps (see EdgeRef.curves). */
  curves?: string[];
}

export interface BodyMesh {
  id: string;
  name: string;
  /**
   * Which mesh this is: the same key, the same geometry (a body the step
   * didn't change). The worker sends only the key for a mesh the page already
   * has, and the view keeps what it drew for it.
   */
  key: number;
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** Triangle ranges (in index units) per face. */
  faceGroups: { start: number; count: number; face: number }[];
  /** Line-segment vertex pairs for all edges. */
  edgePositions: Float32Array;
  /** Ranges (in vertex units of edgePositions) per edge. */
  edgeGroups: { start: number; count: number; edge: number }[];
  faces: FaceInfo[];
  edges: EdgeInfo[];
  /** Edges with fewer than two faces: the body isn't closed there (not watertight). */
  openEdges: number[];
}

/** A construction plane or axis (for an axis, plane.normal is its direction). */
export interface ConstructionInfo {
  id: string;
  name: string;
  plane: PlaneDef;
  /** A construction plane: how it was made (offset, midplane, 3 points…). */
  kind?: string;
}

export interface FeatureError {
  featureId: string;
  message: string;
}

export interface RegenResult {
  bodies: BodyMesh[];
  /** Current plane of every sketch (sketches on faces follow the face). */
  sketchPlanes: Record<string, PlaneDef>;
  /** Outline of the face each face-attached sketch sits on (takes part in its regions). */
  sketchBoundaries: Record<string, SketchEntity[]>;
  /** Sketches whose curves the engine moved (they follow a body's edge that changed): their curves as they are now. */
  sketchEntities?: Record<string, SketchEntity[]>;
  planes: ConstructionInfo[];
  axes: ConstructionInfo[];
  errors: FeatureError[];
  /** Steps that worked but had to give something up (a fillet that no longer fits…). */
  notes?: FeatureError[];
  ms: number;
  /** The engine's memory after it (MB): it never gives any back, so the page starts a fresh engine when it's big. */
  memoryMB?: number;
}

/** A body's physical properties, measured on the solid itself (mm, mm², mm³). */
export interface BodyProps {
  id: string;
  name: string;
  volume: number;
  area: number;
  /** Centre of mass (of the shape, as if all of one material). */
  center: Vec3;
  /** Its box: lowest corner, highest corner. */
  box: [Vec3, Vec3];
}

/** A view to draw: the model seen from `dir` (towards the viewer), `xAxis` to the right on the paper. */
export interface ViewSpec {
  id: string;
  dir: Vec3;
  xAxis: Vec3;
}

/** One body in a drawn view: SVG path data (mm on the paper at 1:1, y down). */
export interface ViewBody {
  id: string;
  /** Edges seen. */
  visible: string;
  /** Where two faces meet smoothly (drawn thin). */
  tangent: string;
  /** Edges behind (drawn dashed). */
  hidden: string;
  /** A point on one of its seen edges, near its middle: where a balloon's leader ends. */
  anchor?: [number, number];
}

/** A drawn view: each body, and the box around them all (2D, y down). */
export interface ProjectedView {
  id: string;
  bodies: ViewBody[];
  box: [[number, number], [number, number]] | null;
}

/** "mesh": each body as triangles, as finely as an STL (for a 3MF), JSON: { id, positions, indices }[]. */
export type ExportFormat = "stl" | "step" | "mesh";

export type Request =
  | { type: "init" }
  | { type: "regenerate"; features: Feature[]; saved?: boolean }
  | { type: "export"; features: Feature[]; format: ExportFormat; bodies?: string[] }
  | { type: "properties"; features: Feature[] }
  | { type: "drawing"; features: Feature[]; views: ViewSpec[]; bodies?: string[] };

export type Response =
  | { type: "ready" }
  | { type: "regenerated"; result: RegenResult }
  | { type: "exported"; blob: Blob }
  | { type: "properties"; bodies: BodyProps[] }
  | { type: "drawing"; views: ProjectedView[] }
  | { type: "error"; message: string };

export interface Envelope<T> {
  id: number;
  msg: T;
}
