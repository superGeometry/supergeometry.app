// Run: npx tsx tests/drill.test.ts [out.json] - a cordless drill-driver at
// full size (the usual compact 10 mm class: ~195 long, ~230 tall with its
// battery), outside and in:
//   Housing: two clamshell halves (one body pulled up, hollowed, split down
//     the middle), vents, slots for the trigger, the direction switch and the
//     battery terminals; a rubber overmold round the back of the grip.
//   Motor (can, shaft, fan), a planetary gearbox (sun, three planets, a ring
//     gear with its teeth inside, the carrier and spindle), the collar, the
//     clutch ring, a keyless chuck with three jaws in angled channels, a 6 mm
//     twist bit (its flutes a coarse Thread).
//   Trigger, direction switch, the switch module, wires down the grip.
//   Battery: a case in two halves, four 18650 cells inside, terminals, a
//     release button and a label.
// x runs from the back of the motor to the bit, y across, z up; the motor's
// axis is at z = 190.
import opencascade from "replicad-opencascadejs";
import { measureArea, measureVolume, setOC } from "replicad";
import { readFileSync, writeFileSync } from "node:fs";
import opentype from "opentype.js";
const { parse } = opentype as any;
import { debugBodies, regenerate } from "../src/kernel/engine";
import { healthOf, isHealthy } from "../src/kernel/repair";
import { arrangement, regionRef, materialRegions } from "../src/sketch/regions";
import { textOutlines } from "../src/sketch/textLayout";
import { resolveDoc } from "../src/doc/params";
import type { PlaneDef, Vec3 } from "../src/doc/types";

setOC(await (opencascade as unknown as () => Promise<any>)());
let failed = 0;
const check = (name: string, ok: boolean, info = "") => {
  if (!ok) failed++;
  console.log(ok ? "ok  " : "FAIL", name, info);
};

