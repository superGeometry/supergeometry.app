// Run: npx tsx tests/harden.test.ts
// The engine against what it can't be asked: a step whose saved values are
// broken (a damaged file), sizes with six noughts too many, and the engine
// itself breaking down (out of memory) - refused in words, quickly, with the
// project still there afterwards.
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { isFault, KernelFault, regenerate, withFreshKernel } from "../src/kernel/engine";
import { arrangement, regionRef } from "../src/sketch/regions";
import type { Feature, PlaneDef } from "../src/doc/types";

const load = async () => setOC(await (opencascade as unknown as () => Promise<any>)());
await load();
let failed = 0;
const check = (name: string, ok: boolean, info = "") => {
  if (!ok) failed++;
  console.log(ok ? "ok  " : "FAIL", name, info);
};
const XY: PlaneDef = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] };
const rect = [{ id: "r", kind: "rect", center: [0, 0], w: 40, h: 30, rotation: 0 }];
const sketch = { id: "s", name: "s", type: "sketch", plane: XY, entities: rect } as Feature;
const box = { id: "A", name: "A", type: "extrude", source: { kind: "profile", sketch: "s", regions: arrangement(rect as any).regions.map(regionRef) }, distance: 20, mode: "new" } as Feature;
const top = { body: "A", center: [0, 0, 20], normal: [0, 0, 1], area: 1200, step: "A" };
const WORDS = /undefined|\bNaN\b|\bnull\b|is not|Cannot read|Standard_|BRep|exception/i;

async function errorOf(fs: Feature[], id: string): Promise<{ text: string; ms: number; bodies: number }> {
  const t0 = performance.now();
  const r: any = await regenerate(fs);
  return { text: r.errors.find((e: any) => e.featureId === id)?.message ?? "", ms: performance.now() - t0, bodies: r.bodies.length };
}

// Broken values: each refused as damaged, at once, the body before it untouched.
{
  const shell = (faces: any): Feature => ({ id: "x", name: "x", type: "shell", body: "A", faces, thickness: 2 }) as Feature;
  const cases: [string, Feature][] = [
    ["a face's direction that is an empty list", shell([{ ...top, normal: [] }])],
    ["a face's middle with a number missing", shell([{ ...top, center: [0, null, 20] }])],
    ["a face's direction that is nothing", shell([{ ...top, normal: null }])],
    ["a plane with no origin", { id: "x", name: "x", type: "plane", plane: { ...XY, origin: null } } as unknown as Feature],
    ["a move by something that isn't three numbers", { id: "x", name: "x", type: "transform", bodies: ["A"], op: { kind: "move", translate: [5] } } as unknown as Feature],
    ["tools that aren't a list", { id: "x", name: "x", type: "boolean", op: "union", target: "A", tools: null } as unknown as Feature],
  ];
  for (const [name, f] of cases) {
    const e = await errorOf([sketch, box, f], "x");
    check(`${name}: refused in words, at once`, !!e.text && !WORDS.test(e.text) && e.ms < 5000 && e.bodies === 1, `"${e.text}" ${e.ms.toFixed(0)} ms, ${e.bodies} bodies`);
  }
}

// A typo of a size: refused (it used to run the engine out of memory showing it).
{
  let e = await errorOf([sketch, { ...box, distance: 1e9 } as Feature], "A");
  check("an extrude a billion mm long: refused as too far", /10 km/.test(e.text) && e.ms < 5000, `"${e.text}" ${e.ms.toFixed(0)} ms`);
  const far: Feature = { id: "x", name: "x", type: "transform", bodies: ["A"], op: { kind: "move", translate: [0, 5e8, 0] } } as unknown as Feature;
  e = await errorOf([sketch, box, far], "x");
  check("a body moved 500 km away: refused, the body where it was", /10 km/.test(e.text) && e.bodies === 1, `"${e.text}"`);
  const speck: Feature = { id: "x", name: "x", type: "transform", bodies: ["A"], op: { kind: "scale", center: [0, 0, 0], factor: 8e-7 } } as unknown as Feature;
  e = await errorOf([sketch, box, speck], "x");
  check("a body scaled to a millionth: refused, the body as it was", /smaller than/.test(e.text) && e.bodies === 1, `"${e.text}"`);
  const big = { ...sketch, entities: [{ id: "c", kind: "circle", center: [0, 0], radius: 2e6 }] } as Feature;
  const disc = { id: "A", name: "A", type: "extrude", source: { kind: "profile", sketch: "s", regions: arrangement(big.type === "sketch" ? (big.entities as any) : []).regions.map(regionRef) }, distance: 1000, mode: "new" } as Feature;
  const t0 = performance.now();
  const r: any = await regenerate([big, disc]);
  const tris = (r.bodies[0]?.indices.length ?? 0) / 3;
  check("a disc 4 km across: shown, with a mesh of a sane size", !r.errors.length && tris > 0 && tris < 200000 && performance.now() - t0 < 10000, `${r.errors.map((x: any) => x.message)} ${tris} triangles, ${(performance.now() - t0).toFixed(0)} ms`);
}

// The engine breaking down: told apart from a step that can't be done, a fresh engine, and once more.
{
  check("an engine fault is told apart from a refusal", isFault(new WebAssembly.RuntimeError("memory access out of bounds")) && isFault(new KernelFault("x")) && !isFault(new Error("That fillet doesn't fit here")) && !isFault(new TypeError("x is not iterable")));
  let loads = 0;
  let tries = 0;
  const r: any = await withFreshKernel(
    async () => (loads++, await load()),
    async () => {
      if (tries++ === 0) throw new WebAssembly.RuntimeError("memory access out of bounds");
      return regenerate([sketch, box]);
    },
  );
  check("after a fault: the engine loaded afresh, the rebuild done again", loads === 1 && tries === 2 && r.bodies.length === 1 && !r.errors.length, `${loads} loads, ${tries} tries`);
  let gaveUp = "";
  try {
    await withFreshKernel(load, async () => {
      throw new WebAssembly.RuntimeError("unreachable");
    });
  } catch (err) {
    gaveUp = String((err as Error).message);
  }
  check("a rebuild that breaks every fresh engine: given up on (not tried for ever)", !!gaveUp, gaveUp);
  const after: any = await regenerate([sketch, box]);
  check("...and the engine still works after", after.bodies.length === 1 && !after.errors.length);
}

process.exit(failed ? 1 : 0);
