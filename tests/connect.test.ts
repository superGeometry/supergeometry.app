// Run: npx tsx tests/connect.test.ts
// Connect: a freeform bridge between two picked faces, joined (Add / Auto),
// cut (Cut) or a body of its own (New body) - between two boxes facing each
// other, side by side (the bridge bends round), different sizes and shapes,
// two faces of one body (a curved tunnel when cut), a thin plate.
import opencascade from "replicad-opencascadejs";
import { getOC, makeBox, measureVolume, setOC, type Shape3D } from "replicad";
import { debugBodies, regenerate, shapeValid } from "../src/kernel/engine";
import { arrangement, regionRef } from "../src/sketch/regions";
import { arcSpine, gentle } from "../src/freeform/connect";
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
  // It leaves the face from its edges: a slice just above it is the whole
  // 20 × 30 (it was 19.5 × 28.9 - already part way to the round end there).
  for (const mode of ["join", "new"] as const) {
    r = await build([...fs, connect(face("A", [0, 0, 10], [0, 0, 1], 600), face("B", [50, 0, 45], [0, 0, -1], Math.PI * 36), mode)]);
    const body = debugBodies().get(mode === "new" ? "cn" : "A") as Shape3D;
    const [lo, hi] = body.intersect(makeBox([-100, -100, 10.01], [100, 100, 10.05])).boundingBox.bounds;
    const off = Math.max(Math.abs(lo[0] + 10), Math.abs(hi[0] - 10), Math.abs(lo[1] + 15), Math.abs(hi[1] - 15));
    check(`…${mode}: the bridge starts on the face's edges, not inside them`, !r.errors && !r.bad && off < 0.02, `${r.errors}${r.bad} ${lo[0].toFixed(2)}..${hi[0].toFixed(2)} × ${lo[1].toFixed(2)}..${hi[1].toFixed(2)}`);
  }
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

// A guide with a corner too tight for the bridge (drawn by hand, out of one
// face and down onto another): rounded off just enough, still joined - and
// the guide edited, the bridge follows it.
{
  const fs = [...box("A", 40, 30, 20, [0, 0, 0]), ...box("B", 40, 30, 20, [0, 66, 65])];
  const side: PlaneDef = { origin: [20, 0, 0], xDir: [0, 1, 0], normal: [1, 0, 0] };
  const g = (pts: [number, number][]) => ({ id: "g", name: "g", type: "sketch", plane: side, entities: [{ id: "s", kind: "spline", points: pts, closed: false, mode: "fit" }] }) as Feature;
  const ends = [face("B", [0, 51, 75], [0, -1, 0], 800), face("A", [0, 0, 20], [0, 0, 1], 1200)];
  const along = { guide: { kind: "sketch", sketch: "g", entities: ["s"] } };
  r = await build([...fs, g([[51, 75], [1, 78], [0, 20]]), connect(ends[0], ends[1], "auto", along)]);
  const yLo = (debugBodies().get("B") as Shape3D)?.boundingBox.bounds[0][1];
  check("a guide with a corner tighter than the bridge is wide: rounded off, joined", !r.errors && !r.bad && r.ids.length === 1, `${r.errors}${r.bad} ${r.ids}`);
  r = await build([...fs, g([[51, 75], [-25, 70], [0, 20]]), connect(ends[0], ends[1], "auto", along)]);
  const yLo2 = (debugBodies().get("B") as Shape3D)?.boundingBox.bounds[0][1];
  check("...the guide edited to swing out further: the bridge goes with it", !r.errors && !r.bad && yLo2 < yLo - 5, `${r.errors}${r.bad} reaches y ${yLo?.toFixed(1)} then ${yLo2?.toFixed(1)}`);
}

// Outlines that don't pair up: a square top to an L-shaped top beside it
// (four sides to six, one of them an inward corner), and to a triangle.
{
  const poly = (id: string, points: [number, number][], h: number): Feature[] => {
    const es = [{ id: "p", kind: "polyline", points, closed: true }];
    return [
      { id: `s${id}`, name: `s${id}`, type: "sketch", plane: plane(0), entities: es } as Feature,
      { id, name: id, type: "extrude", source: { kind: "profile", sketch: `s${id}`, regions: arrangement(es as any).regions.map(regionRef) }, distance: h, mode: "new" } as Feature,
    ];
  };
  const top = (id: string) => {
    const s = debugBodies().get(id) as Shape3D;
    const f = s.faces.find((x) => x.normalAt().z > 0.99)!;
    const c = f.center;
    return face(id, [c.x, c.y, c.z], [0, 0, 1], 0);
  };
  for (const [name, pts] of [["an L", [[0, 50], [40, 50], [40, 65], [15, 65], [15, 90], [0, 90]]], ["a triangle", [[0, 50], [30, 50], [10, 80]]]] as [string, [number, number][]][]) {
    const fs = [...box("A", 20, 20, 20, [60, 0, 0]), ...poly("B", pts, 10)];
    await build(fs);
    const [ta, tb] = [top("A"), top("B")];
    r = await build([...fs, connect({ ...ta, area: 400 }, { ...tb, area: 300 }, "join")]);
    check(`a square top to ${name}-shaped top, no guide: joined`, !r.errors && !r.bad && r.ids.length === 1, `${r.errors}${r.bad} ${r.ids}`);
  }
}

