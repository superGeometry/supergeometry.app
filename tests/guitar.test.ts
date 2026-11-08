// Run: npx tsx tests/guitar.test.ts [out.json] - a steel-string acoustic guitar
// (dreadnought-like, 645 mm scale), made with every tool there is: variables
// (depth, top thickness, tuners a side); sketches with lines, arcs, circles,
// rectangles, an ellipse, polygons, splines, text, sketch fillets, offset,
// mirror and pattern; Extrude, Revolve, Sweep, Loft, Shell, Fillet, Chamfer,
// Thread; Union, Subtract, Intersect, Split Body, Delete; Pattern Linear /
// Circular, Mirror, Move / Rotate, Scale; Offset Face, Scale Face, Replace
// Face; planes (offset, midplane), an axis; Freeform (tuner buttons, the
// back's arch) and Fill to Plane.
//
// Lying on its back: x runs from the tail (0) to the headstock, y across
// (bass side +y), z up (the top faces up).
import opencascade from "replicad-opencascadejs";
import { measureArea, measureVolume, setOC } from "replicad";
import { readFileSync, writeFileSync } from "node:fs";
import opentype from "opentype.js";
const { parse } = opentype as any;
import { debugBodies, regenerate } from "../src/kernel/engine";
import { healthOf, isHealthy } from "../src/kernel/repair";
import { arrangement, regionRef, materialRegions } from "../src/sketch/regions";
import { textOutlines } from "../src/sketch/textLayout";
import { filletCorner, offsetChain, offsetEntity } from "../src/sketch/edit";
import { boxCage, planeCage } from "../src/freeform/cage";
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
/** Facing down (extrudes go down): u = x, v = -y. */
const XYdown = (z = 0): PlaneDef => ({ origin: [0, 0, z], normal: [0, 0, -1], xDir: [1, 0, 0] });
const XZ = (y = 0): PlaneDef => ({ origin: [0, y, 0], normal: [0, -1, 0], xDir: [1, 0, 0] }); // u = x, v = z
const YZ = (x = 0): PlaneDef => ({ origin: [x, 0, 0], normal: [1, 0, 0], xDir: [0, 1, 0] }); // u = y, v = z
const all = (es: any[]) => arrangement(es).regions.map(regionRef);
const where = (es: any[], test: (c: number[]) => boolean) => arrangement(es).regions.filter((r) => test(r.centroid)).map(regionRef);
const feats: any[] = [];
const variables = [
  { name: "depth", expr: "100 mm" },
  { name: "topT", expr: "3 mm" },
  { name: "tuners", expr: "3" },
];
const doc = () => {
  const d: any = { format: "super", version: 2, name: "Acoustic guitar", features: structuredClone(feats), variables, views: [], units: "mm", hidden: [], pins: [], names: {} };
  const problems = resolveDoc(d);
  if (problems.length) console.log("problems:", problems);
  return d;
};
/** History groups: one per part of the guitar (the steps made since the last). */
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
const faceWhere = (body: string, test: (c: number[], nrm: number[]) => boolean) => {
  const f = B(body).faces.find((f: any) => test(f.center.toTuple(), f.normalAt().toTuple()));
  if (!f) throw new Error(`no such face on ${body}`);
  return { body, center: f.center.toTuple() as Vec3, normal: f.normalAt().toTuple() as Vec3, area: measureArea(f) };
};
const edgesWhere = (body: string, test: (p: number[], e: any) => boolean) => {
  const es = B(body).edges.filter((e: any) => test(e.pointAt(0.5).toTuple(), e));
  if (!es.length) throw new Error(`no such edge on ${body}`);
  return es.map((e: any) => ({ body, mid: e.pointAt(0.5).toTuple() as Vec3, dir: e.tangentAt(0.5).toTuple() as Vec3, length: e.length as number }));
};
const V = (body: string) => Math.abs(measureVolume(B(body)));
const box = (body: string) => B(body).boundingBox.bounds as [number[], number[]];

// The scale: 645 mm from the nut to the saddle; the body meets the neck at the 14th fret.
const SCALE = 645;
const JOINT = 505;
const fretFromNut = (k: number) => SCALE * (1 - 2 ** (-k / 12));
const NUT = JOINT + fretFromNut(14);
const fretX = (k: number) => NUT - fretFromNut(k);
const SADDLE = NUT - SCALE + 2; // 2 mm of compensation
const DEPTH = 100;
const TOP = DEPTH + 3;
/** The fretboard's width along the neck (44 at the nut, 56 at the joint). */
const boardW = (x: number) => 44 + ((NUT - x) / (NUT - JOINT)) * 12;

section("Body");
// --- 1. The body: half its outline as points, mirrored for the other half -
// one smooth closed curve (a closed spline); pulled up to the top's
// underside (Extrude, "depth").
const half: [number, number][] = [[JOINT, 28], [497, 80], [478, 122], [448, 142], [410, 146], [372, 138], [335, 123], [300, 118], [262, 128], [215, 160], [160, 188], [105, 197], [55, 180], [18, 130], [2, 60]];
const outlinePts = [...half, [0, 0] as [number, number], ...[...half].reverse().map(([x, y]) => [x, -y] as [number, number])];
const outline = [{ id: "rim", kind: "spline", points: outlinePts, closed: true, mode: "fit" }];
feats.push({ id: "sBody", name: "Body outline", type: "sketch", plane: XY(), entities: outline });
feats.push({ id: "box", name: "Body", type: "extrude", source: { kind: "profile", sketch: "sBody", regions: all(outline) }, distance: DEPTH, mode: "new", exprs: { distance: "depth" } });
// The back bulges out a little (8 mm in the middle): a freeform sheet a bit
// bigger than the body, its middle pulled down, filled up to z = 0 (Fill to
// Plane), trimmed to the outline pulled down (Intersect), joined on (Union).
const cage = planeCage([560, 440], 4, [252, 0, 0]);
cage.verts = cage.verts.map(([x, y, z], k) => {
  const [i, j] = [k % 5, Math.floor(k / 5)];
  const inside = i > 0 && i < 4 && j > 0 && j < 4;
  return [x, y, inside ? (i === 2 && j === 2 ? -8 : -6) : z] as Vec3;
});
feats.push({ id: "arch", name: "Back arch", type: "freeform", cage, surface: true });
feats.push({ id: "archFill", name: "Fill the arch", type: "fillToPlane", body: "arch", plane: XY(0) });
feats.push({ id: "sBack", name: "Back outline", type: "sketch", plane: XYdown(0), entities: outline.map((e) => ({ ...e, id: e.id + "B" })) });
feats.push({ id: "backBlank", name: "Back blank", type: "extrude", source: { kind: "profile", sketch: "sBack", regions: all(outline) }, distance: 12, mode: "new" });
feats.push({ id: "archTrim", name: "Arch to the outline", type: "boolean", op: "intersect", target: "arch", tools: ["backBlank"] });
feats.push({ id: "archOn", name: "Arch on the body", type: "boolean", op: "union", target: "box", tools: ["arch"] });
const r0 = await stage("stage 0 (body with an arched back)");
check("the back bulges 5 to 8 below the rim", box("box")[0][2] < -5 && box("box")[0][2] > -8.5, `${box("box")[0][2].toFixed(2)}`);
// The back's edge rounded (Fillet), then hollowed 3 thick, open at the top (Shell).
feats.push({ id: "backEdge", name: "Round the back edge", type: "fillet", edges: edgesWhere("box", (p) => p[2] < -0.5 && p[2] > -7.9), radius: 4 });
await build();
feats.push({ id: "hollow", name: "Hollow the body", type: "shell", body: "box", faces: [faceWhere("box", (c, nrm) => Math.abs(c[2] - DEPTH) < 1e-6 && nrm[2] > 0.99)], thickness: 3 });
// The back comes off the sides at the rim (Split Body).
feats.push({ id: "back", name: "Back off the sides", type: "split", body: "box", plane: XYdown(0) });

