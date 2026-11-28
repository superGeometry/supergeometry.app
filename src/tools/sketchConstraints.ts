// Sketch constraint UI: the constraint button column, building constraints from
// the selection, and the badges/dimension labels drawn next to the geometry.

import type { ConstraintType, PlaneDef, PointRef, SketchConstraint, SketchEntity, Vec2 } from "../doc/types";
import { applicable, pointOf, pointsOf, sizeOf } from "../sketch/constraints";
import { entityPolylines } from "../sketch/curves";
import { numpadInput, openNumpad } from "../ui/numpad";
import { placeMarks, type DimShape } from "../sketch/constraintMarks";
import { uid } from "../sketch/edit";
import { el } from "../ui/ui";
import { fmtLen, trim } from "../units";
import type { Viewport } from "../view/viewport";
import { sketchToWorld } from "../view/viewport";

export const CONSTRAINT_BUTTONS: { type: ConstraintType | "hv"; label: string; glyph: string; key: string }[] = [
  // Lock / unlock first: the one reached for most.
  { type: "fix", label: "Lock", glyph: "🔒", key: "L" },
  { type: "parallel", label: "Parallel", glyph: "∥", key: "A" },
  { type: "perpendicular", label: "Perpendicular", glyph: "⟂", key: "P" },
  { type: "tangent", label: "Tangent", glyph: "T", key: "T" },
  { type: "coincident", label: "Coincident", glyph: "●", key: "N" },
  { type: "midpoint", label: "Midpoint", glyph: "M", key: "M" },
  { type: "concentric", label: "Concentric", glyph: "◎", key: "C" },
  { type: "hv", label: "Horizontal/Vertical", glyph: "H/V", key: "V" },
  { type: "equal", label: "Equal", glyph: "=", key: "E" },
  { type: "symmetric", label: "Symmetry", glyph: "⇋", key: "S" },
  { type: "distance", label: "Distance", glyph: "↔", key: "D" },
];

const GLYPH: Partial<Record<ConstraintType, string>> = {
  coincident: "●",
  horizontal: "H",
  vertical: "V",
  parallel: "∥",
  perpendicular: "⟂",
  equal: "=",
  tangent: "T",
  concentric: "◎",
  midpoint: "M",
  symmetric: "⇋",
  fix: "🔒",
};

/** The small sign a constraint goes by (a size: its arrow). */
export function constraintGlyph(c: SketchConstraint): string {
  if (c.type === "dim" || c.type === "distance") return c.prop === "angle" ? "∠" : "↔";
  if (c.type === "pattern" || c.type === "follow") return "⛓";
  return GLYPH[c.type] ?? "•";
}

/** Constraints for a button press, from the current selection (empty if it doesn't fit). */
export function buildConstraints(type: ConstraintType | "hv", pts: PointRef[], curves: SketchEntity[], all?: SketchEntity[]): SketchConstraint[] {
  if (type === "hv") {
    if (curves.length === 1 && curves[0].kind === "line" && !pts.length) {
      const l = curves[0];
      const horiz = Math.abs(l.b[0] - l.a[0]) >= Math.abs(l.b[1] - l.a[1]);
      return [{ id: uid(), type: horiz ? "horizontal" : "vertical", curves: [l.id] }];
    }
    // Two points (a circle's centre and a corner, two ends): level with each other, or one above the other -
    // whichever they are nearer to. (The solver had it; no button gave it.)
    if (pts.length === 2 && !curves.length && all) {
      const [a, b] = pts.map((r) => {
        const e = all.find((x) => x.id === r.e);
        return e ? pointOf(e, r.p) : null;
      });
      if (a && b && Math.hypot(a[0] - b[0], a[1] - b[1]) > 1e-9) return [{ id: uid(), type: Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]) ? "horizontal" : "vertical", pts }];
    }
    return [];
  }
  if (!applicable(type, pts, curves)) return [];
  const ids = curves.map((c) => c.id);
  switch (type) {
    case "coincident":
      return pts.length === 2 ? [{ id: uid(), type, pts }] : [{ id: uid(), type, pts, curves: ids }];
    case "midpoint":
    case "symmetric":
      return [{ id: uid(), type, pts, curves: ids }];
    case "distance": {
      const v = distanceOf(pts, curves);
      return v === null ? [] : [{ id: uid(), type, pts, curves: ids.length ? ids : undefined, value: v }];
    }
    case "fix": {
      // Locking a curve holds all of its points (and a circle's size).
      const all = [...pts, ...curves.flatMap((e) => pointsOf(e).map((q) => ({ e: e.id, p: q.p })))];
      const sizes = curves.flatMap((e): SketchConstraint[] => (e.kind === "circle" ? [{ id: uid(), type: "dim", curves: [e.id], prop: "diameter", value: 2 * e.radius, held: true }] : []));
      return [...all.map((p) => ({ id: uid(), type, pts: [p] })), ...sizes];
    }
    default:
      return [{ id: uid(), type, curves: ids }];
  }
}

