// Run: npx tsx tests/window.test.ts [out.json] - a parametric window for a
// passive house, every size a variable. Drawn on XZ (width along X, height
// along Z), its depth along Y: the outside face at y = 0, the room at -D.
//
// - Frame: a ring D deep with an insulation core sealed inside it (a pocket
//   cut, the core filling it), and a rebate from the room side the sash sits in.
// - Sash: a ring overlapping the frame's opening by R, a glazing groove round
//   its inner edge.
// - Triple glazing: three panes g thick, two warm-edge spacers in the cavities.
// - A seal between the sash and the rebate's step.
// - Sill outside: sloped to shed water, with a drip under its front.
// - Handle on the room side.
//
// Changing a variable is one change: the window resizes and stays whole, no
// two parts running into each other, the glass held in its groove all round.
import opencascade from "replicad-opencascadejs";
import { measureDistanceBetween, measureVolume, setOC } from "replicad";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { debugBodies, regenerate } from "../src/kernel/engine";
import { healthOf, isHealthy } from "../src/kernel/repair";
import { arrangement, regionRef } from "../src/sketch/regions";
import { resolveDoc } from "../src/doc/params";
import { evaluate, setVariables } from "../src/units";
import type { PlaneDef } from "../src/doc/types";

setOC(await (opencascade as unknown as () => Promise<any>)());
let failed = 0;
const check = (name: string, ok: boolean, info = "") => {
  if (!ok) failed++;
  console.log(ok ? "ok  " : "FAIL", name, info);
};

let n = 0;
const id = () => `e${n++}`;
const XZ = (y = 0): PlaneDef => ({ origin: [0, y, 0], normal: [0, -1, 0], xDir: [1, 0, 0] }); // u = x, v = z; extrudes towards -Y
const YZ = (x = 0): PlaneDef => ({ origin: [x, 0, 0], normal: [1, 0, 0], xDir: [0, 1, 0] }); // u = y, v = z; extrudes towards +X

const baseVars: [string, string][] = [
  ["W", "1230 mm"], // frame, outside width
  ["H", "1480 mm"], // frame, outside height
  ["D", "120 mm"], // frame depth
  ["F", "80 mm"], // frame face width
  ["R", "20 mm"], // sash overlaps the frame's opening by this
  ["c", "4 mm"], // air round the sash, in the rebate
  ["S", "70 mm"], // sash face width
  ["SD", "92 mm"], // rebate depth (sash + seal)
  ["sl", "5 mm"], // seal thickness
  ["g", "4 mm"], // a pane
  ["cav", "20 mm"], // a cavity between panes
  ["G", "3*g + 2*cav"], // the glazing unit
  ["e", "15 mm"], // glass edge in the groove
  ["gap", "5 mm"], // air round the glass edge
  ["sp", "12 mm"], // warm-edge spacer width
  ["ins", "15 mm"], // frame wall round the insulation core
  ["ov", "40 mm"], // sill past the frame each side
  ["Ws", "W - 2*F + 2*R"], // sash, outside
  ["Hs", "H - 2*F + 2*R"],
  ["Wg", "Ws - 2*S + 2*e"], // glass
  ["Hg", "Hs - 2*S + 2*e"],
  ["yG", "-D + (SD - sl + G)/2"], // the glass's outside face (the unit in the sash's middle)
];
let variables = baseVars.map(([name, expr]) => ({ name, expr }));

