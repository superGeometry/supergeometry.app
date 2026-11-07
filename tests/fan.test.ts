// Run: npx tsx tests/fan.test.ts [out.json] - a desk fan, made with every tool
// there is: variables (blade count, guard size); sketches with lines, arcs,
// circles, rectangles, an ellipse, a polygon, a spline, text, sketch fillets,
// offset, mirror and pattern; Extrude (with taper), Revolve, Sweep, Loft,
// Shell, Fillet, Chamfer, Thread; Union, Subtract, Intersect, Split Body;
// Pattern Linear / Circular, Mirror, Move / Rotate, Scale; Offset Face, Scale
// Face, Replace Face; planes (offset, midplane), an axis; Freeform (a carry
// handle) and Fill to Plane (a soft dome on the base).
import opencascade from "replicad-opencascadejs";
import { measureArea, measureVolume, setOC } from "replicad";
import { readFileSync, writeFileSync } from "node:fs";
import opentype from "opentype.js";
const { parse } = opentype as any;
import { debugBodies, regenerate } from "../src/kernel/engine";
import { healthOf, isHealthy } from "../src/kernel/repair";
import { arrangement, materialRegions, regionRef } from "../src/sketch/regions";
import { textOutlines } from "../src/sketch/textLayout";
import { filletCorner, offsetChain } from "../src/sketch/edit";
import { boxCage, extrudeFaces, planeCage } from "../src/freeform/cage";
import { resolveDoc } from "../src/doc/params";
import type { PlaneDef, Vec3 } from "../src/doc/types";

setOC(await (opencascade as unknown as () => Promise<any>)());
let failed = 0;
const check = (name: string, ok: boolean, info = "") => {
  if (!ok) failed++;
  console.log(ok ? "ok  " : "FAIL", name, info);
};

let n = 0;
const id = () => `e${n++}`;
const XY = (z = 0): PlaneDef => ({ origin: [0, 0, z], normal: [0, 0, 1], xDir: [1, 0, 0] });
const XZ = (y = 0): PlaneDef => ({ origin: [0, y, 0], normal: [0, -1, 0], xDir: [1, 0, 0] }); // u = x, v = z, normal to the front
const YZ = (x = 0): PlaneDef => ({ origin: [x, 0, 0], normal: [1, 0, 0], xDir: [0, 1, 0] }); // u = y, v = z
const all = (es: any[]) => arrangement(es).regions.map(regionRef);
const feats: any[] = [];
const variables = [
  { name: "blades", expr: "5" },
  { name: "reach", expr: "92 mm" },
];
const doc = () => {
  const d: any = { format: "super", version: 2, name: "Desk fan", features: structuredClone(feats), variables, views: [], units: "mm", hidden: [], pins: [], names: {} };
  const problems = resolveDoc(d);
  if (problems.length) console.log("problems:", problems);
  return d;
};
const build = async () => {
  const r: any = await regenerate(doc().features);
  if (r.errors.length) console.log("errors:", r.errors.map((e: any) => `${feats.find((f) => f.id === e.featureId)?.name}: ${e.message}`).join("; "));
  return r;
};
const faceWhere = (body: string, test: (c: number[], nrm: number[]) => boolean) => {
  const f = (debugBodies().get(body) as any).faces.find((f: any) => test(f.center.toTuple(), f.normalAt().toTuple()));
  if (!f) throw new Error(`no such face on ${body}`);
  return { body, center: f.center.toTuple() as Vec3, normal: f.normalAt().toTuple() as Vec3, area: measureArea(f) };
};
const edgeWhere = (body: string, test: (p: number[]) => boolean) => {
  const e = (debugBodies().get(body) as any).edges.find((e: any) => test(e.pointAt(0.5).toTuple()));
  if (!e) throw new Error(`no such edge on ${body}`);
  return { body, mid: e.pointAt(0.5).toTuple() as Vec3, dir: e.tangentAt(0.5).toTuple() as Vec3, length: e.length as number };
};

