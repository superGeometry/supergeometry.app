// Run: npx tsx tests/rotatedface.test.ts - a user's part (tests/fixtures/rotatedface.json):
// a block with notches and three fillets, then faces turned. Turning the face a
// fillet ends on used to leave little pieces of the fillet's cylinder behind,
// and Fillet 01 couldn't be deleted.
import opencascade from "replicad-opencascadejs";
import { measureVolume, setOC } from "replicad";
import { readFileSync } from "node:fs";
import { debugBodies, regenerate } from "../src/kernel/engine";
import { cylinderOf, deleteFace } from "../src/kernel/faceEdit";
import { healthOf, isHealthy } from "../src/kernel/repair";

setOC(await (opencascade as unknown as () => Promise<any>)());
const fs = JSON.parse(readFileSync(new URL("./fixtures/rotatedface.json", import.meta.url), "utf8"));
const BODY = "extrude-mw57bjyk-sfwi";
let failed = 0;
const check = (name: string, ok: boolean, info = "") => {
  if (!ok) failed++;
  console.log(ok ? "ok  " : "FAIL", name, info);
};

const r: any = await regenerate(fs);
const s = debugBodies().get(BODY)!;
const rounds = s.faces.filter((f) => f.geomType === "CYLINDRE");
const notes = (r.notes ?? []).map((n: any) => n.message).join("; ");
check("every step rebuilds without errors", !r.errors.length, r.errors.map((e: any) => e.message).join("; "));
check("turning the face a fillet ends on: just the 3 fillets, no stray cylinder pieces", rounds.length === 3 && s.faces.length === 13, `${rounds.length} round faces, ${s.faces.length} faces`);
check("…and nothing needed repairing", !/Repaired/.test(notes), notes);
check("…a clean solid", isHealthy(healthOf(s)));

const f1 = s.faces.find((f) => f.geomType === "CYLINDRE" && Math.abs(cylinderOf(f)?.a[0] ?? 0) > 0.99)!;
const v0 = Math.abs(measureVolume(s));
try {
  const out = deleteFace(s, f1);
  const added = Math.abs(measureVolume(out)) - v0;
  const want = 15 * 25 * (1 - Math.PI / 4);
  check("Fillet 01 deleted: exactly its rounding filled back in", isHealthy(healthOf(out)) && Math.abs(added - want) < 1e-3 && out.faces.length === 12, `+${added.toFixed(3)} (want ${want.toFixed(3)}), ${out.faces.length} faces`);
} catch (e) {
  check("Fillet 01 deleted", false, (e as Error).message);
}
process.exit(failed ? 1 : 0);
