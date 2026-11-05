// Run: npx tsx tests/threemf.test.ts [out.3mf] — 3MF export: a valid zip with the model and the STEP inside.
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { writeFileSync } from "node:fs";
import type { Feature } from "../src/doc/types";
import { exportBodies, regenerate } from "../src/kernel/engine";
import { exportThreeMF } from "../src/io/threemf";
import { arrangement, regionRef } from "../src/sketch/regions";

setOC(await (opencascade as unknown as () => Promise<any>)());
const rect = [{ id: "r", kind: "rect", center: [0, 0], w: 40, h: 20, rotation: 0 }];
const feats: Feature[] = [
  { id: "s", name: "s", type: "sketch", plane: { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] }, entities: rect as any },
  { id: "b", name: "b", type: "extrude", source: { kind: "profile", sketch: "s", regions: arrangement(rect as any).regions.map(regionRef) }, distance: 10, mode: "new" },
];
const r = await regenerate(feats);
const step = await exportBodies(feats, "step");
const blob = await exportThreeMF(r.bodies.map((b) => ({ name: "Box", positions: b.positions, indices: b.indices, color: "#3d8bff" })), "Test", step);
const buf = Buffer.from(await blob.arrayBuffer());
if (process.argv[2]) writeFileSync(process.argv[2], buf);
const ok = buf.readUInt32LE(0) === 0x04034b50 && buf.length > 1000;
console.log(ok ? "ok  " : "FAIL", "3mf export", buf.length, "bytes");
process.exit(ok ? 0 : 1);
