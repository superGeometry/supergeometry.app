// Run: npx tsx tests/lamp.test.ts [out.json] - a desk arc lamp, made with the
// tools the other build tests don't use: a base revolved from a profile with a
// rounded (Fillet) top rim and a chamfered foot (Chamfer); a 12 mm stem swept
// along a path that rises, arches over and drops (Sweep); a shade revolved as
// a solid cone and hollowed open at the bottom (Shell); eight vents round the
// shade - one cylinder, Pattern Circular, Subtract; a bulb (Revolve).
import opencascade from "replicad-opencascadejs";
import { measureVolume, setOC } from "replicad";
import { readFileSync, writeFileSync } from "node:fs";
import { debugBodies, regenerate } from "../src/kernel/engine";
import { healthOf, isHealthy } from "../src/kernel/repair";
import { arrangement, regionRef } from "../src/sketch/regions";
import type { Vec3 } from "../src/doc/types";

setOC(await (opencascade as unknown as () => Promise<any>)());
let failed = 0;
const check = (name: string, ok: boolean, info = "") => {
  if (!ok) failed++;
  console.log(ok ? "ok  " : "FAIL", name, info);
};

let n = 0;
const id = () => `e${n++}`;
const XZ = { origin: [0, 0, 0] as Vec3, normal: [0, -1, 0] as Vec3, xDir: [1, 0, 0] as Vec3 }; // u = x, v = z
const XY = (z = 0) => ({ origin: [0, 0, z] as Vec3, normal: [0, 0, 1] as Vec3, xDir: [1, 0, 0] as Vec3 });
const poly = (pts: number[][]) => ({ id: id(), kind: "polyline", closed: true, points: pts });
const all = (es: any[]) => arrangement(es).regions.map(regionRef);
const Z: Vec3 = [0, 0, 1];

const feats: any[] = [];
const errs = (r: any) => r.errors.map((e: any) => `${feats.find((f) => f.id === e.featureId)?.name ?? e.featureId}: ${e.message}`).join("; ");

// 1. The base: a profile turned about Z (Revolve).
const baseProfile = [poly([[0, 0], [60, 0], [60, 10], [50, 22], [14, 26], [0, 26]])];
feats.push({ id: "sBase", name: "Base profile", type: "sketch", plane: XZ, entities: baseProfile });
feats.push({ id: "lamp", name: "Base", type: "revolve", source: { kind: "profile", sketch: "sBase", regions: all(baseProfile) }, axis: { origin: [0, 0, 0], dir: Z }, angle: 360, mode: "new" });

// 2. Its rims: the edge where the side meets the top slope rounded (Fillet 4),
//    the foot's edge bevelled (Chamfer 1.5). Edges are named by where they are.
await regenerate(feats);
const edgeAt = (body: string, r: number, z: number) => {
  const e = (debugBodies().get(body) as any).edges.find((e: any) => {
    const p = e.pointAt(0.5).toTuple();
    return Math.abs(Math.hypot(p[0], p[1]) - r) < 1e-3 && Math.abs(p[2] - z) < 1e-3;
  });
  if (!e) throw new Error(`no edge at r ${r}, z ${z}`);
  return { body, mid: e.pointAt(0.5).toTuple(), dir: e.tangentAt(0.5).toTuple(), length: e.length };
};
const vBase = Math.abs(measureVolume(debugBodies().get("lamp")!));
feats.push({ id: "fil", name: "Round the rim", type: "fillet", edges: [edgeAt("lamp", 60, 10)], radius: 4 });
feats.push({ id: "cha", name: "Bevel the foot", type: "chamfer", edges: [edgeAt("lamp", 60, 0)], radius: 1.5 });

// 3. The stem: a 12 mm circle swept along a path up from the base, arching
//    over to 80 mm across and down into the shade (Sweep, joined to the base).
const path = [
  { id: "p1", kind: "line", a: [0, 20], b: [0, 180] },
  { id: "p2", kind: "arc", a: [0, 180], m: [40, 220], b: [80, 180] },
  { id: "p3", kind: "line", a: [80, 180], b: [80, 165] },
];
feats.push({ id: "sPath", name: "Stem path", type: "sketch", plane: XZ, entities: path });
const stemProfile = [{ id: id(), kind: "circle", center: [0, 0], radius: 6 }];
feats.push({ id: "sStem", name: "Stem profile", type: "sketch", plane: XY(20), entities: stemProfile });
feats.push({ id: "stem", name: "Stem", type: "sweep", source: { kind: "profile", sketch: "sStem", regions: all(stemProfile) }, path: { kind: "sketch", sketch: "sPath", entities: ["p1", "p2", "p3"] }, mode: "join", target: "lamp" });

