// Run: npx tsx tests/faceff.test.ts
// Freeform Face: a flat face of a body made a smooth surface through a grid
// of points, its edges kept - raised, pushed in, on a round face, on an
// L-shaped face, after fillets, followed when an earlier step moves the face,
// joined to another body after, and refused on a face with a hole.
import opencascade from "replicad-opencascadejs";
import { getOC, measureVolume, setOC, type Shape3D } from "replicad";
import { debugBodies, regenerate, shapeValid } from "../src/kernel/engine";
import { arrangement, regionRef } from "../src/sketch/regions";
import { faceGrid } from "../src/freeform/faceGrid";
import type { Feature, PlaneDef, Vec3 } from "../src/doc/types";

setOC(await (opencascade as unknown as () => Promise<any>)());
const oc = getOC();
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
const vol = (id: string) => Math.abs(measureVolume(debugBodies().get(id) as Shape3D));
const XY: PlaneDef = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] };
const body = (id: string, es: any[], h: number, plane = XY): Feature[] => [
  { id: `s${id}`, name: `s${id}`, type: "sketch", plane, entities: es } as Feature,
  { id, name: id, type: "extrude", source: { kind: "profile", sketch: `s${id}`, regions: arrangement(es as any).regions.map(regionRef) }, distance: h, mode: "new" } as Feature,
];
const rect = (cx: number, cy: number, w: number, h: number, id = "r") => ({ id, kind: "rect", center: [cx, cy], w, h, rotation: 0 });

async function build(fs: Feature[]) {
  const r: any = await regenerate(fs);
  const errors = r.errors.map((e: any) => `${e.featureId}: ${e.message}`).join(" | ");
  const bad: string[] = [];
  for (const [id, s] of debugBodies()) {
    if (!shapeValid(s as Shape3D)) bad.push(`${id} invalid`);
    if (solids(s as Shape3D) !== 1) bad.push(`${id}: ${solids(s as Shape3D)} solids`);
    const info = r.bodies.find((b: any) => b.id === id);
    if (info?.openEdges?.length) bad.push(`${id}: ${info.openEdges.length} open edges`);
  }
  return { r, errors, bad: bad.join(", ") };
}

/** The (first) face of a body facing `normal`: its ref and grid. */
function faceOf(r: any, id: string, normal: Vec3, n = 5) {
  const b = r.bodies.find((x: any) => x.id === id);
  const i = b.faces.findIndex((f: any) => f.normal[0] * normal[0] + f.normal[1] * normal[1] + f.normal[2] * normal[2] > 0.999);
  const f = b.faces[i];
  const g = b.faceGroups.find((x: any) => x.face === i);
  const P = (k: number): Vec3 => [b.positions[3 * k], b.positions[3 * k + 1], b.positions[3 * k + 2]];
  const tris: [Vec3, Vec3, Vec3][] = [];
  for (let t = g.start; t < g.start + g.count; t += 3) tris.push([P(b.indices[t]), P(b.indices[t + 1]), P(b.indices[t + 2])]);
  const ref = { body: id, center: f.center, normal: f.normal, area: f.area, ...(f.step ? { step: f.step } : {}) };
  return { ref, grid: faceGrid(tris, f.center, f.normal, n) };
}
const ff = (face: any, grid: Vec3[], move: (at: Vec3, i: number) => Vec3, id = "ff"): Feature =>
  ({ id, name: id, type: "faceFreeform", face, points: grid.map((at, i) => ({ at, move: move(at, i) })) }) as Feature;
const up = (k: number) => (at: Vec3): Vec3 => [0, 0, k * Math.max(0, 1 - Math.hypot(at[0], at[1]) / 18)];

// A 40 x 30 x 20 box, its top raised in the middle like a pillow.
const box = body("A", [rect(0, 0, 40, 30)], 20);
let r = await build(box);
const { ref, grid } = faceOf(r.r, "A", [0, 0, 1]);
check("a 5-across grid on a 40 x 30 top: points inside, none on the edges", grid.length >= 9 && grid.every((p) => Math.abs(p[0]) < 18 && Math.abs(p[1]) < 13), `${grid.length}`);
r = await build([...box, ff(ref, grid, up(6))]);
const vUp = vol("A");
const top = (debugBodies().get("A") as Shape3D).boundingBox.bounds[1][2];
check("top raised: a valid closed body, bigger, as high as the middle point", !r.errors && !r.bad && vUp > 24000 + 500 && top > 25 && top < 27.5, `${r.errors}${r.bad} ${vUp.toFixed(0)} top ${top.toFixed(2)}`);
const bb = (debugBodies().get("A") as Shape3D).boundingBox.bounds;
check("...its edges stay put (the sides are as they were)", Math.abs(bb[0][0] + 20) < 1e-3 && Math.abs(bb[1][0] - 20) < 1e-3 && Math.abs(bb[1][1] - 15) < 1e-3, JSON.stringify(bb));
r = await build([...box, ff(ref, grid, up(-6))]);
check("top pushed in: smaller", !r.errors && !r.bad && vol("A") < 24000 - 500, `${r.errors}${r.bad} ${vol("A").toFixed(0)}`);
r = await build([...box, ff(ref, grid, () => [0, 0, 0])]);
check("nothing moved: the body as it was", !r.errors && !r.bad && Math.abs(vol("A") - 24000) < 1e-6, `${r.errors}${r.bad}`);
r = await build([...box, ff(ref, grid, (_, i) => [0, 0, i % 2 ? 3 : -3])]);
check("points up and down in turn: a wavy top", !r.errors && !r.bad, `${r.errors}${r.bad}`);
r = await build([...box, ff(ref, grid, (at) => [at[0] * 0.1, 0, 4])]);
check("points moved sideways as well as up", !r.errors && !r.bad, `${r.errors}${r.bad}`);

