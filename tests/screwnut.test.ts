// Run: npx tsx tests/screwnut.test.ts - an M10 x 1.5 screw (hex head, threaded
// shank) and nut (internal thread), built as a user would, every step checked.
// A thread that only just overlaps the core it's joined to used to come out
// wrong without a word from OpenCascade (then 22 s of repair and a misleading
// message); it's now caught by the joined volume and said plainly.
import opencascade from "replicad-opencascadejs";
import { measureVolume, setOC } from "replicad";
import { debugBodies, regenerate } from "../src/kernel/engine";
import { healthOf, isHealthy } from "../src/kernel/repair";
import { arrangement, regionRef } from "../src/sketch/regions";

setOC(await (opencascade as unknown as () => Promise<any>)());
const XY = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] };
const XZ = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, -1, 0] };
const regs = (es: any[]) => arrangement(es).regions.map(regionRef);
const sk = (id: string, name: string, plane: any, entities: any[]) => ({ id, name, type: "sketch", plane, entities });
const P = 1.5; // pitch
const RMIN = 4.1, RMAJ = 5.0, AF = 17; // core, major radius, hex across flats
const R6 = AF / Math.sqrt(3);
const tri = (cx: number, z: number, d = 0.5) => {
  const pts = [[cx + RMIN - d, z - 0.7], [cx + RMAJ, z], [cx + RMIN - d, z + 0.7]];
  return pts.map((a, i) => ({ id: `t${i}`, kind: "line", a, b: pts[(i + 1) % 3] }));
};
const head = [{ id: "h", kind: "polygon", center: [0, 0], radius: R6, sides: 6, angle: 0 }];
const shank = [{ id: "c", kind: "circle", center: [0, 0], radius: RMIN }];
const NX = 28; // nut beside the screw
const nutHex = [{ id: "n", kind: "polygon", center: [NX, 0], radius: R6, sides: 6, angle: 0 }];
const nutHole = [{ id: "nh", kind: "circle", center: [NX, 0], radius: RMIN }];
const turnsS = 17, turnsN = 7;
const thrS = tri(0, -27.6);
const thrN = tri(NX, -9.5, 0.1);
const feats: any[] = [
  sk("s1", "Head sketch", XY, head),
  { id: "head", name: "Head", type: "extrude", source: { kind: "profile", sketch: "s1", regions: regs(head) }, distance: 6.4, mode: "new" },
  sk("s2", "Shank sketch", XY, shank),
  { id: "shank", name: "Shank", type: "extrude", source: { kind: "profile", sketch: "s2", regions: regs(shank) }, distance: -30, mode: "join", target: "head" },
  sk("s3", "Thread profile", XZ, thrS),
  { id: "thread", name: "Thread", type: "revolve", source: { kind: "profile", sketch: "s3", regions: regs(thrS) }, axis: { origin: [0, 0, 0], dir: [0, 0, 1] }, angle: 360 * turnsS, travel: P * turnsS, mode: "join", target: "head" },
  { id: "tip", name: "Tip chamfer", type: "chamfer", edges: [{ body: "head", mid: [-RMIN, 0, -30], dir: [0, 1, 0], length: 2 * Math.PI * RMIN }], radius: 0.8 },
  { id: "headch", name: "Head chamfer", type: "chamfer", edges: [{ body: "head", mid: [0, R6 * Math.sqrt(3) / 2, 6.4], dir: [1, 0, 0], length: R6 }], radius: 0.6 },
  sk("s4", "Nut sketch", XY, [...nutHex, ...nutHole]),
  { id: "nut", name: "Nut", type: "extrude", source: { kind: "profile", sketch: "s4", regions: regs([...nutHex, ...nutHole]).sort((a: any, b: any) => b.a - a.a).slice(0, 1) }, distance: -8, mode: "new" },
  sk("s5", "Nut thread profile", XZ, thrN),
  { id: "nthread", name: "Nut thread", type: "revolve", source: { kind: "profile", sketch: "s5", regions: regs(thrN) }, axis: { origin: [NX, 0, 0], dir: [0, 0, 1] }, angle: 360 * turnsN, travel: P * turnsN, mode: "cut", target: "nut" },
];
let failed = 0;
const check = (name: string, ok: boolean, info = "") => {
  if (!ok) failed++;
  console.log(ok ? "ok  " : "FAIL", name, info);
};
const r: any = await regenerate(feats);
check("every step builds", !r.errors.length, r.errors.map((e: any) => `${e.feature}: ${e.message}`).join("; "));
const screw = debugBodies().get("head")!;
const nut = debugBodies().get("nut")!;
check("screw: one clean solid with its thread on", isHealthy(healthOf(screw)) && screw.faces.length > 20, `${screw.faces.length} faces`);
// Head + shank + thread − the part of the thread inside the shank, roughly.
const vs = Math.abs(measureVolume(screw));
check("screw volume adds up (head + shank + thread ridge)", vs > 3300 && vs < 3450, vs.toFixed(1));
const vn = Math.abs(measureVolume(nut));
check("nut: thread cut into its hole", isHealthy(healthOf(nut)) && vn < 1579 && vn > 1400 && nut.faces.length > 9, `${vn.toFixed(1)} mm³, ${nut.faces.length} faces`);
// The thread only just overlapping the core: a clear message, quickly.
const shallow = tri(0, -27.6, 0.1);
const bad = feats.map((f) => (f.id === "s3" ? { ...f, entities: shallow } : f.id === "thread" ? { ...f, source: { ...f.source, regions: regs(shallow) } } : f)).slice(0, 6);
const t0 = Date.now();
const rb: any = await regenerate(bad);
const ms = Date.now() - t0;
check("a thread only just overlapping the core: refused with a clear message", rb.errors.some((e: any) => /overlap more/.test(e.message)), rb.errors.map((e: any) => e.message).join("; "));
check("…without a long repair attempt", ms < 15000, `${ms} ms`);
process.exit(failed ? 1 : 0);