// 4. The shade: a cone turned about the hanging line (x = 80), then hollowed,
//    2 mm, open at the bottom (Shell). A socket inside holds the bulb.
const shadeProfile = [poly([[80, 165], [92, 165], [125, 110], [80, 110]])];
feats.push({ id: "sShade", name: "Shade profile", type: "sketch", plane: XZ, entities: shadeProfile });
const hang = { origin: [80, 0, 0] as Vec3, dir: Z };
feats.push({ id: "shade", name: "Shade", type: "revolve", source: { kind: "profile", sketch: "sShade", regions: all(shadeProfile) }, axis: hang, angle: 360, mode: "new" });
await regenerate(feats);
const vCone = Math.abs(measureVolume(debugBodies().get("shade")!));
const bottom = (debugBodies().get("shade") as any).faces.find((f: any) => f.normalAt().z < -0.99);
feats.push({ id: "hollow", name: "Hollow the shade", type: "shell", body: "shade", faces: [{ body: "shade", center: bottom.center.toTuple(), normal: [0, 0, -1], area: Math.PI * 45 * 45 }], thickness: 2 });
const socket = [{ id: id(), kind: "circle", center: [80, 0], radius: 9 }];
feats.push({ id: "sSock", name: "Socket", type: "sketch", plane: XY(147), entities: socket });
feats.push({ id: "sock", name: "Socket", type: "extrude", source: { kind: "profile", sketch: "sSock", regions: all(socket) }, distance: 17, mode: "join", target: "shade" });

// 5. Vents: one cylinder through the shade's wall near the top (from just past the
//    socket, so only the wall is cut), eight of them
//    round the hanging line (Pattern Circular), cut out (Subtract).
const vent = [{ id: id(), kind: "circle", center: [0, 152], radius: 2.5 }];
feats.push({ id: "sVent", name: "Vent", type: "sketch", plane: { origin: [92, 0, 0], normal: [1, 0, 0], xDir: [0, 1, 0] }, entities: vent });
feats.push({ id: "vent", name: "Vent", type: "extrude", source: { kind: "profile", sketch: "sVent", regions: all(vent) }, distance: 30, mode: "new" });
feats.push({ id: "pat", name: "Vents round", type: "transform", bodies: ["vent"], copy: true, op: { kind: "circular", axis: hang, count: 8, angle: 360 } });
feats.push({ id: "cutVents", name: "Cut the vents", type: "boolean", op: "subtract", target: "shade", tools: ["vent", ...Array.from({ length: 7 }, (_, k) => `pat:vent:${k}`)] });

// 6. The bulb: a half disc turned about the hanging line (Revolve).
const bulb = [{ id: "b1", kind: "arc", a: [80, 112], m: [94, 126], b: [80, 140] }, { id: "b2", kind: "line", a: [80, 140], b: [80, 112] }];
feats.push({ id: "sBulb", name: "Bulb profile", type: "sketch", plane: XZ, entities: bulb });
feats.push({ id: "bulb", name: "Bulb", type: "revolve", source: { kind: "profile", sketch: "sBulb", regions: all(bulb) }, axis: hang, angle: 360, mode: "new" });

