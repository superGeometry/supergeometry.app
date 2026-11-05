// Freeform: shape a smooth body by pulling its control cage. Tap cage points,
// edges or faces (Shift adds), then drag the gimbal — or type a value while
// dragging. The smooth surface updates live; Done turns it into a body.

import { BufferAttribute, BufferGeometry, DoubleSide, LineBasicMaterial, LineSegments, Mesh, MeshStandardMaterial, Points, Raycaster, Vector2 } from "three";
import type { Feature, FreeformFeature, TransformFeature, Vec3 } from "../doc/types";
import { boundaryEdges, bridgeLoops, cageEdgeKey, cageEdges, deleteFaces, fillLoop, holeLoops, isClosed, previewMesh, primitiveCage, subdivide, type Cage, type CagePrimitive } from "../freeform/cage";
import { add, cross, dot, len, niceStep, norm, scale, sub, xDirFor } from "../geom";
import type { PanelItem } from "../ui/ui";
import { fmtLen } from "../units";
import type { ToolPointer } from "../view/input";
import { dotMaterial } from "../view/viewport";
import { DragTyping } from "./dragTyping";
import { Gimbal, GIMBAL_AXES, type GimbalPart } from "./gimbal";
import { axisDrag } from "./handles";
import type { AppContext, Tool } from "./tool";

type Pick = { kind: "vert"; i: number } | { kind: "edge"; e: [number, number] } | { kind: "face"; f: number };

const SEL = 0xffa31a;
const HOVER = 0xffd27a;

export class FreeformTool implements Tool {
  readonly id = "freeform";
  private cage: Cage;
  private existing?: FreeformFeature;
  private picks: Pick[] = [];
  private hovered: Pick | null = null;
  private gimbal: Gimbal | null = null;
  private dragging: { part: GimbalPart; from: ToolPointer; base: Vec3[]; center: Vec3; d: Vec3; ang: number } | null = null;
  private typing: DragTyping;
  private uniform = 1;
  /** Moves applied to the body later in History: the cage is shown (and edited) where the body is. */
  private place: Placement = { fwd: (v) => v, inv: (v) => v };
  private surfaceSheet = false;
  private thickness = 0;
  private thickSide: "up" | "down" | "both" = "up";
  /** A new shape that spawned inside another body: first moved into place as a whole. */
  private placing = false;

