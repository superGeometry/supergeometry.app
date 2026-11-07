// Run: npx tsx tests/threemfmesh.test.ts - the 3MF's mesh is as fine as the
// STL's (it used the view's coarse mesh: a slicer showed a cylinder as a
// prism of facets every 14°), and the file is a valid 3MF package.
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { writeFileSync } from "node:fs";
import { exportBodies, regenerate } from "../src/kernel/engine";
import { exportThreeMF } from "../src/io/threemf";

setOC(await (opencascade as unknown as () => Promise<any>)());
let failed = 0;
const check = (name: string, ok: boolean, info = "") => {
  if (!ok) failed++;
  console.log(ok ? "ok  " : "FAIL", name, info);
};
const R = 20;
const feats: any[] = [
  { id: "sk", name: "Sketch 01", type: "sketch", plane: { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] }, entities: [{ id: "c", kind: "circle", center: [0, 0], radius: R }] },
  { id: "cyl", name: "Extrude 01", type: "extrude", source: { kind: "profile", sketch: "sk", regions: [{ c: [0, 0], a: Math.PI * R * R }] }, distance: 30, mode: "auto" },
];
const r = await regenerate(feats);
const view = r.bodies[0];
const fine = JSON.parse(await (await exportBodies(feats, "mesh")).text());
// Facets round the rim: distinct angles of the vertices on the top circle.
const rim = (pos: ArrayLike<number>) => {
  const a = new Set<string>();
  for (let i = 0; i < pos.length; i += 3) if (Math.abs(pos[i + 2] - 30) < 1e-6 && Math.abs(Math.hypot(pos[i], pos[i + 1]) - R) < 1e-3) a.add(Math.atan2(pos[i + 1], pos[i]).toFixed(5));
  return a.size;
};
const nView = rim(view.positions);
const nFine = rim(fine[0].positions);
check("the 3MF's cylinder is much rounder than the view's (facets round the rim)", nFine >= 120 && nFine > nView * 1.9, `${nView} → ${nFine}`);
// Worst gap between the facets and the true circle (the chord's sag): R(1 - cos(π/n)).
const sag = R * (1 - Math.cos(Math.PI / nFine));
check("…within 0.01 mm of the true surface", sag < 0.01, `${sag.toFixed(4)} mm`);
const blob = await exportThreeMF([{ name: "Cylinder", positions: new Float32Array(fine[0].positions), indices: new Uint32Array(fine[0].indices), color: "#3d8bff" }], "Test", new Blob(["STEP"]));
const out = new URL("./fixtures/_out.3mf", import.meta.url);
writeFileSync(out, new Uint8Array(await blob.arrayBuffer()));
console.log("wrote", out.pathname);
console.log(failed ? `${failed} FAILED` : "all passed");
process.exit(failed ? 1 : 0);