const code: Record<string, number> = {};
const t0 = Date.now();
const r: any = await regenerate(feats);
const ms = Date.now() - t0;
check("every step builds", !r.errors.length, errs(r));
const lamp = debugBodies().get("lamp"), shade = debugBodies().get("shade"), bulbS = debugBodies().get("bulb");
check("three clean solids: lamp (base + stem), shade, bulb", r.bodies.length === 3 && [lamp, shade, bulbS].every((s) => !!s && isHealthy(healthOf(s!))), `${r.bodies.map((b: any) => b.id).join(", ")} in ${ms} ms`);
if (lamp && shade && bulbS) {
  const bb = [lamp, shade, bulbS].map((s) => s.boundingBox.bounds);
  const lo = [0, 1, 2].map((k) => Math.min(...bb.map((b) => b[0][k])));
  const hi = [0, 1, 2].map((k) => Math.max(...bb.map((b) => b[1][k])));
  check("stands on the ground, 226 tall (the arch's top), 185 across (base to shade)", Math.abs(lo[2]) < 1e-6 && Math.abs(hi[2] - 226) < 0.5 && Math.abs(hi[0] - lo[0] - 185) < 0.5, [0, 1, 2].map((k) => (hi[k] - lo[k]).toFixed(1)).join(" × "));
  const vs = Math.abs(measureVolume(shade));
  check("the shade is hollow (a thin cone, not a solid one)", vs < vCone * 0.25, `${(vs / 1000).toFixed(1)} cm³ of a ${(vCone / 1000).toFixed(1)} cm³ cone`);
  // The vents: the shade with and without the Subtract.
  await regenerate(feats.filter((f) => f.id !== "cutVents"));
  const before = Math.abs(measureVolume(debugBodies().get("shade")!));
  await regenerate(feats);
  const holes = before - vs;
  check("eight vents cut through the wall (each about π·2.5²·2.4 mm³)", holes > 8 * Math.PI * 2.5 ** 2 * 1.8 && holes < 8 * Math.PI * 2.5 ** 2 * 3.5, `${holes.toFixed(1)} mm³ taken out`);
  const vb = Math.abs(measureVolume(bulbS));
  check("the bulb: a 28 mm ball", Math.abs(vb - (4 / 3) * Math.PI * 14 ** 3) < 1, `${vb.toFixed(1)} mm³`);
  const vLamp = Math.abs(measureVolume(lamp));
  Object.assign(code, { lamp: vLamp, shade: vs, bulb: vb });
  check("base rounded and bevelled, stem joined (more than the base alone)", vLamp > vBase && Math.abs(measureVolume((lamp as any).intersect(shade))) < 1, `${(vLamp / 1000).toFixed(1)} cm³ (base alone ${(vBase / 1000).toFixed(1)})`);
  check("the bulb hangs free inside the shade", Math.abs(measureVolume((bulbS as any).intersect(shade))) < 1e-6);
}
// The same lamp built by hand on a phone-sized screen, as a beginner would
// (tests/fixtures/lamp-hand.json), and it has to come out the same: the base
// outline as lines typed across / up (60, up 10, in 10 up 12, in 36 up 4,
// in 14, then tapped shut), tapped, "Revolve instead" about Z, rim and foot
// rounded and bevelled; the stem path from the base's top as a typed length,
// an arch through three taps and 15 down, swept in one tap (the whole run);
// the shade as four lines from the stem's end turned about its side, shelled
// open at the bottom, a socket pushed down from its inside top; one vent on an
// offset plane, Pattern Circular round the shade's rim, Whole Pattern +
// Subtract; the bulb a half disc from the socket's centre; colours picked with
// Custom. No value worked out by hand.
{
  const hand = JSON.parse(readFileSync(new URL("./fixtures/lamp-hand.json", import.meta.url), "utf8")).features;
  const rh: any = await regenerate(hand);
  check("by hand: every step builds", !rh.errors.length, rh.errors.map((e: any) => `${hand.find((f: any) => f.id === e.featureId)?.name}: ${e.message}`).join("; "));
  const hs = rh.bodies.map((b: any) => debugBodies().get(b.id)!);
  check("by hand: three clean solids (lamp, shade, bulb)", hs.length === 3 && hs.every((x: any) => isHealthy(healthOf(x))), `${hs.length} bodies`);
  const bb = hs.map((s: any) => s.boundingBox.bounds);
  const lo = [0, 1, 2].map((k) => Math.min(...bb.map((b: any) => b[0][k])));
  const hi = [0, 1, 2].map((k) => Math.max(...bb.map((b: any) => b[1][k])));
  check("by hand: the same size as by code (226 tall, 185 across)", Math.abs(lo[2]) < 1e-6 && Math.abs(hi[2] - 226) < 0.5 && Math.abs(hi[0] - lo[0] - 185) < 0.5, [0, 1, 2].map((k) => (hi[k] - lo[k]).toFixed(1)).join(" × "));
  const [hLamp, hShade, hBulb] = ["revolve-mw5m45n0-klet", "revolve-mw5m6fdt-i3k2", "revolve-mw5maqal-2i3i"].map((id) => debugBodies().get(id)!);
  const vs = Math.abs(measureVolume(hShade));
  const cutAt = hand.findIndex((f: any) => f.type === "boolean");
  await regenerate(hand.slice(0, cutAt));
  const holes = Math.abs(measureVolume(debugBodies().get("revolve-mw5m6fdt-i3k2")!)) - vs;
  await regenerate(hand);
  check("by hand: shade hollow, eight vents through its wall", vs < vCone * 0.25 && holes > 8 * Math.PI * 2.5 ** 2 * 1.8 && holes < 8 * Math.PI * 2.5 ** 2 * 3.5, `${(vs / 1000).toFixed(1)} cm³, ${holes.toFixed(1)} mm³ of vents`);
  const vb = Math.abs(measureVolume(hBulb));
  check("by hand: the bulb a 28 mm ball hanging free on the shade's axis", Math.abs(vb - (4 / 3) * Math.PI * 14 ** 3) < 1 && Math.abs(measureVolume((hBulb as any).intersect(hShade))) < 1e-6 && Math.abs(hBulb.boundingBox.center[0] - 80) < 1e-6, `${vb.toFixed(1)} mm³`);
  const vLampHand = Math.abs(measureVolume(hLamp));
  const touchShade = Math.abs(measureVolume((hLamp as any).intersect(hShade)));
  await regenerate(hand.slice(0, hand.findIndex((f: any) => f.type === "sweep")));
  const vBaseHand = Math.abs(measureVolume(debugBodies().get("revolve-mw5m45n0-klet")!));
  await regenerate(hand);
  check("by hand: stem joined to the base, clear of the shade", vLampHand > vBaseHand + 15000 && touchShade < 1, `${(vLampHand / 1000).toFixed(1)} cm³ (base alone ${(vBaseHand / 1000).toFixed(1)})`);
  // The same as by code, part by part (volumes to 0.1 %) and colour by colour.
  const same = [["lamp", vLampHand], ["shade", vs], ["bulb", vb]].map(([k, v]) => [k, v, code[k as string]] as [string, number, number]);
  check("by hand: each part the same as by code", same.every(([, h, c]) => Math.abs(h - c) < c * 1e-3), same.map(([k, h, c]) => `${k} ${(h / 1000).toFixed(2)} / ${(c / 1000).toFixed(2)} cm³`).join(", "));
  const hc = JSON.parse(readFileSync(new URL("./fixtures/lamp-hand.json", import.meta.url), "utf8")).colors;
  check("by hand: the same colours", hc["revolve-mw5m45n0-klet"] === "#2f3a45" && hc["revolve-mw5m6fdt-i3k2"] === "#d9a441" && hc["revolve-mw5maqal-2i3i"] === "#fff4c8");
}

