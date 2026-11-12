// Run: npx tsx tests/gridshapes.test.ts
// Revolve (eight profiles - off the axis, touching it, a corner on it, a ball,
// a rectangle a micron from it - through seven angles, by Pappus), patterns
// in a row and round an axis (joined where the copies touch or overlap),
// Mirror, Scale (one size and each way its own), Move with a turn, and Split
// (planes across, on a diagonal, on a face, past the body; three at once):
// each held to its exact volume.
import { block, circle, cylinder, done, poly, profile, rect, sketch, XZ } from "./kit";
import { build, near, say } from "./grid";
import type { Feature, PlaneDef, SketchEntity, Vec3 } from "../src/doc/types";


// ---------------------------------------------------------------- revolve
{
  // Profiles on the front plane (x right, z up), turned about the z axis: Pappus.
  const zAxis = { origin: [0, 0, 0] as Vec3, dir: [0, 0, 1] as Vec3 };
  const shapes: [string, SketchEntity[], number, number][] = [
    // name, entities, area, centroid's distance from the axis
    ["a rectangle off the axis", [rect("r", 10, 0, 20, 8)], 80, 15],
    ["a rectangle touching the axis", [rect("r", 0, 0, 12, 8)], 96, 6],
    ["a circle off the axis (a ring)", [circle("c", 20, 5, 4)], Math.PI * 16, 20],
    ["a triangle with a corner on the axis", [poly("p", [[0, 0], [15, 0], [15, 10]])], 75, 10],
    ["a half disc on the axis (a ball)", [poly("p", [[0, -10], [0, 10]], false), { id: "a", kind: "arc", a: [0, -10], m: [10, 0], b: [0, 10] } as any], (Math.PI * 100) / 2, (4 * 10) / (3 * Math.PI)],
    ["a quarter disc, its corner on the axis", [poly("p", [[10, 0], [0, 0], [0, 10]], false), { id: "a", kind: "arc", a: [0, 10], m: [Math.SQRT1_2 * 10, Math.SQRT1_2 * 10], b: [10, 0] } as any], (Math.PI * 100) / 4, (4 * 10) / (3 * Math.PI)],
    ["a rectangle 0.001 from the axis", [rect("r", 0.001, 0, 12, 8)], 11.999 * 8, 6.0005],
    ["an L against the axis", [poly("p", [[0, 0], [20, 0], [20, 5], [6, 5], [6, 15], [0, 15]])], 20 * 5 + 6 * 10, (100 * 10 + 60 * 3) / 160],
  ];
  for (const [name, es, ar, rc] of shapes) {
    const s = sketch("s", XZ(), es);
    let src: ReturnType<typeof profile>;
    src = profile("s", es);
    for (const angle of [360, 180, 90, 270, -90, 45, 359]) {
      const g = await build([s, { id: "R", name: "R", type: "revolve", source: src, axis: zAxis, angle, mode: "new" } as Feature]);
      const v = (ar * 2 * Math.PI * rc * Math.abs(angle)) / 360;
      say(!g.errors.length && !g.unsound.length && near(g.vol.R, v, 3e-4), `revolve ${angle}: ${name}`, `${g.errors.join(" | ")} ${g.unsound} got ${g.vol.R?.toFixed(2)} want ${v.toFixed(2)}`);
    }
  }
}

