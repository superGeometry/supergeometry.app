// Copies of freeform bodies as their own freeforms (pure document logic).
//
// A Move/Copy step copies a body; for a freeform that copy would still be
// built from the original's cage, so editing either one changed both. Unless
// the copy is linked, it becomes an independent freeform feature with its own
// (moved) cage - edits on it stay on it.

import type { Feature, FreeformFeature, ProjectDoc, TransformFeature, Vec3 } from "./types";

/** x' = A x + t as rows [a00 a01 a02 t0, …]. */
export type Affine = number[];
const ID: Affine = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

export const applyAffine = (m: Affine, p: Vec3): Vec3 => [0, 1, 2].map((r) => m[r * 4] * p[0] + m[r * 4 + 1] * p[1] + m[r * 4 + 2] * p[2] + m[r * 4 + 3]) as Vec3;

function then(m: Affine, n: Affine): Affine {
  const out: number[] = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) out.push(n[r * 4] * m[c] + n[r * 4 + 1] * m[4 + c] + n[r * 4 + 2] * m[8 + c]);
    out.push(n[r * 4] * m[3] + n[r * 4 + 1] * m[7] + n[r * 4 + 2] * m[11] + n[r * 4 + 3]);
  }
  return out;
}

export const det = (m: Affine) => m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8]) + m[2] * (m[4] * m[9] - m[5] * m[8]);

function rotate(p: Vec3, o: Vec3, axis: Vec3, deg: number): Vec3 {
  const l = Math.hypot(...axis) || 1;
  const k: Vec3 = [axis[0] / l, axis[1] / l, axis[2] / l];
  const v: Vec3 = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const kv = k[0] * v[0] + k[1] * v[1] + k[2] * v[2];
  const x: Vec3 = [k[1] * v[2] - k[2] * v[1], k[2] * v[0] - k[0] * v[2], k[0] * v[1] - k[1] * v[0]];
  return [0, 1, 2].map((i) => o[i] + v[i] * c + x[i] * s + k[i] * kv * (1 - c)) as Vec3;
}

function fromMap(f: (p: Vec3) => Vec3): Affine {
  const o = f([0, 0, 0]);
  const cols = ([[1, 0, 0], [0, 1, 0], [0, 0, 1]] as Vec3[]).map((e) => f(e).map((x, i) => x - o[i]));
  return [0, 1, 2].flatMap((r) => [cols[0][r], cols[1][r], cols[2][r], o[r]]);
}

/** The map of a move / scale / mirror step (null for patterns). */
export function stepAffine(op: TransformFeature["op"]): Affine | null {
  switch (op.kind) {
    case "move": {
      const r = op.rotate && Math.abs(op.rotate.angle) > 1e-9 ? op.rotate : null;
      return fromMap((p) => {
        const q = r ? rotate(p, r.origin, r.axis, r.angle) : p;
        return [q[0] + op.translate[0], q[1] + op.translate[1], q[2] + op.translate[2]];
      });
    }
    case "scale":
      return fromMap((p) => p.map((x, i) => op.center[i] + (x - op.center[i]) * op.factor) as Vec3);
    case "scaleXYZ":
      return fromMap((p) => p.map((x, i) => op.center[i] + (x - op.center[i]) * op.factors[i]) as Vec3);
    case "mirror": {
      const n = op.plane.normal;
      const l = Math.hypot(...n) || 1;
      const k: Vec3 = [n[0] / l, n[1] / l, n[2] / l];
      return fromMap((p) => {
        const d = (p[0] - op.plane.origin[0]) * k[0] + (p[1] - op.plane.origin[1]) * k[1] + (p[2] - op.plane.origin[2]) * k[2];
        return [p[0] - 2 * d * k[0], p[1] - 2 * d * k[1], p[2] - 2 * d * k[2]];
      });
    }
    default:
      return null;
  }
}

/**
 * Which bodies are (still) a freeform's cage moved about, after the first
 * `upto` features: like the engine, anything other than a move/scale/mirror
 * touching a body makes it an ordinary body.
 */
