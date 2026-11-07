// Run: npx tsx tests/closet.test.ts [out.json] - a flat-pack closet built the
// way it's made: every board its own body (two sides, top, bottom, plinth,
// three shelves, a hardboard back, two doors), 18 mm boards, 800 × 500 × 1800.
// Checked: each board is a clean solid of the right size, and no two boards
// overlap (they may touch, like boards screwed together).
import opencascade from "replicad-opencascadejs";
import { measureVolume, setOC } from "replicad";
import { writeFileSync } from "node:fs";
import { debugBodies, regenerate } from "../src/kernel/engine";
import { healthOf, isHealthy } from "../src/kernel/repair";
import { arrangement, regionRef } from "../src/sketch/regions";

setOC(await (opencascade as unknown as () => Promise<any>)());
let failed = 0;
const check = (name: string, ok: boolean, info = "") => {
  if (!ok) failed++;
  console.log(ok ? "ok  " : "FAIL", name, info);
};

const W = 800, D = 500, H = 1800, T = 18, BACK = 3, PLINTH = 80, GAP = 2;
const inner = W - 2 * T; // between the sides
const deep = D - BACK - T; // sides stop at the back panel; doors sit in front of them
/** A board: an x × y rectangle on a horizontal plane at height z, pushed up h. */
const boards: { id: string; name: string; x: number; y: number; z: number; w: number; d: number; h: number }[] = [
  { id: "sideL", name: "Left side", x: 0, y: T, z: 0, w: T, d: deep, h: H },
  { id: "sideR", name: "Right side", x: W - T, y: T, z: 0, w: T, d: deep, h: H },
  { id: "bottom", name: "Bottom", x: T, y: T, z: PLINTH, w: inner, d: deep, h: T },
  { id: "top", name: "Top", x: T, y: T, z: H - T, w: inner, d: deep, h: T },
  { id: "plinth", name: "Plinth", x: T, y: T + 20, z: 0, w: inner, d: T, h: PLINTH },
  ...[1, 2, 3].map((k) => {
    const z0 = PLINTH + T;
    const z = z0 + ((H - T - z0) / 4) * k - T / 2;
    return { id: `shelf${k}`, name: `Shelf ${k}`, x: T, y: T + 20, z: Math.round(z), w: inner, d: deep - 20, h: T };
  }),
  { id: "back", name: "Back", x: 0, y: T + deep, z: 0, w: W, d: BACK, h: H },
  { id: "doorL", name: "Left door", x: 0, y: 0, z: 0, w: W / 2 - GAP / 2, d: T, h: H },
  { id: "doorR", name: "Right door", x: W / 2 + GAP / 2, y: 0, z: 0, w: W / 2 - GAP / 2, d: T, h: H },
];

const feats: any[] = [];
for (const b of boards) {
  const es = [{ id: "r", kind: "rect", center: [b.x + b.w / 2, b.y + b.d / 2], w: b.w, h: b.d, rotation: 0 }];
  feats.push({ id: `sk-${b.id}`, name: `${b.name} sketch`, type: "sketch", plane: { origin: [0, 0, b.z], xDir: [1, 0, 0], normal: [0, 0, 1] }, entities: es });
  feats.push({ id: b.id, name: b.name, type: "extrude", source: { kind: "profile", sketch: `sk-${b.id}`, regions: arrangement(es as any).regions.map(regionRef) }, distance: b.h, mode: "new" });
}

const t0 = Date.now();
const r: any = await regenerate(feats);
const ms = Date.now() - t0;
check("every board builds", !r.errors.length, r.errors.map((e: any) => `${e.feature}: ${e.message}`).join("; "));
check("11 separate bodies", r.bodies.length === boards.length, `${r.bodies.length} bodies in ${ms} ms`);
const shapes = boards.map((b) => ({ b, s: debugBodies().get(b.id)! }));
const wrong = shapes.filter(({ b, s }) => !s || !isHealthy(healthOf(s)) || Math.abs(Math.abs(measureVolume(s)) - b.w * b.d * b.h) > 1e-3 * b.w * b.d * b.h);
check("each board a clean solid of its size", !wrong.length, wrong.map(({ b }) => b.name).join(", "));
const overlaps: string[] = [];
for (let i = 0; i < shapes.length; i++)
  for (let j = i + 1; j < shapes.length; j++) {
    const v = Math.abs(measureVolume((shapes[i].s as any).intersect(shapes[j].s)));
    if (v > 1e-3) overlaps.push(`${shapes[i].b.name} × ${shapes[j].b.name} (${v.toFixed(1)} mm³)`);
  }
