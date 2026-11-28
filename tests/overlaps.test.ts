// Run: npx tsx tests/overlaps.test.ts
// Curves of a sketch that lie on one another are found, so the sketch can show them: two lines one over the other
// look like one.
import type { SketchEntity, Vec2 } from "../src/doc/types";
import { overlaps } from "../src/sketch/overlaps";
import { check, done, near } from "./kit";

const L = (id: string, a: Vec2, b: Vec2, more: Record<string, unknown> = {}): SketchEntity => ({ id, kind: "line", a, b, ...more }) as SketchEntity;
const C = (id: string, c: Vec2, r: number): SketchEntity => ({ id, kind: "circle", center: c, radius: r }) as SketchEntity;
const len = (o: { a: Vec2; b: Vec2 }) => Math.hypot(o.b[0] - o.a[0], o.b[1] - o.a[1]);
const lines = (es: SketchEntity[]) => overlaps(es).filter((o) => o.kind === "line") as Extract<ReturnType<typeof overlaps>[number], { kind: "line" }>[];

{
  const o = lines([L("a", [0, 0], [10, 0]), L("b", [0, 0], [10, 0])]);
  check("two lines exactly one over the other: one stretch, the whole of them, both named", o.length === 1 && near(len(o[0]), 10) && o[0].ids.sort().join() === "a,b", JSON.stringify(o));
}
{
  const o = lines([L("a", [0, 0], [10, 0]), L("b", [10, 0], [0, 0])]);
  check("...drawn the other way round: the same", o.length === 1 && near(len(o[0]), 10), JSON.stringify(o));
}
{
  const o = lines([L("a", [0, 0], [10, 0]), L("b", [6, 0], [16, 0])]);
  check("two lines along one line, lapping by 4: that stretch of 4", o.length === 1 && near(len(o[0]), 4) && near(Math.min(o[0].a[0], o[0].b[0]), 6), JSON.stringify(o));
}
{
  const o = lines([L("a", [0, 0], [20, 0]), L("b", [5, 0], [9, 0])]);
  check("a short line lying on a long one: the short one's stretch", o.length === 1 && near(len(o[0]), 4), JSON.stringify(o));
}
{
  const o = lines([L("a", [0, 0], [10, 0]), L("b", [10, 0], [20, 0])]);
  check("two lines end to end: nothing (they only touch)", o.length === 0, JSON.stringify(o));
  const p = lines([L("a", [0, 0], [10, 0]), L("b", [0, 0.5], [10, 0.5])]);
  check("two lines side by side, half a millimetre apart: nothing", p.length === 0, JSON.stringify(p));
  const q = lines([L("a", [0, 0], [10, 0]), L("b", [0, 0], [10, 0.3])]);
  check("two lines from one point, a little apart in direction: nothing", q.length === 0, JSON.stringify(q));
  const r = lines([L("a", [0, 0], [10, 0]), L("b", [5, -5], [5, 5])]);
  check("two lines crossing: nothing", r.length === 0, JSON.stringify(r));
}
{
  const o = lines([L("a", [0, 0], [10, 0]), L("b", [0, 0], [10, 0]), L("c", [2, 0], [8, 0])]);
  check("three on one stretch: one stretch from end to end, all three named", o.length === 1 && near(len(o[0]), 10) && o[0].ids.length === 3, JSON.stringify(o));
}
{
  const o = lines([L("a", [0, 0], [4, 0]), L("b", [0, 0], [4, 0]), L("c", [10, 0], [14, 0]), L("d", [10, 0], [14, 0])]);
  check("two doubled stretches with a gap between: two stretches", o.length === 2 && o.every((x) => near(len(x), 4)), JSON.stringify(o));
}
{
  const o = lines([L("a", [3, 4], [9, 12]), L("b", [6, 8], [12, 16])]);
  check("on a slant: the shared stretch (from 6, 8 to 9, 12 - five long)", o.length === 1 && near(len(o[0]), 5, 1e-9), JSON.stringify(o));
}
{
  // As the solver leaves them: a hair off.
  const o = lines([L("a", [0, 0], [40, 0]), L("b", [0.00002, 0.00003], [40.00001, -0.00002])]);
  check("one over the other but for a few hundred-thousandths: found", o.length === 1 && near(len(o[0]), 40, 1e-3), JSON.stringify(o));
}
{
  const rect = { id: "r", kind: "rect", center: [5, 5], w: 10, h: 10, rotation: 0 } as SketchEntity;
  const o = lines([rect, L("a", [2, 0], [8, 0])]);
  check("a line drawn along a rectangle's side: found", o.length === 1 && near(len(o[0]), 6) && o[0].ids.sort().join() === "a,r", JSON.stringify(o));
  const poly = { id: "p", kind: "polyline", points: [[0, 0], [10, 0], [10, 10]], closed: false } as SketchEntity;
  const q = lines([poly, L("a", [10, 2], [10, 20])]);
  check("a line along part of a polyline: the shared part", q.length === 1 && near(len(q[0]), 8), JSON.stringify(q));
}
{
  const o = lines([L("a", [0, 0], [10, 0]), L("h", [0, 0], [10, 0], { construction: true })]);
  check("a helper (construction) line along a line: not marked (helpers are drawn along edges on purpose)", o.length === 0, JSON.stringify(o));
}
{
  const o = overlaps([C("c1", [5, 5], 4), C("c2", [5, 5], 4), C("c3", [5, 5], 6)]);
  check("the same circle twice (and a bigger one round them): the two named, not the third", o.length === 1 && o[0].kind === "circle" && o[0].ids.sort().join() === "c1,c2", JSON.stringify(o));
}
check("nothing drawn, or one line: nothing", overlaps([]).length === 0 && overlaps([L("a", [0, 0], [1, 0])]).length === 0);
{
  // Many lines: quick, and only the doubled ones found.
  const es: SketchEntity[] = [];
  for (let i = 0; i < 1500; i++) es.push(L(`l${i}`, [i * 3, 0], [i * 3 + 2, i % 7]));
  es.push(L("dup", [300, 0], [302, (100 % 7)]));
  const t0 = performance.now();
  const o = overlaps(es);
  const ms = performance.now() - t0;
  check("1500 lines and one hidden duplicate: found, in well under a tenth of a second", o.length === 1 && o[0].ids.includes("dup") && ms < 100, `${o.length} in ${ms.toFixed(1)} ms`);
}
done();
