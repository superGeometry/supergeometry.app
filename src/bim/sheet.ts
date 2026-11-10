// The technical sheet: the project as a document. A title block (who, what,
// which revision), the parts list - each body with its item number, material,
// volume, area, mass, centre of mass and size - and the technical data of
// every material used. The item numbers are the ones the drawings' balloons
// point to: the drawings show the shapes, this sheet says what they are made of.
//
// It prints (or saves as a PDF from the print window) and its parts list
// downloads as a spreadsheet (CSV).

import type { ProjectInfo } from "../doc/types";
import type { BodyProps } from "../kernel/protocol";
import { el } from "../ui/ui";
import { trim, UNIT_LABEL, UNIT_MM, units } from "../units";
import type { AppContext } from "../tools/tool";
import { dataTable, fmtArea, fmtMass, fmtVolume, measureBodies } from "./bimTool";
import { massOf, materialOf } from "./materials";

/** One row of the parts list. */
export interface PartRow {
  item: number;
  id: string;
  name: string;
  material: string;
  volume: number;
  area: number;
  /** kg; undefined without a material. */
  mass?: number;
  center: [number, number, number];
  size: [number, number, number];
}

/** The parts list: every body shown, numbered as in the drawings. */
export function partsList(app: AppContext, props: Map<string, BodyProps>): PartRow[] {
  const doc = app.store.doc;
  return app.view.bodyList
    .filter((b) => !doc.hidden.includes(b.id) && props.has(b.id))
    .map((b, i) => {
      const p = props.get(b.id)!;
      const m = materialOf(doc, b.id);
      return {
        item: i + 1,
        id: b.id,
        name: doc.names?.[b.id] ?? b.name,
        material: m?.name ?? "",
        volume: p.volume,
        area: p.area,
        mass: m ? massOf(m, p.volume) : undefined,
        center: p.center,
        size: [p.box[1][0] - p.box[0][0], p.box[1][1] - p.box[0][1], p.box[1][2] - p.box[0][2]],
      };
    });
}

const len = (mm: number) => trim(mm / UNIT_MM[units()], 2);

