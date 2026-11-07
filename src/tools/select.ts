import { circleAxis } from "./slots";
import { isTouchDevice } from "../device";
import { BODY_COLORS, BODY_OPACITY, bodyColor } from "../doc/types";
import type { DeleteGeomFeature, FreeformFeature, EdgeRef, ExtrudeSource, FaceRef, ImageFeature, PlaneDef, SketchFeature, Vec3 } from "../doc/types";
import { arrangement } from "../sketch/regions";
import { projectPolyline } from "../sketch/edit";
import type { ToolItem } from "../ui/ui";
import type { ToolPointer } from "../view/input";
import { add, dot, len, originOnPlane, planeY, scale, sub } from "../geom";
import { evaluate, fmtLen } from "../units";
import { DimWidget } from "./annotate";
import { Gimbal, IN_PLANE } from "./gimbal";
import { Handle } from "./handles";
import { CopyToggle, copyMode } from "./copyToggle";
import { SketchMoveOp } from "./sketchMove";
import { FreeformTool } from "./freeform";
import { isClosed } from "../freeform/cage";
import { detachFreeformCopy, freeformBodies } from "../doc/freeformCopies";
import { connectEdges } from "../doc/freeformConnect";
import { OffsetEdgeOp } from "./offsetEdge";
import { AxisOp, bodyCenter as centerOf, EdgeOp, ExtrudeOp, FillToPlaneOp, ImageOp, LoftOp, MoveFaceOp, PlaneOp, ReplaceFaceOp, ScaleFaceOp, ScaleOp, RevolveOp, ShellOp, SplitOp, SweepOp, TransformOp } from "./ops";
import { SketchTool, type SketchKind } from "./sketch";
import { BooleanOp } from "./booleanOp";
import { bodiesOf, edgeRefOf, faceRefOf, hitToSel, oppositeFace, sameSel, sourceFrame, sourcesOf, type AppContext, type Sel, type Tool } from "./tool";

const SOON = "Coming soon";

/**
 * The default tool. Tap things to select them; the selection decides which
 * tools are listed, and the most likely one gets a handle you can drag right away.
 */
export class SelectTool implements Tool {
  readonly id = "select";
  private handle: Handle | null = null;
  private handleAction: (() => Tool) | null = null;
  private gimbal: Gimbal | null = null;
  private copyToggle: CopyToggle | null = null;
  private dim: DimWidget | null = null;
  /** A tool chosen with nothing selected waits for the selection. */
  private pending: { label: string; accepts: Sel["kind"][]; run: () => void } | null = null;

  constructor(private app: AppContext) {}

  enter(): void {
    this.refresh();
  }

  exit(): void {
    this.clearHandle();
    this.app.ui.setHint(null);
    this.app.setHover(null);
  }

  hover(p: ToolPointer | null): void {
    if (!p) return this.app.setHover(null);
    const g = this.gimbal?.hit(p) ?? null;
    this.gimbal?.setHot(g);
    const onHandle = !!this.handle?.hit(p);
    this.handle?.setHot(onHandle);
    if (g || onHandle) {
      this.app.view.canvas.style.cursor = "grab";
      return this.app.setHover(null);
    }
    this.app.view.canvas.style.cursor = "";
    const hit = this.pickAt(p);
    this.lastHover = { x: p.x, y: p.y, hit };
    this.app.setHover(hitToSel(hit));
  }

  /** What the last hover highlighted, and where: tapping there selects exactly that. */
  private lastHover: { x: number; y: number; hit: ReturnType<SelectTool["pickAt"]> } | null = null;

  private tapHit(p: ToolPointer) {
    const h = this.lastHover;
    if (h?.hit && Math.hypot(h.x - p.x, h.y - p.y) < 6) return h.hit;
    return this.pickAt(p);
  }

  /**
   * The gimbal and the extrude arrow take over only once the pointer moves
   * (dragStart): a click or double-click on top of them still selects what's
   * under it - e.g. double-clicking a face seen straight on, where the arrow
   * points at you and sits right on the face.
   */
  down(): boolean {
    return false;
  }

  dragStart(p: ToolPointer): boolean {
    if (this.gimbal?.hit(p)) {
      const s = this.app.selection[0];
      const img = s?.kind === "image" ? this.app.store.find<ImageFeature>(s.id) : undefined;
      // A vertex: its gimbal moves just that corner (the faces around it follow).
      const at = s?.kind === "vertex" ? this.app.view.vertexOf(s.body, s.vertex) : undefined;
      const edge = s?.kind === "edge" ? this.edgeRefs()[0] : undefined;
      const op = img
        ? new ImageOp(this.app, img)
        : s?.kind === "vertex" && at
          ? new MoveFaceOp(this.app, { vertex: { body: s.body, at } })
          : edge
            ? new MoveFaceOp(this.app, { edge })
            : new TransformOp(this.app, "move", bodiesOf(this.app.selection), undefined, undefined, s?.kind === "body" && copyMode.on);
      this.app.setTool(op);
      return op.down(p);
    }
    if (!this.handle?.hit(p) || !this.handleAction) return false;
    const op = this.handleAction();
    this.app.setTool(op);
    return op.down?.(p) ?? false;
  }

  /** Sketch curves win near them; a face outline copied into a sketch ("bnd-…") is the body's edge. */
  private pickAt(p: ToolPointer) {
    const hit = this.app.view.pick(p.x, p.y, { edgeTolPx: p.tol, curves: true });
    if (hit?.kind !== "curve" && hit?.kind !== "point") return hit;
    const under = this.app.view.pick(p.x, p.y, { edgeTolPx: p.tol });
    if (hit.entity.startsWith("bnd-")) return under;
    // A sketch curve behind a body (seen through it) doesn't win over the body in front.
    if (under && (under.kind === "face" || under.kind === "edge" || under.kind === "vertex")) {
      const eye = this.app.view.cam.camera.position.toArray() as Vec3;
      const far = (q: Vec3) => Math.hypot(q[0] - eye[0], q[1] - eye[1], q[2] - eye[2]);
      if (far(under.point) < far(hit.point) - this.app.view.cam.worldPerPixel(this.app.view.height) * 2) return under;
    }
    return hit;
  }

