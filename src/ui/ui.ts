import type { Feature } from "../doc/types";
import { screenClass, watchScreenClass } from "../device";
import type { FeatureError } from "../kernel/protocol";
import { evaluate, toDisplay, trim, UNIT_LABEL, units } from "../units";
import { icons, type IconName } from "./icons";
import { numpadInput } from "./numpad";
import { settings } from "../settings";

export interface ToolItem {
  id: string;
  label: string;
  icon: IconName;
  /** Small second line, e.g. the current variant ("Diagonal"). */
  sub?: string;
  shortcut?: string;
  active?: boolean;
  disabled?: boolean;
  /** Reason shown when disabled. */
  why?: string;
  /** Opens a flyout with variants / sub-tools instead of running. */
  children?: ToolItem[];
  /** Show a colour circle instead of the icon (colour choices). */
  swatch?: string;
  /** Small icons after the label (e.g. ⟲ + what a toggle switches to). */
  trailing?: IconName[];
  run?(): void;
}

export type FieldKind = "length" | "angle" | "number" | "int";

export type PanelItem =
  | {
      type: "number";
      label: string;
      value: number;
      kind?: FieldKind;
      min?: number;
      onInput(v: number): void;
      /** Expression currently driving the value (shown instead of the number). */
      expr?: string;
      /** Set when the field may hold an expression: called with it, or null for a plain number. */
      onExpr?(expr: string | null): void;
      /** The same value as the value box on the model: left out of the list attached to it. */
      inBox?: boolean;
    }
  | { type: "slot"; label: string; value: string; active: boolean; filled: boolean; onClick(): void }
  | { type: "choice"; label?: string; options: { id: string; label: string }[]; value: string; onChange(id: string): void; /** Always a drop-down. */ list?: boolean }
  | { type: "toggle"; label: string; value: boolean; onChange(v: boolean): void }
  | { type: "button"; label: string; icon?: IconName; onClick(): void; /** Blue: the step to take next (Apply). */ primary?: boolean };

/** Kept for older call sites: a numeric field. */
export interface ValueField {
  label: string;
  value: number;
  unit?: string;
  min?: number;
  step?: number;
  integer?: boolean;
  kind?: FieldKind;
  onInput(v: number): void;
}

export interface ValuePanel {
  title: string;
  fields?: ValueField[];
  items?: PanelItem[];
  onDone?(): void;
  onCancel?(): void;
  /** Extra buttons shown in the panel (e.g. Delete). */
  actions?: ToolItem[];
}

export interface HistoryHandlers {
  edit(id: string): void;
  /** Pointer over a step (null: left it): show what it works on. */
  hover?(id: string | null): void;
  toggle(id: string): void;
  remove(id: string): void;
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

/** All DOM chrome around the viewport. Deliberately framework-free and small. */
export class UI {
  private toolbar = $<HTMLElement>("#toolbar");
  private bottomLeft = $<HTMLElement>("#bottom-left");
  private flyout = $<HTMLElement>("#flyout");
  private hint = $<HTMLElement>("#hint");
  private panel = $<HTMLElement>("#panel");
  private historyEl = $<HTMLElement>("#history");
  private historyList = $<HTMLElement>("#history-list");
  private toastEl = $<HTMLElement>("#toast");
  private labelEl = $<HTMLElement>("#label");
  private status = $<HTMLElement>("#status");
  private rightCol = $<HTMLElement>("#right-col");
  private popover = $<HTMLElement>("#popover");
  readonly pins = $<HTMLElement>("#pins");
  private toastTimer = 0;
  private panelSpec: ValuePanel | null = null;
  private flyoutOwner: string | null = null;
  private popoverOwner: string | null = null;

  constructor() {
    // Phone / tablet & small laptop / monitor & TV: <html data-screen> for the stylesheet.
    watchScreenClass(() => (this.panelSide = -1));
    document.addEventListener(
      "pointerdown",
      (e) => {
        if ((e.target as HTMLElement).tagName === "CANVAS") this.lastPress = { x: e.clientX, y: e.clientY };
      },
      true,
    );
    document.addEventListener(
      "pointermove",
      (e) => {
        this.pointerAt = { x: e.clientX, y: e.clientY };
        if ((e.target as HTMLElement).tagName === "CANVAS") this.lastPointer = { x: e.clientX, y: e.clientY };
      },
      true,
    );
    $("#history-close").innerHTML = icons.close;
    $("#history-close").addEventListener("click", () => this.toggleHistory(false));
    document.addEventListener("pointerdown", (e) => {
      const t = e.target as HTMLElement;
      if (!t.closest("#flyout, #toolbar, #bottom-left")) this.closeFlyout();
    });
    // History opens by default everywhere (on phones it floats and can be closed).
    this.toggleHistory(true);
    this.holdLabels();
    window.addEventListener("resize", () => (this.fitToolbar(), this.fitPanel()));
  }

