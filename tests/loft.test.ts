// Run: npx tsx tests/loft.test.ts - lofts in many arrangements, and a spline revolve.
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import type { ExtrudeSource, Feature, PlaneDef } from "../src/doc/types";
import { regenerate } from "../src/kernel/engine";
import type { BodyMesh } from "../src/kernel/protocol";
import { arrangement, regionRef } from "../src/sketch/regions";

setOC(await (opencascade as unknown as () => Promise<any>)());

const plane = (z: number, flip = false): PlaneDef => ({ origin: [0, 0, z], xDir: [1, 0, 0], normal: flip ? [0, 0, -1] : [0, 0, 1] });
const XZ: PlaneDef = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, -1, 0] };
const sketch = (id: string, p: PlaneDef, entities: any[]): Feature => ({ id, name: id, type: "sketch", plane: p, entities });
const prof = (id: string, entities: any[]): ExtrudeSource => ({ kind: "profile", sketch: id, regions: arrangement(entities).regions.map(regionRef) });
const loft = (sections: ExtrudeSource[], ruled = false): Feature => ({ id: "lo", name: "Loft", type: "loft", sections, ruled, mode: "new" });

const rect = (w: number, h: number, rot = 0) => [{ id: "r", kind: "rect", center: [0, 0], w, h, rotation: rot }];
const circle = (r: number, c: [number, number] = [0, 0]) => [{ id: "c", kind: "circle", center: c, radius: r }];
const hexagon = [{ id: "h", kind: "polygon", center: [0, 0], radius: 10, sides: 6, angle: 0.3 }];
const blob = [{ id: "s", kind: "spline", points: [[10, 0], [4, 8], [-9, 5], [-7, -6], [3, -9]], closed: true, mode: "fit" }];

function volume(b: BodyMesh): number {
  const p = b.positions;
  const ix = b.indices;
  let v = 0;
  for (let i = 0; i < ix.length; i += 3) {
    const [a, c, d] = [ix[i] * 3, ix[i + 1] * 3, ix[i + 2] * 3];
    v += (p[a] * (p[c + 1] * p[d + 2] - p[c + 2] * p[d + 1]) - p[a + 1] * (p[c] * p[d + 2] - p[c + 2] * p[d]) + p[a + 2] * (p[c] * p[d + 1] - p[c + 1] * p[d])) / 6;
  }
  return v;
}

let failed = 0;
async function check(name: string, feats: Feature[], lo: number, hi: number): Promise<void> {
  const r = await regenerate(feats);
  const b = r.bodies.find((x) => x.id === "lo" || x.id === "rv") ?? r.bodies[r.bodies.length - 1];
  const v = b ? volume(b) : NaN;
  const ok = !r.errors.length && !!b && b.openEdges.length === 0 && v > lo && v < hi;
  if (!ok) failed++;
  console.log(ok ? "ok  " : "FAIL", name, `vol=${v.toFixed(0)} (${lo}..${hi}) faces=${b?.faces.length} open=${b?.openEdges.length}`, r.errors.map((e) => e.message).join("; "));
}

