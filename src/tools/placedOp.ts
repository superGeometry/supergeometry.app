// A step put down on a flat face and moved about on it: a hole, a boss, a snap hook.
//
// Where it is: the tap, moved by its dot. It catches on the middle of the face and on the centre of a round edge
// (a boss's rim), and stays there when the model changes; anywhere else it is held from the two nearest straight
// edges, by the two sizes shown - typed over, they place it exactly, and it keeps them when the face is resized.
// It catches, too, on the point where an axis passes through the face and on a sketch drawn on the face (a line's
// end, where lines meet, a circle's centre - see holeSnaps.ts): put exactly there, and held from the edges as
// anywhere else.

import type { EdgeRef, Feature, OnFace, Vec3 } from "../doc/types";
import { distanceFrom, holeFromLines, sideOf } from "../doc/holeSizes";
import { add, cross, dist, dot, len, niceStep, norm, scale, sub } from "../geom";
import { fmtLen } from "../units";
import type { ToolPointer } from "../view/input";
import { DimWidget } from "./annotate";
import { FeatureOp } from "./featureOp";
import { Handle } from "./handles";
import { faceIndexOf, type AppContext } from "./tool";
import { holeSnaps, type SnapPoint } from "./holeSnaps";

/** How near (on screen) a tap or the dragged dot must be to a point it catches on. */
const CATCH_PX = 16;

interface Line {
  a: Vec3;
  b: Vec3;
  ref: EdgeRef;
}
interface Round {
  c: Vec3;
  ref: EdgeRef;
}

export abstract class PlacedOp<F extends Feature & OnFace> extends FeatureOp<F> {
  /** The step as what stands on a face (its place is set here, whatever else it is). */
  protected get placed(): OnFace & { id: string } {
    return this.feature as OnFace & { id: string };
  }

  /**
   * Where the step really is, read off the model once it is made (the middle of a face of its own that lies on its
   * axis); null: not to be told from the model.
   */
  protected madeAt(): Vec3 | null {
    return null;
  }

  /** The face's plane: a point of it, and the way out of the body. */
  protected on: Vec3;
  protected out: Vec3;
  protected middle: Vec3;
  /** What it can catch on and be held from: the round and straight edges lying in the face's plane. */
  protected rounds: Round[] = [];
  protected lines: Line[] = [];
  /** Points it catches on that are not the face's own: where an axis comes through, a sketch's ends and crossings. */
  protected snaps: SnapPoint[] = [];
  /** The two edges its sizes are measured from (shown also when it sits on a centre: typed over, they take it off). */
  protected edges2: [Line, Line] | null = null;

  /**
   * Where the hole really is, read off the model once it is made: on a centre or the middle of the face the engine
   * says where that is (the middle of a face with a boss on it is not where its picture balances).
   */
  protected actual: Vec3 | null = null;

  protected get at(): Vec3 {
    return this.actual ?? this.placed.at;
  }

  refresh(): void {
    const f = this.placed;
    if (this.dragging || (!f.around && !f.centered)) return;
    const made = this.madeAt();
    if (!made) return;
    const c = this.flatten(made);
    if (dist(c, this.at) < 1e-7) return;
    this.actual = c;
    this.show();
  }

  protected handle: Handle | null = null;
  protected dims: DimWidget[] = [];
  protected dragging = false;

