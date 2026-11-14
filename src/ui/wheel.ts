// The tool wheel: the only way to the tools (in place of the tool column).
//
// With it on, a tap on the model - or on an empty spot - brings the tools up
// in a ring round the pointer: the main groups, each always in the same one
// of eight places (MODEL_RING). A tap on a group - or a press slid out across
// it - turns the ring into that group's tools, right there: the most used in
// the group's own place, under the finger, the next either side of it (RANK,
// ORDER), and the middle becomes Back. A tool with kinds of its own (Plane,
// Colour…) opens them the same way. Press, slide, let go: any tool in one stroke.
//
// Its middle is a handle: dragged, the wheel goes where it is put and is kept
// there - it then stays up, showing what the pick offers, instead of coming up
// at the pointer (a tap on the middle folds it to just the handle, two let it
// go back to the pointer). In a sketch it is the sketch's wheel, always kept:
// the drawing tools by what they are for.
//
// It holds exactly what the column and the bottom bar hold - the same
// ToolItems, by the same rule (only what can be used now) - so the keys, the
// search box and the column itself (wheel off) go on working as they did.
// With it on, the bottom bar steps aside with the column, and the right
// column keeps Fit, Screenshot and History: its other lists (snapping, units,
// appearance, shaders, the numpad) are under Settings, in View. While a tool
// with a window of its own is open (Extrude, Fillet, Measure…) the wheel is
// folded to its handle, a cog there: unfolded, it is those Settings.

import { isCoarse, screenClass } from "../device";
import { settings } from "../settings";
import { evaluate, toDisplay, UNIT_LABEL, units } from "../units";
import { numpadInput, openNumpad } from "./numpad";
import { selectAll } from "./textField";
import { iconNameFor, icons, type IconName } from "./icons";
import { el, usable, type PanelItem, type ToolItem, type UI } from "./ui";

/**
 * What it shows: the selection tool's column ("model"), the sketch's, or -
 * the second wheel, always on the screen - the Settings ("settings"), or -
 * the third, up while a tool has a window - the tool's options ("options").
 */
export type WheelLayout = "model" | "sketch" | "freeform" | "settings" | "options";

/** What the tool wheel stands in for now (the Options wheel leaves to it what it shows). */
let toolsLayout: WheelLayout | null = null;

/** More for the model wheel's top sector, beside what the column holds for what's picked (Reveal in Items). */
export type WheelExtras = () => ToolItem[];

/** What a tool sees of the wheel. */
export interface WheelHandle {
  /** Switched on (always, now: the setting is kept on). */
  readonly on: boolean;
  /** Up now: round the pointer, or at the place it is kept. */
  readonly isOpen: boolean;
  /** It has a place of its own on the screen and stays up there (dragged there by its middle; in a sketch or beside a tool, always). */
  readonly kept: boolean;
  /**
   * What it shows from now on: the selection tool's column ("model": what's
   * picked, or the main tools), the sketch's (its tools by what they are
   * for), a freeform shape's (what its card offers, by what it does), or
   * nothing (false: another tool's own column and window show).
   */
  cover(layout: "model" | "sketch" | "freeform" | false, extras?: WheelExtras): void;
  /** Bring it up round a point of the page. (Kept somewhere, it is up already: `summon` unfolds it.) */
  open(x: number, y: number, opts?: WheelOpen): void;
  /** Up at the point, or away again (kept somewhere: folded, or unfolded). */
  toggle(x: number, y: number, opts?: WheelOpen): void;
  close(): void;
  /** Did the press now being handled close an open wheel? (A tap on an empty spot then only closes it.) */
  takeDismissed(): boolean;
}

export interface WheelOpen {
  type?: "mouse" | "pen" | "touch";
  /** Opened under a finger still down (press and hold): it can slide to a tool and lift there. */
  held?: boolean;
  /** Asked for (right-click, Q): a kept wheel that is folded unfolds. */
  summon?: boolean;
}

export interface WheelHost {
  readonly ui: UI;
  mainTools(): ToolItem[];
}

interface Metrics {
  /** The middle: the handle. */
  hub: number;
  /** The ring of groups: from, to. */
  r0: number;
  r1: number;
  /** Between the ring and a row of tools, and between rows. */
  gap: number;
  /** How deep a row of tools is. */
  depth: number;
  /** A tool's cell along its row: as wide as `max`, down to `min` when the row is full. */
  min: number;
  max: number;
}
const FINE: Metrics = { hub: 24, r0: 30, r1: 100, gap: 4, depth: 54, min: 46, max: 58 };
/** Fingers (and a headset's ray): bigger cells. */
const COARSE: Metrics = { hub: 26, r0: 32, r1: 108, gap: 4, depth: 58, min: 52, max: 64 };
/** The drawings are this far (px) each way from the middle at most. */
const BOX = 440;
const SVG = "http://www.w3.org/2000/svg";
const TAU = Math.PI * 2;
/** Where the wheel is kept, per kind of screen (as the tool card's place is). */
const SPOTS = "sg-wheel-spot";
/** The top sector: what's picked (its own tools), and the view's. */
const OWN = "own";
/**
 * Where a picked thing's tool goes when it isn't named like one of the main
 * tools (those go where the main tool is). Anything not known: the top sector.
 */
const GROUP_OF: Record<string, string> = {
  text: "sketch", offset: "sketch", projs: "sketch",
  editFreeform: "freeform", fillHole: "freeform", thicken: "freeform",
  planePerp: "construct", planeEdge: "construct",
  moveBody: "transform", moveVertex: "transform", patl: "transform", patc: "transform", copySketch: "transform", align: "transform",
  offsetFromEdge: "modify",
  drawing: "more", material: "more",
  deselect: OWN, wholePattern: OWN, color: OWN, opacity: OWN, delete: OWN, deleteBody: OWN,
};

/**
 * Each group's tools, most used first: the first goes straight on from the
 * way the group was opened, the next either side of it, and on round (ORDER) -
 * the most used is always the shortest move. (Tools not named here come after,
 * as they are listed.)
 */
const RANK = [
  "extrude", "revolve", "sweep", "loft",
  "fillet", "chamfer", "shell", "offsetFace", "fix", "offsetEdge", "thread", "wrap",
  "subtract", "union", "intersect", "split",
  "move", "mirror", "pattern", "scale", "translate", "rotate",
  "plane", "axis", "proje",
  "ff-box", "ff-cylinder", "ff-sphere", "ff-plane", "faceFreeform", "connect",
  "measure", "section", "variables", "insert", "bim",
];
const rankOf = (id: string) => {
  const k = RANK.indexOf(id);
  return k < 0 ? RANK.length : k;
};
/** Where a ring's tools go, most used first: eighths of a turn from the way in - straight on, then either side, on round. */
const ORDER = [0, 1, -1, 2, -2, 3, -3, 4];
/** The model's first ring, clockwise from the top: eight places, each always the same. */
const MODEL_RING = ["create", "combine", "modify", "construct", "transform", "freeform", "sketch", OWN];

/**
 * The sketch's wheel: the tools by what they are for, each list most used
 * first, and the rest - the line type, Normal to Sketch, a tool not named
 * here - under More; Exit, Delete and Select a tap each. SKETCH_RING says
 * where each is, clockwise from the top.
 */
const SKETCH: ({ tool: string; label?: string } | { id: string; label: string; icon: IconName; tools: string[] })[] = [
  { tool: "exit", label: "Exit" },
  { id: "draw", label: "Draw", icon: "line", tools: ["line", "rect", "circle", "arc", "spline", "polygon", "ellipse", "text"] },
  { id: "modify", label: "Modify", icon: "trim", tools: ["trim", "fillet", "offset", "extend", "project", "split", "align"] },
  { id: "transform", label: "Transform", icon: "transform", tools: ["move", "mirror", "rotate", "pattern", "scale"] },
  { id: "more", label: "More", icon: "more", tools: [] },
  { tool: "delete" },
  { tool: "select" },
];
/** Drawing at the top, Modify and Transform straight across, Exit at the bottom ("": an empty place). */
const SKETCH_RING = ["draw", "delete", "modify", "", "exit", "more", "transform", "select"];

interface Cell {
  item: ToolItem;
  /** A new part of the list starts here. */
  gap?: boolean;
}
interface Sector {
  id: string;
  label: string;
  icon: IconName;
  cells: Cell[];
  /** A place on the ring that is a tool itself (Sketch with nothing picked; Exit, Select, Delete in a sketch): a tap runs it. */
  item?: ToolItem;
  /** That tool is the one in use. */
  on?: boolean;
  /** Nothing in it now: why. */
  why?: string;
  /** The tool most likely next (or the one in use, or one that is on) is in it. */
  mark: boolean;
  /** An empty place (the others keep the places they always have). */
  blank?: boolean;
  /** A colour as its picture, in place of an icon. */
  swatch?: string;
}
/** A ring opened on the way to the one up now: where its middle was, and what of it was opened (`at`: its place, -1 one of its outer band). */
interface Level {
  sectors: Sector[];
  fan: Placed[];
  cx: number;
  cy: number;
  at: number;
  id: string;
  dir: number;
}
interface Placed extends Cell {
  r0: number;
  r1: number;
  a0: number;
  a1: number;
  /** 0: the group's own tools; 1, 2: the kinds of a tool opened further out (the cascade). */
  level: number;
}

// What the pointer is over, as a number (compared on every move): nothing, the middle, a group, a tool.
const NONE = -1;
const HUB = 0;
const SECTOR = 1;
const CELL = 100;