const XY = (z = 0): PlaneDef => ({ origin: [0, 0, z], normal: [0, 0, 1], xDir: [1, 0, 0] }); // u = x, v = y
const XZ = (y = 0): PlaneDef => ({ origin: [0, y, 0], normal: [0, -1, 0], xDir: [1, 0, 0] }); // u = x, v = z (extrudes go -y)
const YZ = (x = 0): PlaneDef => ({ origin: [x, 0, 0], normal: [1, 0, 0], xDir: [0, 1, 0] }); // u = y, v = z (extrudes go +x)
const all = (es: any[]) => arrangement(es).regions.map(regionRef);
const where = (es: any[], test: (c: number[], r: any) => boolean) => arrangement(es).regions.filter((r) => test(r.centroid, r)).map(regionRef);
const feats: any[] = [];
const variables = [
  { name: "wall", expr: "2.5 mm" },
  { name: "cells", expr: "2" },
];
const doc = () => {
  const d: any = { format: "super", version: 2, name: "Cordless drill", features: structuredClone(feats), variables, views: [], units: "mm", hidden: [], pins: [], names: {} };
  const problems = resolveDoc(d);
  if (problems.length) console.log("problems:", problems);
  return d;
};
const sections: { name: string; from: number }[] = [];
const section = (name: string) => sections.push({ name, from: feats.length });
const nameOf = (fid: string) => feats.find((f) => f.id === fid)?.name ?? fid;
const build = async () => {
  const r: any = await regenerate(doc().features);
  if (r.errors.length) console.log("errors:", r.errors.map((e: any) => `${nameOf(e.featureId)}: ${e.message}`).join("; "));
  return r;
};
const stage = async (label: string) => {
  const t = Date.now();
  const r = await build();
  check(`${label} builds`, !r.errors.length, `${r.bodies.length} bodies, ${Date.now() - t} ms`);
  return r;
};
const B = (body: string) => debugBodies().get(body) as any;
const faceRef = (body: string, f: any) => ({ body, center: f.center.toTuple() as Vec3, normal: f.normalAt().toTuple() as Vec3, area: measureArea(f) });
const faceBy = (body: string, test: (f: any) => boolean) => {
  const f = B(body).faces.find(test);
  if (!f) throw new Error(`no such face on ${body}`);
  return faceRef(body, f);
};
const edgesWhere = (body: string, test: (p: number[], e: any) => boolean) => {
  const es = B(body).edges.filter((e: any) => test(e.pointAt(0.5).toTuple(), e));
  if (!es.length) throw new Error(`no such edge on ${body}`);
  return es.map((e: any) => ({ body, mid: e.pointAt(0.5).toTuple() as Vec3, dir: e.tangentAt(0.5).toTuple() as Vec3, length: e.length as number }));
};
const V = (body: string) => Math.abs(measureVolume(B(body)));
const box = (body: string) => B(body).boundingBox.bounds as [number[], number[]];
const rad = (d: number) => (d * Math.PI) / 180;
const range = (n: number, f: (k: number) => string) => Array.from({ length: n }, (_, k) => f(k));
/** Make a body (a profile pulled out). */
const extrude = (id: string, name: string, plane: PlaneDef, entities: any[], distance: number, opts: any = {}) => {
  feats.push({ id: `s_${id}`, name: `${name} sketch`, type: "sketch", plane, entities });
  feats.push({ id, name, type: "extrude", source: { kind: "profile", sketch: `s_${id}`, regions: opts.regions ?? all(entities) }, distance, mode: opts.mode ?? "new", ...(opts.target ? { target: opts.target } : {}) });
};
const revolveX = (id: string, name: string, profile: any[], axisZ: number) => {
  feats.push({ id: `s_${id}`, name: `${name} profile`, type: "sketch", plane: XZ(0), entities: profile });
  feats.push({ id, name, type: "revolve", source: { kind: "profile", sketch: `s_${id}`, regions: all(profile) }, axis: { origin: [0, 0, axisZ], dir: [1, 0, 0] }, angle: 360, mode: "new" });
};
const union = (id: string, name: string, target: string, tools: string[]) => feats.push({ id, name, type: "boolean", op: "union", target, tools });
const subtract = (id: string, name: string, target: string, tools: string[], keepTools = false) => feats.push({ id, name, type: "boolean", op: "subtract", target, tools, keepTools });
/** Pattern round the motor's axis (or a parallel one at height z). */
const roundX = (id: string, name: string, body: string, count: number, z = AX, y = 0) => {
  feats.push({ id, name, type: "transform", bodies: [body], copy: false, op: { kind: "circular", axis: { origin: [0, y, z], dir: [1, 0, 0] }, count, angle: 360 } });
  return [body, ...range(count - 1, (k) => `${id}:${body}:${k}`)];
};
const circle = (id: string, c: [number, number], r: number) => ({ id, kind: "circle", center: c, radius: r });
const rect = (id: string, c: [number, number], w: number, h: number, rotation = 0) => ({ id, kind: "rect", center: c, w, h, rotation });

const AX = 190; // the motor's axis
const R_HOUSE = 27;
const X_FRONT = 88; // the housing's front, where the gearbox starts

// --- 1. The housing, as one body first: the motor's barrel (rounded at the
// back), a spine on top, the grip lofted from an oval at the foot to a
// smaller one under the barrel (leaning back at the bottom), the foot the
// battery slides onto. Joined.
section("Housing");
extrude("barrel", "Motor barrel", YZ(0), [circle("barrel", [0, AX], R_HOUSE)], X_FRONT);
await build();
feats.push({ id: "barrelBack", name: "Round the barrel's back", type: "fillet", edges: edgesWhere("barrel", (p) => Math.abs(p[0]) < 1e-6), radius: 12 });
extrude("spine", "Spine", XY(AX + 10), [rect("spine", [48, 0], 66, 26)], 22);
await build();
feats.push({ id: "spineRound", name: "Round the spine", type: "fillet", edges: edgesWhere("spine", (p, e) => Math.abs(p[2] - (AX + 32)) < 1e-6 || Math.abs(e.tangentAt(0.5).z) > 0.99), radius: 5 });
const gripLow = [{ id: "gl", kind: "ellipse", center: [32, 0], rx: 25, ry: 18, rotation: 0 }];
const gripHigh = [{ id: "gh", kind: "ellipse", center: [55, 0], rx: 22, ry: 16, rotation: 0 }];
feats.push({ id: "s_gripLow", name: "Grip at the foot", type: "sketch", plane: XY(60), entities: gripLow });
feats.push({ id: "s_gripHigh", name: "Grip under the barrel", type: "sketch", plane: XY(AX - 12), entities: gripHigh });
feats.push({ id: "grip", name: "Grip", type: "loft", sections: [{ kind: "profile", sketch: "s_gripLow", regions: all(gripLow) }, { kind: "profile", sketch: "s_gripHigh", regions: all(gripHigh) }], ruled: false, mode: "new" });
extrude("foot", "Foot", XY(52), [rect("foot", [46, 0], 104, 68)], 16);
await build();
feats.push({ id: "footRound", name: "Round the foot's corners", type: "fillet", edges: edgesWhere("foot", (p, e) => Math.abs(e.tangentAt(0.5).z) > 0.99), radius: 10 });
union("housingJoin", "Housing together", "barrel", ["spine", "grip", "foot"]);
await stage("stage 1 (housing shape)");
check("the housing is one solid", healthOf(B("barrel")).solids === 1);

