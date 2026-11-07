// Freeform: shape a smooth body by pulling its control cage. Tap cage points,
// edges or faces (Shift adds; on a touch screen every tap adds), then drag the
// gimbal - or type a value while dragging, or exact Move / Turn / Scale values
// in the card. The smooth surface updates live; Done turns it into a body.
// Undo/Redo step through the cage changes made here.

import { Box3, BufferAttribute, BufferGeometry, DoubleSide, Sprite, LineBasicMaterial, LineSegments, Mesh, MeshBasicMaterial, MeshStandardMaterial, Points, Raycaster, Vector2, Vector3 } from "three";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import type { Feature, FreeformFeature, PlaneDef, TransformFeature, Vec3 } from "../doc/types";
import { applyPlan, archBridge, planeCage, borderChains, cachedPlan, planIndices, smoothNormals, type SubdivPlan, bridgeChains, bridgeFaces, moveTurnScale, shapeCage, sweepFace, type Chain, boundaryEdges, bridgeLoops, cageEdgeKey, extendBorder, cageEdges, deleteFaces, extrudeFaces, fillHole, holeLoops, insertEdgeLoop, insetFaces, isClosed, primitiveCage, refineCage, selfCrossings, subdivide, type Cage, type CagePrimitive } from "../freeform/cage";
import { add, cross, dot, len, niceStep, norm, scale, sub, xDirFor } from "../geom";
import type { PanelItem } from "../ui/ui";
import { fmtLen } from "../units";
import type { ToolPointer } from "../view/input";
import { dotMaterial, planeMarkMaterial, PLANE_MARK_SIZE } from "../view/viewport";
import { isCoarse, screenClass } from "../device";
import { DragTyping, type DragTypingTarget } from "./dragTyping";
import { Gimbal, GIMBAL_AXES, type GimbalPart } from "./gimbal";
import { axisDrag } from "./handles";
import { FillToPlaneOp } from "./ops";
import type { AppContext, Sel, Tool } from "./tool";

type Pick = { kind: "vert"; i: number } | { kind: "edge"; e: [number, number] } | { kind: "face"; f: number };

/**
 * The step just taken, still being adjusted with sliders in the card (no
 * values to work out): the new shape's size, a face pulled out in steps
 * (Length, Bend, Taper), an inset (how far in), a bridge (how far it arches).
 * Re-made from `base` on every slider move; the next tap or step keeps it.
 */
