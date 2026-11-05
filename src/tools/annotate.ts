// 3D dimension annotations: a dimension line with arrowheads, an optional
// floating input (Total/Offset + value + pin), and the layer of pinned measurements.

import { BufferGeometry, ConeGeometry, Group, Line, LineBasicMaterial, LineDashedMaterial, Mesh, MeshBasicMaterial, Vector3 } from "three";
import type { PinDef, Vec3 } from "../doc/types";
import { el } from "../ui/ui";
import { numpadInput, openNumpad } from "../ui/numpad";
import { settings } from "../settings";
import { evaluate, toDisplay, trim, UNIT_LABEL, units } from "../units";
import type { Viewport } from "../view/viewport";

const COLOR = 0xdfe6f3;

/** Dashed line a→b with screen-constant arrowheads at both ends. */
class DimLine {
  readonly group = new Group();
  private line: Line;
  private heads: Mesh[];
  private a = new Vector3();
  private b = new Vector3();

  constructor(
    private view: Viewport,
    color = COLOR,
    private solid = false,
  ) {
    const opts = { color, depthTest: false, transparent: true };
    this.line = new Line(new BufferGeometry(), solid ? new LineBasicMaterial(opts) : new LineDashedMaterial({ ...opts, dashSize: 1, gapSize: 1 }));
    this.line.renderOrder = 11;
    const mat = new MeshBasicMaterial({ color, depthTest: false, transparent: true });
    this.heads = [0, 1].map(() => {
      const m = new Mesh(new ConeGeometry(0.35, 1, 12), mat);
      m.renderOrder = 11;
      return m;
    });
    this.group.add(this.line, ...this.heads);
  }

  set(a: Vec3, b: Vec3): void {
    this.a.set(...a);
    this.b.set(...b);
    this.line.geometry.setFromPoints([this.a, this.b]);
    this.layout();
  }

  layout(): void {
    const wpp = this.view.cam.worldPerPixel(this.view.height);
    if (!this.solid) {
      const mat = this.line.material as LineDashedMaterial;
      mat.dashSize = wpp * 6;
      mat.gapSize = wpp * 4;
      this.line.computeLineDistances();
    }
    const dir = this.b.clone().sub(this.a);
    const len = dir.length();
    const show = len > wpp * 20;
    dir.normalize();
    const s = wpp * 11;
    for (const [i, h] of this.heads.entries()) {
      h.visible = show;
      h.scale.setScalar(s);
      // Cone points +Y; tips sit on the ends, pointing outwards.
      const out = i === 0 ? dir.clone().negate() : dir.clone();
      h.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), out);
      h.position.copy(i === 0 ? this.a : this.b).addScaledVector(out, -s / 2);
    }
  }

  dispose(): void {
    this.line.geometry.dispose();
    this.heads.forEach((h) => h.geometry.dispose());
  }
}

export interface DimWidgetOptions {
  value: number;
  modes?: { id: string; label: string }[];
  mode?: string;
  onMode?(id: string): void;
  onInput?(v: number): void;
  onCommit?(): void;
  onPin?(): void;
  /** Text to restore into the input (when another tool takes over while typing). */
  typed?: string;
  focus?: boolean;
  /** Draw the dimension as a solid line of this colour (it *is* the geometry, e.g. a line being drawn). */
  solidColor?: number;
  /**
   * Keep the value box off the geometry: "side" puts it beside the middle of
   * the dimension, "beyond" past its end b (e.g. outside a fillet arc).
   */
  boxAt?: "middle" | "side" | "beyond";
  /** Extra screen distance past the end for "beyond" (e.g. to clear a drag arrow there). */
  boxGap?: number;
  /** Which way "beyond" goes when the dimension has no length yet (e.g. the arrow's direction). */
  dir?: Vec3;
  /** An angle in degrees (no unit conversion, ° label) instead of a length. */
  angle?: boolean;
  /** No dimension line (just the box, e.g. at the corner between two lines). */
  noLine?: boolean;
  /** The value shows as it's typed, before ↵ (a preview that is safe to redo on every key). */
  live?: boolean;
  /** Variables to choose from (a ƒx menu before the pin): the value becomes that variable. */
  variables?: string[];
  onVariable?(name: string): void;
}

/**
 * A dimension in the viewport: dashed line with arrows and, at its middle,
 * a small editable value with an optional mode dropdown and a pin button.
 */
export class DimWidget {
  private line: DimLine;
  private box = el("div", "dim-widget");
  private input = document.createElement("input");
  private mid = new Vector3();
  private ends: [Vector3, Vector3] = [new Vector3(), new Vector3()];
  private boxAt: "middle" | "side" | "beyond";
  private boxGap: number;
  private dir?: Vec3;
  private hook = () => this.layout();