  constructor(app: AppContext, draft: F, tolPx = 12, existing?: F) {
    super(app, draft, existing);
    const face = this.placed.face;
    this.out = norm(face.normal);
    this.middle = face.center;
    this.on = face.center;
    const body = app.view.body(face.body);
    // (Opened again: the face as it is now - it may have moved since - and the hole where it really is.)
    if (existing && body) {
      const i = faceIndexOf(app, face);
      if (i !== null) this.on = body.faces[i].center;
      const made = this.madeAt();
      if (made) this.placed.at = made;
    }
    const size0 = Math.sqrt(face.area) || 1;
    const flat = (p: Vec3) => Math.abs(dot(sub(p, this.on), this.out)) < 1e-4 * Math.max(1, size0);
    body?.edges.forEach((e) => {
      // (Not the hole's own rim.)
      if (existing && e.steps?.includes(existing.id)) return;
      if (!flat(e.start) || !flat(e.mid) || !flat(e.end) || Math.abs(dot(norm(e.dir), this.out)) > 1e-3) return;
      const ref: EdgeRef = { body: face.body, mid: e.mid, dir: e.dir, length: e.length, ...(e.steps ? { steps: e.steps } : {}), ...(e.curves ? { curves: e.curves } : {}) };
      if (e.type === "LINE" && dist(e.start, e.end) > 1e-6) this.lines.push({ a: e.start, b: e.end, ref });
      else if (e.type === "CIRCLE") {
        const c = centreOf(e.start, e.mid, e.end);
        if (c && !this.rounds.some((r) => dist(r.c, c) < 1e-6)) this.rounds.push({ c, ref });
      }
    });
    this.snaps = holeSnaps(app.store.doc.features, app.store.doc.hidden ?? [], this.on, this.out, size0);
    this.placed.at = this.flatten(this.placed.at);
    if (!existing) this.place(this.placed.at, Math.max(CATCH_PX, tolPx));
    else this.hold();
  }

  protected flatten(p: Vec3): Vec3 {
    return sub(p, scale(this.out, dot(sub(p, this.on), this.out)));
  }

  // ------------------------------------------------------------ where it is

  /** The two straight edges nearest a point that do not run the same way (the nearest first). */
  protected nearest(p: Vec3): [Line, Line] | null {
    const far = (l: Line): number => {
      const t = sub(l.b, l.a);
      const L = len(t);
      const along = dot(sub(p, l.a), t) / (L * L);
      const square = len(cross(sub(p, l.a), t)) / L;
      // (An edge the point is not beside counts as further off: the one it is beside is the one meant.)
      return square + (along < 0 ? -along * L : along > 1 ? (along - 1) * L : 0);
    };
    const sorted = [...this.lines].sort((x, y) => far(x) - far(y));
    const first = sorted[0];
    if (!first) return null;
    const t1 = norm(sub(first.b, first.a));
    const second = sorted.find((l) => len(cross(t1, norm(sub(l.b, l.a)))) > 0.3);
    return second ? [first, second] : null;
  }

  /** How far it is from each of the edges it is measured from. */
  protected distances(): [number, number] | null {
    const h = this.edges2;
    if (!h) return null;
    const d = h.map((l) => distanceFrom(l, this.at, this.middle, this.out));
    return d[0] === null || d[1] === null ? null : [d[0], d[1]];
  }

  /** The edges a hole opened again is held from (or, with none, the nearest: only to show its sizes). */
  protected hold(): void {
    const f = this.placed;
    const tol = 1e-4 * Math.max(1, Math.sqrt(f.face.area));
    const mine = f.from?.map((x) => this.lines.find((l) => dist(l.ref.mid, x.edge.mid) < tol));
    this.edges2 = mine?.[0] && mine[1] ? [mine[0], mine[1]] : this.nearest(f.at);
  }

  /**
   * How far apart two points of the face are as seen on the screen, in pixels. (Not along the face: looked at from
   * the side a face is squeezed, and a tap that is plainly on a point was then millimetres from it.)
   */
  protected apart(a: Vec3, b: Vec3): number {
    const [s, q] = [this.app.view.toScreen(a), this.app.view.toScreen(b)];
    if (s && q) return Math.hypot(s[0] - q[0], s[1] - q[1]);
    return dist(a, b) / Math.max(1e-9, this.app.view.cam.worldPerPixel(this.app.view.height));
  }

