// History → Play: the project built again step by step, slowly enough to follow, the view going to where each
// step changes something. Nothing of the project is touched: each stage is the project's own steps with the later
// ones switched off, built by the engine and shown; at the end (or on Reset) the project is shown again as it is.
import { Box3, Vector3 } from "three";
import type { Feature, PlaneDef, SketchEntity, Vec3 } from "../doc/types";
import type { BodyMesh, RegenResult } from "../kernel/protocol";
import type { Insets } from "../view/camera";
import type { Highlight, Viewport } from "../view/viewport";

export type PlayState = "idle" | "playing" | "paused";

export interface TimelapseHost {
  view(): Viewport;
  /** The project's steps, in order. */
  steps(): Feature[];
  /** The model of these steps (null: the engine was asked for something else meanwhile). */
  build(features: Feature[]): Promise<RegenResult | null>;
  /** A stage is being waited for (true), or has come (false): a recording leaves that wait out. */
  waiting(on: boolean): void;
  /** Show that model; `sketch`: the sketch to show with it, hidden or not. */
  show(r: RegenResult, features: Feature[], sketch: string | null): void;
  /** Light up these bodies and faces (none: nothing lit). */
  flash(what: Highlight[]): void;
  /** The project as it is, shown again. */
  restore(): void;
  state(s: PlayState): void;
  /** The step being shown (null: none). */
  mark(at: { id: string; index: number; of: number; name: string } | null): void;
}

const STOP = Symbol("stop");

// How long each thing takes (ms). Slow on purpose: a step has to be seen, not flashed past.
const MOVE = 900; // the view going somewhere else
const TURN = 1200; // ...and turning to another side on the way
const SETTLE = 250; // after the view arrives, before the step appears
const SKETCH = 1300; // a sketch on show
const SOLID = 1800; // a step that changed a body
const LIT = 900; // of which the changed body stays lit
const QUIET = 700; // a step that shows nothing new (a plane, a variable)

export class Timelapse {
  state: PlayState = "idle";
  private token = 0;
  private wake: (() => void) | null = null;
  /** The part of the view to keep the model in (a recording: the part that is in the video); else what the panels leave free. */
  private within: (() => Insets) | null = null;
  private free(): Insets {
    return this.within?.() ?? this.h.view().coveredInsets();
  }

  constructor(private h: TimelapseHost) {}

  /** The button: Play, then Pause, then Reset (back to the project). */
  press(): void {
    if (this.state === "idle") void this.play();
    else if (this.state === "playing") this.set("paused");
    else this.exit();
  }

  /** Out of it, whatever it was doing: the project is shown again. */
  exit(): void {
    if (this.state === "idle") return;
    this.token++;
    this.wake?.();
  }

  private set(s: PlayState): void {
    this.state = s;
    this.h.state(s);
  }

  private check(t: number): void {
    if (this.token !== t) throw STOP;
  }

  /** Wait; and on, for as long as it is paused. */
  private async sleep(ms: number, t: number): Promise<void> {
    await new Promise<void>((done) => {
      const id = setTimeout(done, ms);
      this.wake = () => (clearTimeout(id), done());
    });
    this.check(t);
    while (this.state === "paused") {
      await new Promise<void>((done) => (this.wake = done));
      this.check(t);
    }
  }

