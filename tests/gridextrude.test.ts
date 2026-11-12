// Run: npx tsx tests/gridextrude.test.ts
// Extrudes of eleven outlines (a circle, a triangle, an L, a star, a ring, two
// circles apart, shapes flush with the face's edges) onto and into a block, in
// every mode - a body of its own, joined, cut to three depths and through all,
// pushed in, kept where both are, both sides, started above the face, with a
// draft either way, tapered - each held to its exact volume.
import { block, circle, done, extrude, poly, rect, sketch, XY } from "./kit";
import { build, near, say } from "./grid";
import type { Feature, SketchEntity } from "../src/doc/types";

const A = block("A", 60, 40, 20); // 0..60, 0..40, 0..20
const VA = 60 * 40 * 20;
const ngon = (n: number, r: number, cx: number, cy: number, turn = 0): [number, number][] => Array.from({ length: n }, (_, i) => [cx + r * Math.cos(turn + (i * 2 * Math.PI) / n), cy + r * Math.sin(turn + (i * 2 * Math.PI) / n)]);
const area = (pts: [number, number][]) => Math.abs(pts.reduce((s, p, i) => s + p[0] * pts[(i + 1) % pts.length][1] - pts[(i + 1) % pts.length][0] * p[1], 0)) / 2;
// name, entities, area, inside the top face?
const shapes: [string, SketchEntity[], number][] = [
  ["a circle", [circle("c", 30, 20, 8)], Math.PI * 64],
  ["a rectangle", [rect("r", 20, 10, 40, 30)], 400],
  ["a triangle", [poly("p", [[20, 10], [45, 12], [28, 32]])], area([[20, 10], [45, 12], [28, 32]])],
  ["a hexagon", [poly("p", ngon(6, 10, 30, 20))], area(ngon(6, 10, 30, 20))],
  ["an L", [poly("p", [[15, 8], [45, 8], [45, 18], [27, 18], [27, 32], [15, 32]])], area([[15, 8], [45, 8], [45, 18], [27, 18], [27, 32], [15, 32]])],
  ["a rectangle flush with two edges of the top", [rect("r", 0, 0, 20, 15)], 300],
  ["a rectangle across the whole top", [rect("r", 0, 0, 60, 40)], 2400],
  ["a circle touching an edge of the top from inside", [circle("c", 8, 20, 8)], Math.PI * 64],
  ["a ring (circle with a hole)", [circle("c", 30, 20, 12), circle("d", 30, 20, 6)], Math.PI * (144 - 36)],
  ["two separate circles", [circle("c", 15, 20, 6), circle("d", 45, 20, 6)], 2 * Math.PI * 36],
  ["a star", [poly("p", Array.from({ length: 10 }, (_, i) => { const r = i % 2 ? 5 : 12; const a = (i * Math.PI) / 5; return [30 + r * Math.cos(a), 20 + r * Math.sin(a)] as [number, number]; }))], area(Array.from({ length: 10 }, (_, i) => { const r = i % 2 ? 5 : 12; const a = (i * Math.PI) / 5; return [30 + r * Math.cos(a), 20 + r * Math.sin(a)] as [number, number]; }))],
];

