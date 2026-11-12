// Run: npx tsx tests/gridfaces.test.ts
// Faces pushed, pulled, moved, tilted, slid and deleted, each result held to
// its exact volume: a block's faces, a cylinder's, faces next to rounded
// corners - and faces with holes in them or things standing on them (a top
// pulled up closed the hole through it with a lid; pushed down, it was
// refused because of a boss standing on it).
import { block, bodies, circle, cylinder, done, extrude, poly, rect, sketch, XY, YZ } from "./kit";
import { build, edgeRefs, faceRef, near, say } from "./grid";
import type { Feature, SketchEntity, Vec3 } from "../src/doc/types";

const W = 40, D = 30, H = 20;
const A = block("A", W, D, H);
const VA = W * D * H;
const q = 1 - Math.PI / 4;
const push = (face: any, distance: number, mode = "auto"): Feature => ({ id: "P", name: "P", type: "extrude", source: { kind: "face", face }, distance, mode, target: face.body }) as Feature;
const cutIn = (id: string, es: SketchEntity[], depth: number): Feature[] => {
  const s = sketch(`${id}-s`, XY(H), es);
  return [s, extrude(id, s, -depth, "cut", { target: "A" })];
};
const standOn = (id: string, es: SketchEntity[], h: number): Feature[] => {
  const s = sketch(`${id}-s`, XY(H), es);
  return [s, extrude(id, s, h, "join", { target: "A" })];
};
const topAt = (z = H) => faceRef("A", (n, c) => n[2] > 0.99 && Math.abs(c[2] - z) < 1e-6);
const sound = (g: Awaited<ReturnType<typeof build>>) => !g.errors.length && !g.unsound.length;
const told = (g: Awaited<ReturnType<typeof build>>, body = "A") => `${g.errors.join(" | ")} ${g.unsound} got ${g.vol[body]?.toFixed(2)}`;

// ------------------------------------------------------------ a block's faces
{
  await build(A);
  const top = topAt();
  const side = faceRef("A", (n) => n[0] > 0.99);
  for (const d of [-19.99, -10, -0.01, 0.01, 5, 200]) {
    let g = await build([...A, push(top, d)]);
    say(sound(g) && near(g.vol.A, W * D * (H + d), 1e-5), `a block's top, ${d}`, `${told(g)} want ${(W * D * (H + d)).toFixed(3)}`);
    if (Math.abs(d) < W) {
      g = await build([...A, push(side, d)]);
      say(sound(g) && near(g.vol.A, (W + d) * D * H, 1e-5), `a block's side, ${d}`, `${told(g)} want ${((W + d) * D * H).toFixed(3)}`);
    }
  }
  for (const d of [-20, -25]) {
    const g = await build([...A, push(top, d)]);
    say(g.errors.length > 0 || !g.ids.includes("A"), `a block's top pushed ${-d} down (all of it): nothing left, or said so`, `${g.errors.join(" | ")} ${JSON.stringify(g.vol)}`);
  }
}

// ------------------------------------------------------------ a cylinder's top and its round face
{
  const C = cylinder("C", 10, 20);
  await build(C);
  const top = faceRef("C", (n) => n[2] > 0.99);
  const round = faceRef("C", (_n, _c, f) => f.geomType === "CYLINDRE");
  for (const d of [-5, 3]) {
    let g = await build([...C, push(top, d)]);
    say(sound(g) && near(g.vol.C, Math.PI * 100 * (20 + d), 1e-5), `a cylinder's top, ${d}`, told(g, "C"));
    g = await build([...C, push(round, d)]);
    say(sound(g) && near(g.vol.C, Math.PI * (10 + d) ** 2 * 20, 1e-5), `a cylinder's round face, ${d} (its radius ${10 + d})`, `${told(g, "C")} want ${(Math.PI * (10 + d) ** 2 * 20).toFixed(2)}`);
  }
}

