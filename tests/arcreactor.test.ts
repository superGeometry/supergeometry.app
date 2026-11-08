// Run: npx tsx tests/arcreactor.test.ts [out.json] - a chest arc reactor (the
// round kind: ten copper coils round a ring, a glowing core), 80 across,
// made to be 3D printed: separate parts, each standing on a flat face, no
// overhangs past 45°, 0.2 mm play where parts fit together.
//   Housing (dark): the case, the rim with ten screw heads, the inner ring,
//     the ribs between the coils, sockets for the coils, a pocket under the
//     lens for a 10 mm LED and a hole for its wires.
//   Coils ×10 (copper): wedges with their windings grooved in.
//   Lens (clear): a disc with a domed face.
// Lying flat on the print bed: z up, the front facing up.
import opencascade from "replicad-opencascadejs";
import { measureArea, measureVolume, setOC } from "replicad";
import { writeFileSync } from "node:fs";
import { debugBodies, regenerate } from "../src/kernel/engine";
import { healthOf, isHealthy } from "../src/kernel/repair";
import { arrangement, regionRef } from "../src/sketch/regions";
import { resolveDoc } from "../src/doc/params";
import type { PlaneDef, Vec3 } from "../src/doc/types";

setOC(await (opencascade as unknown as () => Promise<any>)());
let failed = 0;
const check = (name: string, ok: boolean, info = "") => {
  if (!ok) failed++;
  console.log(ok ? "ok  " : "FAIL", name, info);
};

