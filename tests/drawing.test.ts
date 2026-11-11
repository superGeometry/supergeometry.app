// Run: npx tsx tests/drawing.test.ts
// BIM drawings: the bodies projected with hidden lines, laid out on a sheet at
// a standard scale, balloons with the parts list's item numbers.
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { projectViews } from "../src/kernel/engine";
import { arrangement, regionRef } from "../src/sketch/regions";
import {
  angleDim,
  arcSweep,
  arrangeDims,
  drawingsOf,
  putDrawing,
  extent,
  balloonSpots,
  dimLabel,
  dimSVG,
  drawingSVG,
  edgeAt,
  extraName,
  extraSpec,
  extraSpecs,
  layoutSheet,
  drawingOptions,
  lengthText,
  markSVG,
  minMax,
  nextLetter,
  noteSVG,
  sectionSpec,
  sheetSize,
  specOf,
  VIEW_SPECS,
} from "../src/bim/drawingSheet";
import { emptyDoc, type Feature } from "../src/doc/types";
import { sheetToDXF } from "../src/io/sheetDxf";
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
{
  // Arranged by the book: two short ones side by side in the first row, 10 mm
  // out; the long one over them, 7 mm further; a tiny one's value past its end;
  // a diameter's leader out past the view.
  const [[x0, y0], [x1, y1]] = tp2.box;
  const lineY = (d: { a: [number, number]; offset: number }) => tp2.y + (d.a[1] - y0) * tp2.s - d.offset;
  const r = extent(tp2);
  const ds = arrangeDims(
    [
      { id: "long", view: "top", kind: "length", a: [x0, y0], b: [x1, y0], offset: 3 },
      { id: "s1", view: "top", kind: "length", a: [x0, y0], b: [x0 + 20, y0], offset: 25 },
      { id: "s2", view: "top", kind: "length", a: [x0 + 20, y0], b: [x0 + 40, y0], offset: 40 },
      { id: "tiny", view: "top", kind: "length", a: [x1 - 2, y1], b: [x1, y1], offset: 3 },
      { id: "dia", view: "top", kind: "diameter", a: [0, 0], c: circle!.c, r: 8, offset: 1 },
    ],
    dL,
    o2,
  );
  const by = (id: string) => ds.find((d) => d.id === id)!;
  check("arranged: the short ones in the first row, 10 mm out", Math.abs(lineY(by("s1")) - (r.y0 - 10)) < 1e-6 && Math.abs(lineY(by("s2")) - (r.y0 - 10)) < 1e-6, `${lineY(by("s1"))} ${lineY(by("s2"))} ${r.y0}`);
  check("arranged: the long one over them, 7 mm further out", Math.abs(lineY(by("long")) - (r.y0 - 17)) < 1e-6, String(lineY(by("long"))));
  check("arranged: a dimension along the bottom goes below the view", Math.abs(lineY(by("tiny")) - (r.y1 + 10)) < 1e-6, String(lineY(by("tiny"))));
  check("arranged: too short for its value, the value goes past its end", (by("tiny").slide ?? 0) > 2 && !by("s1").slide);
  const dia = by("dia");
  const C = [tp2.x + (circle!.c[0] - x0) * tp2.s, tp2.y + (circle!.c[1] - y0) * tp2.s];
  const end = [C[0] + Math.cos(dia.angle!) * (8 * tp2.s + dia.offset), C[1] + Math.sin(dia.angle!) * (8 * tp2.s + dia.offset)];
  check("arranged: a diameter's leader ends outside the view", end[0] < r.x0 || end[0] > r.x1 || end[1] < r.y0 || end[1] > r.y1, JSON.stringify(end));
}
{
  // Several drawings in one project; one saved before there could be several is the first.
  const pd = emptyDoc();
  check("no drawings in a new project", drawingsOf(pd).length === 0);
  pd.drawing = { title: "Old", size: "A4" };
  const old = drawingsOf(pd);
  check("a project with one drawing (saved before): that one, with an id", old.length === 1 && old[0].title === "Old" && !!old[0].id);
  putDrawing(pd, "second", { title: "Second" });
  const two = drawingsOf(pd);
  check("a drawing added: both kept, the old one first and unchanged", two.length === 2 && two[0].title === "Old" && two[0].size === "A4" && two[1].id === "second" && !pd.drawing);
  putDrawing(pd, old[0].id, { ...old[0], size: "A3" });
  check("one changed, the other not", drawingsOf(pd)[0].size === "A3" && drawingsOf(pd)[1].title === "Second");
  putDrawing(pd, "second", null);
  check("one deleted, the other kept", drawingsOf(pd).length === 1 && drawingsOf(pd)[0].title === "Old");
}
{
  // DXF of a sheet: y up, arcs the right way round, text kept, arrowheads solid.
  const ents = (dxf: string) => {
    const l = dxf.split("\n");
    const at = l.indexOf("ENTITIES");
    const list: Record<string, string>[] = [];
    for (let i = at + 1; i < l.length - 1; i += 2) {
      if (l[i] === "0") list.push({ type: l[i + 1] });
      else if (list.length) list[list.length - 1][l[i]] ??= l[i + 1];
    }
    return list.filter((e) => e.type !== "ENDSEC" && e.type !== "EOF");
  };
  const q = ents(sheetToDXF(`<svg viewBox="0 0 100 100"><path d="M10 0A10 10 0 0 1 0 10" stroke="#000" stroke-width="0.5" fill="none"/></svg>`));
  check("DXF: a quarter arc, y up, centre and angles right", q.length === 1 && q[0].type === "ARC" && q[0]["10"] === "0" && q[0]["20"] === "100" && q[0]["40"] === "10" && q[0]["50"] === "270" && q[0]["51"] === "0", JSON.stringify(q));
  const t = ents(sheetToDXF(`<svg viewBox="0 0 100 100"><g transform="rotate(-90 20 30)"><text x="20" y="30" font-size="5" text-anchor="middle">Ø16 ±0,1</text></g><path d="M0 0L3 1L3 -1Z" fill="#000"/><path d="M0 50L10 50" stroke="#000" stroke-width="0.25" stroke-dasharray="3 1"/></svg>`));
  const tx = t.find((e) => e.type === "TEXT");
  check("DXF: text kept, turned, centred, Ø and ± as their codes", !!tx && tx["1"] === "%%c16 %%p0,1" && tx["50"] === "90" && tx["72"] === "1" && tx["20"] === "70", JSON.stringify(tx));
  check("DXF: an arrowhead is a solid, a dashed line on HIDDEN", t.some((e) => e.type === "SOLID") && t.some((e) => e.type === "LINE" && e["8"] === "HIDDEN"));
  const whole = ents(sheetToDXF(svg));
  // DXF_OUT=file: the sheet's DXF written there (to open it in a DXF reader).
  if (process.env.DXF_OUT) (await import("node:fs")).writeFileSync(process.env.DXF_OUT, sheetToDXF(svg));
  check("DXF: a whole sheet has its lines, the views' outlines and its text", whole.filter((e) => e.type === "LINE").length > 20 && whole.some((e) => e.type === "TEXT") && whole.some((e) => e["8"] === "VISIBLE"), String(whole.length));
}
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