  /** Played from the start; true if it ran to its end. `within`: see above. */
  async play(within: (() => Insets) | null = null): Promise<boolean> {
    if (this.state !== "idle") return false;
    const all = this.h.steps();
    const on = all.filter((f) => !f.suppressed && !f.rolledBack);
    if (!on.length) return false;
    this.within = within;
    let whole = false;
    const t = ++this.token;
    this.set("playing");
    // The first k steps: the rest switched off, the way a breakpoint does it.
    const upTo = (k: number): Feature[] => {
      const keep = new Set(on.slice(0, k).map((f) => f.id));
      return all.map((f) => (keep.has(f.id) || f.rolledBack ? f : ({ ...f, rolledBack: true } as Feature)));
    };
    try {
      // Nothing yet.
      const none = upTo(0);
      const r0 = await this.h.build(none);
      this.check(t);
      if (r0) this.h.show(r0, none, null);
      await this.sleep(600, t);
      let had = new Map<string, number>();
      // Every corner of the model as it was a step ago: what a step adds is what was not there.
      let was = new Set<string>();
      // Each stage is asked for while the one before it is on show: it is there when its turn comes. (The engine
      // has every step built already - a stage costs it the drawing of the bodies as they were then, up to a
      // second on a hundred-step project, and that second passes while the step before is being looked at.)
      let ahead: Promise<RegenResult | null> | null = this.h.build(upTo(1));
      for (let k = 0; k < on.length; k++) {
        const f = on[k];
        const fs = upTo(k + 1);
        const at = { id: f.id, index: k, of: on.length, name: f.name };
        this.h.mark(at);
        this.h.waiting(true);
        let r: RegenResult | null;
        try {
          r = await (ahead ?? this.h.build(fs));
        } finally {
          this.h.waiting(false);
        }
        this.check(t);
        ahead = k + 1 < on.length ? this.h.build(upTo(k + 2)) : null;
        if (!r) continue;
        const isSketch = f.type === "sketch";
        const changed = r.bodies.filter((b) => had.get(b.id) !== b.key);
        const plane = isSketch ? (r.sketchPlanes[f.id] ?? (f as { plane: PlaneDef }).plane) : null;
        const fresh = plane ? null : freshParts(changed, was);
        const box = plane ? sketchBox(r.sketchEntities?.[f.id] ?? (f as { entities: SketchEntity[] }).entities, plane) : fresh!.box;
        if (!box.isEmpty()) {
          const model = meshBox(r.bodies).union(box);
          await this.frame(box, model, plane ? new Vector3(...plane.normal) : null, t);
        }
        this.h.show(r, fs, isSketch ? f.id : null);
        this.h.mark(at);
        had = new Map(r.bodies.map((b) => [b.id, b.key]));
        was = corners(r.bodies);
        if (isSketch) await this.sleep(SKETCH, t);
        else if (changed.length) {
          this.h.flash(fresh!.lit);
          await this.sleep(LIT, t);
          this.h.flash([]);
          await this.sleep(SOLID - LIT, t);
        } else await this.sleep(QUIET, t);
      }
      // All of it, to end on.
      this.h.mark(null);
      this.h.view().cam.fit(this.h.view().bounds(), true, this.free());
      this.h.view().cam.pace(MOVE);
      await this.sleep(MOVE + 900, t);
      whole = true;
    } catch (e) {
      if (e !== STOP) throw e;
    } finally {
      this.wake = null;
      this.h.flash([]);
      this.h.mark(null);
      this.within = null;
      this.set("idle");
      this.h.restore();
    }
    return whole;
  }

  /**
   * The view goes to where the change is, if it isn't in sight already: over to it (and closer, or further), and
   * round to its side when it is seen edge-on or from behind.
   */
  private async frame(box: Box3, model: Box3, normal: Vector3 | null, t: number): Promise<void> {
    const view = this.h.view();
    const cam = view.cam;
    const size = Math.max(model.getSize(new Vector3()).length(), 1e-6);
    const own = box.getSize(new Vector3()).length();
    const dir = cam.viewDir();
    // Round to it: a sketch seen edge-on or from behind, a change on the far side of the model.
    let from: Vector3 | null = null;
    if (normal) {
      if (-dir.dot(normal.clone().normalize()) < 0.3) from = normal.clone().normalize();
    } else {
      const off = box.getCenter(new Vector3()).sub(model.getCenter(new Vector3()));
      if (off.length() > size * 0.12 && dir.dot(off.clone().normalize()) > 0.35) from = off.normalize();
    }
    if (from) {
      // Not straight at it: a little to its side and above, so its depth shows.
      let side = new Vector3().crossVectors(from, new Vector3(0, 0, 1));
      if (side.length() < 1e-3) side = new Vector3(1, 0, 0);
      side.normalize();
      const over = new Vector3().crossVectors(side, from).normalize();
      if (over.z < 0 && Math.abs(from.z) < 0.99) over.negate();
      const w = from.clone().addScaledVector(side, 0.5).addScaledVector(over, 0.45).normalize();
      cam.lookAlong(w.toArray() as Vec3);
    }
    // What to have in the picture: the change with room round it; most of the model, if the change is most of it.
    const focus = own > size * 0.55 ? model.clone().expandByScalar(size * 0.16) : box.clone().expandByScalar(Math.max(own * 0.5, size * 0.3));
    if (!from && this.inSight(box, focus)) return;
    cam.fit(focus, true, this.free());
    cam.pace(from ? TURN : MOVE);
    const end = performance.now() + (from ? TURN : MOVE) + 400;
    while (cam.animating && performance.now() < end) await this.sleep(40, t);
    await this.sleep(SETTLE, t);
  }

