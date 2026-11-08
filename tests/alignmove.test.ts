// Run: npx tsx tests/alignmove.test.ts
// Align: the first thing picked moves onto the second's axis - never the other
// way round, even when constraints tie them (and nothing is locked).
import assert from "node:assert/strict";
import type { SketchConstraint, SketchEntity, Vec2 } from "../src/doc/types";
import { alignOne, alignShape } from "../src/sketch/edit";
import { constraintError, solve } from "../src/sketch/constraints";

type Ln = Extract<SketchEntity, { kind: "line" }>;
const L = (id: string, a: Vec2, b: Vec2): Ln => ({ id, kind: "line", a, b });
const coin = (a: string, pa: string, b: string, pb: string): SketchConstraint => ({ id: `c${a}${pa}${b}${pb}`, type: "coincident", pts: [{ e: a, p: pa }, { e: b, p: pb }] });
const get = (es: SketchEntity[], id: string) => es.find((e) => e.id === id) as Ln;
const near = (p: Vec2, q: Vec2) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-6;

// A constrained (not locked) box: lines joined, sides horizontal / vertical, a width.
const box = () => {
  const es: SketchEntity[] = [L("b", [0, 0], [40, 0]), L("r", [40, 0], [40, 20]), L("t", [40, 20], [0, 20]), L("l", [0, 20], [0, 0])];
  const cs: SketchConstraint[] = [coin("b", "b", "r", "a"), coin("r", "b", "t", "a"), coin("t", "b", "l", "a"), coin("l", "b", "b", "a"),
    { id: "hb", type: "horizontal", curves: ["b"] }, { id: "ht", type: "horizontal", curves: ["t"] }, { id: "vr", type: "vertical", curves: ["r"] }, { id: "vl", type: "vertical", curves: ["l"] },
    { id: "w", type: "dim", curves: ["b"], prop: "length", value: 40 }];
  return { es, cs };
};

const checks: [string, () => void][] = [
  ["a box's right side moves out to a line; the line stays", () => {
    const { es, cs } = box();
    const target = L("x", [70, -10], [70, 50]);
    const all = [...es, target];
    const res = alignOne(all, cs, "r", target)!;
    assert.ok(res);
    const r = get(res.entities, "r");
    assert.ok(Math.abs(r.a[0] - 70) < 1e-6 && Math.abs(r.b[0] - 70) < 1e-6, `right side at ${r.a[0]}`);
    assert.deepEqual(get(res.entities, "x"), target, "the target didn't move");
    // Solved again as the app will: still there (the width that held it was dropped, not the line pulled back).
    const again = solve(res.entities, res.constraints);
    assert.ok(Math.abs(get(again.entities, "r").a[0] - 70) < 1e-6);
    assert.ok(near(get(again.entities, "x").a, target.a));
    assert.ok(constraintError(res.entities, res.constraints) < 1e-6);
  }],
  ["aligning to a line of another constrained shape moves only the first", () => {
    const a = box();
    const bEs = a.es.map((e) => ({ ...(e as Ln), id: "B" + e.id, a: [(e as Ln).a[0] + 100, (e as Ln).a[1] + 7] as Vec2, b: [(e as Ln).b[0] + 100, (e as Ln).b[1] + 7] as Vec2 }));
    const bCs = a.cs.map((c) => ({ ...c, id: "B" + c.id, curves: c.curves?.map((x) => "B" + x), pts: c.pts?.map((q) => ({ ...q, e: "B" + q.e })) }));
    const all = [...a.es, ...bEs];
    const res = alignOne(all, [...a.cs, ...bCs], "t", get(all, "Bt"))!;
    assert.ok(Math.abs(get(res.entities, "t").a[1] - 27) < 1e-6);
    for (const e of bEs) assert.deepEqual(get(res.entities, e.id), e, `${e.id} moved`);
  }],
  ["a whole shape turns and slides so its edge lies on the line", () => {
    const { es, cs } = box();
    // A slanted target line: y = x - 100.
    const target = L("x", [100, 0], [200, 100]);
    const res = alignShape([...es, target], cs, new Set(["b", "r", "t", "l"]), get(es, "b"), target)!;
    const b = get(res.entities, "b");
    const onT = (p: Vec2) => Math.abs(p[1] - (p[0] - 100)) < 1e-6;
    assert.ok(onT(b.a) && onT(b.b), "edge on the target's axis");
    assert.ok(Math.abs(Math.hypot(b.b[0] - b.a[0], b.b[1] - b.a[1]) - 40) < 1e-6, "size kept");
    assert.deepEqual(get(res.entities, "x"), target);
    // Still a box: corners joined, sides at right angles.
    assert.ok(near(get(res.entities, "b").b, get(res.entities, "r").a) && near(get(res.entities, "t").b, get(res.entities, "l").a));
    // Its H/V constraints no longer hold (it's turned): they went.
    assert.ok(!res.constraints.some((c) => c.id === "hb" || c.id === "vr"));
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
console.log("all align-move checks passed");
