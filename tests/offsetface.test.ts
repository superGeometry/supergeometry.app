// Run: npx tsx tests/offsetface.test.ts - a user's part (tests/fixtures/offsetface.json):
// a fillet whose far end runs into a twisted corner patch (where a chamfer
// meets it), offset 3.5 mm outwards. The patch has no one way to carry on, so
// the region was left open there and the offset was refused; then the ring
// added past the fillet's end left a hollow groove.
import opencascade from "replicad-opencascadejs";
import { measureVolume, setOC } from "replicad";
import { readFileSync } from "node:fs";
import { debugBodies, regenerate } from "../src/kernel/engine";
import { cylinderOf } from "../src/kernel/faceEdit";
import { healthOf, isHealthy } from "../src/kernel/repair";

setOC(await (opencascade as unknown as () => Promise<any>)());
const fs = JSON.parse(readFileSync(new URL("./fixtures/offsetface.json", import.meta.url), "utf8"));
const BODY = "extrude-mw57bjyk-sfwi";
let failed = 0;
const check = (name: string, ok: boolean, info = "") => {
  if (!ok) failed++;
  console.log(ok ? "ok  " : "FAIL", name, info);
};

await regenerate(fs.slice(0, -1));
const s0 = debugBodies().get(BODY)!;
const v0 = Math.abs(measureVolume(s0));
const bb0 = s0.boundingBox.bounds;
const r: any = await regenerate(fs);
const s = debugBodies().get(BODY)!;
check("Offset Face 01 rebuilds", !r.errors.length, r.errors.map((e: any) => e.message).join("; "));
const notes = (r.notes ?? []).map((n: any) => n.message).join("; ");
check("…a clean solid, nothing repaired", isHealthy(healthOf(s)) && !/Repaired/.test(notes), notes);
const radii = s.faces.map((f) => (f.geomType === "CYLINDRE" ? cylinderOf(f)?.r : undefined)).filter((x) => x !== undefined) as number[];
check("…the fillet is now R8.5 (5 + 3.5), the other two still R5, no old R5 pieces left", radii.filter((x) => Math.abs(x - 8.5) < 1e-4).length === 1 && radii.filter((x) => Math.abs(x - 5) < 1e-4).length === 2 && radii.length === 3, radii.map((x) => x.toFixed(3)).join(", "));
check("…no hollow left inside it (every round face bulges outwards)", s.faces.filter((f) => f.geomType === "CYLINDRE").every((f) => (cylinderOf(f)?.s ?? 0) > 0));
const bb = s.boundingBox.bounds;
check("…nothing added past the back of the part", bb[1][1] <= bb0[1][1] + 1e-6 && bb[1][2] <= bb0[1][2] + 1e-6, `max y ${bb0[1][1].toFixed(3)} → ${bb[1][1].toFixed(3)}`);
check("…it grew", Math.abs(measureVolume(s)) > v0, `${v0.toFixed(1)} → ${Math.abs(measureVolume(s)).toFixed(1)}`);
check("…the faces stay few (the corner patch the planes now close is gone)", s.faces.length <= s0.faces.length, `${s0.faces.length} → ${s.faces.length}`);
process.exit(failed ? 1 : 0);