  constructor(
    private view: Viewport,
    opts: DimWidgetOptions,
  ) {
    this.line = opts.solidColor !== undefined ? new DimLine(view, opts.solidColor, true) : new DimLine(view);
    this.boxAt = opts.boxAt ?? "middle";
    this.boxGap = opts.boxGap ?? 0;
    this.dir = opts.dir;
    view.overlay.add(this.line.group);
    if (opts.modes) {
      const sel = document.createElement("select");
      for (const m of opts.modes) {
        const o = document.createElement("option");
        o.value = m.id;
        o.textContent = m.label;
        sel.append(o);
      }
      sel.value = opts.mode ?? opts.modes[0].id;
      sel.addEventListener("change", () => opts.onMode?.(sel.value));
      this.box.append(sel);
    }
    this.input.inputMode = "decimal";
    numpadInput(this.input);
    // Typing on the numpad previews the value as it goes (↵ still applies it).
    if (opts.live) this.input.dataset.live = "1";
    this.input.spellcheck = false;
    this.angle = !!opts.angle;
    this.line.group.visible = !opts.noLine;
    this.input.value = opts.typed ?? this.show(opts.value);
    this.input.readOnly = !opts.onInput;
    // A box you type into (the tool's other values attach under it as a list).
    this.box.classList.toggle("editable", !!opts.onInput);
    this.input.addEventListener("input", () => {
      const v = evaluate(this.input.value, this.angle ? "angle" : "length");
      this.input.classList.toggle("invalid", v === null);
      if (v !== null) opts.onInput?.(v);
    });
    this.input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") opts.onCommit?.();
      if (e.key === "Escape") this.input.blur();
    });
    this.box.append(this.input, el("span", "dim-unit", this.angle ? "°" : UNIT_LABEL[units()]));
    if (opts.onVariable && opts.variables?.length) {
      // ƒx: pick one of the project's variables for this value.
      const sel = document.createElement("select");
      sel.className = "dim-var";
      sel.title = "Use a variable";
      const head = document.createElement("option");
      head.value = "";
      head.textContent = "ƒx";
      sel.append(head);
      for (const name of opts.variables) {
        const o = document.createElement("option");
        o.value = name;
        o.textContent = name;
        sel.append(o);
      }
      sel.addEventListener("change", () => {
        if (sel.value) opts.onVariable!(sel.value);
      });
      this.box.append(sel);
    }
    if (opts.onPin) {
      const pin = el("button", "dim-pin", "📌");
      pin.title = "Pin this measurement";
      pin.addEventListener("click", () => opts.onPin!());
      this.box.append(pin);
    }
    // Clicks on the widget must not reach the viewport.
    this.box.addEventListener("pointerdown", (e) => e.stopPropagation());
    document.body.append(this.box);
    view.frameHooks.add(this.hook);
    view.helpers.add(this);
    if (opts.focus) {
      setTimeout(() => {
        // The numpad opens on it straight away (on touch screens focus alone may not happen) —
        // unless it opened because keys were typed: then the keyboard carries on in it.
        if (settings.value.numpad && opts.typed === undefined) return openNumpad(this.input);
        this.input.focus();
        const n = this.input.value.length;
        this.input.setSelectionRange(n, n);
      }, 0);
    }
  }

  private angle = false;

  private show(v: number): string {
    return this.angle ? trim(v, 2) : trim(toDisplay(v), 3);
  }

  get text(): string {
    return this.input.value;
  }

  set(a: Vec3, b: Vec3): void {
    this.line.set(a, b);
    this.ends[0].set(...a);
    this.ends[1].set(...b);
    this.mid.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
    this.layout();
    this.view.requestRender();
  }

  setValue(v: number): void {
    if (document.activeElement !== this.input) this.input.value = this.show(v);
    this.box.classList.remove("typing", "invalid");
  }

  /** Start typing into the box with this first character (keys pressed elsewhere). */
  focusWith(ch: string): void {
    this.input.value = ch;
    this.input.focus();
    this.input.setSelectionRange(1, 1);
    this.input.dispatchEvent(new Event("input"));
  }

  /** Mark the value as not usable (e.g. a fillet radius too big for the lines). */
  markInvalid(bad: boolean): void {
    this.box.classList.toggle("invalid", bad);
  }

  /** Text typed elsewhere (keys while drawing), shown in the box with a caret. */
  setText(text: string, invalid = false): void {
    if (document.activeElement === this.input) return;
    this.input.value = text;
    this.box.classList.add("typing");
    this.box.classList.toggle("invalid", invalid);
  }

  private layout(): void {
    this.line.layout();
    let s = this.view.toScreen(this.mid);
    const sa = this.view.toScreen(this.ends[0]);
    const sb = this.view.toScreen(this.ends[1]);
    if (s && sa && sb && this.boxAt !== "middle") {
      let dx = sb[0] - sa[0];
      let dy = sb[1] - sa[1];
      // No length yet: use the given direction on screen.
      if (Math.hypot(dx, dy) < 2 && this.dir) {
        const e = this.view.toScreen(this.ends[1].clone().add(new Vector3(...this.dir).multiplyScalar(this.view.cam.worldPerPixel(this.view.height) * 50)));
        if (e) [dx, dy] = [e[0] - sb[0], e[1] - sb[1]];
      }
      const l = Math.hypot(dx, dy) || 1;
      const half = { w: this.box.offsetWidth / 2 + 10, h: this.box.offsetHeight / 2 + 10 };
      if (this.boxAt === "beyond") {
        // Past the end, far enough that the box's own size clears it.
        const k = Math.abs((dx / l) * half.w) + Math.abs((dy / l) * half.h) + this.boxGap;
        s = [sb[0] + (dx / l) * k, sb[1] + (dy / l) * k];
      } else {
        // Beside the middle, on the upper side of the line.
        let n: [number, number] = [-dy / l, dx / l];
        if (n[1] > 0) n = [-n[0], -n[1]];
        const k = Math.abs(n[0] * half.w) + Math.abs(n[1] * half.h);
        s = [s[0] + n[0] * k, s[1] + n[1] * k];
      }
    }
    this.box.hidden = !s;
    // The dimension on screen (the tool's options card keeps off it).
    if (sa && sb) this.box.dataset.seg = `${Math.round(sa[0])},${Math.round(sa[1])},${Math.round(sb[0])},${Math.round(sb[1])}`;
    else delete this.box.dataset.seg;
    if (s && this.input === document.activeElement && this.held) s = this.held;
    if (s) {
      // Always where you can reach it: on screen, clear of the side panels.
      s = clampToFree(s, this.box.offsetWidth / 2, this.box.offsetHeight / 2);
      this.held = s;
      this.box.style.transform = `translate(${Math.round(s[0])}px, ${Math.round(s[1])}px) translate(-50%, -50%)`;
    }
  }

  /** Where the box was last put (it stays put while you type in it). */
  private held: [number, number] | null = null;

  dispose(): void {
    this.view.helpers.delete(this);
    this.view.frameHooks.delete(this.hook);
    this.view.overlay.remove(this.line.group);
    this.line.dispose();
    this.box.remove();
    this.view.requestRender();
  }
}

