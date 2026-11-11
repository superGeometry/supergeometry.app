// Run: npx tsx tests/drawing.test.ts
// BIM drawings: the bodies projected with hidden lines, laid out on a sheet at
// a standard scale, balloons with the parts list's item numbers.
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { projectViews } from "../src/kernel/engine";
import { arrangement, regionRef } from "../src/sketch/regions";
import { angleDim, balloonSpots, dimLabel, dimSVG, drawingSVG, edgeAt, layoutSheet, drawingOptions, lengthText, markSVG, nextLetter, noteSVG, sectionSpec, sheetSize, VIEW_SPECS } from "../src/bim/drawingSheet";
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
check("defaults: A3, first angle, hidden lines, all four views", opts.size === "A3" && opts.angle === "first" && opts.hidden && opts.views.front && opts.views.top && opts.views.side && opts.views.iso);
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
const { svg, layout } = drawingSVG({ doc, views, parts, date: new Date(2026, 10, 10) });
check("the sheet: A3 in mm", svg.includes('width="420mm" height="297mm" viewBox="0 0 420 297"'));
check("its dimensions: 200, 80 and 100", [">200<", ">80<", ">100<"].every((t) => svg.includes(t)));
check("balloons 1 and 2", svg.includes(">1</text>") && svg.includes(">2</text>"));
check("title block: title, scale, number, revision", ["Test plate", ">1:1<", "D-001", ">B<", "A. Person"].every((t) => svg.includes(t)));
check("grid zones: 1 to 8 along, A to F down (A3)", svg.includes(">8</text>") && svg.includes(">F</text>") && !svg.includes(">G</text>"));
check("the sheet's scale was 1:1 here", layout.scale === 1);
check("parts list: the material, its mass", svg.includes("Structural steel S235JR") && svg.includes("3.14 kg"));
check("hidden lines dashed", svg.includes('stroke-dasharray="3 1"') || !views.get("front")!.bodies.some((b) => b.hidden));