// --- 1. Base: an ellipse 220 × 160 pulled up 22 with its sides leaning in
// (Extrude, Taper 0.9); the top rim rounded, the foot bevelled.
const BASE_H = 22;
const baseSk = [{ id: id(), kind: "ellipse", center: [0, 0], rx: 110, ry: 80, rotation: 0 }];
feats.push({ id: "sBase", name: "Base outline", type: "sketch", plane: XY(), entities: baseSk });
feats.push({ id: "stand", name: "Base", type: "extrude", source: { kind: "profile", sketch: "sBase", regions: all(baseSk) }, distance: BASE_H, taper: 0.9, mode: "new" });
await build();
feats.push({ id: "baseRim", name: "Round the rim", type: "fillet", edges: [edgeWhere("stand", (p) => Math.abs(p[2] - BASE_H) < 1e-6)], radius: 6 });
feats.push({ id: "baseFoot", name: "Bevel the foot", type: "chamfer", edges: [edgeWhere("stand", (p) => Math.abs(p[2]) < 1e-6)], radius: 2 });

// --- 2. The name on the front of the base (Text), raised 1.5.
const buf = readFileSync(new URL("../node_modules/@fontsource/roboto/files/roboto-latin-400-normal.woff", import.meta.url));
const font = parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const name = textOutlines(font, "AIRO", [0, -55], 12, 0, "center");
feats.push({ id: "sName", name: "Name", type: "sketch", plane: XY(BASE_H), entities: name });
feats.push({ id: "nameUp", name: "Raise the name", type: "extrude", source: { kind: "profile", sketch: "sName", regions: materialRegions(arrangement(name as any)).map(regionRef) }, distance: 1.5, mode: "join", target: "stand" });

// --- 3. Three speed buttons: a 14 × 8 rectangle, corners rounded in the
// sketch (Fillet), pushed up 4 as a new body, three in a row (Pattern Linear),
// united with the base (Union).
let btn: any[] = [{ id: "b1", kind: "rect", center: [70, -38], w: 14, h: 8, rotation: 0 }];
for (const c of [[63, -42], [77, -42], [77, -34], [63, -34]] as [number, number][]) btn = filletCorner(btn, c, 2, 0.5) ?? btn;
check("button corners rounded in the sketch (4 arcs)", btn.filter((e) => e.kind === "arc").length === 4, btn.map((e) => e.kind).join(" "));
feats.push({ id: "sBtn", name: "Button", type: "sketch", plane: XY(BASE_H), entities: btn });
feats.push({ id: "btn", name: "Button", type: "extrude", source: { kind: "profile", sketch: "sBtn", regions: all(btn) }, distance: 4, mode: "new" });
feats.push({ id: "btns", name: "Buttons", type: "transform", bodies: ["btn"], copy: true, op: { kind: "linear", dir: [-1, 0, 0], spacing: 18, count: 3 } });
feats.push({ id: "btnJoin", name: "Buttons on the base", type: "boolean", op: "union", target: "stand", tools: ["btn", "btns:btn:0", "btns:btn:1"] });

// --- 4. The pole: an octagon (Polygon) 32 across up to 112, extended to meet the yoke with Replace Face
// (its top onto a plane 121 up), its top narrowed with Scale Face.
const pole = [{ id: id(), kind: "polygon", center: [0, 0], radius: 16, sides: 8, angle: 0 }];
feats.push({ id: "sPole", name: "Pole", type: "sketch", plane: XY(BASE_H), entities: pole });
feats.push({ id: "pole", name: "Pole", type: "extrude", source: { kind: "profile", sketch: "sPole", regions: all(pole) }, distance: 90, mode: "new" });
feats.push({ id: "pYoke", name: "Yoke bottom", type: "plane", plane: XY(), offset: 121 });
const r1 = await build();
check("stage 1 builds", !r1.errors.length);
const poleTop = faceWhere("pole", (c, nrm) => Math.abs(c[2] - 112) < 1e-6 && nrm[2] > 0.99);
feats.push({ id: "poleUp", name: "Pole up to the yoke", type: "replaceFace", face: poleTop, plane: { origin: [0, 0, 121], normal: [0, 0, -1], xDir: [1, 0, 0] } });
await build();
const poleTop2 = faceWhere("pole", (c, nrm) => Math.abs(c[2] - 121) < 1e-6 && nrm[2] > 0.99);
feats.push({ id: "poleNeck", name: "Narrow the neck", type: "scaleFace", face: poleTop2, u: [1, 0, 0], factors: [0.8, 0.8] });
feats.push({ id: "poleOn", name: "Pole on the base", type: "boolean", op: "union", target: "stand", tools: ["pole"] });
const r2 = await build();
check("stage 2 builds", !r2.errors.length, r2.bodies.map((b: any) => b.id).join(", "));