// ---------------------------------------------------------------- patterns, mirror, scale
{
  const A = block("A", 10, 10, 10, [20, -5, 0]);
  const zAxis = { origin: [0, 0, 0] as Vec3, dir: [0, 0, 1] as Vec3 };
  const tf = (op: object, extra: object = {}): Feature => ({ id: "T", name: "T", type: "transform", bodies: ["A"], copy: false, op, ...extra }) as Feature;
  for (const count of [2, 3, 8, 24]) {
    let g = await build([...A, tf({ kind: "linear", dir: [1, 0, 0], spacing: 15, count })]);
    say(!g.errors.length && !g.unsound.length && g.ids.length === count && Object.values(g.vol).every((v) => near(v, 1000, 1e-6)), `linear x ${count}`, `${g.errors.join(" | ")} ${g.unsound} ${g.ids.length} bodies`);
    g = await build([...A, tf({ kind: "circular", axis: zAxis, angle: 360, count })]);
    say(!g.errors.length && !g.unsound.length && g.ids.length === count && Object.values(g.vol).every((v) => near(v, 1000, 1e-6)), `circular x ${count}, a full turn`, `${g.errors.join(" | ")} ${g.unsound} ${g.ids.length} bodies`);
    g = await build([...A, tf({ kind: "circular", axis: zAxis, angle: 90, count })]);
    say(!g.errors.length && !g.unsound.length && g.ids.length === count, `circular x ${count}, a quarter turn`, `${g.errors.join(" | ")} ${g.unsound} ${g.ids.length} bodies`);
    // touching copies joined into one: spacing 10 = the block's own width
    g = await build([...A, tf({ kind: "linear", dir: [1, 0, 0], spacing: 10, count }), { id: "U", name: "U", type: "boolean", op: "union", target: "A", tools: Array.from({ length: count - 1 }, (_, k) => `T:A:${k}`) } as Feature]);
    say(!g.errors.length && !g.unsound.length && g.ids.length === 1 && near(g.vol.A, 1000 * count, 1e-6), `linear x ${count}, touching, joined`, `${g.errors.join(" | ")} ${g.unsound} ${g.ids.length} bodies ${g.vol.A?.toFixed(1)}`);
    // overlapping copies joined: spacing 6
    g = await build([...A, tf({ kind: "linear", dir: [1, 0, 0], spacing: 6, count }), { id: "U", name: "U", type: "boolean", op: "union", target: "A", tools: Array.from({ length: count - 1 }, (_, k) => `T:A:${k}`) } as Feature]);
    say(!g.errors.length && !g.unsound.length && g.ids.length === 1 && near(g.vol.A, 100 * (10 + 6 * (count - 1)), 1e-6), `linear x ${count}, overlapping, joined`, `${g.errors.join(" | ")} ${g.unsound} ${g.ids.length} bodies ${g.vol.A?.toFixed(1)}`);
  }
  // mirror: moved, copied, and the copy joined across the plane it touches
  const pl = (x: number): PlaneDef => ({ origin: [x, 0, 0], xDir: [0, 1, 0], normal: [1, 0, 0] });
  let g = await build([...A, tf({ kind: "mirror", plane: pl(0) })]);
  say(!g.errors.length && !g.unsound.length && near(g.vol.A, 1000, 1e-6), "mirror: moved across", `${g.errors.join(" | ")} ${g.unsound}`);
  g = await build([...A, tf({ kind: "mirror", plane: pl(20) }, { copy: true }), { id: "U", name: "U", type: "boolean", op: "union", target: "A", tools: ["T:A:0"] } as Feature]);
  say(!g.errors.length && !g.unsound.length && g.ids.length === 1 && near(g.vol.A, 2000, 1e-6), "mirror: a copy across the block's own face, joined", `${g.errors.join(" | ")} ${g.unsound} ${g.ids} ${g.vol.A?.toFixed(1)}`);
  g = await build([...A, tf({ kind: "mirror", plane: pl(24) }, { copy: true }), { id: "U", name: "U", type: "boolean", op: "union", target: "A", tools: ["T:A:0"] } as Feature]);
  say(!g.errors.length && !g.unsound.length && g.ids.length === 1 && near(g.vol.A, 1200, 1e-6), "mirror: a copy across a plane through the block, joined (12 wide now)", `${g.errors.join(" | ")} ${g.unsound} ${g.ids} ${g.vol.A?.toFixed(1)}`);
  // scale
  for (const k of [0.01, 0.5, 2, 37.5]) {
    g = await build([...A, tf({ kind: "scale", center: [0, 0, 0], factor: k })]);
    say(!g.errors.length && !g.unsound.length && near(g.vol.A, 1000 * k ** 3, 1e-6), `scale ${k}`, `${g.errors.join(" | ")} ${g.unsound} ${g.vol.A}`);
    g = await build([...A, tf({ kind: "scaleXYZ", center: [25, 0, 5], factors: [k, 1, 2] })]);
    say(!g.errors.length && !g.unsound.length && near(g.vol.A, 2000 * k, 1e-6), `scale ${k} along X, 2 along Z`, `${g.errors.join(" | ")} ${g.unsound} ${g.vol.A}`);
  }
  // scaleXYZ of round and filleted things
  const C = cylinder("C", 10, 20);
  g = await build([...C, { id: "T", name: "T", type: "transform", bodies: ["C"], copy: false, op: { kind: "scaleXYZ", center: [0, 0, 0], factors: [2, 1, 0.5] } } as Feature]);
  say(!g.errors.length && !g.unsound.length && near(g.vol.C, Math.PI * 100 * 20, 1e-4), "a cylinder stretched 2 x 1 x 0.5 (an oval post)", `${g.errors.join(" | ")} ${g.unsound} ${g.vol.C}`);
  // move with rotation
  g = await build([...A, tf({ kind: "move", translate: [5, 6, 7], rotate: { origin: [1, 2, 3], axis: [1, 1, 1], angle: 123 } })]);
  say(!g.errors.length && !g.unsound.length && near(g.vol.A, 1000, 1e-6), "move and turn", `${g.errors.join(" | ")} ${g.unsound} ${g.vol.A}`);
}

