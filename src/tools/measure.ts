import type { PinDef, Vec3 } from "../doc/types";
import { settings } from "../settings";
import { cross, dist, dot, len, sub } from "../geom";
import type { BodyMesh } from "../kernel/protocol";
import { icons } from "../ui/icons";
import { el } from "../ui/ui";
import { fmtLen, trim, UNIT_MM, UNIT_LABEL, units } from "../units";
import type { ToolPointer } from "../view/input";
import { hitToSel, sameSel, type AppContext, type Sel, type Tool } from "./tool";

export interface MeasureHost extends AppContext {
  readonly pins: PinDef[];
  setPins(p: PinDef[]): void;
}

interface Row {
  name: string;
  value: string;
  at: Vec3;
  a?: Vec3;
  b?: Vec3;
}

/** Where the Measure window was moved to (its top left corner, on the page): it opens there again. */
let placed: { x: number; y: number } | null = null;

/**
 * Measure: tap faces, edges or bodies; a window lists what can be measured
 * about them (and between two of them). Pin any value to keep it visible.
 *
 * The window is moved by its top bar and closed by its X. It stays short: the values of what is picked, and under
 * them the pinned ones in a list of their own that scrolls - many pins do not make the window any taller.
 */
export class MeasureTool implements Tool {
  readonly id = "measure";
  private items: Sel[] = [];
  private card: HTMLElement | null = null;
  private deltas = false;

  constructor(private app: MeasureHost) {}

  enter(): void {
    this.app.ui.setTools([{ id: "exit", label: "Exit Measure", icon: "exit", shortcut: "Esc", run: () => this.app.setTool(null) }]);
    // The view tools stay, this one lit and pulsing (tap it again to close it).
    this.app.ui.setBottom(this.app.bottomTools());
    this.app.ui.setHint("Tap faces, edges or points to see their sizes. Double-tap for a whole body.");
    this.card = el("div", "measure-card");
    document.body.append(this.card);
    if (placed) this.moveTo(placed.x, placed.y);
    // (The page made smaller, the phone turned: back inside it.)
    window.addEventListener("resize", this.keepIn);
    this.render();
  }

  private keepIn = (): void => {
    if (placed) this.moveTo(placed.x, placed.y);
  };

  /** The window with its top left corner there - as near as the page lets it be (it never leaves it). */
  private moveTo(x: number, y: number): void {
    const c = this.card;
    if (!c) return;
    const r = c.getBoundingClientRect();
    const nx = Math.max(4, Math.min(window.innerWidth - r.width - 4, x));
    const ny = Math.max(4, Math.min(window.innerHeight - Math.min(r.height, 80) - 4, y));
    c.style.width = `${r.width}px`;
    c.style.left = `${nx}px`;
    c.style.top = `${ny}px`;
    c.style.right = "auto";
    c.style.bottom = "auto";
    placed = { x: nx, y: ny };
  }

  exit(): void {
    window.removeEventListener("resize", this.keepIn);
    this.card?.remove();
    this.app.ui.setHint(null);
    this.app.setSelection([]);
    this.app.setHover(null);
  }

  hover(p: ToolPointer | null): void {
    this.app.setHover(p ? hitToSel(this.app.view.pick(p.x, p.y, { edgeTolPx: p.tol, profiles: false, planes: false })) : null);
  }

  tap(p: ToolPointer, count: number): void {
    let s = hitToSel(this.app.view.pick(p.x, p.y, { edgeTolPx: p.tol, profiles: false, planes: false }));
    if (!s) {
      // Empty space: first clears, second leaves Measure.
      if (!this.items.length) return this.app.setTool(null);
      this.items = [];
    } else {
      if (count >= 2 && (s.kind === "face" || s.kind === "edge" || s.kind === "vertex")) s = { kind: "body", body: s.body };
      const i = this.items.findIndex((x) => sameSel(x, s!));
      if (i >= 0) this.items.splice(i, 1);
      else this.items = [...this.items.slice(-1), s];
    }
    this.app.setSelection(this.items);
    this.render();
  }

  key(e: KeyboardEvent): boolean {
    if (e.key === "Escape") {
      if (this.items.length) {
        this.items = [];
        this.app.setSelection([]);
        this.render();
      } else this.app.setTool(null);
      return true;
    }
    return false;
  }

