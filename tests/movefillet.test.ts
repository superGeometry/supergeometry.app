// Run: npx tsx tests/movefillet.test.ts - a user's part (tests/fixtures/
// movefillet.json): a box with faces tilted, an edge moved, a fillet and a
// chain of R3 fillets, then the left wall tilted 18° (Move Face 05). The R3
// fillet ends on that wall and can't be taken off alone (it's one link of a
// chain), so the wall's region was made with the fillet's cylinder as an
// endless one: it carved a groove and left a scrap of the old wall standing
// (12 faces: an inside-out cylinder and a 28 mm² patch at x = -60). Now the
// fillet carries on along its own corner and simply ends on the tilted wall.
import opencascade from "replicad-opencascadejs";
import { measureArea, setOC } from "replicad";
import { readFileSync } from "node:fs";
import { debugBodies, regenerate } from "../src/kernel/engine";
import { healthOf, isHealthy } from "../src/kernel/repair";

setOC(await (opencascade as unknown as () => Promise<any>)());
let failed = 0;
const check = (name: string, ok: boolean, info = "") => {
  if (!ok) failed++;
  console.log(ok ? "ok  " : "FAIL", name, info);
};
const doc = JSON.parse(readFileSync(new URL("./fixtures/movefillet.json", import.meta.url), "utf8"));
const B = "extrude-mw56abf8-v8l2";
const r: any = await regenerate(doc.features);
const name = (id: string) => doc.features.find((f: any) => f.id === id)?.name;
check("only Move Face 04 is refused (a fillet chain runs along that face), with a clear reason", r.errors.length === 1 && name(r.errors[0].featureId) === "Move Face 04" && /fillet/.test(r.errors[0].message), r.errors.map((e: any) => `${name(e.featureId)}: ${e.message}`).join("; "));
const s = debugBodies().get(B)!;
check("one clean solid", isHealthy(healthOf(s)));
const n = (f: any) => f.normalAt().toTuple();
const oldWall = s.faces.filter((f) => f.geomType === "PLANE" && Math.abs(n(f)[0] + 1) < 1e-6);
check("no scrap of the old left wall left standing", oldWall.length === 0, oldWall.map((f) => measureArea(f).toFixed(1)).join(", "));
const wall = s.faces.filter((f) => f.geomType === "PLANE" && Math.abs(n(f)[0] + Math.cos(Math.PI / 10)) < 1e-6 && Math.abs(n(f)[2] - Math.sin(Math.PI / 10)) < 1e-6);
check("the left wall is one face, tilted 18°", wall.length === 1, wall.map((f) => measureArea(f).toFixed(1)).join(", "));
const cyl = s.faces.filter((f) => f.geomType === "CYLINDRE");
check("the same three rounded faces as before the tilt (no groove)", s.faces.length === 10 && cyl.length === 3, `${s.faces.length} faces, round: ${cyl.map((f) => measureArea(f).toFixed(1)).join(", ")}`);
console.log(failed ? `${failed} FAILED` : "all passed");
process.exit(failed ? 1 : 0);
