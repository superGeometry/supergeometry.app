// Variables in the view (Variables switched on): a small tag per variable where
// it acts on the model - its kind's mark (↔ a length, ∠ an angle, # a number)
// and its name, like the sketch's constraint marks. Tap one: its value box
// opens by it, to type a value or a formula, or press and drag sideways to
// turn it up or down - the model follows. While it's open, what it changes is
// drawn on the model in yellow dashes (one thing: the radius, the arm's
// length, the turn's arc), the tags of the variables it's made from or that
// are made from it stay lit (the rest fade), and a line under the box says
// what's made from it ("p2 = p1 + arm1").

import { mergingCommits } from "../doc/store";
import type { Variable, Vec3 } from "../doc/types";
import type { VarKind, VarTag } from "../doc/varAnchors";
import { numpadInput, openNumpad } from "../ui/numpad";
import { el } from "../ui/ui";
import { bareExpr, toDisplay, trim, withUnitOf } from "../units";
import type { Viewport } from "../view/viewport";

const MARK: Record<VarKind, string> = { length: "↔", angle: "∠", number: "#" };
const KIND_NAME: Record<VarKind, string> = { length: "Length", angle: "Angle", number: "Number" };
const SVG_NS = "http://www.w3.org/2000/svg";

export interface VariableTagsHost {
  variables(): readonly Variable[];
  /** What a variable would work out to with this formula (null: not a valid value). Nothing changes. */
  check(name: string, expr: string, kind: VarKind): number | null;
  /** Set a variable's formula; false when it isn't a valid value (nothing changes). */
  setVariable(name: string, expr: string): boolean;
}

export class VariableTags {
  private host = el("div", "vtags");
  private lines = document.createElementNS(SVG_NS, "svg");
  private chips = new Map<string, HTMLButtonElement>();
  private tags: VarTag[] = [];
  private visible = false;
  /** The tag whose value box is open. */
  private openName: string | null = null;
  private box = el("div", "dim-widget vtag-box");
  private input = document.createElement("input");
  private boxName = el("span", "vtag-box-name");
  private boxValue = el("span", "vtag-box-value");
  /** Under the box: the variables made from it, with their formulas. */
  private rel = el("div", "vtag-rel");
  private hook = () => this.layout();
  /** One undo step per opening of the box (not one for everything ever typed in it). */
  private undoGroup = {};
  /**
   * What's typed (or dragged to), not applied yet: the model changes once it's
   * done (↵, the drag let go, a tap elsewhere) - changing as it was typed, a
   * big number threw the model and this box off the screen.
   */
  private pending: string | null = null;

