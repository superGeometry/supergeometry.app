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
}

export interface EdgeInfo {
  mid: Vec3;
  dir: Vec3;
  length: number;
  start: Vec3;
  end: Vec3;
  /** LINE, CIRCLE, ELLIPSE, BSPLINE_CURVE… */
  type: string;
}

export interface BodyMesh {
  id: string;
  name: string;
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
  planes: ConstructionInfo[];
  axes: ConstructionInfo[];
  errors: FeatureError[];
  ms: number;
}

export type ExportFormat = "stl" | "step";

export type Request =
  | { type: "init" }
  | { type: "regenerate"; features: Feature[] }
  | { type: "export"; features: Feature[]; format: ExportFormat; bodies?: string[] };

export type Response =
  | { type: "ready" }
  | { type: "regenerated"; result: RegenResult }
  | { type: "exported"; blob: Blob }
  | { type: "error"; message: string };

export interface Envelope<T> {
  id: number;
  msg: T;
}
