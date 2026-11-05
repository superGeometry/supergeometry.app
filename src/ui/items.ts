// Items panel: every body, sketch, plane, axis and image, with visibility
// toggles — plus folders (at the bottom) to group any of them.

import type { DocStore } from "../doc/store";
import type { Feature, ItemFolder } from "../doc/types";
import type { RegenResult } from "../kernel/protocol";
import { icons, type IconName } from "./icons";
import { el } from "./ui";

export interface ItemsHandlers {
  selectBody(id: string): void;
  editSketch(id: string): void;
  selectPlane(id: string): void;
  selectImage(id: string): void;
  deleteBody(id: string): void;
  deleteFeature(id: string): void;
  /** Rename a body (custom name) or a feature (its history name). */
  rename(id: string, current: string, isBody: boolean): void;
  /** Ask for a name (folders). */
  askName(title: string, current: string): Promise<string | null>;
  isolated(): string[] | null;
}

interface Row {
  id: string;
  name: string;
  icon: IconName;
  open(): void;
  remove(): void;
  extra?: string;
  isBody?: boolean;
}

export class ItemsPanel {
  private el = document.getElementById("items")!;
  private list = document.getElementById("items-list")!;
  /** Rows ticked for grouping (Ctrl/Shift+click, or the checkboxes in Select mode). */
  private checked = new Set<string>();
  private picking = false;
  private collapsed = new Set<string>();
  private last: RegenResult | null = null;

  constructor(
    private store: DocStore,
    private h: ItemsHandlers,
  ) {
    document.getElementById("items-btn")!.addEventListener("click", () => this.toggle());
    document.getElementById("items-close")!.innerHTML = icons.close;
    document.getElementById("items-close")!.addEventListener("click", () => this.toggle(false));
    const pick = document.getElementById("items-pick")!;
    pick.addEventListener("click", () => {
      this.picking = !this.picking;
      if (!this.picking) this.checked.clear();
      pick.classList.toggle("on", this.picking);
      this.render(this.last);
    });
  }

  toggle(open?: boolean): void {
    const on = this.el.classList.toggle("open", open);
    // Phones: one panel at a time (Items or History).
    if (on && window.innerWidth <= 720) {
      document.getElementById("history")?.classList.remove("open");
      document.body.classList.remove("history-open");
    }
    // The tool column steps aside while Items is open.
    document.body.classList.toggle("items-open", on);
    // The value panel and tool column re-fit around it.
    window.dispatchEvent(new Event("resize"));
  }

  private get folders(): ItemFolder[] {
    return this.store.doc.folders ?? [];
  }

  private shown = "";

  render(result: RegenResult | null): void {
    this.last = result;
    // Nothing that the list shows changed: keep the rows (rebuilding them under a
    // click that's in progress would swallow that click).
    const d = this.store.doc;
    const sig = JSON.stringify([
      d.hidden, d.names, d.folders, this.h.isolated(), [...this.checked], this.picking, [...this.collapsed],
      result?.bodies.map((b) => [b.id, b.name]),
      d.features.filter((f) => ["sketch", "plane", "axis", "image"].includes(f.type)).map((f) => [f.id, f.name, f.type]),
    ]);
    if (sig === this.shown) return;
    this.shown = sig;
    this.list.innerHTML = "";
    const hidden = new Set(this.store.doc.hidden);
    const iso = this.h.isolated();
    const inFolder = new Set(this.folders.flatMap((f) => f.items));
    const section = (title: string) => this.list.append(el("li", "items-heading", title));

    // Everything there is, by kind.
    const bodies = result?.bodies ?? [];
    const names = this.store.doc.names ?? {};
    const feats = this.store.doc.features;
    const of = <T extends Feature["type"]>(t: T) => feats.filter((f) => f.type === t);
    const rows: Record<string, Row[]> = {
      Bodies: bodies.map((b) => ({ id: b.id, name: names[b.id] ?? b.name, icon: "body" as IconName, open: () => this.h.selectBody(b.id), remove: () => this.h.deleteBody(b.id), extra: iso && !iso.includes(b.id) ? " isolated-out" : "", isBody: true })),
      // Greyed while something else is isolated (they're hidden until Isolate is off).
      Sketches: of("sketch").map((s) => ({ id: s.id, name: s.name, icon: "sketch" as IconName, open: () => this.h.editSketch(s.id), remove: () => this.h.deleteFeature(s.id), extra: iso && !iso.includes(s.id) ? " isolated-out" : "" })),
      "Planes & axes": [...of("plane"), ...of("axis")].map((c) => ({ id: c.id, name: c.name, icon: (c.type === "plane" ? "plane" : "axis") as IconName, open: () => this.h.selectPlane(c.id), remove: () => this.h.deleteFeature(c.id), extra: iso && !iso.includes(c.id) ? " isolated-out" : "" })),
      Images: of("image").map((i) => ({ id: i.id, name: i.name, icon: "image" as IconName, open: () => this.h.selectImage(i.id), remove: () => this.h.deleteFeature(i.id) })),
    };
    const byId = new Map(Object.values(rows).flat().map((r) => [r.id, r]));

    for (const [title, list] of Object.entries(rows)) {
      const loose = list.filter((r) => !inFolder.has(r.id));
      if (title !== "Bodies" && !loose.length) continue;
      section(`${title} (${loose.length})`);
      if (!loose.length) this.list.append(el("li", "items-empty", bodies.length ? "All in folders" : "No bodies yet"));
      for (const r of loose) this.row(r, hidden, 0);
    }

    // Folders last, each with what it holds.
    if (this.folders.length) section(`Folders (${this.folders.length})`);
    for (const f of this.folders) {
      const items = f.items.map((id) => byId.get(id)).filter((r): r is Row => !!r);
      this.folderRow(f, items, hidden);
      if (!this.collapsed.has(f.id)) for (const r of items) this.row(r, hidden, 1);
    }

    // Grouping bar.
    if (this.checked.size) {
      const bar = el("li", "items-groupbar");
      const make = el("button", "text-btn primary", `New folder (${this.checked.size})`);
      make.addEventListener("click", () => void this.makeFolder());
      const clear = el("button", "text-btn", "Clear");
      clear.addEventListener("click", () => (this.checked.clear(), this.render(this.last)));
      bar.append(make, clear);
      this.list.append(bar);
    } else if (this.picking) {
      this.list.append(el("li", "items-empty", "Tick items, then make a folder of them."));
    }
  }

