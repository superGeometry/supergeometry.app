// Run: npx tsx tests/constraints.test.ts
import assert from "node:assert/strict";
import type { SketchConstraint, SketchEntity } from "../src/doc/types";
import { solve, sizeOf } from "../src/sketch/constraints";
import { angleLines, filletConstraints, filletCorner } from "../src/sketch/edit";
import { arcFrom3 } from "../src/sketch/curves";

const L = (id: string, a: [number, number], b: [number, number]): SketchEntity => ({ id, kind: "line", a, b });
// A slightly crooked quad that constraints should square up.
const quad = [L("l1", [0, 0], [10.3, 0.4]), L("l2", [10.3, 0.4], [10, 5.2]), L("l3", [10, 5.2], [-0.2, 5]), L("l4", [-0.2, 5], [0, 0])];
const coin = (a: string, pa: string, b: string, pb: string): SketchConstraint => ({ id: a + b, type: "coincident", pts: [{ e: a, p: pa }, { e: b, p: pb }] });
const rect: SketchConstraint[] = [
  coin("l1", "b", "l2", "a"),
  coin("l2", "b", "l3", "a"),
  coin("l3", "b", "l4", "a"),
  coin("l4", "b", "l1", "a"),
  { id: "h1", type: "horizontal", curves: ["l1"] },
  { id: "h2", type: "horizontal", curves: ["l3"] },
  { id: "v1", type: "vertical", curves: ["l2"] },
  { id: "v2", type: "vertical", curves: ["l4"] },
  { id: "fx", type: "fix", pts: [{ e: "l1", p: "a" }], at: [0, 0] },
];

const checks: [string, () => void][] = [
  ["rectangle squares up", () => {
    const r = solve(quad, rect);
    assert.ok(r.ok, `error ${r.error}`);
    const [l1, l2] = r.entities as any[];
    assert.ok(Math.abs(l1.a[1] - l1.b[1]) < 1e-6 && Math.abs(l2.a[0] - l2.b[0]) < 1e-6);
  }],
  ["width dimension drives the rectangle", () => {
    const r = solve(quad, [...rect, { id: "w", type: "dim", curves: ["l1"], prop: "length", value: 25 }, { id: "h", type: "dim", curves: ["l2"], prop: "length", value: 8 }]);
    assert.ok(r.ok, `error ${r.error}`);
    assert.ok(Math.abs(sizeOf(r.entities[0], "length")! - 25) < 1e-6);
    assert.ok(Math.abs(sizeOf(r.entities[1], "length")! - 8) < 1e-6);
  }],
  ["drag a corner keeps it rectangular", () => {
    const base = solve(quad, rect).entities;
    const r = solve(base, rect, { drag: [{ ref: { e: "l2", p: "b" }, to: [20, 12] }] });
    assert.ok(r.ok, `error ${r.error}`);
    const l2 = r.entities[1] as any;
    assert.ok(Math.abs(l2.b[0] - 20) < 0.05 && Math.abs(l2.b[1] - 12) < 0.05, JSON.stringify(l2.b));
  }],
  ["tangent line to circle", () => {
    const es: SketchEntity[] = [{ id: "c", kind: "circle", center: [0, 0], radius: 5 }, L("t", [-10, 6], [10, 7])];
    const r = solve(es, [{ id: "tg", type: "tangent", curves: ["t", "c"] }, { id: "h", type: "horizontal", curves: ["t"] }]);
    assert.ok(r.ok, `error ${r.error}`);
    const t = r.entities[1] as any;
    const c = r.entities[0] as any;
    // Either may move: the line must sit exactly one radius from the centre.
    assert.ok(Math.abs(Math.abs(t.a[1] - c.center[1]) - c.radius) < 1e-5);
  }],
  ["perpendicular + equal", () => {
    const es = [L("a", [0, 0], [10, 1]), L("b", [0, 0], [2, 7])];
    const r = solve(es, [{ id: "p", type: "perpendicular", curves: ["a", "b"] }, { id: "e", type: "equal", curves: ["a", "b"] }, coin("a", "a", "b", "a")]);
    assert.ok(r.ok, `error ${r.error}`);
    assert.ok(Math.abs(sizeOf(r.entities[0], "length")! - sizeOf(r.entities[1], "length")!) < 1e-6);
  }],
];

