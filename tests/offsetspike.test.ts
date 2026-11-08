// Run: npx tsx tests/offsetspike.test.ts
// Offset by chain of an outline with sharp corners (the user's Sketch 11: a
// 9-line outline with a narrow spike) must never cross over the original.
import assert from "node:assert/strict";
import type { SketchEntity, Vec2 } from "../src/doc/types";
import { defaultOffset, offsetChain } from "../src/sketch/edit";
import { closestOnPrim, entityPrims } from "../src/sketch/curves";
import { patternSpacing, roundSig } from "../src/geom";

const L = (id: string, a: Vec2, b: Vec2): SketchEntity => ({ id, kind: "line", a, b });
// Sketch 11's outline (closed, clockwise as drawn).
const P: Vec2[] = [
  [4099.992124946016, -1000.0940924028508],
  [3200.0088891664545, -3300.0067232037127],
  [5400, -8800],
  [2149.9926430788155, -5983.329624025584],
  [1299.9999999999995, -9500],
  [4899.999999999999, -11800],
  [7700, -11300],
  [7402.335373455015, -5299.7272120100615],
  [6897.664625653082, -1000.0940924028508],
];
const loop = (pts: Vec2[]) => pts.map((p, i) => L(`e${i}`, p, pts[(i + 1) % pts.length]));

function segsCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o = (p: Vec2, q: Vec2, r: Vec2) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/** Offset pieces: none crosses the original, each point stays about |d| from it (never nearer). */
function checkOffset(orig: SketchEntity[], d: number, label: string) {
  const out = offsetChain(orig, orig[0].id, d);
  if (!out) return; // nothing left at this distance is fine
  const made = out.slice(orig.length) as Extract<SketchEntity, { kind: "line" }>[];
  assert.ok(made.length >= 3, `${label}: a closed outline`);
  for (const m of made)
    for (const o of orig as Extract<SketchEntity, { kind: "line" }>[])
      assert.ok(!segsCross(m.a, m.b, o.a, o.b), `${label}: offset ${JSON.stringify([m.a, m.b])} crosses the original`);
  const dist = (q: Vec2) => Math.min(...orig.map((o) => closestOnPrim(entityPrims(o)[0], q).d));
  for (const m of made)
    for (let t = 0; t <= 1; t += 0.05) {
      const q: Vec2 = [m.a[0] + (m.b[0] - m.a[0]) * t, m.a[1] + (m.b[1] - m.a[1]) * t];
      assert.ok(dist(q) > Math.abs(d) * 0.98, `${label}: a point of the offset is only ${dist(q).toFixed(1)} from the original (d ${d})`);
    }
}

const checks: [string, () => void][] = [
  ["default offset is a tenth of the curve, rounded", () => {
    assert.equal(defaultOffset(L("a", [0, 0], [100, 0])), 10);
    assert.equal(defaultOffset(L("a", [0, 0], [2174, 0])), 220);
    assert.equal(defaultOffset({ id: "c", kind: "circle", center: [0, 0], radius: 5 }), 1);
    assert.equal(defaultOffset({ id: "r", kind: "rect", center: [0, 0], w: 3000, h: 400, rotation: 0 }), 40);
    // Sketch 11's first side (2470 long): 250, not 2.
    assert.equal(defaultOffset(L("s", P[0], P[1])), 250);
  }],
  ["pattern spacing starts just clear of the shape", () => {
    assert.equal(patternSpacing(100), 120);
    assert.equal(patternSpacing(2350), 2800);
    assert.equal(patternSpacing(0), 10);
    assert.equal(patternSpacing(0, 20), 20);
    assert.ok(patternSpacing(37) > 37);
    assert.equal(roundSig(0.0347), 0.035);
  }],
  ["Sketch 11 outline offset inward 840 doesn't cross it", () => checkOffset(loop(P), -840, "in 840")],
  ["Sketch 11 outline at many distances, both ways", () => {
    for (const d of [50, 200, 400, 600, 840, 1000, 1300]) {
      checkOffset(loop(P), d, `out ${d}`);
      checkOffset(loop(P), -d, `in ${d}`);
    }
  }],
  ["random star-ish outlines with sharp corners", () => {
    let seed = 3;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let t = 0; t < 120; t++) {
      const n = 5 + Math.floor(rnd() * 6);
      const pts: Vec2[] = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * 2 * Math.PI;
        const r = i % 2 ? 30 + rnd() * 40 : 100 + rnd() * 60;
        pts.push([Math.cos(a) * r, Math.sin(a) * r]);
      }
      if (rnd() < 0.5) pts.reverse();
      for (const d of [3, 8, 15]) {
        checkOffset(loop(pts), d, `case ${t} out ${d}`);
        checkOffset(loop(pts), -d, `case ${t} in ${d}`);
      }
    }
  }],
];

let failed = 0;
for (const [name, f] of checks) {
  try {
    f();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n     ${(e as Error).message}`);
  }
}
if (failed) process.exit(1);
console.log("all offset-spike checks passed");
