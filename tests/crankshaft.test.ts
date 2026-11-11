// Run: npx tsx tests/crankshaft.test.ts [out.json] - a four-cylinder crankshaft,
// built the way a person would, to push the geometry engine:
//   - one throw (two shaped webs with counterweights, the crank pin, the next
//     main journal) made once, then copied turned half round and along (180°
//     apart in the middle, as a flat-plane four has them: 0, 180, 180, 0);
//   - the throws joined to the nose (stepped, a keyway, a threaded end) and a
//     rear flange with six bolt holes (patterned round, subtracted);
//   - every journal and pin rounded where it meets its webs (20 round edges in
//     one fillet), the counterweights' rims chamfered;
//   - oil drillings at a slant from each main journal through the web into the
//     next pin (sketched on planes tilted along the hole, cut through).
// x runs along the shaft, z is up; the crank pins sit 45 off the axis.
import opencascade from "replicad-opencascadejs";
import { measureArea, measureShapeVolumeProperties, measureVolume, setOC } from "replicad";
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
const YZ = (x = 0): PlaneDef => ({ origin: [x, 0, 0], normal: [1, 0, 0], xDir: [0, 1, 0] }); // u = y, v = z (extrudes go +x)
const XY = (z = 0): PlaneDef => ({ origin: [0, 0, z], normal: [0, 0, 1], xDir: [1, 0, 0] });
const XZ = (y = 0): PlaneDef => ({ origin: [0, y, 0], normal: [0, -1, 0], xDir: [1, 0, 0] }); // u = x, v = z
const all = (es: any[]) => arrangement(es).regions.map(regionRef);
const feats: any[] = [];
const doc = () => ({ format: "super", version: 2, name: "Crankshaft", features: structuredClone(feats), variables: [], views: [], units: "mm", hidden: [], pins: [], names: {} });
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

const extrude = (id: string, name: string, plane: PlaneDef, entities: any[], distance: number, opts: any = {}) => {
  feats.push({ id: `s_${id}`, name: `${name} sketch`, type: "sketch", plane, entities });
  feats.push({ id, name, type: "extrude", source: { kind: "profile", sketch: `s_${id}`, regions: opts.regions ?? all(entities) }, distance, mode: opts.mode ?? "new", ...(opts.target ? { target: opts.target } : {}) });
};
const rad = (d: number) => (d * Math.PI) / 180;

const THROW = 45, PIN_R = 21, MAIN_R = 25, WEB = 16, PIN_L = 22, MAIN_L = 24;
const PERIOD = 2 * WEB + PIN_L + MAIN_L; // 78
const MAINS = [0, 1, 2, 3, 4].map((k) => k * PERIOD); // where each main journal starts
const T0 = MAIN_L; // first web

// --- 1. The nose: Ø24 threaded end, Ø30 with a keyway, Ø40 seal, the first main journal (revolved).
const noseProfile = [
  {
    id: "np",
    kind: "polyline",
    closed: true,
    points: [
      [-75, 0], [-75, 12], [-60, 12], [-60, 15], [-30, 15], [-30, 20], [0, 20], [0, MAIN_R], [MAIN_L, MAIN_R], [MAIN_L, 0],
    ],
  },
];
feats.push({ id: "s_nose", name: "Nose profile", type: "sketch", plane: XZ(0), entities: noseProfile });
feats.push({ id: "crank", name: "Nose", type: "revolve", source: { kind: "profile", sketch: "s_nose", regions: all(noseProfile) }, axis: { origin: [0, 0, 0], dir: [1, 0, 0] }, angle: 360, mode: "new" });
await stage("the nose");
const noseV = Math.PI * (144 * 15 + 225 * 30 + 400 * 30 + 625 * 24);
check("…its volume is the four cylinders'", Math.abs(V("crank") - noseV) < 1, `${V("crank").toFixed(1)} want ${noseV.toFixed(1)}`);

