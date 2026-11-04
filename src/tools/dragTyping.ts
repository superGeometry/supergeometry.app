// Type a value while holding a drag: digits set the value live, Enter applies
// it and finishes, Esc drops what was typed. "," is accepted as decimal point.

import { evaluate, UNIT_LABEL, units } from "../units";
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

  constructor(private app: AppContext) {}

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
    this.app.ui.setLabel(this.at.x, this.at.y, this.text ? `${this.text}▌ ${this.unit}${invalid ? "  ?" : ""}` : null);
  }
}
