import { getPath, setPath } from "../doc/params";
import { BETA_TYPES } from "../doc/store";
import type { ExtrudeSource, Feature, SketchFeature, Vec2 } from "../doc/types";
import type { FieldKind, PanelItem, ToolItem } from "../ui/ui";
import { isExpression } from "../ui/ui";
import type { ToolPointer } from "../view/input";
import type { PickHit, PickOptions } from "../view/viewport";
import { hitToSel, sourcesOf, viewMenu, type AppContext, type Sel, type Tool } from "./tool";
import { DragTyping } from "./dragTyping";
import { screenClass } from "../device";
import { smallerSize } from "../geom";
import { arrangement, materialRegions, pointInRegion, resolveRegion, type Region } from "../sketch/regions";
import { pointInPoly } from "../sketch/curves";

/** Something the user has to point at (an axis, a path, faces to remove, …). */
export interface Slot {
  label: string;
  /** What the slot shows: "X axis", "2 faces", "Select…". */
  describe(): string;
  filled(): boolean;
  pick: PickOptions;
  /** Store the hit into the draft; return false if it doesn't fit this slot. */
  accept(hit: PickHit): boolean;
  multi?: boolean;
  /** Quick choices shown next to the slot (e.g. X / Y / Z). */
  presets?: { label: string; apply(): void }[];
  /** Highlights of what the slot currently holds. */
  shows?(): Sel[];
  /** Show the XY/XZ/YZ planes while this slot is waiting for a pick. */
  originPlanes?: boolean;
  /** Said when a tap hits something this slot can't take. */
  rejectHint?: string;
}

/**
 * Base for tools that create or edit one feature: pick slots + numbers +
 * live preview + Done/Cancel. Subclasses describe the draft; this does the rest.
 */
export abstract class FeatureOp<F extends Feature> implements Tool {
  abstract readonly id: string;
  feature: F;
  protected slots: Slot[] = [];
  protected active = -1;
  protected error: string | null = null;

  constructor(
    protected app: AppContext,
    draft: F,
    protected existing?: F,
  ) {
    this.feature = existing ? structuredClone(existing) : draft;
    this.startSelection = [...app.selection];
  }

  /** What was selected when the tool started (Esc / Cancel goes back to it). */
  private startSelection: Sel[];

  /** Esc / Cancel: one step back - the tool goes, what was selected before is selected again. */
  protected cancel(): void {
    const back = this.startSelection;
    this.app.setTool(null);
    if (back.length) this.app.setSelection(back);
  }

  get editingId(): string {
    return this.feature.id;
  }

  /** One-line instruction for the hint bar. */
  protected abstract hint(): string;
  /** Numbers / choices / toggles in the panel. */
  protected abstract items(): PanelItem[];
  /** Is the draft complete enough to preview and commit? */
  protected ready(): boolean {
    return this.slots.every((s) => s.filled());
  }
  /** Extra panel buttons. */
  protected actions(): ToolItem[] {
    return [];
  }

  enter(): void {
    // Cancel is in the card (on a phone the card is one row without it: there it's in the column).
    this.app.ui.setTools(screenClass() === "phone" ? [{ id: "cancel", label: "Cancel", icon: "close", shortcut: "Esc", run: () => this.cancel() }] : []);
    this.app.ui.setBottom([]);
    this.active = this.slots.findIndex((s) => !s.filled());
    // A step opened again with everything picked: taps add to (or take from) its
    // list of picks, as they did when it was made. (They did nothing: the four
    // bolts left out of a Subtract couldn't be added without tapping its slot first.)
    if (this.active < 0) this.active = this.slots.reduce((last, s, i) => (s.multi ? i : last), -1);
    this.render();
    this.update();
    this.app.ui.focusPanel();
    this.steps = [JSON.stringify(this.feature)];
    this.redos = [];
    window.addEventListener("pointerdown", this.onDown, true);
    window.addEventListener("pointerup", this.onUp, true);
    window.addEventListener("pointercancel", this.onUp, true);
  }