  /**
   * Touch screens show tools as icons only: press and hold one to see its name
   * in the middle of the screen. Let go on it to use it; slide off it to not.
   */
  private holdLabels(): void {
    const ghost = el("div", "tool-ghost");
    ghost.hidden = true;
    document.body.append(ghost);
    let held: { btn: HTMLElement; id: number; timer: number; off: boolean } | null = null;
    let swallow: HTMLElement | null = null;
    const end = () => {
      if (!held) return;
      clearTimeout(held.timer);
      ghost.hidden = true;
      if (held.off) swallow = held.btn;
      held = null;
    };
    document.addEventListener(
      "pointerdown",
      (e) => {
        if (e.pointerType === "mouse") return;
        const btn = (e.target as HTMLElement).closest<HTMLElement>("#toolbar .tool, #bottom-left .tool, #flyout .tool");
        if (!btn) return;
        swallow = null;
        held = {
          btn,
          id: e.pointerId,
          off: false,
          timer: window.setTimeout(() => {
            ghost.textContent = btn.dataset.label ?? btn.title;
            ghost.hidden = false;
          }, 220),
        };
      },
      true,
    );
    document.addEventListener(
      "pointermove",
      (e) => {
        if (!held || e.pointerId !== held.id) return;
        const r = held.btn.getBoundingClientRect();
        const out = e.clientX < r.left - 6 || e.clientX > r.right + 6 || e.clientY < r.top - 6 || e.clientY > r.bottom + 6;
        if (out && !held.off) {
          // Slid off: it won't be used.
          held.off = true;
          ghost.hidden = true;
          clearTimeout(held.timer);
        }
      },
      true,
    );
    document.addEventListener("pointerup", (e) => held && e.pointerId === held.id && end(), true);
    document.addEventListener("pointercancel", (e) => {
      if (held && e.pointerId === held.id) {
        held.off = true;
        end();
      }
    }, true);
    // A press that slid off the button doesn't count as a tap on it.
    document.addEventListener(
      "click",
      (e) => {
        if (swallow && (e.target as HTMLElement).closest(".tool") === swallow) {
          e.stopImmediatePropagation();
          e.preventDefault();
        }
        swallow = null;
      },
      true,
    );
    // The long press shouldn't open the browser's own menu.
    document.addEventListener("contextmenu", (e) => (e.target as HTMLElement).closest?.(".tool") && e.preventDefault());
  }

  toggleHistory(open?: boolean): void {
    const on = this.historyEl.classList.toggle("open", open);
    // Phones: one panel at a time (History or Items).
    if (on && window.innerWidth <= 720) {
      document.getElementById("items")?.classList.remove("open");
      document.body.classList.remove("items-open");
    }
    // Everything on the right makes room for the docked History panel.
    document.body.classList.toggle("history-open", on);
    // Things placed beside the right-hand bar (panel, constraint column) re-fit.
    window.dispatchEvent(new Event("resize"));
  }

  // ------------------------------------------------------------- left column

  setTools(items: ToolItem[]): void {
    this.closeFlyout();
    this.toolItems = items;
    renderTools(this.toolbar, items, (item, btn) => this.runAndOpen(item, btn, this.toolbar, () => this.toolItems));
    this.fitToolbar();
  }

  setBottom(items: ToolItem[]): void {
    this.bottomItems = items;
    renderTools(this.bottomLeft, items, (item, btn) => this.runAndOpen(item, btn, this.bottomLeft, () => this.bottomItems));
    this.fitToolbar();
  }

  private toolItems: ToolItem[] = [];
  private bottomItems: ToolItem[] = [];

  /**
   * A tool with options (Spline: fit / control points…): a click starts it
   * straight away with the option used last, and opens the options beside it.
   */
  private runAndOpen(item: ToolItem, btn: HTMLElement, host: HTMLElement, items: () => ToolItem[]): void {
    if (!item.run || this.flyoutOwner === item.id) return this.openFlyout(item, btn);
    const rect = btn.getBoundingClientRect();
    item.run();
    // Running it may have redrawn the column: open the options on the new button
    // (or where the button was, if a tool took the column over).
    const fresh = items().find((x) => x.id === item.id) ?? item;
    const nb = host.querySelector<HTMLElement>(`[data-tool="${CSS.escape(item.id)}"]`) ?? ({ getBoundingClientRect: () => rect } as HTMLElement);
    if (fresh.children?.length) this.openFlyout(fresh, nb);
  }

  /**
   * The tool column is centred on the left edge; keep it clear of the top bar
   * and of the buttons at the bottom-left, with a gap like the other panels.
   */
  /**
   * The value panel is centred at the bottom: keep it between the left tool
   * columns and the right column / History, wrapping onto more rows if needed.
   */
  fitPanel(): void {
    // The list sizes itself (and is placed by placePanel).
    if (this.panel.classList.contains("as-list")) return void (this.panel.style.maxWidth = "");
    if (window.innerWidth <= 720) return void (this.panel.style.maxWidth = "");
    const GAP = 12;
    const visible = (e: HTMLElement) => !e.hidden && e.childElementCount > 0 && getComputedStyle(e).display !== "none";
    const left = Math.max(0, ...[this.toolbar, this.bottomLeft, document.getElementById("undo-dock")!].filter(visible).map((e) => e.getBoundingClientRect().right));
    const rights = [this.rightCol, ...(this.historyEl.classList.contains("open") ? [this.historyEl] : [])].map((e) => e.getBoundingClientRect().left);
    const right = window.innerWidth - Math.min(window.innerWidth, ...rights);
    const reserve = Math.max(left, right) + GAP;
    this.panel.style.maxWidth = `${Math.max(260, window.innerWidth - 2 * reserve)}px`;
  }

