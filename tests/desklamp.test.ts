// Run: npx tsx tests/desklamp.test.ts [out.json] - a fully parametric,
// adjustable desk lamp (balanced-arm style), every size and every joint angle
// a variable. Built straight up (all joints in a line on Z), then turned at
// each joint by a Move/Rotate whose angle and pivot come from the variables:
// the head about the top joint, then the upper arm with the head about the
// elbow, then both arms about the shoulder, then everything above the base
// about Z (swivel). The joints are real forks: the turret's middle tab sits
// between the lower arm's two side plates, the upper arm between them at the
// elbow, and between the head's yoke at the top - so the parts can turn
// without running into each other. Changing a variable is one change: the
// lamp re-poses or resizes and stays whole.
import opencascade from "replicad-opencascadejs";
import { measureShapeVolumeProperties, measureVolume, setOC } from "replicad";
import { readFileSync, writeFileSync } from "node:fs";
import { debugBodies, regenerate } from "../src/kernel/engine";
import { healthOf, isHealthy } from "../src/kernel/repair";
import { arrangement, regionRef } from "../src/sketch/regions";
import { kindOfPath, resolveDoc } from "../src/doc/params";
import { evaluate, setVariables } from "../src/units";
import { nearestSnap } from "../src/sketch/snapPick";
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
const XZ = (y = 0): PlaneDef => ({ origin: [0, y, 0], normal: [0, -1, 0], xDir: [1, 0, 0] }); // u = x, v = z; extrudes towards -Y
const all = (es: any[]) => arrangement(es.filter((e) => !e.construction)).regions.map(regionRef);
const Y: Vec3 = [0, 1, 0];
const Z: Vec3 = [0, 0, 1];

const baseVars: [string, string][] = [
  ["baseR", "70 mm"], // base radius
  ["baseH", "16 mm"], // base height
  ["post", "40 mm"], // turret post above the base
  ["kR", "10 mm"], // joint (knuckle) radius
  ["arm1", "220 mm"], // shoulder to elbow
  ["arm2", "200 mm"], // elbow to head joint
  ["yokeL", "30 mm"], // head joint to the shade
  ["shadeL", "90 mm"], // shade length
  ["shadeR", "55 mm"], // shade mouth radius
  ["p1", "baseH + post + kR"], // shoulder height (straight up)
  ["p2", "p1 + arm1"], // elbow height
  ["p3", "p2 + arm2"], // head joint height
  ["swivel", "30"], // turn about Z, degrees
  ["a1", "20"], // shoulder: lower arm leans forward
  ["a2", "110"], // elbow: upper arm bends forward / down
  ["a3", "50"], // head: shade tips down
];
let variables = baseVars.map(([name, expr]) => ({ name, expr }));

const feats: any[] = [];
const doc = () => {
  const d: any = { format: "super", version: 2, name: "Desk lamp", features: structuredClone(feats), variables, views: [], units: "mm", hidden: [], pins: [], names: {} };
  const problems = resolveDoc(d);
  if (problems.length) console.log("problems:", problems);
  return d;
};
const errs = (r: any, fs: any[]) => r.errors.map((e: any) => `${fs.find((f: any) => f.id === e.featureId)?.name ?? e.featureId}: ${e.message}`).join("; ");
const build = async () => {
  const d = doc();
  const r: any = await regenerate(d.features);
  return { r, d };
};
const V = (b: string) => Math.abs(measureVolume(debugBodies().get(b)!));

// A dimension driven by an expression.
const dim = (curve: string, prop: string, value: number, expr?: string) => ({ id: id(), type: "dim", curves: [curve], prop, value, ...(expr ? { expr } : {}) });
const vert = (curve: string) => ({ id: id(), type: "vertical", curves: [curve] });
const on = (a: [string, string], b: [string, string]) => ({ id: id(), type: "coincident", pts: [{ e: a[0], p: a[1] }, { e: b[0], p: b[1] }] });

