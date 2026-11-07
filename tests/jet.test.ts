// Run: npx tsx tests/jet.test.ts [out.json] - a turbofan jet engine on a
// display stand, cut away to show what's inside, made with every tool: the
// ones the fan used and the ones no build had used yet - a reference Image to
// trace, Import (an STL sensor pod) and Repair, Delete Face, Delete (a body),
// Scale per axis, Revolve with travel (a coil), Sweep along a model edge, a
// thickened Freeform sheet, a polyline, sketch constraints driven by variables.
import opencascade from "replicad-opencascadejs";
import { makeBaseBox, measureArea, measureVolume, setOC } from "replicad";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import opentype from "opentype.js";
const { parse } = opentype as any;
import { debugBodies, regenerate } from "../src/kernel/engine";
import { healthOf, isHealthy } from "../src/kernel/repair";
import { arrangement, materialRegions, regionRef } from "../src/sketch/regions";
import { textOutlines } from "../src/sketch/textLayout";
import { filletCorner } from "../src/sketch/edit";
import { planeCage } from "../src/freeform/cage";
import { resolveDoc } from "../src/doc/params";
import { faceBeforeShell } from "../src/tools/shellFace";
import type { PlaneDef, Vec3 } from "../src/doc/types";

setOC(await (opencascade as unknown as () => Promise<any>)());
let failed = 0;
const check = (name: string, ok: boolean, info = "") => {
  if (!ok) failed++;
  console.log(ok ? "ok  " : "FAIL", name, info);
};

// The same engine built by hand on a phone-sized screen, as a beginner would
// (tests/fixtures/jet-hand.json, 118 steps): every value typed or picked from
// a list (planes and axes by name, bodies in Items), the side view and the STL
// pod picked as files. (Its core's front end was tapped from inside, through
// the end opened on the preview, before Shell took such a tap as that end: that
// one face is stored as faceBeforeShell gives it now.) Replayed first, while the geometry engine's memory is
// fresh (after the code build and its checks it ran out); compared part by
// part at the end.
const handFile = new URL("./fixtures/jet-hand.json", import.meta.url);
let hand: { errors: string[]; bodies: { id: string; v: number; ok: boolean }[]; vars: boolean } | null = null;
if (existsSync(handFile)) {
  const hd = JSON.parse(readFileSync(handFile, "utf8"));
  resolveDoc(hd);
  const rh: any = await regenerate(hd.features);
  hand = {
    errors: rh.errors.map((e: any) => `${hd.features.find((f: any) => f.id === e.featureId)?.name}: ${e.message}`),
    bodies: rh.bodies.map((b: any) => ({ id: b.id, v: Math.abs(measureVolume(debugBodies().get(b.id)!)), ok: isHealthy(healthOf(debugBodies().get(b.id)!)) })),
    vars: ["fanBlades", "stages"].every((v) => hd.features.some((f: any) => Object.values(f.exprs ?? {}).includes(v))) && hd.features.some((f: any) => f.constraints?.some((c: any) => /fanR/.test(c.expr ?? ""))),
  };
  await regenerate([]);
}

// The two files a beginner would pick: a sensor pod as an STL (long along Y,
// so it has to be turned to fit) and a side view to trace.
const podFile = new URL("./fixtures/jet-pod.stl", import.meta.url);
if (!existsSync(podFile)) {
  const pod = makeBaseBox(14, 40, 20).fillet(3).translate([0, 0, -10]);
  writeFileSync(podFile, Buffer.from(await (pod.blobSTL({ binary: true, tolerance: 0.05, angularTolerance: 0.2 }) as Blob).arrayBuffer()));
}
const refFile = new URL("./fixtures/jet-ref.svg", import.meta.url);
if (!existsSync(refFile))
  writeFileSync(
    refFile,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-60 -320 480 320" width="480" height="320"><rect x="-60" y="-320" width="480" height="320" fill="#fff"/><g fill="none" stroke="#335" stroke-width="2"><path d="M0,-250 A7,7 0 0 0 0,-264 C80,-268 200,-266 300,-258 L300,-250 Z"/><path d="M40,-212 C60,-214 200,-212 320,-206"/><path d="M-45,-150 A45,30 0 0 1 0,-180 L0,-150"/><line x1="-60" y1="-150" x2="420" y2="-150" stroke-dasharray="8 6"/></g></svg>`,
  );