check("no two boards overlap", !overlaps.length, overlaps.join("; "));
const all = shapes.map(({ s }) => s.boundingBox.bounds);
const lo = [0, 1, 2].map((k) => Math.min(...all.map((b) => b[0][k])));
const hi = [0, 1, 2].map((k) => Math.max(...all.map((b) => b[1][k])));
check("overall 800 × 500 × 1800", Math.abs(hi[0] - lo[0] - W) < 1e-6 && Math.abs(hi[1] - lo[1] - D) < 1e-6 && Math.abs(hi[2] - lo[2] - H) < 1e-6, `${(hi[0] - lo[0]).toFixed(1)} × ${(hi[1] - lo[1]).toFixed(1)} × ${(hi[2] - lo[2]).toFixed(1)}`);

// The same closet built through the tools on a phone-sized screen (tests/fixtures/closet-hand.json):
// one floor sketch (side, plinth, door), patterns for the right side, right door
// and bottom/shelves/top, a plane at 80 for the bottom, a move, the back panel.
{
  const { readFileSync } = await import("node:fs");
  const hand = JSON.parse(readFileSync(new URL("./fixtures/closet-hand.json", import.meta.url), "utf8"));
  const rh: any = await regenerate(hand);
  check("by hand: every step builds", !rh.errors.length, rh.errors.map((e: any) => `${e.feature}: ${e.message}`).join("; "));
  check("by hand: 11 separate bodies", rh.bodies.length === 11, `${rh.bodies.length}`);
  const hs = rh.bodies.map((b: any) => debugBodies().get(b.id)!);
  check("by hand: each a clean solid", hs.every((x: any) => isHealthy(healthOf(x))));
  const over: string[] = [];
  for (let i = 0; i < hs.length; i++)
    for (let j = i + 1; j < hs.length; j++) {
      const v = Math.abs(measureVolume(hs[i].intersect(hs[j])));
      if (v > 1e-3) over.push(`${i}×${j} ${v.toFixed(1)}`);
    }
  check("by hand: no two boards overlap", !over.length, over.join("; "));
  const bb = hs.map((x: any) => x.boundingBox.bounds);
  const l = [0, 1, 2].map((k) => Math.min(...bb.map((b: any) => b[0][k])));
  const h = [0, 1, 2].map((k) => Math.max(...bb.map((b: any) => b[1][k])));
  check("by hand: overall 800 × 500 × 1800", [W, D, H].every((v, k) => Math.abs(h[k] - l[k] - v) < 1e-6), `${(h[0] - l[0]).toFixed(1)} × ${(h[1] - l[1]).toFixed(1)} × ${(h[2] - l[2]).toFixed(1)}`);
  const total = (xs: any[]) => xs.reduce((a, x) => a + Math.abs(measureVolume(x)), 0);
  console.log(`     material: by code ${(total(shapes.map((x) => x.s)) / 1e6).toFixed(4)} dm³, by hand ${(total(hs) / 1e6).toFixed(4)} dm³ (by hand: shelves full depth, plinth at the front)`);
}

if (process.argv[2]) {
  const wood = "#c8a27a", white = "#e9e6df";
  writeFileSync(process.argv[2], JSON.stringify({
    format: "super", version: 2, name: "Closet", features: feats, variables: [], views: [], units: "mm",
    hidden: feats.filter((f) => f.type === "sketch").map((f) => f.id), pins: [],
    names: Object.fromEntries(boards.map((b) => [b.id, b.name])),
    colors: Object.fromEntries(boards.map((b) => [b.id, b.id === "back" ? white : wood])),
  }));
}
process.exit(failed ? 1 : 0);
