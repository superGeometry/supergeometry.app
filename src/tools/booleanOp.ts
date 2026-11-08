// Subtract / Intersect as a tool: the body to change (+) and the bodies to
// change it with (−), picked in turn; keep either side if wanted.

import type { BooleanFeature, Vec3 } from "../doc/types";
import type { PanelItem } from "../ui/ui";
import { FeatureOp, type Slot } from "./featureOp";
import { bodyCenter } from "./ops";
import type { AppContext } from "./tool";

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

export class BooleanOp extends FeatureOp<BooleanFeature> {
  readonly id = "boolean";
  private marks: HTMLDivElement[] = [];
  private centers = new Map<string, Vec3>();
  private hook = () => this.placeMarks();

  constructor(app: AppContext, op: "subtract" | "intersect", target = "", tools: string[] = [], existing?: BooleanFeature) {
    super(app, { ...app.store.newIdentity("boolean", cap(op)), type: "boolean", op, target, tools: tools.filter((t) => t !== target) }, existing);
    const sub = this.feature.op === "subtract";
    const bodyOf = (hit: { kind: string; body?: string }) => (hit.kind === "body" || hit.kind === "face" || hit.kind === "edge" || hit.kind === "vertex" ? hit.body ?? null : null);
    const targetSlot: Slot = {
      label: sub ? "Remove from" : "Body",
      describe: () => (this.feature.target ? this.nameOf(this.feature.target) : "Tap a body"),
      filled: () => !!this.feature.target,
      pick: { profiles: false, planes: false, axes: false },
      shows: () => (this.feature.target ? [{ kind: "body", body: this.feature.target }] : []),
      accept: (hit) => {
        const b = bodyOf(hit);
        if (!b) return false;
        this.feature.target = b;
        this.feature.tools = this.feature.tools.filter((t) => t !== b);
        return true;
      },
    };
    const toolsSlot: Slot = {
      label: sub ? "Subtract" : "With",
      multi: true,
      describe: () => (this.feature.tools.length ? `${this.feature.tools.length} bod${this.feature.tools.length > 1 ? "ies" : "y"}` : "Tap bodies"),
      filled: () => this.feature.tools.length > 0,
      pick: { profiles: false, planes: false, axes: false },
      shows: () => this.feature.tools.map((body) => ({ kind: "body" as const, body })),
      accept: (hit) => {
        const b = bodyOf(hit);
        if (!b || b === this.feature.target) return false;
        const t = this.feature.tools;
        this.feature.tools = t.includes(b) ? t.filter((x) => x !== b) : [...t, b];
        return true;
      },
    };
    this.slots = [targetSlot, toolsSlot];
  }

  private nameOf(id: string): string {
    return this.app.store.doc.names?.[id] ?? this.app.view.bodyList.find((b) => b.id === id)?.name ?? "Body";
  }

  protected hint(): string {
    return this.feature.op === "subtract"
      ? "Tap the body to cut, then the bodies to cut away from it."
      : "Tap a body, then the bodies it overlaps. Only the part they share is kept.";
  }

  protected items(): PanelItem[] {
    const f = this.feature;
    const sub = f.op === "subtract";
    return [
      { type: "toggle", label: "Keep modified body", value: !!f.keepTarget, onChange: (v) => ((f.keepTarget = v || undefined), this.render(), this.update()) },
      { type: "toggle", label: sub ? "Keep subtracted bodies" : "Keep intersecting bodies", value: !!f.keepTools, onChange: (v) => ((f.keepTools = v || undefined), this.render(), this.update()) },
    ];
  }

  enter(): void {
    super.enter();
    this.app.view.frameHooks.add(this.hook);
    this.placeMarks();
  }

  exit(): void {
    this.app.view.frameHooks.delete(this.hook);
    for (const m of this.marks) m.remove();
    this.marks = [];
    super.exit();
  }

  protected onDraftChanged(): void {
    this.placeMarks();
  }

  /** "+" on the body that's changed, "−" on each body it's changed with. */
  private placeMarks(): void {
    const want: [string, string][] = [];
    if (this.feature.target) want.push([this.feature.target, "+"]);
    for (const t of this.feature.tools) want.push([t, "−"]);
    while (this.marks.length > want.length) this.marks.pop()!.remove();
    while (this.marks.length < want.length) {
      const m = document.createElement("div");
      m.className = "bool-mark";
      document.body.append(m);
      this.marks.push(m);
    }
    const r = this.app.view.canvas.getBoundingClientRect();
    want.forEach(([body, sign], i) => {
      const m = this.marks[i];
      m.title = sign === "+" ? "Changed" : "Changed with";
      m.classList.toggle("minus", sign !== "+");
      // (Where the body was: in the preview a subtracted body is used up.)
      if (this.app.view.bodyList.some((b) => b.id === body)) this.centers.set(body, bodyCenter(this.app, [body]));
      const at = this.centers.get(body);
      const c = at ? this.app.view.toScreen(at) : null;
      m.hidden = !c;
      if (c) m.style.transform = `translate(${Math.round(r.left + c[0] - 14)}px, ${Math.round(r.top + c[1] - 14)}px)`;
    });
  }
}