let n = 0;
const id = () => `e${n++}`;
const XY = (z = 0): PlaneDef => ({ origin: [0, 0, z], normal: [0, 0, 1], xDir: [1, 0, 0] });
const XZ = (y = 0): PlaneDef => ({ origin: [0, y, 0], normal: [0, -1, 0], xDir: [1, 0, 0] }); // u = x, v = z, normal to the front
const YZ = (x = 0): PlaneDef => ({ origin: [x, 0, 0], normal: [1, 0, 0], xDir: [0, 1, 0] }); // u = y, v = z
const all = (es: any[]) => arrangement(es).regions.map(regionRef);
const feats: any[] = [];
const variables = [
  { name: "fanBlades", expr: "16" },
  { name: "fanR", expr: "97 mm" },
  { name: "stages", expr: "3" },
];
const doc = () => {
  const d: any = { format: "super", version: 2, name: "Jet engine", features: structuredClone(feats), variables, views: [], units: "mm", hidden: [], pins: [], names: {} };
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
const edgeWhere = (body: string, test: (p: number[], a: number[], b: number[]) => boolean) => {
  const e = (debugBodies().get(body) as any).edges.find((e: any) => test(e.pointAt(0.5).toTuple(), e.startPoint.toTuple(), e.endPoint.toTuple()));
  if (!e) throw new Error(`no such edge on ${body}`);
  return { body, mid: e.pointAt(0.5).toTuple() as Vec3, dir: e.tangentAt(0.5).toTuple() as Vec3, length: e.length as number };
};
const near = (a: number, b: number, t = 1e-6) => Math.abs(a - b) < t;
const C = 150; // the engine's centre line, 150 above the ground, along X (air flows to +X)
const AX: Vec3 = [0, 0, C];
const axisRef = { origin: AX, dir: [1, 0, 0] as Vec3, ref: { kind: "axis", feature: "axis" } };
const ring = (k: number, r: number, a0 = 0) => Array.from({ length: k }, (_, i) => [r * Math.cos(a0 + (2 * Math.PI * i) / k), r * Math.sin(a0 + (2 * Math.PI * i) / k)]);
void ring;

// --- 0. A side view to trace from (Image), the centre line (Axis).
feats.push({ id: "ref", name: "Side view", type: "image", plane: XZ(0), src: "data:image/svg+xml;base64," + readFileSync(refFile).toString("base64"), width: 480, height: 320, opacity: 0.5 });
feats.push({ id: "axis", name: "Centre line", type: "axis", origin: AX, dir: [1, 0, 0] });

// --- 1. The nacelle: its wall in section - the inlet lip (an arc), the outside
// (a spline), the back edge and the inside (lines) - turned round the centre line.
const nac = [
  { id: "n1", kind: "arc", a: [0, 250], m: [-7, 257], b: [0, 264] },
  { id: "n2", kind: "spline", points: [[0, 264], [80, 268], [200, 266], [300, 258]], closed: false, mode: "fit" },
  { id: "n3", kind: "line", a: [300, 258], b: [300, 250] },
  { id: "n4", kind: "line", a: [300, 250], b: [0, 250] },
];
feats.push({ id: "sNac", name: "Nacelle wall", type: "sketch", plane: XZ(0), entities: nac });
feats.push({ id: "nacelle", name: "Nacelle", type: "revolve", source: { kind: "profile", sketch: "sNac", regions: all(nac) }, axis: axisRef, angle: 360, mode: "new" });

// --- 2. The core cowl: a solid turned from its outline (straight in the middle, for the coil), hollowed 2 with both
// ends open (Shell); eight guide vanes across the bypass to the nacelle
// (a rectangle on a plane at the cowl, pulled up 40, Pattern Circular).
const core = [
  { id: "k1", kind: "line", a: [40, C], b: [40, 212] },
  { id: "k2", kind: "spline", points: [[40, 212], [70, 214], [120, 214]], closed: false, mode: "fit" },
  { id: "k5", kind: "line", a: [120, 214], b: [200, 214] },
  { id: "k6", kind: "spline", points: [[200, 214], [260, 212], [320, 206]], closed: false, mode: "fit" },
  { id: "k3", kind: "line", a: [320, 206], b: [320, C] },
  { id: "k4", kind: "line", a: [320, C], b: [40, C] },
];
feats.push({ id: "sCore", name: "Core outline", type: "sketch", plane: XZ(0), entities: core });
feats.push({ id: "core", name: "Core cowl", type: "revolve", source: { kind: "profile", sketch: "sCore", regions: all(core) }, axis: axisRef, angle: 360, mode: "new" });
await build();
{
  // On a phone the second end is tapped from inside, through the end already
  // opened on the preview: that inner face is the end face of the core.
  const faces = (debugBodies().get("core") as any).faces.map((f: any) => ({ body: "core", center: f.center.toTuple(), normal: f.normalAt().toTuple(), area: measureArea(f) }));
  const inside = { body: "core", center: [41, 0, C] as Vec3, normal: [1, 0, 0] as Vec3, area: 11715 };
  const m = faceBeforeShell(faces, inside, 1);
  check("an end tapped from inside the shell's preview is the end itself", near(m.center[0], 40) && m.normal[0] < -0.99, `${m.center.map((x) => x.toFixed(1))} ${m.normal.map((x) => x.toFixed(2))}`);
}
feats.push({ id: "coreShell", name: "Hollow the core", type: "shell", body: "core", faces: [faceWhere("core", (c, nrm) => near(c[0], 40) && nrm[0] < -0.99), faceWhere("core", (c, nrm) => near(c[0], 320) && nrm[0] > 0.99)], thickness: 2 });
const vane = [{ id: id(), kind: "rect", center: [75, 0], w: 30, h: 3, rotation: 0 }];
feats.push({ id: "pVane", name: "On the core", type: "plane", plane: XY(), offset: 211 });
feats.push({ id: "sVane", name: "Guide vane", type: "sketch", plane: XY(211), entities: vane });
feats.push({ id: "vane", name: "Guide vane", type: "extrude", source: { kind: "profile", sketch: "sVane", regions: all(vane) }, distance: 41, mode: "new" });
feats.push({ id: "vanes", name: "Guide vanes", type: "transform", bodies: ["vane"], copy: true, op: { kind: "circular", axis: axisRef, count: 8, angle: 360 } });
feats.push({ id: "casing", name: "Casing in one", type: "boolean", op: "union", target: "nacelle", tools: ["vane", ...Array.from({ length: 7 }, (_, k) => `vanes:vane:${k}`), "core"] });
const r1 = await build();
check("stage 1 builds (nacelle, core, vanes in one)", !r1.errors.length, r1.bodies.map((b: any) => b.id).join(", "));

// --- 3. The fan: a quarter of an ellipse 45 x 30 turned round (Revolve) for
// the spinner; a hub; a blade lofted from a fat, little turned root to a thin,
// more turned tip, its tip trimmed round (Intersect); as many round as
// "fanBlades" says (Pattern Circular); all one (Union).
const sp = [
  { id: "p1", kind: "ellipse", center: [0, C], rx: 45, ry: 30, rotation: 0 },
  { id: "p2", kind: "line", a: [-50, C], b: [0, C] },
  { id: "p3", kind: "line", a: [0, C], b: [0, C + 35] },
];
const spQ = arrangement(sp as any).regions.map(regionRef).filter((r) => r.c[0] < 0 && r.c[1] > C && r.a < 2000);
check("the spinner's quarter of the ellipse", spQ.length === 1 && Math.abs(spQ[0].a - (Math.PI * 45 * 30) / 4) < 20, spQ.map((r) => r.a.toFixed(0)).join(" "));
feats.push({ id: "sSpin", name: "Spinner", type: "sketch", plane: XZ(0), entities: sp });
feats.push({ id: "spinner", name: "Spinner", type: "revolve", source: { kind: "profile", sketch: "sSpin", regions: spQ }, axis: axisRef, angle: 360, mode: "new" });
const hub = [{ id: id(), kind: "circle", center: [0, C], radius: 30 }];
feats.push({ id: "sHub", name: "Fan hub", type: "sketch", plane: YZ(0), entities: hub });
feats.push({ id: "fan", name: "Fan hub", type: "extrude", source: { kind: "profile", sketch: "sHub", regions: all(hub) }, distance: 24, mode: "new" });
const root = [{ id: id(), kind: "ellipse", center: [12, 0], rx: 11, ry: 3, rotation: (30 * Math.PI) / 180 }];
const tip = [{ id: id(), kind: "ellipse", center: [12, 0], rx: 16, ry: 1.5, rotation: (60 * Math.PI) / 180 }];
feats.push({ id: "pRoot", name: "Blade root", type: "plane", plane: XY(), offset: 178 });
feats.push({ id: "pTip", name: "Blade tip", type: "plane", plane: XY(), offset: 252 });
feats.push({ id: "sRoot", name: "Blade root", type: "sketch", plane: XY(178), entities: root });
feats.push({ id: "sTip", name: "Blade tip", type: "sketch", plane: XY(252), entities: tip });
feats.push({ id: "blade", name: "Fan blade", type: "loft", sections: [{ kind: "profile", sketch: "sRoot", regions: all(root) }, { kind: "profile", sketch: "sTip", regions: all(tip) }], ruled: false, mode: "new" });
const trim = [{ id: "reach", kind: "circle", center: [0, C], radius: 97 }];
feats.push({ id: "sTrim", name: "Fan reach", type: "sketch", plane: YZ(-10), entities: trim, constraints: [{ id: "dReach", type: "dim", curves: ["reach"], prop: "diameter", value: 194, expr: "fanR*2" }] });
feats.push({ id: "trim", name: "Fan reach", type: "extrude", source: { kind: "profile", sketch: "sTrim", regions: all(trim) }, distance: 50, mode: "new" });
feats.push({ id: "bladeTrim", name: "Trim the tip", type: "boolean", op: "intersect", target: "blade", tools: ["trim"] });
feats.push({ id: "fanRound", name: "Fan blades", type: "transform", bodies: ["blade"], copy: true, op: { kind: "circular", axis: axisRef, count: 16, angle: 360 }, exprs: { "op.count": "fanBlades" } });
feats.push({ id: "fanJoin", name: "Fan in one", type: "boolean", op: "union", target: "fan", tools: ["spinner", "blade", ...Array.from({ length: 15 }, (_, k) => `fanRound:blade:${k}`)] });
const r2 = await build();
check("stage 2 builds (fan)", !r2.errors.length, r2.bodies.map((b: any) => b.id).join(", "));

// --- 4. Compressor: a disc and fourteen blades (a rectangle turned 35°,
// pulled up 30, Pattern Circular), the stage repeated "stages" times along the
// centre line (Pattern Linear).
const disc = [{ id: id(), kind: "circle", center: [0, C], radius: 30 }];
feats.push({ id: "sDisc", name: "Compressor disc", type: "sketch", plane: YZ(50), entities: disc });
feats.push({ id: "comp", name: "Compressor", type: "extrude", source: { kind: "profile", sketch: "sDisc", regions: all(disc) }, distance: 8, mode: "new" });
const cb = [{ id: id(), kind: "rect", center: [54, 0], w: 6, h: 2, rotation: (35 * Math.PI) / 180 }];
feats.push({ id: "sCB", name: "Compressor blade", type: "sketch", plane: XY(178), entities: cb });
feats.push({ id: "cBlade", name: "Compressor blade", type: "extrude", source: { kind: "profile", sketch: "sCB", regions: all(cb) }, distance: 30, mode: "new" });
feats.push({ id: "cBlades", name: "Compressor blades", type: "transform", bodies: ["cBlade"], copy: true, op: { kind: "circular", axis: axisRef, count: 14, angle: 360 } });
feats.push({ id: "compJoin", name: "Stage in one", type: "boolean", op: "union", target: "comp", tools: ["cBlade", ...Array.from({ length: 13 }, (_, k) => `cBlades:cBlade:${k}`)] });
feats.push({ id: "stagesP", name: "Stages", type: "transform", bodies: ["comp"], copy: true, op: { kind: "linear", dir: [1, 0, 0], spacing: 24, count: 3 }, exprs: { "op.count": "stages" } });

// --- 5. Combustor: an ellipse turned round (Revolve), ten fuel nozzles into it.
const comb = [{ id: id(), kind: "ellipse", center: [170, 192], rx: 22, ry: 10, rotation: 0 }];
feats.push({ id: "sComb", name: "Combustor", type: "sketch", plane: XZ(0), entities: comb });
feats.push({ id: "comb", name: "Combustor", type: "revolve", source: { kind: "profile", sketch: "sComb", regions: all(comb) }, axis: axisRef, angle: 360, mode: "new" });
const noz = [{ id: id(), kind: "circle", center: [0, 192], radius: 2 }];
feats.push({ id: "sNoz", name: "Fuel nozzle", type: "sketch", plane: YZ(135), entities: noz });
feats.push({ id: "noz", name: "Fuel nozzle", type: "extrude", source: { kind: "profile", sketch: "sNoz", regions: all(noz) }, distance: 20, mode: "new" });
feats.push({ id: "nozs", name: "Fuel nozzles", type: "transform", bodies: ["noz"], copy: true, op: { kind: "circular", axis: axisRef, count: 10, angle: 360 } });
feats.push({ id: "combJoin", name: "Combustor in one", type: "boolean", op: "union", target: "comb", tools: ["noz", ...Array.from({ length: 9 }, (_, k) => `nozs:noz:${k}`)] });

// --- 6. Turbine: a disc and twenty blades turned the other way.
const td = [{ id: id(), kind: "circle", center: [0, C], radius: 26 }];
feats.push({ id: "sTD", name: "Turbine disc", type: "sketch", plane: YZ(225), entities: td });
feats.push({ id: "turb", name: "Turbine", type: "extrude", source: { kind: "profile", sketch: "sTD", regions: all(td) }, distance: 8, mode: "new" });
const tb = [{ id: id(), kind: "rect", center: [229, 0], w: 7, h: 2, rotation: (-40 * Math.PI) / 180 }];
feats.push({ id: "sTB", name: "Turbine blade", type: "sketch", plane: XY(174), entities: tb });
feats.push({ id: "tBlade", name: "Turbine blade", type: "extrude", source: { kind: "profile", sketch: "sTB", regions: all(tb) }, distance: 32, mode: "new" });
feats.push({ id: "tBlades", name: "Turbine blades", type: "transform", bodies: ["tBlade"], copy: true, op: { kind: "circular", axis: axisRef, count: 20, angle: 360 } });
feats.push({ id: "turbJoin", name: "Turbine in one", type: "boolean", op: "union", target: "turb", tools: ["tBlade", ...Array.from({ length: 19 }, (_, k) => `tBlades:tBlade:${k}`)] });

// --- 7. The shaft through it all, a threaded tail made longer (Offset Face,
// Thread), a nut on it; fan, compressor, turbine and tail one rotor (Union).
const sh = [{ id: id(), kind: "circle", center: [0, C], radius: 6 }];
feats.push({ id: "sShaft", name: "Shaft", type: "sketch", plane: YZ(10), entities: sh });
feats.push({ id: "shaft", name: "Shaft", type: "extrude", source: { kind: "profile", sketch: "sShaft", regions: all(sh) }, distance: 330, mode: "new" });
const tl = [{ id: id(), kind: "circle", center: [0, C], radius: 5 }];
feats.push({ id: "sTail", name: "Shaft tail", type: "sketch", plane: YZ(340), entities: tl });
feats.push({ id: "tail", name: "Shaft tail", type: "extrude", source: { kind: "profile", sketch: "sTail", regions: all(tl) }, distance: 10, mode: "new" });
feats.push({ id: "tailOut", name: "Longer tail", type: "moveFace", face: { body: "tail", center: [350, 0, C], normal: [1, 0, 0], area: Math.PI * 25 }, translate: [6, 0, 0] });
await build();
feats.push({ id: "tailThread", name: "Thread the tail", type: "thread", face: faceWhere("tail", (c, nrm) => Math.abs(nrm[0]) < 1e-6), pitch: 1.5 });
const nut = [
  { id: "u1", kind: "polygon", center: [0, C], radius: 8.5, sides: 6, angle: 0 },
  { id: "u2", kind: "circle", center: [0, C], radius: 4 },
];
feats.push({ id: "sNut", name: "Nut", type: "sketch", plane: YZ(344), entities: nut });
feats.push({ id: "nut", name: "Nut", type: "extrude", source: { kind: "profile", sketch: "sNut", regions: all(nut).filter((r) => r.a > 100) }, distance: 6, mode: "new" });
await build();
feats.push({ id: "nutThread", name: "Thread the nut", type: "thread", face: faceWhere("nut", (c, nrm) => Math.abs(nrm[0]) < 1e-6 && Math.hypot(c[1], c[2] - C) < 4.5 && (c[1] * nrm[1] + (c[2] - C) * nrm[2]) < 0.01), pitch: 1.5 });
feats.push({ id: "rotor", name: "Rotor in one", type: "boolean", op: "union", target: "shaft", tools: ["fan", "comp", "stagesP:comp:0", "stagesP:comp:1", "turb", "tail"] });
const r3 = await build();
check("stage 3 builds (rotor, combustor, nut)", !r3.errors.length, r3.bodies.map((b: any) => b.id).join(", "));

// --- 8. The exhaust: a nozzle lofted from Ø116 to Ø88 and hollowed 2.5
// (Loft, Shell), a cone in it (Extrude with Taper) held by three struts;
// all one with the casing.
const e1 = [{ id: id(), kind: "circle", center: [0, C], radius: 58 }];
const e2 = [{ id: id(), kind: "circle", center: [0, C], radius: 44 }];
feats.push({ id: "pNoz", name: "Nozzle end", type: "plane", plane: YZ(), offset: 400 });
feats.push({ id: "sE1", name: "Nozzle start", type: "sketch", plane: YZ(318), entities: e1 });
feats.push({ id: "sE2", name: "Nozzle end", type: "sketch", plane: YZ(400), entities: e2 });
feats.push({ id: "exh", name: "Nozzle", type: "loft", sections: [{ kind: "profile", sketch: "sE1", regions: all(e1) }, { kind: "profile", sketch: "sE2", regions: all(e2) }], ruled: true, mode: "new" });
await build();
feats.push({ id: "exhShell", name: "Hollow the nozzle", type: "shell", body: "exh", faces: [faceWhere("exh", (c, nrm) => near(c[0], 318) && nrm[0] < -0.99), faceWhere("exh", (c, nrm) => near(c[0], 400) && nrm[0] > 0.99)], thickness: 2.5 });
const plug = [{ id: id(), kind: "circle", center: [0, C], radius: 22 }];
feats.push({ id: "sPlug", name: "Exhaust cone", type: "sketch", plane: YZ(362), entities: plug });
feats.push({ id: "plug", name: "Exhaust cone", type: "extrude", source: { kind: "profile", sketch: "sPlug", regions: all(plug) }, distance: 45, taper: 0.1, mode: "new" });
const strut = [{ id: id(), kind: "rect", center: [375, 0], w: 16, h: 3, rotation: 0 }];
feats.push({ id: "sStrut", name: "Strut", type: "sketch", plane: XY(C + 12), entities: strut });
feats.push({ id: "strut", name: "Strut", type: "extrude", source: { kind: "profile", sketch: "sStrut", regions: all(strut) }, distance: 36, mode: "new" });
feats.push({ id: "struts", name: "Struts", type: "transform", bodies: ["strut"], copy: true, op: { kind: "circular", axis: axisRef, count: 3, angle: 360 } });
feats.push({ id: "exhJoin", name: "Exhaust in one", type: "boolean", op: "union", target: "nacelle", tools: ["exh", "strut", "struts:strut:0", "struts:strut:1", "plug"] });

// --- 9. A heat-exchanger coil round the core: a Ø5 circle turned twice round
// the centre line while moving 40 along it (Revolve with travel), one with the casing.
const coil = [{ id: id(), kind: "circle", center: [140, C + 63], radius: 2.5 }];
feats.push({ id: "sCoil", name: "Coil", type: "sketch", plane: XZ(0), entities: coil });
feats.push({ id: "coil", name: "Coil", type: "revolve", source: { kind: "profile", sketch: "sCoil", regions: all(coil) }, axis: axisRef, angle: 720, travel: 40, mode: "new" });
await build();
const coilV = Math.abs(measureVolume(debugBodies().get("coil")!));
feats.push({ id: "coilOn", name: "Coil on the core", type: "boolean", op: "union", target: "nacelle", tools: ["coil"] });
const r4 = await build();
check("stage 4 builds (exhaust, coil)", !r4.errors.length, r4.bodies.map((b: any) => b.id).join(", "));

// --- 10. Cut away the front half of the casing to show what's inside (Split
// Body on the centre plane, Delete the half nearest you).
feats.push({ id: "cut", name: "Cutaway", type: "split", body: "nacelle", plane: { origin: [0, 0, 0], normal: [0, -1, 0], xDir: [1, 0, 0] } });
feats.push({ id: "cutDel", name: "Take the front half away", type: "delete", bodies: ["cut"] });

// --- 11. The pylon on top: its side as a polyline, 12 thick, joined; its top
// pushed up onto a plane 320 high (Replace Face), narrowed (Scale Face); a
// mounting flange with rounded corners (sketch Fillet) and eight bolt holes
// (sketch Pattern, sketch Mirror), one hole plugged again (Delete Face); the
// flange's top edges bevelled (Chamfer), the pylon's front edges rounded (Fillet);
// the engine's name on its side (Text). The pylon is shaped as a part of its
// own, then joined: tilting its sides where they run into the nacelle's curve
// left hair-thin faces.
const py = [{ id: "py", kind: "polyline", points: [[110, 260], [270, 260], [250, 310], [140, 310]], closed: true }];
feats.push({ id: "sPylon", name: "Pylon", type: "sketch", plane: XZ(6), entities: py });
feats.push({ id: "pylon", name: "Pylon", type: "extrude", source: { kind: "profile", sketch: "sPylon", regions: all(py) }, distance: 12, mode: "new" });
feats.push({ id: "pTop", name: "Pylon top", type: "plane", plane: XY(), offset: 320 });
await build();
feats.push({ id: "pyUp", name: "Pylon up to the plane", type: "replaceFace", face: faceWhere("pylon", (c, nrm) => near(c[2], 310) && nrm[2] > 0.99), plane: { origin: [0, 0, 320], normal: [0, 0, -1], xDir: [1, 0, 0] } });
await build();
feats.push({ id: "pyNarrow", name: "Narrow the top", type: "scaleFace", face: faceWhere("pylon", (c, nrm) => near(c[2], 320) && nrm[2] > 0.99), u: [1, 0, 0], factors: [0.9, 1] });
feats.push({ id: "pylonOn", name: "Pylon on the nacelle", type: "boolean", op: "union", target: "nacelle", tools: ["pylon"] });
let fl: any[] = [{ id: "f1", kind: "rect", center: [195, 0], w: 140, h: 40, rotation: 0 }];
for (const c of [[125, -20], [265, -20], [265, 20], [125, 20]] as [number, number][]) fl = filletCorner(fl, c, 6, 0.5) ?? fl;
check("flange corners rounded in the sketch (4 arcs)", fl.filter((e) => e.kind === "arc").length === 4);
feats.push({ id: "sFlange", name: "Flange", type: "sketch", plane: XY(320), entities: fl });
feats.push({ id: "flange", name: "Flange", type: "extrude", source: { kind: "profile", sketch: "sFlange", regions: all(fl) }, distance: 6, mode: "join", target: "nacelle" });
const holes = [0, 1, 2, 3].flatMap((k) => [12, -12].map((y) => ({ id: `h${k}${y > 0 ? "a" : "b"}`, kind: "circle", center: [145 + 33 * k, y], radius: 4 })));
feats.push({ id: "sHoles", name: "Bolt holes", type: "sketch", plane: XY(326), entities: holes });
feats.push({ id: "holes", name: "Bolt holes", type: "extrude", source: { kind: "profile", sketch: "sHoles", regions: all(holes) }, distance: -6, mode: "cut", target: "nacelle" });
await build();
const prePlug = Math.abs(measureVolume(debugBodies().get("nacelle")!));
feats.push({ id: "plugHole", name: "Plug a hole", type: "deleteGeom", body: "nacelle", faces: [faceWhere("nacelle", (c, nrm) => near(c[0], 244, 0.5) && near(c[1], 12, 0.5) && near(c[2], 323, 0.5) && Math.abs(nrm[2]) < 1e-6)], edges: [], vertices: [] });
await build();
const plugV = Math.abs(measureVolume(debugBodies().get("nacelle")!)) - prePlug;
feats.push({ id: "flChamfer", name: "Bevel the flange", type: "chamfer", edges: [edgeWhere("nacelle", (p) => near(p[2], 326) && near(p[0], 195) && near(Math.abs(p[1]), 20))], radius: 1 });
const nm = textOutlines(parse((({ buffer: b, byteOffset: o, byteLength: l }) => b.slice(o, o + l))(readFileSync(new URL("../node_modules/@fontsource/roboto/files/roboto-latin-400-normal.woff", import.meta.url)))), "SG-1", [190, 282], 14, 0, "center");
feats.push({ id: "sName", name: "Name", type: "sketch", plane: { origin: [0, -6, 0], normal: [0, -1, 0], xDir: [1, 0, 0] }, entities: nm });
if (process.env.DBG) { await build(); const nb: any = debugBodies().get("nacelle"); for (const f of nb.faces) { const c = f.center.toTuple(); if (Math.abs(c[1] + 6) < 0.01) console.log("face y-6", f.geomType, JSON.stringify(f.boundingBox.bounds.map((p: number[]) => p.map((x) => +x.toFixed(2)))), f.normalAt().toTuple().map((x: number) => +x.toFixed(3))); } console.log("dbg-mark"); }
await build();
const preName = Math.abs(measureVolume(debugBodies().get("nacelle")!));
feats.push({ id: "nameUp", name: "Raise the name", type: "extrude", source: { kind: "profile", sketch: "sName", regions: materialRegions(arrangement(nm as any)).map(regionRef) }, distance: 1, mode: "join", target: "nacelle" });
if (process.env.DBG) { feats.find((f) => f.id === "nameUp").mode = "new"; await build(); const a: any = debugBodies().get("nacelle"), b: any = debugBodies().get("nameUp"); const va = measureVolume(a), vb = measureVolume(b), vf = measureVolume(a.fuse(b)); console.log("vols", va, vb, vf, "excess", vf - va - vb, "va again", measureVolume(a.clone())); feats.find((f) => f.id === "nameUp").mode = "join"; }
const r5 = await build();
const nameV = Math.abs(measureVolume(debugBodies().get("nacelle")!)) - preName;
check("stage 5 builds (cutaway, pylon, flange)", !r5.errors.length, r5.bodies.map((b: any) => b.id).join(", "));

// --- 12. The sensor pod: an STL file (Import), made a clean solid (Repair),
// turned 90° and put against the side of the nacelle (Move/Rotate). It stays a
// part of its own, bolted on: a mesh's flat facets joined to the nacelle's
// curve would leave hair-thin slivers.
feats.push({ id: "pod", name: "Sensor pod", type: "import", format: "stl", fileName: "jet-pod.stl", data: readFileSync(podFile).toString("base64") });
feats.push({ id: "podFix", name: "Repair the pod", type: "repair", bodies: ["pod"] });
feats.push({ id: "podPut", name: "Pod on the side", type: "transform", bodies: ["pod"], copy: false, op: { kind: "move", translate: [150, 114, C], rotate: { origin: [0, 0, 0], axis: [0, 0, 1], angle: 90 } } });

// --- 13. The stand: a base plate with rounded corners (Fillet) and a
// rubber bumper along its front top edge (Sweep along the edge); a cradle
// block cut to the nacelle's curve by a cylinder (Subtract), mirrored to the
// back (Mirror about a plane); a drip tray (a Freeform sheet, its rim raised,
// 2 thick); all one.
const base = [{ id: id(), kind: "rect", center: [170, 0], w: 320, h: 150, rotation: 0 }];
feats.push({ id: "sBase", name: "Base plate", type: "sketch", plane: XY(0), entities: base });
feats.push({ id: "stand", name: "Base plate", type: "extrude", source: { kind: "profile", sketch: "sBase", regions: all(base) }, distance: 10, mode: "new" });
await build();
feats.push({ id: "baseRound", name: "Round the corners", type: "fillet", edges: [10, 330].flatMap((x) => [-75, 75].map((y) => edgeWhere("stand", (p) => near(p[0], x) && near(p[1], y) && near(p[2], 5)))), radius: 8 });
feats.push({ id: "bumperAt", name: "Bumper", type: "sketch", plane: YZ(18), entities: [{ id: "bp", kind: "circle", center: [-75, 10], radius: 3 }] });
await build();
const preBumper = Math.abs(measureVolume(debugBodies().get("stand")!));
feats.push({ id: "bumper", name: "Bumper", type: "sweep", source: { kind: "profile", sketch: "bumperAt", regions: all([{ id: "bp", kind: "circle", center: [-75, 10], radius: 3 }]) }, path: { kind: "edges", edges: [edgeWhere("stand", (p) => near(p[1], -75) && near(p[2], 10) && near(p[0], 170))] }, mode: "join", target: "stand" });
await build();
const bumperV = Math.abs(measureVolume(debugBodies().get("stand")!)) - preBumper;
const cr = [{ id: id(), kind: "rect", center: [0, 30], w: 130, h: 40, rotation: 0 }];
feats.push({ id: "sCradle", name: "Cradle", type: "sketch", plane: YZ(80), entities: cr });
feats.push({ id: "cradle", name: "Cradle", type: "extrude", source: { kind: "profile", sketch: "sCradle", regions: all(cr) }, distance: 14, mode: "new" });
const cy = [{ id: id(), kind: "circle", center: [0, C], radius: 118 }];
feats.push({ id: "sCut", name: "Cradle curve", type: "sketch", plane: YZ(70), entities: cy });
feats.push({ id: "cutter", name: "Cradle curve", type: "extrude", source: { kind: "profile", sketch: "sCut", regions: all(cy) }, distance: 40, mode: "new" });
feats.push({ id: "cradleCut", name: "Shape the cradle", type: "boolean", op: "subtract", target: "cradle", tools: ["cutter"] });
feats.push({ id: "pMidStand", name: "Between the cradles", type: "plane", plane: YZ(), offset: 120 });
feats.push({ id: "cradle2", name: "Back cradle", type: "transform", bodies: ["cradle"], copy: true, op: { kind: "mirror", plane: YZ(120) } });
const tray = planeCage([100, 90], 4, [250, 0, 10]);
tray.verts.forEach((p) => {
  if (Math.abs(Math.abs(p[0] - 250) - 50) < 1e-6 || Math.abs(Math.abs(p[1]) - 45) < 1e-6) p[2] += 8;
});
feats.push({ id: "tray", name: "Drip tray", type: "freeform", cage: tray, surface: true, thickness: 2, thickSide: "both" });
feats.push({ id: "trayLong", name: "Longer tray", type: "transform", bodies: ["tray"], copy: false, op: { kind: "scaleXYZ", center: [250, 0, 10], factors: [1.2, 1, 1] } });
feats.push({ id: "standJoin", name: "Stand in one", type: "boolean", op: "union", target: "stand", tools: ["cradle", "cradle2:cradle:0", "tray"] });
const r6 = await build();
check("stage 6 builds (pod, stand)", !r6.errors.length, r6.bodies.map((b: any) => b.id).join(", "));

// --- Checks.
const V = (id: string) => Math.abs(measureVolume(debugBodies().get(id)!));
const t0 = Date.now();
const r: any = await build();
const ms = Date.now() - t0;
check("every step builds", !r.errors.length, `${doc().features.length} steps in ${ms} ms`);
const ids = ["nacelle", "shaft", "comb", "nut", "pod", "stand"];
check("six clean solids: casing, rotor, combustor, nut, sensor pod, stand", r.bodies.length === 6 && ids.every((i) => debugBodies().has(i) && isHealthy(healthOf(debugBodies().get(i)!))), r.bodies.map((b: any) => `${b.id}${debugBodies().has(b.id) && isHealthy(healthOf(debugBodies().get(b.id)!)) ? "" : " (not clean)"}`).join(", "));
const bb = ids.filter((i) => debugBodies().has(i)).map((i) => (debugBodies().get(i) as any).boundingBox.bounds);
const lo = [0, 1, 2].map((k) => Math.min(...bb.map((b: any) => b[0][k])));
const hi = [0, 1, 2].map((k) => Math.max(...bb.map((b: any) => b[1][k])));
check("on the ground, about 450 long and 330 tall", near(lo[2], 0) && hi[0] - lo[0] > 430 && hi[0] - lo[0] < 470 && hi[2] > 320 && hi[2] < 340, [0, 1, 2].map((k) => (hi[k] - lo[k]).toFixed(1)).join(" × "));
const inter = (a: string, b: string) => Math.abs(measureVolume((debugBodies().get(a) as any).intersect(debugBodies().get(b))));
check("the rotor turns free: clear of the casing, the combustor and the nut", inter("shaft", "nacelle") < 1 && inter("shaft", "comb") < 1, `${inter("shaft", "nacelle").toFixed(2)}, ${inter("shaft", "comb").toFixed(2)}`);
const yb = (debugBodies().get("nacelle") as any).boundingBox.bounds;
check("cut away: nothing of the casing in front of the centre plane but the pylon, its name and flange", yb[0][1] > -20.5, `casing y from ${yb[0][1].toFixed(1)}`);
const vNac = V("nacelle");
const podBox = (debugBodies().get("pod") as any).boundingBox.bounds;
check("the imported pod, turned, sits against the side of the nacelle", near(podBox[1][0] - podBox[0][0], 40, 0.2) && podBox[0][1] < 118 && podBox[0][1] > 100 && inter("pod", "nacelle") > 100 && isHealthy(healthOf(debugBodies().get("pod")!)), `${podBox.map((p: number[]) => p.map((x) => x.toFixed(1)).join(",")).join(" / ")}`);
check("one bolt hole plugged (Delete Face)", Math.abs(plugV - Math.PI * 16 * 6) < 30, `${plugV.toFixed(1)} mm³`);
check("the coil winds twice round the core", Math.abs(coilV - 2 * 2 * Math.PI * 63 * Math.PI * 6.25) < 200, `${(coilV / 1000).toFixed(1)} cm³`);
check("the name stands up from the pylon", nameV > 50, `${nameV.toFixed(1)} mm³`);
const vStand = V("stand");
check("the bumper runs the length of the front edge (three quarters of it outside the plate)", Math.abs(bumperV - (3 / 4) * Math.PI * 9 * 304) < 200, `${bumperV.toFixed(0)} mm³`);
const trayTop = (debugBodies().get("stand") as any).faces.some((f: any) => { const c = f.center.toTuple(); return c[0] > 185 && c[0] < 315 && c[2] > 15 && c[2] < 22; });
check("the drip tray's rim stands on the plate", trayTop);
const cradleTop = (debugBodies().get("stand") as any).boundingBox.bounds[1][2];
check("the cradles reach up under the nacelle", cradleTop > 30 && cradleTop < 50.5, `top at ${cradleTop.toFixed(1)}`);
const spinX = (debugBodies().get("shaft") as any).boundingBox.bounds[0][0];
check("the spinner reaches 45 in front of the fan", near(spinX, -45, 0.5), `x ${spinX.toFixed(1)}`);
const d = doc();
check("fan blades, reach and stages come from variables", d.features.find((f: any) => f.id === "fanRound").op.count === 16 && d.features.find((f: any) => f.id === "stagesP").op.count === 3 && near(d.features.find((f: any) => f.id === "sTrim").entities[0].radius, 97));
const codeV = new Map(ids.map((c) => [c, V(c)]));
console.log("volumes", [...codeV].map(([k, v]) => `${k} ${(v / 1000).toFixed(2)}`).join(", "));

const codeVs = codeV;
if (hand) {
  check("by hand: every step builds", !hand.errors.length, hand.errors.join("; "));
  check("by hand: six clean solids", hand.bodies.length === 6 && hand.bodies.every((b) => b.ok), hand.bodies.map((b) => `${b.id} ${(b.v / 1000).toFixed(2)}`).join(", "));
  for (const [c, v] of codeVs) {
    const m = hand.bodies.find((b) => Math.abs(b.v - v) < v * 2e-3);
    check(`by hand: ${c} the same as by code`, !!m, `${(v / 1000).toFixed(2)} cm³ ${m ? `= ${(m.v / 1000).toFixed(2)} (${m.id})` : ""}`);
  }
  check("by hand: fan blades, reach and stages from the variables", hand.vars);
}

if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify({ ...doc(), hidden: feats.filter((f) => ["sketch", "plane", "axis", "image"].includes(f.type)).map((f) => f.id), colors: { nacelle: "#c9ced6", shaft: "#e0b04a", comb: "#c0573e", nut: "#8a9099", pod: "#3f6f9f", stand: "#2e3440" } }));
process.exit(failed ? 1 : 0);