  tap(p: ToolPointer, count: number): void {
    let hit = this.tapHit(p);
    // A finger on a thin shape (a ruler's tick, a letter) is always on its
    // outline too: one tap takes the shape under it (to extrude); a double
    // tap opens the sketch to edit. (A mouse can aim for one or the other.)
    // (Also while a tool waits for a shape: Loft took no taps on a thin blade tip.)
    if (hit?.kind === "curve" && count < 2 && isTouchDevice && (!this.pending || this.pending.accepts.includes("profile"))) {
      const under = this.app.view.pick(p.x, p.y, { edgeTolPx: 0, curves: false, profiles: true, edges: false, vertices: false });
      // A shape of another sketch under the finger wins too: a path drawn from
      // the middle of the circle to sweep along opened its sketch instead.
      if (under?.kind === "profile") hit = under;
    }
    // Tapping a line/curve/point of a finished sketch opens it for editing, with that piece selected.
    if ((hit?.kind === "curve" || hit?.kind === "point") && !this.pending) {
      const tool = new SketchTool(this.app, { sketchId: hit.sketch });
      this.app.setSelection([]);
      this.app.setTool(tool);
      if (hit.kind === "curve") tool.preselect([hit.entity]);
      else tool.preselect([], [{ e: hit.entity, p: hit.p }]);
      return;
    }
    // Where the tap was: Edit Freeform picks the cage element there.
    this.lastTap = p;
    let s = hitToSel(hit);
    const sel = this.app.selection;
    if (!s) return this.app.setSelection([]);
    // Double tap selects the whole body.
    if (count >= 2 && (s.kind === "face" || s.kind === "edge" || s.kind === "vertex")) s = { kind: "body", body: s.body };
    // With bodies selected, tapping another body adds it (Union/Subtract need two).
    if (sel[0]?.kind === "body" && (s.kind === "face" || s.kind === "edge" || s.kind === "vertex") && (p.add || !sel.some((x) => x.kind === "body" && x.body === (s as { body: string }).body))) {
      s = { kind: "body", body: s.body };
    }
    if (sel.length && sel[0].kind === s.kind) {
      const i = sel.findIndex((x) => sameSel(x, s!));
      if (i >= 0 && count < 2) this.app.setSelection(sel.filter((_, j) => j !== i));
      else if (i < 0) this.app.setSelection(p.add || sel[0].kind !== "vertex" ? [...sel, s] : [s]);
    } else {
      this.app.setSelection([s]);
    }
    if (this.pending && this.pending.accepts.includes(s.kind)) {
      const run = this.pending.run;
      this.pending = null;
      run();
      return;
    }
    // A shape's region tapped (not added with Shift/Ctrl): its extrude arrow is
    // ready - at 0, so nothing is made until the arrow is dragged (or a value typed).
    const now = this.app.selection;
    if (s.kind === "profile" && !p.add && count < 2 && now.length && now.every((x) => x.kind === "profile") && now.some((x) => sameSel(x, s!))) {
      const src = sourcesOf(this.app, now)[0];
      if (src) this.app.setTool(new ExtrudeOp(this.app, src, undefined, "auto", { distance: 0 }).markTapped());
    }
  }

  /** Window selection: bodies entirely inside the box. */
  box(a: { x: number; y: number }, b: { x: number; y: number }, final: boolean, add: boolean): void {
    if (!final) return;
    const x0 = Math.min(a.x, b.x);
    const x1 = Math.max(a.x, b.x);
    const y0 = Math.min(a.y, b.y);
    const y1 = Math.max(a.y, b.y);
    const inside = this.app.view.bodyList.filter((body) => {
      if (this.app.view.isHidden(body.id)) return false;
      for (let i = 0; i < body.positions.length; i += 3 * Math.max(1, Math.floor(body.positions.length / 3 / 400))) {
        const s = this.app.view.toScreen([body.positions[i], body.positions[i + 1], body.positions[i + 2]]);
        if (!s || s[0] < x0 || s[0] > x1 || s[1] < y0 || s[1] > y1) return false;
      }
      return true;
    });
    const picked: Sel[] = inside.map((body) => ({ kind: "body", body: body.id }));
    const base = add ? this.app.selection.filter((s) => s.kind === "body") : [];
    this.app.setSelection([...base, ...picked.filter((s) => !base.some((x) => sameSel(x, s)))]);
  }

  /** Right-click: let go of what's picked (and of a tool waiting for a pick). */
  context(): void {
    if (!this.app.selection.length && !this.pending) return;
    this.pending = null;
    this.app.setSelection([]);
  }

  key(e: KeyboardEvent): boolean {
    const k = e.key.toLowerCase();
    if (k === "escape" && (this.app.selection.length || this.pending)) {
      this.pending = null;
      this.app.setSelection([]);
      return true;
    }
    // A sketch region selected: just type the height - the extrude starts with it.
    const sel = this.app.selection;
    if (!e.ctrlKey && !e.metaKey && !e.altKey && /^[0-9.\-]$/.test(e.key) && sel.length && sel.every((x) => x.kind === "profile")) {
      const src = sourcesOf(this.app, sel)[0];
      if (src) {
        const v = Number(e.key);
        this.app.setTool(new ExtrudeOp(this.app, src, undefined, "auto", { distance: Number.isFinite(v) ? v : 0, typed: e.key }));
        return true;
      }
    }
    if (e.ctrlKey || e.metaKey) return false;
    const want = k === "delete" || k === "backspace" ? "DEL" : k.toUpperCase();
    const action = flatten(this.actions()).find((a) => a.shortcut?.toUpperCase() === want && !a.disabled && a.run);
    if (action) {
      action.run!();
      return true;
    }
    return false;
  }

  /** Re-derive tools and handle from the current selection. */
  refresh(): void {
    this.clearHandle();
    // Whatever an earlier tool left on screen goes too (no ghost arrows or dots).
    this.app.view.clearHelpers([]);
    const sel = this.app.selection;
    this.app.ui.setTools(sel.length ? this.actions() : this.app.mainTools());
    this.app.ui.setBottom(this.app.bottomTools());
    this.app.ui.setHint(
      this.pending
        ? `${this.pending.label}: select ${this.pending.accepts.join(" or ")}`
        : sel.length === 0
          ? null
          : `${sel.length} ${label(sel[0], sel.length)} selected`,
    );
    const first = sel[0];
    if (!first) return;
    // The most likely next step gets a handle.
    if (first.kind === "profile") {
      const src = sourcesOf(this.app, sel)[0];
      if (src) this.showHandle(sourceFrame(this.app, src), "arrow", () => new ExtrudeOp(this.app, src));
    } else if (first.kind === "face" && sel.length === 1 && offsettable(this.app.view.body(first.body)?.faces[first.face]?.type)) {
      // Flat and round faces: drag the arrow to offset (round faces change radius).
      const src = sourcesOf(this.app, sel)[0];
      if (src) {
        this.showHandle(sourceFrame(this.app, src), "arrow", () => new ExtrudeOp(this.app, src));
        if (this.app.view.body(first.body)?.faces[first.face]?.plane) this.showFaceDimension(first, src);
      }
    } else if (first.kind === "face" && sel.length === 2 && sel[1].kind === "face") {
      this.showFacesDistance(first, sel[1]);
    } else if (first.kind === "body") {
      // Body: the Move/Rotate gimbal is ready to drag (with Copy beside it).
      this.gimbal = new Gimbal(this.app.view);
      this.gimbal.setCenter(centerOf(this.app, bodiesOf(sel)));
      const g = this.gimbal;
      this.copyToggle = new CopyToggle(this.app.view, () => g.origin);
    } else if (first.kind === "vertex" && sel.length === 1) {
      const v = this.app.view.vertexOf(first.body, first.vertex);
      // A freeform's points are moved in Edit Freeform, so no gimbal here.
      if (v && !this.freeformOf(first.body)) {
        this.gimbal = new Gimbal(this.app.view);
        this.gimbal.setCenter(v);
      }
    } else if (first.kind === "image") {
      const img = this.app.store.find<ImageFeature>(first.id);
      if (img) {
        const pl = img.plane;
        this.gimbal = new Gimbal(this.app.view, { axes: [pl.xDir, planeY(pl), pl.normal], parts: IN_PLANE });
        this.gimbal.setCenter(pl.origin);
      }
    } else if (first.kind === "edge") {
      const e = this.edgeRefs()[0];
      const straight = this.app.view.body(first.body)?.edges[first.edge]?.type === "LINE";
      // One straight edge: its Move/Rotate gimbal is ready to drag (fillet and
      // chamfer are in the list); a round one: the fillet's dot.
      if (e && straight && sel.length === 1 && !this.freeformOf(first.body)) {
        this.gimbal = new Gimbal(this.app.view, { axes: MoveFaceOp.edgeAxes(e.dir), parts: MoveFaceOp.edgeParts });
        this.gimbal.setCenter(e.mid);
      } else if (e) this.showHandle({ base: e.mid, normal: e.dir }, "dot", () => new EdgeOp(this.app, "fillet", this.edgeRefs()).grabFromEdge());
    }
  }