// ---- Edges to dimension, tapping them, the dimensions put on.
const holed = (await import("../src/kernel/engine")).projectViews;
const disc: Feature[] = (() => {
  const es = [
    { id: "o", kind: "polyline", points: [[0, 0], [60, 0], [60, 40], [0, 40]], closed: true },
    { id: "h", kind: "circle", center: [30, 20], radius: 8 },
  ];
  return [
    { id: "ds", name: "ds", type: "sketch", plane: { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] }, entities: es } as Feature,
    { id: "D", name: "D", type: "extrude", source: { kind: "profile", sketch: "ds", regions: arrangement(es as any).regions.filter((r) => r.holes.length).map(regionRef) }, distance: 10, mode: "new" } as Feature,
  ];
})();
const dv = new Map((await holed(disc, VIEW_SPECS)).map((v) => [v.id, v]));
const topEdges = dv.get("top")!.bodies[0].edges;
const circle = topEdges.find((e) => "c" in e) as { c: [number, number]; r: number } | undefined;
check("a plate with a hole, from the top: its 4 sides and the hole as a circle", topEdges.filter((e) => !("c" in e)).length >= 4 && !!circle && Math.abs(circle.r - 8) < 1e-3, JSON.stringify(circle));
// ---- The same, worked out on the meshes (as for freeform or very big models).
{
  const mv = new Map((await projectViews(features, VIEW_SPECS, undefined, "mesh")).map((v) => [v.id, v]));
  const mf = mv.get("front")!;
  check("meshes: front view still exactly 200 wide, 80 high", Math.abs(mf.box![1][0] - mf.box![0][0] - 200) < 1e-6 && Math.abs(mf.box![1][1] - mf.box![0][1] - 80) < 1e-6, JSON.stringify(mf.box));
  check("meshes: seen from the top nothing is hidden", mv.get("top")!.bodies.every((b) => !b.hidden), mv.get("top")!.bodies.map((b) => b.hidden.slice(0, 60)).join(" | "));
  const mw = (await projectViews(wall, [VIEW_SPECS[0]], undefined, "mesh"))[0];
  check("meshes: the wall's edges behind the post are hidden", !!mw.bodies.find((b) => b.id === "W")?.hidden);
  const md = (await projectViews(disc, VIEW_SPECS, undefined, "mesh")).find((v) => v.id === "top")!.bodies[0].edges;
  const mc = md.find((e) => "c" in e) as { c: [number, number]; r: number } | undefined;
  check("meshes: the hole from the top is a circle, r 8", !!mc && Math.abs(mc.r - 8) < 1e-3 && md.some((e) => !("c" in e) && Math.abs(Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]) - 60) < 1e-6), JSON.stringify(mc));
  // A round rod seen from the side: its outlines are exact straight lines 10 apart.
  const rodEs = [{ id: "c", kind: "circle", center: [0, 0], radius: 5 }];
  const rod: Feature[] = [
    { id: "rs", name: "rs", type: "sketch", plane: { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] }, entities: rodEs } as Feature,
    { id: "R", name: "R", type: "extrude", source: { kind: "profile", sketch: "rs", regions: arrangement(rodEs as any).regions.map(regionRef) }, distance: 30, mode: "new" } as Feature,
  ];
  const rf = (await projectViews(rod, [VIEW_SPECS[0]], undefined, "mesh"))[0].bodies[0].edges.filter((e) => !("c" in e) && Math.abs(e.a[0] - e.b[0]) < 1e-6 && Math.abs(Math.abs(e.b[1] - e.a[1]) - 30) < 1e-3);
  const xs = rf.map((e) => e.a[0]).sort((a, b) => a - b);
  check("meshes: a rod's outlines from the side, 30 long and exactly 10 apart", xs.length === 2 && Math.abs(xs[1] - xs[0] - 10) < 1e-6, JSON.stringify(rf));
  // A tall thin panel from the isometric view: its big flat faces' triangles
  // must not cover the edges beside them (they hid its top edges).
  const panel = block("Q", [[0, 0], [18, 0], [18, 479], [0, 479]], 0, 1800);
  const isoSpec = VIEW_SPECS.filter((v) => v.id === "iso");
  const len = (d: string) => {
    let n = 0;
    let at: number[] | null = null;
    for (const m of d.matchAll(/([ML])(-?[\d.e-]+) (-?[\d.e-]+)/g)) {
      const p = [+m[2], +m[3]];
      if (m[1] === "L" && at) n += Math.hypot(p[0] - at[0], p[1] - at[1]);
      at = p;
    }
    return n;
  };
  const pe = (await projectViews(panel, isoSpec, undefined, "exact"))[0].bodies[0];
  const pm = (await projectViews(panel, isoSpec, undefined, "mesh"))[0].bodies[0];
  check("meshes: a thin panel from the isometric view shows the same lines as exactly", Math.abs(len(pm.visible) - len(pe.visible)) < len(pe.visible) * 0.01 && Math.abs(len(pm.hidden) - len(pe.hidden)) < len(pe.hidden) * 0.01, `${len(pm.visible)} / ${len(pe.visible)}, hidden ${len(pm.hidden)} / ${len(pe.hidden)}`);
}
// A scale too big for the sheet: said so, the views cut at the frame.
{
  const big = emptyDoc();
  big.drawing = { size: "A4", scale: 10 };
  const bl = layoutSheet(views, drawingOptions(big), 2);
  const bs = drawingSVG({ doc: big, views, parts: [], date: new Date() }).svg;
  check("10:1 on A4 doesn't fit: cut at the frame", !bl.fits && bs.includes('clip-path="url(#sheet-area)"'));
  big.drawing = { size: "A4" };
  check("the automatic scale fits, nothing cut", layoutSheet(views, drawingOptions(big), 2).fits && !drawingSVG({ doc: big, views, parts: [], date: new Date() }).svg.includes("clipPath"));
}
const ddoc = emptyDoc();
const dL = layoutSheet(dv, drawingOptions(ddoc), 0);
const tp2 = dL.views.find((v) => v.id === "top")!;
const onHole: [number, number] = [tp2.x + (30 + 8 - tp2.box[0][0]) * tp2.s, tp2.y + (-20 - tp2.box[0][1]) * tp2.s];
const hit = edgeAt(dv, dL, onHole, 1);
check("tapping the hole on the sheet finds the circle", hit?.kind === "circle" && Math.abs((hit.r ?? 0) - 8) < 1e-3, JSON.stringify(hit));
const onSide: [number, number] = [tp2.x + 10 * tp2.s, tp2.y];
const side = edgeAt(dv, dL, onSide, 1, "line");
check("tapping the far side finds that edge, 60 long", !!side && Math.abs(Math.hypot(side.b[0] - side.a[0], side.b[1] - side.a[1]) - 60) < 1e-6);
const o2 = drawingOptions(ddoc);
check("a length dimension says 60", dimSVG({ id: "d1", view: "top", kind: "length", a: side!.a, b: side!.b, offset: 8 }, tp2, o2).includes(">60<"));
check("a diameter says Ø16, a radius R8", dimSVG({ id: "d2", view: "top", kind: "diameter", a: [0, 0], c: circle!.c, r: 8, offset: 6 }, tp2, o2).includes(">Ø16<") && dimSVG({ id: "d3", view: "top", kind: "radius", a: [0, 0], c: circle!.c, r: 8, offset: 6 }, tp2, o2).includes(">R8<"));
ddoc.drawing = { precision: 2, comma: true, units: "cm" };
check("lengths in the drawing's units, decimals, comma: 12.345 mm is 1,23 cm", lengthText(12.345, drawingOptions(ddoc)) === "1,23", lengthText(12.345, drawingOptions(ddoc)));
ddoc.drawing = { precision: 2 };
check("no trailing zeros: 60 mm is 60", lengthText(60, drawingOptions(ddoc)) === "60");
ddoc.drawing = { size: "A4", portrait: true };
check("portrait A4: 210 wide, 297 high", sheetSize(drawingOptions(ddoc)).join() === "210,297");
ddoc.drawing = { moved: { front: [5, 7] } };
const mL = layoutSheet(dv, drawingOptions(ddoc), 0);
const [f0, f1] = [dL.views.find((v) => v.id === "front")!, mL.views.find((v) => v.id === "front")!];
const [t0, t1] = [dL.views.find((v) => v.id === "top")!, mL.views.find((v) => v.id === "top")!];
check("moving the front view takes the top view along, still lined up", f1.x - f0.x === 5 && f1.y - f0.y === 7 && t1.x - t0.x === 5 && t1.x === f1.x);
ddoc.drawing = { views: { iso: false, top: false } };
check("views switched off are not drawn", layoutSheet(dv, drawingOptions(ddoc), 0).views.map((v) => v.id).sort().join() === "front,left");

