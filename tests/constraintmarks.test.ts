// Run: npx tsx tests/constraintmarks.test.ts
// One mark of a kind at a place: wherever constraints of one kind meet on one point or one curve, the drawing shows
// their sign once there, not once for each. Every kind of constraint, in the ways they pile up - and a great many
// random piles besides. No constraint goes unshown: the one mark stands for all of them.
import type { SketchConstraint, SketchEntity, Vec2 } from "../src/doc/types";
import { placeMarks } from "../src/sketch/constraintMarks";
import { check, done } from "./kit";

const L = (id: string, a: Vec2, b: Vec2): SketchEntity => ({ id, kind: "line", a, b }) as SketchEntity;
const C = (id: string, c: Vec2, r: number): SketchEntity => ({ id, kind: "circle", center: c, radius: r }) as SketchEntity;
const A = (id: string, a: Vec2, m: Vec2, b: Vec2): SketchEntity => ({ id, kind: "arc", a, m, b }) as SketchEntity;
let n = 0;
const K = (type: string, more: Partial<SketchConstraint>): SketchConstraint => ({ id: `k${++n}`, type, ...more }) as SketchConstraint;
const P = (e: string, p: string) => ({ e, p });

/** The places where one kind of mark is drawn more than once, and the constraints no mark stands for. */
function faults(entities: SketchEntity[], constraints: SketchConstraint[]) {
  const marks = placeMarks(entities, constraints);
  const seen = new Map<string, number>();
  for (const m of marks) {
    if (m.shape || m.c.type === "dim" || m.c.type === "distance") continue;
    const k = `${m.c.type}|${m.at[0].toFixed(4)},${m.at[1].toFixed(4)}`;
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  const doubled = [...seen].filter(([, v]) => v > 1).map(([k]) => k);
  const shown = new Set(marks.flatMap((m) => [m.c.id, ...m.also.map((c) => c.id)]));
  const lost = constraints.filter((c) => c.type !== "pattern" && c.type !== "follow" && !shown.has(c.id)).map((c) => c.type);
  return { marks, doubled, lost };
}
const one = (name: string, entities: SketchEntity[], constraints: SketchConstraint[], want?: number) => {
  const f = faults(entities, constraints);
  const small = f.marks.filter((m) => !m.shape && m.c.type !== "dim" && m.c.type !== "distance").length;
  check(name, !f.doubled.length && !f.lost.length && (want === undefined || small === want), `marks ${small}${want === undefined ? "" : ` (want ${want})`} doubled ${JSON.stringify(f.doubled)} lost ${JSON.stringify(f.lost)}`);
};

// ---------------------------------------------------------------- joined ends
const star = [L("a", [0, 0], [10, 0]), L("b", [0, 0], [0, 10]), L("c", [0, 0], [-10, 0]), L("d", [0, 0], [0, -10])];
one("two lines joined at a corner: one dot", star.slice(0, 2), [K("coincident", { pts: [P("a", "a"), P("b", "a")] })], 1);
one("three lines meeting at a point (two joins): one dot", star.slice(0, 3), [K("coincident", { pts: [P("a", "a"), P("b", "a")] }), K("coincident", { pts: [P("b", "a"), P("c", "a")] })], 1);
one("four lines meeting at a point (three joins): one dot", star, [K("coincident", { pts: [P("a", "a"), P("b", "a")] }), K("coincident", { pts: [P("b", "a"), P("c", "a")] }), K("coincident", { pts: [P("c", "a"), P("d", "a")] })], 1);
one("the same two ends joined twice over: one dot", star.slice(0, 2), [K("coincident", { pts: [P("a", "a"), P("b", "a")] }), K("coincident", { pts: [P("b", "a"), P("a", "a")] })], 1);
one("every pair of three ends joined (three joins): one dot", star.slice(0, 3), [K("coincident", { pts: [P("a", "a"), P("b", "a")] }), K("coincident", { pts: [P("b", "a"), P("c", "a")] }), K("coincident", { pts: [P("a", "a"), P("c", "a")] })], 1);
{
  // A closed square: four corners, one dot each.
  const sq = [L("s1", [0, 0], [10, 0]), L("s2", [10, 0], [10, 10]), L("s3", [10, 10], [0, 10]), L("s4", [0, 10], [0, 0])];
  const joins = [0, 1, 2, 3].map((i) => K("coincident", { pts: [P(sq[i].id, "b"), P(sq[(i + 1) % 4].id, "a")] }));
  one("a square, its four corners joined: a dot at each", sq, joins, 4);
  one("...with level and upright on its sides: those signs once a side", sq, [...joins, K("horizontal", { curves: ["s1"] }), K("horizontal", { curves: ["s3"] }), K("vertical", { curves: ["s2"] }), K("vertical", { curves: ["s4"] })], 8);
}
one("two ends held on the centre of one circle: one dot there", [C("o", [0, 0], 5), L("a", [0, 0], [9, 0]), L("b", [0, 0], [0, 9])], [K("coincident", { pts: [P("a", "a"), P("o", "c")] }), K("coincident", { pts: [P("b", "a"), P("o", "c")] })], 1);

{
  // Joined as the solver leaves them: a hair apart (a few hundred-thousandths), not on the very same numbers.
  const es = [L("a", [0, 0], [40, 0]), L("b", [40.00004, 0.00003], [40, 30]), L("c", [39.99997, -0.00002], [70, -20])];
  one("two ends joined a hair apart: one dot", es.slice(0, 2), [K("coincident", { pts: [P("a", "b"), P("b", "a")] })], 1);
  one("three ends joined a hair apart (two joins): one dot", es, [K("coincident", { pts: [P("a", "b"), P("b", "a")] }), K("coincident", { pts: [P("b", "a"), P("c", "a")] })], 1);
}
// ---------------------------------------------------------------- one line, one kind, several times
const three = [L("a", [0, 0], [10, 0]), L("b", [0, 5], [10, 5]), L("c", [0, 9], [10, 9]), L("d", [0, 14], [10, 14])];
one("level put on a line twice: one H", three.slice(0, 1), [K("horizontal", { curves: ["a"] }), K("horizontal", { curves: ["a"] })], 1);
one("upright put on a line twice: one V", [L("u", [0, 0], [0, 10])], [K("vertical", { curves: ["u"] }), K("vertical", { curves: ["u"] })], 1);
one("locked twice: one lock", three.slice(0, 1), [K("fix", { pts: [P("a", "a")], at: [0, 0] }), K("fix", { pts: [P("a", "a")], at: [0, 0] })], 1);
for (const type of ["parallel", "equal", "perpendicular"]) {
  one(`${type}: a line tied to two others - once on each line`, three.slice(0, 3), [K(type, { curves: ["a", "b"] }), K(type, { curves: ["b", "c"] })], 3);
  one(`${type}: four lines in a chain - once on each line`, three, [K(type, { curves: ["a", "b"] }), K(type, { curves: ["b", "c"] }), K(type, { curves: ["c", "d"] })], 4);
  one(`${type}: every pair of three lines - once on each line`, three.slice(0, 3), [K(type, { curves: ["a", "b"] }), K(type, { curves: ["b", "c"] }), K(type, { curves: ["a", "c"] })], 3);
  one(`${type}: the same pair twice - once on each line`, three.slice(0, 2), [K(type, { curves: ["a", "b"] }), K(type, { curves: ["b", "a"] })], 2);
}
one("a line both parallel to one and equal to another: its two signs, each once", three.slice(0, 3), [K("parallel", { curves: ["a", "b"] }), K("equal", { curves: ["b", "c"] })], 4);

// ---------------------------------------------------------------- rounds
const rings = [C("o1", [0, 0], 3), C("o2", [0, 0], 5), C("o3", [0, 0], 8)];
one("three rings about one middle (two concentrics): once on each ring", rings, [K("concentric", { curves: ["o1", "o2"] }), K("concentric", { curves: ["o2", "o3"] })], 3);
one("three equal circles: once on each", [C("e1", [0, 0], 3), C("e2", [10, 0], 3), C("e3", [20, 0], 3)], [K("equal", { curves: ["e1", "e2"] }), K("equal", { curves: ["e2", "e3"] })], 3);
{
  // A round between two lines: tangent to both - the round has one T, each line one.
  const es = [L("a", [0, 0], [10, 0]), A("r", [10, 0], [12.83, 1.17], [14, 4]), L("b", [14, 4], [14, 14])];
  one("a round tangent to the two lines it joins: one T on the round, one on each line", es, [K("tangent", { curves: ["a", "r"] }), K("tangent", { curves: ["r", "b"] })], 3);
  one("...with its ends joined to them as well: a dot at each end", es, [K("tangent", { curves: ["a", "r"] }), K("tangent", { curves: ["r", "b"] }), K("coincident", { pts: [P("a", "b"), P("r", "a")] }), K("coincident", { pts: [P("r", "b"), P("b", "a")] })], 5);
  one("a circle tangent to three lines: one T on the circle", [C("o", [5, 5], 5), L("x", [0, 0], [10, 0]), L("y", [0, 0], [0, 10]), L("z", [0, 10], [10, 10])], [K("tangent", { curves: ["x", "o"] }), K("tangent", { curves: ["y", "o"] }), K("tangent", { curves: ["z", "o"] })], 4);
}
// ---------------------------------------------------------------- middles and mirrors
one("two ends held on the middle of one line: no sign twice", [L("a", [0, 0], [10, 0]), L("b", [5, 0], [5, 8]), L("c", [5, 0], [5, -8])], [K("midpoint", { pts: [P("b", "a")], curves: ["a"] }), K("midpoint", { pts: [P("c", "a")], curves: ["a"] })]);
one("two pairs of points mirrored over one line: its sign once on the line", [L("ax", [0, -5], [0, 5]), L("p", [-4, 0], [-4, 3]), L("q", [4, 0], [4, 3])], [K("symmetric", { pts: [P("p", "a"), P("q", "a")], curves: ["ax"] }), K("symmetric", { pts: [P("p", "b"), P("q", "b")], curves: ["ax"] })]);

// ---------------------------------------------------------------- sizes are each their own
{
  const f = faults([L("a", [0, 0], [10, 0]), L("b", [0, 5], [10, 5])], [K("dim", { curves: ["a"], prop: "length", value: 10 }), K("dim", { curves: ["b"], prop: "length", value: 10 })]);
  check("two lengths: two dimensions, as ever", f.marks.length === 2 && !f.lost.length, f.marks.length);
}

// ---------------------------------------------------------------- at random
{
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed / 0x7fffffff);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
  const kinds = ["coincident", "horizontal", "vertical", "parallel", "perpendicular", "equal", "tangent", "concentric", "midpoint", "symmetric", "fix"];
  let bad = 0;
  let piles = 0;
  let total = 0;
  for (let run = 0; run < 400; run++) {
    // A handful of lines out of a few shared points, and some circles on those points: plenty lands on one spot.
    const pts: Vec2[] = Array.from({ length: 4 }, () => [Math.round(rnd() * 4) * 5, Math.round(rnd() * 4) * 5]);
    const es: SketchEntity[] = [];
    for (let i = 0; i < 6; i++) {
      const [a, b] = [pick(pts), pick(pts)];
      if (a !== b && (a[0] !== b[0] || a[1] !== b[1])) es.push(L(`l${i}`, a, b));
    }
    for (let i = 0; i < 3; i++) es.push(C(`c${i}`, pick(pts), 2 + i));
    const lines = es.filter((e) => e.kind === "line");
    const circles = es.filter((e) => e.kind === "circle");
    if (lines.length < 2) continue;
    const cs: SketchConstraint[] = [];
    for (let i = 0; i < 14; i++) {
      const type = pick(kinds);
      const [l1, l2] = [pick(lines), pick(lines)];
      const end = () => P(pick(lines).id, pick(["a", "b"]));
      if (type === "coincident") cs.push(K(type, { pts: [end(), end()] }));
      else if (type === "horizontal" || type === "vertical") cs.push(K(type, { curves: [l1.id] }));
      else if (type === "parallel" || type === "perpendicular" || type === "equal") cs.push(K(type, { curves: [l1.id, l2.id] }));
      else if (type === "tangent") cs.push(K(type, { curves: [l1.id, pick(circles).id] }));
      else if (type === "concentric") cs.push(K(type, { curves: [pick(circles).id, pick(circles).id] }));
      else if (type === "midpoint") cs.push(K(type, { pts: [end()], curves: [l1.id] }));
      else if (type === "symmetric") cs.push(K(type, { pts: [end(), end()], curves: [l1.id] }));
      else cs.push(K(type, { pts: [end()] }));
    }
    const f = faults(es, cs);
    total++;
    if (f.marks.some((m) => m.also.length)) piles++;
    if (f.doubled.length || f.lost.length) bad++;
  }
  check(`${total} random sketches, 14 constraints each: no sign twice at a place, none unshown`, bad === 0 && total > 300, `${bad} bad`);
  check("...and most of them had constraints of one kind piled on one place (the test did test it)", piles > total * 0.8, `${piles} of ${total}`);
}
done();
