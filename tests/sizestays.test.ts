// Run: npx tsx tests/sizestays.test.ts
// A size changed in a sketch that nothing holds in place: only the curve it is of, and what is tied straight to
// it, moves. The solver alone spread the change over every point, and the whole shape shifted a little.
import type { SketchConstraint, SketchEntity } from "../src/doc/types";
import { setValueStrict, solve } from "../src/sketch/constraints";
import { check, done } from "./kit";

// A slanted four-sided shape, 100 mm top and right sides, its bottom left corner rounded 5 (a sketch fillet).
const s60 = Math.sin(Math.PI / 3);
const es0 = [
  { id: "bottom", kind: "line", a: [80, 0], b: [-11.34, 0] },
  { id: "right", kind: "line", a: [80, 0], b: [130, 100 * s60] },
  { id: "top", kind: "line", a: [130, 100 * s60], b: [30, 100 * s60] },
  { id: "left", kind: "line", a: [30, 100 * s60], b: [-15.67, 7.5] },
  { id: "round", kind: "arc", a: [-11.34, 0], m: [-15.67, 2.5], b: [-15.67, 7.5] },
] as unknown as SketchEntity[];
const pt = (e: string, p: string) => ({ e, p });
const cs = [
  { id: "h1", type: "horizontal", curves: ["bottom"] },
  { id: "c1", type: "coincident", pts: [pt("bottom", "a"), pt("right", "a")] },
  { id: "ang", type: "dim", curves: ["bottom", "right"], prop: "angle", value: 120 },
  { id: "l1", type: "dim", curves: ["right"], prop: "length", value: 100 },
  { id: "c2", type: "coincident", pts: [pt("right", "b"), pt("top", "a")] },
  { id: "h2", type: "horizontal", curves: ["top"] },
  { id: "l2", type: "dim", curves: ["top"], prop: "length", value: 100 },
  { id: "c3", type: "coincident", pts: [pt("top", "b"), pt("left", "a")] },
  { id: "par", type: "parallel", curves: ["left", "right"] },
  { id: "c4", type: "coincident", pts: [pt("bottom", "b"), pt("round", "a")] },
  { id: "t1", type: "tangent", curves: ["bottom", "round"] },
  { id: "c5", type: "coincident", pts: [pt("left", "b"), pt("round", "b")] },
  { id: "t2", type: "tangent", curves: ["left", "round"] },
  { id: "r", type: "dim", curves: ["round"], prop: "radius", value: 5 },
] as unknown as SketchConstraint[];
const start = solve(es0, cs);
check("the shape solves as drawn", start.ok, start.error);
const es = start.entities;
const line = (list: SketchEntity[], id: string) => list.find((e) => e.id === id) as unknown as { a: number[]; b: number[] };
const moved = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]);

for (const r of [10, 20, 2]) {
  const res = setValueStrict(es, cs, "r", r);
  const now = res?.result.entities ?? [];
  const far = res ? Math.max(...["right", "top"].flatMap((id) => [moved(line(now, id).a, line(es, id).a), moved(line(now, id).b, line(es, id).b)])) : NaN;
  // The lines the round joins keep their far ends (tied to the sides that stay) and their directions.
  const kept = res ? Math.max(moved(line(now, "bottom").a, line(es, "bottom").a), moved(line(now, "left").a, line(es, "left").a)) : NaN;
  const arc = now.find((e) => e.id === "round") as unknown as { a: number[]; m: number[]; b: number[] } | undefined;
  // The radius it has now: from its three points.
  let rad = NaN;
  if (arc) {
    const [ax, ay, bx, by, cx, cy] = [...arc.a, ...arc.m, ...arc.b];
    const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
    const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
    rad = Math.hypot(ax - ux, ay - uy);
  }
  check(`the round made ${r}: the two 100 mm sides do not move at all`, !!res && far < 1e-6, `moved ${far}`);
  check(`the round made ${r}: the lines it joins keep their other ends, and the round is ${r}`, !!res && kept < 1e-6 && Math.abs(rad - r) < 1e-5, `ends moved ${kept}, radius ${rad}`);
}
// A size nothing far away can stay still for: taken all the same (the 100 mm top made 60 moves its neighbours).
{
  const res = setValueStrict(es, cs, "l2", 60);
  check("a size that needs the rest to move is still taken", !!res && res.result.ok, res ? res.result.error : "refused");
}
done();