  /** Called by the app when a top-level tool needs a selection first. */
  /**
   * A pick made in Items (a phone's surest way to pick a body): a tool waiting
   * for one takes it - Repair Body sat on "select body" while the pod was
   * picked in the list. False when nothing waits for it.
   */
  pickFromList(s: Sel): boolean {
    if (!this.pending || !this.pending.accepts.includes(s.kind)) return false;
    const run = this.pending.run;
    this.pending = null;
    this.app.setSelection([s]);
    run();
    return true;
  }

  waitFor(label: string, accepts: Sel["kind"][], run: () => void): void {
    this.pending = { label, accepts, run };
    this.app.setSelection([]);
  }

  // --------------------------------------------------------------- menus

  /** The list for what's picked, its groups apart with a dim line. */
  private actions(): ToolItem[] {
    return withGroups(this.actionList());
  }

  private actionList(): ToolItem[] {
    const sel = this.app.selection;
    if (!sel.length) return [];
    const head: ToolItem[] = [{ id: "deselect", label: "Deselect All", icon: "deselect", shortcut: "Esc", sub: `${sel.length} ${label(sel[0], sel.length)}`, run: () => this.app.setSelection([]) }];
    // A freeform body (or a face/edge/point of one): open its cage, picking the spot that was tapped.
    const first = sel[0];
    const ffBody = "body" in first ? first.body : "";
    const ff = ffBody ? this.freeformOf(ffBody) : undefined;
    // Editing a copy: it becomes its own freeform first (unless it is linked).
    const own = () => this.ownFreeform(ffBody) ?? ff!;
    if (ff?.type === "freeform") head.push({ id: "editFreeform", label: "Edit Freeform", icon: "freeform", shortcut: "F2", run: () => this.editFreeform(own()) });
    // Border edges of open freeforms (one surface or two): connect them with new faces.
    const edgeSel = sel.filter((x): x is Extract<Sel, { kind: "edge" }> => x.kind === "edge");
    if (edgeSel.length >= 2 && edgeSel.length === sel.length) {
      const bodies = [...new Set(edgeSel.map((x) => x.body))];
      const open = bodies.every((b) => {
        const f = this.freeformOf(b);
        return !!f && !isClosed(f.cage);
      });
      if (open && bodies.length <= 2) head.push({ id: "connect", label: "Connect", icon: "loft", sub: bodies.length === 2 ? "Join the two surfaces" : "New faces between the edges", run: () => this.connectEdges(edgeSel) });
    }
    // An open freeform (faces deleted, or a surface): close a hole, or give it a thickness.
    if (ff?.type === "freeform" && !isClosed(ff.cage)) {
      if (first.kind === "edge") {
        const at = sel.flatMap((x) => (x.kind === "edge" ? [this.app.view.body(x.body)?.edges[x.edge]?.mid].filter((p): p is Vec3 => !!p) : []));
        head.push({
          id: "fillHole",
          label: "Fill hole",
          icon: "fill",
          run: () => {
            const tool = new FreeformTool(this.app, { feature: own() });
            this.app.setTool(tool);
            if (!tool.fillHoleAt(at)) this.app.ui.toast("No hole there to fill");
            else this.app.ui.toast("Hole filled - Done keeps it");
          },
        });
      }
      head.push({ id: "thicken", label: "Thickness…", icon: "shell", run: () => this.app.setTool(new FreeformTool(this.app, { feature: own() })) });
    }
    // A face, edge or point of a freeform: its shape comes from the cage -
    // fillet, chamfer, offset face… don't apply (they were listed all the same).
    if (ff?.type === "freeform" && (first.kind === "face" || first.kind === "edge" || first.kind === "vertex")) {
      const bodies = bodiesOf(sel);
      const app = this.app;
      return [
        ...head,
        { id: "moveBody", label: "Move/Rotate Body", icon: "move", run: () => app.setTool(new TransformOp(app, "move", bodies)) },
        { id: "mirror", label: "Mirror", icon: "mirror", run: () => app.setTool(new TransformOp(app, "mirror", bodies)) },
        { id: "patl", label: "Pattern – Linear", icon: "patternLinear", run: () => app.setTool(new TransformOp(app, "linear", bodies)) },
        { id: "patc", label: "Pattern – Circular", icon: "patternCircular", run: () => app.setTool(new TransformOp(app, "circular", bodies)) },
        { id: "deleteBody", label: "Delete Body", icon: "trash", run: () => (app.store.add({ ...app.store.newIdentity("delete"), type: "delete", bodies }), app.setSelection([])) },
      ];
    }
    switch (sel[0].kind) {
      case "profile":
        return [...head, ...this.profileActions()];
      case "face":
        return [...head, ...this.faceActions()];
      case "edge":
        return [...head, ...this.edgeActions()];
      case "body":
        return [...head, ...this.bodyActions()];
      case "plane":
        return [...head, ...this.planeActions()];
      case "axis":
        return [...head, ...this.axisActions()];
      case "vertex": {
        const bodies = bodiesOf(sel);
        const s = sel[0] as Extract<Sel, { kind: "vertex" }>;
        const pivot = this.app.view.vertexOf(s.body, s.vertex);
        const at = sel.flatMap((x) => (x.kind === "vertex" && x.body === s.body ? [this.app.view.vertexOf(x.body, x.vertex)!].filter(Boolean) : []));
        // A freeform's points move in Edit Freeform (at the top of this list), not here.
        const isFreeform = !!ff && ff.type === "freeform";
        return [
          ...head,
          ...(isFreeform ? [] : [{ id: "moveVertex", label: "Move Vertex", icon: "move" as const, shortcut: "M", active: true, disabled: !pivot, run: () => pivot && this.app.setTool(new MoveFaceOp(this.app, { vertex: { body: s.body, at: pivot } })) }]),
          { id: "move", label: "Move/Rotate Body", icon: "move", run: () => this.app.setTool(new TransformOp(this.app, "move", bodies, undefined, pivot)) },
          { id: "delete", label: "Delete Vertex", icon: "trash", shortcut: "Del", run: () => this.deleteGeom(s.body, { vertices: at }) },
        ];
      }
      case "image": {
        const img = this.app.store.find<ImageFeature>((sel[0] as Extract<Sel, { kind: "image" }>).id);
        if (!img) return head;
        return [
          ...head,
          { id: "move", label: "Move/Rotate", icon: "move", shortcut: "M", active: true, run: () => this.app.setTool(new ImageOp(this.app, img)) },
          { id: "scale", label: "Scale / Opacity", icon: "scale", shortcut: "S", run: () => this.app.setTool(new ImageOp(this.app, img)) },
          { id: "delete", label: "Delete", icon: "trash", shortcut: "Del", run: () => (this.app.store.remove(img.id), this.app.setSelection([])) },
        ];
      }
      default:
        return head;
    }
  }

