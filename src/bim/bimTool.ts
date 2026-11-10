// BIM: each body given a real material (with its technical data), and from
// those the technical sheet (parts list, masses, the materials' data) that
// the drawings are made with. Entered from BIM in the left column.
//
// Tap a body (or its row in the card), then a material: it is that material
// from then on - its colour on the model, its mass in the sheet.

import type { MaterialDef } from "../doc/types";
import type { BodyProps } from "../kernel/protocol";
import { el } from "../ui/ui";
import type { ToolPointer } from "../view/input";
import { hitToSel, type AppContext, type Sel, type Tool } from "../tools/tool";
import { allMaterials, assignMaterial, fmtMass, fmtVolume, massOf, MATERIAL_CLASSES, materialOf, materialRows } from "./materials";

export { fmtArea, fmtMass, fmtVolume } from "./materials";
import { openSheet } from "./sheet";
import { openDrawing } from "./drawing";

/** Each body's properties, measured on the solids (kept until the project changes). */
export async function measureBodies(app: AppContext): Promise<Map<string, BodyProps>> {
  const props = await app.kernel.properties(app.store.doc.features as never);
  return new Map(props.map((p) => [p.id, p]));
}


export class BimTool implements Tool {
  readonly id = "bim";
  private card: HTMLElement | null = null;
  private props = new Map<string, BodyProps>();
  /** The project the properties were measured for. */
  private measured: unknown = null;
  private search = "";
  /** The material whose technical data is shown open. */
  private details: string | null = null;

  constructor(private app: AppContext) {}

  private get picked(): string[] {
    return [...new Set(this.app.selection.flatMap((s) => ("body" in s ? [s.body] : [])))];
  }

  enter(): void {
    const soon = "Coming next";
    this.app.ui.setTools([
      { id: "exit", label: "Exit BIM", icon: "exit", shortcut: "Esc", run: () => this.app.setTool(null) },
      { id: "bimMaterials", label: "Materials", icon: "bim", active: true, sub: "a material for each body" },
      { id: "bimSheet", label: "Technical Sheet", icon: "sheet", sub: "parts, masses, data", run: () => openSheet(this.app) },
      { id: "bimDrawings", label: "Drawings", icon: "drawing", sub: "views, dimensions, balloons", run: () => openDrawing(this.app) },
      { id: "bimAssemblies", label: "Assemblies", icon: "assembly", disabled: true, why: soon },
    ]);
    this.app.ui.setBottom(this.app.bottomTools());
    this.app.ui.setHint("Tap a body, then its material. The material's data gives the body its mass.");
    this.card = el("div", "bim-card");
    document.body.append(this.card);
    document.body.classList.add("bim-open");
    // Bodies picked before: what the materials go to.
    const bodies = this.picked;
    this.app.setSelection(bodies.map((body) => ({ kind: "body", body })));
    this.render();
    void this.measure();
  }

  exit(): void {
    this.card?.remove();
    this.card = null;
    document.body.classList.remove("bim-open");
    this.app.ui.setHint(null);
    this.app.setSelection([]);
    this.app.setHover(null);
  }

  key(e: KeyboardEvent): boolean {
    if (e.key === "Escape") {
      if (this.app.selection.length) this.app.setSelection([]);
      else this.app.setTool(null);
      this.render();
      return true;
    }
    return false;
  }

  /** After a rebuild: bodies may have changed size (their mass with them). */
  refresh(): void {
    this.render();
    void this.measure();
  }

  private async measure(): Promise<void> {
    const doc = this.app.store.doc.features;
    if (this.measured === doc) return;
    this.measured = doc;
    try {
      const props = await measureBodies(this.app);
      if (this.measured !== doc) return;
      this.props = props;
      this.render();
    } catch {
      // Measured again after the next change.
      this.measured = null;
    }
  }

  private bodyAt(p: ToolPointer): string | null {
    const s = hitToSel(this.app.view.pick(p.x, p.y, { edgeTolPx: p.tol, profiles: false, planes: false, axes: false, images: false }));
    return s && "body" in s ? s.body : null;
  }

  hover(p: ToolPointer | null): void {
    const b = p ? this.bodyAt(p) : null;
    this.app.setHover(b ? { kind: "body", body: b } : null);
  }

  tap(p: ToolPointer): void {
    const b = this.bodyAt(p);
    if (!b) {
      this.app.setSelection([]);
      return this.render();
    }
    // Tap: that body (or another one added to it, with the first still picked: one tap each).
    const now = this.picked;
    const next: Sel[] = now.includes(b) ? now.filter((x) => x !== b).map((body) => ({ kind: "body", body })) : [...now, b].map((body) => ({ kind: "body", body }));
    this.app.setSelection(next);
    this.render();
  }

  private give(m: MaterialDef | null): void {
    const bodies = this.picked;
    if (!bodies.length) return this.app.ui.toast("Tap a body first (or its row above)");
    this.app.store.commit((d) => assignMaterial(d, bodies, m));
    this.app.ui.toast(m ? `${bodies.length === 1 ? "It is" : `${bodies.length} bodies are`} ${m.name} now` : "Material taken off");
    this.render();
  }

