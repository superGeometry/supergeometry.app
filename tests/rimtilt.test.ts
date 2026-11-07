// Run: npx tsx tests/rimtilt.test.ts - Move Face tilting the rim a Shell
// leaves round its opening (a user's box: filleted, chamfered, shelled open on
// the chamfer, the rim pushed in twice). The rim is a flat face with a hole;
// tilting it failed at any angle (its region was cut into 11 cells by every
// neighbour's surface, and joining them failed). Now: its outline's region
// less its hole's.
import opencascade from "replicad-opencascadejs";
import { measureArea, measureVolume, setOC } from "replicad";
import { debugBodies, regenerate } from "../src/kernel/engine";
import { healthOf, isHealthy } from "../src/kernel/repair";

setOC(await (opencascade as unknown as () => Promise<any>)());
let failed = 0;
const check = (name: string, ok: boolean, info = "") => {
  if (!ok) failed++;
  console.log(ok ? "ok  " : "FAIL", name, info);
};
const rect = { id: "sk", name: "Sketch 01", type: "sketch", plane: { origin: [0, 0, 0], xDir: [0, 1, 0], normal: [1, 0, 0] }, entities: [{ id: "r", kind: "rect", center: [20, 25], w: 40, h: 50, rotation: 0 }] };
const B = "box";
const s2 = Math.SQRT1_2;
const base: any[] = [
  rect,
  { id: B, name: "Extrude 01", type: "extrude", source: { kind: "profile", sketch: "sk", regions: [{ c: [20, 25], a: 2000 }] }, distance: 28, mode: "auto" },
  { id: "f1", name: "Fillet 01", type: "fillet", edges: [{ body: B, mid: [14, 40, 50], dir: [1, 0, 0], length: 28 }], radius: 20 },
  { id: "c1", name: "Chamfer 01", type: "chamfer", edges: [{ body: B, mid: [14, 0, 50], dir: [1, 0, 0], length: 28 }], radius: 14 },
  { id: "s1", name: "Shell 01", type: "shell", body: B, faces: [{ body: B, center: [14, 7, 43], normal: [0, -s2, s2], area: 554.37 }], thickness: 5 },
  { id: "o1", name: "Offset Face 01", type: "extrude", source: { kind: "face", face: { body: B, center: [14, 7, 43], normal: [0, -s2, s2], area: 452.548 } }, distance: -3, mode: "auto", target: B },
  { id: "o2", name: "Offset Face 02", type: "extrude", source: { kind: "face", face: { body: B, center: [14, 9.1213, 40.8787], normal: [0, -s2, s2], area: 512.548 } }, distance: -9, mode: "auto", target: B },
];
const rim = { body: B, center: [14, 13.960626616153542, 32.99006386767639], normal: [0, -s2, s2], area: 632.652 };
await regenerate(base);
const v0 = Math.abs(measureVolume(debugBodies().get(B)!));
for (const angle of [14, -10, 3]) {
  const r: any = await regenerate([...base, { id: "m1", name: "Move Face 01", type: "moveFace", face: rim, translate: [0, 0, 0], rotate: { origin: rim.center, axis: [1, 0, 0], angle } }]);
  const s = debugBodies().get(B)!;
  const a = (angle * Math.PI) / 180;
  const want = [0, -s2 * Math.cos(a) - s2 * Math.sin(a), -s2 * Math.sin(a) + s2 * Math.cos(a)];
  const tilted = s.faces.filter((f) => f.geomType === "PLANE" && f.normalAt().toTuple().every((x, i) => Math.abs(x - want[i]) < 1e-6));
  const v = Math.abs(measureVolume(s));
  check(`rim tilted ${angle}°: builds, one clean solid`, !r.errors.length && isHealthy(healthOf(s)), r.errors.map((e: any) => e.message).join("; "));
  check("…the rim is one face at the new angle, still with its opening", tilted.length === 1 && tilted[0].clone().innerWires().length === 1, tilted.map((f) => measureArea(f).toFixed(1)).join(", "));
  check("…the walls just follow (volume within 10%)", Math.abs(v - v0) < v0 * 0.1, `${v0.toFixed(0)} → ${v.toFixed(0)}`);
}
console.log(failed ? `${failed} FAILED` : "all passed");
process.exit(failed ? 1 : 0);
