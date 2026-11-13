// The tool wheel: an experiment beside the tool column (More → Tool wheel).
//
// With it on, a tap on the model - or on an empty spot - brings the tools up
// in a ring round the pointer: what's picked at the top, then the main groups
// (Sketch, Freeform, Insert, Construct, Transform, Tools, BIM) clockwise, each
// always in the same place. Pointing at a group fans its tools out from that
// side of the ring; a tap on one runs it. A tool with kinds of its own (Plane,
// Colour…) opens them in place of the fan; the group brings its list back.
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

import { isCoarse, screenClass } from "../device";
import { settings } from "../settings";
import { icons, type IconName } from "./icons";
import { el, usable, type ToolItem, type UI } from "./ui";

/** Whose column it stands in for: the selection tool's, or the sketch's. */
export type WheelLayout = "model" | "sketch";

/** More for the model wheel's top sector, beside what the column and the bar hold: for what's picked, and for the view. */
export type WheelExtras = () => { own: ToolItem[]; view: ToolItem[] };

/** What a tool sees of the wheel. */
export interface WheelHandle {
  /** Switched on (More → Tool wheel). */
  readonly on: boolean;
  /** Up now: round the pointer, or at the place it is kept. */
  readonly isOpen: boolean;
  /** It has a place of its own on the screen and stays up there (dragged there by its middle; in a sketch, always). */
  readonly kept: boolean;
  /**
   * Which tool's column it stands in for from now on: the selection tool's
   * ("model": what's picked, or the main tools), the sketch's (its tools by
   * what they are for), or none (false: the column shows as ever).
   */
  cover(layout: WheelLayout | false, extras?: WheelExtras): void;
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
/** A small gap (px) where a new part of a list starts. */
const PART_GAP = 9;
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
  offsetFromEdge: "tools",
  drawing: "bim", material: "bim",
  deselect: OWN, wholePattern: OWN, color: OWN, opacity: OWN, delete: OWN, deleteBody: OWN,
};

/**
 * The sketch's wheel, clockwise from the top: Exit, then the tools by what
 * they are for down the right (their fans open away from the screen's edge
 * the wheel starts at), and the rest - the line type, Normal to Sketch, a tool
 * not named here - under More; Delete and Select on the left, a tap each.
 */