// ------------------------------------------------------------ next to rounded corners: the rounds go with the face
{
  await build(A);
  const base = [...A, { id: "F", name: "F", type: "fillet", edges: edgeRefs("A", (_m, d) => Math.abs(d[2]) > 0.99), radius: 4 } as Feature];
  await build(base);
  const top = topAt();
  const side = faceRef("A", (n, _c, f) => n[0] > 0.99 && f.geomType === "PLANE");
  for (const d of [-5, -2, 2, 5]) {
    let g = await build([...base, push(top, d)]);
    say(sound(g) && near(g.vol.A, (W * D - 4 * q * 16) * (H + d), 1e-5), `a block with rounded corners: its top, ${d}`, told(g));
    g = await build([...base, push(side, d)]);
    say(sound(g) && near(g.vol.A, ((W + d) * D - 4 * q * 16) * H, 1e-5), `a block with rounded corners: a side, ${d} (the rounds move with it)`, `${told(g)} want ${(((W + d) * D - 4 * q * 16) * H).toFixed(2)}`);
  }
}

// ------------------------------------------------------------ faces with holes in them, or things standing on them
const holed: [string, Feature[], (d: number) => number, number[]][] = [
  ["a round hole through", [...A, ...cutIn("h", [circle("c", 20, 15, 5)], H)], (d) => (1200 - 25 * Math.PI) * (H + d), [-5, 0.5, 5, 30]],
  ["two round holes through", [...A, ...cutIn("h", [circle("c", 10, 15, 4), circle("e", 30, 15, 3)], H)], (d) => (1200 - 25 * Math.PI) * (H + d), [-5, 5]],
  ["a window through", [...A, ...cutIn("h", [rect("r", 10, 10, 30, 20)], H)], (d) => 1000 * (H + d), [-5, 5]],
  ["a triangle hole through", [...A, ...cutIn("h", [poly("p", [[10, 8], [30, 8], [20, 24]])], H)], (d) => (1200 - 160) * (H + d), [-5, 5]],
  ["an L-shaped hole through", [...A, ...cutIn("h", [poly("p", [[8, 6], [32, 6], [32, 14], [18, 14], [18, 24], [8, 24]])], H)], (d) => (1200 - (24 * 8 + 10 * 10)) * (H + d), [-5, 5]],
  ["a blind pocket 8 deep", [...A, ...cutIn("h", [rect("r", 10, 10, 30, 20)], 8)], (d) => 1200 * (H + d) - 200 * (8 + d), [-5, 5]],
  ["a blind round hole 8 deep", [...A, ...cutIn("h", [circle("c", 20, 15, 5)], 8)], (d) => 1200 * (H + d) - 25 * Math.PI * (8 + d), [-5, 5]],
  ["a round boss 10 high on it", [...A, ...standOn("b", [circle("c", 20, 15, 5)], 10)], (d) => 1200 * (H + d) + 25 * Math.PI * (10 - d), [-5, 3]],
  ["a square boss 10 high on it", [...A, ...standOn("b", [rect("r", 15, 10, 25, 20)], 10)], (d) => 1200 * (H + d) + 100 * (10 - d), [-5, 3]],
  ["a hole and a boss", [...A, ...cutIn("h", [circle("c", 10, 15, 4)], H), ...standOn("b", [circle("c", 30, 15, 4)], 10)], (d) => (1200 - 16 * Math.PI) * (H + d) + 16 * Math.PI * (10 - d), [-5, 3]],
  ["a hole 1 mm from its edge", [...A, ...cutIn("h", [circle("c", 6, 15, 5)], H)], (d) => (1200 - 25 * Math.PI) * (H + d), [-5, 5]],
];
for (const [name, base, vol, ds] of holed)
  for (const d of ds) {
    await build(base);
    const ref = topAt();
    for (const mode of ["auto", d > 0 ? "join" : "cut"]) {
      const g = await build([...base, push(ref, mode === "cut" ? Math.abs(d) : d, mode)]);
      say(sound(g) && g.ids.length === 1 && near(g.vol.A, vol(d), 1e-5), `a top with ${name}, ${d > 0 ? "pulled up" : "pushed down"} ${Math.abs(d)} (${mode})`, `${told(g)} want ${vol(d).toFixed(2)}`);
    }
    const g = await build([...base, { id: "M", name: "M", type: "moveFace", face: ref, translate: [0, 0, d] } as Feature]);
    say(sound(g) && g.ids.length === 1 && near(g.vol.A, vol(d), 1e-5), `a top with ${name}, moved ${d}`, `${told(g)} want ${vol(d).toFixed(2)}`);
  }