// --- 5. The yoke: half a U (a line down, a quarter circle round the centre
// 190 up, Arc by its centre), mirrored to the other side (sketch Mirror), offset 8 inwards (sketch
// Offset), the ends closed; 12 thick, on a plane 6 behind the front one.
const half = [
  { id: "y1", kind: "line", a: [70, 232], b: [70, 190] },
  { id: "y2", kind: "arc", a: [70, 190], m: [70 * Math.SQRT1_2, 190 - 70 * Math.SQRT1_2], b: [0, 120] },
];
const mir = (e: any) => (e.kind === "line" ? { ...e, id: e.id + "m", a: [-e.a[0], e.a[1]], b: [-e.b[0], e.b[1]] } : { ...e, id: e.id + "m", a: [-e.a[0], e.a[1]], m: [-e.m[0], e.m[1]], b: [-e.b[0], e.b[1]] });
const outer = [...half, ...half.map(mir)];
const inner = (offsetChain(outer as any, "y1", -8) ?? []).filter((e: any) => !outer.some((o) => o.id === e.id));
const innerEnds = inner.flatMap((e: any) => (e.kind === "line" ? [e.a, e.b] : [e.a, e.b])).filter((p: number[]) => Math.abs(p[1] - 232) < 1e-6);
check("the U offset 8 inwards (sketch Offset)", inner.length === 4 && innerEnds.length === 2 && innerEnds.every((p: number[]) => Math.abs(Math.abs(p[0]) - 62) < 1e-6), inner.map((e: any) => e.kind).join(" "));
const caps = [
  { id: "c1", kind: "line", a: [70, 232], b: [62, 232] },
  { id: "c2", kind: "line", a: [-70, 232], b: [-62, 232] },
];
const yoke = [...outer, ...inner, ...caps];
feats.push({ id: "pBack", name: "Behind the middle", type: "plane", plane: XZ(), offset: -6 });
feats.push({ id: "sYoke", name: "Yoke", type: "sketch", plane: XZ(6), entities: yoke });
feats.push({ id: "yoke", name: "Yoke", type: "extrude", source: { kind: "profile", sketch: "sYoke", regions: all(yoke) }, distance: 12, mode: "join", target: "stand" });
const r3 = await build();
check("stage 3 builds (yoke on the pole)", !r3.errors.length && r3.bodies.length === 1, r3.bodies.map((b: any) => b.id).join(", "));

// --- 6. The fan's axis (Axis), level with the pivot, pointing to the front.
const AX: Vec3 = [0, 0, 215];
feats.push({ id: "fanAxis", name: "Fan axis", type: "axis", origin: AX, dir: [0, -1, 0] });
const axisRef = { origin: AX, dir: [0, -1, 0] as Vec3, ref: { kind: "axis", feature: "fanAxis" } };

// --- 7. The motor housing: a spline profile turned about that axis (Revolve),
// hollowed 2.5 open at the back (Shell), cut in two half way (Split Body).
const prof = [
  { id: "h1", kind: "line", a: [-20, 215], b: [-20, 250] },
  { id: "h2", kind: "spline", points: [[-20, 250], [5, 265], [40, 260], [55, 245], [60, 230]], closed: false, mode: "fit" },
  { id: "h4", kind: "line", a: [60, 230], b: [60, 215] },
  { id: "h3", kind: "line", a: [60, 215], b: [-20, 215] },
];
feats.push({ id: "sHouse", name: "Housing profile", type: "sketch", plane: YZ(), entities: prof });
feats.push({ id: "house", name: "Housing", type: "revolve", source: { kind: "profile", sketch: "sHouse", regions: all(prof) }, axis: axisRef, angle: 360, mode: "new" });
await build();
feats.push({ id: "houseShell", name: "Hollow the housing", type: "shell", body: "house", faces: [faceWhere("house", (c, nrm) => Math.abs(c[1] - 60) < 1e-6 && nrm[1] > 0.99)], thickness: 2.5 });
// Split half way between its front (y = -20) and back (y = 60): Midplane.
feats.push({ id: "pMid", name: "Midplane", type: "plane", plane: { origin: [0, 20, 0], normal: [0, 1, 0], xDir: [1, 0, 0] }, offset: 0 });
feats.push({ id: "houseSplit", name: "Front and back", type: "split", body: "house", plane: { origin: [0, 20, 0], normal: [0, 1, 0], xDir: [1, 0, 0] } });