// ---------------------------------------------------------------- split
{
  const A = block("A", 40, 30, 20);
  const planes: [string, PlaneDef, number][] = [
    ["across the middle", { origin: [20, 0, 0], xDir: [0, 1, 0], normal: [1, 0, 0] }, 0.5],
    ["a quarter up", { origin: [0, 0, 5], xDir: [1, 0, 0], normal: [0, 0, 1] }, 0.75],
    ["corner to corner (diagonal)", { origin: [0, 0, 0], xDir: [0, 0, 1], normal: [30 / 50, -40 / 50, 0] }, 0.5],
    ["on a face (nothing to split)", { origin: [40, 0, 0], xDir: [0, 1, 0], normal: [1, 0, 0] }, -1],
    ["past the body", { origin: [50, 0, 0], xDir: [0, 1, 0], normal: [1, 0, 0] }, -1],
    ["through one corner edge only", { origin: [0, 0, 0], xDir: [0, 0, 1], normal: [Math.SQRT1_2, Math.SQRT1_2, 0] }, -1],
  ];
  for (const [name, plane, share] of planes) {
    const g = await build([...A, { id: "S", name: "S", type: "split", body: "A", plane } as Feature]);
    if (share < 0) say(g.errors.length > 0 && /doesn't cut|Nothing/i.test(g.errors.join()), `split ${name}`, `${g.errors.join(" | ")} ${JSON.stringify(g.vol)}`);
    else say(!g.errors.length && !g.unsound.length && g.ids.length === 2 && near(g.vol.A + g.vol.S, 24000, 1e-6) && (near(g.vol.A, 24000 * share, 1e-6) || near(g.vol.S, 24000 * share, 1e-6)), `split ${name}`, `${g.errors.join(" | ")} ${g.unsound} ${JSON.stringify(g.vol)}`);
  }
  // A cylinder split through its axis, and off it.
  const C = cylinder("C", 10, 20);
  for (const [name, x, share] of [["through its axis", 0, 0.5], ["off its axis", 5, (Math.acos(0.5) - 0.5 * Math.sqrt(0.75)) / Math.PI]] as const) {
    const g = await build([...C, { id: "S", name: "S", type: "split", body: "C", plane: { origin: [x, 0, 0], xDir: [0, 1, 0], normal: [1, 0, 0] } } as Feature]);
    const V = Math.PI * 100 * 20;
    say(!g.errors.length && !g.unsound.length && g.ids.length === 2 && near(g.vol.C + g.vol.S, V, 1e-5) && (near(g.vol.C, V * share, 1e-4) || near(g.vol.S, V * share, 1e-4)), `split a cylinder ${name}`, `${g.errors.join(" | ")} ${g.unsound} ${JSON.stringify(g.vol)} want ${(V * share).toFixed(2)}`);
  }
  // several planes at once
  const g = await build([...A, { id: "S", name: "S", type: "split", body: "A", plane: { origin: [10, 0, 0], xDir: [0, 1, 0], normal: [1, 0, 0] }, planes: [{ origin: [30, 0, 0], xDir: [0, 1, 0], normal: [1, 0, 0] }, { origin: [0, 0, 10], xDir: [1, 0, 0], normal: [0, 0, 1] }] } as Feature]);
  say(!g.errors.length && !g.unsound.length && g.ids.length === 6 && near(Object.values(g.vol).reduce((a, b) => a + b, 0), 24000, 1e-6), "split by three planes at once: six pieces", `${g.errors.join(" | ")} ${g.unsound} ${g.ids.length} ${JSON.stringify(g.vol)}`);
}
done();