const feats: any[] = [];
const doc = () => {
  const d: any = { format: "super", version: 2, name: "Passive window", features: structuredClone(feats), variables, views: [], units: "mm", hidden: [], pins: [], names: {} };
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
const body = (b: string) => debugBodies().get(b) as any;
const V = (b: string) => Math.abs(measureVolume(debugBodies().get(b)!));
/** The variables' values now (lengths in mm). */
const values = () => {
  setVariables(variables);
  const o: Record<string, number> = {};
  for (const v of variables) o[v.name] = evaluate(v.name, "length")!;
  return o;
};

// --- sketch helpers: rectangles centred on the origin, sized by expressions.
const fixC = (r: string) => ({ id: id(), type: "fix", pts: [{ e: r, p: "c" }], at: [0, 0] });
const dim = (curve: string, prop: string, value: number, expr: string) => ({ id: id(), type: "dim", curves: [curve], prop, value, expr });
/** Concentric rectangles (w, h as numbers for the first draw, and as expressions). */
function rings(rs: [number, number, string, string][]) {
  const es: any[] = [];
  const cs: any[] = [];
  for (const [w, h, we, he] of rs) {
    const r = id();
    es.push({ id: r, kind: "rect", center: [0, 0], w, h, rotation: 0 });
    cs.push(fixC(r), dim(r, "w", w, we), dim(r, "h", h, he));
  }
  return { es, cs };
}
const regions = (es: any[]) => arrangement(es.filter((e) => !e.construction)).regions.map(regionRef);
/** The ring between two rectangles (outlined by both). */
const ring = (es: any[]) => regions(es).filter((r) => r.k?.length === 2);
/** The inside of the one rectangle. */
const whole = (es: any[]) => regions(es);
const sketch = (sid: string, name: string, plane: PlaneDef, s: { es: any[]; cs: any[] }, exprs?: Record<string, string>) =>
  feats.push({ id: sid, name, type: "sketch", plane, entities: s.es, constraints: s.cs, ...(exprs ? { exprs } : {}) });
const extrude = (fid: string, name: string, sk: string, regs: any[], distance: number, mode: string, more: Record<string, unknown> = {}) =>
  feats.push({ id: fid, name, type: "extrude", source: { kind: "profile", sketch: sk, regions: regs }, distance, mode, ...more });

// Numbers for the first draw (the expressions are what count).
const v0 = values();
const { W, H, D, F, R, c, S, SD, sl, g, cav, G, e, gap, sp, ins, Ws, Hs, Wg, Hg, yG } = v0;

// 1. Frame: the ring, D deep from the outside face.
const sFrame = rings([
  [W, H, "W", "H"],
  [W - 2 * F, H - 2 * F, "W - 2*F", "H - 2*F"],
]);
sketch("sFrame", "Frame", XZ(0), sFrame);
extrude("frame", "Frame", "sFrame", ring(sFrame.es), D, "new", { exprs: { distance: "D" } });

// 2. The rebate, from the room side SD deep: out to the sash's size and the air round it
//    (the inner rectangle well inside the opening, so the cut has no faces to share).
const sReb = rings([
  [Ws + 2 * c, Hs + 2 * c, "Ws + 2*c", "Hs + 2*c"],
  [W - 2 * F - 40, H - 2 * F - 40, "W - 2*F - 40 mm", "H - 2*F - 40 mm"],
]);
sketch("sReb", "Rebate", XZ(-D + SD), sReb, { "plane.origin.1": "-D + SD" });
extrude("reb", "Rebate", "sReb", ring(sReb.es), SD, "cut", { target: "frame", exprs: { distance: "SD" } });

// 3. Insulation: a pocket in the frame's outer part, ins from every face, and the core in it.
const sCore = rings([
  [W - 2 * ins, H - 2 * ins, "W - 2*ins", "H - 2*ins"],
  [Ws + 2 * c + 2 * ins, Hs + 2 * c + 2 * ins, "Ws + 2*c + 2*ins", "Hs + 2*c + 2*ins"],
]);
sketch("sCore", "Insulation", XZ(-ins), sCore, { "plane.origin.1": "-ins" });
extrude("pocket", "Insulation pocket", "sCore", ring(sCore.es), D - 2 * ins, "cut", { target: "frame", exprs: { distance: "D - 2*ins" } });
extrude("core", "Insulation core", "sCore", ring(sCore.es), D - 2 * ins, "new", { exprs: { distance: "D - 2*ins" } });

// 4. Seal on the rebate's step, in the overlap (4 mm in from each side of it).
const sSeal = rings([
  [Ws - 8, Hs - 8, "Ws - 8 mm", "Hs - 8 mm"],
  [W - 2 * F + 8, H - 2 * F + 8, "W - 2*F + 8 mm", "H - 2*F + 8 mm"],
]);
sketch("sSeal", "Seal", XZ(-D + SD), sSeal, { "plane.origin.1": "-D + SD" });
extrude("seal", "Seal", "sSeal", ring(sSeal.es), sl, "new", { exprs: { distance: "sl" } });

// 5. Sash: from the seal to the room-side face.
const sSash = rings([
  [Ws, Hs, "Ws", "Hs"],
  [Ws - 2 * S, Hs - 2 * S, "Ws - 2*S", "Hs - 2*S"],
]);
sketch("sSash", "Sash", XZ(-D + SD - sl), sSash, { "plane.origin.1": "-D + SD - sl" });
extrude("sash", "Sash", "sSash", ring(sSash.es), SD - sl, "new", { exprs: { distance: "SD - sl" } });
// …its glazing groove: the glass and the air round it, 3 mm more each way in depth.
const sGroove = rings([
  [Wg + 2 * gap, Hg + 2 * gap, "Wg + 2*gap", "Hg + 2*gap"],
  [Ws - 2 * S - 40, Hs - 2 * S - 40, "Ws - 2*S - 40 mm", "Hs - 2*S - 40 mm"],
]);
sketch("sGroove", "Glazing groove", XZ(yG + 3), sGroove, { "plane.origin.1": "yG + 3 mm" });
extrude("groove", "Glazing groove", "sGroove", ring(sGroove.es), G + 6, "cut", { target: "sash", exprs: { distance: "G + 6 mm" } });

// 6. Glass: a pane, copied twice a pane and a cavity further in.
const sPane = rings([[Wg, Hg, "Wg", "Hg"]]);
sketch("sPane", "Glass", XZ(yG), sPane, { "plane.origin.1": "yG" });
extrude("pane1", "Outer pane", "sPane", whole(sPane.es), g, "new", { exprs: { distance: "g" } });
const copy = (fid: string, name: string, b: string, dy: number, expr: string) =>
  feats.push({ id: fid, name, type: "transform", bodies: [b], copy: true, op: { kind: "move", translate: [0, dy, 0] }, exprs: { "op.translate.1": expr } });
copy("pane2", "Middle pane", "pane1", -(g + cav), "-(g + cav)");
copy("pane3", "Inner pane", "pane1", -2 * (g + cav), "-2*(g + cav)");
// …and the spacers between them.
const sSpacer = rings([
  [Wg, Hg, "Wg", "Hg"],
  [Wg - 2 * sp, Hg - 2 * sp, "Wg - 2*sp", "Hg - 2*sp"],
]);
sketch("sSpacer", "Spacer", XZ(yG - g), sSpacer, { "plane.origin.1": "yG - g" });
extrude("spacer1", "Outer spacer", "sSpacer", ring(sSpacer.es), cav, "new", { exprs: { distance: "cav" } });
copy("spacer2", "Inner spacer", "spacer1", -(g + cav), "-(g + cav)");

// 7. Sill, outside under the frame: flat under it 30 mm, then sloping out 70 mm,
//    its front 40 mm deep, and a drip groove under the front.
const sill = { es: [{ id: "sillP", kind: "polyline", closed: true, points: [[-30, 0], [0, 0], [70, -12], [70, -40], [-30, -40]] }], cs: [] };
sketch("sSill", "Sill", { ...YZ(0), origin: [0, 0, -H / 2] }, sill, { "plane.origin.2": "-H/2" });
extrude("sill", "Sill", "sSill", whole(sill.es), W / 2 + 40, "new", { symmetric: true, exprs: { distance: "W/2 + ov" } });
const drip = { es: [{ id: "dripR", kind: "rect", center: [58, -37], w: 6, h: 6, rotation: 0 }], cs: [] };
sketch("sDrip", "Drip", { ...YZ(0), origin: [0, 0, -H / 2] }, drip, { "plane.origin.2": "-H/2" });
extrude("drip", "Drip", "sDrip", whole(drip.es), W / 2 + 40, "cut", { target: "sill", symmetric: true, exprs: { distance: "W/2 + ov" } });

// 8. Handle on the room side, in the middle of the sash's right side: a rosette and a lever down.
const hx = Ws / 2 - S / 2;
const sRos = { es: [{ id: "rosC", kind: "circle", center: [0, 0], radius: 20 }], cs: [] };
sketch("sRos", "Handle", { ...XZ(-D), origin: [hx, -D, 0] }, sRos, { "plane.origin.0": "Ws/2 - S/2", "plane.origin.1": "-D" });
extrude("handle", "Handle", "sRos", whole(sRos.es), 12, "new");
const sLever = { es: [{ id: "levR", kind: "rect", center: [0, -50], w: 22, h: 130, rotation: 0 }], cs: [] };
sketch("sLever", "Lever", { ...XZ(-D - 12), origin: [hx, -D - 12, 0] }, sLever, { "plane.origin.0": "Ws/2 - S/2", "plane.origin.1": "-D - 12 mm" });
extrude("lever", "Lever", "sLever", whole(sLever.es), 14, "join", { target: "handle" });

const PARTS = ["frame", "core", "seal", "sash", "pane1", "pane2:pane1:0", "pane3:pane1:0", "spacer1", "spacer2:spacer1:0", "sill", "handle"];
const NAME: Record<string, string> = { "pane2:pane1:0": "pane2", "pane3:pane1:0": "pane3", "spacer2:spacer1:0": "spacer2" };
const nm = (p: string) => NAME[p] ?? p;

/** What each part's volume should be, from the variables. */
function expected(v: Record<string, number>): Record<string, number> {
  const box = (w: number, h: number) => w * h;
  const opening = box(v.W - 2 * v.F, v.H - 2 * v.F);
  const rebate = box(v.Ws + 2 * v.c, v.Hs + 2 * v.c) - opening;
  const coreA = box(v.W - 2 * v.ins, v.H - 2 * v.ins) - box(v.Ws + 2 * v.c + 2 * v.ins, v.Hs + 2 * v.c + 2 * v.ins);
  const core = coreA * (v.D - 2 * v.ins);
  const frame = (box(v.W, v.H) - opening) * v.D - rebate * v.SD - core;
  const seal = (box(v.Ws - 8, v.Hs - 8) - box(v.W - 2 * v.F + 8, v.H - 2 * v.F + 8)) * v.sl;
  const sash = (box(v.Ws, v.Hs) - box(v.Ws - 2 * v.S, v.Hs - 2 * v.S)) * (v.SD - v.sl) - (box(v.Wg + 2 * v.gap, v.Hg + 2 * v.gap) - box(v.Ws - 2 * v.S, v.Hs - 2 * v.S)) * (v.G + 6);
  const pane = box(v.Wg, v.Hg) * v.g;
  const spacer = (box(v.Wg, v.Hg) - box(v.Wg - 2 * v.sp, v.Hg - 2 * v.sp)) * v.cav;
  const sill = ((30 * 40 + (70 * (40 + 28)) / 2) - 36) * (v.W + 2 * v.ov);
  const handle = Math.PI * 400 * 12 + 22 * 130 * 14;
  return { frame, core, seal, sash, pane1: pane, "pane2:pane1:0": pane, "pane3:pane1:0": pane, spacer1: spacer, "spacer2:spacer1:0": spacer, sill, handle };
}

const inter = (a: string, b: string) => Math.abs(measureVolume(body(a).intersect(body(b))));
function clashes(): string[] {
  const out: string[] = [];
  for (let i = 0; i < PARTS.length; i++)
    for (let j = i + 1; j < PARTS.length; j++) {
      const v = inter(PARTS[i], PARTS[j]);
      if (v > 0.01) out.push(`${nm(PARTS[i])}/${nm(PARTS[j])} ${v.toFixed(2)} mm³`);
    }
  return out;
}
const bb = (b: string) => body(b).boundingBox.bounds as [number[], number[]];
const size = (b: string) => [0, 1, 2].map((k) => bb(b)[1][k] - bb(b)[0][k]);

/** Every check that holds for any sizes. */
function checkAll(label: string, r: any) {
  check(`${label}: every step builds`, !r.errors.length, errs(r, feats));
  if (r.errors.length) return;
  const missing = PARTS.filter((p) => !debugBodies().has(p));
  check(`${label}: eleven parts`, r.bodies.length === PARTS.length && !missing.length, missing.length ? `missing ${missing.map(nm).join(", ")}` : r.bodies.map((b: any) => b.id).join(", "));
  if (missing.length) return;
  const sick = PARTS.filter((p) => !isHealthy(healthOf(debugBodies().get(p)!)));
  check(`${label}: each a clean solid`, !sick.length, sick.map(nm).join(", "));
  const v = values();
  const want = expected(v);
  const off = PARTS.map((p) => ({ p, rel: Math.abs(V(p) - want[p]) / want[p] })).filter((x) => x.rel > 1e-6);
  check(`${label}: every part's volume as its sizes say`, !off.length, off.map((x) => `${nm(x.p)} ${(x.rel * 100).toFixed(4)} % (${(V(x.p) / 1000).toFixed(2)} / ${(want[x.p] / 1000).toFixed(2)} cm³)`).join(", "));
  check(`${label}: no two parts run into each other`, !clashes().length, clashes().join("; "));
  const fs = size("frame");
  check(`${label}: the frame is W × D × H`, Math.abs(fs[0] - v.W) < 1e-3 && Math.abs(fs[1] - v.D) < 1e-3 && Math.abs(fs[2] - v.H) < 1e-3, fs.map((x) => x.toFixed(2)).join(" × "));
  // The insulation is sealed inside the frame: ins of frame on every side of it, and it fills its pocket.
  const cb = bb("core");
  const inside = [0, 1, 2].every((k) => cb[0][k] > bb("frame")[0][k] + v.ins - 1e-3 && cb[1][k] < bb("frame")[1][k] - v.ins + 1e-3);
  check(`${label}: the core is sealed inside the frame, filling its pocket`, inside && measureDistanceBetween(body("core"), body("frame")) < 1e-4);
  // The glass: in its groove with air all round, covered by the sash by e.
  const gaps = ["pane1", "pane2:pane1:0", "pane3:pane1:0"].map((p) => measureDistanceBetween(body(p), body("sash")));
  check(`${label}: the glass touches the sash nowhere (3 mm at least)`, gaps.every((x) => x > 3 - 1e-4), gaps.map((x) => x.toFixed(2)).join(", "));
  const p1 = bb("pane1");
  const sashIn = (v.Ws - 2 * v.S) / 2;
  check(`${label}: the glass's edge hidden e behind the sash all round`, Math.abs(p1[1][0] - sashIn - v.e) < 1e-3 && Math.abs(p1[1][2] - (v.Hs - 2 * v.S) / 2 - v.e) < 1e-3, `${(p1[1][0] - sashIn).toFixed(2)} mm`);
  const unit = [bb("pane1")[1][1], bb("pane3:pane1:0")[0][1]];
  check(`${label}: the glazing unit is G thick, in the sash's middle`, Math.abs(unit[0] - unit[1] - v.G) < 1e-3 && Math.abs((unit[0] + unit[1]) / 2 - (-v.D + (v.SD - v.sl) / 2)) < 1e-3, `${(unit[0] - unit[1]).toFixed(2)} mm, middle at y ${((unit[0] + unit[1]) / 2).toFixed(2)}`);
  check(`${label}: the spacers fill the cavities edge to edge`, Math.abs(measureDistanceBetween(body("spacer1"), body("pane1"))) < 1e-4 && Math.abs(measureDistanceBetween(body("spacer1"), body("pane2:pane1:0"))) < 1e-4 && Math.abs(measureDistanceBetween(body("spacer2:spacer1:0"), body("pane3:pane1:0"))) < 1e-4);
  // The sash sits in the rebate with air round it, the seal pressed between it and the step.
  check(`${label}: the sash clears the frame (c round it, the seal's room behind it)`, Math.abs(measureDistanceBetween(body("sash"), body("frame")) - Math.min(v.c, v.sl)) < 1e-3, `${measureDistanceBetween(body("sash"), body("frame")).toFixed(3)} mm`);
  check(`${label}: the seal touches both the sash and the frame`, measureDistanceBetween(body("seal"), body("sash")) < 1e-4 && measureDistanceBetween(body("seal"), body("frame")) < 1e-4);
  // The sill: under the frame, longer than it by ov each side, and outside it.
  const s = bb("sill");
  check(`${label}: the sill is under the frame, ov past each side, out 70 mm`, Math.abs(s[1][2] + v.H / 2) < 1e-3 && Math.abs(s[1][0] - s[0][0] - v.W - 2 * v.ov) < 1e-3 && Math.abs(s[1][1] - 70) < 1e-3);
  const h = bb("handle");
  check(`${label}: the handle is on the sash's right side, in the room`, Math.abs((h[0][0] + h[1][0]) / 2 - (v.Ws / 2 - v.S / 2)) < 1e-3 && h[1][1] <= -v.D + 1e-3);
  // Passive-house numbers: a lot of glass for the frame (more daylight, less frame to lose heat through).
  const glazed = ((v.Ws - 2 * v.S) * (v.Hs - 2 * v.S)) / (v.W * v.H);
  if (label === "as drawn") check(`${label}: glass is over 60 % of the window`, glazed > 0.6, `${(glazed * 100).toFixed(1)} %`);
  else console.log(`     glass ${(glazed * 100).toFixed(1)} % of the window`);
}

// --------------------------------------------------------------- the build
const t0 = performance.now();
const { r } = await build();
const ms = performance.now() - t0;
checkAll("as drawn", r);
check("…built in reasonable time", ms < 20000, `${Math.round(ms)} ms`);
console.log("     volumes", PARTS.map((p) => `${nm(p)} ${(V(p) / 1000).toFixed(1)}`).join(", "), "cm³");

// ------------------------------------------------- one change: it resizes
async function withVars(set: Record<string, string>, label: string) {
  const keep = variables;
  variables = baseVars.map(([name, expr]) => ({ name, expr: set[name] ?? expr }));
  const { r: r2 } = await build();
  checkAll(label, r2);
  variables = keep;
}
await withVars({ W: "900 mm", H: "1200 mm" }, "smaller");
await withVars({ W: "1600 mm", H: "2300 mm", F: "90 mm", S: "80 mm" }, "a door-height window, wider frame");
await withVars({ g: "6 mm", cav: "18 mm", SD: "100 mm" }, "thicker panes, narrower cavities");
await withVars({ D: "140 mm", ins: "20 mm", c: "6 mm" }, "deeper frame, thicker walls");
{
  let seed = 11;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pick = (a: number, b: number) => Math.round(a + (b - a) * rnd());
  for (let i = 0; i < 6; i++) {
    const set = { W: `${pick(600, 1800)} mm`, H: `${pick(600, 2400)} mm`, F: `${pick(70, 100)} mm`, S: `${pick(60, 90)} mm`, cav: `${pick(14, 22)} mm`, D: `${pick(110, 150)} mm` };
    await withVars(set, `random window ${i + 1} (${Object.values(set).join(", ")})`);
  }
}

if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify({ ...doc(), hidden: feats.filter((f) => f.type === "sketch").map((f) => f.id) }));

