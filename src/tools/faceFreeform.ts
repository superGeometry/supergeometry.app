// Freeform Face: a flat face of a body made a smooth surface. A cage is laid
// over the face - a grid whose border runs round the face's edge - and shaped
// in the Freeform tool: tap its points, edges or faces and move them with the
// gimbal (along the face, or out of it). The border stays put, so the face's
// edges, and the rest of the body, don't move.

import type { FaceFreeformFeature, FaceRef, Vec3 } from "../doc/types";
import { FreeformTool, layFaceCage } from "./freeform";
import { faceRefOf, type AppContext, type Sel, type Tool } from "./tool";

/** The triangles of face `i` of a body as shown (the cage goes only where the face is). */
function faceTriangles(app: AppContext, body: string, i: number): [Vec3, Vec3, Vec3][] {
  const b = app.view.body(body);
  const g = b?.faceGroups.find((x) => x.face === i);
  if (!b || !g) return [];
  const P = (k: number): Vec3 => [b.positions[3 * k], b.positions[3 * k + 1], b.positions[3 * k + 2]];
  const out: [Vec3, Vec3, Vec3][] = [];
  for (let t = g.start; t < g.start + g.count; t += 3) out.push([P(b.indices[t]), P(b.indices[t + 1]), P(b.indices[t + 2])]);
  return out;
}

/** The face most like a saved one (facing the same way, its middle nearest), or -1. */
function nearestFace(faces: { center: Vec3; normal: Vec3 }[], ref: FaceRef): number {
  let best = -1;
  let d = Infinity;
  faces.forEach((f, k) => {
    if (f.normal[0] * ref.normal[0] + f.normal[1] * ref.normal[1] + f.normal[2] * ref.normal[2] < 0.999) return;
    const e = Math.hypot(f.center[0] - ref.center[0], f.center[1] - ref.center[1], f.center[2] - ref.center[2]);
    if (e < d) ((d = e), (best = k));
  });
  return best;
}

/**
 * The Freeform tool on a face: `face`, a flat face to shape (a new step), or
 * `existing`, a Freeform Face step to change (its face found on the body by
 * the step that made it). Null (after saying why) when no cage fits the face.
 */
export function faceFreeformTool(app: AppContext, face: Extract<Sel, { kind: "face" }> | null, existing?: FaceFreeformFeature): Tool | null {
  if (existing) {
    const faces = app.view.body(existing.face.body)?.faces ?? [];
    let i = faces.findIndex((f) => f.step === existing.id);
    // The step didn't work (so its face isn't there): the flat face it was made on.
    if (i < 0) i = nearestFace(faces, existing.face);
    // (Over a face already shaped the cage is laid on its outline, which is the flat face's.)
    const tris = i >= 0 ? faceTriangles(app, existing.face.body, i) : [];
    const feature = structuredClone(existing);
    if (!feature.cage?.verts?.length) {
      // Made before faces had cages: a fresh one over it.
      const laid = layFaceCage(tris, feature.face.center, feature.face.normal, 5);
      if (!laid) return (app.ui.toast("This face's outline won't take a grid - pick it again with Freeform Face"), null);
      feature.cage = laid.cage;
      feature.grid = laid.n;
    }
    return new FreeformTool(app, { face: { feature, existing: true, tris } });
  }
  const ref = face && (faceRefOf(app, face) as FaceRef | null);
  if (!face || !ref) return null;
  const tris = faceTriangles(app, face.body, face.face);
  const laid = layFaceCage(tris, ref.center, ref.normal, 5);
  if (!laid) return (app.ui.toast("This face's outline won't take a grid (too small, or too odd a shape)"), null);
  const feature: FaceFreeformFeature = { ...app.store.newIdentity("faceFreeform"), type: "faceFreeform", face: ref, cage: laid.cage, grid: laid.n };
  return new FreeformTool(app, { face: { feature, existing: false, tris } });
}