// Many outlines, joined and cut, a face above a face: each one sound body
// (the bridge from the faces' very edges where that joins; else the other way).
{
  const ext = (id: string, es: any[], h: number, z: number): Feature[] => [
    { id: `s${id}`, name: `s${id}`, type: "sketch", plane: plane(z), entities: es } as Feature,
    { id, name: id, type: "extrude", source: { kind: "profile", sketch: `s${id}`, regions: arrangement(es as any).regions.map(regionRef) }, distance: h, mode: "new" } as Feature,
  ];
  const ngon = (n: number, r: number, cx: number, turn = 0) => ({ id: "p", kind: "polyline", closed: true, points: Array.from({ length: n }, (_, i) => [cx + r * Math.cos(turn + (i * 2 * Math.PI) / n), r * Math.sin(turn + (i * 2 * Math.PI) / n)]) });
  const shapes: [string, (cx: number) => any][] = [
    ["a triangle", (cx) => ({ id: "p", kind: "polyline", closed: true, points: [[cx, -10], [cx + 30, -10], [cx + 10, 20]] })],
    ["a hexagon", (cx) => ngon(6, 12, cx)],
    ["a square turned 30°", (cx) => ngon(4, 14, cx, Math.PI / 6)],
    ["a circle", (cx) => ({ id: "c", kind: "circle", center: [cx, 0], radius: 9 })],
    ["a 30 × 8 strip", (cx) => ({ id: "r", kind: "rect", center: [cx, 0], w: 30, h: 8, rotation: 0 })],
  ];
  const topOf = (id: string, up: boolean) => {
    const f = (debugBodies().get(id) as Shape3D).faces.find((x) => (up ? x.normalAt().z > 0.99 : x.normalAt().z < -0.99))!;
    return face(id, [f.center.x, f.center.y, f.center.z], [0, 0, up ? 1 : -1], 0);
  };
  for (const [na, A] of shapes)
    for (const [nb, B] of shapes) {
      const fs = [...ext("A", [A(0)], 10, 0), ...ext("B", [B(45)], 15, 50)];
      await build(fs);
      const [ta, tb] = [topOf("A", true), topOf("B", false)];
      for (const mode of ["join", "cut"] as const) {
        r = await build([...fs, connect(ta, tb, mode)]);
        const sound = !r.errors && !r.bad && r.ids.length === (mode === "join" ? 1 : 2);
        check(`${na} up to ${nb}, ${mode}`, sound, `${r.errors}${r.bad} ${r.ids}`);
      }
      // As a body of its own it only touches the two it joins: turning tighter
      // than it is wide, its inner side ran back down into the body it left
      // (folded through itself - hidden once joined, but no sound solid).
      r = await build([...fs, connect(ta, tb, "new")]);
      const [A0, B0, br] = ["A", "B", "cn"].map((k) => debugBodies().get(k) as Shape3D);
      const into = br ? [A0, B0].map((x) => Math.abs(measureVolume(br.intersect(x as any) as Shape3D))) : [NaN];
      const whole = br ? Math.abs(measureVolume(br)) : NaN;
      check(`${na} up to ${nb}, a body of its own: reaches into neither body`, !r.errors && !r.bad && Math.max(...into) < whole * 1e-4, `${r.errors}${r.bad} ${into.map((v) => v.toFixed(2))} of ${whole.toFixed(0)}`);
    }
}

