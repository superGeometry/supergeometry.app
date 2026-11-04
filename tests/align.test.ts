// Run: npx tsx tests/align.test.ts
import assert from "node:assert/strict";
import type { SketchEntity } from "../src/doc/types";
import { alignLine, joinCollinear } from "../src/sketch/edit";

type LineE = Extract<SketchEntity, { kind: "line" }>;
const L = (id: string, a: [number, number], b: [number, number]): SketchEntity => ({ id, kind: "line", a, b });
const close = (p: number[], q: number[]) => assert.ok(Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-9, `${p} vs ${q}`);

// A rectangle's right side aligns onto a vertical line further right; top and bottom stretch.
const rect = [L("b", [0, 0], [10, 0]), L("r", [10, 0], [10, 5]), L("t", [10, 5], [0, 5]), L("l", [0, 5], [0, 0])];
const target = L("x", [14, -3], [14, 9]);
const out = alignLine([...rect, target], "r", target)!;
const get = (id: string) => out.find((e) => e.id === id) as LineE;
close(get("r").a, [14, 0]);
close(get("r").b, [14, 5]);
close(get("b").b, [14, 0]);
close(get("t").a, [14, 5]);
close(get("l").a, [0, 5]);
console.log("ok   align stretches neighbours");

// A free tilted line lands on the target's axis.
const free = alignLine([L("f", [0, 1], [5, 3]), L("y", [0, 0], [10, 0])], "f", L("y", [0, 0], [10, 0]))!;
const f = free[0] as LineE;
close(f.a, [0, 0]);
close(f.b, [5, 0]);
console.log("ok   align free line");

const j = joinCollinear([L("1", [0, 0], [4, 0]), L("2", [4, 0], [9, 0]), L("3", [4, 0], [4, 5])], "1")!;
assert.equal(j.removed, "2");
const one = j.entities.find((e) => e.id === "1") as LineE;
close(one.a, [0, 0]);
close(one.b, [9, 0]);
assert.equal(j.entities.length, 2);
assert.equal(joinCollinear([L("1", [0, 0], [4, 0]), L("3", [4, 0], [4, 5])], "1"), null);
console.log("ok   join collinear");

// Splines: Extend/Join with lines, chain offsets through them.
{
  const { joinEnds, offsetChain, splineEnds } = await import("../src/sketch/edit");
  const sp: SketchEntity = { id: "s", kind: "spline", points: [[0, 0], [10, 5], [20, 0], [30, 8]], closed: false, mode: "fit" };
  const wall = L("w", [35, -10], [35, 20]);
  const j = joinEnds([sp, wall], { id: "s", at: [29, 7] }, { id: "w", at: [35, 15] })!;
  const s2 = j.find((e) => e.id === "s")!;
  const w2 = j.find((e) => e.id === "w") as LineE;
  close(splineEnds(s2)![1], w2.b);
  assert.ok(Math.abs(w2.b[0] - 35) < 1e-9);
  const down = L("m", [10, -10], [10, -5]);
  const j2 = joinEnds([sp, down], { id: "m", at: [10, -5] }, { id: "s", at: [12, 4] })!;
  close((j2.find((e) => e.id === "m") as LineE).b, [10, 5]);
  const loop = [sp, L("a", [30, 8], [30, -20]), L("b", [30, -20], [0, -20]), L("c", [0, -20], [0, 0])];
  const off = offsetChain(loop, "a", 2)!;
  assert.equal(off.length, 8);
  // The offset outline stays closed: each piece starts where the one before ends.
  const made = off.slice(4);
  const ends = made.map((e) => (e.kind === "spline" ? splineEnds(e)! : [(e as LineE).a, (e as LineE).b]));
  for (let i = 0; i < ends.length; i++) {
    const a = ends[i][1];
    const nexts = ends.map((x) => x[0]).concat(ends.map((x) => x[1]));
    assert.ok(nexts.some((q, k) => k % ends.length !== i && Math.hypot(q[0] - a[0], q[1] - a[1]) < 1e-6), `gap after piece ${i}`);
  }
  console.log("ok   spline join / extend / chain offset");
}