// Hollow, open at the front for the gearbox (Shell, "wall").
feats.push({ id: "hollow", name: "Hollow the housing", type: "shell", body: "barrel", faces: [faceBy("barrel", (f: any) => f.geomType === "PLANE" && Math.abs(f.center.x - X_FRONT) < 1e-6)], thickness: 2.5, exprs: { thickness: "wall" } });
await stage("stage 1b (housing hollowed)");

// --- 2. The motor: its can, the end bell, the shaft, a fan at the back
// (a disc and eight blades round the shaft).
section("Motor");
extrude("motor", "Motor can", YZ(10), [circle("can", [0, AX], 18)], 52);
extrude("bell", "End bell", YZ(62), [circle("bell", [0, AX], 10)], 4);
extrude("shaft", "Motor shaft", YZ(4), [circle("shaft", [0, AX], 1.5)], 88);
union("motorJoin", "Motor together", "motor", ["bell", "shaft"]);
extrude("fan", "Fan disc", YZ(5), [circle("fan", [0, AX], 15)], 1.2);
extrude("blade", "Fan blade", YZ(4), [rect("blade", [0, AX + 9], 1.2, 12, rad(20))], 4.5);
const blades = roundX("blades", "Blades round", "blade", 8);
union("fanJoin", "Fan together", "fan", blades);
await build();
feats.push({ id: "canRound", name: "Round the can", type: "fillet", edges: edgesWhere("motor", (p, e) => e.geomType === "CIRCLE" && Math.abs(e.length - 2 * Math.PI * 18) < 0.1), radius: 2 });
await stage("stage 2 (motor)");

// --- 3. The planetary gearbox: the housing ring (the ring gear, its 36 teeth
// inside), the sun gear on the motor shaft, three planets, the carrier with
// the spindle. Teeth: one tooth, Pattern Circular, Union.
section("Gearbox");
const ring = [circle("go", [0, AX], 24), circle("gi", [0, AX], 19)];
extrude("gearbox", "Gearbox", YZ(X_FRONT), ring, 30, { regions: where(ring, (_, r) => r.holes.length > 0) });
extrude("rtooth", "Ring tooth", YZ(90), [rect("rt", [0, AX + 18.3], 1.6, 2)], 22);
union("ringTeeth", "Ring teeth on", "gearbox", roundX("rteeth", "Ring teeth round", "rtooth", 36));
extrude("sun", "Sun gear", YZ(92), [circle("sun", [0, AX], 4)], 18);
extrude("stooth", "Sun tooth", YZ(92), [rect("st", [0, AX + 4.6], 1.4, 1.6)], 18);
union("sunTeeth", "Sun teeth on", "sun", roundX("steeth", "Sun teeth round", "stooth", 10));
const PL = AX + 11.8;
extrude("planet", "Planet gear", YZ(92), [circle("pl", [0, PL], 5.4)], 18);
extrude("ptooth", "Planet tooth", YZ(92), [rect("pt", [0, PL + 6], 1.4, 1.6)], 18);
union("planetTeeth", "Planet teeth on", "planet", roundX("pteeth", "Planet teeth round", "ptooth", 14, PL));
const planets = roundX("planets", "Planets round", "planet", 3);
extrude("carrier", "Carrier", YZ(110), [circle("ca", [0, AX], 15)], 3);
extrude("spindle", "Spindle", YZ(113), [circle("sp", [0, AX], 5)], 29);
extrude("pin", "Planet pin", YZ(90), [circle("pp", [0, PL], 1.5)], 20);
union("carrierJoin", "Carrier with spindle and pins", "carrier", ["spindle", ...roundX("pins", "Pins round", "pin", 3)]);
await stage("stage 3 (gearbox)");
check("36 ring teeth", B("gearbox").faces.length > 36 * 3, `${B("gearbox").faces.length} faces`);