  private profileActions(): ToolItem[] {
    const app = this.app;
    const sel = app.selection;
    const src = sourcesOf(app, sel)[0] as Extract<ExtrudeSource, { kind: "profile" }> | undefined;
    const sketchId = (sel[0] as Extract<Sel, { kind: "profile" }>).sketch;
    const plane = app.sketchPlane(sketchId);
    const inSketch = (kind: string) => () => this.openSketch(sketchId, kind);
    const frame = src ? sourceFrame(app, src) : null;
    return [
      { id: "sketch", label: "Sketch", icon: "sketch", run: inSketch("line") },
      { id: "move", label: "Move/Rotate", icon: "move", shortcut: "M", run: inSketch("move") },
      // The whole sketch to a parallel plane (or slid in its own), as a copy or moved.
      { id: "copySketch", label: "Copy to Plane", icon: "copy", sub: "Gimbal: parallel plane", run: () => frame && app.setTool(new SketchMoveOp(app, sketchId, frame.base, true)) },
      { id: "scale", label: "Scale Sketch", icon: "scale", run: inSketch("scale") },
      { id: "patl", label: "Pattern – Linear", icon: "patternLinear", run: inSketch("patternLinear") },
      { id: "patc", label: "Pattern – Circular", icon: "patternCircular", run: inSketch("patternCircular") },
      // Starts at the last distance used (the preview shows at once: Enter keeps it).
      { id: "extrude", label: "Extrude", icon: "extrude", shortcut: "E", active: true, run: () => src && app.setTool(new ExtrudeOp(app, src, undefined, "auto", { distance: 0 })) },
      { id: "axis", label: "Axis – Perp. to Face", icon: "axis", run: () => frame && app.setTool(new AxisOp(app, frame.base, frame.normal)) },
      { id: "plane", label: "Plane – Offset", icon: "plane", run: () => plane && app.setTool(new PlaneOp(app, plane, undefined)) },
      { id: "text", label: "Text", icon: "text", run: inSketch("text") },
      { id: "rotate", label: "Rotate Around Axis", icon: "rotateAxis", run: inSketch("rotate") },
      { id: "mirror", label: "Mirror", icon: "mirror", run: inSketch("mirror") },
      { id: "loft", label: "Loft", icon: "loft", run: () => app.setTool(new LoftOp(app, sourcesOf(app, sel).flatMap(splitRegions), sel)) },
      { id: "split", label: "Split Body", icon: "split", disabled: !app.view.bodyList.length || !plane, why: "Needs a body", run: () => this.splitWith(plane!) },
      { id: "revolve", label: "Revolve", icon: "revolve", shortcut: "R", run: () => src && app.setTool(new RevolveOp(app, src)) },
      { id: "sweep", label: "Sweep", icon: "sweep", shortcut: "W", run: () => src && app.setTool(new SweepOp(app, src)) },
      { id: "offset", label: "Offset Edge", icon: "offset", shortcut: "O", run: inSketch("offset") },
      { id: "projs", label: "Project as Sketch", icon: "project", disabled: true, why: SOON },
      { id: "proje", label: "Project as Edge", icon: "projectEdge", disabled: true, why: SOON },
      { id: "wrap", label: "Wrap & Emboss", icon: "wrap", disabled: true, why: SOON },
      { id: "delete", label: "Delete", icon: "trash", shortcut: "Del", run: () => this.deleteProfiles() },
    ];
  }

  private faceActions(): ToolItem[] {
    const app = this.app;
    const sel = app.selection;
    const s = sel[0] as Extract<Sel, { kind: "face" }>;
    const info = app.view.body(s.body)?.faces[s.face];
    const flat = !!info?.plane;
    const one = sel.length === 1;
    const src = sourcesOf(app, sel)[0];
    const faceRefs = sel.flatMap((x) => (x.kind === "face" ? [faceRefOf(app, x)!] : []));
    const needFlat = { disabled: !flat || !one, why: "Needs one flat face" };
    const ref = faceRefOf(app, s);
    return [
      { id: "sketch", label: "Sketch", icon: "sketch", shortcut: "S", ...needFlat, run: () => this.sketchOnFace() },
      // Moves just this face; the rest of the body stretches to follow.
      { id: "move", label: "Move/Rotate Face", icon: "moveFace", shortcut: "M", ...needFlat, run: () => ref && info?.plane && app.setTool(new MoveFaceOp(app, { face: ref, plane: info.plane })) },
      // Scales just this face, within its plane; the sides tilt to follow.
      { id: "scale", label: "Scale Face", icon: "scale", ...needFlat, run: () => ref && info?.plane && app.setTool(new ScaleFaceOp(app, ref, info.plane)) },
      { id: "align", label: "Align", icon: "align", disabled: true, why: SOON },
      { id: "thread", label: "Thread", icon: "thread", disabled: !one || !info?.round, why: "Needs one round face (a shank or a hole)", run: () => app.startThread() },
      { id: "offsetFace", label: "Offset Face", icon: "offsetFace", shortcut: "E", active: true, disabled: !one || !offsettable(info?.type), why: "Needs one flat or round face", run: () => src && app.setTool(new ExtrudeOp(app, src)) },
      { id: "fillet", label: "Fillet", icon: "fillet", shortcut: "F", run: () => this.edgesOfFaces("fillet") },
      { id: "chamfer", label: "Chamfer", icon: "chamfer", run: () => this.edgesOfFaces("chamfer") },
      { id: "extrude", label: "Extrude", icon: "extrude", ...needFlat, run: () => src && app.setTool(new ExtrudeOp(app, src, undefined, "new")) },
      { id: "shell", label: "Shell", icon: "shell", run: () => app.setTool(new ShellOp(app, s.body, faceRefs)) },
      { id: "axis", label: "Axis – Perp. to Face", icon: "axis", run: () => info && app.setTool(new AxisOp(app, info.center, info.normal)) },
      { id: "plane", label: "Plane – Offset", icon: "plane", ...needFlat, run: () => info?.plane && app.setTool(new PlaneOp(app, info.plane, faceRefOf(app, s)!)) },
      { id: "loft", label: "Loft", icon: "loft", ...needFlat, run: () => app.setTool(new LoftOp(app, sourcesOf(app, sel).flatMap(splitRegions), sel)) },
      { id: "split", label: "Split Body", icon: "split", disabled: !flat || app.view.bodyList.length < 2, why: "Needs another body to split", run: () => this.splitWith(info!.plane!, s.body) },
      { id: "revolve", label: "Revolve", icon: "revolve", ...needFlat, run: () => src && app.setTool(new RevolveOp(app, src)) },
      { id: "sweep", label: "Sweep", icon: "sweep", ...needFlat, run: () => src && app.setTool(new SweepOp(app, src)) },
      // What else works on the face itself (patterns, mirror, translate, move
      // body are body tools: they're offered when the body is selected).
      { id: "replace", label: "Replace Face", icon: "replaceFace", ...needFlat, run: () => ref && app.setTool(new ReplaceFaceOp(app, ref)) },
      { id: "projs", label: "Project as Sketch", icon: "project", ...needFlat, run: () => this.projectFace("select") },
      // The neighbours extend to close the gap (fillets, chamfers, holes).
      { id: "delete", label: "Delete Face", icon: "trash", shortcut: "Del", run: () => this.deleteGeom(s.body, { faces: faceRefs.filter((f) => f.body === s.body) }) },
    ];
  }