export function freeformBodies(features: readonly Feature[], upto = features.length): Map<string, { feature: FreeformFeature; m: Affine }> {
  const out = new Map<string, { feature: FreeformFeature; m: Affine }>();
  for (const f of features.slice(0, upto)) {
    if (f.suppressed) continue;
    if (f.type === "freeform") {
      out.set(f.id, { feature: f, m: ID });
      continue;
    }
    if (f.type === "transform") {
      const step = stepAffine(f.op);
      for (const id of f.bodies) {
        const ff = out.get(id);
        if (!ff) continue;
        if (!step) continue; // a pattern: the copies are ordinary bodies
        if (f.copy) out.set(`${f.id}:${id}:0`, { feature: ff.feature, m: then(ff.m, step) });
        else out.set(id, { feature: ff.feature, m: then(ff.m, step) });
      }
      continue;
    }
    const text = JSON.stringify(f);
    for (const id of [...out.keys()]) if (text.includes(`"${id}"`)) out.delete(id);
  }
  return out;
}

/** Body ids inside a JSON text: `old` (alone or as part of a copy's id) becomes `now`. */
function renameIn(text: string, old: string, now: string): string {
  const esc = old.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`([":])${esc}(?=[":])`, "g"), `$1${now}`);
}

/**
 * Turn a freeform body made by a copy step into its own freeform feature (in
 * the copy step's place). Later steps that use the copy use the new feature.
 * Returns the new features and the new body id (null when it isn't a
 * freeform copy).
 */
export function detachFreeformCopy(doc: ProjectDoc, bodyId: string, newId: string): { doc: ProjectDoc; id: string } | null {
  const [tid, ...rest] = bodyId.split(":");
  if (rest.length < 2) return null;
  const src = rest.slice(0, -1).join(":");
  const i = doc.features.findIndex((f) => f.id === tid);
  const t = doc.features[i] as TransformFeature | undefined;
  if (!t || t.type !== "transform" || !t.copy || t.link || !t.bodies.includes(src)) return null;
  const ff = freeformBodies(doc.features, i + 1).get(bodyId);
  if (!ff) return null;
  const flip = det(ff.m) < 0;
  const clone: FreeformFeature = {
    ...structuredClone(ff.feature),
    id: newId,
    name: t.name,
    cage: {
      verts: ff.feature.cage.verts.map((v) => applyAffine(ff.m, v)),
      // A mirror turns the shape inside out: wind the quads the other way.
      faces: ff.feature.cage.faces.map((q) => (flip ? ([q[0], q[3], q[2], q[1]] as typeof q) : ([...q] as typeof q))),
    },
  };
  const features = [...doc.features];
  const left = t.bodies.filter((b) => b !== src);
  if (left.length) features.splice(i, 1, { ...t, bodies: left }, clone);
  else features.splice(i, 1, clone);
  const rename = <T>(x: T): T => JSON.parse(renameIn(JSON.stringify(x), bodyId, newId)) as T;
  const at = features.indexOf(clone);
  const out: ProjectDoc = {
    ...doc,
    features: [...features.slice(0, at + 1), ...features.slice(at + 1).map(rename)],
    hidden: rename(doc.hidden),
    names: Object.fromEntries(Object.entries(doc.names ?? {}).map(([k, v]) => [renameIn(`"${k}"`, bodyId, newId).slice(1, -1), v])),
  };
  if (doc.colors) out.colors = Object.fromEntries(Object.entries(doc.colors).map(([k, v]) => [renameIn(`"${k}"`, bodyId, newId).slice(1, -1), v]));
  if (doc.materials) out.materials = Object.fromEntries(Object.entries(doc.materials).map(([k, v]) => [renameIn(`"${k}"`, bodyId, newId).slice(1, -1), v]));
  // The copy's name in Items stays what it was.
  if (!out.names?.[newId] && doc.names?.[bodyId]) out.names = { ...out.names, [newId]: doc.names[bodyId] };
  return { doc: out, id: newId };
}

/** The map that undoes m. */
export function invertAffine(m: Affine): Affine {
  const [a, b, c, , d, e, f, , g, h, i] = m;
  const D = det(m);
  const inv = [(e * i - f * h) / D, (c * h - b * i) / D, (b * f - c * e) / D, (f * g - d * i) / D, (a * i - c * g) / D, (c * d - a * f) / D, (d * h - e * g) / D, (b * g - a * h) / D, (a * e - b * d) / D];
  const t = [m[3], m[7], m[11]];
  const out: Affine = [];
  for (let r = 0; r < 3; r++) out.push(inv[r * 3], inv[r * 3 + 1], inv[r * 3 + 2], -(inv[r * 3] * t[0] + inv[r * 3 + 1] * t[1] + inv[r * 3 + 2] * t[2]));
  return out;
}