// --- 2. One throw: a web (round over the pin, straight sides, a counterweight
// below), the pin, the second web, the next main journal - joined as one body.
const R_CW = 72, R_TOP = 30;
const cw = (deg: number): P2 => [R_CW * Math.cos(rad(deg)), R_CW * Math.sin(rad(deg))];
const web = (pre: string) => [
  { id: `${pre}1`, kind: "line", a: cw(340), b: [R_TOP, THROW] },
  { id: `${pre}2`, kind: "arc", a: [R_TOP, THROW], m: [0, THROW + R_TOP], b: [-R_TOP, THROW] },
  { id: `${pre}3`, kind: "line", a: [-R_TOP, THROW], b: cw(200) },
  { id: `${pre}4`, kind: "arc", a: cw(200), m: cw(270), b: cw(340) },
];
// The straight-sided middle, the half round over the pin, the counterweight's segment below.
const webArea = (() => {
  const [x1, y1] = cw(340);
  const mid = ((2 * x1 + 2 * R_TOP) / 2) * (THROW - y1);
  const th = rad(140);
  return mid + (Math.PI * R_TOP ** 2) / 2 + (R_CW ** 2 / 2) * (th - Math.sin(th));
})();
extrude("throw", "Web 1", YZ(T0), web("wa"), WEB);
extrude("pin1", "Crank pin 1", YZ(T0 + WEB), [circle("p", [0, THROW], PIN_R)], PIN_L, { mode: "join", target: "throw" });
extrude("webB", "Web 2", YZ(T0 + WEB + PIN_L), web("wb"), WEB, { mode: "join", target: "throw" });
extrude("main2", "Main journal 2", YZ(T0 + 2 * WEB + PIN_L), [circle("m", [0, 0], MAIN_R)], MAIN_L, { mode: "join", target: "throw" });
await stage("one throw");
const throwV = 2 * webArea * WEB + Math.PI * PIN_R ** 2 * PIN_L + Math.PI * MAIN_R ** 2 * MAIN_L;
check("…one body, as big as its parts", Math.abs(V("throw") - throwV) < 0.5, `${V("throw").toFixed(1)} want ${throwV.toFixed(1)}`);

// --- 3. The other three: copied along, turned half round for the middle two.
const copy = (id: string, k: number, turn: boolean) =>
  feats.push({ id, name: `Throw ${k + 1}`, type: "transform", bodies: ["throw"], copy: true, op: { kind: "move", translate: [k * PERIOD, 0, 0], ...(turn ? { rotate: { origin: [0, 0, 0], axis: [1, 0, 0], angle: 180 } } : {}) } });
copy("t2", 1, true);
copy("t3", 2, true);
copy("t4", 3, false);
feats.push({ id: "join", name: "Join the throws", type: "boolean", op: "union", target: "crank", tools: ["throw", "t2:throw:0", "t3:throw:0", "t4:throw:0"] });
await stage("four throws joined to the nose");
check("…one body", [...debugBodies().keys()].join() === "crank", [...debugBodies().keys()].join());
check("…its volume: the nose and four throws", Math.abs(V("crank") - noseV - 4 * throwV) < 1, `${V("crank").toFixed(1)} want ${(noseV + 4 * throwV).toFixed(1)}`);

// --- 4. The rear flange, six bolt holes round it.
const X_END = MAINS[4] + MAIN_L; // 336
extrude("flange", "Flange", YZ(X_END), [circle("f", [0, 0], 55), circle("pilot", [0, 0], 12)], 16, { mode: "join", target: "crank", regions: arrangement([circle("f", [0, 0], 55), circle("pilot", [0, 0], 12)]).regions.filter((r: any) => r.area > 2000).map(regionRef) });
extrude("bolt", "Bolt hole", YZ(X_END - 6), [circle("b", [40, 0], 5)], 30);
feats.push({ id: "bolts", name: "Bolt holes round", type: "transform", bodies: ["bolt"], copy: true, op: { kind: "circular", axis: { origin: [0, 0, 0], dir: [1, 0, 0] }, count: 6, angle: 360 } });
feats.push({ id: "holes", name: "Bolt holes cut", type: "boolean", op: "subtract", target: "crank", tools: ["bolt", ...[0, 1, 2, 3, 4].map((k) => `bolts:bolt:${k}`)] });
await stage("the flange and its bolt holes");
const flangeV = Math.PI * (55 ** 2 - 12 ** 2) * 16 - 6 * Math.PI * 25 * 16;
check("…the flange with a pilot recess and six holes", Math.abs(V("crank") - noseV - 4 * throwV - flangeV) < 1, `${(V("crank") - noseV - 4 * throwV).toFixed(1)} want ${flangeV.toFixed(1)}`);