// --- 8. The pivot: a Ø10 rod right through the arms and the housing; a copy
// scaled 1.05 (Scale, Copy) taken out of the yoke (Subtract) leaves it room.
const rod = [{ id: id(), kind: "circle", center: [0, 215], radius: 5 }];
feats.push({ id: "sRod", name: "Pivot", type: "sketch", plane: YZ(-80), entities: rod });
feats.push({ id: "rod", name: "Pivot", type: "extrude", source: { kind: "profile", sketch: "sRod", regions: all(rod) }, distance: 160, mode: "new" });
feats.push({ id: "rodRoom", name: "Room for the pivot", type: "transform", bodies: ["rod"], copy: true, op: { kind: "scale", center: AX, factor: 1.05 } });
const r4 = await build();
check("stage 4 builds", !r4.errors.length, r4.bodies.map((b: any) => b.id).join(", "));

const yr = (id: string) => (debugBodies().get(id) as any).boundingBox.bounds.map((p: number[]) => p[1].toFixed(1)).join("…");
console.log("house", yr("house"), "houseSplit", yr("houseSplit"));
feats.push({ id: "holes", name: "Holes for the pivot", type: "boolean", op: "subtract", target: "stand", tools: ["rodRoom:rod:0"] });
feats.push({ id: "rodIn", name: "Pivot into the housing", type: "boolean", op: "union", target: "house", tools: ["rod"] });

// --- 9. Vents in the back cover: one slot 4 × 36 drawn, five in a row (sketch
// Pattern) on a plane 75 behind, cut 30 in.
const slots = [-2, -1, 0, 1, 2].map((k) => ({ id: `v${k + 2}`, kind: "rect", center: [k * 12, 215], w: 4, h: 36, rotation: 0 }));
feats.push({ id: "pVents", name: "Behind the fan", type: "plane", plane: XZ(), offset: -75 });
feats.push({ id: "sVents", name: "Vents", type: "sketch", plane: XZ(75), entities: slots });
feats.push({ id: "vents", name: "Cut the vents", type: "extrude", source: { kind: "profile", sketch: "sVents", regions: all(slots) }, distance: 30, mode: "cut", target: "houseSplit" });
const r5 = await build();
check("stage 5 builds", !r5.errors.length, r5.bodies.map((b: any) => b.id).join(", "));

// --- 10. The spindle: Ø8 out of the housing's front, its end pushed further
// out (Offset Face), threaded (Thread). The hub: a dome with a Ø8 hole
// (Revolve). A hex nut (Polygon with a circle in it), its hole threaded.
const sp = [{ id: id(), kind: "circle", center: [0, 215], radius: 4 }];
feats.push({ id: "sSpin", name: "Spindle", type: "sketch", plane: XZ(-20), entities: sp });
feats.push({ id: "spin", name: "Spindle", type: "extrude", source: { kind: "profile", sketch: "sSpin", regions: all(sp) }, distance: 16, mode: "new" });
feats.push({ id: "spinOut", name: "Longer spindle", type: "moveFace", face: { body: "spin", center: [0, -36, 215], normal: [0, -1, 0], area: Math.PI * 16 }, translate: [0, -14, 0] });
await build();
feats.push({ id: "spinThread", name: "Thread the spindle", type: "thread", face: faceWhere("spin", (c, nrm) => Math.abs(nrm[1]) < 1e-6), pitch: 1.25 });
const hub = [
  { id: "u1", kind: "line", a: [-24, 219], b: [-24, 231] },
  { id: "u2", kind: "line", a: [-24, 231], b: [-30, 231] },
  { id: "u3", kind: "arc", a: [-30, 231], m: [-30 - 12 * Math.SQRT1_2, 219 + 12 * Math.SQRT1_2], b: [-42, 219] },
  { id: "u4", kind: "line", a: [-42, 219], b: [-24, 219] },
];
feats.push({ id: "sHub", name: "Hub profile", type: "sketch", plane: YZ(), entities: hub });
feats.push({ id: "rotor", name: "Hub", type: "revolve", source: { kind: "profile", sketch: "sHub", regions: all(hub) }, axis: axisRef, angle: 360, mode: "new" });
const nut = [
  { id: "n1", kind: "polygon", center: [0, 215], radius: 7, sides: 6, angle: 0 },
  { id: "n2", kind: "circle", center: [0, 215], radius: 4 },
];
feats.push({ id: "sNut", name: "Nut", type: "sketch", plane: XZ(-42), entities: nut });
feats.push({ id: "nut", name: "Nut", type: "extrude", source: { kind: "profile", sketch: "sNut", regions: all(nut).filter((r) => r.a > 60) }, distance: 6, mode: "new" });
await build();
feats.push({ id: "nutThread", name: "Thread the nut", type: "thread", face: faceWhere("nut", (c, nrm) => Math.abs(nrm[1]) < 1e-6 && Math.hypot(c[0], c[2] - 215) < 4.5 && Math.hypot(nrm[0], nrm[2]) > 0.99 && (c[0] * nrm[0] + (c[2] - 215) * nrm[2]) < 0.01), pitch: 1.5 }); // what the Thread tool picks for a Ø8 hole (a tap-drill hole for M10)