section("Top");
// --- 2. The top (soundboard): the same outline, 3 thick ("topT"), its edge
// rounded; the soundhole cut through it.
feats.push({ id: "sTop", name: "Top outline", type: "sketch", plane: XY(DEPTH), entities: outline.map((e) => ({ ...e, id: e.id + "T" })) });
feats.push({ id: "top", name: "Top", type: "extrude", source: { kind: "profile", sketch: "sTop", regions: all(outline) }, distance: 3, mode: "new", exprs: { distance: "topT" } });
const HOLE: [number, number] = [366, 0]; // its edge just under the fretboard's end
const hole = [{ id: "hole", kind: "circle", center: HOLE, radius: 50 }];
feats.push({ id: "sHole", name: "Soundhole", type: "sketch", plane: XY(DEPTH), entities: hole });
feats.push({ id: "holeCut", name: "Cut the soundhole", type: "extrude", source: { kind: "profile", sketch: "sHole", regions: all(hole) }, distance: 3, mode: "cut", target: "top" });
const r1 = await stage("stage 1 (body and top)");
feats.push({ id: "topEdge", name: "Round the top edge", type: "fillet", edges: edgesWhere("top", (p, e) => Math.abs(p[2] - TOP) < 1e-6 && e.length > 200), radius: 2 });

section("Bracing");
// --- 3. Bracing under the top: an X of two 8-wide bars crossing behind the
// soundhole (12 deep, Extrude down), trimmed to the inside of the body - its
// outline offset 3 inwards (sketch Offset), pulled up as a body (Intersect) -
// their bottom edges bevelled (Chamfer), glued to the top (Union).
const xAt: [number, number] = [270, 0]; // (the bars pass clear of the soundhole)
const bars = [40, -40].map((deg, k) => ({ id: `bar${k}`, kind: "rect", center: xAt, w: 400, h: 8, rotation: (deg * Math.PI) / 180 }));
feats.push({ id: "sBraces", name: "X bracing", type: "sketch", plane: XYdown(DEPTH), entities: bars });
feats.push({ id: "braces", name: "Braces", type: "extrude", source: { kind: "profile", sketch: "sBraces", regions: all(bars) }, distance: 12, mode: "new" });
const innerRim = offsetEntity(outline[0] as any, -3) as any;
const inner = innerRim ? [{ ...innerRim, id: "rimIn" }] : [];
check("the outline offset 3 inwards (sketch Offset): one closed spline", inner.length === 1 && inner[0].kind === "spline", inner.map((e: any) => e.kind).join(" "));
check("... and 3 inside it", !!innerRim && Math.abs(Math.max(...innerRim.points.map((q: number[]) => q[1])) - (197 - 3)) < 1.5, `${innerRim && Math.max(...innerRim.points.map((q: number[]) => q[1])).toFixed(2)}`);
feats.push({ id: "sInside", name: "Inside of the body", type: "sketch", plane: XY(), entities: inner });
feats.push({ id: "inside", name: "Inside", type: "extrude", source: { kind: "profile", sketch: "sInside", regions: all(inner) }, distance: DEPTH, mode: "new" });
feats.push({ id: "bracesTrim", name: "Braces inside the body", type: "boolean", op: "intersect", target: "braces", tools: ["inside"] });
const r2 = await stage("stage 2 (top, bracing)");
feats.push({ id: "braceBevel", name: "Bevel the braces", type: "chamfer", edges: edgesWhere("braces", (p, e) => Math.abs(p[2] - (DEPTH - 12)) < 1e-6 && e.length > 40), radius: 3 });
feats.push({ id: "bracesOn", name: "Braces on the top", type: "boolean", op: "union", target: "top", tools: ["braces"] });
await stage("stage 3 (braces glued)");

