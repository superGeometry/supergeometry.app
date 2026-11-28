// Run: npx tsx tests/pickedonly.test.ts
// A constraint put on picked curves changes those curves; a curve that was not picked stays where it is, if the
// constraint can be met that way. (A line and an arc made tangent: the line at the arc's other end slid along.)
import type { SketchConstraint, SketchEntity } from "../src/doc/types";
import { addForUser } from "../src/sketch/constraints";
import { check, done } from "./kit";

const pt = (e: string, p: string) => ({ e, p });
type L = { a: number[]; b: number[]; m: number[] };
const get = (es: SketchEntity[], id: string) => es.find((e) => e.id === id) as unknown as L;
const moved = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// An upright line down to (480, 56), a level line from (510, 20), and an arc joining the two ends - not tangent to
// either yet. Vertical and Horizontal on the lines; nothing holds them in place.
const es = [
  { id: "up", kind: "line", a: [480, 240], b: [480, 55.96472613] },
  { id: "level", kind: "line", a: [510, 20], b: [720, 20] },
  { id: "arc", kind: "arc", a: [510, 20], m: [487.2711306369633, 30.16433701194881], b: [480, 55.96472613] },
] as unknown as SketchEntity[];
const cs = [
  { id: "v", type: "vertical", curves: ["up"] },
  { id: "h", type: "horizontal", curves: ["level"] },
  { id: "c1", type: "coincident", pts: [pt("arc", "a"), pt("level", "a")] },
  { id: "c2", type: "coincident", pts: [pt("arc", "b"), pt("up", "b")] },
] as unknown as SketchConstraint[];

const tangentAt = (now: SketchEntity[], line: string, end: "a" | "b") => {
  // The arc's centre from its three points; tangent to the line at that end: the radius there is square to it
  // (to the thousandth the solver works to).
  const arc = get(now, "arc");
  const [ax, ay, bx, by, cx, cy] = [...arc.a, ...arc.m, ...arc.b];
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
  const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
  const l = get(now, line);
  const dir = [l.b[0] - l.a[0], l.b[1] - l.a[1]];
  const p = arc[end];
  const r = [p[0] - ux, p[1] - uy];
  return Math.abs(dir[0] * r[0] + dir[1] * r[1]) / (Math.hypot(dir[0], dir[1]) * Math.hypot(r[0], r[1]));
};

for (const [first, name] of [["up", "the line picked first"], ["arc", "the arc picked first"], [undefined, "no first pick"]] as const) {
  const res = addForUser(es, cs, [{ id: "t", type: "tangent", curves: ["up", "arc"] } as unknown as SketchConstraint], first);
  const now = res.result.entities;
  const level = get(now, "level");
  check(`upright line and arc made tangent (${name}): the level line, not picked, does not move`, res.ok && moved(level.a, [510, 20]) < 1e-6 && moved(level.b, [720, 20]) < 1e-6, `${level.a} ${level.b}`);
  check(`…and they are tangent, the arc still joined to both lines`, res.ok && tangentAt(now, "up", "b") < 1e-3 && moved(get(now, "arc").a, level.a) < 1e-6 && moved(get(now, "arc").b, get(now, "up").b) < 1e-6 && !res.removed.length, `off square by ${tangentAt(now, "up", "b")}`);
}
// The other pair: level line and arc picked - the upright line stays.
{
  const res = addForUser(es, cs, [{ id: "t", type: "tangent", curves: ["level", "arc"] } as unknown as SketchConstraint], "level");
  const up = get(res.result.entities, "up");
  check("level line and arc made tangent: the upright line, not picked, does not move", res.ok && moved(up.a, [480, 240]) < 1e-6 && moved(up.b, [480, 55.96472613]) < 1e-6 && tangentAt(res.result.entities, "level", "a") < 1e-3, `${up.a} ${up.b}`);
}
// A constraint that can't be met with the rest held still is still taken: something unpicked gives way.
{
  const es2 = [
    { id: "p", kind: "line", a: [0, 0], b: [50, 0] },
    { id: "q", kind: "line", a: [50, 0], b: [50, 40] },
    { id: "r", kind: "line", a: [50, 40], b: [0, 40] },
  ] as unknown as SketchEntity[];
  const cs2 = [
    { id: "c1", type: "coincident", pts: [pt("p", "b"), pt("q", "a")] },
    { id: "c2", type: "coincident", pts: [pt("q", "b"), pt("r", "a")] },
  ] as unknown as SketchConstraint[];
  // q made 60 long: its ends are tied to p and r, which were not picked - one of them has to move.
  const res = addForUser(es2, cs2, [{ id: "d", type: "dim", curves: ["q"], prop: "length", value: 60 } as unknown as SketchConstraint]);
  const q = get(res.result.entities, "q");
  check("a size the unpicked curves have to move for is still taken", res.ok && Math.abs(moved(q.a, q.b) - 60) < 1e-6, `${moved(q.a, q.b)}`);
}
done();
