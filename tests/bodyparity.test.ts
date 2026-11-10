// Run: npx tsx tests/bodyparity.test.ts - Symmetric extrude and Two-Distance chamfer through the real engine.
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import type { Feature, PlaneDef } from "../src/doc/types";
import { regenerate } from "../src/kernel/engine";
import { arrangement, regionRef } from "../src/sketch/regions";

setOC(await (opencascade as unknown as () => Promise<any>)());

const XY: PlaneDef = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] };
const rect = [{ id: "r", kind: "rect", center: [0, 0], w: 40, h: 20, rotation: 0 }];
const regions = arrangement(rect as any).regions.map(regionRef);
const sketch: Feature = { id: "s1", name: "s1", type: "sketch", plane: XY, entities: rect as any };
const box = (extra: Partial<Feature> = {}): Feature => ({ id: "e1", name: "Extrude", type: "extrude", source: { kind: "profile", sketch: "s1", regions }, distance: 10, mode: "auto", ...extra }) as Feature;

let failed = 0;
const check = (name: string, ok: boolean, info: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${info}`);
  if (!ok) failed++;
};
const zs = (r: Awaited<ReturnType<typeof regenerate>>) => Array.from(r.bodies[0].positions).filter((_, i) => i % 3 === 2);

// Symmetric: 10 each side, from z = -10 to z = 10.
{
  const r = await regenerate([sketch, box({ symmetric: true } as Partial<Feature>)]);
  const z = zs(r);
  const lo = Math.min(...z);
  const hi = Math.max(...z);
  check("symmetric extrude", r.errors.length === 0 && Math.abs(lo + 10) < 1e-6 && Math.abs(hi - 10) < 1e-6, `z ${lo}..${hi}, errors ${r.errors.map((e) => e.message)}`);
}
// Symmetric with a taper: refused with a clear message.
{
  const r = await regenerate([sketch, box({ symmetric: true, taper: 0.5 } as Partial<Feature>)]);
  check("symmetric + taper refused", r.errors.length === 1 && /one way/.test(r.errors[0].message), r.errors.map((e) => e.message).join());
}

// Two-Distance chamfer on the top long edge (y = 10, z = 10): 2 along one face, 5 along the other.
const edge = { body: "e1", mid: [0, 10, 10] as [number, number, number], dir: [1, 0, 0] as [number, number, number], length: 40 };
const chamfer = (extra: object): Feature => ({ id: "c1", name: "Chamfer", type: "chamfer", edges: [edge], radius: 2, ...extra }) as Feature;
{
  const eq = await regenerate([sketch, box(), chamfer({})]);
  const two = await regenerate([sketch, box(), chamfer({ distance2: 5 })]);
  const flipped = await regenerate([sketch, box(), chamfer({ distance2: 5, flip: true })]);
  const errs = [...eq.errors, ...two.errors, ...flipped.errors].map((e) => e.message);
  check("chamfers rebuild", errs.length === 0, errs.join() || "no errors");
  check("equal chamfer: 7 faces", eq.bodies[0].faces.length === 7, `${eq.bodies[0].faces.length} faces`);
  check("two-distance: 7 faces", two.bodies[0].faces.length === 7, `${two.bodies[0].faces.length} faces`);
  // The slant's two ends: 2 and 5 from the edge, one on each face; flipped swaps them.
  const a = await slant(two);
  const b = await slant(flipped);
  check("two-distance sizes", near(a, [2, 5]), JSON.stringify(a));
  check("flip swaps the sides", near(b, [2, 5]) && a[0] !== b[0], `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
}

/** How far the slant runs along the top face and down the side face (from the box's corner line). */
async function slant(r: Awaited<ReturnType<typeof regenerate>>): Promise<[number, number]> {
  const p = Array.from(r.bodies[0].positions);
  let topY = -Infinity;
  let sideZ = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    const [y, z] = [p[i + 1], p[i + 2]];
    if (Math.abs(z - 10) < 1e-6) topY = Math.max(topY, y);
    if (Math.abs(y - 10) < 1e-6) sideZ = Math.max(sideZ, z);
  }
  return [Math.round((10 - topY) * 1e4) / 1e4, Math.round((10 - sideZ) * 1e4) / 1e4];
}
function near(v: [number, number], want: [number, number]): boolean {
  const s = [...v].sort((x, y) => x - y);
  return Math.abs(s[0] - want[0]) < 1e-3 && Math.abs(s[1] - want[1]) < 1e-3;
}

if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log("all passed");
