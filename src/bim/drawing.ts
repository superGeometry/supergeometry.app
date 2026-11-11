// The drawing workspace: the sheet in the middle; its tools at the left
// (views, dimensions, notes, delete, exit); its properties at the right
// (sheet, scale, projection, title block, dimension style, line widths).
// Tap an edge with a dimension tool and its dimension is there; drag a view,
// a dimension or a note to move it. Everything is saved with the project and
// undoes like any other change. The sheet itself is made in drawingSheet.ts.

import type { DimText, DrawingDim, DrawingMark, DrawingNote, DrawingOptions, ProjectDoc, ProjectInfo, ViewOrient } from "../doc/types";
import type { ProjectedView, ViewSpec } from "../kernel/protocol";
import { icons, type IconName } from "../ui/icons";
import { el, textButton } from "../ui/ui";
import { UNIT_MM } from "../units";
import type { AppContext } from "../tools/tool";
import { measureBodies } from "./bimTool";
import { SheetCamera } from "./sheetCamera";
import { partsList, type PartRow } from "./sheet";
import {
  annId,
  drawingOptions,
  drawingSVG,
  edgeAt,
  extent,
  fromPaper,
  moveKey,
  nextLetter,
  outward,
  placeDir,
  pointAt,
  scaleLabel,
  SCALES,
  extraName,
  extraSpecs,
  isIsoView,
  minMax,
  ORIENTS,
  SHEETS,
  type Ent,
  sheetSize,
  specOf,
  toPaper,
  VIEW_NAMES,
  VIEW_SPECS,
  type EdgeHit,
  type Layout,
  type Opts,
  type SheetSize,
} from "./drawingSheet";

type ToolId =
  | "length"
  | "distance"
  | "pointLine"
  | "lineLine"
  | "angle"
  | "angle3"
  | "arcAngle"
  | "minmax"
  | "radius"
  | "diameter"
  | "note"
  | "section"
  | "detail"
  | "base"
  | "projection"
  | "center"
  | "cline"
  | "clineLines";
const TOOL_HINT: Record<ToolId, string> = {
  arcAngle: "Tap an arc for the angle it goes round",
  minmax: "Tap a point, an edge or a circle, then another: the distance between them (nearest; Max in the bar for the farthest)",
  base: "Tap where the view goes",
  projection: "Tap the view to project from (not an isometric one or a detail)",
  length: "Tap a straight edge to dimension its length",
  distance: "Tap a point (a corner, the middle of an edge, a centre), then another: the distance between them",
  pointLine: "Tap a point, then a straight edge: the distance square to it",
  lineLine: "Tap a straight edge, then one parallel to it: the distance between them",
  angle: "Tap a straight edge, then another: the angle between them",
  angle3: "Tap a point, then the corner the angle is at, then another point",
  radius: "Tap a circle or an arc for its radius",
  diameter: "Tap a circle or an arc for its diameter",
  note: "Tap an edge for a note that points at it, or the empty paper for a note on its own",
  section: "Tap where the cut line starts on a view (corners, middles and centres snap)",
  detail: "Tap the middle of the area to show bigger",
  center: "Tap a circle or an arc for its centre mark",
  cline: "Tap a point, then another: a centreline through them",
  clineLines: "Tap a straight edge, then the one opposite it: the centreline between them",
};

type P2 = [number, number];
/** A point or an edge picked on a view, on the way to a dimension, a section, a centreline. */
type Pick = { view: string; p: P2; line?: { a: P2; b: P2 }; ent?: Ent };
const sub2 = (a: P2, b: P2): P2 => [a[0] - b[0], a[1] - b[1]];
const len2 = (a: P2) => Math.hypot(a[0], a[1]);
const unit2 = (a: P2): P2 => {
  const l = len2(a) || 1;
  return [a[0] / l, a[1] / l];
};
/** The point of the line through a and b nearest p. */
const foot = (p: P2, a: P2, b: P2): P2 => {
  const ab = sub2(b, a);
  const t = ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / (ab[0] * ab[0] + ab[1] * ab[1] || 1);
  return [a[0] + ab[0] * t, a[1] + ab[1] * t];
};
const cross2 = (a: P2, b: P2) => a[0] * b[1] - a[1] * b[0];
/** Two edges this close to parallel (sin of 1°) are taken as parallel. */
const PARALLEL = Math.sin(Math.PI / 180);