// The hand build (tests/fixtures/window-hand.json, built on a phone-sized
// screen): the same parts as by code, and the same after the variables change.
const handFile = new URL("./fixtures/window-hand.json", import.meta.url);
if (existsSync(handFile)) {
  const hand = JSON.parse(readFileSync(handFile, "utf8"));
  const HAND: Record<string, string> = hand.parts;
  const compare = async (set: Record<string, string>, label: string) => {
    const vars = baseVars.map(([name, expr]) => ({ name, expr: set[name] ?? expr }));
    const keep = variables;
    variables = vars;
    const { r: rc } = await build();
    const cv = new Map(PARTS.map((p) => [p, V(p)]));
    const cb = new Map(PARTS.map((p) => [p, bb(p)]));
    variables = keep;
    const d = structuredClone(hand.doc);
    d.variables = vars;
    const problems = resolveDoc(d);
    const rh: any = await regenerate(d.features);
    const ok = !problems.length && !rh.errors.length && PARTS.every((p) => debugBodies().has(HAND[nm(p)]));
    check(`hand build, ${label}: builds, every part`, ok && !rc.errors.length, [...problems, errs(rh, d.features)].join("; ") || rh.bodies.map((b: any) => b.id).join(", "));
    if (!ok) return;
    const off = PARTS.map((p) => ({ p, rel: Math.abs(V(HAND[nm(p)]) - cv.get(p)!) / cv.get(p)! })).filter((x) => x.rel > 0.001);
    check(`hand build, ${label}: every part the same as by code (volume within 0.1 %)`, !off.length, off.map((x) => `${nm(x.p)} ${(x.rel * 100).toFixed(2)} %`).join(", "));
    // And in the same place: sketches on planes follow them, a handle typed at
    // "Ws/2 - S/2" follows the sash (worked out once, it stayed where it was).
    const moved = PARTS.filter((p) => {
      const a = cb.get(p)!;
      const b = bb(HAND[nm(p)]);
      return [0, 1].some((i) => [0, 1, 2].some((k) => Math.abs(a[i][k] - b[i][k]) > 0.1));
    });
    check(`hand build, ${label}: every part where it is by code (within 0.1 mm)`, !moved.length, moved.map(nm).join(", "));
  };
  await compare({}, "as drawn");
  await compare({ W: "900 mm", H: "1200 mm" }, "smaller");
  await compare({ W: "1600 mm", H: "2300 mm", F: "90 mm", S: "80 mm" }, "door-height, wider frame");
  await compare({ g: "6 mm", cav: "18 mm", SD: "100 mm" }, "thicker panes");
}