/** Current distance between two points, or a point and a line. */
export function distanceOf(pts: PointRef[], curves: SketchEntity[], all: SketchEntity[] = curves): number | null {
  const P = (r: PointRef) => {
    const e = all.find((x) => x.id === r.e);
    return e ? pointOf(e, r.p) : null;
  };
  if (pts.length === 2 && !curves.length) {
    const [a, b] = pts.map(P);
    return a && b ? Math.hypot(a[0] - b[0], a[1] - b[1]) : null;
  }
  const l = curves[0];
  const p = pts[0] && P(pts[0]);
  if (pts.length === 1 && curves.length === 1 && l.kind === "line" && p) {
    const dx = l.b[0] - l.a[0];
    const dy = l.b[1] - l.a[1];
    return Math.abs((p[0] - l.a[0]) * dy - (p[1] - l.a[1]) * dx) / (Math.hypot(dx, dy) || 1);
  }
  // Two lines that run the same way (within a degree): how far apart they are - the second's middle from the first.
  // (Asked for: a distance between two lines. Two lines that cross have an angle between them, not a distance.)
  const m = curves[1];
  if (!pts.length && curves.length === 2 && l.kind === "line" && m.kind === "line") {
    const [dx, dy, ex, ey] = [l.b[0] - l.a[0], l.b[1] - l.a[1], m.b[0] - m.a[0], m.b[1] - m.a[1]];
    const [L, M] = [Math.hypot(dx, dy), Math.hypot(ex, ey)];
    if (!(L > 1e-12) || !(M > 1e-12) || Math.abs(dx * ey - dy * ex) / (L * M) > Math.sin(Math.PI / 180)) return null;
    const mid = [(m.a[0] + m.b[0]) / 2, (m.a[1] + m.b[1]) / 2];
    return Math.abs((mid[0] - l.a[0]) * dy - (mid[1] - l.a[1]) * dx) / L;
  }
  return null;
}

/**
 * Constraints already on the selection for a button: the column shows them
 * as on, and tapping the button removes them.
 */
export function existingConstraints(type: ConstraintType | "hv", constraints: SketchConstraint[], pts: PointRef[], curves: SketchEntity[]): SketchConstraint[] {
  const ids = new Set(curves.map((e) => e.id));
  const ptKeys = new Set(pts.map((p) => `${p.e}:${p.p}`));
  const types: string[] = type === "hv" ? ["horizontal", "vertical"] : [type];
  // A point counts as selected when it is, or when its curve is.
  const ptIn = (p: PointRef) => ptKeys.has(`${p.e}:${p.p}`) || ids.has(p.e);
  return constraints.filter((c) => {
    // (The size Lock put on a circle goes with its lock; it was left behind, and the circle unlocked kept its size.)
    if (type === "fix" && c.type === "dim" && c.held && c.curves?.length === 1 && ids.has(c.curves[0])) return true;
    if (!types.includes(c.type)) return false;
    const cv = c.curves ?? [];
    const cp = c.pts ?? [];
    if (!cv.length && !cp.length) return false;
    if (type === "fix") return cp.every(ptIn);
    // Every curve and point it involves is in the selection.
    return cv.every((id) => ids.has(id)) && cp.every(ptIn) && (cv.length + cp.length > 1 || ids.size + pts.length === 1);
  });
}

