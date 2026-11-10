// Run: node --expose-gc --import tsx tests/perf.test.ts (or npx tsx) - rebuild memory and speed on a long project.
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { regenerate } from "../src/kernel/engine";
import { arrangement, regionRef } from "../src/sketch/regions";
setOC(await (opencascade as unknown as () => Promise<any>)());
// A sketch with 20 000 points of spline (≈1.5 MB of JSON) first, then 120 small steps.
const big = { id: "big", name: "Sketch", type: "sketch", plane: { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] }, entities: [{ id: "sp", kind: "spline", closed: false, mode: "fit", points: Array.from({ length: 20000 }, (_, i) => [i * 0.001 + 100, Math.sin(i) * 0.001 + 100]) }] };
const es = [{ id: "r", kind: "rect", center: [0, 0], w: 40, h: 30, rotation: 0 }];
const fs: any[] = [big, { id: "sk", name: "S", type: "sketch", plane: big.plane, entities: es }, { id: "b", name: "E", type: "extrude", source: { kind: "profile", sketch: "sk", regions: arrangement(es as any).regions.map(regionRef) }, distance: 20, mode: "new" }];
for (let i = 0; i < 120; i++) fs.push({ id: `t${i}`, name: "T", type: "transform", bodies: ["b"], copy: false, op: { kind: "move", translate: [0.01, 0, 0] } });
(globalThis as any).gc?.();
const m0 = process.memoryUsage().heapUsed;
const t0 = performance.now();
await regenerate(fs);
const t1 = performance.now();
fs[fs.length - 1] = { ...fs[fs.length - 1], op: { kind: "move", translate: [0.02, 0, 0] } };
await regenerate(fs);
const t2 = performance.now();
global.gc?.();
const grew = (process.memoryUsage().heapUsed - m0) / 1e6;
// (Memory is only told after a collection: run without --expose-gc, what is
// measured is mostly garbage not yet collected - the speed is still checked.)
const collected = typeof (globalThis as any).gc === "function";
if (!collected) console.log("     (run with node --expose-gc --import tsx for the memory check)");
const ok = (!collected || grew < 25) && t2 - t1 < 500;
console.log(ok ? "ok  " : "FAIL", "long project with a big sketch first: rebuild cache stays small and quick");
console.log(`heap +${((process.memoryUsage().heapUsed - m0) / 1e6).toFixed(0)} MB; full rebuild ${(t1 - t0).toFixed(0)} ms; last step changed ${(t2 - t1).toFixed(0)} ms`);
process.exit(ok ? 0 : 1);