  constructor(
    private view: Viewport,
    private app: VariableTagsHost,
  ) {
    this.lines.classList.add("vtag-lines");
    this.host.hidden = true;
    this.host.append(this.lines);
    document.body.append(this.host);
    this.input.autocomplete = "off";
    this.input.spellcheck = false;
    this.input.inputMode = "decimal";
    numpadInput(this.input);
    this.box.append(this.boxName, this.input, this.boxValue);
    this.box.hidden = true;
    this.rel.hidden = true;
    this.box.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.input.addEventListener("input", () => this.typed());
    // A drag let go: what it was dragged to applies (the box stays open).
    this.input.addEventListener("change", () => this.apply());
    this.input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") (e.preventDefault(), this.close());
      else if (e.key === "Escape") (e.preventDefault(), this.close(false));
    });
    document.body.append(this.box, this.rel);
    // A tap anywhere else puts the box away (the numpad's own keys don't count);
    // a drag turns or moves the view and the box stays open, its marks with it.
    let press: { id: number; x: number; y: number; moved: boolean } | null = null;
    document.addEventListener(
      "pointerdown",
      (e) => {
        const t = e.target as HTMLElement;
        // A second finger (pinch): not a tap.
        if (press && e.pointerId !== press.id) return void (press.moved = true);
        press = null;
        if (!this.openName || this.box.contains(t) || t.closest?.(".numpad, .vtag")) return;
        press = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
      },
      true,
    );
    document.addEventListener(
      "pointermove",
      (e) => {
        if (press && e.pointerId === press.id && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 6) press.moved = true;
      },
      true,
    );
    document.addEventListener(
      "pointerup",
      (e) => {
        if (!press || e.pointerId !== press.id) return;
        const tap = !press.moved;
        press = null;
        if (tap) this.close();
      },
      true,
    );    view.frameHooks.add(this.hook);
  }

  /** Show or hide them all (the Variables switch). */
  setVisible(on: boolean): void {
    this.visible = on;
    this.host.hidden = !on;
    if (!on) this.close();
    this.view.requestRender();
  }

  set(tags: VarTag[]): void {
    this.tags = tags;
    const live = new Set(tags.filter((t) => t.at).map((t) => t.name));
    for (const [n, chip] of this.chips) if (!live.has(n)) (chip.remove(), this.chips.delete(n));
    for (const t of tags) {
      if (!t.at) continue;
      let chip = this.chips.get(t.name);
      if (!chip) {
        chip = el("button", "vtag");
        chip.type = "button";
        chip.addEventListener("pointerdown", (e) => e.stopPropagation());
        chip.addEventListener("click", (e) => (e.stopPropagation(), this.openName === t.name ? this.close() : this.open(t.name)));
        this.host.append(chip);
        this.chips.set(t.name, chip);
      }
      chip.dataset.kind = t.kind;
      chip.classList.toggle("formula", t.from.length > 0);
      chip.innerHTML = "";
      chip.append(el("span", "vtag-mark", MARK[t.kind]), el("span", "vtag-name", t.name));
      chip.title = `${KIND_NAME[t.kind]} variable ${t.name} = ${bareExpr(this.exprOf(t.name))} (tap to change)`;
    }
    if (this.openName && !this.chips.has(this.openName)) this.close();
    else if (this.openName && this.pending === null) this.showValue();
    this.showRelated();
    this.view.requestRender();
  }

  private exprOf(name: string): string {
    return this.app.variables().find((v) => v.name === name)?.expr ?? "";
  }

  private kindOf(name: string): VarKind {
    return this.tags.find((t) => t.name === name)?.kind ?? "number";
  }

  private open(name: string): void {
    this.openName = name;
    this.undoGroup = {};
    this.pending = null;
    this.boxName.textContent = `${MARK[this.kindOf(name)]} ${name} =`;
    this.input.dataset.kind = this.kindOf(name);
    this.input.value = bareExpr(this.exprOf(name));
    this.input.classList.remove("invalid");
    this.input.size = Math.max(4, this.input.value.length + 1);
    this.box.hidden = false;
    this.showRelated();
    this.showValue();
    this.layout();
    this.input.focus();
    this.input.select();
    openNumpad(this.input);
  }

  /** Put away: what was typed applies (unless `keep` is false: Esc puts it back as it was). */
  private close(keep = true): void {
    if (!this.openName) return;
    if (keep) this.apply();
    this.pending = null;
    this.openName = null;
    this.box.hidden = true;
    this.input.blur();
    this.showRelated();
    this.view.requestRender();
  }

  /**
   * The open one's relations, without lines across the view: the tags it's
   * made from and made from it stay lit, the rest fade; under the box, what's
   * made from it.
   */
  private showRelated(): void {
    const name = this.openName;
    const tag = name ? this.tags.find((t) => t.name === name) : undefined;
    const near = new Set([...(tag?.from ?? []), ...(tag?.to ?? [])]);
    for (const [n, c] of this.chips) {
      c.classList.toggle("sel", n === name);
      c.classList.toggle("rel", !!tag && near.has(n));
      c.classList.toggle("faded", !!tag && n !== name && !near.has(n));
    }
    const lines = (tag?.to ?? []).map((n) => `${n} = ${bareExpr(this.exprOf(n))}`);
    this.rel.textContent = "";
    for (const l of lines.slice(0, 3)) this.rel.append(el("div", "", `\u2192 ${l}`));
    if (lines.length > 3) this.rel.append(el("div", "", `+${lines.length - 3} more`));
    this.rel.hidden = !tag || !lines.length;
  }

  /** What a formula works out to ("= 66"), from what's typed (or the value as it is). */
  private showValue(text = this.exprOf(this.openName ?? "")): void {
    const name = this.openName;
    if (!name) return;
    const kind = this.kindOf(name);
    const v = this.app.check(name, text, kind);
    const formula = /[a-z_]/i.test(text.replace(/(\d)\s*(mm|cm|m|in|ft)\b/gi, "$1"));
    // A length in the unit in use, without it (like the value itself).
    this.boxValue.textContent = v === null || !formula ? "" : `= ${kind === "length" ? trim(toDisplay(v), 3) : kind === "angle" ? `${trim(v, 2)}°` : trim(v, 3)}`;
  }

  /** Typed or dragged: checked, shown - not applied yet. */
  private typed(): void {
    const name = this.openName;
    if (!name) return;
    // A plain number keeps the unit the value had ("220 mm", shown as 220, typed 300: "300 mm").
    const text = withUnitOf(this.input.value, this.exprOf(name));
    this.input.size = Math.max(4, this.input.value.length + 1);
    const ok = !!text && this.app.check(name, text, this.kindOf(name)) !== null;
    this.pending = text;
    this.input.classList.toggle("invalid", !ok);
    this.showValue(ok ? text : undefined);
  }

  /** What's typed takes effect: the model follows (one undo step per opening). */
  private apply(): void {
    const name = this.openName;
    const text = this.pending;
    if (!name || text === null) return;
    this.pending = null;
    if (!text || this.app.check(name, text, this.kindOf(name)) === null) return;
    mergingCommits(this.undoGroup, () => this.app.setVariable(name, text));
  }

  private layout(): void {
    if (!this.visible) return;
    // Tags at the same spot on screen are fanned out down the screen.
    const taken: [number, number][] = [];
    const at = new Map<string, [number, number]>();
    for (const t of this.tags) {
      const chip = this.chips.get(t.name);
      if (!chip || !t.at) continue;
      const s = this.view.toScreen(t.at);
      chip.hidden = !s;
      if (!s) continue;
      let [x, y] = s;
      while (taken.some(([a, b]) => Math.abs(a - x) < 30 && Math.abs(b - y) < 18)) y += 20;
      taken.push([x, y]);
      at.set(t.name, [x, y]);
      chip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, -50%)`;
    }
    this.drawLines(at);
    const open = this.openName && at.get(this.openName);
    if (!open) {
      if (this.openName) this.box.style.transform = this.rel.style.transform = "translate(-9999px, 0)";
      return;
    }
    // The box beside its tag, kept on screen.
    const w = this.box.offsetWidth;
    const h = this.box.offsetHeight;
    const x = Math.max(6, Math.min(window.innerWidth - w - 6, open[0] + 18));
    const y = Math.max(56, Math.min(window.innerHeight - h - 6, open[1] - h / 2));
    this.box.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    // What's made from it, under the box (above it at the bottom of the screen).
    if (!this.rel.hidden) {
      const rh = this.rel.offsetHeight;
      const below = y + h + 4 + rh < window.innerHeight - 6;
      const rx = Math.max(6, Math.min(window.innerWidth - this.rel.offsetWidth - 6, x));
      this.rel.style.transform = `translate(${Math.round(rx)}px, ${Math.round(below ? y + h + 4 : y - rh - 4)}px)`;
    }
  }

  /**
   * The open tag: what it changes, drawn on the model in yellow dashes - a
   * length like a dimension (a tick across each end), an angle as its arc.
   */
  private drawLines(at: Map<string, [number, number]>): void {
    this.lines.innerHTML = "";
    const name = this.openName;
    if (!name || !at.get(name)) return;
    const tag = this.tags.find((t) => t.name === name)!;
    const add = (tagName: string, attrs: Record<string, string>) => {
      const n = document.createElementNS(SVG_NS, tagName);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      n.setAttribute("class", "mark");
      this.lines.append(n);
    };
    const f = (x: number) => x.toFixed(1);
    for (const m of tag.marks) {
      const pts = m.map((p) => this.view.toScreen(p as Vec3));
      if (pts.some((p) => !p)) continue;
      add("polyline", { points: pts.map((p) => `${f(p![0])},${f(p![1])}`).join(" ") });
    }
    const first = tag.marks[0]?.map((p) => this.view.toScreen(p as Vec3));
    if (!first || first.some((p) => !p)) return;
    if (tag.kind === "angle") {
      // The pivot.
      add("circle", { cx: f(first[0]![0]), cy: f(first[0]![1]), r: "3" });
      return;
    }
    // Where it's measured from and to: a tick across each end.
    for (const m of tag.marks) {
      if (m.length !== 2) continue;
      const [p, q] = m.map((x) => this.view.toScreen(x as Vec3));
      if (!p || !q) continue;
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
      const [nx, ny] = [(-(q[1] - p[1]) / len) * 7, ((q[0] - p[0]) / len) * 7];
      for (const e of [p, q]) add("line", { x1: f(e[0] - nx), y1: f(e[1] - ny), x2: f(e[0] + nx), y2: f(e[1] + ny), "stroke-dasharray": "none" });
    }
  }

  dispose(): void {
    this.view.frameHooks.delete(this.hook);
    this.host.remove();
    this.box.remove();
    this.rel.remove();
  }
}
