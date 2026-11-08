// Run: npx tsx tests/drill.test.ts [out.json] - a compact cordless drill-driver
// at full size (~206 long, ~231 tall with its battery), shaped after a photo of
// a teal and black one, outside and in:
//   Housing: sculpted from a side outline and a front outline (Intersect), its
//     edges rounded, hollowed, a black rear cap, two clamshell halves; a vent
//     grille in a frame, a label plate, the two-speed slider on top, an LED in
//     the foot; black rubber on the grip's back and front, a stripe down its side.
//   Motor (can, shaft, fan), a planetary gearbox (sun, three planets, a ring
//     gear with its teeth inside, the carrier and spindle), a notched silver
//     collar, the clutch ring with its numbers, a keyless chuck (two ribbed
//     sleeves, a silver nose) with three jaws closing to a point.
//   Trigger, direction switch, the switch module, wires down the grip.
//   Battery: a slide-on pack (black, a teal top, a sloped black front with the
//     red release button), hollow with four 18650 cells, terminals, a
//     "48V Lithium-ion" panel on its side.
// x runs from the back of the motor to the chuck, y across, z up; the motor's
// axis is at z = 202.
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

type P2 = [number, number];
const XY = (z = 0): PlaneDef => ({ origin: [0, 0, z], normal: [0, 0, 1], xDir: [1, 0, 0] }); // u = x, v = y
const XZ = (y = 0): PlaneDef => ({ origin: [0, y, 0], normal: [0, -1, 0], xDir: [1, 0, 0] }); // u = x, v = z (extrudes go -y)
const YZ = (x = 0): PlaneDef => ({ origin: [x, 0, 0], normal: [1, 0, 0], xDir: [0, 1, 0] }); // u = y, v = z (extrudes go +x)
/** The +y side, read from there: u = -x, v = z (extrudes go +y). */
const PY = (y: number): PlaneDef => ({ origin: [0, y, 0], normal: [0, 1, 0], xDir: [-1, 0, 0] });
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
const build = async (quiet = false) => {
  const r: any = await regenerate(doc().features);
  if (r.errors.length && !quiet) console.log("errors:", r.errors.map((e: any) => `${nameOf(e.featureId)}: ${e.message}`).join("; "));
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
const edgeRef = (body: string, e: any) => ({ body, mid: e.pointAt(0.5).toTuple() as Vec3, dir: e.tangentAt(0.5).toTuple() as Vec3, length: e.length as number });
const edgesWhere = (body: string, test: (p: number[], e: any) => boolean) => {
  const es = B(body).edges.filter((e: any) => test(e.pointAt(0.5).toTuple(), e));
  if (!es.length) throw new Error(`no such edge on ${body}`);
  return es.map((e: any) => edgeRef(body, e));
};
/** Edges where the faces either side meet at an angle (not the smooth seams between a line and a curve). */
const sharpEdges = (body: string, minDeg = 20) => {
  const s = B(body);
  const out: any[] = [];
  for (const e of s.edges) {
    const fs = s.faces.filter((f: any) => f.edges.some((x: any) => x.wrapped.IsSame(e.wrapped)));
    if (fs.length !== 2) continue;
    const p = e.pointAt(0.5);
    const [a, b] = fs.map((f: any) => f.normalAt(p).toTuple());
    const cos = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    if (cos < Math.cos(rad(minDeg))) out.push(edgeRef(body, e));
  }
  return out;
};
/** Round a body's sharp edges, as big as will go of `radii`. */
const roundSharp = async (id: string, name: string, body: string, radii: number[], keep: (e: any) => boolean = () => true) => {
  await build(true);
  const edges = sharpEdges(body).filter(keep);
  for (const r of radii) {
    feats.push({ id, name, type: "fillet", edges, radius: r });
    const res = await build(true);
    if (!res.errors.some((e: any) => e.featureId === id)) return r;
    feats.pop();
  }
  return 0;
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
const revolveX = (id: string, name: string, profile: any[]) => {
  feats.push({ id: `s_${id}`, name: `${name} profile`, type: "sketch", plane: XZ(0), entities: profile });
  feats.push({ id, name, type: "revolve", source: { kind: "profile", sketch: `s_${id}`, regions: all(profile) }, axis: { origin: [0, 0, AX], dir: [1, 0, 0] }, angle: 360, mode: "new" });
};
const union = (id: string, name: string, target: string, tools: string[]) => feats.push({ id, name, type: "boolean", op: "union", target, tools });
const subtract = (id: string, name: string, target: string, tools: string[], keepTools = false) => feats.push({ id, name, type: "boolean", op: "subtract", target, tools, keepTools });
const intersect = (id: string, name: string, target: string, tools: string[]) => feats.push({ id, name, type: "boolean", op: "intersect", target, tools });
/** Pattern round the motor's axis (or a parallel one at height z). */
const roundX = (id: string, name: string, body: string, count: number, z = AX, y = 0) => {
  feats.push({ id, name, type: "transform", bodies: [body], copy: false, op: { kind: "circular", axis: { origin: [0, y, z], dir: [1, 0, 0] }, count, angle: 360 } });
  return [body, ...range(count - 1, (k) => `${id}:${body}:${k}`)];
};
const circle = (id: string, c: P2, r: number) => ({ id, kind: "circle", center: c, radius: r });
const rect = (id: string, c: P2, w: number, h: number, rotation = 0) => ({ id, kind: "rect", center: c, w, h, rotation });
const poly = (id: string, points: P2[]) => ({ id, kind: "polyline", closed: true, points });

// An outline: straight lines ("l") and curves through points ("s"), each piece
// starting where the last ended, the last ending where the first began.
type Seg = { k: "l" | "s"; p: P2[] };
const outline = (pre: string, segs: Seg[]) =>
  segs.map((s, i) => (s.k === "l" ? { id: `${pre}${i}`, kind: "line", a: s.p[0], b: s.p[1] } : { id: `${pre}${i}`, kind: "spline", closed: false, mode: "fit", points: s.p }));
/** The same outline grown by g all round (each point moved out along the corner's bisector). */
const grow = (segs: Seg[], g: number): Seg[] => {
  const pts: P2[] = [];
  for (const s of segs) pts.push(...s.p.slice(0, -1));
  const n = pts.length;
  let area = 0;
  for (let i = 0; i < n; i++) area += pts[i][0] * pts[(i + 1) % n][1] - pts[(i + 1) % n][0] * pts[i][1];
  const out = area > 0 ? 1 : -1; // counter-clockwise: the outside is to the right of travel
  const norm = (a: P2, b: P2): P2 => {
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return [(out * (b[1] - a[1])) / d, (-out * (b[0] - a[0])) / d];
  };
  const moved = pts.map((p, i) => {
    const n1 = norm(pts[(i - 1 + n) % n], p), n2 = norm(p, pts[(i + 1) % n]);
    const m: P2 = [n1[0] + n2[0], n1[1] + n2[1]];
    const ml = Math.hypot(m[0], m[1]);
    const c = Math.max(0.5, ml / 2); // cos of the half-angle
    return [p[0] + (m[0] / ml) * (g / c), p[1] + (m[1] / ml) * (g / c)] as P2;
  });
  const key = (p: P2) => `${p[0]},${p[1]}`;
  const at = new Map(pts.map((p, i) => [key(p), moved[i]]));
  return segs.map((s) => ({ k: s.k, p: s.p.map((p) => at.get(key(p)) ?? moved[0]) }));
};
/** A body from two views: the side outline pulled across, the front outline pulled along, kept where they overlap. */
const twoView = (id: string, name: string, side: Seg[], front: Seg[]) => {
  extrude(id, name, XZ(80), outline(`${id}S`, side), 160);
  extrude(`${id}F`, `${name} (front view)`, YZ(-20), outline(`${id}F`, front), 280);
  intersect(`${id}X`, `${name} from both views`, id, [`${id}F`]);
};

const AX = 202; // the motor's axis
const X_FRONT = 88; // the housing's front, where the gearbox opens

// --- 1. The housing: the motor's housing and the foot each from two views -
// a side outline (the rounded rear, the flat top, the chin over the trigger;
// the foot's sloped front) and a front outline (rounded over the top) pulled
// across each other, kept where they overlap (Intersect) - their sharp edges
// rounded; the grip lofted through four rounded-square sections between them;
// joined. A copy kept for the rubber later; hollowed, open at the front.
section("Housing");
const HS: Seg[] = [
  { k: "l", p: [[88, 158], [108, 160]] },
  { k: "s", p: [[108, 160], [113, 166], [112, 174]] },
  { k: "l", p: [[112, 174], [X_FRONT, 176]] },
  { k: "l", p: [[X_FRONT, 176], [X_FRONT, 222]] },
  { k: "s", p: [[X_FRONT, 222], [85, 229], [78, 231]] },
  { k: "l", p: [[78, 231], [16, 231]] },
  { k: "s", p: [[16, 231], [5, 226], [0, 212], [1, 192], [6, 178], [16, 168]] },
  { k: "s", p: [[16, 168], [44, 161], [88, 158]] },
];
const HF: Seg[] = [
  { k: "l", p: [[-24, 150], [24, 150]] },
  { k: "s", p: [[24, 150], [27, 162], [28, 178]] },
  { k: "l", p: [[28, 178], [28, 212]] },
  { k: "s", p: [[28, 212], [27, 224], [20, 232], [10, 236]] },
  { k: "l", p: [[10, 236], [-10, 236]] },
  { k: "s", p: [[-10, 236], [-20, 232], [-27, 224], [-28, 212]] },
  { k: "l", p: [[-28, 212], [-28, 178]] },
  { k: "s", p: [[-28, 178], [-27, 162], [-24, 150]] },
];
const FS: Seg[] = [
  { k: "l", p: [[16, 56], [116, 56]] },
  { k: "s", p: [[116, 56], [120, 60], [119, 66], [114, 70]] },
  { k: "l", p: [[114, 70], [16, 73]] },
  { k: "s", p: [[16, 73], [12.5, 64.5], [16, 56]] },
];
const FF: Seg[] = [
  { k: "l", p: [[-34, 56], [34, 56]] },
  { k: "s", p: [[34, 56], [36, 62], [33, 70], [28, 75]] },
  { k: "l", p: [[28, 75], [-28, 75]] },
  { k: "s", p: [[-28, 75], [-33, 70], [-36, 62], [-34, 56]] },
];
// The grip: x middle, half its depth, half its width, at four heights (the
// first in the foot, the last in the housing above).
const GRIP: [number, number, number, number][] = [
  [68, 60, 26, 19],
  [100, 61, 21, 17],
  [132, 64, 23, 18],
  [166, 64, 26, 20],
];
const squircle = (id: string, cx: number, a: number, b: number) => ({
  id, kind: "spline", closed: true, mode: "fit",
  points: range(16, (t) => String(t)).map((_, t) => {
    const f = (2 * Math.PI * t) / 16, c = Math.cos(f), s = Math.sin(f);
    return [cx + a * Math.sign(c) * Math.abs(c) ** (2 / 3.5), b * Math.sign(s) * Math.abs(s) ** (2 / 3.5)] as P2;
  }),
});
const housing = async (pre: string, name: string, g: number, round: boolean) => {
  const top = pre, foot = `${pre}Foot`, grip = `${pre}Grip`;
  twoView(top, name, g ? grow(HS, g) : HS, g ? grow(HF, g) : HF);
  twoView(foot, `${name}: foot`, g ? grow(FS, g) : FS, g ? grow(FF, g) : FF);
  if (round) {
    const rT = await roundSharp(`${top}Round`, `Round the ${name.toLowerCase()}'s edges`, top, [3, 2.5, 2], (e) => Math.abs(e.mid[0] - X_FRONT) > 0.01);
    const rF = await roundSharp(`${foot}Round`, "Round the foot's edges", foot, [3, 2.5, 2]);
    check(`${name}: edges round`, rT > 0 && rF > 0, `r ${rT}, ${rF}`);
  }
  const secs = GRIP.map(([z, cx, a, b], k) => {
    const sk = `s_${grip}${k}`;
    const e = [squircle(`${grip}q${k}`, cx, a + g, b + g)];
    feats.push({ id: sk, name: `${name}: grip at ${z}`, type: "sketch", plane: XY(z), entities: e });
    return { kind: "profile", sketch: sk, regions: all(e) };
  });
  feats.push({ id: grip, name: `${name}: grip`, type: "loft", sections: secs, ruled: false, mode: "new" });
  union(`${pre}Join`, `${name} together`, top, [grip, foot]);
};
await housing("barrel", "Housing", 0, true);
await stage("stage 1 (housing shape)");
check("the housing is one solid", healthOf(B("barrel")).solids === 1);
feats.push({ id: "core", name: "Housing kept whole (for the rubber)", type: "transform", bodies: ["barrel"], copy: true, op: { kind: "move", translate: [0, 0, 0] } });
await build();
// Hollow: the housing drawn 2.5 smaller inside it, taken away; then the round
// opening at the front for the gearbox.
await housing("inside", "Housing inside", -2.5, false);
subtract("hollow", "Hollow the housing", "barrel", ["inside"]);
extrude("mouth", "Front opening", YZ(X_FRONT - 6), [circle("mo", [0, AX], 25)], 10, { mode: "cut", target: "barrel" });
await stage("stage 1b (housing hollowed)");

// --- 2. The motor: its can, the end bell, the shaft, a fan at the back
// (a disc and eight blades round the shaft).
section("Motor");
extrude("motor", "Motor can", YZ(12), [circle("can", [0, AX], 18)], 42);
extrude("bell", "End bell", YZ(54), [circle("bell", [0, AX], 10)], 4);
extrude("shaft", "Motor shaft", YZ(5), [circle("shaft", [0, AX], 1.5)], 75);
union("motorJoin", "Motor together", "motor", ["bell", "shaft"]);
extrude("fan", "Fan disc", YZ(5), [circle("fan", [0, AX], 15)], 1.2);
extrude("blade", "Fan blade", YZ(5.5), [rect("blade", [0, AX + 9], 1.2, 12, rad(20))], 4.5);
const blades = roundX("blades", "Blades round", "blade", 8);
union("fanJoin", "Fan together", "fan", blades);
await build();
feats.push({ id: "canRound", name: "Round the can", type: "fillet", edges: edgesWhere("motor", (p, e) => e.geomType === "CIRCLE" && Math.abs(e.length - 2 * Math.PI * 18) < 0.1), radius: 2 });
await stage("stage 2 (motor)");

// --- 3. The planetary gearbox in the housing's nose: the ring gear (its 36
// teeth inside), the sun gear on the motor shaft, three planets, the carrier
// with the spindle. Teeth: one tooth, Pattern Circular, Union.
section("Gearbox");
const ring = [circle("go", [0, AX], 24), circle("gi", [0, AX], 19)];
extrude("gearbox", "Gearbox", YZ(58), ring, 30, { regions: where(ring, (_, r) => r.holes.length > 0) });
extrude("rtooth", "Ring tooth", YZ(60), [rect("rt", [0, AX + 18.3], 1.6, 2)], 22);
union("ringTeeth", "Ring teeth on", "gearbox", roundX("rteeth", "Ring teeth round", "rtooth", 36));
extrude("sun", "Sun gear", YZ(62), [circle("sun", [0, AX], 4)], 18);
extrude("stooth", "Sun tooth", YZ(62), [rect("st", [0, AX + 4.6], 1.4, 1.6)], 18);
union("sunTeeth", "Sun teeth on", "sun", roundX("steeth", "Sun teeth round", "stooth", 10));
const PL = AX + 11.8;
extrude("planet", "Planet gear", YZ(62), [circle("pl", [0, PL], 5.4)], 18);
extrude("ptooth", "Planet tooth", YZ(62), [rect("pt", [0, PL + 6], 1.4, 1.6)], 18);
union("planetTeeth", "Planet teeth on", "planet", roundX("pteeth", "Planet teeth round", "ptooth", 14, PL));
const planets = roundX("planets", "Planets round", "planet", 3);
extrude("carrier", "Carrier", YZ(80), [circle("ca", [0, AX], 15)], 3);
extrude("spindle", "Spindle", YZ(83), [circle("sp", [0, AX], 5)], 59);
extrude("pin", "Planet pin", YZ(60), [circle("pp", [0, PL], 1.5)], 20);
union("carrierJoin", "Carrier with spindle and pins", "carrier", ["spindle", ...roundX("pins", "Pins round", "pin", 3)]);
await stage("stage 3 (gearbox)");
check("36 ring teeth", B("gearbox").faces.length > 36 * 3, `${B("gearbox").faces.length} faces`);

// --- 4. The front: a silver collar (four notches), the clutch ring (ribs
// round its front, its numbers round its back - each on a plane touching the
// ring), the chuck (revolved; ribbed rear and front sleeves, cut by two
// Pattern Circular sets of grooves), its nose split off (silver), and three
// jaws leaning in to meet in a point (Rotate, Pattern Circular) in channels
// cut for them (Subtract, keep the jaws).
section("Chuck");
const collar = [circle("co", [0, AX], 25), circle("ci", [0, AX], 16)];
extrude("collar", "Collar", YZ(X_FRONT), collar, 9, { regions: where(collar, (_, r) => r.holes.length > 0) });
extrude("notch", "Collar notch", YZ(X_FRONT), [rect("nt", [0, AX + 25], 6, 3)], 9);
subtract("notches", "Notch the collar", "collar", roundX("notchesR", "Notches round", "notch", 4));
const clutch = [circle("clo", [0, AX], 24), circle("cli", [0, AX], 8)];
extrude("clutch", "Clutch ring", YZ(97), clutch, 21, { regions: where(clutch, (_, r) => r.holes.length > 0) });
extrude("crib", "Clutch rib", YZ(106), [rect("cr", [0, AX + 24], 2.4, 2)], 12);
union("clutchRibs", "Clutch ribs on", "clutch", roundX("cribs", "Clutch ribs round", "crib", 30));
const fontFile = readFileSync("node_modules/@fontsource/roboto/files/roboto-latin-400-normal.woff");
const font = parse(fontFile.buffer.slice(fontFile.byteOffset, fontFile.byteOffset + fontFile.byteLength));
const fontBoldFile = readFileSync("node_modules/@fontsource/roboto/files/roboto-latin-700-normal.woff");
const fontBold = parse(fontBoldFile.buffer.slice(fontBoldFile.byteOffset, fontBoldFile.byteOffset + fontBoldFile.byteLength));
const text = (pre: string, f: any, s: string, at: P2, size: number) => textOutlines(f, s, at, size, 0, "center").map((e: any, i: number) => ({ ...e, id: `${pre}${i}` }));
const textRegions = (es: any[]) => materialRegions(arrangement(es)).map(regionRef);
const NUMS = ["2", "6", "10", "14", "18"];
const markIds: string[] = [];
NUMS.forEach((s, k) => {
  // Round the +y side (where it's seen from), the numbers upright towards the chuck.
  const th = rad(30 + k * 30);
  const R = 23.6;
  const r: Vec3 = [0, Math.sin(th), Math.cos(th)];
  const plane: PlaneDef = { origin: [101.5, R * r[1], AX + R * r[2]], normal: r, xDir: [0, -Math.cos(th), Math.sin(th)] };
  const es = text(`n${k}_`, fontBold, s, [0, -1.6], 4.2);
  extrude(`mark${k}`, `Clutch number ${s}`, plane, es, 0.9, { regions: textRegions(es) });
  markIds.push(`mark${k}`);
});
await build();
const chuckProfile = [
  poly("cp", [[118, AX + 5], [118, AX + 20], [120.5, AX + 21.5], [150, AX + 21.5], [152, AX + 19.2], [156, AX + 19.2], [158, AX + 20.6], [182, AX + 19], [189, AX + 15.5], [194, AX + 10], [194, AX + 3.2], [170, AX + 3.2], [170, AX], [142, AX], [142, AX + 5]]),
];
revolveX("chuck", "Chuck", chuckProfile);
extrude("grooveR", "Rear sleeve groove", YZ(122), [rect("grr", [0, AX + 21.5], 1.8, 2.4)], 27);
extrude("grooveF", "Front sleeve groove", YZ(160), [rect("grf", [0, AX + 20], 1.6, 3.2)], 21);
subtract("grooveCut", "Rib the sleeves", "chuck", [...roundX("groovesR", "Rear grooves round", "grooveR", 24), ...roundX("groovesF", "Front grooves round", "grooveF", 20)]);
feats.push({ id: "nose", name: "Nose off the sleeve", type: "split", body: "chuck", plane: { origin: [188, 0, 0], normal: [1, 0, 0], xDir: [0, 1, 0] } });
const JR = 5.6; // the jaws' middle; leaning 8.5° they meet 1 off the axis at the tip
extrude("jaw", "Jaw", YZ(160), [rect("jw", [0, AX + JR], 2.4, 2.4)], 46);
feats.push({ id: "jawLean", name: "Lean the jaw in", type: "transform", bodies: ["jaw"], copy: false, op: { kind: "move", translate: [0, 0, 0], rotate: { origin: [183, 0, AX + JR], axis: [0, 1, 0], angle: 8.5 } } });
const jaws = roundX("jaws", "Jaws round", "jaw", 3);
subtract("jawSlots", "Jaw channels in the chuck", "chuck", jaws, true);
subtract("jawSlotsN", "Jaw channels in the nose", "nose", jaws, true);
await stage("stage 4 (chuck)");
check("the jaws meet in a point past the nose", box("jaw")[1][0] > 204 && box("jaw")[1][0] < 208, `${box("jaw")[1][0].toFixed(1)}`);
check("five clutch numbers", markIds.every((m) => B(m)));

// --- 5. Controls and details: the trigger (lines and a curve, Extrude across,
// its front rounded), the direction switch through the top of the grip, the
// switch module inside, slots cut for them (Subtract, keep the parts); the
// two-speed slider in a slot on top; the vent grille (four slots through,
// a frame round them each side); the label plate; the LED in the foot.
section("Controls");
const trigger = [
  { id: "t0", kind: "line", a: [90, 128], b: [104, 128] },
  { id: "t1", kind: "spline", closed: false, mode: "fit", points: [[104, 128], [110, 138], [110, 150], [106, 160]] },
  { id: "t2", kind: "line", a: [106, 160], b: [88, 160] },
  { id: "t3", kind: "line", a: [88, 160], b: [90, 128] },
];
extrude("trigger", "Trigger", XZ(8), trigger, 16);
await build();
feats.push({ id: "triggerRound", name: "Round the trigger", type: "fillet", edges: edgesWhere("trigger", (p) => Math.abs(Math.abs(p[1]) - 8) < 1e-6 && p[0] > 104), radius: 2 });
extrude("dirSwitch", "Direction switch", XZ(29), [rect("ds", [80, 169.5], 10, 7)], 58);
extrude("module", "Switch module", XY(118), [rect("sm", [64, 0], 16, 16)], 22);
subtract("triggerSlot", "Trigger slot", "barrel", ["trigger"], true);
subtract("switchSlot", "Switch slot", "barrel", ["dirSwitch"], true);
extrude("speedSlot", "Speed slot", XY(228), [rect("ss", [36, 0], 26, 10)], 4, { mode: "cut", target: "barrel" });
extrude("slider", "Speed slider", XY(228.5), [rect("sl", [31, 0], 10, 8)], 4.5);
const vents = [198, 202, 206, 210].map((z, k) => rect(`v${k}`, [30, z], 24, 2));
extrude("vents", "Vent slots", XZ(40), vents, 80, { mode: "cut", target: "barrel" });
const frame = (pre: string, c: P2) => [rect(`${pre}o`, c, 32, 20), rect(`${pre}i`, c, 28, 16)];
const frameL = frame("fl", [-30, 204]);
extrude("frameL", "Vent frame (left)", PY(27.6), frameL, 1.2, { regions: where(frameL, (_, r) => r.holes.length > 0), mode: "join", target: "barrel" });
const frameR = frame("fr", [30, 204]);
extrude("frameR", "Vent frame (right)", XZ(-27.6), frameR, 1.2, { regions: where(frameR, (_, r) => r.holes.length > 0), mode: "join", target: "barrel" });
extrude("plate", "Label plate", PY(28), [rect("lp", [-66, 204], 34, 13)], 0.8);
const plateText = text("pt", fontBold, "DRILL DRIVER", [-66, 202.4], 4);
extrude("plateText", "Label", PY(28.8), plateText, 0.4, { regions: textRegions(plateText) });
extrude("led", "LED", YZ(114), [circle("ld", [0, 63], 3)], 6);
subtract("ledHole", "LED hole", "barrel", ["led"], true);
await stage("stage 5 (controls)");

// --- 6. The battery: a slide-on pack from two views again, its edges
// rounded, hollowed (Shell, no face open), a teal top split off and its
// sloped front split off that (black, the red release button in it); four
// 18650 cells inside (Pattern Linear twice, "cells" each way); two terminals
// up into the foot; a panel let into its side with "48V Lithium-ion" on it.
section("Battery");
const BS: Seg[] = [
  { k: "l", p: [[14, 0], [116, 0]] },
  { k: "s", p: [[116, 0], [122, 2], [124, 8]] },
  { k: "l", p: [[124, 8], [124, 38]] },
  { k: "s", p: [[124, 38], [121, 46], [112, 50]] },
  { k: "l", p: [[112, 50], [98, 51]] },
  { k: "l", p: [[98, 51], [96, 56]] },
  { k: "l", p: [[96, 56], [12, 56]] },
  { k: "s", p: [[12, 56], [8.6, 53], [8, 48]] },
  { k: "l", p: [[8, 48], [8, 8]] },
  { k: "s", p: [[8, 8], [9.5, 2], [14, 0]] },
];
const BF: Seg[] = [
  { k: "l", p: [[-33, 0], [33, 0]] },
  { k: "s", p: [[33, 0], [38, 3], [39, 10]] },
  { k: "l", p: [[39, 10], [39, 44]] },
  { k: "s", p: [[39, 44], [38, 52], [32, 58]] },
  { k: "l", p: [[32, 58], [-32, 58]] },
  { k: "s", p: [[-32, 58], [-38, 52], [-39, 44]] },
  { k: "l", p: [[-39, 44], [-39, 10]] },
  { k: "s", p: [[-39, 10], [-38, 3], [-33, 0]] },
];
twoView("battery", "Battery case", BS, BF);
await build();
const rBat = await roundSharp("batRound", "Round the case's edges", "battery", [4, 3, 2]);
check("the battery's edges round", rBat > 0, `r ${rBat}`);
const stadium = (pre: string) => [rect(`${pre}r`, [-66, 24], 64, 22), circle(`${pre}a`, [-34, 24], 11), circle(`${pre}b`, [-98, 24], 11)];
extrude("batPocket", "Panel pocket", PY(38), stadium("bk"), 2, { mode: "cut", target: "battery" });
// Hollow: the case drawn 2 smaller inside it, taken away (a sealed void).
twoView("batIn", "Battery inside", grow(BS, -2), grow(BF, -2));
subtract("batHollow", "Hollow the case", "battery", ["batIn"]);
feats.push({ id: "batTop", name: "Top off the case", type: "split", body: "battery", plane: { origin: [0, 0, 42], normal: [0, 0, 1], xDir: [1, 0, 0] } });
feats.push({ id: "batNose", name: "Front off the top", type: "split", body: "batTop", plane: { origin: [96, 0, 0], normal: [1, 0, 0], xDir: [0, 1, 0] } });
extrude("release", "Release button", XY(44), [rect("rb", [110, 0], 8, 28)], 8);
subtract("releaseSlot", "Release button slot", "batNose", ["release"], true);
extrude("batPlate", "Battery panel", PY(38), stadium("bp"), 1.2);
const batText = [...text("b48", fontBold, "48V", [-93, 19.5], 9), ...text("bli", font, "Lithium-ion", [-55, 21.5], 6)];
extrude("batText", "Battery lettering", PY(39.2), batText, 0.5, { regions: textRegions(batText) });
extrude("cell", "Cell", YZ(30), [circle("cl", [-10, 13], 9.25)], 65);
extrude("nub", "Cell terminal", YZ(95), [circle("nb", [-10, 13], 3.5)], 1.5);
union("cellJoin", "Cell with its terminal", "cell", ["nub"]);
feats.push({ id: "cellsY", name: "Cells across", type: "transform", bodies: ["cell"], copy: false, op: { kind: "linear", dir: [0, 1, 0], spacing: 20, count: 2 }, exprs: { "op.count": "cells" } });
feats.push({ id: "cellsZ", name: "Cells up", type: "transform", bodies: ["cell", "cellsY:cell:0"], copy: false, op: { kind: "linear", dir: [0, 0, 1], spacing: 20, count: 2 }, exprs: { "op.count": "cells" } });
const cellIds = ["cell", "cellsY:cell:0", "cellsZ:cell:0", "cellsZ:cellsY:cell:0:0"];
extrude("terms", "Terminals", XY(50), [rect("ta", [80, 8], 20, 1.5), rect("tb", [80, -8], 20, 1.5)], 12);
subtract("termSlots", "Terminal slots", "barrel", ["terms"], true);
subtract("termSlotsB", "Terminal slots (battery)", "batTop", ["terms"], true);
await stage("stage 6 (battery)");

// --- 7. Wiring: from the switch module down the grip to the terminals, and up
// to the motor (Sweep along curves drawn on side planes).
section("Wiring");
const wire = (id: string, name: string, y: number, pts: P2[], r: number) => {
  const pl = XZ(y);
  feats.push({ id: `p_${id}`, name: `${name} path`, type: "sketch", plane: pl, entities: [{ id: `pw${id}`, kind: "spline", closed: false, mode: "fit", points: pts }] });
  const [a, b] = pts;
  const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const dir: Vec3 = [(b[0] - a[0]) / d, 0, (b[1] - a[1]) / d];
  feats.push({ id: `g_${id}`, name: `${name} gauge`, type: "sketch", plane: { origin: [a[0], y, a[1]], normal: dir, xDir: [0, 1, 0] }, entities: [circle(`gw${id}`, [0, 0], r)] });
  feats.push({ id, name, type: "sweep", source: { kind: "profile", sketch: `g_${id}`, regions: all([circle(`gw${id}`, [0, 0], r)]) }, path: { kind: "sketch", sketch: `p_${id}`, entities: [`pw${id}`] }, mode: "new" });
};
wire("wireRed", "Red wire", 4, [[62, 118], [60, 96], [64, 76], [74, 66], [80, 63]], 1.1);
wire("wireBlack", "Black wire", -4, [[66, 118], [64, 96], [67, 76], [76, 66], [82, 63]], 1.1);
wire("wireMotor", "Motor wire", 0, [[64, 140], [58, 156], [44, 170], [26, 178], [13, 181]], 1);
await stage("stage 7 (wiring)");

// --- 8. Finish: the rear cap off the housing (black), the housing in two
// halves (Split Body down the middle); the rubber - the housing's two views
// drawn 1.2 bigger, kept within a strip down the grip's back, one under the
// trigger and a stripe down its side, less the housing kept whole earlier.
section("Finish");
feats.push({ id: "cap", name: "Rear cap", type: "split", body: "barrel", plane: { origin: [12, 0, 0], normal: [-1, 0, 0], xDir: [0, 1, 0] } });
feats.push({ id: "halves", name: "Housing halves", type: "split", body: "barrel", plane: XZ(0) });
await housing("moldG", "Rubber outline", 1.2, false);
const strips = [
  poly("mb", [[8, 80], [50, 82], [52, 112], [50, 150], [46, 173], [8, 173]]),
  poly("mf", [[70, 84], [100, 84], [100, 126], [72, 126]]),
  poly("ms", [[78, 156], [84, 156], [66, 128], [70, 90], [64, 90], [60, 128]]),
];
extrude("mold", "Rubber", XZ(60), strips, 120);
intersect("moldCut", "Rubber over the grip", "mold", ["moldG"]);
subtract("moldSkin", "Rubber skin", "mold", ["core:barrel:0"]);
const final = await stage("the whole drill");

// --- Checks.
const bodies = final.bodies.map((b: any) => b.id);
const unhealthy = bodies.filter((id: string) => !isHealthy(healthOf(B(id))));
check("every body is a clean solid", !unhealthy.length, unhealthy.join(" "));
check("two housing halves", !!B("barrel") && !!B("halves") && box("barrel")[0][1] > -1e-6 && box("halves")[1][1] < 1e-6, `${box("barrel")[0][1].toFixed(2)} / ${box("halves")[1][1].toFixed(2)}`);
check("a rear cap", !!B("cap") && box("cap")[1][0] < 12 + 1e-6);
check("~206 long", Math.abs(box("jaw")[1][0] - box("cap")[0][0] - 206) < 2, `${(box("jaw")[1][0] - box("cap")[0][0]).toFixed(1)}`);
check("~231 tall", Math.abs(box("barrel")[1][2] - box("battery")[0][2] - 231) < 2, `${(box("barrel")[1][2] - box("battery")[0][2]).toFixed(1)}`);
check("four cells", cellIds.every((c) => B(c)));
check("rubber on the grip, a thin skin", !!B("mold") && V("mold") > 2000 && V("mold") < 12000, `${B("mold") ? V("mold").toFixed(0) : 0} mm³`);
// Nothing inside runs into the housing or the battery.
const inner = ["motor", "fan", "module", "wireRed", "wireBlack", "wireMotor", ...cellIds, "carrier", "sun", "gearbox"];
for (const a of inner) {
  for (const b of ["barrel", "halves", "cap", "battery", "batTop", "batNose", "mold"]) {
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
  const teal = "#1aa3b8", black = "#1b1d21", rubber = "#26292e", steel = "#b9bdc2", silver = "#d4d8dc", white = "#eef2f4", brass = "#c9a227";
  const colors: Record<string, string> = {
    barrel: teal, halves: teal, cap: black, mold: rubber, trigger: black, dirSwitch: black, module: "#2a2d33", slider: black, plate: black, plateText: white, led: "#f3f0d2",
    motor: "#8f969d", fan: black, gearbox: "#3a3d42", sun: steel, carrier: steel, collar: silver, clutch: black, chuck: black, nose: silver,
    battery: black, batTop: "#25282d", batNose: black, release: "#d6282c", batPlate: teal, batText: white, terms: brass, wireRed: "#d42a2a", wireBlack: "#111111", wireMotor: "#d42a2a",
  };
  for (const p of planets) colors[p] = steel;
  for (const j of jaws) colors[j] = silver;
  for (const c of cellIds) colors[c] = "#2f6fd0";
  const names: Record<string, string> = {
    barrel: "Housing (left)", halves: "Housing (right)", cap: "Rear cap", mold: "Rubber grip", trigger: "Trigger", dirSwitch: "Direction switch", module: "Switch module",
    slider: "Speed slider", plate: "Label plate", plateText: "Label", led: "LED", motor: "Motor", fan: "Fan", gearbox: "Gearbox (ring gear)", sun: "Sun gear",
    carrier: "Carrier and spindle", collar: "Collar", clutch: "Clutch ring", chuck: "Chuck sleeve", nose: "Chuck nose",
    battery: "Battery (bottom)", batTop: "Battery (top)", batNose: "Battery (front)", release: "Release button", batPlate: "Battery panel", batText: "Battery lettering",
    terms: "Terminals", wireRed: "Red wire", wireBlack: "Black wire", wireMotor: "Motor wire",
  };
  markIds.forEach((m, k) => ((colors[m] = white), (names[m] = `Clutch number ${NUMS[k]}`)));
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
