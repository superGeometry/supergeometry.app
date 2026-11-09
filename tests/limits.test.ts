// Run: npx tsx tests/limits.test.ts
// Values a person might type by mistake: each step stops at once with a
// message that says what is wrong (or works), never a freeze or a mystery.
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { regenerate } from "../src/kernel/engine";
setOC(await (opencascade as unknown as () => Promise<any>)());

const XY = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] };
const FRONT = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, -1, 0] };
const sk = (id: string, entities: any[], plane: any = XY) => ({ id, name: id, type: "sketch", plane, entities, constraints: [] });
const box = [sk("s", [{ id: "r", kind: "rect", center: [0, 0], w: 40, h: 30, rotation: 0 }]), { id: "b", name: "Extrude 01", type: "extrude", source: { kind: "profile", sketch: "s", regions: [{ c: [0, 0], a: 1200 }] }, distance: 20, mode: "new" }];
const cyl = [sk("c", [{ id: "k", kind: "circle", center: [0, 0], radius: 10 }]), { id: "y", name: "Extrude 01", type: "extrude", source: { kind: "profile", sketch: "c", regions: [{ c: [0, 0], a: 314.159 }] }, distance: 30, mode: "new" }];
const side = { body: "y", center: [0, 0, 15], normal: [-1, 0, 0], area: 1884.955592153876 };
const T = (op: any) => ({ id: "t", name: "T", type: "transform", bodies: ["b"], copy: false, op });
const rev = (cx: number) => [sk("s", [{ id: "r", kind: "rect", center: [cx, 5], w: 10, h: 10, rotation: 0 }], FRONT), { id: "v", name: "R", type: "revolve", source: { kind: "profile", sketch: "s", regions: [{ c: [cx, 5], a: 100 }] }, axis: { origin: [0, 0, 0], dir: [0, 0, 1] }, angle: 360, mode: "new" }];

// [name, steps, the message wanted (a part of it), or "" for "works"]
const cases: [string, any[], string][] = [
  ["pattern of 30000 (a typo for 30)", [...box, T({ kind: "linear", dir: [1, 0, 0], spacing: 50, count: 30000 })], "too many"],
  ["pattern spacing 0", [...box, T({ kind: "linear", dir: [1, 0, 0], spacing: 0, count: 5 })], "spacing is zero"],
  ["circular pattern angle 0", [...box, T({ kind: "circular", axis: { origin: [0, 0, 0], dir: [0, 0, 1] }, count: 4, angle: 0 })], "angle is zero"],
  ["pattern of 5 works", [...box, T({ kind: "linear", dir: [1, 0, 0], spacing: 50, count: 5 })], ""],
  ["revolve across the axis", rev(0), "crosses the axis"],
  ["revolve touching the axis works", rev(5), ""],
  ["thread pitch 0.05", [...cyl, { id: "th", name: "Th", type: "thread", face: side, pitch: 0.05 }], "too fine"],
  ["thread pitch 0", [...cyl, { id: "th", name: "Th", type: "thread", face: side, pitch: 0 }], "more than 0"],
];

let failed = 0;
for (const [name, feats, want] of cases) {
  const t0 = performance.now();
  const r: any = await regenerate(feats as any);
  const msg = r.errors.map((e: any) => e.message).join("; ");
  const ok = (want ? msg.toLowerCase().includes(want) : !msg) && performance.now() - t0 < 5000;
  if (!ok) failed++;
  console.log(ok ? "ok  " : "FAIL", name, msg ? `- "${msg}"` : "", `${Math.round(performance.now() - t0)}ms`);
}
process.exit(failed ? 1 : 0);
