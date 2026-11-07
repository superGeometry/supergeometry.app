// Run: npx tsx tests/deletefuzz.test.ts [rounds] [seed]
//
// Random parts, a random edge filleted or chamfered, then that fillet deleted
// again: if the delete is accepted, the part must be exactly what it was
// before the fillet (same volume, a clean solid) - "as if it was never there".
import opencascade from "replicad-opencascadejs";
import { measureVolume, setOC } from "replicad";
import { debugBodies, regenerate } from "../src/kernel/engine";
import { healthOf, isHealthy } from "../src/kernel/repair";
import { base, rng } from "./fuzzkit";
import { cylinderOf } from "../src/kernel/faceEdit";
import type { Feature } from "../src/doc/types";

setOC(await (opencascade as unknown as () => Promise<any>)());
const ROUNDS = Number(process.argv[2] ?? 16);
const SEED = Number(process.argv[3] ?? 1);

let accepted = 0;
let refused = 0;
let notMade = 0;
const fails: string[] = [];
const why = new Map<string, number>();
for (let k = 0; k < ROUNDS; k++) {
  const R = rng(SEED * 4099 + k);
  const feats = base(R, k);
  const r0: any = await regenerate(feats);
  if (r0.errors.length || !r0.bodies.length) continue;
  const b = r0.bodies[0];
  const v0 = Math.abs(measureVolume(debugBodies().get(b.id)!));
  const edges = b.edges.filter((e: any) => e.length > 1);
  const e = edges[Math.floor(R() * edges.length)];
  if (!e) continue;
  const kind = R() < 0.65 ? "fillet" : "chamfer";
  const radius = Math.round((0.5 + R() * 3) * 100) / 100;
  const fil = { id: "fil", name: kind, type: kind, edges: [{ body: b.id, mid: e.mid, dir: e.dir, length: e.length }], radius } as Feature;
  const r1: any = await regenerate([...feats, fil]);
  if (r1.errors.length) {
    notMade++;
    continue;
  }
  // The faces that fillet made: a chamfer's flat face points a way no face
  // did before; a fillet's round faces have its radius (or are new tori).
  const s1 = debugBodies().get(b.id)!;
  const oldNormals = b.faces.filter((x: any) => x.type === "PLANE").map((x: any) => x.normal);
  const hadTorus = b.faces.some((x: any) => x.type === "TORUS");
  const made = s1.faces
    .map((face, i) => ({ face, info: r1.bodies.find((x: any) => x.id === b.id).faces[i] }))
    .filter(({ face, info }) => {
      if (!info) return false;
      if (kind === "chamfer") return face.geomType === "PLANE" && !oldNormals.some((n: number[]) => Math.abs(n[0] * info.normal[0] + n[1] * info.normal[1] + n[2] * info.normal[2]) > 0.9999);
      if (face.geomType === "TORUS") return !hadTorus;
      const r = cylinderOf(face)?.r;
      return r !== undefined && Math.abs(r - radius) < 1e-6;
    })
    .map(({ info }) => info);
  if (!made.length) continue;
  const f = made[Math.floor(R() * made.length)];
  const del = { id: "del", name: "Delete", type: "deleteGeom", body: b.id, faces: [{ body: b.id, center: f.center, normal: f.normal, area: f.area }], edges: [], vertices: [] } as Feature;
  const r2: any = await regenerate([...feats, fil, del]);
  if (r2.errors.length) {
    refused++;
    const m = r2.errors[0].message.slice(0, 60);
    if (process.env.DF_WHY) console.log("refused", k, `part ${k % 7}`, kind, f.type, r2.errors[0].message.slice(0, 80));
    why.set(`${kind}: ${m}`, (why.get(`${kind}: ${m}`) ?? 0) + 1);
    continue;
  }
  accepted++;
  const s = debugBodies().get(b.id)!;
  const v = Math.abs(measureVolume(s));
  const ok = isHealthy(healthOf(s)) && Math.abs(v - v0) <= v0 * 1e-5;
  if (!ok) fails.push(`round ${k} (${kind} r${radius} on part ${k % 7}): ${isHealthy(healthOf(s)) ? "" : "not a clean solid, "}volume ${v.toFixed(3)}, before the ${kind} ${v0.toFixed(3)}`);
}
for (const f of fails) console.log("FAIL", f);
console.log(`${accepted} fillets/chamfers deleted, ${refused} refused, ${notMade} couldn't be made in the first place; ${fails.length} not back to the original`);
for (const [m, n] of [...why].sort((a, b) => b[1] - a[1])) console.log(`  ${n}× ${m}`);
process.exit(fails.length ? 1 : 0);