for (const [name, es, ar] of shapes) {
  const s = sketch("s", XY(20), es);
  // the ring: only the ring region (not the inner disc)
  const src = (extra: object) => {
    const f = extrude("E", s, 10, "new", extra) as any;
    if (name.startsWith("a ring")) f.source.regions = f.source.regions.filter((r: any) => r.a > 200);
    return f as Feature;
  };
  const pieces = name.startsWith("two") ? 2 : 1;
  // (A ring cut right through leaves the plug in its middle loose: two pieces.)
  const through = name.startsWith("a ring") ? 2 : 1;
  let g = await build([...A, s, src({ mode: "new" })], { E: pieces });
  say(!g.errors.length && !g.unsound.length && near(g.vol.E, ar * 10, 2e-4), `${name}: new body`, `${g.errors.join(" | ")} ${g.unsound} got ${g.vol.E?.toFixed(2)} want ${(ar * 10).toFixed(2)}`);
  g = await build([...A, s, src({ mode: "join", target: "A" })]);
  say(!g.errors.length && !g.unsound.length && g.ids.length === 1 && near(g.vol.A, VA + ar * 10, 2e-4), `${name}: joined onto the top`, `${g.errors.join(" | ")} ${g.unsound} ${g.ids} got ${g.vol.A?.toFixed(2)} want ${(VA + ar * 10).toFixed(2)}`);
  g = await build([...A, s, src({ mode: "auto", target: "A" })]);
  say(!g.errors.length && !g.unsound.length && g.ids.length === 1 && near(g.vol.A, VA + ar * 10, 2e-4), `${name}: auto, pulled up`, `${g.errors.join(" | ")} ${g.unsound} ${g.ids} got ${g.vol.A?.toFixed(2)} want ${(VA + ar * 10).toFixed(2)}`);
  for (const depth of [5, 20, 30]) {
    g = await build([...A, s, src({ mode: "cut", target: "A", distance: -depth })], { A: depth >= 20 ? through : 1 });
    const want = VA - ar * Math.min(depth, 20);
    if (want < 1e-6) say(g.errors.length > 0 || !g.ids.includes("A"), `${name}: cut ${depth} deep (all of it)`, `${g.errors.join(" | ")} ${JSON.stringify(g.vol)}`);
    else say(!g.errors.length && !g.unsound.length && near(g.vol.A, want, 2e-4), `${name}: cut ${depth} deep`, `${g.errors.join(" | ")} ${g.unsound} got ${g.vol.A?.toFixed(2)} want ${want.toFixed(2)}`);
  }
  g = await build([...A, s, src({ mode: "auto", target: "A", distance: -5 })]);
  say(!g.errors.length && !g.unsound.length && near(g.vol.A, VA - ar * 5, 2e-4), `${name}: auto, pushed in 5`, `${g.errors.join(" | ")} ${g.unsound} got ${g.vol.A?.toFixed(2)} want ${(VA - ar * 5).toFixed(2)}`);
  g = await build([...A, s, src({ mode: "cut", target: "A", extent: "through", distance: -1 })], { A: through });
  if (name.includes("whole top")) say(g.errors.length > 0 || !g.ids.includes("A"), `${name}: cut through all (all of it)`, `${g.errors.join(" | ")} ${JSON.stringify(g.vol)}`);
  else say(!g.errors.length && !g.unsound.length && near(g.vol.A, VA - ar * 20, 2e-4), `${name}: cut through all`, `${g.errors.join(" | ")} ${g.unsound} got ${g.vol.A?.toFixed(2)} want ${(VA - ar * 20).toFixed(2)}`);
  g = await build([...A, s, src({ mode: "intersect", target: "A", distance: -8 })], { A: pieces });
  say(!g.errors.length && !g.unsound.length && near(g.vol.A, ar * 8, 2e-4), `${name}: intersect, 8 down`, `${g.errors.join(" | ")} ${g.unsound} ${JSON.stringify(g.vol)} want ${(ar * 8).toFixed(2)}`);
  g = await build([...A, s, src({ mode: "new", symmetric: true, distance: 6 })], { E: pieces });
  say(!g.errors.length && !g.unsound.length && near(g.vol.E, ar * 12, 2e-4), `${name}: new, both sides`, `${g.errors.join(" | ")} ${g.unsound} got ${g.vol.E?.toFixed(2)} want ${(ar * 12).toFixed(2)}`);
  g = await build([...A, s, src({ mode: "new", start: 5 })], { E: pieces });
  say(!g.errors.length && !g.unsound.length && near(g.vol.E, ar * 10, 2e-4), `${name}: new, starting 5 above`, `${g.errors.join(" | ")} ${g.unsound} got ${g.vol.E?.toFixed(2)} want ${(ar * 10).toFixed(2)}`);
  for (const draft of [5, -5]) {
    g = await build([...A, s, src({ mode: "new", draft })], { E: pieces });
    say(!g.errors.length && !g.unsound.length && g.vol.E > ar * 10 * 0.5 && g.vol.E < ar * 10 * 1.6 && (draft > 0 ? g.vol.E < ar * 10 : g.vol.E > ar * 10), `${name}: new, draft ${draft}`, `${g.errors.join(" | ")} ${g.unsound} got ${g.vol.E?.toFixed(2)} straight ${(ar * 10).toFixed(2)}`);
  }
  g = await build([...A, s, src({ mode: "new", taper: 0.5 })], { E: pieces });
  // a frustum-like solid: h/3 (A0 + A1 + sqrt(A0 A1)) with A1 = A0/4 -> 10/3 * A0 * 1.75
  if (!name.startsWith("a ring") && !name.startsWith("two")) say(!g.errors.length && !g.unsound.length && near(g.vol.E, (10 / 3) * ar * 1.75, 2e-3), `${name}: new, tapered to 50%`, `${g.errors.join(" | ")} ${g.unsound} got ${g.vol.E?.toFixed(2)} want ${((10 / 3) * ar * 1.75).toFixed(2)}`);
}
done();