/** A screen point moved (if needed) so a box of these half sizes is on screen and off the open side panels. */
/** The side panels' and the tool card's places, measured at most every 120 ms (not per box per frame). */
let freeCache: { t: number; sides: DOMRect[]; panel: DOMRect | null } | null = null;
function freeAreas(): { sides: DOMRect[]; panel: DOMRect | null } {
  const now = performance.now();
  if (freeCache && now - freeCache.t < 120) return freeCache;
  const sides: DOMRect[] = [];
  for (const id of ["items", "history"]) {
    const e = document.getElementById(id);
    if (e && !e.hidden && e.offsetWidth) sides.push(e.getBoundingClientRect());
  }
  const p = document.getElementById("panel");
  const panel = document.documentElement.dataset.screen === "phone" && p && !p.hidden && p.offsetHeight ? p.getBoundingClientRect() : null;
  freeCache = { t: now, sides, panel };
  return freeCache;
}

function clampToFree(s: [number, number], hw: number, hh: number): [number, number] {
  let left = 8;
  let right = window.innerWidth - 8;
  const free = freeAreas();
  for (const r of free.sides) {
    if (r.width > window.innerWidth * 0.6) continue; // a phone sheet over everything: ignore
    if (r.left < window.innerWidth / 2) left = Math.max(left, r.right + 8);
    else right = Math.min(right, r.left - 8);
  }
  if (right - left < hw * 2) [left, right] = [8, window.innerWidth - 8];
  const x = Math.max(left + hw, Math.min(right - hw, s[0]));
  let y = Math.max(52 + hh, Math.min(window.innerHeight - 8 - hh, s[1]));
  // Phones: the tool's options card sits fixed along the bottom — the box stays above it.
  if (free.panel) {
    const r = free.panel;
    if (x + hw > r.left - 6 && x - hw < r.right + 6 && y + hh > r.top - 6) y = Math.max(52 + hh, r.top - 8 - hh);
  }
  return [x, y];
}

/** Pinned measurements: label + (optional) dimension line, always on top. */
export class PinLayer {
  private group = new Group();
  private lines: DimLine[] = [];
  private labels: HTMLElement[] = [];
  private pins: PinDef[] = [];
  private visible = true;
  private host = document.getElementById("pins")!;

  constructor(private view: Viewport) {
    view.overlay.add(this.group);
    view.frameHooks.add(() => this.layout());
  }

  set(pins: PinDef[], visible: boolean): void {
    this.lines.forEach((l) => (this.group.remove(l.group), l.dispose()));
    this.labels.forEach((l) => l.remove());
    this.pins = pins;
    this.visible = visible;
    this.lines = [];
    this.labels = pins.map((p) => {
      if (p.a && p.b) {
        const l = new DimLine(this.view, 0x8fb4ff);
        l.set(p.a, p.b);
        this.group.add(l.group);
        this.lines.push(l);
      }
      const tag = el("div", "pin", p.text);
      this.host.append(tag);
      return tag;
    });
    this.group.visible = visible;
    this.view.requestRender();
  }

  private layout(): void {
    this.lines.forEach((l) => l.layout());
    this.pins.forEach((p, i) => {
      const s = this.view.toScreen(p.at);
      const tag = this.labels[i];
      tag.hidden = !this.visible || !s;
      if (s) tag.style.transform = `translate(${Math.round(s[0])}px, ${Math.round(s[1])}px) translate(-50%, -50%)`;
    });
  }
}
