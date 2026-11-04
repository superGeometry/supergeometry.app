// Run: npx tsx tests/offsetcurved.test.ts — Offset Face on flat faces bordered by curved
// (sloped) faces: the curved neighbours carry on, it isn't a straight extrude.
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import type { Feature, PlaneDef } from "../src/doc/types";
import { regenerate } from "../src/kernel/engine";
import type { BodyMesh } from "../src/kernel/protocol";
import { arrangement, regionRef } from "../src/sketch/regions";

setOC(await (opencascade as unknown as () => Promise<any>)());

const XY: PlaneDef = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] };
const XZ: PlaneDef = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, -1, 0] };
const sketch = (id: string, plane: PlaneDef, entities: any[]): Feature => ({ id, name: id, type: "sketch", plane, entities });
const prof = (id: string, entities: any[]) => ({ kind: "profile" as const, sketch: id, regions: arrangement(entities).regions.map(regionRef) });

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
async function offsetTop(name: string, feats: Feature[], body: string, d: number, want: (v0: number) => [number, number]): Promise<void> {
  const r0 = await regenerate(feats);
  const b0 = r0.bodies.find((b) => b.id === body)!;
  const top = b0.faces.reduce((bi, f, i) => (f.normal[2] > 0.99 && (b0.faces[bi].normal[2] <= 0.99 || f.center[2] > b0.faces[bi].center[2]) ? i : bi), 0);
  const f = b0.faces[top];
  const r = await regenerate([...feats, { id: "of", name: "of", type: "extrude", source: { kind: "face", face: { body, center: f.center, normal: f.normal, area: f.area } }, distance: d, mode: "auto", target: body } as Feature]);
  const b = r.bodies.find((x) => x.id === body)!;
  const v0 = volume(b0);
  const v = volume(b);
  const zmax = Math.max(...Array.from(b.positions).filter((_, i) => i % 3 === 2));
  const [lo, hi] = want(v0);
  const ok = !r.errors.length && v > lo && v < hi && b.openEdges.length === 0 && Math.abs(zmax - (f.center[2] + d)) < 1e-3;
  if (!ok) failed++;
  console.log(ok ? "ok  " : "FAIL", name, `vol ${v0.toFixed(0)} → ${v.toFixed(0)} (${lo.toFixed(0)}..${hi.toFixed(0)}), top z ${zmax.toFixed(2)}`, r.errors.map((e) => e.message).join("; "));
}

// A cone (frustum r 20 → 10 over 20): the top carries on up the cone.
const trap = [{ id: "t", kind: "polyline", closed: true, points: [[0, 0], [20, 0], [10, 20], [0, 20]] }];
const cone: Feature[] = [sketch("c", XZ, trap), { id: "cone", name: "cone", type: "revolve", source: prof("c", trap), axis: { origin: [0, 0, 0], dir: [0, 0, 1] }, angle: 360, mode: "new" }];
const frustum = (r1: number, r2: number, h: number) => ((Math.PI * h) / 3) * (r1 * r1 + r1 * r2 + r2 * r2);
// Up 5: top radius 7.5 at z 25 (a straight extrude would keep radius 10).
await offsetTop("cone top up 5", cone, "cone", 5, () => [frustum(20, 7.5, 25) * 0.99, frustum(20, 7.5, 25) * 1.01]);
await offsetTop("cone top down 4", cone, "cone", -4, () => [frustum(20, 12, 16) * 0.99, frustum(20, 12, 16) * 1.01]);

// A loft (square → circle): the circle face carries on along the lofted side.
const sq = [{ id: "r", kind: "rect", center: [0, 0], w: 40, h: 40, rotation: 0 }];
const ci = [{ id: "c", kind: "circle", center: [0, 0], radius: 10 }];
const lofted: Feature[] = [sketch("a", XY, sq), sketch("b", { ...XY, origin: [0, 0, 30] }, ci), { id: "lo", name: "lo", type: "loft", sections: [prof("a", sq), prof("b", ci)], ruled: false, mode: "new" } as Feature];
await offsetTop("loft top up 3", lofted, "lo", 3, (v0) => [v0 + 3 * 100, v0 + 3 * 314]);

// A vase (revolved spline): the rim carries on.
const vase = [
  { id: "sp", kind: "spline", points: [[10, 0], [14, 10], [8, 25], [12, 40]], closed: false, mode: "fit" },
  { id: "t", kind: "line", a: [12, 40], b: [0, 40] },
  { id: "ax", kind: "line", a: [0, 40], b: [0, 0] },
  { id: "bt", kind: "line", a: [0, 0], b: [10, 0] },
];
const vaseF: Feature[] = [sketch("v", XZ, vase), { id: "rv", name: "rv", type: "revolve", source: prof("v", vase), axis: { origin: [0, 0, 0], dir: [0, 0, 1] }, angle: 360, mode: "new" }];
await offsetTop("vase rim up 2", vaseF, "rv", 2, (v0) => [v0 + 2 * Math.PI * 100, v0 + 2 * Math.PI * 196]);

process.exit(failed ? 1 : 0);
