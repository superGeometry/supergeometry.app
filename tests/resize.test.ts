// Run: npx tsx tests/resize.test.ts
// A part made the usual way (box, rounded corners, a hole sketched on top,
// a chamfer, shelled from below), then its first sizes changed: every later
// step must follow - the same part as one whose picks were made at the new size.
import opencascade from "replicad-opencascadejs";
import { setOC, measureVolume } from "replicad";
import { debugBodies, regenerate } from "../src/kernel/engine";
import { resolveDoc } from "../src/doc/params";
setOC(await (opencascade as unknown as () => Promise<any>)());

const XY = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] };
function part(w: number, d: number, h: number, fresh = false) {
  const W = fresh ? w : 40, D = fresh ? d : 30, H = fresh ? h : 20;
  // Refs as they were picked on the 40 x 30 x 20 box (what the doc stores).
  return {
    variables: [],
    features: [
      { id: "s", name: "Sketch 01", type: "sketch", plane: XY, entities: [{ id: "r", kind: "rect", center: [0, 0], w, h: d, rotation: 0 }], constraints: [] },
      { id: "b", name: "Extrude 01", type: "extrude", source: { kind: "profile", sketch: "s", regions: [{ c: [0, 0], a: 1200, k: ["r"], s: [2] }] }, distance: h, mode: "new" },
      // fillet: the 4 vertical edges
      { id: "f", name: "Fillet 01", type: "fillet", radius: 3, edges: [[W / 2, D / 2], [-W / 2, D / 2], [W / 2, -D / 2], [-W / 2, -D / 2]].map(([x, y]) => ({ body: "b", mid: [x, y, H / 2], dir: [0, 0, 1], length: H })) },
      // a hole sketched on the top face, cut through
      { id: "s2", name: "Sketch 02", type: "sketch", plane: { origin: [0, 0, H], xDir: [1, 0, 0], normal: [0, 0, 1] }, attachedTo: { body: "b", center: [0, 0, H], normal: [0, 0, 1], area: W * D - (4 - Math.PI) * 9 }, entities: [{ id: "c", kind: "circle", center: [0, 0], radius: 5 }], constraints: [] },
      { id: "e2", name: "Extrude 02", type: "extrude", source: { kind: "profile", sketch: "s2", regions: [{ c: [0, 0], a: 78.54, k: ["c"], s: [0.5] }] }, distance: -20, mode: "cut", target: "b" },
      // chamfer the top outer rim (one of its straight edges)
      { id: "ch", name: "Chamfer 01", type: "chamfer", radius: 1, edges: [{ body: "b", mid: [0, -D / 2, H], dir: [1, 0, 0], length: W - 6 }] },
      // shell from the bottom face
      { id: "sh", name: "Shell 01", type: "shell", body: "b", faces: [{ body: "b", center: [0, 0, 0], normal: [0, 0, -1], area: W * D - (4 - Math.PI) * 9 - 78.54 }], thickness: 1.5 },
    ],
  };
}

let failed = 0;
for (const [w, d, h] of [[40, 30, 20], [60, 30, 20], [40, 50, 20], [40, 30, 35], [80, 60, 10], [24, 18, 20]]) {
  const doc2: any = part(w, d, h, true);
  await regenerate(doc2.features);
  const want = Math.abs(measureVolume(debugBodies().get("b") as any)).toFixed(0);
  const doc: any = part(w, d, h);
  resolveDoc(doc);
  const r: any = await regenerate(doc.features);
  const b = debugBodies().get("b");
  const got = b ? Math.abs(measureVolume(b as any)).toFixed(0) : "-";
  const ok = !r.errors.length && got === want;
  if (!ok) failed++;
  console.log(ok ? "ok  " : "FAIL", `${w}x${d}x${h}`.padEnd(10), "errors", JSON.stringify(r.errors.map((e: any) => `${e.featureId}: ${e.message}`)), "volume", got, "want", want);
}
process.exit(failed ? 1 : 0);
