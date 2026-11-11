// Run: npx tsx tests/helicalgears.test.ts [out.json] - a pair of helical gears
// that mesh, built the way a person would, to push the geometry engine:
//   - each gear's outline drawn tooth by tooth (involute flanks as splines,
//     round tips and roots: 108 and 180 curves), swept up its axis with a
//     twist (a 20° helix; the two twist opposite ways, by their sizes);
//   - a bore with a keyway, a hub on the big gear, six lightening holes
//     patterned round and cut, every tooth's ends chamfered (hundreds of edges
//     on twisted faces), the pinion's bore threaded;
//   - checked: the teeth fill what an involute gear should, the gears sit
//     meshed without running into each other, and turned together (as they'd
//     run) they still don't - at the bottom face and at the top, where the
//     twist has carried the teeth round.
// The gears' axes are vertical (z), the pinion at the origin, the gear at x = 48.
import opencascade from "replicad-opencascadejs";
import { measureArea, measureVolume, setOC } from "replicad";
import { writeFileSync } from "node:fs";
import { debugBodies, regenerate } from "../src/kernel/engine";
import { healthOf, isHealthy } from "../src/kernel/repair";
import { arrangement, regionRef } from "../src/sketch/regions";
import type { PlaneDef, Vec3 } from "../src/doc/types";

setOC(await (opencascade as unknown as () => Promise<any>)());
let failed = 0;
const check = (name: string, ok: boolean, info = "") => {
  if (!ok) failed++;
  console.log(ok ? "ok  " : "FAIL", name, info);
};
type P2 = [number, number];
const XY = (z = 0): PlaneDef => ({ origin: [0, 0, z], normal: [0, 0, 1], xDir: [1, 0, 0] });
const XZ = (y = 0): PlaneDef => ({ origin: [0, y, 0], normal: [0, -1, 0], xDir: [1, 0, 0] }); // u = x, v = z
const feats: any[] = [];
const doc = () => ({ format: "super", version: 2, name: "Helical gears", features: structuredClone(feats), variables: [], views: [], units: "mm", hidden: [], pins: [], names: {} });
const nameOf = (fid: string) => feats.find((f) => f.id === fid)?.name ?? fid;
const build = async (quiet = false) => {
  const r: any = await regenerate(doc().features as any);
  if (r.errors.length && !quiet) console.log("   errors:", r.errors.map((e: any) => `${nameOf(e.featureId)}: ${e.message}`).join("; "));
  return r;
};
const stage = async (label: string) => {
  const t = Date.now();
  const r = await build();
  check(`${label} builds`, !r.errors.length, `${r.bodies.length} bodies, ${Date.now() - t} ms`);
  return r;
};
const B = (body: string) => debugBodies().get(body) as any;
const V = (body: string) => Math.abs(measureVolume(B(body)));
const box = (body: string) => B(body).boundingBox.bounds as [number[], number[]];
const edgeRef = (body: string, e: any) => ({ body, mid: e.pointAt(0.5).toTuple() as Vec3, dir: e.tangentAt(0.5).toTuple() as Vec3, length: e.length as number });
const faceRef = (body: string, f: any) => ({ body, center: f.center.toTuple() as Vec3, normal: f.normalAt().toTuple() as Vec3, area: measureArea(f) });
const circle = (id: string, c: P2, r: number) => ({ id, kind: "circle", center: c, radius: r });
/** Edges as the app picks them: from the engine's own list (direction of unit length, the steps either side). */
const asPicked = (r: any, body: string, edges: any[]) => {
  const infos = r.bodies.find((b: any) => b.id === body).edges;
  const all = B(body).edges;
  if (infos.length !== all.length) throw new Error("edge lists differ");
  return edges.map((e: any) => {
    const i = all.findIndex((x: any) => x.isSame(e));
    const { mid, dir, length, steps, curves } = infos[i];
    return { body, mid, dir, length, ...(steps ? { steps } : {}), ...(curves ? { curves } : {}) };
  });
};

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;
const overlap = (a: string, b: string, sa?: any, sb?: any) => {
  try {
    return Math.abs(measureVolume((sa ?? B(a)).clone().intersect((sb ?? B(b)).clone())));
  } catch {
    return -1;
  }
};