section("Rosette");
// --- 4. The rosette: a ring round the soundhole sunk 0.6 into the top and
// filled with a ring of its own, 24 notches round it (an axis through the
// soundhole, Pattern Circular, Subtract).
const rings = [
  { id: "ring56", kind: "circle", center: HOLE, radius: 56 },
  { id: "ring62", kind: "circle", center: HOLE, radius: 62 },
];
const ringRegion = arrangement(rings).regions.filter((r) => r.holes.length).map(regionRef);
check("one ring between the circles", ringRegion.length === 1);
feats.push({ id: "sRosette", name: "Rosette", type: "sketch", plane: XYdown(TOP), entities: rings });
feats.push({ id: "rosetteCut", name: "Sink the rosette", type: "extrude", source: { kind: "profile", sketch: "sRosette", regions: ringRegion }, distance: 0.6, mode: "cut", target: "top" });
feats.push({ id: "rosette", name: "Rosette ring", type: "extrude", source: { kind: "profile", sketch: "sRosette", regions: ringRegion }, distance: 0.6, mode: "new" });
const notch = [{ id: "notch", kind: "rect", center: [HOLE[0] + 59, 0], w: 8, h: 1.6, rotation: 0 }];
feats.push({ id: "sNotch", name: "Rosette notch", type: "sketch", plane: XYdown(TOP), entities: notch });
feats.push({ id: "notch", name: "Notch", type: "extrude", source: { kind: "profile", sketch: "sNotch", regions: all(notch) }, distance: 0.3, mode: "new" });
feats.push({ id: "holeAxis", name: "Soundhole axis", type: "axis", origin: [HOLE[0], HOLE[1], 0], dir: [0, 0, 1] });
feats.push({ id: "notches", name: "Notches round", type: "transform", bodies: ["notch"], copy: false, op: { kind: "circular", axis: { origin: [HOLE[0], HOLE[1], 0], dir: [0, 0, 1], ref: { kind: "axis", feature: "holeAxis" } }, count: 24, angle: 360 } });
feats.push({ id: "notchCut", name: "Notch the rosette", type: "boolean", op: "subtract", target: "rosette", tools: ["notch", ...Array.from({ length: 23 }, (_, k) => `notches:notch:${k}`)] });
const r4 = await stage("stage 4 (rosette)");
{
  const ring = Math.PI * (62 ** 2 - 56 ** 2) * 0.6;
  const notches = 24 * 6 * 1.6 * 0.3; // (each notch 6 long inside the ring)
  check("the rosette: a ring with 24 notches", Math.abs(V("rosette") - (ring - notches)) < 3, `${V("rosette").toFixed(1)} vs ${(ring - notches).toFixed(1)}`);
}

section("Neck");
// --- 5. The neck: lofted from a half-ellipse at the body (56.8 wide, 22
// deep) to a smaller one at the nut (44 wide, 19 deep) - each an ellipse cut
// by a line, the half below kept. The heel under it at the body: a profile of
// lines and a spline (on a side plane, Extrude across), its foot rounded
// (Fillet) and brought down to 4 above the back (Replace Face); joined on.
const NECK0 = 480;
const halfEllipse = (x: number, rx: number, ry: number, tag: string) => {
  const es = [
    { id: `el${tag}`, kind: "ellipse", center: [0, TOP], rx, ry, rotation: 0 },
    { id: `cut${tag}`, kind: "line", a: [-rx - 5, TOP], b: [rx + 5, TOP] },
  ];
  return { es, regions: where(es, (c) => c[1] < TOP) };
};
const sec0 = halfEllipse(NECK0, boardW(NECK0) / 2, 22, "0");
const NUT1 = NUT + 5; // (the nut sits on the neck's last 5 mm)
const sec1 = halfEllipse(NUT1, 22, 19, "1");
feats.push({ id: "sNeck0", name: "Neck at the body", type: "sketch", plane: YZ(NECK0), entities: sec0.es });
feats.push({ id: "sNeck1", name: "Neck at the nut", type: "sketch", plane: YZ(NUT1), entities: sec1.es });
feats.push({ id: "neck", name: "Neck", type: "loft", sections: [{ kind: "profile", sketch: "sNeck0", regions: sec0.regions }, { kind: "profile", sketch: "sNeck1", regions: sec1.regions }], ruled: false, mode: "new" });
const heel = [
  { id: "hTop", kind: "line", a: [600, 96], b: [498, 96] },
  { id: "hBack", kind: "line", a: [498, 96], b: [498, 8] },
  { id: "hFoot", kind: "line", a: [498, 8], b: [518, 8] },
  { id: "hCurve", kind: "spline", points: [[518, 8], [540, 40], [572, 78], [600, 96]], closed: false, mode: "fit" },
];
feats.push({ id: "sHeel", name: "Heel profile", type: "sketch", plane: XZ(25), entities: heel });
feats.push({ id: "heel", name: "Heel", type: "extrude", source: { kind: "profile", sketch: "sHeel", regions: all(heel) }, distance: 50, mode: "new" });
const r5a = await stage("stage 5a (neck, heel)");
check("the neck runs from the body to the nut", Math.abs(box("neck")[0][0] - NECK0) < 0.01 && Math.abs(box("neck")[1][0] - NUT1) < 0.01, `${box("neck")[0][0].toFixed(2)}..${box("neck")[1][0].toFixed(2)}`);
check("the heel is 50 across", Math.abs(box("heel")[1][1] - box("heel")[0][1] - 50) < 0.01);
feats.push({ id: "heelDown", name: "Heel down to the back", type: "replaceFace", face: faceWhere("heel", (c, nrm) => nrm[2] < -0.99 && Math.abs(c[2] - 8) < 1e-6), plane: XYdown(4) });
await build();
feats.push({ id: "heelFoot", name: "Round the heel's foot", type: "fillet", edges: edgesWhere("heel", (p) => Math.abs(p[2] - 4) < 1e-6 && Math.abs(Math.abs(p[1]) - 25) < 1e-6), radius: 4 });
feats.push({ id: "neckOn", name: "Heel on the neck", type: "boolean", op: "union", target: "neck", tools: ["heel"] });
await stage("stage 5 (neck with its heel)");
check("the heel's foot is 4 above the back", Math.abs(box("neck")[0][2] - 4) < 0.05, `${box("neck")[0][2].toFixed(2)}`);