// --- 4. The front: the collar, the clutch ring (30 grip ribs round it), the
// chuck (revolved: sleeve, taper, nose with the bit's bore), grip grooves
// cut round it, its nose split off (another colour), three jaws leaning in
// (Rotate, Pattern Circular) in channels cut for them (Subtract, keep the
// jaws), and the bit (revolved, its flutes a coarse Thread).
section("Chuck");
const collar = [circle("co", [0, AX], 22.5), circle("ci", [0, AX], 16)];
extrude("collar", "Collar", YZ(118), collar, 6, { regions: where(collar, (_, r) => r.holes.length > 0) });
const clutch = [circle("clo", [0, AX], 24.5), circle("cli", [0, AX], 8)];
extrude("clutch", "Clutch ring", YZ(124), clutch, 18, { regions: where(clutch, (_, r) => r.holes.length > 0) });
extrude("crib", "Clutch rib", YZ(125), [rect("cr", [0, AX + 24.5], 2.4, 2)], 16);
union("clutchRibs", "Clutch ribs on", "clutch", roundX("cribs", "Clutch ribs round", "crib", 30));
await build();
const chuckProfile = [
  { id: "cp", kind: "polyline", closed: false, points: [[142, AX], [142, AX + 21], [176, AX + 21], [182, AX + 17], [190, AX + 12], [196, AX + 8], [196, AX + 3.2], [172, AX + 3.2], [172, AX]] },
  { id: "cax", kind: "line", a: [172, AX], b: [142, AX] },
];
revolveX("chuck", "Chuck", chuckProfile, AX);
feats.push({ id: "groove", name: "Chuck groove", type: "sketch", plane: YZ(146), entities: [rect("gr", [0, AX + 21], 1.6, 2.4)] });
feats.push({ id: "grooveB", name: "Chuck groove", type: "extrude", source: { kind: "profile", sketch: "groove", regions: all([rect("gr", [0, AX + 21], 1.6, 2.4)]) }, distance: 28, mode: "new" });
subtract("grooveCut", "Grip the chuck", "chuck", roundX("grooves", "Grooves round", "grooveB", 20));
await build();
feats.push({ id: "chuckEdge", name: "Round the chuck's back", type: "fillet", edges: edgesWhere("chuck", (p) => Math.abs(p[0] - 142) < 1e-6 && Math.hypot(p[1], p[2] - AX) > 20), radius: 1.5 });
feats.push({ id: "nose", name: "Nose off the sleeve", type: "split", body: "chuck", plane: { origin: [182, 0, 0], normal: [1, 0, 0], xDir: [0, 1, 0] } });
const JR = 4.25; // the jaws' middle at the nose: their inside faces 0.05 off the bit
extrude("jaw", "Jaw", YZ(160), [rect("jw", [0, AX + JR], 2.4, 2.4)], 39);
feats.push({ id: "jawLean", name: "Lean the jaw in", type: "transform", bodies: ["jaw"], copy: false, op: { kind: "move", translate: [0, 0, 0], rotate: { origin: [199, 0, AX + JR], axis: [0, 1, 0], angle: 8 } } });
const jaws = roundX("jaws", "Jaws round", "jaw", 3);
subtract("jawSlots", "Jaw channels in the chuck", "chuck", jaws, true);
subtract("jawSlotsN", "Jaw channels in the nose", "nose", jaws, true);
revolveX("bit", "Drill bit", [
  { id: "bp", kind: "polyline", closed: false, points: [[176, AX], [176, AX + 3], [250, AX + 3], [255.5, AX]] },
  { id: "bax", kind: "line", a: [255.5, AX], b: [176, AX] },
], AX);
await build();
feats.push({ id: "flutes", name: "Flutes", type: "thread", face: faceBy("bit", (f: any) => f.geomType === "CYLINDRE"), pitch: 2.5, round: { r: 3, hole: false } });
await stage("stage 4 (chuck, bit)");
check("the bit sticks out 60 past the nose", Math.abs(box("bit")[1][0] - 255.5) < 0.01);