// The face follows: the box made taller after.
{
  const taller = body("A", [rect(0, 0, 40, 30)], 30);
  r = await build([...taller, ff(ref, grid, up(6))]);
  const t = (debugBodies().get("A") as Shape3D).boundingBox.bounds[1][2];
  check("box made 30 tall after: the raised top goes with it", !r.errors && !r.bad && t > 35 && t < 37.5, `${r.errors}${r.bad} top ${t.toFixed(2)}`);
}

// A side face, a round top, an L-shaped top.
{
  const side = faceOf((await build(box)).r, "A", [1, 0, 0]);
  r = await build([...box, ff(side.ref, side.grid, () => [5, 0, 0])]);
  check("a side face pushed out", !r.errors && !r.bad && vol("A") > 24000, `${r.errors}${r.bad}`);
  const cyl = body("C", [{ id: "c", kind: "circle", center: [0, 0], radius: 15 }], 10);
  const c = faceOf((await build(cyl)).r, "C", [0, 0, 1]);
  r = await build([...cyl, ff(c.ref, c.grid, up(8))]);
  check("a cylinder's round top made a dome", !r.errors && !r.bad && vol("C") > Math.PI * 225 * 10, `${r.errors}${r.bad} ${c.grid.length} points`);
  const L = body("L", [{ id: "p", kind: "polyline", points: [[0, 0], [40, 0], [40, 15], [15, 15], [15, 40], [0, 40]], closed: true }], 10);
  const l = faceOf((await build(L)).r, "L", [0, 0, 1], 7);
  const outside = l.grid.filter((p) => p[0] + l.ref.center[0] > 15.5 && p[1] + l.ref.center[1] > 15.5);
  r = await build([...L, ff(l.ref, l.grid, () => [0, 0, 3])]);
  check("an L-shaped top: points only on the L, raised", outside.length === 0 && l.grid.length > 5 && !r.errors && !r.bad, `${r.errors}${r.bad} ${l.grid.length} points, ${outside.length} outside`);
}

// After fillets on the top's edges; and joined to / cut by another body after.
{
  const fil: Feature = { id: "f", name: "f", type: "fillet", radius: 3, edges: [[0, 15], [0, -15]].map(([x, y]) => ({ body: "A", mid: [x, y, 20], dir: [1, 0, 0], length: 40, steps: ["A"] })) } as Feature;
  const t = faceOf((await build([...box, fil])).r, "A", [0, 0, 1]);
  r = await build([...box, fil, ff(t.ref, t.grid, up(5))]);
  check("top rounded along two edges first, then raised", !r.errors && !r.bad, `${r.errors}${r.bad}`);
  const other = body("B", [rect(30, 0, 30, 10, "r2")], 10);
  r = await build([...box, ff(ref, grid, up(6)), ...other, { id: "u", name: "u", type: "boolean", op: "union", target: "A", tools: ["B"] } as Feature]);
  check("the raised box joined to another box after", !r.errors && !r.bad && [...debugBodies().keys()].length === 1, `${r.errors}${r.bad}`);
  r = await build([...box, ff(ref, grid, up(6)), ...body("H", [{ id: "c", kind: "circle", center: [0, 0], radius: 5 }], 40, { origin: [0, 0, -5], xDir: [1, 0, 0], normal: [0, 0, 1] }), { id: "s", name: "s", type: "boolean", op: "subtract", target: "A", tools: ["H"] } as Feature]);
  check("...a hole cut down through the raised top", !r.errors && !r.bad && vol("A") < vUp, `${r.errors}${r.bad}`);
}

// A face with a hole: refused, saying so. A point pushed through the bottom: refused, not broken.
{
  const res = [rect(0, 0, 40, 40), { id: "c", kind: "circle", center: [0, 0], radius: 6 }];
  const ring: Feature[] = [
    { id: "sR", name: "sR", type: "sketch", plane: XY, entities: res } as Feature,
    { id: "R", name: "R", type: "extrude", source: { kind: "profile", sketch: "sR", regions: arrangement(res as any).regions.filter((g: any) => g.area > 1000 || Math.abs(regionRef(g).a) > 1000).map(regionRef) }, distance: 10, mode: "new" } as Feature,
  ];
  const t = faceOf((await build(ring)).r, "R", [0, 0, 1]);
  r = await build([...ring, ff(t.ref, t.grid, () => [0, 0, 3])]);
  check("a face with a hole in it: refused, saying so", /holes/.test(r.errors), r.errors);
  r = await build([...box, ff(ref, grid, (_, i) => (i === Math.floor(grid.length / 2) ? [0, 0, -40] : [0, 0, 0]))]);
  check("a point pushed right through the bottom: refused (not a broken body)", !!r.errors && !r.bad, `${r.errors}${r.bad}`);
}

process.exit(failed ? 1 : 0);
