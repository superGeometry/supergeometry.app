// Run: npx tsx tests/curvedfaces.test.ts - a round side extruded from a sketch
// is one face, however the curve was split in the sketch (a line across the
// circle, both halves tapped; an arc drawn as two arcs; a line ending on it).
// Extra edges down a round side broke later unions and threads.
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { debugBodies, regenerate } from "../src/kernel/engine";
import { arrangement, regionRef } from "../src/sketch/regions";

setOC(await (opencascade as unknown as () => Promise<any>)());
let failed = 0;
const check = (name: string, ok: boolean, info = "") => {
  if (!ok) failed++;
  console.log(ok ? "ok  " : "FAIL", name, info);
};

const XY = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] };
const R = 10;
const at = (deg: number) => [R * Math.cos((deg * Math.PI) / 180), R * Math.sin((deg * Math.PI) / 180)];

/** Extrude every closed shape of the sketch (or those `pick` keeps); the round faces it has. */
async function roundFaces(entities: any[], pick: (r: any) => boolean = () => true, extra: any[] = []) {
  const regions = arrangement(entities).regions.filter(pick);
  const feats: any[] = [
    ...extra,
    { id: "s", name: "S", type: "sketch", plane: XY, entities },
    { id: "e", name: "E", type: "extrude", source: { kind: "profile", sketch: "s", regions: regions.map(regionRef) }, distance: 20, mode: extra.length ? "join" : "new", target: extra.length ? "box" : undefined },
  ];
  const r: any = await regenerate(feats);
  if (r.errors.length) return { n: -1, info: r.errors.map((e: any) => e.message).join("; ") };
  const body = debugBodies().get(extra.length ? "box" : "e")!;
  const round = body.faces.filter((f) => f.geomType !== "PLANE");
  return { n: round.length, info: `${round.length} round faces (${round.map((f) => f.geomType).join(",")}), ${body.faces.length} faces, ${regions.length} shapes` };
}

{
  // A circle with a line across it: both halves extruded together.
  const r = await roundFaces([
    { id: "c", kind: "circle", center: [0, 0], radius: R },
    { id: "l", kind: "line", a: [-R, 0], b: [R, 0] },
  ]);
  check("circle split by a line, both halves: one round face", r.n === 1, r.info);
}
{
  // A line crossing the circle and running past it: just the circle's two inside parts.
  const ents = [
    { id: "c", kind: "circle", center: [0, 0], radius: R },
    { id: "l", kind: "line", a: [-2 * R, 3], b: [2 * R, 3] },
  ];
  const r = await roundFaces(ents, (g) => Math.abs(g.area) < Math.PI * R * R + 1);
  check("circle crossed by a longer line, both parts: one round face", r.n === 1, r.info);
}
{
  // A D: half circle drawn as two arcs, closed by a line.
  const r = await roundFaces([
    { id: "a1", kind: "arc", a: at(0), m: at(45), b: at(90) },
    { id: "a2", kind: "arc", a: at(90), m: at(135), b: at(180) },
    { id: "l", kind: "line", a: at(180), b: at(0) },
  ]);
  check("half circle drawn as two arcs: one round face", r.n === 1, r.info);
}
{
  // A D whose arc has another line ending on it from outside.
  const r = await roundFaces(
    [
      { id: "a1", kind: "arc", a: at(0), m: at(90), b: at(180) },
      { id: "l", kind: "line", a: at(180), b: at(0) },
      { id: "x", kind: "line", a: at(60), b: [R * 2, R * 2] },
    ],
    (g) => g.area > 0 && g.area < (Math.PI * R * R) / 2 + 1,
  );
  check("arc with a line ending on it: one round face", r.n === 1, r.info);
}
{
  // Joined onto a box it stands on: still one round face.
  const box = [
    { id: "bs", name: "B", type: "sketch", plane: { origin: [0, 0, -5], xDir: [1, 0, 0], normal: [0, 0, 1] }, entities: [{ id: "r", kind: "rect", center: [0, 0], w: 40, h: 40, rotation: 0 }] },
    { id: "box", name: "Box", type: "extrude", source: { kind: "profile", sketch: "bs", regions: [regionRef(arrangement([{ id: "r", kind: "rect", center: [0, 0], w: 40, h: 40, rotation: 0 }] as any).regions[0])] }, distance: 5, mode: "new" },
  ];
  const r = await roundFaces(
    [
      { id: "c", kind: "circle", center: [0, 0], radius: R },
      { id: "l", kind: "line", a: [-R, 0], b: [R, 0] },
    ],
    () => true,
    box,
  );
  check("split circle joined onto a box: one round face", r.n === 1, r.info);
}

{
  // A rod drawn as two half circles: it takes a thread.
  const ents = [
    { id: "a1", kind: "arc", a: [5, 0], m: [0, 5], b: [-5, 0] },
    { id: "a2", kind: "arc", a: [-5, 0], m: [0, -5], b: [5, 0] },
  ];
  const regions = arrangement(ents as any).regions.filter((g: any) => g.area > 0 && g.area < 100);
  const rod: any[] = [
    { id: "s", name: "S", type: "sketch", plane: XY, entities: ents },
    { id: "b", name: "Rod", type: "extrude", source: { kind: "profile", sketch: "s", regions: regions.map(regionRef) }, distance: 30, mode: "new" },
  ];
  const r0: any = await regenerate(rod);
  const side = r0.bodies[0]?.faces.filter((f: any) => f.type === "CYLINDRE") ?? [];
  const r1: any = side.length === 1 ? await regenerate([...rod, { id: "t", name: "Thread", type: "thread", face: { body: "b", center: side[0].center, normal: side[0].normal, area: side[0].area }, pitch: 1.5 }]) : { errors: [{ message: `${side.length} round faces` }] };
  check("rod drawn as two half circles takes a thread", !r1.errors.length, r1.errors.map((e: any) => e.message).join("; "));
}
{
  // A closed spline with a line ending on it from outside.
  const pts = [[10, 0], [0, 8], [-10, 0], [0, -6]];
  const sp = { id: "s1", kind: "spline", points: pts, closed: true, mode: "fit" };
  const probe = arrangement([sp] as any).prims[0] as any;
  const on = probe.pts[Math.floor(probe.pts.length / 3)];
  const r = await roundFaces([sp, { id: "x", kind: "line", a: on, b: [on[0] + 20, on[1] + 20] }], (g) => g.area > 0);
  check("closed spline with a line ending on it: one curved face", r.n === 1, r.info);
}
{
  // An open spline closed by a line, with another line ending on the spline.
  const sp = { id: "s1", kind: "spline", points: [[-10, 0], [-5, 7], [3, 9], [10, 0]], closed: false, mode: "fit" };
  const probe = arrangement([sp] as any).prims[0] as any;
  const on = probe.pts[Math.floor(probe.pts.length / 2)];
  const r = await roundFaces([sp, { id: "l", kind: "line", a: [10, 0], b: [-10, 0] }, { id: "x", kind: "line", a: on, b: [on[0], on[1] + 20] }], (g) => g.area > 0);
  check("open spline with a line ending on it: one curved face", r.n === 1, r.info);
}

process.exit(failed ? 1 : 0);