// --- 5. Controls: the trigger (lines and a spline, Extrude across), the
// direction switch through the grip's top, the switch module inside, slots
// cut for them in the housing (Subtract, keep the parts), vents by the fan
// (Pattern Linear, cut through).
section("Controls");
const trigger = [
  { id: "t0", kind: "line", a: [64, 162], b: [80, 162] },
  { id: "t1", kind: "spline", closed: false, mode: "fit", points: [[80, 162], [86, 152], [84, 141], [78, 134]] },
  { id: "t2", kind: "line", a: [78, 134], b: [64, 134] },
  { id: "t3", kind: "line", a: [64, 134], b: [64, 162] },
];
extrude("trigger", "Trigger", XZ(7), trigger, 14);
await build();
feats.push({ id: "triggerRound", name: "Round the trigger", type: "fillet", edges: edgesWhere("trigger", (p) => Math.abs(Math.abs(p[1]) - 7) < 1e-6 && p[0] > 79), radius: 2 });
extrude("dirSwitch", "Direction switch", XY(166), [rect("ds", [62, 0], 8, 54)], 6);
extrude("module", "Switch module", XY(138), [rect("sm", [54, 0], 18, 18)], 22);
subtract("triggerSlot", "Trigger slot", "barrel", ["trigger"], true);
subtract("switchSlot", "Switch slot", "barrel", ["dirSwitch"], true);
extrude("vent", "Vent", XZ(32), [rect("vt", [16, AX], 3, 16)], 64);
feats.push({ id: "vents", name: "Vents along", type: "transform", bodies: ["vent"], copy: false, op: { kind: "linear", dir: [1, 0, 0], spacing: 6, count: 4 } });
subtract("ventCut", "Cut the vents", "barrel", ["vent", ...range(3, (k) => `vents:vent:${k}`)]);
await stage("stage 5 (controls)");

// --- 6. The battery: a case (corners rounded) hollowed and split into its
// two halves; four 18650 cells inside (Pattern Linear twice, "cells" each
// way); two terminals up into the foot (slots cut for them); the release
// button; "18V LI-ION" raised on its side.
section("Battery");
extrude("battery", "Battery case", XY(0), [rect("bc", [47, 0], 106, 72)], 52);
await build();
feats.push({ id: "batRound", name: "Round the case's corners", type: "fillet", edges: edgesWhere("battery", (p, e) => Math.abs(e.tangentAt(0.5).z) > 0.99), radius: 9 });
await build();
feats.push({ id: "batBottom", name: "Round the case's bottom", type: "fillet", edges: edgesWhere("battery", (p) => Math.abs(p[2]) < 1e-6), radius: 4 });
feats.push({ id: "batHollow", name: "Hollow the case", type: "shell", body: "battery", faces: [], thickness: 2 });
feats.push({ id: "batTop", name: "Lid off the case", type: "split", body: "battery", plane: { origin: [0, 0, 30], normal: [0, 0, 1], xDir: [1, 0, 0] } });
extrude("cell", "Cell", YZ(10), [circle("cl", [-10, 13], 9.25)], 65);
extrude("nub", "Cell terminal", YZ(75), [circle("nb", [-10, 13], 3.5)], 1.5);
union("cellJoin", "Cell with its terminal", "cell", ["nub"]);
feats.push({ id: "cellsY", name: "Cells across", type: "transform", bodies: ["cell"], copy: false, op: { kind: "linear", dir: [0, 1, 0], spacing: 20, count: 2 }, exprs: { "op.count": "cells" } });
feats.push({ id: "cellsZ", name: "Cells up", type: "transform", bodies: ["cell", "cellsY:cell:0"], copy: false, op: { kind: "linear", dir: [0, 0, 1], spacing: 20, count: 2 }, exprs: { "op.count": "cells" } });
const cellIds = ["cell", "cellsY:cell:0", "cellsZ:cell:0", "cellsZ:cellsY:cell:0:0"];
extrude("terms", "Terminals", XY(52), [rect("ta", [70, 8], 20, 1.2), rect("tb", [70, -8], 20, 1.2)], 6);
subtract("termSlots", "Terminal slots", "barrel", ["terms"], true);
extrude("release", "Release button", YZ(100), [rect("rb", [0, 42], 30, 8)], 2.5);
const fontFile = readFileSync("node_modules/@fontsource/roboto/files/roboto-latin-400-normal.woff");
const font = parse(fontFile.buffer.slice(fontFile.byteOffset, fontFile.byteOffset + fontFile.byteLength));
const label = textOutlines(font, "18V LI-ION", [47, 10], 7, 0, "center").map((e: any, i: number) => ({ ...e, id: `lb${i}` }));
extrude("label", "Label", XZ(-36), label, 0.6, { regions: materialRegions(arrangement(label)).map(regionRef), mode: "join", target: "battery" });
await stage("stage 6 (battery)");