  private edgeActions(): ToolItem[] {
    const app = this.app;
    const sel = app.selection;
    const s = sel[0] as Extract<Sel, { kind: "edge" }>;
    const info = app.view.body(s.body)?.edges[s.edge];
    const bodies = bodiesOf(sel);
    const straight = info?.type === "LINE";
    const ref = this.edgeRefs()[0];
    // With variables defined, Fillet/Chamfer open a list: a free size, or one of the variables.
    const vars = app.store.doc.variables ?? [];
    const sized = (kind: "fillet" | "chamfer"): Partial<ToolItem> =>
      vars.length
        ? {
            sub: "Pick a size",
            children: [
              { id: `${kind}-free`, label: "Drag / type", icon: kind, run: () => app.setTool(new EdgeOp(app, kind, this.edgeRefs())) },
              ...vars.map((v) => ({ id: `${kind}-var-${v.name}`, label: `${v.name} = ${v.expr}`, icon: "variable" as const, run: () => app.setTool(new EdgeOp(app, kind, this.edgeRefs(), undefined, v.name)) })),
            ],
          }
        : {};
    return [
      { id: "fillet", label: "Fillet", icon: "fillet", shortcut: "F", active: true, run: () => app.setTool(new EdgeOp(app, "fillet", this.edgeRefs())), ...sized("fillet") },
      { id: "chamfer", label: "Chamfer", icon: "chamfer", shortcut: "C", run: () => app.setTool(new EdgeOp(app, "chamfer", this.edgeRefs())), ...sized("chamfer") },
      // A line on a face, parallel to this edge (the face is tapped next).
      { id: "offsetEdge", label: "Offset Edge", icon: "offsetEdge", disabled: !straight || sel.length !== 1, why: "Needs one straight edge", run: () => app.setTool(new OffsetEdgeOp(app, s)) },
      // Moves just this edge: the faces on it tilt to follow.
      { id: "move", label: "Move/Rotate Edge", icon: "moveEdge", shortcut: "M", disabled: !straight || sel.length !== 1, why: "Needs one straight edge", run: () => ref && app.setTool(new MoveFaceOp(app, { edge: ref })) },
      { id: "moveBody", label: "Move/Rotate Body", icon: "move", run: () => app.setTool(new TransformOp(app, "move", bodies)) },
      // A round edge (a hole's rim, a shank's end): thread the round face it bounds - in a small hole the rim is what a finger hits.
      ...(info?.type === "CIRCLE" && sel.length === 1 ? [{ id: "thread", label: "Thread", icon: "thread" as const, run: () => app.startThread() }] : []),
      // Along a straight edge; through the centre of a round one (a rim, a hole).
      {
        id: "axis",
        label: info?.type === "CIRCLE" ? "Axis – Through Centre" : "Axis – Along Edge",
        icon: "axis",
        disabled: !straight && info?.type !== "CIRCLE",
        why: "Needs a straight or round edge",
        run: () => {
          if (!info) return;
          const ax = info.type === "CIRCLE" ? circleAxis(info.start, info.mid, info.end, info.dir) : { origin: info.start, dir: info.dir };
          if (ax) app.setTool(new AxisOp(app, ax.origin, ax.dir));
        },
      },
      { id: "planePerp", label: "Plane – Perp. to Edge", icon: "plane", run: () => info && app.setTool(new PlaneOp(app, { origin: info.mid, normal: info.dir, xDir: perpTo(info.dir) }, undefined)) },
      { id: "translate", label: "Translate", icon: "translate", shortcut: "N", run: () => app.setTool(new TransformOp(app, "translate", bodies)) },
      { id: "rotate", label: "Rotate Around Axis", icon: "rotateAxis", run: () => app.setTool(new TransformOp(app, "rotate", bodies)) },
      { id: "proje", label: "Project as Edge", icon: "projectEdge", disabled: true, why: SOON },
      { id: "delete", label: "Delete Edge", icon: "trash", shortcut: "Del", run: () => this.deleteGeom(s.body, { edges: this.edgeRefs().filter((e) => e.body === s.body) }) },
    ];
  }