  fitToolbar(): void {
    if (window.innerWidth <= 720) return void (this.toolbar.style.maxHeight = "");
    const GAP = 14;
    // Whatever is stacked at the bottom-left (section/measure buttons, the undo dock).
    const stack = [this.bottomLeft, document.getElementById("undo-dock")!].filter((e) => e.childElementCount && getComputedStyle(e).display !== "none");
    const below = stack.length ? window.innerHeight - Math.min(...stack.map((e) => e.getBoundingClientRect().top)) + GAP : 0;
    const above = 52 + GAP;
    this.toolbar.style.maxHeight = `${Math.max(160, window.innerHeight - 2 * Math.max(below, above))}px`;
  }

  /** Back-compat: the context list now lives in the main column. */
  setContext(_items: ToolItem[]): void {}

  private openFlyout(item: ToolItem, anchor: HTMLElement): void {
    if (this.flyoutOwner === item.id) return this.closeFlyout();
    this.flyoutOwner = item.id;
    // Measure before re-rendering: a nested anchor lives inside this flyout.
    const r = anchor.getBoundingClientRect();
    this.flyout.innerHTML = "";
    renderTools(this.flyout, item.children ?? [], (child, btn) => this.openFlyout(child, btn), () => this.closeFlyout());
    // Colour choices show as a grid of circles.
    this.flyout.classList.toggle("swatch-grid", !!item.children?.length && item.children.every((c) => c.swatch));
    this.flyout.hidden = false;
    const narrow = window.innerWidth <= 720;
    if (narrow) {
      // Above the bottom strip and the buttons stacked over it (undo, section…).
      const stack = [this.bottomLeft, document.getElementById("undo-dock")!].filter((e) => e.childElementCount && getComputedStyle(e).display !== "none").map((e) => e.getBoundingClientRect().top);
      const above = Math.min(r.top, ...stack.filter((t) => t < r.top));
      this.flyout.style.left = "8px";
      this.flyout.style.top = "";
      this.flyout.style.bottom = `${window.innerHeight - above + 8}px`;
    } else {
      // Clear of the whole column (it can be wider than its buttons, with a scrollbar).
      const col = anchor.closest?.("#toolbar, #bottom-left")?.getBoundingClientRect();
      this.flyout.style.left = `${Math.max(r.right, col?.right ?? 0) + 6}px`;
      this.flyout.style.bottom = "";
      // Short screens (phones sideways): within the tool column's height, never over the
      // top bar or the undo buttons, scrolling if longer. Elsewhere: clear of the top bar.
      const toolbar = this.toolbar.getBoundingClientRect();
      const short = window.innerHeight <= 500 && toolbar.height > 0;
      const top = short ? toolbar.top : 52;
      // …and above the buttons at the bottom left (section, measure, undo).
      const stackTop = Math.min(window.innerHeight, ...[this.bottomLeft, document.getElementById("undo-dock")!].filter((e) => e.childElementCount && getComputedStyle(e).display !== "none").map((e) => e.getBoundingClientRect().top));
      const bottom = short ? toolbar.bottom : Math.min(window.innerHeight - 12, stackTop - 8);
      this.flyout.style.maxHeight = `${Math.max(120, bottom - top)}px`;
      const h = Math.min(this.flyout.scrollHeight, bottom - top);
      this.flyout.style.top = `${Math.max(top, Math.min(r.top, bottom - h))}px`;
    }
  }

  closeFlyout(): void {
    this.flyout.hidden = true;
    this.flyoutOwner = null;
  }

  // ------------------------------------------------------------ right column

  addRight(id: string, icon: IconName, title: string, open: (host: HTMLElement) => void, label?: () => string, place?: { host: HTMLElement; className: string }): HTMLButtonElement {
    const b = document.createElement("button");
    b.className = place ? place.className : "right-btn";
    b.title = title;
    b.innerHTML = icons[icon];
    if (label) {
      const l = document.createElement("span");
      l.className = "right-label";
      b.append(l);
      b.dataset.dynamic = "1";
      (b as HTMLButtonElement & { refresh?: () => void }).refresh = () => (l.textContent = label());
      (b as HTMLButtonElement & { refresh?: () => void }).refresh!();
    }
    b.addEventListener("click", () => {
      // Popovers stay open until their button is clicked again.
      if (this.popoverOwner === id) return this.closePopover();
      this.popoverOwner = id;
      this.popoverFill = () => {
        this.popover.innerHTML = "";
        open(this.popover);
      };
      this.popoverFill();
      if (!this.popover.childElementCount) return this.closePopover();
      this.popover.hidden = false;
      const r = b.getBoundingClientRect();
      if (place) {
        // Opened from the view cube: under the cube, its right edge lined up with the button.
        // (Clear of the right-hand column below it.)
        const col = this.rightCol.getBoundingClientRect();
        this.popover.style.right = `${Math.max(window.innerWidth - r.right, col.width ? window.innerWidth - col.left + 8 : 8)}px`;
        this.popover.style.top = `${Math.min(r.bottom + 6, window.innerHeight - this.popover.offsetHeight - 8)}px`;
      } else {
        this.popover.style.right = "";
        this.popover.style.top = `${Math.max(8, Math.min(r.top, window.innerHeight - this.popover.offsetHeight - 8))}px`;
      }
      document.querySelectorAll(".pop-open").forEach((x) => x.classList.remove("pop-open"));
      b.classList.add("pop-open");
      // Things placed beside the right column (the constraint column) move over.
      window.dispatchEvent(new Event("resize"));
    });
    (place?.host ?? this.rightCol).append(b);
    return b;
  }

