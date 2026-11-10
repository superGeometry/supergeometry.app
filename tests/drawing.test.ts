// Run: npx tsx tests/drawing.test.ts
// BIM drawings: the bodies projected with hidden lines, laid out on a sheet at
// a standard scale, balloons with the parts list's item numbers.
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { projectViews } from "../src/kernel/engine";
import { arrangement, regionRef } from "../src/sketch/regions";
import { balloonSpots, drawingSVG, layoutSheet, drawingOptions, VIEW_SPECS } from "../src/bim/drawingSheet";
import { emptyDoc, type Feature } from "../src/doc/types";
import type { PartRow } from "../src/bim/sheet";

setOC(await (opencascade as unknown as () => Promise<any>)());
let failed = 0;
const check = (name: string, ok: boolean, info = "") => {
  if (!ok) failed++;
  console.log(ok ? "ok  " : "FAIL", name, info);
};
const block = (id: string, pts: number[][], z: number, h: number): Feature[] => {
  const es = [{ id: `${id}p`, kind: "polyline", points: pts, closed: true }];
  return [
    { id: `${id}s`, name: `${id}s`, type: "sketch", plane: { origin: [0, 0, z], xDir: [1, 0, 0], normal: [0, 0, 1] }, entities: es } as Feature,
    { id, name: id, type: "extrude", source: { kind: "profile", sketch: `${id}s`, regions: arrangement(es as any).regions.map(regionRef) }, distance: h, mode: "new" } as Feature,
  ];
};
// A 200 x 100 x 20 plate, and a 40 x 40 x 60 post standing on it.
const features = [...block("A", [[0, 0], [200, 0], [200, 100], [0, 100]], 0, 20), ...block("B", [[20, 20], [60, 20], [60, 60], [20, 60]], 20, 60)];
const views = new Map((await projectViews(features, VIEW_SPECS)).map((v) => [v.id, v]));
const front = views.get("front")!;
check("front view: 200 wide, 80 high", Math.abs(front.box![1][0] - front.box![0][0] - 200) < 1e-6 && Math.abs(front.box![1][1] - front.box![0][1] - 80) < 1e-6, JSON.stringify(front.box));
const top = views.get("top")!;
check("top view: 200 by 100", Math.abs(top.box![1][1] - top.box![0][1] - 100) < 1e-6);
check("each body drawn on its own, with a point for its balloon", front.bodies.length === 2 && front.bodies.every((b) => b.visible && b.anchor));
const left = views.get("left")!;
check("seen from the top nothing is hidden", top.bodies.every((b) => !b.hidden));
check("the left view is 100 wide (the depth)", Math.abs(left.box![1][0] - left.box![0][0] - 100) < 1e-6);
// A post in front of a wall: the wall's edges behind it are hidden.
const wall = [...block("W", [[0, 50], [100, 50], [100, 60], [0, 60]], 0, 50), ...block("P", [[40, 0], [60, 0], [60, 10], [40, 10]], 0, 80)];
const wv = (await projectViews(wall, [VIEW_SPECS[0]]))[0];
check("a wall behind a post: its edges behind the post are hidden (dashed)", !!wv.bodies.find((b) => b.id === "W")?.hidden, wv.bodies.map((b) => b.id + ":" + b.hidden.length).join(" "));

const doc = emptyDoc();
doc.name = "Test plate";
const opts = drawingOptions(doc);
check("defaults: A3, first angle, hidden lines, isometric", opts.size === "A3" && opts.angle === "first" && opts.hidden && opts.iso);
const L = layoutSheet(views, opts, 2);
check("200 mm plate on A3: drawn 1:1", L.scale === 1, String(L.scale));
const fp = L.views.find((v) => v.id === "front")!;
const tp = L.views.find((v) => v.id === "top")!;
const lp = L.views.find((v) => v.id === "left")!;
check("first angle: top view below the front view, lined up", tp.y > fp.y + 80 && Math.abs(tp.x - fp.x) < 1e-9);
check("first angle: the view from the left on the right, level with the front", lp.x > fp.x + 200 && Math.abs(lp.y - fp.y) < 1e-9);
const inFrame = L.views.every((v) => v.x >= 20 && v.y >= 10 && v.x + (v.box[1][0] - v.box[0][0]) * v.s <= 410 && v.y + (v.box[1][1] - v.box[0][1]) * v.s <= 287);
check("every view inside the frame", inFrame);
doc.drawing = { angle: "third" };
const L3 = layoutSheet(views, drawingOptions(doc), 2);
const f3 = L3.views.find((v) => v.id === "front")!;
const t3 = L3.views.find((v) => v.id === "top")!;
check("third angle: top view above, the view from the right on the right", t3.y < f3.y && L3.side === "right" && !!L3.views.find((v) => v.id === "right"));
doc.drawing = { size: "A4" };
check("on A4 it has to shrink: 1:2", layoutSheet(views, drawingOptions(doc), 2).scale === 0.5, String(layoutSheet(views, drawingOptions(doc), 2).scale));
doc.drawing = { size: "A3", scale: 0.2 };
check("a scale chosen is kept", layoutSheet(views, drawingOptions(doc), 2).scale === 0.2);
doc.drawing = undefined;

const parts: PartRow[] = [
  { item: 1, id: "A", name: "Plate", material: "Structural steel S235JR", volume: 400000, area: 0, mass: 3.14, center: [0, 0, 0], size: [200, 100, 20] },
  { item: 2, id: "B", name: "Post", material: "", volume: 96000, area: 0, center: [0, 0, 0], size: [40, 40, 60] },
];
doc.info = { author: "A. Person", number: "D-001", revision: "B" };
const { svg } = drawingSVG({ doc, views, parts, date: "2026-11-10" });
check("the sheet: A3 in mm", svg.includes('width="420mm" height="297mm" viewBox="0 0 420 297"'));
check("its dimensions: 200, 80 and 100", [">200<", ">80<", ">100<"].every((t) => svg.includes(t)));
check("balloons 1 and 2", svg.includes(">1</text>") && svg.includes(">2</text>"));
check("title block: title, scale, number, revision", ["Test plate", ">1:1<", "D-001", ">B<", "A. Person"].every((t) => svg.includes(t)));
check("parts list: the material, its mass", svg.includes("Structural steel S235JR") && svg.includes("3.14 kg"));
check("hidden lines dashed", svg.includes('stroke-dasharray="3 1"') || !views.get("front")!.bodies.some((b) => b.hidden));

const spots = balloonSpots({ x0: 0, y0: 0, x1: 100, y1: 100 }, [1, 2, 3].map((item) => ({ item, at: [50 + item * 0.1, 10] as [number, number] })));
const apart = spots.every((a, i) => spots.every((b, j) => i === j || Math.hypot(a.x - b.x, a.y - b.y) >= 9.99));
check("balloons for parts close together are spread apart", apart, JSON.stringify(spots.map((s) => [s.x, s.y])));
check("they sit on the rectangle around the view", spots.every((s) => s.y === 0 || s.x === 0 || s.x === 100 || s.y === 100));

if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log("all passed");
