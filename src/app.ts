import { isTouchDevice } from "./device";
import { circleAxis } from "./tools/slots";
import { CurvePointPlaneOp, EdgeAnglePlaneOp, FacePointPlaneOp, ThreePointPlaneOp } from "./tools/planeOps";
import { DocStore, parseProject } from "./doc/store";
import { SUPPORT, openSupport } from "./ui/support";
import { currentProjectId, forgetProject, keepProject, libraryEntries, newProjectId, projectText, renameProject, setCurrentProject } from "./doc/library";
import { showLibrary } from "./ui/library";
import { showAbout } from "./ui/about";
import type { EdgeFeature, ExtrudeFeature, ExtrudeSource, Feature, ProjectDoc, FillToPlaneFeature, ImageFeature, LoftFeature, PinDef, PlaneDef, PlaneFeature, RevolveFeature, ShellFeature, SketchEntity, SketchFeature, SplitFeature, SweepFeature, TransformFeature, Units, Vec3 } from "./doc/types";
import { emptyDoc } from "./doc/types";
import { createVariable, editVariables, insertFile, insertImage } from "./io/insert";
import { freeformBodies } from "./doc/freeformCopies";
import { KernelClient } from "./kernel/client";
import type { ExportFormat, RegenResult } from "./kernel/protocol";
import { settings } from "./settings";
import { PinLayer } from "./tools/annotate";
import { MeasureTool } from "./tools/measure";
import { ItemsPanel } from "./ui/items";
import { OffsetEdgeOp } from "./tools/offsetEdge";
import { AxisOp, EdgeOp, ExtrudeOp, FillToPlaneOp, ThreadOp, ImageOp, LoftOp, MidplaneOp, MoveFaceOp, PlaneOp, ReplaceFaceOp, ScaleFaceOp, ScaleOp, RevolveOp, ShellOp, SplitOp, SweepOp, TransformOp } from "./tools/ops";
import { add, dist, scale, toWorld, xDirFor } from "./geom";
import { entityPolylines } from "./sketch/curves";
import { FreeformTool } from "./tools/freeform";
import { sectionPlane, SectionTool, type SectionState } from "./tools/section";
import { SelectTool } from "./tools/select";
import { BooleanOp } from "./tools/booleanOp";
import { SketchTool } from "./tools/sketch";
import { bodiesOf, edgeRefOf, faceRefOf, sameSel, sourcesOf, type AppContext, type Sel, type Tool } from "./tools/tool";
import { setupRightColumn } from "./ui/panels";
import type { ToolItem } from "./ui/ui";
import { UI } from "./ui/ui";
import { setUnits, setVariables } from "./units";
import { InputRouter } from "./view/input";
import { ViewCube } from "./view/viewcube";
import { PivotButton } from "./ui/pivot";
import { HelpPanel } from "./ui/help";
import { icons } from "./ui/icons";
import { Updates } from "./ui/update";
import { Install } from "./ui/install";
import { exportThreeMF } from "./io/threemf";
import { sketchToDXF } from "./io/dxf";
import { isHeadset, screenClass } from "./device";
import { Viewport } from "./view/viewport";

/** The page's own title, from index.html (it names the app for search results). */
const PAGE_TITLE = document.title;

const SOON = "Coming soon";

export class App implements AppContext {
  readonly store = new DocStore();
  readonly kernel = new KernelClient();
  readonly view: Viewport;
  readonly ui = new UI();
  private input: InputRouter;
  result: RegenResult | null = null;
  selection: Sel[] = [];
  section: SectionState | null = null;
  isolated: string[] | null = null;
  private hover: Sel | null = null;
  private selectTool: SelectTool;
  private tool: Tool;
  private shownErrors = "";
  private pinLayer: PinLayer;
  private items: ItemsPanel;

  constructor(canvas: HTMLCanvasElement) {
    this.view = new Viewport(canvas);
    this.input = new InputRouter(this.view);
    this.selectTool = new SelectTool(this);
    this.tool = this.selectTool;
    this.input.handler = this.tool;
    // Headsets: bigger targets everywhere (CSS) - aiming a controller is less precise than a mouse.
    if (isHeadset) document.body.classList.add("headset");
    // A spinner while the geometry engine works on something that takes a moment.
    const busy = document.createElement("div");
    busy.id = "busy";
    busy.hidden = true;
    busy.innerHTML = `<span class="spinner"></span><span>Working…</span><button type="button" class="busy-stop" title="Stop - takes back the last change">Stop</button>`;
    document.body.append(busy);
    busy.querySelector(".busy-stop")!.addEventListener("click", () => this.stopWork());
    let busyTimer = 0;
    this.kernel.onBusy = (on) => {
      clearTimeout(busyTimer);
      // Only for waits you would notice (not every quick preview while dragging).
      if (on) busyTimer = window.setTimeout(() => (busy.hidden = false), 300);
      else busy.hidden = true;
    };
    const cube = new ViewCube(this.view);
    document.getElementById("viewcube-host")!.append(cube.el);
    // The orbit centre button sits at the cube's bottom left (Views at its bottom right).
    cube.el.append(new PivotButton(this.view, (t) => this.ui.toast(t)).el);
    // Screenshots name the isolated bodies and surfaces (when isolating).
    const isolatedNames = () =>
      (this.isolated ?? []).flatMap((id) => {
        const b = this.view.bodyList.find((x) => x.id === id);
        return b ? [this.store.doc.names?.[id] ?? b.name ?? "Body"] : [];
      });
    setupRightColumn(this.ui, this.view, this.store, (u) => this.setUnits(u), isolatedNames);
    this.pinLayer = new PinLayer(this.view);
    // ƒx buttons on number fields create named variables.
    this.ui.variableFactory = (current) => createVariable(this, current);
    this.ui.variableNames = () => this.store.doc.variables.map((v) => v.name);
    settings.onChange(() => this.showPins());
    this.items = new ItemsPanel(this.store, {
      // A phone: like taps in the view, each body tapped in Items joins the
      // selection (tapped again, it leaves) - Subtract needs two bodies, and
      // the second one replaced the first.
      selectBody: (id) => {
        if (this.tool === this.selectTool && this.selectTool.pickFromList({ kind: "body", body: id })) return;
        const had = this.selection.filter((s) => s.kind === "body");
        this.setTool(null);
        if (!isTouchDevice || !had.length || had.length !== this.selection.length) return this.setSelection([{ kind: "body", body: id }]);
        const i = had.findIndex((s) => s.kind === "body" && s.body === id);
        this.setSelection(i >= 0 ? had.filter((_, k) => k !== i) : [...had, { kind: "body", body: id }]);
      },
      editSketch: (id) => this.setTool(new SketchTool(this, { sketchId: id })),
      selectPlane: (id) => (this.setTool(null), this.setSelection([{ kind: "plane", id }])),
      deleteBody: (id) => this.store.add({ ...this.store.newIdentity("delete"), type: "delete", bodies: [id] }),
      deleteFeature: (id) => this.store.remove(id),
      selectImage: (id) => (this.setTool(null), this.setSelection([{ kind: "image", id }])),
      rename: async (id, current, isBody) => {
        const v = await this.ui.dialog("Rename", [{ key: "name", label: "Name", value: current }]);
        const name = v?.name.trim();
        if (!name) return;
        if (isBody) this.store.commit((d) => (d.names = { ...(d.names ?? {}), [id]: name }));
        else this.store.update(id, { name });
      },
      askName: async (title, current) => (await this.ui.dialog(title, [{ key: "name", label: "Name", value: current }]))?.name.trim() || null,
      isolated: () => this.isolatedWithSketches(),
    });
    // Computers and tablets start with Items open (phones: History only, there's no room for both).
    // (A phone on its side is wider than 720 px but only ~375 tall: Items would cover a third of it.)
    if (screenClass() !== "phone") this.items.toggle(true);

    this.store.onChange(() => this.docChanged());
    window.addEventListener("keydown", (e) => this.onKey(e));
    // A phone may drop the page once it's in the background: save now, undo steps included.
    document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && void this.store.flush());
    window.addEventListener("pagehide", () => void this.store.flush());
    this.wireTopbar();
    this.tool.enter?.();