const SKETCH: ({ tool: string; label?: string } | { id: string; label: string; icon: IconName; tools: string[] })[] = [
  { tool: "exit", label: "Exit" },
  { id: "draw", label: "Draw", icon: "line", tools: ["line", "arc", "spline", "rect", "circle", "ellipse", "polygon", "text"] },
  { id: "modify", label: "Modify", icon: "trim", tools: ["fillet", "trim", "extend", "split", "align", "offset", "project"] },
  { id: "transform", label: "Transform", icon: "transform", tools: ["move", "rotate", "scale", "mirror", "pattern"] },
  { id: "more", label: "More", icon: "more", tools: [] },
  { tool: "delete" },
  { tool: "select" },
];

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
}
interface Placed extends Cell {
  r0: number;
  r1: number;
  a0: number;
  a1: number;
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

/**
 * A group's tools as rows of a half ring outside the ring of groups, centred
 * on the group (`mid`). One row while they fit, then a second further out.
 */
function fanLayout(cells: Cell[], mid: number, m: Metrics): Placed[] {
  const N = cells.length;
  if (!N) return [];
  const rows: { r0: number; r1: number; rm: number; cap: number }[] = [];
  let room = 0;
  for (let k = 0; room < N && k < 4; k++) {
    const r0 = m.r1 + m.gap + k * (m.depth + m.gap);
    const rm = r0 + m.depth / 2;
    const cap = Math.max(1, Math.floor((Math.PI * rm) / m.min));
    rows.push({ r0, r1: r0 + m.depth, rm, cap });
    room += cap;
  }
  // Read top to bottom at either side, left to right above and below.
  const flip = Math.cos(mid) < -0.01 || (Math.abs(Math.cos(mid)) <= 0.01 && Math.sin(mid) > 0);
  const out: Placed[] = [];
  let at = 0;
  rows.forEach((row, k) => {
    const left = N - at;
    const later = rows.slice(k + 1).reduce((s, r) => s + r.cap, 0);
    // In proportion to the row's room (so the cells come out about as wide in each), the list kept in order.
    const n = k === rows.length - 1 ? left : Math.max(left - later, Math.min(row.cap, left, Math.round((N * row.cap) / room)));
    const part = cells.slice(at, at + n);
    at += n;
    if (!part.length) return;
    const seq = flip ? [...part].reverse() : part;
    const gapAt = seq.map((c, j) => j > 0 && !!(flip ? seq[j - 1].gap : c.gap));
    const gaps = gapAt.filter(Boolean).length * PART_GAP;
    const w = Math.min(m.max, (Math.PI * row.rm - gaps) / seq.length);
    let a = mid - (seq.length * w + gaps) / row.rm / 2;
    const placed = seq.map((c, j): Placed => {
      if (gapAt[j]) a += PART_GAP / row.rm;
      const a0 = a;
      a += w / row.rm;
      return { ...c, r0: row.r0, r1: row.r1, a0, a1: a };
    });
    out.push(...(flip ? placed.reverse() : placed));
  });
  return out;
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
  private fan: Placed[] = [];
  /** The group whose tools are fanned out (-1: none), and the tools opened inside it (Plane › …). */
  private openSector = -1;
  private trail: ToolItem[] = [];
  private hot = NONE;
  private up = false;
  private dismissed = false;

  /** Where it is kept, by layout: the middle as fractions of the page's width and height. */
  private spots: Partial<Record<WheelLayout, [number, number]>> = {};
  /** Kept, and folded to just its middle (until the page is loaded again). */
  private folded: Record<WheelLayout, boolean> = { model: false, sketch: screenClass() === "phone" };
  /** Where it belongs (px): where it was put, or where it came up. */
  private home = { x: 0, y: 0 };
  /** The middle, on the page (off its home while a fan needs the room). */
  private cx = 0;
  private cy = 0;
  private slid = false;
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
  private openAtPress = -1;
  /** What the press came down on, and where: a tap acts on that, wherever the wheel has slid to since. */
  private pressHit = NONE;
  private pressAt = { x: 0, y: 0 };
  /** Counts the fans shown: a tool pressed in a fan that has since been replaced isn't run. */
  private fanCount = 0;
  private pressFan = 0;
  /** A list swapped in under a resting pointer: a click this soon after isn't for it. */
  private guardUntil = 0;
  /** When the wheel last slid to bring a fan on the screen. */
  private slidAt = -Infinity;
  /**
   * Just up at the pointer: the second tap of a double tap (the whole body)
   * still goes to the model - through the middle, or through all of it when
   * it had to open off the pointer (which is then on one of its pieces).
   */
  private fresh: "" | "hub" | "all" = "";
  private switchTimer = 0;
  private drillTimer = 0;
  private freshTimer = 0;
  private leaveTimer = 0;
  private tipTimer = 0;
  private refreshing = false;

  constructor(private host: WheelHost) {
    this.root.id = "wheel";
    this.root.hidden = true;
    this.tip.hidden = true;
    this.hubEl.setAttribute("class", "wheel-hub");
    const grip = el("div", "wheel-item wheel-grip");
    grip.innerHTML = icons.move;
    this.hubSvg.append(this.hubEl);
    this.hubBox.append(this.hubSvg, grip);
    this.fanBox.append(this.fanSvg, this.fanItems);
    this.ringBox.append(this.ringSvg, this.ringItems);
    this.body.append(this.fanBox, this.ringBox, this.hubBox);
    this.root.append(this.body, this.tip);
    document.body.append(this.root);
    document.addEventListener("pointerdown", this.onDown, true);
    document.addEventListener("pointermove", this.onMove, true);
    document.addEventListener("pointerup", this.onUp, true);
    document.addEventListener("pointercancel", this.onCancel, true);
    window.addEventListener("keydown", this.onKey, true);
    // Scrolling zooms the view: the wheel is out of its way (kept somewhere, its fan is).
    window.addEventListener("wheel", () => this.away(), { capture: true, passive: true });
    window.addEventListener("blur", () => this.away());
    window.addEventListener("resize", () => {
      if (!this.up) return;
      if (!this.kept) return this.hide();
      this.home = this.homeNow();
      this.rest();
    });
    this.root.addEventListener("contextmenu", (e) => e.preventDefault());
    host.ui.onTools = () => this.itemsChanged();
    settings.onChange(() => this.sync());
    this.sync();
  }

  get on(): boolean {
    return settings.value.wheel;
  }

  get isOpen(): boolean {
    return this.up;
  }

  get kept(): boolean {
    return this.layout === "sketch" || (this.layout === "model" && !!this.spots.model);
  }

  private get isFolded(): boolean {
    return !!this.layout && this.kept && this.folded[this.layout];
  }

  cover(layout: WheelLayout | false, extras?: WheelExtras): void {
    const next = layout || null;
    if (extras) this.extras = extras;
    // (The sketch says so each time it sets its tools: the same again is nothing new.)
    if (next === this.layout) return;
    this.hide();
    this.layout = next;
    if (!extras) this.extras = null;
    this.loadSpots();
    this.sync();
  }

  /** The column steps aside while the wheel stands in for it; a kept wheel is up whenever it does. */
  private sync(): void {
    const covers = this.on && this.layout !== null;
    document.body.classList.toggle("wheel-covers", covers);
    if (!covers) return this.hide();
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
      all[screenClass()] = this.spots;
      localStorage.setItem(SPOTS, JSON.stringify(all));
    } catch {
      // private window: not remembered
    }
  }