  // ---- Undo inside the tool
  // Each change made while the tool is open - a drag of its handle, a value typed, an option chosen, something more
  // picked - is a step of its own that Undo takes back, one at a time, and Redo puts back. Undo used to close the tool,
  // throwing all of it away, and then take back the step before it as well. With nothing left to take back in the
  // tool, Undo closes it (nothing made); the next Undo is the project's.
  private steps: string[] = [];
  private redos: string[] = [];
  private held = false;
  private settle = 0;
  private restoring = false;
  private onDown = (): void => void (this.held = true);
  private onUp = (): void => {
    this.held = false;
    // (After the tool's own handlers for this lift have run.)
    window.setTimeout(() => this.record(), 0);
  };

  /** What the draft is now, as a step - if it differs from the last one. */
  private record(): void {
    if (this.restoring || !this.steps.length) return;
    const now = JSON.stringify(this.feature);
    if (now === this.steps[this.steps.length - 1]) return;
    this.steps.push(now);
    if (this.steps.length > 100) this.steps.shift();
    this.redos = [];
    (this.app as AppContext & { refreshUndo?(): void }).refreshUndo?.();
  }

  /** The draft changed: a step once the drag ends, or once typing stops for a moment (digit by digit is one step). */
  private noteChange(): void {
    if (this.restoring || this.held) return;
    clearTimeout(this.settle);
    this.settle = window.setTimeout(() => this.record(), 450);
  }

  /** The draft put back to a step (in place: the window's parts and the handles hold on to it). */
  private restore(step: string): void {
    this.restoring = true;
    try {
      const f = this.feature as unknown as Record<string, unknown>;
      for (const k of Object.keys(f)) delete f[k];
      Object.assign(f, JSON.parse(step));
      this.restored();
      this.render();
      this.update();
    } finally {
      this.restoring = false;
    }
  }

  /** After Undo / Redo put the draft back: for a tool that keeps something beside the draft in step with it. */
  protected restored(): void {}

  get canUndo(): boolean {
    return true;
  }
  get canRedo(): boolean {
    return this.redos.length > 0;
  }
  undo(): boolean {
    clearTimeout(this.settle);
    this.record();
    if (this.steps.length < 2) {
      this.cancel();
      return true;
    }
    this.redos.push(this.steps.pop()!);
    this.restore(this.steps[this.steps.length - 1]);
    return true;
  }
  redo(): boolean {
    const next = this.redos.pop();
    if (!next) return false;
    this.steps.push(next);
    this.restore(next);
    return true;
  }

  exit(): void {
    clearTimeout(this.settle);
    window.removeEventListener("pointerdown", this.onDown, true);
    window.removeEventListener("pointerup", this.onUp, true);
    window.removeEventListener("pointercancel", this.onUp, true);
    this.app.view.setOriginPlanesVisible(false);
    this.app.ui.showPanel(null);
    this.app.ui.setHint(null);
    this.app.ui.setLabel(0, 0, null);
    DragTyping.hideAll();
    this.app.setHover(null);
    this.app.setSelection([]);
  }

  hover(p: ToolPointer | null): void {
    const slot = this.slots[this.active];
    if (!p || !slot) return this.app.setHover(null);
    const hit = this.app.view.pick(p.x, p.y, { edgeTolPx: p.tol, ...slot.pick });
    this.lastHover = { x: p.x, y: p.y, hit };
    this.app.setHover(hitToSel(hit));
  }

  /** What hover highlighted: a tap at the same spot takes exactly that. */
  private lastHover: { x: number; y: number; hit: PickHit | null } | null = null;

  /** Tools turning / sweeping a sketch profile: tapping another shape of it adds it (or takes it out). */
  protected moreRegions = false;