  refreshRight(): void {
    this.rightCol.querySelectorAll<HTMLButtonElement & { refresh?: () => void }>("button").forEach((b) => b.refresh?.());
  }

  private popoverFill: (() => void) | null = null;

  closePopover(): void {
    // An action button (no popover shown) must not stay the owner: its next click would only "close".
    this.popoverOwner = null;
    if (this.popover.hidden) return;
    this.popover.hidden = true;
    this.popoverFill = null;
    document.querySelectorAll(".pop-open").forEach((x) => x.classList.remove("pop-open"));
    window.dispatchEvent(new Event("resize"));
  }

  /** Re-draw the open popover (after one of its choices changed). */
  refreshPopover(): void {
    this.popoverFill?.();
  }

  // ------------------------------------------------------- hint/status/toast

  setHint(text: string | null): void {
    this.hint.textContent = text ?? "";
    this.hintText = text;
    this.hint.hidden = !text || !settings.value.showHints;
  }

  private hintText: string | null = null;

  /** More → Guide text switched: show (or hide) what's there now. */
  refreshHint(): void {
    this.setHint(this.hintText);
  }

  /** A small persistent note (e.g. "body not closed"), never blocking. */
  setWarning(text: string | null): void {
    const w = document.getElementById("warn")!;
    w.textContent = text ?? "";
    w.hidden = !text;
  }

  setStatus(text: string | null): void {
    this.status.textContent = text ?? "";
    this.status.hidden = !text;
  }

  toast(text: string, kind: "info" | "error" = "info"): void {
    this.toastEl.textContent = text;
    this.toastEl.className = `show ${kind}`;
    // Never over what's being typed into (a value box, the numpad, the tool panel): then it shows up top.
    const t = this.toastEl.getBoundingClientRect();
    const hit = [...document.querySelectorAll<HTMLElement>(".numpad:not([hidden]), .dim-widget, #panel:not([hidden])")].some((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.left < t.right && r.right > t.left && r.top < t.bottom && r.bottom > t.top;
    });
    if (hit) this.toastEl.classList.add("top");
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => (this.toastEl.className = ""), 3600);
  }

  /** Floating label next to the pointer, e.g. live dimensions while drawing. */
  setLabel(x: number, y: number, text: string | null): void {
    if (!text) {
      this.labelEl.hidden = true;
      return;
    }
    // Callers mark typeable values with a trailing "· type a value". The value is
    // already in a box on screen (the value box or the tool's list): no second label.
    const value = text.replace(/\s+· type a value$/, "");
    const typeable = value !== text;
    const typing = value.includes("▌");
    const shownElsewhere = !this.panel.hidden || !!document.querySelector(".dim-widget.editable:not([hidden])");
    if (typeable && !typing && shownElsewhere) {
      this.labelEl.hidden = true;
      return;
    }
    this.labelEl.hidden = false;
    const tip = typing ? "Enter ↵ apply · Esc cancel" : null;
    this.labelEl.replaceChildren(el("span", "label-value", value), ...(tip ? [el("span", "label-tip", tip)] : []));
    this.labelEl.classList.toggle("typing", typing);
    this.labelEl.style.transform = `translate(${Math.round(x + 18)}px, ${Math.round(y + 14)}px)`;
  }

  /** Small modal form; resolves with the values, or null if cancelled. */
  dialog(title: string, fields: { key: string; label: string; value: string; placeholder?: string }[], note?: string): Promise<Record<string, string> | null> {
    return new Promise((resolve) => {
      const back = el("div", "dialog-back");
      const box = el("form", "dialog");
      box.append(el("div", "panel-title", title));
      if (note) box.append(el("div", "dialog-note", note));
      const inputs = fields.map((f) => {
        const l = el("label", "dialog-field");
        l.append(el("span", "field-label", f.label));
        const i = document.createElement("input");
        i.value = f.value;
        i.placeholder = f.placeholder ?? "";
        i.autocomplete = "off";
        i.spellcheck = false;
        l.append(i);
        box.append(l);
        return i;
      });
      const row = el("div", "panel-buttons");
      const close = (v: Record<string, string> | null) => {
        back.remove();
        resolve(v);
      };
      row.append(textButton("Cancel", "Esc", () => close(null)));
      const ok = textButton("OK", "Enter", () => close(Object.fromEntries(fields.map((f, i) => [f.key, inputs[i].value]))), true);
      row.append(ok);
      box.append(row);
      box.addEventListener("submit", (e) => (e.preventDefault(), ok.click()));
      // Enter is OK (left to the browser it would "click" the first button: Cancel).
      for (const b of row.querySelectorAll("button")) b.type = "button";
      box.addEventListener("keydown", (e) => {
        if (e.key === "Escape") close(null);
        if (e.key === "Enter") (e.preventDefault(), ok.click());
        e.stopPropagation();
      });
      back.append(box);
      document.body.append(back);
      inputs[0]?.focus();
    });
  }

