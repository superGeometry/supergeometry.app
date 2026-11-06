// Run: npx tsx tests/ruler.test.ts [out.json] — a 160 × 30 × 3 mm ruler, 0–15 cm,
// with its scale cut into the top: a tick every mm (4 mm long, 6 at each half
// centimetre, 9 at each centimetre, 0.3 wide) and the numbers 0–15, engraved
// 0.6 mm deep. The text is the app's own (same font, same layout).
import opencascade from "replicad-opencascadejs";
import { measureVolume, setOC } from "replicad";
import { readFileSync, writeFileSync } from "node:fs";
import opentype from "opentype.js";
const { parse } = opentype as any;
import { debugBodies, regenerate } from "../src/kernel/engine";
import { healthOf, isHealthy } from "../src/kernel/repair";
import { arrangement, materialRegions, regionRef } from "../src/sketch/regions";
import { textOutlines } from "../src/sketch/textLayout";

setOC(await (opencascade as unknown as () => Promise<any>)());
let failed = 0;
const check = (name: string, ok: boolean, info = "") => {
  if (!ok) failed++;
  console.log(ok ? "ok  " : "FAIL", name, info);
};

const L = 160, W = 30, T = 3, DEPTH = 0.6, ZERO = 5, CM = 15, TICK = 0.3, TEXT = 3.5;
const buf = readFileSync(new URL("../node_modules/@fontsource/roboto/files/roboto-latin-400-normal.woff", import.meta.url));
const font = parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

const bar = [{ id: "bar", kind: "rect", center: [L / 2, W / 2], w: L, h: W, rotation: 0 }];
const marks: any[] = [];
for (let mm = 0; mm <= CM * 10; mm++) {
  const len = mm % 10 === 0 ? 9 : mm % 5 === 0 ? 6 : 4;
  marks.push({ id: `t${mm}`, kind: "rect", center: [ZERO + mm, W - len / 2], w: TICK, h: len, rotation: 0 });
}
for (let cm = 0; cm <= CM; cm++) {
  // Centred under its tick (the Text tool's Align: Centre).
  const ns = textOutlines(font, String(cm), [ZERO + cm * 10, W - 9 - 1.5 - TEXT], TEXT, 0, "center");
  const xs = ns.flatMap((e: any) => e.points.map((p: number[]) => p[0]));
  if (Math.abs((Math.min(...xs) + Math.max(...xs)) / 2 - (ZERO + cm * 10)) > 1e-9) check(`${cm} centred on its tick`, false);
  marks.push(...ns.map((e: any, i: number) => ({ ...e, id: `n${cm}-${i}` })));
}

// The regions to cut: every shape, holes left (the app's own "All shapes").
const t0 = Date.now();
const regions = materialRegions(arrangement(marks));
const area = regions.reduce((a: number, r: any) => a + r.area, 0);
const XY = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] };
const TOP = { origin: [0, 0, T], xDir: [1, 0, 0], normal: [0, 0, 1] };
const feats: any[] = [
  { id: "s1", name: "Ruler outline", type: "sketch", plane: XY, entities: bar },
  { id: "ruler", name: "Ruler", type: "extrude", source: { kind: "profile", sketch: "s1", regions: arrangement(bar as any).regions.map(regionRef) }, distance: T, mode: "new" },
  { id: "s2", name: "Scale", type: "sketch", plane: TOP, entities: marks },
  { id: "engrave", name: "Engrave", type: "extrude", source: { kind: "profile", sketch: "s2", regions: regions.map(regionRef) }, distance: -DEPTH, mode: "cut", target: "ruler" },
];
const r: any = await regenerate(feats);
const ms = Date.now() - t0;
const s = debugBodies().get("ruler")!;
check("every step builds", !r.errors.length, r.errors.map((e: any) => `${e.feature}: ${e.message}`).join("; "));
check("one clean solid", r.bodies.length === 1 && isHealthy(healthOf(s)), `${r.bodies.length} bodies, ${ms} ms, ${s.faces.length} faces`);
const removed = L * W * T - Math.abs(measureVolume(s));
check("exactly the scale's area × 0.6 mm taken away", Math.abs(removed - area * DEPTH) < area * DEPTH * 1e-3, `${removed.toFixed(3)} mm³ vs ${(area * DEPTH).toFixed(3)} (${regions.length} shapes, ${area.toFixed(1)} mm²)`);
check("151 ticks and 16 numbers cut", regions.length >= 151 + 16, `${regions.length} regions`);
const bb = s.boundingBox.bounds;
check("still 160 × 30 × 3", Math.abs(bb[1][0] - bb[0][0] - L) < 1e-6 && Math.abs(bb[1][1] - bb[0][1] - W) < 1e-6 && Math.abs(bb[1][2] - bb[0][2] - T) < 1e-6);

if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify({ format: "super", version: 2, name: "Ruler", features: feats, variables: [], views: [], units: "mm", hidden: ["s1", "s2"], pins: [], names: { ruler: "Ruler" } }));
process.exit(failed ? 1 : 0);