  private bodyActions(): ToolItem[] {
    const app = this.app;
    const bodies = bodiesOf(app.selection);
    const multi = bodies.length >= 2;
    // An open surface (it has open edges: a sheet, not a solid).
    const openSurface = bodies.length === 1 && !!app.view.bodyList.find((b) => b.id === bodies[0])?.openEdges?.length;
    const boolean = (op: "union" | "subtract" | "intersect") => () => {
      const f = { ...app.store.newIdentity("boolean", cap(op)), type: "boolean" as const, op, target: bodies[0], tools: bodies.slice(1) };
      // Tried first: one that can't be done (e.g. Union of bodies that don't touch) says why and isn't added.
      void app.preview([...app.store.features, f]).then((r) => {
        const err = r?.errors.find((e) => e.featureId === f.id);
        if (err) {
          app.ui.toast(err.message);
          void app.preview([...app.store.features]);
          return;
        }
        app.store.add(f);
        app.setSelection([{ kind: "body", body: bodies[0] }]);
      });
    };
    // A body of a pattern picked: the rest of it in one tap (eight vents to
    // subtract were eight double-taps on small targets).
    const chosen = new Set(bodies);
    const ids = app.view.bodyList.map((b) => b.id);
    const pattern = app.store.features
      .flatMap((f) => (f.type === "transform" && (f.op.kind === "linear" || f.op.kind === "circular") && !f.suppressed ? f.bodies.map((b) => [b, ...ids.filter((id) => id.startsWith(`${f.id}:${b}:`))]) : []))
      .find((g) => g.length > 1 && g.some((id) => chosen.has(id)) && !g.every((id) => chosen.has(id)));
    return [
      ...(pattern
        ? [{ id: "wholePattern", label: "Whole Pattern", icon: "patternCircular" as const, sub: `${pattern.length} bodies`, run: () => app.setSelection([...app.selection, ...pattern.filter((id) => !chosen.has(id)).map((body) => ({ kind: "body" as const, body }))]) }]
        : []),
      { id: "move", label: "Move/Rotate", icon: "move", shortcut: "M", active: true, run: () => app.setTool(new TransformOp(app, "move", bodies)) },
      {
        id: "scale",
        label: "Scale",
        icon: "scale",
        // Starts the kind used last.
        sub: lastScale.xyz ? "X / Y / Z" : "Uniform",
        run: () => app.setTool(new ScaleOp(app, lastScale.xyz, bodies)),
        children: [
          { id: "scaleUniform", label: "Uniform", icon: "scale", active: !lastScale.xyz, run: () => ((lastScale.xyz = false), app.setTool(new ScaleOp(app, false, bodies))) },
          { id: "scaleXYZ", label: "X / Y / Z", icon: "scale", sub: "freeform bodies", active: lastScale.xyz, run: () => ((lastScale.xyz = true), app.setTool(new ScaleOp(app, true, bodies))) },
        ],
      },
      { id: "translate", label: "Translate", icon: "translate", shortcut: "N", run: () => app.setTool(new TransformOp(app, "translate", bodies)) },
      { id: "patl", label: "Pattern – Linear", icon: "patternLinear", run: () => app.setTool(new TransformOp(app, "linear", bodies)) },
      { id: "patc", label: "Pattern – Circular", icon: "patternCircular", run: () => app.setTool(new TransformOp(app, "circular", bodies)) },
      { id: "rotate", label: "Rotate Around Axis", icon: "rotateAxis", run: () => app.setTool(new TransformOp(app, "rotate", bodies)) },
      { id: "mirror", label: "Mirror", icon: "mirror", run: () => app.setTool(new TransformOp(app, "mirror", bodies)) },
      { id: "union", label: "Union", icon: "union", shortcut: "U", disabled: !multi, why: "Select 2+ bodies", run: boolean("union") },
      // Subtract / Intersect open their tool with the bodies picked (+ the first, − the rest): Keep options there.
      { id: "subtract", label: "Subtract", icon: "subtract", disabled: !multi, why: "Select 2+ bodies (first is kept)", run: () => app.setTool(new BooleanOp(app, "subtract", bodies[0], bodies.slice(1))) },
      { id: "intersect", label: "Intersect", icon: "intersect", disabled: !multi, why: "Select 2+ bodies", run: () => app.setTool(new BooleanOp(app, "intersect", bodies[0], bodies.slice(1))) },
      { id: "split", label: "Split Body", icon: "split", run: () => app.setTool(new SplitOp(app, bodies[0])) },
      // An open surface (a freeform sheet): filled down to a plane to make it a solid.
      ...(openSurface ? [{ id: "fillToPlane", label: "Fill to Plane", icon: "fill" as const, run: () => app.setTool(new FillToPlaneOp(app, bodies[0])) }] : []),
      { id: "shell", label: "Shell", icon: "shell", run: () => app.setTool(new ShellOp(app, bodies[0], [])) },
      {
        id: "color",
        label: "Color",
        icon: "color",
        sub: BODY_COLORS.find((c) => c.hex === bodyColor((app.store.doc.colors ?? {})[bodies[0]]))?.name ?? ((app.store.doc.colors ?? {})[bodies[0]] ? "Custom" : "Grey"),
        children: [...BODY_COLORS.map((c, i): ToolItem => ({
          id: `color-${i}`,
          label: c.name,
          icon: "color",
          swatch: c.hex,
          active: (bodyColor((app.store.doc.colors ?? {})[bodies[0]]) ?? BODY_COLORS[0].hex) === c.hex,
          run: () =>
            app.store.commit((d) => {
              const colors = { ...(d.colors ?? {}) };
              for (const b of bodies) if (i === 0) delete colors[b];
              else colors[b] = c.hex;
              d.colors = colors;
            }),
        })),
        // Any colour (a dark lamp base, a brass shade): the ten soft ones
        // couldn't give what a model made by code had.
        ((): ToolItem => {
          const now = bodyColor((app.store.doc.colors ?? {})[bodies[0]]);
          const custom = !!now && !BODY_COLORS.some((c) => c.hex === now);
          return {
            id: "color-custom",
            label: "Custom…",
            icon: "color" as const,
            ...(custom ? { swatch: now } : {}),
            active: custom,
            run: () => {
              const input = document.createElement("input");
              input.type = "color";
              input.value = now ?? BODY_COLORS[0].hex;
              input.style.cssText = "position:fixed;left:-100px;top:0;opacity:0";
              document.body.append(input);
              const set = (final: boolean) => {
                const hex = input.value;
                const write = (d: { colors?: Record<string, string> }) => {
                  const colors = { ...(d.colors ?? {}) };
                  for (const b of bodies) colors[b] = hex;
                  d.colors = colors;
                };
                // One undo step for the whole pick: live while choosing, kept on change.
                if (final) app.store.commit(write);
                else app.store.transient(write);
                if (final) input.remove();
              };
              input.addEventListener("input", () => set(false));
              input.addEventListener("change", () => set(true));
              input.click();
            },
          };
        })(),
        ],
      },
      {
        // Next to Color: how see-through the body is.
        id: "opacity",
        label: "Transparency",
        icon: "color",
        sub: BODY_OPACITY.find((o) => o.value === ((app.store.doc.opacity ?? {})[bodies[0]] ?? 1))?.name ?? "Solid",
        children: BODY_OPACITY.map((o, i) => ({
          id: `opacity-${i}`,
          label: o.name,
          icon: "color",
          active: ((app.store.doc.opacity ?? {})[bodies[0]] ?? 1) === o.value,
          run: () =>
            app.store.commit((d) => {
              const op = { ...(d.opacity ?? {}) };
              for (const b of bodies) if (o.value >= 1) delete op[b];
              else op[b] = o.value;
              d.opacity = op;
            }),
        })),
      },
      { id: "delete", label: "Delete", icon: "trash", shortcut: "Del", run: () => this.deleteBodies(bodies) },
    ];
  }

  private planeActions(): ToolItem[] {
    const app = this.app;
    const s = app.selection[0] as Extract<Sel, { kind: "plane" }>;
    const plane = app.view.planeOf(s.id);
    const isFeature = !!app.store.find(s.id);
    return [
      { id: "sketch", label: "Sketch", icon: "sketch", shortcut: "S", run: () => plane && (app.setSelection([]), app.setTool(new SketchTool(app, { plane }))) },
      { id: "plane", label: "Plane – Offset", icon: "plane", run: () => plane && app.setTool(new PlaneOp(app, plane, undefined)) },
      { id: "split", label: "Split Body", icon: "split", disabled: !app.view.bodyList.length, why: "Needs a body", run: () => plane && this.splitWith(plane) },
      { id: "delete", label: "Delete", icon: "trash", shortcut: "Del", disabled: !isFeature, why: "Origin planes can't be deleted", run: () => (app.store.remove(s.id), app.setSelection([])) },
    ];
  }

  private axisActions(): ToolItem[] {
    const app = this.app;
    const s = app.selection[0] as Extract<Sel, { kind: "axis" }>;
    return [{ id: "delete", label: "Delete", icon: "trash", shortcut: "Del", run: () => (app.store.remove(s.id), app.setSelection([])) }];
  }

  // ------------------------------------------------------------- helpers

  private showHandle(frame: { base: Vec3; normal: Vec3 }, shape: "arrow" | "dot", action: () => Tool): void {
    this.handle = new Handle(this.app.view, shape);
    this.handle.set(frame.base, shape === "arrow" ? frame.normal : undefined);
    this.handleAction = action;
  }

  private clearHandle(): void {
    this.handle?.dispose();
    this.handle = null;
    this.handleAction = null;
    this.gimbal?.dispose();
    this.gimbal = null;
    this.copyToggle?.dispose();
    this.copyToggle = null;
    clearTimeout(this.dimTimer);
    this.dim?.dispose();
    this.dim = null;
  }

