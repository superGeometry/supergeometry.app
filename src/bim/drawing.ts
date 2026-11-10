// The drawing workspace: the sheet in the middle; its tools at the left
// (views, dimensions, notes, delete, exit); its properties at the right
// (sheet, scale, projection, title block, dimension style, line widths).
// Tap an edge with a dimension tool and its dimension is there; drag a view,
// a dimension or a note to move it. Everything is saved with the project and
// undoes like any other change. The sheet itself is made in drawingSheet.ts.

import type { DrawingDim, DrawingNote, DrawingOptions, ProjectDoc, ProjectInfo } from "../doc/types";
import type { ProjectedView } from "../kernel/protocol";
import { icons, type IconName } from "../ui/icons";
import { el } from "../ui/ui";
import type { AppContext } from "../tools/tool";
import { measureBodies } from "./bimTool";
import { partsList, type PartRow } from "./sheet";
import {
  annId,
  drawingOptions,
  drawingSVG,
  edgeAt,
  moveKey,
  outward,
  pointAt,
  scaleLabel,
  SCALES,
  SHEETS,
  sheetSize,
  toPaper,
  VIEW_SPECS,
  type Layout,
  type Opts,
  type SheetSize,
} from "./drawingSheet";

type ToolId = "length" | "distance" | "radius" | "diameter" | "note";
const TOOL_HINT: Record<ToolId, string> = {
  length: "Tap a straight edge to dimension its length",
  distance: "Tap a corner, then another: the distance between them",
  radius: "Tap a circle or an arc for its radius",
  diameter: "Tap a circle or an arc for its diameter",
  note: "Tap where the note goes",
};