// Two wide plates close together, one a little to the side of the other: no
// bridge that turns with its curve fits between them (it would have to turn
// tighter than it is wide). Its outline slides along the curve instead.
{
  const fs = [...box("A", 100, 100, 10, [0, 0, 0]), ...box("B", 100, 100, 10, [5, 0, 30])];
  const ends = [face("A", [0, 0, 10], [0, 0, 1], 10000), face("B", [5, 0, 30], [0, 0, -1], 10000)];
  r = await build([...fs, connect(ends[0], ends[1], "new")]);
  const own = r.ids.includes("cn") ? vol("cn") : NaN;
  // (Sliding: the area times the way up, whatever the way sideways.)
  check("two wide plates 20 apart, 5 to the side: a bridge of its own, 100 x 100 all the way", !r.errors && !r.bad && Math.abs(own - 200000) < 200, `${r.errors}${r.bad} ${own.toFixed(0)}`);
  r = await build([...fs, connect(ends[0], ends[1], "join")]);
  check("...joined: one body, the plates and what's between", !r.errors && !r.bad && r.ids.length === 1 && Math.abs(vol("A") - 400000) < 400, `${r.errors}${r.bad} ${r.ids} ${r.ids[0] && vol(r.ids[0]).toFixed(0)}`);
  r = await build([...fs, connect(ends[0], ends[1], "cut", { size: 0.5 })]);
  check("...cut at half size: a pocket in each plate", !r.errors && !r.bad && r.ids.length === 2 && vol("A") < 100000 - 1000 && vol("B") < 100000 - 1000, `${r.errors}${r.bad} ${r.ids}`);
  // Further to the side, and the upper plate leaning 10 degrees: still joined.
  const lean = (10 * Math.PI) / 180;
  const n: Vec3 = [Math.sin(lean), 0, Math.cos(lean)];
  const es = [{ id: "r", kind: "rect", center: [0, 0], w: 60, h: 60, rotation: 0 }];
  const leaning: Feature[] = [
    ...box("A", 60, 60, 10, [0, 0, 0]),
    { id: "sB", name: "sB", type: "sketch", plane: { origin: [15, 0, 40], xDir: [Math.cos(lean), 0, -Math.sin(lean)], normal: n }, entities: es } as Feature,
    { id: "B", name: "B", type: "extrude", source: { kind: "profile", sketch: "sB", regions: arrangement(es as any).regions.map(regionRef) }, distance: 10, mode: "new" } as Feature,
  ];
  r = await build([...leaning, connect(face("A", [0, 0, 10], [0, 0, 1], 3600), face("B", [15, 0, 40], [-n[0], 0, -n[2]], 3600), "join")]);
  check("a 60 x 60 top to a plate above it, 15 to the side and leaning 10 degrees: joined", !r.errors && !r.bad && r.ids.length === 1 && vol("A") > 72000 + 3600 * 25, `${r.errors}${r.bad} ${r.ids} ${r.ids[0] && vol(r.ids[0]).toFixed(0)}`);
}

// The two-arc curve: from one middle to the other, leaving and arriving
// square, and turning as little as can be (two faces 40 up and 45 across:
// arcs of 20.1 mm, where the plain curve turns in 13.4).
{
  const c = arcSpine([0, 0, 0], [0, 0, 1], [45, 0, 40], [0, 0, -1])!;
  const d = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const dir = (t: number) => { const [p, q] = [c(t - 1e-5), c(t + 1e-5)]; const L = d(p, q); return [(q[0] - p[0]) / L, (q[1] - p[1]) / L, (q[2] - p[2]) / L]; };
  const [t0, t1, tm] = [dir(1e-5), dir(1 - 1e-5), dir(0.5)];
  check("two arcs: from A's middle to B's, straight out of one and straight into the other", d(c(0), [0, 0, 0]) < 1e-9 && d(c(1), [45, 0, 40]) < 1e-9 && t0[2] > 0.99999 && t1[2] > 0.99999, `${c(0)} ${c(1)} ${t0} ${t1}`);
  // Each arc's radius from three points on it.
  const radius = (ta: number, tb: number, tc: number) => { const [A, B, C] = [c(ta), c(tb), c(tc)]; const [a, b, cc] = [d(B, C), d(A, C), d(A, B)]; const s = (a + b + cc) / 2; return (a * b * cc) / (4 * Math.sqrt(Math.max(1e-18, s * (s - a) * (s - b) * (s - cc)))); };
  const [r1, r2] = [radius(0.05, 0.25, 0.45), radius(0.55, 0.75, 0.95)];
  check("...each arc turns in 20.1 mm, and they meet going the same way", Math.abs(r1 - 20.139) < 0.01 && Math.abs(r2 - 20.139) < 0.01 && Math.abs(tm[0] - 0.9931) < 0.01, `${r1.toFixed(3)} ${r2.toFixed(3)} ${tm.map((x) => x.toFixed(4))}`);
  // An outline 16.67 wide towards the turn fits the arcs (20.1 > 1.1 x 16.67), one 19 wide doesn't.
  const ring = (w: number): Vec3[] => [[w, -10, 0], [w - 30, -10, 0], [w - 20, 20, 0]];
  check("...a triangle reaching 16.7 towards the turn fits them; one reaching 19 would fold", gentle(c, { a: ring(16.67), b: ring(16.67) }) && !gentle(c, { a: ring(19), b: ring(19) }));
  // An arch (both faces up): the outline is checked as the curve has turned it - at the top, its side towards the other face.
  const arch = arcSpine([0, 0, 0], [0, 0, 1], [30, 0, 0], [0, 0, 1])!;
  const wide = (w: number): Vec3[] => [[w, -5, 0], [-w, -5, 0], [-w, 5, 0], [w, 5, 0]];
  check("...an arch 30 across (a half circle of 15): 13 wide each way fits, 14 doesn't", gentle(arch, { a: wide(13), b: wide(13) }) && !gentle(arch, { a: wide(14), b: wide(14) }));
  check("...none where B is straight behind A", arcSpine([0, 0, 0], [0, 0, 1], [0, 0, -10], [0, 0, -1]) === null);
}

process.exit(failed ? 1 : 0);
