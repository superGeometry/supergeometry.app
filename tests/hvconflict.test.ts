// Run: npx tsx tests/hvconflict.test.ts
// Making a nearly horizontal / vertical line Horizontal / Vertical must just
// work: the line itself moves (it isn't held as "first picked"), and an
// existing constraint in its way (an angle, a parallel...) gives way.
import assert from "node:assert/strict";
import type { SketchConstraint, SketchEntity } from "../src/doc/types";
import { addForUser, constraintError } from "../src/sketch/constraints";

type V = [number, number];
const L = (id: string, a: V, b: V): SketchEntity => ({ id, kind: "line", a, b });
const coin = (a: string, pa: string, b: string, pb: string): SketchConstraint => ({ id: `c-${a}${pa}-${b}${pb}`, type: "coincident", pts: [{ e: a, p: pa }, { e: b, p: pb }] });
const line = (es: SketchEntity[], id: string) => es.find((e) => e.id === id) as Extract<SketchEntity, { kind: "line" }>;
const flat = (es: SketchEntity[], id: string) => Math.abs(line(es, id).a[1] - line(es, id).b[1]);
const upright = (es: SketchEntity[], id: string) => Math.abs(line(es, id).a[0] - line(es, id).b[0]);

/** A closed polygon of lines, joined end to end. */
function loop(pts: V[]): { es: SketchEntity[]; cs: SketchConstraint[] } {
  const es = pts.map((p, i) => L(`l${i}`, p, pts[(i + 1) % pts.length]));
  const cs = es.map((_, i) => coin(`l${i}`, "b", `l${(i + 1) % es.length}`, "a"));
  return { es, cs };
}

function hv(es: SketchEntity[], cs: SketchConstraint[], id: string) {
  // As the H/V button builds it: whichever the line is nearer.
  const l = line(es, id);
  const added: SketchConstraint[] = [{ id: "new", type: Math.abs(l.b[0] - l.a[0]) >= Math.abs(l.b[1] - l.a[1]) ? "horizontal" : "vertical", curves: [id] }];
  return { added, r: addForUser(es, cs, added, id) };
}