  /**
   * Another region of the profile's sketch tapped (on a phone a tapped region
   * opens the tool straight away): it joins the profile - tapped again, it
   * leaves. So several regions go together. True when the tap was used.
   */
  protected regionTap(p: ToolPointer): boolean {
    const f = this.feature as unknown as { source?: ExtrudeSource };
    const src = f.source;
    if (src?.kind !== "profile" || this.existing) return false;
    const hit = this.app.view.pick(p.x, p.y, { edgeTolPx: p.tol, profiles: true, planes: false, axes: false, vertices: false });
    if (hit?.kind !== "profile" || hit.sketch !== src.sketch) return false;
    const arr = arrangement(this.app.sketchCurves(src.sketch));
    const have = src.regions.map((ref) => resolveRegion(arr, ref)).map((r) => (r ? arr.regions.indexOf(r) : -1)).filter((k) => k >= 0);
    const sel = have.map((region) => ({ kind: "profile" as const, sketch: src.sketch, region }));
    const i = sel.findIndex((s) => s.region === hit.region);
    const next = i >= 0 ? sel.filter((_, j) => j !== i) : [...sel, { kind: "profile" as const, sketch: hit.sketch, region: hit.region }];
    if (!next.length) {
      this.app.setTool(null);
      return true;
    }
    const made = sourcesOf(this.app, next)[0];
    if (!made) return false;
    f.source = made;
    this.partKey = "";
    this.regionsChanged();
    this.app.ui.toast(`${next.length} region${next.length > 1 ? "s" : ""} selected`);
    this.render();
    this.app.setSelection([...next, ...this.slots.flatMap((s) => s.shows?.() ?? [])]);
    this.update();
    return true;
  }

  /** Can a tap on another shape of the profile's sketch add it now? */
  protected addsRegions(): boolean {
    return this.moreRegions;
  }

  private partKey = "";
  private partIs = false;

  /**
   * Is what's picked only a part of a shape as it was drawn - cut off from the rest by a curve that runs on
   * through it (a shape drawn across a rectangle is three shapes: over it, in it, under it)? A tap takes the one
   * under the finger, and nothing said so: someone turned the third of their shape that lay under a plate, and
   * took the result for the joins and cuts being broken ("Cut didn't work at all. With Add at least you can see
   * something"). Said in the tool's line while the other parts can still be added by a tap.
   * (Not a hole's rim: a circle inside a plate ends where it began, and is all on the plate's own outline.)
   */
  private partOfAShape(): boolean {
    const src = (this.feature as unknown as { source?: ExtrudeSource }).source;
    if (src?.kind !== "profile" || this.existing || !this.addsRegions()) return false;
    const key = `${src.sketch}|${JSON.stringify(src.regions)}`;
    if (key === this.partKey) return this.partIs;
    this.partKey = key;
    this.partIs = false;
    const arr = arrangement(this.app.sketchCurves(src.sketch));
    const picked = new Set(src.regions.map((ref) => resolveRegion(arr, ref)).filter((r): r is Region => !!r));
    const edgeOf = (r: Region) => [r.outer, ...r.holes].flatMap((l) => l.pieces.map((x) => x.piece));
    const mine = new Set([...picked].flatMap(edgeOf));
    // The stretches it shares with a shape that is not picked...
    const shared = new Set<number>();
    for (const r of arr.regions) if (!picked.has(r)) for (const k of edgeOf(r)) if (mine.has(k)) shared.add(k);
    // ...where the curve of one of them runs on past its end, off the picked shape's outline.
    for (const k of shared) {
      const pc = arr.pieces[k];
      for (const node of [pc.n0, pc.n1])
        if (arr.pieces.some((o, j) => j !== k && o.prim === pc.prim && (o.n0 === node || o.n1 === node) && !mine.has(j))) {
          this.partIs = true;
          return true;
        }
    }
    return false;
  }

  /** A tap on a body the step waiting can't use (a mirror's plane, a ball tapped): true if the tool took it some other way. */
  protected otherBody(_body: string): boolean {
    return false;
  }