checks.push(
  ["equal: the first picked line keeps its length", () => {
    const es = [L("p", [0, 0], [10, 0]), L("q", [0, 5], [20, 5])];
    const r = solve(es, [{ id: "e", type: "equal", curves: ["p", "q"] }], { fixed: new Set(["p"]) });
    assert.ok(Math.abs(sizeOf(r.entities[0], "length")! - 10) < 1e-6 && Math.abs(sizeOf(r.entities[1], "length")! - 10) < 1e-6);
  }],
  ["fillet on a joined corner stays tangent after solving", () => {
    const es = [L("h", [0, 0], [20, 0]), L("v", [20, 0], [20, 20])];
    const cs: SketchConstraint[] = [coin("h", "b", "v", "a"), { id: "hh", type: "horizontal", curves: ["h"] }, { id: "vv", type: "vertical", curves: ["v"] }];
    const before = new Set(es.map((e) => e.id));
    const next = filletCorner(es, [20, 0], 4, 1e-6)!;
    const fc = filletConstraints(next, cs, before);
    const r = solve(next, fc);
    assert.ok(r.ok, "solves");
    const arc = r.entities.find((e) => e.kind === "arc") as any;
    const c = arcFrom3(arc.a, arc.m, arc.b)!;
    assert.ok(Math.abs(c.r - 4) < 1e-6 && Math.abs(c.c[0] - 16) < 1e-6 && Math.abs(c.c[1] - 4) < 1e-6, JSON.stringify(c));
  }],
  ["angle between lines: second turns about its end nearest the first", () => {
    const es = [L("p", [0, 0], [20, 0]), L("q", [5, 1], [5, 11])];
    const r = angleLines(es, "p", "q", 30)!;
    const q = r.entities[1] as any;
    assert.deepEqual(q.a, [5, 1]);
    const ang = (Math.atan2(q.b[1] - q.a[1], q.b[0] - q.a[0]) * 180) / Math.PI;
    assert.ok(Math.abs(Math.abs(ang) - 30) < 1e-9 || Math.abs(Math.abs(ang) - 150) < 1e-9, `angle ${ang}`);
  }],
);

let failed = 0;
for (const [name, fn] of checks) {
  try {
    fn();
    console.log("ok  ", name);
  } catch (e) {
    failed++;
    console.log("FAIL", name, "—", (e as Error).message);
  }
}

// A new constraint that contradicts an old one replaces it; one that agrees stays alongside.
{
  const { addResolving } = await import("../src/sketch/constraints");
  const l1: any = { id: "l1", kind: "line", a: [0, 0], b: [10, 1] };
  const h: any = { id: "h", type: "horizontal", curves: ["l1"] };
  const v: any = { id: "v", type: "vertical", curves: ["l1"] };
  const r1 = addResolving([l1], [h], [v]);
  if (!r1.result.ok || r1.removed.length !== 1 || r1.removed[0].id !== "h" || !r1.constraints.some((c) => c.id === "v")) throw new Error("vertical should replace horizontal");
  const len: any = { id: "len", type: "dim", curves: ["l1"], prop: "length", value: 10 };
  const r2 = addResolving([l1], [h], [len]);
  if (!r2.result.ok || r2.removed.length || r2.constraints.length !== 2) throw new Error("a length should sit alongside horizontal");
  console.log("ok   contradicting constraint replaces, agreeing one adds");
}
{
  // Strict (what the sketch uses): a contradicting constraint is refused, nothing is taken away.
  const { addStrict } = await import("../src/sketch/constraints");
  const l1 = L("l1", [0, 0], [10, 1]);
  const h: SketchConstraint = { id: "h", type: "horizontal", curves: ["l1"] };
  const v: SketchConstraint = { id: "v", type: "vertical", curves: ["l1"] };
  const r = addStrict([l1], [h], [v]);
  if (r.ok || r.constraints.length !== 1 || r.constraints[0].id !== "h") throw new Error("vertical on a horizontal line should be refused");
  const len: SketchConstraint = { id: "len", type: "dim", curves: ["l1"], prop: "length", value: 12 };
  const r2 = addStrict([l1], [h], [len]);
  if (!r2.ok || r2.constraints.length !== 2) throw new Error("a length should sit alongside horizontal");
  console.log("ok   strict: contradicting constraint refused, agreeing one adds");
}

process.exit(failed ? 1 : 0);