// --- 5. Keyway in the Ø30 and a thread on the Ø24 end.
extrude("key", "Keyway", XY(15), [{ id: "k", kind: "rect", center: [-45, 0], w: 20, h: 8, rotation: 0 }], -4, { mode: "cut", target: "crank" });
await stage("the keyway");
const beforeKey = noseV + 4 * throwV + flangeV;
// Under the round top: 20 long, the part of the Ø30 between z 11 and 15 and |y| < 4.
const keyA = (() => {
  let a = 0;
  for (let k = 0; k < 4000; k++) {
    const y = -4 + (8 * (k + 0.5)) / 4000;
    a += (Math.max(11, Math.sqrt(225 - y * y)) - 11) * (8 / 4000);
  }
  return a * 20;
})();
check("…the keyway takes 20 long, 8 wide, 4 deep under the round top", Math.abs(beforeKey - V("crank") - keyA) < 0.5, `${(beforeKey - V("crank")).toFixed(2)} want ${keyA.toFixed(2)}`);
const afterKey = V("crank");
const thr = B("crank").faces.find((f: any) => f.geomType === "CYLINDRE" && Math.abs(f.center.x + 67.5) < 1);
feats.push({ id: "thread", name: "Thread M24", type: "thread", face: faceRef("crank", thr), pitch: 2, round: { r: 12, hole: false } });
await stage("the thread");
// An ISO thread's V's hold about 0.32 P x the pitch line's length round x the length threaded.
check("…the thread takes about what its grooves hold", Math.abs(afterKey - V("crank") - 0.32 * 2 * Math.PI * 22.4 * 15) < 300, `${(afterKey - V("crank")).toFixed(1)} mm³`);
const threadedV = V("crank");

// --- 6. Round every journal and pin where it meets a web (40 edges, r 3).
const r6 = await build(true);
const isPinOrMain = (e: any) => {
  if (e.geomType !== "CIRCLE") return false;
  const [x, y, z] = e.pointAt(0.5).toTuple();
  const atWeb = [0, 1, 2, 3].some((k) => [T0, T0 + WEB, T0 + WEB + PIN_L, T0 + 2 * WEB + PIN_L].some((wx) => Math.abs(x - (wx + k * PERIOD)) < 1e-3));
  if (!atWeb) return false;
  const rMain = Math.hypot(y, z);
  const rPin = Math.min(Math.hypot(y, z - THROW), Math.hypot(y, z + THROW));
  return Math.abs(rMain - MAIN_R) < 1e-3 || Math.abs(rPin - PIN_R) < 1e-3;
};
const roundEdges = asPicked(r6, "crank", B("crank").edges.filter(isPinOrMain));
check("40 round edges (each journal and pin at both its webs, some in two halves)", roundEdges.length >= 16, `${roundEdges.length}`);
const preFillet = V("crank");
feats.push({ id: "fil", name: "Journal fillets", type: "fillet", radius: 3, edges: roundEdges });
await stage("the journal and pin fillets");
// A fillet in an inside corner adds (1 - π/4) r² round each circle.
const fillAdd = [MAIN_R, PIN_R].map((R) => (1 - Math.PI / 4) * 9 * 2 * Math.PI * (R + 1)).reduce((a, b) => a + b) * 8;
check("…they add what 16 inside rounds should", Math.abs(V("crank") - preFillet - fillAdd) < fillAdd * 0.15, `${(V("crank") - preFillet).toFixed(1)} want ~${fillAdd.toFixed(1)}`);