  /** After regionTap changed the profile (e.g. Extrude moves its arrow). */
  protected regionsChanged(): void {}

  tap(p: ToolPointer): void {
    const slot = this.slots[this.active];
    const h = this.lastHover;
    let hit = h?.hit && Math.hypot(h.x - p.x, h.y - p.y) < 6 ? h.hit : this.app.view.pick(p.x, p.y, { edgeTolPx: p.tol, ...(slot?.pick ?? {}) });
    // Not what this step is making (its preview): what's under it. (A Fill's
    // last boundary curve, tapped once the loop closed, took the edge of the
    // surface just made on it instead.)
    const mine = (b: string) => b === this.feature.id || b.startsWith(`${this.feature.id}:`);
    if (hit && "body" in hit && hit.body && mine(hit.body)) hit = this.app.view.pick(p.x, p.y, { edgeTolPx: p.tol, ...(slot?.pick ?? {}), bodies: false });
    if (this.moreRegions && (!slot || !hit || hit.kind === "plane" || hit.kind === "profile") && this.regionTap(p)) return;
    // Tapping empty space ends the tool: keep the result if it's complete.
    if (!hit) {
      if (this.ready()) this.done();
      else this.app.setTool(null);
      return;
    }
    if (!slot) return;
    // Not this one - but another body's face in the same place is (the bolts
    // flush with the flange they're to cut: the flange came first every time).
    const body = "body" in hit ? hit.body : null;
    if (!slot.accept(hit) && !(body && this.app.view.facesAt(p.x, p.y).some((f) => f.kind === "face" && f.body !== body && slot.accept(f)))) {
      if (this.moreRegions && this.regionTap(p)) return;
      if (body && !mine(body) && this.otherBody(body)) return;
      if (slot.rejectHint) this.app.ui.toast(slot.rejectHint);
      return;
    }
    if (!slot.multi) this.active = this.slots.findIndex((s, i) => i > this.active && !s.filled());
    this.render();
    if (this.finishWhenPicked && this.ready()) return void this.finishIfOk();
    this.update();
  }

  /**
   * A body tapped in Items: the slot waiting takes it, as a tap on it in the
   * view would. (Six pegs inside a pulley's web, to subtract, can't be tapped
   * there - and the tap in Items put Subtract away and selected the body.)
   */
  pickBody(id: string): boolean {
    const slot = this.slots[this.active];
    if (!slot || !slot.accept({ kind: "body", body: id, point: [0, 0, 0] } as unknown as PickHit)) return false;
    if (!slot.multi) this.active = this.slots.findIndex((s, i) => i > this.active && !s.filled());
    this.render();
    if (this.finishWhenPicked && this.ready()) {
      void this.finishIfOk();
      return true;
    }
    this.update();
    return true;
  }

  /** Nothing left to set once the picks are made (e.g. Replace Face): the last pick finishes. */
  protected finishWhenPicked = false;

  private async finishIfOk(): Promise<void> {
    this.onDraftChanged();
    const r = await this.app.preview(this.featuresWith());
    const err = r?.errors.find((e) => e.featureId === this.feature.id)?.message;
    if (err) {
      this.error = err;
      this.setHint();
      this.app.ui.toast(err);
      return;
    }
    this.done();
  }

  /**
   * Right-click: Done and Cancel (and the view's switches) by the pointer -
   * a stray right-click no longer throws the tool's work away.
   */
  context(p: ToolPointer): void {
    viewMenu(this.app, p.x, p.y, [
      { label: "Done", shortcut: "Enter", disabled: !this.ready() || !!this.error, run: () => this.done() },
      { label: "Cancel", shortcut: "Esc", run: () => this.cancel() },
    ]);
  }

  key(e: KeyboardEvent): boolean {
    if (e.key === "Enter") this.done();
    else if (e.key === "Escape") this.cancel();
    else return false;
    return true;
  }