// A pocket's floor; the bottom of a block with a hole through; a side with a hole across it.
{
  const pocket = [...A, ...cutIn("h", [rect("r", 10, 10, 30, 20)], 8)];
  await build(pocket);
  const floor = topAt(12);
  for (const d of [-2, 2, 7]) {
    const g = await build([...pocket, push(floor, d)]);
    say(sound(g) && near(g.vol.A, 24000 - 200 * (8 - d), 1e-5), `a pocket's floor, ${d}`, `${told(g)} want ${(24000 - 200 * (8 - d)).toFixed(2)}`);
  }
  const through = [...A, ...cutIn("h", [circle("c", 20, 15, 5)], H)];
  await build(through);
  const bottom = faceRef("A", (n) => n[2] < -0.99);
  for (const d of [-5, 5]) {
    const g = await build([...through, push(bottom, d)]);
    say(sound(g) && near(g.vol.A, (1200 - 25 * Math.PI) * (H + d), 1e-5), `the bottom of a block with a round hole through, ${d}`, `${told(g)} want ${((1200 - 25 * Math.PI) * (H + d)).toFixed(2)}`);
  }
  const s = sketch("x-s", YZ(40), [circle("c", 15, 10, 4)]);
  const across = [...A, s, extrude("x", s, -40, "cut", { target: "A" })];
  await build(across);
  const side = faceRef("A", (n, c) => n[0] > 0.99 && Math.abs(c[0] - 40) < 1e-6);
  for (const d of [-5, 5]) {
    const g = await build([...across, push(side, d)]);
    say(sound(g) && near(g.vol.A, (600 - 16 * Math.PI) * (40 + d), 1e-5), `a side with a hole across the block through it, ${d}`, `${told(g)} want ${((600 - 16 * Math.PI) * (40 + d)).toFixed(2)}`);
  }
}

// An L-shaped top with a round hole; a cone's top with a hole (its side carries on as a cone).
{
  const sL = sketch("L-s", XY(), [poly("p", [[0, 0], [40, 0], [40, 15], [15, 15], [15, 40], [0, 40]])]);
  const sh = sketch("h-s", XY(10), [circle("c", 28, 7, 3)]);
  const base = [sL, extrude("A", sL, 10), sh, extrude("h", sh, -10, "cut", { target: "A" })];
  await build(base);
  const t = faceRef("A", (n) => n[2] > 0.99);
  for (const d of [-4, 4]) {
    const g = await build([...base, push(t, d)]);
    say(sound(g) && near(g.vol.A, (975 - 9 * Math.PI) * (10 + d), 1e-5), `an L's top with a round hole, ${d}`, `${told(g)} want ${((975 - 9 * Math.PI) * (10 + d)).toFixed(2)}`);
  }
  const sc = sketch("c-s", XY(), [circle("c", 0, 0, 15)]);
  const sh2 = sketch("h2-s", XY(20), [circle("c", 0, 0, 3)]);
  const cone = [sc, extrude("A", sc, 20, "new", { taper: 0.5 }), sh2, extrude("h", sh2, -20, "cut", { target: "A" })];
  await build(cone);
  const frustum = (h: number, r1: number) => ((Math.PI * h) / 3) * (225 + 15 * r1 + r1 * r1);
  const t2 = faceRef("A", (n) => n[2] > 0.99);
  for (const d of [-5, 5]) {
    const g = await build([...cone, push(t2, d)]);
    const v = frustum(20 + d, 15 - 0.375 * (20 + d)) - 9 * Math.PI * (20 + d);
    say(sound(g) && near(g.vol.A, v, 3e-4), `a cone's top with a hole through it, ${d}`, `${told(g)} want ${v.toFixed(2)}`);
  }
}