// --- 11. A blade: a fat ellipse at the hub lofted to a thin, more turned one
// past the tip (Loft, two offset planes), its tip rounded off by a cylinder
// (Intersect), as many round the axis as the "blades" variable says (Pattern
// Circular), all one with the hub (Union).
const root = [{ id: id(), kind: "ellipse", center: [0, -33], rx: 9, ry: 4, rotation: (20 * Math.PI) / 180 }];
const tip = [{ id: id(), kind: "ellipse", center: [0, -33], rx: 24, ry: 2.5, rotation: (35 * Math.PI) / 180 }];
feats.push({ id: "pRoot", name: "Blade root", type: "plane", plane: XY(), offset: 226 });
feats.push({ id: "pTip", name: "Blade tip", type: "plane", plane: XY(), offset: 312 });
feats.push({ id: "sRoot", name: "Blade root", type: "sketch", plane: XY(226), entities: root });
feats.push({ id: "sTip", name: "Blade tip", type: "sketch", plane: XY(312), entities: tip });
feats.push({ id: "blade", name: "Blade", type: "loft", sections: [{ kind: "profile", sketch: "sRoot", regions: all(root) }, { kind: "profile", sketch: "sTip", regions: all(tip) }], ruled: false, mode: "new" });
const trim = [{ id: "reach", kind: "circle", center: [0, 215], radius: 92 }];
feats.push({ id: "sTrim", name: "Blade reach", type: "sketch", plane: XZ(-10), entities: trim, constraints: [{ id: "dReach", type: "dim", curves: ["reach"], prop: "diameter", value: 184, expr: "reach*2" }] });
feats.push({ id: "trim", name: "Blade reach", type: "extrude", source: { kind: "profile", sketch: "sTrim", regions: all(trim) }, distance: 50, mode: "new" });
feats.push({ id: "bladeTrim", name: "Round the tip", type: "boolean", op: "intersect", target: "blade", tools: ["trim"] });
feats.push({ id: "bladeRound", name: "Blades", type: "transform", bodies: ["blade"], copy: true, op: { kind: "circular", axis: axisRef, count: 5, angle: 360 }, exprs: { "op.count": "blades" } });
feats.push({ id: "rotorJoin", name: "Blades on the hub", type: "boolean", op: "union", target: "rotor", tools: ["blade", "bladeRound:blade:0", "bladeRound:blade:1", "bladeRound:blade:2", "bladeRound:blade:3"] });
const r6 = await build();
check("stage 6 builds", !r6.errors.length, r6.bodies.map((b: any) => b.id).join(", "));

