// Hole: a screw's hole in a flat face, by the screw's size.
//
// A hole for an M3 screw was a sketch, a circle, knowing that 3.4 is
// the size that lets it through, a cut - and a second circle for the head. Here: tap the face where the screw goes,
// choose the screw and the head. Every size it fills in can be typed over. (Where it is and how it is moved: placedOp.ts.)

import type { FaceRef, HoleFeature, Vec3 } from "../doc/types";
import { headFor, holeFor, screwSize, SCREW_SIZES, sinkDepth } from "../doc/holeSizes";
import { dot } from "../geom";
import type { PanelItem } from "../ui/ui";
import { fmtLen } from "../units";
import { PlacedOp } from "./placedOp";
import type { AppContext } from "./tool";

type Head = HoleFeature["head"];
const HEADS: { id: Head; label: string }[] = [
  { id: "none", label: "None" },
  { id: "counterbore", label: "Counterbore" },
  { id: "countersink", label: "Countersink" },
];

/** The hole made last: the next one starts as the same screw, head and depth (four of them are one choice, not four). */
let lastHole: Pick<HoleFeature, "size" | "diameter" | "head" | "headDiameter" | "headDepth" | "through" | "depth"> | null = null;

export class HoleOp extends PlacedOp<HoleFeature> {
  readonly id = "hole";

  constructor(app: AppContext, face: FaceRef, at: Vec3, tolPx = 12, existing?: HoleFeature) {
    const size = screwSize("M3")!;
    super(app, { ...app.store.newIdentity("hole"), type: "hole", face, at, ...(lastHole ?? { ...holeFor(size, "none"), head: "none", through: true, depth: 10 }) }, tolPx, existing);
  }

  /** The hole's own wall is round about where it is. */
  protected madeAt(): Vec3 | null {
    const f = this.feature;
    return this.app.view.body(f.face.body)?.faces.find((g) => g.step === f.id && g.round?.hole && Math.abs(dot(g.normal, this.out)) < 0.01)?.center ?? null;
  }

  protected hint(): string {
    const f = this.feature;
    const what = `${f.size ? `${f.size} hole` : `Hole ${fmtLen(f.diameter)} across`}${f.head === "none" ? "" : `, ${f.head}`}${f.through ? ", right through" : `, ${fmtLen(f.depth)} deep`}`;
    return `${what}. ${this.where()}`;
  }

  protected ready(): boolean {
    return this.feature.diameter > 0;
  }

  protected items(): PanelItem[] {
    const f = this.feature;
    const items: PanelItem[] = [
      { type: "choice", label: "Screw", list: true, options: [...SCREW_SIZES.map((s) => ({ id: s.name, label: s.name })), { id: "", label: "Other" }], value: f.size ?? "", onChange: (id) => this.setScrew(id) },
      this.num("Diameter", "diameter", "length", { min: 0.01, onInput: () => this.changed() }),
      { type: "choice", label: "Head", options: HEADS, value: f.head, onChange: (id) => this.setHead(id as Head) },
    ];
    if (f.head !== "none") items.push(this.num("Head diameter", "headDiameter", "length", { min: 0.01, onInput: () => this.changed() }));
    if (f.head === "counterbore") items.push(this.num("Head depth", "headDepth", "length", { min: 0.01, onInput: () => this.changed() }));
    items.push({ type: "toggle", label: "Through", value: f.through, onChange: (v) => ((f.through = v), this.changed(true)) });
    if (!f.through) items.push(this.num("Depth", "depth", "length", { min: 0.01, onInput: () => this.changed() }));
    return items;
  }

  private setScrew(name: string): void {
    const f = this.feature;
    const size = screwSize(name);
    if (size) Object.assign(f, holeFor(size, f.head));
    else delete f.size;
    this.fitDepth();
    // (Sizes from the table: no longer what a formula typed for the last screw said.)
    for (const k of ["diameter", "headDiameter", "headDepth"]) this.setExpr(k, null);
    this.changed(true);
  }

  private setHead(head: Head): void {
    const f = this.feature;
    f.head = head;
    const size = screwSize(f.size);
    if (head !== "none") {
      const made = size ? holeFor(size, head) : headFor(f.diameter, head);
      f.headDiameter = made.headDiameter;
      f.headDepth = made.headDepth;
      for (const k of ["headDiameter", "headDepth"]) this.setExpr(k, null);
    }
    this.fitDepth();
    this.changed(true);
  }

  /** A hole to a depth goes deeper than the recess for its head (choosing a bigger screw made it "too shallow"). */
  private fitDepth(): void {
    const f = this.feature;
    if (f.through || f.head === "none") return;
    const recess = f.head === "counterbore" ? f.headDepth : sinkDepth(f);
    if (!(f.depth > recess)) f.depth = Math.ceil(recess + f.diameter);
  }

  private changed(panel = false): void {
    const f = this.feature;
    lastHole = { ...(f.size ? { size: f.size } : {}), diameter: f.diameter, head: f.head, headDiameter: f.headDiameter, headDepth: f.headDepth, through: f.through, depth: f.depth };
    if (panel) this.render();
    this.update();
    if (!panel) this.setHint();
  }
}