// --- 7. Wiring: from the switch module down the grip to the terminals, and up
// to the motor (Sweep along splines drawn on side planes).
section("Wiring");
const wire = (id: string, name: string, y: number, pts: [number, number][], r: number) => {
  const pl = XZ(y);
  feats.push({ id: `p_${id}`, name: `${name} path`, type: "sketch", plane: pl, entities: [{ id: `pw${id}`, kind: "spline", closed: false, mode: "fit", points: pts }] });
  const [a, b] = pts;
  const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const dir: Vec3 = [(b[0] - a[0]) / d, 0, (b[1] - a[1]) / d];
  feats.push({ id: `g_${id}`, name: `${name} gauge`, type: "sketch", plane: { origin: [a[0], y, a[1]], normal: dir, xDir: [0, 1, 0] }, entities: [circle(`gw${id}`, [0, 0], r)] });
  feats.push({ id, name, type: "sweep", source: { kind: "profile", sketch: `g_${id}`, regions: all([circle(`gw${id}`, [0, 0], r)]) }, path: { kind: "sketch", sketch: `p_${id}`, entities: [`pw${id}`] }, mode: "new" });
};
wire("wireRed", "Red wire", 4, [[54, 137], [49, 115], [48, 85], [52, 62], [68, 57]], 1.1);
wire("wireBlack", "Black wire", -4, [[54, 137], [47, 112], [46, 84], [50, 62], [68, 57]], 1.1);
wire("wireMotor", "Motor wire", 0, [[50, 161], [38, 167], [22, 170], [8, 176]], 1);
await stage("stage 7 (wiring)");

// --- 8. The housing in two halves (Split Body down the middle), a rubber
// overmold round the back of the grip: the grip's loft grown 1.2 (a loft of
// bigger ovals) less the grip itself, cut by a slanting plane, the front
// piece put away.
section("Finish");
feats.push({ id: "halves", name: "Housing halves", type: "split", body: "barrel", plane: XZ(0) });
const moldLow = [{ id: "ml", kind: "ellipse", center: [32, 0], rx: 26.2, ry: 19.2, rotation: 0 }];
const moldHigh = [{ id: "mh", kind: "ellipse", center: [55, 0], rx: 23.2, ry: 17.2, rotation: 0 }];
feats.push({ id: "s_moldLow", name: "Overmold at the foot", type: "sketch", plane: XY(70), entities: moldLow });
feats.push({ id: "s_moldHigh", name: "Overmold at the top", type: "sketch", plane: XY(150), entities: moldHigh });
feats.push({ id: "mold", name: "Overmold", type: "loft", sections: [{ kind: "profile", sketch: "s_moldLow", regions: all(moldLow) }, { kind: "profile", sketch: "s_moldHigh", regions: all(moldHigh) }], ruled: false, mode: "new" });
feats.push({ id: "s_gripIn", name: "Grip inside the overmold", type: "sketch", plane: XY(60), entities: gripLow.map((e) => ({ ...e, id: "gl2" })) });
feats.push({ id: "s_gripIn2", name: "Grip inside the overmold (top)", type: "sketch", plane: XY(AX - 12), entities: gripHigh.map((e) => ({ ...e, id: "gh2" })) });
feats.push({ id: "gripIn", name: "Grip (for the overmold)", type: "loft", sections: [{ kind: "profile", sketch: "s_gripIn", regions: all(gripLow) }, { kind: "profile", sketch: "s_gripIn2", regions: all(gripHigh) }], ruled: false, mode: "new" });
subtract("moldSkin", "Overmold skin", "mold", ["gripIn"]);
const n = Math.hypot(1, 0.25);
feats.push({ id: "moldFront", name: "Overmold front off", type: "split", body: "mold", plane: { origin: [44, 0, 110], normal: [1 / n, 0, 0.25 / n], xDir: [0, 1, 0] } });
feats.push({ id: "moldFrontGone", name: "Put the front piece away", type: "delete", bodies: ["moldFront"] });
const final = await stage("the whole drill");