// The helpers the hand build leaned on.
{
  const { chainThrough, circleAxis } = await import("../src/tools/slots");
  check("a tap on one curve of a path takes the whole joined run, in order", JSON.stringify(chainThrough(path as any, "p2")) === JSON.stringify(["p1", "p2", "p3"]));
  const branch = [...path, { id: "p4", kind: "line", a: [80, 180], b: [120, 180] }];
  check("…stopping where curves branch", JSON.stringify(chainThrough(branch as any, "p1")) === JSON.stringify(["p1", "p2"]));
  const ax = circleAxis([125, 0, 110], [35, 0, 110], [125, 0, 110], [0, -1, 0])!;
  check("a round edge gives the line through its centre", Math.hypot(ax.origin[0] - 80, ax.origin[1], ax.origin[2] - 110) < 1e-9 && Math.abs(Math.abs(ax.dir[2]) - 1) < 1e-9);
  const arcAx = circleAxis([0, 0, 0], [40, 0, 40], [80, 0, 0], [1, 0, 0])!;
  check("…and an arc the line through its centre", Math.hypot(arcAx.origin[0] - 40, arcAx.origin[1], arcAx.origin[2]) < 1e-9 && Math.abs(Math.abs(arcAx.dir[1]) - 1) < 1e-9);
}

if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify({ format: "super", version: 2, name: "Arc lamp", features: feats, variables: [], views: [], units: "mm", hidden: feats.filter((f) => f.type === "sketch").map((f) => f.id), pins: [], names: { lamp: "Lamp", shade: "Shade", bulb: "Bulb" }, colors: { lamp: "#2f3a45", shade: "#d9a441", bulb: "#fff4c8" } }));
process.exit(failed ? 1 : 0);
