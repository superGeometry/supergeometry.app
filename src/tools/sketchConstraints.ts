// Sketch constraint UI: the constraint button column, building constraints from
// the selection, and the badges/dimension labels drawn next to the geometry.

import type { ConstraintType, PlaneDef, PointRef, SketchConstraint, SketchEntity, Vec2 } from "../doc/types";
import { applicable, pointOf, pointsOf, sizeOf } from "../sketch/constraints";
import { arcFrom3 } from "../sketch/curves";
import { uid } from "../sketch/edit";
import { el } from "../ui/ui";
import { fmtLen, trim } from "../units";
import type { Viewport } from "../view/viewport";
import { sketchToWorld } from "../view/viewport";

export const CONSTRAINT_BUTTONS: { type: ConstraintType | "hv"; label: string; glyph: string; key: string }[] = [
  { type: "parallel", label: "Parallel", glyph: "∥", key: "A" },
  { type: "perpendicular", label: "Perpendicular", glyph: "⟂", key: "P" },
  { type: "tangent", label: "Tangent", glyph: "T", key: "T" },
  { type: "coincident", label: "Coincident", glyph: "●", key: "N" },
  { type: "midpoint", label: "Midpoint", glyph: "M", key: "M" },
  { type: "concentric", label: "Concentric", glyph: "◎", key: "C" },
  { type: "hv", label: "Horizontal/Vertical", glyph: "H/V", key: "V" },
  { type: "equal", label: "Equal", glyph: "=", key: "E" },
  { type: "symmetric", label: "Symmetry", glyph: "⇋", key: "S" },
  { type: "fix", label: "Lock", glyph: "🔒", key: "L" },
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

/** Constraints for a button press, from the current selection (empty if it doesn't fit). */
export function buildConstraints(type: ConstraintType | "hv", pts: PointRef[], curves: SketchEntity[]): SketchConstraint[] {
  if (type === "hv") {
    if (curves.length === 1 && curves[0].kind === "line" && !pts.length) {
      const l = curves[0];
      const horiz = Math.abs(l.b[0] - l.a[0]) >= Math.abs(l.b[1] - l.a[1]);
      return [{ id: uid(), type: horiz ? "horizontal" : "vertical", curves: [l.id] }];
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
      const sizes = curves.flatMap((e): SketchConstraint[] => (e.kind === "circle" ? [{ id: uid(), type: "dim", curves: [e.id], prop: "diameter", value: 2 * e.radius }] : []));
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
    if (!types.includes(c.type)) return false;
    const cv = c.curves ?? [];
    const cp = c.pts ?? [];
    if (!cv.length && !cp.length) return false;
    if (type === "fix") return cp.every(ptIn);
    // Every curve and point it involves is in the selection.
    return cv.every((id) => ids.has(id)) && cp.every(ptIn) && (cv.length + cp.length > 1 || ids.size + pts.length === 1);
  });
}

export function buttonEnabled(type: ConstraintType | "hv", pts: PointRef[], curves: SketchEntity[]): boolean {
  return buildConstraints(type, pts, curves).length > 0;
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

/** Badges + dimension labels for the constraints of the sketch being edited. */
export class ConstraintGlyphs {
  private host = el("div", "cglyphs");
  private chips = new Map<string, HTMLElement>();
  private hook = () => this.layout();
  private items: { c: SketchConstraint; at: Vec2; off: [number, number] }[] = [];
  private plane: PlaneDef | null = null;
  selected: string | null = null;

  constructor(
    private view: Viewport,
    private onClick: (id: string) => void,
  ) {
    document.body.append(this.host);
    view.frameHooks.add(this.hook);
  }

  set(plane: PlaneDef, entities: SketchEntity[], constraints: SketchConstraint[]): void {
    this.plane = plane;
    const get = (id: string) => entities.find((e) => e.id === id);
    const mid = (e: SketchEntity): Vec2 | null => {
      if (e.kind === "line") return [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2];
      if (e.kind === "arc") return e.m;
      if (e.kind === "circle" || e.kind === "ellipse" || e.kind === "rect" || e.kind === "polygon") return e.center;
      return e.points[0] ?? null;
    };
    this.items = [];
    // Several badges at one spot are fanned out so they stay readable.
    const counts = new Map<string, number>();
    for (const c of constraints) {
      let at: Vec2 | null = null;
      if (c.pts?.length) {
        const e = get(c.pts[0].e);
        at = e ? pointOf(e, c.pts[0].p) : null;
      } else if (c.curves?.length) {
        const e = get(c.curves[0]);
        at = e ? mid(e) : null;
        if (e && c.type === "dim" && (c.prop === "radius" || c.prop === "diameter")) {
          const r = e.kind === "circle" ? e.radius : e.kind === "arc" ? (arcFrom3(e.a, e.m, e.b)?.r ?? 0) : e.kind === "polygon" ? e.radius : 0;
          const ctr = e.kind === "arc" ? (arcFrom3(e.a, e.m, e.b)?.c ?? at!) : at!;
          at = [ctr[0] + r * 0.707, ctr[1] + r * 0.707];
        }
        if (e && c.type === "dim" && e.kind === "rect" && (c.prop === "w" || c.prop === "h")) {
          const cs = Math.cos(e.rotation);
          const sn = Math.sin(e.rotation);
          const off = c.prop === "w" ? [0, -e.h / 2] : [e.w / 2, 0];
          at = [e.center[0] + off[0] * cs - off[1] * sn, e.center[1] + off[0] * sn + off[1] * cs];
        }
      }
      if (!at) continue;
      const k = `${at[0].toFixed(4)},${at[1].toFixed(4)}`;
      const n = counts.get(k) ?? 0;
      counts.set(k, n + 1);
      const isDim = c.type === "dim" || c.type === "distance";
      this.items.push({ c, at, off: isDim ? [0, -16] : [14 + n * 18, 12] });
    }
    // Sync chips.
    const live = new Set(this.items.map((i) => i.c.id));
    for (const [id, chip] of this.chips) if (!live.has(id)) (chip.remove(), this.chips.delete(id));
    for (const { c } of this.items) {
      let chip = this.chips.get(c.id);
      if (!chip) {
        chip = el("button", "cglyph");
        chip.addEventListener("pointerdown", (e) => e.stopPropagation());
        chip.addEventListener("click", (e) => (e.stopPropagation(), this.onClick(c.id)));
        this.host.append(chip);
        this.chips.set(c.id, chip);
      }
      chip.className = `cglyph${c.type === "dim" || c.type === "distance" ? " dim" : ""}${c.id === this.selected ? " sel" : ""}${c.expr ? " expr" : ""}`;
      chip.textContent = label(c, get);
      // Each kind its own colour (recognised at a glance).
      chip.dataset.type = c.type;
      chip.title = c.type === "dim" ? `${c.prop} dimension${c.expr ? ` = ${c.expr}` : ""} (click to edit)` : `${c.type} (click to select)`;
    }
    this.layout();
  }

  /**
   * The constraint mark (not a dimension) at a screen point, if any. Marks
   * don't catch taps themselves — the drawing under them always comes first;
   * the sketch asks here when a tap found nothing else.
   */
  hitAt(x: number, y: number): string | null {
    if (this.host.hidden) return null;
    for (const [id, chip] of this.chips) {
      if (chip.hidden || chip.classList.contains("dim")) continue;
      const r = chip.getBoundingClientRect();
      if (x > r.left - 4 && x < r.right + 4 && y > r.top - 4 && y < r.bottom + 4) return id;
    }
    return null;
  }

  /** Show or hide all the badges (the "Show constraints" switch). */
  setVisible(on: boolean): void {
    this.host.hidden = !on;
  }

  private layout(): void {
    if (!this.plane) return;
    for (const it of this.items) {
      const chip = this.chips.get(it.c.id);
      if (!chip) continue;
      const s = this.view.toScreen(sketchToWorld(this.plane, it.at));
      chip.hidden = !s;
      if (s) chip.style.transform = `translate(${Math.round(s[0] + it.off[0])}px, ${Math.round(s[1] + it.off[1])}px) translate(-50%, -50%)`;
    }
  }

  dispose(): void {
    this.view.frameHooks.delete(this.hook);
    this.host.remove();
  }
}

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