  private render(): void {
    if (!this.card) return;
    // (Where its pinned list was scrolled to stays, as the rest is drawn again.)
    const scrolled = this.card.querySelector(".measure-pins")?.scrollTop ?? 0;
    this.card.innerHTML = "";
    // Its top bar: the window is moved by it; the X closes Measure.
    const bar = el("div", "measure-bar");
    bar.append(el("div", "panel-title", "Measure"));
    const close = el("button", "icon-btn");
    close.type = "button";
    close.title = "Close Measure";
    close.innerHTML = icons.close;
    close.addEventListener("pointerdown", (e) => e.stopPropagation());
    close.addEventListener("click", () => this.app.setTool(null));
    bar.append(close);
    let grab: { id: number; dx: number; dy: number } | null = null;
    bar.addEventListener("pointerdown", (e) => {
      const r = this.card!.getBoundingClientRect();
      grab = { id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top };
      bar.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    bar.addEventListener("pointermove", (e) => {
      if (grab && e.pointerId === grab.id) this.moveTo(e.clientX - grab.dx, e.clientY - grab.dy);
    });
    const drop = (e: PointerEvent) => {
      if (grab && e.pointerId === grab.id) grab = null;
    };
    bar.addEventListener("pointerup", drop);
    bar.addEventListener("pointercancel", drop);
    this.card.append(bar);
    const rows = this.measurements();
    const head = el("label", "measure-toggle");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = this.deltas;
    box.addEventListener("change", () => ((this.deltas = box.checked), this.render()));
    head.append(box, " Include X, Y, Z deltas");
    const show = el("label", "measure-toggle");
    const sbox = document.createElement("input");
    sbox.type = "checkbox";
    sbox.checked = settings.value.showPinned;
    sbox.addEventListener("change", () => settings.set("showPinned", sbox.checked));
    show.append(sbox, " Show pinned measurements");
    this.card.append(head, show);
    if (!rows.length) this.card.append(el("div", "measure-empty", "Nothing selected"));
    for (const r of rows) {
      const row = el("div", "measure-row");
      row.append(el("div", "measure-value", r.value), el("div", "measure-name", r.name));
      const pin = el("button", "icon-btn", "📌");
      pin.title = "Pin to always show";
      pin.addEventListener("click", () => (this.app.addPin({ text: r.value, at: r.at, a: r.a, b: r.b }), this.render()));
      row.append(pin);
      this.card.append(row);
    }
    // The pinned ones: a list of their own, a few lines tall, that scrolls - however many there are.
    const pins = this.app.pins;
    if (pins.length) {
      const head = el("div", "measure-pins-head");
      head.append(el("span", "", `Pinned (${pins.length})`));
      const clear = el("button", "text-btn", "Clear all");
      clear.addEventListener("click", () => (this.app.setPins([]), this.render()));
      head.append(clear);
      const list = el("div", "measure-pins");
      pins.forEach((p, i) => {
        const row = el("div", "measure-pin");
        row.append(el("div", "measure-value", p.text));
        const off = el("button", "icon-btn");
        off.type = "button";
        off.title = "Unpin";
        off.innerHTML = icons.close;
        off.addEventListener("click", () => (this.app.setPins(this.app.pins.filter((_, k) => k !== i)), this.render()));
        row.append(off);
        list.append(row);
      });
      this.card.append(head, list);
      list.scrollTop = scrolled;
    }
    // (Drawn again taller or shorter: still inside the page.)
    if (placed) this.moveTo(placed.x, placed.y);
  }

  private measurements(): Row[] {
    const out: Row[] = [];
    const info = this.items.map((s) => this.describe(s)).filter((x): x is Described => !!x);
    for (const d of info) out.push(...d.rows);
    if (info.length === 2) {
      const [a, b] = info;
      const mid = (p: Vec3, q: Vec3): Vec3 => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];
      out.push({ name: "Distance (centers)", value: fmtLen(dist(a.anchor, b.anchor)), at: mid(a.anchor, b.anchor), a: a.anchor, b: b.anchor });
      const m = closestPair(a.points, b.points);
      out.push({ name: "Minimum distance", value: fmtLen(m.d), at: mid(m.p, m.q), a: m.p, b: m.q });
      if (this.deltas) {
        const d = sub(b.anchor, a.anchor);
        ["X", "Y", "Z"].forEach((n, i) => {
          const end = [...a.anchor] as Vec3;
          end[i] = b.anchor[i];
          out.push({ name: `Δ${n}`, value: fmtLen(Math.abs(d[i])), at: mid(a.anchor, end), a: a.anchor, b: end });
        });
      }
      if (a.dir && b.dir) {
        const ang = (Math.acos(Math.min(1, Math.abs(dot(a.dir, b.dir)))) * 180) / Math.PI;
        out.push({ name: "Angle", value: `${trim(ang, 2)}°`, at: mid(a.anchor, b.anchor) });
      }
    }
    return out;
  }

  private describe(s: Sel): Described | null {
    if (s.kind !== "face" && s.kind !== "edge" && s.kind !== "body" && s.kind !== "vertex") return null;
    const b = this.app.view.body(s.body);
    if (!b) return null;
    if (s.kind === "vertex") {
      const v = this.app.view.vertexOf(s.body, s.vertex);
      if (!v) return null;
      const u = UNIT_MM[units()];
      return { rows: [{ name: "Point (X, Y, Z)", value: v.map((c) => trim(c / u, 3)).join(", "), at: v }], anchor: v, points: [v] };
    }
    if (s.kind === "face") {
      const f = b.faces[s.face];
      const pts = facePoints(b, s.face);
      const rows: Row[] = [{ name: `Surface area · ${niceType(f.type)}`, value: fmtArea(f.area), at: f.center }];
      // A round face (a shaft, a hole): its diameter, pinned as a line straight across it.
      if (f.round) {
        const r = f.round.r;
        const across = acrossCylinder(b, s.face, r, f.round.hole, f.center);
        rows.push({ name: f.round.hole ? "Diameter · hole" : "Diameter", value: `Ø ${fmtLen(2 * r)}`, at: across?.mid ?? f.center, ...(across ? { a: across.a, b: across.b } : {}) });
        rows.push({ name: "Radius", value: `R ${fmtLen(r)}`, at: across?.b ?? f.center, ...(across ? { a: across.mid, b: across.b } : {}) });
      }
      return { rows, anchor: f.center, points: pts, dir: f.plane ? f.normal : undefined };
    }
    if (s.kind === "edge") {
      const e = b.edges[s.edge];
      const pts = edgePoints(b, s.edge);
      const rows: Row[] = [{ name: `Length · ${niceType(e.type)}`, value: fmtLen(e.length), at: e.mid, ...(e.type === "LINE" ? { a: e.start, b: e.end } : {}) }];
      if (e.type === "CIRCLE" && pts.length >= 3) {
        const r = circumradius(pts[0], pts[Math.floor(pts.length / 3)], pts[Math.floor((2 * pts.length) / 3)]);
        if (r) rows.push({ name: "Diameter", value: fmtLen(2 * r), at: e.mid }, { name: "Radius", value: fmtLen(r), at: e.mid });
      }
      return { rows, anchor: e.mid, points: pts, dir: e.type === "LINE" ? e.dir : undefined };
    }
    const pts: Vec3[] = [];
    for (let i = 0; i < b.positions.length; i += 3) pts.push([b.positions[i], b.positions[i + 1], b.positions[i + 2]]);
    const min = [0, 1, 2].map((k) => Math.min(...pts.map((p) => p[k])));
    const max = [0, 1, 2].map((k) => Math.max(...pts.map((p) => p[k])));
    const center: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    const area = b.faces.reduce((s2, f) => s2 + f.area, 0);
    return {
      rows: [
        { name: "Size (X × Y × Z)", value: `${trim((max[0] - min[0]) / UNIT_MM[units()], 3)} × ${trim((max[1] - min[1]) / UNIT_MM[units()], 3)} × ${fmtLen(max[2] - min[2])}`, at: center },
        { name: "Surface area", value: fmtArea(area), at: center },
        { name: "Volume", value: fmtVolume(volume(b)), at: center },
      ],
      anchor: center,
      points: pts,
    };
  }
}

interface Described {
  rows: Row[];
  anchor: Vec3;
  points: Vec3[];
  dir?: Vec3;
}

function facePoints(b: BodyMesh, face: number): Vec3[] {
  const g = b.faceGroups.find((x) => x.face === face);
  if (!g) return [];
  const out: Vec3[] = [];
  for (let i = g.start; i < g.start + g.count; i++) {
    const v = b.indices[i] * 3;
    out.push([b.positions[v], b.positions[v + 1], b.positions[v + 2]]);
  }
  return out;
}

function edgePoints(b: BodyMesh, edge: number): Vec3[] {
  const g = b.edgeGroups.find((x) => x.edge === edge);
  if (!g) return [];
  const out: Vec3[] = [];
  for (let i = g.start; i < g.start + g.count; i++) out.push([b.edgePositions[i * 3], b.edgePositions[i * 3 + 1], b.edgePositions[i * 3 + 2]]);
  return out;
}

/**
 * A line straight across a round face, through its axis, level with the
 * middle of the face: its ends on the surface (null where the face's own
 * normals can't tell the axis).
 */
function acrossCylinder(b: BodyMesh, face: number, r: number, hole: boolean, center: Vec3): { a: Vec3; b: Vec3; mid: Vec3 } | null {
  const g = b.faceGroups.find((x) => x.face === face);
  if (!g || !g.count) return null;
  const at = (i: number): { p: Vec3; n: Vec3 } => {
    const v = b.indices[i] * 3;
    return { p: [b.positions[v], b.positions[v + 1], b.positions[v + 2]], n: [b.normals[v], b.normals[v + 1], b.normals[v + 2]] };
  };
  const first = at(g.start);
  // The surface's normals all stand square to the axis: two far apart give it.
  let axis: Vec3 | null = null;
  let best = 0.2;
  for (let i = g.start; i < g.start + g.count; i++) {
    const c = cross(first.n, at(i).n);
    const l = len(c);
    if (l > best) {
      best = l;
      axis = [c[0] / l, c[1] / l, c[2] / l];
    }
  }
  if (!axis) return null;
  // (A hole's surface faces its axis, a shaft's away from it.)
  const k = hole ? r : -r;
  const onAxis: Vec3 = [first.p[0] + first.n[0] * k, first.p[1] + first.n[1] * k, first.p[2] + first.n[2] * k];
  const t = dot(sub(center, onAxis), axis);
  const mid: Vec3 = [onAxis[0] + axis[0] * t, onAxis[1] + axis[1] * t, onAxis[2] + axis[2] * t];
  const side = dot(first.n, axis);
  const u0: Vec3 = [first.n[0] - axis[0] * side, first.n[1] - axis[1] * side, first.n[2] - axis[2] * side];
  const ul = len(u0);
  if (ul < 1e-9) return null;
  const u: Vec3 = [u0[0] / ul, u0[1] / ul, u0[2] / ul];
  return { a: [mid[0] - u[0] * r, mid[1] - u[1] * r, mid[2] - u[2] * r], b: [mid[0] + u[0] * r, mid[1] + u[1] * r, mid[2] + u[2] * r], mid };
}

function closestPair(a: Vec3[], b: Vec3[]): { d: number; p: Vec3; q: Vec3 } {
  let best = { d: Infinity, p: a[0], q: b[0] };
  const step = (n: number) => Math.max(1, Math.floor(n / 600));
  for (let i = 0; i < a.length; i += step(a.length)) {
    for (let j = 0; j < b.length; j += step(b.length)) {
      const d = dist(a[i], b[j]);
      if (d < best.d) best = { d, p: a[i], q: b[j] };
    }
  }
  return best;
}

function circumradius(a: Vec3, b: Vec3, c: Vec3): number | null {
  const ab = len(sub(b, a));
  const bc = len(sub(c, b));
  const ca = len(sub(a, c));
  const area2 = len(cross(sub(b, a), sub(c, a)));
  return area2 > 1e-12 ? (ab * bc * ca) / (2 * area2) : null;
}

/** Signed-tetrahedron volume of the (closed) mesh. */
function volume(b: BodyMesh): number {
  let v = 0;
  const p = b.positions;
  for (let i = 0; i < b.indices.length; i += 3) {
    const a = b.indices[i] * 3;
    const c = b.indices[i + 1] * 3;
    const d = b.indices[i + 2] * 3;
    v += (p[a] * (p[c + 1] * p[d + 2] - p[c + 2] * p[d + 1]) - p[a + 1] * (p[c] * p[d + 2] - p[c + 2] * p[d]) + p[a + 2] * (p[c] * p[d + 1] - p[c + 1] * p[d])) / 6;
  }
  return Math.abs(v);
}

function fmtArea(mm2: number): string {
  const k = UNIT_MM[units()];
  return `${trim(mm2 / (k * k), 3)} ${UNIT_LABEL[units()]}²`;
}

function fmtVolume(mm3: number): string {
  const k = UNIT_MM[units()];
  return `${trim(mm3 / (k * k * k), 3)} ${UNIT_LABEL[units()]}³`;
}

function niceType(t: string): string {
  return t.toLowerCase().replace(/_/g, " ").replace("bspline", "free-form").replace("cylindre", "cylinder");
}