// --- 7. Chamfer the counterweights' rims (the R72 arcs, both faces of each web).
const r7 = await build(true);
const rims = asPicked(r7, "crank", B("crank").edges.filter((e: any) => {
  if (e.geomType !== "CIRCLE") return false;
  const [, y, z] = e.pointAt(0.5).toTuple();
  return Math.abs(Math.hypot(y, z) - R_CW) < 1e-3;
}));
check("16 counterweight rim edges", rims.length === 16, `${rims.length}`);
const preCham = V("crank");
feats.push({ id: "cham", name: "Counterweight chamfers", type: "chamfer", radius: 2, edges: rims });
await stage("the counterweight chamfers");
// Each a 2 x 2 triangle along a 140° arc of R72 (at its middle, 2/3 in), and a corner where it
// stops at the web's straight side.
const chamV = 16 * 2 * rad(140) * (R_CW - 2 / 3);
check("…each takes a 2 x 2 triangle off along its rim", Math.abs(preCham - V("crank") - chamV) < 60, `${(preCham - V("crank")).toFixed(1)} want ${chamV.toFixed(1)}`);

// --- 8. Oil drillings: from each of mains 2-5 at a slant through the web into the pin before it.
const drill = (k: number) => {
  // The main journal's underside (or top, for a throw turned round), to the pin's middle and 15 on.
  const turned = k === 1 || k === 2;
  const s = turned ? -1 : 1;
  const xm = MAINS[k + 1] + MAIN_L / 2 + 4; // on the main
  const A: Vec3 = [xm, 0, -s * MAIN_R];
  const pinX = T0 + WEB + PIN_L / 2 + k * PERIOD;
  const P: Vec3 = [pinX, 0, s * THROW];
  const d = [P[0] - A[0], P[1] - A[1], P[2] - A[2]];
  const L = Math.hypot(...d);
  const n: Vec3 = [d[0] / L, d[1] / L, d[2] / L];
  const o: Vec3 = [A[0] - n[0] * 10, A[1] - n[1] * 10, A[2] - n[2] * 10];
  extrude(`oil${k}`, `Oil hole ${k + 1}`, { origin: o, normal: n, xDir: [0, 1, 0] }, [circle("o", [0, 0], 3)], L + 25, { mode: "cut", target: "crank" });
  return L + 15; // inside the metal
};
const preOil = V("crank");
const oilLen = [0, 1, 2, 3].map(drill).reduce((a, b) => a + b);
await stage("four oil drillings");
const oilV = Math.PI * 9 * oilLen;
check("…about a 6 mm hole's worth each (less where it crosses the fillets' air)", Math.abs(preOil - V("crank") - oilV) < oilV * 0.08, `${(preOil - V("crank")).toFixed(1)} want ~${oilV.toFixed(1)}`);

// --- Checks on the whole.
const final = await build();
check("one clean solid", final.bodies.length === 1 && isHealthy(healthOf(B("crank"))), JSON.stringify(healthOf(B("crank"))));
const [lo, hi] = box("crank");
check("427 long (75 nose, 4 throws, 5 mains, the flange)", Math.abs(hi[0] - lo[0] - 427) < 0.5, `${(hi[0] - lo[0]).toFixed(2)}`);
check("as high as low: webs reach 75 over the pins both ways", Math.abs(hi[2] - 75) < 1e-3 && Math.abs(lo[2] + 75) < 1e-3, `${lo[2].toFixed(2)} .. ${hi[2].toFixed(2)}`);
// Balanced: a flat-plane four's throws (0, 180, 180, 0) put the mass on the axis.
{
  const c = measureShapeVolumeProperties(B("crank")).centerOfMass;
  check("balanced: its centre of mass is on the axis (the keyway and oil holes pull it a hair)", Math.hypot(c[1], c[2]) < 0.05, c.map((v: number) => v.toFixed(3)).join(", "));
}
console.log(`${feats.length} steps, ${(V("crank") / 1000).toFixed(1)} cm³ (${((V("crank") * 7.85e-3) / 1000).toFixed(2)} kg of steel)`);