export async function openDrawing(app: AppContext): Promise<void> {
  document.querySelector(".bim-sheet")?.remove();
  const store = app.store;

  // The bodies drawn: those picked as it opens, or the ones chosen before, or all shown.
  const picked = [...new Set(app.selection.flatMap((s) => ("body" in s ? [s.body] : [])))];
  if (picked.length) store.commit((d) => (d.drawing = { ...(d.drawing ?? {}), bodies: picked }));

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

  let views = new Map<string, ProjectedView>();
  let parts: PartRow[] = [];
  let allParts: PartRow[] = [];
  let layout: Layout | null = null;
  let tool: ToolId | null = null;
  let selected: string | null = null;
  let firstPoint: { view: string; p: [number, number] } | null = null;
  /** While dragging: the drawing as it would be (committed when let go). */
  let draft: DrawingOptions | null = null;
  const date = new Date();
  let svg = "";

  const docNow = (): ProjectDoc => (draft ? { ...store.doc, drawing: draft } : store.doc);
  const opts = (): Opts => drawingOptions(docNow());
  const set = (patch: Partial<DrawingOptions>) =>
    store.commit((d) => {
      const next: DrawingOptions = { ...(d.drawing ?? {}), ...patch };
      for (const k of Object.keys(next) as (keyof DrawingOptions)[]) if (next[k] === undefined) delete next[k];
      d.drawing = next;
    });

  const shut = () => {
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
    } catch (err) {
      paper.innerHTML = "";
      paper.append(el("div", "bim-sub", `The views could not be drawn: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }
    render();
  };

  // ---- Only the views the sheet shows are drawn (a big assembly takes seconds
  // a view); one switched on later, or the other side view, is drawn then.
  const failed = new Set<string>();
  let fetching = false;
  const wanted = () => {
    const o = opts();
    const side = o.angle === "first" ? "left" : "right";
    return VIEW_SPECS.filter((v) => (v.id === "front" || v.id === "top" || v.id === "iso" ? o.views[v.id] : o.views.side && v.id === side));
  };
  const fetchMissing = async () => {
    const miss = wanted().filter((v) => !views.has(v.id) && !failed.has(v.id));
    if (!miss.length || fetching) return;
    fetching = true;
    const of = views;
    name.textContent = `Drawing · ${opts().title} · drawing the views…`;
    try {
      const got = await app.kernel.drawing(store.doc.features as never, miss, parts.map((p) => p.id));
      if (of !== views) return;
      for (const v of got) views.set(v.id, v);
    } catch {
      for (const v of miss) failed.add(v.id);
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
    if (!draft) svg = drawingSVG({ doc, views, parts, date }).svg;
    const zoomed = paper.querySelector("svg")?.classList.contains("zoomed") ?? false;
    paper.innerHTML = made.svg;
    const s = paper.querySelector("svg");
    if (s) {
      s.removeAttribute("width");
      s.removeAttribute("height");
      s.classList.add("bim-drawing-svg");
      s.classList.toggle("zoomed", zoomed);
    }
    if (!fetching) name.textContent = `Drawing · ${drawingOptions(doc).title}`;
    if (!draft) (renderTools(), renderProps());
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
  /** 12 screen pixels, in mm on the paper. */
  const tolerance = () => {
    const s = paper.querySelector("svg");
    const [W] = sheetSize(opts());
    return s ? (12 * W) / Math.max(1, s.getBoundingClientRect().width) : 3;
  };

  // ---- Tapping and dragging on the sheet
  let drag: { id: number; x: number; y: number; target: string; moved: boolean; start: DrawingOptions } | null = null;
  paper.addEventListener("pointerdown", (e) => {
    const q = sheetPoint(e);
    if (!q || !layout) return;
    if (tool) return void useTool(q, e);
    const t = e.target as Element;
    const ann = t.closest("[data-ann]")?.getAttribute("data-ann");
    const view = t.closest("[data-view]")?.getAttribute("data-view");
    const target = ann ?? (view ? `view:${view}` : null);
    if (!target) {
      if (selected) (selected = null), render();
      return;
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
      const k = moveKey(drag.target.slice(5));
      const [mx, my] = o.moved[k] ?? [0, 0];
      next.moved = { ...o.moved, [k]: [mx + dx, my + dy] };
    } else {
      const id = drag.target;
      const dim = o.dims.find((d) => d.id === id);
      const note = o.notes.find((n) => n.id === id);
      if (note) next.notes = o.notes.map((n) => (n === note ? { ...n, x: note.x + dx, y: note.y + dy } : n));
      if (dim) {
        const p = layout.views.find((v) => v.id === dim.view);
        if (p) next.dims = o.dims.map((d) => (d === dim ? movedDim(dim, p, q) : d));
      }
    }
    draft = next;
    render();
  });
  const endDrag = (e: PointerEvent) => {
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
  // A double tap: on a note, write it again; on the empty paper, see it closer (or all of it again).
  paper.addEventListener("dblclick", (e) => {
    if (tool) return;
    const id = (e.target as Element).closest("[data-ann]")?.getAttribute("data-ann");
    const n = opts().notes.find((x) => x.id === id);
    if (n) return noteInput([n.x, n.y], e.clientX, e.clientY, n);
    if ((e.target as Element).closest("[data-ann],[data-view]")) return;
    paper.querySelector("svg")?.classList.toggle("zoomed");
  });

  /** A dimension dragged to a point: its line through there (a circle's: its leader towards it). */
  const movedDim = (d: DrawingDim, p: Layout["views"][number], q: [number, number]): DrawingDim => {
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
    firstPoint = null;
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
        (d.kind === "radius" || d.kind === "diameter" ? near(x.c, d.c) && Math.abs((x.r ?? 0) - (d.r ?? 0)) < 1e-3 : (near(x.a, d.a) && near(x.b, d.b)) || (near(x.a, d.b) && near(x.b, d.a))),
    );
    if (same) {
      selected = same.id;
      render();
      return app.ui.toast("That one is dimensioned already");
    }
    set({ dims: [...opts().dims, d] });
  };
  const useTool = (q: [number, number], e: PointerEvent) => {
    if (!layout) return;
    const tol = tolerance();
    if (tool === "length") {
      const hit = edgeAt(views, layout, q, tol, "line");
      if (!hit) return app.ui.toast("Tap right on a straight edge of a view");
      const p = layout.views.find((v) => v.id === hit.view)!;
      addDim({ id: annId("dim"), view: hit.view, kind: "length", a: hit.a, b: hit.b, offset: outward(p, hit.a, hit.b) });
    } else if (tool === "distance") {
      const hit = pointAt(views, layout, q, tol * 1.5, firstPoint?.view);
      if (!hit) return app.ui.toast(firstPoint ? "Tap a corner in the same view" : "Tap a corner (the end of an edge) of a view");
      if (!firstPoint) {
        firstPoint = hit;
        return showHint("Now tap the second corner");
      }
      if (Math.hypot(hit.p[0] - firstPoint.p[0], hit.p[1] - firstPoint.p[1]) < 1e-6) return;
      const p = layout.views.find((v) => v.id === hit.view)!;
      addDim({ id: annId("dim"), view: hit.view, kind: "distance", a: firstPoint.p, b: hit.p, offset: outward(p, firstPoint.p, hit.p) });
      firstPoint = null;
      showHint(TOOL_HINT.distance);
    } else if (tool === "radius" || tool === "diameter") {
      const hit = edgeAt(views, layout, q, tol, "circle");
      if (!hit || !hit.c || hit.r === undefined) return app.ui.toast("Tap right on a circle or an arc of a view (seen face on)");
      const p = layout.views.find((v) => v.id === hit.view)!;
      const c = toPaper(p, hit.c);
      addDim({ id: annId("dim"), view: hit.view, kind: tool, a: hit.a, c: hit.c, r: hit.r, offset: 6, angle: Math.atan2(q[1] - c[1], q[0] - c[0]) || -Math.PI / 4 });
    } else if (tool === "note") {
      noteInput(q, e.clientX, e.clientY);
    }
  };
  const noteInput = (q: [number, number], cx: number, cy: number, edit?: DrawingNote) => {
    stage.querySelector(".bim-note-input")?.remove();
    const input = el("input", "bim-note-input");
    input.placeholder = "Note";
    input.value = edit?.text ?? "";
    const r = stage.getBoundingClientRect();
    input.style.left = `${cx - r.left}px`;
    input.style.top = `${cy - r.top - 14}px`;
    stage.append(input);
    setTimeout(() => input.focus(), 0);
    let done = false;
    const finish = (keep: boolean) => {
      if (done) return;
      done = true;
      const t = input.value.trim();
      input.remove();
      if (keep) {
        const o = opts();
        if (edit) set({ notes: t ? o.notes.map((n) => (n.id === edit.id ? { ...n, text: t } : n)) : o.notes.filter((n) => n.id !== edit.id) });
        else if (t) set({ notes: [...o.notes, { id: annId("note"), x: q[0], y: q[1], text: t }] });
      }
      if (tool === "note") startTool(null);
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") finish(true);
      if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
  };

  const removeSelected = () => {
    const id = selected;
    if (!id) return;
    selected = null;
    const o = opts();
    if (id.startsWith("view:")) {
      // A view taken off: back with its switch in Views.
      const v = id.slice(5);
      const key = v === "left" || v === "right" ? "side" : (v as "front" | "top" | "iso");
      set({ views: { ...o.views, [key]: false } });
    } else set({ dims: o.dims.filter((d) => d.id !== id), notes: o.notes.filter((n) => n.id !== id) });
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
    }
  };
  window.addEventListener("keydown", onKey, true);

  // ---- The tools at the left
  let open: "views" | "dims" | null = null;
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
    button("Views", "views", () => ((open = open === "views" ? null : "views"), renderTools()), { on: open === "views" });
    if (open === "views") {
      const toggle = (k: "front" | "top" | "side" | "iso", label: string) =>
        button(label, o.views[k] ? "eye" : "eyeOff", () => set({ views: { ...o.views, [k]: !o.views[k] } }), { on: o.views[k], sub: true });
      toggle("front", "Front");
      toggle("top", "Top");
      toggle("side", o.angle === "first" ? "Side (from the left)" : "Side (from the right)");
      toggle("iso", "Isometric");
      button("Hidden lines", o.hidden ? "eye" : "eyeOff", () => set({ hidden: !o.hidden }), { on: o.hidden, sub: true });
      button("Put views back", "undo", () => set({ moved: undefined }), { sub: true, disabled: !Object.keys(o.moved).length });
    }
    button("Dimensions", "ruler", () => ((open = open === "dims" ? null : "dims"), renderTools()), { on: open === "dims" || !!(tool && tool !== "note") });
    if (open === "dims") {
      button("Line Length", "line", () => startTool("length"), { on: tool === "length", sub: true });
      button("Point-to-Point", "measure", () => startTool("distance"), { on: tool === "distance", sub: true });
      button("Radius", "arc", () => startTool("radius"), { on: tool === "radius", sub: true });
      button("Diameter", "circle", () => startTool("diameter"), { on: tool === "diameter", sub: true });
      button("Overall sizes", o.overall ? "eye" : "eyeOff", () => set({ overall: !o.overall }), { on: o.overall, sub: true });
    }
    button("Note", "text", () => startTool(tool === "note" ? null : "note"), { on: tool === "note" });
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
    const width = (k: "visible" | "hidden" | "dims", label: string, list: number[]) =>
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
    props.scrollTop = keep;
  };

  // ---- Out: print / PDF at the paper's size, or an SVG file.
  print.addEventListener("click", () => {
    const [W, H] = sheetSize(opts());
    const page = document.createElement("style");
    page.textContent = `@page { size: ${W}mm ${H}mm; margin: 0; } body.printing-drawing .bim-drawing-print svg { width: ${W}mm; height: ${H}mm; display: block; }`;
    document.head.append(page);
    const holder = el("div", "bim-drawing-print");
    holder.innerHTML = svg;
    document.body.append(holder);
    document.body.classList.add("printing-drawing");
    window.print();
    document.body.classList.remove("printing-drawing");
    holder.remove();
    page.remove();
  });
  svgBtn.addEventListener("click", () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${svg}`], { type: "image/svg+xml" }));
    a.download = `${opts().title} - drawing.svg`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });

  renderTools();
  await load();
}
