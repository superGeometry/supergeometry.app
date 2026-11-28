// A feature of a body with everything that was built on it: the step that made it, and the later steps that
// worked on its faces and edges - a fillet round a boss's foot, a hole drilled in it, a pocket cut from a sketch
// drawn on it. Mirrored or patterned, the feature comes whole. (Pure: the project's steps in, step ids out.)

import type { Feature } from "./types";

/** What a step refers to: the steps whose faces and edges it names, and the sketches it is made from. */
function refsOf(v: unknown, steps: Set<string>, sketches: Set<string>): void {
  if (Array.isArray(v)) {
    for (const x of v) refsOf(x, steps, sketches);
    return;
  }
  if (!v || typeof v !== "object") return;
  const o = v as Record<string, unknown>;
  // (A face is named by the step that made it; an edge by the steps of the faces either side.)
  if (typeof o.step === "string" && Array.isArray(o.center)) steps.add(o.step);
  if (Array.isArray(o.steps) && Array.isArray(o.mid)) for (const s of o.steps) if (typeof s === "string") steps.add(s);
  if (typeof o.sketch === "string") sketches.add(o.sketch);
  for (const [k, x] of Object.entries(o)) {
    // (Nothing to find in a file's bytes, a sketch's curves or its list of steps - and they can be long.)
    if (k === "data" || k === "entities" || k === "log" || k === "constraints") continue;
    refsOf(x, steps, sketches);
  }
}

/**
 * The steps named (`seeds`) and every later step built on what they made, in the order of the project's history.
 * A sketch drawn on the feature is not one of them itself, but what is made from it is.
 */
export function featureFamily(features: readonly Feature[], seeds: string[]): string[] {
  const family = new Set(seeds);
  const drawnOn = new Set<string>();
  const first = features.findIndex((f) => family.has(f.id));
  if (first < 0) return [];
  for (const g of features.slice(first + 1)) {
    if (family.has(g.id) || g.suppressed || g.rolledBack) continue;
    // (A mirror or a pattern of features is not built on them: it repeats them. Mirrored again, it is not one of the family.)
    if (g.type === "transform" && (g.steps?.length || g.hole)) continue;
    const steps = new Set<string>();
    const sketches = new Set<string>();
    refsOf(g, steps, sketches);
    const on = [...steps].some((s) => family.has(s)) || [...sketches].some((s) => drawnOn.has(s));
    if (!on) continue;
    if (g.type === "sketch") drawnOn.add(g.id);
    else if (g.type !== "plane" && g.type !== "axis") family.add(g.id);
  }
  return features.filter((f) => family.has(f.id)).map((f) => f.id);
}

/** A step made after a mirror or a pattern of features, on one of its sides. */
export interface SideOf {
  /** The mirror or pattern step. */
  repeat: string;
  /** Built on the feature itself, or on one of the copies that step made. */
  side: "original" | "copy";
}

/**
 * The steps that come after a mirror or a pattern of features and are built on it - on the feature it repeats, or
 * on a copy it made - each with which. What such a step does on its side is done on the others too: the two sides
 * of a mirror stay alike, whichever is changed. (A step built on both sides at once is left as it is.)
 */
export function featureLinks(features: readonly Feature[]): Map<string, SideOf[]> {
  const out = new Map<string, SideOf[]>();
  features.forEach((m, at) => {
    if (m.type !== "transform" || !m.steps?.length || m.unlinked || m.suppressed || m.rolledBack) return;
    const later = new Set(features.slice(at + 1).map((f) => f.id));
    const seeds = new Set(m.steps);
    const original = new Set(featureFamily(features, m.steps).filter((id) => later.has(id) && !seeds.has(id)));
    const copy = new Set(featureFamily(features, [m.id]).filter((id) => later.has(id) && id !== m.id));
    for (const id of new Set([...original, ...copy])) {
      if (original.has(id) && copy.has(id)) continue;
      out.set(id, [...(out.get(id) ?? []), { repeat: m.id, side: original.has(id) ? "original" : "copy" }]);
    }
  });
  return out;
}
