// Connect border edges of freeform surfaces (pure document logic): two rows of
// edges get a strip of quads between them, two hole rims a tube. Edges on two
// different freeforms make them one freeform (so the whole thing can then be
// given a thickness). Like making a face from edges in a mesh modeller.

import { borderChains, borderEdgeMids, bridgeChains, cageEdgeKey, joinCages, flipFaces, windingAgrees, type Cage, type Chain } from "../freeform/cage";
import { applyAffine, freeformBodies, invertAffine } from "./freeformCopies";
import type { Feature, FreeformFeature, ProjectDoc, TransformFeature, Vec3 } from "./types";

/** A picked edge of a finished body: which body, and its middle point (world). */
export interface PickedEdge {
  body: string;
  mid: Vec3;
}

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** The cage of a freeform body where the body is (moves later in History applied). */
function worldCage(doc: ProjectDoc, body: string): { feature: FreeformFeature; cage: Cage; m: number[] } | null {
  const ff = freeformBodies(doc.features).get(body);
  if (!ff || ff.feature.id !== body) return null;
  return { feature: ff.feature, m: ff.m, cage: { faces: ff.feature.cage.faces, verts: ff.feature.cage.verts.map((v) => applyAffine(ff.m, v)) } };
}

/** The open-border cage edges under the picked body edges (null if one isn't on a border). */
function cageEdgesAt(cage: Cage, picks: Vec3[]): Set<string> | null {
  const mids = borderEdgeMids(cage);
  if (!mids.length) return null;
  const chosen = new Set<string>();
  for (const p of picks) {
    let best = mids[0];
    for (const m of mids) if (dist(m.at, p) < dist(best.at, p)) best = m;
    // Far from every border edge: an inner edge, or another part of the shape.
    const [a, b] = best.e;
    const L = dist(cage.verts[a], cage.verts[b]);
    if (dist(best.at, p) > Math.max(L * 0.35, 1e-6)) return null;
    chosen.add(cageEdgeKey(a, b));
  }
  return chosen;
}

export type ConnectResult = { doc: ProjectDoc; body: string } | { error: string };

/** Can these picked edges be connected (for showing the button)? */
export function canConnect(doc: ProjectDoc, picks: PickedEdge[]): boolean {
  const bodies = [...new Set(picks.map((p) => p.body))];
  return picks.length >= 2 && bodies.length <= 2 && bodies.every((b) => !!worldCage(doc, b));
}

/**
 * Connect the picked border edges. They must make two runs with the same
 * number of edges (two edges, two rows, or two hole rims), on one freeform or
 * on two. Two freeforms become one: the later one in History keeps the result
 * and the earlier one goes.
 */
export function connectEdges(doc: ProjectDoc, picks: PickedEdge[]): ConnectResult {
  const bodies = [...new Set(picks.map((p) => p.body))];
  if (bodies.length > 2) return { error: "Pick edges on one or two freeform surfaces" };
  const parts = bodies.map((b) => worldCage(doc, b));
  if (parts.some((p) => !p)) return { error: "Connect works on freeform surfaces - edit the shape's cage first" };
  const [P, Q] = parts as NonNullable<(typeof parts)[number]>[];
  // One cage holding everything, and the chosen border edges in it.
  let cage = P.cage;
  let offset = 0;
  if (Q) ({ cage, offset } = joinCages(P.cage, Q.cage));
  const chosen = new Set<string>();
  for (const [k, part] of parts.entries()) {
    const at = cageEdgesAt(part!.cage, picks.filter((p) => p.body === bodies[k]).map((p) => p.mid));
    if (!at) return { error: "Pick edges along an open border (the rim of a surface or of a hole)" };
    const o = k === 0 ? 0 : offset;
    for (const key of at) {
      const [a, b] = key.split(",").map(Number);
      chosen.add(cageEdgeKey(a + o, b + o));
    }
  }
  const runs = borderChains(cage, chosen);
  if (runs.length !== 2) return { error: runs.length < 2 ? "Pick the edges on both sides you want to connect" : "Pick two runs of edges (one on each side) to connect" };
  const [A, B] = runs as [Chain, Chain];
  const edges = (c: Chain) => (c.closed ? c.verts.length : c.verts.length - 1);
  if (A.closed !== B.closed) return { error: "Connect a hole with a hole, or a row of edges with a row" };
  if (edges(A) !== edges(B)) return { error: `Both sides need the same number of edges (${edges(A)} and ${edges(B)})` };
  let next = bridgeChains(cage, A, B);
  if (!next) return { error: "These edges can't be connected (they touch each other)" };
  // Two surfaces facing opposite ways: turn the second one round so they join up.
  if (Q && !windingAgrees(next)) {
    const flipped = bridgeChains(flipFaces(cage, (i) => i >= P.cage.faces.length), A, B);
    if (flipped && windingAgrees(flipped)) next = flipped;
  }
  if (!Q) return { doc: store(doc, P.feature, next, P.m), body: P.feature.id };
  // Two freeforms → one: the later step keeps it, the earlier one goes.
  const ia = doc.features.indexOf(P.feature);
  const ib = doc.features.indexOf(Q.feature);
  const [keep, drop, mKeep] = ia < ib ? [Q.feature, P.feature, Q.m] : [P.feature, Q.feature, P.m];
  const users = doc.features.filter((f) => f !== drop && JSON.stringify(f).includes(`"${drop.id}`) && !(f.type === "transform" && !f.copy && ["move", "scale", "mirror", "scaleXYZ"].includes(f.op.kind)));
  if (users.length) return { error: `“${drop.name}” is used by “${users[0].name}” later on - it can't be merged into the other surface` };
  const out = store(doc, keep, next, mKeep, { surface: !!(keep.surface || drop.surface) });
  // The dropped one's own moves go with it (they are already in the merged cage).
  out.features = out.features
    .filter((f) => f.id !== drop.id)
    .map((f) => (f.type === "transform" && f.bodies.includes(drop.id) ? ({ ...f, bodies: f.bodies.filter((b) => b !== drop.id) } as TransformFeature) : f))
    .filter((f) => !(f.type === "transform" && !f.bodies.length));
  out.hidden = out.hidden.filter((h) => h !== drop.id);
  return { doc: out, body: keep.id };
}

/** Put a world-space cage back into a freeform step (in its own coordinates). */
function store(doc: ProjectDoc, f: FreeformFeature, cage: Cage, m: number[], extra: Partial<FreeformFeature> = {}): ProjectDoc {
  const inv = invertAffine(m);
  const updated: FreeformFeature = { ...f, ...extra, cage: { faces: cage.faces, verts: cage.verts.map((v) => applyAffine(inv, v)) } };
  return { ...doc, features: doc.features.map((x): Feature => (x.id === f.id ? updated : x)) };
}
