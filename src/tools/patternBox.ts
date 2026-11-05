// A small floating box beside a pattern's drag arrow: how many copies, and how
// far apart (between neighbours, or the whole run from the first to the last).

import { Vector3 } from "three";
import type { Vec3 } from "../doc/types";
import { el } from "../ui/ui";
import { numpadInput } from "../ui/numpad";
import { evaluate, toDisplay, trim, UNIT_LABEL, units } from "../units";
import type { Viewport } from "../view/viewport";

export interface PatternBoxOptions {
  count: number;
  spacing: number;
  /** "between": spacing is from one copy to the next; "total": from the first to the last. */
  measure: "between" | "total";
  onChange(v: { count: number; spacing: number; measure: "between" | "total" }): void;
  onCommit(): void;
}

export class PatternBox {
  private box = el("div", "dim-widget pattern-box");
  private count = document.createElement("input");
  private dist = document.createElement("input");
  private sel = document.createElement("select");
  private at = new Vector3();
  private hook = () => this.layout();

  constructor(
    private view: Viewport,
    opts: PatternBoxOptions,
  ) {
    for (const [id, label] of [["between", "Between"], ["total", "Total"]]) {
      const o = document.createElement("option");
      o.value = id;
      o.textContent = label;
      this.sel.append(o);
    }
    this.sel.value = opts.measure;
    this.count.inputMode = "numeric";
    this.count.value = String(opts.count);
    this.count.title = "Count (the original included)";
    this.dist.inputMode = "decimal";
    numpadInput(this.count);
    numpadInput(this.dist);
    this.dist.value = trim(toDisplay(opts.spacing), 3);
    const changed = () => {
      const n = Math.round(Number(this.count.value));
      const d = evaluate(this.dist.value, "length");
      const ok = Number.isFinite(n) && n >= 2 && d !== null;
      this.box.classList.toggle("invalid", !ok);
      if (ok) opts.onChange({ count: n, spacing: d!, measure: this.sel.value as "between" | "total" });
    };
    for (const i of [this.count, this.dist]) {
      i.spellcheck = false;
      i.addEventListener("input", changed);
      i.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") opts.onCommit();
        if (e.key === "Escape") i.blur();
      });
    }
    this.sel.addEventListener("change", changed);
    this.box.append(el("span", "dim-unit", "×"), this.count, this.sel, this.dist, el("span", "dim-unit", UNIT_LABEL[units()]));
    this.box.addEventListener("pointerdown", (e) => e.stopPropagation());
    document.body.append(this.box);
    view.frameHooks.add(this.hook);
    view.helpers.add(this);
    setTimeout(() => (this.count.focus(), this.count.select()), 0);
  }

  /** Where the box sits (a world point, e.g. the arrow's tip). */
  place(p: Vec3): void {
    this.at.set(...p);
    this.layout();
  }

  private layout(): void {
    const s = this.view.toScreen(this.at);
    this.box.hidden = !s;
    if (s) this.box.style.transform = `translate(${Math.round(s[0] + 24)}px, ${Math.round(s[1] - 24)}px) translate(0, -50%)`;
  }

  dispose(): void {
    this.view.helpers.delete(this);
    this.view.frameHooks.delete(this.hook);
    this.box.remove();
  }
}