  private render(): void {
    const card = this.card;
    if (!card) return;
    const doc = this.app.store.doc;
    const keep = card.querySelector<HTMLElement>(".bim-materials")?.scrollTop ?? 0;
    card.innerHTML = "";
    card.append(el("div", "panel-title", "Materials"));

    // ---- The bodies, each with its material and mass.
    const bodies = this.app.view.bodyList.filter((b) => !doc.hidden.includes(b.id));
    const picked = new Set(this.picked);
    const list = el("div", "bim-bodies");
    bodies.forEach((b, i) => {
      const m = materialOf(doc, b.id);
      const p = this.props.get(b.id);
      const row = el("button", `bim-body${picked.has(b.id) ? " on" : ""}`);
      const dot = el("span", "bim-swatch");
      dot.style.background = doc.colors?.[b.id] ?? "#b9bec7";
      const text = el("span", "bim-body-text");
      text.append(el("span", "bim-body-name", `${i + 1}. ${doc.names?.[b.id] ?? b.name}`), el("span", "bim-sub", m ? m.name : "No material yet"));
      const mass = el("span", "bim-mass", m && p ? fmtMass(massOf(m, p.volume)) : p ? fmtVolume(p.volume) : "");
      row.append(dot, text, mass);
      row.addEventListener("click", () => {
        this.app.setSelection([{ kind: "body", body: b.id }]);
        this.render();
      });
      list.append(row);
    });
    if (!bodies.length) list.append(el("div", "bim-sub", "No bodies yet: make one, then give it a material."));
    card.append(list);

    // ---- What's picked, and what it weighs.
    const sel = this.picked;
    const now = sel.map((id) => materialOf(doc, id));
    const same = now.every((m) => m?.id === now[0]?.id) ? now[0] : undefined;
    const info = el("div", "bim-picked");
    if (!sel.length) info.append(el("span", "bim-sub", "Tap a body, or its row, to give it a material."));
    else {
      const kg = sel.reduce((s, id) => {
        const m = materialOf(doc, id);
        const p = this.props.get(id);
        return m && p ? s + massOf(m, p.volume) : s;
      }, 0);
      const known = sel.every((id) => materialOf(doc, id) && this.props.get(id));
      info.append(el("span", "", `${sel.length === 1 ? "1 body" : `${sel.length} bodies`} picked${known ? ` · ${fmtMass(kg)}` : ""}`));
      if (now.some(Boolean)) {
        const off = el("button", "text-btn", "Take off material");
        off.addEventListener("click", () => this.give(null));
        info.append(off);
      }
    }
    card.append(info);

    // ---- The library, by class; search to narrow it.
    const find = el("input", "bim-search");
    find.type = "search";
    find.placeholder = "Search materials (steel, PLA, oak…)";
    find.value = this.search;
    find.addEventListener("input", () => {
      this.search = find.value;
      this.render();
      const again = this.card?.querySelector<HTMLInputElement>(".bim-search");
      again?.focus();
      again?.setSelectionRange(again.value.length, again.value.length);
    });
    card.append(find);
    const box = el("div", "bim-materials");
    const q = this.search.trim().toLowerCase();
    const all = allMaterials(doc).filter((m) => !q || `${m.name} ${m.category} ${m.standard ?? ""}`.toLowerCase().includes(q));
    const classes = [...MATERIAL_CLASSES, ...new Set(all.map((m) => m.category).filter((c) => !(MATERIAL_CLASSES as readonly string[]).includes(c)))];
    for (const c of classes) {
      const ms = all.filter((m) => m.category === c);
      if (!ms.length) continue;
      box.append(el("div", "bim-class", c));
      for (const m of ms) {
        const row = el("div", `bim-material${same?.id === m.id ? " on" : ""}`);
        const pick = el("button", "bim-material-pick");
        const sw = el("span", "bim-swatch");
        sw.style.background = m.color;
        const text = el("span", "bim-body-text");
        text.append(el("span", "bim-body-name", m.name), el("span", "bim-sub", `${m.density} kg/m³${m.standard ? ` · ${m.standard}` : ""}`));
        pick.append(sw, text);
        pick.addEventListener("click", () => this.give(m));
        const more = el("button", `bim-info${this.details === m.id ? " on" : ""}`, "i");
        more.title = "Technical data";
        more.addEventListener("click", () => {
          this.details = this.details === m.id ? null : m.id;
          this.render();
        });
        row.append(pick, more);
        box.append(row);
        if (this.details === m.id) box.append(dataTable(m));
      }
    }
    if (!all.length) box.append(el("div", "bim-sub", "No material by that name."));
    card.append(box);
    box.scrollTop = keep;
  }
}

/** A material's technical data, by group (identity, physical, thermal). */
export function dataTable(m: MaterialDef): HTMLElement {
  const t = el("div", "bim-data");
  for (const g of materialRows(m)) {
    t.append(el("div", "bim-data-group", g.group));
    for (const [k, v] of g.rows) {
      const r = el("div", "bim-data-row");
      r.append(el("span", "", k), el("span", "", v));
      t.append(r);
    }
  }
  return t;
}
