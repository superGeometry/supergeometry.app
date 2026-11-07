// Run: npx tsx tests/filltoplane.test.ts - an open freeform surface filled
// down (or up, or across) to a plane: a solid with straight sides and its
// outline projected flat on the plane as the bottom.
import opencascade from "replicad-opencascadejs";
import { measureVolume, setOC } from "replicad";
import { debugBodies, regenerate } from "../src/kernel/engine";
import { healthOf, isHealthy } from "../src/kernel/repair";
import { planeCage } from "../src/freeform/cage";
import { arrangement, regionRef } from "../src/sketch/regions";
import type { Feature, PlaneDef, Vec3 } from "../src/doc/types";

setOC(await (opencascade as unknown as () => Promise<any>)());

let failed = 0;
const check = (name: string, ok: boolean, info = "") => {
  if (!ok) failed++;
  console.log(ok ? "ok  " : "FAIL", name, info);
};

/** A 40×40 sheet at height z, its inner points pulled up/down by `bump`. */
function sheet(z: number, bump = 6, n = 4): Feature {
  const c = planeCage([40, 40], n, [0, 0, z]);
  c.verts.forEach((p, i) => {
    const inner = Math.abs(p[0]) < 19 && Math.abs(p[1]) < 19;
    if (inner) p[2] += bump * Math.cos(p[0] / 9) * Math.cos(p[1] / 11) * (i % 2 ? 1 : 0.6);
  });
  return { id: "s", name: "Surface", type: "freeform", cage: c, surface: true } as Feature;
}
const fill = (plane: PlaneDef): Feature => ({ id: "f", name: "Fill to Plane", type: "fillToPlane", body: "s", plane } as Feature);
const XY: PlaneDef = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] };

async function run(fs: Feature[], name: string, expect: (s: any, r: any) => [boolean, string]) {
  const r: any = await regenerate(fs);
  const bodies = [...debugBodies()];
  const err = r.errors[0]?.message;
  if (err) return check(name, false, `refused: ${err}`);
  const s = bodies.find(([id]) => id === "s")?.[1];
  const [ok, info] = expect(s, r);
  check(name, ok, info);
}

const healthy = (s: any) => !!s && isHealthy(healthOf(s));

await run([sheet(20), fill(XY)], "surface at 20 filled down to the ground", (s) => {
  const bb = s.boundingBox;
  const v = measureVolume(s);
  return [healthy(s) && Math.abs(bb.bounds[0][2]) < 1e-6 && v > 40 * 40 * 14 && v < 40 * 40 * 27, `vol ${v.toFixed(0)}, bottom at ${bb.bounds[0][2].toFixed(3)}, ${s.faces.length} faces`];
});
await run([sheet(20), fill({ origin: [0, 0, 60], xDir: [1, 0, 0], normal: [0, 0, 1] })], "filled up to a plane above it", (s) => {
  const bb = s.boundingBox;
  return [healthy(s) && Math.abs(bb.bounds[1][2] - 60) < 1e-6, `top at ${bb.bounds[1][2].toFixed(3)}`];
});
{
  const n: Vec3 = [0.3, 0, 1];
  const l = Math.hypot(...n);
  await run([sheet(25), fill({ origin: [0, 0, 0], xDir: [1 / l, 0, -0.3 / l], normal: n.map((x) => x / l) as Vec3 })], "filled to a tilted plane (sides along its normal)", (s) => [healthy(s), `vol ${measureVolume(s).toFixed(0)}`]);
}
await run([sheet(20, 18, 6), fill(XY)], "a deep wavy surface (6×6 patches)", (s) => [healthy(s), `vol ${measureVolume(s).toFixed(0)}, ${s.faces.length} faces`]);
{
  // The plane cuts across the surface: what's on the surface's side is filled, or a clear message.
  const r: any = await regenerate([sheet(20, 14), fill({ origin: [0, 0, 20], xDir: [1, 0, 0], normal: [0, 0, 1] })]);
  const s = debugBodies().get("s");
  check("plane across the surface: filled where it's above, or refused with a message", r.errors.length ? !!r.errors[0].message : healthy(s), r.errors[0]?.message ?? `vol ${s ? measureVolume(s).toFixed(0) : "-"}`);
}
{
  const r: any = await regenerate([sheet(20), fill({ origin: [100, 0, 0], xDir: [0, 1, 0], normal: [1, 0, 0] })]);
  const s = debugBodies().get("s");
  check("plane off to the side (surface seen edge-on): fills sideways or a message", r.errors.length ? !!r.errors[0].message : healthy(s), r.errors[0]?.message ?? `vol ${s ? measureVolume(s).toFixed(0) : "-"}`);
}
{
  // An overhang: one edge row pulled back over the surface (it folds as seen from below).
  const f = sheet(20) as any;
  for (const p of f.cage.verts) if (p[0] > 19) ((p[0] -= 14), (p[2] += 12));
  const r: any = await regenerate([f, fill(XY)]);
  const s = debugBodies().get("s");
  check("a surface folding back over itself (an overhang): a clean solid, the fold filled under too", r.errors.length ? false : healthy(s) && measureVolume(s) > 24000, r.errors[0]?.message ?? `vol ${s ? measureVolume(s).toFixed(0) : "-"}`);
}
{
  const solidFF: Feature = { id: "s", name: "Blob", type: "freeform", cage: (await import("../src/freeform/cage")).sphereCage(30) } as Feature;
  const r: any = await regenerate([solidFF, fill(XY)]);
  check("a solid freeform is refused (it's not an open surface)", r.errors.some((e: any) => /already a solid/.test(e.message)), r.errors[0]?.message ?? "accepted");
}
{
  // Then used like any body: joined to a block, an edge rounded.
  const es = [{ id: "r", kind: "rect", center: [0, 30], w: 30, h: 30, rotation: 0 }];
  const fs: Feature[] = [
    sheet(20),
    fill(XY),
    { id: "sk", name: "Sketch", type: "sketch", plane: XY, entities: es } as Feature,
    { id: "b", name: "Block", type: "extrude", source: { kind: "profile", sketch: "sk", regions: arrangement(es as any).regions.map(regionRef) }, distance: 15, mode: "new" } as Feature,
    { id: "u", name: "Union", type: "boolean", op: "union", target: "s", tools: ["b"] } as Feature,
  ];
  await run(fs, "the filled body joined to a block", (s) => [healthy(s), `vol ${measureVolume(s).toFixed(0)}`]);
  const r: any = await regenerate(fs);
  const body = r.bodies.find((b: any) => b.id === "s");
  const e = body.edges.find((x: any) => x.type === "LINE" && Math.abs(x.mid[2]) < 1e-6);
  const r2: any = await regenerate([...fs, { id: "fi", name: "Fillet", type: "fillet", edges: [{ body: "s", mid: e.mid, dir: e.dir, length: e.length }], radius: 2 } as Feature]);
  check("…and an edge of it filleted", !r2.errors.length && healthy(debugBodies().get("s")), r2.errors[0]?.message ?? "");
  const r3: any = await regenerate([...fs.slice(0, 2), { id: "mv", name: "Move", type: "transform", bodies: ["s"], copy: false, op: { kind: "move", translate: [5, 5, 5] } } as Feature]);
  check("…and moved", !r3.errors.length && healthy(debugBodies().get("s")), r3.errors[0]?.message ?? "");
}

process.exit(failed ? 1 : 0);
