// Run: npx tsx tests/filletedit.test.ts — moving faces next to big fillets keeps the fillets
// (no tunnels carved through the body by an extended fillet cylinder).
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import type { Feature, PlaneDef } from "../src/doc/types";
import { regenerate } from "../src/kernel/engine";
import type { BodyMesh } from "../src/kernel/protocol";
import { arrangement, regionRef } from "../src/sketch/regions";

setOC(await (opencascade as unknown as () => Promise<any>)());

const XY: PlaneDef = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] };
const rect = [{ id: "r", kind: "rect", center: [0, 0], w: 40, h: 30, rotation: 0 }];
const R = 8;
const base: Feature[] = [
  { id: "s", name: "s", type: "sketch", plane: XY, entities: rect as any },
  { id: "b", name: "b", type: "extrude", source: { kind: "profile", sketch: "s", regions: arrangement(rect as any).regions.map(regionRef) }, distance: 20, mode: "new" },
  // A big fillet along the top back edge.
  { id: "f", name: "f", type: "fillet", edges: [{ body: "b", mid: [0, 15, 20], dir: [1, 0, 0], length: 40 }], radius: R },
];
const corner = R * R * (1 - Math.PI / 4); // material a fillet takes off, per unit length

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
async function check(name: string, extra: Feature[], expected: number, cylinders = 1): Promise<void> {
  const r = await regenerate([...base, ...extra]);
  const b = r.bodies[0];
  const v = b ? volume(b) : NaN;
  const cyl = b ? b.faces.filter((f) => f.type !== "PLANE").length : -1;
  const ok = !r.errors.length && (Number.isNaN(expected) ? v > 20000 && v < 30000 : Math.abs(v - expected) < expected * 0.005) && cyl === cylinders && b.openEdges.length === 0;
  if (!ok) failed++;
  console.log(ok ? "ok  " : "FAIL", name, `vol ${v.toFixed(1)} (want ${expected.toFixed(1)}), round faces ${cyl}`, r.errors.map((e) => e.message).join("; "));
}

const faceRef = async (pick: (f: { center: number[]; normal: number[] }) => boolean) => {
  const r = await regenerate(base);
  const f = r.bodies[0].faces.find(pick)!;
  return { body: "b", center: f.center, normal: f.normal, area: f.area } as any;
};
const offset = (id: string, face: any, d: number): Feature => ({ id, name: id, type: "extrude", source: { kind: "face", face }, distance: d, mode: "auto", target: "b" } as Feature);

await check("filleted box as built", [], 24000 - 40 * corner);
const top = await faceRef((f) => f.normal[2] > 0.99);
await check("top face (fillet runs into it) up 5", [offset("o1", top, 5)], 40 * 30 * 25 - 40 * corner);
await check("top face down 4", [offset("o1", top, -4)], 40 * 30 * 16 - 40 * corner);
const side = await faceRef((f) => f.normal[0] > 0.99);
await check("side face (fillet ends on it) out 5", [offset("o2", side, 5)], 45 * 30 * 20 - 45 * corner);
await check("side face in 6", [offset("o2", side, -6)], 34 * 30 * 20 - 34 * corner);
const back = await faceRef((f) => f.normal[1] > 0.99);
await check("back face (fillet runs into it) out 3", [offset("o3", back, 3)], 40 * 33 * 20 - 40 * corner);
const front = await faceRef((f) => f.normal[1] < -0.99);
await check("front face (no fillet) out 5", [offset("o4", front, 5)], 40 * 35 * 20 - 40 * corner);

// A corner next to the fillet, pulled up: the faces around it tilt, the fillet stays one round face.
await check("front-right-top corner up 4", [{ id: "mv", name: "mv", type: "moveFace", vertex: { body: "b", at: [20, -15, 20] }, translate: [0, 0, 4] } as Feature], NaN);
await check("edge next to it (front top) up 3", [{ id: "me", name: "me", type: "moveFace", edge: { body: "b", mid: [0, -15, 20], dir: [1, 0, 0], length: 40 }, translate: [0, 0, 3] } as Feature], NaN);

process.exit(failed ? 1 : 0);