const M = 2, PA = rad(20), HELIX = rad(20), WIDTH = 20, BACKLASH = 0.1;
const Z1 = 18, Z2 = 30;
const R1 = (M * Z1) / 2, R2 = (M * Z2) / 2; // 18, 30
const CD = R1 + R2; // 48
const inv = (a: number) => Math.tan(a) - a;

/** One gear's outline, tooth by tooth: a radial line below the base circle, the involute flank (a spline), the tip arc, back down, the root arc. */
const gearOutline = (pre: string, z: number, c: P2, turn = 0) => {
  const rp = (M * z) / 2, rb = rp * Math.cos(PA), ra = rp + M, rf = rp - 1.25 * M;
  const psi = Math.PI / (2 * z) - BACKLASH / 2 / rp; // half the tooth at the pitch circle
  const phi = (r: number) => psi + inv(PA) - inv(Math.acos(Math.min(1, rb / r))); // flank's angle from the tooth's middle
  const at = (r: number, a: number): P2 => [c[0] + r * Math.cos(a + turn), c[1] + r * Math.sin(a + turn)];
  const r0 = Math.max(rb, rf);
  const flank = (mid: number, s: number) => Array.from({ length: 9 }, (_, i) => r0 + ((ra - r0) * i) / 8).map((r) => at(r, mid + s * phi(r)));
  const es: any[] = [];
  for (let k = 0; k < z; k++) {
    const m = (2 * Math.PI * k) / z;
    const right = flank(m, -1), left = flank(m, 1).reverse();
    if (rf < rb) es.push({ id: `${pre}${k}a`, kind: "line", a: at(rf, m - phi(rb)), b: right[0] });
    es.push({ id: `${pre}${k}b`, kind: "spline", closed: false, mode: "fit", points: right });
    es.push({ id: `${pre}${k}c`, kind: "arc", a: right[8], m: at(ra, m), b: left[0] });
    es.push({ id: `${pre}${k}d`, kind: "spline", closed: false, mode: "fit", points: left });
    if (rf < rb) es.push({ id: `${pre}${k}e`, kind: "line", a: left[8], b: at(rf, m + phi(rb)) });
    const n = (2 * Math.PI * (k + 1)) / z;
    es.push({ id: `${pre}${k}f`, kind: "arc", a: at(rf, m + phi(rb)), m: at(rf, (m + n) / 2), b: at(rf, n - phi(rb)) });
  }
  return es;
};
/** The area an involute gear's outline holds (the same curves, integrated finely). */
const gearArea = (z: number) => {
  const rp = (M * z) / 2, rb = rp * Math.cos(PA), ra = rp + M, rf = rp - 1.25 * M;
  const psi = Math.PI / (2 * z) - BACKLASH / 2 / rp;
  const phi = (r: number) => psi + inv(PA) - inv(Math.acos(Math.min(1, rb / r)));
  // ∫ r dr dθ: the tooth's width in angle at each radius.
  let a = Math.PI * rf * rf;
  const n = 20000;
  for (let i = 0; i < n; i++) {
    const r = rf + ((ra - rf) * (i + 0.5)) / n;
    a += z * 2 * phi(Math.max(r, rb)) * r * ((ra - rf) / n);
  }
  return a;
};

// The twist that makes a 20° helix over the face width, at each gear's pitch circle.
const twist1 = deg((WIDTH * Math.tan(HELIX)) / R1); // ~23.2°
const twist2 = -twist1 * (R1 / R2);

const gear = (id: string, name: string, z: number, c: P2, turn: number, twist: number, bore: number) => {
  const es = [...gearOutline(`${id}t`, z, c, turn), circle(`${id}bore`, c, bore)];
  const regs = arrangement(es).regions.filter((r: any) => r.area > Math.PI * bore * bore + 1).map(regionRef);
  feats.push({ id: `s_${id}`, name: `${name} teeth`, type: "sketch", plane: XY(0), entities: es });
  const path = [{ id: "ax", kind: "line", a: [c[0], 0], b: [c[0], WIDTH] }];
  feats.push({ id: `p_${id}`, name: `${name} axis`, type: "sketch", plane: XZ(c[1]), entities: path });
  feats.push({ id, name, type: "sweep", source: { kind: "profile", sketch: `s_${id}`, regions: regs }, path: { kind: "sketch", sketch: `p_${id}`, entities: ["ax"] }, mode: "new", twist });
  return { regs, count: es.length };
};