  /**
   * A selected flat face shows its thickness to the opposite face (Total);
   * typing a value or switching to Offset starts Offset Face right away.
   */
  private showFaceDimension(s: Extract<Sel, { kind: "face" }>, src: ExtrudeSource): void {
    const f = this.app.view.body(s.body)!.faces[s.face];
    const opp = oppositeFace(this.app, s.body, s.face);
    if (!opp) return;
    const start = (measure: "total" | "offset", distance: number, typed?: string) =>
      this.app.setTool(new ExtrudeOp(this.app, src, undefined, "auto", { measure, distance, typed }));
    // Shown a moment later, beside the face - never under the pointer while you double-click for the body.
    this.dimTimer = window.setTimeout(() => {
      this.dim = new DimWidget(this.app.view, {
        value: opp.distance,
        // Past the tip of the extrude arrow, which starts at the face.
        boxAt: "beyond",
        boxGap: 96,
        dir: f.normal,
        modes: [{ id: "total", label: "Total" }, { id: "offset", label: "Offset" }],
        mode: "total",
        onMode: (m) => start(m as "total" | "offset", 0),
        onInput: (v) => start("total", v - opp.distance, this.dim?.text),
        onPin: () => this.app.addPin({ text: fmtLen(opp.distance), a: opp.point, b: f.center, at: scale(add(opp.point, f.center), 0.5) }),
        // ƒx: the thickness becomes a variable (and follows it when it changes).
        variables: this.app.store.doc.variables.map((v) => v.name),
        onVariable: (name) => {
          const v = evaluate(name, "length");
          if (v === null) return;
          const offset = Math.round((v - opp.distance) * 1e9) / 1e9;
          this.app.setTool(new ExtrudeOp(this.app, src, undefined, "auto", { measure: "total", distance: offset, expr: `${name} - ${Math.round(opp.distance * 1e6) / 1e6}mm` }));
        },
      });
      this.dim.set(opp.point, f.center);
    }, 400);
  }

  private dimTimer = 0;

  /**
   * Two faces: their distance as a dimension with a pin. Parallel flat faces:
   * the gap between them; otherwise centre to centre.
   */
  private showFacesDistance(a: Extract<Sel, { kind: "face" }>, b: Extract<Sel, { kind: "face" }>): void {
    const fa = this.app.view.body(a.body)?.faces[a.face];
    const fb = this.app.view.body(b.body)?.faces[b.face];
    if (!fa || !fb) return;
    const n = fa.normal;
    const parallel = !!fa.plane && !!fb.plane && Math.abs(dot(n, fb.normal)) > 0.9999;
    const p0 = fa.center;
    const p1 = parallel ? add(p0, scale(n, dot(sub(fb.center, p0), n))) : fb.center;
    const d = len(sub(p1, p0));
    this.dim = new DimWidget(this.app.view, {
      value: d,
      boxAt: "side",
      onPin: () => this.app.addPin({ text: fmtLen(d), a: p0, b: p1, at: scale(add(p0, p1), 0.5) }),
    });
    this.dim.set(p0, p1);
    this.app.ui.setHint(`${parallel ? "Distance between the faces" : "Centre to centre"}: ${fmtLen(d)}`);
  }

  private edgeRefs(): EdgeRef[] {
    return this.app.selection.flatMap((s) => (s.kind === "edge" ? [edgeRefOf(this.app, s)!].filter(Boolean) : []));
  }

  /** Fillet/chamfer every edge lying on the selected flat faces. */
  private edgesOfFaces(kind: "fillet" | "chamfer"): void {
    const refs: EdgeRef[] = [];
    for (const s of this.app.selection) {
      if (s.kind !== "face") continue;
      const b = this.app.view.body(s.body);
      const f = b?.faces[s.face];
      if (!b || !f?.plane) continue;
      b.edges.forEach((e, i) => {
        const on = [e.start, e.end, e.mid].every((p) => Math.abs((p[0] - f.center[0]) * f.normal[0] + (p[1] - f.center[1]) * f.normal[1] + (p[2] - f.center[2]) * f.normal[2]) < 1e-5);
        if (on) refs.push(edgeRefOf(this.app, { body: s.body, edge: i })!);
      });
    }
    if (!refs.length) return this.app.ui.toast("Select flat faces, or tap the edges directly");
    this.app.setTool(new EdgeOp(this.app, kind, refs));
  }

  private sketchOnFace(kind?: string): void {
    const s = this.app.selection[0] as Extract<Sel, { kind: "face" }>;
    const info = this.app.view.body(s.body)?.faces[s.face];
    if (!info?.plane) return;
    const ref = faceRefOf(this.app, s)!;
    this.app.setSelection([]);
    const tool = new SketchTool(this.app, { plane: originOnPlane(info.plane), attachedTo: ref });
    this.app.setTool(tool);
    if (kind) tool.setKind(kind as SketchKind);
  }

  /** Project the face outline into a new sketch on that face. */
  private projectFace(then: string): void {
    const s = this.app.selection[0] as Extract<Sel, { kind: "face" }>;
    const b = this.app.view.body(s.body);
    const f = b?.faces[s.face];
    if (!b || !f?.plane) return;
    const plane = f.plane;
    const entities = b.edges.flatMap((e, i) => {
      const on = [e.start, e.end, e.mid].every((p) => Math.abs((p[0] - f.center[0]) * f.normal[0] + (p[1] - f.center[1]) * f.normal[1] + (p[2] - f.center[2]) * f.normal[2]) < 1e-5);
      if (!on) return [];
      const g = b.edgeGroups.find((x) => x.edge === i)!;
      const pts: Vec3[] = [];
      for (let k = g.start; k < g.start + g.count; k++) if ((k - g.start) % 2 === 0 || k === g.start + g.count - 1) pts.push([b.edgePositions[k * 3], b.edgePositions[k * 3 + 1], b.edgePositions[k * 3 + 2]]);
      const ent = projectPolyline(pts, plane, e.type);
      return ent ? [ent] : [];
    });
    const sk: SketchFeature = { ...this.app.store.newIdentity("sketch"), type: "sketch", plane, attachedTo: faceRefOf(this.app, s)!, entities };
    this.app.store.add(sk);
    this.openSketch(sk.id, then);
  }

  private openSketch(sketchId: string, kind: string): void {
    // Preselect the curves bounding the selected regions for sketch-level edits.
    const sk = this.app.store.find<SketchFeature>(sketchId);
    const regions = this.app.selection.filter((s): s is Extract<Sel, { kind: "profile" }> => s.kind === "profile" && s.sketch === sketchId).map((s) => s.region);
    const ids = new Set<string>();
    if (sk) {
      const arr = arrangement(this.app.sketchCurves(sketchId));
      for (const ri of regions) {
        const r = arr.regions[ri];
        for (const loop of [r?.outer, ...(r?.holes ?? [])])
          for (const ref of loop?.pieces ?? []) {
            const src = arr.prims[arr.pieces[ref.piece].prim].src;
            if (!src.startsWith("bnd-")) ids.add(src);
          }
      }
    }
    this.app.setSelection([]);
    const tool = new SketchTool(this.app, { sketchId });
    this.app.setTool(tool);
    tool.setKind(kind as SketchKind);
    if (ids.size && kind !== "line" && kind !== "text") tool.preselect(ids);
  }

  private splitWith(plane: PlaneDef, exceptBody?: string): void {
    const body = this.app.view.bodyList.find((b) => b.id !== exceptBody)?.id;
    if (body) this.app.setTool(new SplitOp(this.app, body, undefined, plane));
  }

  private deleteProfiles(): void {
    const sel = this.app.selection.filter((s): s is Extract<Sel, { kind: "profile" }> => s.kind === "profile");
    const sk = sel[0] && this.app.store.find<SketchFeature>(sel[0].sketch);
    if (!sk) return;
    const arr = arrangement(this.app.sketchCurves(sk.id));
    // Remove curves that only bound the selected regions (face outline curves aren't the sketch's).
    const used = new Map<string, Set<number>>();
    arr.regions.forEach((r) => {
      for (const loop of [r.outer, ...r.holes]) for (const ref of loop.pieces) {
        const src = arr.prims[arr.pieces[ref.piece].prim].src;
        used.set(src, (used.get(src) ?? new Set()).add(r.index));
      }
    });
    const chosen = new Set(sel.map((s) => s.region));
    const doomed = [...used].filter(([, rs]) => [...rs].every((r) => chosen.has(r))).map(([id]) => id);
    this.app.store.update(sk.id, { entities: sk.entities.filter((e) => !doomed.includes(e.id)) });
    this.app.setSelection([]);
  }