type Live =
  | { kind: "shape"; prim: "box" | "cylinder" | "sphere"; size: Vec3; rows: number }
  /** A new flat surface on the plane picked: its width, depth and faces in the card. */
  | { kind: "sheet"; size: [number, number]; rows: number; at: Vec3; x: Vec3; y: Vec3; n: Vec3 }
  | { kind: "sweep"; base: Cage; face: number; steps: number; length: number; bend: number; taper: number; size: number }
  | { kind: "inset"; base: Cage; faces: number[]; amount: number }
  | { kind: "bridge"; base: Cage; fa: number; fb: number; arch: number; segments: number; span: number };

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
  /** The card's exact values: what they act on (Move, Turn, Scale), and the points as they were before typing. */
  private xform: "move" | "turn" | "scale" = "move";
  private fieldBase: Map<number, Vec3> | null = null;
  private fieldVals = [0, 0, 0, 1];
  private live: Live | null = null;
  private primKind: CagePrimitive | null = null;
  /** The last tap that picked a face (tap there again: the face behind it). */
  private lastFaceTap: { x: number; y: number; t: number; f: number } | null = null;
  /** Cage changes made in this edit, for Undo/Redo. */
  private past: { cage: Cage; picks: Pick[] }[] = [];
  private future: { cage: Cage; picks: Pick[] }[] = [];
  /** Moves applied to the body later in History: the cage is shown (and edited) where the body is. */
  private place: Placement = { fwd: (v) => v, inv: (v) => v };
  private surfaceSheet = false;
  private thickness = 0;
  private thickSide: "up" | "down" | "both" = "up";
  /** A new shape that spawned inside another body: first moved into place as a whole. */
  private placing = false;
  /** A new surface waiting for the plane it goes on. */
  private choosingPlane = false;

  // Scene objects.
  private surface = new Mesh(new BufferGeometry(), new MeshStandardMaterial({ color: 0xb9c6dc, roughness: 0.5, metalness: 0.05, side: DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
  /**
   * Where one face meets the next, drawn on the smooth surface itself:
   * without them the faces of a smooth shape all ran together, hard to tell
   * apart while picking. Hidden behind the surface where it turns away.
   */
  private faceEdges: LineSegments2;
  /** Which surface points the face outlines join (pairs), for the layout shown. */
  private faceEdgeIdx: Uint32Array = new Uint32Array(0);
  private lines = new LineSegments(new BufferGeometry(), new LineBasicMaterial({ color: 0x5f8fe8, transparent: true, opacity: 0.85, depthTest: false }));
  private dots = new Points(new BufferGeometry(), dotMaterial({ color: 0xffffff, size: isCoarse ? 13 : 9 }));
  // Picked points / edges / faces stand out: thick lines (a plain line is
  // always 1 px), bigger dots, and picked faces filled.
  private marks: LineSegments2;
  private markDots = new Points(new BufferGeometry(), dotMaterial({ color: SEL, size: isCoarse ? 20 : 15 }));
  private hoverMarks: LineSegments2;
  private hoverDots = new Points(new BufferGeometry(), dotMaterial({ color: HOVER, size: isCoarse ? 18 : 14 }));
  /**
   * Symmetry: every point moved moves its mirror image too (across this plane);
   * points on the plane stay on it. `symPicking`: waiting for X / Y / Z or a
   * tapped cage edge (the plane across its middle).
   */
  private sym: { origin: Vec3; normal: Vec3 } | null = null;
  private symPicking = false;
  private symPairs: Map<number, number> | null = null;
  private symMark = new Sprite(planeMarkMaterial("symmetry"));
  private symPlane = new Mesh(new BufferGeometry(), new MeshBasicMaterial({ color: 0xb36bff, transparent: true, opacity: 0.1, depthTest: false, side: DoubleSide, depthWrite: false }));
  private markFill = new Mesh(new BufferGeometry(), new MeshBasicMaterial({ color: SEL, transparent: true, opacity: 0.35, depthTest: false, side: DoubleSide }));

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
      // The symmetry plane set last time: still there (and shown).
      const sy = from.feature.symmetry;
      if (sy) {
        const o = this.place.fwd(sy.origin);
        this.sym = { origin: o, normal: norm(sub(this.place.fwd(add(sy.origin, sy.normal)), o)) };
      }
    } else {
      this.cage = primitiveCage(from.primitive);
      this.surfaceSheet = from.primitive === "plane";
      this.primKind = from.primitive;
      // A new surface: first pick the plane (or flat face) it lies on, like a new sketch.
      this.choosingPlane = from.primitive === "plane";
    }
    this.typing = new DragTyping(app);
    this.marks = new LineSegments2(new LineSegmentsGeometry(), app.view.lineMaterial(SEL, 4, false));
    this.hoverMarks = new LineSegments2(new LineSegmentsGeometry(), app.view.lineMaterial(HOVER, 2.5, false));
    this.faceEdges = new LineSegments2(new LineSegmentsGeometry(), app.view.lineMaterial(0x2f3b52, 1.6, true));
    this.markFill.renderOrder = 67;
    // Zoom to fit frames the cage being shaped (its points: the smooth shape lies inside them).
    this.dots.userData.fit = true;
    // The cage on top of everything (planes, other bodies, the gimbal).
    this.lines.renderOrder = 68;
    this.dots.renderOrder = 70;
    for (const o of [this.marks, this.hoverMarks]) o.renderOrder = 69;
    for (const o of [this.markDots, this.hoverDots]) o.renderOrder = 71;
  }

  get editingId(): string | undefined {
    return this.existing?.id;
  }

  enter(): void {
    const view = this.app.view;
    if (this.sym) queueMicrotask(() => this.drawSymPlane());
    this.symMark.renderOrder = 72;
    this.symMark.visible = false;
    view.overlay.add(this.symPlane, this.symMark, this.surface, this.faceEdges, this.lines, this.dots, this.markFill, this.marks, this.markDots, this.hoverMarks, this.hoverDots);
    // Editing an existing freeform: hide its finished body while the cage is out.
    if (this.existing) view.setHidden(new Set([...this.app.store.doc.hidden, this.existing.id]));
    this.app.setSelection([]);
    // Cancel is in the card (on a phone the card is one row without it: there it's in the column).
    this.app.ui.setTools(screenClass() === "phone" ? [{ id: "cancel", label: "Cancel", icon: "close", shortcut: "Esc", run: () => this.cancel() }] : []);
    this.app.ui.setBottom([]);
    if (this.choosingPlane) {
      // Nothing shown yet: the origin planes (and flat faces) to put it on.
      for (const o of [this.surface, this.faceEdges, this.lines, this.dots]) o.visible = false;
      view.setOriginPlanesVisible(true);
      this.app.ui.setHint("Select a plane or a flat face to place the surface on.");
      this.app.ui.showPanel({ title: "Freeform surface", items: [], onCancel: () => this.cancel() });
      return;
    }
    this.startEditing();
  }

  /** Show the cage and the shape, ready to edit. */
  private startEditing(): void {
    // A new box, cylinder or sphere: its size and rows in the card first.
    if (!this.existing && this.primKind && this.primKind !== "plane") {
      const prim = this.primKind;
      this.live = { kind: "shape", prim, size: [40, 40, 40], rows: prim === "sphere" ? 2 : 2 };
      this.cage = shapeCage(prim, [40, 40, 40], 2);
    }
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
    // A new shape: framed, clear of the card (it used to appear tiny, half under it on a phone).
    if (!this.existing) {
      const box = new Box3().setFromPoints(this.cage.verts.map((v) => new Vector3(...v)));
      this.app.view.cam.fit(box, true, this.app.view.coveredInsets());
    }
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
    view.setOriginPlanesVisible(false);
    // (A sprite's geometry is shared by every sprite: only taken off, not disposed.)
    view.overlay.remove(this.symMark);
    view.overlay.remove(this.faceEdges);
    for (const o of [this.symPlane, this.surface, this.lines, this.dots, this.markFill, this.marks, this.markDots, this.hoverMarks, this.hoverDots]) {
      view.overlay.remove(o);
      o.geometry.dispose();
    }
    this.gimbal?.dispose();
    this.gimbal = null;
    view.setHidden(new Set(this.app.store.doc.hidden));
    this.app.ui.showPanel(null);
    this.app.ui.setHint(null);
    this.app.ui.setLabel(0, 0, null);
    this.typing.hideBox();
    for (const o of [this.marks, this.hoverMarks, this.faceEdges]) {
      o.geometry.dispose();
      view.releaseLineMaterial(o.material);
    }
    view.requestRender();
  }

  private hint(): void {
    if (this.placing) return this.app.ui.setHint("Drag the gimbal (or type Move values) to put it in place first. Then tap points, edges or faces to shape it.");
    // A phone has no Shift: there every tap adds, a second tap drops it.
    if (this.live && this.live.kind !== "shape" && this.live.kind !== "sheet") return this.app.ui.setHint("Shape it with the sliders in the card. Tap the model (or take the next step) to keep it.");
    if (this.live) return this.app.ui.setHint("Set the size and rows in the card, then tap faces to shape it.");
    const more = isCoarse ? "Tap more to add; tap a face again for the one behind it" : "Shift+tap adds; click a face again for the one behind it";
    this.app.ui.setHint(
      this.picks.length
        ? `Drag the gimbal, or type exact Move / Turn / Scale values. ${more}. Tap empty space to deselect.`
        : `Tap cage points, edges or faces to select them (${isCoarse ? "every tap adds" : "Shift adds"}). Done turns the shape into a body.`,
    );
  }

  private panel(): void {
    const n = this.selectedVerts().length;
    const items: PanelItem[] = this.liveItems();
    if (n && (!this.live || this.live.kind === "shape" || this.live.kind === "sheet")) {
      // Exact values (a phone can't type while dragging), from where the points are now.
      this.fieldBase = null;
      // Nothing moved yet: no offset, no turn - and every scale factor 1 (0 flattened the points).
      this.fieldVals = this.xform === "scale" ? [1, 1, 1, 1] : [0, 0, 0, 1];
      items.push({ type: "choice", options: [{ id: "move", label: "Move" }, { id: "turn", label: "Turn" }, { id: "scale", label: "Scale" }], value: this.xform, onChange: (v) => ((this.xform = v as typeof this.xform), this.panel()) });
      if (this.xform === "scale") {
        items.push({ type: "number", label: "All", value: 1, kind: "number", min: 0.01, onInput: (v) => this.setField(3, v) });
        for (const [k, a] of ["X", "Y", "Z"].entries()) items.push({ type: "number", label: a, value: 1, kind: "number", min: 0.01, onInput: (v) => this.setField(k, v) });
      } else {
        const turn = this.xform === "turn";
        for (const [k, a] of ["X", "Y", "Z"].entries()) items.push({ type: "number", label: turn ? `${a}°` : `Δ${a}`, value: 0, kind: turn ? "angle" : "length", onInput: (v) => this.setField(k, v) });
      }
    }
    if (!this.live && !this.placing) {
      items.push({
        type: "toggle",
        label: "Symmetry",
        value: !!this.sym || this.symPicking,
        onChange: (on) => {
          // Two facing (parallel) faces picked: the mirror goes midway between them.
          const fs = this.picks.filter((p): p is Extract<Pick, { kind: "face" }> => p.kind === "face");
          if (on && fs.length === 2) {
            const mid = (f: number) => this.centroid([...this.cage.faces[f]]);
            const nrm = (f: number) => {
              const [a, b, c, d] = this.cage.faces[f].map((i) => this.cage.verts[i]);
              return norm(cross(sub(c, a), sub(d, b)));
            };
            const [n0, n1] = [nrm(fs[0].f), nrm(fs[1].f)];
            if (Math.abs(dot(n0, n1)) > 0.995) return this.setSymmetry(scale(add(mid(fs[0].f), mid(fs[1].f)), 0.5), n0);
          }
          this.sym = null;
          this.symPairs = null;
          this.symPicking = on;
          this.drawSymPlane();
          if (on) this.app.ui.setHint("Symmetry: pick X / Y / Z (through the middle), tap a cage edge (across its middle) - or pick two facing faces first: midway between them.");
          this.panel();
        },
      });
      if (this.symPicking) {
        const mid = this.centroid(this.cage.verts.map((_, i) => i));
        items.push({ type: "choice", label: "Mirror across", options: [{ id: "x", label: "X" }, { id: "y", label: "Y" }, { id: "z", label: "Z" }], value: "", onChange: (k) => this.setSymmetry(mid, k === "x" ? [1, 0, 0] : k === "y" ? [0, 1, 0] : [0, 0, 1]) });
      }
    }
    // Points on an open border picked (two or more along it): new faces beyond them.
    const pickedVerts = this.picks.filter((p): p is Extract<Pick, { kind: "vert" }> => p.kind === "vert").map((p) => p.i);
    if (pickedVerts.length >= 2 && !this.placing && !this.live && extendBorder(this.cage, pickedVerts)) {
      items.push({
        type: "button",
        label: "Extend surface",
        icon: "extrude",
        onClick: () => {
          const r = extendBorder(this.cage, pickedVerts);
          if (r) this.changeCage(r.cage, r.verts.map((i) => ({ kind: "vert" as const, i })));
        },
      });
    }
    const faces = this.picks.filter((p) => p.kind === "face").length;
    if (faces && !this.placing) {
      items.push(
        { type: "button", label: `Extrude face${faces > 1 ? "s" : ""}`, icon: "extrude", onClick: () => this.extrudeSelected() },
        { type: "button", label: "Inset", icon: "offset", onClick: () => this.insetSelected() },
      );
    }
    if (faces) items.push({ type: "button", label: `Delete face${faces > 1 ? "s" : ""}`, icon: "trash", onClick: () => this.deleteSelectedFaces() });
    // Two faces: a tube between them (a handle, a tunnel) - both open up and join.
    if (faces === 2 && !this.placing) items.push({ type: "button", label: "Bridge faces", icon: "loft", onClick: () => this.bridgeSelectedFaces() });
    // One edge picked: a new loop of points across the faces it runs through.
    const edges = this.picks.filter((p) => p.kind === "edge");
    if (edges.length === 1 && !faces && !this.placing) items.push({ type: "button", label: "Add edge loop", icon: "splitLine", onClick: () => this.addEdgeLoop(edges[0].e) });
    // Rim edges of holes picked: one hole → Fill, two facing holes → Bridge.
    // (Not while the whole shape is being placed: then every point is picked.)
    const loops = this.placing ? [] : this.pickedLoops();
    if (loops.length === 1) items.push({ type: "button", label: "Fill hole", icon: "fill", onClick: () => this.fillHoles(loops) });
    if (loops.length === 2) items.push({ type: "button", label: "Bridge holes", icon: "loft", onClick: () => this.fillHoles(loops) });
    // Two runs of border edges (two edges, two rows): a strip of faces between them.
    else {
      const runs = this.placing ? [] : this.pickedRuns();
      if (runs.length === 2 && !runs.every((r) => r.closed)) items.push({ type: "button", label: "Connect edges", icon: "loft", onClick: () => this.connectRuns(runs) });
    }
    // An open shape can be given a thickness to become a solid.
    if (!isClosed(this.cage)) {
      items.push(
        { type: "number", label: "Thickness", value: this.thickness, kind: "length", min: 0, onInput: (v) => ((this.thickness = Math.max(0, v)), this.panelHint()) },
        { type: "choice", options: [{ id: "up", label: "Up" }, { id: "down", label: "Down" }, { id: "both", label: "Symmetric" }], value: this.thickSide, onChange: (v) => ((this.thickSide = v as typeof this.thickSide), this.panel()) },
        // Or solid down to a plane (no thickness): finish the surface, then pick the plane.
        {
          type: "button",
          label: "Fill to a plane…",
          icon: "fill",
          onClick: () => {
            this.thickness = 0;
            const id = this.done();
            if (id) this.app.setTool(new FillToPlaneOp(this.app, id));
          },
        },
      );
    }
    const liveTitle = { shape: "New shape", sheet: "New surface", sweep: "Pulled out", inset: "Inset", bridge: "Bridge" };
    this.app.ui.showPanel({
      title: this.live ? `Freeform · ${liveTitle[this.live.kind]}` : `Freeform${n ? ` · ${n} point${n > 1 ? "s" : ""}` : ""}`,
      items,
      actions: [
        { id: "all", label: "Select all", icon: "pointer", run: () => ((this.picks = this.cage.verts.map((_, i) => ({ kind: "vert" as const, i }))), this.selectionChanged()) },
        // Twice as many cage points everywhere, same shape (for finer shaping).
        { id: "refine", label: "Add detail", icon: "patternLinear", run: () => this.addDetail() },
      ],
      onDone: () => this.done(),
      onCancel: () => this.cancel(),
      enterApplies: true,
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

  /** Picked border edges grouped into runs (edges picked, or the points along them). */
  private pickedRuns(): Chain[] {
    const verts = new Set(this.selectedVerts());
    const picked = new Set(this.picks.flatMap((p) => (p.kind === "edge" ? [cageEdgeKey(p.e[0], p.e[1])] : [])));
    const chosen = new Set<string>();
    for (const [a, b] of boundaryEdges(this.cage)) if (picked.has(cageEdgeKey(a, b)) || (verts.has(a) && verts.has(b) && !picked.size)) chosen.add(cageEdgeKey(a, b));
    return chosen.size ? borderChains(this.cage, chosen) : [];
  }

  private connectRuns(runs: Chain[]): void {
    const edges = (c: Chain) => (c.closed ? c.verts.length : c.verts.length - 1);
    if (runs[0].closed !== runs[1].closed) return this.app.ui.toast("Connect a hole with a hole, or a row of edges with a row");
    if (edges(runs[0]) !== edges(runs[1])) return this.app.ui.toast(`Both sides need the same number of edges (${edges(runs[0])} and ${edges(runs[1])})`);
    const next = bridgeChains(this.cage, runs[0], runs[1]);
    if (!next) return this.app.ui.toast("These edges can't be connected (they touch each other)");
    this.remember();
    this.cage = next;
    this.picks = [];
    this.rebuild();
    this.selectionChanged();
    this.panelHint();
  }

  /** A cage change: the new cage, what's picked after it, and a fresh preview. */
  private changeCage(next: Cage, picks: Pick[]): void {
    this.remember();
    this.cage = next;
    this.picks = picks;
    this.rebuild();
    this.selectionChanged();
    this.panelHint();
  }

  /** Typical cage edge length (for default sizes). */
  private edgeSize(): number {
    const es = cageEdges(this.cage);
    const t = es.reduce((s, [a, b]) => s + len(sub(this.cage.verts[a], this.cage.verts[b])), 0);
    return t / Math.max(1, es.length);
  }

  private pickedFaces(): number[] {
    return this.picks.flatMap((p) => (p.kind === "face" ? [p.f] : []));
  }

  /** The picked faces lift out a little, with new side faces; they stay picked to drag further. */
  private extrudeSelected(): void {
    const picked = this.pickedFaces();
    if (picked.length === 1) {
      // One face: pulled out in steps, with Length / Bend / Taper sliders.
      const q = this.cage.faces[picked[0]].map((v) => this.cage.verts[v]);
      const size = (len(sub(q[0], q[2])) + len(sub(q[1], q[3]))) / 2 / Math.SQRT2;
      this.startLive({ kind: "sweep", base: this.cage, face: picked[0], steps: 4, length: Math.round(size * 2), bend: 0, taper: 1, size });
      this.app.ui.toast("Pulled out - Length, Bend and Taper in the card shape it (a spout: bend it up)");
      return;
    }
    const out = extrudeFaces(this.cage, this.pickedFaces(), this.edgeSize() * 0.4);
    if (!out) return;
    this.changeCage(out.cage, out.faces.map((f) => ({ kind: "face" as const, f })));
    this.app.ui.toast("Extruded - drag the gimbal to pull the faces further (or push them in)");
  }

  /** A smaller face inside each picked one (ringed by new faces), picked to shape on its own. */
  private insetSelected(): void {
    this.startLive({ kind: "inset", base: this.cage, faces: this.pickedFaces(), amount: 0.3 });
  }

  /** A new loop of points across every face the edge's ring runs through; the new points get picked. */
  private addEdgeLoop(e: [number, number]): void {
    const before = this.cage.verts.length;
    const next = insertEdgeLoop(this.cage, e[0], e[1]);
    if (!next) return this.app.ui.toast("No clean loop runs through this edge (its ring of faces crosses itself) - try a neighbouring edge");
    this.changeCage(next, next.verts.slice(before).map((_, k) => ({ kind: "vert" as const, i: before + k })));
    this.app.ui.toast("Edge loop added - its new points are picked (drag or scale them)");
  }

  /** The whole cage twice as fine: the shape doesn't change, there's just more to pull. */
  private addDetail(): void {
    if (this.cage.faces.length > 600) return this.app.ui.toast("The cage is fine enough already (it would get slow)");
    this.changeCage(refineCage(this.cage), []);
  }

  private bridgeSelectedFaces(): void {
    const [a, b] = this.pickedFaces();
    if (!bridgeFaces(this.cage, a, b)) return this.app.ui.toast("These two faces can't be bridged (they touch each other)");
    const ca = scale(this.cage.faces[a].reduce((s, v) => add(s, this.cage.verts[v]), [0, 0, 0] as Vec3), 0.25);
    const cb = scale(this.cage.faces[b].reduce((s, v) => add(s, this.cage.verts[v]), [0, 0, 0] as Vec3), 0.25);
    const span = len(sub(ca, cb));
    // Faces looking the same way (two on the back of a can): a handle, arched out.
    // Facing each other (a tunnel): straight across.
    const same = dot(this.faceNormalOf(a), this.faceNormalOf(b)) > 0.3;
    this.startLive({ kind: "bridge", base: this.cage, fa: a, fb: b, arch: same ? Math.round(span * 0.9) : 0, segments: same ? 6 : 1, span });
    this.app.ui.toast(same ? "Bridged into a handle - Arch in the card sets how far it reaches out" : "Bridged - the two faces are joined by a tube");
  }

  private faceNormalOf(f: number): Vec3 {
    const [p, q, r, t] = this.cage.faces[f].map((v) => this.cage.verts[v]);
    return norm(cross(sub(r, p), sub(t, q)));
  }

  // ---------------------------------------------------------- live steps

  private startLive(l: Live): void {
    this.remember();
    this.live = l;
    if (!this.applyLive()) {
      this.live = null;
      this.past.pop();
      this.app.refreshUndo();
      return;
    }
    this.panel();
    this.hint();
  }

  /** Re-make the live step from its base with the card's current values. */
  private applyLive(): boolean {
    const l = this.live;
    if (!l) return false;
    let next: Cage | null = null;
    let picks: Pick[] = [];
    if (l.kind === "shape") {
      next = shapeCage(l.prim, l.size, l.rows);
      if (this.placing) picks = next.verts.map((_, i) => ({ kind: "vert" as const, i }));
    } else if (l.kind === "sheet") {
      const flat = planeCage(l.size, Math.max(1, Math.round(l.rows)));
      next = { faces: flat.faces, verts: flat.verts.map((v) => add(l.at, add(add(scale(l.x, v[0]), scale(l.y, v[1])), scale(l.n, v[2])))) };
      if (this.placing) picks = next.verts.map((_, i) => ({ kind: "vert" as const, i }));
    } else if (l.kind === "sweep") {
      const r = sweepFace(l.base, l.face, l);
      if (r) ((next = r.cage), (picks = [{ kind: "face", f: r.face }]));
    } else if (l.kind === "inset") {
      const r = insetFaces(l.base, l.faces, l.amount);
      if (r) ((next = r.cage), (picks = r.faces.map((f) => ({ kind: "face" as const, f }))));
    } else {
      next = archBridge(l.base, l.fa, l.fb, l);
      if (!next) this.app.ui.toast("That would twist the handle - try less arch or more segments");
    }
    if (!next) return false;
    this.cage = next;
    this.picks = picks;
    this.rebuild();
    this.placeGimbal();
    this.drawMarks();
    return true;
  }

  private setLive(patch: Partial<Record<string, number | Vec3>>): void {
    if (!this.live) return;
    const before = { ...this.live };
    Object.assign(this.live, patch);
    // Not possible (a handle that would twist): stay as it was.
    if (!this.applyLive()) ((this.live = before as Live), this.applyLive());
  }

  private frameTimer = 0;
  /** After a size change: frame the new size (once typing pauses). */
  private frameSoon(): void {
    clearTimeout(this.frameTimer);
    this.frameTimer = window.setTimeout(() => {
      const box = new Box3().setFromPoints(this.cage.verts.map((v) => new Vector3(...v)));
      this.app.view.cam.fit(box, true, this.app.view.coveredInsets());
    }, 500);
  }

  /** The live step's controls, at the top of the card. */
  private liveItems(): PanelItem[] {
    const l = this.live;
    if (!l) return [];
    const mm = (v: number) => fmtLen(v);
    if (l.kind === "sheet")
      return [
        { type: "number", label: "Width", value: l.size[0], kind: "length", min: 0.01, onInput: (v) => (this.setLive({ size: [v, l.size[1]] as unknown as Vec3 }), this.frameSoon()) },
        { type: "number", label: "Depth", value: l.size[1], kind: "length", min: 0.01, onInput: (v) => (this.setLive({ size: [l.size[0], v] as unknown as Vec3 }), this.frameSoon()) },
        { type: "slider", label: "Faces", value: l.rows, min: 1, max: 8, step: 1, onInput: (v) => this.setLive({ rows: v }) },
        // Where its middle is, from the origin: it lands on the middle of the
        // face tapped, which is rarely a round number (a base plate's top was
        // 1.43 off centre once a bumper ran along one edge) - ΔX / ΔY from there
        // were sums to do.
        ...([0, 1, 2] as const).map((k) => ({
          type: "number" as const,
          label: `Centre ${"XYZ"[k]}`,
          value: Math.round(l.at[k] * 1000) / 1000,
          kind: "length" as const,
          onInput: (v: number) => this.setLive({ at: l.at.map((x, i) => (i === k ? v : x)) as Vec3 }),
        })),
      ];
    if (l.kind === "shape") {
      const round = l.prim !== "box";
      const out: PanelItem[] = [
        { type: "number", label: round ? "Diameter" : "Width", value: l.size[0], kind: "length", min: 0.01, onInput: (v) => (this.setLive({ size: round ? [v, v, l.prim === "sphere" ? v : l.size[2]] : [v, l.size[1], l.size[2]] }), this.frameSoon()) },
      ];
      if (l.prim === "box") out.push({ type: "number", label: "Depth", value: l.size[1], kind: "length", min: 0.01, onInput: (v) => (this.setLive({ size: [l.size[0], v, l.size[2]] }), this.frameSoon()) });
      if (l.prim !== "sphere") {
        out.push({ type: "number", label: "Height", value: l.size[2], kind: "length", min: 0.01, onInput: (v) => (this.setLive({ size: [l.size[0], l.size[1], v] }), this.frameSoon()) });
        out.push({ type: "slider", label: l.prim === "box" ? "Faces" : "Rows", value: l.rows, min: 1, max: 8, step: 1, onInput: (v) => this.setLive({ rows: v }) });
      }
      return out;
    }
    if (l.kind === "sweep")
      return [
        { type: "slider", label: "Length", value: l.length, min: Math.max(1, Math.round(l.size * 0.2)), max: Math.round(l.size * 10), step: 1, show: mm, onInput: (v) => this.setLive({ length: v }) },
        { type: "slider", label: "Bend", value: l.bend, min: -150, max: 150, step: 1, show: (v) => `${v}°`, onInput: (v) => this.setLive({ bend: v }) },
        { type: "slider", label: "Taper", value: l.taper, min: 0.2, max: 2.5, step: 0.05, show: (v) => `${v.toFixed(2)}×`, onInput: (v) => this.setLive({ taper: v }) },
        { type: "slider", label: "Steps", value: l.steps, min: 1, max: 12, step: 1, onInput: (v) => this.setLive({ steps: v }) },
      ];
    if (l.kind === "inset") return [{ type: "slider", label: "Inset", value: l.amount, min: 0.05, max: 0.9, step: 0.01, show: (v) => `${Math.round(v * 100)}%`, onInput: (v) => this.setLive({ amount: v }) }];
    return [
      { type: "slider", label: "Arch", value: l.arch, min: 0, max: Math.round(l.span * 3), step: 1, show: mm, onInput: (v) => this.setLive({ arch: v, segments: v > 0 && l.segments < 2 ? 6 : l.segments }) },
      { type: "slider", label: "Segments", value: l.segments, min: 1, max: 12, step: 1, onInput: (v) => this.setLive({ segments: v }) },
    ];
  }

  private deleteSelectedFaces(): void {
    const faces = this.picks.flatMap((p) => (p.kind === "face" ? [p.f] : []));
    if (!faces.length) return;
    if (faces.length >= this.cage.faces.length) return this.app.ui.toast("At least one face has to stay");
    this.remember();
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
    let next: Cage | null;
    if (loops.length === 2) next = bridgeLoops(this.cage, loops[0], loops[1]);
    else {
      const filled = fillHole(this.cage, loops[0]);
      next = filled?.cage ?? null;
      if (filled?.refined) this.app.ui.toast("The cage got twice as fine so this hole could be closed - the shape stays the same");
    }
    if (!next) return this.app.ui.toast(loops.length === 2 ? "Bridging needs two holes with the same number of edges" : "That hole can't be filled");
    this.remember();
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

  /** Is a cage point well behind the smooth surface, seen from the eye? */
  private hiddenPoint(q: Vec3, eye: Vec3): boolean {
    const d = sub(q, eye);
    const L = len(d);
    if (L < 1e-9) return false;
    this.ray.set(new Vector3(...eye), new Vector3(d[0] / L, d[1] / L, d[2] / L));
    const hit = this.ray.intersectObject(this.surface, false)[0]?.distance ?? Infinity;
    const g = this.surface.geometry.boundingSphere;
    const margin = (g?.radius ?? 10) * 0.15;
    return hit < L - margin;
  }

  /**
   * The cage point, edge or (frontmost) face the tap is closest to. Points and
   * edges behind the smooth surface (the far side) don't count.
   */
  private pickAt(p: ToolPointer): Pick | null {
    const view = this.app.view;
    const scr = this.cage.verts.map((v) => view.toScreen(v));
    // Points are drawn on top of everything, and are picked that way too: a
    // generous reach, and one hidden behind the surface still counts (a point
    // in plain view nearby wins over it).
    const tol = Math.max(16, p.tol * 1.8);
    const eye = view.cam.camera.position.toArray() as Vec3;
    const wall = this.surfaceDepth(p);
    // In front of the smooth surface along the tap's ray, give or take a little:
    // a cage edge can lie just millimetres outside the surface (a cylinder's
    // sides), and where along it the tap falls is only estimated - with no
    // allowance, half the edges of a tall cylinder couldn't be picked.
    const reach = (this.surface.geometry.boundingSphere?.radius ?? 10) * 0.08;
    const visible = (q: Vec3) => len(sub(q, eye)) < wall + reach;
    let best: { d: number; i: number } | null = null;
    scr.forEach((s, i) => {
      if (!s) return;
      const d = Math.hypot(s[0] - p.x, s[1] - p.y);
      if (d >= tol) return;
      const hidden = this.hiddenPoint(this.cage.verts[i], eye);
      // Behind the shape while the tap lands on it: that's a tap on the near
      // side - the spout's points showing through the can took taps meant for
      // the face in front of them.
      if (hidden && wall < Infinity) return;
      const score = d + (hidden ? tol : 0);
      if (!best || score < best.d) best = { d: score, i };
    });
    let bestE: { d: number; e: [number, number] } | null = null;
    for (const e of cageEdges(this.cage)) {
      const a = scr[e[0]];
      const b = scr[e[1]];
      if (!a || !b) continue;
      const { d, t } = segDist(p.x, p.y, a, b);
      const at = add(this.cage.verts[e[0]], scale(sub(this.cage.verts[e[1]], this.cage.verts[e[0]]), t));
      if (d < p.tol && visible(at) && (!bestE || d < bestE.d)) bestE = { d, e };
    }
    // Faces: inside the projected quad; nearest to the camera wins.
    let bestF: { d: number; f: number; mid: number } | null = null;
    this.cage.faces.forEach((f, fi) => {
      const q = f.map((i) => scr[i]);
      if (q.some((s) => !s) || !inPoly(p.x, p.y, q as [number, number][])) return;
      const c = scale(f.reduce((s, i) => add(s, this.cage.verts[i]), [0, 0, 0] as Vec3), 0.25);
      const d = len(sub(c, eye));
      const m = view.toScreen(c);
      if (!bestF || d < bestF.d) bestF = { d, f: fi, mid: m ? Math.hypot(m[0] - p.x, m[1] - p.y) : Infinity };
    });
    // Whichever the tap is closest to: a point, an edge, or the middle of the
    // face under it. (Points always won within a fingertip's reach: on a
    // phone, among a detailed cage, a face's middle couldn't be tapped.)
    const pt = best as { d: number; i: number } | null;
    const ed = bestE as { d: number; e: [number, number] } | null;
    const fc = bestF as { d: number; f: number; mid: number } | null;
    const faceAt = fc ? fc.mid : Infinity;
    // A point gets a few pixels' start on the edges running out of it: a tap a
    // fingertip's wobble from a point lies right on those edges (aiming at the
    // nine inner points of a sheet picked three edges).
    const slack = Math.min(10, p.tol * 0.4);
    if (pt && pt.d <= Math.min((ed?.d ?? Infinity) + slack, faceAt)) return { kind: "vert", i: pt.i };
    if (ed && ed.d < faceAt) return { kind: "edge", e: ed.e };
    if (fc) return { kind: "face", f: fc.f };
    if (pt) return { kind: "vert", i: pt.i };
    return ed ? { kind: "edge", e: ed.e } : null;
  }

  /** Every cage face under the pointer, nearest first. */
  private facesUnder(p: ToolPointer): number[] {
    const view = this.app.view;
    const scr = this.cage.verts.map((v) => view.toScreen(v));
    const eye = view.cam.camera.position.toArray() as Vec3;
    const out: { f: number; d: number }[] = [];
    this.cage.faces.forEach((f, fi) => {
      const q = f.map((i) => scr[i]);
      if (q.some((s) => !s) || !inPoly(p.x, p.y, q as [number, number][])) return;
      const c = scale(f.reduce((s, i) => add(s, this.cage.verts[i]), [0, 0, 0] as Vec3), 0.25);
      out.push({ f: fi, d: len(sub(c, eye)) });
    });
    return out.sort((a, b) => a.d - b.d).map((x) => x.f);
  }

  /** Which plane / flat face is under the pointer (choosing where a new surface goes). */
  private planeAt(p: ToolPointer): { plane: PlaneDef; at: Vec3; sel: Sel } | null {
    const hit = this.app.view.pick(p.x, p.y, { edges: false, vertices: false, planes: true, planesFirst: true, profiles: false, edgeTolPx: 0 });
    if (hit?.kind === "plane") {
      const plane = this.app.view.planeOf(hit.id);
      return plane ? { plane, at: plane.origin, sel: { kind: "plane", id: hit.id } } : null;
    }
    if (hit?.kind === "face") {
      const info = this.app.view.body(hit.body)?.faces[hit.face];
      // On a face: centred on it.
      if (info?.plane) return { plane: info.plane, at: info.center, sel: { kind: "face", body: hit.body, face: hit.face } };
    }
    return null;
  }

  hover(p: ToolPointer | null): void {
    if (this.choosingPlane) {
      this.app.setHover(p ? (this.planeAt(p)?.sel ?? null) : null);
      return;
    }
    if (this.dragging) return;
    const g = p && this.gimbal?.hit(p);
    this.gimbal?.setHot(g ?? null);
    this.hovered = p && !g ? this.pickAt(p) : null;
    this.app.view.canvas.style.cursor = g ? "grab" : "";
    this.drawMarks();
  }

  tap(p: ToolPointer, count = 1): void {
    if (this.symPicking && !this.choosingPlane) {
      const hit = this.pickAt(p);
      if (hit?.kind === "edge") {
        const [a, b] = hit.e.map((i) => this.cage.verts[i]);
        this.setSymmetry(scale(add(a, b), 0.5), sub(b, a));
        return;
      }
      return this.app.ui.toast("Tap a cage edge (the mirror goes across its middle), or pick X / Y / Z in the card");
    }
    if (this.choosingPlane) {
      const at = this.planeAt(p);
      if (!at) return this.app.ui.toast("Select a plane or a flat face");
      // The flat sheet (made on XY at the origin) laid onto that plane.
      const x = norm(at.plane.xDir);
      const n = norm(at.plane.normal);
      const y = cross(n, x);
      this.cage = { faces: this.cage.faces, verts: this.cage.verts.map((v) => add(at.at, add(add(scale(x, v[0]), scale(y, v[1])), scale(n, v[2])))) };
      // Its size and faces in the card, like a new box (a 50 × 30 pad was a
      // 60 × 60 sheet to be scaled by 0.83 and 0.5).
      this.live = { kind: "sheet", size: [60, 60], rows: 4, at: at.at, x, y, n };
      this.choosingPlane = false;
      this.app.setHover(null);
      this.app.view.setOriginPlanesVisible(false);
      for (const o of [this.surface, this.faceEdges, this.lines, this.dots]) o.visible = true;
      this.startEditing();
      return;
    }
    // Tapped again where a face was just picked: the face behind it (a face
    // hidden behind another part - a handle's end behind its own arm - could
    // never be reached). Past the last one, it's dropped.
    const lt = this.lastFaceTap;
    if (lt && Math.hypot(p.x - lt.x, p.y - lt.y) < 14 && performance.now() - lt.t < 4000 && this.picks.some((x) => x.kind === "face" && x.f === lt.f)) {
      const under = this.facesUnder(p);
      const k = under.indexOf(lt.f);
      this.live = null;
      this.picks = this.picks.filter((x) => !(x.kind === "face" && x.f === lt.f));
      if (k >= 0 && k + 1 < under.length) {
        const f = under[k + 1];
        this.picks.push({ kind: "face", f });
        this.lastFaceTap = { x: p.x, y: p.y, t: performance.now(), f };
        this.app.ui.toast(k + 2 < under.length ? "The face behind - tap again for the next one" : "The face behind (tap again to drop it)");
      } else this.lastFaceTap = null;
      this.selectionChanged();
      return;
    }
    // Double-tap on empty space: finish and select the whole body (e.g. to move
    // or colour it). On a point, edge or face it's just quick tapping: keep it picked.
    if (count >= 2) {
      const again = this.pickAt(p);
      if (again) {
        if (!this.picks.some((x) => JSON.stringify(x) === JSON.stringify(again))) {
          this.live = null;
          if (p.shift || p.add || p.type === "touch") this.picks.push(again);
          else this.picks = [again];
          this.selectionChanged();
        }
        return;
      }
      const id = this.done();
      if (id) this.app.setSelection([{ kind: "body", body: id }]);
      return;
    }
    this.lastFaceTap = null;
    this.live = null;
    // A tap while placing: they'd rather edit right away.
    if (this.placing) {
      this.placing = false;
      this.picks = [];
    }
    const hit = this.pickAt(p);
    if (!hit) {
      // Empty space: deselect. With nothing selected it used to finish the
      // whole edit - one stray tap on a phone (meant to deselect) ended it
      // half made. Done, or a double-tap on empty space, finishes.
      if (this.picks.length) return ((this.picks = []), this.selectionChanged());
      this.app.ui.toast("Nothing picked. Done (or a double-tap on empty space) finishes the shape");
      return;
    }
    const key = JSON.stringify(hit);
    const i = this.picks.findIndex((x) => JSON.stringify(x) === key);
    // A touch screen has no Shift: there every tap adds, and a second tap drops it.
    if (p.shift || p.add || p.type === "touch") {
      if (i >= 0) this.picks.splice(i, 1);
      else this.picks.push(hit);
    } else this.picks = i >= 0 && this.picks.length === 1 ? [] : [hit];
    if (hit.kind === "face" && this.picks.some((x) => x.kind === "face" && x.f === hit.f)) this.lastFaceTap = { x: p.x, y: p.y, t: performance.now(), f: hit.f };
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

  /**
   * A mouse drag from empty space: the blue box - the cage points inside it
   * are picked (with Shift / Ctrl added to what's picked).
   */
  box(a: { x: number; y: number }, b: { x: number; y: number }, final: boolean, add: boolean): void {
    if (!final || this.choosingPlane || this.dragging) return;
    const [x0, x1] = [Math.min(a.x, b.x), Math.max(a.x, b.x)];
    const [y0, y1] = [Math.min(a.y, b.y), Math.max(a.y, b.y)];
    if (x1 - x0 < 3 && y1 - y0 < 3) return;
    const inside = this.cage.verts.flatMap((v, i) => {
      const q = this.app.view.toScreen(v);
      return q && q[0] >= x0 && q[0] <= x1 && q[1] >= y0 && q[1] <= y1 ? [i] : [];
    });
    const keep = add ? this.picks.filter((p) => p.kind === "vert" && !inside.includes(p.i)) : [];
    this.picks = [...keep, ...inside.map((i) => ({ kind: "vert" as const, i }))];
    this.selectionChanged();
  }

  down(p: ToolPointer): boolean {
    if (this.choosingPlane) return false;
    const part = this.gimbal?.hit(p);
    if (!part || !this.gimbal) return false;
    // Another cage point right under the pointer: that's a tap on it, not a drag
    // of the gimbal's middle (arrows and rings still drag).
    if (part.kind === "center" || part.kind === "plane") {
      const hit = this.pickAt(p);
      const sel = new Set(this.selectedVerts());
      if (hit?.kind === "vert" && !sel.has(hit.i)) {
        const s = this.app.view.toScreen(this.cage.verts[hit.i]);
        if (s && Math.hypot(s[0] - p.x, s[1] - p.y) < Math.max(10, p.tol)) return false;
      }
    }
    // One point turned about itself wouldn't move: it turns about the shape's centre instead.
    const ids = this.selectedVerts();
    const center = part.kind === "ring" && ids.length === 1 ? this.centroid(this.cage.verts.map((_, i) => i)) : this.gimbal.origin;
    this.remember();
    this.fieldBase = null;
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
      this.boxAt(p, fmtLen(d));
    } else if (part.kind === "plane" || part.kind === "center") {
      const n: Vec3 = part.kind === "plane" ? GIMBAL_AXES[part.i] : (view.cam.viewDir().toArray() as Vec3);
      const plane = { origin: dr.center, normal: n, xDir: xDirFor(n) };
      const a = view.rayToPlane(dr.from.x, dr.from.y, plane);
      const b = view.rayToPlane(p.x, p.y, plane);
      if (!a || !b) return;
      const d = sub(b, a);
      this.apply([snap(d[0]), snap(d[1]), snap(d[2])], 0);
      this.boxAt(p, fmtLen(len(dr.d)));
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
      this.boxAt(p, `${total}°`);
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
    this.mirrorMoved(ids);
    this.gimbal?.setCenter(this.centroid(ids));
    this.rebuild();
  }

  // ----------------------------------------------------------- symmetry

  /** Mirror a point across the symmetry plane. */
  private mirrored(q: Vec3): Vec3 {
    const { origin, normal } = this.sym!;
    return sub(q, scale(normal, 2 * dot(sub(q, origin), normal)));
  }

  private setSymmetry(origin: Vec3, normal: Vec3): void {
    const n = norm(normal);
    if (len(n) < 0.5) return;
    this.sym = { origin, normal: n };
    this.symPicking = false;
    this.symPairs = null;
    this.drawSymPlane();
    this.panel();
    this.app.ui.toast("Symmetry on: what you move on one side moves on the other");
  }

  /** Which point mirrors which (worked out from where the points are before a change). */
  private pairs(base: Vec3[]): Map<number, number> {
    if (this.symPairs && this.symPairs.size === base.length) return this.symPairs;
    const box = new Box3().setFromPoints(base.map((v) => new Vector3(...v)));
    const tol = Math.max(1e-6, box.getSize(new Vector3()).length() * 1e-4);
    const m = new Map<number, number>();
    base.forEach((v, i) => {
      const w = this.mirrored(v);
      let best = -1;
      let bd = tol;
      base.forEach((u, j) => {
        const dd = Math.hypot(u[0] - w[0], u[1] - w[1], u[2] - w[2]);
        if (dd <= bd) ((bd = dd), (best = j));
      });
      if (best >= 0) m.set(i, best);
    });
    this.symPairs = m;
    return m;
  }

  /** After points moved: their mirror images follow; points on the plane stay on it. */
  private mirrorMoved(ids: number[]): void {
    if (!this.sym || !ids.length) return;
    const base = this.dragging?.base ?? this.past[this.past.length - 1]?.cage.verts ?? this.cage.verts;
    if (base.length !== this.cage.verts.length) return;
    const pair = this.pairs(base);
    const moved = new Set(ids);
    const { origin, normal } = this.sym;
    for (const i of ids) {
      const j = pair.get(i);
      if (j === undefined) continue;
      if (j === i) {
        const v = this.cage.verts[i];
        this.cage.verts[i] = sub(v, scale(normal, dot(sub(v, origin), normal)));
      } else if (!moved.has(j) || i < j) this.cage.verts[j] = this.mirrored(this.cage.verts[i]);
    }
  }

  /** The symmetry plane, a see-through square round the shape. */
  private drawSymPlane(): void {
    const g = this.symPlane.geometry;
    this.symMark.visible = !!this.sym;
    if (!this.sym) {
      g.setAttribute("position", new BufferAttribute(new Float32Array(0), 3));
      return;
    }
    const box = new Box3().setFromPoints(this.cage.verts.map((v) => new Vector3(...v)));
    const r = box.getSize(new Vector3()).length() * 0.6 + 1;
    const n = this.sym.normal;
    const u = xDirFor(n);
    const w = cross(n, u);
    const c = sub(this.sym.origin, scale(n, 0));
    const P = (a: number, b: number) => add(c, add(scale(u, a * r), scale(w, b * r)));
    const q = [P(-1, -1), P(1, -1), P(1, 1), P(-1, -1), P(1, 1), P(-1, 1)].flat();
    g.setAttribute("position", new BufferAttribute(new Float32Array(q), 3));
    g.computeBoundingSphere();
    this.symPlane.renderOrder = 66;
    // Its mark at a corner (the symmetry symbol), so it reads as the mirror, not a plane of the model.
    this.symMark.position.set(...P(-0.97, 0.97));
    this.symMark.scale.set(2 * r * PLANE_MARK_SIZE, 2 * r * PLANE_MARK_SIZE, 1);
    this.app.view.requestRender();
  }

  up(): void {
    const moved = !!this.dragging && (len(this.dragging.d) > 0 || this.dragging.ang !== 0);
    const from = this.dragging?.from;
    // A press on the gimbal that moved nothing isn't a step to undo…
    if (this.dragging && !moved) (this.past.pop(), this.app.refreshUndo());
    this.dragging = null;
    // …it's a tap on what's under it: the gimbal's arrows lie over the faces
    // next to the picked one, and picking the four faces of a cap one after
    // another only ever got the first.
    if (from && !moved && !this.typing.active && this.pickAt(from)) {
      this.typing.reset();
      this.app.ui.setLabel(0, 0, null);
      this.typing.hideBox();
      this.gimbal?.setHot(null);
      this.tap(from);
      return;
    }
    this.typing.reset();
    this.app.ui.setLabel(0, 0, null);
    this.typing.hideBox();
    this.gimbal?.setHot(null);
    if (this.placing && moved) {
      // In place: on to editing points, edges and faces.
      this.placing = false;
      this.picks = [];
      this.selectionChanged();
      return;
    }
    this.placeGimbal();
    // The card's exact values start again from where the drag left the points.
    if (moved) this.panel();
  }

  /** What a typed value does to the drag under way. */
  private dragTarget(): DragTypingTarget | null {
    const dr = this.dragging;
    if (!dr) return null;
    const part = dr.part;
    const dragDir = norm(dr.d);
    return {
      kind: part.kind === "ring" ? "angle" : "length",
      apply: (v) => {
        if (part.kind === "ring") this.apply([0, 0, 0], v);
        else if (part.kind === "axis") this.apply(scale(GIMBAL_AXES[part.i], v), 0);
        else if (len(dr.d) > 1e-9) this.apply(scale(dragDir, v), 0);
      },
      commit: () => this.up(),
      cancel: () => this.apply([0, 0, 0], 0),
    };
  }

  dragKey(e: KeyboardEvent): boolean {
    const t = this.dragTarget();
    return !!t && this.typing.key(e, t);
  }

  /** The drag's value in a box by the pointer (type into it while dragging). */
  private boxAt(p: ToolPointer, text: string): void {
    const t = this.dragTarget();
    if (t) this.typing.box(p, text, t);
  }

  /**
   * A typed Move, Turn or Scale of the picked points (see moveTurnScale),
   * always from where they were when typing began.
   */
  private setField(k: number, v: number): void {
    if (this.xform === "scale" && !(v > 0)) return;
    const ids = this.selectedVerts();
    if (!ids.length) return;
    if (!this.fieldBase) {
      this.remember();
      this.fieldBase = new Map(ids.map((i) => [i, [...this.cage.verts[i]] as Vec3]));
    }
    this.fieldVals[k] = v;
    const base = [...this.fieldBase];
    const moved = moveTurnScale(base.map(([, p]) => p), this.xform, this.fieldVals as [number, number, number, number]);
    base.forEach(([i], n) => (this.cage.verts[i] = moved[n]));
    this.mirrorMoved(base.map(([i]) => i));
    this.rebuild();
    this.placeGimbal();
  }

  // ---------------------------------------------------------------- undo

  /** Keep the cage as it is now, before a change (Undo goes back to it). */
  private remember(): void {
    this.live = null;
    this.past.push({ cage: structuredClone(this.cage), picks: structuredClone(this.picks) });
    if (this.past.length > 100) this.past.shift();
    this.future = [];
    this.app.refreshUndo();
  }
  get canUndo(): boolean {
    return this.past.length > 0;
  }
  get canRedo(): boolean {
    return this.future.length > 0;
  }
  undo(): boolean {
    const prev = !this.dragging && this.past.pop();
    if (!prev) return false;
    this.live = null;
    this.future.push({ cage: structuredClone(this.cage), picks: structuredClone(this.picks) });
    this.restore(prev);
    return true;
  }
  redo(): boolean {
    const next = !this.dragging && this.future.pop();
    if (!next) return false;
    this.live = null;
    this.past.push({ cage: structuredClone(this.cage), picks: structuredClone(this.picks) });
    this.restore(next);
    return true;
  }
  private restore(st: { cage: Cage; picks: Pick[] }): void {
    this.cage = st.cage;
    this.picks = st.picks;
    this.rebuild();
    this.selectionChanged();
    this.panelHint();
    this.app.refreshUndo();
  }

  // --------------------------------------------------------------- drawing

  /** The plan the preview mesh was last built from (same layout: refill in place). */
  private shownPlan: SubdivPlan | null = null;
  private crossing = false;
  private crossTimer = 0;
  private crossAt = 0;

  /** Does the shape pass through itself? Red surface + a hint if so (kept cheap while dragging). */
  private checkCrossing(): void {
    const run = () => {
      this.crossAt = performance.now();
      this.crossTimer = 0;
      const was = this.crossing;
      this.crossing = selfCrossings(this.cage, this.cage.faces.length > 150 ? 1 : 2, 1).length > 0;
      (this.surface.material as MeshStandardMaterial).color.setHex(this.crossing ? 0xe06c6c : 0xb9c6dc);
      if (this.crossing !== was) {
        if (this.crossing) this.app.ui.setHint("The shape passes through itself here - pull the point back (it can't become a body like this).");
        else this.hint();
      }
      this.app.view.requestRender();
    };
    if (performance.now() - this.crossAt > 150) return run();
    if (!this.crossTimer) this.crossTimer = window.setTimeout(run, 150);
  }

  private rebuild(): void {
    this.checkCrossing();
    // The same smooth surface the body will have (points on the limit surface),
    // from weights kept per layout: while points are dragged or a slider moves,
    // the buffers are refilled in place (~0.3 ms, it was ~21 ms for a
    // watering can - 70–100 ms a finger move on a phone).
    const plan = cachedPlan(this.cage, 3);
    const g = this.surface.geometry;
    if (plan !== this.shownPlan) {
      this.shownPlan = plan;
      const pos = applyPlan(plan, this.cage.verts);
      const tri = planIndices(plan);
      g.setAttribute("position", new BufferAttribute(pos, 3));
      g.setAttribute("normal", new BufferAttribute(smoothNormals(pos, tri), 3));
      g.setIndex(new BufferAttribute(tri, 1));
      // The faces' outlines: each face's grid border, once per shared edge.
      this.faceEdgeIdx = faceBorders(plan);
    } else {
      const pa = g.getAttribute("position") as BufferAttribute;
      const na = g.getAttribute("normal") as BufferAttribute;
      applyPlan(plan, this.cage.verts, pa.array as Float32Array);
      smoothNormals(pa.array as Float32Array, g.getIndex()!.array as Uint32Array, na.array as Float32Array);
      pa.needsUpdate = true;
      na.needsUpdate = true;
    }
    g.computeBoundingSphere();
    const sp = g.getAttribute("position").array as Float32Array;
    const fe: number[] = new Array(this.faceEdgeIdx.length * 3);
    this.faceEdgeIdx.forEach((v, k) => ((fe[k * 3] = sp[v * 3]), (fe[k * 3 + 1] = sp[v * 3 + 1]), (fe[k * 3 + 2] = sp[v * 3 + 2])));
    setLines(this.faceEdges, fe);
    // (While a new surface's plane is still being chosen: not shown yet.)
    this.faceEdges.visible = this.surface.visible && fe.length > 0;
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
    setLines(this.marks, seg(this.picks));
    setPositions(this.markDots, pts(this.picks));
    const h = this.hovered ? [this.hovered] : [];
    setLines(this.hoverMarks, seg(h));
    setPositions(this.hoverDots, pts(h));
    // Picked faces filled (two triangles each).
    const fill = this.picks.flatMap((p) => {
      if (p.kind !== "face") return [];
      const [a, b, c, d] = this.cage.faces[p.f].map((i) => this.cage.verts[i]);
      return [...a, ...b, ...c, ...a, ...c, ...d];
    });
    const fg = this.markFill.geometry;
    fg.setAttribute("position", new BufferAttribute(new Float32Array(fill), 3));
    fg.computeBoundingSphere();
    this.app.view.requestRender();
  }

  // ------------------------------------------------------------- finishing

  /** Right-click: let go of the picked points/edges/faces; then finish (keeping the shape). */
  context(): void {
    if (this.dragging) return;
    if (this.picks.length) return ((this.picks = []), this.selectionChanged());
    if (this.choosingPlane) return this.cancel();
    this.done();
  }

  key(e: KeyboardEvent): boolean {
    if (e.key === "Escape") {
      if (this.picks.length) ((this.picks = []), this.selectionChanged());
      else this.cancel();
      return true;
    }
    // Still choosing where it goes: nothing to finish yet.
    if (e.key === "Enter" && this.choosingPlane) return true;
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
    if (selfCrossings(this.cage, 2, 1).length) {
      this.app.ui.toast("The shape passes through itself (shown red) - pull the point back first", "error");
      return null;
    }
    // Stored where it was made: later move steps in History still apply on top.
    const cage = { faces: structuredClone(this.cage.faces), verts: this.cage.verts.map(this.place.inv) };
    const open = !isClosed(cage);
    const symmetry = this.sym ? (() => {
      const o = this.place.inv(this.sym!.origin);
      return { origin: o, normal: norm(sub(this.place.inv(add(this.sym!.origin, this.sym!.normal)), o)) };
    })() : undefined;
    const extra = { surface: this.surfaceSheet || undefined, thickness: open && this.thickness > 0 ? this.thickness : undefined, thickSide: open && this.thickness > 0 ? this.thickSide : undefined, symmetry };
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

/** Thick lines (segment pairs). */
function setLines(o: LineSegments2, xyz: number[]): void {
  const g = o.geometry as LineSegmentsGeometry;
  // (No segments: an empty instanced line draws nothing.)
  g.setPositions(xyz.length ? xyz : [0, 0, 0, 0, 0, 0]);
  o.visible = xyz.length > 0;
}

function setPositions(o: LineSegments | Points, xyz: number[]): void {
  const g = o.geometry;
  g.setAttribute("position", new BufferAttribute(new Float32Array(xyz), 3));
  g.computeBoundingSphere();
  g.computeBoundingBox();
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

/** The smooth surface's face outlines (each cage face's grid border), as line segment indices, shared edges once. */
function faceBorders(plan: SubdivPlan): Uint32Array {
  const seen = new Set<string>();
  const out: number[] = [];
  const seg = (a: number, b: number) => {
    const k = a < b ? `${a},${b}` : `${b},${a}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(a, b);
  };
  const n = plan.n;
  for (const g of plan.grids)
    for (let k = 0; k < n; k++) {
      seg(g[k][0], g[k + 1][0]);
      seg(g[k][n], g[k + 1][n]);
      seg(g[0][k], g[0][k + 1]);
      seg(g[n][k], g[n][k + 1]);
    }
  return Uint32Array.from(out);
}