  /** Where a kept wheel belongs on the page as it is now. */
  private homeNow(): { x: number; y: number } {
    // (The sketch's wheel, never moved: where the model's is kept, if it is.)
    const s = this.layout === "sketch" ? (this.spots.sketch ?? this.spots.model) : this.spots.model;
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
    this.slid = false;
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
    return this.layout === "sketch" ? this.sketchContent() : this.modelContent();
  }

  /** The model's ring: the top sector, then the main groups in the column's order - each with what it holds now. */
  private modelContent(): { sectors: Sector[]; pick: string } {
    const { column, bar } = this.host.ui.shown();
    const main = this.host.mainTools();
    const shown = usable(column).filter(notSep);
    let groups: Sector[];
    let own: Cell[] = [];
    if (shown.length > 0 && shown.every((it) => main.some((g) => g.id === it.id))) {
      // Nothing picked: the column is the main tools themselves.
      groups = shown.map((g) => {
        const cells = kidsOf(g).map((item) => ({ item }));
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
      for (const it of shown) (lists.get(groupOf(it.id)) ?? own).push({ item: it });
      // A group with nothing for this pick says why: its tools that are off, with their reasons.
      const off = new Map<string, string[]>();
      for (const it of column) if (it.disabled && it.why && it.label) off.set(groupOf(it.id), [...(off.get(groupOf(it.id)) ?? []), `${it.label}: ${it.why}`]);
      const what = shown.find((it) => it.id === "deselect")?.sub;
      groups = main.map((g) => {
        const cells = lists.get(g.id)!;
        const why = cells.length ? undefined : off.get(g.id)?.slice(0, 3).join(" · ") ?? `${g.label} has nothing for ${what ?? "this"}`;
        return { id: g.id, label: g.label, icon: g.icon, cells, why, mark: marked(cells) };
      });
    }
    const pick = shown.find((it) => it.id === "deselect")?.sub ?? "";
    const extras = this.extras?.() ?? { own: [], view: [] };
    own = [...own, ...extras.own.map((item) => ({ item }))];
    const view = [...usable(bar).filter(notSep), ...extras.view].map((item, i): Cell => ({ item, gap: i === 0 && own.length > 0 }));
    const top: Sector = { id: OWN, label: pick || "View", icon: pick ? "pointer" : "eye", cells: [...own, ...view], mark: marked(view) };
    return { sectors: [top, ...groups], pick };
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
    // More: what isn't named above (Other plane, a tool added since), then the bottom bar's (the line type, Normal to Sketch).
    const more = sectors.find((s) => s.id === "more" && !s.item);
    if (more) {
      const rest = tools.filter((t) => !placed.has(t.id)).map((item): Cell => ({ item }));
      more.cells = [...rest, ...usable(bar).filter(notSep).map((item, i): Cell => ({ item, gap: i === 0 && rest.length > 0 }))];
    }
    for (const s of sectors) if (!s.item) s.mark = marked(s.cells);
    // (A category with nothing in it has no place on the ring.)
    return { sectors: sectors.filter((s) => s.item || s.cells.length), pick: "" };
  }

  /** The tools shown in a group's fan: its own, or those of a tool opened inside it. */
  private cellsOf(i: number, trail: ToolItem[]): Cell[] {
    const s = this.sectors[i];
    if (!s) return [];
    const parent = trail[trail.length - 1];
    if (!parent) return s.cells;
    const kids = kidsOf(parent);
    const cells = kids.map((item): Cell => ({ item }));
    // What a tap on it does in the column (the kind used last) comes first, unless one of its kinds is marked as that.
    if (parent.run && !kids.some((k) => k.active)) cells.unshift({ item: { ...parent, children: undefined } });
    return cells;
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
    this.sig = signature(sectors);
    this.pick = pick;
    this.type = opts.type ?? "mouse";
    this.m = this.type === "touch" || isCoarse ? COARSE : FINE;
    // Whole on the screen with any of its fans out, as near the pointer as that allows: it then
    // never has to move under the pointer. Where the screen is too small for that (a phone, across),
    // the ring is whole, and it slides when a fan needs the room (see fit).
    const M = 6;
    const reach = this.extent();
    const ring = this.m.r1;
    const [l, r] = innerWidth >= reach.l + reach.r + 2 * M ? [reach.l, reach.r] : [ring, ring];
    const [t, b] = innerHeight >= reach.t + reach.b + 2 * M ? [reach.t, reach.b] : [ring, ring];
    this.cx = clamp(x, l + M, Math.max(l + M, innerWidth - r - M));
    this.cy = clamp(y, t + M, Math.max(t + M, innerHeight - b - M));
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
    this.sig = signature(sectors);
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
    this.openSector = -1;
    this.trail = [];
    this.fan = [];
  }

  private clearTimers(): void {
    clearTimeout(this.switchTimer);
    clearTimeout(this.drillTimer);
    clearTimeout(this.leaveTimer);
    clearTimeout(this.tipTimer);
  }

  /** Put the fan away, if one is out. */
  private shut(): void {
    if (this.openSector >= 0) this.showFan(-1);
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
      const open = this.sectors[this.openSector]?.id;
      const sig = signature(sectors);
      const same = sig === this.sig;
      this.sectors = sectors;
      this.sig = sig;
      const at = sectors.findIndex((s) => s.id === open && s.cells.length > 0);
      // The tools opened inside a tool (Plane › …), found again among the new ones.
      const trail: ToolItem[] = [];
      let from = at >= 0 ? sectors[at].cells.map((c) => c.item) : [];
      for (const t of this.trail) {
        const it = from.find((x) => x.id === t.id);
        if (!it) break;
        trail.push(it);
        from = kidsOf(it);
      }
      if (same && trail.length === this.trail.length) {
        // Nothing looks different (the model rebuilt, the same tools made again): only what a tap runs is new.
        this.trail = trail;
        const fresh = fanLayout(this.cellsOf(this.openSector, trail), this.midOf(this.openSector), this.m);
        if (fresh.length === this.fan.length) this.fan = fresh;
        return;
      }
      this.unpoint();
      this.drawRing();
      this.showFan(at, at >= 0 ? trail : []);
    });
  }

