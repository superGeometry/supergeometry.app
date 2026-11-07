// Run: npx tsx tests/offsetedge.test.ts - Offset Edge: a line on a flat face,
// parallel to a straight edge at a distance, from the face's outline to its
// outline (cut back where it would run past the face, carried on where it
// would stop short). Then the sketch it makes splits the face into two regions.
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { regenerate } from "../src/kernel/engine";
import type { BodyMesh } from "../src/kernel/protocol";
import { offsetLineOnFace, type OffsetLine } from "../src/tools/offsetEdgeGeom";
import { dot, len, sub } from "../src/geom";
import type { Vec3 } from "../src/doc/types";

setOC(await (opencascade as unknown as () => Promise<any>)());
let failed = 0;
const check = (name: string, ok: boolean, info = "") => {
  if (!ok) failed++;
  console.log(ok ? "ok  " : "FAIL", name, info);
};
const near = (a: number, b: number, e = 1e-6) => Math.abs(a - b) < e;
const f3 = (p: Vec3) => p.map((x) => x.toFixed(3)).join(", ");

// A 40 x 30 box, 20 high (top face at z = 20).
const XY = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] };
const box = (extra: any[] = [], ents: any[] = [{ id: "r", kind: "rect", center: [20, 15], w: 40, h: 30, rotation: 0 }]) => [
  { id: "sk", name: "Sketch 01", type: "sketch", plane: XY, entities: ents },
  { id: "body", name: "Extrude 01", type: "extrude", source: { kind: "profile", sketch: "sk", regions: [{ c: [20, 15], a: 1200 }] }, distance: 20, mode: "auto" },
  ...extra,
];
const faceBy = (b: BodyMesh, n: Vec3) => b.faces.findIndex((f) => f.type === "PLANE" && len(sub(f.normal, n)) < 1e-6);
const edgeBy = (b: BodyMesh, test: (e: BodyMesh["edges"][number]) => boolean) => b.edges.find(test)!;

{
  const r = await regenerate(box() as any);
  const b = r.bodies[0];
  const top = faceBy(b, [0, 0, 1]);
  // The top face's front edge (y = 0, z = 20, along X).
  const e = edgeBy(b, (x) => x.type === "LINE" && near(x.mid[1], 0) && near(x.mid[2], 20));
  const line = offsetLineOnFace(b, top, b.faces[top].plane!, e.start, e.end, 5) as OffsetLine;
  check("box top, front edge, 5 in: a line across the whole face", typeof line !== "string" && near(Math.abs(line.a[0] - line.b[0]), 40) && near(line.a[1], 5) && near(line.b[1], 5) && near(line.a[2], 20), typeof line === "string" ? line : `${f3(line.a)} → ${f3(line.b)}`);
  const far = offsetLineOnFace(b, top, b.faces[top].plane!, e.start, e.end, 31);
  check("…31 in (past the face): says so", typeof far === "string" && /misses/.test(far), String(far));
  // An edge not on the face, but along it: the bottom face's back edge, offset on the top face.
  const back = edgeBy(b, (x) => x.type === "LINE" && near(x.mid[1], 30) && near(x.mid[2], 0));
  const l2 = offsetLineOnFace(b, top, b.faces[top].plane!, back.start, back.end, 10) as OffsetLine;
  check("an edge of another face (below, along the face): 10 in from where it lies over the face", typeof l2 !== "string" && near(l2.a[1], 20) && near(Math.abs(l2.a[0] - l2.b[0]), 40), typeof l2 === "string" ? l2 : `${f3(l2.a)} → ${f3(l2.b)}`);
  // An upright edge on the top face: it doesn't run along it.
  const up = edgeBy(b, (x) => x.type === "LINE" && Math.abs(x.dir[2]) > 0.99);
  check("an upright edge on the top face: refused", typeof offsetLineOnFace(b, top, b.faces[top].plane!, up.start, up.end, 5) === "string");
  // A short edge whose line runs onto the side face: the side face (x = 40) with the top's front edge? No: the
  // side face (y = 0) with the top's front edge, 5 down: a line across the side face.
  const front = faceBy(b, [0, -1, 0]);
  const l3 = offsetLineOnFace(b, front, b.faces[front].plane!, e.start, e.end, 5) as OffsetLine;
  check("the front face with the same edge: 5 down from the top, across the face", typeof l3 !== "string" && near(l3.a[2], 15) && near(Math.abs(l3.a[0] - l3.b[0]), 40), typeof l3 === "string" ? l3 : `${f3(l3.a)} → ${f3(l3.b)}`);
}

// A round hole through the top, near the back: a line across it stops at the hole's rim on its own side.
{
  const hole = [
    { id: "sk2", name: "Sketch 02", type: "sketch", plane: { origin: [0, 0, 20], xDir: [1, 0, 0], normal: [0, 0, 1] }, entities: [{ id: "c", kind: "circle", center: [30, 20], radius: 4 }] },
    { id: "cut", name: "Extrude 02", type: "extrude", source: { kind: "profile", sketch: "sk2", regions: [{ c: [30, 20], a: Math.PI * 16 }] }, distance: -20, mode: "auto", target: "body" },
  ];
  const r = await regenerate(box(hole) as any);
  const b = r.bodies[0];
  const top = faceBy(b, [0, 0, 1]);
  const e = edgeBy(b, (x) => x.type === "LINE" && near(x.mid[1], 0) && near(x.mid[2], 20));
  const l = offsetLineOnFace(b, top, b.faces[top].plane!, e.start, e.end, 18) as OffsetLine;
  // At y = 18 the hole (centre 30, 20, r 4) spans x = 30 ± √12. The edge's middle (x = 20) is left of it.
  const xs = typeof l === "string" ? [] : [l.a[0], l.b[0]].sort((p, q) => p - q);
  check("across a hole: from the left side to the hole's rim, exactly on the circle", xs.length === 2 && near(xs[0], 0) && near(xs[1], 30 - Math.sqrt(12), 1e-6), typeof l === "string" ? l : `x ${xs.map((x) => x.toFixed(6)).join(" → ")}`);
}

// The made sketch splits the face: two regions to extrude.
{
  const r0 = await regenerate(box() as any);
  const b = r0.bodies[0];
  const top = faceBy(b, [0, 0, 1]);
  const e = edgeBy(b, (x) => x.type === "LINE" && near(x.mid[1], 0) && near(x.mid[2], 20));
  const pl = b.faces[top].plane!;
  const l = offsetLineOnFace(b, top, pl, e.start, e.end, 5) as OffsetLine;
  const f = b.faces[top];
  const sketch = { id: "off", name: "Offset Edge 01", type: "sketch", plane: pl, attachedTo: { body: "body", center: f.center, normal: f.normal, area: f.area }, entities: [{ id: "l", kind: "line", a: l.a2, b: l.b2 }] };
  const r = await regenerate(box([sketch]) as any);
  const { arrangement } = await import("../src/sketch/regions");
  const regions = arrangement([...(sketch.entities as any), ...(r.sketchBoundaries.off ?? [])]).regions;
  const areas = regions.map((x: any) => Math.abs(x.area)).sort((p: number, q: number) => p - q);
  check("the line splits the top face into a 40 x 5 strip and the rest", areas.length === 2 && near(areas[0], 200, 1e-3) && near(areas[1], 1000, 1e-3), areas.map((a: number) => a.toFixed(3)).join(", "));
  void dot;
}

console.log(failed ? `${failed} FAILED` : "all passed");
process.exit(failed ? 1 : 0);
