// The enclosure tools: what a printed case needs beyond its walls.
//
// Boss: a post for a screw, by the screw's size, with ribs round its foot. Snap Fit: a springy hook, and the slot
// it springs into. (Both are put down on a flat face and moved like a hole: placedOp.ts.) Lip: a raised band along
// a rim, and the groove for it in the other half. Rib: lines of a sketch made a thin wall.

import type { BossFeature, FaceRef, LipFeature, PathRef, RibFeature, SnapFeature, Vec3 } from "../doc/types";
import { BOSS_SIZES, bossFor, bossSize } from "../doc/bossSizes";
import { dot, sub } from "../geom";
import type { PanelItem } from "../ui/ui";
import { fmtLen } from "../units";
import { FeatureOp } from "./featureOp";
import { PlacedOp } from "./placedOp";
import { facesSlot, pathSlot } from "./slots";
import type { AppContext } from "./tool";

// ------------------------------------------------------------------ boss

const FITS: { id: BossFeature["fit"]; label: string }[] = [
  { id: "screw", label: "Screw" },
  { id: "insert", label: "Heat-set insert" },
];

/** The boss made last: the next starts the same (a case has four of them). */
let lastBoss: Omit<BossFeature, "id" | "name" | "type" | "face" | "at" | "around" | "centered" | "from" | "exprs" | "suppressed" | "rolledBack"> | null = null;

export class BossOp extends PlacedOp<BossFeature> {
  readonly id = "boss";

  constructor(app: AppContext, face: FaceRef, at: Vec3, tolPx = 12, existing?: BossFeature) {
    const start = { ...bossFor(bossSize("M3")!, "screw"), fit: "screw" as const, height: 10, holeDepth: 8, ribs: 0, ribThickness: 1.2, ribReach: 4 };
    super(app, { ...app.store.newIdentity("boss"), type: "boss", face, at, ...(lastBoss ?? start) }, tolPx, existing);
  }

  /** Its hole's wall is round about where it is (the post's own wall too, while no rib cuts it in pieces). */
  protected madeAt(): Vec3 | null {
    const f = this.feature;
    const faces = this.app.view.body(f.face.body)?.faces.filter((g) => g.step === f.id && !!g.round && Math.abs(dot(g.normal, this.out)) < 0.01) ?? [];
    return (faces.find((g) => g.round!.hole) ?? (f.ribs > 0 ? undefined : faces[0]))?.center ?? null;
  }

  protected hint(): string {
    const f = this.feature;
    const what = `${f.size ? `${f.size} boss` : "Boss"} ${fmtLen(f.diameter)} across, ${fmtLen(f.height)} tall${f.hole > 0 ? `, a ${fmtLen(f.hole)} hole for ${f.fit === "insert" ? "a heat-set insert" : "the screw"}` : ""}${f.ribs > 0 ? `, ${f.ribs} rib${f.ribs > 1 ? "s" : ""}` : ""}`;
    return `${what}. ${this.where()}`;
  }

  protected ready(): boolean {
    return this.feature.diameter > 0 && this.feature.height > 0;
  }

  protected items(): PanelItem[] {
    const f = this.feature;
    const items: PanelItem[] = [
      { type: "choice", label: "Screw", list: true, options: [...BOSS_SIZES.map((s) => ({ id: s.name, label: s.name })), { id: "", label: "Other" }], value: f.size ?? "", onChange: (id) => this.setScrew(id, f.fit) },
      { type: "choice", label: "For", options: FITS, value: f.fit, onChange: (id) => this.setScrew(f.size ?? "", id as BossFeature["fit"]) },
      this.num("Height", "height", "length", { min: 0.01, onInput: () => this.changed() }),
      this.num("Diameter", "diameter", "length", { min: 0.01, onInput: () => this.changed() }),
      this.num("Hole", "hole", "length", { min: 0, onInput: () => this.changed() }),
    ];
    if (f.hole > 0) items.push(this.num("Hole depth", "holeDepth", "length", { min: 0.01, onInput: () => this.changed() }));
    items.push(this.num("Ribs", "ribs", "int", { min: 0, onInput: () => this.changed(true) }));
    if (f.ribs > 0) {
      items.push(this.num("Rib thickness", "ribThickness", "length", { min: 0.01, onInput: () => this.changed() }));
      items.push(this.num("Rib length", "ribReach", "length", { min: 0.01, onInput: () => this.changed() }));
    }
    return items;
  }

  private setScrew(name: string, fit: BossFeature["fit"]): void {
    const f = this.feature;
    f.fit = fit;
    const size = bossSize(name);
    if (size) Object.assign(f, bossFor(size, fit));
    else delete f.size;
    // (Sizes from the table: no longer what a formula typed for the last screw said.)
    for (const k of ["diameter", "hole"]) this.setExpr(k, null);
    this.changed(true);
  }

