// On-screen numpad for value boxes (phones, tablets, headsets): no system
// keyboard covering half the screen. Switched on/off with the keypad button
// in the right column.
//
// It doesn't rely on keyboard focus (iPad Safari moves focus away from the
// box as soon as a button is tapped): it keeps its own target and caret,
// answers on the key's release, and only closes on ↵, or a tap elsewhere.
// Nothing is applied while typing: ↵ applies it (tool panel boxes preview as you type).

import { settings } from "../settings";

const KEYS = ["7", "8", "9", "⌫", "4", "5", "6", "−", "1", "2", "3", "↵", "ƒx", "0", "."];

class Numpad {
  private el = document.createElement("div");
  private target: HTMLInputElement | null = null;
  /** The caret / selection inside the box, kept here (the box may not have focus). */
  private selStart = 0;
  private selEnd = 0;
  /** Just opened on a box: the first key typed replaces what's in it. */
  private fresh = false;

  constructor() {
    this.el.className = "numpad";
    this.el.hidden = true;
    for (const k of KEYS) {
      const b = document.createElement("button");
      b.type = "button";
      b.tabIndex = -1;
      b.textContent = k;
      b.className = k === "↵" ? "np-enter" : "";
      let downId: number | null = null;
      // Keep the focus where it is (and stop iOS from zooming, selecting or
      // sending the tap anywhere else).
      b.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        downId = e.pointerId;
        b.classList.add("down");
      });
      b.addEventListener("touchstart", (e) => e.preventDefault(), { passive: false });
      b.addEventListener("pointerup", (e) => {
        e.preventDefault();
        e.stopPropagation();
        b.classList.remove("down");
        if (downId !== e.pointerId) return;
        downId = null;
        this.press(k);
      });
      b.addEventListener("pointercancel", () => ((downId = null), b.classList.remove("down")));
      b.addEventListener("pointerleave", () => ((downId = null), b.classList.remove("down")));
      // Taps arrive as pointer events; a click after them must not do it twice.
      b.addEventListener("click", (e) => (e.preventDefault(), e.stopPropagation()));
      this.el.append(b);
    }
    this.el.addEventListener("pointerdown", (e) => (e.preventDefault(), e.stopPropagation()));
    this.el.addEventListener("touchstart", (e) => e.preventDefault(), { passive: false });
    document.body.append(this.el);
    // Opening: focusing a numpad box, or tapping one (focus can be unreliable on touch).
    document.addEventListener("focusin", (e) => {
      const t = e.target as HTMLElement;
      if (t instanceof HTMLInputElement && t.dataset.numpad === "1" && settings.value.numpad && t !== this.target) this.open(t);
    });
    document.addEventListener(
      "pointerdown",
      (e) => {
        const t = e.target as HTMLElement;
        if (this.el.contains(t)) return;
        if (t instanceof HTMLInputElement && t.dataset.numpad === "1" && settings.value.numpad) {
          if (t !== this.target) this.open(t);
          return;
        }
        // A tap anywhere else puts the numpad away.
        if (this.target) this.close();
      },
      true,
    );
    // Switched on/off: boxes already on screen follow (system keyboard back when off).
    settings.onChange((v) => {
      for (const i of document.querySelectorAll<HTMLInputElement>("input[data-numpad='1']")) i.inputMode = v.numpad ? "none" : "decimal";
      if (!v.numpad) this.close();
    });
  }

  open(input: HTMLInputElement): void {
    this.target = input;
    this.fresh = true;
    // All of it selected, so typing overrides it.
    this.selStart = 0;
    this.selEnd = input.value.length;
    this.showSelection();
    this.el.hidden = false;
    this.place();
    // Its box goes away (the tool finished, or another one took over): so does the numpad.
    const watch = () => {
      if (!this.target) return;
      if (!this.target.isConnected) return this.close();
      requestAnimationFrame(watch);
    };
    requestAnimationFrame(watch);
  }

  private close(): void {
    this.el.hidden = true;
    this.target = null;
  }

  private showSelection(): void {
    try {
      this.target?.setSelectionRange(this.selStart, this.selEnd);
    } catch {
      // not a text box
    }
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
    // The box went away (its tool finished): nothing to type into.
    if (!t || !t.isConnected) return this.close();
    let v = t.value;
    let s = Math.min(this.selStart, v.length);
    let e = Math.min(this.selEnd, v.length);
    // First key after opening: a digit, point or ⌫ starts the value over.
    if (this.fresh && (k === "⌫" || k === "." || /^\d$/.test(k))) [s, e] = [0, v.length];
    if (k !== "↵") this.fresh = false;
    const put = (text: string) => {
      v = v.slice(0, s) + text + v.slice(e);
      s = e = s + text.length;
    };
    if (k === "⌫") {
      if (s !== e) put("");
      else if (s > 0) {
        v = v.slice(0, s - 1) + v.slice(s);
        s = e = s - 1;
      }
    } else if (k === "−") {
      // Flip the sign of the whole value.
      v = v.startsWith("-") ? v.slice(1) : `-${v}`;
      s = e = v.length;
    } else if (k === "↵") {
      // Only now does the value count: the box hears it, then Enter.
      t.dispatchEvent(new Event("input", { bubbles: true }));
      t.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      t.dispatchEvent(new Event("change", { bubbles: true }));
      return this.close();
    } else if (k === "ƒx") {
      // Variables are typed by name: bring the system keyboard for that.
      this.close();
      t.inputMode = "text";
      t.focus();
      return;
    } else put(k);
    t.value = v;
    this.selStart = s;
    this.selEnd = e;
    this.showSelection();
    // Tool panel boxes (fillet radius, extrude distance…) show the result while
    // typing — a preview only: ↵ is what applies it. Boxes on the sketch wait for ↵.
    if (t.closest("#panel") || t.dataset.live === "1") t.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

let pad: Numpad | null = null;

/**
 * Let a numeric input use the on-screen numpad (when it's on): the system
 * keyboard stays away and the numpad opens under the box when it's tapped.
 */
export function numpadInput(input: HTMLInputElement): void {
  pad ??= new Numpad();
  input.dataset.numpad = "1";
  if (settings.value.numpad) input.inputMode = "none";
}

/** Open the numpad on a box right away (a box that appears ready for typing). */
export function openNumpad(input: HTMLInputElement): void {
  if (!settings.value.numpad) return;
  pad ??= new Numpad();
  pad.open(input);
}