// Prism-like bounds: between the smaller and the larger section × height.
await check("rect → circle", [sketch("a", plane(0), rect(40, 20)), sketch("b", plane(30), circle(8)), loft([prof("a", rect(40, 20)), prof("b", circle(8))])], 200 * 30, 800 * 30);
await check("circle → circle, shifted sideways", [sketch("a", plane(0), circle(10)), sketch("b", plane(30), circle(5, [15, 0])), loft([prof("a", circle(10)), prof("b", circle(5, [15, 0]))])], 78 * 30, 315 * 30);
await check("rect → rect turned 45°", [sketch("a", plane(0), rect(20, 20)), sketch("b", plane(30), rect(20, 20, Math.PI / 4)), loft([prof("a", rect(20, 20)), prof("b", rect(20, 20, Math.PI / 4))])], 300 * 30, 400 * 30 + 1);
await check("three sections rect → circle → rect", [sketch("a", plane(0), rect(30, 30)), sketch("b", plane(20), circle(8)), sketch("c", plane(40), rect(30, 30)), loft([prof("a", rect(30, 30)), prof("b", circle(8)), prof("c", rect(30, 30))])], 200 * 40, 900 * 40);
await check("picked top first", [sketch("a", plane(0), rect(40, 20)), sketch("b", plane(30), circle(8)), loft([prof("b", circle(8)), prof("a", rect(40, 20))])], 200 * 30, 800 * 30);
await check("middle picked last (out of order)", [sketch("a", plane(0), rect(30, 30)), sketch("b", plane(20), circle(8)), sketch("c", plane(40), rect(30, 30)), loft([prof("a", rect(30, 30)), prof("c", rect(30, 30)), prof("b", circle(8))])], 200 * 40, 900 * 40);
await check("plane facing down (reversed wire)", [sketch("a", plane(0), rect(40, 20)), sketch("b", plane(30, true), circle(8)), loft([prof("a", rect(40, 20)), prof("b", circle(8))])], 200 * 30, 800 * 30);
await check("hexagon → circle", [sketch("a", plane(0), hexagon), sketch("b", plane(25), circle(6)), loft([prof("a", hexagon), prof("b", circle(6))])], 113 * 25, 260 * 25);
await check("spline blob → circle", [sketch("a", plane(0), blob), sketch("b", plane(25), circle(5)), loft([prof("a", blob), prof("b", circle(5))])], 78 * 25, 400 * 25);
await check("ruled rect → smaller rect", [sketch("a", plane(0), rect(30, 30)), sketch("b", plane(20), rect(10, 10)), loft([prof("a", rect(30, 30)), prof("b", rect(10, 10))], true)], 100 * 20, 900 * 20);
await check("box top face → circle", [
  sketch("a", plane(0), rect(30, 30)),
  { id: "e", name: "Extrude", type: "extrude", source: prof("a", rect(30, 30)), distance: 10, mode: "new" },
  sketch("b", plane(40), circle(6)),
  { id: "lo", name: "Loft", type: "loft", sections: [{ kind: "face", face: { body: "e", center: [0, 0, 10], normal: [0, 0, 1], area: 900 } }, prof("b", circle(6))], ruled: false, mode: "new" },
], 113 * 30, 900 * 30);
await check("tilted planes (not parallel)", [sketch("a", plane(0), rect(20, 20)), sketch("b", { origin: [0, 0, 30], xDir: [1, 0, 0], normal: [0, Math.sin(0.4), Math.cos(0.4)] }, circle(8)), loft([prof("a", rect(20, 20)), prof("b", circle(8))])], 200 * 25, 400 * 35);

// A vase: spline side + straight bottom, top and axis, turned about Z.
const vase = [
  { id: "sp", kind: "spline", points: [[10, 0], [14, 10], [8, 25], [12, 40]], closed: false, mode: "fit" },
  { id: "t", kind: "line", a: [12, 40], b: [0, 40] },
  { id: "ax", kind: "line", a: [0, 40], b: [0, 0] },
  { id: "bt", kind: "line", a: [0, 0], b: [10, 0] },
];
{
  const feats: Feature[] = [sketch("v", XZ, vase), { id: "rv", name: "Revolve", type: "revolve", source: prof("v", vase), axis: { origin: [0, 0, 0], dir: [0, 0, 1] }, angle: 360, mode: "new" }];
  await check("spline vase revolve", feats, Math.PI * 8 * 8 * 40, Math.PI * 14 * 14 * 40);
  // The spline side is one smooth face (not a stack of strips from a fitted curve).
  const r = await regenerate(feats);
  const side = r.bodies[0].faces.filter((f) => f.type !== "PLANE").length;
  const ok = side === 1;
  if (!ok) failed++;
  console.log(ok ? "ok  " : "FAIL", "vase side is one face:", side);
}

// A thread: a small triangle turned 5 times while moving 10 along the axis (pitch 2).
{
  const tri = [{ id: "tr", kind: "polyline", closed: true, points: [[10, 0], [11.2, 0.7], [10, 1.4]] }];
  const area = (1.2 * 1.4) / 2;
  const ideal = area * 2 * Math.PI * 10.4 * 5;
  await check("thread: 5 turns, travel 10", [sketch("t", XZ, tri), { id: "rv", name: "Revolve", type: "revolve", source: prof("t", tri), axis: { origin: [0, 0, 0], dir: [0, 0, 1] }, angle: 1800, travel: 10, mode: "new" } as Feature], ideal * 0.9, ideal * 1.1);
  // A spring the other way round (negative travel).
  const disc = [{ id: "d", kind: "circle", center: [15, 0], radius: 1 }];
  const ideal2 = Math.PI * 2 * Math.PI * 15 * 3;
  await check("spring: 3 turns, travel -12", [sketch("t", XZ, disc), { id: "rv", name: "Revolve", type: "revolve", source: prof("t", disc), axis: { origin: [0, 0, 0], dir: [0, 0, 1] }, angle: 1080, travel: -12, mode: "new" } as Feature], ideal2 * 0.9, ideal2 * 1.1);
}

process.exit(failed ? 1 : 0);