section("Fretboard");
// --- 6. The fretboard on the neck and the top: tapering 56 → 44 (a closed
// polyline), 6 thick; its end over the soundhole brought out 6 further
// (Offset Face). 20 frets (rectangles, Extrude 1.3, their crowns rounded),
// dot inlays sunk in and filled, the nut: its back edge bevelled (Chamfer),
// six string slots cut.
const BOARD0 = 424;
const BT = TOP + 6;
const board = [{ id: "board", kind: "polyline", closed: true, points: [[BOARD0, -boardW(BOARD0) / 2], [NUT, -22], [NUT, 22], [BOARD0, boardW(BOARD0) / 2]] }];
feats.push({ id: "sBoard", name: "Fretboard outline", type: "sketch", plane: XY(TOP), entities: board });
feats.push({ id: "board", name: "Fretboard", type: "extrude", source: { kind: "profile", sketch: "sBoard", regions: all(board) }, distance: 6, mode: "new" });
await build();
feats.push({ id: "boardEnd", name: "Fretboard end out", type: "moveFace", face: faceWhere("board", (c, nrm) => nrm[0] < -0.99), translate: [-6, 0, 0] });
const frets = Array.from({ length: 20 }, (_, i) => {
  const x = fretX(i + 1);
  return { id: `fret${i + 1}`, kind: "rect", center: [x, 0], w: 2.4, h: boardW(x) - 1, rotation: 0 };
});
feats.push({ id: "sFrets", name: "Frets", type: "sketch", plane: XY(BT), entities: frets });
feats.push({ id: "frets", name: "Frets", type: "extrude", source: { kind: "profile", sketch: "sFrets", regions: all(frets) }, distance: 1.3, mode: "new" });
const r6a = await stage("stage 6a (fretboard, frets)");
check("the board's end is out over the soundhole", Math.abs(box("board")[0][0] - (BOARD0 - 6)) < 0.01, `${box("board")[0][0].toFixed(2)}`);
check("20 frets", B("frets").faces.length === 20 * 6, `${B("frets").faces.length} faces`);
feats.push({ id: "fretCrowns", name: "Round the frets", type: "fillet", edges: edgesWhere("frets", (p, e) => Math.abs(p[2] - (BT + 1.3)) < 1e-6 && e.length > 30), radius: 0.6 });
const dotAt = (k: number) => (fretX(k - 1) + fretX(k)) / 2;
const dots = [3, 5, 7, 9, 15, 17, 19].map((k) => ({ id: `dot${k}`, kind: "circle", center: [dotAt(k), 0], radius: 3 }));
dots.push({ id: "dot12a", kind: "circle", center: [dotAt(12), 10], radius: 3 }, { id: "dot12b", kind: "circle", center: [dotAt(12), -10], radius: 3 });
feats.push({ id: "sDots", name: "Inlay dots", type: "sketch", plane: XYdown(BT), entities: dots });
feats.push({ id: "dotCut", name: "Sink the dots", type: "extrude", source: { kind: "profile", sketch: "sDots", regions: all(dots) }, distance: 0.6, mode: "cut", target: "board" });
feats.push({ id: "inlays", name: "Inlays", type: "extrude", source: { kind: "profile", sketch: "sDots", regions: all(dots) }, distance: 0.6, mode: "new" });
const nut = [{ id: "nut", kind: "rect", center: [NUT + 2.5, 0], w: 5, h: 44, rotation: 0 }];
feats.push({ id: "sNut", name: "Nut outline", type: "sketch", plane: XY(TOP), entities: nut });
feats.push({ id: "nut", name: "Nut", type: "extrude", source: { kind: "profile", sketch: "sNut", regions: all(nut) }, distance: 9, mode: "new" });
await build();
feats.push({ id: "nutBevel", name: "Bevel the nut", type: "chamfer", edges: edgesWhere("nut", (p) => Math.abs(p[0] - NUT1) < 1e-6 && Math.abs(p[2] - (TOP + 9)) < 1e-6), radius: 1.5 });
const STRING_Y = Array.from({ length: 6 }, (_, i) => -18 + 7.2 * i);
const slots = STRING_Y.map((y, i) => ({ id: `slot${i}`, kind: "rect", center: [NUT + 2.5, -y], w: 6, h: 0.8, rotation: 0 }));
feats.push({ id: "sSlots", name: "String slots", type: "sketch", plane: XYdown(TOP + 9), entities: slots });
feats.push({ id: "slotCut", name: "Cut the slots", type: "extrude", source: { kind: "profile", sketch: "sSlots", regions: where(slots, (c) => Math.abs(c[0] - (NUT + 2.5)) < 2.5) }, distance: 1, mode: "cut", target: "nut" });
await stage("stage 6b (crowns, inlays, nut)");
const r6 = await stage("stage 6 (fretboard done)");
check("inlays: 9 dots", Math.abs(V("inlays") - 9 * Math.PI * 9 * 0.6) < 0.5, `${V("inlays").toFixed(2)}`);