// --- 1. The pinion, 18 teeth, and the gear, 30 teeth, turned half a tooth so a gap faces the pinion's tooth.
const g1 = gear("pinion", "Pinion", Z1, [0, 0], 0, twist1, 5);
const g2 = gear("wheel", "Gear", Z2, [CD, 0], Math.PI / Z2, twist2, 8);
const t0 = Date.now();
await stage("two helical gears swept with twist");
console.log(`     (${g1.count} + ${g2.count} curves, ${Date.now() - t0} ms)`);
check("…each sketch is one region with its bore", g1.regs.length === 1 && g2.regs.length === 1, `${g1.regs.length} ${g2.regs.length}`);
{
  // The twist doesn't change how much there is: the same gears swept straight hold the same.
  const [v1, v2] = [V("pinion"), V("wheel")];
  for (const id of ["pinion", "wheel"]) feats.find((f) => f.id === id).twist = 0;
  await build();
  const [s1, s2] = [V("pinion"), V("wheel")];
  feats.find((f) => f.id === "pinion").twist = twist1;
  feats.find((f) => f.id === "wheel").twist = twist2;
  await build();
  check("…twisted, each holds what it does swept straight", Math.abs(v1 - s1) < s1 * 3e-4 && Math.abs(v2 - s2) < s2 * 3e-4, `${v1.toFixed(1)} / ${s1.toFixed(1)}, ${v2.toFixed(1)} / ${s2.toFixed(1)}`);
  // Swept straight, an involute gear's area (its flanks drawn as splines through 9 points each).
  const want1 = (gearArea(Z1) - Math.PI * 25) * WIDTH, want2 = (gearArea(Z2) - Math.PI * 64) * WIDTH;
  check("…and what an involute gear with a bore should", Math.abs(s1 - want1) < want1 * 3e-4 && Math.abs(s2 - want2) < want2 * 3e-4, `${s1.toFixed(1)} want ${want1.toFixed(1)}, ${s2.toFixed(1)} want ${want2.toFixed(1)}`);
  const bores = ["pinion", "wheel"].map((id) => B(id).faces.filter((f: any) => f.geomType === "CYLINDRE").length);
  check("…their bores are true cylinders (twisted, they were splines a thread couldn't use)", bores.every((n) => n >= 1), bores.join(" "));
}
check("…both clean solids", isHealthy(healthOf(B("pinion"))) && isHealthy(healthOf(B("wheel"))));
{
  const [lo, hi] = box("pinion");
  check("…the pinion 40 across its tips, 20 high", Math.abs(hi[2] - lo[2] - WIDTH) < 1e-3 && Math.abs(Math.max(hi[0], -lo[0], hi[1], -lo[1]) - (R1 + M)) < 0.05, `${(hi[0] - lo[0]).toFixed(2)} x ${(hi[2] - lo[2]).toFixed(2)}`);
}
// The top face's teeth turned by the twist: the tip of tooth 0 is at angle twist1 there.
{
  const top = B("pinion").faces.find((f: any) => f.geomType === "PLANE" && Math.abs(f.center.z - WIDTH) < 1e-6);
  const pts = top.edges.map((e: any) => e.pointAt(0.5).toTuple()).filter((p: number[]) => Math.abs(Math.hypot(p[0], p[1]) - (R1 + M)) < 1e-3);
  const angs = pts.map((p: number[]) => deg(Math.atan2(p[1], p[0])));
  const near = angs.reduce((b: number, a: number) => (Math.abs(a - twist1) < Math.abs(b - twist1) ? a : b), 999);
  check("…its top face is turned by the twist (a tooth's tip at 23.2°)", Math.abs(near - twist1) < 0.05, `${near.toFixed(3)}° want ${twist1.toFixed(3)}°`);
}