/**
 * A bar between two joints in an XZ sketch: up the Z axis from the origin to
 * `from` (construction, its length an expression), then the bar's own length
 * (construction): a round joint at each end it's asked for and a strip of
 * width `w` between them. Returns entities and constraints.
 */
function bar(from: [number, string], len: [number, string], w: number, ends: { bottom: boolean; top: boolean }, wExpr?: string) {
  const L0 = id();
  const L1 = id();
  const r = id();
  const es: any[] = [
    { id: L0, kind: "line", a: [0, 0], b: [0, from[0]], construction: true },
    { id: L1, kind: "line", a: [0, from[0]], b: [0, from[0] + len[0]], construction: true },
    { id: r, kind: "rect", center: [0, from[0] + len[0] / 2], w, h: len[0], rotation: 0 },
  ];
  const cs: any[] = [
    { id: id(), type: "fix", pts: [{ e: L0, p: "a" }], at: [0, 0] },
    vert(L0),
    vert(L1),
    on([L0, "b"], [L1, "a"]),
    dim(L0, "length", from[0], from[1]),
    dim(L1, "length", len[0], len[1]),
    { id: id(), type: "midpoint", pts: [{ e: r, p: "c" }], curves: [L1] },
    dim(r, "w", w, wExpr),
    dim(r, "h", len[0], len[1]),
  ];
  for (const [want, p] of [[ends.bottom, "a"], [ends.top, "b"]] as [boolean, string][]) {
    if (!want) continue;
    const c = id();
    es.push({ id: c, kind: "circle", center: [0, p === "a" ? from[0] : from[0] + len[0]], radius: 10 });
    cs.push(on([c, "c"], [L1, p]), dim(c, "radius", 10, "kR"));
  }
  return { es, cs };
}

// Numbers for the first build (the expressions are what count).
const P1 = 16 + 40 + 10;
const P2 = P1 + 220;
const P3 = P2 + 200;

// 1. Base: a disc, its top rim rounded.
const sBase = [{ id: "baseC", kind: "circle", center: [0, 0], radius: 70 }];
feats.push({ id: "sBase", name: "Base", type: "sketch", plane: XY(), entities: sBase, constraints: [{ id: id(), type: "fix", pts: [{ e: "baseC", p: "c" }], at: [0, 0] }, dim("baseC", "radius", 70, "baseR")] });
feats.push({ id: "base", name: "Base", type: "extrude", source: { kind: "profile", sketch: "sBase", regions: all(sBase) }, distance: 16, mode: "new", exprs: { distance: "baseH" } });
feats.push({ id: "baseRound", name: "Round the base", type: "fillet", edges: [{ body: "base", mid: [-70, 0, 16], dir: [0, 1, 0], length: 2 * Math.PI * 70 }], radius: 5 });

// 2. Turret: a post up from the base's top face (a sketch on that face, so it
//    follows the base's height), and the shoulder's middle tab on top of it.
const topFace = { body: "base", center: [0, 0, 16] as Vec3, normal: Z, area: Math.PI * 70 * 70 };
const sPost = [{ id: "postC", kind: "circle", center: [0, 0], radius: 12 }];
feats.push({ id: "sPost", name: "Post", type: "sketch", plane: XY(16), attachedTo: topFace, entities: sPost });
feats.push({ id: "turret", name: "Post", type: "extrude", source: { kind: "profile", sketch: "sPost", regions: all(sPost) }, distance: 40, mode: "new", exprs: { distance: "post" } });
const tab = bar([56, "baseH + post"], [10, "kR"], 20, { bottom: false, top: true }, "2*kR");
feats.push({ id: "sTab", name: "Shoulder tab", type: "sketch", plane: XZ(4), entities: tab.es, constraints: tab.cs });
feats.push({ id: "tab", name: "Shoulder tab", type: "extrude", source: { kind: "profile", sketch: "sTab", regions: all(tab.es) }, distance: 8, mode: "join", target: "turret" });

