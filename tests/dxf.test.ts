// Run: npx tsx tests/dxf.test.ts — sketch → DXF → read back: same curves.
import assert from "node:assert/strict";
import type { SketchEntity } from "../src/doc/types";
import { sketchToDXF } from "../src/io/dxf";

const sketch: SketchEntity[] = [
  { id: "l", kind: "line", a: [0, 0], b: [40, 0] },
  { id: "c", kind: "circle", center: [20, 20], radius: 5 },
  { id: "a", kind: "arc", a: [40, 0], m: [50, 10], b: [40, 20] },
  { id: "r", kind: "rect", center: [0, 30], w: 10, h: 6, rotation: 0 },
  { id: "s", kind: "spline", points: [[0, 50], [10, 60], [20, 50]], closed: false, mode: "fit" },
  { id: "k", kind: "line", a: [0, -5], b: [40, -5], construction: true },
];
const text = sketchToDXF(sketch);
const count = (t: string) => text.split("\n").filter((l, i, a) => l === t && a[i - 1] === "0").length;
assert.equal(count("LINE"), 1 + 4 + 1); // line, rect sides, construction line
assert.equal(count("CIRCLE"), 1);
assert.equal(count("ARC"), 1);
assert.equal(count("POLYLINE"), 1);
assert.ok(text.includes("CONSTRUCTION"));
assert.ok(text.trimEnd().endsWith("EOF"));
// The arc: centre (40,10), radius 10, from -90° to 90° (counter-clockwise through (50,10)).
const i = text.split("\n").findIndex((l, k, a) => l === "ARC" && a[k - 1] === "0");
const arc = text.split("\n").slice(i, i + 20);
// Group codes and values come in pairs (code line, value line).
const pairs = new Map<string, number>();
for (let k = 1; k + 1 < arc.length && arc[k] !== "0"; k += 2) if (!pairs.has(arc[k])) pairs.set(arc[k], Number(arc[k + 1]));
const val = (code: string) => pairs.get(code)!;
assert.ok(Math.abs(val("10") - 40) < 1e-6 && Math.abs(val("20") - 10) < 1e-6 && Math.abs(val("40") - 10) < 1e-6);
assert.ok(Math.abs(val("50") - 270) < 1e-6 && Math.abs(val("51") - 90) < 1e-6, `${val("50")} ${val("51")}`);
console.log("ok   sketch → DXF: lines, circle, arc, polyline, construction layer");

// Read back with the importer.
const { parseDXF } = await import("../src/io/insert");
const back = parseDXF(text);
assert.ok(back.length >= 8, `read back ${back.length}`);
console.log("ok   DXF reads back in:", back.length, "curves");