/** Upsert a driving dimension on one entity (length / radius / w / h / …). */
export function setDim(list: SketchConstraint[], entity: string, prop: string, value: number, expr?: string | null): SketchConstraint[] {
  const i = list.findIndex((c) => c.type === "dim" && c.curves?.[0] === entity && c.curves.length === 1 && c.prop === prop);
  const c: SketchConstraint = { id: i >= 0 ? list[i].id : uid(), type: "dim", curves: [entity], prop, value, ...(expr ? { expr } : {}) };
  return i >= 0 ? list.map((x, k) => (k === i ? c : x)) : [...list, c];
}

/** The dimension constraint on an entity's property, if any. */
export function dimOf(list: SketchConstraint[], entity: string, prop: string): SketchConstraint | undefined {
  return list.find((c) => c.type === "dim" && c.curves?.[0] === entity && c.curves.length === 1 && c.prop === prop);
}

/** What the sketch does for its marks: pick one, give a dimension's size as it is typed, take a new one. */
export interface GlyphHost {
  click(id: string): void;
  /** A dimension's size as text to type over ("20", or its formula). */
  text(id: string): string;
  /** A size typed at the dimension itself: true if it was taken. */
  edit(id: string, text: string): boolean;
}

interface Mark {
  /** Its chip: the constraint's id, and which of the things it ties this mark is on. */
  key: string;
  c: SketchConstraint;
  /** The other constraints of its kind at this place: the mark is theirs too (see placeMarks). */
  also: SketchConstraint[];
  at: Vec2;
  dir: Vec2;
  dist: number;
  shape?: DimShape;
  /** Where its chip's middle is on screen, as last laid out (for the pointer). */
  x: number;
  y: number;
  w: number;
  /** It is on one of the curves picked in the sketch. */
  mine?: boolean;
}

const SVG = "http://www.w3.org/2000/svg";
/** How far the move handle of a picked curve reaches from it on screen (px): its marks and sizes go out past that. */
const GIMBAL_REACH = 58;

/**
 * The constraints of the sketch being edited, on the drawing:
 *  - a small mark for each, on every curve or point it ties (a parallel's sign on both lines, not on one of them);
 *  - a dimension as a dimension: thin lines out from what it measures, a line with arrows, the size on it - a
 *    round's as a leader to its rim, an angle's as an arc - not a number near the shape;
 *  - the one pointed at (the mouse over its mark, or picked) lit, with everything it ties lit with it; and with
 *    curves picked, their constraints' marks stand out and the curves they are tied to show faintly;
 *  - a dimension's size typed where it is: a click on it puts a box there.
 */
export class ConstraintGlyphs {
  private host = el("div", "cglyphs");
  private svg = document.createElementNS(SVG, "svg");
  private lines = document.createElementNS(SVG, "path");
  private heads = document.createElementNS(SVG, "path");
  private litLines = document.createElementNS(SVG, "path");
  private litHeads = document.createElementNS(SVG, "path");
  private tied = document.createElementNS(SVG, "path");
  private lit = document.createElementNS(SVG, "path");
  private chips = new Map<string, HTMLElement>();
  private hook = () => this.layout();
  private marks: Mark[] = [];
  private plane: PlaneDef | null = null;
  private entities = new Map<string, SketchEntity>();
  private outlines = new Map<string, Vec2[][]>();
  private constraints: SketchConstraint[] = [];
  /** The one picked (its card is up). */
  selected: string | null = null;
  /** The one the pointer is on, or a list's row is. */
  private pointed: string | null = null;
  /** The curves picked in the sketch. */
  private focus = new Set<string>();
  private editing: { id: string; input: HTMLInputElement } | null = null;