// 3. Lower arm: two side plates (y 5..9 and -9..-5), round at both joints.
const a1 = bar([P1, "p1"], [220, "arm1"], 12, { bottom: true, top: true });
feats.push({ id: "sArm1", name: "Lower arm", type: "sketch", plane: XZ(9), entities: a1.es, constraints: a1.cs });
feats.push({ id: "arm1", name: "Lower arm", type: "extrude", source: { kind: "profile", sketch: "sArm1", regions: all(a1.es) }, distance: 4, mode: "new" });
feats.push({ id: "arm1M", name: "Lower arm, other side", type: "transform", bodies: ["arm1"], copy: true, op: { kind: "mirror", plane: XZ(0) } });
// …tied across with a rung near the elbow (the two plates are one part).
const rung = bar([P1 + 150, "p1 + arm1 - 70 mm"], [12, "12 mm"], 12, { bottom: false, top: false });
feats.push({ id: "sRung", name: "Rung", type: "sketch", plane: XZ(9), entities: rung.es, constraints: rung.cs });
feats.push({ id: "rung", name: "Rung", type: "extrude", source: { kind: "profile", sketch: "sRung", regions: all(rung.es) }, distance: 18, mode: "join", target: "arm1" });
feats.push({ id: "arm1J", name: "Lower arm in one", type: "boolean", op: "union", target: "arm1", tools: ["arm1M:arm1:0"] });

// 4. Upper arm: one bar in the middle (y -4..4), round at both joints.
const a2 = bar([P2, "p2"], [200, "arm2"], 12, { bottom: true, top: true });
feats.push({ id: "sArm2", name: "Upper arm", type: "sketch", plane: XZ(4), entities: a2.es, constraints: a2.cs });
feats.push({ id: "arm2", name: "Upper arm", type: "extrude", source: { kind: "profile", sketch: "sArm2", regions: all(a2.es) }, distance: 8, mode: "new" });

// 5. Head: a yoke (two plates round the head joint, a bridge across their
//    top), then the shade: a flaring cone from the bridge (Extrude with
//    Taper), hollowed open at the mouth (Shell).
const yk = bar([P3, "p3"], [30, "yokeL"], 20, { bottom: true, top: false }, "2*kR");
feats.push({ id: "sYoke", name: "Yoke", type: "sketch", plane: XZ(9), entities: yk.es, constraints: yk.cs });
feats.push({ id: "head", name: "Yoke", type: "extrude", source: { kind: "profile", sketch: "sYoke", regions: all(yk.es) }, distance: 4, mode: "new" });
feats.push({ id: "headM", name: "Yoke, other side", type: "transform", bodies: ["head"], copy: true, op: { kind: "mirror", plane: XZ(0) } });
const br = bar([P3 + 24, "p3 + yokeL - 6 mm"], [6, "6 mm"], 20, { bottom: false, top: false }, "2*kR");
feats.push({ id: "sBridge", name: "Yoke bridge", type: "sketch", plane: XZ(9), entities: br.es, constraints: br.cs });
feats.push({ id: "bridge", name: "Yoke bridge", type: "extrude", source: { kind: "profile", sketch: "sBridge", regions: all(br.es) }, distance: 18, mode: "join", target: "head" });
feats.push({ id: "headJ", name: "Yoke in one", type: "boolean", op: "union", target: "head", tools: ["headM:head:0"] });
const bridgeTop = { body: "head", center: [0, 0, P3 + 30] as Vec3, normal: Z, area: 20 * 18 };
const sNeck = [{ id: "neckC", kind: "circle", center: [0, 0], radius: 16 }];
feats.push({ id: "sShade", name: "Shade", type: "sketch", plane: XY(P3 + 30), attachedTo: bridgeTop, entities: sNeck });
// (The face's own outline splits the circle: both pieces are the shade - as
// the app shows them, the face's edges as the sketch has them.)
const faceEdge = ((await regenerate(doc().features)) as any).sketchBoundaries.sShade ?? [];
check("the shade's sketch sits on the yoke's whole top (one face, 20 × 18)", faceEdge.length === 4, `${faceEdge.length} edges`);
feats.push({ id: "shade", name: "Shade", type: "extrude", source: { kind: "profile", sketch: "sShade", regions: all([...sNeck, ...faceEdge]) }, distance: 90, mode: "new", taper: 55 / 16, exprs: { distance: "shadeL", taper: "shadeR / 16 mm" } });
const mouth = { body: "shade", center: [0, 0, P3 + 120] as Vec3, normal: Z, area: Math.PI * 55 * 55 };
feats.push({ id: "hollow", name: "Hollow the shade", type: "shell", body: "shade", faces: [mouth], thickness: 2 });
feats.push({ id: "headS", name: "Shade on the yoke", type: "boolean", op: "union", target: "head", tools: ["shade"] });

