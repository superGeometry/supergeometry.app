// Parametric document: evaluate expressions (variables) into feature values and
// re-solve sketch constraints, so the document's numbers are always consistent.

import { solve } from "../sketch/constraints";
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
      const r = solve(f.entities, f.constraints);
      f.entities = r.entities;
      if (!r.ok) problems.push(`${f.name}: constraints can't all be met`);
    }
  }
  return problems;
}