export async function openDrawing(app: AppContext): Promise<void> {
  document.querySelector(".bim-sheet")?.remove();
  const store = app.store;

  // The first drawing of the project: its preferences asked first.
  const fresh = !store.doc.drawing;
  // The bodies drawn: those picked as it opens, or the ones chosen before, or all shown.
  const picked = [...new Set(app.selection.flatMap((s) => ("body" in s ? [s.body] : [])))];

  // ---- The workspace
  const back = el("div", "bim-sheet bim-drawing");
  const bar = el("div", "bim-sheet-bar");
  const name = el("span", "bim-sheet-name", "Drawing");
  const print = el("button", "text-btn", "Print / PDF");
  const svgBtn = el("button", "text-btn", "SVG");
  const propsBtn = el("button", "text-btn on", "Properties");
  const close = el("button", "bim-close");
  close.innerHTML = icons.close;
  close.title = "Exit Drawing";
  close.setAttribute("aria-label", "Exit Drawing");
  bar.append(name, print, svgBtn, propsBtn, close);
  const work = el("div", "bim-dwork");
  const tools = el("div", "bim-dtools");
  const stage = el("div", "bim-dstage");
  const paper = el("div", "bim-drawing-paper");
  const hint = el("div", "bim-dhint");
  hint.hidden = true;
  stage.append(paper, hint);
  const props = el("div", "bim-props");
  work.append(tools, stage, props);
  back.append(bar, work);
  document.body.append(back);
  paper.append(el("div", "bim-sub", "Drawing the views…"));

  // ---- Zoom and move round the sheet: the wheel or two fingers zoom where
  // they are; dragging the empty paper (or with the middle or right button)
  // moves it; a double tap on the empty paper goes closer there, or back to
  // all of it. Only the SVG's viewBox changes (the sheet isn't drawn again).
  const camera = new SheetCamera();
  const zoomBox = el("div", "bim-dzoom");
  const zoomOut = el("button", "bim-dzoom-btn", "−");
  const zoomLabel = el("button", "bim-dzoom-btn bim-dzoom-fit", "100%");
  const zoomIn = el("button", "bim-dzoom-btn", "+");
  zoomOut.title = "Zoom out (−)";
  zoomLabel.title = "All of the sheet (F)";
  zoomIn.title = "Zoom in (+)";
  zoomBox.append(zoomOut, zoomLabel, zoomIn);
  stage.append(zoomBox);
  const applyCamera = () => {
    paper.querySelector("svg")?.setAttribute("viewBox", camera.viewBox());
    zoomLabel.textContent = `${Math.round(camera.ratio() * 100)}%`;
  };
  /** A screen point (px) in the paper's area. */
  const local = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = paper.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const copyCamera = () => Object.assign(new SheetCamera(), { vw: camera.vw, vh: camera.vh, W: camera.W, H: camera.H, z: camera.z, cx: camera.cx, cy: camera.cy });
  let glide = 0;
  /** To another zoom smoothly (a fifth of a second). */
  const glideTo = (to: { z: number; cx: number; cy: number }, fitted = false) => {
    cancelAnimationFrame(glide);
    const from = camera.state;
    const t0 = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / 180);
      camera.blend(from, to, 1 - Math.pow(1 - k, 3));
      camera.fitted = fitted && k === 1;
      applyCamera();
      if (k < 1) glide = requestAnimationFrame(step);
    };
    glide = requestAnimationFrame(step);
  };
  const fitAll = () => {
    const c = copyCamera();
    c.fit();
    glideTo(c.state, true);
  };
  const zoomBy = (k: number, at: [number, number] = [camera.vw / 2, camera.vh / 2]) => {
    const c = copyCamera();
    c.zoomAt(at[0], at[1], k);
    glideTo(c.state);
  };
  zoomOut.addEventListener("click", () => zoomBy(1 / 1.5));
  zoomIn.addEventListener("click", () => zoomBy(1.5));
  zoomLabel.addEventListener("click", fitAll);
  /** The area's exact size (not rounded to whole pixels: the paper under the cursor would creep). */
  const sizeCamera = () => {
    const r = paper.getBoundingClientRect();
    camera.resize(r.width, r.height);
  };
  const resized = new ResizeObserver(() => {
    sizeCamera();
    applyCamera();
  });
  resized.observe(paper);
  paper.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      cancelAnimationFrame(glide);
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const at = local(e);
      // A touchpad swiped sideways moves the sheet; a wheel (or a touchpad pinch: ctrl) zooms, about 8 % a notch.
      if (!e.ctrlKey && !e.metaKey && Math.abs(e.deltaX) > Math.abs(e.deltaY)) camera.panBy(-e.deltaX * unit, -e.deltaY * unit);
      else camera.zoomAt(at[0], at[1], Math.exp(-e.deltaY * unit * (e.ctrlKey ? 0.01 : 0.0008)));
      applyCamera();
    },
    { passive: false },
  );
  // The right button moves the sheet (no menu).
  paper.addEventListener("contextmenu", (e) => e.preventDefault());

  let views = new Map<string, ProjectedView>();
  let parts: PartRow[] = [];
  let allParts: PartRow[] = [];
  let layout: Layout | null = null;
  let tool: ToolId | null = null;
  let selected: string | null = null;
  let picks: Pick[] = [];
  /** While dragging: the drawing as it would be (committed when let go). */
  let draft: DrawingOptions | null = null;
  const date = new Date();
  /** The sheet as printed or saved (made then: each redraw needn't). */
  const sheetOut = () => drawingSVG({ doc: docNow(), views, parts, date }).svg;

  const docNow = (): ProjectDoc => (draft ? { ...store.doc, drawing: draft } : store.doc);
  const opts = (): Opts => drawingOptions(docNow());
  const set = (patch: Partial<DrawingOptions>) =>
    store.commit((d) => {
      const next: DrawingOptions = { ...(d.drawing ?? {}), ...patch };
      for (const k of Object.keys(next) as (keyof DrawingOptions)[]) if (next[k] === undefined) delete next[k];
      d.drawing = next;
    });

  const shut = () => {
    resized.disconnect();
    cancelAnimationFrame(glide);
    back.remove();
    window.removeEventListener("keydown", onKey, true);
    off();
  };
  close.addEventListener("click", shut);

  // ---- Kernel: the views of the bodies drawn.
  const load = async () => {
    paper.innerHTML = "";
    const status = el("div", "bim-sub", "Measuring the bodies…");
    paper.append(status);
    try {
      allParts = partsList(app, await measureBodies(app));
      const want = drawingOptions(store.doc).bodies?.filter((id) => allParts.some((p) => p.id === id));
      parts = want?.length ? allParts.filter((p) => want.includes(p.id)) : allParts;
      if (!parts.length) {
        paper.innerHTML = "";
        paper.append(el("div", "bim-sub", "No bodies to draw: make one first (hidden bodies are left off the drawing)."));
        return;
      }
      views = new Map();
      failed.clear();
      // One view at a time, saying how far it got (a big assembly takes seconds a view).
      const first = wanted();
      const list = first.length ? first : VIEW_SPECS.slice(0, 1);
      const got: ProjectedView[] = [];
      for (const [i, v] of list.entries()) {
        status.textContent = `Drawing the views: ${i + 1} of ${list.length}…`;
        got.push(...(await app.kernel.drawing(store.doc.features as never, [v], parts.map((p) => p.id))));
      }
      views = new Map(got.map((v) => [v.id, v]));
      drawnAs.clear();
      for (const v of list) drawnAs.set(v.id, JSON.stringify(v));
    } catch (err) {
      paper.innerHTML = "";
      paper.append(el("div", "bim-sub", `The views could not be drawn: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }
    render();
  };

  // ---- Only the views the sheet shows are drawn (a big assembly takes seconds
  // a view); one switched on later, the other side view, a section, is drawn then.
  const failed = new Set<string>();
  /** What each drawn view was drawn as (a section flipped is drawn again). */
  const drawnAs = new Map<string, string>();
  let fetching = false;
  const wanted = (): ViewSpec[] => {
    const o = opts();
    const side = o.angle === "first" ? "left" : "right";
    const base = VIEW_SPECS.filter((v) => (v.id === "front" || v.id === "top" || v.id === "iso" ? o.views[v.id] : o.views.side && v.id === side));
    return [...base, ...extraSpecs(o)];
  };
  const fetchMissing = async () => {
    const miss = wanted().filter((v) => (!views.has(v.id) || drawnAs.get(v.id) !== JSON.stringify(v)) && !failed.has(JSON.stringify(v)));
    if (!miss.length || fetching) return;
    fetching = true;
    const of = views;
    name.textContent = `Drawing · ${opts().title} · drawing the views…`;
    try {
      const got = await app.kernel.drawing(store.doc.features as never, miss, parts.map((p) => p.id));
      if (of !== views) return;
      for (const v of got) views.set(v.id, v);
      for (const v of miss) drawnAs.set(v.id, JSON.stringify(v));
    } catch {
      for (const v of miss) failed.add(JSON.stringify(v));
    } finally {
      fetching = false;
    }
    if (of === views) render();
    else void fetchMissing();
  };

  // ---- The sheet
  const render = () => {
    if (!views.size) return;
    void fetchMissing();
    const doc = docNow();
    const made = drawingSVG({ doc, views, parts, date, interactive: true, selected });
    layout = made.layout;
    paper.innerHTML = made.svg;
    const s = paper.querySelector("svg");
    if (s) {
      // The sheet fills the area; what of it is seen is the camera's.
      const vb = s.viewBox.baseVal;
      camera.setSheet(vb.width, vb.height);
      if (camera.vw <= 1) sizeCamera();
      s.setAttribute("width", "100%");
      s.setAttribute("height", "100%");
      s.setAttribute("preserveAspectRatio", "xMidYMid meet");
      s.classList.add("bim-drawing-svg");
      applyCamera();
    }
    if (!fetching) name.textContent = `Drawing · ${drawingOptions(doc).title}`;
    if (s) s.insertAdjacentHTML("beforeend", picksSVG());
    if (!draft) (renderTools(), renderProps(), showSelection());
  };
  /** What the tool has picked so far, shown on the sheet. */
  const picksSVG = (): string => {
    if (!tool || !picks.length || !layout) return "";
    const at = (k: Pick) => {
      const p = layout!.views.find((v) => v.id === k.view);
      return p ? toPaper(p, k.p) : null;
    };
    const blue = `stroke="#1a73e8" stroke-width="0.5" fill="none"`;
    let out = "";
    if (tool === "detail" && picks.length === 2) {
      const c = at(picks[0]);
      const p = layout.views.find((v) => v.id === picks[0].view);
      if (c && p) out += `<circle cx="${c[0]}" cy="${c[1]}" r="${picks[1].p[0] * p.s}" ${blue} stroke-dasharray="2 1"/>`;
    }
    if (tool === "section" && picks.length === 2) {
      const a = at(picks[0]);
      const b = at(picks[1]);
      if (a && b) out += `<path d="M${a[0]} ${a[1]}L${b[0]} ${b[1]}" ${blue} stroke-dasharray="4 1 1 1"/>`;
    }
    for (const k of picks) {
      if (tool === "detail" && k === picks[1]) continue;
      const p = layout.views.find((v) => v.id === k.view);
      if (k.line && p) {
        const a = toPaper(p, k.line.a);
        const b = toPaper(p, k.line.b);
        out += `<path d="M${a[0]} ${a[1]}L${b[0]} ${b[1]}" stroke="#1a73e8" stroke-width="0.8"/>`;
      } else {
        const c = at(k);
        if (c) out += `<circle cx="${c[0]}" cy="${c[1]}" r="1" fill="#1a73e8"/>`;
      }
    }
    return out;
  };
  const off = store.onChange(() => {
    if (!draft) render();
  });

  // ---- Where the pointer is on the paper (mm)
  const sheetPoint = (e: { clientX: number; clientY: number }): [number, number] | null => {
    const s = paper.querySelector("svg");
    const m = s?.getScreenCTM();
    if (!s || !m) return null;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return [p.x, p.y];
  };
  /** A point on the paper, on the screen. */
  const clientOf = (q: P2): P2 => {
    const m = paper.querySelector("svg")?.getScreenCTM();
    if (!m) return [0, 0];
    const p = new DOMPoint(q[0], q[1]).matrixTransform(m);
    return [p.x, p.y];
  };
  /** 12 screen pixels, in mm on the paper. */
  const tolerance = () => 12 / camera.z;

  // ---- Tapping and dragging on the sheet
  let frame = 0;
  let drag: { id: number; x: number; y: number; target: string; moved: boolean; start: DrawingOptions } | null = null;
  /** The fingers (or the mouse) down on the paper, where they are (px). */
  const fingers = new Map<number, [number, number]>();
  let pinch: { d: number; mid: [number, number] } | null = null;
  let pan: { id: number; x: number; y: number; moved: boolean; deselect: boolean } | null = null;
  const pair = (): [[number, number], [number, number]] => {
    const [a, b] = [...fingers.values()];
    return [a, b];
  };
  const startPan = (e: PointerEvent, deselect: boolean) => {
    const [x, y] = local(e);
    pan = { id: e.pointerId, x, y, moved: false, deselect };
  };
  paper.addEventListener("pointerdown", (e) => {
    fingers.set(e.pointerId, local(e));
    try {
      paper.setPointerCapture(e.pointerId);
    } catch {
      // Already let go.
    }
    if (fingers.size >= 2) {
      // A second finger: no dragging of what the first one held; the two zoom and move the sheet.
      if (drag) {
        drag = null;
        draft = null;
        render();
      }
      pan = null;
      const [a, b] = pair();
      pinch = { d: Math.hypot(b[0] - a[0], b[1] - a[1]), mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
      cancelAnimationFrame(glide);
      return;
    }
    // The middle or right button: the sheet moves, whatever is under it.
    if (e.button === 1 || e.button === 2) {
      e.preventDefault();
      return startPan(e, false);
    }
    const q = sheetPoint(e);
    if (!q || !layout) return;
    if (tool) {
      // Off the paper (the grey round it): nothing to pick, no note out there.
      const [W, H] = sheetSize(opts());
      if (q[0] < 0 || q[1] < 0 || q[0] > W || q[1] > H) return;
      return void useTool(q, e);
    }
    const t = e.target as Element;
    const ann = t.closest("[data-ann]")?.getAttribute("data-ann");
    const view = t.closest("[data-view]")?.getAttribute("data-view");
    const target = ann ?? (view ? `view:${view}` : null);
    if (!target) {
      // The empty paper: dragged, it moves; tapped, nothing is picked any more.
      e.preventDefault();
      return startPan(e, true);
    }
    e.preventDefault();
    selected = target;
    drag = { id: e.pointerId, x: q[0], y: q[1], target, moved: false, start: structuredClone(store.doc.drawing ?? {}) };
    try {
      paper.setPointerCapture(e.pointerId);
    } catch {
      // Already let go.
    }
    render();
  });
  paper.addEventListener("pointermove", (e) => {
    if (fingers.has(e.pointerId)) fingers.set(e.pointerId, local(e));
    if (pinch && fingers.size >= 2) {
      const [a, b] = pair();
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      camera.panBy(mid[0] - pinch.mid[0], mid[1] - pinch.mid[1]);
      if (pinch.d > 0 && d > 0) camera.zoomAt(mid[0], mid[1], d / pinch.d);
      pinch = { d, mid };
      applyCamera();
      return;
    }
    if (pan && e.pointerId === pan.id) {
      const [x, y] = local(e);
      if (!pan.moved && Math.hypot(x - pan.x, y - pan.y) < 4) return;
      if (!pan.moved) cancelAnimationFrame(glide);
      pan.moved = true;
      paper.classList.add("panning");
      camera.panBy(x - pan.x, y - pan.y);
      pan.x = x;
      pan.y = y;
      applyCamera();
      return;
    }
    if (!drag || e.pointerId !== drag.id || !layout) return;
    const q = sheetPoint(e);
    if (!q) return;
    const dx = q[0] - drag.x;
    const dy = q[1] - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < tolerance() / 4) return;
    drag.moved = true;
    const next: DrawingOptions = structuredClone(drag.start);
    const o = drawingOptions({ ...store.doc, drawing: drag.start });
    if (drag.target.startsWith("view:")) {
      const v = drag.target.slice(5);
      const sec = o.sections.find((x) => x.id === v);
      const det = o.details.find((x) => x.id === v);
      const ex = o.extra.find((x) => x.id === v);
      const placed = layout.views.find((x) => x.id === v);
      if (ex && (ex.orient || isIsoView(ex))) {
        // A base view or an isometric projection: anywhere.
        const at: P2 = ex.at ?? (placed ? [placed.x + ((placed.box[1][0] - placed.box[0][0]) * placed.s) / 2, placed.y + ((placed.box[1][1] - placed.box[0][1]) * placed.s) / 2] : [0, 0]);
        next.extra = o.extra.map((x) => (x === ex ? { ...x, at: [at[0] + dx, at[1] + dy] } : x));
      } else if (ex && ex.dir && placed) {
        // A projection square on: along its line from its view only (it stays lined up).
        const vert = Math.abs(ex.dir[1]) >= Math.abs(ex.dir[0]);
        const along = vert ? dy * Math.sign(ex.dir[1]) : dx * Math.sign(ex.dir[0]);
        const half = (vert ? placed.box[1][1] - placed.box[0][1] : placed.box[1][0] - placed.box[0][0]) * placed.s * 0.5 + 8;
        next.extra = o.extra.map((x) => (x === ex ? { ...x, gap: Math.max(half, ex.gap ?? 0) + along } : x));
      } else if (sec) {
        // A section slides along its line from its view only (it stays lined up).
        const pl = placeDir(sec, o);
        const along = Math.abs(pl[1]) >= Math.abs(pl[0]) ? dy * Math.sign(pl[1]) : dx * Math.sign(pl[0]);
        const placed = layout.views.find((x) => x.id === sec.id);
        const half = placed ? (Math.abs(pl[1]) >= Math.abs(pl[0]) ? placed.box[1][1] - placed.box[0][1] : placed.box[1][0] - placed.box[0][0]) * placed.s * 0.5 + 16 : 0;
        next.sections = o.sections.map((x) => (x === sec ? { ...x, gap: Math.max(half, sec.gap) + along } : x));
      } else if (det) next.details = o.details.map((x) => (x === det ? { ...x, at: [det.at[0] + dx, det.at[1] + dy] } : x));
      else {
        const k = moveKey(v);
        const [mx, my] = o.moved[k] ?? [0, 0];
        next.moved = { ...o.moved, [k]: [mx + dx, my + dy] };
      }
    } else {
      const id = drag.target;
      const dim = o.dims.find((d) => d.id === id);
      const note = o.notes.find((n) => n.id === id);
      const img = o.images.find((m) => m.id === id);
      if (note) next.notes = o.notes.map((n) => (n === note ? { ...n, x: note.x + dx, y: note.y + dy } : n));
      if (img) next.images = o.images.map((m) => (m === img ? { ...m, x: img.x + dx, y: img.y + dy } : m));
      if (dim) {
        const p = layout.views.find((v) => v.id === dim.view);
        if (p) next.dims = o.dims.map((d) => (d === dim ? movedDim(dim, p, q) : d));
      }
    }
    draft = next;
    // Once a frame at most (a mouse moves more often than the screen shows).
    if (!frame)
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (draft) render();
      });
  });
  const endDrag = (e: PointerEvent) => {
    fingers.delete(e.pointerId);
    if (pinch) {
      // The pinch is over once a finger lifts (the other doesn't start a drag).
      if (fingers.size < 2) pinch = null;
      return;
    }
    if (pan && e.pointerId === pan.id) {
      const p = pan;
      pan = null;
      paper.classList.remove("panning");
      if (!p.moved && p.deselect && selected) (selected = null), render();
      return;
    }
    if (!drag || e.pointerId !== drag.id) return;
    const moved = drag.moved;
    drag = null;
    const d = draft;
    draft = null;
    if (moved && d) store.commit((doc) => (doc.drawing = d));
    else render();
  };
  paper.addEventListener("pointerup", endDrag);
  paper.addEventListener("pointercancel", endDrag);
  // A double tap: on a note, write it again; on a dimension, its text and tolerance; on the empty paper, see it closer (or all of it again).
  paper.addEventListener("dblclick", (e) => {
    if (tool) return;
    const id = (e.target as Element).closest("[data-ann]")?.getAttribute("data-ann");
    const n = opts().notes.find((x) => x.id === id);
    if (n) return noteInput([n.x, n.y], e.clientX, e.clientY, n);
    const d = opts().dims.find((x) => x.id === id);
    if (d) return void editDim(d);
    if ((e.target as Element).closest("[data-ann],[data-view]")) return;
    if (camera.ratio() < 1.5) zoomBy(2.5, local(e));
    else fitAll();
  });

  /** A dimension dragged to a point: its line through there (a circle's: its leader towards it). */
  const movedDim = (d: DrawingDim, p: Layout["views"][number], q: [number, number]): DrawingDim => {
    if (d.kind === "angle" && d.c) {
      const c = toPaper(p, d.c);
      return { ...d, offset: Math.max(3, Math.hypot(q[0] - c[0], q[1] - c[1])) };
    }
    if (d.c && d.r !== undefined) {
      const c = toPaper(p, d.c);
      return { ...d, angle: Math.atan2(q[1] - c[1], q[0] - c[0]), offset: Math.max(2, Math.hypot(q[0] - c[0], q[1] - c[1]) - d.r * p.s) };
    }
    if (!d.b) return d;
    const A = toPaper(p, d.a);
    const B = toPaper(p, d.b);
    const L = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1;
    const n = [(B[1] - A[1]) / L, -(B[0] - A[0]) / L];
    return { ...d, offset: (q[0] - A[0]) * n[0] + (q[1] - A[1]) * n[1] };
  };

  // ---- The dimension and note tools
  const startTool = (t: ToolId | null) => {
    tool = t;
    picks = [];
    selected = null;
    hint.hidden = !t;
    paper.classList.toggle("picking", !!t);
    if (t) showHint(TOOL_HINT[t]);
    render();
  };
  const showHint = (msg: string) => {
    hint.innerHTML = "";
    const done = el("button", "text-btn on", "Done");
    done.addEventListener("click", () => startTool(null));
    hint.append(el("span", "", msg), done);
  };
  const addDim = (d: DrawingDim) => {
    // The same edge (or circle) dimensioned again: the one it has is picked instead.
    const straight = (k: string) => k === "length" || k === "distance";
    const near = (p?: [number, number], q?: [number, number]) => (!p && !q) || (!!p && !!q && Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-3);
    const same = opts().dims.find(
      (x) =>
        x.view === d.view &&
        (x.kind === d.kind || (straight(x.kind) && straight(d.kind))) &&
        (d.kind === "radius" || d.kind === "diameter"
          ? near(x.c, d.c) && Math.abs((x.r ?? 0) - (d.r ?? 0)) < 1e-3
          : near(x.c, d.c) && ((near(x.a, d.a) && near(x.b, d.b)) || (near(x.a, d.b) && near(x.b, d.a)))),
    );
    if (same) {
      selected = same.id;
      render();
      return app.ui.toast("That one is dimensioned already");
    }
    set({ dims: [...opts().dims, d] });
  };
  const placedOf = (id: string) => layout!.views.find((v) => v.id === id)!;
  /** A point picked: a corner, a middle or a centre near the tap (in `view` if given). */
  const pointPick = (q: P2, view?: string): Pick | null => pointAt(views, layout!, q, tolerance() * 1.5, view);
  /** A point picked, or where the tap is on the view under it (not the isometric one, not a detail). */
  const freePick = (q: P2, view?: string): Pick | null => {
    const hit = pointPick(q, view);
    if (hit && !placedOf(hit.view).clip) return hit;
    for (const p of layout!.views) {
      if (p.iso || p.clip || (view && p.id !== view)) continue;
      const r = extent(p);
      if (q[0] > r.x0 - 3 && q[0] < r.x1 + 3 && q[1] > r.y0 - 3 && q[1] < r.y1 + 3) return { view: p.id, p: fromPaper(p, q) };
    }
    return null;
  };
  const linePick = (q: P2, view?: string): (EdgeHit & { line: { a: P2; b: P2 } }) | null => {
    const hit = edgeAt(views, layout!, q, tolerance(), "line");
    return hit && (!view || hit.view === view) ? { ...hit, line: { a: hit.a, b: hit.b } } : null;
  };
  const step = (msg: string) => (showHint(msg), render());
  const addMark = (m: DrawingMark) => {
    const near = (p?: P2, q?: P2) => (!p && !q) || (!!p && !!q && len2(sub2(p, q)) < 1e-3);
    const o = opts();
    const same = o.marks.find((x) => x.view === m.view && x.kind === m.kind && near(x.c, m.c) && ((near(x.a, m.a) && near(x.b, m.b)) || (near(x.a, m.b) && near(x.b, m.a))));
    if (same) {
      selected = same.id;
      render();
      return app.ui.toast("That one is there already");
    }
    set({ marks: [...o.marks, m] });
  };
  /** A dimension's arc for an angle: half the shorter ray, on the paper, 8 to 30 mm. */
  const arcFor = (view: string, c: P2, a: P2, b: P2) => Math.min(30, Math.max(8, 0.5 * Math.min(len2(sub2(a, c)), len2(sub2(b, c))) * placedOf(view).s));

  const useTool = (q: [number, number], e: PointerEvent) => {
    if (!layout) return;
    const tol = tolerance();
    const view = picks[0]?.view;
    const again = (msg: string) => app.ui.toast(picks.length ? `${msg} in the same view` : msg);
    if (tool === "length") {
      const hit = edgeAt(views, layout, q, tol, "line");
      if (!hit) return app.ui.toast("Tap right on a straight edge of a view");
      const p = layout.views.find((v) => v.id === hit.view)!;
      addDim({ id: annId("dim"), view: hit.view, kind: "length", a: hit.a, b: hit.b, offset: outward(p, hit.a, hit.b) });
    } else if (tool === "distance" || tool === "cline") {
      const hit = pointPick(q, view);
      if (!hit) return again("Tap a corner, the middle of an edge or a centre");
      if (!picks.length) return (picks.push(hit), step("Now tap the second point"));
      if (len2(sub2(hit.p, picks[0].p)) < 1e-6) return;
      const a = picks[0].p;
      picks = [];
      if (tool === "cline") addMark({ id: annId("mark"), view: hit.view, kind: "line", a, b: hit.p });
      else addDim({ id: annId("dim"), view: hit.view, kind: "distance", a, b: hit.p, offset: outward(placedOf(hit.view), a, hit.p) });
      showHint(TOOL_HINT[tool]);
    } else if (tool === "pointLine") {
      if (!picks.length) {
        const hit = pointPick(q);
        if (!hit) return app.ui.toast("Tap a corner, the middle of an edge or a centre");
        return (picks.push(hit), step("Now tap a straight edge"));
      }
      const hit = linePick(q, view);
      if (!hit) return again("Tap a straight edge");
      const a = picks[0].p;
      const b = foot(a, hit.a, hit.b);
      picks = [];
      if (len2(sub2(a, b)) < 1e-6) return (app.ui.toast("That point is on the edge"), step(TOOL_HINT.pointLine));
      addDim({ id: annId("dim"), view: hit.view, kind: "distance", a, b, offset: outward(placedOf(hit.view), a, b) });
      showHint(TOOL_HINT.pointLine);
    } else if (tool === "lineLine" || tool === "angle" || tool === "clineLines") {
      const hit = linePick(q, view);
      if (!hit) return again("Tap a straight edge");
      if (!picks.length) return (picks.push({ view: hit.view, p: foot(fromPaper(placedOf(hit.view), q), hit.a, hit.b), line: hit.line }), step("Now tap the second edge"));
      const first = picks[0];
      const l1 = first.line!;
      const u1 = unit2(sub2(l1.b, l1.a));
      const u2 = unit2(sub2(hit.b, hit.a));
      const parallel = Math.abs(cross2(u1, u2)) < PARALLEL;
      picks = [];
      if (tool === "angle") {
        if (parallel) return (app.ui.toast("Those edges are parallel: they make no angle"), step(TOOL_HINT.angle));
        // Where they meet, and a point on each the side tapped.
        const d = sub2(hit.a, l1.a);
        const t = cross2(d, u2) / cross2(u1, u2);
        const c: P2 = [l1.a[0] + u1[0] * t, l1.a[1] + u1[1] * t];
        const far = (l: { a: P2; b: P2 }, tap: P2): P2 => {
          const f = foot(tap, l.a, l.b);
          if (len2(sub2(f, c)) > 1e-6) return f;
          return len2(sub2(l.a, c)) > len2(sub2(l.b, c)) ? l.a : l.b;
        };
        const a = far(l1, first.p);
        const b = far(hit.line, foot(fromPaper(placedOf(hit.view), q), hit.a, hit.b));
        addDim({ id: annId("dim"), view: hit.view, kind: "angle", c, a, b, offset: arcFor(hit.view, c, a, b) });
      } else {
        if (!parallel) return (app.ui.toast(tool === "lineLine" ? "Those edges aren't parallel: use Line-to-Line Angle" : "Those edges aren't parallel"), step(TOOL_HINT[tool]));
        if (tool === "lineLine") {
          const a: P2 = [(l1.a[0] + l1.b[0]) / 2, (l1.a[1] + l1.b[1]) / 2];
          const b = foot(a, hit.a, hit.b);
          if (len2(sub2(a, b)) < 1e-6) return (app.ui.toast("Those edges are on one line"), step(TOOL_HINT.lineLine));
          addDim({ id: annId("dim"), view: hit.view, kind: "distance", a, b, offset: outward(placedOf(hit.view), a, b) });
        } else {
          // Midway between them, from the first end to the last of the two.
          const n: P2 = [-u1[1], u1[0]];
          const dot = (p: P2, v: P2) => p[0] * v[0] + p[1] * v[1];
          const dm = (dot(l1.a, n) + dot(hit.a, n)) / 2;
          const ts = [l1.a, l1.b, hit.a, hit.b].map((p) => dot(p, u1));
          const at = (t: number): P2 => [u1[0] * t + n[0] * dm, u1[1] * t + n[1] * dm];
          addMark({ id: annId("mark"), view: hit.view, kind: "line", a: at(Math.min(...ts)), b: at(Math.max(...ts)) });
        }
      }
      showHint(TOOL_HINT[tool]);
    } else if (tool === "angle3") {
      const hit = pointPick(q, view);
      if (!hit) return again("Tap a corner, the middle of an edge or a centre");
      if (picks.some((k) => len2(sub2(k.p, hit.p)) < 1e-6)) return;
      picks.push(hit);
      if (picks.length === 1) return step("Now tap the corner the angle is at");
      if (picks.length === 2) return step("Now tap the third point");
      const [a, c, b] = picks.map((k) => k.p);
      picks = [];
      if (Math.abs(cross2(unit2(sub2(a, c)), unit2(sub2(b, c)))) < 1e-9) return (app.ui.toast("Those points are on one line"), step(TOOL_HINT.angle3));
      addDim({ id: annId("dim"), view: hit.view, kind: "angle", c, a, b, offset: arcFor(hit.view, c, a, b) });
      showHint(TOOL_HINT.angle3);
    } else if (tool === "arcAngle") {
      const hit = edgeAt(views, layout, q, tol, "circle");
      if (!hit || !hit.c || hit.r === undefined || !hit.m) return app.ui.toast("Tap right on an arc of a view (seen face on)");
      if (len2(sub2(hit.a, hit.b)) < 1e-6 * Math.max(1, hit.r)) return app.ui.toast("That is a whole circle (360°): tap an arc");
      addDim({ id: annId("dim"), view: hit.view, kind: "angle", c: hit.c, a: hit.a, b: hit.b, through: hit.m, offset: hit.r * placedOf(hit.view).s + 6 });
    } else if (tool === "minmax") {
      // A point when the tap is right on one (a corner, a centre), else the edge or circle under it.
      const pt = pointAt(views, layout, q, tol * 0.7, view);
      const edge = pt ? null : edgeAt(views, layout, q, tol);
      const ent: (Ent & { view: string }) | null = pt
        ? { kind: "point", p: pt.p, view: pt.view }
        : edge && (!view || edge.view === view)
          ? edge.kind === "circle" && edge.c && edge.r !== undefined && edge.m
            ? { kind: "circle", c: edge.c, r: edge.r, a: edge.a, m: edge.m, b: edge.b, view: edge.view }
            : { kind: "line", a: edge.a, b: edge.b, view: edge.view }
          : null;
      if (!ent) return again("Tap a point, an edge or a circle");
      if (!picks.length) return (picks.push({ view: ent.view, p: [0, 0], ent }), step("Now tap the second one"));
      const first = picks[0].ent!;
      picks = [];
      const mm = minMax(first, ent);
      const gap = (pr: [P2, P2]) => len2(sub2(pr[0], pr[1]));
      const max = gap(mm.min) < 1e-6;
      const [a, b] = max ? mm.max : mm.min;
      if (gap([a, b]) < 1e-6) return (app.ui.toast("Those two meet: there is no distance between them"), step(TOOL_HINT.minmax));
      addDim({ id: annId("dim"), view: ent.view, kind: "distance", a, b, minmax: mm, ...(max ? { max } : {}), offset: outward(placedOf(ent.view), a, b) });
      showHint(TOOL_HINT.minmax);
    } else if (tool === "base") {
      const o = opts();
      const id = annId("view");
      set({ extra: [...o.extra, { id, orient: pendingBase.orient, at: q, ...(pendingBase.scale ? { scale: pendingBase.scale } : {}) }] });
      startTool(null);
      selected = `view:${id}`;
      render();
    } else if (tool === "projection") {
      if (!picks.length) {
        const p = layout.views.find((v) => {
          const r = extent(v);
          return q[0] >= r.x0 - 2 && q[0] <= r.x1 + 2 && q[1] >= r.y0 - 2 && q[1] <= r.y1 + 2;
        });
        if (!p) return app.ui.toast("Tap on a view");
        if (!specOf(p.id, opts())) return app.ui.toast("Views are projected from the front, top and side views, added ones and sections (not an isometric one or a detail)");
        return (picks.push({ view: p.id, p: [0, 0] }), step("Tap beside it (left, right, above, below) for a view square on, or past a corner for an isometric one"));
      }
      const p = placedOf(picks[0].view);
      const r = extent(p);
      const dir: P2 = [q[0] > r.x1 ? 1 : q[0] < r.x0 ? -1 : 0, q[1] > r.y1 ? 1 : q[1] < r.y0 ? -1 : 0];
      if (!dir[0] && !dir[1]) return app.ui.toast("Tap outside the view: beside it, or past a corner");
      const o = opts();
      const id = annId("view");
      const corner = dir[0] && dir[1];
      const gap = dir[1] ? (dir[1] > 0 ? q[1] - r.y1 : r.y0 - q[1]) : dir[0] > 0 ? q[0] - r.x1 : r.x0 - q[0];
      picks = [];
      set({ extra: [...o.extra, corner ? { id, view: p.id, dir, at: q } : { id, view: p.id, dir, gap: Math.max(0, gap) }] });
      startTool(null);
      selected = `view:${id}`;
      render();
    } else if (tool === "radius" || tool === "diameter" || tool === "center") {
      const hit = edgeAt(views, layout, q, tol, "circle");
      if (!hit || !hit.c || hit.r === undefined) return app.ui.toast("Tap right on a circle or an arc of a view (seen face on)");
      const p = layout.views.find((v) => v.id === hit.view)!;
      const c = toPaper(p, hit.c);
      if (tool === "center") addMark({ id: annId("mark"), view: hit.view, kind: "center", c: hit.c, r: hit.r });
      else addDim({ id: annId("dim"), view: hit.view, kind: tool, a: hit.a, c: hit.c, r: hit.r, offset: 6, angle: Math.atan2(q[1] - c[1], q[0] - c[0]) || -Math.PI / 4 });
    } else if (tool === "section") {
      if (picks.length < 2) {
        const hit = freePick(q, view);
        if (!hit) return again("Tap on a view (not the isometric one or a detail)");
        if (!specOf(hit.view, opts())) return app.ui.toast("Sections are cut from the front, top and side views, or from another section");
        picks.push(hit);
        if (picks.length === 1) return step("Now tap where the cut line ends");
        // Nearly level or upright: made exactly so.
        const [a, b] = [picks[0].p, picks[1].p];
        const ang = Math.abs(Math.atan2(b[1] - a[1], b[0] - a[0]));
        if (Math.abs(Math.sin(ang)) < Math.sin((3 * Math.PI) / 180)) picks[1].p = [b[0], a[1]];
        else if (Math.abs(Math.cos(ang)) < Math.sin((3 * Math.PI) / 180)) picks[1].p = [a[0], b[1]];
        if (len2(sub2(picks[1].p, a)) * placedOf(hit.view).s < 2) return (picks.pop(), app.ui.toast("Draw a longer line"));
        return step("Tap the side of the line the section view goes on");
      }
      const [a, b] = [picks[0].p, picks[1].p];
      const p = placedOf(picks[0].view);
      const A = toPaper(p, a);
      const u = unit2(sub2(toPaper(p, b), A));
      const n: P2 = [-u[1], u[0]];
      const sg = Math.sign((q[0] - A[0]) * n[0] + (q[1] - A[1]) * n[1]) || 1;
      const place: P2 = [n[0] * sg, n[1] * sg];
      const o = opts();
      const look: P2 = o.angle === "first" ? place : [-place[0], -place[1]];
      const r = extent(p);
      const vertical = Math.abs(place[1]) >= Math.abs(place[0]);
      const gap = vertical ? (place[1] > 0 ? q[1] - r.y1 : r.y0 - q[1]) : place[0] > 0 ? q[0] - r.x1 : r.x0 - q[0];
      const id = annId("sec");
      picks = [];
      set({ sections: [...o.sections, { id, letter: nextLetter(o), view: p.id, a, b, look, gap: Math.max(0, gap) }] });
      startTool(null);
      selected = `view:${id}`;
      render();
    } else if (tool === "detail") {
      if (!picks.length) {
        const hit = freePick(q);
        if (!hit) return app.ui.toast("Tap on a view (not the isometric one or a detail)");
        return (picks.push(hit), step("Now tap how far round it goes"));
      }
      const p = placedOf(picks[0].view);
      if (picks.length === 1) {
        const R = len2(sub2(q, toPaper(p, picks[0].p)));
        if (R < 2) return app.ui.toast("Make the circle bigger");
        return (picks.push({ view: p.id, p: [R / p.s, 0] }), step("Tap where the detail view goes"));
      }
      const o = opts();
      const id = annId("det");
      const det = { id, letter: nextLetter(o), view: p.id, c: picks[0].p, r: picks[1].p[0], at: q };
      picks = [];
      set({ details: [...o.details, det] });
      startTool(null);
      selected = `view:${id}`;
      render();
    } else if (tool === "note") {
      // On an edge: a note pointing at it, a little up and out from it.
      const hit = edgeAt(views, layout, q, tol);
      if (!hit) return noteInput(q, e.clientX, e.clientY);
      const p = placedOf(hit.view);
      const v = fromPaper(p, q);
      let at: P2;
      if (hit.kind === "circle" && hit.c && hit.r !== undefined) {
        const d = unit2(sub2(v, hit.c));
        at = [hit.c[0] + d[0] * hit.r, hit.c[1] + d[1] * hit.r];
      } else {
        const ab = sub2(hit.b, hit.a);
        const t = Math.max(0, Math.min(1, ((v[0] - hit.a[0]) * ab[0] + (v[1] - hit.a[1]) * ab[1]) / (ab[0] * ab[0] + ab[1] * ab[1] || 1)));
        at = [hit.a[0] + ab[0] * t, hit.a[1] + ab[1] * t];
      }
      const P = toPaper(p, at);
      const c = [p.x + ((p.box[1][0] - p.box[0][0]) * p.s) / 2, p.y + ((p.box[1][1] - p.box[0][1]) * p.s) / 2];
      const out = P[0] >= c[0] ? 1 : -1;
      const spot: P2 = [P[0] + out * 12 - (out < 0 ? 20 : 0), P[1] - 10];
      const [cx, cy] = clientOf(spot);
      noteInput(spot, cx, cy, undefined, { view: hit.view, p: at });
    }
  };
  /** Ends the note being written (kept). */
  let closeNote: (() => void) | null = null;
  const noteInput = (q: [number, number], cx: number, cy: number, edit?: DrawingNote, to?: DrawingNote["to"]) => {
    // One being written already: kept as it is.
    closeNote?.();
    const input = el("input", "bim-note-input");
    input.placeholder = "Note";
    input.value = edit?.text ?? "";
    const r = stage.getBoundingClientRect();
    stage.append(input);
    // On the screen whole (a phone is narrow): moved in from the right edge when it would run off.
    input.style.left = `${Math.max(4, Math.min(cx - r.left, r.width - input.offsetWidth - 4))}px`;
    input.style.top = `${Math.max(4, Math.min(cy - r.top - 14, r.height - input.offsetHeight - 4))}px`;
    setTimeout(() => input.focus(), 0);
    let done = false;
    const finish = (keep: boolean) => {
      if (done) return;
      done = true;
      closeNote = null;
      const t = input.value.trim();
      input.remove();
      if (keep) {
        const o = opts();
        if (edit) set({ notes: t ? o.notes.map((n) => (n.id === edit.id ? { ...n, text: t } : n)) : o.notes.filter((n) => n.id !== edit.id) });
        else if (t) set({ notes: [...o.notes, { id: annId("note"), x: q[0], y: q[1], text: t, ...(to ? { to } : {}) }] });
      }
      if (tool === "note") startTool(null);
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") finish(true);
      if (e.key === "Escape") finish(false);
    });
    closeNote = () => finish(true);
    input.addEventListener("blur", () => finish(true));
  };

  const removeSelected = () => {
    const id = selected;
    if (!id) return;
    selected = null;
    const o = opts();
    if (id.startsWith("view:")) {
      const v = id.slice(5);
      // A section, a detail or an added view: gone with what was put on it, and the views made from it.
      // A standard view taken off: the same for what was made from it (its switch in Views brings it back).
      const gone = new Set([v]);
      for (let grew = true; grew; ) {
        grew = false;
        for (const x of [...o.sections, ...o.details, ...o.extra]) if (!gone.has(x.id) && x.view && gone.has(x.view)) (gone.add(x.id), (grew = true));
      }
      const keep = <T extends { id: string; view?: string }>(list: T[]) => list.filter((x) => !gone.has(x.id) && !(x.view && gone.has(x.view)));
      const madeOf = gone.size > 1 || o.sections.some((x) => x.id === v) || o.details.some((x) => x.id === v) || o.extra.some((x) => x.id === v);
      if (madeOf) {
        set({
          ...(VIEW_SPECS.some((x) => x.id === v) ? { views: { ...o.views, [v === "left" || v === "right" ? "side" : v]: false } } : {}),
          sections: keep(o.sections),
          details: keep(o.details),
          extra: keep(o.extra),
          dims: keep(o.dims),
          marks: keep(o.marks),
          notes: o.notes.map((n) => (n.to && gone.has(n.to.view) ? { id: n.id, x: n.x, y: n.y, text: n.text } : n)),
        });
        return;
      }
      // A view taken off: back with its switch in Views.
      const key = v === "left" || v === "right" ? "side" : (v as "front" | "top" | "iso");
      set({ views: { ...o.views, [key]: false } });
    } else set({ dims: o.dims.filter((d) => d.id !== id), notes: o.notes.filter((n) => n.id !== id), marks: o.marks.filter((m) => m.id !== id), images: o.images.filter((m) => m.id !== id) });
  };

  /** With something picked and no tool on: what it is, and what can be done to it. */
  const showSelection = () => {
    if (tool) return;
    hint.innerHTML = "";
    hint.hidden = !selected;
    if (!selected) return;
    const id = selected;
    const o = opts();
    const button = (label: string, run: () => void, on = false) => {
      const b = el("button", `text-btn${on ? " on" : ""}`, label);
      b.addEventListener("click", run);
      hint.append(b);
    };
    /** A view's scale, picked from the standard ones. */
    const scaleSelect = (now: number, change: (s: number) => void) => {
      const s = el("select", "bim-select");
      for (const sc of SCALES) {
        const op = el("option", "", scaleLabel(sc));
        op.value = String(sc);
        op.selected = Math.abs(sc - now) < 1e-9;
        s.append(op);
      }
      if (![...s.options].some((x) => x.selected)) {
        const op = el("option", "", scaleLabel(now));
        op.value = String(now);
        op.selected = true;
        s.prepend(op);
      }
      s.title = "Scale";
      s.addEventListener("change", () => change(Number(s.value)));
      hint.append(s);
    };
    if (id.startsWith("view:")) {
      const v = id.slice(5);
      const sec = o.sections.find((x) => x.id === v);
      const det = o.details.find((x) => x.id === v);
      const ex = o.extra.find((x) => x.id === v);
      const now = layout?.views.find((x) => x.id === v)?.s ?? 1;
      if (ex) {
        hint.append(el("span", "", extraName(ex, o)));
        // A view lined up with another is at its scale (the lines run on from one to the other).
        if (ex.orient || isIsoView(ex)) scaleSelect(now, (s) => set({ extra: o.extra.map((x) => (x === ex ? { ...x, scale: s } : x)) }));
        else hint.append(el("span", "bim-sub", "Scale: its view's"));
      } else if (v === "iso") {
        hint.append(el("span", "", "Isometric view"));
        scaleSelect(now, (s) => set({ isoScale: s }));
      } else if (VIEW_SPECS.some((x) => x.id === v)) {
        // The front, top and side views share one scale: they line up.
        hint.append(el("span", "", VIEW_NAMES[v] ?? "View"));
        scaleSelect(now, (s) => set({ scale: s }));
      } else if (sec) {
        hint.append(el("span", "", `Section ${sec.letter}-${sec.letter}`));
        button("Flip", () => set({ sections: o.sections.map((x) => (x === sec ? { ...x, look: [-x.look[0], -x.look[1]] as P2 } : x)) }));
      } else if (det) {
        hint.append(el("span", "", `Detail ${det.letter}`));
        scaleSelect(now, (s) => set({ details: o.details.map((x) => (x === det ? { ...x, scale: s } : x)) }));
      } else hint.append(el("span", "", VIEW_NAMES[v] ?? "View"));
    } else {
      const d = o.dims.find((x) => x.id === id);
      const n = o.notes.find((x) => x.id === id);
      const img = o.images.find((x) => x.id === id);
      if (img) {
        hint.append(el("span", "", "Picture"));
        // Bigger or smaller about its middle.
        const resize = (k: number) => set({ images: o.images.map((x) => (x === img ? { ...x, x: img.x - (img.w * (k - 1)) / 2, y: img.y - (img.h * (k - 1)) / 2, w: img.w * k, h: img.h * k } : x)) });
        button("Smaller", () => resize(1 / 1.25));
        button("Bigger", () => resize(1.25));
      } else if (d) {
        hint.append(el("span", "", d.minmax ? "Min-Max Distance" : "Dimension"));
        const mm = d.minmax;
        if (mm) {
          const pv = layout?.views.find((x) => x.id === d.view);
          const flip = (max: boolean) => {
            const [a, b] = max ? mm.max : mm.min;
            if (len2(sub2(a, b)) < 1e-6) return app.ui.toast("They meet: the nearest is no distance");
            set({ dims: o.dims.map((x) => (x === d ? { ...x, a, b, max: max || undefined, offset: pv ? outward(pv, a, b) : x.offset } : x)) });
          };
          button("Min", () => flip(false), !d.max);
          button("Max", () => flip(true), !!d.max);
        }
        button("Text and tolerance", () => void editDim(d));
      } else if (n) {
        hint.append(el("span", "", "Note"));
        button("Edit", () => {
          const [cx, cy] = clientOf([n.x, n.y]);
          noteInput([n.x, n.y], cx, cy, n);
        });
      } else hint.append(el("span", "", "Centreline"));
    }
    button("Delete", removeSelected);
    button("Done", () => ((selected = null), render()), true);
  };

  // ---- Base views: which way, at what scale, then where.
  let pendingBase: { orient: ViewOrient; scale?: number } = { orient: "front" };
  const chooseBase = async () => {
    const orient = select(pendingBase.orient, Object.entries(ORIENTS).map(([k, r]) => [k, r.name]));
    const scale = select(String(pendingBase.scale ?? ""), [["", `The sheet's (${scaleLabel(layout?.scale ?? 1)})`], ...SCALES.map((s): [string, string] => [String(s), scaleLabel(s)])]);
    if (!(await form("Base View", [["View from", orient], ["Scale", scale]]))) return;
    pendingBase = { orient: orient.value as ViewOrient, ...(scale.value ? { scale: Number(scale.value) } : {}) };
    startTool("base");
  };

  // ---- Pictures: a file from the device, made small enough to keep in the project.
  const addImage = async () => {
    const input = el("input", "");
    input.type = "file";
    input.accept = "image/*";
    const file = await new Promise<File | null>((resolve) => {
      input.addEventListener("change", () => resolve(input.files?.[0] ?? null));
      input.click();
    });
    if (!file) return;
    try {
      const url = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(r.error);
        r.readAsDataURL(file);
      });
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("not a picture"));
        img.src = url;
      });
      // At most 1200 pixels across: plenty on paper, and the project stays small.
      const k = Math.min(1, 1200 / Math.max(img.naturalWidth, img.naturalHeight));
      let src = url;
      if (k < 1 || file.size > 400_000) {
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(img.naturalWidth * k));
        c.height = Math.max(1, Math.round(img.naturalHeight * k));
        c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
        src = file.type === "image/png" || file.type === "image/svg+xml" ? c.toDataURL("image/png") : c.toDataURL("image/jpeg", 0.85);
      }
      const [W, H] = sheetSize(opts());
      const w = Math.min(60, W / 4);
      const h = (w * img.naturalHeight) / Math.max(1, img.naturalWidth);
      const id = annId("img");
      set({ images: [...opts().images, { id, x: (W - w) / 2, y: (H - h) / 2, w, h, src }] });
      startTool(null);
      selected = id;
      render();
    } catch {
      app.ui.toast("That file isn't a picture this can show");
    }
  };

  /** A small window of rows; resolves true on OK. */
  const form = (title: string, rows: [string, HTMLElement][], note?: string): Promise<boolean> =>
    new Promise((resolve) => {
      const back = el("div", "dialog-back over-sheet");
      const box = el("form", "dialog");
      box.append(el("div", "panel-title", title));
      if (note) box.append(el("div", "dialog-note", note));
      const list = el("div", "dialog-list");
      for (const [label, control] of rows) {
        const l = el("label", "dialog-field");
        l.append(el("span", "field-label", label), control);
        list.append(l);
      }
      box.append(list);
      const done = (ok: boolean) => {
        back.remove();
        resolve(ok);
      };
      const buttons = el("div", "panel-buttons");
      buttons.append(textButton("Cancel", "Esc", () => done(false)), textButton("OK", "Enter", () => done(true), true));
      for (const b of buttons.querySelectorAll("button")) b.type = "button";
      box.append(buttons);
      box.addEventListener("submit", (e) => (e.preventDefault(), done(true)));
      box.addEventListener("keydown", (e) => {
        if (e.key === "Escape") done(false);
        if (e.key === "Enter" && !(e.target as HTMLElement).closest("select")) (e.preventDefault(), done(true));
        e.stopPropagation();
      });
      back.append(box);
      back.addEventListener("pointerdown", (e) => e.target === back && done(false));
      document.body.append(back);
      (list.querySelector("input, select") as HTMLElement | null)?.focus();
    });
  const select = (value: string, options: [string, string][]) => {
    const s = el("select", "bim-select");
    for (const [v, t] of options) {
      const op = el("option", "", t);
      op.value = v;
      op.selected = v === value;
      s.append(op);
    }
    return s;
  };
  const input = (value: string, placeholder = "") => {
    const i = el("input", "");
    i.value = value;
    i.placeholder = placeholder;
    i.autocomplete = "off";
    return i;
  };

  /** A dimension's text before and after its value, and its tolerance. */
  const editDim = async (d: DrawingDim) => {
    const o = opts();
    const angle = d.kind === "angle";
    // Tolerances are typed in the drawing's units (degrees for an angle), kept in mm (radians).
    const k = angle ? Math.PI / 180 : UNIT_MM[o.units];
    const shown = (v?: number) => (v === undefined ? "" : String(Math.round((v / k) * 1e6) / 1e6));
    const pre = input(d.prefix ?? "", "e.g. 4×");
    const post = input(d.suffix ?? "", "e.g. THRU");
    const kind = select(d.tol?.kind ?? "none", [
      ["none", "None"],
      ["sym", "Symmetrical (±)"],
      ["dev", "Deviation (+ / -)"],
      ["limits", "Limits (largest / smallest)"],
      ["basic", "Basic (boxed)"],
    ]);
    const up = input(shown(d.tol?.up), "0");
    const down = input(shown(d.tol?.down), "same as upper");
    up.inputMode = down.inputMode = "decimal";
    const unit = angle ? "°" : o.units;
    if (!(await form("Dimension text", [["Before the value", pre], ["After the value", post], ["Tolerance", kind], [`Upper (${unit})`, up], [`Lower (${unit})`, down]]))) return;
    const num = (s: string) => {
      const v = Number(s.trim().replace(",", "."));
      return s.trim() && Number.isFinite(v) ? Math.abs(v) * k : undefined;
    };
    const t = kind.value as NonNullable<DimText["tol"]>["kind"] | "none";
    const next: DrawingDim = { ...d, prefix: pre.value || undefined, suffix: post.value || undefined, tol: t === "none" ? undefined : { kind: t, up: num(up.value), down: num(down.value) } };
    for (const key of ["prefix", "suffix", "tol"] as const) if (next[key] === undefined) delete next[key];
    set({ dims: opts().dims.map((x) => (x.id === d.id ? next : x)) });
  };

  /** The first drawing: title, sheet, scale, views - then the sheet. */
  const preferences = async (): Promise<boolean> => {
    const o = opts();
    const title = input(o.title);
    const orient = select(o.portrait ? "portrait" : "landscape", [
      ["landscape", "Landscape"],
      ["portrait", "Portrait"],
    ]);
    const size = select(o.size, (Object.keys(SHEETS) as SheetSize[]).map((s) => [s, `${s.startsWith("ANSI") ? s : `ISO ${s}`} (${SHEETS[s][0]} × ${SHEETS[s][1]} mm)`]));
    const scale = select("auto", [["auto", "Largest that fits"], ...SCALES.map((s) => [String(s), scaleLabel(s)] as [string, string])]);
    const four = el("input", "");
    four.type = "checkbox";
    four.checked = true;
    const ok = await form(
      "Drawing preferences",
      [
        ["Drawing title", title],
        ["Orientation", orient],
        ["Sheet size", size],
        ["View-to-sheet scale", scale],
        ["Include 4 views: front, top, side, isometric", four],
      ],
      "All of these can be changed later in Properties.",
    );
    if (!ok) return false;
    set({
      title: title.value.trim() && title.value.trim() !== o.title ? title.value.trim() : undefined,
      portrait: orient.value === "portrait" || undefined,
      size: size.value as SheetSize,
      scale: scale.value === "auto" ? undefined : Number(scale.value),
      views: four.checked ? undefined : { front: true, top: false, side: false, iso: false },
    });
    return true;
  };

  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).closest?.("input, select")) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (tool) startTool(null);
      else if (selected) (selected = null), render();
      else shut();
    } else if ((e.key === "Delete" || e.key === "Backspace") && selected) {
      e.preventDefault();
      e.stopPropagation();
      removeSelected();
    } else if (!e.ctrlKey && !e.metaKey && !e.altKey && ["+", "=", "-", "_", "f", "F", "0"].includes(e.key)) {
      // Zoom in / out, all of the sheet.
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "+" || e.key === "=") zoomBy(1.5);
      else if (e.key === "-" || e.key === "_") zoomBy(1 / 1.5);
      else fitAll();
    }
  };
  window.addEventListener("keydown", onKey, true);

  // ---- The tools at the left
  let open: "views" | "dims" | "marks" | null = null;
  const renderTools = () => {
    tools.innerHTML = "";
    const o = opts();
    const button = (label: string, icon: IconName, run: () => void, opt: { on?: boolean; disabled?: boolean; sub?: boolean } = {}) => {
      const b = el("button", `bim-dtool${opt.on ? " on" : ""}${opt.sub ? " sub" : ""}`);
      b.innerHTML = icons[icon];
      b.append(el("span", "", label));
      b.title = label;
      b.disabled = !!opt.disabled;
      b.addEventListener("click", run);
      tools.append(b);
    };
    button("Exit Drawing", "close", shut);
    const pick = (t: ToolId, label: string, icon: IconName) => button(label, icon, () => startTool(tool === t ? null : t), { on: tool === t, sub: true });
    button("Views", "views", () => ((open = open === "views" ? null : "views"), renderTools()), { on: open === "views" || tool === "section" || tool === "detail" || tool === "base" || tool === "projection" });
    if (open === "views") {
      const toggle = (k: "front" | "top" | "side" | "iso", label: string) =>
        button(label, o.views[k] ? "eye" : "eyeOff", () => set({ views: { ...o.views, [k]: !o.views[k] } }), { on: o.views[k], sub: true });
      toggle("front", "Front");
      toggle("top", "Top");
      toggle("side", o.angle === "first" ? "Side (from the left)" : "Side (from the right)");
      toggle("iso", "Isometric");
      button("Base View", "views", () => (tool === "base" ? startTool(null) : void chooseBase()), { on: tool === "base", sub: true });
      pick("projection", "Projected View", "project");
      pick("section", "Section View", "section");
      pick("detail", "Detail View", "isolate");
      button("Hidden lines", o.hidden ? "eye" : "eyeOff", () => set({ hidden: !o.hidden }), { on: o.hidden, sub: true });
      button("Put views back", "undo", () => set({ moved: undefined }), { sub: true, disabled: !Object.keys(o.moved).length });
    }
    const dimTools: ToolId[] = ["length", "distance", "pointLine", "lineLine", "minmax", "angle", "angle3", "arcAngle", "radius", "diameter"];
    button("Dimensions", "ruler", () => ((open = open === "dims" ? null : "dims"), renderTools()), { on: open === "dims" || (!!tool && dimTools.includes(tool)) });
    if (open === "dims") {
      pick("length", "Line Length", "line");
      pick("distance", "Point-to-Point", "measure");
      pick("pointLine", "Point-to-Line", "alignLine");
      pick("lineLine", "Line-to-Line", "offsetEdge");
      pick("minmax", "Min-Max Distance", "ruler");
      pick("angle", "Line-to-Line Angle", "planeAngle");
      pick("angle3", "3-Point Angle", "planeAngle");
      pick("arcAngle", "Arc Angle", "arc");
      pick("radius", "Radius", "arc");
      pick("diameter", "Diameter", "circle");
      button("Overall sizes", o.overall ? "eye" : "eyeOff", () => set({ overall: !o.overall }), { on: o.overall, sub: true });
    }
    const markTools: ToolId[] = ["center", "cline", "clineLines"];
    button("Centrelines", "lineDashed", () => ((open = open === "marks" ? null : "marks"), renderTools()), { on: open === "marks" || (!!tool && markTools.includes(tool)) });
    if (open === "marks") {
      pick("center", "Centre Mark", "axis");
      pick("cline", "2-Point Centreline", "lineDashed");
      pick("clineLines", "2-Line Centreline", "splitLine");
    }
    button("Note", "text", () => startTool(tool === "note" ? null : "note"), { on: tool === "note" });
    button("Image", "image", () => void addImage());
    button("Delete", "trash", removeSelected, { disabled: !selected });
  };

  // ---- The properties at the right
  propsBtn.addEventListener("click", () => {
    props.hidden = !props.hidden;
    propsBtn.classList.toggle("on", !props.hidden);
  });
  if (window.matchMedia("(max-width: 700px)").matches) (props.hidden = true), propsBtn.classList.remove("on");
  const renderProps = () => {
    const keep = props.scrollTop;
    props.innerHTML = "";
    const o = opts();
    const section = (title: string) => props.append(el("div", "bim-props-h", title));
    const row = (label: string, control: HTMLElement) => {
      const r = el("label", "bim-props-row");
      r.append(el("span", "", label), control);
      props.append(r);
    };
    const choose = <T extends string | number>(value: T, options: [T, string][], change: (v: T) => void) => {
      const s = el("select", "bim-select");
      for (const [v, t] of options) {
        const op = el("option", "", t);
        op.value = String(v);
        op.selected = v === value;
        s.append(op);
      }
      s.addEventListener("change", () => change(options.find(([v]) => String(v) === s.value)![0]));
      return s;
    };
    const textField = (value: string, change: (v: string) => void) => {
      const i = el("input", "bim-input");
      i.value = value;
      i.placeholder = "-";
      i.addEventListener("change", () => change(i.value.trim()));
      return i;
    };

    section("Drawing");
    row("Title", textField(o.title, (v) => set({ title: v || undefined })));
    const bodies = el("div", "bim-props-bodies");
    bodies.append(el("span", "", `${parts.length} of ${allParts.length} ${allParts.length === 1 ? "body" : "bodies"}`));
    if (parts.length < allParts.length) {
      const all = el("button", "text-btn", "Draw all");
      all.addEventListener("click", () => (set({ bodies: undefined }), void load()));
      bodies.append(all);
    }
    row("Bodies", bodies);
    props.append(el("div", "bim-sub bim-props-note", "To draw only some bodies: pick them, then open Drawings."));

    section("Sheet");
    const orient = el("div", "bim-seg");
    for (const [v, t] of [
      [true, "Portrait"],
      [false, "Landscape"],
    ] as [boolean, string][]) {
      const b = el("button", o.portrait === v ? "on" : "", t);
      b.addEventListener("click", () => set({ portrait: v || undefined }));
      orient.append(b);
    }
    row("Orientation", orient);
    row(
      "Sheet size",
      choose(
        o.size,
        (Object.keys(SHEETS) as SheetSize[]).map((s) => [s, `${s.startsWith("ANSI") ? s : `ISO ${s}`} (${SHEETS[s][0]} × ${SHEETS[s][1]} mm)`]),
        (v) => set({ size: v }),
      ),
    );
    row(
      "View scale",
      choose(String(o.scale ?? "auto"), [["auto", `Auto (${scaleLabel(layout?.scale ?? 1)})`], ...SCALES.map((s) => [String(s), scaleLabel(s)] as [string, string])], (v) =>
        set({ scale: v === "auto" ? undefined : Number(v) }),
      ),
    );
    if (layout && !layout.fits)
      props.append(el("div", "bim-sub bim-props-note", o.scale ? "The views don't fit the sheet at this scale: they're cut at the frame. Pick a smaller scale or a bigger sheet." : "A view is moved off the drawing area: it's cut at the frame."));
    row(
      "Projection",
      choose(
        o.angle,
        [
          ["first", "First angle"],
          ["third", "Third angle"],
        ],
        (v) => set({ angle: v as "first" | "third" }),
      ),
    );
    row(
      "Title block",
      choose(
        o.titleBlock,
        [
          ["none", "Empty sheet"],
          ["border", "Border only"],
          ["simple", "Simple"],
          ["table", "With parts list"],
        ],
        (v) => set({ titleBlock: v as Opts["titleBlock"] }),
      ),
    );
    row(
      "Date format",
      choose(
        o.dateFormat,
        [
          ["iso", "YYYY-MM-DD"],
          ["dmy", "DD/MM/YY"],
          ["mdy", "MM/DD/YY"],
        ],
        (v) => set({ dateFormat: v as Opts["dateFormat"] }),
      ),
    );
    const balloons = el("input", "");
    balloons.type = "checkbox";
    balloons.checked = o.balloons;
    balloons.addEventListener("change", () => set({ balloons: balloons.checked ? undefined : false }));
    row("Balloons (item numbers)", balloons);

    section("Title block");
    const info = (key: keyof ProjectInfo, label: string) =>
      row(label, textField(store.doc.info?.[key] ?? "", (v) => store.commit((d) => (d.info = { ...(d.info ?? {}), [key]: v || undefined }))));
    info("number", "Drawing number");
    info("revision", "Revision");
    info("author", "Created by");
    info("company", "Owner");

    section("Dimensions");
    row(
      "Units",
      choose(
        o.units,
        [
          ["mm", "Millimetre"],
          ["cm", "Centimetre"],
          ["m", "Metre"],
          ["in", "Inch"],
        ],
        (v) => set({ units: v as Opts["units"] }),
      ),
    );
    row(
      "Length precision",
      choose(
        o.precision,
        [0, 1, 2, 3].map((n) => [n, n ? `0${o.comma ? "," : "."}${"123".slice(0, n)}` : "0"] as [number, string]),
        (v) => set({ precision: v }),
      ),
    );
    row(
      "Angle precision",
      choose(
        o.anglePrecision,
        [0, 1, 2].map((n) => [n, n ? `0${o.comma ? "," : "."}${"12".slice(0, n)}°` : "0°"] as [number, string]),
        (v) => set({ anglePrecision: v }),
      ),
    );
    row(
      "Decimal separator",
      choose(
        o.comma ? "comma" : "point",
        [
          ["point", "Point"],
          ["comma", "Comma"],
        ],
        (v) => set({ comma: v === "comma" || undefined }),
      ),
    );

    section("Line widths");
    const width = (k: "visible" | "hidden" | "dims" | "center" | "section", label: string, list: number[]) =>
      row(
        label,
        choose(
          o.lines[k],
          list.map((w) => [w, `${w.toFixed(2)} mm`] as [number, string]),
          (v) => set({ lines: { ...(store.doc.drawing?.lines ?? {}), [k]: v } }),
        ),
      );
    width("visible", "Visible outlines", [0.25, 0.35, 0.4, 0.5, 0.7]);
    width("hidden", "Hidden lines", [0.13, 0.15, 0.18, 0.25, 0.35]);
    width("dims", "Dimensions and thin lines", [0.13, 0.15, 0.18, 0.25, 0.35]);
    width("center", "Centrelines and cut lines", [0.13, 0.15, 0.18, 0.25, 0.35]);
    width("section", "Section hatching", [0.13, 0.15, 0.18, 0.25, 0.35]);
    props.scrollTop = keep;
  };

  // ---- Out: print / PDF at the paper's size, or an SVG file.
  print.addEventListener("click", () => {
    const [W, H] = sheetSize(opts());
    const page = document.createElement("style");
    page.textContent = `@page { size: ${W}mm ${H}mm; margin: 0; } body.printing-drawing .bim-drawing-print svg { width: ${W}mm; height: ${H}mm; display: block; }`;
    document.head.append(page);
    const holder = el("div", "bim-drawing-print");
    holder.innerHTML = sheetOut();
    document.body.append(holder);
    document.body.classList.add("printing-drawing");
    window.print();
    document.body.classList.remove("printing-drawing");
    holder.remove();
    page.remove();
  });
  svgBtn.addEventListener("click", () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${sheetOut()}`], { type: "image/svg+xml" }));
    a.download = `${opts().title} - drawing.svg`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });

  renderTools();
  if (fresh && !(await preferences())) return shut();
  if (picked.length) store.commit((d) => (d.drawing = { ...(d.drawing ?? {}), bodies: picked }));
  await load();
}