    this.ui.setStatus("Loading geometry kernel…");
    const loaded = this.store.load().then(() => this.attachLibrary());
    // Every visit starts at the projects, with a welcome: shown as soon as the
    // projects are read, while the geometry kernel is still loading behind it.
    void loaded.then(() => this.showProjects(true, true));
    Promise.all([this.kernel.ready, loaded])
      .then(async () => {
        this.ui.setStatus(null);
        await this.regenerate();
        this.view.fitAll(false);
      })
      .catch((err) => this.ui.setStatus(`Could not start the geometry kernel: ${err.message ?? err}`));
  }

  // ------------------------------------------------------------ state

  setSelection(sel: Sel[]): void {
    this.selection = sel;
    this.refreshHighlights();
    // Selected bodies, planes, axes and images light up in Items too.
    this.items?.markSelected(sel.flatMap((s) => (s.kind === "body" ? [s.body] : s.kind === "plane" || s.kind === "axis" || s.kind === "image" ? [s.id] : [])));
    if (this.tool === this.selectTool) this.selectTool.refresh();
  }

  setHover(h: Sel | null): void {
    if (h === this.hover || (h && this.hover && sameSel(h, this.hover))) return;
    this.hover = h;
    this.refreshHighlights();
  }

  setTool(tool: Tool | null): void {
    const next = tool ?? this.selectTool;
    const leavingOp = this.tool !== this.selectTool;
    this.tool.exit?.();
    this.tool = next;
    this.input.handler = next;
    this.hover = null;
    this.ui.closeFlyout();
    this.ui.unfoldPanel();
    next.enter?.();
    this.updateUndo();
    // Leaving an operation drops its preview.
    if (leavingOp && next === this.selectTool) void this.regenerate();
    else this.refreshSketches();
    this.renderHistory();
  }

  /** The last section used: Section View off and on again brings it back. */
  private lastSection: SectionState | null = null;

  /**
   * Section View button: on → off (remembered); off → the remembered section,
   * or a new one - straight from a selected flat face if there is one.
   */
  private toggleSection(): void {
    if (this.section) {
      const keep = this.section;
      if (this.tool instanceof SectionTool) this.setTool(null);
      this.setSection(null);
      this.lastSection = keep;
      this.refreshTools();
      return;
    }
    const s = this.selection[0];
    const face = s?.kind === "face" ? this.view.body(s.body)?.faces[s.face] : undefined;
    if (face?.plane) {
      // Cut a hair inside the face so the face itself shows the cut.
      const inset = -this.view.cam.worldPerPixel(this.view.height);
      this.setSection({ plane: face.plane, offset: inset, flipped: false, inset });
    } else if (this.lastSection) this.setSection(this.lastSection);
    this.setTool(new SectionTool(this));
  }

  /** Re-draw the tool columns (e.g. after Section View changed). */
  private refreshTools(): void {
    if (this.tool === this.selectTool) this.selectTool.refresh();
    else this.ui.setBottom(this.bottomTools());
  }

  /** Thread the selected round face (a shank or a hole). */
  startThread(): void {
    let s = this.selection[0];
    // A round edge (a hole's rim): the round face of the same radius it bounds.
    if (s?.kind === "edge") {
      const body = this.view.body(s.body);
      const e = body?.edges[s.edge];
      if (body && e?.type === "CIRCLE") {
        const c = scale(add(e.start, e.mid), 0.5);
        const r = dist(e.start, e.mid) / 2;
        let best = -1;
        let bestD = Infinity;
        body.faces.forEach((f, i) => {
          if (!f.round || Math.abs(f.round.r - r) > r * 1e-4) return;
          const d = dist(f.center, c);
          if (d < bestD) (bestD = d), (best = i);
        });
        if (best >= 0) s = { kind: "face", body: s.body, face: best };
      }
    }
    if (s?.kind !== "face") return void this.ui.toast("Threads go on round faces: tap a shank or a hole");
    const info = this.view.body(s.body)?.faces[s.face];
    const ref = faceRefOf(this, s);
    if (!info?.round || !ref) return void this.ui.toast("Threads go on round faces: tap a shank or a hole");
    this.setSelection([s]);
    this.setTool(new ThreadOp(this, ref, info.round));
  }

  setSection(s: SectionState | null): void {
    this.section = s;
    // A section on screen is the one to remember (a deleted one is forgotten).
    if (s) this.lastSection = null;
    this.view.setSection(s ? sectionPlane(s) : null);
  }

  get pins(): PinDef[] {
    return this.store.doc.pins;
  }

  setPins(p: PinDef[]): void {
    this.store.commit((d) => (d.pins = p));
  }

  addPin(pin: PinDef): void {
    this.setPins([...this.pins, pin]);
    this.ui.toast(`Pinned ${pin.text}`);
  }

  private showPins(): void {
    this.pinLayer.set(this.pins, settings.value.showPinned);
  }

  /** Bodies and features seen at the last rebuild: anything new while isolating joins the isolated set. */
  private known: Set<string> | null = null;

  isolate(bodies: string[] | null): void {
    this.isolated = bodies?.length ? [...bodies] : null;
    // What exists now; anything made from here on joins the isolated set.
    this.known = new Set([...(this.result?.bodies ?? []).map((b) => b.id), ...this.store.doc.features.map((f) => f.id)]);
    this.applyVisibility();
    // Isolated bodies are all there is: sketches, planes, axes and images step out too.
    this.refreshConstruction();
    this.refreshSketches();
    if (this.tool === this.selectTool) this.selectTool.refresh();
    this.items.render(this.result);
  }

  /**
   * What isolating shows: the isolated bodies (and what was made since), plus
   * the sketches drawn on a face of one of those bodies - they belong to it,
   * so their shapes can be picked (extrude, offset…) like on any face.
   */
  isolatedWithSketches(): string[] | null {
    if (!this.isolated) return null;
    const iso = new Set(this.isolated);
    const onIsolated = this.store.doc.features.filter((f) => f.type === "sketch" && !!f.attachedTo && iso.has(f.attachedTo.body) && !iso.has(f.id)).map((f) => f.id);
    return onIsolated.length ? [...this.isolated, ...onIsolated] : this.isolated;
  }

  /** Hidden (Items) + not isolated → invisible and unpickable. */
  private applyVisibility(): void {
    const hidden = new Set(this.store.doc.hidden);
    if (this.isolated) for (const b of this.result?.bodies ?? []) if (!this.isolated.includes(b.id)) hidden.add(b.id);
    this.view.setHidden(hidden);
  }

  sketchPlane(id: string): PlaneDef | undefined {
    return this.result?.sketchPlanes[id] ?? this.store.find<SketchFeature>(id)?.plane;
  }

  sketchCurves(id: string): SketchEntity[] {
    return [...(this.store.find<SketchFeature>(id)?.entities ?? []), ...(this.result?.sketchBoundaries[id] ?? [])];
  }

  /**
   * The Stop button by the spinner: the engine drops what it's doing and the
   * change that started it is taken back (a live preview is cancelled; a
   * committed change is undone).
   */
  private stopWork(): void {
    const running = this.kernel.running;
    const committed = !running || running === this.store.doc.features;
    this.kernel.stop();
    if (this.tool !== this.selectTool && !(this.tool instanceof SketchTool)) this.setTool(null);
    if (committed && this.store.canUndo) this.store.undo();
    else void this.regenerate();
    this.ui.toast("Stopped - the last change was taken back");
  }

  async preview(features: Feature[]): Promise<RegenResult | null> {
    const r = await this.kernel.regenerate(features);
    if (r) this.apply(r, features);
    return r;
  }

  private docChanged(): void {
    setUnits(this.store.doc.units);
    setVariables(this.store.doc.variables);
    this.ui.refreshRight();
    this.showPins();
    this.view.setBodyColors(this.store.doc.colors ?? {}, this.store.doc.opacity ?? {});
    // New planes, sketches and names show in Items now, not once a long rebuild
    // has finished (a plane just made wasn't there to tap for seconds).
    this.items.render(this.result);
    void this.regenerate();
  }

  private setUnits(u: Units): void {
    this.store.commit((d) => (d.units = u));
  }

  private async regenerate(): Promise<void> {
    const features = this.store.doc.features;
    const r = await this.kernel.regenerate(features);
    if (r) this.apply(r, features);
  }

  private apply(r: RegenResult, features: readonly Feature[]): void {
    this.result = r;
    const now = new Set([...r.bodies.map((b) => b.id), ...features.map((f) => f.id)]);
    if (this.isolated) {
      // Made while isolating (a copy, a new sketch or plane): it belongs with what's shown.
      if (this.known) for (const id of now) if (!this.known.has(id)) this.isolated.push(id);
      this.isolated = this.isolated.filter((id) => now.has(id));
      if (!this.isolated.some((id) => r.bodies.some((b) => b.id === id))) this.isolated = null;
    }
    this.known = now;
    this.view.setBodies(r.bodies);
    this.applyVisibility();
    this.refreshConstruction(features);
    this.refreshSketches(features);
    // Drop selections that point at geometry that no longer exists.
    this.selection = this.selection.filter((s) => {
      if (s.kind === "profile" || s.kind === "curve" || s.kind === "point") return !!this.store.find(s.sketch) || features.some((f) => f.id === s.sketch);
      if (s.kind === "plane" || s.kind === "axis") return !!this.view.planeOf(s.id) || !!this.view.axisOf(s.id);
      if (s.kind === "image") return features.some((f) => f.id === s.id);
      if (s.kind === "origin") return true;
      const b = this.view.body(s.body);
      if (!b) return false;
      if (s.kind === "face") return s.face < b.faces.length;
      if (s.kind === "edge") return s.edge < b.edges.length;
      if (s.kind === "vertex") return !!this.view.vertexOf(s.body, s.vertex);
      return true;
    });
    this.refreshHighlights();
    this.tool.refresh?.();
    if (this.tool === this.selectTool) this.selectTool.refresh();
    this.renderHistory();
    this.items.render(r);
    const open = this.openBodies(r);
    this.ui.setWarning(
      open.length
        ? `⚠ ${open.length === 1 ? (this.store.doc.names?.[open[0].id] ?? open[0].name) : `${open.length} bodies`} not closed - ${open.reduce((s, b) => s + b.openEdges.length, 0)} open edge(s) shown in orange`
        : this.store.problems[0]
          ? `⚠ ${this.store.problems[0]}`
          : null,
    );
    const errs = r.errors.map((e) => e.featureId + e.message).join();
    if (errs && errs !== this.shownErrors && this.tool === this.selectTool) {
      this.ui.toast(`${r.errors.length} step${r.errors.length > 1 ? "s" : ""} failed to rebuild - see History`, "error");
    }
    this.shownErrors = errs;
  }

  private refreshConstruction(features: readonly Feature[] = this.store.doc.features): void {
    const r = this.result;
    if (!r) return;
    const hidden = new Set(this.store.doc.hidden);
    // Isolating: only what's isolated (or was made since) shows.
    const shown = (id: string) => !hidden.has(id) && (!this.isolated || this.isolated.includes(id));
    this.view.setConstruction(r.planes.filter((p) => shown(p.id)), r.axes.filter((a) => shown(a.id)));
    this.view.setImages(features.filter((f): f is ImageFeature => f.type === "image" && !f.suppressed && shown(f.id)));
  }

  private refreshSketches(features: readonly Feature[] = this.store.doc.features): void {
    const hidden = new Set(this.store.doc.hidden);
    const iso = this.isolatedWithSketches();
    const sketches = features
      .filter((f): f is SketchFeature => f.type === "sketch" && !f.suppressed && ((!hidden.has(f.id) && (!iso || iso.includes(f.id))) || f.id === this.tool.activeSketch))
      .map((s) => ({ ...s, plane: this.result?.sketchPlanes[s.id] ?? s.plane, boundary: this.result?.sketchBoundaries[s.id] }));
    this.view.setSketches(sketches, this.tool.activeSketch);
  }

  private refreshHighlights(): void {
    this.view.setHighlights(this.selection, this.hover);
  }

  // ------------------------------------------------------------ history

  /**
   * Bodies with open edges - except freeform surfaces that are meant to be
   * open sheets (not thickened): those aren't a problem.
   */
  private openBodies(r: RegenResult | null) {
    return (r?.bodies ?? []).filter((b) => {
      if (!b.openEdges?.length) return false;
      // A surface on purpose (or a copy of one) isn't meant to be closed.
      const f = this.store.find(b.id);
      const ff = f?.type === "freeform" ? f : freeformBodies(this.store.features).get(b.id)?.feature;
      return !(ff?.surface && !ff.thickness);
    });
  }

  private renderHistory(): void {
    // The rows are rebuilt: a hover on an old row is over.
    this.view.setStepHover(null);
    const warnings = new Map<string, string>();
    for (const b of this.openBodies(this.result)) warnings.set(b.id.split(":")[0], `${b.name}: not closed - ${b.openEdges.length} open edge(s)`);
    for (const n of this.result?.notes ?? []) warnings.set(n.featureId, warnings.has(n.featureId) ? `${warnings.get(n.featureId)} ${n.message}` : n.message);
    this.ui.renderHistory(this.store.doc.features, this.result?.errors ?? [], this.tool.editingId ?? this.tool.activeSketch ?? null, {
      edit: (id) => this.editFeature(id),
      hover: (id) => this.view.setStepHover(id ? this.stepTargets(id) : null),
      toggle: (id) => {
        const f = this.store.find(id);
        if (f) this.store.update(id, { suppressed: !f.suppressed });
      },
      remove: (id) => {
        if (this.tool !== this.selectTool) this.setTool(null);
        this.store.remove(id);
      },
      groups: this.store.doc.historyGroups ?? [],
      setGroups: (next) => this.store.commit((d) => (d.historyGroups = next.length ? next : undefined)),
      suppress: (ids, off) =>
        this.store.commit((d) => {
          for (const f of d.features) if (ids.includes(f.id)) f.suppressed = off || undefined;
        }),
      askName: async (title, current) => (await this.ui.dialog(title, [{ key: "name", label: "Name", value: current }]))?.name.trim() || null,
    }, warnings);
  }

  /** What a History step works on: its bodies (made or changed), sketches, and the edges it names. */
  private stepTargets(id: string): { bodies: string[]; lines: Vec3[][] } {
    const f = this.store.find(id);
    const bodies = new Set<string>();
    const sketches = new Set<string>();
    const edges: [Vec3, Vec3][] = [];
    if (!f) return { bodies: [], lines: [] };
    if (f.type === "sketch") sketches.add(f.id);
    // Bodies this step made (its own id, or copies "id:…").
    for (const b of this.result?.bodies ?? []) if (b.id === f.id || b.id.startsWith(`${f.id}:`)) bodies.add(b.id);
    const walk = (v: unknown, key = ""): void => {
      if (Array.isArray(v)) return v.forEach((x) => walk(x, key));
      if (!v || typeof v !== "object") {
        if (typeof v === "string" && (key === "body" || key === "bodies" || key === "target")) bodies.add(v);
        if (typeof v === "string" && key === "sketch") sketches.add(v);
        return;
      }
      const o = v as Record<string, unknown>;
      // An edge reference: draw the edge itself.
      if (Array.isArray(o.mid) && Array.isArray(o.dir) && typeof o.length === "number") {
        const m = o.mid as Vec3;
        const d = o.dir as Vec3;
        const h = (o.length as number) / 2;
        edges.push([[m[0] - d[0] * h, m[1] - d[1] * h, m[2] - d[2] * h], [m[0] + d[0] * h, m[1] + d[1] * h, m[2] + d[2] * h]]);
      }
      for (const [k, x] of Object.entries(o)) if (k !== "exprs") walk(x, k);
    };
    walk(f);
    // Only what's still there.
    const have = new Set((this.result?.bodies ?? []).map((b) => b.id));
    // Sketch curves in 3D.
    const lines: Vec3[][] = [...edges];
    for (const sid of sketches) {
      const plane = this.sketchPlane(sid);
      const sk = this.store.find<SketchFeature>(sid);
      if (!plane || !sk) continue;
      for (const e of sk.entities) for (const pl of entityPolylines(e)) lines.push(pl.map((uv) => toWorld(plane, uv)));
    }
    return { bodies: [...bodies].filter((b) => have.has(b)), lines };
  }

  private editFeature(id: string): void {
    const f = this.store.find(id);
    if (!f) return;
    this.setSelection([]);
    switch (f.type) {
      case "boolean":
        // Subtract / Intersect open their tool (picks, Keep options); Union has nothing to set.
        if (f.op !== "union") return this.setTool(new BooleanOp(this, f.op, f.target, f.tools, f));
        break;
      case "sketch":
        return this.setTool(new SketchTool(this, { sketchId: f.id }));
      case "extrude":
        return this.setTool(new ExtrudeOp(this, f.source, f as ExtrudeFeature));
      case "fillet":
      case "chamfer":
        return this.setTool(new EdgeOp(this, f.type, f.edges, f as EdgeFeature));
      case "revolve":
        return this.setTool(new RevolveOp(this, f.source, f as RevolveFeature));
      case "sweep":
        return this.setTool(new SweepOp(this, f.source, f as SweepFeature));
      case "loft":
        return this.setTool(new LoftOp(this, f.sections, [], f as LoftFeature));
      case "shell":
        return this.setTool(new ShellOp(this, f.body, f.faces, f as ShellFeature));
      case "split":
        return this.setTool(new SplitOp(this, f.body, f as SplitFeature));
      case "fillToPlane":
        return this.setTool(new FillToPlaneOp(this, f.body, f as FillToPlaneFeature));
      case "thread":
        return this.setTool(new ThreadOp(this, f.face, f.round ?? { r: 5, hole: false }, f));
      case "plane":
        return this.setTool(new PlaneOp(this, f.plane, f.face, f as PlaneFeature));
      case "transform": {
        if (f.op.kind === "scale" || f.op.kind === "scaleXYZ") return this.setTool(new ScaleOp(this, f.op.kind === "scaleXYZ", f.bodies, f as TransformFeature));
        return this.setTool(new TransformOp(this, f.op.kind, f.bodies, f as TransformFeature));
      }
      case "scaleFace":
        return this.setTool(new ScaleFaceOp(this, f.face, { origin: f.face.center, normal: f.face.normal, xDir: f.u }, f));
      case "replaceFace":
        return this.setTool(new ReplaceFaceOp(this, f.face, f));
      case "image":
        return this.setTool(new ImageOp(this, f as ImageFeature));
      case "freeform":
        return this.setTool(new FreeformTool(this, { feature: f }));
      case "moveFace": {
        const target = f.face ? { face: f.face, plane: { origin: f.face.center, normal: f.face.normal, xDir: xDirFor(f.face.normal) } } : f.edge ? { edge: f.edge } : f.vertex ? { vertex: f.vertex } : null;
        if (target) return this.setTool(new MoveFaceOp(this, target, f));
        break;
      }
      default:
        this.ui.toast(`${f.name} has no values to edit. You can suppress or delete it.`);
    }
  }

  // ------------------------------------------------------------ menus

  /** Nothing selected: the top-level menu (the left tool column). */
  mainTools(): ToolItem[] {
    const wait = (label: string, accepts: Sel["kind"][], run: () => void) => () => {
      this.selectTool.waitFor(label, accepts, run);
      this.selectTool.refresh();
    };
    const bodies = () => bodiesOf(this.selection);
    const transform = (kind: ConstructorParameters<typeof TransformOp>[1], label: string) =>
      wait(label, ["body", "face", "edge"], () => this.setTool(new TransformOp(this, kind, bodies())));
    const src = () => sourcesOf(this, this.selection)[0];
    return [
      { id: "sketch", label: "Sketch", icon: "sketch", shortcut: "S", run: () => this.setTool(new SketchTool(this)) },
      {
        // Smooth shapes from a control cage.
        id: "freeform",
        label: "Freeform",
        icon: "freeform",
        children: (["box", "sphere", "cylinder", "plane"] as const).map((k) => ({
          id: `ff-${k}`,
          label: { box: "Box", sphere: "Sphere", cylinder: "Cylinder", plane: "Surface (plane)" }[k],
          icon: "freeform" as const,
          run: () => this.setTool(new FreeformTool(this, { primitive: k })),
        })),
      },
      {
        id: "insert",
        label: "Insert",
        icon: "insert",
        children: [
          {
            // One entry: make a new one, or see and change the ones there are.
            id: "variables",
            label: "Variables",
            icon: "variable",
            sub: `${this.store.doc.variables.length} defined`,
            children: [
              { id: "var", label: "New Variable", icon: "variableNew", run: () => void createVariable(this) },
              { id: "vars", label: "Edit Variables", icon: "variableEdit", sub: `${this.store.doc.variables.length} defined`, run: () => void editVariables(this) },
            ],
          },
          { id: "image", label: "Image", icon: "image", run: () => void insertImage(this).then((f) => f && this.setTool(new ImageOp(this, f))) },
          { id: "file", label: "File", icon: "file", sub: "STEP, STL, OBJ, DXF, SVG", run: () => void insertFile(this) },
          { id: "project", label: "Project", icon: "file", sub: ".super", run: () => void insertFile(this) },
        ],
      },
      {
        id: "construct",
        label: "Construct",
        icon: "construct",
        children: [
          {
            id: "plane",
            label: "Plane",
            icon: "plane",
            children: [
              { id: "offset", label: "Offset Plane", icon: "planeOffset", run: () => this.setTool(new PlaneOp(this, null, undefined)) },
              { id: "mid", label: "Midplane", icon: "planeMid", run: () => this.setTool(new MidplaneOp(this)) },
              { id: "3pt", label: "Through 3 Points", icon: "plane3pt", run: () => this.setTool(new ThreePointPlaneOp(this)) },
              { id: "curve", label: "On Curve at Point", icon: "planeCurve", run: () => this.setTool(new CurvePointPlaneOp(this, false)) },
              { id: "perp", label: "Perpendicular to Edge at Point", icon: "planePerp", run: () => this.setTool(new CurvePointPlaneOp(this, true)) },
              { id: "angle", label: "Through Edge at Angle", icon: "planeAngle", run: () => this.setTool(new EdgeAnglePlaneOp(this)) },
              { id: "parallel", label: "Parallel to Face at Point", icon: "planeParallel", run: () => this.setTool(new FacePointPlaneOp(this)) },
            ],
          },
          {
            id: "axis",
            label: "Axis",
            icon: "axis",
            // An axis along X, Y or Z needs nothing to pick: in an empty
            // project (a jet engine's centre line, first thing) "select face
            // or edge" was a dead end.
            children: [
              ...(["X", "Y", "Z"] as const).map((k, i) => ({
                id: `axis${k}`,
                label: `Along ${k}`,
                icon: "axis" as const,
                sub: "through a point you type",
                run: () => this.setTool(new AxisOp(this, [0, 0, 0], [i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0])),
              })),
              { id: "axisPick", label: "From Face or Edge", icon: "axis" as const, run: wait("Axis", ["face", "edge"], () => {
              const s = this.selection[0];
              if (s.kind === "face") {
                const f = this.view.body(s.body)?.faces[s.face];
                if (f) this.setTool(new AxisOp(this, f.center, f.normal));
              } else if (s.kind === "edge") {
                const e = this.view.body(s.body)?.edges[s.edge];
                // A round edge: through its centre.
                const ax = e && (e.type === "CIRCLE" ? circleAxis(e.start, e.mid, e.end, e.dir) : { origin: e.start, dir: e.dir });
                if (ax) this.setTool(new AxisOp(this, ax.origin, ax.dir));
              }
            }) },
            ],
          },
        ],
      },
      {
        id: "transform",
        label: "Transform",
        icon: "transform",
        children: [
          { id: "move", label: "Move/Rotate", icon: "move", shortcut: "M", run: transform("move", "Move/Rotate") },
          { id: "scale", label: "Scale", icon: "scale", run: wait("Scale", ["body", "face", "edge"], () => this.setTool(new ScaleOp(this, false, bodies()))) },
          { id: "translate", label: "Translate", icon: "translate", run: transform("translate", "Translate") },
          {
            id: "pattern",
            label: "Pattern",
            icon: "patternLinear",
            children: [
              { id: "linear", label: "Linear", icon: "patternLinear", run: transform("linear", "Pattern – Linear") },
              { id: "circular", label: "Circular", icon: "patternCircular", run: transform("circular", "Pattern – Circular") },
            ],
          },
          { id: "rotate", label: "Rotate Around Axis", icon: "rotateAxis", run: transform("rotate", "Rotate Around Axis") },
          { id: "align", label: "Align", icon: "align", disabled: true, why: SOON },
          { id: "mirror", label: "Mirror", icon: "mirror", run: transform("mirror", "Mirror") },
        ],
      },
      {
        id: "tools",
        label: "Tools",
        icon: "tools",
        children: [
          { id: "offsetFace", label: "Offset Face", icon: "offsetFace", run: wait("Offset Face", ["face"], () => src() && this.setTool(new ExtrudeOp(this, src()!))) },
          { id: "fillet", label: "Fillet", icon: "fillet", run: wait("Fillet", ["edge"], () => this.setTool(new EdgeOp(this, "fillet", this.selection.flatMap((s) => (s.kind === "edge" ? [edgeRefOf(this, s)!] : []))))) },
          { id: "chamfer", label: "Chamfer", icon: "chamfer", run: wait("Chamfer", ["edge"], () => this.setTool(new EdgeOp(this, "chamfer", this.selection.flatMap((s) => (s.kind === "edge" ? [edgeRefOf(this, s)!] : []))))) },
          { id: "offsetEdge", label: "Offset Edge", icon: "offsetEdge", run: () => {
            const s = this.selection.find((x) => x.kind === "edge");
            this.setTool(new OffsetEdgeOp(this, s?.kind === "edge" ? s : undefined));
          } },
          { id: "extrude", label: "Extrude", icon: "extrude", run: wait("Extrude", ["profile", "face"], () => src() && this.setTool(new ExtrudeOp(this, src()!))) },
          { id: "shell", label: "Shell", icon: "shell", run: wait("Shell", ["face", "body"], () => {
            const s = this.selection[0];
            const faces = this.selection.flatMap((x) => (x.kind === "face" ? [faceRefOf(this, x)!] : []));
            this.setTool(new ShellOp(this, bodiesOf([s])[0], faces));
          }) },
          { id: "loft", label: "Loft", icon: "loft", run: wait("Loft", ["profile", "face"], () => this.setTool(new LoftOp(this, sourcesOf(this, this.selection).flatMap((s): ExtrudeSource[] => (s.kind === "profile" ? s.regions.map((r) => ({ ...s, regions: [r] })) : [s])), this.selection))) },
          { id: "union", label: "Union", icon: "union", run: wait("Union (double-tap bodies)", ["body"], () => this.selectTool.refresh()) },
          { id: "subtract", label: "Subtract", icon: "subtract", run: () => this.setTool(new BooleanOp(this, "subtract")) },
          { id: "intersect", label: "Intersect", icon: "intersect", run: () => this.setTool(new BooleanOp(this, "intersect")) },
          { id: "split", label: "Split Body", icon: "split", run: wait("Split Body", ["body", "face"], () => this.setTool(new SplitOp(this, bodiesOf(this.selection)[0]))) },
          { id: "fillToPlane", label: "Fill to Plane", icon: "fill", run: wait("Fill to Plane (tap the surface)", ["body", "face", "edge"], () => this.setTool(new FillToPlaneOp(this, bodiesOf(this.selection)[0]))) },
          { id: "revolve", label: "Revolve", icon: "revolve", run: wait("Revolve", ["profile", "face"], () => src() && this.setTool(new RevolveOp(this, src()!))) },
          { id: "thread", label: "Thread", icon: "thread", run: wait("Thread (tap a round face or its rim)", ["face", "edge"], () => this.startThread()) },
          { id: "sweep", label: "Sweep", icon: "sweep", run: wait("Sweep", ["profile", "face"], () => src() && this.setTool(new SweepOp(this, src()!))) },
          {
            id: "repair",
            label: "Repair Body",
            icon: "check",
            run: wait("Repair Body", ["body", "face", "edge"], () => {
              const ids = bodiesOf(this.selection);
              if (!ids.length) return;
              this.store.add({ ...this.store.newIdentity("repair"), type: "repair", bodies: ids });
              this.ui.toast("Repair added to History - it notes what it fixed");
            }),
          },
          { id: "replace", label: "Replace Face", icon: "replaceFace", disabled: true, why: SOON },
          { id: "proje", label: "Project as Edge", icon: "projectEdge", disabled: true, why: SOON },
          { id: "wrap", label: "Wrap & Emboss", icon: "wrap", disabled: true, why: SOON },
        ],
      },
      // With variables set up: Edit Variables in a box of its own under the tools.
      ...(this.store.doc.variables.length
        ? [
            { id: "===vars", label: "", icon: "variableEdit" as const },
            { id: "editVars", label: "Edit Variables", icon: "variableEdit" as const, sub: `${this.store.doc.variables.length} defined`, run: () => void editVariables(this) },
          ]
        : []),
    ];
  }

  bottomTools(): ToolItem[] {
    return [
      { id: "section", label: "Section View", icon: "section", sub: this.section ? "On" : this.lastSection ? "Off · tap to show" : "Off", active: !!this.section, run: () => this.toggleSection() },
      { id: "measure", label: "Measure", icon: "measure", run: () => this.setTool(new MeasureTool(this)) },
      this.isolated
        ? { id: "isolate", label: "Isolate", icon: "isolate", sub: "On - tap to show all", active: true, run: () => this.isolate(null) }
        : {
            id: "isolate",
            label: "Isolate",
            icon: "isolate",
            sub: "Off",
            disabled: !bodiesOf(this.selection).length,
            why: "Select a body, face or edge to isolate",
            run: () => this.isolate(bodiesOf(this.selection)),
          },
    ];
  }

  private onKey(e: KeyboardEvent): void {
    // Typing while holding a drag sets an exact value; Enter applies it and finishes.
    // (Checked first: a panel field may still have focus from before the drag.)
    if (this.input.dragging && this.tool.dragKey?.(e)) {
      e.preventDefault();
      (document.activeElement as HTMLElement | null)?.blur?.();
      if (e.key === "Enter") this.input.endDrag();
      return;
    }
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === "z") {
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if (mod && k === "y") {
      e.preventDefault();
      this.redo();
      return;
    }
    if (mod && k === "s") {
      e.preventDefault();
      this.save();
      return;
    }
    if (this.tool.key?.(e)) {
      e.preventDefault();
      return;
    }
    if (mod) return;
    if (this.tool !== this.selectTool) return;
    if (k === "s" && !this.selection.length) this.setTool(new SketchTool(this));
    else if (k === "f" && !this.selection.length) this.fit();
  }

  private fit(): void {
    this.view.fitAll();
  }

  // ------------------------------------------------------------ files

  private wireTopbar(): void {
    const on = (id: string, fn: () => void) => document.getElementById(id)!.addEventListener("click", fn);
    const menu = document.getElementById("file-menu")!;
    const more = document.getElementById("more-menu")!;
    // Phones: one thing open at a time at the left - a menu closes Items.
    // Phones: one thing open at a time - a menu takes the place of Items and of History.
    const phoneItemsAway = () => {
      if (window.innerWidth > 720) return;
      if (document.getElementById("items")!.classList.contains("open")) this.items.toggle(false);
      if (document.body.classList.contains("history-open")) this.ui.toggleHistory(false);
    };
    on("file-btn", () => ((more.hidden = true), menu.toggleAttribute("hidden"), !menu.hidden && phoneItemsAway()));
    on("more-btn", () => ((menu.hidden = true), more.toggleAttribute("hidden"), !more.hidden && phoneItemsAway()));
    document.getElementById("m-version")!.textContent = `Version ${__APP_VERSION__}`;
    const moreItem = (id: string, fn: () => void) => on(id, () => ((more.hidden = true), fn()));
    // Fullscreen (the label follows the state; Esc also leaves it).
    const fs = document.getElementById("m-fullscreen")!;
    const doc = document as Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => void };
    const root = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
    const isFull = () => !!(document.fullscreenElement ?? doc.webkitFullscreenElement);
    const paint = () => {
      fs.firstChild!.textContent = isFull() ? "Exit fullscreen" : "Fullscreen";
      // Tablets draw their own close button at the top left in fullscreen: the top bar makes room.
      document.body.classList.toggle("is-fullscreen", isFull());
    };
    document.addEventListener("fullscreenchange", paint);
    document.addEventListener("webkitfullscreenchange", paint);
    const goFull = () => {
      if (root.requestFullscreen) void root.requestFullscreen().catch(() => this.ui.toast("This browser won't go fullscreen here"));
      else if (root.webkitRequestFullscreen) root.webkitRequestFullscreen();
      // iPhone Safari has no fullscreen for pages: the Home Screen app is.
      else this.ui.toast("Tip: Share → Add to Home Screen opens supergeometry.app full screen");
    };
    moreItem("m-fullscreen", () => {
      if (isFull()) return void (document.exitFullscreen?.() ?? doc.webkitExitFullscreen?.());
      goFull();
    });
    // The welcome window (and File → Open) has a Full screen button too (a
    // browser only allows it from a tap). Everywhere but an app that already
    // has the whole screen; where a browser has none (iPhone), it says how.
    this.fullscreen = !matchMedia("(display-mode: fullscreen)").matches ? { isFull, toggle: () => (isFull() ? void (document.exitFullscreen?.() ?? doc.webkitExitFullscreen?.()) : goFull()) } : null;
    // Help and Tutorial: placeholders for now.
    // A newer build out? More pulses and its Update item says NEW.
    this.updates = new Updates(() => this.store.flush());
    moreItem("m-update", () => void this.confirmReset());
    // Phones and tablets: an offer to add the app to the home screen (More → Install app too).
    const install = new Install((t) => this.ui.toast(t));
    const inst = document.getElementById("m-install")!;
    document.getElementById("more-btn")!.addEventListener("click", () => (inst.hidden = !install.available));
    moreItem("m-install", () => install.offer(true));
    // Help: a panel explaining every button (toggle it from More → Help).
    const help = new HelpPanel();
    moreItem("m-help", () => help.toggle());
    // The guide text (what to tap next): on or off.
    const hintsState = document.getElementById("m-hints-state")!;
    const paintHints = () => (hintsState.textContent = settings.value.showHints ? "On" : "Off");
    paintHints();
    moreItem("m-hints", () => {
      settings.set("showHints", !settings.value.showHints);
      paintHints();
      this.ui.refreshHint();
    });
    moreItem("m-tutorial", () => {});
    // About: the README, in the app. Support links open in a new tab (no access back to this page).
    moreItem("m-about", () => showAbout());
    // Support: a short list of ways (each opens in a new tab). One without a link yet says so.
    const donateList = document.getElementById("m-donate-list")!;
    on("m-donate", () => {
      donateList.hidden = !donateList.hidden;
      document.getElementById("m-donate-arrow")!.textContent = donateList.hidden ? "▸" : "▾";
    });
    for (const { id, url } of SUPPORT) {
      const b = document.getElementById(`m-support-${id}`);
      if (!b) continue;
      if (!url) {
        b.querySelector(".menu-soon")!.textContent = "soon";
        b.classList.add("disabled");
      }
      moreItem(`m-support-${id}`, () => (url ? openSupport(url) : this.ui.toast("Coming soon")));
    }
    document.addEventListener("pointerdown", (e) => {
      if (!(e.target as HTMLElement).closest("#file-menu, #file-btn")) menu.hidden = true;
      if (!(e.target as HTMLElement).closest("#more-menu, #more-btn")) more.hidden = true;
    });
    const item = (id: string, fn: () => void) =>
      on(id, () => {
        menu.hidden = true;
        fn();
      });
    item("m-new", () => void this.newProject());
    item("m-open", () => void this.showProjects());
    item("m-save", () => this.save());
    item("m-stl", () => void this.export("stl"));
    item("m-step", () => void this.export("step"));
    item("m-3mf", () => void this.export3mf());
    item("m-dxf", () => this.exportDXF());
    // A share button at the right of each export (and Save): straight to the share sheet.
    // Only for the file types this browser will really share (Chrome on Android,
    // for one, refuses 3D and CAD files: a button there would only download).
    {
      const shares: [string, string, () => void][] = [
        ["m-save", "super", () => this.save("share")],
        ["m-stl", "stl", () => void this.export("stl", "share")],
        ["m-step", "step", () => void this.export("step", "share")],
        ["m-3mf", "3mf", () => void this.export3mf("share")],
        ["m-dxf", "dxf", () => this.exportDXF("share")],
      ];
      // Android's share sheet turns these files away or mangles them: downloads only there.
      const android = /Android/i.test(navigator.userAgent);
      for (const [id, ext, run] of shares) {
        if (android || !canShareType(ext)) continue;
        const btn = document.getElementById(id)!;
        const sh = document.createElement("span");
        sh.className = "menu-share";
        sh.setAttribute("role", "button");
        sh.title = "Share";
        sh.innerHTML = icons.share;
        sh.addEventListener("click", (e) => {
          e.stopPropagation();
          menu.hidden = true;
          run();
        });
        btn.append(sh);
      }
    }
    on("undo-btn", () => this.undo());
    on("redo-btn", () => this.redo());
    this.store.onChange(() => this.updateUndo());
    this.updateUndo();

    // Project name: click and type; Enter or leaving the field renames.
    const name = document.getElementById("project-name") as HTMLInputElement;
    const show = () => {
      if (document.activeElement !== name) name.value = this.store.doc.name;
      // A new, unnamed project keeps the page's own title (what search results show).
      document.title = this.store.doc.name === "Untitled" ? PAGE_TITLE : `${this.store.doc.name} – supergeometry.app`;
    };
    const rename = () => {
      const v = name.value.trim();
      if (v && v !== this.store.doc.name) this.store.commit((d) => (d.name = v));
      else name.value = this.store.doc.name;
    };
    name.addEventListener("change", rename);
    name.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") name.blur();
      if (e.key === "Escape") (name.value = this.store.doc.name), name.blur();
    });
    name.addEventListener("focus", () => name.select());
    this.store.onChange(show);
    show();
    // The saved mark at the end of the name: a tick once every change is on this device.
    const mark = () => {
      const saved = this.store.saved;
      name.classList.toggle("saving", !saved);
      name.title = `Project name - click to rename\n${saved ? "Saved on this device" : "Saving…"}`;
    };
    this.store.onSavedState(mark);
    mark();
  }

  /**
   * Undo: a tool with steps of its own (a freeform cage being shaped) takes
   * those back, and leaves the project alone while it's open - Ctrl+Z used to
   * throw the whole cage edit away and undo the step before it too.
   */
  private undo(): void {
    if (this.tool.undo) {
      if (!this.tool.undo()) this.ui.toast("Nothing to undo in this edit yet (Cancel leaves it unchanged)");
      return this.updateUndo();
    }
    if (this.tool instanceof SketchTool) {
      if (this.tool.undoPoint()) return;
      this.tool.stopDrawing();
    } else if (this.tool !== this.selectTool) this.setTool(null);
    this.store.undo();
  }
  private redo(): void {
    if (this.tool.redo) {
      this.tool.redo();
      return this.updateUndo();
    }
    if (this.tool instanceof SketchTool) this.tool.stopDrawing();
    else if (this.tool !== this.selectTool) this.setTool(null);
    this.store.redo();
  }
  refreshUndo(): void {
    this.updateUndo();
  }

  private updateUndo(): void {
    const t = this.tool?.undo ? this.tool : null;
    (document.getElementById("undo-btn") as HTMLButtonElement).disabled = t ? !t.canUndo : !this.store.canUndo;
    (document.getElementById("redo-btn") as HTMLButtonElement).disabled = t ? !t.canRedo : !this.store.canRedo;
  }

  private updates!: Updates;

  /** More → Update: asked first (it reloads the app), with the option to save a copy. */
  private async confirmReset(): Promise<void> {
    const choice = await this.ui.ask(
      "Update?",
      "The app reloads with its newest version. Your project stays on this device - you can also save a copy to a file first.",
      [
        { id: "reset", label: "Yes, update" },
        { id: "save", label: "Save a copy & update", primary: true },
      ],
    );
    if (!choice) return;
    if (choice === "save") {
      this.save();
      // Give the download a moment to start before the page reloads.
      await new Promise((r) => setTimeout(r, 800));
    }
    await this.updates.reset();
  }

  /**
   * New project: the current one can be saved (downloaded) or discarded
   * first. Then the app checks for a newer version and, if there is one,
   * clears its cached files and reloads - a new project starts on the latest.
   */
  private async newProject(): Promise<void> {
    const was = this.store.features.length ? this.store.doc.name : null;
    await this.switchProject(emptyDoc(), newProjectId());
    if (was) this.ui.toast(`“${was}” is kept in File → Open`);
    if (await this.updates.check()) await this.updates.reset();
  }

  // ------------------------------------------------------------ library

  /** Which library project is open; null until the saved project is read. */
  private projectId: string | null = null;
  /** The open project has an entry in the library (an empty new one doesn't, yet). */
  private projectKept = false;

  /** Startup: the open project is the library's current one (work from before the library is kept now). */
  private async attachLibrary(): Promise<void> {
    let id = await currentProjectId();
    if (!id) {
      id = newProjectId();
      await setCurrentProject(id);
    }
    this.projectId = id;
    this.projectKept = (await libraryEntries()).some((e) => e.id === id);
    // The library's copy follows when the app goes to the background (the
    // autosave holds the newest state meanwhile, and is copied in at the next
    // start if need be) - no extra saving or drawing while modelling.
    this.store.onSaved = (text) => document.visibilityState === "hidden" && void this.keepInLibrary(text);
    // Its newest state is the autosave (a page closed mid-save left the library a step behind).
    const text = JSON.stringify(this.store.doc);
    // (No picture: nothing is drawn yet.)
    if ((this.projectKept || this.store.features.length) && (await projectText(id)) !== text) {
      this.projectKept = true;
      await keepProject(id, this.store.doc.name, text);
    }
  }

  /** The open project into the library: with a new picture of the view now and then (it costs a moment). */
  private async keepInLibrary(text: string, picture = false): Promise<void> {
    const id = this.projectId;
    if (!id || (!this.projectKept && !this.store.features.length)) return;
    // A new picture: opening the gallery, leaving the project, or the app going to the background.
    const snap = picture || document.visibilityState === "hidden";
    this.projectKept = true;
    await keepProject(id, this.store.doc.name, text, snap ? this.viewPicture() : undefined);
  }

  /** A small picture of the model (as the view looks at it, framed to fit), for the library. */
  private viewPicture(): string | undefined {
    try {
      return this.view.snapshot(320, 240, getComputedStyle(document.body).backgroundColor || "#2b2d31");
    } catch {
      return undefined;
    }
  }

  /** Close the open project (it's kept, with a fresh picture) and open another. */
  private async switchProject(doc: ProjectDoc, id: string): Promise<void> {
    this.setTool(null);
    this.setSection(null);
    this.isolate(null);
    if (this.projectId) await this.keepInLibrary(JSON.stringify(this.store.doc), true);
    const kept = (await libraryEntries()).some((e) => e.id === id);
    await setCurrentProject(id);
    // The id and the document change together: an autosave due meanwhile went to the old project.
    this.projectId = id;
    this.projectKept = kept;
    this.store.openDoc(doc);
    setTimeout(() => this.fit(), 400);
  }

  /** File → Open: the projects kept on this device, and Open file… for any other. */
  /** Full screen from the projects window (null: not offered here). */
  private fullscreen: { isFull(): boolean; toggle(): void } | null = null;

  private async showProjects(welcome = false, starting = false): Promise<void> {
    // The open one with its picture as it looks now (starting: nothing has changed, nor is it drawn yet).
    if (this.projectId && !starting) await this.keepInLibrary(JSON.stringify(this.store.doc), true);
    const entries = await libraryEntries();
    showLibrary(entries, this.projectId, {
      open: (id) => void this.openKept(id),
      newProject: () => void this.newProject(),
      openFile: () => this.open(),
      download: (id) => void this.downloadKept(id),
      remove: (id) => forgetProject(id),
      rename: async (id, current) => {
        const name = (await this.ui.dialog("Rename project", [{ key: "name", label: "Name", value: current }]))?.name.trim();
        if (!name || name === current) return null;
        // The open one through its document (the top bar and its autosave follow).
        if (id === this.projectId) this.store.commit((d) => (d.name = name));
        else await renameProject(id, name);
        return name;
      },
    }, { welcome, fullscreen: this.fullscreen });
  }

  private async openKept(id: string): Promise<void> {
    const text = await projectText(id);
    if (!text) return this.ui.toast("That project couldn't be read", "error");
    try {
      await this.switchProject(parseProject(text), id);
    } catch (err) {
      this.ui.toast(`Could not open: ${(err as Error).message}`, "error");
    }
  }

  private async downloadKept(id: string): Promise<void> {
    const text = await projectText(id);
    const e = (await libraryEntries()).find((x) => x.id === id);
    if (text && e) download(new Blob([text], { type: "application/json" }), `${e.name}.super`);
  }

  private save(how: Delivery = "download"): void {
    void this.deliver(new Blob([JSON.stringify(this.store.doc)], { type: "application/json" }), `${this.store.doc.name}.super`, how);
  }

  /**
   * Hand a made file over: download it, or share it (phones and tablets:
   * the system share sheet - mail, messages, a slicer app…).
   */
  private async deliver(blob: Blob, name: string, how: Delivery): Promise<void> {
    if (how === "download") return download(blob, name);
    const ext = name.split(".").pop()!.toLowerCase();
    const file = new File([blob], name, { type: MIME[ext] ?? (blob.type || "application/octet-stream") });
    if (!canShare(file)) {
      this.ui.toast(`This browser can't share .${ext} files - downloaded instead`, "error");
      return download(blob, name);
    }
    const share = () => navigator.share({ files: [file], title: name });
    try {
      await share();
    } catch (err) {
      const why = (err as Error).name;
      if (why === "AbortError") return; // closed the share sheet
      if (why !== "NotAllowedError") {
        this.ui.toast("Sharing didn't work here - downloaded instead", "error");
        return download(blob, name);
      }
      // Making the file took a moment and the browser no longer counts this as a
      // tap: one more tap shares it.
      // The share sheet is opened right in that tap (not after it), as iOS requires.
      let again: Promise<void> | null = null;
      const go = await this.ui.ask("Ready to share", name, [
        { id: "share", label: "Share", primary: true, run: () => (again = share()) },
        { id: "dl", label: "Download instead" },
      ]);
      if (go === "share" && again) {
        try {
          await again;
        } catch (e) {
          if ((e as Error).name === "AbortError") return;
          this.ui.toast("Sharing isn't available here - downloaded instead", "error");
          download(blob, name);
        }
      } else if (go === "dl") download(blob, name);
    }
  }

  private open(): void {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".super,.tessel,application/json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const doc = parseProject(await file.text());
        doc.name = file.name.replace(/\.(super|tessel)$/i, "");
        // A project of its own in the library (the open one is kept as it was).
        await this.switchProject(doc, newProjectId());
      } catch (err) {
        this.ui.toast(`Could not open: ${(err as Error).message}`, "error");
      }
    };
    input.click();
  }

  /**
   * DXF of a sketch: the one open (e.g. picked in Items), or the one whose
   * curves or regions are selected. Without one, say how to pick it.
   */
  private exportDXF(how: Delivery = "download"): void {
    const fromSel = this.selection.flatMap((s) => (s.kind === "curve" || s.kind === "point" || s.kind === "profile" ? [s.sketch] : []))[0];
    const id = this.tool.activeSketch ?? fromSel;
    const sk = id ? this.store.find<SketchFeature>(id) : undefined;
    if (!sk || sk.type !== "sketch") {
      this.ui.toast("Select a sketch first: open Items, tap the sketch, then File → Export DXF.");
      if (!document.getElementById("items")?.classList.contains("open")) this.items.toggle(true);
      return;
    }
    if (!sk.entities.length) return this.ui.toast("That sketch is empty");
    void this.deliver(new Blob([sketchToDXF(sk.entities)], { type: "application/dxf" }), `${this.store.doc.name} - ${sk.name}.dxf`, how);
    this.ui.toast(`Exported “${sk.name}” as DXF`);
  }

  /** 3MF for slicers: the meshes, with the exact STEP model packed inside. */
  private async export3mf(how: Delivery = "download"): Promise<void> {
    const ids = chosenBodies(this);
    const bodies = (this.result?.bodies ?? []).filter((b) => (ids.length ? ids.includes(b.id) : !this.view.isHidden(b.id)));
    if (!bodies.length) return this.ui.toast("Nothing to export");
    try {
      this.ui.setStatus("Exporting 3MF…");
      const step = await this.kernel.export(this.store.doc.features, "step", bodies.map((b) => b.id));
      // A fine mesh, as for STL (the view's is coarse: round faces came out faceted in the slicer).
      const fine = JSON.parse(await (await this.kernel.export(this.store.doc.features, "mesh", bodies.map((b) => b.id))).text()) as { id: string; positions: number[]; indices: number[] }[];
      const names = this.store.doc.names ?? {};
      const blob = await exportThreeMF(
        bodies.map((b) => {
          const m = fine.find((x) => x.id === b.id);
          return { name: names[b.id] ?? b.name, positions: m ? new Float32Array(m.positions) : b.positions, indices: m ? new Uint32Array(m.indices) : b.indices, color: this.store.doc.colors?.[b.id] };
        }),
        this.store.doc.name,
        step,
      );
      await this.deliver(blob, `${this.store.doc.name}.3mf`, how);
    } catch (err) {
      this.ui.toast(`Export failed: ${(err as Error).message}`, "error");
    } finally {
      this.ui.setStatus(null);
    }
  }

  private async export(format: ExportFormat, how: Delivery = "download"): Promise<void> {
    // Selected bodies win; otherwise what's isolated; otherwise everything.
    const picked = bodiesOf(this.selection);
    const bodies = picked.length ? picked : (this.isolated ?? []).filter((id) => this.result?.bodies.some((b) => b.id === id));
    try {
      this.ui.setStatus(`Exporting ${bodies.length ? `${bodies.length} bod${bodies.length > 1 ? "ies" : "y"} as ` : ""}${format.toUpperCase()}…`);
      const blob = await this.kernel.export(this.store.doc.features, format, bodies.length ? bodies : undefined);
      await this.deliver(blob, `${this.store.doc.name}.${format === "step" ? "step" : "stl"}`, how);
    } catch (err) {
      this.ui.toast(`Export failed: ${(err as Error).message}`, "error");
    } finally {
      this.ui.setStatus(null);
    }
  }
}

/** Same choice of bodies as the other exports: selected, else isolated, else all. */
function chosenBodies(app: App): string[] {
  const picked = bodiesOf(app.selection);
  return picked.length ? picked : (app.isolated ?? []).filter((id) => app.result?.bodies.some((b) => b.id === id));
}

type Delivery = "download" | "share";

/** The file types the exports are shared as (the share sheet picks apps by them). */
const MIME: Record<string, string> = {
  stl: "model/stl",
  step: "model/step",
  "3mf": "model/3mf",
  dxf: "image/vnd.dxf",
  super: "application/json",
};

function canShare(file: File): boolean {
  try {
    return typeof navigator.share === "function" && !!navigator.canShare?.({ files: [file] });
  } catch {
    return false;
  }
}

/** Will this browser share a file of this kind (the system share sheet)? */
function canShareType(ext: string): boolean {
  return canShare(new File(["x"], `x.${ext}`, { type: MIME[ext] ?? "application/octet-stream" }));
}

function download(blob: Blob, name: string): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
