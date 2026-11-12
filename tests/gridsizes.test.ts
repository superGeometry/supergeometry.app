// Run: npx tsx tests/gridsizes.test.ts
// The same small part built at six sizes, from a hundredth of its size (a
// block 0.4 mm long, its walls 15 microns) to a thousand times (40 metres): a hole, rounds, a
// face pulled, a boss, a chamfer, a pocket, its floor rounded, a shell, a
// split, a pattern joined - and a ring revolved, a loft, a sweep and a bridge.
// Every step must work at every size, and the volumes scale as the cube.
import { circle, done, extrude, profile, rect, sketch, XY, XZ } from "./kit";
import { build, edgeRefs, faceRef, near, say } from "./grid";
import type { Feature, Vec3 } from "../src/doc/types";

const sizes = [0.01, 0.1, 1, 10, 100, 1000];
const results = new Map<string, Map<number, number | string>>();
const note = (step: string, k: number, v: number | string) => (results.get(step) ?? results.set(step, new Map()).get(step)!).set(k, v);

for (const k of sizes) {
  const s0 = sketch("s0", XY(), [rect("r", 0, 0, 40 * k, 30 * k)]);
  let fs: Feature[] = [s0, extrude("A", s0, 20 * k)];
  const step = async (name: string, add: () => Feature[] | Promise<Feature[]>, body = "A") => {
    let extra: Feature[];
    try {
      extra = await add();
    } catch (e) {
      note(name, k, "refs: " + String((e as Error).message ?? e).slice(0, 60));
      return;
    }
    const g = await build([...fs, ...extra], { T: 0 });
    if (g.errors.length) note(name, k, g.errors.join(" | ").slice(0, 90));
    else if (g.unsound.filter((u) => !u.startsWith("T:")).length) note(name, k, "unsound: " + g.unsound.join(", "));
    else {
      note(name, k, g.vol[body] / k ** 3);
      fs = [...fs, ...extra];
    }
    await build(fs);
  };
  await build(fs);
  await step("block", () => []);
  await step("a round hole through", () => { const s = sketch("s1", XY(20 * k), [circle("c", 20 * k, 15 * k, 5 * k)]); return [s, extrude("h", s, -20 * k, "cut", { target: "A" })]; });
  await step("fillet the four upright edges", () => [{ id: "F", name: "F", type: "fillet", edges: edgeRefs("A", (m, d, e) => Math.abs(d[2]) > 0.99 && e.geomType === "LINE" && (Math.abs(m[0]) < 1e-6 * k || Math.abs(m[0] - 40 * k) < 1e-6 * k)), radius: 4 * k } as Feature]);
  await step("pull the top up", () => [{ id: "P", name: "P", type: "extrude", source: { kind: "face", face: faceRef("A", (n) => n[2] > 0.99) }, distance: 5 * k, mode: "auto", target: "A" } as Feature]);
  await step("a boss on top", () => { const s = sketch("s2", XY(25 * k), [circle("c", 10 * k, 15 * k, 3 * k)]); return [s, extrude("b", s, 6 * k, "join", { target: "A" })]; });
  await step("chamfer the boss's rim", () => [{ id: "C", name: "C", type: "chamfer", edges: edgeRefs("A", (m, d, e) => e.geomType === "CIRCLE" && Math.abs(m[2] - 31 * k) < 1e-6 * k), radius: 1 * k } as Feature]);
  await step("a pocket", () => { const s = sketch("s3", XY(25 * k), [rect("r", 27 * k, 4 * k, 35 * k, 10 * k)]); return [s, extrude("p", s, -8 * k, "cut", { target: "A" })]; });
  await step("fillet the pocket's floor edges", () => [{ id: "F2", name: "F2", type: "fillet", edges: edgeRefs("A", (m, d) => Math.abs(m[2] - 17 * k) < 1e-6 * k && Math.abs(d[2]) < 0.01), radius: 1 * k } as Feature]);
  await step("shell, bottom open", () => [{ id: "S", name: "S", type: "shell", body: "A", faces: [faceRef("A", (n) => n[2] < -0.99)], thickness: 1.5 * k } as Feature]);
  await step("split in two", () => [{ id: "X", name: "X", type: "split", body: "A", plane: { origin: [20 * k, 0, 0], xDir: [0, 1, 0], normal: [1, 0, 0] } } as Feature]);
  await step("a pattern of three, joined", () => [
    { id: "T", name: "T", type: "transform", bodies: ["X"], copy: false, op: { kind: "linear", dir: [0, 1, 0], spacing: 25 * k, count: 3 } } as Feature,
    { id: "U", name: "U", type: "boolean", op: "union", target: "X", tools: ["T:X:0", "T:X:1"] } as Feature,
  ], "X");
}
// Separate small things at each size.
for (const k of sizes) {
  const zAxis = { origin: [0, 0, 0] as Vec3, dir: [0, 0, 1] as Vec3 };
  let es: any[] = [rect("r", 10 * k, 0, 20 * k, 8 * k)];
  let g = await build([sketch("s", XZ(), es), { id: "R", name: "R", type: "revolve", source: profile("s", es), axis: zAxis, angle: 360, mode: "new" } as Feature]);
  note("revolve a ring", k, g.errors.length ? g.errors.join(" | ").slice(0, 80) : g.unsound.length ? "unsound: " + g.unsound : g.vol.R / k ** 3);
  const a = [circle("c", 0, 0, 10 * k)], b = [rect("r", -6 * k, -6 * k, 6 * k, 6 * k)];
  g = await build([sketch("s1", XY(0), a), sketch("s2", XY(30 * k), b), { id: "L", name: "L", type: "loft", sections: [profile("s1", a), profile("s2", b)], ruled: false, mode: "new" } as Feature]);
  note("loft a circle to a square", k, g.errors.length ? g.errors.join(" | ").slice(0, 80) : g.unsound.length ? "unsound: " + g.unsound : g.vol.L / k ** 3);
  const p = [circle("c", 0, 0, 3 * k)];
  const q = [{ id: "sp", kind: "spline", points: [[0, 0], [2 * k, 15 * k], [15 * k, 30 * k], [35 * k, 35 * k]], closed: false, mode: "fit" } as any];
  g = await build([sketch("sp", XY(0), p), sketch("sq", XZ(), q), { id: "W", name: "W", type: "sweep", source: profile("sp", p), path: { kind: "sketch", sketch: "sq", entities: ["sp"] }, mode: "new" } as Feature]);
  note("sweep a circle along a spline", k, g.errors.length ? g.errors.join(" | ").slice(0, 80) : g.unsound.length ? "unsound: " + g.unsound : g.vol.W / k ** 3);
  // Connect two blocks
  const sa = sketch("sa", XY(), [rect("r", 0, 0, 20 * k, 20 * k)]), sb = sketch("sb", XY(50 * k), [rect("r", 30 * k, 0, 50 * k, 20 * k)]);
  const two = [sa, extrude("A", sa, 10 * k), sb, extrude("B", sb, 10 * k)];
  await build(two);
  try {
    const fa = faceRef("A", (n) => n[2] > 0.99), fb = faceRef("B", (n) => n[2] < -0.99);
    g = await build([...two, { id: "cn", name: "cn", type: "connect", faces: [fa, fb], mode: "join" } as Feature]);
    note("connect two blocks", k, g.errors.length ? g.errors.join(" | ").slice(0, 80) : g.unsound.length ? "unsound: " + g.unsound : g.vol.A / k ** 3);
  } catch (e) { note("connect two blocks", k, String(e).slice(0, 60)); }
}
for (const [step, m] of results) {
  const ref = m.get(1);
  for (const k of sizes) {
    const v = m.get(k);
    const ok = typeof v === "number" && typeof ref === "number" && near(v, ref, 2e-4);
    say(ok, `${step} at x${k}`, typeof v === "number" ? `${v.toFixed(3)} per unit cube, at x1: ${typeof ref === "number" ? ref.toFixed(3) : ref}` : String(v));
  }
}
done();