  private lastTap: ToolPointer | null = null;

  /**
   * Connect picked border edges of freeform surfaces: two edges get a face
   * between them, two rows a strip, two hole rims a tube. Edges on two
   * surfaces make them one surface (ready for a Thickness).
   */
  private connectEdges(edges: Extract<Sel, { kind: "edge" }>[]): void {
    const picks = edges.flatMap((x) => {
      const mid = this.app.view.body(x.body)?.edges[x.edge]?.mid;
      return mid ? [{ body: x.body, mid }] : [];
    });
    // Copies become their own freeforms first (their ids change).
    const ids = new Map<string, string>();
    for (const b of new Set(picks.map((p) => p.body))) {
      const f = this.ownFreeform(b);
      if (!f) return this.app.ui.toast("Connect works on freeform surfaces");
      ids.set(b, f.id);
    }
    const out = connectEdges(this.app.store.doc, picks.map((p) => ({ body: ids.get(p.body)!, mid: p.mid })));
    if ("error" in out) return this.app.ui.toast(out.error);
    this.app.store.commit((d) => {
      d.features = out.doc.features;
      d.hidden = out.doc.hidden;
    });
    this.app.setSelection([{ kind: "body", body: out.body }]);
    this.app.ui.toast("Connected - Thickness… makes it a solid");
  }

  /** The freeform a body is made from (its own, or the one a copy was made of). */
  private freeformOf(body: string): FreeformFeature | undefined {
    const f = this.app.store.find<FreeformFeature>(body);
    if (f?.type === "freeform") return f;
    return freeformBodies(this.app.store.features).get(body)?.feature;
  }

  /**
   * The freeform to edit for a body. A copy that isn't linked to its original
   * becomes its own freeform first, so editing it leaves the original alone.
   */
  private ownFreeform(body: string): FreeformFeature | undefined {
    const f = this.app.store.find<FreeformFeature>(body);
    if (f?.type === "freeform") return f;
    const id = this.app.store.newIdentity("freeform").id;
    const out = detachFreeformCopy(this.app.store.doc, body, id);
    if (!out) return freeformBodies(this.app.store.features).get(body)?.feature;
    this.app.store.commit((d) => {
      d.features = out.doc.features;
      d.hidden = out.doc.hidden;
      d.names = out.doc.names;
      if (out.doc.colors) d.colors = out.doc.colors;
    });
    return this.app.store.find<FreeformFeature>(id);
  }

  private editFreeform(ff: FreeformFeature): void {
    const at = this.lastTap;
    const tool = new FreeformTool(this.app, { feature: ff });
    this.app.setTool(tool);
    if (at) tool.selectAt(at);
  }

  /** Delete faces/edges/vertices of one body; tells the user when it can't heal. */
  private deleteGeom(body: string, what: { faces?: FaceRef[]; edges?: EdgeRef[]; vertices?: Vec3[] }): void {
    // A freeform body: the cage loses the faces there, and stays open for a thickness.
    const ff = this.freeformOf(body) && this.ownFreeform(body);
    if (ff) {
      const tool = new FreeformTool(this.app, { feature: ff });
      this.app.setTool(tool);
      if (what.faces?.length) tool.deleteAt(what.faces.map((f) => f.center), "face");
      else if (what.edges?.length) tool.deleteAt(what.edges.map((e) => e.mid), "edge");
      else if (what.vertices?.length) tool.deleteAt(what.vertices, "vertex");
      return;
    }
    const f: DeleteGeomFeature = { ...this.app.store.newIdentity("deleteGeom"), type: "deleteGeom", body, faces: what.faces ?? [], edges: what.edges ?? [], vertices: what.vertices ?? [] };
    this.app.setSelection([]);
    this.app.preview([...this.app.store.features, f]).then((r) => {
      const err = r?.errors.find((e) => e.featureId === f.id);
      if (err) {
        this.app.ui.toast(err.message);
        this.app.preview([...this.app.store.features]);
      } else this.app.store.add(f);
    });
  }

  private deleteBodies(bodies: string[]): void {
    this.app.store.add({ ...this.app.store.newIdentity("delete"), type: "delete", bodies });
    this.app.setSelection([]);
  }
}

/** Loft wants one profile per section. */
function splitRegions(s: ExtrudeSource): ExtrudeSource[] {
  return s.kind === "profile" ? s.regions.map((r) => ({ ...s, regions: [r] })) : [s];
}

/** Faces Offset Face can push: flat ones and round (cylindrical) ones. */
function offsettable(type: string | undefined): boolean {
  return type === "PLANE" || type === "CYLINDRE";
}

function flatten(items: ToolItem[]): ToolItem[] {
  return items.flatMap((i) => [i, ...flatten(i.children ?? [])]);
}

function perpTo(d: Vec3): Vec3 {
  const a: Vec3 = Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const x: Vec3 = [a[1] * d[2] - a[2] * d[1], a[2] * d[0] - a[0] * d[2], a[0] * d[1] - a[1] * d[0]];
  const l = Math.hypot(...x) || 1;
  return [x[0] / l, x[1] / l, x[2] / l];
}

function label(s: Sel, n: number): string {
  const base = { face: "face", edge: "edge", vertex: "vertex", body: "body", profile: "profile", curve: "curve", point: "point", image: "image", plane: "plane", axis: "axis", origin: "origin" }[s.kind];
  if (base === "vertex") return n === 1 ? "vertex" : "vertices";
  return n === 1 ? base : base === "body" ? "bodies" : base === "axis" ? "axes" : `${base}s`;
}

function cap(s: string): string {
  return s[0].toUpperCase() + s.slice(1);
}

/** Which Scale was used last (the button starts that one). */
const lastScale = { xyz: false };

/** Which group a list entry belongs to (a dim line goes between groups). */
const GROUP: Record<string, string> = {
  deselect: "pick", editFreeform: "pick", connect: "pick", fillHole: "pick", thicken: "pick", wholePattern: "pick",
  move: "move", moveVertex: "move", moveBody: "move", scale: "move", translate: "move", rotate: "move", mirror: "move", patl: "move", patc: "move", copySketch: "move", align: "move",
  sketch: "make", extrude: "make", revolve: "make", sweep: "make", loft: "make", shell: "make", split: "make", fillet: "make", chamfer: "make", thread: "make", offsetFace: "make", offsetEdge: "make", offset: "make", replace: "make", fill: "make", fillToPlane: "make", text: "make", wrap: "make", proje: "make", projs: "make", total: "make",
  union: "combine", subtract: "combine", intersect: "combine",
  axis: "construct", plane: "construct", planePerp: "construct",
  color: "look", opacity: "look",
  delete: "delete", deleteBody: "delete",
};

function withGroups(items: ToolItem[]): ToolItem[] {
  const out: ToolItem[] = [];
  let last = "";
  items.forEach((it, i) => {
    const g = GROUP[it.id] ?? last;
    if (i > 0 && g !== last) out.push({ id: `---${i}`, label: "", icon: "more" });
    out.push(it);
    last = g;
  });
  return out;
}