// --- 12. The guard: a Ø4 ring 105 from the axis (a circle turned about it,
// Revolve), a spoke bending in to the middle (Sweep along a spline), twelve
// round (Pattern Circular), a cap, all one (Union); a copy mirrored behind the
// fan (Mirror), its cap reaching the back of the housing.
const ring = [{ id: id(), kind: "circle", center: [-62, 320], radius: 2 }];
feats.push({ id: "sRing", name: "Guard ring", type: "sketch", plane: YZ(), entities: ring });
feats.push({ id: "guard", name: "Guard", type: "revolve", source: { kind: "profile", sketch: "sRing", regions: all(ring) }, axis: axisRef, angle: 360, mode: "new" });
const spokePath = [{ id: "sp1", kind: "spline", points: [[-62, 320], [-64, 300], [-71, 262], [-77, 226]], closed: false, mode: "fit" }];
feats.push({ id: "sSpokePath", name: "Spoke path", type: "sketch", plane: YZ(), entities: spokePath });
const spokeEnd = [{ id: id(), kind: "circle", center: [0, -62], radius: 1.4 }];
feats.push({ id: "sSpoke", name: "Spoke", type: "sketch", plane: XY(320), entities: spokeEnd });
feats.push({ id: "spoke", name: "Spoke", type: "sweep", source: { kind: "profile", sketch: "sSpoke", regions: all(spokeEnd) }, path: { kind: "sketch", sketch: "sSpokePath", entities: ["sp1"] }, mode: "new" });
feats.push({ id: "spokes", name: "Spokes", type: "transform", bodies: ["spoke"], copy: true, op: { kind: "circular", axis: axisRef, count: 12, angle: 360 } });
const cap = [{ id: id(), kind: "circle", center: [0, 215], radius: 12 }];
feats.push({ id: "sCap", name: "Guard cap", type: "sketch", plane: XZ(-58), entities: cap });
feats.push({ id: "cap", name: "Guard cap", type: "extrude", source: { kind: "profile", sketch: "sCap", regions: all(cap) }, distance: 21, mode: "new" });
feats.push({ id: "guardJoin", name: "Guard in one", type: "boolean", op: "union", target: "guard", tools: ["spoke", ...Array.from({ length: 11 }, (_, k) => `spokes:spoke:${k}`), "cap"] });
feats.push({ id: "guardBack", name: "Back guard", type: "transform", bodies: ["guard"], copy: true, op: { kind: "mirror", plane: { origin: [0, 0, 0], normal: [0, 1, 0], xDir: [1, 0, 0] } } });
// Four tie rods between the two guards, outside the blades' sweep (Pattern
// Circular, starting at 45° so none runs into the pole).
const tie = [{ id: id(), kind: "circle", center: [105 * Math.SQRT1_2, 215 + 105 * Math.SQRT1_2], radius: 2 }];
feats.push({ id: "sTie", name: "Tie rod", type: "sketch", plane: XZ(62), entities: tie });
feats.push({ id: "tie", name: "Tie rod", type: "extrude", source: { kind: "profile", sketch: "sTie", regions: all(tie) }, distance: 124, mode: "new" });
feats.push({ id: "ties", name: "Tie rods", type: "transform", bodies: ["tie"], copy: true, op: { kind: "circular", axis: axisRef, count: 4, angle: 360 } });
feats.push({ id: "spinOn", name: "Spindle on the motor", type: "boolean", op: "union", target: "house", tools: ["spin"] });
feats.push({ id: "tiesOn", name: "Tie rods on the guard", type: "boolean", op: "union", target: "guard", tools: ["tie", "ties:tie:0", "ties:tie:1", "ties:tie:2"] });
feats.push({ id: "guardsOne", name: "Both guards in one", type: "boolean", op: "union", target: "guard", tools: ["guardBack:guard:0"] });
feats.push({ id: "guardOn", name: "Guard on the back cover", type: "boolean", op: "union", target: "houseSplit", tools: ["guard"] });
const r7 = await build();
check("stage 7 builds", !r7.errors.length, r7.bodies.map((b: any) => b.id).join(", "));

// --- 13. A carry handle on the back cover (Freeform): a box 66 × 14 × 10, its
// two end faces underneath pulled down 18 into the cover (Extrude faces),
// smooth; one with the cover (Union).
let hcage = boxCage([66, 14, 10], 3, [0, 40, 268]);
const under = hcage.faces.map((f, i) => ({ i, c: f.map((v) => hcage.verts[v]).reduce((a, p) => [a[0] + p[0] / 4, a[1] + p[1] / 4, a[2] + p[2] / 4], [0, 0, 0]) })).filter(({ c }) => Math.abs(c[2] - 268) < 1e-6 && Math.abs(c[1] - 40) < 1 && Math.abs(Math.abs(c[0]) - 22) < 1).map(({ i }) => i);
check("the handle's two end faces underneath", under.length === 2);
hcage = extrudeFaces(hcage, under, 18)!.cage;
feats.push({ id: "handle", name: "Handle", type: "freeform", cage: hcage });
feats.push({ id: "handleOn", name: "Handle on the cover", type: "boolean", op: "union", target: "houseSplit", tools: ["handle"] });

