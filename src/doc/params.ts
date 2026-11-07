// Parametric document: evaluate expressions (variables) into feature values and
// re-solve sketch constraints, so the document's numbers are always consistent.

import { solveFine } from "../sketch/constraints";
import { evaluate, setVariables } from "../units";
import type { Feature, ProjectDoc } from "./types";

/** Kind of value stored at a path (for units: lengths are mm, angles degrees). */
export function kindOfPath(path: string): "length" | "angle" | "number" {
  const last = path.split(".").pop() ?? "";
  if (/angle|rot/i.test(last) || /rotate/.test(path)) return "angle";
  if (/count|factor|sides|opacity/i.test(last)) return "number";
  return "length";
}

export function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), obj);
}

export function setPath(obj: unknown, path: string, value: unknown): void {
  const keys = path.split(".");
  let o = obj as Record<string, unknown>;
  for (const k of keys.slice(0, -1)) {
    if (o[k] == null) return;
    o = o[k] as Record<string, unknown>;
  }
  o[keys[keys.length - 1]] = value;
}

/** Recompute every expression-driven value and re-solve constrained sketches (in place). */
export function resolveDoc(doc: ProjectDoc): string[] {
  const problems: string[] = [];
  setVariables(doc.variables ?? []);
  for (const f of doc.features as Feature[]) {
    for (const [path, expr] of Object.entries(f.exprs ?? {})) {
      const v = evaluate(expr, kindOfPath(path));
      if (v === null) problems.push(`${f.name}: "${expr}" can't be evaluated`);
      else setPath(f, path, v);
    }
    if (f.type === "sketch" && f.constraints?.length) {
      for (const c of f.constraints) {
        if (!c.expr) continue;
        const v = evaluate(c.expr, c.prop === "angle" ? "angle" : "length");
        if (v === null) problems.push(`${f.name}: "${c.expr}" can't be evaluated`);
        else c.value = v;
      }
      const r = solveFine(f.entities, f.constraints);
      // Can't all be met: the sketch stays as it was rather than being bent out of shape.
      // Met already (only rounding noise in the 14th digit): kept exactly as it
      // was - the noise changed the step, and every change anywhere (a colour,
      // a name, an eye in Items) rebuilt everything after the sketch: 20 s a
      // time on a desk fan.
      if (!r.ok) problems.push(`${f.name}: constraints can't all be met`);
      else if (!sameNumbers(f.entities, r.entities, 1e-9)) f.entities = r.entities;
    }
  }
  return problems;
}

/** The same structure with every number within `tol` of the other's. */
function sameNumbers(a: unknown, b: unknown, tol: number): boolean {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= tol;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => sameNumbers(x, b[i], tol));
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    return ka.length === kb.length && ka.every((k) => sameNumbers((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], tol));
  }
  return a === b;
}
