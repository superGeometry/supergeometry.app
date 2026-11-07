// Run: npx tsx tests/shellrim.test.ts - a user's part (tests/fixtures/shellrim.json):
// a box with a fillet and a chamfer, shelled open at the chamfer, then the
// rim the shell left (a frame round the opening) offset 3 mm in. The rim's
// corners each slid along one wall only and were averaged: off both walls,
// so slanted patches stood up past the new rim as fins. A corner now slides
// along the body's edge where its two walls meet.
import opencascade from "replicad-opencascadejs";
import { measureVolume, setOC } from "replicad";
import { readFileSync } from "node:fs";
import { debugBodies, regenerate } from "../src/kernel/engine";

setOC(await (opencascade as unknown as () => Promise<any>)());
const doc = JSON.parse(readFileSync(new URL("./fixtures/shellrim.json", import.meta.url), "utf8"));
const fs = doc.features;
const BODY = "extrude-mw6obrns-xqpb";
let failed = 0;
const check = (name: string, ok: boolean, info = "") => {
  if (!ok) failed++;
  console.log(ok ? "ok  " : "FAIL", name, info);
};
const n0 = [0, -Math.SQRT1_2, Math.SQRT1_2];
const depth = (c: { y: number; z: number }) => n0[1] * 7 + n0[2] * 43 - (n0[1] * c.y + n0[2] * c.z);

await regenerate(fs.slice(0, -1));
const s0 = debugBodies().get(BODY)!;
const v0 = Math.abs(measureVolume(s0));
for (const d of [-3, 3]) {
  fs[fs.length - 1].distance = d;
  const r: any = await regenerate(fs);
  const s = debugBodies().get(BODY)!;
  check(`offset ${d}: rebuilds`, !r.errors.length, r.errors.map((e: any) => e.message).join("; "));
  check("…only flat and round faces (no slanted patches)", s.faces.every((f) => f.geomType === "PLANE" || f.geomType === "CYLINDRE"), s.faces.map((f) => f.geomType).join(","));
  check("…no more faces than before", s.faces.length <= s0.faces.length + 1, `${s0.faces.length} → ${s.faces.length}`);
  const rim = s.faces.filter((f) => f.geomType === "PLANE" && Math.abs(f.normalAt().y + Math.SQRT1_2) < 1e-6 && Math.abs(f.normalAt().z - Math.SQRT1_2) < 1e-6);
  check("…one rim, moved by the offset", rim.length === 1 && Math.abs(depth(rim[0].center) + d) < 1e-6, rim.map((f) => depth(f.center).toFixed(3)).join(","));
  const bb = s.boundingBox.bounds;
  check("…stays inside the walls' own planes (box unchanged)", Math.abs(bb[0][1]) < 1e-6 && Math.abs(bb[1][2] - 50) < 1e-6, JSON.stringify(bb));
  const v = Math.abs(measureVolume(s));
  check(d < 0 ? "…smaller" : "…bigger", d < 0 ? v < v0 : v > v0, `${v0.toFixed(1)} → ${v.toFixed(1)}`);
}
process.exit(failed ? 1 : 0);