  constructor(
    private view: Viewport,
    private sketch: GlyphHost,
  ) {
    this.svg.setAttribute("class", "cdims");
    for (const [p, cls] of [[this.tied, "tied"], [this.lines, "line"], [this.heads, "head"], [this.lit, "lit"], [this.litLines, "line on"], [this.litHeads, "head on"]] as const) {
      p.setAttribute("class", cls);
      this.svg.append(p);
    }
    this.host.append(this.svg);
    document.body.append(this.host);
    view.frameHooks.add(this.hook);
    window.addEventListener("pointermove", this.onMove, { passive: true });
  }

  /** The mouse over a mark: that constraint is the one pointed at. (Marks take no taps themselves - see hitAt.) */
  private onMove = (e: PointerEvent): void => {
    if (e.pointerType !== "mouse" || e.buttons || this.host.hidden || this.editing) return;
    const over = e.target instanceof Element && (e.target === this.view.canvas || this.host.contains(e.target));
    this.setPointed(over ? this.markAt(e.clientX, e.clientY, true) : null);
  };

  /** The constraint to light with all it ties (null: none but the picked one). */
  setPointed(id: string | null): void {
    if (id === this.pointed) return;
    this.pointed = id;
    this.classes();
    this.layout();
  }

  /** The curves picked in the sketch: their constraints stand out, what those tie them to shows faintly. */
  setFocus(ids: Iterable<string>): void {
    const next = new Set(ids);
    if (next.size === this.focus.size && [...next].every((id) => this.focus.has(id))) return;
    this.focus = next;
    this.classes();
    this.layout();
  }

  set(plane: PlaneDef, entities: SketchEntity[], constraints: SketchConstraint[]): void {
    this.plane = plane;
    this.constraints = constraints;
    this.entities = new Map(entities.map((e) => [e.id, e]));
    this.outlines.clear();
    if (this.pointed && !constraints.some((c) => c.id === this.pointed)) this.pointed = null;
    const get = (id: string) => this.entities.get(id);
    this.marks = placeMarks(entities, constraints).map((m) => ({ ...m, x: 0, y: 0, w: 0 }));
    // Sync chips.
    const live = new Set(this.marks.map((m) => m.key));
    for (const [key, chip] of this.chips) if (!live.has(key)) (chip.remove(), this.chips.delete(key));
    for (const m of this.marks) {
      const c = m.c;
      let chip = this.chips.get(m.key);
      if (!chip) {
        chip = el("button", "cglyph");
        chip.addEventListener("pointerdown", (e) => e.stopPropagation());
        chip.addEventListener("click", (e) => (e.stopPropagation(), this.sketch.click(c.id)));
        this.host.append(chip);
        this.chips.set(m.key, chip);
      }
      chip.textContent = label(c, get);
      // Each kind its own colour (recognised at a glance).
      chip.dataset.type = c.type;
      chip.dataset.dim = c.type === "dim" || c.type === "distance" ? "1" : "";
      chip.dataset.expr = c.expr ? "1" : "";
      chip.title = chip.dataset.dim ? `${c.prop ?? "distance"} dimension${c.expr ? ` = ${c.expr}` : ""} (click to type a new size)` : `${c.type} (click to select)`;
      // (About as wide as its text: for the pointer, without asking the page.)
      m.w = chip.dataset.dim ? 14 + chip.textContent.length * 7.3 : 16;
    }
    if (this.editing && !constraints.some((c) => c.id === this.editing!.id)) this.endEdit();
    this.classes();
    this.layout();
  }

  /** The constraint that is lit with all it ties: the one pointed at, else the one picked. */
  private get shown(): string | null {
    return this.pointed ?? this.selected;
  }

  private classes(): void {
    const shown = this.shown;
    for (const m of this.marks) {
      const chip = this.chips.get(m.key);
      if (!chip) continue;
      const mine = this.focus.size > 0 && [m.c, ...m.also].some((c) => refs(c).some((id) => this.focus.has(id)));
      m.mine = mine;
      chip.className = `cglyph${chip.dataset.dim ? " dim" : ""}${m.c.id === shown || m.also.some((c) => c.id === shown) ? " sel" : ""}${mine ? " on" : ""}${chip.dataset.expr ? " expr" : ""}`;
    }
  }