  /**
   * Put down at a point of the face: on the face's middle or a round edge's centre when within `catchAt` (pixels,
   * on the screen) of one, else held from the two nearest straight edges, their sizes in steps of `step`.
   */
  protected place(p: Vec3, catchAt: number, step = 0): void {
    const f = this.placed;
    p = this.flatten(p);
    this.actual = null;
    delete f.around;
    delete f.centered;
    delete f.from;
    let best: { c: Vec3; d: number; round?: Round } | null = null;
    for (const c of [{ c: this.flatten(this.middle) }, ...this.rounds.map((round) => ({ c: round.c, round }))]) {
      const d = this.apart(c.c, p);
      if (d <= catchAt && (!best || d < best.d)) best = { ...c, d };
    }
    // An axis's point, a point of a sketch on the face - the nearer of that and the face's own wins (its own, when
    // they are one place: the middle of the face stays "the middle" though an axis comes through there).
    let snap: (SnapPoint & { d: number }) | null = null;
    for (const s of this.snaps) {
      const d = this.apart(s.at, p);
      if (d <= catchAt && (!snap || d < snap.d)) snap = { ...s, d };
    }
    if (best && !(snap && snap.d < best.d - 1e-6)) {
      f.at = best.c;
      if (best.round) f.around = best.round.ref;
      else f.centered = true;
      this.edges2 = this.nearest(f.at);
      this.caught = best.round ? "On the centre of the round edge" : "In the middle of the face";
      return;
    }
    // Exactly there (its sizes from the edges as they come out).
    if (snap) {
      f.at = this.flatten(snap.at);
      this.edges2 = this.nearest(f.at);
      this.keepSizes(0);
      this.caught = snap.what;
      return;
    }
    this.caught = null;
    f.at = p;
    this.edges2 = this.nearest(p);
    this.keepSizes(step);
  }

  /** What it caught on last (said by the pointer while it is dragged). */
  protected caught: string | null = null;

  /** Held from its two edges at the sizes it has now (in steps of `step`), or at `typed` for one of them. */
  protected keepSizes(step = 0, typed?: { i: number; v: number }): void {
    const f = this.placed;
    const h = this.edges2;
    const d = this.distances();
    if (!h || !d) return;
    f.at = this.at;
    this.actual = null;
    const size = d.map((x, i) => {
      if (typed?.i === i) return (x < 0 ? -1 : 1) * typed.v;
      return Math.round((step > 0 ? Math.round(x / step) * step : x) * 1e9) / 1e9;
    });
    const at = holeFromLines(f.at, this.middle, this.out, { ...h[0], d: size[0] }, { ...h[1], d: size[1] });
    if (!at) return;
    f.at = this.flatten(at);
    delete f.around;
    delete f.centered;
    f.from = [
      { edge: h[0].ref, d: size[0] },
      { edge: h[1].ref, d: size[1] },
    ];
  }

  // ------------------------------------------------------------ the tool

  enter(): void {
    super.enter();
    this.handle = new Handle(this.app.view, "dot");
    this.show();
  }

  exit(): void {
    this.handle?.dispose();
    this.handle = null;
    for (const d of this.dims) d.dispose();
    this.dims = [];
    super.exit();
  }

  protected restored(): void {
    this.actual = null;
    this.hold();
    this.show();
  }

  /** The dot on the hole, and its two sizes from the edges. */
  protected show(): void {
    if (!this.handle) return;
    const at = this.at;
    this.handle.set(at, this.out);
    const h = this.edges2;
    const d = this.distances();
    if (!h || !d) {
      for (const w of this.dims) w.dispose();
      this.dims = [];
      return;
    }
    h.forEach((l, i) => {
      const m = sideOf(l, this.middle, at, this.out);
      if (!m) return;
      this.dims[i] ??= new DimWidget(this.app.view, {
        value: Math.abs(d[i]),
        // (Its box past the edge, off the face: on the line it sat on the hole.)
        boxAt: "beyond",
        boxGap: 6,
        dir: scale(m, -1),
        facing: this.out,
        onInput: (v) => this.typed(i, v),
        onCommit: () => this.done(),
      });
      this.dims[i].set(at, sub(at, scale(m, d[i])));
      this.dims[i].setValue(Math.abs(d[i]));
    });
  }