const notSep = (it: ToolItem) => !it.id.startsWith("---");
const kidsOf = (it: ToolItem) => usable(it.children ?? []).filter(notSep);
/** A tap opens its kinds - not one that starts with the kind used last and shows them once it's the tool in use. */
const opens = (it: ToolItem) => kidsOf(it).length > 0 && !(it.variantsWhenActive && !it.active && !!it.run);
const marked = (cells: Cell[]) => cells.some((c) => !!c.item.active || !!c.item.pulse);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Everything a ring shows, as text: the same again needs no drawing again. */
function signature(sectors: Sector[]): string {
  const tool = (it: ToolItem): unknown[] => [it.id, it.label, it.icon, it.sub, !!it.active, !!it.pulse, it.swatch, it.shortcut, kidsOf(it).map(tool)];
  return JSON.stringify(sectors.map((s) => [s.id, s.label, s.icon, !!s.on, s.mark, s.why, s.item && tool(s.item), s.cells.map((c) => [!!c.gap, tool(c.item)])]));
}

/** What a ring shows, its outer band too. */
const sigOf = (sectors: Sector[], fan: Placed[]) => signature(sectors) + JSON.stringify(fan.map((c) => [c.item.id, c.item.label, c.item.sub, !!c.item.active]));

/** An empty place on a ring. */
const blank = (): Sector => ({ id: "", label: "", icon: "more", cells: [], mark: false, blank: true });

/** A ring's sectors in their fixed places (ids clockwise from the top, "" empty); one not named takes an empty place. */
function compassOf(order: string[], sectors: Sector[]): Sector[] {
  const out = order.map((id) => (id && sectors.find((s) => s.id === id)) || blank());
  for (const s of sectors) {
    if (order.includes(s.id)) continue;
    const k = out.findIndex((x) => x.blank);
    if (k >= 0) out[k] = s;
    else out.push(s);
  }
  return out;
}

/** A piece of a ring, from r0 to r1 and a0 to a1 (clockwise, 0 to the right), a gap of `gap` px kept round it. */
function wedge(r0: number, r1: number, a0: number, a1: number, gap = 2): string {
  const p = (r: number, a: number) => `${(r * Math.cos(a)).toFixed(2)} ${(r * Math.sin(a)).toFixed(2)}`;
  const i0 = a0 + gap / 2 / r0;
  const i1 = a1 - gap / 2 / r0;
  const o0 = a0 + gap / 2 / r1;
  const o1 = a1 - gap / 2 / r1;
  const big = (a: number, b: number) => (b - a > Math.PI ? 1 : 0);
  return `M${p(r0, i0)}L${p(r1, o0)}A${r1} ${r1} 0 ${big(o0, o1)} 1 ${p(r1, o1)}L${p(r0, i1)}A${r0} ${r0} 0 ${big(i0, i1)} 0 ${p(r0, i0)}Z`;
}

function svgBox(): SVGSVGElement {
  const s = document.createElementNS(SVG, "svg");
  s.setAttribute("class", "wheel-svg");
  s.setAttribute("viewBox", `${-BOX} ${-BOX} ${2 * BOX} ${2 * BOX}`);
  s.setAttribute("width", String(2 * BOX));
  s.setAttribute("height", String(2 * BOX));
  s.style.left = s.style.top = `${-BOX}px`;
  return s;
}

function path(cls: string, d: string): SVGPathElement {
  const p = document.createElementNS(SVG, "path");
  p.setAttribute("class", cls);
  p.setAttribute("d", d);
  return p;
}