section("Headstock");
// --- 7. The headstock: lines and an arc, 15 thick, "SUPER" raised on it
// (Text, Extrude join). Tuner holes: one cylinder, Pattern Linear ("tuners"
// a side), the row mirrored across the middle (Mirror), all cut through
// (Subtract). Then tilted 14° back about the nut (Rotate) and joined to the neck.
const HEAD_END = 1050;
const head = [
  { id: "hl0", kind: "line", a: [NUT1, -26], b: [HEAD_END, -42] },
  { id: "hl1", kind: "line", a: [NUT1, 26], b: [HEAD_END, 42] },
  { id: "hl2", kind: "line", a: [NUT1, -26], b: [NUT1, 26] },
  { id: "hTip", kind: "arc", a: [HEAD_END, 42], m: [HEAD_END + 16, 0], b: [HEAD_END, -42] },
];
feats.push({ id: "sHead", name: "Headstock outline", type: "sketch", plane: XYdown(TOP), entities: head });
feats.push({ id: "head", name: "Headstock", type: "extrude", source: { kind: "profile", sketch: "sHead", regions: all(head) }, distance: 15, mode: "new" });
const fontFile = readFileSync("node_modules/@fontsource/roboto/files/roboto-latin-400-normal.woff");
const font = parse(fontFile.buffer.slice(fontFile.byteOffset, fontFile.byteOffset + fontFile.byteLength));
const logo = textOutlines(font, "SUPER", [995, -4], 8, 0, "center").map((e: any, i: number) => ({ ...e, id: `t${i}` }));
feats.push({ id: "sLogo", name: "Logo", type: "sketch", plane: XY(TOP), entities: logo });
feats.push({ id: "logo", name: "Raise the logo", type: "extrude", source: { kind: "profile", sketch: "sLogo", regions: materialRegions(arrangement(logo)).map(regionRef) }, distance: 0.6, mode: "join", target: "head" });
const PEG_X = [935, 975, 1015];
const peg = [{ id: "peg", kind: "circle", center: [PEG_X[0], -25], radius: 5 }];
feats.push({ id: "sPeg", name: "Tuner hole", type: "sketch", plane: XYdown(TOP + 1), entities: peg });
feats.push({ id: "peg", name: "Tuner hole", type: "extrude", source: { kind: "profile", sketch: "sPeg", regions: all(peg) }, distance: 20, mode: "new" });
feats.push({ id: "pegRow", name: "Tuner holes along", type: "transform", bodies: ["peg"], copy: false, op: { kind: "linear", dir: [1, 0, 0], spacing: 40, count: 3 }, exprs: { "op.count": "tuners" } });
feats.push({ id: "pegMirror", name: "Tuner holes across", type: "transform", bodies: ["peg", "pegRow:peg:0", "pegRow:peg:1"], copy: true, op: { kind: "mirror", plane: XZ(0) } });
const pegIds = ["peg", "pegRow:peg:0", "pegRow:peg:1", "pegMirror:peg:0", "pegMirror:pegRow:peg:0:0", "pegMirror:pegRow:peg:1:0"];
feats.push({ id: "pegCut", name: "Drill the tuner holes", type: "boolean", op: "subtract", target: "head", tools: pegIds });
const r7a = await stage("stage 7a (headstock)");
{
  const flat = Math.abs(V("head"));
  check("the headstock: six holes through", B("head").faces.filter((f: any) => f.geomType === "CYLINDRE" && Math.abs(measureArea(f) - 2 * Math.PI * 5 * 15) < 1).length === 6, `${B("head").faces.filter((f: any) => f.geomType === "CYLINDRE").length} round faces, ${flat.toFixed(0)} mm³`);
  check("the logo stands 0.6 proud", Math.abs(box("head")[1][2] - (TOP + 0.6)) < 1e-6);
}
section("Tuners");
// --- 8. The tuners (built on the flat headstock, tilted with it): the post
// and its bushing revolved from one profile, a thread on the bushing; the
// gear housing under the head (its corners rounded), the shaft out to the
// side, a freeform button on it (stretched with Scale XYZ); joined, then
// patterned along ("tuners") and mirrored across like the holes.
const faceBy = (body: string, test: (f: any) => boolean) => {
  const f = B(body).faces.find(test);
  if (!f) throw new Error(`no such face on ${body}`);
  return { body, center: f.center.toTuple() as Vec3, normal: f.normalAt().toTuple() as Vec3, area: measureArea(f) };
};
const PX = PEG_X[0];
const HB = TOP - 15; // the headstock's back
const post = [
  { id: "pp", kind: "polyline", closed: false, points: [[PX, HB - 2], [PX + 4.9, HB - 2], [PX + 4.9, TOP], [PX + 6, TOP], [PX + 6, TOP + 6], [PX + 3, TOP + 6], [PX + 3, TOP + 18], [PX, TOP + 18]] },
  { id: "pAxis", kind: "line", a: [PX, TOP + 18], b: [PX, HB - 2] },
];
feats.push({ id: "sPost", name: "Tuner post profile", type: "sketch", plane: XZ(25), entities: post });
feats.push({ id: "tuner", name: "Tuner post", type: "revolve", source: { kind: "profile", sketch: "sPost", regions: all(post) }, axis: { origin: [PX, 25, 0], dir: [0, 0, 1], ref: { kind: "sketchLine", sketch: "sPost", entity: "pAxis" } }, angle: 360, mode: "new" });
await build();
feats.push({ id: "bushThread", name: "Thread the bushing", type: "thread", face: faceBy("tuner", (f) => f.geomType === "CYLINDRE" && Math.abs(measureArea(f) - 2 * Math.PI * 6 * 6) < 0.5), pitch: 0.75, round: { r: 6, hole: false } });
const housing = [{ id: "hs", kind: "rect", center: [PX, -31], w: 14, h: 24, rotation: 0 }];
feats.push({ id: "sHousing", name: "Gear housing", type: "sketch", plane: XYdown(HB), entities: housing });
feats.push({ id: "housing", name: "Gear housing", type: "extrude", source: { kind: "profile", sketch: "sHousing", regions: all(housing) }, distance: 12, mode: "new" });
await build();
feats.push({ id: "housingRound", name: "Round the housing", type: "fillet", edges: edgesWhere("housing", (p, e) => Math.abs(p[2] - (HB - 6)) < 1e-6 && Math.abs(e.length - 12) < 1e-6), radius: 3 });
const XZp = (y: number): PlaneDef => ({ origin: [0, y, 0], normal: [0, 1, 0], xDir: [1, 0, 0] }); // u = x, v = -z
const shaft = [{ id: "sh", kind: "circle", center: [PX, -(HB - 6)], radius: 2 }];
feats.push({ id: "sShaft", name: "Tuner shaft", type: "sketch", plane: XZp(42), entities: shaft });
feats.push({ id: "shaft", name: "Tuner shaft", type: "extrude", source: { kind: "profile", sketch: "sShaft", regions: all(shaft) }, distance: 12, mode: "new" });
const button = boxCage([16, 6, 20], 2, [PX, 56, HB - 16]);
feats.push({ id: "button", name: "Tuner button", type: "freeform", cage: button });
feats.push({ id: "buttonShape", name: "Shape the button", type: "transform", bodies: ["button"], copy: false, op: { kind: "scaleXYZ", center: [PX, 56, HB - 6], factors: [1, 0.8, 1.15] } });
feats.push({ id: "tunerJoin", name: "Tuner together", type: "boolean", op: "union", target: "tuner", tools: ["housing", "shaft", "button"] });
const r8a = await stage("stage 8a (one tuner)");
check("the tuner is one solid", healthOf(B("tuner")).solids === 1, JSON.stringify(healthOf(B("tuner"))).slice(0, 120));
feats.push({ id: "tunerRow", name: "Tuners along", type: "transform", bodies: ["tuner"], copy: false, op: { kind: "linear", dir: [1, 0, 0], spacing: 40, count: 3 }, exprs: { "op.count": "tuners" } });
feats.push({ id: "tunerMirror", name: "Tuners across", type: "transform", bodies: ["tuner", "tunerRow:tuner:0", "tunerRow:tuner:1"], copy: true, op: { kind: "mirror", plane: XZ(0) } });
const tunerIds = ["tuner", "tunerRow:tuner:0", "tunerRow:tuner:1", "tunerMirror:tuner:0", "tunerMirror:tunerRow:tuner:0:0", "tunerMirror:tunerRow:tuner:1:0"];
await stage("stage 8 (six tuners)");
check("six tuners", tunerIds.every((t) => B(t)), tunerIds.filter((t) => !B(t)).join(" "));

feats.push({ id: "headTilt", name: "Tilt the headstock back", type: "transform", bodies: ["head", ...tunerIds], copy: false, op: { kind: "move", translate: [0, 0, 0], rotate: { origin: [NUT1, 0, TOP], axis: [0, 1, 0], angle: 14 } } });
await build();
{
  const k = Math.PI / 180 * 14;
  const tipZ = TOP - (HEAD_END + 16 - NUT1) * Math.sin(k);
  check("the headstock tilts back 14°", Math.abs(box("head")[0][2] - (tipZ - 15 * Math.cos(k))) < 3, `lowest ${box("head")[0][2].toFixed(1)}, tip top ~${tipZ.toFixed(1)}`);
}
feats.push({ id: "headOn", name: "Headstock on the neck", type: "boolean", op: "union", target: "neck", tools: ["head"] });
await stage("stage 8b (headstock and tuners on)");