// ---- Section views: the plate with the hole cut across the hole, from the top view.
{
  const sdoc = emptyDoc();
  sdoc.drawing = { sections: [{ id: "sec-1", letter: "A", view: "top", a: [-5, -20], b: [65, -20], look: [0, 1], gap: 15 }] };
  let so = drawingOptions(sdoc);
  const spec = sectionSpec(so.sections[0], so)!;
  check("a section of the top view, looking down the paper: square to the cut, the plate's x along it", spec.dir.join() === "0,1,0" && spec.xAxis.join() === "1,0,0" && !!spec.cut, JSON.stringify(spec));
  const sv = (await holed(disc, [spec]))[0];
  check("the section is the plate's width by its thickness", !!sv.box && Math.abs(sv.box[1][0] - sv.box[0][0] - 60) < 1e-6 && Math.abs(sv.box[1][1] - sv.box[0][1] - 10) < 1e-6, JSON.stringify(sv.box));
  // The cut faces: closed outlines, their area the plate's section less the hole's (60 - 16) x 10.
  const area = (d: string) =>
    d
      .split("Z")
      .filter((s) => s.trim())
      .reduce((sum, s) => {
        const pts = [...s.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
        let a = 0;
        for (let i = 0; i < pts.length; i++) {
          const [p, q] = [pts[i], pts[(i + 1) % pts.length]];
          a += p[0] * q[1] - q[0] * p[1];
        }
        return sum + Math.abs(a) / 2;
      }, 0);
  const cut = sv.bodies[0]?.section ?? "";
  check("the faces it cuts come back as closed outlines, 440 mm² (the hole left out)", Math.abs(area(cut) - 440) < 1e-3, cut);
  check("no hidden lines in a section", sv.bodies.every((b) => !b.hidden));
  const sviews = new Map([...dv, ["sec-1", sv]]);
  const sL = layoutSheet(sviews, so, 1);
  const [stop, ssec] = [sL.views.find((v) => v.id === "top")!, sL.views.find((v) => v.id === "sec-1")!];
  const sh = 10 * ssec.s;
  check("first angle: placed the way its arrows point (below the top view), lined up with it, its middle as far off as it was put", !!ssec && Math.abs(ssec.x - stop.x) < 1e-9 && Math.abs(ssec.y + sh / 2 - (stop.y + 40 * stop.s + Math.max(15, sh / 2 + 16))) < 1e-9, JSON.stringify([stop, ssec]));
  const ssvg = drawingSVG({ doc: sdoc, views: sviews, parts: [], date: new Date() }).svg;
  check("drawn hatched, labelled A-A, its cut line on the top view with its letters", ssvg.includes('fill="url(#hatch-a)"') && ssvg.includes(">A-A<") && (ssvg.match(/font-size="5"[^>]*>A</g) ?? []).length === 2 && ssvg.includes('stroke-dasharray="8 1.5 1.5 1.5"'));
  sdoc.drawing = { ...sdoc.drawing, angle: "third" };
  so = drawingOptions(sdoc);
  const tL = layoutSheet(new Map([...dv, ["sec-1", (await holed(disc, [sectionSpec(so.sections[0], so)!]))[0]]]), so, 1);
  const [ttop, tsec] = [tL.views.find((v) => v.id === "top")!, tL.views.find((v) => v.id === "sec-1")!];
  check("third angle: placed against its arrows (above the top view)", !!tsec && tsec.y + 10 * tsec.s < ttop.y);
  // A cut down the front view, looking right: in first angle that is the view from the left.
  const fdoc = emptyDoc();
  fdoc.drawing = { sections: [{ id: "s2", letter: "B", view: "front", a: [30, -20], b: [30, 5], look: [1, 0], gap: 20 }] };
  const fs = sectionSpec(drawingOptions(fdoc).sections[0], drawingOptions(fdoc))!;
  check("a section down the front view, looking right, faces the way the left view does", fs.dir.join() === "-1,0,0" && fs.xAxis.map((x) => x + 0).join() === "0,-1,0", JSON.stringify(fs));
  check("letters go on from the last, skipping I and O", nextLetter(drawingOptions({ ...emptyDoc(), drawing: { sections: ["A", "B", "C", "D", "E", "F", "G", "H"].map((letter) => ({ id: letter, letter, view: "top", a: [0, 0], b: [1, 0], look: [0, 1], gap: 1 })) } })) === "J");
}

// ---- Detail views: a circle of a view, twice as big, where it was put.
{
  const ddoc2 = emptyDoc();
  ddoc2.drawing = { details: [{ id: "det-1", letter: "B", view: "top", c: [30, -20], r: 10, at: [300, 200] }] };
  const dL2 = layoutSheet(dv, drawingOptions(ddoc2), 0);
  const [top2, det] = [dL2.views.find((v) => v.id === "top")!, dL2.views.find((v) => v.id === "det-1")!];
  check("a detail: twice its view's scale, its circle where it was put", !!det && det.s === top2.s * 2 && det.clip?.c.join() === "300,200" && det.clip.r === 10 * det.s && det.src === "top");
  const dsvg = drawingSVG({ doc: ddoc2, views: dv, parts: [], date: new Date() }).svg;
  check("drawn cut to its circle, captioned with its letter and scale", dsvg.includes('clip-path="url(#clip-det-1)"') && dsvg.includes(`>B (${det.s}:1)<`));
  const inDetail = edgeAt(dv, dL2, [300 + 8 * det.s, 200], 1);
  check("tapping the hole inside the detail finds it, on the detail", inDetail?.view === "det-1" && inDetail.kind === "circle" && Math.abs((inDetail.r ?? 0) - 8) < 1e-6, JSON.stringify(inDetail));
  check("nothing is found outside the detail's circle", !edgeAt(dv, dL2, [300 + 10 * det.s + 3, 200], 1)?.view.startsWith("det"));
}

// ---- Angles, tolerances, centre marks, notes that point.
{
  const ao = drawingOptions(emptyDoc());
  const a90 = dimSVG({ id: "a", view: "top", kind: "angle", c: [0, 0], a: [60, 0], b: [0, -40], offset: 15 }, tp2, ao);
  check("an angle between two edges square to each other says 90°", a90.includes(">90°<") && a90.includes("A15 15 0 0 "), a90.slice(0, 200));
  check("an angle is the smaller way round", angleDim([0, 0], [10, 0], [-10, -1], 10, "x", 0.25).includes("A10 10 0 0 0"));
  const d = { id: "l", view: "top", kind: "length" as const, a: [0, 0] as [number, number], b: [60, 0] as [number, number], offset: 8 };
  check("± tolerance", dimLabel({ ...d, tol: { kind: "sym", up: 0.02 } }, 60, ao).main === "60 ±0.02");
  const dev = dimLabel({ ...d, tol: { kind: "dev", up: 0.1, down: 0.05 } }, 60, ao);
  check("deviations stacked after the value: +0.1 over -0.05", dev.main === "60" && dev.up === "+0.1" && dev.down === "-0.05");
  const lim = dimLabel({ ...d, tol: { kind: "limits", up: 0.1, down: 0.05 } }, 60, ao);
  check("limits: the largest size over the smallest", lim.up === "60.1" && lim.down === "59.95");
  check("a basic size is boxed", dimSVG({ ...d, tol: { kind: "basic" } }, tp2, ao).includes("<rect"));
  check("text before and after the value", dimLabel({ ...d, kind: "diameter", prefix: "4× ", suffix: " THRU" }, 16, ao, "Ø").main === "4× Ø16 THRU");
  const cm = markSVG({ id: "m", view: "top", kind: "center", c: circle!.c, r: 8 }, tp2, 0.25);
  const arms = [...cm.matchAll(/M(-?[\d.]+) (-?[\d.]+)L(-?[\d.]+) (-?[\d.]+)/g)].map((m) => Math.hypot(Number(m[3]) - Number(m[1]), Number(m[4]) - Number(m[2])));
  check("a centre mark: four arms, each 2.5 mm past the circle", arms.length === 4 && arms.every((l) => Math.abs(l - (8 * tp2.s + 2.5)) < 0.02), JSON.stringify(arms));
  const nt = noteSVG({ id: "n", x: 300, y: 100, text: "Deburr", to: { view: "top", p: [60, -20] } }, tp2, 0.25);
  check("a note pointing at an edge has a leader and an arrow", (nt.match(/<path/g) ?? []).length === 2 && nt.includes(">Deburr<"));
}

const spots = balloonSpots({ x0: 0, y0: 0, x1: 100, y1: 100 }, [1, 2, 3].map((item) => ({ item, at: [50 + item * 0.1, 10] as [number, number] })));
const apart = spots.every((a, i) => spots.every((b, j) => i === j || Math.hypot(a.x - b.x, a.y - b.y) >= 9.99));
check("balloons for parts close together are spread apart", apart, JSON.stringify(spots.map((s) => [s.x, s.y])));
check("they sit on the rectangle around the view", spots.every((s) => s.y === 0 || s.x === 0 || s.x === 100 || s.y === 100));

if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log("all passed");