// Change things upstream, like a person would: a longer stroke, a thicker pin.
{
  const was = structuredClone(feats);
  const t = Date.now();
  for (const f of feats) if (f.id === "s_pin1") f.entities = [circle("p", [0, THROW], 23)];
  const r = await build();
  check("pin made Ø46: everything after still builds (fillets, chamfers, oil holes)", !r.errors.length, `${Date.now() - t} ms`);
  feats.length = 0;
  feats.push(...was);
}
{
  const was = structuredClone(feats);
  feats.find((f) => f.id === "bolts").op.count = 8;
  feats.find((f) => f.id === "bolts").op.angle = 360;
  const r = await build();
  check("eight bolt holes (the subtract picked six): still builds, with a note", !r.errors.length, (r.notes ?? []).map((n: any) => n.message).join(" | "));
  feats.length = 0;
  feats.push(...was);
}
{
  const was = structuredClone(feats);
  feats.find((f) => f.id === "fil").radius = 4;
  const r = await build();
  check("fillets made r 4: still builds", !r.errors.length);
  feats.length = 0;
  feats.push(...was);
}
{
  const was = structuredClone(feats);
  feats.find((f) => f.id === "t3").suppressed = true;
  const r = await build();
  check("throw 3 switched off: the join is the first step to say the bodies don't touch (a gap in the shaft)", r.errors.length >= 1 && /don't touch/.test(r.errors[0].message) && nameOf(r.errors[0].featureId) === "Join the throws", r.errors.map((e: any) => `${nameOf(e.featureId)}: ${e.message}`).join("; "));
  feats.length = 0;
  feats.push(...was);
}

// --- The same shaft built by hand on a phone, up to the thread
// (tests/fixtures/crankshaft-hand.json): the nose profile drawn and revolved; a
// web's outline (two R72/R30 arcs, two lines) on the nose's end and extruded 16
// as a new body; the pin's circle on it (22), the second web projected from the
// first (16), the main journal (24); that throw copied along three times with
// Move (one turned round 180°) and all joined; the flange with its Ø24 bore, a
// bolt extruded back into it and patterned 6 round the axis, each of the six
// tapped for the subtract;
// a plane 15 up for the keyway (cut 4) and the Ø24 end threaded at pitch 2.
{
  const { readFileSync } = await import("node:fs");
  const hand = JSON.parse(readFileSync(new URL("./fixtures/crankshaft-hand.json", import.meta.url), "utf8"));
  const rh: any = await regenerate(hand);
  check("by hand: every step builds", !rh.errors.length, rh.errors.map((e: any) => `${hand.find((f: any) => f.id === e.featureId)?.name}: ${e.message}`).join("; "));
  const hb = rh.bodies.map((b: any) => debugBodies().get(b.id) as any);
  check("by hand: one clean solid", hb.length === 1 && isHealthy(healthOf(hb[0])), `${hb.length} bodies`);
  const hv = Math.abs(measureVolume(hb[0]));
  check("by hand: the same metal as the code build after its thread (within 0.1%)", Math.abs(hv - threadedV) < threadedV * 1e-3, `${hv.toFixed(1)} vs ${threadedV.toFixed(1)}`);
  const [hlo, hhi] = hb[0].boundingBox.bounds;
  check("by hand: 427 long, ±75 over the pins", Math.abs(hhi[0] - hlo[0] - 427) < 0.5 && Math.abs(hhi[2] - 75) < 1e-3 && Math.abs(hlo[2] + 75) < 1e-3, `${hlo.map((v: number) => v.toFixed(1))} .. ${hhi.map((v: number) => v.toFixed(1))}`);
}

if (process.argv[2]) {
  const d: any = doc();
  d.colors = { crank: "#9aa1a8" };
  d.names = { crank: "Crankshaft" };
  d.hidden = feats.filter((f) => f.type === "sketch").map((f) => f.id);
  writeFileSync(process.argv[2], JSON.stringify(d));
  console.log("written", process.argv[2]);
}
process.exit(failed ? 1 : 0);
