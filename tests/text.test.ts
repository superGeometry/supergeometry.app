// Run: npx tsx tests/text.test.ts - text outlines are few curves, and true to the font.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import opentype, { type Font } from "opentype.js";
const { parse } = opentype as any;
import type { SketchEntity, Vec2 } from "../src/doc/types";
import { textOutlines } from "../src/sketch/textLayout";
import { polylineOutlines } from "./textPolylineRef";
import { arrangement, closestOnEntity, materialRegions } from "../src/sketch/regions";

const fonts = ["roboto/files/roboto-latin-400-normal", "roboto-slab/files/roboto-slab-latin-400-normal", "roboto-mono/files/roboto-mono-latin-400-normal", "oswald/files/oswald-latin-400-normal", "bebas-neue/files/bebas-neue-latin-400-normal", "pacifico/files/pacifico-latin-400-normal"];
const load = (f: string): Font => {
  const b = readFileSync(new URL(`../node_modules/@fontsource/${f}.woff`, import.meta.url));
  return parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};
const SIZE = 10;
const TEXT = "Hello SG-1 O8gB&@ Qwerty 2026";

const edges = (es: SketchEntity[]) => es.reduce((n, e) => n + (e.kind === "polyline" ? e.points.length : 1), 0);
const ink = (es: SketchEntity[]) => materialRegions(arrangement(es)).reduce((a, r) => a + r.area, 0);

let failed = 0;
for (const name of fonts) {
  try {
    const f = load(name);
    const t0 = performance.now();
    const es = textOutlines(f, TEXT, [0, 0], SIZE);
    const ms = performance.now() - t0;
    const was = polylineOutlines(8, f, TEXT, [0, 0], SIZE);
    const oldEdges = edges(was);
    // How far the curves stray from the font's outline (finely sampled).
    let dev = 0;
    for (const c of polylineOutlines(16, f, TEXT, [0, 0], SIZE)) for (const q of (c as any).points as Vec2[]) dev = Math.max(dev, Math.min(...es.map((e) => closestOnEntity(e, q).d)));
    // The same letters, holes and all (a gap in a hole's outline fills it in).
    const [a0, a1] = [ink(was), ink(es)];
    const [r0, r1] = [arrangement(was).regions.length, arrangement(es).regions.length];
    assert.ok(dev < SIZE * 6e-3, `strays ${dev.toFixed(4)}`);
    assert.equal(r1, r0, "regions");
    assert.ok(Math.abs(a1 - a0) / a0 < 0.005, `ink ${a0.toFixed(2)} → ${a1.toFixed(2)}`);
    // Letter by letter too: a lost hole hides in the total of a long text.
    for (const ch of new Set(TEXT.replace(/ /g, ""))) {
      const [x0, x1] = [ink(polylineOutlines(8, f, ch, [0, 0], SIZE)), ink(textOutlines(f, ch, [0, 0], SIZE))];
      assert.ok(Math.abs(x1 - x0) / x0 < 0.015, `"${ch}" ink ${x0.toFixed(2)} → ${x1.toFixed(2)}`);
    }
    assert.ok(edges(es) < oldEdges * 0.45, `${edges(es)} edges (was ${oldEdges})`);
    console.log("ok  ", name.split("/")[0], `- ${oldEdges} → ${edges(es)} edges, strays ${dev.toFixed(4)}, ${r1} regions, ${ms.toFixed(0)} ms`);
  } catch (e) {
    failed++;
    console.log("FAIL", name.split("/")[0], "-", e instanceof Error ? e.message : e);
  }
}
process.exit(failed ? 1 : 0);