// --- 14. A soft dome on the base behind the pole for the switch (a Freeform
// surface pulled up in the middle, filled down to the base top: Fill to Plane),
// one with the base (Union).
// The nine inner points up 5, the middle one 3 more.
const dome = planeCage([50, 30], 4, [0, 42, 24]);
dome.verts.forEach((p) => {
  if (Math.abs(p[0]) < 24 && Math.abs(p[1] - 42) < 14) p[2] += 5;
  if (Math.abs(p[0]) < 1e-6 && Math.abs(p[1] - 42) < 1e-6) p[2] += 3;
});
feats.push({ id: "dome", name: "Switch dome", type: "freeform", cage: dome, surface: true });
feats.push({ id: "domeFill", name: "Fill down to the base", type: "fillToPlane", body: "dome", plane: XY(BASE_H) });
feats.push({ id: "domeOn", name: "Dome on the base", type: "boolean", op: "union", target: "stand", tools: ["dome"] });

// --- 15. The head tilted up 10° about the pivot (Move/Rotate).
feats.push({ id: "tilt", name: "Tilt the head", type: "transform", bodies: ["house", "houseSplit", "rotor", "nut"], copy: false, op: { kind: "move", translate: [0, 0, 0], rotate: { origin: AX, axis: [1, 0, 0], angle: -10 } } });
const r8 = await build();
check("stage 8 builds", !r8.errors.length, r8.bodies.map((b: any) => b.id).join(", "));

// --- Checks.
const V = (id: string) => Math.abs(measureVolume(debugBodies().get(id)!));
const without = async (ids: string[], body: string) => {
  const r: any = await regenerate(doc().features.filter((f: any) => !ids.includes(f.id)));
  const v = r.errors.length ? NaN : V(body);
  await regenerate(doc().features);
  return v;
};
const t0 = Date.now();
const r: any = await build();
const ms = Date.now() - t0;
check("every step builds", !r.errors.length, `${doc().features.length} steps in ${ms} ms`);
const ids = ["stand", "house", "houseSplit", "rotor", "nut"];
check("five clean solids: stand, housing front (with guards), back cover (with handle), rotor, nut", r.bodies.length === 5 && ids.every((i) => debugBodies().has(i) && isHealthy(healthOf(debugBodies().get(i)!))), r.bodies.map((b: any) => b.id).join(", "));
const bb = ids.map((i) => (debugBodies().get(i) as any).boundingBox.bounds);
const lo = [0, 1, 2].map((k) => Math.min(...bb.map((b: any) => b[0][k])));
const hi = [0, 1, 2].map((k) => Math.max(...bb.map((b: any) => b[1][k])));
check("stands on the ground; about 220 wide, 330 tall", Math.abs(lo[2]) < 1e-6 && hi[0] - lo[0] > 215 && hi[0] - lo[0] < 225 && hi[2] > 315 && hi[2] < 345, [0, 1, 2].map((k) => (hi[k] - lo[k]).toFixed(1)).join(" × "));
const vStand = V("stand");
const noName = await without(["nameUp"], "stand");
check("the name stands up from the base", vStand - noName > 50, `${(vStand - noName).toFixed(1)} mm³ of letters`);
const noBtns = await without(["btn", "btns", "btnJoin"], "stand");
check("three buttons with rounded corners on the base", Math.abs(vStand - noName - (noName - noBtns) * 0 - (vStand - noBtns) + (vStand - noBtns)) >= 0 && Math.abs(vStand - noBtns - 3 * (14 * 8 - (4 - Math.PI) * 4) * 4) < 3 * 4 * 2, `${(vStand - noBtns).toFixed(1)} mm³`);
const noDome = await without(["dome", "domeFill", "domeOn"], "stand");
check("the switch dome sits on the base (Fill to Plane, joined)", vStand - noDome > 2000, `${((vStand - noDome) / 1000).toFixed(1)} cm³`);
const noVents = await without(["vents"], "houseSplit");
check("five vents cut through the back cover", noVents - V("houseSplit") > 5 * 4 * 36 * 2 * 0.5, `${(noVents - V("houseSplit")).toFixed(1)} mm³ taken out`);
const noHandle = await without(["handle", "handleOn"], "houseSplit");
check("the handle is one with the back cover", V("houseSplit") - noHandle > 3000, `${((V("houseSplit") - noHandle) / 1000).toFixed(1)} cm³`);
const inter = (a: string, b: string) => Math.abs(measureVolume((debugBodies().get(a) as any).intersect(debugBodies().get(b))));
check("the head turns free: pivot clear of the yoke, rotor clear of the housing and guards", inter("house", "stand") < 1 && inter("rotor", "house") < 1 && inter("rotor", "houseSplit") < 1, `${inter("house", "stand").toFixed(2)}, ${inter("rotor", "house").toFixed(2)}`);
const hubC = (debugBodies().get("rotor") as any).boundingBox.center;
check("the head tilted up 10° (the hub above the pivot)", hubC[2] > 215 + 3, `hub at z ${hubC[2].toFixed(1)}`);
const d = doc();
check("the blade count and reach come from variables", d.features.find((f: any) => f.id === "bladeRound").op.count === 5 && Math.abs(d.features.find((f: any) => f.id === "sTrim").entities[0].radius - 92) < 1e-6);
const d2: any = { ...doc(), variables: [{ name: "blades", expr: "5" }, { name: "reach", expr: "95 mm" }] };
resolveDoc(d2);
check("…longer blades are one change", Math.abs(d2.features.find((f: any) => f.id === "sTrim").entities[0].radius - 95) < 1e-6);

