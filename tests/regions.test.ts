// Run: npx tsx tests/regions.test.ts
import assert from "node:assert/strict";
import type { SketchEntity } from "../src/doc/types";
import { arrangement } from "../src/sketch/regions";

const rect = (id: string, cx: number, cy: number, w: number, h: number): SketchEntity => ({ id, kind: "rect", center: [cx, cy], w, h, rotation: 0 });
const line = (id: string, a: [number, number], b: [number, number]): SketchEntity => ({ id, kind: "line", a, b });
const summary = (es: SketchEntity[]) =>
  arrangement(es)
    .regions.map((r) => `${r.area.toFixed(2)}${r.holes.length ? `(h${r.holes.length})` : ""}`)
    .sort();

const cases: [string, SketchEntity[], string[]][] = [
  ["single rect", [rect("a", 0, 0, 20, 10)], ["200.00"]],
  // Areas are of the display polygons (96 segments per circle), not exact.
  ["circle in rect → ring + disk", [rect("a", 0, 0, 40, 20), { id: "c", kind: "circle", center: [0, 0], radius: 5 }], ["721.52(h1)", "78.48"]],
  ["two overlapping rects → 3", [rect("a", 0, 0, 20, 20), rect("b", 10, 10, 20, 20)], ["100.00", "300.00", "300.00"]],
  ["four lines → square", [line("1", [0, 0], [10, 0]), line("2", [10, 0], [10, 10]), line("3", [10, 10], [0, 10]), line("4", [0, 10], [0, 0])], ["100.00"]],
  ["line through rect → 2", [rect("a", 0, 0, 20, 10), line("l", [0, -10], [0, 10])], ["100.00", "100.00"]],
  ["D shape (arc + line)", [line("l", [-10, 0], [10, 0]), { id: "a", kind: "arc", a: [10, 0], m: [0, 10], b: [-10, 0] }], ["156.97"]],
  ["dangling line ignored", [rect("a", 0, 0, 20, 10), line("l", [10, 0], [30, 0])], ["200.00"]],
  ["line ending inside splits nothing", [rect("a", 0, 0, 20, 10), line("l", [0, 0], [30, 0])], ["200.00"]],
  ["ellipse", [{ id: "e", kind: "ellipse", center: [0, 0], rx: 10, ry: 5, rotation: 0.3 }], ["156.97"]],
  ["construction ignored", [rect("a", 0, 0, 20, 10), { ...line("l", [0, -10], [0, 10]), construction: true }], ["200.00"]],
  ["closed spline", [{ id: "s", kind: "spline", points: [[0, 0], [10, 0], [10, 10], [0, 10]], closed: true, mode: "fit" }], ["*"]],
  ["two circles crossing → 3", [{ id: "c1", kind: "circle", center: [0, 0], radius: 10 }, { id: "c2", kind: "circle", center: [10, 0], radius: 10 }], ["*", "*", "*"]],
  // Lines drawn over a face's outline (the rect): the doubled edges count once.
  ["lines on a rect's edges → 2", [rect("f", 0, 0, 20, 10), line("1", [-10, -5], [0, -5]), line("2", [0, -5], [0, 5]), line("3", [0, 5], [-10, 5]), line("4", [-10, 5], [-10, -5])], ["100.00", "100.00"]],
  ["partly overlapping lines → square", [line("1", [0, 0], [10, 0]), line("1b", [3, 0], [14, 0]), line("2", [10, 0], [10, 10]), line("3", [10, 10], [0, 10]), line("4", [0, 10], [0, 0])], ["100.00"]],
];

let failed = 0;
for (const [name, es, expected] of cases) {
  const got = summary(es);
  try {
    assert.equal(got.length, expected.length);
    expected.forEach((e, i) => e === "*" || assert.equal(got[i], e));
    console.log("ok  ", name, got.join(" "));
  } catch {
    failed++;
    console.log("FAIL", name, "got", got.join(" "), "expected", expected.join(" "));
  }
}
process.exit(failed ? 1 : 0);