// 6. The joints turn: head, then elbow, then shoulder, then the swivel.
const turn = (fid: string, name: string, bodies: string[], at: number, atExpr: string, angle: string, axis = Y) => ({
  id: fid,
  name,
  type: "transform",
  bodies,
  copy: false,
  op: { kind: "move", translate: [0, 0, 0], rotate: { origin: [0, 0, at], axis, angle: 0 } },
  exprs: { "op.rotate.angle": angle, ...(atExpr ? { "op.rotate.origin.2": atExpr } : {}) },
});
feats.push(turn("tHead", "Tip the head", ["head"], P3, "p3", "a3"));
feats.push(turn("tElbow", "Bend the elbow", ["arm2", "head"], P2, "p2", "a2"));
feats.push(turn("tShoulder", "Lean the arm", ["arm1", "arm2", "head"], P1, "p1", "a1"));
feats.push(turn("tSwivel", "Swivel", ["turret", "arm1", "arm2", "head"], 0, "", "swivel", Z));

const PARTS = ["base", "turret", "arm1", "arm2", "head"];
const deg = Math.PI / 180;

/** Where the joints and the shade's mouth should be, from the variables (forward kinematics). */
function pose(v: Record<string, number>) {
  const p1 = v.baseH + v.post + v.kR;
  const s = v.swivel * deg;
  const out = (r: number, z: number): Vec3 => [r * Math.cos(s), r * Math.sin(s), z];
  const t1 = v.a1 * deg;
  const t2 = t1 + v.a2 * deg;
  const t3 = t2 + v.a3 * deg;
  const e = [v.arm1 * Math.sin(t1), p1 + v.arm1 * Math.cos(t1)];
  const h = [e[0] + v.arm2 * Math.sin(t2), e[1] + v.arm2 * Math.cos(t2)];
  const reach = v.yokeL + v.shadeL;
  const m = [h[0] + reach * Math.sin(t3), h[1] + reach * Math.cos(t3)];
  return { shoulder: out(0, p1), elbow: out(e[0], e[1]), head: out(h[0], h[1]), mouth: out(m[0], m[1]), dir: [Math.sin(t3) * Math.cos(s), Math.sin(t3) * Math.sin(s), Math.cos(t3)] as Vec3 };
}
const values = () => {
  const d = doc();
  const o: Record<string, number> = {};
  const lens = new Set(["baseR", "baseH", "post", "kR", "arm1", "arm2", "yokeL", "shadeL", "shadeR"]);
  for (const v of variables) if (!/^p\d$/.test(v.name)) o[v.name] = lens.has(v.name) ? parseFloat(v.expr) : parseFloat(v.expr);
  void d;
  return o;
};

