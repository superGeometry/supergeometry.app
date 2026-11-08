// Run: npx tsx tests/dragspeed.test.ts
// Dragging a joined point of a real sketch (the user's Sketch 11: three outlines
// linked by constraints, ~100 unknowns) must keep up with the finger: each
// frame's solve stays a few milliseconds, lands on the pointer and keeps every
// constraint met.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { PointRef, SketchConstraint, SketchEntity, Vec2 } from "../src/doc/types";
import { constraintError, pointOf, solve } from "../src/sketch/constraints";

const { entities, constraints } = JSON.parse(readFileSync(new URL("./fixtures/sketch11.json", import.meta.url), "utf8")) as { entities: SketchEntity[]; constraints: SketchConstraint[] };
const cases: PointRef[][] = [
  [{ e: "tgiurail", p: "b" }, { e: "811a5ls1", p: "a" }],
  [{ e: "x8x6r0sn", p: "a" }, { e: "scx4wbmg", p: "b" }],
  // Held by its radius and two tangents: it follows as far as those let it.
  [{ e: "yilyby4v", p: "a" }, { e: "h4m33en4", p: "a" }],
];
const held = new Set(["yilyby4v"]);
let failed = 0;
for (const refs of cases) {
  const name = `drag ${refs[0].e}:${refs[0].p}`;
  try {
    const at = refs.map((r) => pointOf(entities.find((e) => e.id === r.e)!, r.p)!);
    const times: number[] = [];
    for (let i = 1; i <= 30; i++) {
      const to = (k: number): Vec2 => [at[k][0] + i * 25, at[k][1] - i * 9];
      const s = performance.now();
      const r = solve(entities, constraints, { drag: refs.map((ref, k) => ({ ref, to: to(k) })) });
      times.push(performance.now() - s);
      assert.ok(r.ok, `frame ${i} not solved`);
      assert.ok(constraintError(r.entities, constraints) < 1e-4, `frame ${i} constraints off`);
      const p = pointOf(r.entities.find((e) => e.id === refs[0].e)!, refs[0].p)!;
      if (!held.has(refs[0].e)) assert.ok(Math.hypot(p[0] - to(0)[0], p[1] - to(0)[1]) < 1, `frame ${i} not at the pointer`);
    }
    times.sort((a, b) => a - b);
    // Generous (slow machines, first-run JIT): it was ~9 ms here before, ~2-5 now.
    assert.ok(times[15] < 20, `median ${times[15].toFixed(1)} ms`);
    console.log(`ok   ${name} (median ${times[15].toFixed(1)} ms)`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n     ${(e as Error).message}`);
  }
}
if (failed) process.exit(1);
console.log("all drag-speed checks passed");