// ---- Views added by hand: base views from any side or corner, projections from a view.
{
  const same = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < 1e-9);
  const unit = (a: number[]) => a.map((x) => x / Math.hypot(...a));
  const xdoc = emptyDoc();
  xdoc.drawing = {
    extra: [
      { id: "back", orient: "back", at: [300, 220], scale: 0.5 },
      { id: "pr", view: "front", dir: [1, 0], gap: 0 },
      { id: "pd", view: "front", dir: [0, 1] },
      { id: "pc", view: "front", dir: [1, -1], at: [330, 60] },
      { id: "pt", view: "top", dir: [1, 0] },
      { id: "fromIso", view: "pc", dir: [1, 0] },
    ],
  };
  let xo = drawingOptions(xdoc);
  const sp = (id: string) => extraSpec(xo.extra.find((v) => v.id === id)!, xo)!;
  const left = VIEW_SPECS.find((v) => v.id === "left")!;
  const right = VIEW_SPECS.find((v) => v.id === "right")!;
  const topS = VIEW_SPECS.find((v) => v.id === "top")!;
  check("a base view from the back: looking at it from +Y, x the other way", same(sp("back").dir as number[], [0, 1, 0]) && same(sp("back").xAxis as number[], [-1, 0, 0]));
  check("first angle: projected to the right of the front view, it is the view from the left", same(sp("pr").dir as number[], left.dir as number[]) && same(sp("pr").xAxis as number[], left.xAxis as number[]), JSON.stringify(sp("pr")));
  check("first angle: projected below the front view, it is the top view", same(sp("pd").dir as number[], topS.dir as number[]) && same(sp("pd").xAxis as number[], topS.xAxis as number[]), JSON.stringify(sp("pd")));
  check("projected up and right from the front view: the isometric view from the front, right, top", same(sp("pc").dir as number[], unit([1, -1, 1])) && same(sp("pc").xAxis as number[], unit([1, 1, 0])), JSON.stringify(sp("pc")));
  const ptS = sp("pt");
  check("projected to the right of the top view: from the left, its up the top view's up (so it lines up)", same(ptS.dir as number[], [-1, 0, 0]) && same(ptS.xAxis as number[], [0, 0, 1]), JSON.stringify(ptS));
  check("nothing is projected square from an isometric view", !specOf("pc", xo) && !extraSpecs(xo).some((v) => v.id === "fromIso"));
  check("their names: Back view, Left view, Isometric view", extraName(xo.extra[0], xo) === "Back view" && extraName(xo.extra[1], xo) === "Left view" && extraName(xo.extra[3], xo) === "Isometric view");
  const tdoc = { ...xdoc, drawing: { ...xdoc.drawing, angle: "third" as const } };
  const t3 = drawingOptions(tdoc);
  const prT = extraSpec(t3.extra[1], t3)!;
  check("third angle: projected to the right of the front view, it is the view from the right", same(prT.dir as number[], right.dir as number[]) && same(prT.xAxis as number[], right.xAxis as number[]), JSON.stringify(prT));
  // Laid out: the plate and post, drawn every way.
  const xv = new Map([...views, ...(await projectViews(features, extraSpecs(xo))).map((v) => [v.id, v] as const)]);
  const XL = layoutSheet(xv, xo, 0);
  const at = (id: string) => XL.views.find((v) => v.id === id)!;
  const ext = (id: string) => {
    const p = at(id);
    return { x0: p.x, y0: p.y, x1: p.x + (p.box[1][0] - p.box[0][0]) * p.s, y1: p.y + (p.box[1][1] - p.box[0][1]) * p.s };
  };
  const bk = ext("back");
  check("a base view: at its own scale (1:2), its middle where it was put", at("back").s === 0.5 && Math.abs((bk.x0 + bk.x1) / 2 - 300) < 1e-9 && Math.abs((bk.y0 + bk.y1) / 2 - 220) < 1e-9);
  check("a projection square on: level with its view, past its right edge, at its scale", Math.abs(at("pr").y - at("front").y) < 1e-9 && ext("pr").x0 > ext("front").x1 && at("pr").s === at("front").s);
  check("below it: lined up under it", Math.abs(at("pd").x - at("front").x) < 1e-9 && ext("pd").y0 > ext("front").y1);
  const pc = ext("pc");
  check("an isometric projection: where it was put, and isometric (no hidden lines, nothing measured on it)", !!at("pc").iso && Math.abs((pc.x0 + pc.x1) / 2 - 330) < 1e-9 && !edgeAt(xv, XL, [330, 60], 50)?.view.startsWith("pc"));
  const xsvg = drawingSVG({ doc: xdoc, views: xv, parts: [], date: new Date() }).svg;
  check("captioned: the back view with its scale, the left view", xsvg.includes(">Back view (1:2)<") && xsvg.includes(">Left view<"));
  // The isometric view's own scale.
  const idoc = emptyDoc();
  idoc.drawing = { isoScale: 0.2 };
  check("the isometric view at the scale given it", layoutSheet(views, drawingOptions(idoc), 0).views.find((v) => v.id === "iso")?.s === 0.2);
  xo = drawingOptions({ ...emptyDoc(), drawing: { images: [{ id: "im", x: 30, y: 20, w: 40, h: 20, src: "data:image/png;base64,AAAA" }] } });
  const isvg = drawingSVG({ doc: { ...emptyDoc(), drawing: { images: xo.images } }, views, parts: [], date: new Date() }).svg;
  check("a picture on the sheet, where it was put", isvg.includes('<image href="data:image/png;base64,AAAA" x="30" y="20" width="40" height="20"'));
}

