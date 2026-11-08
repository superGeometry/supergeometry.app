// Run: npx tsx tests/stretch.test.ts - Scale X / Y / Z on ordinary bodies
// (not just freeforms): a box, a cylinder, a filleted box, a box with a hole
// through it, a sphere - each one clean solid, its size and volume stretched.
import opencascade from "replicad-opencascadejs";
import { getOC, makeBaseBox, makeCylinder, makeSphere, setOC } from "replicad";
import { stretchShape } from "../src/kernel/stretch";
import { healthOf, isHealthy } from "../src/kernel/repair";
import { debugBodies, regenerate } from "../src/kernel/engine";
import { arrangement, regionRef } from "../src/sketch/regions";

setOC(await (opencascade as unknown as () => Promise<any>)());
let failed = 0;
const check = (name: string, ok: boolean, info = "") => {
  if (!ok) failed++;
  console.log(ok ? "ok  " : "FAIL", name, info);
};

const vol = (s: any) => {
  const oc: any = getOC();
  const p = new oc.GProp_GProps();
  oc.BRepGProp.VolumeProperties(s.wrapped, p, 1e-6, true, false);
  return p.Mass();
};
const cases: [string, () => any, [number, number, number]?][] = [
  ["hole stretched across (elliptic)", () => makeBaseBox(20, 10, 6).cut(makeCylinder(2, 30, [-15, 0, 3], [1, 0, 0])), [1, 1, 2]],
  ["cylinder cut at a slant (trimmed round face)", () => makeCylinder(5, 12).cut(makeBaseBox(30, 30, 30).rotate(30, [0, 0, 0], [1, 0, 0]).translate([0, 0, 10])), [1.7, 1, 1]],
  ["filleted box, stretched along X", () => makeBaseBox(20, 10, 6).fillet(2), [3, 1, 1]],
  ["box", () => makeBaseBox(20, 10, 6)],
  ["cylinder", () => makeCylinder(5, 12)],
  ["cylinder lying down", () => makeCylinder(5, 12, [0, 0, 0], [1, 0, 0])],
  ["filleted box", () => makeBaseBox(20, 10, 6).fillet(2)],
  ["box with a hole", () => makeBaseBox(20, 10, 6).cut(makeCylinder(2, 20, [0, 0, -5]))],
  ["sphere", () => makeSphere(5)],
];
for (const [name, make, k] of cases) {
  const K = k ?? ([1, 1, 2.5] as [number, number, number]);
  const s = make();
  const v0 = Math.abs(vol(s));
  const b0 = s.boundingBox.bounds;
  const t = Date.now();
  try {
    const out = stretchShape(s, [0, 0, 0], K);
    const v1 = Math.abs(vol(out));
    const b1 = out.boundingBox.bounds;
    const sizes = [0, 1, 2].map((i) => (b1[1][i] - b1[0][i]) / (b0[1][i] - b0[0][i]));
    const okSize = sizes.every((r, i) => Math.abs(r - K[i]) < 2e-3);
    check(`${name} stretched ×${K.join("/")}`, isHealthy(healthOf(out)) && Math.abs(v1 - v0 * K[0] * K[1] * K[2]) < v0 * 2e-3 && okSize, `volume ${v0.toFixed(2)} → ${v1.toFixed(2)}, sizes ×${sizes.map((r) => r.toFixed(4)).join("/")}, ${out.faces.length} faces, ${Date.now() - t} ms`);
  } catch (e) {
    check(`${name} stretched`, false, String((e as Error).message));
  }
}
{
  // A threaded rod (a thread's twisted faces), through the app's own steps:
  // stretched along its length and across it.
  const XY = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] };
  const c = [{ id: "c", kind: "circle", center: [0, 0], radius: 5 }];
  const rod: any[] = [
    { id: "s", name: "S", type: "sketch", plane: XY, entities: c },
    { id: "b", name: "Rod", type: "extrude", source: { kind: "profile", sketch: "s", regions: arrangement(c as any).regions.map(regionRef) }, distance: 20, mode: "new" },
  ];
  const r0: any = await regenerate(rod);
  const side = r0.bodies[0].faces.find((f: any) => f.type === "CYLINDRE");
  const r1: any = await regenerate([...rod, { id: "t", name: "Thread", type: "thread", face: { body: "b", center: side.center, normal: side.normal, area: side.area }, pitch: 1.5 }]);
  const threaded = debugBodies().get("b")!;
  for (const K of [[1, 1, 1.5], [1.4, 1, 1]] as [number, number, number][]) {
    const t = Date.now();
    try {
      const v0 = vol(threaded);
      const out = stretchShape(threaded, [0, 0, 0], K);
      const v1 = vol(out);
      check(`threaded rod stretched ×${K.join("/")}`, !r1.errors.length && isHealthy(healthOf(out)) && Math.abs(v1 - v0 * K[0] * K[1] * K[2]) < v0 * 2e-3, `${v0.toFixed(1)} → ${v1.toFixed(1)}, ${threaded.faces.length} → ${out.faces.length} faces, ${Date.now() - t} ms`);
    } catch (e) {
      check(`threaded rod stretched ×${K.join("/")}`, false, String((e as Error).message));
    }
  }
}
process.exit(failed ? 1 : 0);