  /** Rebuild the panel (after slots/choices change). */
  protected render(): void {
    const slotItems: PanelItem[] = this.slots.flatMap((s, i): PanelItem[] => [
      { type: "slot", label: s.label, value: s.describe(), active: i === this.active, filled: s.filled(), onClick: () => ((this.active = i), this.render()) },
      ...(s.presets?.length && i === this.active
        ? [{ type: "choice" as const, options: s.presets.map((p, k) => ({ id: String(k), label: p.label })), value: "", onChange: (k: string) => (s.presets![Number(k)].apply(), this.advance(), this.render(), this.update()) }]
        : []),
    ]);
    this.app.ui.showPanel({
      title: this.feature.name,
      beta: BETA_TYPES.has(this.feature.type),
      items: [...slotItems, ...this.items()],
      actions: this.actions(),
      onDone: () => this.done(),
      onCancel: () => this.cancel(),
    });
    this.showSlotHighlights();
    this.setHint();
    this.app.view.setOriginPlanesVisible(!!this.slots[this.active]?.originPlanes);
  }

  private advance(): void {
    const s = this.slots[this.active];
    if (s && !s.multi) this.active = this.slots.findIndex((x, i) => i > this.active && !x.filled());
  }

  private showSlotHighlights(): void {
    this.app.setSelection(this.slots.flatMap((s) => s.shows?.() ?? []));
  }

  protected setHint(): void {
    const slot = this.slots[this.active];
    let text = this.error ? `⚠ ${this.error}` : slot && !slot.filled() ? `${slot.label}: ${slot.describe()}` : this.hint();
    if (!this.error && this.partOfAShape()) text += `${/[.!?]$/.test(text) ? "" : "."} Only this part of the shape is picked: tap the others to add them.`;
    this.app.ui.setHint(text);
    this.app.ui.setPanelWarning(this.error);
  }

  /**
   * What the last preview asked for was: a drag snaps its value to steps and
   * asks again on every pointer move - the same draft on the same project is
   * on screen already (or on its way), not rebuilt and shown again.
   */
  private asked: { key: string; base: readonly Feature[]; pending: boolean; result: unknown } | null = null;

  /**
   * A size the tool chose by itself for a new step (where it is in the step, and what it is now). While it is still
   * that, a step that cannot be built with it is tried again with the next round size down, a few times: a start
   * size taken from a long edge may not fit the thin wall beside it.
   */
  protected startValue: { path: string; value: number; left: number } | null = null;

  /** Re-run the preview with the current draft. */
  protected update(): void {
    this.onDraftChanged();
    this.noteChange();
    const ready = this.ready();
    const base = this.app.store.features;
    // (The steps that aren't the project's own: the draft, or what a tool puts in its place.)
    const list = ready ? this.featuresWith() : null;
    const own = new Set(base);
    const key = list ? JSON.stringify(list.filter((f) => !own.has(f))) : "";
    const was = this.asked;
    if (was && was.key === key && was.base === base && (was.pending || was.result === this.app.result)) return;
    const mine = { key, base, pending: true, result: null as unknown };
    this.asked = mine;
    const shown = (r: unknown) => {
      mine.pending = false;
      mine.result = r;
      // Overtaken by something else's rebuild: asked again next time.
      if (!r && this.asked === mine) this.asked = null;
    };
    if (!ready) {
      void this.app.preview([...base]).then(shown);
      return;
    }
    this.app.preview(list!).then((r) => {
      shown(r);
      this.error = r?.errors.find((e) => e.featureId === this.feature.id)?.message ?? null;
      const s = this.startValue;
      if (this.error && s && !this.existing && s.left > 0 && this.asked === mine && Math.abs(Number(getPath(this.feature as Feature, s.path))) === s.value) {
        const sign = Number(getPath(this.feature as Feature, s.path)) < 0 ? -1 : 1;
        s.left--;
        s.value = smallerSize(s.value);
        setPath(this.feature as Feature, s.path, sign * s.value);
        this.error = null;
        this.render();
        this.update();
        return;
      }
      this.setHint();
      // What the step notes about itself (it cut where Add may have been
      // meant, a piece left off): said while it's being made, not only on
      // its History row, out of sight on a phone. Once per new note.
      const note = r ? (r.notes?.find((n) => n.featureId === this.feature.id)?.message ?? null) : this.noted;
      if (note && note !== this.noted && !this.error) this.app.ui.toast(note);
      this.noted = note;
    });
  }