// ---- Arc angles (past 180° too) and min-max distances.
{
  const t = arcSweep([0, 0], [10, 0], [0, 10], [-10, 0]);
  check("an arc from 0° round through 180° to 90° goes 270°", Math.abs(Math.abs(t) - 1.5 * Math.PI) < 1e-12, String(t));
  check("through a point on the short way: the short way", Math.abs(arcSweep([0, 0], [10, 0], [0, 10], [7, 7]) - Math.PI / 2) < 1e-12);
  const ao = drawingOptions(emptyDoc());
  const a270 = dimSVG({ id: "a", view: "top", kind: "angle", c: [0, 0], a: [10, 0], b: [0, 10], through: [-10, 0], offset: 15 }, tp2, ao);
  check("drawn the long way round, labelled 270°", a270.includes(">270°<") && /A15 15 0 1 /.test(a270), a270.slice(0, 160));
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  const d = (pr: [[number, number], [number, number]]) => Math.hypot(pr[0][0] - pr[1][0], pr[0][1] - pr[1][1]);
  const pl = minMax({ kind: "point", p: [0, 0] }, { kind: "line", a: [5, -10], b: [5, 10] });
  check("point to edge: nearest square to it (5), farthest an end", near(d(pl.min), 5) && near(d(pl.max), Math.hypot(5, 10)), `${d(pl.min)} ${d(pl.max)}`);
  const circ = (c: [number, number], r: number) => ({ kind: "circle" as const, c, r, a: [c[0] + r, c[1]] as [number, number], m: [c[0] - r, c[1]] as [number, number], b: [c[0] + r, c[1]] as [number, number] });
  const cc = minMax(circ([0, 0], 5), circ([20, 0], 3));
  check("circle to circle: 12 apart at the nearest, 28 at the farthest", near(d(cc.min), 12) && near(d(cc.max), 28), `${d(cc.min)} ${d(cc.max)}`);
  const ll = minMax({ kind: "line", a: [0, 0], b: [10, 0] }, { kind: "line", a: [0, 5], b: [10, 5] });
  check("two parallel edges: 5 apart, the far corners", near(d(ll.min), 5) && near(d(ll.max), Math.hypot(10, 5)));
  const arc = minMax({ kind: "point", p: [0, -20] }, { kind: "circle", c: [0, 0], r: 10, a: [10, 0], m: [0, 10], b: [-10, 0] });
  check("a point and an arc that turns away from it: nearest at the arc's end, not the circle", near(d(arc.min), Math.hypot(10, 20)), String(d(arc.min)));
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
