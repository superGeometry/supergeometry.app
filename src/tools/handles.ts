import { ConeGeometry, Group, Mesh, MeshBasicMaterial, SphereGeometry, Vector3 } from "three";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import type { Vec3 } from "../doc/types";
import type { Viewport } from "../view/viewport";
import type { ToolPointer } from "../view/input";

// Amber, so a handle never disappears against the blue of a selection.
const COLOR = 0xffa31a;
const HOT = 0xffd27a;
const ARROW_PX = 84;

/**
 * A drag handle drawn at constant screen size: an arrow along a direction, or a
 * dot. `hit` tests in screen space so it's easy to grab with a finger.
 */
export class Handle {
  private group = new Group();
  private base = new Vector3();
  private dir = new Vector3(0, 0, 1);
  // Transparent (at full opacity) so it's drawn in the last pass, over see-through
  // selection highlights — three.js draws all opaque things before those.
  private mat = new MeshBasicMaterial({ color: COLOR, depthTest: false, transparent: true });
  private head: Mesh;
  private shaft: LineSegments2 | null = null;
  private lineMat;
  private onFrame = () => this.layout();

  constructor(private view: Viewport, readonly shape: "arrow" | "dot") {
    this.lineMat = view.lineMaterial(COLOR, 4);
    this.lineMat.transparent = true;
    this.head = new Mesh(shape === "arrow" ? new ConeGeometry(0.11, 0.3, 20) : new SphereGeometry(0.12, 20, 12), this.mat);
    this.head.renderOrder = 50;
    this.group.add(this.head);
    if (shape === "arrow") {
      this.shaft = new LineSegments2(new LineSegmentsGeometry(), this.lineMat);
      this.shaft.renderOrder = 50;
      this.group.add(this.shaft);
    }
    view.overlay.add(this.group);
    view.frameHooks.add(this.onFrame);
    view.helpers.add(this);
  }

  private hot = false;

  /** Highlight while the pointer is over it (brighter and a bit bigger). */
  setHot(on: boolean): void {
    if (on === this.hot) return;
    this.hot = on;
    this.mat.color.setHex(on ? HOT : COLOR);
    if (this.shaft) {
      this.view.releaseLineMaterial(this.lineMat);
      this.lineMat = this.view.lineMaterial(on ? HOT : COLOR, on ? 6 : 4);
      this.lineMat.transparent = true;
      this.shaft.material = this.lineMat;
    }
    this.layout();
    this.view.requestRender();
  }

  set(base: Vec3, dir?: Vec3): void {
    this.base.set(...base);
    if (dir) this.dir.set(...dir).normalize();
    this.layout();
    this.view.requestRender();
  }

  /** Screen position of the grabbable part. */
  grabPoint(): [number, number] | null {
    return this.view.toScreen(this.tip());
  }

  hit(p: ToolPointer): boolean {
    const s = this.grabPoint();
    return !!s && Math.hypot(s[0] - p.x, s[1] - p.y) < Math.max(30, p.tol * 1.8);
  }

  dispose(): void {
    this.view.helpers.delete(this);
    this.view.frameHooks.delete(this.onFrame);
    this.view.overlay.remove(this.group);
    this.head.geometry.dispose();
    this.shaft?.geometry.dispose();
    this.view.releaseLineMaterial(this.lineMat);
    this.view.requestRender();
  }

  private size(): number {
    return this.view.cam.worldPerPixel(this.view.height) * ARROW_PX;
  }

  private headScale(): number {
    return this.size() * (this.hot ? 1.45 : 1);
  }

  private tip(): Vector3 {
    return this.shape === "arrow" ? this.base.clone().addScaledVector(this.dir, this.size()) : this.base.clone();
  }

  private layout(): void {
    const s = this.size();
    this.head.scale.setScalar(this.headScale());
    if (this.shape === "arrow") {
      const tip = this.tip();
      this.head.position.copy(tip);
      this.head.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), this.dir);
      const start = this.base.clone().addScaledVector(this.dir, s * 0.12);
      (this.shaft!.geometry as LineSegmentsGeometry).setPositions([...start.toArray(), ...tip.toArray()]);
    } else {
      this.head.position.copy(this.base);
    }
  }
}

/** Screen-space drag along a world axis → signed world distance. */
/**
 * How far (world units, signed along `dir`) the pointer has dragged along the
 * line through `origin` in direction `dir`: the point of that line under the
 * finger, now minus at the start. Exact at any zoom and from any side — the
 * arrow always follows the finger: drag outward, it goes outward.
 */
export function axisDrag(view: Viewport, origin: Vec3, dir: Vec3, from: ToolPointer, to: ToolPointer): number {
  const dl = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  const d: Vec3 = [dir[0] / dl, dir[1] / dl, dir[2] / dl];
  const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  // Where along the line the pointer's ray passes closest.
  const along = (p: ToolPointer): number | null => {
    const r = view.pointerRay(p.x, p.y);
    const w: Vec3 = [origin[0] - r.o[0], origin[1] - r.o[1], origin[2] - r.o[2]];
    const b = dot3(d, r.d);
    const den = 1 - b * b;
    // Looking (almost) straight along the line: no good answer this way.
    if (den < 0.03) return null;
    return (b * dot3(r.d, w) - dot3(d, w)) / den;
  };
  const t0 = along(from);
  const t1 = along(to);
  if (t0 !== null && t1 !== null) return t1 - t0;
  // Nearly end-on: by the screen direction of a long piece of the line (or,
  // dead end-on, finger up = towards you).
  const wpp = view.cam.worldPerPixel(view.height);
  const L = wpp * 80;
  const o = new Vector3(...origin);
  const a = view.toScreen(o);
  const b = view.toScreen(o.clone().addScaledVector(new Vector3(...d), L));
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (a && b) {
    const vx = b[0] - a[0];
    const vy = b[1] - a[1];
    const l2 = vx * vx + vy * vy;
    if (l2 > 16) return ((dx * vx + dy * vy) / l2) * L;
  }
  const eye = view.pointerRay(view.width / 2, view.height / 2).d;
  const towardYou = dot3(d, eye) < 0 ? 1 : -1;
  return -dy * wpp * towardYou;
}