const codeV = new Map(["stand", "house", "houseSplit", "rotor", "nut"].map((c) => [c, Math.abs(measureVolume(debugBodies().get(c)!))]));

// The same fan built by hand on a phone-sized screen, as a beginner would
// (tests/fixtures/fan-hand.json, 81 steps): every value typed or snapped (line
// X / Y and across / up, spline points typed, arcs by their centre, Rotate
// About a centre tapped), shapes picked in Items (Subtract, Union, Intersect),
// axes from the axis list or a round edge, colours with Custom. Part by part
// it has to come out the same as by code.
{
  const hd = JSON.parse(readFileSync(new URL("./fixtures/fan-hand.json", import.meta.url), "utf8"));
  resolveDoc(hd);
  const rh: any = await regenerate(hd.features);
  check("by hand: every step builds", !rh.errors.length, rh.errors.map((e: any) => `${hd.features.find((f: any) => f.id === e.featureId)?.name}: ${e.message}`).join("; "));
  const pairs: [string, string, string][] = [
    ["stand", "extrude-mw5nqw1u-c3s9", "stand (base, name, buttons, dome, pole, yoke)"],
    ["house", "split-mw5ojrqx-w9ry", "housing front (pivot, spindle)"],
    ["houseSplit", "revolve-mw5oi2ao-q3bl", "back cover (vents, guards, handle)"],
    ["rotor", "revolve-mw5otaeo-dn4p", "rotor (hub, five blades)"],
    ["nut", "extrude-mw5ovmpp-3f7x", "nut"],
  ];
  const handV = new Map(pairs.map(([, h]) => [h, debugBodies().has(h) ? Math.abs(measureVolume(debugBodies().get(h)!)) : NaN]));
  check("by hand: five clean solids, the same parts", rh.bodies.length === 5 && pairs.every(([, h]) => debugBodies().has(h) && isHealthy(healthOf(debugBodies().get(h)!))), rh.bodies.map((b: any) => b.id).join(", "));
  const hb = pairs.map(([, h]) => (debugBodies().get(h) as any)?.boundingBox.bounds).filter(Boolean);
  const hlo = [0, 1, 2].map((k) => Math.min(...hb.map((b: any) => b[0][k])));
  const hhi = [0, 1, 2].map((k) => Math.max(...hb.map((b: any) => b[1][k])));
  for (const [c, h, what] of pairs) check(`by hand: ${what} the same as by code`, Math.abs(handV.get(h)! - codeV.get(c)!) < codeV.get(c)! * 2e-3, `${(handV.get(h)! / 1000).toFixed(2)} / ${(codeV.get(c)! / 1000).toFixed(2)} cm³`);
  check("by hand: the same size", [0, 1, 2].every((k) => Math.abs(hhi[k] - hlo[k] - (hi[k] - lo[k])) < 0.5), [0, 1, 2].map((k) => (hhi[k] - hlo[k]).toFixed(1)).join(" × "));
  check("by hand: blade count and reach from the variables", hd.features.some((f: any) => f.exprs?.["op.count"] === "blades") && hd.features.some((f: any) => f.constraints?.some((c: any) => c.expr === "reach*2")));
}

if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify({ ...doc(), hidden: feats.filter((f) => f.type === "sketch" || f.type === "plane" || f.type === "axis").map((f) => f.id), colors: { stand: "#efeae0", house: "#2f6f8f", houseSplit: "#2f6f8f", rotor: "#dfe4ea", nut: "#9aa3ad" } }));
process.exit(failed ? 1 : 0);
