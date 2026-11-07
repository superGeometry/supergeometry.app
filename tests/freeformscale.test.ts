// Run: npx tsx tests/freeformscale.test.ts
//
// Scaling freeforms pushed hard: cage points scaled in the card (all of them,
// half, one face's, one point) by tiny, huge and lopsided factors, and whole
// freeform bodies scaled (uniform and per axis, copies too). A scale may be
// refused with a message; one that's accepted must give a valid closed solid
// (a clean sheet for a surface) - and, for the whole shape, exactly that size.
import opencascade from "replicad-opencascadejs";
import { measureVolume, setOC } from "replicad";
import { debugBodies, regenerate, shapeValid } from "../src/kernel/engine";
import { boxCage, cylinderCage, moveTurnScale, planeCage, refineCage, sphereCage, type Cage } from "../src/freeform/cage";
import type { Vec3 } from "../src/doc/types";

setOC(await (opencascade as unknown as () => Promise<any>)());
let failed = 0;
let checks = 0;
const check = (name: string, ok: boolean, info = "") => {
  checks++;
  if (!ok) {
    failed++;
    console.log("FAIL", name, info);
  }
};

const cages: [string, Cage, boolean][] = [
  ["box", boxCage([40, 30, 20], 2, [0, 0, 10]), true],
  ["sphere", sphereCage(30, [0, 0, 15]), true],
  ["cylinder", cylinderCage(20, 40, 2, [0, 0, 20]), true],
  ["refined box", refineCage(boxCage([40, 30, 20], 1, [10, 5, 30])), true],
  ["sheet", planeCage([50, 40], 3, [0, 0, 0]), false],
];
const factors: [number, number, number, number][] = [
  [1, 1, 1, 0.01],
  [1, 1, 1, 0.1],
  [1, 1, 1, 0.5],
  [1, 1, 1, 2],
  [1, 1, 1, 10],
  [1, 1, 1, 100],
  [0.01, 1, 1, 1],
  [1, 0.02, 1, 1],
  [1, 1, 0.01, 1],
  [5, 0.2, 1, 1],
  [0.3, 3, 7, 1],
  [2, 2, 0.5, 0.5],
];
const box = (id: string) => (debugBodies().get(id) as any).boundingBox;
const size = (b: any) => [b.width, b.height, b.depth];

async function build(cage: Cage, surface: boolean, extra: any[] = []) {
  const f = { id: "ff", name: "ff", type: "freeform", cage, ...(surface ? { surface: true } : {}) };
  const t0 = Date.now();
  const r: any = await regenerate([f, ...extra] as any);
  return { r, ms: Date.now() - t0 };
}

let slowest = { ms: 0, what: "" };
for (const [name, cage0, closed] of cages) {
  const base = await build(cage0, !closed);
  check(`${name}: builds`, !base.r.errors.length, base.r.errors.map((e: any) => e.message).join("; "));
  const s0 = size(box("ff"));
  const n = cage0.verts.length;
  // Points picked: all, half (by x), one face's corners, one point.
  const picks: [string, number[]][] = [
    ["all points", cage0.verts.map((_, i) => i)],
    ["half", cage0.verts.flatMap((v, i) => (v[0] > 0 ? [i] : []))],
    ["one face", [...cage0.faces[0]]],
    ["one point", [Math.floor(n / 2)]],
  ];
  for (const [what, ids] of picks) {
    for (const k of factors) {
      const moved = moveTurnScale(ids.map((i) => cage0.verts[i]), "scale", k);
      const cage: Cage = { faces: cage0.faces, verts: cage0.verts.map((v) => [...v] as Vec3) };
      ids.forEach((i, j) => (cage.verts[i] = moved[j]));
      const tag = `${name}, ${what}, scale ${k.join("/")}`;
      let res;
      try {
        res = await build(cage, !closed);
      } catch (e) {
        check(`${tag}: no crash`, false, String(e));
        continue;
      }
      if (res.ms > slowest.ms) slowest = { ms: res.ms, what: tag };
      if (res.r.errors.length) {
        // Refused: it has to say why.
        check(`${tag}: refused with a message`, res.r.errors.every((e: any) => typeof e.message === "string" && e.message.length > 10), JSON.stringify(res.r.errors));
        continue;
      }
      const b: any = debugBodies().get("ff");
      check(`${tag}: valid`, !!b && shapeValid(b));
      if (closed) check(`${tag}: a solid with volume`, !!b && measureVolume(b) > 0, b ? String(measureVolume(b)) : "");
      // Every point scaled together: the shape is exactly that much bigger.
      if (what === "all points") {
        const s = size(box("ff"));
        const want = [k[0] * k[3], k[1] * k[3], k[2] * k[3]];
        const ok = [0, 1, 2].every((a) => s0[a] < 1e-6 || Math.abs(s[a] / s0[a] - want[a]) < Math.max(0.02 * want[a], 1e-3 / s0[a]));
        check(`${tag}: the whole shape scales by the factors`, ok, `${s.map((x: number) => x.toFixed(3))} vs ${s0.map((x: number, a: number) => (x * want[a]).toFixed(3))}`);
      }
    }
  }
  // The whole body scaled as a step (uniform, and per axis), with copies too.
  for (const [kind, op] of [
    ["uniform ×0.05", { kind: "scale", center: [0, 0, 0], factor: 0.05 }],
    ["uniform ×20", { kind: "scale", center: [0, 0, 0], factor: 20 }],
    ["per axis 3/0.1/1", { kind: "scaleXYZ", center: [0, 0, 0], factors: [3, 0.1, 1] }],
    ["per axis 0.01/1/50", { kind: "scaleXYZ", center: [5, 5, 5], factors: [0.01, 1, 50] }],
  ] as const) {
    for (const copy of [false, true]) {
      const tf = { id: "t", name: "t", type: "transform", bodies: ["ff"], copy, op };
      const tag = `${name}: body ${kind}${copy ? " (copy)" : ""}`;
      const res = await build(cage0, !closed, [tf]);
      if (res.r.errors.length) {
        check(`${tag}: refused with a message`, res.r.errors.every((e: any) => e.message?.length > 10), JSON.stringify(res.r.errors));
        continue;
      }
      const id = copy ? "t:ff:0" : "ff";
      const b: any = debugBodies().get(id);
      check(`${tag}: there`, !!b, res.r.bodies.map((x: any) => x.id).join(","));
      if (!b) continue;
      check(`${tag}: valid`, shapeValid(b));
      const s = size(box(id));
      const want = op.kind === "scale" ? [op.factor, op.factor, op.factor] : op.factors;
      check(`${tag}: that size`, [0, 1, 2].every((a) => s0[a] < 1e-6 || Math.abs(s[a] / s0[a] - want[a]) < 0.02 * want[a] + 1e-6), `${s.map((x: number) => x.toFixed(3))}`);
      if (copy) check(`${tag}: the original stays`, debugBodies().has("ff") && Math.abs(size(box("ff"))[0] - s0[0]) < 1e-6);
    }
  }
}
console.log(`${checks} checks, ${failed} failed; slowest ${slowest.ms} ms (${slowest.what})`);
process.exit(failed ? 1 : 0);
