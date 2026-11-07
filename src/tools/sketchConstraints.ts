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
  /** Each mark: where on the drawing, which way is "outside" there (sketch units), and how far out (px). */
  private items: { c: SketchConstraint; at: Vec2; dir: Vec2; dist: number }[] = [];
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
    const inside = shapeCentres(entities);
    const norm = (v: Vec2): Vec2 | null => {
      const l = Math.hypot(v[0], v[1]);
      return l > 1e-9 ? [v[0] / l, v[1] / l] : null;
    };
    // Away from the middle of the shape it belongs to (off the blue fill of a closed one).
    const away = (e: SketchEntity, p: Vec2, fallback: Vec2): Vec2 => {
      const c = inside.get(e.id);
      const d = c && norm([p[0] - c[0], p[1] - c[1]]);
      return d ?? fallback;
    };
    // Several badges at one spot are fanned out (further out) so they stay readable.
    const counts = new Map<string, number>();
    for (const c of constraints) {
      // A mark only while everything it ties together is still drawn.
      if (![...(c.pts ?? []).map((p) => p.e), ...(c.curves ?? [])].every((id) => get(id))) continue;
      let at: Vec2 | null = null;
      let dir: Vec2 = [Math.SQRT1_2, -Math.SQRT1_2];
      if (c.pts?.length) {
        const e = get(c.pts[0].e);
        at = e ? pointOf(e, c.pts[0].p) : null;
        if (e && at) dir = away(e, at, dir);
      } else if (c.curves?.length) {
        const e = get(c.curves[0]);
        at = e ? mid(e) : null;
        if (e && at) {
          if (e.kind === "line") {
            // Square off the line, on the side away from its shape's middle.
            const n = norm([-(e.b[1] - e.a[1]), e.b[0] - e.a[0]]) ?? dir;
            const c0 = inside.get(e.id);
            const flip = c0 && (at[0] - c0[0]) * n[0] + (at[1] - c0[1]) * n[1] < 0;
            dir = flip ? [-n[0], -n[1]] : n;
          } else if (e.kind === "arc") {
            const ac = arcFrom3(e.a, e.m, e.b)?.c;
            const out = ac ? norm([e.m[0] - ac[0], e.m[1] - ac[1]]) : null;
            dir = away(e, at, out ?? dir);
          } else if (e.kind === "circle" || e.kind === "polygon") {
            // Closed round shapes: on the rim at the top right, outside it.
            dir = [Math.SQRT1_2, Math.SQRT1_2];
            at = [e.center[0] + e.radius * dir[0], e.center[1] + e.radius * dir[1]];
          } else if (e.kind === "ellipse" || e.kind === "rect") {
            const [hx, hy] = e.kind === "ellipse" ? [e.rx * Math.SQRT1_2, e.ry * Math.SQRT1_2] : [e.w / 2, e.h / 2];
            const cs = Math.cos(e.rotation);
            const sn = Math.sin(e.rotation);
            at = [e.center[0] + hx * cs - hy * sn, e.center[1] + hx * sn + hy * cs];
            dir = norm([at[0] - e.center[0], at[1] - e.center[1]]) ?? dir;
          } else {
            dir = away(e, at, dir);
          }
        }
        if (e && c.type === "dim" && (c.prop === "radius" || c.prop === "diameter")) {
          const r = e.kind === "circle" ? e.radius : e.kind === "arc" ? (arcFrom3(e.a, e.m, e.b)?.r ?? 0) : e.kind === "polygon" ? e.radius : 0;
          const ctr = e.kind === "arc" ? (arcFrom3(e.a, e.m, e.b)?.c ?? at!) : at!;
          at = [ctr[0] + r * 0.707, ctr[1] + r * 0.707];
          dir = [Math.SQRT1_2, Math.SQRT1_2];
        }
        if (e && c.type === "dim" && e.kind === "rect" && (c.prop === "w" || c.prop === "h")) {
          const cs = Math.cos(e.rotation);
          const sn = Math.sin(e.rotation);
          const off = c.prop === "w" ? [0, -e.h / 2] : [e.w / 2, 0];
          at = [e.center[0] + off[0] * cs - off[1] * sn, e.center[1] + off[0] * sn + off[1] * cs];
          dir = norm([at[0] - e.center[0], at[1] - e.center[1]]) ?? dir;
        }
      }
      if (!at) continue;
      const k = `${at[0].toFixed(4)},${at[1].toFixed(4)}`;
      const n = counts.get(k) ?? 0;
      counts.set(k, n + 1);
      const isDim = c.type === "dim" || c.type === "distance";
      this.items.push({ c, at, dir, dist: isDim ? 18 + n * 20 : 14 + n * 18 });
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
   * don't catch taps themselves - the drawing under them always comes first;
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
      if (!s) continue;
      // "Outside" on screen: the sketch direction as the view shows it (any turn, any zoom).
      const s2 = this.view.toScreen(sketchToWorld(this.plane, [it.at[0] + it.dir[0] * 1e-3, it.at[1] + it.dir[1] * 1e-3]));
      let dx = s2 ? s2[0] - s[0] : 1;
      let dy = s2 ? s2[1] - s[1] : 1;
      const l = Math.hypot(dx, dy);
      // Looking along the sketch (edge-on): no way out on screen - right and below.
      [dx, dy] = l > 1e-9 ? [dx / l, dy / l] : [Math.SQRT1_2, Math.SQRT1_2];
      // A mark is ~16 px across: its centre goes far enough out that all of it clears the line.
      const d = it.dist + 4;
      chip.style.transform = `translate(${Math.round(s[0] + dx * d)}px, ${Math.round(s[1] + dy * d)}px) translate(-50%, -50%)`;
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

/**
 * The middle of the shape each curve belongs to: curves joined end to end
 * make one shape (a rectangle of four lines, a slot of lines and arcs); a
 * circle, ellipse, rectangle or polygon is its own. Marks go away from it.
 */
function shapeCentres(entities: SketchEntity[]): Map<string, Vec2> {
  const parent = entities.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const ends = (e: SketchEntity): Vec2[] => {
    if (e.kind === "line" || e.kind === "arc") return [e.a, e.b];
    if ((e.kind === "spline" || e.kind === "polyline") && !e.closed && e.points.length) return [e.points[0], e.points[e.points.length - 1]];
    return [];
  };
  // Ends at the same spot (joined): one shape. (Hashed, so big sketches stay quick.)
  const at = new Map<string, number>();
  entities.forEach((e, i) => {
    for (const p of ends(e)) {
      const k = `${p[0].toFixed(5)},${p[1].toFixed(5)}`;
      const j = at.get(k);
      if (j === undefined) at.set(k, i);
      else parent[find(i)] = find(j);
    }
  });
  const samples = (e: SketchEntity): Vec2[] => {
    if (e.kind === "line") return [e.a, e.b];
    if (e.kind === "arc") return [e.a, e.m, e.b];
    if (e.kind === "spline" || e.kind === "polyline") return e.points;
    return [e.center];
  };
  const sum = new Map<number, [number, number, number]>();
  entities.forEach((e, i) => {
    const r = find(i);
    const s = sum.get(r) ?? [0, 0, 0];
    for (const p of samples(e)) (s[0] += p[0]), (s[1] += p[1]), (s[2] += 1);
    sum.set(r, s);
  });
  const out = new Map<string, Vec2>();
  entities.forEach((e, i) => {
    const s = sum.get(find(i))!;
    if (s[2]) out.set(e.id, [s[0] / s[2], s[1] / s[2]]);
  });
  return out;
}