export async function openSheet(app: AppContext): Promise<void> {
  document.querySelector(".bim-sheet")?.remove();
  const back = el("div", "bim-sheet");
  const bar = el("div", "bim-sheet-bar");
  const close = el("button", "text-btn", "Close");
  const print = el("button", "text-btn", "Print / PDF");
  const csv = el("button", "text-btn", "Parts list (CSV)");
  bar.append(el("span", "bim-sheet-name", "Technical Sheet"), print, csv, close);
  const paper = el("div", "bim-paper");
  paper.append(el("div", "bim-sub", "Measuring the bodies…"));
  back.append(bar, paper);
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
  print.addEventListener("click", () => {
    document.body.classList.add("printing-sheet");
    window.print();
    document.body.classList.remove("printing-sheet");
  });

  let rows: PartRow[] = [];
  try {
    rows = partsList(app, await measureBodies(app));
  } catch (err) {
    paper.innerHTML = "";
    paper.append(el("div", "bim-sub", `The bodies could not be measured: ${err instanceof Error ? err.message : String(err)}`));
    return;
  }
  csv.addEventListener("click", () => {
    const u = UNIT_LABEL[units()];
    const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const k = UNIT_MM[units()];
    const lines = [
      ["Item", "Name", "Material", `Volume (${u}3)`, `Area (${u}2)`, "Mass (kg)", `Centre of mass X (${u})`, `Y (${u})`, `Z (${u})`, `Size X (${u})`, `Size Y (${u})`, `Size Z (${u})`].join(","),
      ...rows.map((r) =>
        [r.item, q(r.name), q(r.material), trim(r.volume / k ** 3, 4), trim(r.area / k ** 2, 4), r.mass === undefined ? "" : trim(r.mass, 4), ...r.center.map(len), ...r.size.map(len)].join(","),
      ),
    ];
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([lines.join("\r\n")], { type: "text/csv" }));
    a.download = `${app.store.doc.name || "project"} - parts list.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
  paper.innerHTML = "";
  render(app, paper, rows);
}

function render(app: AppContext, paper: HTMLElement, rows: PartRow[]): void {
  const doc = app.store.doc;
  const info: ProjectInfo = doc.info ?? {};

  // ---- Title block
  const head = el("div", "bim-title-block");
  const field = (label: string, value: string, key?: keyof ProjectInfo) => {
    const f = el("label", "bim-tb-field");
    f.append(el("span", "bim-tb-label", label));
    if (!key) f.append(el("span", "bim-tb-value", value));
    else {
      const input = el("input", "bim-tb-value");
      input.value = value;
      input.placeholder = "-";
      input.addEventListener("change", () => app.store.commit((d) => (d.info = { ...(d.info ?? {}), [key]: input.value.trim() || undefined })));
      f.append(input);
    }
    head.append(f);
  };
  field("Project", doc.name || "Untitled");
  field("Document", "Technical sheet");
  field("Number", info.number ?? "", "number");
  field("Revision", info.revision ?? "", "revision");
  field("Author", info.author ?? "", "author");
  field("Company", info.company ?? "", "company");
  field("Date", new Date().toISOString().slice(0, 10));
  field("Units", `${UNIT_LABEL[units()]}, kg`);
  paper.append(head);

  // ---- Parts list
  paper.append(el("h2", "bim-h", "1. Parts list"));
  const missing = rows.filter((r) => r.mass === undefined).length;
  if (missing) paper.append(el("div", "bim-warn", `${missing === 1 ? "1 body has" : `${missing} bodies have`} no material yet: no mass for ${missing === 1 ? "it" : "them"}. Give each body a material in BIM - Materials.`));
  const u = UNIT_LABEL[units()];
  const t = el("table", "bim-table");
  const hr = el("tr", "");
  for (const h of ["Item", "Name", "Material", "Volume", "Surface area", "Mass", `Centre of mass (${u})`, `Size X × Y × Z (${u})`]) hr.append(el("th", "", h));
  t.append(hr);
  for (const r of rows) {
    const tr = el("tr", "");
    for (const v of [String(r.item), r.name, r.material || "-", fmtVolume(r.volume), fmtArea(r.area), r.mass === undefined ? "-" : fmtMass(r.mass), r.center.map(len).join(", "), r.size.map(len).join(" × ")]) tr.append(el("td", "", v));
    t.append(tr);
  }
  const total = rows.reduce((s, r) => s + (r.mass ?? 0), 0);
  const tf = el("tr", "bim-total");
  for (const v of ["", `${rows.length} ${rows.length === 1 ? "part" : "parts"}`, "", fmtVolume(rows.reduce((s, r) => s + r.volume, 0)), "", `${fmtMass(total)}${missing ? " +" : ""}`, "", ""]) tf.append(el("td", "", v));
  t.append(tf);
  const wrap = el("div", "bim-table-wrap");
  wrap.append(t);
  paper.append(wrap);

  // ---- Materials used, with their data
  paper.append(el("h2", "bim-h", "2. Materials"));
  const used = new Map<string, number[]>();
  for (const r of rows) {
    const m = materialOf(doc, r.id);
    if (m) used.set(m.id, [...(used.get(m.id) ?? []), r.item]);
  }
  if (!used.size) paper.append(el("div", "bim-sub", "No materials given yet."));
  const grid = el("div", "bim-material-grid");
  for (const [, items] of used) {
    const m = materialOf(doc, rows.find((r) => r.item === items[0])!.id)!;
    const c = el("div", "bim-material-card");
    const h = el("div", "bim-material-head");
    const sw = el("span", "bim-swatch");
    sw.style.background = m.color;
    h.append(sw, el("b", "", m.name));
    c.append(h, el("div", "bim-sub", `Items ${items.join(", ")}`), dataTable(m));
    grid.append(c);
  }
  paper.append(grid);
  paper.append(
    el(
      "div",
      "bim-foot",
      "Strengths are the minimums of the standard named, where the grade has one; other values are typical (thermal values of building materials: ISO 10456 design values). A supplier's data sheet comes first where it differs. Masses are worked out from each body's measured volume and its material's density.",
    ),
  );
}