// ------------------------------------------------------------ moved, tilted, slid, twisted; a corner and an edge
{
  await build(A);
  const top = topAt();
  const mv = (extra: object): Feature => ({ id: "M", name: "M", type: "moveFace", translate: [0, 0, 0], ...extra }) as Feature;
  let g = await build([...A, mv({ face: top, translate: [0, 0, 7] })]);
  say(sound(g) && near(g.vol.A, W * D * 27, 1e-6), "a block's top moved 7 up", told(g));
  for (const ang of [5, 20, -20]) {
    g = await build([...A, mv({ face: top, rotate: { origin: [20, 15, 20], axis: [0, 1, 0], angle: ang } })]);
    say(sound(g) && near(g.vol.A, VA, 1e-6), `a block's top tilted ${ang} about its middle: as much taken as added`, told(g));
  }
  g = await build([...A, mv({ face: top, translate: [10, 0, 0] })]);
  say(sound(g) && near(g.vol.A, VA, 1e-6), "a block's top slid 10 sideways: a leaning block, the same volume", told(g));
  g = await build([...A, mv({ face: top, rotate: { origin: [20, 15, 20], axis: [0, 0, 1], angle: 30 } })]);
  say(sound(g) && g.vol.A > VA * 0.7 && g.vol.A < VA * 1.3, "a block's top turned 30 about its own normal: a twisted block", told(g));
  g = await build([...A, mv({ vertex: { body: "A", at: [40, 30, 20] }, translate: [0, 0, 10] })]);
  say(sound(g) && g.vol.A > VA && g.vol.A < VA + W * D * 10 * 0.5, "a block's corner pulled 10 up", told(g));
  await build(A);
  const edge = edgeRefs("A", (m) => Math.abs(m[0] - 40) < 1e-6 && Math.abs(m[2] - 20) < 1e-6)[0];
  g = await build([...A, mv({ edge, translate: [0, 0, 10] })]);
  say(sound(g) && near(g.vol.A, VA + (W * D * 10) / 2, 1e-6), "a block's top edge lifted 10: a wedge on top", `${told(g)} want ${VA + (W * D * 10) / 2}`);
}

// ------------------------------------------------------------ deleted: a fillet's face, a hole's wall, a pocket
{
  await build(A);
  const rounded = [...A, { id: "F", name: "F", type: "fillet", edges: edgeRefs("A", (_m, d) => Math.abs(d[2]) > 0.99).slice(0, 1), radius: 5 } as Feature];
  await build(rounded);
  const del = (faces: any[]): Feature => ({ id: "X", name: "X", type: "deleteGeom", body: "A", faces, edges: [], vertices: [] }) as Feature;
  let g = await build([...rounded, del([faceRef("A", (_n, _c, f) => f.geomType === "CYLINDRE")])]);
  say(sound(g) && near(g.vol.A, VA, 1e-6), "a fillet's face deleted: the sharp edge is back", told(g));
  const through = [...A, ...cutIn("h", [circle("c", 20, 15, 5)], H)];
  await build(through);
  g = await build([...through, del([faceRef("A", (_n, _c, f) => f.geomType === "CYLINDRE")])]);
  say(sound(g) && near(g.vol.A, VA, 1e-6), "a through hole's wall deleted: the hole closes", told(g));
  const pocket = [...A, ...cutIn("p", [rect("r", 10, 10, 30, 20)], 8)];
  await build(pocket);
  const inside = bodies().get("A")!.faces.filter((f) => {
    const c = f.center.toTuple();
    return c[0] > 9.9 && c[0] < 30.1 && c[1] > 9.9 && c[1] < 20.1 && c[2] < 19.9 && c[2] > 0.1;
  });
  g = await build([...pocket, del(inside.map((f) => ({ body: "A", center: f.center.toTuple() as Vec3, normal: f.normalAt().toTuple() as Vec3, area: 0 })))]);
  say(sound(g) && near(g.vol.A, VA, 1e-6), `a pocket's ${inside.length} faces deleted together: it fills in`, told(g));
}

// ------------------------------------------------------------ a face scaled
{
  await build(A);
  const top = topAt();
  const scaled = (factors: [number, number]): Feature => ({ id: "S", name: "S", type: "scaleFace", face: top, u: [1, 0, 0], factors }) as Feature;
  let g = await build([...A, scaled([0.5, 0.5])]);
  const half = (H / 3) * (W * D + (W * D) / 4 + (W * D) / 2);
  say(sound(g) && near(g.vol.A, half, 1e-6), "a block's top scaled to half each way: a frustum", `${told(g)} want ${half}`);
  g = await build([...A, scaled([0.5, 1])]);
  say(sound(g) && near(g.vol.A, (D * H * (W + W / 2)) / 2, 1e-6), "a block's top scaled to half along X only", `${told(g)} want ${(D * H * (W + W / 2)) / 2}`);
  g = await build([...A, scaled([1.5, 1.5])]);
  const more = (H / 3) * (W * D + W * D * 2.25 + W * D * 1.5);
  say(sound(g) && near(g.vol.A, more, 1e-6), "a block's top scaled to 150 %", `${told(g)} want ${more}`);
}
done();