section("Bridge and hardware");
// --- 9. The bridge: a block 32 × 154, 9 high, its top shrunk (Scale Face)
// so the sides lean in, the leaning corners rounded. The saddle slot cut at a
// 2° slant, the saddle in it (its top rounded). Six pin holes (Pattern
// Linear) through the bridge and the top (Subtract, tools kept, then
// Delete), the pins revolved (a spline head) and patterned. A pickguard (a
// closed spline round the rosette minus a circle), strap buttons (Revolve,
// one copy Scaled and moved to the heel), the neck's pocket cut into the
// body (Subtract, keep the neck), and a slip - a seventh nut slot - taken
// back out (Delete faces).
const BR0 = 196;
const BR1 = 228;
const bridge = [{ id: "br", kind: "rect", center: [(BR0 + BR1) / 2, 0], w: BR1 - BR0, h: 154, rotation: 0 }];
feats.push({ id: "sBridge", name: "Bridge outline", type: "sketch", plane: XY(TOP), entities: bridge });
feats.push({ id: "bridge", name: "Bridge", type: "extrude", source: { kind: "profile", sketch: "sBridge", regions: all(bridge) }, distance: 9, mode: "new" });
await build();
feats.push({ id: "bridgeTop", name: "Narrow the bridge's top", type: "scaleFace", face: faceWhere("bridge", (c, nrm) => nrm[2] > 0.99 && Math.abs(c[2] - (TOP + 9)) < 1e-6), u: [1, 0, 0], factors: [0.8, 0.9] });
await build();
feats.push({ id: "bridgeRound", name: "Round the bridge's corners", type: "fillet", edges: edgesWhere("bridge", (p) => p[2] > TOP + 1 && p[2] < TOP + 8 && Math.abs(p[1]) > 60), radius: 4 });
const slot = [{ id: "sad", kind: "rect", center: [SADDLE, 0], w: 3, h: 72, rotation: (2 * Math.PI) / 180 }];
feats.push({ id: "sSaddleSlot", name: "Saddle slot", type: "sketch", plane: XYdown(TOP + 9), entities: slot });
feats.push({ id: "slotCutB", name: "Cut the saddle slot", type: "extrude", source: { kind: "profile", sketch: "sSaddleSlot", regions: all(slot) }, distance: 5, mode: "cut", target: "bridge" });
feats.push({ id: "sSaddle", name: "Saddle", type: "sketch", plane: XY(TOP + 4), entities: slot.map((e) => ({ ...e, id: "sad2" })) });
feats.push({ id: "saddle", name: "Saddle", type: "extrude", source: { kind: "profile", sketch: "sSaddle", regions: all(slot) }, distance: 8, mode: "new" });
const r9a = await stage("stage 9a (bridge, saddle)");
feats.push({ id: "saddleRound", name: "Round the saddle's top", type: "fillet", edges: edgesWhere("saddle", (p, e) => Math.abs(p[2] - (TOP + 12)) < 1e-6 && e.length > 60), radius: 1.4 });
const PIN_X = 206;
const PIN_Y = Array.from({ length: 6 }, (_, i) => -27 + 10.8 * i);
const pinHole = [{ id: "ph", kind: "circle", center: [PIN_X, -PIN_Y[0]], radius: 2.5 }];
feats.push({ id: "sPinHole", name: "Pin hole", type: "sketch", plane: XYdown(TOP + 10), entities: pinHole });
feats.push({ id: "pinHole", name: "Pin hole", type: "extrude", source: { kind: "profile", sketch: "sPinHole", regions: all(pinHole) }, distance: 25, mode: "new" });
feats.push({ id: "pinHoles", name: "Pin holes along", type: "transform", bodies: ["pinHole"], copy: false, op: { kind: "linear", dir: [0, 1, 0], spacing: 10.8, count: 6 } });
const holeIds = ["pinHole", ...Array.from({ length: 5 }, (_, k) => `pinHoles:pinHole:${k}`)];
feats.push({ id: "pinCutB", name: "Drill the bridge", type: "boolean", op: "subtract", target: "bridge", tools: holeIds, keepTools: true });
feats.push({ id: "pinCutT", name: "Drill the top", type: "boolean", op: "subtract", target: "top", tools: holeIds, keepTools: true });
feats.push({ id: "pinHolesGone", name: "Put the drills away", type: "delete", bodies: holeIds });
const pin = [
  { id: "pinBody", kind: "polyline", closed: false, points: [[PIN_X, TOP + 9], [PIN_X, TOP - 8], [PIN_X + 2, TOP - 8], [PIN_X + 2.3, TOP + 9], [PIN_X + 3.5, TOP + 9]] },
  { id: "pinHead", kind: "spline", closed: false, mode: "fit", points: [[PIN_X + 3.5, TOP + 9], [PIN_X + 2.9, TOP + 11.2], [PIN_X, TOP + 12.5]] },
  { id: "pinAxis", kind: "line", a: [PIN_X, TOP + 12.5], b: [PIN_X, TOP + 9] },
];
feats.push({ id: "sPin", name: "Bridge pin profile", type: "sketch", plane: XZ(PIN_Y[0]), entities: pin });
feats.push({ id: "pin", name: "Bridge pin", type: "revolve", source: { kind: "profile", sketch: "sPin", regions: all(pin) }, axis: { origin: [PIN_X, PIN_Y[0], 0], dir: [0, 0, 1] }, angle: 360, mode: "new" });
feats.push({ id: "pins", name: "Pins along", type: "transform", bodies: ["pin"], copy: false, op: { kind: "linear", dir: [0, 1, 0], spacing: 10.8, count: 6 } });
const guard = [
  { id: "pg", kind: "spline", closed: true, mode: "fit", points: [[430, -40], [452, -88], [428, -128], [362, -140], [300, -120], [284, -76], [308, -42], [366, -45]] },
  { id: "pgHole", kind: "circle", center: HOLE, radius: 63 },
];
const guardRegions = where(guard, (c) => c[1] < -75);
check("the pickguard: one piece, the rosette left out", guardRegions.length === 1);
feats.push({ id: "sGuard", name: "Pickguard", type: "sketch", plane: XY(TOP), entities: guard });
feats.push({ id: "guard", name: "Pickguard", type: "extrude", source: { kind: "profile", sketch: "sGuard", regions: guardRegions }, distance: 0.6, mode: "new" });
const endpin = [
  { id: "epBody", kind: "polyline", closed: false, points: [[4, 50], [4, 53], [-4, 53], [-4, 55], [-8, 55]] },
  { id: "epHead", kind: "spline", closed: false, mode: "fit", points: [[-8, 55], [-10.6, 53.6], [-12, 50]] },
  { id: "epAxis", kind: "line", a: [-12, 50], b: [4, 50] },
];
feats.push({ id: "sEndpin", name: "Strap button profile", type: "sketch", plane: XZ(0), entities: endpin });
feats.push({ id: "endpin", name: "Strap button", type: "revolve", source: { kind: "profile", sketch: "sEndpin", regions: all(endpin) }, axis: { origin: [0, 0, 50], dir: [1, 0, 0], ref: { kind: "sketchLine", sketch: "sEndpin", entity: "epAxis" } }, angle: 360, mode: "new" });
feats.push({ id: "heelPinS", name: "Smaller strap button", type: "transform", bodies: ["endpin"], copy: true, op: { kind: "scale", center: [-4, 0, 50], factor: 0.8 } });
feats.push({ id: "heelPin", name: "Strap button to the heel", type: "transform", bodies: ["heelPinS:endpin:0"], copy: false, op: { kind: "move", translate: [512, 0, -44.6], rotate: { origin: [0, 0, 50], axis: [0, 1, 0], angle: -90 } } });
feats.push({ id: "pocketT", name: "Neck pocket in the top", type: "boolean", op: "subtract", target: "top", tools: ["neck"], keepTools: true });
feats.push({ id: "pocketB", name: "Neck pocket in the sides", type: "boolean", op: "subtract", target: "box", tools: ["neck"], keepTools: true });
const slip = [{ id: "slip", kind: "rect", center: [NUT + 2.5, 0], w: 6, h: 0.8, rotation: 0 }];
feats.push({ id: "sSlip", name: "A seventh slot", type: "sketch", plane: XYdown(TOP + 9), entities: slip });
feats.push({ id: "slip", name: "A seventh slot", type: "extrude", source: { kind: "profile", sketch: "sSlip", regions: where(slip, (c) => Math.abs(c[0] - (NUT + 2.5)) < 2.5) }, distance: 1, mode: "cut", target: "nut" });
await build();
const vSlipped = V("nut");
const slipFaces = B("nut").faces.filter((f: any) => {
  const c = f.center.toTuple();
  const n = f.normalAt().toTuple();
  return Math.abs(c[1]) < 0.5 && ((Math.abs(n[1]) > 0.99 && Math.abs(c[2] - (TOP + 8.5)) < 0.3) || (n[2] > 0.99 && Math.abs(c[2] - (TOP + 8)) < 1e-6));
});
feats.push({ id: "slipGone", name: "Take the slip back out", type: "deleteGeom", body: "nut", faces: slipFaces.map((f: any) => ({ body: "nut", center: f.center.toTuple(), normal: f.normalAt().toTuple(), area: measureArea(f) })), edges: [], vertices: [] });
const r9 = await stage("stage 9 (bridge, pins, pickguard, strap buttons, pocket)");
check("the slip is filled again", Math.abs(V("nut") - vSlipped - (5 - 1) * 0.8) < 0.05, `${slipFaces.length} faces; ${vSlipped.toFixed(2)} → ${V("nut").toFixed(2)}`);
check("six pins", ["pin", ...Array.from({ length: 5 }, (_, k) => `pins:pin:${k}`)].every((t) => B(t)));
check("the drills are put away", holeIds.every((t) => !B(t)));
check("the heel's strap button points down under the heel", box("heelPinS:endpin:0")[0][2] < 4 && box("heelPinS:endpin:0")[1][2] > 4, `${box("heelPinS:endpin:0")[0][2].toFixed(1)}..${box("heelPinS:endpin:0")[1][2].toFixed(1)}`);