/** The shade's mouth: the round edge on the head of radius shadeR (centre and the way it faces). */
function mouthOf(shadeR: number, id = "head"): Vec3 | null {
  const head = debugBodies().get(id) as any;
  let best: Vec3 | null = null;
  for (const e of head.edges) {
    if (e.geomType !== "CIRCLE") continue;
    const a = e.pointAt(0).toTuple();
    const b = e.pointAt(0.5).toTuple();
    const c: Vec3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    const r = Math.hypot(a[0] - c[0], a[1] - c[1], a[2] - c[2]);
    if (Math.abs(r - shadeR) < 0.05) best = c;
  }
  return best;
}
const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const inter = (a: string, b: string) => Math.abs(measureVolume((debugBodies().get(a) as any).intersect(debugBodies().get(b))));
function clashes(): string[] {
  const out: string[] = [];
  for (let i = 0; i < PARTS.length; i++)
    for (let j = i + 1; j < PARTS.length; j++) {
      const v = inter(PARTS[i], PARTS[j]);
      if (v > 0.01) out.push(`${PARTS[i]}/${PARTS[j]} ${v.toFixed(2)} mm³`);
    }
  return out;
}

// --------------------------------------------------------------- the build
const t0 = performance.now();
const { r } = await build();
const ms = performance.now() - t0;
check("every step builds", !r.errors.length, errs(r, feats));
check("five parts: base, turret, lower arm, upper arm, head", r.bodies.length === 5 && PARTS.every((p) => debugBodies().has(p)), r.bodies.map((b: any) => b.id).join(", "));
check("…each a clean solid", PARTS.every((p) => isHealthy(healthOf(debugBodies().get(p)!))), PARTS.filter((p) => !isHealthy(healthOf(debugBodies().get(p)!))).join(", "));
check("…built in reasonable time", ms < 20000, `${Math.round(ms)} ms`);
const v0 = values();
const want = pose(v0);
const m0 = mouthOf(55);
check("the shade's mouth is where the joint angles put it", !!m0 && dist(m0, want.mouth) < 0.05, m0 ? `${m0.map((x) => x.toFixed(2)).join(", ")} / ${want.mouth.map((x) => x.toFixed(2)).join(", ")}` : "no mouth edge");
check("no two parts run into each other (forks at every joint)", !clashes().length, clashes().join("; "));
const lo = (debugBodies().get("head") as any).boundingBox.bounds[0][2];
check("the shade clears the desk", lo > 1, `lowest point z ${lo.toFixed(1)}`);
// Stable: the centre of mass (same material all through) over the base.
{
  let m = 0;
  const c = [0, 0, 0];
  for (const p of PARTS) {
    const pr = measureShapeVolumeProperties(debugBodies().get(p)!);
    const cm = pr.centerOfMass;
    m += pr.volume;
    for (let k = 0; k < 3; k++) c[k] += cm[k] * pr.volume;
    pr.delete?.();
  }
  const cx = c[0] / m;
  const cy = c[1] / m;
  check("it doesn't tip over: the centre of mass is over the base", Math.hypot(cx, cy) < 70 - 5, `${Math.hypot(cx, cy).toFixed(1)} mm from the middle (base radius 70)`);
}
check("the shade is hollow (2 mm wall, open at the mouth)", V("head") < Math.PI * 90 * (16 * 16 + 16 * 55 + 55 * 55) / 3 * 0.3, `${(V("head") / 1000).toFixed(1)} cm³`);
const codeV = new Map(PARTS.map((p) => [p, V(p)]));
const lo3 = [0, 1, 2].map((k) => Math.min(...PARTS.map((p) => (debugBodies().get(p) as any).boundingBox.bounds[0][k])));
const hi3 = [0, 1, 2].map((k) => Math.max(...PARTS.map((p) => (debugBodies().get(p) as any).boundingBox.bounds[1][k])));
console.log("     size", [0, 1, 2].map((k) => (hi3[k] - lo3[k]).toFixed(1)).join(" × "), "mm; volumes", PARTS.map((p) => `${p} ${(codeV.get(p)! / 1000).toFixed(2)}`).join(", "), "cm³");