  private changed(panel = false): void {
    const f = this.feature;
    f.ribs = Math.max(0, Math.min(8, Math.round(f.ribs || 0)));
    lastBoss = { ...(f.size ? { size: f.size } : {}), fit: f.fit, diameter: f.diameter, height: f.height, hole: f.hole, holeDepth: f.holeDepth, ribs: f.ribs, ribThickness: f.ribThickness, ribReach: f.ribReach };
    if (panel) this.render();
    this.update();
    if (!panel) this.setHint();
  }
}

// ------------------------------------------------------------------ snap fit

const KINDS: { id: SnapFeature["kind"]; label: string }[] = [
  { id: "hook", label: "Hook" },
  { id: "slot", label: "Slot" },
];

/** The sizes used last: a slot made after a hook is that hook's slot. */
let lastSnap: Pick<SnapFeature, "length" | "width" | "thickness" | "overhang" | "hookHeight" | "clearance"> | null = null;

export class SnapOp extends PlacedOp<SnapFeature> {
  readonly id = "snap";

  constructor(app: AppContext, face: FaceRef, at: Vec3, tolPx = 12, existing?: SnapFeature) {
    const start = { length: 8, width: 5, thickness: 1.6, overhang: 1.2, hookHeight: 2, clearance: 0.2 };
    super(app, { ...app.store.newIdentity("snap"), type: "snap", face, at, kind: "hook", angle: 0, ...(lastSnap ?? start) }, tolPx, existing);
  }

  protected hint(): string {
    const f = this.feature;
    const what =
      f.kind === "hook"
        ? `A hook ${fmtLen(f.length)} up the arm, sticking out ${fmtLen(f.overhang)}. Turn sets which way it faces`
        : `The slot for a hook ${fmtLen(f.width)} wide and ${fmtLen(f.hookHeight)} tall, ${fmtLen(f.clearance)} of room all round. Turn sets which way it lies`;
    return `${what}. ${this.where()}`;
  }

  protected ready(): boolean {
    const f = this.feature;
    return f.width > 0 && f.hookHeight > 0 && f.overhang > 0;
  }

  protected items(): PanelItem[] {
    const f = this.feature;
    const items: PanelItem[] = [{ type: "choice", label: "Make", options: KINDS, value: f.kind, lead: true, onChange: (id) => ((f.kind = id as SnapFeature["kind"]), this.changed(true)) }];
    if (f.kind === "hook") items.push(this.num("Length", "length", "length", { min: 0.01, onInput: () => this.changed() }), this.num("Thickness", "thickness", "length", { min: 0.01, onInput: () => this.changed() }));
    items.push(
      this.num("Width", "width", "length", { min: 0.01, onInput: () => this.changed() }),
      this.num("Hook height", "hookHeight", "length", { min: 0.01, onInput: () => this.changed() }),
      this.num("Overhang", "overhang", "length", { min: 0.01, onInput: () => this.changed() }),
    );
    if (f.kind === "slot") {
      items.push(this.num("Clearance", "clearance", "length", { min: 0, onInput: () => this.changed() }));
      items.push({ type: "toggle", label: "Through", value: !!f.through, onChange: (v) => ((f.through = v), this.changed(true)) });
    }
    items.push(this.num("Turn", "angle", "angle", { onInput: () => this.changed() }));
    items.push({ type: "button", label: "Turn 90°", icon: "rotateAxis", onClick: () => ((f.angle = (((Math.round(f.angle / 90) + 1) * 90) % 360)), this.setExpr("angle", null), this.changed(true)) });
    return items;
  }

  private changed(panel = false): void {
    const f = this.feature;
    lastSnap = { length: f.length, width: f.width, thickness: f.thickness, overhang: f.overhang, hookHeight: f.hookHeight, clearance: f.clearance };
    if (panel) this.render();
    this.update();
    if (!panel) this.setHint();
  }
}

// ------------------------------------------------------------------ lip

const LIPS: { id: LipFeature["kind"]; label: string }[] = [
  { id: "lip", label: "Lip" },
  { id: "groove", label: "Groove" },
];
const SIDES: { id: LipFeature["side"]; label: string }[] = [
  { id: "inside", label: "Inside" },
  { id: "outside", label: "Outside" },
];

/** The lip made last: the groove made next is the one for it (the same side and sizes). */
let lastLip: Pick<LipFeature, "side" | "width" | "height" | "clearance"> | null = null;

export class LipOp extends FeatureOp<LipFeature> {
  readonly id = "lip";

  constructor(app: AppContext, faces: FaceRef[], existing?: LipFeature) {
    // (Half the wall wide, to start with: the wall is about the rim's area over the length round it.)
    const wall = faces[0] ? wallOf(app, faces[0]) : 0;
    const width = wall > 0 ? Math.max(0.4, Math.round(wall * 5) / 10) : 1;
    const start = lastLip ? { ...lastLip, kind: "groove" as const } : { kind: "lip" as const, side: "inside" as const, width, height: Math.max(1, Math.round(width * 3) / 2), clearance: 0.2 };
    super(app, { ...app.store.newIdentity("lip"), type: "lip", faces, ...start }, existing);
    this.slots = [facesSlot(app, "Rim", () => this.feature.faces, (f) => (this.feature.faces = f))];
    this.active = 0;
  }

