// Run: npx tsx tests/gridfillet.test.ts
// Fillets and chamfers on a block's edges (one, the four upright ones, the
// top's, all twelve), a cylinder's rims and an L's inside edge, at sizes from
// half a millimetre up to the biggest that fits, each held to its exact
// volume (a round takes (1 - pi/4) r^2 per unit length, a chamfer r^2 / 2;
// an inside edge gains as much). Exactly at the limit a refusal in words is
// fine; a wrong shape is not.
import { block, cylinder, done, extrude, poly, sketch, XY } from "./kit";
import { build, edgeRefs, near, say } from "./grid";
import type { Feature, Vec3 } from "../src/doc/types";

const W = 40, D = 30, H = 20;
const A = block("A", W, D, H);
const VA = W * D * H;
const vertical = (m: Vec3, d: Vec3) => Math.abs(d[2]) > 0.99;
const topLoop = (m: Vec3, d: Vec3) => Math.abs(m[2] - H) < 1e-6 && Math.abs(d[2]) < 0.01;
const along = (axis: number) => (m: Vec3, d: Vec3) => Math.abs(d[axis]) > 0.99;
const edge = (type: "fillet" | "chamfer", edges: any[], radius: number, extra: object = {}): Feature => ({ id: "F", name: "F", type, edges, radius, ...extra }) as Feature;
const q = 1 - Math.PI / 4;

await build(A);
const sets: [string, any[], (r: number) => number | null, (r: number) => number | null, number][] = [
  // name, edges, fillet volume removed, chamfer volume removed, biggest size that fits
  ["one vertical edge", edgeRefs("A", vertical).slice(0, 1), (r) => q * r * r * H, (r) => (r * r * H) / 2, 30],
  ["the four vertical edges", edgeRefs("A", vertical), (r) => 4 * q * r * r * H, (r) => 2 * r * r * H, 15],
  ["one top edge", edgeRefs("A", (m, d) => topLoop(m, d) && Math.abs(d[0]) > 0.99).slice(0, 1), (r) => q * r * r * W, (r) => (r * r * W) / 2, 20],
  ["two opposite top edges", edgeRefs("A", (m, d) => topLoop(m, d) && Math.abs(d[0]) > 0.99), (r) => 2 * q * r * r * W, (r) => r * r * W, 15],
  // (The four top edges: the chamfers overlap at the corners - each corner's pyramid, r^3 / 3, counted once.)
  ["the four top edges", edgeRefs("A", topLoop), () => null, (r) => r * r * (W + D) - (4 / 3) * r ** 3, 10],
  ["all twelve edges", edgeRefs("A", () => true), () => null, () => null, 9],
];
for (const [name, edges, fv, cv, limit] of sets) {
  if (!edges.length) { say(false, name, "no edges found"); continue; }
  for (const r of [0.5, 2, 5, limit * 0.6, limit * 0.999, limit]) {
    for (const type of ["fillet", "chamfer"] as const) {
      const g = await build([...A, edge(type, edges, r)]);
      const rem = type === "fillet" ? fv(r) : cv(r);
      const okVol = rem === null ? g.vol.A < VA && g.vol.A > VA * 0.3 : near(g.vol.A, VA - rem, 2e-4);
      // exactly at the limit OpenCascade may refuse: a refusal in words is fine there, a wrong shape is not
      const atLimit = r === limit;
      const refused = g.errors.length > 0 && /doesn't fit|too big|smaller/i.test(g.errors.join());
      say((atLimit && refused) || (!g.errors.length && !g.unsound.length && okVol), `${type} ${r.toFixed(3)} on ${name}`, `${g.errors.join(" | ")} ${g.unsound} got ${g.vol.A?.toFixed(2)} want ${rem === null ? "?" : (VA - rem).toFixed(2)}`);
    }
  }
}

// Variable, chord, two-distance, G2, setback: sound, and between the plain sizes.
await build(A);
const V4 = edgeRefs("A", vertical), V1 = V4.slice(0, 1), T4 = edgeRefs("A", topLoop), ALL = edgeRefs("A", () => true);
for (const [name, extra, type] of [["variable 2..5", { radius2: 5 }, "fillet"], ["by chord 3", { chord: true }, "fillet"], ["G2", { g2: true }, "fillet"], ["two distances 2, 4", { distance2: 4 }, "chamfer"], ["two distances, flipped", { distance2: 4, flip: true }, "chamfer"]] as const) {
  for (const [sname, edges] of [["one vertical edge", V1], ["the four vertical edges", V4], ["the four top edges", T4], ["all twelve", ALL]] as const) {
    const g = await build([...A, edge(type, edges as any[], name.startsWith("by chord") ? 3 : 2, extra)]);
    say(!g.errors.length && !g.unsound.length && g.vol.A < VA && g.vol.A > VA * 0.8, `${type} ${name} on ${sname}`, `${g.errors.join(" | ")} ${g.unsound} got ${g.vol.A?.toFixed(2)} of ${VA}`);
  }
}