  /** The note the last preview had for this step (said once). */
  private noted: string | null = null;

  /** Hook for handles etc. */
  protected onDraftChanged(): void {}

  /**
   * A number field bound to a path in the feature (e.g. "distance",
   * "op.translate.2") that can also hold a variable expression.
   */
  protected num(label: string, path: string, kind: FieldKind, opts: { min?: number; onInput?: (v: number) => void; inBox?: boolean } = {}): PanelItem {
    const f = this.feature as Feature;
    return {
      type: "number",
      label,
      value: Number(getPath(f, path) ?? 0),
      kind,
      min: opts.min,
      expr: f.exprs?.[path],
      inBox: opts.inBox,
      onExpr: (expr) => this.setExpr(path, expr),
      onInput: (v) => {
        setPath(f, path, v);
        if (opts.onInput) opts.onInput(v);
        else this.update();
      },
    };
  }

  /**
   * Text typed into a value box at the model: a formula with variables keeps
   * the value linked to them (as the panel's field does); a plain number unlinks it.
   */
  /** The value at `path` follows this formula (null: just a number). */
  protected setExpr(path: string, expr: string | null): void {
    const f = this.feature as Feature;
    const exprs = { ...(f.exprs ?? {}) };
    if (expr) exprs[path] = expr;
    else delete exprs[path];
    f.exprs = Object.keys(exprs).length ? exprs : undefined;
  }

  protected typedInto(path: string, text: string, wrap: (t: string) => string = (t) => t): void {
    const f = this.feature as Feature;
    const exprs = { ...(f.exprs ?? {}) };
    if (isExpression(text)) exprs[path] = wrap(text.trim());
    else delete exprs[path];
    f.exprs = Object.keys(exprs).length ? exprs : undefined;
  }

  protected featuresWith(): Feature[] {
    const list = [...this.app.store.features];
    if (!this.existing) return [...list, this.feature];
    list[list.findIndex((f) => f.id === this.feature.id)] = this.feature;
    return list;
  }

  protected done(): void {
    if (!this.ready()) {
      const missing = this.slots.find((s) => !s.filled());
      // Nothing left to pick means nothing changed: just close the tool.
      if (!missing) return this.app.setTool(null);
      this.app.ui.toast("Finish picking first: " + missing.label);
      return;
    }
    if (this.existing) this.app.store.update(this.feature.id, this.feature);
    else {
      // A new solid from sketches: the sketches step out of the way (the eye in Items brings them back).
      const f = this.feature as Feature;
      // An extrude: its sketch is hidden straight away (tap the eye to bring it
      // back for the next shape). Other steps: once all its regions are used -
      // one drawn with several parts stays in view until the last is made.
      const used = sketchesUsed(f).filter((id) => f.type === "extrude" || allRegionsUsed(this.app, id, [...this.app.store.doc.features, f]));
      this.app.store.commit((d) => {
        d.features.push(f);
        if (used.length) d.hidden = [...new Set([...d.hidden, ...used])];
      });
    }
    this.app.setTool(null);
  }
}