  /** A question with a few answers (buttons); resolves with the chosen id, or null (Esc / Cancel). */
  ask(title: string, note: string, choices: { id: string; label: string; primary?: boolean; /** Runs inside the tap itself (for things a browser only allows on a tap, like sharing). */ run?: () => void }[]): Promise<string | null> {
    return new Promise((resolve) => {
      const back = el("div", "dialog-back");
      const box = el("div", "dialog");
      box.append(el("div", "panel-title", title));
      if (note) box.append(el("div", "dialog-note", note));
      const row = el("div", "panel-buttons");
      const close = (v: string | null) => {
        back.remove();
        window.removeEventListener("keydown", onKey, true);
        resolve(v);
      };
      row.append(textButton("Cancel", "Esc", () => close(null)));
      let primary: HTMLButtonElement | null = null;
      for (const c of choices) {
        const b = textButton(c.label, c.primary ? "Enter" : "", () => (c.run?.(), close(c.id)), !!c.primary);
        if (c.primary) primary = b;
        row.append(b);
      }
      for (const b of row.querySelectorAll("button")) b.type = "button";
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") (e.preventDefault(), close(null));
        if (e.key === "Enter" && primary) (e.preventDefault(), primary.click());
        e.stopPropagation();
      };
      window.addEventListener("keydown", onKey, true);
      box.append(row);
      back.append(box);
      back.addEventListener("pointerdown", (e) => e.target === back && close(null));
      document.body.append(back);
      primary?.focus();
    });
  }

  // ------------------------------------------------------------------- panel

  get panelOpen(): boolean {
    return this.panelSpec !== null;
  }

  showPanel(spec: ValuePanel | null): void {
    this.panelSpec = spec;
    this.panel.innerHTML = "";
    this.panel.hidden = !spec;
    // Closed: next time it's placed afresh.
    if (!spec) return void (this.panelSide = -1);
    // A short list, like a right-click menu: each value with its box after the
    // name. It hangs under the tool's value box on the model (or by the pointer).
    this.panel.classList.add("as-list");
    this.followPanel();
    this.panel.append(el("div", "panel-title", spec.title));
    const row = el("div", "panel-fields");
    const items: PanelItem[] = [
      ...(spec.fields ?? []).map(
        (f): PanelItem => ({ type: "number", label: f.label, value: f.value, kind: f.kind ?? (f.integer ? "int" : f.unit ? "length" : "number"), min: f.min, onInput: f.onInput }),
      ),
      ...(spec.items ?? []),
    ];
    let numberIndex = 0;
    for (const it of items) {
      if (it.type === "number") {
        const f = this.numberField(it, numberIndex++, spec);
        if (it.inBox) f.dataset.inbox = "1";
        row.append(f);
      }
      else if (it.type === "slot") {
        const b = el("button", `slot${it.active ? " active" : ""}${it.filled ? " filled" : ""}`);
        b.append(el("span", "slot-label", it.label), el("span", "slot-value", it.value));
        b.addEventListener("click", it.onClick);
        row.append(b);
      } else if (it.type === "choice" && (it.options.length > 4 || it.list)) {
        // Many options (e.g. fonts, more with every imported one): a drop-down that stays in the panel.
        const g = el("label", "field choice-list");
        if (it.label) g.append(el("span", "field-label", it.label));
        const sel = document.createElement("select");
        for (const o of it.options) {
          const opt = document.createElement("option");
          opt.value = o.id;
          opt.textContent = o.label;
          sel.append(opt);
        }
        sel.value = it.value;
        sel.addEventListener("change", () => it.onChange(sel.value));
        sel.addEventListener("pointerdown", (e) => e.stopPropagation());
        g.append(sel);
        row.append(g);
      } else if (it.type === "choice") {
        const g = el("div", "choice");
        if (it.label) g.append(el("span", "field-label", it.label));
        for (const o of it.options) {
          const b = el("button", o.id === it.value ? "active" : "", o.label);
          b.addEventListener("click", () => it.onChange(o.id));
          g.append(b);
        }
        row.append(g);
      } else if (it.type === "toggle") {
        const b = el("button", `toggle${it.value ? " on" : ""}`, it.label);
        b.addEventListener("click", () => it.onChange(!it.value));
        row.append(b);
      } else {
        const b = el("button", it.primary ? "text-btn primary" : "text-btn");
        if (it.icon) b.innerHTML = icons[it.icon];
        b.append(it.label);
        b.addEventListener("click", it.onClick);
        row.append(b);
      }
    }
    this.panel.append(row);
    const buttons = el("div", "panel-buttons");
    for (const a of spec.actions ?? []) {
      const b = toolButton(a, true);
      b.addEventListener("click", () => a.run?.());
      buttons.append(b);
    }
    if (spec.onCancel) buttons.append(textButton("Cancel", "Esc", spec.onCancel));
    if (spec.onDone) buttons.append(textButton("Done", "Enter", spec.onDone, true));
    this.panel.append(buttons);
  }

  private numberField(f: Extract<PanelItem, { type: "number" }>, index: number, spec: ValuePanel): HTMLElement {
    const kind = f.kind ?? "length";
    const label = el("label", "field");
    label.append(el("span", "field-label", f.label));
    const input = document.createElement("input");
    input.type = "text";
    input.inputMode = "decimal";
    numpadInput(input);
    input.autocomplete = "off";
    input.spellcheck = false;
    input.value = f.expr ?? shown(f.value, kind);
    input.dataset.index = String(index);
    input.dataset.kind = kind;
    if (f.expr) input.classList.add("has-expr");
    const apply = () => {
      const v = evaluate(input.value, kind === "length" ? "length" : kind === "angle" ? "angle" : "number");
      const ok = v !== null && (f.min === undefined || v >= f.min);
      input.classList.toggle("invalid", !ok);
      if (!ok) return;
      // Text with a variable name stays an expression (parametric); plain numbers don't.
      const isExpr = isExpression(input.value);
      input.classList.toggle("has-expr", isExpr);
      f.onExpr?.(isExpr ? input.value.trim() : null);
      f.onInput(kind === "int" ? Math.round(v!) : v!);
    };
    input.addEventListener("input", apply);
    // Clicking a value selects it: typing replaces it (no "020").
    input.addEventListener("focus", () => requestAnimationFrame(() => document.activeElement === input && input.select()));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        apply();
        spec.onDone?.();
      } else if (e.key === "Escape") {
        e.preventDefault();
        spec.onCancel?.();
      } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        const v = evaluate(input.value, kind === "length" ? "length" : "number") ?? 0;
        const step = kind === "length" ? (e.shiftKey ? 10 : 1) : e.shiftKey ? 10 : 1;
        const next = v + (e.key === "ArrowUp" ? step : -step) * (kind === "length" ? unitScale() : 1);
        input.value = shown(next, kind);
        apply();
      }
      e.stopPropagation();
    });
    label.append(input);
    const unit = kind === "length" ? UNIT_LABEL[units()] : kind === "angle" ? "°" : "";
    if (unit) label.append(el("span", "field-unit", unit));
    if (f.onExpr && this.variableFactory) {
      const fx = el("button", "fx-btn", "ƒx");
      fx.title = "Variables: use one here, or make a new one from this value";
      fx.addEventListener("click", async (e) => {
        e.preventDefault();
        // One button, two ways: an existing variable, or a new one.
        const names = this.variableNames();
        let name: string | null = null;
        if (names.length) {
          const pick = await this.ask("Variables", "Use a variable for this value, or make a new one from it.", [
            ...names.slice(0, 8).map((n) => ({ id: `v:${n}`, label: n })),
            { id: "new", label: "New variable", primary: true },
          ]);
          if (!pick) return;
          name = pick === "new" ? await this.variableFactory!(input.value) : pick.slice(2);
        } else name = await this.variableFactory!(input.value);
        if (!name) return;
        input.value = name;
        apply();
      });
      label.append(fx);
    }
    return label;
  }

  /** Where the pointer last pressed on the model (the list goes near it when there's no value box). */
  private lastPress: { x: number; y: number } | null = null;
  private following = false;

  /**
   * Keep the tool's list beside what you're working on, every frame: under the
   * value box on the model if there is one (it moves with the view), else just
   * past where you last pressed, and always on screen.
   */
  private followPanel(): void {
    if (this.following) return;
    this.following = true;
    const step = () => {
      if (this.panel.hidden) {
        this.following = false;
        return;
      }
      this.placePanel();
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /** Where the pointer is over the model (the card keeps out of its way). */
  private lastPointer: { x: number; y: number } | null = null;
  /** Where the pointer is anywhere on the page. */
  private pointerAt: { x: number; y: number } | null = null;
  /** Which side the card went last time (kept while it's still clear: no jumping about). */
  private panelSide = -1;

  private placePanel(): void {
    const p = this.panel;
    const box = [...document.querySelectorAll<HTMLElement>(".dim-widget.editable")].filter((e) => !e.hidden && e.offsetWidth).pop();
    p.classList.toggle("attached", !!box);
    // Phones: one fixed place, right above the hint text (or the bottom
    // buttons) — never chasing the model across a small screen.
    if (screenClass() === "phone") {
      const tops = ["#hint", "#bottom-left", "#undo-dock", "#toolbar"]
        .map((q) => document.querySelector<HTMLElement>(q))
        .filter((e): e is HTMLElement => !!e && !e.hidden && e.offsetHeight > 0 && getComputedStyle(e).display !== "none")
        .map((e) => e.getBoundingClientRect())
        // Only what sits along the bottom (not a side column).
        .filter((r) => r.top > window.innerHeight * 0.55 && r.width > 120)
        .map((r) => r.top);
      const bottom = Math.min(window.innerHeight - 8, ...tops) - 8;
      p.style.left = "8px";
      p.style.top = `${Math.round(Math.max(52, bottom - p.offsetHeight))}px`;
      this.panelSide = 0;
      return;
    }
    // Heading for the card (or typing in it): it holds still, so it can be clicked.
    if (this.panelSide >= 0 && p.style.left) {
      const cr = p.getBoundingClientRect();
      const q = this.pointerAt;
      const near = q && q.x > cr.left - 60 && q.x < cr.right + 60 && q.y > cr.top - 60 && q.y < cr.bottom + 60;
      if (near || p.contains(document.activeElement) || p.matches(":hover")) return;
    }
    const w = p.offsetWidth;
    const h = p.offsetHeight;
    const M = 8;
    const W = window.innerWidth;
    const H = window.innerHeight;
    // Places to try, in order of preference.
    let spots: [number, number][];
    // What the card must not cover: the dimension (the line being drawn, the
    // drag arrow) and the pointer.
    const avoid: [number, number][][] = [];
    if (box) {
      const r = box.getBoundingClientRect();
      spots = [
        [r.right + 4, r.top],
        [r.left - 4 - w, r.top],
        [r.left, r.top - 4 - h],
        [r.left, r.bottom + 4],
        [r.right + 4, r.bottom - h],
        [r.left - 4 - w, r.bottom - h],
      ];
      const seg = box.dataset.seg?.split(",").map(Number);
      if (seg && seg.length === 4 && seg.every(Number.isFinite)) avoid.push([[seg[0], seg[1]], [seg[2], seg[3]]]);
    } else if (this.lastPress) {
      const q = this.lastPress;
      spots = [
        [q.x + 28, q.y + 20],
        [q.x - 28 - w, q.y + 20],
        [q.x + 28, q.y - 20 - h],
        [q.x - 28 - w, q.y - 20 - h],
      ];
    } else spots = [[(W - w) / 2, H - h - 70]];
    if (this.lastPointer) avoid.push([[this.lastPointer.x, this.lastPointer.y]]);
    const clampX = (x: number) => Math.max(M, Math.min(W - w - M, x));
    const clampY = (y: number) => Math.max(52, Math.min(H - h - M, y));
    // How badly a spot is in the way: off screen (moved back on), over the line, over the pointer.
    const cost = ([x0, y0]: [number, number], withPointer: boolean): number => {
      const x = clampX(x0);
      const y = clampY(y0);
      let c = Math.abs(x - x0) + Math.abs(y - y0) > 1 ? 1 : 0;
      const pad = 14;
      const inside = (px: number, py: number) => px > x - pad && px < x + w + pad && py > y - pad && py < y + h + pad;
      for (const a of avoid) {
        if (a.length === 1) {
          if (withPointer && inside(a[0][0], a[0][1])) c += 2;
          continue;
        }
        for (let k = 0; k <= 24; k++) {
          const t = k / 24;
          if (inside(a[0][0] + (a[1][0] - a[0][0]) * t, a[0][1] + (a[1][1] - a[0][1]) * t)) {
            c += 4;
            break;
          }
        }
      }
      return c;
    };
    // Where it is stays as long as it's clear of the line (the pointer only steers where it goes next).
    let pick = this.panelSide >= 0 && this.panelSide < spots.length && cost(spots[this.panelSide], false) === 0 ? this.panelSide : -1;
    if (pick < 0) {
      let best = Infinity;
      spots.forEach((sp, i) => {
        const c = cost(sp, true);
        if (c < best) [best, pick] = [c, i];
      });
    }
    this.panelSide = pick;
    const [x, y] = spots[pick];
    p.style.left = `${Math.round(clampX(x))}px`;
    p.style.top = `${Math.round(clampY(y))}px`;
  }

  /** Creates a variable from a field's current text; returns its name (set by the app). */
  variableFactory: ((current: string) => Promise<string | null>) | null = null;
  /** The project's variable names (set by the app). */
  variableNames: () => string[] = () => [];

  /** Update displayed values without rebuilding (keeps focus while dragging). */
  updatePanelValues(values: number[]): void {
    this.panel.querySelectorAll<HTMLInputElement>("input[data-index]").forEach((input) => {
      const v = values[Number(input.dataset.index)];
      if (v !== undefined && document.activeElement !== input) input.value = shown(v, input.dataset.kind as FieldKind);
    });
  }

  focusPanel(): void {
    // Only focus with a keyboard; on touch it would pop the on-screen keyboard.
    if (matchMedia("(pointer: fine)").matches) this.panel.querySelector<HTMLInputElement>("input")?.select();
  }

  // ----------------------------------------------------------------- history

  /** Steps whose ! explanation is folded out in History. */
  private openWarns = new Set<string>();

  /** Sketches whose steps are folded out in History. */
  private openSteps = new Set<string>();

  renderHistory(features: readonly Feature[], errors: FeatureError[], activeId: string | null, h: HistoryHandlers, warnings: Map<string, string> = new Map()): void {
    this.historyList.innerHTML = "";
    if (features.length === 0) {
      this.historyList.append(el("li", "history-empty", "Nothing yet. Start with Sketch."));
      return;
    }
    for (const f of features) {
      const li = el("li", "history-item");
      const err = errors.find((e) => e.featureId === f.id);
      if (err) li.classList.add("error");
      if (f.suppressed) li.classList.add("suppressed");
      if (f.id === activeId) li.classList.add("active");
      const name = el("button", "history-name", f.name);
      name.title = err ? err.message : "Edit";
      // A step that works but leaves something to look at (e.g. a body that isn't closed).
      const warn = warnings.get(f.id);
      if (warn && !err) {
        // The ! folds the explanation out under the step (like a sketch's steps).
        const mark = el("button", "history-warn", "!");
        mark.title = warn;
        mark.addEventListener("click", (e) => {
          e.stopPropagation();
          if (this.openWarns.has(f.id)) this.openWarns.delete(f.id);
          else this.openWarns.add(f.id);
          this.renderHistory(features, errors, activeId, h, warnings);
        });
        li.prepend(mark);
        name.title = warn;
      }
      name.addEventListener("click", () => h.edit(f.id));
      li.addEventListener("pointerenter", () => h.hover?.(f.id));
      li.addEventListener("pointerleave", () => h.hover?.(null));
      const eye = iconButton(f.suppressed ? "eyeOff" : "eye", f.suppressed ? "Enable" : "Suppress", () => h.toggle(f.id));
      const del = iconButton("trash", "Delete", () => h.remove(f.id));
      // A sketch's own steps fold out under it (closed by default).
      const steps = f.type === "sketch" ? (f.log ?? []) : [];
      if (steps.length) {
        const open = this.openSteps.has(f.id);
        const caret = el("button", "history-caret", open ? "▾" : "▸");
        caret.title = open ? "Hide the steps in this sketch" : `Show the ${steps.length} step${steps.length > 1 ? "s" : ""} in this sketch`;
        caret.addEventListener("click", (e) => {
          e.stopPropagation();
          if (this.openSteps.has(f.id)) this.openSteps.delete(f.id);
          else this.openSteps.add(f.id);
          this.renderHistory(features, errors, activeId, h, warnings);
        });
        li.append(caret);
      }
      li.append(name, eye, del);
      if (err) li.append(el("div", "history-error", err.message));
      if (warn && !err && this.openWarns.has(f.id)) li.append(el("div", "history-warning-text", warn));
      this.historyList.append(li);
      // What was done inside a sketch, step by step.
      if (f.type === "sketch" && f.log?.length && this.openSteps.has(f.id)) {
        const steps = f.log;
        const shownSteps = steps.length > 12 ? steps.slice(-12) : steps;
        const sub = el("li", "history-steps");
        if (steps.length > shownSteps.length) sub.append(el("div", "history-step more", `… ${steps.length - shownSteps.length} earlier`));
        for (const s of shownSteps) {
          const row = el("button", "history-step", `${s.op}${s.n > 1 ? ` ×${s.n}` : ""}`);
          row.title = "Open the sketch";
          row.addEventListener("click", () => h.edit(f.id));
          sub.append(row);
        }
        this.historyList.append(sub);
      }
    }
  }
}

/** Does the text use a variable (a name that isn't a unit suffix)? */
export function isExpression(text: string): boolean {
  return /[a-z_]/i.test(text.replace(/(\d|\))\s*(mm|cm|m|in|ft)\b/gi, "$1"));
}

