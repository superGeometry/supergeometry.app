// Run: npx tsx tests/outline.test.ts
// A lid's lip drawn as offsets of the face outline (2 and 4 mm in from the
// edge of the lid's underside): when the lid is made bigger, the lip follows
// the edge - the offsets are made from the face as it is, on every rebuild.
import opencascade from "replicad-opencascadejs";
import { setOC, measureVolume } from "replicad";
import { debugBodies, regenerate } from "../src/kernel/engine";
import { resolveDoc } from "../src/doc/params";
import { arrangement, regionRef } from "../src/sketch/regions";
setOC(await (opencascade as unknown as () => Promise<any>)());

const XY = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] };
const DOWN = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, -1] };
let failed = 0;
const check = (name: string, ok: boolean, info = "") => {
  if (!ok) failed++;
  console.log(ok ? "ok  " : "FAIL", name, info);
};
const vol = (id: string) => Math.abs(measureVolume(debugBodies().get(id) as any));

const rect = [{ id: "r", kind: "rect", center: [0, 0], w: 80, h: 50, rotation: 0 }];
const lid = (W: string, cornerR = 6) => {
  const doc: any = {
    variables: [{ name: "W", expr: W }],
    features: [
      { id: "s1", name: "Sketch 01", type: "sketch", plane: XY, entities: rect, constraints: [], exprs: { "entities.0.w": "W" } },
      { id: "lid", name: "Extrude 01", type: "extrude", source: { kind: "profile", sketch: "s1", regions: arrangement(rect as any).regions.map(regionRef) }, distance: 3, mode: "new" },
      { id: "f1", name: "Fillet 01", type: "fillet", radius: cornerR, edges: [[40, 25], [-40, 25], [40, -25], [-40, -25]].map(([x, y]) => ({ body: "lid", mid: [x, y, 1.5], dir: [0, 0, 1], length: 3, steps: ["lid"] })) },
      // On the underside: the outline offset 2 and 4 mm in, the ring between them the lip.
      { id: "s2", name: "Sketch 02", type: "sketch", plane: DOWN, attachedTo: { body: "lid", center: [0, 0, 0], normal: [0, 0, -1], area: 4000, step: "lid" }, entities: [], constraints: [], outlineOffsets: [{ id: "a", distance: -2, at: [40, 0] }, { id: "b", distance: -4, at: [40, 0] }] },
    ],
  };
  return doc;
};

// The lip's ring as the app would pick it: from the sketch's curves after a rebuild.
let doc = lid("80");
resolveDoc(doc);
let r: any = await regenerate(doc.features);
const curves = r.sketchBoundaries.s2 as any[];
const links = curves.filter((e) => e.id.startsWith("lnk-"));
check("the two offsets of the outline are made (lines and corner arcs)", links.filter((e) => e.id.startsWith("lnk-a-")).length === 8 && links.filter((e) => e.id.startsWith("lnk-b-")).length === 8, links.map((e) => `${e.id}:${e.kind}`).join(" "));
const ring = arrangement(curves).regions.find((g) => g.curves.some((c) => c.startsWith("lnk-a")) && g.curves.some((c) => c.startsWith("lnk-b")));
check("…with a ring between them", !!ring, `${ring?.area.toFixed(1)}`);
doc.features.push({ id: "lip", name: "Extrude 02", type: "extrude", source: { kind: "profile", sketch: "s2", regions: [regionRef(ring!)] }, distance: 4, mode: "join", target: "lid" });

const ringArea = (W: number, R: number) => {
  // Rounded rectangle W x 50 with corner R, offset in by d: (W-2d) x (50-2d), corners R-d.
  const rr = (d: number) => (W - 2 * d) * (50 - 2 * d) - (4 - Math.PI) * (R - d) ** 2;
  return rr(2) - rr(4);
};
for (const W of [80, 120, 50]) {
  const d = JSON.parse(JSON.stringify(doc));
  d.variables[0].expr = String(W);
  resolveDoc(d);
  r = await regenerate(d.features);
  const want = W * 50 * 3 - (4 - Math.PI) * 36 * 3 + ringArea(W, 6) * 4;
  check(`lid ${W} wide: the lip follows the edge, 2 mm in all round`, !r.errors.length && Math.abs(vol("lid") - want) < 0.5, `${r.errors.map((e: any) => e.message).join()} ${vol("lid").toFixed(1)} want ${want.toFixed(1)}`);
}
// The corners made rounder: the lip's corners follow too.
const d = JSON.parse(JSON.stringify(doc));
d.features.find((f: any) => f.id === "f1").radius = 10;
r = await regenerate(d.features);
const want = 80 * 50 * 3 - (4 - Math.PI) * 100 * 3 + ringArea(80, 10) * 4;
check("corners made 10: the lip's corners follow", !r.errors.length && Math.abs(vol("lid") - want) < 0.5, `${r.errors.map((e: any) => e.message).join()} ${vol("lid").toFixed(1)} want ${want.toFixed(1)}`);

// The same lid made by hand on a phone (tests/fixtures/lid-hand.json): drawn
// 80 x 50, corners 6, the lip from two offsets of the top face's edge; then
// the rectangle deleted and drawn again 100 x 60 and the corners made 10. The
// fillet finds the new corners (edges of the same step), the lip follows.
{
  const { readFileSync } = await import("node:fs");
  const hand = JSON.parse(readFileSync(new URL("./fixtures/lid-hand.json", import.meta.url), "utf8"));
  resolveDoc(hand);
  r = await regenerate(hand.features);
  const rr = (d: number) => (100 - 2 * d) * (60 - 2 * d) - (4 - Math.PI) * (10 - d) ** 2;
  const want = (100 * 60 - (4 - Math.PI) * 100) * 3 + (rr(2) - rr(4)) * 4;
  const v = vol("extrude-mw9gghgi-u7ha");
  check("hand-built lid: 100 x 60, corners 10, lip 2-4 mm in", !r.errors.length && !(r.notes ?? []).length && Math.abs(v - want) < 0.5, `${[...r.errors, ...(r.notes ?? [])].map((e: any) => e.message).join()} ${v.toFixed(1)} want ${want.toFixed(1)}`);
}

process.exit(failed ? 1 : 0);