  /** Is the change in the picture, and neither a speck nor bigger than the screen? */
  private inSight(box: Box3, focus: Box3): boolean {
    const view = this.h.view();
    const c = view.cam.camera;
    c.updateMatrixWorld();
    const free = this.free();
    const [x0, x1, y0, y1] = [free.left * 2 - 1, 1 - free.right * 2, free.bottom * 2 - 1, 1 - free.top * 2];
    const span = (b: Box3) => {
      let [ax, bx, ay, by] = [Infinity, -Infinity, Infinity, -Infinity];
      for (let i = 0; i < 8; i++) {
        const p = new Vector3(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z).project(c);
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || p.z > 1) return null;
        (ax = Math.min(ax, p.x)), (bx = Math.max(bx, p.x)), (ay = Math.min(ay, p.y)), (by = Math.max(by, p.y));
      }
      return { ax, bx, ay, by };
    };
    const s = span(box);
    if (!s || s.ax < x0 || s.bx > x1 || s.ay < y0 || s.by > y1) return false;
    // Too far off to see what changed, or so near that there is no telling where on the model it is.
    const f = span(focus);
    const share = f ? Math.max((f.bx - f.ax) / (x1 - x0), (f.by - f.ay) / (y1 - y0)) : 2;
    return share > 0.22 && share < 1.6;
  }
}

const cornerKey = (p: ArrayLike<number>, i: number) => `${Math.round(p[i] * 1e4)},${Math.round(p[i + 1] * 1e4)},${Math.round(p[i + 2] * 1e4)}`;

function corners(bodies: BodyMesh[]): Set<string> {
  const out = new Set<string>();
  for (const b of bodies) for (let i = 0; i + 2 < b.positions.length; i += 3) out.add(cornerKey(b.positions, i));
  return out;
}

/**
 * What a step added to the bodies it changed: the box of their corners that were not there before (a hole cut in a
 * block is the hole, not the block), and what to light - the faces with such corners, or the whole body when it is
 * all new. Nothing new in a body that changed (something was only taken away): the body.
 */
function freshParts(changed: BodyMesh[], was: Set<string>): { box: Box3; lit: Highlight[] } {
  const box = new Box3();
  const lit: Highlight[] = [];
  const p = new Vector3();
  for (const b of changed) {
    const isNew = new Uint8Array(b.positions.length / 3);
    let n = 0;
    for (let v = 0; v < isNew.length; v++) if (!was.has(cornerKey(b.positions, v * 3))) (isNew[v] = 1), n++;
    if (!n || n === isNew.length) {
      box.union(meshBox([b]));
      lit.push({ kind: "body", body: b.id });
      continue;
    }
    for (let v = 0; v < isNew.length; v++) if (isNew[v]) box.expandByPoint(p.set(b.positions[v * 3], b.positions[v * 3 + 1], b.positions[v * 3 + 2]));
    const faces = new Set<number>();
    for (const g of b.faceGroups) {
      // (A face that only lost a piece keeps most of its corners: lit when a fair share of them is new.)
      let fresh = 0;
      for (let i = g.start; i < g.start + g.count; i++) fresh += isNew[b.indices[i]];
      if (fresh > g.count * 0.34) faces.add(g.face);
    }
    if (!faces.size || faces.size === new Set(b.faceGroups.map((g) => g.face)).size) lit.push({ kind: "body", body: b.id });
    else for (const face of faces) lit.push({ kind: "face", body: b.id, face });
  }
  return { box, lit };
}

function meshBox(bodies: BodyMesh[]): Box3 {
  const box = new Box3();
  const p = new Vector3();
  for (const b of bodies) for (let i = 0; i + 2 < b.positions.length; i += 3) box.expandByPoint(p.set(b.positions[i], b.positions[i + 1], b.positions[i + 2]));
  return box;
}

/** A sketch's curves, where they are in space: their box. */
function sketchBox(entities: SketchEntity[], plane: PlaneDef): Box3 {
  const box = new Box3();
  const o = new Vector3(...plane.origin);
  const x = new Vector3(...plane.xDir).normalize();
  const y = new Vector3().crossVectors(new Vector3(...plane.normal), x).normalize();
  const put = (u: number, v: number) => Number.isFinite(u) && Number.isFinite(v) && box.expandByPoint(o.clone().addScaledVector(x, u).addScaledVector(y, v));
  for (const e of entities as unknown as Record<string, unknown>[]) {
    for (const k of ["a", "b", "m", "c", "p", "center", "at"]) {
      const q = e[k];
      if (Array.isArray(q) && typeof q[0] === "number" && typeof q[1] === "number") put(q[0], q[1]);
    }
    if (Array.isArray(e.points)) for (const q of e.points as unknown[]) if (Array.isArray(q)) put(q[0] as number, q[1] as number);
    // Round and boxy ones, by their middle and size.
    const c = e.center as number[] | undefined;
    const num = (k: string) => (typeof e[k] === "number" ? (e[k] as number) : 0);
    const half = Math.max(num("radius"), num("r"), num("rx"), num("ry"), Math.hypot(num("w"), num("h")) / 2);
    if (Array.isArray(c) && half > 0) (put(c[0] - half, c[1] - half), put(c[0] + half, c[1] + half));
  }
  return box;
}