// --- 2. Meshed: they don't run into each other; turned together, they still don't.
const o0 = overlap("pinion", "wheel");
check("meshed: the teeth don't run into each other (0.1 backlash)", o0 >= 0 && o0 < 0.01, `${o0.toFixed(4)} mm³`);
for (const a of [3, 7, 11, 17]) {
  const p = B("pinion").clone().rotate(a, [0, 0, 0], [0, 0, 1]);
  const w = B("wheel").clone().rotate((-a * Z1) / Z2, [CD, 0, 0], [0, 0, 1]);
  const o = overlap("", "", p, w);
  check(`…turned ${a}° together: still clear`, o >= 0 && o < 0.01, `${o.toFixed(4)} mm³`);
}
{
  // Without the backlash they'd touch, and with a tooth too many degrees out they'd run in: the check bites.
  const p = B("pinion").clone().rotate(5, [0, 0, 0], [0, 0, 1]);
  const o = overlap("", "", p, B("wheel"));
  check("…the pinion alone turned 5°: they run into each other (the check works)", o > 1, `${o.toFixed(2)} mm³`);
}

// --- 3. The gear: a hub, six lightening holes patterned round and cut.
feats.push({ id: "s_hub", name: "Hub sketch", type: "sketch", plane: XY(WIDTH), entities: [circle("h", [CD, 0], 14), circle("hb", [CD, 0], 8)] });
feats.push({ id: "hub", name: "Hub", type: "extrude", source: { kind: "profile", sketch: "s_hub", regions: arrangement([circle("h", [CD, 0], 14), circle("hb", [CD, 0], 8)]).regions.filter((r: any) => r.area > 300).map(regionRef) }, distance: 8, mode: "join", target: "wheel" });
feats.push({ id: "s_lh", name: "Lightening hole", type: "sketch", plane: XY(WIDTH), entities: [circle("l", [CD + 19, 0], 4)] });
feats.push({ id: "lh", name: "Lightening hole", type: "extrude", source: { kind: "profile", sketch: "s_lh", regions: arrangement([circle("l", [CD + 19, 0], 4)]).regions.map(regionRef) }, distance: -WIDTH, mode: "new" });
feats.push({ id: "lhs", name: "Lightening holes round", type: "transform", bodies: ["lh"], copy: true, op: { kind: "circular", axis: { origin: [CD, 0, 0], dir: [0, 0, 1] }, count: 6, angle: 360 } });
feats.push({ id: "cutl", name: "Lightening holes cut", type: "boolean", op: "subtract", target: "wheel", tools: ["lh", ...[0, 1, 2, 3, 4].map((k) => `lhs:lh:${k}`)] });
// A keyway in the gear's bore, through the hub too.
feats.push({ id: "s_kw", name: "Keyway", type: "sketch", plane: XY(0), entities: [{ id: "k", kind: "rect", center: [CD + 8, 0], w: 5, h: 4, rotation: 0 }] });
feats.push({ id: "kw", name: "Keyway", type: "extrude", source: { kind: "profile", sketch: "s_kw", regions: arrangement([{ id: "k", kind: "rect", center: [CD + 8, 0], w: 5, h: 4, rotation: 0 }] as any).regions.map(regionRef) }, distance: WIDTH + 8, mode: "cut", target: "wheel" });
const pre3 = V("wheel");
await stage("hub, lightening holes and keyway");
// The keyway: the 5 x 4 from x 5.5 to 10.5 less what's inside the Ø16 bore, through gear and hub.
const kwV = (() => {
  let a = 0;
  for (let k = 0; k < 4000; k++) {
    const y = -2 + (4 * (k + 0.5)) / 4000;
    a += (10.5 - Math.max(5.5, Math.sqrt(64 - y * y))) * (4 / 4000);
  }
  return a * (WIDTH + 8);
})();
const want3 = pre3 + Math.PI * (14 * 14 - 64) * 8 - 6 * Math.PI * 16 * WIDTH;
check("…the hub added and six holes taken (and a keyway)", Math.abs(V("wheel") - (want3 - kwV)) < 0.5, `${V("wheel").toFixed(1)} want ~${(want3 - kwV).toFixed(1)}`);