  /**
   * The constraint mark (not a dimension) at a screen point, if any. Marks
   * don't catch taps themselves - the drawing under them always comes first;
   * the sketch asks here when a tap found nothing else.
   */
  hitAt(x: number, y: number): string | null {
    return this.markAt(x, y, false);
  }

  private markAt(x: number, y: number, dims: boolean): string | null {
    if (this.host.hidden) return null;
    for (const m of this.marks) {
      const chip = this.chips.get(m.key);
      if (!chip || chip.hidden || (!dims && m.shape) || (!dims && chip.dataset.dim)) continue;
      if (Math.abs(x - m.x) < m.w / 2 + 4 && Math.abs(y - m.y) < 13) return m.c.id;
    }
    return null;
  }

  /** Show or hide all the badges (the "Show constraints" switch). */
  setVisible(on: boolean): void {
    this.host.hidden = !on;
  }

  /**
   * Tapped to select (in the Select tool), or let through to the drawing under
   * them: a rectangle's width label under its edge took Mirror's tap on the
   * circle there, and the shapes picked so far were let go.
   */
  setTappable(on: boolean): void {
    this.host.classList.toggle("passive", !on);
  }

  // ------------------------------------------------------------ a size typed at the dimension

  /** A box on the dimension itself to type its size into: Enter takes it, Esc leaves it as it was. */
  beginEdit(id: string): void {
    if (this.editing?.id === id) return void this.editing.input.focus();
    this.endEdit();
    const chip = this.chips.get(id);
    if (!chip || !chip.dataset.dim || this.host.hidden) return;
    const input = document.createElement("input");
    input.className = "cglyph-edit";
    input.inputMode = "decimal";
    input.spellcheck = false;
    input.value = this.sketch.text(id);
    numpadInput(input);
    const was = input.value;
    const take = (): boolean => {
      if (input.value.trim() === was.trim()) return true;
      if (this.sketch.edit(id, input.value)) return true;
      input.classList.add("invalid");
      return false;
    };
    input.addEventListener("pointerdown", (e) => e.stopPropagation());
    input.addEventListener("input", () => input.classList.remove("invalid"));
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") (e.preventDefault(), take() && this.endEdit());
      if (e.key === "Escape") (e.preventDefault(), this.endEdit());
    });
    // (Left for somewhere else: the size typed so far is taken if the sketch can take it.)
    input.addEventListener("blur", () => this.editing?.input === input && (take(), this.endEdit()));
    this.host.append(input);
    this.editing = { id, input };
    chip.classList.add("editing");
    this.layout();
    input.focus();
    input.select();
    // (On a touch screen: the number pad, as for every other size.)
    openNumpad(input);
  }

  private endEdit(): void {
    const ed = this.editing;
    if (!ed) return;
    this.editing = null;
    ed.input.remove();
    this.chips.get(ed.id)?.classList.remove("editing");
  }

  // ------------------------------------------------------------ drawn

  private layout(): void {
    const plane = this.plane;
    if (!plane || this.host.hidden) return;
    const to = (p: Vec2) => this.view.toScreen(sketchToWorld(plane, p));
    const shown = this.shown;
    const d = { line: "", head: "", litLine: "", litHead: "" };
    const seg = (a: number[], b: number[]) => `M${a[0].toFixed(1)} ${a[1].toFixed(1)}L${b[0].toFixed(1)} ${b[1].toFixed(1)}`;
    /** An arrowhead with its point at `tip`, pointing the way of (ux, uy). */
    const head = (tip: number[], ux: number, uy: number) => {
      const bx = tip[0] - ux * 8;
      const by = tip[1] - uy * 8;
      return `M${tip[0].toFixed(1)} ${tip[1].toFixed(1)}L${(bx - uy * 3).toFixed(1)} ${(by + ux * 3).toFixed(1)}L${(bx + uy * 3).toFixed(1)} ${(by - ux * 3).toFixed(1)}Z`;
    };
    // Where marks and sizes already are, so that none lies on another (a line's sign and its length are both at
    // its middle; a ring's radius by a tangent's sign - "dimensions and radius or diameter sometimes overlap the
    // constraints"). The small marks first, nearest what they belong to; then each dimension, set further out
    // until its size is clear of them and of the dimensions before it.
    const taken: [number, number, number, number][] = [];
    const clash = (at: number[], hw: number, hh: number) => taken.some(([x, y, w, h]) => Math.abs(at[0] - x) < hw + w + 3 && Math.abs(at[1] - y) < hh + h + 3);
    for (const m of [...this.marks].sort((a, b) => (a.shape ? 1 : 0) - (b.shape ? 1 : 0))) {
      const chip = this.chips.get(m.key);
      if (!chip) continue;
      const s = to(m.at);
      chip.hidden = !s;
      if (!s) continue;
      // "Outside" on screen: the sketch direction as the view shows it (any turn, any zoom).
      const s2 = to([m.at[0] + m.dir[0] * 1e-3, m.at[1] + m.dir[1] * 1e-3]);
      let dx = s2 ? s2[0] - s[0] : 1;
      let dy = s2 ? s2[1] - s[1] : 1;
      const l = Math.hypot(dx, dy);
      // Looking along the sketch (edge-on): no way out on screen - right and below.
      [dx, dy] = l > 1e-9 ? [dx / l, dy / l] : [Math.SQRT1_2, Math.SQRT1_2];
      // How far out. A dimension: far enough that its size, which lies level, clears the line it measures whichever
      // way that line runs (beside an upright line the box was across it: "on vertical lines, the line dimension
      // box goes over the line"). On a picked curve: out past the handle that comes up there to move it ("the
      // moving gimbal is over the constraints").
      let dist0 = m.dist;
      if (m.shape?.kind === "span") dist0 = Math.max(dist0 + 6, Math.abs(dx) * (m.w / 2) + Math.abs(dy) * 11 + 12 + (m.dist - 22));
      // (An angle's arc is at the corner, not where the handle is.)
      if (m.mine && m.shape?.kind !== "angle") dist0 += GIMBAL_REACH;
      const on = m.c.id === shown;
      // What it measures is too small on screen to carry a dimension (the whole sketch seen at once, on a phone
      // above all: every size piled on the next): left out until it is zoomed to - unless it is the one picked or
      // pointed at, or on a curve that is picked.
      if (m.shape && !on && !m.mine && this.editing?.id !== m.key && this.tooSmall(m.shape, to)) {
        chip.hidden = true;
        continue;
      }
      let line = "";
      let heads = "";
      let at: number[] = s;
      const sh = m.shape;
      const [hw, hh] = [m.w / 2, sh ? 11 : 7];
      // (A few steps further out at most: past that it would be nowhere near what it belongs to.)
      // Further out a step at a time; a length whose own side is full, on the line's other side. Nowhere free: where
      // it would have gone to begin with.
      const tries: [number, number][] = sh?.kind === "span" ? [[1, 0], [1, 1], [1, 2], [-1, 0], [-1, 1], [1, 3], [-1, 2], [1, 0]] : [[1, 0], [1, 1], [1, 2], [1, 3], [1, 4], [1, 0]];
      for (const [side, step] of tries) {
        const dist = dist0 + step * (sh ? 20 : 15);
        const [ox, oy] = [dx * side, dy * side];
        line = "";
        heads = "";
        at = [s[0] + ox * (dist + 4), s[1] + oy * (dist + 4)];
        if (sh?.kind === "span") {
          const a = to(sh.a);
          const b = to(sh.b);
          if (a && b) {
            // Thin lines out from the two ends, past the dimension's own line; that line between them, with arrows
            // where it is long enough for them; the size at its middle.
            const a2 = [a[0] + ox * dist, a[1] + oy * dist];
            const b2 = [b[0] + ox * dist, b[1] + oy * dist];
            line = seg([a[0] + ox * 4, a[1] + oy * 4], [a2[0] + ox * 5, a2[1] + oy * 5]) + seg([b[0] + ox * 4, b[1] + oy * 4], [b2[0] + ox * 5, b2[1] + oy * 5]) + seg(a2, b2);
            const len = Math.hypot(b2[0] - a2[0], b2[1] - a2[1]);
            if (len > 34) {
              const ux = (b2[0] - a2[0]) / len;
              const uy = (b2[1] - a2[1]) / len;
              heads = head(a2, -ux, -uy) + head(b2, ux, uy);
            }
            at = [(a2[0] + b2[0]) / 2, (a2[1] + b2[1]) / 2];
            // (Too short for its size to sit on it: the size past its end, in line with it.)
            if (len < m.w + 22 && len > 1e-6) at = [b2[0] + ((b2[0] - a2[0]) / len) * (m.w / 2 + 8), b2[1] + ((b2[1] - a2[1]) / len) * (m.w / 2 + 8)];
          }
        } else if (sh?.kind === "round") {
          const c = to(sh.c);
          const rim = to(sh.rim);
          if (c && rim) {
            const len = Math.hypot(rim[0] - c[0], rim[1] - c[1]) || 1;
            const ux = (rim[0] - c[0]) / len;
            const uy = (rim[1] - c[1]) / len;
            // From the middle (a radius) or the far rim (a diameter) out through the rim, the size past it.
            const from = sh.across ? [c[0] - ux * len, c[1] - uy * len] : c;
            const out = [rim[0] + ux * (dist - 6), rim[1] + uy * (dist - 6)];
            line = seg(from, out);
            heads = head(rim, ux, uy) + (sh.across ? head(from, -ux, -uy) : "");
            at = [out[0] + ux * (m.w / 2 + 4), out[1] + uy * (m.w / 2 + 4)];
          }
        } else if (sh?.kind === "angle") {
          const v = to(sh.v);
          const p1 = to([sh.v[0] + sh.d1[0] * 1e-3, sh.v[1] + sh.d1[1] * 1e-3]);
          const p2 = to([sh.v[0] + sh.d2[0] * 1e-3, sh.v[1] + sh.d2[1] * 1e-3]);
          if (v && p1 && p2) {
            const a1 = Math.atan2(p1[1] - v[1], p1[0] - v[0]);
            const a2 = Math.atan2(p2[1] - v[1], p2[0] - v[0]);
            let sweep = a2 - a1;
            while (sweep > Math.PI) sweep -= 2 * Math.PI;
            while (sweep < -Math.PI) sweep += 2 * Math.PI;
            const r = 26 + (dist - 22);
            const q1 = [v[0] + r * Math.cos(a1), v[1] + r * Math.sin(a1)];
            const q2 = [v[0] + r * Math.cos(a2), v[1] + r * Math.sin(a2)];
            // An arc from one way round to the other, the size outside its middle.
            line = `M${q1[0].toFixed(1)} ${q1[1].toFixed(1)}A${r} ${r} 0 0 ${sweep > 0 ? 1 : 0} ${q2[0].toFixed(1)} ${q2[1].toFixed(1)}`;
            const am = a1 + sweep / 2;
            at = [v[0] + (r + m.w / 2 + 6) * Math.cos(am), v[1] + (r + 14) * Math.sin(am)];
          }
        }
        if (!clash(at, hw, hh)) break;
      }
      taken.push([at[0], at[1], hw, hh]);
      if (on) (d.litLine += line), (d.litHead += heads);
      else (d.line += line), (d.head += heads);
      m.x = at[0];
      m.y = at[1];
      chip.style.transform = `translate(${Math.round(at[0])}px, ${Math.round(at[1])}px) translate(-50%, -50%)`;
      if (this.editing?.id === m.key) this.editing.input.style.transform = chip.style.transform;
    }
    this.lines.setAttribute("d", d.line);
    this.heads.setAttribute("d", d.head);
    this.litLines.setAttribute("d", d.litLine);
    this.litHeads.setAttribute("d", d.litHead);
    // What the lit constraint ties, drawn over; and, with curves picked, what their constraints tie them to.
    const stroke = (ids: Iterable<string>, points: Vec2[] = []) => {
      let out = "";
      for (const id of ids) {
        let lines = this.outlines.get(id);
        const e = this.entities.get(id);
        if (!lines && e) this.outlines.set(id, (lines = entityPolylines(e)));
        for (const poly of lines ?? []) {
          let pen = "M";
          for (const p of poly) {
            const s = to(p);
            if (!s) continue;
            out += `${pen}${s[0].toFixed(1)} ${s[1].toFixed(1)}`;
            pen = "L";
          }
        }
      }
      for (const p of points) {
        const s = to(p);
        if (s) out += `M${(s[0] - 5).toFixed(1)} ${s[1].toFixed(1)}a5 5 0 1 0 10 0a5 5 0 1 0 -10 0`;
      }
      return out;
    };
    const one = shown ? this.constraints.find((c) => c.id === shown) : undefined;
    const pointsOfIt = (c: SketchConstraint): Vec2[] => (c.pts ?? []).flatMap((p) => {
      const e = this.entities.get(p.e);
      const at = e ? pointOf(e, p.p) : null;
      return at ? [at] : [];
    });
    this.lit.setAttribute("d", one ? stroke(one.curves ?? [], pointsOfIt(one)) : "");
    const partners = new Set<string>();
    if (this.focus.size && !one) for (const c of this.constraints) {
      if (c.type === "pattern" || c.type === "follow") continue;
      const ids = refs(c);
      if (ids.some((id) => this.focus.has(id))) for (const id of ids) if (!this.focus.has(id)) partners.add(id);
    }
    this.tied.setAttribute("d", stroke(partners));
  }

  /** Is what a dimension measures only a few pixels on screen? */
  private tooSmall(sh: DimShape, to: (p: Vec2) => number[] | null): boolean {
    const [p, q] = sh.kind === "span" ? [sh.a, sh.b] : sh.kind === "round" ? [sh.c, sh.rim] : [sh.v, [sh.v[0] + sh.d2[0], sh.v[1] + sh.d2[1]] as Vec2];
    const a = to(p);
    const b = to(q);
    if (!a || !b) return false;
    const px = Math.hypot(a[0] - b[0], a[1] - b[1]);
    // (An angle: by how big one unit of the sketch is - a millimetre a pixel or two is the whole drawing in a thumb's width.)
    return sh.kind === "span" ? px < 34 : sh.kind === "round" ? px < 11 : px < 1.6;
  }

  dispose(): void {
    this.endEdit();
    window.removeEventListener("pointermove", this.onMove);
    this.view.frameHooks.delete(this.hook);
    this.host.remove();
  }
}

/** Every curve a constraint names, by its curves and by its points. */
const refs = (c: SketchConstraint): string[] => [...(c.curves ?? []), ...(c.pts ?? []).map((p) => p.e)];

function label(c: SketchConstraint, get: (id: string) => SketchEntity | undefined): string {
  if (c.type === "dim") {
    const e = c.curves?.[0] ? get(c.curves[0]) : undefined;
    const v = c.value ?? (e && c.prop ? sizeOf(e, c.prop) : 0) ?? 0;
    const name = c.expr && /[a-z_]/i.test(c.expr) ? `${c.expr} = ` : "";
    if (c.prop === "angle") return `${name}${trim(v, 2)}°`;
    if (c.prop === "radius") return `${name}R ${fmtLen(v)}`;
    if (c.prop === "diameter") return `${name}⌀ ${fmtLen(v)}`;
    return `${name}${fmtLen(v)}`;
  }
  if (c.type === "distance") return fmtLen(c.value ?? 0);
  return GLYPH[c.type] ?? "?";
}