// ------------------------------------- what the hand build found, on its own
{
  // A centre typed with a variable is held there and follows it.
  const sk: any = {
    id: "s", name: "Sketch", type: "sketch", plane: XZ(),
    entities: [{ id: "c", kind: "circle", center: [520, 0], radius: 20 }],
    constraints: [{ id: "f", type: "fix", pts: [{ e: "c", p: "c" }], at: [520, 0], atExpr: ["a/2 - b", null] }],
  };
  const d: any = { variables: [{ name: "a", expr: "1000 mm" }, { name: "b", expr: "30 mm" }], features: [sk] };
  const problems = resolveDoc(d);
  check("a point typed with a variable follows it", !problems.length && Math.abs(d.features[0].entities[0].center[0] - 470) < 1e-6 && Math.abs(d.features[0].entities[0].center[1]) < 1e-6, `${d.features[0].entities[0].center} ${problems}`);
  // A sketch on a construction plane follows the plane when its offset changes.
  const pl: any = { id: "p", name: "Plane", type: "plane", kind: "offset", plane: XZ(), offset: 30, exprs: { offset: "o" } };
  const s2: any = { id: "s2", name: "Sketch", type: "sketch", plane: XZ(-30), onPlane: "p", entities: [{ id: "r", kind: "rect", center: [0, 0], w: 100, h: 100, rotation: 0 }], constraints: [] };
  const e2: any = { id: "x", name: "Extrude", type: "extrude", source: { kind: "profile", sketch: "s2", regions: whole(s2.entities) }, distance: 10, mode: "new" };
  const d2: any = { variables: [{ name: "o", expr: "75 mm" }], features: [pl, s2, e2] };
  resolveDoc(d2);
  const r2: any = await regenerate(d2.features);
  const box = r2.errors.length ? null : (debugBodies().get("x")!.boundingBox.bounds as number[][]);
  check("a sketch on a plane follows the plane's offset", !!box && Math.abs(box[1][1] + 75) < 1e-6 && Math.abs(box[0][1] + 85) < 1e-6, box ? `y ${box[0][1]}..${box[1][1]}` : errs(r2, d2.features));
}

console.log(failed ? `${failed} FAILED` : "all passed");
process.exit(failed ? 1 : 0);
