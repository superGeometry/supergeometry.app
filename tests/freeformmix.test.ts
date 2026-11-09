// Run: npx tsx tests/freeformmix.test.ts [quick]
//
// Bodies made from sketches together with freeform bodies, every way they can
// meet: union, subtract (either way round) and intersect, with the freeform
// overlapping, inside, around, just touching and well away from the other;
// then extrudes joining / cutting into a freeform, a sketch on a body's face
// reaching a freeform, the seam where they meet rounded, shells, chamfers,
// moves / mirrors / patterns, splits, the cage changed afterwards, sheets
// with a thickness.
//
// Volumes are checked against each other, not against hand-worked numbers:
//   V(A ∪ B) + V(A ∩ B) = V(A) + V(B),  V(A − B) = V(A) − V(A ∩ B).
// Every accepted step must leave valid, closed solids.
import opencascade from "replicad-opencascadejs";
import { getOC, measureVolume, setOC, type Shape3D } from "replicad";
import { debugBodies, regenerate, shapeValid } from "../src/kernel/engine";
import { arrangement, regionRef } from "../src/sketch/regions";
import { boxCage, cylinderCage, planeCage, refineCage, sphereCage, type Cage } from "../src/freeform/cage";
import type { Feature, PlaneDef, Vec3 } from "../src/doc/types";

setOC(await (opencascade as unknown as () => Promise<any>)());
const oc = getOC();
const QUICK = process.argv[2] === "quick";
// "matrix" / "rest": one part only. The engine leaks a little on every boolean
// with a freeform (inside OpenCascade; the app restarts its engine when it
// grows): all of it in one process runs out of memory.
const PART = process.argv[2] === "matrix" || process.argv[2] === "rest" ? process.argv[2] : null;
if (!PART && !QUICK) {
  const { spawnSync } = await import("node:child_process");
  let bad = 0;
  for (const part of ["matrix", "rest"]) bad |= spawnSync(process.execPath, [...process.execArgv, process.argv[1], part], { stdio: "inherit" }).status ?? 1;
  process.exit(bad);
}

