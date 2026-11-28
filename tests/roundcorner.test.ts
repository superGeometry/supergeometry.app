// Run: npx tsx tests/roundcorner.test.ts
// Two lines joined by a round (a sketch fillet), the round given a new radius: the lines stay on their own lines
// and keep their far ends; only the ends at the round move along them. The solver alone met the new radius by
// sliding all three a little, lines that nothing told to move included.
import type { SketchConstraint, SketchEntity } from "../src/doc/types";
import { setValueStrict, solve } from "../src/sketch/constraints";
import { check, done } from "./kit";

const pt = (e: string, p: string) => ({ e, p });
type L = { a: number[]; b: number[] };
const get = (es: SketchEntity[], id: string) => es.find((e) => e.id === id) as unknown as L & { m: number[] };
const radiusOf = (arc: { a: number[]; m: number[]; b: number[] }) => {
  const [ax, ay, bx, by, cx, cy] = [...arc.a, ...arc.m, ...arc.b];
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
  const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
  return Math.hypot(ax - ux, ay - uy);
};
const far = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// An upright line down to a round of 12, and a level line on from it: the corner would be at (50, 10). Only
// Vertical and Horizontal on the lines - nothing holds them in place.
const k = 12 * (1 - Math.SQRT1_2);
const es0 = [
  { id: "up", kind: "line", a: [50, 120], b: [50, 22] },
  { id: "level", kind: "line", a: [62, 10], b: [200, 10] },
  { id: "round", kind: "arc", a: [50, 22], m: [50 + k, 10 + k], b: [62, 10] },
] as unknown as SketchEntity[];
const cs = [
  { id: "v", type: "vertical", curves: ["up"] },
  { id: "h", type: "horizontal", curves: ["level"] },
  { id: "c1", type: "coincident", pts: [pt("up", "b"), pt("round", "a")] },
  { id: "t1", type: "tangent", curves: ["up", "round"] },
  { id: "c2", type: "coincident", pts: [pt("level", "a"), pt("round", "b")] },
  { id: "t2", type: "tangent", curves: ["level", "round"] },
  { id: "r", type: "dim", curves: ["round"], prop: "radius", value: 12 },
] as unknown as SketchConstraint[];
const start = solve(es0, cs);
check("the corner solves as drawn", start.ok, start.error);
const es = start.entities;

for (const r of [16, 30, 4, 12.5]) {
  const res = setValueStrict(es, cs, "r", r);
  const now = res?.result.entities ?? [];
  const [up, level, round] = [get(now, "up"), get(now, "level"), get(now, "round")];
  const ok = !!res && res.result.ok;
  check(`radius ${r}: the upright line is still at x = 50 and still starts at (50, 120)`, ok && Math.abs(up.a[0] - 50) < 1e-6 && Math.abs(up.b[0] - 50) < 1e-6 && far(up.a, [50, 120]) < 1e-6, ok ? `${up.a} ${up.b}` : "refused");
  check(`radius ${r}: the level line is still at y = 10 and still ends at (200, 10)`, ok && Math.abs(level.a[1] - 10) < 1e-6 && Math.abs(level.b[1] - 10) < 1e-6 && far(level.b, [200, 10]) < 1e-6, ok ? `${level.a} ${level.b}` : "refused");
  check(`radius ${r}: the round is ${r}, and meets the lines ${r} from the corner`, ok && Math.abs(radiusOf(round) - r) < 1e-5 && far(up.b, [50, 10 + r]) < 1e-5 && far(level.a, [50 + r, 10]) < 1e-5, ok ? `${radiusOf(round)} at ${up.b} and ${level.a}` : "refused");
}

// A corner that isn't square: 60 degrees between the lines.
{
  const c60 = Math.cos(Math.PI / 3);
  const s60 = Math.sin(Math.PI / 3);
  const d = 10 / Math.tan(Math.PI / 6);
  const es1 = [
    { id: "p", kind: "line", a: [100, 0], b: [d, 0] },
    { id: "q", kind: "line", a: [d * c60, d * s60], b: [100 * c60, 100 * s60] },
    { id: "round", kind: "arc", a: [d, 0], m: [(20 - 10) * Math.cos(Math.PI / 6), (20 - 10) * Math.sin(Math.PI / 6)], b: [d * c60, d * s60] },
  ] as unknown as SketchEntity[];
  const cs1 = [
    { id: "h", type: "horizontal", curves: ["p"] },
    { id: "c1", type: "coincident", pts: [pt("p", "b"), pt("round", "a")] },
    { id: "t1", type: "tangent", curves: ["p", "round"] },
    { id: "c2", type: "coincident", pts: [pt("q", "a"), pt("round", "b")] },
    { id: "t2", type: "tangent", curves: ["q", "round"] },
    { id: "r", type: "dim", curves: ["round"], prop: "radius", value: 10 },
  ] as unknown as SketchConstraint[];
  const s1 = solve(es1, cs1);
  const res = setValueStrict(s1.entities, cs1, "r", 18);
  const now = res?.result.entities ?? [];
  const [p, q] = [get(now, "p"), get(now, "q")];
  const was = get(s1.entities, "q");
  // The slanted line has no constraint of its own: it must still run along the same line, from the same far end.
  const cross = (q.b[0] - q.a[0]) * (was.b[1] - was.a[1]) - (q.b[1] - q.a[1]) * (was.b[0] - was.a[0]);
  check("a 60 degree corner, radius 10 to 18: both lines keep their far ends, the slanted one its slant", !!res && s1.ok && far(p.a, [100, 0]) < 1e-6 && Math.abs(p.b[1]) < 1e-6 && far(q.b, was.b) < 1e-6 && Math.abs(cross) < 1e-5 && Math.abs(radiusOf(get(now, "round")) - 18) < 1e-5, res ? `p ${p.a} ${p.b} q ${q.a} ${q.b}` : "refused");
}
// A radius the corner has no room for: left to the solver, as before (the lines are free, so it may make room).
{
  const res = setValueStrict(es, cs, "r", 500);
  check("a radius bigger than the lines are long: left to the solver - taken with the round 500, or refused", res === null || Math.abs(radiusOf(get(res.result.entities, "round")) - 500) < 1e-3);
}
done();
