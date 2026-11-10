// The drawing sheet on screen: its options in a bar (paper, projection,
// scale, hidden lines, isometric view), the title block's fields, print / PDF
// and an SVG download. The sheet itself is made in drawingSheet.ts.

import type { DrawingOptions, ProjectInfo } from "../doc/types";
import type { ProjectedView } from "../kernel/protocol";
import { el } from "../ui/ui";
import type { AppContext } from "../tools/tool";
import { measureBodies } from "./bimTool";
import { partsList, type PartRow } from "./sheet";
import { drawingOptions, drawingSVG, scaleLabel, SCALES, SHEETS, VIEW_SPECS, type SheetSize } from "./drawingSheet";

export async function openDrawing(app: AppContext): Promise<void> {
  document.querySelector(".bim-sheet")?.remove();
  const back = el("div", "bim-sheet bim-drawing");
  const bar = el("div", "bim-sheet-bar");
  const name = el("span", "bim-sheet-name", "Drawing");
  const size = select(Object.keys(SHEETS).map((s) => [s, s]));
  const angle = select([
    ["first", "First angle"],
    ["third", "Third angle"],
  ]);
  const scale = select([["auto", "Auto scale"], ...SCALES.map((s) => [String(s), scaleLabel(s)] as [string, string])]);
  const hidden = toggle("Hidden lines");
  const iso = toggle("Isometric");
  const titleBtn = el("button", "text-btn", "Title block");
  const print = el("button", "text-btn", "Print / PDF");
  const svgBtn = el("button", "text-btn", "SVG");
  const close = el("button", "text-btn", "Close");
  bar.append(name, size, angle, scale, hidden.label, iso.label, titleBtn, print, svgBtn, close);
  const titleRow = el("div", "bim-drawing-info");
  titleRow.hidden = true;
  const paper = el("div", "bim-drawing-paper");
  paper.append(el("div", "bim-sub", "Drawing the views…"));
  back.append(bar, titleRow, paper);
  document.body.append(back);

  const shut = () => {
    back.remove();
    window.removeEventListener("keydown", onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") (e.preventDefault(), e.stopPropagation(), shut());
  };
  window.addEventListener("keydown", onKey, true);
  close.addEventListener("click", shut);

  let parts: PartRow[] = [];
  let views = new Map<string, ProjectedView>();
  try {
    parts = partsList(app, await measureBodies(app));
    if (!parts.length) {
      paper.innerHTML = "";
      paper.append(el("div", "bim-sub", "No bodies to draw: make one first (hidden bodies are left off the drawing)."));
      return;
    }
    const got = await app.kernel.drawing(app.store.doc.features as never, VIEW_SPECS, parts.map((p) => p.id));
    views = new Map(got.map((v) => [v.id, v]));
  } catch (err) {
    paper.innerHTML = "";
    paper.append(el("div", "bim-sub", `The views could not be drawn: ${err instanceof Error ? err.message : String(err)}`));
    return;
  }
  const date = new Date().toISOString().slice(0, 10);
  let svg = "";
  let W = 420;
  let H = 297;
  const render = () => {
    const doc = app.store.doc;
    const o = drawingOptions(doc);
    size.value = o.size;
    angle.value = o.angle;
    scale.value = o.scale ? String(o.scale) : "auto";
    hidden.input.checked = o.hidden;
    iso.input.checked = o.iso;
    const made = drawingSVG({ doc, views, parts, date });
    svg = made.svg;
    W = made.layout.W;
    H = made.layout.H;
    scale.options[0].textContent = `Auto (${scaleLabel(made.layout.scale)})`;
    paper.innerHTML = svg;
    const s = paper.querySelector("svg");
    if (s) {
      s.removeAttribute("width");
      s.removeAttribute("height");
      s.classList.add("bim-drawing-svg");
      s.classList.toggle("zoomed", zoomed);
    }
  };
  // Tap the paper to see it closer (and again to see all of it).
  let zoomed = false;
  paper.addEventListener("click", () => {
    zoomed = !zoomed;
    paper.querySelector("svg")?.classList.toggle("zoomed", zoomed);
  });
  const set = (patch: DrawingOptions) =>
    app.store.commit((d) => {
      const next = { ...(d.drawing ?? {}), ...patch };
      if (next.scale === undefined) delete next.scale;
      d.drawing = next;
    });
  size.addEventListener("change", () => (set({ size: size.value as SheetSize }), render()));
  angle.addEventListener("change", () => (set({ angle: angle.value as "first" | "third" }), render()));
  scale.addEventListener("change", () => (set({ scale: scale.value === "auto" ? undefined : Number(scale.value) }), render()));
  hidden.input.addEventListener("change", () => (set({ hidden: hidden.input.checked }), render()));
  iso.input.addEventListener("change", () => (set({ iso: iso.input.checked }), render()));

  // Title block: what the technical sheet's title block says too.
  const fields: [keyof ProjectInfo, string][] = [
    ["number", "Drawing number"],
    ["revision", "Revision"],
    ["author", "Created by"],
    ["company", "Owner"],
  ];
  for (const [key, label] of fields) {
    const f = el("label", "bim-tb-field");
    const input = el("input", "bim-tb-value");
    input.value = app.store.doc.info?.[key] ?? "";
    input.placeholder = "-";
    input.addEventListener("change", () => {
      app.store.commit((d) => (d.info = { ...(d.info ?? {}), [key]: input.value.trim() || undefined }));
      render();
    });
    f.append(el("span", "bim-tb-label", label), input);
    titleRow.append(f);
  }
  titleBtn.addEventListener("click", () => {
    titleRow.hidden = !titleRow.hidden;
    titleBtn.classList.toggle("on", !titleRow.hidden);
  });

  print.addEventListener("click", () => {
    const page = document.createElement("style");
    page.textContent = `@page { size: ${W}mm ${H}mm; margin: 0; } body.printing-drawing .bim-drawing-svg { width: ${W}mm; height: ${H}mm; }`;
    document.head.append(page);
    document.body.classList.add("printing-sheet", "printing-drawing");
    window.print();
    document.body.classList.remove("printing-sheet", "printing-drawing");
    page.remove();
  });
  svgBtn.addEventListener("click", () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${svg}`], { type: "image/svg+xml" }));
    a.download = `${app.store.doc.name || "project"} - drawing.svg`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
  render();
}

function select(options: [string, string][]): HTMLSelectElement {
  const s = el("select", "bim-select");
  for (const [v, t] of options) {
    const o = el("option", "", t);
    o.value = v;
    s.append(o);
  }
  return s;
}

function toggle(label: string): { label: HTMLLabelElement; input: HTMLInputElement } {
  const l = el("label", "bim-toggle");
  const input = el("input", "");
  input.type = "checkbox";
  l.append(input, el("span", "", label));
  return { label: l, input };
}
