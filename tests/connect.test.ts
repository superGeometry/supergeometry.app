// Run: npx tsx tests/connect.test.ts
// Connect: a freeform bridge between two picked faces, joined (Add / Auto),
// cut (Cut) or a body of its own (New body) - between two boxes facing each
// other, side by side (the bridge bends round), different sizes and shapes,
// two faces of one body (a curved tunnel when cut), a thin plate.
import opencascade from "replicad-opencascadejs";
import { getOC, measureVolume, setOC, type Shape3D } from "replicad";
import { debugBodies, regenerate, shapeValid } from "../src/kernel/engine";
import { arrangement, regionRef } from "../src/sketch/regions";
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
const plane = (z: number): PlaneDef => ({ origin: [0, 0, z], xDir: [1, 0, 0], normal: [0, 0, 1] });
const box = (id: string, w: number, d: number, h: number, at: Vec3): Feature[] => {
  const es = [{ id: "r", kind: "rect", center: [at[0], at[1]], w, h: d, rotation: 0 }];
  return [
    { id: `s${id}`, name: `s${id}`, type: "sketch", plane: plane(at[2]), entities: es } as Feature,
    { id, name: id, type: "extrude", source: { kind: "profile", sketch: `s${id}`, regions: arrangement(es as any).regions.map(regionRef) }, distance: h, mode: "new" } as Feature,
  ];
};
const cyl = (id: string, r: number, h: number, at: Vec3): Feature[] => {
  const es = [{ id: "c", kind: "circle", center: [at[0], at[1]], radius: r }];
  return [
    { id: `s${id}`, name: `s${id}`, type: "sketch", plane: plane(at[2]), entities: es } as Feature,
    { id, name: id, type: "extrude", source: { kind: "profile", sketch: `s${id}`, regions: arrangement(es as any).regions.map(regionRef) }, distance: h, mode: "new" } as Feature,
  ];
};
const face = (body: string, center: Vec3, normal: Vec3, area: number) => ({ body, center, normal, area, step: body });
const connect = (a: any, b: any, mode: "auto" | "new" | "join" | "cut", extra: object = {}): Feature => ({ id: "cn", name: "Connect 01", type: "connect", faces: [a, b], mode, ...extra }) as Feature;

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
  return { errors, bad: bad.join(", "), ids: [...debugBodies().keys()] };
}

// Two 20 mm cubes 40 apart, facing each other.
const two = [...box("A", 20, 20, 20, [0, 0, 0]), ...box("B", 20, 20, 20, [60, 0, 0])];
const fA = face("A", [10, 0, 10], [1, 0, 0], 400);
const fB = face("B", [50, 0, 10], [-1, 0, 0], 400);
const cubes = 2 * 8000;

let r = await build([...two, connect(fA, fB, "new")]);
const vBridge = r.ids.includes("cn") ? vol("cn") : NaN;
check("New body: a bridge of its own between two cubes facing each other", !r.errors && !r.bad && r.ids.length === 3 && vBridge > 40 * 400 * 0.5, `${r.errors}${r.bad} ${r.ids} ${vBridge.toFixed(0)}`);
r = await build([...two, connect(fA, fB, "join")]);
check("Add: the two cubes and the bridge are one body", !r.errors && !r.bad && r.ids.length === 1 && vol("A") > cubes + vBridge * 0.6 && vol("A") < cubes + vBridge, `${r.errors}${r.bad} ${r.ids} ${r.ids[0] && vol(r.ids[0]).toFixed(0)}`);
r = await build([...two, connect(fA, fB, "auto")]);
check("Auto joins them too", !r.errors && !r.bad && r.ids.length === 1, `${r.errors}${r.bad} ${r.ids}`);
r = await build([...two, connect(fA, fB, "cut")]);
check("Cut: the bridge's ends are cut out of both cubes", !r.errors && !r.bad && r.ids.length === 2 && vol("A") < 8000 && vol("B") < 8000, `${r.errors}${r.bad} ${r.ids}`);

// Side by side, both faces up: the bridge leaves A upward and comes down into B (an arch).
{
  const up = [face("A", [0, 0, 20], [0, 0, 1], 400), face("B", [60, 0, 20], [0, 0, 1], 400)];
  r = await build([...two, connect(up[0], up[1], "join")]);
  const bb = (debugBodies().get("A") as Shape3D)?.boundingBox.bounds;
  check("both faces up: an arch from one top to the other, joined", !r.errors && !r.bad && r.ids.length === 1 && bb[1][2] > 30, `${r.errors}${r.bad} top at ${bb?.[1][2].toFixed(1)}`);
  r = await build([...two, connect(up[0], up[1], "join", { bulge: 0.3 })]);
  const bb2 = (debugBodies().get("A") as Shape3D)?.boundingBox.bounds;
  // (No lower than turning as tightly as the bridge is wide allows: a tighter turn would fold it.)
  check("…less Bend: no higher an arch, still made", !r.errors && !r.bad && bb2[1][2] <= bb[1][2] + 1, `${r.errors}${r.bad} ${bb2?.[1][2].toFixed(1)}`);
}

// Different shapes and sizes: a 20 × 30 face to a round end of a cylinder.
{
  const fs = [...box("A", 20, 30, 10, [0, 0, 0]), ...cyl("B", 6, 20, [50, 0, 45])];
  r = await build([...fs, connect(face("A", [0, 0, 10], [0, 0, 1], 600), face("B", [50, 0, 45], [0, 0, -1], Math.PI * 36), "join")]);
  check("a flat 20 × 30 top to a cylinder's round end above it", !r.errors && !r.bad && r.ids.length === 1, `${r.errors}${r.bad} ${r.ids}`);
}