const XY: PlaneDef = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] };
let failed = 0;
const check = (name: string, ok: boolean, info = "") => {
  if (!ok) failed++;
  console.log(ok ? "ok  " : "FAIL", name, info);
};
const solids = (s: Shape3D) => {
  const ex = new oc.TopExp_Explorer(s.wrapped, oc.TopAbs_ShapeEnum.TopAbs_SOLID, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  let n = 0;
  for (; ex.More(); ex.Next()) n++;
  ex.delete();
  return n;
};
const vol = (id: string) => {
  const b = debugBodies().get(id);
  return b ? Math.abs(measureVolume(b as Shape3D)) : NaN;
};

// ------------------------------------------------------------ the bodies

const sketch = (id: string, es: any[], plane: PlaneDef = XY): Feature => ({ id, name: id, type: "sketch", plane, entities: es }) as Feature;
const extrude = (id: string, sk: string, es: any[], distance: number, mode: "new" | "join" | "cut" | "auto" = "new", target?: string): Feature =>
  ({ id, name: id, type: "extrude", source: { kind: "profile", sketch: sk, regions: arrangement(es).regions.map(regionRef) }, distance, mode, ...(target ? { target } : {}) }) as Feature;
const rect = (w: number, h: number, cx = 0, cy = 0) => [{ id: "r", kind: "rect", center: [cx, cy], w, h, rotation: 0 }];
const circle = (r: number, cx = 0, cy = 0) => [{ id: "c", kind: "circle", center: [cx, cy], radius: r }];

/** A body from a sketch, id "A": its steps. */
const SK: Record<string, () => Feature[]> = {
  box: () => [sketch("skA", rect(40, 30)), extrude("A", "skA", rect(40, 30), 20)],
  cylinder: () => [sketch("skA", circle(12)), extrude("A", "skA", circle(12), 30)],
  "rounded box": () => [
    sketch("skA", rect(40, 30)),
    extrude("A", "skA", rect(40, 30), 20),
    { id: "fA", name: "fA", type: "fillet", radius: 4, edges: [[20, 15], [-20, 15], [20, -15], [-20, -15]].map(([x, y]) => ({ body: "A", mid: [x, y, 10], dir: [0, 0, 1], length: 20, steps: ["A"] })) } as Feature,
  ],
};

/** A freeform, id "B", centred on the origin (moved / scaled for each placement). */
const pulled = () => {
  const c = boxCage([30, 30, 30], 2);
  const top = c.verts.reduce((best, v, i) => (v[2] > c.verts[best][2] + 1e-9 || (Math.abs(v[2] - c.verts[best][2]) < 1e-9 && v[0] + v[1] > c.verts[best][0] + c.verts[best][1]) ? i : best), 0);
  c.verts[top] = [c.verts[top][0] + 6, c.verts[top][1] + 6, c.verts[top][2] + 12];
  return c;
};
const FF: Record<string, () => { cage: Cage; thickness?: number }> = {
  sphere: () => ({ cage: sphereCage(30) }),
  "box cage": () => ({ cage: boxCage([30, 30, 30], 2) }),
  "cylinder cage": () => ({ cage: cylinderCage(24, 36, 2) }),
  "refined, pulled": () => ({ cage: refineCage(pulled()) }),
  "thick sheet": () => ({ cage: planeCage([40, 40], 4), thickness: 4 }),
};
const freeform = (id: string, ff: { cage: Cage; thickness?: number }, at: Vec3 = [0, 0, 0], k = 1): Feature =>
  ({
    id,
    name: id,
    type: "freeform",
    cage: { faces: ff.cage.faces, verts: ff.cage.verts.map((v) => [at[0] + v[0] * k, at[1] + v[1] * k, at[2] + v[2] * k] as Vec3) },
    ...(ff.thickness ? { surface: true, thickness: ff.thickness * k, thickSide: "both" } : {}),
  }) as Feature;

/** Bounding box of a body as built. */
function bbox(id: string): { lo: Vec3; hi: Vec3 } {
  const b = debugBodies().get(id) as Shape3D;
  const bb = b.boundingBox;
  return { lo: bb.bounds[0] as Vec3, hi: bb.bounds[1] as Vec3 };
}

/** Builds; the bodies' problems (empty: fine). `parts`: more than one solid is fine (a cut in two). */
async function build(features: Feature[], parts = false): Promise<{ errors: string; bad: string; r: any }> {
  let r: any;
  try {
    r = await regenerate(features);
  } catch (e) {
    return { errors: `threw: ${(e as Error).message}`, bad: "", r: null };
  }
  const errors = r.errors.map((e: any) => `${e.featureId}: ${e.message}`).join(" | ");
  const bad: string[] = [];
  for (const [id, s] of debugBodies()) {
    const info = r.bodies.find((b: any) => b.id === id);
    if (!shapeValid(s as Shape3D)) bad.push(`${id} invalid`);
    const n = solids(s as Shape3D);
    if (n < 1 || (n > 1 && !parts)) bad.push(`${id}: ${n} solids`);
    if (info?.openEdges?.length) bad.push(`${id}: ${info.openEdges.length} open edges`);
  }
  return { errors, bad: bad.join(", "), r };
}

const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(1, Math.abs(a), Math.abs(b));
const TOL = 2e-3;

// ------------------------------------------------- 1. the boolean matrix

const PLACES: { name: string; place: (a: { lo: Vec3; hi: Vec3 }, b: { lo: Vec3; hi: Vec3 }) => { at: Vec3; k: number }; empty?: boolean }[] = [
  // The freeform's middle at a corner of the other body.
  { name: "overlapping", place: (a) => ({ at: [a.hi[0] - 4, a.hi[1] - 4, a.hi[2] - 4], k: 1 }) },
  // Small, well inside.
  { name: "inside", place: (a, b) => ({ at: mid(a), k: (0.5 * Math.min(...size(a))) / Math.max(...size(b)) }) },
  // Big, all round it.
  { name: "around", place: (a, b) => ({ at: mid(a), k: (1.6 * Math.max(...size(a))) / Math.min(...size(b)) }) },
  // Side by side, 0.3 mm into each other.
  { name: "just touching", place: (a, b) => ({ at: [a.hi[0] - 0.3 - b.lo[0], mid(a)[1], mid(a)[2]], k: 1 }) },
  // A centre in common, the same size more or less.
  { name: "same middle", place: (a) => ({ at: mid(a), k: 1 }) },
  { name: "apart", place: (a) => ({ at: [a.hi[0] + 60, 0, 0], k: 1 }), empty: true },
];
const mid = (b: { lo: Vec3; hi: Vec3 }): Vec3 => [0, 1, 2].map((k) => (b.lo[k] + b.hi[k]) / 2) as Vec3;
const size = (b: { lo: Vec3; hi: Vec3 }): Vec3 => [0, 1, 2].map((k) => b.hi[k] - b.lo[k]) as Vec3;

const skNames = QUICK ? ["box"] : Object.keys(SK);
const ffNames = QUICK ? ["sphere", "thick sheet"] : Object.keys(FF);
const placeNames = QUICK ? ["overlapping", "inside"] : PLACES.map((p) => p.name);
let combos = 0;
const t0 = performance.now();
for (const sk of PART === "rest" ? [] : skNames) {
  await build(SK[sk]());
  const vA = vol("A");
  const boxA = bbox("A");
  for (const ffn of ffNames) {
    await build([freeform("B", FF[ffn]())]);
    const boxB0 = bbox("B");
    for (const pl of PLACES.filter((p) => placeNames.includes(p.name))) {
      const { at, k } = pl.place(boxA, boxB0);
      // Placed by its middle (the cage isn't centred on its box when pulled).
      const c0 = mid(boxB0).map((x) => x * k);
      const B = freeform("B", FF[ffn](), [at[0] - c0[0], at[1] - c0[1], at[2] - c0[2]], k);
      const label = `${sk} + ${ffn}, ${pl.name}`;
      const alone = await build([B]);
      const vB = vol("B");
      if (alone.errors || alone.bad) {
        check(`${label}: the freeform builds`, false, alone.errors + alone.bad);
        continue;
      }
      combos++;
      const op = async (o: "union" | "subtract" | "intersect", target: string, tool: string) => {
        const res = await build([...SK[sk](), B, { id: "bo", name: "bo", type: "boolean", op: o, target, tools: [tool] } as Feature], true);
        return { ...res, v: vol(target) };
      };
      const I = await op("intersect", "A", "B");
      const vI = I.errors ? (/empty/i.test(I.errors) ? 0 : NaN) : I.v;
      if (pl.empty) check(`${label}: intersect says it's empty`, vI === 0, I.errors || `${I.v}`);
      else check(`${label}: intersect`, !I.errors && !I.bad && vI > 0, I.errors + I.bad);
      const I2 = await op("intersect", "B", "A");
      if (!pl.empty) check(`${label}: intersect the other way round, the same`, !I2.errors && !I2.bad && rel(I2.v, vI) < TOL, `${I2.errors}${I2.bad} ${I2.v.toFixed(1)} vs ${vI.toFixed(1)}`);
      const U = await op("union", "A", "B");
      const U2 = await op("union", "B", "A");
      if (pl.empty) {
        // Apart: refused, saying why.
        check(`${label}: union refused - they don't touch`, /don't touch/.test(U.errors) && /don't touch/.test(U2.errors), U.errors + U2.errors);
      } else {
        check(`${label}: union`, !U.errors && !U.bad && rel(U.v, vA + vB - vI) < TOL, `${U.errors}${U.bad} ${U.v.toFixed(1)} want ${(vA + vB - vI).toFixed(1)}`);
        check(`${label}: union into the freeform`, !U2.errors && !U2.bad && rel(U2.v, vA + vB - vI) < TOL, `${U2.errors}${U2.bad} ${U2.v.toFixed(1)}`);
      }
      for (const [t, o, vt] of [["A", "B", vA], ["B", "A", vB]] as const) {
        const S = await op("subtract", t, o);
        const want = vt - vI;
        const gone = want < vt * 1e-6;
        const ok = gone ? /empty/i.test(S.errors) : !S.errors && !S.bad && rel(S.v, want) < TOL;
        check(`${label}: ${t === "A" ? "freeform cut out of the sketch body" : "sketch body cut out of the freeform"}`, ok, `${S.errors}${S.bad} ${S.v.toFixed(1)} want ${want.toFixed(1)}`);
      }
    }
  }
}
console.log(`  ${combos} placements, ${((performance.now() - t0) / 1000).toFixed(1)} s`);

// ------------------------------------------------- 2. every other way they meet
if (PART === "matrix") process.exit(failed ? 1 : 0);

const sphere = () => freeform("B", FF.sphere(), [15, 10, 20]);
const boxSteps = () => SK.box();
const union = (target = "A", tools = ["B"]): Feature => ({ id: "u", name: "u", type: "boolean", op: "union", target, tools }) as Feature;
const vSphere = await (async () => (await build([sphere()]), vol("B")))();
const vBox = 40 * 30 * 20;

// An extrude straight into a freeform, joined / cut.
{
  const es = circle(6, 15, 10);
  const up = [sphere(), sketch("s", es), extrude("e", "s", es, 30, "join", "B")];
  let r = await build(up);
  const vJoin = vol("B");
  await build([sphere(), sketch("s", es), extrude("e", "s", es, 30, "new")]);
  const vPeg = vol("e");
  await build([sphere(), sketch("s", es), extrude("e", "s", es, 30, "new"), { id: "i", name: "i", type: "boolean", op: "intersect", target: "e", tools: ["B"], keepTools: true } as Feature]);
  const vCommon = vol("e");
  check("extrude joined into a freeform (mode Add)", !r.errors && !r.bad && rel(vJoin, vSphere + vPeg - vCommon) < TOL, `${r.errors}${r.bad} ${vJoin.toFixed(1)} want ${(vSphere + vPeg - vCommon).toFixed(1)}`);
  r = await build([sphere(), sketch("s", es), extrude("e", "s", es, 30, "cut", "B")]);
  check("extrude cut through a freeform (a hole down through the sphere)", !r.errors && !r.bad && rel(vol("B"), vSphere - vCommon) < TOL, `${r.errors}${r.bad} ${vol("B").toFixed(1)} want ${(vSphere - vCommon).toFixed(1)}`);
  // Auto: a negative distance from a sketch above the sphere cuts into it.
  const top: PlaneDef = { origin: [0, 0, 40], xDir: [1, 0, 0], normal: [0, 0, 1] };
  r = await build([sphere(), sketch("s", es, top), extrude("e", "s", es, -25, "auto", "B")]);
  check("extrude Auto with a negative distance cuts down into a freeform", !r.errors && !r.bad && vol("B") < vSphere - 1, `${r.errors}${r.bad} ${vol("B").toFixed(1)}`);
}

// A sketch on the box's top face, extruded up into a freeform sitting on it.
{
  const es = rect(10, 10, 12, 8);
  const top: PlaneDef = { origin: [0, 0, 20], xDir: [1, 0, 0], normal: [0, 0, 1] };
  const sk2 = { ...sketch("s2", es, top), attachedTo: { body: "A", center: [0, 0, 20], normal: [0, 0, 1], area: 1200, step: "A" } } as Feature;
  const r = await build([...boxSteps(), sphere(), union(), sk2, extrude("e2", "s2", es, 15, "auto", "A")]);
  check("sketch on the box's top face, extruded up through the freeform joined to it", !r.errors && !r.bad && vol("A") > vBox, `${r.errors}${r.bad}`);
}

// The seam where a box and a freeform meet, rounded and chamfered.
for (const kind of ["fillet", "chamfer"] as const) {
  const base = [...boxSteps(), freeform("B", FF["cylinder cage"](), [0, 0, 15]), union()];
  const r0 = await build(base);
  const body = r0.r.bodies.find((b: any) => b.id === "A");
  const seam = body.edges.filter((e: any) => e.steps?.length === 2);
  const r = await build([...base, { id: "f", name: "f", type: kind, radius: 2, edges: seam.map((e: any) => ({ body: "A", mid: e.mid, dir: e.dir, length: e.length, steps: e.steps })) } as Feature]);
  check(`the seam where a freeform cylinder stands on a box, ${kind === "fillet" ? "rounded" : "chamfered"} (${seam.length} edges)`, seam.length > 0 && !r.errors && !r.bad && vol("A") > vol("A") * 0, `${r.errors}${r.bad}`);
}

// Box edges rounded after a freeform was joined to it; and the other way round.
{
  const fil = (r: number): Feature => ({ id: "fb", name: "fb", type: "fillet", radius: r, edges: [[20, 15], [-20, 15], [20, -15], [-20, -15]].map(([x, y]) => ({ body: "A", mid: [x, y, 10], dir: [0, 0, 1], length: 20, steps: ["A"] })) }) as Feature;
  let r = await build([...boxSteps(), freeform("B", FF.sphere(), [0, 0, 20]), union(), fil(3)]);
  check("box corners rounded after a freeform was joined on top", !r.errors && !r.bad, `${r.errors}${r.bad}`);
  r = await build([...boxSteps(), fil(3), freeform("B", FF.sphere(), [0, 0, 20]), union()]);
  check("…and before it was joined", !r.errors && !r.bad, `${r.errors}${r.bad}`);
}

// Shells.
{
  let r = await build([...boxSteps(), sphere(), union(), { id: "sh", name: "sh", type: "shell", body: "A", faces: [{ body: "A", center: [0, -15, 10], normal: [0, -1, 0], area: 800, step: "A" }], thickness: 1.5 } as Feature]);
  check("box + freeform joined, then shelled with the front open", !r.errors && !r.bad && vol("A") < vBox, `${r.errors}${r.bad}`);
  r = await build([sphere(), { id: "sh", name: "sh", type: "shell", body: "B", faces: [], thickness: 2 } as Feature]);
  check("a freeform hollowed (closed shell)", !r.errors && !r.bad && vol("B") < vSphere && vol("B") > 0, `${r.errors}${r.bad}`);
  r = await build([...boxSteps(), sphere(), { id: "sh", name: "sh", type: "shell", body: "B", faces: [], thickness: 2 } as Feature, union()]);
  check("a hollow freeform joined to a box", !r.errors && !r.bad, `${r.errors}${r.bad}`);
}

// Moved, mirrored, patterned freeforms joined to / cut from a box.
{
  const moves: [string, any][] = [
    ["moved and turned", { kind: "move", translate: [-10, 0, -5], rotate: { origin: [15, 10, 20], axis: [1, 0, 0], angle: 30 } }],
    ["mirrored (a copy)", { kind: "mirror", plane: { origin: [0, 0, 0], xDir: [0, 1, 0], normal: [1, 0, 0] } }],
    ["in a row of 3", { kind: "linear", dir: [-1, 0, 0], spacing: 12, count: 3 }],
    ["round an axis, 4 of them", { kind: "circular", axis: { origin: [0, 0, 0], dir: [0, 0, 1] }, count: 4, angle: 360 }],
    ["scaled 0.6", { kind: "scale", center: [15, 10, 20], factor: 0.6 }],
    ["stretched along X", { kind: "scaleXYZ", center: [15, 10, 20], factors: [1.6, 1, 0.7] }],
  ];
  for (const [name, op] of moves) {
    const copy = op.kind !== "move" && op.kind !== "scale" && op.kind !== "scaleXYZ";
    const steps = [...boxSteps(), sphere(), { id: "t", name: "t", type: "transform", bodies: ["B"], copy, op } as Feature];
    const r0 = await build(steps, true);
    const ffs = [...debugBodies().keys()].filter((id) => id !== "A");
    for (const o of ["union", "subtract"] as const) {
      const r = await build([...steps, { id: "bo", name: "bo", type: "boolean", op: o, target: "A", tools: ffs } as Feature], true);
      check(`freeform ${name}, ${o === "union" ? "joined to" : "cut out of"} a box (${ffs.length} of them)`, !r0.errors && !r.errors && !r.bad, `${r0.errors}${r.errors}${r.bad}`);
    }
  }
}

// Split: a box + freeform body cut in two by a plane, the halves add up.
{
  const steps = [...boxSteps(), sphere(), union()];
  await build(steps);
  const whole = vol("A");
  const r = await build([...steps, { id: "sp", name: "sp", type: "split", body: "A", plane: { origin: [15, 0, 0], xDir: [0, 1, 0], normal: [1, 0, 0] } } as Feature], true);
  const sum = [...debugBodies().keys()].reduce((s, id) => s + vol(id), 0);
  check("box + freeform split through the freeform: the pieces add up", !r.errors && !r.bad && rel(sum, whole) < TOL, `${r.errors}${r.bad} ${sum.toFixed(1)} vs ${whole.toFixed(1)}`);
}

// The cage changed after the union: the union follows.
{
  const bigger = freeform("B", FF.sphere(), [15, 10, 20], 1.3);
  await build([...boxSteps(), bigger]);
  const vB2 = vol("B");
  await build([...boxSteps(), bigger, { id: "i", name: "i", type: "boolean", op: "intersect", target: "A", tools: ["B"] } as Feature]);
  const vI = vol("A");
  const r = await build([...boxSteps(), bigger, union()]);
  check("cage made bigger after the union: the union follows", !r.errors && !r.bad && rel(vol("A"), vBox + vB2 - vI) < TOL, `${r.errors}${r.bad}`);
}

// A sheet with a thickness, and a sheet without (a surface: refused, with a way out).
{
  const sheet = (t?: number) => freeform("B", { cage: planeCage([30, 30], 3), thickness: t }, [10, 5, 20]);
  let r = await build([...boxSteps(), sheet(3), { id: "bo", name: "bo", type: "boolean", op: "subtract", target: "A", tools: ["B"] } as Feature]);
  check("a thick sheet cut out of a box's top (a groove)", !r.errors && !r.bad && vol("A") < vBox, `${r.errors}${r.bad}`);
  r = await build([...boxSteps(), sheet(), union()]);
  check("a sheet with no thickness joined to a box: refused, saying what to do", /open surface.*Thickness/.test(r.errors), r.errors);
}

// Two freeforms and a box, all in one union; then a freeform joined into a freeform.
{
  const C = freeform("C", FF["box cage"](), [-15, -10, 15]);
  let r = await build([...boxSteps(), sphere(), C, union("A", ["B", "C"])]);
  check("box + two freeforms in one union", !r.errors && !r.bad, `${r.errors}${r.bad}`);
  r = await build([sphere(), freeform("C", FF["cylinder cage"](), [15, 10, 30]), union("B", ["C"])]);
  check("freeform joined into a freeform", !r.errors && !r.bad, `${r.errors}${r.bad}`);
}

// A flat face of the box moved after the union (the freeform part rides along).
{
  const r = await build([...boxSteps(), freeform("B", FF.sphere(), [0, 0, 20]), union(), { id: "mf", name: "mf", type: "moveFace", face: { body: "A", center: [-20, 0, 10], normal: [-1, 0, 0], area: 600, step: "A" }, translate: [-8, 0, 0] } as Feature]);
  check("a box face pushed out after a freeform was joined on top", !r.errors && !r.bad && vol("A") > vBox, `${r.errors}${r.bad}`);
}

// A freeform inside a box, cut out: a hidden hollow.
{
  const r = await build([...boxSteps(), freeform("B", FF.sphere(), [0, 0, 10], 0.4), { id: "bo", name: "bo", type: "boolean", op: "subtract", target: "A", tools: ["B"] } as Feature]);
  check("a small freeform cut out of the inside of a box (a hollow)", !r.errors && !r.bad && vol("A") < vBox, `${r.errors}${r.bad}`);
}

process.exit(failed ? 1 : 0);