  protected hint(): string {
    const f = this.feature;
    if (!f.faces.length) return "Tap the rim: the flat face on top of the wall, round the opening.";
    return f.kind === "lip"
      ? `A lip ${fmtLen(f.width)} wide and ${fmtLen(f.height)} tall along the ${f.side} of the rim. The other half takes the Groove for it.`
      : `The groove for a lip ${fmtLen(f.width)} wide and ${fmtLen(f.height)} tall, ${fmtLen(f.clearance)} of room for it.`;
  }

  protected ready(): boolean {
    return this.feature.faces.length > 0 && this.feature.width > 0 && this.feature.height > 0;
  }

  protected items(): PanelItem[] {
    const f = this.feature;
    const items: PanelItem[] = [
      { type: "choice", label: "Make", options: LIPS, value: f.kind, lead: true, onChange: (id) => ((f.kind = id as LipFeature["kind"]), this.changed(true)) },
      { type: "choice", label: "Side", options: SIDES, value: f.side, onChange: (id) => ((f.side = id as LipFeature["side"]), this.changed(true)) },
      this.num("Width", "width", "length", { min: 0.01, onInput: () => this.changed() }),
      this.num("Height", "height", "length", { min: 0.01, onInput: () => this.changed() }),
    ];
    if (f.kind === "groove") items.push(this.num("Clearance", "clearance", "length", { min: 0, onInput: () => this.changed() }));
    return items;
  }

  private changed(panel = false): void {
    const f = this.feature;
    lastLip = { side: f.side, width: f.width, height: f.height, clearance: f.clearance };
    if (panel) this.render();
    this.update();
    if (!panel) this.setHint();
  }

  protected done(): void {
    const f = this.feature;
    if (this.ready()) lastLip = f.kind === "lip" ? { side: f.side, width: f.width, height: f.height, clearance: f.clearance } : null;
    super.done();
  }
}

/** How thick the wall under a rim is, about: the rim's area over half the length of the edges round it (0: not to be told). */
function wallOf(app: AppContext, face: FaceRef): number {
  const body = app.view.body(face.body);
  if (!body) return 0;
  const size = Math.sqrt(face.area) || 1;
  const flat = (p: Vec3) => Math.abs(dot(sub(p, face.center), face.normal)) < 1e-4 * Math.max(1, size);
  let round = 0;
  for (const e of body.edges) if (flat(e.start) && flat(e.mid) && flat(e.end)) round += e.length;
  return round > 0 ? face.area / (round / 2) : 0;
}

// ------------------------------------------------------------------ rib

let lastRib: Pick<RibFeature, "thickness" | "height" | "extend"> | null = null;

export class RibOp extends FeatureOp<RibFeature> {
  readonly id = "rib";

  constructor(app: AppContext, path: PathRef | null, existing?: RibFeature) {
    super(app, { ...app.store.newIdentity("rib"), type: "rib", path: path ?? { kind: "sketch", sketch: "", entities: [] }, ...(lastRib ?? { thickness: 1.6, height: 8, extend: true }) }, existing);
    this.slots = [
      pathSlot(
        app,
        () => (this.picked() ? this.feature.path : null),
        (p) => {
          // (Lines of a sketch: an edge of the body has no plane to stand a rib on.)
          if (p.kind !== "sketch") return void app.ui.toast("A rib is made from lines of a sketch: draw them on the floor, or on a plane above it");
          this.feature.path = p;
        },
      ),
    ];
    this.slots[0].label = "Lines";
    this.active = 0;
  }

  private picked(): boolean {
    const p = this.feature.path;
    return p.kind === "sketch" && p.entities.length > 0;
  }

  protected hint(): string {
    const f = this.feature;
    if (!this.picked()) return "Tap the lines of a sketch the rib follows. Drawn on a face, it rises from it; drawn above the body, it goes down to it.";
    return `A rib ${fmtLen(f.thickness)} thick. Lines on a face rise ${fmtLen(f.height)} from it; lines above the body go down to it.${f.extend ? " Straight ends run on to the walls." : ""}`;
  }

  protected ready(): boolean {
    return this.picked() && this.feature.thickness > 0 && this.feature.height > 0;
  }

  protected items(): PanelItem[] {
    const f = this.feature;
    return [
      this.num("Thickness", "thickness", "length", { min: 0.01, onInput: () => this.changed() }),
      this.num("Height", "height", "length", { min: 0.01, onInput: () => this.changed() }),
      { type: "toggle", label: "Run on to walls", value: f.extend, onChange: (v) => ((f.extend = v), this.changed(true)) },
    ];
  }

  private changed(panel = false): void {
    const f = this.feature;
    lastRib = { thickness: f.thickness, height: f.height, extend: f.extend };
    if (panel) this.render();
    this.update();
    if (!panel) this.setHint();
  }
}