  private row(r: Row, hidden: Set<string>, depth: number): void {
    const li = el("li", `items-row${hidden.has(r.id) ? " hidden-item" : ""}${r.extra ?? ""}${this.checked.has(r.id) ? " checked" : ""}${depth ? " in-folder" : ""}`);
    if (this.picking) {
      const box = document.createElement("input");
      box.type = "checkbox";
      box.className = "items-check";
      box.checked = this.checked.has(r.id);
      box.addEventListener("change", () => this.check(r.id, box.checked));
      li.append(box);
    }
    const eye = el("button", "icon-btn");
    eye.title = hidden.has(r.id) ? "Show" : "Hide";
    eye.innerHTML = icons[hidden.has(r.id) ? "eyeOff" : "eye"];
    eye.addEventListener("click", (e) => {
      e.stopPropagation();
      this.store.commit((d) => (d.hidden = hidden.has(r.id) ? d.hidden.filter((x) => x !== r.id) : [...d.hidden, r.id]));
    });
    const label = el("button", "items-name");
    label.innerHTML = icons[r.icon];
    label.append(r.name);
    // Ctrl/Cmd/Shift+click ticks the row for grouping; a plain click opens it.
    label.addEventListener("click", (e) => (e.ctrlKey || e.metaKey || e.shiftKey || this.picking ? this.check(r.id, !this.checked.has(r.id)) : r.open()));
    const ren = el("button", "icon-btn");
    ren.title = "Rename";
    ren.innerHTML = icons.rename;
    ren.addEventListener("click", (e) => (e.stopPropagation(), this.h.rename(r.id, r.name, !!r.isBody)));
    const del = el("button", "icon-btn");
    del.title = "Delete";
    del.innerHTML = icons.trash;
    del.addEventListener("click", (e) => (e.stopPropagation(), r.remove()));
    li.append(eye, label, ren, del);
    this.list.append(li);
  }

  private folderRow(f: ItemFolder, items: Row[], hidden: Set<string>): void {
    const li = el("li", "items-row folder-row");
    const allHidden = items.length > 0 && items.every((r) => hidden.has(r.id));
    const eye = el("button", "icon-btn");
    eye.title = allHidden ? "Show all in folder" : "Hide all in folder";
    eye.innerHTML = icons[allHidden ? "eyeOff" : "eye"];
    eye.addEventListener("click", () =>
      this.store.commit((d) => {
        const ids = new Set(items.map((r) => r.id));
        d.hidden = allHidden ? d.hidden.filter((x) => !ids.has(x)) : [...new Set([...d.hidden, ...ids])];
      }),
    );
    const label = el("button", "items-name");
    label.innerHTML = icons.folder;
    label.append(f.name, el("span", "items-count", ` ${items.length}`), el("span", "items-caret", this.collapsed.has(f.id) ? " ▸" : " ▾"));
    label.title = "Show / hide its contents";
    label.addEventListener("click", () => {
      if (this.collapsed.has(f.id)) this.collapsed.delete(f.id);
      else this.collapsed.add(f.id);
      this.render(this.last);
    });
    const ren = el("button", "icon-btn");
    ren.title = "Rename folder";
    ren.innerHTML = icons.rename;
    ren.addEventListener("click", async () => {
      const name = await this.h.askName("Rename folder", f.name);
      if (name) this.store.commit((d) => (d.folders = (d.folders ?? []).map((x) => (x.id === f.id ? { ...x, name } : x))));
    });
    const del = el("button", "icon-btn");
    del.title = "Remove folder (keeps what's in it)";
    del.innerHTML = icons.trash;
    del.addEventListener("click", () => this.store.commit((d) => (d.folders = (d.folders ?? []).filter((x) => x.id !== f.id))));
    li.append(eye, label, ren, del);
    this.list.append(li);
  }

  private check(id: string, on: boolean): void {
    if (on) this.checked.add(id);
    else this.checked.delete(id);
    this.render(this.last);
  }

  private async makeFolder(): Promise<void> {
    const ids = [...this.checked];
    const name = await this.h.askName("New folder", `Folder ${this.folders.length + 1}`);
    if (!name) return;
    this.checked.clear();
    this.picking = false;
    document.getElementById("items-pick")!.classList.remove("on");
    // An item lives in one folder at a time.
    this.store.commit((d) => {
      const rest = (d.folders ?? []).map((f) => ({ ...f, items: f.items.filter((x) => !ids.includes(x)) }));
      d.folders = [...rest, { id: `folder-${Date.now().toString(36)}`, name, items: ids }];
    });
  }
}