function unitScale(): number {
  return { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 }[units()];
}

function shown(v: number, kind: FieldKind): string {
  if (kind === "length") return trim(toDisplay(v), 4);
  if (kind === "int") return String(Math.round(v));
  return trim(v, 4);
}

/**
 * Only what can be used right now: tools that can't (greyed before) are left
 * out, and so are groups with nothing usable inside.
 */
function usable(items: ToolItem[]): ToolItem[] {
  const out: ToolItem[] = [];
  for (const item of items) {
    if (item.disabled) continue;
    if (item.children?.length) {
      const children = usable(item.children);
      if (!children.length && !item.run) continue;
      out.push({ ...item, children });
    } else out.push(item);
  }
  // No separators at the ends or twice in a row.
  return out.filter((x, i, a) => !x.id.startsWith("---") || (i > 0 && i < a.length - 1 && !a[i - 1].id.startsWith("---")));
}

function renderTools(host: HTMLElement, all: ToolItem[], onFlyout: (item: ToolItem, btn: HTMLElement) => void, after?: () => void): void {
  host.innerHTML = "";
  const items = usable(all);
  for (const item of items) {
    if (item.id.startsWith("---")) {
      host.append(el("div", "tool-sep"));
      continue;
    }
    const b = toolButton(item, true);
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      if (item.disabled) return;
      if (item.children?.length) onFlyout(item, b);
      else {
        item.run?.();
        after?.();
      }
    });
    host.append(b);
  }
}

