// Run: npx tsx tests/shell.test.ts - Shell on shapes with many faces.
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import type { Feature, PlaneDef } from "../src/doc/types";
import { regenerate } from "../src/kernel/engine";
import type { BodyMesh } from "../src/kernel/protocol";
import { arrangement, regionRef } from "../src/sketch/regions";

setOC(await (opencascade as unknown as () => Promise<any>)());

const XY: PlaneDef = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] };
const sketch = (id: string, entities: any[], p = XY): Feature => ({ id, name: id, type: "sketch", plane: p, entities });
const extrude = (id: string, sk: string, entities: any[], d: number, mode: "new" | "auto" = "new"): Feature => ({ id, name: id, type: "extrude", source: { kind: "profile", sketch: sk, regions: arrangement(entities).regions.map(regionRef) }, distance: d, mode });

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
/** Shell the body's top-most face and check it hollowed (volume went well down) and stayed closed. */
async function check(name: string, feats: Feature[], body: string, t = 1): Promise<void> {
  const r0 = await regenerate(feats);
  const b0 = r0.bodies.find((b) => b.id === body)!;
  // The biggest upward face (the lid you'd open).
  const top = b0.faces.reduce((bi, f, i) => (f.normal[2] > 0.99 && (b0.faces[bi].normal[2] <= 0.99 || f.area > b0.faces[bi].area) ? i : bi), 0);
  const f = b0.faces[top];
  const r = await regenerate([...feats, { id: "sh", name: "Shell", type: "shell", body, faces: [{ body, center: f.center, normal: f.normal, area: f.area }], thickness: t }]);
  const b = r.bodies.find((x) => x.id === body);
  const v0 = volume(b0);
  const v = b ? volume(b) : NaN;
  const ok = !r.errors.length && !!b && v < v0 * 0.8 && v > 0 && b.openEdges.length === 0;
  if (!ok) failed++;
  console.log(ok ? "ok  " : "FAIL", name, `${b0.faces.length} faces, vol ${v0.toFixed(0)} → ${v.toFixed(0)}`, r.errors.map((e) => e.message).join("; "));
}

const box = [{ id: "r", kind: "rect", center: [0, 0], w: 40, h: 30, rotation: 0 }];
const base = [sketch("s", box), extrude("b", "s", box, 20)];
const edgesOfBox = (z: number) => [
  { body: "b", mid: [0, -15, z], dir: [1, 0, 0], length: 40 }, { body: "b", mid: [0, 15, z], dir: [1, 0, 0], length: 40 },
  { body: "b", mid: [-20, 0, z], dir: [0, 1, 0], length: 30 }, { body: "b", mid: [20, 0, z], dir: [0, 1, 0], length: 30 },
];
const verticals = [[-20, -15], [20, -15], [20, 15], [-20, 15]].map(([x, y]) => ({ body: "b", mid: [x, y, 10], dir: [0, 0, 1], length: 20 }));

await check("plain box", base, "b");
await check("box, vertical edges rounded", [...base, { id: "f", name: "f", type: "fillet", edges: verticals as any, radius: 4 }], "b");
await check("box, every edge rounded", [...base, { id: "f1", name: "f", type: "fillet", edges: verticals as any, radius: 4 }, { id: "f2", name: "f", type: "fillet", edges: [{ body: "b", mid: [0, -15, 0], dir: [1, 0, 0], length: 32 }] as any, radius: 2 }], "b");
await check("box, bottom edges chamfered", [...base, { id: "c", name: "c", type: "chamfer", edges: edgesOfBox(0) as any, radius: 2 }], "b");
// Many small faces: a box with ribs joined on top, then a 24-sided column.
const ribs = Array.from({ length: 6 }, (_, i) => ({ id: `k${i}`, kind: "rect", center: [-15 + i * 6, 0], w: 2, h: 30, rotation: 0 }));
await check("box with 6 ribs joined", [...base, sketch("s2", ribs, { ...XY, origin: [0, 0, 20] }), { ...extrude("j", "s2", ribs, 5, "auto"), target: "b" } as any], "b");
const poly = [{ id: "p", kind: "polygon", center: [0, 0], radius: 20, sides: 24, angle: 0 }];
await check("24-sided prism", [sketch("s", poly), extrude("b", "s", poly, 20)], "b");
const star = [{ id: "st", kind: "polyline", closed: true, points: Array.from({ length: 20 }, (_, i) => { const a = (i / 20) * Math.PI * 2; const r = i % 2 ? 9 : 20; return [r * Math.cos(a), r * Math.sin(a)]; }) }];
await check("10-point star prism", [sketch("s", star), extrude("b", "s", star, 15)], "b", 0.8);

process.exit(failed ? 1 : 0);