const checks: [string, () => void][] = [
  ["lone nearly horizontal line goes horizontal", () => {
    const es = [L("a", [0, 0], [100, 3])];
    const { r } = hv(es, [], "a");
    assert.ok(r.ok);
    assert.ok(flat(r.result.entities, "a") < 1e-6);
  }],
  ["lone nearly vertical line goes vertical", () => {
    const es = [L("a", [0, 0], [-2, 50])];
    const { r, added } = hv(es, [], "a");
    assert.equal(added[0].type, "vertical");
    assert.ok(r.ok && upright(r.result.entities, "a") < 1e-6);
  }],
  ["line in a closed shape goes horizontal, shape stays joined", () => {
    const { es, cs } = loop([[0, 0], [80, 4], [85, 60], [-3, 55]]);
    const { r } = hv(es, cs, "l0");
    assert.ok(r.ok);
    assert.equal(r.removed.length, 0);
    assert.ok(flat(r.result.entities, "l0") < 1e-6);
    assert.ok(constraintError(r.result.entities, r.constraints) < 1e-6);
  }],
  ["an angle dimension on the line gives way", () => {
    const es = [L("a", [0, 0], [100, 4])];
    const cs: SketchConstraint[] = [{ id: "ang", type: "dim", curves: ["a"], prop: "angle", value: 2.29 }];
    const { r } = hv(es, cs, "a");
    assert.ok(r.ok);
    assert.deepEqual(r.removed.map((c) => c.id), ["ang"]);
    assert.ok(flat(r.result.entities, "a") < 1e-6);
  }],
  ["an angle between two lines gives way, the other line's vertical stays", () => {
    const { es, cs } = loop([[0, 0], [80, 3], [80, 60], [0, 60]]);
    const more: SketchConstraint[] = [
      ...cs,
      { id: "v1", type: "vertical", curves: ["l1"] },
      { id: "ang", type: "dim", curves: ["l0", "l1"], prop: "angle", value: 92 },
    ];
    // Square l1 first so the starting state meets its constraints.
    const { r } = hv(es, more, "l0");
    assert.ok(r.ok);
    assert.deepEqual(r.removed.map((c) => c.id), ["ang"]);
    assert.ok(r.constraints.some((c) => c.id === "v1"));
    assert.ok(flat(r.result.entities, "l0") < 1e-6 && upright(r.result.entities, "l1") < 1e-6);
  }],
  ["a parallel to a slanted line gives way", () => {
    const es = [L("a", [0, 0], [100, 5]), L("b", [0, 20], [100, 25])];
    const cs: SketchConstraint[] = [{ id: "par", type: "parallel", curves: ["a", "b"] }, { id: "fb", type: "fix", pts: [{ e: "b", p: "a" }], at: [0, 20] }, { id: "fb2", type: "fix", pts: [{ e: "b", p: "b" }], at: [100, 25] }];
    const { r } = hv(es, cs, "a");
    assert.ok(r.ok);
    assert.deepEqual(r.removed.map((c) => c.id), ["par"]);
    assert.ok(flat(r.result.entities, "a") < 1e-6);
  }],
  ["one end locked: the other end moves", () => {
    const es = [L("a", [10, 10], [110, 13])];
    const cs: SketchConstraint[] = [{ id: "fx", type: "fix", pts: [{ e: "a", p: "a" }], at: [10, 10] }];
    const { r } = hv(es, cs, "a");
    assert.ok(r.ok && r.removed.length === 0);
    const l = line(r.result.entities, "a");
    assert.ok(Math.hypot(l.a[0] - 10, l.a[1] - 10) < 1e-6 && flat(r.result.entities, "a") < 1e-6);
  }],
  ["both ends locked on a slant: refused, the locks stay", () => {
    const es = [L("a", [0, 0], [100, 3])];
    const cs: SketchConstraint[] = [
      { id: "f1", type: "fix", pts: [{ e: "a", p: "a" }], at: [0, 0] },
      { id: "f2", type: "fix", pts: [{ e: "a", p: "b" }], at: [100, 3] },
    ];
    const { r } = hv(es, cs, "a");
    assert.equal(r.ok, false);
    assert.equal(r.constraints, cs);
  }],
  ["two slanted lines both made horizontal one after another", () => {
    const { es, cs } = loop([[0, 0], [90, 2], [92, 50], [1, 48]]);
    let s = { es, cs };
    for (const id of ["l0", "l2", "l1", "l3"]) {
      const { r } = hv(s.es, s.cs, id);
      assert.ok(r.ok, id);
      s = { es: r.result.entities, cs: r.constraints };
    }
    assert.ok(flat(s.es, "l0") < 1e-6 && flat(s.es, "l2") < 1e-6 && upright(s.es, "l1") < 1e-6 && upright(s.es, "l3") < 1e-6);
  }],
  ["only the needed one goes when several conflict", () => {
    const es = [L("a", [0, 0], [100, 4])];
    const cs: SketchConstraint[] = [
      { id: "len", type: "dim", curves: ["a"], prop: "length", value: Math.hypot(100, 4) },
      { id: "ang", type: "dim", curves: ["a"], prop: "angle", value: 2.29 },
    ];
    const { r } = hv(es, cs, "a");
    assert.ok(r.ok);
    assert.deepEqual(r.removed.map((c) => c.id), ["ang"]);
    assert.ok(r.constraints.some((c) => c.id === "len"));
  }],
  ["fuzz: random near-level polygons with angle dims always take H/V", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let t = 0; t < 200; t++) {
      const n = 3 + Math.floor(rnd() * 4);
      const pts: V[] = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * 2 * Math.PI + rnd() * 0.3;
        const rr = 40 + rnd() * 60;
        pts.push([Math.cos(a) * rr, Math.sin(a) * rr]);
      }
      const { es, cs } = loop(pts);
      // Measured angle dims on some corners (met as they are).
      const more = [...cs];
      for (let i = 0; i < n; i++)
        if (rnd() < 0.5) {
          const l = line(es, `l${i}`);
          more.push({ id: `ang${i}`, type: "dim", curves: [`l${i}`], prop: "angle", value: (Math.atan2(l.b[1] - l.a[1], l.b[0] - l.a[0]) * 180) / Math.PI });
        }
      // Angles between neighbours too (as measured, so met), and a length or two.
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        if (rnd() < 0.4) {
          const a = line(es, `l${i}`);
          const b = line(es, `l${j}`);
          const d1 = [a.b[0] - a.a[0], a.b[1] - a.a[1]];
          const d2 = [b.b[0] - b.a[0], b.b[1] - b.a[1]];
          const ang = Math.abs(Math.atan2(d1[0] * d2[1] - d1[1] * d2[0], d1[0] * d2[0] + d1[1] * d2[1]));
          more.push({ id: `bt${i}`, type: "dim", curves: [`l${i}`, `l${j}`], prop: "angle", value: (ang * 180) / Math.PI });
        }
        if (rnd() < 0.3) {
          const a = line(es, `l${i}`);
          more.push({ id: `len${i}`, type: "dim", curves: [`l${i}`], prop: "length", value: Math.hypot(a.b[0] - a.a[0], a.b[1] - a.a[1]) });
        }
      }
      if (rnd() < 0.5) more.push({ id: "lock", type: "fix", pts: [{ e: "l0", p: "a" }], at: line(es, "l0").a });
      const id = `l${Math.floor(rnd() * n)}`;
      const { r } = hv(es, more, id);
      assert.ok(r.ok, `case ${t}`);
      const l = line(r.result.entities, id);
      assert.ok(Math.min(Math.abs(l.a[1] - l.b[1]), Math.abs(l.a[0] - l.b[0])) < 1e-5, `case ${t} not level`);
      assert.ok(constraintError(r.result.entities, r.constraints) < 1e-5, `case ${t} constraints`);
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
console.log("all hv-conflict checks passed");