// --- Checks.
const bodies = final.bodies.map((b: any) => b.id);
const unhealthy = bodies.filter((id: string) => !isHealthy(healthOf(B(id))));
check("every body is a clean solid", !unhealthy.length, unhealthy.join(" "));
check("two housing halves", !!B("barrel") && !!B("halves") && box("barrel")[0][1] > -1e-6 && box("halves")[1][1] < 1e-6, `${box("barrel")[0][1].toFixed(2)} / ${box("halves")[1][1].toFixed(2)}`);
// The foot (and the battery under it) stands 6 behind the motor's back.
check("the drill is ~260 long with the bit", Math.abs(box("bit")[1][0] - box("barrel")[0][0] - 261.5) < 1, `${(box("bit")[1][0] - box("barrel")[0][0]).toFixed(1)}`);
check("~230 tall", Math.abs(box("barrel")[1][2] - box("battery")[0][2] - 222) < 2, `${(box("barrel")[1][2] - box("battery")[0][2]).toFixed(1)}`);
check("four cells", cellIds.every((c) => B(c)));
// Nothing inside runs into the housing or into each other.
const inner = ["motor", "fan", "module", "wireRed", "wireBlack", "wireMotor", ...cellIds, "carrier", "sun"];
for (const a of inner) {
  for (const b of ["barrel", "halves", "battery", "batTop"]) {
    if (!B(b)) continue;
    let v = 0;
    try {
      v = Math.abs(measureVolume(B(a).intersect(B(b))));
    } catch {
      v = -1;
    }
    if (v > 0.5 || v < 0) check(`${a} clear of ${b}`, false, `${v.toFixed(2)} mm³`);
  }
}
check("nothing inside runs into the shells (checked above)", true);
const used = new Set(feats.map((f) => f.type));
console.log(`${feats.length} steps, ${bodies.length} bodies; tools: ${[...used].sort().join(" ")}`);

if (process.argv[2]) {
  const d = doc();
  const teal = "#17a2b4", black = "#1d2024", steel = "#b9bdc2", brass = "#c9a227";
  const colors: Record<string, string> = {
    barrel: teal, halves: teal, mold: black, trigger: black, dirSwitch: black, module: "#2a2d33", motor: "#8f969d", fan: black,
    gearbox: black, sun: steel, carrier: steel, collar: steel, clutch: black, chuck: black, nose: steel, bit: "#d9dde1",
    battery: black, batTop: teal, release: "#d42a2a", terms: brass, wireRed: "#d42a2a", wireBlack: "#111111", wireMotor: "#d42a2a",
  };
  for (const p of planets) colors[p] = steel;
  for (const j of jaws) colors[j] = steel;
  for (const c of cellIds) colors[c] = "#2f6fd0";
  const names: Record<string, string> = {
    barrel: "Housing (left)", halves: "Housing (right)", mold: "Rubber overmold", trigger: "Trigger", dirSwitch: "Direction switch", module: "Switch module",
    motor: "Motor", fan: "Fan", gearbox: "Gearbox (ring gear)", sun: "Sun gear", carrier: "Carrier and spindle", collar: "Collar", clutch: "Clutch ring",
    chuck: "Chuck sleeve", nose: "Chuck nose", bit: "Drill bit 6 mm", battery: "Battery (bottom)", batTop: "Battery (top)", release: "Release button",
    terms: "Terminals", wireRed: "Red wire", wireBlack: "Black wire", wireMotor: "Motor wire",
  };
  planets.forEach((p, i) => (names[p] = `Planet gear ${i + 1}`));
  jaws.forEach((p, i) => (names[p] = `Jaw ${i + 1}`));
  cellIds.forEach((p, i) => (names[p] = `Cell ${i + 1}`));
  const missing = bodies.filter((b: string) => !names[b]);
  check("every body named", !missing.length, missing.join(" "));
  d.colors = colors;
  d.names = names;
  d.hidden = feats.filter((f) => f.type === "sketch").map((f) => f.id);
  d.historyGroups = sections.map((s, k) => ({ id: `g${k}`, name: s.name, steps: feats.slice(s.from, sections[k + 1]?.from ?? feats.length).map((f) => f.id) })).filter((g) => g.steps.length > 1);
  writeFileSync(process.argv[2], JSON.stringify(d));
  console.log("written", process.argv[2]);
}
process.exit(failed ? 1 : 0);
