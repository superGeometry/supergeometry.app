// Run: npx tsx tests/thread.test.ts - the Thread step: an outside thread on a
// shank, an inside one in a nut's hole, left-handed, short faces refused,
// the head next to the shank left alone.
import opencascade from "replicad-opencascadejs";
import { measureVolume, setOC } from "replicad";
import { debugBodies, regenerate } from "../src/kernel/engine";
import { healthOf, isHealthy } from "../src/kernel/repair";
import { arrangement, regionRef } from "../src/sketch/regions";
import { defaultPitch, threadLabel } from "../src/kernel/threads";

setOC(await (opencascade as unknown as () => Promise<any>)());
let failed = 0;
const check = (name: string, ok: boolean, info = "") => {
  if (!ok) failed++;
  console.log(ok ? "ok  " : "FAIL", name, info);
};
const XY = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] };
const regs = (es: any[]) => arrangement(es).regions.map(regionRef);
const R6 = 17 / Math.sqrt(3);
const head = [{ id: "h", kind: "polygon", center: [0, 0], radius: R6, sides: 6, angle: 0 }, { id: "c", kind: "circle", center: [0, 0], radius: 5 }];
const screw: any[] = [
  { id: "s1", name: "Sketch", type: "sketch", plane: XY, entities: head },
  { id: "b", name: "Head", type: "extrude", source: { kind: "profile", sketch: "s1", regions: regs(head) }, distance: 6.4, mode: "new" },
  { id: "shank", name: "Shank", type: "extrude", source: { kind: "profile", sketch: "s1", regions: regs(head).filter((r: any) => r.a < 100) }, distance: -30, mode: "join", target: "b" },
];
const r0: any = await regenerate(screw);
const s0 = debugBodies().get("b")!;
const v0 = Math.abs(measureVolume(s0));
const shankFace = r0.bodies[0].faces.find((f: any) => f.type === "CYLINDRE");
check("a plain M10 screw blank", !r0.errors.length && !!shankFace, r0.errors.map((e: any) => e.message).join());
const thr = { id: "t", name: "Thread", type: "thread", face: { body: "b", center: shankFace.center, normal: shankFace.normal, area: shankFace.area }, pitch: 1.5 };
let t = Date.now();
const r1: any = await regenerate([...screw, thr]);
const s1 = debugBodies().get("b")!;
const v1 = Math.abs(measureVolume(s1));
// The groove: section ½·w·d with w = 2·(d + 0.08P)·tan30 at the mouth, about
// 2π·(r − d/3)·length long; most of it is in the shank.
check("outside thread cut: one clean solid, material taken from the shank only", !r1.errors.length && isHealthy(healthOf(s1)) && v1 < v0 && v0 - v1 < 400 && v0 - v1 > 150, `${r1.errors.map((e: any) => e.message).join()} ${v0.toFixed(1)} → ${v1.toFixed(1)} in ${Date.now() - t} ms`);
const hb = s1.boundingBox.bounds;
check("…the head is untouched (still 17 across flats, 6.4 high)", Math.abs(hb[1][2] - 6.4) < 1e-6 && Math.abs(hb[1][1] - hb[0][1] - 17) < 1e-3);
check("…label says M10 × 1.5", threadLabel(10, false, 1.5) === "M10 × 1.5" && defaultPitch(10, false) === 1.5);