  /** A size typed by one of its edges: that far from it, as far from the other as it was. */
  protected typed(i: number, v: number): void {
    if (!(v >= 0)) return;
    this.keepSizes(0, { i, v });
    this.show();
    this.update();
  }

  protected moved(): void {
    this.show();
    this.update();
  }

  protected catchAt(p: ToolPointer): number {
    return Math.max(CATCH_PX, p.tol);
  }

  protected pointOn(p: ToolPointer): Vec3 | null {
    return this.app.view.rayToPlane(p.x, p.y, { origin: this.on, normal: this.out, xDir: [1, 0, 0] });
  }

  hover(p: ToolPointer | null): void {
    this.handle?.setHot(!!p && (this.dragging || !!this.handle?.hit(p)));
    this.app.setHover(null);
  }

  down(p: ToolPointer): boolean {
    if (!this.handle?.hit(p)) return false;
    this.dragging = true;
    return true;
  }

  drag(p: ToolPointer): void {
    if (!this.dragging) return;
    const at = this.pointOn(p);
    if (!at) return;
    this.place(at, this.catchAt(p), niceStep(this.app.view.cam.worldPerPixel(this.app.view.height) * 4));
    const d = this.distances();
    this.app.ui.setLabel(p.x, p.y, this.caught ?? (d && this.placed.from ? `${fmtLen(Math.abs(d[0]))} and ${fmtLen(Math.abs(d[1]))} from the edges` : null));
    this.moved();
  }

  up(): void {
    this.dragging = false;
    this.app.ui.setLabel(0, 0, null);
    this.handle?.setHot(false);
    this.setHint();
  }

  /** A tap on the body puts the hole there; a tap on nothing ends the tool (the hole is kept). */
  tap(p: ToolPointer): void {
    // (The body alone: a sketch drawn on the face, or an axis through it, is what the hole is put on - a tap on one
    // is a tap on the face under it.)
    const hit = this.app.view.pick(p.x, p.y, { edgeTolPx: p.tol, profiles: false, planes: false, axes: false });
    if (!hit || !("body" in hit) || hit.body !== this.placed.face.body) return super.tap(p);
    // On its face (or in the hole itself): there. Another face of the body - a side wall - is not a place on this one.
    const mine = hit.kind === "face" && this.app.view.body(hit.body)?.faces[hit.face]?.step === this.placed.id;
    const flat = Math.abs(dot(sub(hit.point, this.on), this.out)) < 1e-3 * Math.max(1, Math.sqrt(this.placed.face.area));
    const at = mine || flat ? this.pointOn(p) : null;
    if (!at) return void this.app.ui.toast("Tap the face it is on to move it there");
    this.place(at, this.catchAt(p), niceStep(this.app.view.cam.worldPerPixel(this.app.view.height) * 4));
    if (this.caught) this.app.ui.toast(this.caught);
    this.moved();
    this.setHint();
  }

  /** Where it is, in words (the end of its guide text). */
  protected where(): string {
    const f = this.placed;
    const on = this.caught && !f.around && !f.centered ? `${this.caught}. ` : "";
    return f.around ? "It is on the centre of the round edge, and stays there." : f.centered ? "It is in the middle of the face, and stays there." : f.from ? `${on}Type its two sizes from the edges, or drag its dot.` : `${on}Drag its dot to move it.`;
  }
}

/** The centre of a round edge from its start, middle and end (a whole circle: half way from start to middle). */
function centreOf(a: Vec3, m: Vec3, b: Vec3): Vec3 | null {
  if (dist(a, b) < 1e-7 * Math.max(1, dist(a, m))) return scale(add(a, m), 0.5);
  const ab = sub(m, a);
  const ac = sub(b, a);
  const n = cross(ab, ac);
  const n2 = dot(n, n);
  if (n2 < 1e-18) return null;
  const to = add(scale(cross(n, ab), dot(ac, ac)), scale(cross(ac, n), dot(ab, ab)));
  return add(a, scale(to, 1 / (2 * n2)));
}
