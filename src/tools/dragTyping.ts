// Type a value while holding a drag: digits set the value live, Enter applies
// it and finishes, Esc drops what was typed. "," is accepted as decimal point.

import { mergingCommits } from "../doc/store";
import { evaluate, UNIT_LABEL, units } from "../units";
import { numpadInput } from "../ui/numpad";
import type { ToolPointer } from "../view/input";
import type { AppContext } from "./tool";

export interface DragTypingTarget {
  kind: "length" | "angle" | "number";
  /** Apply a typed value (mm for lengths, degrees for angles). */
  apply(v: number): void;
  /** Enter: finish with the current value. */
  commit(): void;
  /** Esc: drop the typed text and go back to following the pointer. */
  cancel?(): void;
  /** Tab: move to the next dimension (e.g. rectangle width → height). */
  next?(): boolean;
  /** Show the typed text somewhere else than the pointer label (e.g. a dimension box). */
  show?(text: string, invalid: boolean): void;
}

export class DragTyping {
  text = "";
  private at: { x: number; y: number } = { x: 0, y: 0 };
  private static all = new Set<DragTyping>();

  constructor(private app: AppContext) {
    DragTyping.all.add(this);
  }

  /** Every floating value box away (the tool that showed it ended). */
  static hideAll(): void {
    for (const t of DragTyping.all) t.hideBox();
  }

  // ------------------------------------------------- floating value box
  // A drag's value in a box by the pointer that stays after letting go: tap
  // it to type (the numpad on a phone) - every drag gets one, like the
  // extrude arrow's. (It also shows what's typed during the drag: no second
  // "Enter ↵ apply" label.)
  private boxEl: HTMLDivElement | null = null;
  private boxInput: HTMLInputElement | null = null;
  private boxTarget: DragTypingTarget | null = null;

  /** Show / move the value box at the pointer with this value. */
  box(p: ToolPointer, value: string, target: DragTypingTarget): void {
    this.at = { x: p.x, y: p.y };
    this.boxTarget = target;
    if (!this.boxEl) {
      const box = document.createElement("div");
      box.className = "dim-widget editable float-value";
      const input = document.createElement("input");
      input.inputMode = "decimal";
      input.spellcheck = false;
      numpadInput(input);
      const unit = document.createElement("span");
      unit.className = "dim-unit";
      box.append(input, unit);
      input.addEventListener("input", () => {
        const t = this.boxTarget;
        if (!t) return;
        const v = evaluate(input.value, t.kind);
        input.classList.toggle("invalid", v === null);
        if (v !== null) mergingCommits(input, () => t.apply(v));
      });
      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          const t = this.boxTarget;
          this.hideBox();
          t?.commit();
        }
        if (e.key === "Escape") input.blur();
      });
      box.addEventListener("pointerdown", (e) => e.stopPropagation());
      document.body.append(box);
      this.boxEl = box;
      this.boxInput = input;
    }
    const unit = target.kind === "length" ? UNIT_LABEL[units()] : target.kind === "angle" ? "°" : "";
    (this.boxEl.querySelector(".dim-unit") as HTMLElement).textContent = unit;
    if (document.activeElement !== this.boxInput) this.boxInput!.value = value.replace(/\s*(mm|cm|m|in|ft|°|")$/, "").replace(/^×/, "");
    const r = this.app.view.canvas.getBoundingClientRect();
    this.boxEl.style.left = `${Math.round(r.left + p.x + 22)}px`;
    this.boxEl.style.top = `${Math.round(r.top + p.y + 16)}px`;
    this.boxEl.hidden = false;
    this.app.ui.setLabel(0, 0, null);
  }

  hideBox(): void {
    this.boxEl?.remove();
    this.boxEl = null;
    this.boxInput = null;
    this.boxTarget = null;
  }

  /** While text is typed, pointer motion shouldn't change the value. */
  get active(): boolean {
    return this.text.length > 0;
  }

  /** Remember where the pointer is (the typed value is shown next to it). */
  track(p: ToolPointer): void {
    this.at = { x: p.x, y: p.y };
    if (this.active) this.show();
  }

  reset(): void {
    this.text = "";
  }

  /** Handle a key during a drag; true if it was used. */
  key(e: KeyboardEvent, t: DragTypingTarget): boolean {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    this.display = t.show ?? null;
    this.unit = t.kind === "length" ? UNIT_LABEL[units()] : t.kind === "angle" ? "°" : "";
    if (e.key === "Enter") {
      this.text = "";
      this.app.ui.setLabel(0, 0, null);
      t.commit();
      return true;
    }
    if (e.key === "Escape") {
      if (!this.text) return false;
      this.text = "";
      this.app.ui.setLabel(0, 0, null);
      t.cancel?.();
      return true;
    }
    if (e.key === "Tab") {
      if (!t.next?.()) return false;
      this.text = "";
      this.show();
      return true;
    }
    if (e.key === "Backspace") {
      this.text = this.text.slice(0, -1);
    } else if (e.key.length === 1 && /[0-9.,+\-*/()a-z"' ]/i.test(e.key)) {
      this.text += e.key === "," ? "." : e.key;
    } else return false;
    const v = this.text ? evaluate(this.text, t.kind) : null;
    if (v !== null) t.apply(v);
    else if (!this.text) t.cancel?.();
    this.show(v === null && !!this.text);
    return true;
  }

  private unit = "";
  private display: DragTypingTarget["show"] | null = null;

  private show(invalid = false): void {
    if (this.display) return this.display(this.text, invalid);
    // What's typed goes into the value box on screen (this drag's, or the
    // tool's own on the model): a second blue "Enter ↵ apply" box isn't needed.
    const into = this.boxInput ?? [...document.querySelectorAll<HTMLInputElement>(".dim-widget.editable input")].find((i) => i.offsetParent);
    if (into) {
      if (this.text) into.value = this.text;
      into.classList.toggle("invalid", invalid);
      this.app.ui.setLabel(0, 0, null);
      return;
    }
    this.app.ui.setLabel(this.at.x, this.at.y, this.text ? `${this.text}▌ ${this.unit}${invalid ? "  ?" : ""}` : null);
  }
}
