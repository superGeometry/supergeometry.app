// On-screen numpad for value boxes (phones, tablets, headsets): no system
// keyboard covering half the screen. Switched on/off with the keypad button
// in the right column.
//
// It doesn't rely on keyboard focus (iPad Safari moves focus away from the
// box as soon as a button is tapped): it keeps its own target and caret,
// answers on the key's release, and only closes on ↵, or a tap elsewhere.
// The value follows each key (the model updates as you type); ↵ finishes.

import { screenClass } from "../device";
import { settings } from "../settings";

/** Where the numpad was dragged to, per kind of screen (it stays there). */
const POS_KEY = "sg-numpad-pos";
type Spot = { x: number; y: number };
function savedSpots(): Record<string, Spot> {
  try {
    return JSON.parse(localStorage.getItem(POS_KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
}
function saveSpot(spot: Spot | null): void {
  try {
    const all = savedSpots();
    if (spot) all[screenClass()] = spot;
    else delete all[screenClass()];
    localStorage.setItem(POS_KEY, JSON.stringify(all));
  } catch {
    // private window: it just isn't remembered
  }
}

const KEYS = ["7", "8", "9", "⌫", "4", "5", "6", "−", "1", "2", "3", "↵", "ƒx", "0", "."];
/** ƒx on: a row of operators under the keys (− types a minus then, not the sign flip). */
const FX_KEYS = ["+", "×", "/", "abc"];

/** The project's variables, for ƒx (set by the app). */
let varHooks: { names: () => string[]; create: (value: string) => Promise<string | null> } | null = null;
export function numpadVariables(hooks: typeof varHooks): void {
  varHooks = hooks;
}

class Numpad {
  private el = document.createElement("div");
  private target: HTMLInputElement | null = null;

  /** Put away if it's open on this box. */
  closeIf(input: HTMLInputElement): void {
    if (this.target === input) this.close();
  }
  /** The caret / selection inside the box, kept here (the box may not have focus). */
  private selStart = 0;
  private selEnd = 0;
  /** Just opened on a box: the first key typed replaces what's in it. */
  private fresh = false;
  /** ƒx on: operators and the variables' names to type formulas with. */
  private fx = false;
  private fxRow = document.createElement("div");
  private chips = document.createElement("div");

  constructor() {
    this.el.className = "numpad";
    this.el.hidden = true;
    // The grip along the top: drag it to put the numpad where you want it - it
    // opens there from then on. Double-tap it: back to opening by the box.
    const grip = document.createElement("div");
    grip.className = "np-grip";
    grip.title = "Drag to move · double-tap to put it back by the box";
    grip.innerHTML = "<span></span>";
    let drag: { id: number; dx: number; dy: number; moved: boolean } | null = null;
    let lastTap = 0;
    grip.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const r = this.el.getBoundingClientRect();
      drag = { id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top, moved: false };
      grip.setPointerCapture(e.pointerId);
    });
    grip.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      drag.moved = true;
      this.moveTo(e.clientX - drag.dx, e.clientY - drag.dy);
    });
    const end = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      e.preventDefault();
      e.stopPropagation();
      if (drag.moved) saveSpot({ x: parseFloat(this.el.style.left), y: parseFloat(this.el.style.top) });
      else if (performance.now() - lastTap < 350) {
        saveSpot(null);
        this.place();
      } else lastTap = performance.now();
      drag = null;
    };
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);
    this.el.append(grip);
    const key = (k: string, host: HTMLElement, cls = "") => {
      const b = document.createElement("button");
      b.type = "button";
      b.tabIndex = -1;
      b.textContent = k;
      b.className = cls || (k === "↵" ? "np-enter" : k === "ƒx" ? "np-fx" : "");
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
      host.append(b);
      return b;
    };
    for (const k of KEYS) key(k, this.el);
    this.fxRow.className = "np-fx-row";
    for (const k of FX_KEYS) key(k, this.fxRow, k === "abc" ? "np-abc" : "np-op");
    this.chips.className = "np-chips";
    this.el.append(this.fxRow, this.chips);
    this.keyFor = (k) => key(k, this.chips, k === "+ New" ? "np-chip np-new" : "np-chip");
    this.el.addEventListener("pointerdown", (e) => (e.preventDefault(), e.stopPropagation()));
    this.el.addEventListener("touchstart", (e) => e.preventDefault(), { passive: false });
    document.body.append(this.el);
    // Opening: focusing a numpad box, or tapping one (focus can be unreliable on touch).
    document.addEventListener("focusin", (e) => {
      const t = e.target as HTMLElement;
      // Already up (moving on to another box): it stays where it is.
      if (t instanceof HTMLInputElement && t.dataset.numpad === "1" && settings.value.numpad && t !== this.target) this.open(t, !this.el.hidden);
    });
    document.addEventListener(
      "pointerdown",
      (e) => {
        const t = e.target as HTMLElement;
        if (this.el.contains(t)) return;
        // A numpad box opens on a plain tap (the click): pressing and dragging
        // sideways scrubs its value instead.
        if (t instanceof HTMLInputElement && t.dataset.numpad === "1" && settings.value.numpad) return;
        // Sketching: a tap on the drawing places the next point - the numpad
        // stays where it was put (it moves on to the next size box).
        if (t instanceof HTMLCanvasElement && document.body.classList.contains("sketching")) return;
        // A tap anywhere else puts the numpad away.
        if (this.target) this.close();
      },
      true,
    );
    document.addEventListener(
      "click",
      (e) => {
        const t = e.target as HTMLElement;
        if (t instanceof HTMLInputElement && t.dataset.numpad === "1" && settings.value.numpad && !t.dataset.scrubbed && t !== this.target) this.open(t, !this.el.hidden);
        // A tap in the box it's open on: the caret goes where it was tapped (or
        // what's selected by hand) - keys add there instead of replacing it all.
        else if (t instanceof HTMLInputElement && t === this.target && !t.dataset.scrubbed) requestAnimationFrame(() => this.takeCaret(t));
      },
      true,
    );
    // Switched on/off: boxes already on screen follow (system keyboard back when off).
    settings.onChange((v) => {
      for (const i of document.querySelectorAll<HTMLInputElement>("input[data-numpad='1']")) i.inputMode = v.numpad ? "none" : "decimal";
      if (!v.numpad) this.close();
    });
  }

  private keyFor: (k: string) => HTMLButtonElement = () => document.createElement("button");

  /** ƒx on or off: the operators and a chip per variable (and + New: one from this value). */
  private setFx(on: boolean): void {
    this.fx = on;
    this.el.classList.toggle("fx", on);
    this.chips.innerHTML = "";
    if (on) {
      for (const n of varHooks?.names() ?? []) this.keyFor(n).dataset.name = n;
      if (varHooks) this.keyFor("+ New");
    }
    if (!this.el.hidden) this.place();
  }

  open(input: HTMLInputElement, stay = false): void {
    // Moving on to another box: it stays right where it is (setFx re-places it).
    const at = stay ? { left: this.el.style.left, top: this.el.style.top } : null;
    this.target = input;
    this.fresh = true;
    // A formula in the box already: ƒx is on.
    this.setFx(/[a-z_]/i.test(input.value.replace(/(\d)\s*(mm|cm|m|in|ft)\b/gi, "$1")));
    // All of it selected, so typing overrides it - but a minus stays: the
    // number after it is what's selected (⌫ first clears it all, sign too).
    this.selStart = input.value.startsWith("-") ? 1 : 0;
    this.selEnd = input.value.length;
    this.showSelection();
    this.el.hidden = false;
    if (at) {
      this.el.style.left = at.left;
      this.el.style.top = at.top;
    } else this.place();
    // Its box goes away (the tool finished, or another one took over): so does
    // the numpad - unless, sketching, a new size box took its place (the next
    // line's length): it carries on there, right where it is.
    // (Placing a point puts the old box away a moment before the next one shows:
    // it waits a little for that one before going.)
    let waited = 0;
    const watch = () => {
      const t = this.target;
      if (!t || t !== input) return;
      // Gone, or hidden (a size box put away when its tool ends).
      if (!t.isConnected || !t.getClientRects().length) {
        const sketching = document.body.classList.contains("sketching");
        const next = sketching ? this.nextBox(t) : null;
        if (next) return this.open(next, true);
        if (!sketching || ++waited > 30) return this.close();
      }
      requestAnimationFrame(watch);
    };
    requestAnimationFrame(watch);
  }

  /** A size box on screen to type into next (the one by the drawing first, then the card's). */
  private nextBox(was: HTMLInputElement): HTMLInputElement | null {
    // The same kind of box as the one that went: the size box by the drawing,
    // or the card's - not whatever box is on screen once the tool's done.
    const sel = was.closest(".dim-widget") ? ".dim-widget.editable input[data-numpad='1']" : was.closest("#panel") ? "#panel input[data-numpad='1']" : null;
    if (!sel) return null;
    return [...document.querySelectorAll<HTMLInputElement>(sel)].find((i) => i.getClientRects().length > 0 && !i.disabled) ?? null;
  }

  get shown(): boolean {
    return !this.el.hidden;
  }

  private close(): void {
    this.el.hidden = true;
    this.target = null;
  }

  /** Where the box's own caret / selection is now (put there by a tap or a drag across the text). */
  private takeCaret(t: HTMLInputElement): void {
    if (t !== this.target || t.selectionStart === null || t.selectionEnd === null) return;
    this.selStart = t.selectionStart;
    this.selEnd = t.selectionEnd;
    // A caret placed on purpose: what's there stays, the next key adds to it.
    if (this.selStart === this.selEnd) this.fresh = false;
  }

  private showSelection(): void {
    try {
      this.target?.setSelectionRange(this.selStart, this.selEnd);
    } catch {
      // not a text box
    }
  }

  /** On screen, whole. */
  private moveTo(x: number, y: number): void {
    const w = this.el.offsetWidth;
    const h = this.el.offsetHeight;
    this.el.style.left = `${Math.round(Math.max(4, Math.min(window.innerWidth - w - 4, x)))}px`;
    this.el.style.top = `${Math.round(Math.max(4, Math.min(window.innerHeight - h - 4, y)))}px`;
  }

  /** Where it was dragged to last (on this kind of screen); else below the box (or above it near the bottom). */
  private place(): void {
    const t = this.target;
    if (!t) return;
    const spot = savedSpots()[screenClass()];
    if (spot) return this.moveTo(spot.x, spot.y);
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
    // First key after opening: a digit or point types over the number (a
    // minus in front stays); ⌫ clears it all, sign too - then type it positive.
    if (this.fresh && (k === "." || /^\d$/.test(k))) [s, e] = [v.startsWith("-") ? 1 : 0, v.length];
    // A variable tapped first: the box becomes it.
    if (this.fresh && varHooks?.names().includes(k)) [s, e] = [0, v.length];
    if (this.fresh && k === "⌫") [s, e] = [0, v.length];
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
    } else if (k === "−" && this.fx) {
      put("-");
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
      // Operators and the variables' names on the numpad.
      this.setFx(!this.fx);
      return;
    } else if (k === "abc") {
      // Anything else (a name not made yet): the system keyboard.
      this.close();
      t.inputMode = "text";
      t.focus();
      return;
    } else if (k === "+ New") {
      // A variable from this value: it's made, and the box uses it.
      const value = t.value;
      this.close();
      void varHooks?.create(value).then((name) => {
        if (!name || !t.isConnected) return;
        t.value = name;
        t.dispatchEvent(new Event("input", { bubbles: true }));
        t.dispatchEvent(new Event("change", { bubbles: true }));
      });
      return;
    } else if (k === "×") put("*");
    else if (k === "+" || k === "/") put(k);
    else put(k);
    t.value = v;
    this.selStart = s;
    this.selEnd = e;
    this.showSelection();
    // Every box hears each key: the model follows what's typed (↵ finishes).
    t.dispatchEvent(new Event("input", { bubbles: true }));
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
  scrubbable(input);
}