// Two faces of one body: cut, a curved tunnel from the top to the front.
{
  const fs = box("A", 40, 40, 40, [0, 0, 0]);
  const top = face("A", [0, 0, 40], [0, 0, 1], 1600);
  const front = face("A", [0, -20, 20], [0, -1, 0], 1600);
  r = await build([...fs, connect(top, front, "cut", { size: 0.3 })]);
  check("one body, top to front, Cut: a curved tunnel through it", !r.errors && !r.bad && r.ids.length === 1 && vol("A") < 64000 - 100, `${r.errors}${r.bad} ${vol("A").toFixed(0)}`);
  r = await build([...fs, connect(top, front, "join", { size: 0.3 })]);
  check("…Add: a handle from the top round to the front", !r.errors && !r.bad && vol("A") > 64000 + 100, `${r.errors}${r.bad} ${vol("A").toFixed(0)}`);
  r = await build([...fs, connect(top, top, "join")]);
  check("the same face twice: refused, saying so", /two different faces/.test(r.errors), r.errors);
}

// A 3 mm plate: the end mustn't poke out of its back.
{
  const fs = [...box("A", 40, 40, 3, [0, 0, 0]), ...box("B", 20, 20, 20, [0, 0, 30])];
  r = await build([...fs, connect(face("A", [0, 0, 3], [0, 0, 1], 1600), face("B", [0, 0, 30], [0, 0, -1], 400), "join")]);
  const lo = (debugBodies().get("A") as Shape3D)?.boundingBox.bounds[0][2];
  check("a 3 mm plate joined to a cube above it: nothing pokes out under the plate", !r.errors && !r.bad && r.ids.length === 1 && lo > -1e-3, `${r.errors}${r.bad} bottom at ${lo?.toFixed(3)}`);
}

// The faces move (the cube made taller): the bridge follows.
{
  const tall = [...box("A", 20, 20, 30, [0, 0, 0]), ...box("B", 20, 20, 20, [60, 0, 0])];
  r = await build([...tall, connect(fA, fB, "join")]);
  check("cube A made taller after: the bridge still finds its face and follows", !r.errors && !r.bad && r.ids.length === 1, `${r.errors}${r.bad}`);
}

// Along a guide: a spline drawn in a sketch, the bridge follows it.
{
  // The front plane (XZ): sketch y is world z. A note: its normal is -Y.
  const front: PlaneDef = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, -1, 0] };
  const guide = (id: string, pts: [number, number][], plane = front): Feature => ({ id, name: id, type: "sketch", plane, entities: [{ id: "g", kind: "spline", points: pts, closed: false, mode: "fit" }] }) as Feature;
  const up = [face("A", [0, 0, 20], [0, 0, 1], 400), face("B", [60, 0, 20], [0, 0, 1], 400)];
  const arch = guide("g1", [[0, 20], [10, 45], [30, 55], [50, 45], [60, 20]]);
  r = await build([...two, arch, connect(up[0], up[1], "join", { guide: { kind: "sketch", sketch: "g1", entities: ["g"] } })]);
  const top = (debugBodies().get("A") as Shape3D)?.boundingBox.bounds[1][2];
  check("both tops up, along a high arch drawn as a spline: the bridge goes over it", !r.errors && !r.bad && r.ids.length === 1 && top > 55 && top < 70, `${r.errors}${r.bad} top at ${top?.toFixed(1)}`);
  // The same curve drawn the other way round.
  const back = guide("g1", [[60, 20], [50, 45], [30, 55], [10, 45], [0, 20]]);
  r = await build([...two, back, connect(up[0], up[1], "join", { guide: { kind: "sketch", sketch: "g1", entities: ["g"] } })]);
  const top2 = (debugBodies().get("A") as Shape3D)?.boundingBox.bounds[1][2];
  check("…the curve drawn from B to A: the same bridge", !r.errors && !r.bad && Math.abs(top2 - top) < 0.5, `${r.errors}${r.bad} top at ${top2?.toFixed(1)}`);
  // Ends a few mm off the faces' middles: pulled onto them.
  const loose = guide("g1", [[3, 23], [10, 45], [30, 55], [50, 45], [57, 22]]);
  r = await build([...two, loose, connect(up[0], up[1], "join", { guide: { kind: "sketch", sketch: "g1", entities: ["g"] } })]);
  check("…its ends a few mm off the faces: still joined", !r.errors && !r.bad && r.ids.length === 1, `${r.errors}${r.bad}`);
  // Cubes facing each other 90 apart, the bridge swinging out sideways (a guide on the ground plane).
  const ground: PlaneDef = { origin: [0, 0, 10], xDir: [1, 0, 0], normal: [0, 0, 1] };
  const far = [...box("A", 20, 20, 20, [0, 0, 0]), ...box("B", 20, 20, 20, [110, 0, 0])];
  const fB2 = face("B", [100, 0, 10], [-1, 0, 0], 400);
  const swing = guide("g2", [[10, 0], [30, 18], [55, 25], [80, 18], [100, 0]], ground);
  r = await build([...far, swing, connect(fA, fB2, "new", { guide: { kind: "sketch", sketch: "g2", entities: ["g"] } })]);
  const yMax = (debugBodies().get("cn") as Shape3D)?.boundingBox.bounds[1][1];
  check("facing cubes, the bridge swung out sideways along a curve on the ground", !r.errors && !r.bad && yMax > 25 && yMax < 40, `${r.errors}${r.bad} reaches y ${yMax?.toFixed(1)}`);
  r = await build([...far, swing, connect(fA, fB2, "cut", { guide: { kind: "sketch", sketch: "g2", entities: ["g"] } })]);
  check("…Cut along it", !r.errors && !r.bad && vol("A") < 8000 && vol("B") < 8000, `${r.errors}${r.bad}`);
}

process.exit(failed ? 1 : 0);