// --- 4. Chamfer every tooth's ends: the tips' and the involute flanks' edges at both faces (0.5).
// (Not the short radial bit below the base circle: on a helix as steep as 33° the engine can't
// chamfer it at any size - the 23° gears here take it, but the change to 33° below wouldn't.)
const r4 = await build(true);
for (const [id, z] of [["pinion", Z1], ["wheel", Z2]] as const) {
  const rp = (M * z) / 2;
  const cx = id === "pinion" ? 0 : CD;
  const tooth = B(id).edges.filter((e: any) => {
    const p = e.pointAt(0.5).toTuple();
    const r = Math.hypot(p[0] - cx, p[1]);
    return (Math.abs(p[2]) < 1e-6 || Math.abs(p[2] - WIDTH) < 1e-6) && r > rp * Math.cos(PA) + 0.1;
  });
  const pre = V(id);
  feats.push({ id: `ch_${id}`, name: `Chamfer ${id} teeth`, type: "chamfer", radius: 0.5, edges: asPicked(r4, id, tooth) });
  const t = Date.now();
  const r = await build();
  check(`${id}: ${tooth.length} tooth edges chamfered 0.5`, !r.errors.length && isHealthy(healthOf(B(id))), `${Date.now() - t} ms`);
  // Each tooth's outline above the root, at both faces, loses a 0.5 x 0.5 triangle along it.
  const flankLen = tooth.reduce((s: number, e: any) => s + e.length, 0);
  check(`…takes about 0.125 mm² along ${flankLen.toFixed(0)} mm of edge`, Math.abs(pre - V(id) - 0.125 * flankLen) < 0.125 * flankLen * 0.25, `${(pre - V(id)).toFixed(1)} want ~${(0.125 * flankLen).toFixed(1)}`);
}

// --- 5. Thread the pinion's bore (M10 x 1.5 tapped into the Ø10 drawn... a Ø8.5 tap drill).
feats.find((f) => f.id === "s_pinion").entities = feats.find((f) => f.id === "s_pinion").entities.map((e: any) => (e.id === "pinionbore" ? { ...e, radius: 4.25 } : e));
{
  const es = feats.find((f) => f.id === "s_pinion").entities;
  feats.find((f) => f.id === "pinion").source.regions = arrangement(es).regions.filter((r: any) => r.area > Math.PI * 4.25 ** 2 + 1).map(regionRef);
}
await build(true);
const boreF = B("pinion").faces.find((f: any) => f.geomType === "CYLINDRE" && Math.abs(f.center.x) < 1e-3 && Math.abs(f.center.y) < 1e-3);
feats.push({ id: "thr", name: "Thread M10", type: "thread", face: faceRef("pinion", boreF), pitch: 1.5, round: { r: 4.25, hole: true } });
const pre5 = V("pinion");
await stage("the pinion's bore threaded M10");
check("…the thread takes metal out of the bore", V("pinion") < pre5 - 50 && V("pinion") > pre5 - 600, `${(pre5 - V("pinion")).toFixed(1)} mm³`);
check("…still clear of the gear", overlap("pinion", "wheel") < 0.01);

// --- Changes upstream: a steeper helix, fewer teeth.
{
  const was = structuredClone(feats);
  feats.find((f) => f.id === "pinion").twist = twist1 * 1.8;
  feats.find((f) => f.id === "wheel").twist = twist2 * 1.8;
  const r = await build();
  check("a 33° helix: everything after rebuilds", !r.errors.length);
  check("…still clear", overlap("pinion", "wheel") < 0.01, `${overlap("pinion", "wheel").toFixed(4)}`);
  feats.length = 0;
  feats.push(...was);
}
{
  const was = structuredClone(feats);
  feats.find((f) => f.id === "pinion").twist = 0;
  feats.find((f) => f.id === "wheel").twist = 0;
  const r = await build();
  check("twist 0 (spur gears): everything after rebuilds", !r.errors.length);
  feats.length = 0;
  feats.push(...was);
}
const final = await build();
check("two clean solids at the end", final.bodies.length === 2 && ["pinion", "wheel"].every((b) => isHealthy(healthOf(B(b)))));
console.log(`${feats.length} steps`);

if (process.argv[2]) {
  const d: any = doc();
  d.colors = { pinion: "#b9bdc2", wheel: "#c9a227" };
  d.names = { pinion: "Pinion (18 teeth)", wheel: "Gear (30 teeth)" };
  d.hidden = feats.filter((f) => f.type === "sketch").map((f) => f.id);
  writeFileSync(process.argv[2], JSON.stringify(d));
  console.log("written", process.argv[2]);
}
process.exit(failed ? 1 : 0);