// ------------------------------------------------- one change each: re-pose / resize
async function withVars(set: Record<string, string>, label: string, more: (v: Record<string, number>) => void = () => {}) {
  const keep = variables;
  variables = baseVars.map(([name, expr]) => ({ name, expr: set[name] ?? expr }));
  const { r: r2 } = await build();
  const v = values();
  const w = pose(v);
  const m = mouthOf(v.shadeR);
  check(`${label}: builds`, !r2.errors.length && r2.bodies.length === 5, errs(r2, feats));
  if (!r2.errors.length) {
    check(`${label}: the mouth moves with it`, !!m && dist(m, w.mouth) < 0.05, m ? `${dist(m, w.mouth).toFixed(3)} mm off` : "no mouth edge");
    check(`${label}: no parts run into each other`, !clashes().length, clashes().join("; "));
    more(v);
  }
  variables = keep;
}
await withVars({ a1: "0", a2: "0", a3: "0", swivel: "0" }, "straight up", (v) => {
  const top = Math.max(...PARTS.map((p) => (debugBodies().get(p) as any).boundingBox.bounds[1][2]));
  check("straight up: as tall as the parts add up", Math.abs(top - (v.baseH + v.post + v.kR + v.arm1 + v.arm2 + v.yokeL + v.shadeL)) < 0.05, `${top.toFixed(2)} mm`);
});
await withVars({ a1: "35", a2: "80", a3: "20" }, "reaching out");
await withVars({ a1: "-15", a2: "140", a3: "60", swivel: "-90" }, "leaning back, turned");
await withVars({ arm1: "260 mm", arm2: "160 mm" }, "longer lower arm, shorter upper arm");
await withVars({ baseR: "90 mm", baseH: "22 mm", post: "30 mm" }, "bigger, taller base", () => {
  const b = (debugBodies().get("base") as any).boundingBox.bounds;
  check("bigger base: 180 across, 22 tall, rim still rounded", Math.abs(b[1][0] - b[0][0] - 180) < 0.05 && Math.abs(b[1][2] - 22) < 0.05 && (debugBodies().get("base") as any).faces.length > 3, `${(b[1][0] - b[0][0]).toFixed(2)} × ${b[1][2].toFixed(2)}`);
});
await withVars({ shadeR: "70 mm", shadeL: "110 mm", kR: "12 mm" }, "bigger shade, fatter joints");

// Twelve random lamps (seeded): sizes and angles anywhere in a sensible range,
// each one change of the variables - every one builds, poses right, no clashes.
{
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const pick = (a: number, b: number) => Math.round(a + (b - a) * rnd());
  for (let i = 0; i < 12; i++) {
    const set = {
      arm1: `${pick(150, 300)} mm`,
      arm2: `${pick(150, 260)} mm`,
      shadeR: `${pick(40, 70)} mm`,
      shadeL: `${pick(70, 120)} mm`,
      baseR: `${pick(60, 100)} mm`,
      a1: `${pick(-20, 40)}`,
      a2: `${pick(60, 140)}`,
      a3: `${pick(0, 80)}`,
      swivel: `${pick(-180, 180)}`,
    };
    await withVars(set, `random lamp ${i + 1} (${Object.values(set).join(", ")})`);
  }
}

if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify({ ...doc(), hidden: feats.filter((f) => f.type === "sketch").map((f) => f.id), colors: { base: "#3a3f47", turret: "#3a3f47", arm1: "#c8ccd2", arm2: "#c8ccd2", head: "#2f6f8f" } }));