// A nut: hex with an 8.5 hole (M10's tap drill), threaded inside.
const nutS = [{ id: "n", kind: "polygon", center: [0, 0], radius: R6, sides: 6, angle: 0 }, { id: "h", kind: "circle", center: [0, 0], radius: 4.25 }];
const nut: any[] = [
  { id: "s2", name: "Nut sketch", type: "sketch", plane: XY, entities: nutS },
  { id: "nut", name: "Nut", type: "extrude", source: { kind: "profile", sketch: "s2", regions: regs(nutS).filter((r: any) => r.a > 100) }, distance: 8, mode: "new" },
];
const rn: any = await regenerate(nut);
const hole = rn.bodies[0].faces.find((f: any) => f.type === "CYLINDRE");
const vn0 = Math.abs(measureVolume(debugBodies().get("nut")!));
check("hole picks M10 × 1.5 from its tap-drill size", defaultPitch(8.5, true) === 1.5 && threadLabel(8.5, true, 1.5) === "M10 × 1.5", `${defaultPitch(8.5, true)} ${threadLabel(8.5, true, 1.5)}`);
t = Date.now();
const rn1: any = await regenerate([...nut, { id: "nt", name: "Thread", type: "thread", face: { body: "nut", center: hole.center, normal: hole.normal, area: hole.area }, pitch: 1.5 }]);
const sn = debugBodies().get("nut")!;
const vn1 = Math.abs(measureVolume(sn));
check("inside thread cut into the nut", !rn1.errors.length && isHealthy(healthOf(sn)) && vn1 < vn0 && vn0 - vn1 > 50, `${rn1.errors.map((e: any) => e.message).join()} ${vn0.toFixed(1)} → ${vn1.toFixed(1)} in ${Date.now() - t} ms`);
const rl: any = await regenerate([...screw, { ...thr, left: true }]);
check("left-handed thread too", !rl.errors.length && isHealthy(healthOf(debugBodies().get("b")!)), rl.errors.map((e: any) => e.message).join());
const rc: any = await regenerate([...screw, { ...thr, pitch: 9 }]);
check("a pitch too coarse for the diameter: a clear message", rc.errors.some((e: any) => /too coarse|shorter/.test(e.message)), rc.errors.map((e: any) => e.message).join());
const flat = r0.bodies[0].faces.find((f: any) => f.type === "PLANE");
const rf: any = await regenerate([...screw, { ...thr, face: { body: "b", center: flat.center, normal: flat.normal, area: flat.area } }]);
check("a flat face: refused with a message", rf.errors.some((e: any) => /round faces/.test(e.message)), rf.errors.map((e: any) => e.message).join());
// Every common size, outside on a rod and inside a nut, right and left hand:
// each must come out (the kernel checks the cut against the groove's exact volume).
import { makeCylinder, makeBaseBox } from "replicad";
import { threadFace } from "../src/kernel/engine";
import { defaultPitch as dp } from "../src/kernel/threads";
const bad: string[] = [];
let n = 0;
t = Date.now();
for (const D of [3, 4, 5, 6, 8, 10, 12, 16, 20, 24]) {
  const P = dp(D, false);
  for (const left of [false, true]) {
    n += 2;
    try {
      const rod = makeCylinder(D / 2, 3 * D, [0, 0, 0]) as any;
      const out = threadFace(rod, rod.faces.find((f: any) => f.geomType === "CYLINDRE"), P, left);
      if (!isHealthy(healthOf(out))) bad.push(`M${D} rod${left ? " left" : ""}: not clean`);
    } catch (e) {
      bad.push(`M${D} rod${left ? " left" : ""}: ${(e as Error).message}`);
    }
    try {
      const nutB = (makeBaseBox(D * 2, D * 2, D) as any).cut(makeCylinder((D - P) / 2, D * 3, [0, 0, -D]));
      const hole = nutB.faces.find((f: any) => f.geomType === "CYLINDRE");
      const out = threadFace(nutB, hole, P, left);
      if (!isHealthy(healthOf(out))) bad.push(`M${D} nut${left ? " left" : ""}: not clean`);
    } catch (e) {
      bad.push(`M${D} nut${left ? " left" : ""}: ${(e as Error).message}`);
    }
  }
}
check(`M3–M24, rods and nuts, both hands: all ${n} threaded`, !bad.length, `${bad.join("; ")} (${Date.now() - t} ms)`);
process.exit(failed ? 1 : 0);