section("Strings");
// --- 10. The strings: each drawn in its own upright plane slanting from its
// pin to its nut slot - a line up onto the saddle and a line on to the nut,
// the corner on the saddle rounded (sketch Fillet) - with a circle across its
// start (Sweep). From the nut a second sweep runs on to its tuner post.
const R_STRING = [0.15, 0.2, 0.27, 0.36, 0.5, 0.67];
const POST_OF = [[1015, -25], [975, -25], [935, -25], [935, 25], [975, 25], [1015, 25]];
const tilt = (p: Vec3): Vec3 => {
  // As the headstock: 14° about the line across the nut's back.
  const k = (14 * Math.PI) / 180;
  const [x, y, z] = [p[0] - NUT1, p[1], p[2] - TOP];
  return [NUT1 + x * Math.cos(k) + z * Math.sin(k), y, TOP - x * Math.sin(k) + z * Math.cos(k)];
};
const unit3 = (v: number[]) => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l] as Vec3;
};
const cross3 = (a: number[], b: number[]): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const stringIds: string[] = [];
for (let i = 0; i < 6; i++) {
  const r = R_STRING[i];
  const A: Vec3 = [PIN_X + 3.6, PIN_Y[i], 0];
  const N: Vec3 = [NUT1, STRING_Y[i], 0];
  const run = Math.hypot(N[0] - A[0], N[1] - A[1]);
  const u: Vec3 = [(N[0] - A[0]) / run, (N[1] - A[1]) / run, 0];
  const plane: PlaneDef = { origin: A, normal: [u[1], -u[0], 0], xDir: u };
  // Where it crosses the slanted saddle (x = SADDLE - y·tan 2°).
  let sS = (SADDLE - A[0]) / u[0];
  for (let k = 0; k < 3; k++) sS = (SADDLE - Math.tan((2 * Math.PI) / 180) * (A[1] + u[1] * sS) - A[0]) / u[0];
  const p0: [number, number] = [0, TOP + 9 + r];
  const pS: [number, number] = [sS, TOP + 12 + r];
  const pN: [number, number] = [run, TOP + 8 + r];
  const lines = [
    { id: `up${i}`, kind: "line", a: p0, b: pS },
    { id: `on${i}`, kind: "line", a: pS, b: pN },
  ];
  const path = filletCorner(lines as any, pS, 4, 0.01);
  check(`string ${i + 1}: the saddle corner rounds`, !!path && path.length === 3);
  feats.push({ id: `sPath${i}`, name: `String ${i + 1} path`, type: "sketch", plane, entities: path });
  const d = unit3([u[0] * (pS[0] - p0[0]), u[1] * (pS[0] - p0[0]), pS[1] - p0[1]]);
  const start: Vec3 = [A[0], A[1], p0[1]];
  const ring = [{ id: `ring${i}`, kind: "circle", center: [0, 0], radius: r }];
  feats.push({ id: `sStr${i}`, name: `String ${i + 1} gauge`, type: "sketch", plane: { origin: start, normal: d, xDir: plane.normal }, entities: ring });
  feats.push({ id: `string${i}`, name: `String ${i + 1}`, type: "sweep", source: { kind: "profile", sketch: `sStr${i}`, regions: all(ring) }, path: { kind: "sketch", sketch: `sPath${i}`, entities: path!.map((e: any) => e.id) }, mode: "new" });
  // On from the nut to the post (its side towards the middle, 12 up the flat headstock - tilted).
  const n3: Vec3 = [NUT1, STRING_Y[i], TOP + 8 + r];
  const [px, py] = POST_OF[i];
  const post3 = tilt([px, py - Math.sign(py) * 3, TOP + 12]);
  const e = unit3([post3[0] - n3[0], post3[1] - n3[1], post3[2] - n3[2]]);
  const side = unit3(cross3(e, [0, 0, 1]));
  const L2 = Math.hypot(post3[0] - n3[0], post3[1] - n3[1], post3[2] - n3[2]);
  feats.push({ id: `sTail${i}`, name: `String ${i + 1} to its tuner`, type: "sketch", plane: { origin: n3, normal: side, xDir: e }, entities: [{ id: `tail${i}`, kind: "line", a: [0, 0], b: [L2, 0] }] });
  feats.push({ id: `sTailR${i}`, name: `String ${i + 1} gauge (head)`, type: "sketch", plane: { origin: n3, normal: e, xDir: side }, entities: [{ ...ring[0], id: `ringT${i}` }] });
  feats.push({ id: `stringT${i}`, name: `String ${i + 1} on the head`, type: "sweep", source: { kind: "profile", sketch: `sTailR${i}`, regions: all(ring) }, path: { kind: "sketch", sketch: `sTail${i}`, entities: [`tail${i}`] }, mode: "new" });
  stringIds.push(`string${i}`, `stringT${i}`);
}
const r10 = await stage("stage 10 (strings)");
for (let i = 0; i < 6; i++) {
  const r = R_STRING[i];
  const len = Math.hypot(NUT1 - PIN_X - 3.6, STRING_Y[i] - PIN_Y[i]);
  const v = V(`string${i}`);
  check(`string ${i + 1}: a ${(2 * r).toFixed(2)} mm tube ${len.toFixed(0)} long`, Math.abs(v / (Math.PI * r * r) - len) < 3, `${(v / (Math.PI * r * r)).toFixed(1)} mm`);
}

