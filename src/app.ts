import { isTouchDevice } from "./device";
import { circleAxis } from "./tools/slots";
import { CurvePointPlaneOp, EdgeAnglePlaneOp, FacePointPlaneOp, ThreePointPlaneOp } from "./tools/planeOps";
import { ImprintOp, WrapOp } from "./tools/wrapOps";
import { DocStore, parseProject } from "./doc/store";
import { SUPPORT, openSupport } from "./ui/support";
import { currentProjectId, forgetProject, keepProject, libraryEntries, newProjectId, projectText, renameProject, setCurrentProject } from "./doc/library";
import { showLibrary } from "./ui/library";
import { showAbout } from "./ui/about";
import { findAction, openCommandSearch, showShortcuts } from "./ui/commands";
import type { EdgeFeature, ExtrudeFeature, ExtrudeSource, Feature, FillToPlaneFeature, ImageFeature, LoftFeature, PathRef, PinDef, PlaneDef, PlaneFeature, ProjectDoc, RevolveFeature, ShellFeature, SketchEntity, SketchFeature, SplitFeature, SweepFeature, TransformFeature, Units, Vec3 } from "./doc/types";
import { emptyDoc } from "./doc/types";
import { createVariable, insertFile, insertImage } from "./io/insert";
import { numpadVariables } from "./ui/numpad";
import { variableTags } from "./doc/varAnchors";
import { VariableTags } from "./tools/variableTags";
import { VariablesTool } from "./tools/variablesTool";
import { freeformBodies } from "./doc/freeformCopies";
import { KernelClient } from "./kernel/client";
import type { ExportFormat, RegenResult } from "./kernel/protocol";
import { settings } from "./settings";
import { PinLayer } from "./tools/annotate";
import { MeasureTool } from "./tools/measure";
import { BimTool } from "./bim/bimTool";
import { openSheet } from "./bim/sheet";
import { openDrawing } from "./bim/drawing";
import { ItemsPanel } from "./ui/items";
import { OffsetEdgeOp } from "./tools/offsetEdge";
import { faceFreeformTool } from "./tools/faceFreeform";
import { AxisOp, ConnectOp, EdgeOp, ExtrudeOp, FillOp, FillToPlaneOp, ThreadOp, ImageOp, LoftOp, MidplaneOp, MoveFaceOp, PlaneOp, ReplaceFaceOp, ScaleFaceOp, ScaleOp, ScaleRefOp, RevolveOp, ShellOp, SplitOp, SweepOp, TransformOp } from "./tools/ops";
import { add, dist, scale, toWorld, xDirFor } from "./geom";
import { entityPolylines } from "./sketch/curves";
import { FreeformTool } from "./tools/freeform";
import { sectionPlane, SectionTool, type SectionState } from "./tools/section";
import { SelectTool } from "./tools/select";
import { BooleanOp } from "./tools/booleanOp";
import { sketchesUsed } from "./tools/featureOp";
import { SketchTool } from "./tools/sketch";
import { definedCurves } from "./sketch/constraints";
import { bodiesOf, edgeRefOf, faceRefOf, sameSel, sourcesOf, type AppContext, type Sel, type Tool } from "./tools/tool";
import { setupRightColumn } from "./ui/panels";
import type { ToolItem } from "./ui/ui";
import { UI } from "./ui/ui";
import { Wheel } from "./ui/wheel";
import { evaluate, setUnits, setVariables } from "./units";
import { InputRouter } from "./view/input";
import { ViewCube } from "./view/viewcube";
import { PivotButton } from "./ui/pivot";
import { HelpPanel } from "./ui/help";
import { icons } from "./ui/icons";
import { Updates } from "./ui/update";
import { Offline } from "./ui/offline";
import { Install } from "./ui/install";
import { exportThreeMF, zip } from "./io/threemf";
import { glb } from "./io/formats";
import { sketchToDXF } from "./io/dxf";
import { isHeadset, screenClass } from "./device";
import { Viewport } from "./view/viewport";
import { VRMode, vrSupported } from "./view/xr";

/** The page's own title, from index.html (it names the app for search results). */
const PAGE_TITLE = document.title;

const SOON = "Coming soon";