// Setback (a rounded corner where three rounds meet): all the edges round the corners, a setback that reaches past them.
for (const setback of [4, 6]) {
  const g = await build([...A, edge("fillet", ALL, 2, { setback })]);
  say(!g.errors.length && !g.unsound.length && g.vol.A < VA && g.vol.A > VA * 0.9, `fillet 2 with setback ${setback} on all twelve`, `${g.errors.join(" | ")} ${g.unsound} got ${g.vol.A?.toFixed(2)} of ${VA}`);
}
{
  const g = await build([...A, edge("fillet", V4, 2, { setback: 4 })]);
  say(/Setback joins corners/.test(g.errors.join()), "setback with no corner where three rounds meet: said so", g.errors.join(" | "));
}

// A cylinder's rims.
{
  const C = cylinder("C", 10, 20, 0, 0, 0);
  await build(C);
  const VC = Math.PI * 100 * 20;
  const rims = edgeRefs("C", (m, d, e) => e.geomType === "CIRCLE");
  // (A hair under the cylinder's own radius leaves a top next to nothing: refused, in words.)
  const refusal = /doesn't fit|too big|smaller|hair-thin/i;
  for (const r of [1, 4, 9, 9.999, 10]) {
    // A rim rounded: what is between the corner and the arc (area q r^2, its middle r (10 - 3 pi) / (12 - 3 pi) in from the corner), turned round the axis.
    const cg = (r * (10 - 3 * Math.PI)) / (12 - 3 * Math.PI);
    const one = q * r * r * 2 * Math.PI * (10 - cg);
    for (const [which, edges, n] of [["top rim", rims.filter((e) => e.mid[2] > 10), 1], ["both rims", rims, 2]] as const) {
      let g = await build([...C, { id: "F", name: "F", type: "fillet", edges, radius: r } as Feature]);
      const refused = g.errors.length > 0 && refusal.test(g.errors.join());
      say((r >= 9.999 && refused) || (!g.errors.length && !g.unsound.length && near(g.vol.C, VC - n * one, 3e-4)), `fillet ${r} on a cylinder's ${which}`, `${g.errors.join(" | ")} ${g.unsound} got ${g.vol.C?.toFixed(2)} want ${(VC - n * one).toFixed(2)}`);
      // Chamfered: a triangle r by r, its middle r / 3 in from the corner.
      const cone = (r * r * 0.5) * 2 * Math.PI * (10 - r / 3);
      g = await build([...C, { id: "F", name: "F", type: "chamfer", edges, radius: r } as Feature]);
      const refused2 = g.errors.length > 0 && refusal.test(g.errors.join());
      say((r >= 9.999 && refused2) || (!g.errors.length && !g.unsound.length && near(g.vol.C, VC - n * cone, 3e-4)), `chamfer ${r} on a cylinder's ${which}`, `${g.errors.join(" | ")} ${g.unsound} got ${g.vol.C?.toFixed(2)} want ${(VC - n * cone).toFixed(2)}`);
    }
  }
}

// An L-shaped block: the inside (concave) edge filleted adds material, chamfered too.
{
  const s = sketch("s", XY(), [poly("p", [[0, 0], [40, 0], [40, 15], [15, 15], [15, 40], [0, 40]])]);
  const L = [s, extrude("L", s, 10)];
  await build(L);
  const VL = (40 * 15 + 15 * 25) * 10;
  const inner = edgeRefs("L", (m, d) => Math.abs(d[2]) > 0.99 && Math.abs(m[0] - 15) < 1e-6 && Math.abs(m[1] - 15) < 1e-6);
  for (const r of [1, 5, 14, 20]) {
    let g = await build([...L, { id: "F", name: "F", type: "fillet", edges: inner, radius: r } as Feature]);
    say(!g.errors.length && !g.unsound.length && near(g.vol.L, VL + q * r * r * 10, 2e-4), `fillet ${r} on an L's inside edge`, `${g.errors.join(" | ")} ${g.unsound} got ${g.vol.L?.toFixed(2)} want ${(VL + q * r * r * 10).toFixed(2)}`);
    g = await build([...L, { id: "F", name: "F", type: "chamfer", edges: inner, radius: r } as Feature]);
    say(!g.errors.length && !g.unsound.length && near(g.vol.L, VL + (r * r * 10) / 2, 2e-4), `chamfer ${r} on an L's inside edge`, `${g.errors.join(" | ")} ${g.unsound} got ${g.vol.L?.toFixed(2)} want ${(VL + (r * r * 10) / 2).toFixed(2)}`);
  }
  // every vertical edge at once (five convex, one concave)
  await build(L);
  const all = edgeRefs("L", (m, d) => Math.abs(d[2]) > 0.99);
  for (const r of [1, 3, 6]) {
    const g = await build([...L, { id: "F", name: "F", type: "fillet", edges: all, radius: r } as Feature]);
    say(!g.errors.length && !g.unsound.length && near(g.vol.L, VL - 4 * q * r * r * 10, 2e-4), `fillet ${r} on all six vertical edges of an L (five out, one in)`, `${g.errors.join(" | ")} ${g.unsound} got ${g.vol.L?.toFixed(2)} want ${(VL - 4 * q * r * r * 10).toFixed(2)}`);
  }
}
done();