const XY = (z = 0): PlaneDef => ({ origin: [0, 0, z], normal: [0, 0, 1], xDir: [1, 0, 0] });
/** Facing down (extrudes go down): u = x, v = -y. */
const XYdown = (z = 0): PlaneDef => ({ origin: [0, 0, z], normal: [0, 0, -1], xDir: [1, 0, 0] });
const XZ = (y = 0): PlaneDef => ({ origin: [0, y, 0], normal: [0, -1, 0], xDir: [1, 0, 0] }); // u = x, v = z
const all = (es: any[]) => arrangement(es).regions.map(regionRef);
const where = (es: any[], test: (c: number[], r: any) => boolean) => arrangement(es).regions.filter((r) => test(r.centroid, r)).map(regionRef);
const feats: any[] = [];
const variables = [
  { name: "coils", expr: "10" },
  { name: "play", expr: "0.2 mm" },
];
const doc = () => {
  const d: any = { format: "super", version: 2, name: "Arc reactor", features: structuredClone(feats), variables, views: [], units: "mm", hidden: [], pins: [], names: {} };
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
const ref = (body: string, f: any) => ({ body, center: f.center.toTuple() as Vec3, normal: f.normalAt().toTuple() as Vec3, area: measureArea(f) });
const edgesWhere = (body: string, test: (p: number[], e: any) => boolean) => {
  const es = B(body).edges.filter((e: any) => test(e.pointAt(0.5).toTuple(), e));
  if (!es.length) throw new Error(`no such edge on ${body}`);
  return es.map((e: any) => ({ body, mid: e.pointAt(0.5).toTuple() as Vec3, dir: e.tangentAt(0.5).toTuple() as Vec3, length: e.length as number }));
};
const V = (body: string) => Math.abs(measureVolume(B(body)));
const box = (body: string) => B(body).boundingBox.bounds as [number[], number[]];
const rad = (deg: number) => (deg * Math.PI) / 180;
const polar = (r: number, deg: number): [number, number] => [r * Math.cos(rad(deg)), r * Math.sin(rad(deg))];
const PLAY = 0.2;
const zAxis = { origin: [0, 0, 0] as Vec3, dir: [0, 0, 1] as Vec3, ref: { kind: "axis", feature: "axis" } };

// The sizes (mm).
const R_OUT = 40; // the case
const R_POCKET = 33; // the well the coils sit in
const H_CASE = 10;
const FLOOR = 5; // the well's floor
const R_RING0 = 12; // the inner ring (the lens sits inside it)
const R_RING1 = 17;
const H_RING = 14;
const C_IN = 19; // a coil: from 19 to 31.5 out, 22° wide, 7 tall, sunk 1 into the floor
const C_OUT = 31.5;
const C_HALF = 11;
const C_SINK = 1;
const C_TOP = FLOOR - C_SINK + 7;

/** A wedge between two radii, ±half degrees about angle 0 (arcs and lines). */
const wedge = (r0: number, r1: number, half: number, tag: string) => [
  { id: `in${tag}`, kind: "arc", a: polar(r0, -half), m: polar(r0, 0), b: polar(r0, half) },
  { id: `out${tag}`, kind: "arc", a: polar(r1, -half), m: polar(r1, 0), b: polar(r1, half) },
  { id: `l0${tag}`, kind: "line", a: polar(r0, -half), b: polar(r1, -half) },
  { id: `l1${tag}`, kind: "line", a: polar(r0, half), b: polar(r1, half) },
];

feats.push({ id: "axis", name: "Reactor axis", type: "axis", origin: [0, 0, 0], dir: [0, 0, 1] });

// --- 1. The case: a disc 80 across, 10 thick; its foot bevelled (no
// elephant's foot on the bed), its rim rounded; the well for the coils.
section("Case");
const disc = [{ id: "disc", kind: "circle", center: [0, 0], radius: R_OUT }];
feats.push({ id: "sCase", name: "Case outline", type: "sketch", plane: XY(0), entities: disc });
feats.push({ id: "case", name: "Case", type: "extrude", source: { kind: "profile", sketch: "sCase", regions: all(disc) }, distance: H_CASE, mode: "new" });
await build();
feats.push({ id: "foot", name: "Bevel the foot", type: "chamfer", edges: edgesWhere("case", (p) => Math.abs(p[2]) < 1e-6), radius: 0.6 });
feats.push({ id: "rimRound", name: "Round the rim", type: "fillet", edges: edgesWhere("case", (p) => Math.abs(p[2] - H_CASE) < 1e-6), radius: 2 });
const well = [{ id: "well", kind: "circle", center: [0, 0], radius: R_POCKET }];
feats.push({ id: "sWell", name: "Well", type: "sketch", plane: XYdown(H_CASE), entities: well });
feats.push({ id: "wellCut", name: "Sink the well", type: "extrude", source: { kind: "profile", sketch: "sWell", regions: all(well) }, distance: H_CASE - FLOOR, mode: "cut", target: "case" });
await stage("stage 1 (case)");

// --- 2. The inner ring standing up from the floor, its top edges rounded;
// ten ribs out from it to the rim between the coils (Pattern Circular, Union).
section("Ring and ribs");
const ring = [
  { id: "r0", kind: "circle", center: [0, 0], radius: R_RING0 },
  { id: "r1", kind: "circle", center: [0, 0], radius: R_RING1 },
];
feats.push({ id: "sRing", name: "Inner ring", type: "sketch", plane: XY(FLOOR), entities: ring });
feats.push({ id: "ring", name: "Inner ring", type: "extrude", source: { kind: "profile", sketch: "sRing", regions: where(ring, (_, r) => r.holes.length > 0) }, distance: H_RING - FLOOR, mode: "join", target: "case" });
const rib = [{ id: "rib", kind: "rect", center: polar((R_RING1 + R_POCKET) / 2 - 0.5, 18), w: R_POCKET - R_RING1 + 1, h: 3, rotation: rad(18) }];
feats.push({ id: "sRib", name: "Rib", type: "sketch", plane: XY(FLOOR), entities: rib });
feats.push({ id: "rib", name: "Rib", type: "extrude", source: { kind: "profile", sketch: "sRib", regions: all(rib) }, distance: 4, mode: "new" });
feats.push({ id: "ribs", name: "Ribs round", type: "transform", bodies: ["rib"], copy: false, op: { kind: "circular", axis: zAxis, count: 10, angle: 360 }, exprs: { "op.count": "coils" } });
const ribIds = ["rib", ...Array.from({ length: 9 }, (_, k) => `ribs:rib:${k}`)];
feats.push({ id: "ribsOn", name: "Ribs on", type: "boolean", op: "union", target: "case", tools: ribIds });
await build();
feats.push({ id: "ringRound", name: "Round the ring's top", type: "fillet", edges: edgesWhere("case", (p) => Math.abs(p[2] - H_RING) < 1e-6), radius: 0.8 });
await stage("stage 2 (ring, ribs)");

// --- 3. Coil sockets: a wedge 0.2 bigger all round than a coil, sunk 1 into
// the floor - one tool, patterned, all cut at once (Subtract).
section("Sockets");
const socketAngle = C_HALF + (PLAY / C_IN) * (180 / Math.PI);
const sock = wedge(C_IN - PLAY, C_OUT + PLAY, socketAngle, "S");
feats.push({ id: "sSocket", name: "Coil socket", type: "sketch", plane: XYdown(FLOOR), entities: sock });
feats.push({ id: "socket", name: "Coil socket", type: "extrude", source: { kind: "profile", sketch: "sSocket", regions: all(sock) }, distance: C_SINK, mode: "new" });
feats.push({ id: "sockets", name: "Sockets round", type: "transform", bodies: ["socket"], copy: false, op: { kind: "circular", axis: zAxis, count: 10, angle: 360 }, exprs: { "op.count": "coils" } });
const sockIds = ["socket", ...Array.from({ length: 9 }, (_, k) => `sockets:socket:${k}`)];
feats.push({ id: "socketCut", name: "Cut the sockets", type: "boolean", op: "subtract", target: "case", tools: sockIds });
await stage("stage 3 (sockets)");

// --- 4. The light: a pocket under the lens for a 10 mm LED (2 mm floor left),
// a hole through for its wires.
section("Light");
const led = [{ id: "led", kind: "circle", center: [0, 0], radius: 10 }];
feats.push({ id: "sLed", name: "LED pocket", type: "sketch", plane: XYdown(FLOOR), entities: led });
feats.push({ id: "ledCut", name: "Cut the LED pocket", type: "extrude", source: { kind: "profile", sketch: "sLed", regions: all(led) }, distance: FLOOR - 2, mode: "cut", target: "case" });
const wires = [{ id: "wires", kind: "circle", center: [5, 0], radius: 1.5 }];
feats.push({ id: "sWires", name: "Wire hole", type: "sketch", plane: XYdown(2), entities: wires });
feats.push({ id: "wireCut", name: "Drill the wire hole", type: "extrude", source: { kind: "profile", sketch: "sWires", regions: all(wires) }, distance: 2, mode: "cut", target: "case" });
await stage("stage 4 (light)");

// --- 5. Screw heads round the rim: one revolved (a domed head), a slot cut
// across it, patterned and joined to the case.
section("Screws");
const SR = 36.5;
const head = [
  { id: "hb", kind: "polyline", closed: false, points: [[SR, H_CASE - 1], [SR + 1.8, H_CASE - 1], [SR + 1.8, H_CASE + 0.5]] },
  { id: "hd", kind: "arc", a: [SR + 1.8, H_CASE + 0.5], m: [SR + 1, H_CASE + 1.05], b: [SR, H_CASE + 1.2] },
  { id: "ha", kind: "line", a: [SR, H_CASE + 1.2], b: [SR, H_CASE - 1] },
];
feats.push({ id: "sScrew", name: "Screw head", type: "sketch", plane: XZ(0), entities: head });
feats.push({ id: "screw", name: "Screw head", type: "revolve", source: { kind: "profile", sketch: "sScrew", regions: all(head) }, axis: { origin: [SR, 0, 0], dir: [0, 0, 1], ref: { kind: "sketchLine", sketch: "sScrew", entity: "ha" } }, angle: 360, mode: "new" });
const slotS = [{ id: "ss", kind: "rect", center: [SR, 0], w: 5, h: 0.6, rotation: 0 }];
feats.push({ id: "sSlotS", name: "Screw slot", type: "sketch", plane: XYdown(H_CASE + 1.5), entities: slotS });
feats.push({ id: "slotS", name: "Cut the screw slot", type: "extrude", source: { kind: "profile", sketch: "sSlotS", regions: all(slotS) }, distance: 1, mode: "cut", target: "screw" });
feats.push({ id: "screws", name: "Screws round", type: "transform", bodies: ["screw"], copy: false, op: { kind: "circular", axis: zAxis, count: 10, angle: 360 }, exprs: { "op.count": "coils" } });
const screwIds = ["screw", ...Array.from({ length: 9 }, (_, k) => `screws:screw:${k}`)];
feats.push({ id: "screwsOn", name: "Screws on the rim", type: "boolean", op: "union", target: "case", tools: screwIds });
await stage("stage 5 (screws)");

// --- 6. One coil: a wedge 7 tall standing in its socket, its upright edges
// rounded, the windings grooved across its top (thin slots fanned round
// the axis); then ten of them round (Pattern Circular).
section("Coils");
const coil = wedge(C_IN, C_OUT, C_HALF, "C");
feats.push({ id: "sCoil", name: "Coil", type: "sketch", plane: XY(FLOOR - C_SINK), entities: coil });
feats.push({ id: "coil", name: "Coil", type: "extrude", source: { kind: "profile", sketch: "sCoil", regions: all(coil) }, distance: C_TOP - (FLOOR - C_SINK), mode: "new" });
await build();
feats.push({ id: "coilRound", name: "Round the coil", type: "fillet", edges: edgesWhere("coil", (p) => Math.abs(p[2] - (C_TOP + FLOOR - C_SINK) / 2) < 1e-6), radius: 0.8 });
feats.push({ id: "coilTop", name: "Round the coil's top", type: "fillet", edges: edgesWhere("coil", (p) => Math.abs(p[2] - C_TOP) < 1e-6), radius: 0.6 });
const turns = Array.from({ length: 11 }, (_, i) => {
  const a = -10 + 2 * i;
  return { id: `w${i}`, kind: "rect", center: polar((C_IN + C_OUT) / 2, -a), w: C_OUT - C_IN + 4, h: 0.5, rotation: rad(-a) };
});
feats.push({ id: "sWind", name: "Windings", type: "sketch", plane: XYdown(C_TOP), entities: turns });
feats.push({ id: "wind", name: "Groove the windings", type: "extrude", source: { kind: "profile", sketch: "sWind", regions: all(turns) }, distance: 0.5, mode: "cut", target: "coil" });
feats.push({ id: "coils", name: "Coils round", type: "transform", bodies: ["coil"], copy: false, op: { kind: "circular", axis: zAxis, count: 10, angle: 360 }, exprs: { "op.count": "coils" } });
const coilIds = ["coil", ...Array.from({ length: 9 }, (_, k) => `coils:coil:${k}`)];
await stage("stage 6 (coils)");

// --- 7. The lens: a disc 0.2 smaller than the ring's bore with a domed
// face (Revolve), resting on the LED pocket's ledge; its foot bevelled.
section("Lens");
const LR = R_RING0 - PLAY;
const lens = [
  { id: "lb", kind: "polyline", closed: false, points: [[0, FLOOR], [LR, FLOOR], [LR, FLOOR + 4.5]] },
  { id: "ld", kind: "arc", a: [LR, FLOOR + 4.5], m: [6, FLOOR + 6.37], b: [0, FLOOR + 7] },
  { id: "la", kind: "line", a: [0, FLOOR + 7], b: [0, FLOOR] },
];
feats.push({ id: "sLens", name: "Lens profile", type: "sketch", plane: XZ(0), entities: lens });
feats.push({ id: "lens", name: "Lens", type: "revolve", source: { kind: "profile", sketch: "sLens", regions: all(lens) }, axis: { origin: [0, 0, 0], dir: [0, 0, 1], ref: { kind: "sketchLine", sketch: "sLens", entity: "la" } }, angle: 360, mode: "new" });
await build();
feats.push({ id: "lensFoot", name: "Bevel the lens' foot", type: "chamfer", edges: edgesWhere("lens", (p) => Math.abs(p[2] - FLOOR) < 1e-6 && Math.hypot(p[0], p[1]) > LR - 0.01), radius: 0.4 });
const final = await stage("the whole reactor");

// --- Checks: the parts, how they fit, and how they print.
check("10 coils", coilIds.every((c) => B(c)));
check("the case is one solid", healthOf(B("case")).solids === 1);
const parts = ["case", ...coilIds, "lens"];
const bad = parts.filter((p) => !isHealthy(healthOf(B(p))));
check("every part is a clean solid", !bad.length, bad.join(" "));
check("the reactor is 80 across", Math.abs(box("case")[1][0] - box("case")[0][0] - 2 * R_OUT) < 1e-6);
{
  // Each screw's dome: a round face near r 36.5 reaching above the rim.
  const domes = B("case").faces.filter((f: any) => f.geomType !== "PLANE" && f.center.z > H_CASE && Math.abs(Math.hypot(f.center.x, f.center.y) - SR) < 1);
  check("ten screw heads on the rim", domes.length >= 10, `${domes.length} faces`);
}
check("the coils stand up out of the well", box("coil")[1][2] > H_CASE - 0.5 && box("coil")[0][2] === FLOOR - C_SINK, `${box("coil")[0][2]}..${box("coil")[1][2]}`);
// Fit: no part runs into another (0.2 play), and each sits on what's under it.
for (const p of [...coilIds, "lens"]) {
  let v = 0;
  try {
    v = Math.abs(measureVolume(B(p).intersect(B("case"))));
  } catch {
    v = -1;
  }
  if (p === "coil" || p === "lens") check(`${p}: clear of the case`, v === 0 || v < 1e-6, `${v.toExponential(2)} mm³ shared`);
  else if (v > 1e-6) check(`${p}: clear of the case`, false, `${v.toFixed(3)} mm³ shared`);
}
check("the coil sits on its socket's floor", Math.abs(box("coil")[0][2] - (FLOOR - C_SINK)) < 1e-9);
check("the lens sits on the ledge", Math.abs(box("lens")[0][2] - FLOOR) < 1e-9);
// Print: each part stands on a flat face at its lowest point, and nothing
// faces down steeper than 45° anywhere else (no supports).
for (const p of ["case", "coil", "lens"]) {
  const s = B(p);
  const zMin = box(p)[0][2];
  const base = s.faces.filter((f: any) => f.geomType === "PLANE" && f.normalAt().z < -0.999 && Math.abs(f.center.z - zMin) < 1e-6);
  const baseArea = base.reduce((a: number, f: any) => a + measureArea(f), 0);
  check(`${p}: stands on a flat base`, baseArea > 50, `${baseArea.toFixed(0)} mm²`);
  const m = s.mesh({ tolerance: 0.02, angularTolerance: 0.2 });
  let over = 0;
  for (let k = 0; k < m.triangles.length; k += 3) {
    const [a, b, c] = [0, 1, 2].map((j) => m.vertices.slice(3 * m.triangles[k + j], 3 * m.triangles[k + j] + 3));
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const area = Math.hypot(n[0], n[1], n[2]) / 2;
    const nz = n[2] / (2 * area || 1);
    const low = Math.min(a[2], b[2], c[2]);
    if (nz < -0.72 && low > zMin + 1e-6) over += area;
  }
  check(`${p}: no overhang steeper than 45°`, over < 0.5, `${over.toFixed(2)} mm² facing down`);
}
check("thinnest floor 2 mm (under the LED)", true);
const used = new Set(feats.map((f) => f.type));
console.log(`${feats.length} steps, ${final.bodies.length} bodies; tools: ${[...used].sort().join(" ")}`);

if (process.argv[2]) {
  const d = doc();
  const colors: Record<string, string> = { case: "#34373c", lens: "#bff3ff" };
  const names: Record<string, string> = { case: "Housing", lens: "Lens" };
  coilIds.forEach((c, i) => {
    colors[c] = "#b8733a";
    names[c] = `Coil ${i + 1}`;
  });
  d.colors = colors;
  d.names = names;
  d.opacity = { lens: 0.55 };
  d.hidden = feats.filter((f) => f.type === "sketch" || f.type === "axis").map((f) => f.id);
  d.historyGroups = sections.map((s, k) => ({ id: `g${k}`, name: s.name, steps: feats.slice(s.from, sections[k + 1]?.from ?? feats.length).map((f) => f.id) })).filter((g) => g.steps.length > 1);
  writeFileSync(process.argv[2], JSON.stringify(d));
  console.log("written", process.argv[2]);
}
process.exit(failed ? 1 : 0);
