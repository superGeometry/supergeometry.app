// Run: npx tsx tests/heldend.test.ts
// A line whose one end is tied to another line's end, given a new length: the tied end stays, the free end takes
// the change. Left to the solver both ends moved, and the other line was dragged along.
import type { SketchConstraint, SketchEntity } from "../src/doc/types";
import { addStrict, lengthFromHeldEnd } from "../src/sketch/constraints";
import { check, done } from "./kit";

const line = (id: string, a: [number, number], b: [number, number]) => ({ id, kind: "line", a, b }) as SketchEntity;
const tie = (id: string, e1: string, p1: "a" | "b", e2: string, p2: "a" | "b") => ({ id, type: "coincident", pts: [{ e: e1, p: p1 }, { e: e2, p: p2 }] }) as SketchConstraint;
const ends = (es: SketchEntity[], id: string) => {
  const e = es.find((x) => x.id === id) as { a: [number, number]; b: [number, number] };
  return [e.a, e.b];
};
const at = (p: number[], x: number, y: number) => Math.hypot(p[0] - x, p[1] - y) < 1e-6;

/** The length of `id` set to `v`, the way the sketch tool does it. */
function setLength(es: SketchEntity[], cs: SketchConstraint[], id: string, v: number) {
  const from = lengthFromHeldEnd(es, cs, id, v);
  const res = addStrict(from, cs, [{ id: "d", type: "dim", curves: [id], prop: "length", value: v } as SketchConstraint]);
  return { ok: res.ok, es: res.result.entities };
}

// A level line 20 long, and an upright one from its right end: an L.
const L = [line("A", [0, 0], [20, 0]), line("B", [20, 0], [20, 15])];
const tied = [tie("c1", "A", "b", "B", "a")];
for (const v of [30, 8]) {
  const r = setLength(L, tied, "A", v);
  const [a, b] = ends(r.es, "A");
  const [ba, bb] = ends(r.es, "B");
  check(`level line to ${v}: its tied end and the upright line stay, its free end goes to x = ${20 - v}`, r.ok && at(b, 20, 0) && at(a, 20 - v, 0) && at(ba, 20, 0) && at(bb, 20, 15), JSON.stringify([a, b, ba, bb]));
}
// The upright line: tied at its start, so its far end moves.
{
  const r = setLength(L, tied, "B", 40);
  const [ba, bb] = ends(r.es, "B");
  const [a, b] = ends(r.es, "A");
  check("upright line to 40: its tied start stays, its top goes to y = 40, the level line stays", r.ok && at(ba, 20, 0) && at(bb, 20, 40) && at(a, 0, 0) && at(b, 20, 0), JSON.stringify([ba, bb, a, b]));
}
// A slanted line tied at its far end: the change runs along the line.
{
  const es = [line("A", [0, 0], [30, 40]), line("B", [30, 40], [60, 40])];
  const r = setLength(es, [tie("c1", "A", "b", "B", "a")], "A", 25);
  const [a, b] = ends(r.es, "A");
  check("a slanted line 50 long to 25: its tied end stays, its free end comes halfway along it", r.ok && at(b, 30, 40) && at(a, 15, 20), JSON.stringify([a, b]));
}
// Tied at both ends, or at neither: nothing is moved beforehand.
{
  const es = [line("A", [0, 0], [20, 0]), line("B", [20, 0], [20, 15]), line("C", [0, 0], [0, 15])];
  const both = [tie("c1", "A", "b", "B", "a"), tie("c2", "A", "a", "C", "a")];
  check("tied at both ends: left to the solver", lengthFromHeldEnd(es, both, "A", 30) === es);
  check("tied at neither end: left to the solver", lengthFromHeldEnd(es, [], "A", 30) === es);
}
done();