function toolButton(item: ToolItem, withLabel: boolean): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "tool";
  b.dataset.tool = item.id;
  b.dataset.label = item.label;
  b.classList.toggle("active", !!item.active);
  b.classList.toggle("has-children", !!item.children?.length);
  b.classList.toggle("disabled", !!item.disabled);
  b.title = item.disabled && item.why ? item.why : item.shortcut ? `${item.label} (${item.shortcut})` : item.label;
  b.innerHTML = item.swatch ? `<span class="swatch" style="background:${item.swatch}"></span>` : icons[item.icon];
  if (withLabel) {
    const l = el("span", "tool-label");
    const top = el("span", "tool-name", item.label);
    if (item.shortcut) top.append(el("kbd", "", item.shortcut));
    l.append(top);
    if (item.sub) l.append(el("span", "tool-sub", item.sub));
    b.append(l);
  }
  if (item.trailing?.length) {
    const t = el("span", "tool-trailing");
    t.innerHTML = item.trailing.map((i) => icons[i]).join("");
    b.append(t);
  }
  return b;
}

function iconButton(icon: IconName, title: string, run: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "icon-btn";
  b.title = title;
  b.innerHTML = icons[icon];
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    run();
  });
  return b;
}

function textButton(label: string, kbd: string, run: () => void, primary = false): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = primary ? "text-btn primary" : "text-btn";
  b.append(label);
  if (kbd && matchMedia("(pointer: fine)").matches) b.append(el("kbd", "", kbd));
  b.addEventListener("click", run);
  return b;
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

export function fmt(v: number): string {
  return String(Math.round(v * 1000) / 1000);
}