// The hand build (tests/fixtures/desklamp-hand.json: built on a phone-sized
// screen, tapping and typing - sketches dimensioned with the variables, planes
// offset from XZ, mirror copies joined, the turns made with Rotate Around Axis
// on the joints' round edges, their angle and pivot height typed as variables):
// the same parts as by code, and the same after the variables change.
{
  const hand = JSON.parse(readFileSync(new URL("./fixtures/desklamp-hand.json", import.meta.url), "utf8"));
  const HAND: Record<string, string> = {
    base: "extrude-mw6z9bsk-dfvp",
    turret: "extrude-mw6zam0z-zbru",
    arm1: "extrude-mw6zldl8-77ke",
    arm2: "extrude-mw6zp54w-vwb2",
    head: "transform-mw6zpz65-gpm1:extrude-mw6zpv4o-7q9b:0",
  };
  const compare = async (set: Record<string, string>, label: string) => {
    const vars = baseVars.map(([name, expr]) => ({ name, expr: set[name] ?? expr }));
    // The code build, with these variables.
    const keep = variables;
    variables = vars;
    const { r: rc } = await build();
    const cv = new Map(PARTS.map((p) => [p, V(p)]));
    const v = values();
    const cm = mouthOf(v.shadeR);
    variables = keep;
    // The hand build, with the same.
    const d = structuredClone(hand);
    d.variables = vars;
    const problems = resolveDoc(d);
    const rh: any = await regenerate(d.features);
    const ok = !problems.length && !rh.errors.length && rh.bodies.length === 5 && PARTS.every((p) => debugBodies().has(HAND[p]));
    check(`hand build, ${label}: builds, five parts`, ok && !rc.errors.length, [...problems, errs(rh, d.features)].join("; ") || rh.bodies.map((b: any) => b.id).join(", "));
    if (!ok) return;
    const off = PARTS.map((p) => ({ p, rel: Math.abs(V(HAND[p]) - cv.get(p)!) / cv.get(p)! })).filter((x) => x.rel > 0.001);
    check(`hand build, ${label}: every part the same as by code (volume within 0.1 %)`, !off.length, off.map((x) => `${x.p} ${(x.rel * 100).toFixed(2)} %`).join(", ") || PARTS.map((p) => `${p} ${(V(HAND[p]) / 1000).toFixed(2)}`).join(", "));
    const hm = mouthOf(v.shadeR, HAND.head);
    check(`hand build, ${label}: the shade's mouth in the same place`, !!hm && !!cm && dist(hm, cm) < 0.05, hm && cm ? `${dist(hm, cm).toFixed(3)} mm apart` : "no mouth edge");
  };
  await compare({}, "as drawn");
  await compare({ a1: "0", a2: "0", a3: "0", swivel: "0" }, "straight up");
  await compare({ arm1: "260 mm", arm2: "160 mm", a2: "90" }, "longer lower arm, shorter upper arm");
  await compare({ baseR: "90 mm", baseH: "22 mm", post: "30 mm", kR: "12 mm" }, "bigger base, fatter joints");
  await compare({ shadeR: "70 mm", shadeL: "110 mm", a3: "30", swivel: "-120" }, "bigger shade, turned");
}

// What the hand build turned up, fixed in the app (the screen parts are checked
// by hand; these are the parts underneath them).
{
  // A turn's pivot is a length (only its angle an angle): "p3" as its height.
  check("a turn's pivot height is a length, its angle an angle", kindOfPath("op.rotate.origin.2") === "length" && kindOfPath("op.rotate.angle") === "angle");
  // The taper is a plain ratio; with variables that have units it can still use them.
  setVariables(variables);
  check("the taper is a plain number", kindOfPath("taper") === "number");
  const pct = evaluate("shadeR / 16 mm * 100", "number");
  check("a plain-number field takes variables with units (the shade's flare, in %)", pct !== null && Math.abs(pct - 343.75) < 1e-9, String(pct));
  check("…and a length typed in one counts in mm", evaluate("2 cm / 5 mm", "number") === 4, String(evaluate("2 cm / 5 mm", "number")));
  // Snapping: a line's end and a rectangle side's middle on one spot - the line's end (it can be kept on) wins.
  const side = { label: "Midpoint", d: 0.2 };
  const end = { label: "Endpoint", d: 0.3, ref: { e: "L1", p: "b" } };
  check("on one spot, the snap point a circle can be kept on wins", nearestSnap([side, end], 8)?.label === "Endpoint" && nearestSnap([end, side], 8)?.label === "Endpoint");
  check("…but a clearly nearer one still wins", nearestSnap([{ label: "near", d: 1 }, { ...end, d: 4 }], 8)?.label === "near");
  check("…and nothing out of reach", nearestSnap([{ label: "far", d: 9 }], 8) === null);
}

console.log(failed ? `${failed} FAILED` : "all passed");
process.exit(failed ? 1 : 0);