/** Length, angle or plain number: the box's own kind, else its unit. */
function kindOf(input: HTMLInputElement): "length" | "angle" | "number" | "int" {
  const k = input.dataset.kind;
  if (k === "length" || k === "angle" || k === "number" || k === "int") return k;
  const unit = input.parentElement?.querySelector(".dim-unit, .field-unit")?.textContent?.trim() ?? "";
  return unit === "°" ? "angle" : unit ? "length" : "number";
}

/** A step a few pixels of drag should move this value by. */
function scrubStep(v: number, kind: string): number {
  if (kind === "int") return 1;
  if (kind === "angle") return 1;
  const a = Math.abs(v);
  if (kind === "number") return a < 1 ? 0.01 : a < 10 ? 0.1 : 1;
  return a < 1 ? 0.01 : a < 10 ? 0.1 : a < 100 ? 0.5 : a < 1000 ? 5 : 50;
}

/** A plain number ("220", "12.5 mm"), not "width*2" or a variable: what a drag can turn up or down. */
function plainNumber(input: HTMLInputElement): number | null {
  const text = input.value.trim().replace(/\s*(mm|cm|m|in|ft|°|")$/i, "");
  return /^-?\d*\.?\d+$/.test(text) ? Number(text) : null;
}

let measure: CanvasRenderingContext2D | null = null;

/** Where in the box's text a click at `clientX` falls (the caret's index). */
function caretAt(input: HTMLInputElement, clientX: number): number {
  measure ??= document.createElement("canvas").getContext("2d");
  const text = input.value;
  if (!measure) return text.length;
  const cs = getComputedStyle(input);
  measure.font = cs.font;
  const r = input.getBoundingClientRect();
  const left = parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth);
  const inner = r.width - left - parseFloat(cs.paddingRight) - parseFloat(cs.borderRightWidth);
  const width = (s: string) => measure!.measureText(s).width;
  let x = clientX - r.left - left + input.scrollLeft;
  const free = Math.max(0, inner - width(text));
  if (cs.textAlign === "center") x -= free / 2;
  else if (cs.textAlign === "right" || cs.textAlign === "end") x -= free;
  let best = 0;
  for (let i = 1; i <= text.length; i++) if (Math.abs(width(text.slice(0, i)) - x) < Math.abs(width(text.slice(0, best)) - x)) best = i;
  return best;
}

/**
 * A value box is also a horizontal scroll wheel: press and drag left or right
 * to turn the value down or up - selected or not (the mouse shows ↔ over it).
 * A click selects the value (and opens the numpad); a click in the box when
 * it's already in use puts the caret there.
 */
function scrubbable(input: HTMLInputElement): void {
  if (input.dataset.scrub) return;
  input.dataset.scrub = "1";
  let start: { x: number; v: number; id: number; kind: string; step: number; mouse: boolean; focused: boolean } | null = null;
  let moved = false;
  // ↔ over a value that can be dragged; a formula is text to edit (the text cursor).
  const cursor = () => input.classList.toggle("scrub-off", plainNumber(input) === null);
  input.addEventListener("pointerenter", cursor);
  input.addEventListener("input", cursor);
  input.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const kind = kindOf(input);
    const v = plainNumber(input);
    cursor();
    if (v === null) return;
    const mouse = e.pointerType === "mouse";
    start = { x: e.clientX, v, id: e.pointerId, kind, step: scrubStep(v, kind), mouse, focused: document.activeElement === input };
    moved = false;
    // A mouse: no text selecting by dragging - it's a click (handled on let go) or a drag.
    if (mouse) e.preventDefault();
    // (Held only once it's a drag: held from the press, a tap couldn't put
    // the caret where it was tapped - it went to the start.)
  });
  input.addEventListener("pointermove", (e) => {
    if (!start || e.pointerId !== start.id) return;
    const dx = e.clientX - start.x;
    if (!moved && Math.abs(dx) < 6) return;
    if (!moved) {
      moved = true;
      try {
        input.setPointerCapture(e.pointerId);
      } catch {
        // synthetic pointers can't be captured
      }
      input.dataset.scrubbed = "1";
      input.classList.add("scrubbing");
      pad?.closeIf(input);
    }
    e.preventDefault();
    const n = Math.round(dx / 4);
    let nv = start.v + n * start.step;
    if (start.kind === "int") nv = Math.round(nv);
    const dec = Math.max(0, -Math.floor(Math.log10(start.step) + 1e-9));
    const text = String(Number(nv.toFixed(dec)));
    if (text !== input.value) {
      input.value = text;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  const end = (e: PointerEvent) => {
    if (!start || e.pointerId !== start.id) return;
    const s = start;
    start = null;
    if (moved) {
      input.classList.remove("scrubbing");
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.blur();
      // (the click that follows mustn't open the numpad)
      setTimeout(() => delete input.dataset.scrubbed, 0);
    } else if (e.type === "pointerup" && s.mouse) {
      // A first click: the whole value, ready to be typed over. In use
      // already: the caret where it was clicked (to add to it).
      if (!s.focused || document.activeElement !== input) {
        input.focus();
        input.select();
      } else {
        const i = caretAt(input, e.clientX);
        input.setSelectionRange(i, i);
      }
    }
  };
  input.addEventListener("pointerup", end);
  input.addEventListener("pointercancel", end);
}

/** Open the numpad on a box right away (a box that appears ready for typing). */
export function openNumpad(input: HTMLInputElement): void {
  if (!settings.value.numpad) return;
  pad ??= new Numpad();
  // Already up (the next size box while sketching): it stays where it is.
  pad.open(input, pad.shown);
}