export class App implements AppContext {
  readonly store = new DocStore();
  readonly kernel = new KernelClient();
  readonly view: Viewport;
  readonly ui = new UI();
  /** The tool wheel (More → Tool wheel): the tools in a ring round the pointer, beside the column. */
  readonly wheel = new Wheel({ ui: this.ui, mainTools: () => this.mainTools() });
  private input: InputRouter;
  result: RegenResult | null = null;
  selection: Sel[] = [];
  section: SectionState | null = null;
  isolated: string[] | null = null;
  /** Variables switched on: their tags in the view. */
  varsOn = false;
  private varTags!: VariableTags;
  private hover: Sel | null = null;
  private selectTool: SelectTool;
  /** The headset mode (its pictures can be checked on the page: vr.snapshot). */
  vr: VRMode | null = null;
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
    // VR: only where a headset can open it (its own browser, or a PC with one connected). A viewer: the model as a real thing in your room.
    // On a phone or tablet it's AR: the model in the room through the camera.
    const handheld = isTouchDevice && !isHeadset;
    const vr: VRMode = (this.vr = new VRMode({
      renderer: this.view.renderer,
      handheld,
      scene: this.view.scene,
      bounds: () => this.view.modelBounds(),
      xray: () => {
        const on = settings.value.shader !== "xray";
        settings.set("shader", on ? "xray" : "shaded");
        return on ? "X-Ray" : "Shaded";
      },
      edges: () => {
        const on = !settings.value.showEdges;
        settings.set("showEdges", on);
        return on ? "Edges shown" : "Edges hidden";
      },
      looks: () => ({ xray: settings.value.shader === "xray" ? "Shaded" : "X-Ray", edges: settings.value.showEdges ? "Hide Edges" : "Show Edges" }),
      beforeFrame: () => this.view.xrFrame(),
      onEnter: () => {
        this.setTool(null);
        this.setSelection([]);
        this.view.xrMode(true);
      },
      onExit: () => this.view.xrMode(false),
    }));
    // In the top bar, where it's seen: on a headset always, elsewhere when a headset can be used.
    const vrBtn = document.getElementById("vr-btn")!;
    if (handheld) {
      vrBtn.textContent = "Enter AR";
      vrBtn.title = "See the model in your room through the camera";
    }
    const checkVR = () => void vrSupported(handheld).then((ok) => (vrBtn.hidden = !ok && !isHeadset));
    checkVR();
    (navigator as Navigator & { xr?: EventTarget }).xr?.addEventListener("devicechange", checkVR);
    vrBtn.addEventListener("click", async () => {
      if (!(await vrSupported(handheld))) return this.ui.toast(handheld ? "This browser can't show AR - try Chrome" : "This browser can't open VR here - open supergeometry.app in the headset's own browser (not an installed app window)");
      vr.enter().catch((e: unknown) => this.ui.toast(`${handheld ? "AR" : "VR"} didn't start: ${e instanceof Error ? e.message : e}`));
    });
    this.pinLayer = new PinLayer(this.view);
    this.varTags = new VariableTags(this.view, {
      variables: () => this.store.doc.variables,
      check: (name, expr, kind) => {
        const list = this.store.doc.variables;
        setVariables(list.map((v) => (v.name === name ? { name, expr } : v)));
        try {
          return evaluate(expr, "number") === null ? null : evaluate(name, kind);
        } finally {
          setVariables(list);
        }
      },
      setVariable: (name, expr) => {
        const list = this.store.doc.variables;
        const next = list.map((v) => (v.name === name ? { name, expr } : v));
        setVariables(next);
        const bad = next.some((v) => evaluate(v.expr) === null);
        setVariables(list);
        if (bad) return false;
        if (list.find((v) => v.name === name)?.expr !== expr) this.store.commit((d) => (d.variables = next));
        return true;
      },
    });
    // ƒx buttons on number fields create named variables.
    this.ui.variableFactory = (current) => createVariable(this, current);
    this.ui.variableNames = () => this.store.doc.variables.map((v) => v.name);
    numpadVariables({ names: () => this.store.doc.variables.map((v) => v.name), create: (value) => createVariable(this, value) });
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
    this.view.canvas.addEventListener("pointermove", (e) => {
      const r = this.view.canvas.getBoundingClientRect();
      this.pointerAt = [e.clientX - r.left, e.clientY - r.top];
    });
    this.view.canvas.addEventListener("pointerleave", () => (this.pointerAt = null));
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
        // A project never pictured (kept before it was ever drawn) showed a
        // blank shape on its card: now that it's drawn, it gets its picture -
        // in the welcome window too, if that's still open.
        const entry = (await libraryEntries()).find((e) => e.id === this.projectId);
        if (entry && !entry.thumb && this.store.features.length) {
          await this.keepInLibrary(JSON.stringify(this.store.doc), true);
          const thumb = (await libraryEntries()).find((e) => e.id === this.projectId)?.thumb;
          const pic = document.querySelector<HTMLElement>(".library-card.current .library-pic");
          if (thumb && pic && !pic.querySelector("img")) {
            const img = document.createElement("img");
            img.src = thumb;
            img.alt = "";
            img.draggable = false;
            pic.querySelector("svg")?.replaceWith(img);
          }
        }
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
    // A phone: History and Items go, so the tool, its arrows and its value
    // boxes aren't drawn under them (they can be opened again while it runs).
    if (next !== this.selectTool && window.innerWidth <= 720) {
      if (document.body.classList.contains("history-open")) this.ui.toggleHistory(false);
      if (document.getElementById("items")?.classList.contains("open")) this.items.toggle(false);
    }
    next.enter?.();
    // With the tool wheel on, a tool with a window of its own (the selection tool and a sketch
    // say for themselves what the wheel shows) keeps the wheel's handle: Settings stay in reach.
    // (Unless it gave way to another tool as it started: the wheel is that one's to set.)
    if (this.tool === next && next !== this.selectTool && !(next instanceof SketchTool)) this.wheel.cover("tool");
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
    // Any other edge (a revolved shank's seam runs right along its top): the
    // round face under the finger.
    const at = this.selectTool.tapPoint;
    if (s?.kind === "edge" && at) {
      const body = s.body;
      const under = this.view.facesAt(at.x, at.y).find((f) => f.kind === "face" && f.body === body && this.view.body(body)?.faces[f.face]?.round);
      if (under?.kind === "face") s = { kind: "face", body, face: under.face };
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
    this.view.setSectionStyle(s?.flat ? "flat" : s?.only ? "only" : "normal");
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

  revealInItems(ids: string[]): void {
    this.items.reveal(ids);
  }

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

  /** The tags where the variables act on the model as it is now (Variables on). */
  private showVariableTags(): void {
    if (this.varsOn && this.result) this.varTags.set(variableTags(this.store.doc.variables, this.store.doc.features, this.result));
  }

  /** The Variables button: on (tags and their card), or off. */
  private toggleVariables(): void {
    if (this.varsOn) return this.variablesOff();
    this.varsOn = true;
    this.showVariableTags();
    this.varTags.setVisible(true);
    this.setTool(new VariablesTool(this));
  }

  variablesOff(): void {
    this.varsOn = false;
    this.varTags.setVisible(false);
    if (this.tool instanceof VariablesTool) this.setTool(null);
    this.refreshTools();
  }

  private setUnits(u: Units): void {
    this.store.commit((d) => (d.units = u));
  }

  private async regenerate(): Promise<void> {
    const features = this.store.doc.features;
    const r = await this.kernel.regenerate(features, true);
    if (r) this.apply(r, features);
  }

  /** Sketches the engine moved the curves of (they follow a body): those curves, by the sketch as it was sent. */
  private solved = new WeakMap<Feature, SketchEntity[]>();

  private apply(r: RegenResult, features: readonly Feature[]): void {
    this.result = r;
    this.solved = new WeakMap();
    if (r.sketchEntities) {
      const moved = r.sketchEntities;
      for (const f of features) if (moved[f.id]) this.solved.set(f, moved[f.id]);
      // The project as it is (not a preview of a change): they are the sketch's curves from now on.
      if (features === this.store.doc.features) {
        this.store.adopt((d) => {
          for (const f of d.features) if (f.type === "sketch" && moved[f.id]) f.entities = moved[f.id];
        });
        features = this.store.doc.features;
      }
    }
    // Which patterns a step used whole, as it was made: kept with it (they stay whole when a count changes).
    if (r.whole && features === this.store.doc.features) {
      const whole = r.whole;
      this.store.adopt((d) => {
        for (const f of d.features) if ((f.type === "boolean" || f.type === "delete") && whole[f.id] && !f.whole) f.whole = whole[f.id];
      });
      features = this.store.doc.features;
    }
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
    // (Once: the selection tool's own refresh was run a second time after this.)
    this.tool.refresh?.();
    this.renderHistory();
    this.items.render(r);
    this.showVariableTags();
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
    this.view.setImages(features.filter((f): f is ImageFeature => f.type === "image" && !f.suppressed && !f.rolledBack && shown(f.id)));
  }

  /** The sketch being edited: which curves its constraints hold completely (worked out once per change). */
  private definedCache: { entities: unknown; constraints: unknown; defined: Set<string> | undefined; all: boolean } | null = null;

  private definedOf(s: SketchFeature): Set<string> | undefined {
    const c = this.definedCache;
    if (c && c.entities === s.entities && c.constraints === s.constraints) return c.defined;
    const r = definedCurves(s.entities, s.constraints ?? []);
    const all = !!r?.all && s.entities.some((e) => !e.construction);
    // Just became fully defined: say so (the curves have turned green).
    if (all && c && !c.all) this.ui.toast("Sketch fully defined");
    this.definedCache = { entities: s.entities, constraints: s.constraints, defined: r?.defined, all };
    return r?.defined;
  }

  /** Sketches hidden (after use) that were shown again: meant to be used again, so tappable through bodies. */
  private revealed = new Set<string>();
  private wasHidden = new Set<string>();

  private refreshSketches(features: readonly Feature[] = this.store.doc.features): void {
    const hidden = new Set(this.store.doc.hidden);
    for (const id of this.wasHidden) if (!hidden.has(id)) this.revealed.add(id);
    for (const id of hidden) this.revealed.delete(id);
    this.wasHidden = hidden;
    const iso = this.isolatedWithSketches();
    const sketches = features
      .filter((f): f is SketchFeature => f.type === "sketch" && !f.suppressed && !f.rolledBack && ((!hidden.has(f.id) && (!iso || iso.includes(f.id))) || f.id === this.tool.activeSketch))
      .map((s) => ({ ...s, entities: this.solved.get(s) ?? s.entities, plane: this.result?.sketchPlanes[s.id] ?? s.plane, boundary: this.result?.sketchBoundaries[s.id] }))
      .map((s) => (s.id === this.tool.activeSketch ? { ...s, defined: this.definedOf(s) } : s));
    // Drawn but not made into anything yet: shown through bodies, and a tap on it finds it there
    // (a pocket sketched on a plane through the middle of a body is inside it). The same
    // for one used, hidden, and shown again in Items: the pocket's sketch shown to fill
    // the pocket with a core couldn't be tapped through the frame round it.
    const used = new Set(features.filter((f) => !f.suppressed && !f.rolledBack).flatMap(sketchesUsed));
    this.view.setSketches(sketches, this.tool.activeSketch, new Set(sketches.filter((s) => !used.has(s.id) || this.revealed.has(s.id)).map((s) => s.id)));
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

  /** What the History rows were last made from (everything a row shows). */
  private historyShown = "";

  private renderHistory(): void {
    const warnings = new Map<string, string>();
    for (const b of this.openBodies(this.result)) warnings.set(b.id.split(":")[0], `${b.name}: not closed - ${b.openEdges.length} open edge(s)`);
    for (const n of this.result?.notes ?? []) warnings.set(n.featureId, warnings.has(n.featureId) ? `${warnings.get(n.featureId)} ${n.message}` : n.message);
    // The same rows as are there: left as they are (every step of a drag's
    // preview rebuilt the whole list - 5 ms for 200 steps, far more on a phone).
    const doc = this.store.doc;
    const shown = JSON.stringify([
      doc.features.map((f) => [f.id, f.name, f.type, f.suppressed ? 1 : 0, f.rolledBack ? 1 : 0, f.type === "sketch" ? (f.log ?? 0) : 0]),
      this.result?.errors ?? [],
      this.tool.editingId ?? this.tool.activeSketch ?? null,
      [...warnings],
      doc.hidden,
      doc.historyGroups ?? [],
    ]);
    if (shown === this.historyShown) return;
    this.historyShown = shown;
    // The rows are rebuilt: a hover on an old row is over.
    this.view.setStepHover(null);
    this.ui.renderHistory(this.store.doc.features, this.result?.errors ?? [], this.tool.editingId ?? this.tool.activeSketch ?? null, {
      edit: (id) => this.editFeature(id),
      hover: (id) => this.view.setStepHover(id ? this.stepTargets(id) : null),
      toggle: (id) => {
        const f = this.store.find(id);
        if (f) this.store.update(id, { suppressed: !f.suppressed });
      },
      isHidden: (id) => this.store.doc.hidden.includes(id),
      toggleHidden: (id) => this.store.commit((d) => (d.hidden = d.hidden.includes(id) ? d.hidden.filter((x) => x !== id) : [...d.hidden, id])),
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
      breakAfter: (id) => this.breakAfter(id),
      merge: () => void this.mergeHistory(),
    }, warnings);
  }

  /**
   * The History's breakpoint: the steps after `id` off (the model as it was
   * there) until it's removed (null). New steps go in at the breakpoint.
   */
  private breakAfter(id: string | null): void {
    if (this.tool !== this.selectTool) this.setTool(null);
    const at = id ? this.store.features.findIndex((f) => f.id === id) : Infinity;
    const later = id ? this.store.features.length - 1 - at : 0;
    if (id && !later) return void this.ui.toast("It's the last step - there's nothing after it to roll back");
    this.store.commit((d) => {
      d.features.forEach((f, i) => {
        if (i > at) f.rolledBack = true;
        else delete f.rolledBack;
      });
    });
    this.ui.toast(id ? `Rolled back to here: ${later} later step${later === 1 ? "" : "s"} off until you remove the breakpoint` : "Breakpoint removed: every step is on again");
  }

  /**
   * Merge: the history flattened into the bodies as they are now (each kept
   * as its exact shape, its name, colour and material kept). Sketches and
   * variables can stay; every other step goes. Undo takes it back.
   */
  private async mergeHistory(): Promise<void> {
    const bodies = this.view.bodyList;
    if (!bodies.length) return void this.ui.toast("There are no bodies yet - nothing to merge into");
    const off = this.store.features.filter((f) => f.rolledBack || f.suppressed).length;
    const v = await this.ui.dialog(
      "Merge history",
      [
        { key: "sketches", label: "Keep the sketches", value: "1", check: true },
        { key: "variables", label: "Keep the variables", value: "1", check: true },
      ],
      `Every step becomes the bodies as they are now: they can't be edited by their steps any more.${off ? ` The ${off} step${off === 1 ? "" : "s"} switched off or after the breakpoint go too.` : ""} Undo takes it back.`,
    );
    if (!v) return;
    if (this.tool !== this.selectTool) this.setTool(null);
    const features = this.store.doc.features.filter((f) => !f.rolledBack);
    const made: Feature[] = [];
    const renamed = new Map<string, string>();
    for (const b of bodies) {
      const blob = await this.kernel.export(features, "step", [b.id]);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      // The body keeps its id where it can be a step's (names, colours, folders stay with it).
      const id = /^[\w-]+$/.test(b.id) && !made.some((m) => m.id === b.id) ? b.id : this.store.newIdentity("import").id;
      if (id !== b.id) renamed.set(b.id, id);
      const name = this.store.doc.names[b.id] ?? b.name;
      made.push({ id, name, type: "import", format: "step", fileName: `${name}.step`, data: btoa(bin) });
    }
    const keepSketches = !!v.sketches;
    const keepVars = !!v.variables;
    this.store.commit((d) => {
      const sketches = keepSketches
        ? d.features.flatMap((f): Feature[] => {
            if (f.type !== "sketch" || f.rolledBack) return [];
            // Nothing left to follow: a merged body has no steps to point at.
            const s: SketchFeature = { ...f, attachedTo: undefined, outlineOffsets: undefined, links: undefined };
            s.constraints = s.constraints?.filter((c) => !/"(ref|lnk)-/.test(JSON.stringify(c)));
            if (!keepVars) delete s.exprs;
            return [s];
          })
        : [];
      d.features = [...made, ...sketches];
      if (!keepVars) d.variables = [];
      d.historyGroups = undefined;
      const re = (id: string) => renamed.get(id) ?? id;
      const reKeys = <T,>(r: Record<string, T> | undefined) => (r ? Object.fromEntries(Object.entries(r).map(([k, x]) => [re(k), x])) : r);
      d.names = reKeys(d.names)!;
      d.colors = reKeys(d.colors);
      d.opacity = reKeys(d.opacity);
      d.materials = reKeys(d.materials);
      d.hidden = d.hidden.map(re);
      d.folders = d.folders?.map((f) => ({ ...f, items: f.items.map(re) }));
    });
    this.ui.toast(`History merged: ${made.length} bod${made.length === 1 ? "y" : "ies"}${keepSketches ? ", the sketches kept" : ""}`);
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

  editStep(id: string): void {
    this.editFeature(id);
  }

  private editFeature(id: string): void {
    const f = this.store.find(id);
    if (!f) return;
    this.setSelection([]);
    // What the step works on can be off screen (or under History): once its
    // tool shows its picks, bring them into view. A sketch frames itself.
    if (f.type !== "sketch") {
      const before = this.tool;
      setTimeout(() => this.tool !== before && this.view.keepInView(), 400);
    }
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
      case "fill":
        return this.setTool(new FillOp(this, f.boundary, f));
      case "imprint":
        return this.setTool(new ImprintOp(this, f.source ? { source: f.source } : { edges: f.edges ?? [] }, f));
      case "wrap":
        return this.setTool(new WrapOp(this, f.source, f));
      case "thread":
        return this.setTool(new ThreadOp(this, f.face, f.round ?? { r: 5, hole: false }, f));
      case "plane":
        return this.setTool(new PlaneOp(this, f.plane, f.face, f as PlaneFeature));
      case "transform": {
        if (f.op.kind === "scale" && f.op.ref) return this.setTool(new ScaleRefOp(this, f.bodies, f as TransformFeature));
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
      case "connect":
        return this.setTool(new ConnectOp(this, [], f));
      case "faceFreeform":
        return this.setTool(faceFreeformTool(this, null, f));
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
      // An empty project: Sketch pulses - that's where to start.
      { id: "sketch", label: "Sketch", icon: "sketch", shortcut: "S", pulse: this.store.features.length === 0, run: () => this.setTool(new SketchTool(this)) },
      {
        // Smooth shapes from a control cage.
        id: "freeform",
        label: "Freeform",
        icon: "freeform",
        children: [
          ...(["box", "sphere", "cylinder", "plane"] as const).map((k) => ({
            id: `ff-${k}`,
            label: { box: "Box", sphere: "Sphere", cylinder: "Cylinder", plane: "Surface (plane)" }[k],
            icon: "freeform" as const,
            run: () => this.setTool(new FreeformTool(this, { primitive: k })),
          })),
          // A flat face of a body made smooth (its edges stay put).
          {
            id: "faceFreeform",
            beta: true,
            label: "Freeform Face",
            icon: "freeform" as const,
            sub: "a face of a body",
            run: wait("Freeform Face (tap a flat face)", ["face"], () => {
              const s = this.selection[0];
              if (s?.kind !== "face" || !this.view.body(s.body)?.faces[s.face]?.plane) return void this.ui.toast("Freeform Face works on flat faces for now");
              const t = faceFreeformTool(this, s);
              if (t) this.setTool(t);
            }),
          },
          // A smooth bridge between two faces.
          { id: "connect", label: "Connect", icon: "freeform" as const, sub: "two faces", beta: true, run: () => this.setTool(new ConnectOp(this, this.selection.filter((s) => s.kind === "face").slice(0, 2))) },
        ],
      },
      {
        id: "insert",
        label: "Insert",
        icon: "insert",
        children: [
          { id: "image", label: "Image", icon: "image", run: () => void insertImage(this).then((f) => f && this.setTool(new ImageOp(this, f))) },
          { id: "file", label: "File", icon: "file", sub: "STEP, STL, OBJ, 3MF, DXF, SVG", run: () => void insertFile(this) },
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
          { id: "fillNetwork", label: "Fill", icon: "fill", sub: "a surface over curves", run: () => this.setTool(new FillOp(this, this.pickedCurves())) },
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
          { id: "proje", label: "Project as Edge", icon: "projectEdge", beta: true, run: wait("Project as Edge (tap a sketch's shape)", ["profile"], () => src() && this.setTool(new ImprintOp(this, { source: src()! }))) },
          { id: "wrap", label: "Wrap & Emboss", icon: "wrap", beta: true, run: wait("Wrap & Emboss (tap a sketch's shape)", ["profile"], () => src() && this.setTool(new WrapOp(this, src()!))) },
        ],
      },
      {
        // The project as a building information model: real materials, and
        // from them the technical sheet and the drawings.
        id: "bim",
        label: "BIM",
        icon: "bim",
        children: [
          { id: "bimMaterials", label: "Materials", icon: "bim", sub: "a real material for each body", run: () => this.setTool(new BimTool(this)) },
          { id: "bimSheet", label: "Technical Sheet", icon: "sheet", sub: "parts list, masses, data", run: () => void openSheet(this) },
          { id: "bimDrawings", label: "Drawings", icon: "drawing", sub: "views with dimensions", run: () => void openDrawing(this) },
          { id: "bimAssemblies", label: "Assemblies", icon: "assembly", sub: "parts placed and joined", run: () => this.ui.toast("Assemblies are being built - after Drawings") },
        ],
      },
    ];
  }

  bottomTools(): ToolItem[] {
    return [
      // The one whose card is open pulses (as a tool does while its window is open).
      { id: "section", label: "Section View", icon: "section", sub: this.section ? "On" : this.lastSection ? "Off · tap to show" : "Off", active: !!this.section, pulse: this.tool instanceof SectionTool, run: () => this.toggleSection() },
      { id: "measure", label: "Measure", icon: "measure", active: this.tool instanceof MeasureTool, pulse: this.tool instanceof MeasureTool, run: () => this.setTool(this.tool instanceof MeasureTool ? null : new MeasureTool(this)) },
      // On: a tag per variable in the view (tap one to change it), and their card. Off again.
      { id: "variables", label: "Variables", icon: "variable", sub: this.varsOn ? "On" : this.store.doc.variables.length ? `Off · ${this.store.doc.variables.length}` : "Off", active: this.varsOn, pulse: this.tool instanceof VariablesTool, run: () => this.toggleVariables() },
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
    // Select Through: pick what's behind the faces in front.
    if (mod && e.shiftKey && k === "s") {
      e.preventDefault();
      this.view.setSelectThrough(!this.view.selectThrough);
      this.ui.toast(this.view.selectThrough ? "Select Through on: edges and sketches behind the faces can be picked" : "Select Through off");
      return;
    }
    if (mod && k === "s") {
      e.preventDefault();
      this.save();
      return;
    }
    // Search commands: Ctrl+F anywhere (X too, outside a sketch - see below).
    if (mod && k === "f") {
      e.preventDefault();
      this.searchCommands();
      return;
    }
    // The standard views: Ctrl (or Alt, where the browser keeps Ctrl+1… for its tabs) + 1 to 7.
    if ((mod || e.altKey) && /^[1-7]$/.test(e.key)) {
      e.preventDefault();
      this.viewByNumber(Number(e.key));
      return;
    }
    if (this.tool.key?.(e)) {
      e.preventDefault();
      return;
    }
    // Space over a face: zoom to it.
    if (k === " " && !mod && this.pointerAt) {
      const hit = this.view.pick(this.pointerAt[0], this.pointerAt[1], { edges: false, planes: false, profiles: false });
      if (hit?.kind === "face" && this.view.zoomToFace(hit.body, hit.face)) e.preventDefault();
      return;
    }
    if (this.tool !== this.selectTool) return;
    // The booleans: Ctrl+U / B / I.
    if (mod && !e.shiftKey && (k === "u" || k === "b" || k === "i")) {
      if (this.runCommand([{ u: "Union", b: "Subtract", i: "Intersect" }[k]])) e.preventDefault();
      return;
    }
    if (mod || e.altKey) return;
    if (k === "x") return void (e.preventDefault(), this.searchCommands());
    if (e.key === "?") return void showShortcuts();
    const none = !this.selection.length;
    if (k === "s" && none) return void this.setTool(new SketchTool(this));
    if (k === "f" && none) return void this.fit();
    // A drawing tool's letter with nothing picked: a sketch, with that tool (once its plane is picked).
    const draw: Record<string, "line" | "arc" | "circle" | "rect" | "polygon" | "spline" | "offset" | "trim"> = { l: "line", a: "arc", c: "circle", r: "rect", g: "polygon", i: "spline", o: "offset", t: "trim" };
    if (draw[k] && none && !e.shiftKey) return void this.setTool(new SketchTool(this, { kind: draw[k] }));
    // A modeling tool's letter: that tool, for what's picked (or waiting for it).
    const tools: Record<string, string[]> = {
      e: ["Extrude", "Offset Face"],
      f: ["Fillet"],
      h: ["Shell"],
      m: ["Move/Rotate"],
      n: ["Translate"],
      p: ["Project as Sketch"],
      s: ["Scale", "Scale Sketch"],
      v: ["Revolve"],
      w: ["Sweep"],
      o: ["Offset Edge"],
    };
    if (tools[k] && !e.shiftKey && this.runCommand(tools[k])) e.preventDefault();
  }

  /** Where the pointer was last over the view (Space zooms to the face there). */
  private pointerAt: [number, number] | null = null;

  /** The picked sketch curves and edges, as paths (one per sketch, one per body): what Fill starts with. */
  private pickedCurves(): PathRef[] {
    const out: PathRef[] = [];
    for (const s of this.selection) {
      if (s.kind === "curve") {
        const p = out.find((x): x is Extract<PathRef, { kind: "sketch" }> => x.kind === "sketch" && x.sketch === s.sketch);
        if (p) p.entities.push(s.entity);
        else out.push({ kind: "sketch", sketch: s.sketch, entities: [s.entity] });
      } else if (s.kind === "edge") {
        const ref = edgeRefOf(this, s);
        if (!ref) continue;
        const p = out.find((x): x is Extract<PathRef, { kind: "edges" }> => x.kind === "edges" && x.edges[0]?.body === ref.body);
        if (p) p.edges.push(ref);
        else out.push({ kind: "edges", edges: [ref] });
      }
    }
    return out;
  }

  /** Run the first of these commands that's offered now (the picked thing's tools first). */
  private runCommand(labels: string[]): boolean {
    const hit = findAction(this.ui.offered(), this.mainTools(), labels);
    if (!hit) return false;
    hit.item.run!();
    return true;
  }

  private searchCommands(): void {
    openCommandSearch(
      () => this.ui.offered(),
      () => [...this.mainTools(), { id: "shortcuts", label: "Keyboard shortcuts", icon: "menu", shortcut: "?", run: () => showShortcuts() }],
    );
  }

  /** 1 the default view; 2-7 front, back, top, bottom, right, left. */
  private viewByNumber(n: number): void {
    const cam = this.view.cam;
    if (n === 1) {
      cam.iso();
      this.view.fitAll();
      return;
    }
    const views: [Vec3, Vec3?][] = [
      [[0, -1, 0]],
      [[0, 1, 0], [-1, 0, 0]],
      [[0, 0, 1]],
      [[0, 0, -1]],
      [[1, 0, 0], [0, 1, 0]],
      [[-1, 0, 0], [0, -1, 0]],
    ];
    const [normal, xDir] = views[n - 2];
    cam.lookAlong(normal, xDir);
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
    // The tool wheel (an experiment): the tools round the pointer where the model is tapped; off, the column is back.
    const wheelState = document.getElementById("m-wheel-state")!;
    const paintWheel = () => (wheelState.textContent = settings.value.wheel ? "On" : "Off");
    paintWheel();
    moreItem("m-wheel", () => {
      settings.set("wheel", !settings.value.wheel);
      paintWheel();
      // (The selection tool's guide text says how the tools are reached. Another tool's column and bar stay its own.)
      if (this.tool === this.selectTool) this.selectTool.refresh();
      this.ui.toast(settings.value.wheel ? "Tool wheel on: tap the model, or an empty spot, and the tools come up round the pointer" : "Tool wheel off: the tools are in the column on the left again");
    });
    // Offline mode: the app kept on this device, so it works with no connection.
    const offlineState = document.getElementById("m-offline-state")!;
    const offline = new Offline((t, k) => this.ui.toast(t, k), (state) => (offlineState.textContent = state));
    this.updates.offline = { get on() { return settings.value.offline; }, download: (fresh) => offline.download(fresh) };
    moreItem("m-offline", () => void offline.toggle());
    moreItem("m-tutorial", () => {});
    // About: the README, in the app. Support links open in a new tab (no access back to this page).
    moreItem("m-about", () => showAbout());
    // Feedback: a bug report, suggestion or discussion, posted on r/supergeometry (Reddit's page, in a new tab).
    // (Loaded on the first tap: most visits never open it.)
    moreItem("m-feedback", () => void import("./ui/feedback").then(({ showFeedback }) => showFeedback()));
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
    item("m-glb", () => void this.exportGLB());
    item("m-each", () => {
      // Which format each body is saved in: a menu where the File menu was.
      const r = document.getElementById("file-btn")!.getBoundingClientRect();
      const row = (f: "stl" | "step" | "3mf" | "glb", label: string) => ({ label, run: () => void this.exportEach(f) });
      this.ui.menu(r.left, r.bottom + 4, [row("stl", "Each body as STL"), row("step", "Each body as STEP"), row("3mf", "Each body as 3MF"), row("glb", "Each body as GLB")]);
    });
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
        ["m-glb", "glb", () => void this.exportGLB("share")],
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

  /** The bodies to export (chosen, else shown) with their fine meshes - for GLB. */
  private async fineMeshes(ids: string[]): Promise<{ name: string; positions: Float32Array; indices: Uint32Array; color?: string; opacity?: number }[]> {
    const fine = JSON.parse(await (await this.kernel.export(this.store.doc.features, "mesh", ids)).text()) as { id: string; positions: number[]; indices: number[] }[];
    const names = this.store.doc.names ?? {};
    return ids.flatMap((id) => {
      const b = this.result?.bodies.find((x) => x.id === id);
      const m = fine.find((x) => x.id === id);
      if (!b) return [];
      return [{ name: names[id] ?? b.name, positions: m ? new Float32Array(m.positions) : b.positions, indices: m ? new Uint32Array(m.indices) : b.indices, color: this.store.doc.colors?.[id], opacity: this.store.doc.opacity?.[id] }];
    });
  }

  /** GLB (one-file glTF): for the web, AR and renderers - the bodies' meshes and colours. */
  private async exportGLB(how: Delivery = "download"): Promise<void> {
    const ids = chosenBodies(this);
    const bodies = (this.result?.bodies ?? []).filter((b) => (ids.length ? ids.includes(b.id) : !this.view.isHidden(b.id)));
    if (!bodies.length) return this.ui.toast("Nothing to export");
    try {
      this.ui.setStatus("Exporting GLB…");
      const out = glb(await this.fineMeshes(bodies.map((b) => b.id)), this.store.doc.name);
      await this.deliver(new Blob([out as BlobPart], { type: "model/gltf-binary" }), `${this.store.doc.name}.glb`, how);
    } catch (err) {
      this.ui.toast(`Export failed: ${(err as Error).message}`, "error");
    } finally {
      this.ui.setStatus(null);
    }
  }

  /** Each body in a file of its own (named after it), together in a ZIP. */
  private async exportEach(format: "stl" | "step" | "3mf" | "glb"): Promise<void> {
    const ids = chosenBodies(this);
    const bodies = (this.result?.bodies ?? []).filter((b) => (ids.length ? ids.includes(b.id) : !this.view.isHidden(b.id)));
    if (!bodies.length) return this.ui.toast("Nothing to export");
    const names = this.store.doc.names ?? {};
    const used = new Set<string>();
    const fileName = (id: string, fallback: string) => {
      const base = (names[id] ?? fallback).replace(/[\\/:*?"<>|]+/g, "-").trim() || "Body";
      let n = base;
      for (let k = 2; used.has(n.toLowerCase()); k++) n = `${base} ${k}`;
      used.add(n.toLowerCase());
      return `${n}.${format}`;
    };
    try {
      const files: { name: string; data: Uint8Array }[] = [];
      for (const [i, b] of bodies.entries()) {
        this.ui.setStatus(`Exporting body ${i + 1} of ${bodies.length}…`);
        let blob: Blob;
        if (format === "glb") blob = new Blob([glb(await this.fineMeshes([b.id]), names[b.id] ?? b.name) as BlobPart]);
        else if (format === "3mf") {
          const [m] = await this.fineMeshes([b.id]);
          blob = await exportThreeMF([m], m.name, await this.kernel.export(this.store.doc.features, "step", [b.id]));
        } else blob = await this.kernel.export(this.store.doc.features, format, [b.id]);
        files.push({ name: fileName(b.id, b.name), data: new Uint8Array(await blob.arrayBuffer()) });
      }
      const out = await zip(files);
      await this.deliver(new Blob([out], { type: "application/zip" }), `${this.store.doc.name} - ${bodies.length} ${bodies.length === 1 ? "body" : "bodies"}.zip`, "download");
      this.ui.toast(`${bodies.length} ${bodies.length === 1 ? "body" : "bodies"}, each its own ${format.toUpperCase()} file, in a ZIP`);
    } catch (err) {
      this.ui.toast(`Export failed: ${(err as Error).message}`, "error");
    } finally {
      this.ui.setStatus(null);
    }
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
  glb: "model/gltf-binary",
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