section("Finish");
// --- Finish: the woods and metals (Colours), a repair pass on the neck,
// everything checked, the project written out.
feats.push({ id: "neckRepair", name: "Check the neck", type: "repair", bodies: ["neck"] });
const final = await stage("the whole guitar");
const colors: Record<string, string> = {
  box: "#b8742e", back: "#9c5a22", top: "#e8c68a", rosette: "#3a2416", neck: "#a8652a", board: "#2e1e14", frets: "#d8d8d0", inlays: "#f2efe6",
  nut: "#f4f0e2", bridge: "#2e1e14", saddle: "#f4f0e2", guard: "#3a1c10", endpin: "#1c1c1c", "heelPinS:endpin:0": "#1c1c1c",
};
for (const t of tunerIds) colors[t] = "#cfd3d6";
for (const s of stringIds) colors[s] = "#e0d6b8";
for (const p of ["pin", ...Array.from({ length: 5 }, (_, k) => `pins:pin:${k}`)]) colors[p] = "#1c1c1c";
const names = new Set(final.bodies.map((b: any) => b.id));
check("every coloured body is there", Object.keys(colors).every((k) => names.has(k)), Object.keys(colors).filter((k) => !names.has(k)).join(" "));
const unhealthy = final.bodies.filter((b: any) => !isHealthy(healthOf(B(b.id)))).map((b: any) => b.id);
check("every body is a clean solid", !unhealthy.length, unhealthy.join(" "));
check("no step left an error", !final.errors.length);
const used = new Set(feats.map((f) => f.type));
check("tools used", used.size >= 20, [...used].sort().join(" "));
console.log(`${feats.length} steps, ${final.bodies.length} bodies`);
if (process.argv[2]) {
  const d = doc();
  d.colors = colors;
  // As the app leaves them: sketches, planes and axes hidden once used; the bodies named; History grouped by part.
  d.hidden = feats.filter((f) => f.type === "sketch" || f.type === "axis" || f.type === "plane").map((f) => f.id);
  const names: Record<string, string> = { box: "Sides", back: "Back", top: "Top", rosette: "Rosette", neck: "Neck", board: "Fretboard", frets: "Frets", inlays: "Inlays", nut: "Nut", bridge: "Bridge", saddle: "Saddle", guard: "Pickguard", endpin: "Strap button", "heelPinS:endpin:0": "Heel strap button" };
  tunerIds.forEach((t, i) => (names[t] = `Tuner ${i + 1}`));
  ["pin", ...Array.from({ length: 5 }, (_, k) => `pins:pin:${k}`)].forEach((t, i) => (names[t] = `Bridge pin ${i + 1}`));
  for (let i = 0; i < 6; i++) {
    names[`string${i}`] = `String ${i + 1}`;
    names[`stringT${i}`] = `String ${i + 1} (head)`;
  }
  check("every body named", final.bodies.every((b: any) => names[b.id]), final.bodies.filter((b: any) => !names[b.id]).map((b: any) => b.id).join(" "));
  d.names = names;
  d.historyGroups = sections.map((s, k) => ({ id: `g${k}`, name: s.name, steps: feats.slice(s.from, sections[k + 1]?.from ?? feats.length).map((f) => f.id) })).filter((g) => g.steps.length > 1);
  writeFileSync(process.argv[2], JSON.stringify(d));
  console.log("written", process.argv[2]);
}

process.exit(failed ? 1 : 0);