  // Scene objects.
  private surface = new Mesh(new BufferGeometry(), new MeshStandardMaterial({ color: 0xb9c6dc, roughness: 0.5, metalness: 0.05, side: DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
  private lines = new LineSegments(new BufferGeometry(), new LineBasicMaterial({ color: 0x5f8fe8, transparent: true, opacity: 0.85, depthTest: false }));
  private dots = new Points(new BufferGeometry(), dotMaterial({ color: 0xffffff, size: 8 }));
  private marks = new LineSegments(new BufferGeometry(), new LineBasicMaterial({ color: SEL, depthTest: false, linewidth: 2 }));
  private markDots = new Points(new BufferGeometry(), dotMaterial({ color: SEL, size: 12 }));
  private hoverMarks = new LineSegments(new BufferGeometry(), new LineBasicMaterial({ color: HOVER, depthTest: false }));
  private hoverDots = new Points(new BufferGeometry(), dotMaterial({ color: HOVER, size: 12 }));

  constructor(
    private app: AppContext,
    from: { primitive: CagePrimitive } | { feature: FreeformFeature },
  ) {
    if ("feature" in from) {
      this.existing = from.feature;
      this.place = placementOf(app.store.features, from.feature.id);
      const c = structuredClone(from.feature.cage);
      this.cage = { faces: c.faces, verts: c.verts.map(this.place.fwd) };
      this.surfaceSheet = !!from.feature.surface;
      this.thickness = from.feature.thickness ?? 0;
      this.thickSide = from.feature.thickSide ?? "up";
    } else {
      this.cage = primitiveCage(from.primitive);
      this.surfaceSheet = from.primitive === "plane";
    }
    this.typing = new DragTyping(app);
    this.lines.renderOrder = 11;
    this.dots.renderOrder = 12;
    for (const o of [this.marks, this.markDots, this.hoverMarks, this.hoverDots]) o.renderOrder = 13;
  }

  get editingId(): string | undefined {
    return this.existing?.id;
  }

  enter(): void {
    const view = this.app.view;
    view.overlay.add(this.surface, this.lines, this.dots, this.marks, this.markDots, this.hoverMarks, this.hoverDots);
    // Editing an existing freeform: hide its finished body while the cage is out.
    if (this.existing) view.setHidden(new Set([...this.app.store.doc.hidden, this.existing.id]));
    this.app.setSelection([]);
    this.app.ui.setTools([{ id: "cancel", label: "Cancel", icon: "close", shortcut: "Esc", run: () => this.cancel() }]);
    this.app.ui.setBottom([]);
    this.rebuild();
    // A new shape inside another body (or a flat surface, which you'll want to place first): move it as a whole first.
    if (!this.existing && (this.surfaceSheet || this.overlapsBodies())) {
      // Grab the whole shape first; point editing starts after it's been moved.
      this.placing = true;
      this.picks = this.cage.verts.map((_, i) => ({ kind: "vert" as const, i }));
      this.drawMarks();
      this.placeGimbal();
    }
    this.panel();
    this.hint();
  }

  /** Does the cage's box overlap any visible body's box? */
  private overlapsBodies(): boolean {
    const lo = [0, 1, 2].map((k) => Math.min(...this.cage.verts.map((v) => v[k])));
    const hi = [0, 1, 2].map((k) => Math.max(...this.cage.verts.map((v) => v[k])));
    const hidden = new Set(this.app.store.doc.hidden);
    return this.app.view.bodyList.some((b) => {
      if (hidden.has(b.id) || !b.positions.length) return false;
      for (let k = 0; k < 3; k++) {
        let mn = Infinity;
        let mx = -Infinity;
        for (let i = k; i < b.positions.length; i += 3) {
          mn = Math.min(mn, b.positions[i]);
          mx = Math.max(mx, b.positions[i]);
        }
        if (mx < lo[k] || mn > hi[k]) return false;
      }
      return true;
    });
  }

  exit(): void {
    const view = this.app.view;
    for (const o of [this.surface, this.lines, this.dots, this.marks, this.markDots, this.hoverMarks, this.hoverDots]) {
      view.overlay.remove(o);
      o.geometry.dispose();
    }
    this.gimbal?.dispose();
    this.gimbal = null;
    view.setHidden(new Set(this.app.store.doc.hidden));
    this.app.ui.showPanel(null);
    this.app.ui.setHint(null);
    this.app.ui.setLabel(0, 0, null);
    view.requestRender();
  }

  private hint(): void {
    if (this.placing) return this.app.ui.setHint("Drag the gimbal to move it into place first. Then tap points, edges or faces to shape it.");
    this.app.ui.setHint(
      this.picks.length
        ? "Drag the gimbal to move or turn the selection (type a value while dragging). Shift+tap adds. Tap empty space to deselect."
        : "Tap cage points, edges or faces to select them (Shift adds). Done turns the shape into a body.",
    );
  }

  private panel(): void {
    const n = this.selectedVerts().length;
    const items: PanelItem[] = [];
    if (n) items.push({ type: "number", label: "Scale", value: 1, kind: "number", min: 0.01, onInput: (v) => this.scaleSelection(v) });
    const faces = this.picks.filter((p) => p.kind === "face").length;
    if (faces) items.push({ type: "button", label: `Delete face${faces > 1 ? "s" : ""}`, icon: "trash", onClick: () => this.deleteSelectedFaces() });
    // Rim edges of holes picked: one hole → Fill, two facing holes → Bridge.
    const loops = this.pickedLoops();
    if (loops.length === 1) items.push({ type: "button", label: "Fill hole", icon: "fill", onClick: () => this.fillHoles(loops) });
    if (loops.length === 2) items.push({ type: "button", label: "Bridge holes", icon: "loft", onClick: () => this.fillHoles(loops) });
    // An open shape can be given a thickness to become a solid.
    if (!isClosed(this.cage)) {
      items.push(
        { type: "number", label: "Thickness", value: this.thickness, kind: "length", min: 0, onInput: (v) => ((this.thickness = Math.max(0, v)), this.panelHint()) },
        { type: "choice", options: [{ id: "up", label: "Up" }, { id: "down", label: "Down" }, { id: "both", label: "Symmetric" }], value: this.thickSide, onChange: (v) => ((this.thickSide = v as typeof this.thickSide), this.panel()) },
      );
    }
    this.uniform = 1;
    this.app.ui.showPanel({
      title: `Freeform${n ? ` · ${n} point${n > 1 ? "s" : ""}` : ""}`,
      items,
      actions: [{ id: "all", label: "Select all", icon: "pointer", run: () => ((this.picks = this.cage.verts.map((_, i) => ({ kind: "vert" as const, i }))), this.selectionChanged()) }],
      onDone: () => this.done(),
      onCancel: () => this.cancel(),
    });
  }

  private panelHint(): void {
    if (!isClosed(this.cage)) this.app.ui.setHint(this.thickness > 0 ? `Done makes a solid ${fmtLen(this.thickness)} thick.` : "Open shape: Done makes a surface. Give it a Thickness to make a solid.");
  }

  /** Holes whose rim edges are all picked (edges, or the points along them). */
  private pickedLoops(): number[][] {
    const verts = new Set(this.selectedVerts());
    const chosen = new Set<string>();
    for (const [a, b] of boundaryEdges(this.cage)) if (verts.has(a) && verts.has(b)) chosen.add(cageEdgeKey(a, b));
    return chosen.size ? holeLoops(this.cage, chosen) : [];
  }

  private deleteSelectedFaces(): void {
    const faces = this.picks.flatMap((p) => (p.kind === "face" ? [p.f] : []));
    if (!faces.length) return;
    if (faces.length >= this.cage.faces.length) return this.app.ui.toast("At least one face has to stay");
    this.cage = deleteFaces(this.cage, faces);
    this.picks = [];
    this.rebuild();
    this.selectionChanged();
    this.panelHint();
  }

  /**
   * From the select tool: fill the hole whose rim passes nearest the given
   * points (a tapped edge of the hole). Returns false if there's no hole.
   */
  fillHoleAt(points: Vec3[]): boolean {
    const rim = boundaryEdges(this.cage);
    if (!rim.length) return false;
    const loops = holeLoops(this.cage, new Set(rim.map(([a, b]) => cageEdgeKey(a, b))));
    if (!loops.length) return false;
    // The hole nearest the tap (by its rim points on the smooth surface).
    const sub3 = subdivide(this.cage, 3);
    const near = (loop: number[]) => {
      let best = Infinity;
      for (const q of points) for (const v of loop) best = Math.min(best, Math.hypot(...(sub(sub3.points[v], q) as [number, number, number])));
      return best;
    };
    const loop = loops.reduce((m, l) => (near(l) < near(m) ? l : m), loops[0]);
    this.fillHoles([loop]);
    return true;
  }

  private fillHoles(loops: number[][]): void {
    const next = loops.length === 2 ? bridgeLoops(this.cage, loops[0], loops[1]) : fillLoop(this.cage, loops[0]);
    if (!next) return this.app.ui.toast(loops.length === 2 ? "Bridging needs two holes with the same number of edges" : "Fill needs a hole with an even number of edges");
    this.cage = next;
    this.picks = [];
    this.rebuild();
    this.selectionChanged();
  }

  // --------------------------------------------------------------- picking

  private selectedVerts(): number[] {
    const s = new Set<number>();
    for (const p of this.picks) {
      if (p.kind === "vert") s.add(p.i);
      else if (p.kind === "edge") p.e.forEach((i) => s.add(i));
      else this.cage.faces[p.f].forEach((i) => s.add(i));
    }
    return [...s];
  }

  /** How far along the pointer's ray the smooth surface is (∞ if missed). */
  private surfaceDepth(p: ToolPointer): number {
    const view = this.app.view;
    const r = view.canvas.getBoundingClientRect();
    this.ray.setFromCamera(new Vector2((p.x / r.width) * 2 - 1, -(p.y / r.height) * 2 + 1), view.cam.camera);
    return this.ray.intersectObject(this.surface, false)[0]?.distance ?? Infinity;
  }
  private ray = new Raycaster();

  /**
   * Nearest cage point, else edge, else the frontmost face under the pointer.
   * Points and edges behind the smooth surface (the far side) don't count.
   */
  private pickAt(p: ToolPointer): Pick | null {
    const view = this.app.view;
    const scr = this.cage.verts.map((v) => view.toScreen(v));
    const tol = Math.max(10, p.tol * 1.3);
    const eye = view.cam.camera.position.toArray() as Vec3;
    const wall = this.surfaceDepth(p);
    const visible = (q: Vec3) => len(sub(q, eye)) < wall + 1e-6;
    let best: { d: number; i: number } | null = null;
    scr.forEach((s, i) => {
      if (!s || !visible(this.cage.verts[i])) return;
      const d = Math.hypot(s[0] - p.x, s[1] - p.y);
      if (d < tol && (!best || d < best.d)) best = { d, i };
    });
    if (best) return { kind: "vert", i: (best as { i: number }).i };
    let bestE: { d: number; e: [number, number] } | null = null;
    for (const e of cageEdges(this.cage)) {
      const a = scr[e[0]];
      const b = scr[e[1]];
      if (!a || !b) continue;
      const { d, t } = segDist(p.x, p.y, a, b);
      const at = add(this.cage.verts[e[0]], scale(sub(this.cage.verts[e[1]], this.cage.verts[e[0]]), t));
      if (d < p.tol && visible(at) && (!bestE || d < bestE.d)) bestE = { d, e };
    }
    if (bestE) return { kind: "edge", e: (bestE as { e: [number, number] }).e };
    // Faces: inside the projected quad; nearest to the camera wins.
    let bestF: { d: number; f: number } | null = null;
    this.cage.faces.forEach((f, fi) => {
      const q = f.map((i) => scr[i]);
      if (q.some((s) => !s) || !inPoly(p.x, p.y, q as [number, number][])) return;
      const c = scale(f.reduce((s, i) => add(s, this.cage.verts[i]), [0, 0, 0] as Vec3), 0.25);
      const d = len(sub(c, eye));
      if (!bestF || d < bestF.d) bestF = { d, f: fi };
    });
    return bestF ? { kind: "face", f: (bestF as { f: number }).f } : null;
  }

  hover(p: ToolPointer | null): void {
    if (this.dragging) return;
    const g = p && this.gimbal?.hit(p);
    this.gimbal?.setHot(g ?? null);
    this.hovered = p && !g ? this.pickAt(p) : null;
    this.app.view.canvas.style.cursor = g ? "grab" : "";
    this.drawMarks();
  }

  tap(p: ToolPointer, count = 1): void {
    // Double-tap: finish and select the whole body (e.g. to move or colour it).
    if (count >= 2) {
      const id = this.done();
      if (id) this.app.setSelection([{ kind: "body", body: id }]);
      return;
    }
    // A tap while placing: they'd rather edit right away.
    if (this.placing) {
      this.placing = false;
      this.picks = [];
    }
    const hit = this.pickAt(p);
    if (!hit) {
      // Empty space: deselect; with nothing selected, finish.
      if (this.picks.length) return ((this.picks = []), this.selectionChanged());
      this.done();
      return;
    }
    const key = JSON.stringify(hit);
    const i = this.picks.findIndex((x) => JSON.stringify(x) === key);
    if (p.shift || p.add) {
      if (i >= 0) this.picks.splice(i, 1);
      else this.picks.push(hit);
    } else this.picks = i >= 0 && this.picks.length === 1 ? [] : [hit];
    this.selectionChanged();
  }

  private selectionChanged(): void {
    this.drawMarks();
    this.placeGimbal();
    this.panel();
    this.hint();
  }

  private centroid(ids: number[]): Vec3 {
    return scale(ids.reduce((s, i) => add(s, this.cage.verts[i]), [0, 0, 0] as Vec3), 1 / Math.max(1, ids.length));
  }

  private placeGimbal(): void {
    const ids = this.selectedVerts();
    if (!ids.length) {
      this.gimbal?.dispose();
      this.gimbal = null;
      return;
    }
    this.gimbal ??= new Gimbal(this.app.view);
    this.gimbal.setCenter(this.centroid(ids));
  }

  // ------------------------------------------------------------ dragging

  down(p: ToolPointer): boolean {
    const part = this.gimbal?.hit(p);
    if (!part || !this.gimbal) return false;
    // One point turned about itself wouldn't move: it turns about the shape's centre instead.
    const ids = this.selectedVerts();
    const center = part.kind === "ring" && ids.length === 1 ? this.centroid(this.cage.verts.map((_, i) => i)) : this.gimbal.origin;
    this.dragging = { part, from: p, base: this.cage.verts.map((v) => [...v] as Vec3), center, d: [0, 0, 0], ang: 0 };
    this.gimbal.setHot(part);
    return true;
  }

  drag(p: ToolPointer): void {
    const dr = this.dragging;
    if (!dr) return;
    this.typing.track(p);
    if (this.typing.active) return;
    const view = this.app.view;
    const step = niceStep(view.cam.worldPerPixel(view.height) * 4);
    const snap = (v: number) => (p.shift ? v : Math.round(v / step) * step);
    const part = dr.part;
    if (part.kind === "axis") {
      const dir = GIMBAL_AXES[part.i];
      const d = snap(axisDrag(view, dr.center, dir, dr.from, p));
      this.apply(scale(dir, d), 0);
      this.app.ui.setLabel(p.x, p.y, `${fmtLen(d)}  · type a value`);
    } else if (part.kind === "plane" || part.kind === "center") {
      const n: Vec3 = part.kind === "plane" ? GIMBAL_AXES[part.i] : (view.cam.viewDir().toArray() as Vec3);
      const plane = { origin: dr.center, normal: n, xDir: xDirFor(n) };
      const a = view.rayToPlane(dr.from.x, dr.from.y, plane);
      const b = view.rayToPlane(p.x, p.y, plane);
      if (!a || !b) return;
      const d = sub(b, a);
      this.apply([snap(d[0]), snap(d[1]), snap(d[2])], 0);
      this.app.ui.setLabel(p.x, p.y, `${fmtLen(len(dr.d))}  · type a value`);
    } else if (part.kind === "ring") {
      const axis = GIMBAL_AXES[part.i];
      const c = view.toScreen(dr.center);
      if (!c) return;
      const ang = (q: { x: number; y: number }) => Math.atan2(q.y - c[1], q.x - c[0]);
      const facing = dot(axis, view.cam.viewDir().toArray() as Vec3) < 0 ? 1 : -1;
      let deg = ((-(ang(p) - ang(dr.from)) * 180) / Math.PI) * facing;
      deg = ((deg + 540) % 360) - 180;
      const total = p.shift ? deg : Math.round(deg);
      this.apply([0, 0, 0], total);
      this.app.ui.setLabel(p.x, p.y, `${total}°  · type a value`);
    }
  }

  /** Move the selected points from where the drag began: translate d, then turn `deg` about the gimbal axis. */
  private apply(d: Vec3, deg: number): void {
    const dr = this.dragging;
    if (!dr) return;
    dr.d = d;
    dr.ang = deg;
    const ids = this.selectedVerts();
    const axis = dr.part.kind === "ring" ? GIMBAL_AXES[dr.part.i] : null;
    const t = (deg * Math.PI) / 180;
    for (const i of ids) {
      let q = dr.base[i];
      if (axis && deg) {
        // Rodrigues' rotation about the axis through the centre.
        const v = sub(q, dr.center);
        const r = add(add(scale(v, Math.cos(t)), scale(cross(axis, v), Math.sin(t))), scale(axis, dot(axis, v) * (1 - Math.cos(t))));
        q = add(dr.center, r);
      }
      this.cage.verts[i] = add(q, d);
    }
    this.gimbal?.setCenter(this.centroid(ids));
    this.rebuild();
  }

  up(): void {
    const moved = !!this.dragging && (len(this.dragging.d) > 0 || this.dragging.ang !== 0);
    this.dragging = null;
    this.typing.reset();
    this.app.ui.setLabel(0, 0, null);
    this.gimbal?.setHot(null);
    if (this.placing && moved) {
      // In place: on to editing points, edges and faces.
      this.placing = false;
      this.picks = [];
      this.selectionChanged();
      return;
    }
    this.placeGimbal();
  }

  dragKey(e: KeyboardEvent): boolean {
    const dr = this.dragging;
    if (!dr) return false;
    const part = dr.part;
    const dragDir = norm(dr.d);
    return this.typing.key(e, {
      kind: part.kind === "ring" ? "angle" : "length",
      apply: (v) => {
        if (part.kind === "ring") this.apply([0, 0, 0], v);
        else if (part.kind === "axis") this.apply(scale(GIMBAL_AXES[part.i], v), 0);
        else if (len(dr.d) > 1e-9) this.apply(scale(dragDir, v), 0);
      },
      commit: () => this.up(),
      cancel: () => this.apply([0, 0, 0], 0),
    });
  }

  /** Panel Scale: grow/shrink the selection about its centre (relative to the last value). */
  private scaleSelection(v: number): void {
    if (v <= 0) return;
    const ids = this.selectedVerts();
    const c = this.centroid(ids);
    const k = v / this.uniform;
    this.uniform = v;
    for (const i of ids) this.cage.verts[i] = add(c, scale(sub(this.cage.verts[i], c), k));
    this.rebuild();
    this.placeGimbal();
  }

  // --------------------------------------------------------------- drawing

  private rebuild(): void {
    const m = previewMesh(subdivide(this.cage, 3));
    const g = this.surface.geometry;
    g.setAttribute("position", new BufferAttribute(m.positions, 3));
    g.setAttribute("normal", new BufferAttribute(m.normals, 3));
    g.setIndex(new BufferAttribute(m.indices, 1));
    g.computeBoundingSphere();
    const edges = cageEdges(this.cage).flatMap(([a, b]) => [...this.cage.verts[a], ...this.cage.verts[b]]);
    setPositions(this.lines, edges);
    setPositions(this.dots, this.cage.verts.flat());
    this.drawMarks();
  }

  private drawMarks(): void {
    const seg = (ps: Pick[]) =>
      ps.flatMap((p) => {
        const V = this.cage.verts;
        if (p.kind === "edge") return [...V[p.e[0]], ...V[p.e[1]]];
        if (p.kind === "face") {
          const f = this.cage.faces[p.f];
          return f.flatMap((i, k) => [...V[i], ...V[f[(k + 1) % 4]]]);
        }
        return [];
      });
    const pts = (ps: Pick[]) => ps.flatMap((p) => (p.kind === "vert" ? [...this.cage.verts[p.i]] : []));
    setPositions(this.marks, seg(this.picks));
    setPositions(this.markDots, pts(this.picks));
    const h = this.hovered ? [this.hovered] : [];
    setPositions(this.hoverMarks, seg(h));
    setPositions(this.hoverDots, pts(h));
    this.app.view.requestRender();
  }

  // ------------------------------------------------------------- finishing

  key(e: KeyboardEvent): boolean {
    if (e.key === "Escape") {
      if (this.picks.length) ((this.picks = []), this.selectionChanged());
      else this.cancel();
      return true;
    }
    if (e.key === "Enter") return (this.done(), true);
    if ((e.key === "Delete" || e.key === "Backspace") && this.picks.some((p) => p.kind === "face")) return (this.deleteSelectedFaces(), true);
    if (e.key.toLowerCase() === "a" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      this.picks = this.cage.verts.map((_, i) => ({ kind: "vert" as const, i }));
      this.selectionChanged();
      return true;
    }
    return false;
  }

  /** Save and close; returns the body id. */
  private done(): string | null {
    // Stored where it was made: later move steps in History still apply on top.
    const cage = { faces: structuredClone(this.cage.faces), verts: this.cage.verts.map(this.place.inv) };
    const open = !isClosed(cage);
    const extra = { surface: this.surfaceSheet || undefined, thickness: open && this.thickness > 0 ? this.thickness : undefined, thickSide: open && this.thickness > 0 ? this.thickSide : undefined };
    let id: string;
    if (this.existing) {
      id = this.existing.id;
      this.app.store.update(id, { cage, ...extra } as Partial<FreeformFeature>);
    } else {
      const f: FreeformFeature = { ...this.app.store.newIdentity("freeform", isClosed(cage) ? "Freeform" : "Freeform surface"), type: "freeform", cage, ...extra };
      this.app.store.add(f);
      id = f.id;
    }
    this.app.setTool(null);
    return id;
  }

  private cancel(): void {
    this.app.setTool(null);
  }

  /** Select the cage element under the pointer (used when a tap on the body opens the tool). */
  /**
   * Delete the cage faces under picked body geometry (from the select tool):
   * a face → its patch; an edge or a point → every patch that touches it.
   * The shape opens up, so the Thickness choice shows.
   */
  deleteAt(points: Vec3[], kind: "face" | "edge" | "vertex"): void {
    const sub3 = subdivide(this.cage, 3);
    const n = sub3.n;
    const size = Math.max(1e-9, ...[0, 1, 2].map((k) => Math.max(...this.cage.verts.map((v) => v[k])) - Math.min(...this.cage.verts.map((v) => v[k]))));
    const dist3 = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    const doomed = new Set<number>();
    for (const q of points) {
      if (kind === "face") {
        let best = -1;
        let bd = Infinity;
        sub3.grids.forEach((g, f) => {
          const d = dist3(sub3.points[g[n >> 1][n >> 1]], q);
          if (d < bd) [bd, best] = [d, f];
        });
        if (best >= 0) doomed.add(best);
        continue;
      }
      // Patches whose rim passes through the edge / point.
      const rim = sub3.grids.map((g) => {
        let d = Infinity;
        for (let i = 0; i <= n; i++)
          for (const [a, b] of [[0, i], [n, i], [i, 0], [i, n]]) d = Math.min(d, dist3(sub3.points[g[a][b]], q));
        return d;
      });
      const min = Math.min(...rim);
      rim.forEach((d, f) => d < min + size * 0.01 && doomed.add(f));
    }
    if (!doomed.size) return;
    if (doomed.size >= this.cage.faces.length) return this.app.ui.toast("At least one face has to stay");
    this.cage = deleteFaces(this.cage, [...doomed]);
    this.picks = [];
    this.rebuild();
    this.selectionChanged();
    this.app.ui.toast("The shape is no longer closed: give it a Thickness to make a solid, or Done for a surface.");
    this.panelHint();
  }

  selectAt(p: ToolPointer): void {
    const hit = this.pickAt(p);
    if (!hit) return;
    this.picks = [hit];
    this.selectionChanged();
  }
}

function setPositions(o: LineSegments | Points, xyz: number[]): void {
  const g = o.geometry;
  g.setAttribute("position", new BufferAttribute(new Float32Array(xyz), 3));
  g.computeBoundingSphere();
}

/** Screen distance from (x, y) to segment a–b, and where along it (0…1). */
function segDist(x: number, y: number, a: [number, number], b: [number, number]): { d: number; t: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l2));
  return { d: Math.hypot(x - (a[0] + dx * t), y - (a[1] + dy * t)), t };
}

function inPoly(x: number, y: number, q: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
    const [xi, yi] = q[i];
    const [xj, yj] = q[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

interface Placement {
  fwd(v: Vec3): Vec3;
  inv(v: Vec3): Vec3;
}

/**
 * Where later History steps put this body: moves, scales and mirrors that
 * act on it (not copies). `inv` undoes them, to store edits in the cage's own place.
 */
function placementOf(features: readonly Feature[], id: string): Placement {
  const i = features.findIndex((f) => f.id === id);
  const steps = features
    .slice(i + 1)
    .filter((f): f is TransformFeature => f.type === "transform" && !f.suppressed && !f.copy && f.bodies.includes(id) && ["move", "scale", "mirror"].includes(f.op.kind));
  const turn = (p: Vec3, o: Vec3, axis: Vec3, deg: number): Vec3 => {
    const k = norm(axis);
    const v = sub(p, o);
    const t = (deg * Math.PI) / 180;
    return add(o, add(add(scale(v, Math.cos(t)), scale(cross(k, v), Math.sin(t))), scale(k, dot(k, v) * (1 - Math.cos(t)))));
  };
  const reflect = (p: Vec3, o: Vec3, n: Vec3): Vec3 => {
    const k = norm(n);
    return sub(p, scale(k, 2 * dot(sub(p, o), k)));
  };
  const apply = (op: TransformFeature["op"], p: Vec3, back: boolean): Vec3 => {
    if (op.kind === "move") {
      const r = op.rotate;
      if (!back) return add(r && r.angle ? turn(p, r.origin, r.axis, r.angle) : p, op.translate);
      const q = sub(p, op.translate);
      return r && r.angle ? turn(q, r.origin, r.axis, -r.angle) : q;
    }
    if (op.kind === "scale") return add(op.center, scale(sub(p, op.center), back ? 1 / op.factor : op.factor));
    if (op.kind === "mirror") return reflect(p, op.plane.origin, op.plane.normal);
    return p;
  };
  return {
    fwd: (v) => steps.reduce((p, f) => apply(f.op, p, false), v),
    inv: (v) => [...steps].reverse().reduce((p, f) => apply(f.op, p, true), v),
  };
}