/** Has every region of a sketch been made into something (by these steps)? */
function allRegionsUsed(app: AppContext, sketch: string, features: Feature[]): boolean {
  try {
    const arr = arrangement(app.sketchCurves(sketch));
    // Only what was drawn counts (not the outline of the face it's on: window
    // sketches on a wall stayed in view after every window was cut).
    const drawn = materialRegions(arrangement(app.store.find<SketchFeature>(sketch)?.entities ?? []));
    if (drawn.length <= 1 && arr.regions.length <= 1) return true;
    const used: Region[] = [];
    const add = (s: ExtrudeSource) => {
      if (s.kind !== "profile" || s.sketch !== sketch) return;
      for (const ref of s.regions) {
        const r = resolveRegion(arr, ref);
        if (r) used.push(r);
      }
    };
    // A full turn's axis in the sketch: what's drawn across it (a whole circle
    // for a ball, its lower half never picked) is in the solid too.
    const mirrors: ((q: Vec2) => Vec2)[] = [];
    const pl = app.sketchPlane(sketch);
    for (const g of features) {
      if (g.type === "extrude" || g.type === "revolve" || g.type === "sweep") add(g.source);
      else if (g.type === "loft") g.sections.forEach(add);
      if (g.type === "revolve" && pl && Math.abs(g.angle) >= 360 - 1e-9 && g.source.kind === "profile" && g.source.sketch === sketch) {
        const n = pl.normal;
        const y: [number, number, number] = [n[1] * pl.xDir[2] - n[2] * pl.xDir[1], n[2] * pl.xDir[0] - n[0] * pl.xDir[2], n[0] * pl.xDir[1] - n[1] * pl.xDir[0]];
        const d3 = g.axis.dir;
        const dl = Math.hypot(d3[0], d3[1], d3[2]) || 1;
        const off = (d3[0] * n[0] + d3[1] * n[1] + d3[2] * n[2]) / dl;
        const rel = [g.axis.origin[0] - pl.origin[0], g.axis.origin[1] - pl.origin[1], g.axis.origin[2] - pl.origin[2]];
        if (Math.abs(off) > 1e-9 || Math.abs(rel[0] * n[0] + rel[1] * n[1] + rel[2] * n[2]) > 1e-6) continue;
        const dot2 = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        const o: Vec2 = [dot2(rel, pl.xDir), dot2(rel, y)];
        const du = dot2(d3, pl.xDir) / dl;
        const dv = dot2(d3, y) / dl;
        mirrors.push((q) => {
          const t = (q[0] - o[0]) * du + (q[1] - o[1]) * dv;
          const f: Vec2 = [o[0] + t * du, o[1] + t * dv];
          return [2 * f[0] - q[0], 2 * f[1] - q[1]];
        });
      }
    }
    // Every shape drawn has been made into something. (Matched shape by shape,
    // not piece by piece: where the drawing meets an edge in its plane - the
    // corner of a rounded button and the same corner of the body made from
    // it, sampled a little differently - slivers are left that no one would
    // use; the sketch stayed in view and its face-wide region took every later
    // tap on that face.)
    const inside = (m: Region, q: Vec2) => pointInPoly(q, m.outer.poly) && !m.holes.some((h) => pointInPoly(q, h.poly));
    const covered = (m: Region) => used.some((r) => inside(m, pointInRegion(r)));
    const turnedIn = (m: Region) => mirrors.some((mir) => used.some((r) => inside(r, mir(pointInRegion(m)))));
    return drawn.every((m) => covered(m) || turnedIn(m));
  } catch {
    return true;
  }
}

/** The sketches an extrude / revolve / sweep / loft was made from. */
export function sketchesUsed(f: Feature): string[] {
  const of = (s: ExtrudeSource) => (s.kind === "profile" ? [s.sketch] : []);
  switch (f.type) {
    case "extrude":
    case "revolve":
      return of(f.source);
    case "sweep":
      return [...of(f.source), ...(f.path.kind === "sketch" ? [f.path.sketch] : [])];
    case "loft":
      return f.sections.flatMap(of);
    case "fill":
      return [...f.boundary, ...(f.guides ?? [])].flatMap((p) => (p.kind === "sketch" ? [p.sketch] : []));
    case "rib":
      return f.path.kind === "sketch" && f.path.sketch ? [f.path.sketch] : [];
    default:
      return [];
  }
}