const calm = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export class Wheel implements WheelHandle {
  private readonly root = el("div", "");
  private readonly body = el("div", "wheel-body");
  private readonly ringBox = el("div", "wheel-ring");
  private readonly fanBox = el("div", "wheel-fan");
  private readonly hubBox = el("div", "wheel-mid");
  private readonly ringSvg = svgBox();
  private readonly fanSvg = svgBox();
  private readonly hubSvg = svgBox();
  private readonly ringItems = el("div", "wheel-items");
  private readonly fanItems = el("div", "wheel-items");
  private readonly tip = el("div", "wheel-tip");
  private readonly hubEl = document.createElementNS(SVG, "circle");
  /** The mark on the middle: the handle's, or a cog beside a tool (it is the Settings there). */
  private readonly grip = el("div", "wheel-item wheel-grip");
  private ringEls: SVGElement[] = [];
  private fanEls: SVGElement[] = [];

  private m = FINE;
  /** Whose column it stands in for now (null: no one's - the column shows). */
  private layout: WheelLayout | null = null;
  private extras: WheelExtras | null = null;
  private sectors: Sector[] = [];
  /** What the ring was last drawn from. */
  private sig = "";
  /** What's picked, as the top sector names it ("" nothing): a wheel up at the pointer goes when that changes under it. */
  private pick = "";
  /** The ring's outer band: its tools past eight. */
  private fan: Placed[] = [];
  /** The rings opened on the way to this one (the first ring first). */
  private stack: Level[] = [];
  /** The way into this ring (from the middle of the one before): its most used tool is straight on. */
  private dir = -Math.PI / 2;
  private hot = NONE;
  private up = false;
  private dismissed = false;

  /** Where it is kept, by layout: the middle as fractions of the page's width and height. */
  private spots: Partial<Record<WheelLayout, [number, number]>> = {};
  /** Kept, and folded to just its middle (until the page is loaded again). */
  private folded: Record<WheelLayout, boolean> = { model: false, sketch: screenClass() === "phone", freeform: screenClass() === "phone", settings: true, options: true };
  /** Where it belongs (px): where it was put, or where it came up. */
  private home = { x: 0, y: 0 };
  /** The middle, on the page (off its home while a fan needs the room). */
  private cx = 0;
  private cy = 0;
  /** Where the pointer is, and where it was when the wheel came up. */
  private px = 0;
  private py = 0;
  private from = { x: 0, y: 0 };
  /** Not moved since it came up: what's under the pointer doesn't count yet. */
  private still = false;
  /** The wheel slid under a pointer that stayed put: nothing changes until it moves from here. */
  private hold: { x: number; y: number } | null = null;
  private type: "mouse" | "pen" | "touch" = "mouse";
  /** The pointer pressed on the wheel (it may slide to a tool and let go there). */
  private pressed: number | null = null;
  /** Pressed on the middle: the wheel goes with it once it moves. */
  private grab: { dx: number; dy: number; moved: boolean } | null = null;
  private hubTapAt = -Infinity;
  /** Opened under a finger still down: its next move makes it the pressed one. */
  private adopt = false;
  private adopted = false;
  /** What the press came down on, and where: a tap acts on that, wherever the wheel has slid to since. */
  private pressHit = NONE;
  private pressAt = { x: 0, y: 0 };
  /** Counts the rings shown: a press on one that has since been replaced is let go of.  */
  private fanCount = 0;
  private pressFan = 0;
  /**
   * Just up at the pointer: the second tap of a double tap (the whole body)
   * still goes to the model - through the middle, or through all of it when
   * it had to open off the pointer (which is then on one of its pieces).
   */
  private fresh: "" | "hub" | "all" = "";
  private freshTimer = 0;
  private tipTimer = 0;
  private refreshing = false;

  /**
   * The tool wheel ("tools": what a tool asks for with `cover`), or the
   * Settings wheel ("settings"): always on the screen while the wheel is on,
   * folded to its cog unless opened.
   */
  constructor(
    private host: WheelHost,
    private readonly kind: "tools" | "settings" | "options" = "tools",
  ) {
    this.root.id = kind === "tools" ? "wheel" : `wheel-${kind}`;
    this.root.classList.add("wheel-root");
    if (kind !== "tools") this.layout = kind;
    this.root.hidden = true;
    this.tip.hidden = true;
    this.hubEl.setAttribute("class", "wheel-hub");
    this.hubSvg.append(this.hubEl);
    this.hubBox.append(this.hubSvg, this.grip);
    this.fanBox.append(this.fanSvg, this.fanItems);
    this.ringBox.append(this.ringSvg, this.ringItems);
    this.body.append(this.fanBox, this.ringBox, this.hubBox);
    this.root.append(this.body, this.tip);
    document.body.append(this.root);
    document.addEventListener("pointerdown", this.onDown, true);
    document.addEventListener("pointermove", this.onMove, true);
    document.addEventListener("pointerup", this.onUp, true);
    document.addEventListener("pointercancel", this.onCancel, true);
    // A finger on the wheel is never the page scrolling or zooming: else a phone's browser
    // takes it over after a few millimetres and the drag stops (pointercancel).
    document.addEventListener("touchmove", (e) => this.pressed !== null && e.cancelable && e.preventDefault(), { capture: true, passive: false });
    window.addEventListener("keydown", this.onKey, true);
    // Scrolling zooms the view: the wheel is out of its way (kept somewhere, its fan is).
    window.addEventListener("wheel", () => this.away(), { capture: true, passive: true });
    window.addEventListener("blur", () => this.away());
    window.addEventListener("resize", () => {
      // (Typing a value: on a phone the keyboard coming up is a resize - the wheel stays as it is.)
      if (!this.up || this.typer) return;
      if (!this.kept) return this.hide();
      // (A fan laid out for the old screen may not fit the new one: it is put away, opened again where it fits.)
      this.shut();
      this.home = this.homeNow();
      this.rest();
    });
    this.root.addEventListener("contextmenu", (e) => e.preventDefault());
    if (kind === "tools") host.ui.onTools = () => this.itemsChanged();
    // (The tool's window opened, closed or changed: the Options wheel comes, goes, or shows what it holds now.)
    if (kind === "tools") host.ui.onPanel = () => this.layout === "freeform" && this.itemsChanged();
    if (kind === "options") {
      const before = host.ui.onPanel;
      host.ui.onPanel = () => (before?.(), this.sync(), this.itemsChanged());
    }
    // (A setting changed: the mode itself, or what Settings shows - the unit, the numpad on or off.)
    settings.onChange(() => (this.sync(), this.itemsChanged()));
    if (kind !== "tools") {
      this.loadSpots();
      // (Once the app is set up: its lists are the right column's, made after the wheels.)
      setTimeout(() => this.sync());
    } else this.sync();
  }

  get on(): boolean {
    return settings.value.wheel;
  }

  get isOpen(): boolean {
    return this.up;
  }

  get kept(): boolean {
    return this.layout === "sketch" || this.layout === "freeform" || this.layout === "settings" || this.layout === "options" || (this.layout === "model" && !!this.spots.model);
  }

  private get isFolded(): boolean {
    return !!this.layout && this.kept && this.folded[this.layout];
  }

  cover(layout: "model" | "sketch" | "freeform" | false, extras?: WheelExtras): void {
    if (this.kind !== "tools") return;
    const next = layout || null;
    toolsLayout = next;
    if (extras) this.extras = extras;
    // (The sketch says so each time it sets its tools: the same again is nothing new.)
    if (next === this.layout) return;
    this.hide();
    this.layout = next;
    if (!extras) this.extras = null;
    this.loadSpots();
    this.sync();
  }

  /** The column steps aside while the wheel stands in for it; a kept wheel is up whenever there is something for it to show. */
  private sync(): void {
    if (this.kind === "tools") {
      // (On at all: the right column keeps only Fit, Screenshot and History - the rest is on the Settings wheel.)
      document.body.classList.toggle("wheel-ui", this.on);
      // (While another tool is open it stands in for nothing: the tool's own column and bar stay.)
      document.body.classList.toggle("wheel-covers", this.on && (this.layout === "model" || this.layout === "sketch" || this.layout === "freeform"));
    }
    if (this.kind === "options") {
      // Up only while the open tool has a window with something to set; the window itself then stays out of sight.
      // (Not while the window holds a text box to type into - a sketch's Text: the window shows, with all of it.)
      const typing = !!document.querySelector("#panel .text-input");
      const has = this.on && this.host.ui.panelOpen && !typing && this.content().sectors.length > 0;
      document.body.classList.toggle("wheel-options", has);
      if (!has) return this.hide();
    }
    if (!this.on || !this.layout) return this.hide();
    if (this.kept && !this.up) this.showKept();
  }

  takeDismissed(): boolean {
    const d = this.dismissed;
    this.dismissed = false;
    return d;
  }

  // ------------------------------------------------------------------ places

  private loadSpots(): void {
    try {
      this.spots = JSON.parse(localStorage.getItem(SPOTS) ?? "{}")?.[screenClass()] ?? {};
    } catch {
      this.spots = {};
    }
  }

  private saveSpots(): void {
    try {
      const all = JSON.parse(localStorage.getItem(SPOTS) ?? "{}") ?? {};
      // (Both wheels keep their places here: each writes only its own.)
      const mine: WheelLayout[] = this.kind === "tools" ? ["model", "sketch", "freeform"] : [this.kind];
      const spots = { ...(all[screenClass()] ?? {}) };
      for (const k of mine) {
        if (this.spots[k]) spots[k] = this.spots[k];
        else delete spots[k];
      }
      all[screenClass()] = spots;
      localStorage.setItem(SPOTS, JSON.stringify(all));
    } catch {
      // private window: not remembered
    }
  }

  /** Where a kept wheel belongs on the page as it is now. */
  private homeNow(): { x: number; y: number } {
    if (this.layout === "settings" || this.layout === "options") {
      const s = this.spots[this.layout];
      if (s) return { x: s[0] * innerWidth, y: s[1] * innerHeight };
      // Never put anywhere: at the bottom right, beside the right-hand column (folded, just its icon) -
      // the Options above the Settings.
      const col = document.getElementById("right-col")?.getBoundingClientRect();
      const right = col && col.width > 0 ? col.left : innerWidth;
      // (Placed by the folded size: the two icons keep their places; unfolded, a wheel comes in from the edges as far as it must.)
      const r = this.m.r0;
      const step = this.layout === "options" ? 2 * r + 16 : 0;
      // (A phone: no tool strip along the bottom any more - down on the row of undo/redo, level
      // with its bottom; upright, where there's no room above the guide text, side by side.)
      const undo = document.getElementById("undo-dock")?.getBoundingClientRect();
      if (document.documentElement.dataset.screen === "phone" && undo && undo.height > 0) {
        const upright = innerHeight > innerWidth;
        return { x: right - 8 - r - (upright ? step : 0), y: undo.bottom - r - (upright ? 0 : step) };
      }
      return { x: right - 8 - r, y: innerHeight - 70 - step - r };
    }
    // (The sketch's wheel never moved: where the model's is kept, if it is.)
    const s = (this.layout && this.spots[this.layout]) ?? this.spots.model;
    if (s) return { x: s[0] * innerWidth, y: s[1] * innerHeight };
    // Never put anywhere: where the tool column is - at the left, beside Items when that is open
    // (folded, its middle is at the edge; unfolded, the ring is clear of it).
    const items = document.getElementById("items");
    const left = items?.classList.contains("open") && innerWidth > 720 ? items.getBoundingClientRect().right : 0;
    return { x: left + 8 + (this.isFolded ? this.m.r0 : this.m.r1), y: innerHeight / 2 };
  }

  /** A kept wheel at its home, as near it as keeps it whole on the screen (folded: just its middle). */
  private rest(): void {
    const M = 6;
    const r = this.isFolded ? this.m.r0 : this.m.r1;
    this.cx = clamp(this.home.x, r + M, Math.max(r + M, innerWidth - r - M));
    this.cy = clamp(this.home.y, r + M, Math.max(r + M, innerHeight - r - M));
    this.place();
  }

  private place(): void {
    this.root.style.transform = `translate(${Math.round(this.cx)}px, ${Math.round(this.cy)}px)`;
  }

  /** Folded to just the middle (the handle), or whole again. */
  private fold(on: boolean): void {
    if (!this.layout) return;
    this.folded[this.layout] = on;
    this.root.classList.toggle("folded", on);
    if (on) this.shut();
    if (!on && this.layout === "settings") {
      // (Unfolded: the lists as they are now - the settings may have changed from elsewhere since.)
      this.stack = [];
      this.fan = [];
      this.sectors = this.content().sectors;
      this.sig = sigOf(this.sectors, []);
      this.redraw();
    }
    this.unpoint();
    this.root.classList.add("slide");
    this.home = this.homeNow();
    this.rest();
  }

  /** Let go where it was dragged to: it is kept there from now on. */
  private drop(): void {
    const layout = this.layout;
    if (!layout) return;
    const was = this.kept;
    this.home = { x: this.cx, y: this.cy };
    this.spots[layout] = [this.cx / innerWidth, this.cy / innerHeight];
    this.saveSpots();
    if (was) return;
    // Up at the pointer until now: from here on it stays where it was put.
    this.settle();
    this.still = false;
    this.root.classList.add("kept");
    this.host.ui.toast("The wheel stays here now. Tap its middle to fold it away - twice, and it comes up at the pointer again.");
  }

  /** The model's wheel no longer kept anywhere: it comes up at the pointer again. */
  private letGo(): void {
    delete this.spots.model;
    this.saveSpots();
    this.folded.model = false;
    this.hide();
    this.host.ui.toast("The wheel comes up at the pointer again: tap the model, or an empty spot.");
  }

  // ---------------------------------------------------------------- content

  private content(): { sectors: Sector[]; pick: string } {
    return this.layout === "sketch" ? this.sketchContent() : this.layout === "freeform" ? this.freeformContent() : this.layout === "settings" ? this.settingsContent() : this.layout === "options" ? this.optionsContent() : this.modelContent();
  }

  /**
   * The Settings wheel: Snap to, Units, Appearance, Shaders - each fanning out
   * its switches and choices, set with a tap right there (what only a slider or
   * a typed value can set is under More…, in the list's window) - NumPad and Snapshot.
   */
  private settingsContent(): { sectors: Sector[]; pick: string } {
    const ui = this.host.ui;
    const lists: [string, string, IconName][] = [
      ["snap", "Snap to", "magnet"],
      ["units", "Units", "ruler"],
      ["appearance", "Appearance", "eye"],
      ["display", "Shaders", "display"],
    ];
    const sectors = lists.map(([id, label, icon]): Sector => ({
      id,
      label,
      icon,
      cells: ui.optionItems(id, () => this.openList(id, label)),
      mark: false,
    }));
    const pad = settings.value.numpad;
    const numpad: ToolItem = { id: "set-numpad", label: "NumPad", icon: "numpad", sub: pad ? "On" : "Off", active: pad, run: () => ui.popAt("numpad", 0, 0) };
    sectors.push({ id: "numpad", label: "NumPad", icon: "numpad", cells: [], item: numpad, on: pad, mark: false });
    const shot: ToolItem = { id: "set-shot", label: "Snapshot", icon: "camera", run: () => ui.popAt("shot", 0, 0) };
    sectors.push({ id: "shot", label: "Snapshot", icon: "camera", cells: [], item: shot, mark: false });
    return { sectors, pick: "" };
  }

  /**
   * The Options wheel: what the open tool's window holds. Each choice fans out
   * its options, a switch or a slot is one tap, chips fan out; numbers and
   * sliders are typed in the window, which Values brings back. Then the
   * window's own actions (under More), Cancel and Done.
   */
  private optionsContent(): { sectors: Sector[]; pick: string } {
    const ui = this.host.ui;
    const p = ui.panelContent();
    if (!p) return { sectors: [], pick: "" };
    let k = 0;
    // ("opt-": set right there, the wheel stays open showing it.)
    const opt = (label: string, run: () => void, on?: boolean, sub?: string, icon?: IconName): ToolItem => ({ id: `opt-panel-${k++}`, label, icon: icon ?? iconNameFor(label) ?? (on ? "check" : "options"), sub, active: on, run });
    const sectors: Sector[] = [];
    // (A freeform shape: its wheel has the rest - here only the values to set.)
    const ff = toolsLayout === "freeform";
    const more: Cell[] = ff ? [] : p.actions.filter((a) => !a.disabled).map((item) => ({ item }));
    const valueCells: Cell[] = [];
    for (const it of p.items) {
      if (ff && it.type !== "number" && it.type !== "slider") continue;
      if (it.type === "choice") {
        const now = it.options.find((o) => o.id === it.value);
        const cells = it.options.map((o): Cell => ({ item: opt(o.label, () => it.onChange(o.id), o.id === it.value) }));
        sectors.push({ id: `choice-${k}`, label: it.label ?? now?.label ?? "Kind", icon: "more", cells, mark: false });
      } else if (it.type === "toggle") {
        const item = opt(it.label, () => it.onChange(!it.value), it.value, it.value ? "On" : "Off", iconNameFor(it.label) ?? (it.value ? "check" : "close"));
        sectors.push({ id: item.id, label: it.label, icon: item.icon, cells: [], item, on: it.value, mark: false });
      } else if (it.type === "slot") {
        const item = opt(it.label, it.onClick, it.active, it.value, iconNameFor(it.label) ?? (it.filled ? "check" : "point"));
        sectors.push({ id: item.id, label: it.label, icon: item.icon, cells: [], item, on: it.active, mark: false });
      } else if (it.type === "chips") {
        if (!it.chips.length) continue;
        const cells = it.chips.map((c): Cell => ({ item: opt(c.glyph ? `${c.glyph} ${c.label}` : c.label, c.onClick, !!c.on, undefined, "constraints") }));
        sectors.push({ id: `chips-${k++}`, label: it.label ?? "Add", icon: "constraints", cells, mark: false });
      } else if (it.type === "button") {
        // A tap each, on the ring (where to sketch: XY, XZ, YZ…); past the room there, under More.
        const item: ToolItem = { id: `panel-btn-${k++}`, label: it.label, icon: it.icon ?? iconNameFor(it.label) ?? "tools", run: it.onClick };
        sectors.push({ id: item.id, label: it.label, icon: item.icon, cells: [], item, mark: !!it.primary });
      } else if (it.type === "number" || it.type === "slider") {
        // A value: a tap and its box is up to type it in (the numpad with it,
        // where that's on) - the value itself as its second line.
        const len = it.type === "number" && (it.kind ?? "length") === "length";
        const show = it.type === "slider" ? (it.show?.(it.value) ?? String(it.value)) : len ? `${+(toDisplay(it.value)).toFixed(3)} ${UNIT_LABEL[units()]}` : String(+it.value.toFixed(3));
        const put = (to: number) => {
          let v = to;
          if (it.type === "slider") v = Math.min(it.max, Math.max(it.min, v));
          else if (it.min !== undefined) v = Math.max(it.min, v);
          if (it.type === "number" && it.kind === "int") v = Math.round(v);
          it.onInput(v);
          // (A tool that does not draw its window again keeps this item: it holds the new value from now on.)
          it.value = v;
          ui.syncPanelValue(it, v);
        };
        const kind = it.type === "slider" || it.kind === "int" || it.kind === "number" ? "number" : it.kind === "angle" ? "angle" : "length";
        const now = it.type === "number" && kind === "length" ? String(+toDisplay(it.value).toFixed(4)) : String(+it.value.toFixed(4));
        valueCells.push({ item: opt(it.label, () => this.typeValue(it.label, now, kind, put), false, show, "numpad") });
      }
    }
    // Room on the ring: past six of its own, the rest of the window's switches and buttons go under More.
    while (sectors.length > 6) {
      const s = sectors.pop()!;
      more.unshift(...(s.item ? [{ item: s.item }] : s.cells));
    }
    if (more.length) sectors.push({ id: "more", label: "More", icon: "more", cells: more, mark: false });
    // Only values to set (a new shape's size): each its own place on the ring, a tap to type it -
    // not one lone Values group on a whole ring.
    if (!sectors.length && valueCells.length <= 8) for (const c of valueCells) sectors.push({ id: c.item.id, label: c.item.label, icon: c.item.icon, cells: [], item: c.item, mark: false });
    // (One value: Values is it - a tap and its box is up.)
    else if (valueCells.length === 1) sectors.push({ id: "values", label: valueCells[0].item.label, icon: "numpad", cells: [], item: valueCells[0].item, mark: false });
    else if (valueCells.length) sectors.push({ id: "values", label: "Values", icon: "numpad", cells: valueCells, mark: false });
    if (p.cancel && !ff) sectors.push({ id: "cancel", label: "Cancel", icon: "close", cells: [], item: { id: "cancel", label: "Cancel", icon: "close", shortcut: "Esc", run: p.cancel }, mark: false });
    if (p.done && !ff) sectors.push({ id: "done", label: "Done", icon: "check", cells: [], item: { id: "done", label: "Done", icon: "check", shortcut: "Enter", run: p.done }, mark: false });
    // (Only Done or Cancel: nothing to set - no wheel; the tool's own ways to finish stay.)
    return { sectors: sectors.some((s) => s.id !== "done" && s.id !== "cancel") ? sectors : [], pick: "" };
  }

  /** The box a value is being typed into, on the wheel. */
  private typer: HTMLElement | null = null;
  /** Ends that box: true sets what is typed, false leaves the value as it was. */
  private typerEnd: ((keep: boolean) => void) | null = null;

  /**
   * Type a value right on the wheel: a small box by the pointer, the value
   * in it selected. Enter (or tapping away) sets it, Esc leaves it as it was.
   */
  private typeValue(label: string, now: string, kind: "length" | "angle" | "number", put: (v: number) => void): void {
    this.typerEnd?.(false);
    const box = el("div", "wheel-type");
    box.append(el("span", "wheel-type-label", label));
    const input = document.createElement("input");
    input.type = "text";
    input.inputMode = "decimal";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.value = now;
    input.dataset.kind = kind === "number" ? "number" : kind;
    numpadInput(input);
    box.append(input);
    const unit = kind === "length" ? UNIT_LABEL[units()] : kind === "angle" ? "°" : "";
    if (unit) box.append(el("span", "wheel-type-unit", unit));
    box.style.left = `${Math.round(this.px - this.cx)}px`;
    box.style.top = `${Math.round(this.py - this.cy)}px`;
    this.root.append(box);
    this.typer = box;
    let over = false;
    const done = (keep: boolean) => {
      if (over) return;
      over = true;
      if (keep) {
        const v = evaluate(input.value, kind);
        if (v !== null) put(v);
      }
      box.remove();
      if (this.typer === box) (this.typer = null), (this.typerEnd = null);
      this.itemsChanged();
    };
    this.typerEnd = done;
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        done(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        done(false);
      }
      e.stopPropagation();
    });
    input.addEventListener("blur", () => setTimeout(() => document.activeElement !== input && done(true), 150));
    // Kept on the screen.
    const r = box.getBoundingClientRect();
    if (r.right > innerWidth - 6) box.style.left = `${Math.round(this.px - this.cx - (r.right - innerWidth + 6))}px`;
    if (r.bottom > innerHeight - 6) box.style.top = `${Math.round(this.py - this.cy - (r.bottom - innerHeight + 6))}px`;
    input.focus();
    selectAll(input);
    openNumpad(input);
  }

  /** A list's window (for what the wheel can't set: a slider, a typed size), beside the wheel on the side the pointer is. */
  private openList(id: string, label: string): void {
    const out = Math.hypot(this.px - this.cx, this.py - this.cy) + 34;
    this.host.ui.popAt(id, this.px >= this.cx ? this.cx + out : this.cx - out - 270, this.py - 28, label);
  }

  /**
   * The model's ring: the main groups, each always in its place (MODEL_RING),
   * and More - what's picked offers of its own, the view's tools, Insert and
   * BIM. Each group's tools most used first (RANK).
   */
  private modelContent(): { sectors: Sector[]; pick: string } {
    const { column, bar } = this.host.ui.shown();
    const main = this.host.mainTools();
    const shown = usable(column).filter(notSep);
    // (Move's kinds - Move/Rotate, Translate, Rotate Around Axis - are Transform's own tools: no ring more to reach them.)
    const flat = (items: ToolItem[]) => items.flatMap((it) => (it.id === "moveKinds" ? kidsOf(it) : [it]));
    const ranked = (cells: Cell[]) =>
      cells
        .map((c, k) => ({ c, k }))
        .sort((x, y) => rankOf(x.c.item.id) - rankOf(y.c.item.id) || x.k - y.k)
        .map(({ c }) => c);
    let groups: Sector[];
    let own: Cell[] = [];
    if (shown.length > 0 && shown.every((it) => main.some((g) => g.id === it.id))) {
      // Nothing picked: the column is the main tools themselves.
      groups = shown.map((g) => {
        const cells = ranked(flat(kidsOf(g)).map((item) => ({ item })));
        return { id: g.id, label: g.label, icon: g.icon, cells, item: g.children?.length ? undefined : g, mark: !!g.pulse || marked(cells) };
      });
    } else {
      // Something picked: its tools, each in the group the main tool of that name is in.
      const where = new Map<string, string>();
      const walk = (items: ToolItem[], g: string) => {
        for (const it of items) {
          if (!where.has(it.id)) where.set(it.id, g);
          walk(it.children ?? [], g);
        }
      };
      for (const g of main) walk([g], g.id);
      const groupOf = (id: string) => GROUP_OF[id] ?? where.get(id) ?? OWN;
      const lists = new Map<string, Cell[]>(main.map((g) => [g.id, []]));
      for (const it of flat(shown)) (lists.get(groupOf(it.id)) ?? own).push({ item: it });
      // A group with nothing for this pick says why: its tools that are off, with their reasons.
      const off = new Map<string, string[]>();
      for (const it of column) if (it.disabled && it.why && it.label) off.set(groupOf(it.id), [...(off.get(groupOf(it.id)) ?? []), `${it.label}: ${it.why}`]);
      const what = shown.find((it) => it.id === "deselect")?.sub;
      groups = main.map((g) => {
        const cells = ranked(lists.get(g.id)!);
        const why = cells.length ? undefined : off.get(g.id)?.slice(0, 3).join(" · ") ?? `${g.label} has nothing for ${what ?? "this"}`;
        return { id: g.id, label: g.label, icon: g.icon, cells, why, mark: marked(cells) };
      });
    }
    const pick = shown.find((it) => it.id === "deselect")?.sub ?? "";
    own = [...own, ...(this.extras?.() ?? []).map((item) => ({ item }))];
    const view = ranked(usable(bar).filter(notSep).map((item): Cell => ({ item }))).map((c, i): Cell => ({ ...c, gap: i === 0 && own.length > 0 }));
    // The More group's own (Insert, BIM) join it: eight places on the ring.
    const more = groups.find((g) => g.id === "more");
    groups = groups.filter((g) => g !== more);
    const rest = (more?.cells ?? []).map((c, i): Cell => ({ ...c, gap: i === 0 }));
    const top: Sector = { id: OWN, label: pick || "More", icon: pick ? "pointer" : "more", cells: [...own, ...view, ...rest], mark: marked(view) };
    return { sectors: compassOf(MODEL_RING, [top, ...groups]), pick };
  }

  /**
   * A freeform shape's wheel: what its card offers, by what it does, each
   * group in the same place every time (greyed, saying why, while nothing
   * picked fits it) - Done at the top, Select all and Cancel a tap each. The
   * values to type stay on the Options wheel.
   */
  private freeformContent(): { sectors: Sector[]; pick: string } {
    const p = this.host.ui.panelContent();
    if (!p) return { sectors: [], pick: "" };
    let k = 0;
    // ("opt-": set right there, the fan stays showing it; a button that changes the shape closes it.)
    const opt = (label: string, run: () => void, on?: boolean, sub?: string, icon?: IconName): ToolItem => ({ id: `opt-ff-${k++}`, label, icon: icon ?? iconNameFor(label) ?? (on ? "check" : "options"), sub, active: on, run });
    const act = (label: string, run: () => void, icon?: IconName): ToolItem => ({ id: `ff-${k++}`, label, icon: icon ?? iconNameFor(label) ?? "freeform", run });
    const cells: Record<string, Cell[]> = { shape: [], holes: [], move: [], symmetry: [], solid: [], more: [] };
    const choice = (it: Extract<PanelItem, { type: "choice" }>) => it.options.map((o): Cell => ({ item: opt(o.label, () => it.onChange(o.id), o.id === it.value) }));
    for (const it of p.items) {
      if (it.type === "button") {
        const to = /^(Extrude face|Inset|Extend surface|Add edge loop|Bridge faces)/.test(it.label) ? "shape" : /^(Fill hole|Bridge holes|Connect edges|Delete face)/.test(it.label) ? "holes" : /^Fill to a plane/.test(it.label) ? "solid" : "more";
        cells[to].push({ item: act(it.label, it.onClick, it.icon) });
      } else if (it.type === "choice") {
        const ids = it.options.map((o) => o.id);
        if (ids.includes("move") && ids.includes("turn")) cells.move.push(...choice(it));
        else if (ids.includes("up") && ids.includes("down")) cells.solid.unshift(...choice(it));
        else if (it.label === "Mirror across") cells.symmetry.push(...choice(it));
        else cells.more.push({ item: { id: `ff-kinds-${k++}`, label: it.label ?? "Kind", icon: "more", sub: it.options.find((o) => o.id === it.value)?.label, children: choice(it).map((c) => c.item) } });
      } else if (it.type === "toggle") {
        const to = it.label === "Symmetry" ? "symmetry" : "more";
        cells[to].unshift({ item: opt(it.label, () => it.onChange(!it.value), it.value, it.value ? "On" : "Off", iconNameFor(it.label) ?? (it.value ? "check" : "close")) });
      } else if (it.type === "slot") {
        cells.more.push({ item: opt(it.label, it.onClick, it.active, it.value, iconNameFor(it.label) ?? (it.filled ? "check" : "point")) });
      } else if (it.type === "chips") {
        for (const c of it.chips) cells.more.push({ item: opt(c.label, c.onClick, !!c.on) });
      }
    }
    let selectAll: ToolItem | undefined;
    for (const a of p.actions) {
      if (a.disabled) continue;
      if (a.id === "all") selectAll = a;
      else if (a.id === "refine") cells.shape.push({ item: a });
      else cells.more.push({ item: a });
    }
    const group = (id: string, label: string, icon: IconName, why: string): Sector => ({ id, label, icon, cells: cells[id], why: cells[id].length ? undefined : why, mark: false });
    const sectors: Sector[] = [];
    if (p.done) sectors.push({ id: "done", label: "Done", icon: "check", cells: [], item: { id: "ff-done", label: "Done", icon: "check", shortcut: "Enter", run: p.done }, mark: true });
    sectors.push(
      group("shape", "Shape", "extrude", "Pick faces, edges or points to shape"),
      group("holes", "Holes", "fill", "Pick a hole's rim, two borders, or faces"),
      group("move", "Move", "move", "Pick points, edges or faces to move them"),
      group("symmetry", "Symmetry", "mirror", "Not while the shape is being placed or set up"),
      group("solid", "Solid", "shell", "A closed shape is solid already"),
    );
    if (cells.more.length) sectors.push(group("more", "More", "more", ""));
    if (selectAll) sectors.push({ id: "select", label: "Select all", icon: "selectAll", cells: [], item: selectAll, mark: false });
    if (p.cancel) sectors.push({ id: "cancel", label: "Cancel", icon: "close", cells: [], item: { id: "ff-cancel", label: "Cancel", icon: "close", shortcut: "Esc", run: p.cancel }, mark: false });
    return { sectors, pick: "" };
  }

  /** The sketch's ring: its tools by what they are for (see SKETCH). */
  private sketchContent(): { sectors: Sector[]; pick: string } {
    const { column, bar } = this.host.ui.shown();
    const tools = usable(column).filter(notSep);
    const byId = new Map(tools.map((t) => [t.id, t]));
    const placed = new Set<string>();
    const sectors: Sector[] = [];
    for (const spec of SKETCH) {
      if ("tool" in spec) {
        const it = byId.get(spec.tool);
        if (!it) continue;
        placed.add(it.id);
        sectors.push({ id: it.id, label: spec.label ?? it.label, icon: it.icon, cells: [], item: it, on: !!it.active, mark: !!it.pulse });
        continue;
      }
      const cells = spec.tools.flatMap((id): Cell[] => {
        const it = byId.get(id);
        if (!it) return [];
        placed.add(id);
        return [{ item: it }];
      });
      sectors.push({ id: spec.id, label: spec.label, icon: spec.icon, cells, mark: false });
    }
    // More: what isn't named above (Other plane, a tool added since), then the bottom bar's (the line
    // type, Normal to Sketch) and the constraints column on or off. (Settings are on their own wheel.)
    const more = sectors.find((s) => s.id === "more" && !s.item);
    if (more) {
      const rest = tools.filter((t) => !placed.has(t.id)).map((item): Cell => ({ item }));
      const cons = settings.value.showConstraints;
      const constraints: ToolItem = { id: "set-constraints", label: "Constraints", icon: "constraints", sub: cons ? "On" : "Off", active: cons, run: () => this.host.ui.popAt("constraints", 0, 0) };
      more.cells = [...rest, ...[...usable(bar).filter(notSep), constraints].map((item, i): Cell => ({ item, gap: i === 0 && rest.length > 0 }))];
    }
    for (const s of sectors) if (!s.item) s.mark = marked(s.cells);
    // (A category with nothing in it has no place on the ring.)
    return { sectors: compassOf(SKETCH_RING, sectors.filter((s) => s.item || s.cells.length)), pick: "" };
  }

  /** A tool's kinds, as the cells of its ring. */
  private kindsOf(parent: ToolItem): Cell[] {
    const kids = kidsOf(parent);
    const cells = kids.map((item): Cell => ({ item }));
    // What a tap on it does in the column (the kind used last) comes first, unless one of its kinds is marked as that.
    if (parent.run && !kids.some((k) => k.active)) cells.unshift({ item: { ...parent, children: undefined } });
    return cells;
  }

  /** A tool as a place on a ring: a tap runs it - or, one with kinds of its own, opens them. */
  private sectorOf(it: ToolItem): Sector {
    if (opens(it)) {
      const cells = this.kindsOf(it);
      return { id: it.id, label: it.label, icon: it.icon, swatch: it.swatch, cells, on: !!it.active, mark: marked(cells) };
    }
    return { id: it.id, label: it.label, icon: it.icon, swatch: it.swatch, cells: [], item: it, on: !!it.active, mark: !!it.pulse };
  }

  /**
   * A group's tools (or a tool's kinds) as a ring of their own, come into
   * from `dir`: the most used straight on, the next either side of it, and on
   * round (ORDER). Past eight, the rest in a band round the outside, the same way.
   */
  private ringOf(cells: Cell[], dir: number): { sectors: Sector[]; fan: Placed[] } {
    const n = 8;
    const step = TAU / n;
    const e = Math.round((dir + Math.PI / 2) / step);
    const sectors = Array.from({ length: n }, blank);
    cells.slice(0, n).forEach((c, k) => (sectors[(((e + ORDER[k]) % n) + n) % n] = this.sectorOf(c.item)));
    const rest = cells.slice(n);
    const m = this.m;
    const w = TAU / Math.max(n, rest.length);
    const r0 = m.r1 + m.gap;
    const fan = rest.map((c, k): Placed => {
      const a = dir + (k === 0 ? 0 : k % 2 ? (k + 1) / 2 : -k / 2) * w;
      return { item: c.item, r0, r1: r0 + m.depth, a0: a - w / 2, a1: a + w / 2, level: 0 };
    });
    return { sectors, fan };
  }

  /** Open a group (or a tool's kinds): the ring becomes its tools, in place; the middle is Back. */
  private enter(id: string, cells: Cell[], dir: number, at: number): void {
    this.stack.push({ sectors: this.sectors, fan: this.fan, cx: this.cx, cy: this.cy, at, id, dir: this.dir });
    const ring = this.ringOf(cells, dir);
    this.sectors = ring.sectors;
    this.fan = ring.fan;
    this.dir = dir;
    this.sig = sigOf(this.sectors, this.fan);
    this.levelChanged();
  }

  /** Back to the ring before, where it was. */
  private back(): void {
    const l = this.stack.pop();
    if (!l) return;
    this.sectors = l.sectors;
    this.fan = l.fan;
    this.dir = l.dir;
    this.sig = sigOf(this.sectors, this.fan);
    this.levelChanged();
  }

  /** Back to the first ring, if another is up. */
  private shut(): void {
    if (!this.stack.length) return;
    this.stack.length = 1;
    this.back();
  }

  /** Another ring is up, where the wheel is (moved in only as far as its outer band needs). */
  private levelChanged(grow = true): void {
    this.fanCount++;
    this.unpoint();
    const M = 6;
    const R = this.reach();
    const at = this.kept ? this.home : { x: this.cx, y: this.cy };
    this.cx = clamp(at.x, R + M, Math.max(R + M, innerWidth - R - M));
    this.cy = clamp(at.y, R + M, Math.max(R + M, innerHeight - R - M));
    this.root.classList.remove("slide");
    this.place();
    this.redraw();
    // The pointer stays where it is: what's under it counts once it moves on.
    this.hold = { x: this.px, y: this.py };
    if (grow && this.up && !calm()) this.body.animate([{ opacity: 0.4, transform: "scale(0.86)" }, { opacity: 1, transform: "none" }], { duration: 110, easing: "ease-out" });
  }

  // ------------------------------------------------------------ open / close

  open(x: number, y: number, opts: WheelOpen = {}): void {
    if (!this.on || this.layout !== "model") return;
    // Kept somewhere: it is up already, with what's picked (asked for by name, it unfolds).
    if (this.kept) return void (opts.summon && this.folded.model && this.fold(false));
    this.hide();
    const { sectors, pick } = this.content();
    if (!sectors.some((s) => s.cells.length || s.item)) return;
    this.sectors = sectors;
    this.stack = [];
    this.fan = [];
    this.dir = -Math.PI / 2;
    this.sig = sigOf(sectors, []);
    this.pick = pick;
    this.type = opts.type ?? "mouse";
    this.m = this.type === "touch" || isCoarse ? COARSE : FINE;
    // Round the pointer, whole on the screen.
    const M = 6;
    const ring = this.m.r1;
    this.cx = clamp(x, ring + M, Math.max(ring + M, innerWidth - ring - M));
    this.cy = clamp(y, ring + M, Math.max(ring + M, innerHeight - ring - M));
    this.home = { x: this.cx, y: this.cy };
    this.px = this.from.x = x;
    this.py = this.from.y = y;
    this.still = true;
    this.hold = null;
    this.root.classList.remove("kept", "folded", "slide", "dragging");
    this.draw();
    this.place();
    this.root.hidden = false;
    this.up = true;
    if (!calm()) this.body.animate([{ opacity: 0, transform: "scale(0.82)" }, { opacity: 1, transform: "none" }], { duration: 110, easing: "ease-out" });
    this.adopt = !!opts.held;
    this.adopted = false;
    if (!opts.held) {
      this.fresh = Math.hypot(x - this.cx, y - this.cy) > this.m.hub - 6 ? "all" : "hub";
      this.root.classList.add(this.fresh === "all" ? "fresh-all" : "fresh");
      this.freshTimer = window.setTimeout(() => this.settle(), 350);
    }
  }

  /** A kept wheel comes up at its place, with what there is now. */
  private showKept(): void {
    const { sectors, pick } = this.content();
    this.sectors = sectors;
    this.stack = [];
    this.fan = [];
    this.dir = -Math.PI / 2;
    this.sig = sigOf(sectors, []);
    this.pick = pick;
    this.type = isCoarse ? "touch" : "mouse";
    this.m = isCoarse ? COARSE : FINE;
    this.still = false;
    this.hold = null;
    this.adopt = this.adopted = false;
    this.settle();
    this.root.classList.remove("slide", "dragging");
    this.root.classList.add("kept");
    this.root.classList.toggle("folded", this.isFolded);
    this.draw();
    this.home = this.homeNow();
    this.rest();
    this.root.hidden = false;
    this.up = true;
  }

  toggle(x: number, y: number, opts: WheelOpen = {}): void {
    if (!this.on || !this.layout) return;
    if (this.kept) return this.fold(!this.isFolded);
    if (this.up) this.hide();
    else this.open(x, y, opts);
  }

  /** No longer just up: every piece takes the pointer. */
  private settle(): void {
    clearTimeout(this.freshTimer);
    this.fresh = "";
    this.root.classList.remove("fresh", "fresh-all");
  }

  /** Away: one up at the pointer goes; one kept somewhere stays, its fan put away. */
  close(): void {
    if (this.kept) this.shut();
    else this.hide();
  }

  private away(): void {
    if (this.up) this.close();
  }

  /** Off the screen altogether. */
  private hide(): void {
    if (!this.up) return;
    this.up = false;
    this.root.hidden = true;
    this.clearTimers();
    this.settle();
    this.root.classList.remove("slide", "dragging");
    this.tip.hidden = true;
    this.pressed = null;
    this.grab = null;
    this.adopt = false;
    this.hot = NONE;
    this.stack = [];
    this.fan = [];
  }

  private clearTimers(): void {
    clearTimeout(this.tipTimer);
  }

  /** Nothing pointed at any more (what was is redrawn, or gone). */
  private unpoint(): void {
    this.elOf(this.hot)?.classList.remove("hot");
    this.hot = NONE;
    this.tip.hidden = true;
    this.clearTimers();
  }

  /** The column or the bar was given new tools while the wheel is up: it shows them. */
  private itemsChanged(): void {
    if (!this.up || this.refreshing) return;
    this.refreshing = true;
    queueMicrotask(() => {
      this.refreshing = false;
      if (!this.up) return;
      const { sectors, pick } = this.content();
      // Up at the pointer, and what's picked changed under it (deleted, deselected by a key): it goes.
      if (!this.kept && pick !== this.pick) return this.hide();
      this.pick = pick;
      // The rings opened on the way here, found again among the new tools (as far as they still are).
      const was = this.stack;
      const stack: Level[] = [];
      let ring: { sectors: Sector[]; fan: Placed[] } = { sectors, fan: [] };
      let dir = -Math.PI / 2;
      for (const l of was) {
        const k = ring.sectors.findIndex((s) => s.id === l.id && !s.item && s.cells.length > 0);
        const c = k < 0 ? ring.fan.find((f) => f.item.id === l.id && opens(f.item)) : undefined;
        if (k < 0 && !c) break;
        const cells = c ? this.kindsOf(c.item) : ring.sectors[k].cells;
        const d = c ? (c.a0 + c.a1) / 2 : this.midOf(k, ring.sectors.length);
        stack.push({ ...l, sectors: ring.sectors, fan: ring.fan, at: k, dir });
        ring = this.ringOf(cells, d);
        dir = d;
      }
      const sig = sigOf(ring.sectors, ring.fan);
      const same = sig === this.sig && stack.length === was.length;
      this.stack = stack;
      this.sectors = ring.sectors;
      this.fan = ring.fan;
      this.dir = dir;
      this.sig = sig;
      // (Nothing looks different - the model rebuilt, the same tools made again: only what a tap runs is new.)
      if (same) return;
      // Back as far as there still is something: round where that ring was.
      if (stack.length < was.length) return this.levelChanged(false);
      this.unpoint();
      this.redraw();
    });
  }

  // ----------------------------------------------------------------- drawing

  private midOf(i: number, n = this.sectors.length): number {
    return -Math.PI / 2 + (i * TAU) / n;
  }

  private item(it: { icon: IconName; swatch?: string }, label: string, cls: string, r: number, a: number, width?: number): HTMLElement {
    const d = el("div", `wheel-item ${cls}`);
    if (it.swatch) {
      const sw = el("span", "swatch");
      sw.style.background = it.swatch;
      d.append(sw);
    } else d.innerHTML = icons[it.icon] ?? "";
    // (A long word - Transparency, Perpendicular - a size smaller: it stays in one piece.)
    const name = el("span", `wheel-name${label.split(/[\s/]+/).some((w) => w.length > 10) ? " long" : ""}`, label);
    if (width) name.style.width = `${Math.round(width)}px`;
    d.append(name);
    d.style.left = `${(r * Math.cos(a)).toFixed(1)}px`;
    d.style.top = `${(r * Math.sin(a)).toFixed(1)}px`;
    return d;
  }

  /** The whole wheel anew: the middle, the ring. */
  private draw(): void {
    this.hubEl.setAttribute("r", String(this.m.hub));
    this.hot = NONE;
    this.tip.hidden = true;
    this.redraw();
  }

  private redraw(): void {
    this.drawRing();
    this.drawFan();
    this.drawCrumbs();
  }

  private drawRing(): void {
    const m = this.m;
    const step = TAU / this.sectors.length;
    const inner = this.stack.length > 0;
    // What takes the pointer is a plate under the pieces (the hairlines between them included): a
    // press on a hairline is a press on the wheel, not on the model behind it.
    const plate = document.createElementNS(SVG, "circle");
    plate.setAttribute("class", "wheel-plate");
    plate.setAttribute("r", String((m.r0 + m.r1) / 2));
    plate.setAttribute("stroke-width", String(m.r1 - m.r0 + m.gap));
    this.ringSvg.replaceChildren(plate);
    this.ringItems.replaceChildren();
    this.ringEls = this.sectors.map((s, i) => {
      if (s.blank) return path("wheel-cell", "");
      const mid = this.midOf(i);
      const dim = !s.cells.length && !s.item;
      const own = !inner && (s.id === OWN || (this.layout === "sketch" && s.id === "exit"));
      const p = path(`wheel-cell wheel-sector${dim ? " dim" : ""}${own ? " own" : ""}${s.on ? " on" : ""}`, wedge(m.r0, m.r1, mid - step / 2, mid + step / 2, 3));
      this.ringSvg.append(p);
      this.ringItems.append(this.item(s, inner && !s.item && s.cells.length ? `${s.label} ›` : s.label, `sector${dim ? " dim" : ""}${s.mark ? " mark" : ""}${s.on ? " on" : ""}`, (m.r0 + m.r1) / 2 + 1, mid));
      return p;
    });
    // (What's on is drawn last: its outline whole, over its neighbours'.)
    for (const p of this.ringEls) if (p.classList.contains("on")) this.ringSvg.append(p);
  }

  /** The band round the outside: a ring's tools past eight. */
  private drawFan(): void {
    const m = this.m;
    this.fanSvg.replaceChildren();
    this.fanItems.replaceChildren();
    if (this.fan.length) {
      const c = this.fan[0];
      const plate = document.createElementNS(SVG, "circle");
      plate.setAttribute("class", "wheel-plate");
      plate.setAttribute("r", String((c.r0 + c.r1) / 2));
      plate.setAttribute("stroke-width", String(c.r1 - c.r0 + m.gap));
      this.fanSvg.append(plate);
    }
    this.fanEls = this.fan.map((c) => {
      const it = c.item;
      const p = path(`wheel-cell${it.active ? " on" : ""}`, wedge(c.r0, c.r1, c.a0, c.a1));
      this.fanSvg.append(p);
      const rm = (c.r0 + c.r1) / 2;
      const mid = (c.a0 + c.a1) / 2;
      // The room for its name: the cell's width along the band above and below the wheel, its depth at the sides.
      const up = Math.abs(Math.sin(mid));
      const across = Math.abs(Math.cos(mid));
      const width = (up * (c.a1 - c.a0) * rm + across * (c.r1 - c.r0)) / (up + across) - 4;
      this.fanItems.append(this.item(it, kidsOf(it).length ? `${it.label} ›` : it.label, `${it.active ? "on" : ""}${it.pulse ? " mark" : ""}`, rm, mid, width));
      return p;
    });
    for (const p of this.fanEls) if (p.classList.contains("on")) this.fanSvg.append(p);
  }

  /** The middle: the handle - or, while a group's tools are up, Back. */
  private drawCrumbs(): void {
    const inner = this.stack.length > 0;
    this.root.classList.toggle("inner", inner);
    this.grip.innerHTML = inner ? icons.back : this.layout === "settings" ? icons.settings : this.layout === "options" ? icons.options : icons.move;
  }

  /** How far out the wheel reaches (its outer band too). */
  private reach(): number {
    return this.fan.reduce((r, c) => Math.max(r, c.r1), this.m.r1);
  }

  // -------------------------------------------------------------------- tip

  /** The name of what's pointed at (with its second line and key), just outside the wheel there. */
  private say(a: number, r: number, name: string, opts: { sub?: string; key?: string; beta?: boolean; why?: boolean } = {}): void {
    const t = this.tip;
    t.replaceChildren(el("span", "wheel-tip-name", name));
    if (opts.beta) t.append(el("span", "beta-tag", "BETA"));
    if (opts.sub) t.append(el("span", "wheel-tip-sub", opts.sub));
    if (opts.key) t.append(el("kbd", "", opts.key));
    t.classList.toggle("why", !!opts.why);
    t.hidden = false;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const x = r * c;
    const y = r * s;
    t.style.left = `${Math.round(x)}px`;
    t.style.top = `${Math.round(y)}px`;
    t.style.transform = `translate(${c > 0.4 ? "0" : c < -0.4 ? "-100%" : "-50%"}, ${s > 0.4 ? "0" : s < -0.4 ? "-100%" : "-50%"})`;
    // Kept on the screen (once per thing pointed at, not per move).
    const b = t.getBoundingClientRect();
    const dx = b.left < 6 ? 6 - b.left : b.right > innerWidth - 6 ? innerWidth - 6 - b.right : 0;
    const dy = b.top < 6 ? 6 - b.top : b.bottom > innerHeight - 6 ? innerHeight - 6 - b.bottom : 0;
    if (dx) t.style.left = `${Math.round(x + dx)}px`;
    if (dy) t.style.top = `${Math.round(y + dy)}px`;
  }

  private sayTool(it: ToolItem, a: number, r: number): void {
    this.say(a, r, it.label, { sub: it.sub, key: it.shortcut, beta: it.beta });
  }

  /** What the middle is for, said under the wheel once the pointer rests on it. */
  private sayHub(): void {
    const text = this.stack.length
      ? "Back"
      : this.isFolded
      ? this.layout === "settings" || this.layout === "options"
        ? `${this.layout === "settings" ? "Settings" : "Options"}: click · drag to move`
        : "Click to unfold · drag to move"
      : !this.kept
        ? "Drag to keep it somewhere · click to close"
        : this.layout === "model"
          ? "Drag to move · click to fold · twice: back at the pointer"
          : "Drag to move · click to fold";
    this.say(Math.PI / 2, (this.isFolded ? this.m.r0 : this.reach()) + 8, text);
  }

  // ---------------------------------------------------------------- pointer

  /** What's at a point of the page: by its distance and direction from the middle (no looking at the page). */
  private hitAt(x: number, y: number): number {
    const dx = x - this.cx;
    const dy = y - this.cy;
    const r = Math.hypot(dx, dy);
    const m = this.m;
    if (r < m.r0) return HUB;
    if (this.isFolded) return NONE;
    const a = Math.atan2(dy, dx);
    if (r <= m.r1 + m.gap / 2) {
      const n = this.sectors.length;
      const step = TAU / n;
      const k = ((Math.floor((a + Math.PI / 2 + step / 2) / step) % n) + n) % n;
      return this.sectors[k]?.blank ? NONE : SECTOR + k;
    }
    for (let i = 0; i < this.fan.length; i++) {
      const c = this.fan[i];
      if (r < c.r0 - m.gap / 2 || r > c.r1 + m.gap / 2) continue;
      if ((((a - c.a0) % TAU) + TAU) % TAU <= c.a1 - c.a0) return CELL + i;
    }
    return NONE;
  }

  private elOf(hit: number): SVGElement | null | undefined {
    return hit === HUB ? this.hubEl : hit >= CELL ? this.fanEls[hit - CELL] : hit >= SECTOR ? this.ringEls[hit - SECTOR] : null;
  }

  private track(x: number, y: number): void {
    this.px = x;
    this.py = y;
    if (this.still) {
      if (Math.hypot(x - this.from.x, y - this.from.y) < 8) return;
      this.still = false;
    }
    if (this.hold) {
      if (Math.hypot(x - this.hold.x, y - this.hold.y) < 10) return;
      this.hold = null;
    }
    const hit = this.hitAt(x, y);
    // Pressed and slid out across a group: the ring becomes its tools, the most used under the finger - slide on to another, let go.
    if (this.pressed !== null && !this.grab && hit >= SECTOR && hit < CELL && Math.hypot(x - this.cx, y - this.cy) > (this.m.r0 + this.m.r1) / 2 && Math.hypot(x - this.pressAt.x, y - this.pressAt.y) > 12) {
      const i = hit - SECTOR;
      const s = this.sectors[i];
      if (!s.item && s.cells.length) return this.enter(s.id, s.cells, this.midOf(i), i);
    }
    // (The same thing as before: nothing to do. This runs on every move.)
    if (hit !== this.hot) this.point(hit);
  }

  /** The pointer came onto a group, a tool, the middle - or off them all: its name, just outside the wheel. */
  private point(hit: number): void {
    this.elOf(this.hot)?.classList.remove("hot");
    this.hot = hit;
    this.elOf(hit)?.classList.add("hot");
    this.clearTimers();
    if (hit >= CELL) {
      const c = this.fan[hit - CELL];
      return this.sayTool(c.item, (c.a0 + c.a1) / 2, this.reach() + 8);
    }
    this.tip.hidden = true;
    if (hit === NONE) return;
    if (hit === HUB) {
      this.tipTimer = window.setTimeout(() => this.hot === HUB && !this.grab?.moved && this.sayHub(), 700);
      return;
    }
    const i = hit - SECTOR;
    const s = this.sectors[i];
    const mid = this.midOf(i);
    if (!s.cells.length && !s.item) return this.say(mid, this.reach() + 8, s.why ?? `${s.label} has nothing here`, { why: true });
    if (s.item) this.sayTool(s.item, mid, this.reach() + 8);
  }

  private run(item: ToolItem): void {
    // A switch or a choice on the Settings wheel is set right there: the fan stays, showing it set.
    if (item.id.startsWith("opt-") && !item.id.endsWith("-more")) {
      item.run?.();
      this.itemsChanged();
      return;
    }
    this.close();
    item.run?.();
  }

  /** A tap (or a press let go) at (x, y) on a place of the ring, or of its outer band. */
  private activate(hit: number): void {
    if (hit >= CELL) {
      const c = this.fan[hit - CELL];
      if (!c) return;
      if (opens(c.item)) return this.enter(c.item.id, this.kindsOf(c.item), (c.a0 + c.a1) / 2, -1);
      return this.run(c.item);
    }
    const i = hit - SECTOR;
    const s = this.sectors[i];
    if (!s || s.blank) return;
    if (s.item) return this.run(s.item);
    if (!s.cells.length) return this.say(this.midOf(i), this.reach() + 8, s.why ?? `${s.label} has nothing here`, { why: true });
    this.enter(s.id, s.cells, this.midOf(i), i);
  }

  /** A tap on the middle: back a ring; on the first, one up at the pointer closes, one kept somewhere folds or unfolds - twice, the model's is let go. */
  private hubTap(): void {
    if (this.stack.length) return this.back();
    if (!this.kept) return this.hide();
    const now = performance.now();
    if (this.layout === "model" && now - this.hubTapAt < 400) return this.letGo();
    this.hubTapAt = now;
    this.fold(!this.isFolded);
  }

  private onDown = (e: PointerEvent): void => {
    // (Typing a value: a press in its box, or on the numpad, is for that.)
    if (this.typer && ((e.target as Element).closest?.(".wheel-type, .numpad") ?? null)) return;
    if (!this.up) {
      this.dismissed = false;
      return;
    }
    // On the wheel, by where the press is (the same sums as for pointing; the pieces can still be
    // sliding or growing into place on the page) - unless something lying over the wheel was pressed.
    const hit = this.hitAt(e.clientX, e.clientY);
    const target = e.target as Element;
    const onView = target.tagName === "CANVAS";
    const mine = hit !== NONE && (this.root.contains(target) || onView);
    const through = this.fresh === "all" || (this.fresh === "hub" && hit === HUB);
    if (!mine || through) {
      if (!this.kept) {
        // A press anywhere else closes it, and goes on to what was pressed (the model: a tap picks, a drag turns the view).
        this.dismissed = true;
        this.hide();
        return;
      }
      // Kept somewhere, it stays: the press only takes it back to its first ring. A finger's is spent
      // on that (a tap meant to close the ring would draw a point).
      if (!this.stack.length) return;
      this.shut();
      if (e.pointerType === "touch" && onView) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (e.button !== 0) return this.close();
    this.type = e.pointerType === "touch" ? "touch" : e.pointerType === "pen" ? "pen" : "mouse";
    this.pressed = e.pointerId;
    this.adopt = this.adopted = false;
    this.still = false;
    this.hold = null;
    this.pressHit = hit;
    this.pressFan = this.fanCount;
    this.pressAt = { x: e.clientX, y: e.clientY };
    // The middle is the handle: the wheel goes with a press that moves; one that doesn't is a tap on it.
    this.grab = hit === HUB ? { dx: e.clientX - this.cx, dy: e.clientY - this.cy, moved: false } : null;
    this.track(e.clientX, e.clientY);
  };

  private onMove = (e: PointerEvent): void => {
    if (!this.up) return;
    const g = this.grab;
    if (g && this.pressed === e.pointerId) {
      if (!g.moved) {
        if (Math.hypot(e.clientX - this.pressAt.x, e.clientY - this.pressAt.y) < 6) return;
        g.moved = true;
        this.shut();
        this.unpoint();
        this.root.classList.remove("slide");
        this.root.classList.add("dragging");
      }
      this.home = { x: e.clientX - g.dx, y: e.clientY - g.dy };
      this.rest();
      return;
    }
    if (this.adopt && e.pointerType !== "mouse") {
      this.adopt = false;
      this.adopted = true;
      this.pressed = e.pointerId;
      this.pressAt = { ...this.from };
    }
    // (A finger only counts while it is down on the wheel.)
    if (e.pointerType === "touch") {
      if (this.pressed !== e.pointerId) return;
    } else this.type = e.pointerType === "pen" ? "pen" : "mouse";
    this.track(e.clientX, e.clientY);
  };

  private onUp = (e: PointerEvent): void => {
    if (!this.up) return;
    // Lifted where it was held: the wheel stays up, as after a tap.
    if (this.adopt && e.pointerType !== "mouse") return void (this.adopt = false);
    if (this.pressed !== e.pointerId) return;
    this.pressed = null;
    const g = this.grab;
    this.grab = null;
    if (g) {
      e.preventDefault();
      this.root.classList.remove("dragging");
      if (g.moved) this.drop();
      else this.hubTap();
      return;
    }
    // A tap is for what it came down on (a group tapped near the screen's edge slides the
    // wheel to fit its fan - what's under the finger then is not what was tapped); a press
    // that slid somewhere is for where it was let go.
    const tap = !this.adopted && Math.hypot(e.clientX - this.pressAt.x, e.clientY - this.pressAt.y) < 10;
    const hit = tap ? this.pressHit : this.hitAt(e.clientX, e.clientY);
    if (hit === NONE || hit === HUB) return;
    if (tap && this.pressFan !== this.fanCount) return;
    // (Not kept from the view: a finger that came down on it, and was held for the wheel, is let go of there too.)
    e.preventDefault();
    this.activate(hit);
  };

  private onCancel = (e: PointerEvent): void => {
    if (this.pressed === e.pointerId) {
      this.pressed = null;
      if (this.grab?.moved) this.drop();
      this.grab = null;
      this.root.classList.remove("dragging");
    }
    this.adopt = false;
  };

  private onKey = (e: KeyboardEvent): void => {
    if (!this.up || e.key !== "Escape") return;
    // (Typing a value: Esc is the box's, it leaves the value as it was.)
    if (this.typer) {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.typerEnd?.(false);
      return;
    }
    // Esc goes back a ring; on the first it closes the wheel (kept somewhere, Esc is then the app's). What's picked stays picked.
    if (this.kept && !this.stack.length) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (this.stack.length) this.back();
    else this.close();
  };

  // ------------------------------------------------------------ for checking

  /** Every tool the wheel offers now, by where it is ("Tools › Fillet"), whether it is up or not. */
  tools(): { id: string; label: string; path: string }[] {
    const { sectors } = this.up ? { sectors: this.stack[0]?.sectors ?? this.sectors } : this.content();
    const out: { id: string; label: string; path: string }[] = [];
    const walk = (it: ToolItem, path: string[]) => {
      const here = [...path, it.label];
      const kids = kidsOf(it);
      if (it.run) out.push({ id: it.id, label: it.label, path: here.join(" › ") });
      for (const k of kids) walk(k, here);
    };
    for (const s of sectors) {
      if (s.item) walk(s.item, []);
      for (const c of s.cells) walk(c.item, [s.label]);
    }
    return out;
  }

  /** The wheel as it is now: where its middle, each group and each fanned-out tool is on the page (to point and tap at). */
  describe() {
    const at = (r: number, a: number) => ({ x: Math.round(this.cx + r * Math.cos(a)), y: Math.round(this.cy + r * Math.sin(a)) });
    const m = this.m;
    return {
      on: this.on,
      open: this.up,
      layout: this.layout,
      kept: this.kept,
      ...(this.up
        ? {
            folded: this.isFolded,
            center: { x: Math.round(this.cx), y: Math.round(this.cy) },
            path: this.stack.map((l) => l.id),
            sectors: this.sectors.map((s, i) => ({ s, i })).filter(({ s }) => !s.blank).map(({ s, i }) => ({
              id: s.id,
              label: s.label,
              ...at((m.r0 + m.r1) / 2, this.midOf(i)),
              ...(s.item ? { runs: s.item.label } : {}),
              ...(s.on ? { inUse: true } : {}),
              ...(s.cells.length || s.item ? {} : { off: s.why }),
              tools: s.cells.map((c) => c.item.label + (c.item.active ? " *" : "")),
            })),
            fan: this.fan.map((c) => ({ id: c.item.id, label: c.item.label, ...at((c.r0 + c.r1) / 2, (c.a0 + c.a1) / 2), ...(c.item.active ? { inUse: true } : {}), ...(kidsOf(c.item).length ? { opens: kidsOf(c.item).map((k) => k.label) } : {}) })),
            tip: this.tip.hidden ? null : this.tip.textContent,
          }
        : {}),
    };
  }
}