  // ----------------------------------------------------------------- drawing

  private midOf(i: number): number {
    return -Math.PI / 2 + (i * TAU) / this.sectors.length;
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

  /** The whole wheel anew: the middle, the ring, no fan. */
  private draw(): void {
    this.hubEl.setAttribute("r", String(this.m.hub));
    this.hot = NONE;
    this.tip.hidden = true;
    this.drawRing();
    this.showFan(-1);
  }

  private drawRing(): void {
    const m = this.m;
    const step = TAU / this.sectors.length;
    // What takes the pointer is a plate under the pieces (the hairlines between them included): a
    // press on a hairline is a press on the wheel, not on the model behind it.
    const plate = document.createElementNS(SVG, "circle");
    plate.setAttribute("class", "wheel-plate");
    plate.setAttribute("r", String((m.r0 + m.r1) / 2));
    plate.setAttribute("stroke-width", String(m.r1 - m.r0 + m.gap));
    this.ringSvg.replaceChildren(plate);
    this.ringItems.replaceChildren();
    this.ringEls = this.sectors.map((s, i) => {
      const mid = this.midOf(i);
      const dim = !s.cells.length && !s.item;
      const p = path(`wheel-cell wheel-sector${dim ? " dim" : ""}${i === 0 ? " own" : ""}${s.on ? " on" : ""}`, wedge(m.r0, m.r1, mid - step / 2, mid + step / 2, 3));
      this.ringSvg.append(p);
      this.ringItems.append(this.item(s, s.label, `sector${dim ? " dim" : ""}${s.mark ? " mark" : ""}${s.on ? " on" : ""}`, (m.r0 + m.r1) / 2 + 1, mid));
      return p;
    });
  }

  /** Fan out a group's tools (-1: none), or the tools of a tool opened inside it. */
  private showFan(i: number, trail: ToolItem[] = []): void {
    this.ringEls[this.openSector]?.classList.remove("open");
    this.fanCount++;
    this.openSector = i;
    this.trail = trail;
    this.ringEls[i]?.classList.add("open");
    if (this.hot >= CELL) {
      this.hot = NONE;
      this.tip.hidden = true;
    }
    const m = this.m;
    this.fan = i < 0 ? [] : fanLayout(this.cellsOf(i, trail), this.midOf(i), m);
    this.fanSvg.replaceChildren();
    this.fanItems.replaceChildren();
    // (A plate under each row takes the pointer, as under the ring.)
    for (const r0 of new Set(this.fan.map((c) => c.r0))) {
      const row = this.fan.filter((c) => c.r0 === r0);
      this.fanSvg.append(path("wheel-plate", wedge(r0 - m.gap / 2, row[0].r1 + m.gap / 2, Math.min(...row.map((c) => c.a0)), Math.max(...row.map((c) => c.a1)), 0)));
    }
    this.fanEls = this.fan.map((c) => {
      const it = c.item;
      const p = path(`wheel-cell${it.active ? " on" : ""}`, wedge(c.r0, c.r1, c.a0, c.a1));
      this.fanSvg.append(p);
      const rm = (c.r0 + c.r1) / 2;
      const mid = (c.a0 + c.a1) / 2;
      // The room for its name: the cell's width along the row above and below the wheel, its depth at the sides.
      const up = Math.abs(Math.sin(mid));
      const across = Math.abs(Math.cos(mid));
      const width = (up * (c.a1 - c.a0) * rm + across * (c.r1 - c.r0)) / (up + across) - 4;
      this.fanItems.append(this.item(it, kidsOf(it).length ? `${it.label} ›` : it.label, `${it.active ? "on" : ""}${it.pulse ? " mark" : ""}`, rm, mid, width));
      return p;
    });
    if (this.fan.length && !calm()) this.fanBox.animate([{ opacity: 0, transform: "scale(0.9)" }, { opacity: 1, transform: "none" }], { duration: 90, easing: "ease-out" });
    if (this.fan.length) this.fit();
    // A kept wheel that slid for the fan goes back to its place once the fan is away.
    else if (this.kept && this.slid && this.up) {
      this.root.classList.add("slide");
      this.rest();
    }
  }

  /** How far the wheel reaches each way from its middle, with every group's fan out. */
  private extent(): { l: number; r: number; t: number; b: number } {
    const e = { l: this.m.r1, r: this.m.r1, t: this.m.r1, b: this.m.r1 };
    this.sectors.forEach((s, i) => {
      for (const c of fanLayout(s.cells, this.midOf(i), this.m))
        for (const a of [c.a0, (c.a0 + c.a1) / 2, c.a1]) {
          const x = c.r1 * Math.cos(a);
          const y = c.r1 * Math.sin(a);
          e.l = Math.max(e.l, -x);
          e.r = Math.max(e.r, x);
          e.t = Math.max(e.t, -y);
          e.b = Math.max(e.b, y);
        }
    });
    return e;
  }

  /** How far out the fan reaches. */
  private reach(): number {
    return this.fan.reduce((r, c) => Math.max(r, c.r1), this.m.r1);
  }

  /** A fan that would run off the screen: the wheel slides to bring it on. */
  private fit(): void {
    let x0 = -this.m.r1;
    let x1 = this.m.r1;
    let y0 = -this.m.r1;
    let y1 = this.m.r1;
    for (const c of this.fan)
      for (const a of [c.a0, (c.a0 + c.a1) / 2, c.a1]) {
        const x = c.r1 * Math.cos(a);
        const y = c.r1 * Math.sin(a);
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
    const M = 6;
    let dx = this.cx + x1 > innerWidth - M ? innerWidth - M - this.cx - x1 : 0;
    if (this.cx + x0 + dx < M) dx = M - this.cx - x0;
    let dy = this.cy + y1 > innerHeight - M ? innerHeight - M - this.cy - y1 : 0;
    if (this.cy + y0 + dy < M) dy = M - this.cy - y0;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    this.cx += dx;
    this.cy += dy;
    this.slid = true;
    if (this.up) this.root.classList.add("slide");
    this.place();
    // The pointer stayed put and the wheel moved: what's under it now counts once it moves
    // again - and another group it lands on has to wait a little longer to take the fan.
    this.hold = { x: this.px, y: this.py };
    this.slidAt = performance.now();
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
    const text = this.isFolded
      ? "Click to unfold · drag to move"
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
      return SECTOR + ((((Math.floor((a + Math.PI / 2 + step / 2) / step) % n) + n) % n));
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
    // (The same thing as before: nothing to do. This runs on every move.)
    if (hit !== this.hot) this.point(hit);
  }

  /** The pointer came onto a group, a tool, the middle - or off them all. */
  private point(hit: number): void {
    this.elOf(this.hot)?.classList.remove("hot");
    this.hot = hit;
    this.elOf(hit)?.classList.add("hot");
    this.clearTimers();
    if (hit >= CELL) {
      const c = this.fan[hit - CELL];
      this.sayTool(c.item, (c.a0 + c.a1) / 2, this.reach() + 8);
      // Resting on a tool with kinds of its own opens them (a tap does at once).
      if (opens(c.item) && !c.item.variantsWhenActive && this.type !== "touch") this.drillTimer = window.setTimeout(() => this.hot === hit && this.drill(hit - CELL, true), 280);
      return;
    }
    this.tip.hidden = true;
    if (hit === NONE) {
      // Off a kept wheel: its fan goes away after a moment (one up at the pointer is closed as a whole).
      if (this.kept && this.openSector >= 0 && this.pressed === null) this.leaveTimer = window.setTimeout(() => this.hot === NONE && this.shut(), 500);
      return;
    }
    if (hit === HUB) {
      this.tipTimer = window.setTimeout(() => this.hot === HUB && !this.grab?.moved && this.sayHub(), 700);
      return;
    }
    const i = hit - SECTOR;
    const s = this.sectors[i];
    const mid = this.midOf(i);
    if (!s.cells.length && !s.item) return this.say(mid, this.m.r1 + 8, s.why ?? `${s.label} has nothing here`, { why: true });
    if (s.item) this.sayTool(s.item, mid, this.m.r1 + 8);
    if (i === this.openSector) {
      // Back from a tool's kinds to the group's own list.
      if (this.trail.length) this.showFan(i);
      return;
    }
    const go = () => this.hot === hit && this.showFan(i);
    // Straight away - except from one group's fan to the next: heading across a
    // neighbour for a tool at the far end of the fan mustn't swap the fan away.
    // (Longer just after the wheel slid: the pointer is still on its way to the fan that moved.)
    const slid = performance.now() - this.slidAt < 450;
    if (this.openSector < 0 || (this.pressed !== null && !slid)) go();
    else this.switchTimer = window.setTimeout(go, slid ? 450 : 90);
  }

  /** A tool's own kinds (Plane ›, Colour ›) take the fan's place. */
  private drill(index: number, resting: boolean): void {
    const c = this.fan[index];
    if (!c) return;
    this.showFan(this.openSector, [...this.trail, c.item]);
    this.guardUntil = resting ? performance.now() + 260 : 0;
  }

  private run(item: ToolItem): void {
    this.close();
    item.run?.();
  }

  /** A tap (or a press let go) on a group or a tool. */
  private activate(hit: number): void {
    if (hit >= CELL) {
      const c = this.fan[hit - CELL];
      if (!c) return;
      if (opens(c.item)) return this.drill(hit - CELL, false);
      if (performance.now() < this.guardUntil) return;
      return this.run(c.item);
    }
    const i = hit - SECTOR;
    const s = this.sectors[i];
    if (!s) return;
    if (s.item) return this.run(s.item);
    if (!s.cells.length) return this.say(this.midOf(i), this.m.r1 + 8, s.why ?? `${s.label} has nothing here`, { why: true });
    // A group with one tool, its fan already showing: a tap on the group runs it.
    const only = s.cells.length === 1 ? s.cells[0].item : null;
    if (only && this.openAtPress === i && !this.trail.length && !opens(only)) return this.run(only);
    if (this.openSector !== i || this.trail.length) this.showFan(i);
  }

  /** A tap on the middle: one up at the pointer closes; one kept somewhere folds or unfolds - twice, the model's is let go. */
  private hubTap(): void {
    if (!this.kept) return this.hide();
    const now = performance.now();
    if (this.layout === "model" && now - this.hubTapAt < 400) return this.letGo();
    this.hubTapAt = now;
    this.fold(!this.isFolded);
  }

  private onDown = (e: PointerEvent): void => {
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
      // Kept somewhere, it stays: the press only puts its fan away. A finger's is spent on that
      // (nothing hovers a fan away for a finger, and a tap meant to close it would draw a point).
      if (this.openSector < 0) return;
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
    this.openAtPress = this.openSector;
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
      this.openAtPress = this.openSector;
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
    if (tap && hit >= CELL && this.pressFan !== this.fanCount) return;
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
    // Esc closes the wheel only (kept somewhere: its fan), and what's picked stays picked. With no fan out, Esc is the app's.
    if (this.kept && this.openSector < 0) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.close();
  };

  // ------------------------------------------------------------ for checking

  /** Every tool the wheel offers now, by where it is ("Tools › Fillet"), whether it is up or not. */
  tools(): { id: string; label: string; path: string }[] {
    const { sectors } = this.up ? { sectors: this.sectors } : this.content();
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
            group: this.sectors[this.openSector]?.id ?? null,
            inside: this.trail.map((t) => t.label),
            sectors: this.sectors.map((s, i) => ({
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
