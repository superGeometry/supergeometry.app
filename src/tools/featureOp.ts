import { getPath, setPath } from "../doc/params";
import type { ExtrudeSource, Feature, SketchFeature, Vec2 } from "../doc/types";
import type { FieldKind, PanelItem, ToolItem } from "../ui/ui";
import { isExpression } from "../ui/ui";
import type { ToolPointer } from "../view/input";
import type { PickHit, PickOptions } from "../view/viewport";
import { hitToSel, sourcesOf, type AppContext, type Sel, type Tool } from "./tool";
import { DragTyping } from "./dragTyping";
import { screenClass } from "../device";
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
    this.render();
    this.update();
    this.app.ui.focusPanel();
  }

  exit(): void {
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
    this.regionsChanged();
    this.app.ui.toast(`${next.length} region${next.length > 1 ? "s" : ""} selected`);
    this.render();
    this.app.setSelection([...next, ...this.slots.flatMap((s) => s.shows?.() ?? [])]);
    this.update();
    return true;
  }

  /** After regionTap changed the profile (e.g. Extrude moves its arrow). */
  protected regionsChanged(): void {}

  tap(p: ToolPointer): void {
    const slot = this.slots[this.active];
    const h = this.lastHover;
    const hit = h?.hit && Math.hypot(h.x - p.x, h.y - p.y) < 6 ? h.hit : this.app.view.pick(p.x, p.y, { edgeTolPx: p.tol, ...(slot?.pick ?? {}) });
    if (this.moreRegions && (!slot || !hit || hit.kind === "plane" || hit.kind === "profile") && this.regionTap(p)) return;
    // Tapping empty space ends the tool: keep the result if it's complete.
    if (!hit) {
      if (this.ready()) this.done();
      else this.app.setTool(null);
      return;
    }
    if (!slot) return;
    if (!slot.accept(hit)) {
      if (this.moreRegions && this.regionTap(p)) return;
      if (slot.rejectHint) this.app.ui.toast(slot.rejectHint);
      return;
    }
    if (!slot.multi) this.active = this.slots.findIndex((s, i) => i > this.active && !s.filled());
    this.render();
    if (this.finishWhenPicked && this.ready()) return void this.finishIfOk();
    this.update();
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

  /** Right-click: back out of the tool (like Esc). */
  context(): void {
    this.cancel();
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

  private setHint(): void {
    const slot = this.slots[this.active];
    const text = this.error ? `⚠ ${this.error}` : slot && !slot.filled() ? `${slot.label}: ${slot.describe()}` : this.hint();
    this.app.ui.setHint(text);
  }

  /** Re-run the preview with the current draft. */
  protected update(): void {
    this.onDraftChanged();
    if (!this.ready()) {
      this.app.preview([...this.app.store.features]);
      return;
    }
    this.app.preview(this.featuresWith()).then((r) => {
      this.error = r?.errors.find((e) => e.featureId === this.feature.id)?.message ?? null;
      this.setHint();
    });
  }

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
      onExpr: (expr) => {
        const exprs = { ...(f.exprs ?? {}) };
        if (expr) exprs[path] = expr;
        else delete exprs[path];
        f.exprs = Object.keys(exprs).length ? exprs : undefined;
      },
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
      // …once all their regions are used: one drawn with several parts (a
      // side, a plinth and a door) stays in view until the last is made.
      const used = sketchesUsed(f).filter((id) => allRegionsUsed(this.app, id, [...this.app.store.doc.features, f]));
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
    for (const g of features) {
      if (g.type === "extrude" || g.type === "revolve" || g.type === "sweep") add(g.source);
      else if (g.type === "loft") g.sections.forEach(add);
    }
    // Every shape drawn has been made into something. (Matched shape by shape,
    // not piece by piece: where the drawing meets an edge in its plane - the
    // corner of a rounded button and the same corner of the body made from
    // it, sampled a little differently - slivers are left that no one would
    // use; the sketch stayed in view and its face-wide region took every later
    // tap on that face.)
    const inside = (m: Region, q: Vec2) => pointInPoly(q, m.outer.poly) && !m.holes.some((h) => pointInPoly(q, h.poly));
    return drawn.every((m) => used.some((r) => inside(m, pointInRegion(r))));
  } catch {
    return true;
  }
}

/** The sketches an extrude / revolve / sweep / loft was made from. */
function sketchesUsed(f: Feature): string[] {
  const of = (s: ExtrudeSource) => (s.kind === "profile" ? [s.sketch] : []);
  switch (f.type) {
    case "extrude":
    case "revolve":
      return of(f.source);
    case "sweep":
      return [...of(f.source), ...(f.path.kind === "sketch" ? [f.path.sketch] : [])];
    case "loft":
      return f.sections.flatMap(of);
    default:
      return [];
  }
}
