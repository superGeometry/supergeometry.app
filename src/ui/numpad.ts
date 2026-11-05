// On-screen numpad for value boxes (phones, tablets, headsets): no system
// keyboard covering half the screen. Turned on in Units & grid.

import { settings } from "../settings";

const KEYS = ["7", "8", "9", "⌫", "4", "5", "6", "−", "1", "2", "3", "↵", "ƒx", "0", "."];

class Numpad {
  private el = document.createElement("div");
  private target: HTMLInputElement | null = null;

  constructor() {
    this.el.className = "numpad";
    this.el.hidden = true;
    for (const k of KEYS) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = k;
      b.className = k === "↵" ? "np-enter" : k === "✕" ? "np-close" : "";
      // Keep the focus (and the caret) in the value box.
      b.addEventListener("pointerdown", (e) => e.preventDefault());
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        this.press(k);
      });
      this.el.append(b);
    }
    this.el.addEventListener("pointerdown", (e) => e.stopPropagation());
    document.body.append(this.el);
    document.addEventListener("focusin", (e) => {
      const t = e.target as HTMLElement;
      if (t instanceof HTMLInputElement && t.dataset.numpad === "1" && settings.value.numpad) this.open(t);
    });
    document.addEventListener("focusout", (e) => {
      if (e.target === this.target) setTimeout(() => document.activeElement !== this.target && this.close(), 0);
    });
  }

  /** Just opened on a box: the first key typed replaces what's in it. */
  private fresh = false;

  private open(input: HTMLInputElement): void {
    this.target = input;
    this.fresh = true;
    this.el.hidden = false;
    this.place();
    // All of it selected, so typing overrides it (after anything that moves the caret on focus).
    const all = () => this.target === input && input.setSelectionRange(0, input.value.length);
    all();
    setTimeout(all, 0);
  }

  private close(): void {
    this.el.hidden = true;
    this.target = null;
  }

  /** Below the box (or above it near the bottom), kept on screen. */
  private place(): void {
    const t = this.target;
    if (!t) return;
    const r = t.getBoundingClientRect();
    const w = this.el.offsetWidth;
    const h = this.el.offsetHeight;
    const below = r.bottom + 8 + h < window.innerHeight;
    const left = Math.min(window.innerWidth - w - 8, Math.max(8, r.left + r.width / 2 - w / 2));
    this.el.style.left = `${left}px`;
    this.el.style.top = `${below ? r.bottom + 8 : Math.max(8, r.top - h - 8)}px`;
  }

  private press(k: string): void {
    const t = this.target;
    if (!t) return;
    // First key after opening: a digit, point or ⌫ starts the value over.
    if (this.fresh && (k === "⌫" || k === "." || /^\d$/.test(k))) t.setSelectionRange(0, t.value.length);
    if (k !== "↵") this.fresh = false;
    const v = t.value;
    const s = t.selectionStart ?? v.length;
    const e = t.selectionEnd ?? v.length;
    const put = (text: string) => {
      t.value = v.slice(0, s) + text + v.slice(e);
      const at = s + text.length;
      t.setSelectionRange(at, at);
    };
    if (k === "⌫") {
      if (s !== e) put("");
      else if (s > 0) {
        t.value = v.slice(0, s - 1) + v.slice(s);
        t.setSelectionRange(s - 1, s - 1);
      }
    } else if (k === "−") {
      // Flip the sign of the whole value.
      t.value = v.startsWith("-") ? v.slice(1) : `-${v}`;
    } else if (k === "↵") {
      // Only now does the value count: the box hears it, then Enter.
      t.dispatchEvent(new Event("input", { bubbles: true }));
      t.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      t.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    } else if (k === "✕") {
      t.blur();
      return this.close();
    } else if (k === "ƒx") {
      // Variables are typed by name: bring the system keyboard for that.
      t.inputMode = "text";
      t.blur();
      setTimeout(() => t.focus(), 0);
      return this.close();
    } else put(k);
    // Typing only edits the text: nothing is applied until ↵.
  }
}

let pad: Numpad | null = null;

/**
 * Let a numeric input use the on-screen numpad (when it's on): the system
 * keyboard stays away and the numpad opens under the box on focus.
 */
export function numpadInput(input: HTMLInputElement): void {
  pad ??= new Numpad();
  input.dataset.numpad = "1";
  if (settings.value.numpad) input.inputMode = "none";
}
