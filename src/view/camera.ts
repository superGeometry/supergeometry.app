import { Box3, MathUtils, OrthographicCamera, PerspectiveCamera, Quaternion, Vector3, type Camera } from "three";
import type { SavedView, Vec3 } from "../doc/types";

const UP = new Vector3(0, 0, 1);
const FOV = 40;

/**
 * Z-up orbit camera: azimuth around Z, elevation above the XY plane.
 * Perspective and orthographic share target/distance, so switching is seamless.
 */
export class CameraController {
  readonly persp: PerspectiveCamera;
  readonly orthoCam: OrthographicCamera;
  ortho = false;
  target = new Vector3(0, 0, 0);
  distance = 300;
  azimuth = MathUtils.degToRad(-60);
  elevation = MathUtils.degToRad(30);
  /** Roll around the view direction (used for face-on views, rotated 90° steps). */
  roll = 0;
  animate = true;
  /** A chosen point to orbit around (else the view turns about its target). Zoom to fit clears it. */
  pivot: Vector3 | null = null;
  private aspect = 1;
  private animation: { from: ViewState; to: ViewState; t0: number } | null = null;

  constructor(aspect: number) {
    this.persp = new PerspectiveCamera(FOV, aspect, 0.1, 1e7);
    this.orthoCam = new OrthographicCamera(-1, 1, 1, -1, -1e7, 1e7);
    this.aspect = aspect;
    this.update();
  }

  get camera(): PerspectiveCamera | OrthographicCamera {
    return this.ortho ? this.orthoCam : this.persp;
  }

  setAspect(a: number): void {
    this.aspect = a;
    this.update();
  }

  setOrtho(on: boolean): void {
    this.ortho = on;
    this.update();
  }

  orbit(dxPx: number, dyPx: number): void {
    this.animation = null;
    this.roll = 0;
    const az0 = this.azimuth;
    const el0 = this.elevation;
    this.azimuth -= dxPx * 0.006;
    this.elevation = MathUtils.clamp(this.elevation + dyPx * 0.006, -Math.PI / 2 + 1e-4, Math.PI / 2 - 1e-4);
    if (this.pivot) {
      // Turn the target about the pivot the same way the view turned, so the
      // pivot stays put on screen: first about Z (azimuth), then about the
      // view's sideways axis (elevation).
      const right0 = new Vector3(-Math.sin(az0), Math.cos(az0), 0);
      const qEl = new Quaternion().setFromAxisAngle(right0, -(this.elevation - el0));
      const qAz = new Quaternion().setFromAxisAngle(UP, this.azimuth - az0);
      const rel = this.target.clone().sub(this.pivot).applyQuaternion(qEl).applyQuaternion(qAz);
      this.target.copy(this.pivot).add(rel);
    }
    this.update();
  }

  /** Pan so the scene follows the pointer. */
  pan(dxPx: number, dyPx: number, viewportHeight: number): void {
    this.animation = null;
    const worldPerPx = this.worldPerPixel(viewportHeight);
    const right = new Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const up = new Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
    this.target.addScaledVector(right, -dxPx * worldPerPx).addScaledVector(up, dyPx * worldPerPx);
    this.update();
  }

  /** factor < 1 zooms in. `toward` keeps that world point under the pointer. */
  zoom(factor: number, toward?: Vector3): void {
    this.animation = null;
    // 0.001 mm … 1 000 000 mm scenes.
    const newDist = MathUtils.clamp(this.distance * factor, 0.005, 5e6);
    // A point far off (the ground at the horizon, a bad hit) would fling the
    // target away: zoom straight in instead.
    if (toward && (!Number.isFinite(toward.x + toward.y + toward.z) || toward.distanceTo(this.target) > this.distance * 20)) toward = undefined;
    if (toward) {
      const k = 1 - newDist / this.distance;
      if (this.ortho) {
        // In ortho, only move sideways (depth doesn't change what's under the cursor).
        const view = this.viewDir();
        const t = toward.clone().sub(this.target);
        t.addScaledVector(view, -t.dot(view));
        this.target.addScaledVector(t, k);
      } else {
        this.target.lerp(toward, k);
      }
    }
    this.distance = newDist;
    this.update();
  }

  worldPerPixel(viewportHeight: number): number {
    return (2 * this.distance * Math.tan(MathUtils.degToRad(FOV / 2))) / viewportHeight;
  }

  /** Unit vector from the camera towards the target. */
  viewDir(): Vector3 {
    return this.target.clone().sub(this.camera.position).normalize();
  }

  /**
   * Look along -normal at the target. `xDir` (optional) is the world direction
   * that should point right on screen, e.g. a sketch plane's x axis.
   */
  lookAlong(normal: Vec3, xDir?: Vec3, target?: Vec3): void {
    const n = new Vector3(...normal).normalize();
    const to = this.aim();
    if (target) to.target = new Vector3(...target);
    to.elevation = MathUtils.clamp(Math.asin(n.z), -Math.PI / 2 + 1e-4, Math.PI / 2 - 1e-4);
    to.roll = 0;
    const x = new Vector3(...(xDir ?? [1, 0, 0]));
    if (Math.abs(n.z) > 0.999) {
      // Top/bottom: at the poles the screen's right is (-sin a, cos a, 0).
      to.azimuth = Math.atan2(-x.x, x.y);
    } else {
      to.azimuth = Math.atan2(n.y, n.x);
      if (xDir) {
        // Tilted planes: roll so xDir points right on screen.
        const d = new Vector3(...normal).normalize();
        const right = new Vector3().crossVectors(UP, d).normalize();
        const up = new Vector3().crossVectors(d, right);
        to.roll = Math.atan2(x.dot(up), x.dot(right));
      }
    }
    this.go(to);
  }

  /** Rotate the view 90° around the view direction (view cube arrows). */
  rollBy(rad: number): void {
    const to = this.aim();
    to.roll += rad;
    this.go(to);
  }

  iso(): void {
    this.go({ ...this.aim(), azimuth: MathUtils.degToRad(-60), elevation: MathUtils.degToRad(30), roll: 0 });
  }

  /**
   * Frame `box`. `free` is the part of the screen not covered by tool columns
   * and bars (fractions of the width/height covered on each side): the model is
   * fitted into that and centred in it — on a phone the columns cover a fifth
   * of each side, and a ruler fitted to the whole screen lost both ends.
   */
  fit(box: Box3, animate = true, free: Insets = NO_INSETS): void {
    this.pivot = null;
    const finite = (v: Vector3) => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
    if (box.isEmpty() || !finite(box.min) || !finite(box.max)) box = new Box3(new Vector3(-50, -50, 0), new Vector3(50, 50, 20));
    const center = box.getCenter(new Vector3());
    const to = this.aim();
    const { right, up, back } = this.axes(to);
    // The box as the destination view sees it: its half extent across and up
    // the screen, and how far its nearest corner comes towards the camera.
    let hw = 0, hh = 0, hd = 0;
    for (let i = 0; i < 8; i++) {
      const c = new Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).sub(center);
      hw = Math.max(hw, Math.abs(c.dot(right)));
      hh = Math.max(hh, Math.abs(c.dot(up)));
      hd = Math.max(hd, c.dot(back));
    }
    const s = Math.max(hw, hh, 0.005);
    hw = Math.max(hw, s * 0.02);
    hh = Math.max(hh, s * 0.02);
    const fw = Math.max(0.3, 1 - free.left - free.right);
    const fh = Math.max(0.3, 1 - free.top - free.bottom);
    const tanV = Math.tan(MathUtils.degToRad(FOV / 2));
    const tanH = tanV * this.aspect;
    // Half the free width at distance d is d·tanH·fw; a margin of 12 % around.
    const distance = Math.max(hw / (tanH * fw), hh / (tanV * fh)) * 1.12 + (this.ortho ? 0 : hd);
    // Put the box's centre in the middle of the free area, not of the screen.
    const ox = ((free.left - free.right) / 2) * 2 * distance * tanH;
    const oy = ((free.top - free.bottom) / 2) * 2 * distance * tanV;
    const target = center.clone().addScaledVector(right, -ox).addScaledVector(up, oy);
    const dest = { ...to, target, distance };
    // Perspective swells the near side of a deep model, and not about the
    // free area's centre: project the corners and correct, a few times over.
    const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => new Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z));
    const fx = free.left + fw / 2, fy = free.top + fh / 2;
    for (let it = 0; it < 10; it++) {
      const eye = dest.target.clone().addScaledVector(back, dest.distance);
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, near = dest.distance;
      for (const c of corners) {
        const v = c.clone().sub(eye);
        const depth = this.ortho ? dest.distance : Math.max(1e-9, -v.dot(back));
        near = Math.min(near, depth);
        const sx = (v.dot(right) / (depth * tanH) + 1) / 2;
        const sy = (1 - v.dot(up) / (depth * tanV)) / 2;
        x0 = Math.min(x0, sx), x1 = Math.max(x1, sx), y0 = Math.min(y0, sy), y1 = Math.max(y1, sy);
      }
      const k = Math.max((x1 - x0) / (fw / 1.12), (y1 - y0) / (fh / 1.12), 1e-6);
      const dx = (x0 + x1) / 2 - fx, dy = (y0 + y1) / 2 - fy;
      if (Math.abs(k - 1) < 0.01 && Math.abs(dx) < 0.002 && Math.abs(dy) < 0.002) break;
      // The extremes are mostly the near corners: they move by the shift over their own depth.
      dest.target.addScaledVector(right, dx * 2 * near * tanH).addScaledVector(up, -dy * 2 * near * tanV);
      dest.distance *= k;
    }
    if (animate) this.go(dest);
    else this.applyState(dest);
  }

  /** The screen's right, up and towards-the-viewer directions for a view state. */
  private axes(s: ViewState): { right: Vector3; up: Vector3; back: Vector3 } {
    const ce = Math.cos(s.elevation);
    const dir = new Vector3(ce * Math.cos(s.azimuth), ce * Math.sin(s.azimuth), Math.sin(s.elevation));
    const cam = this.scratch;
    cam.position.copy(dir);
    cam.up.copy(UP);
    if (Math.abs(dir.z) > 0.99) cam.up.set(-Math.cos(s.azimuth) * Math.sign(dir.z), -Math.sin(s.azimuth) * Math.sign(dir.z), 0);
    cam.lookAt(0, 0, 0);
    if (s.roll) cam.rotateZ(s.roll);
    cam.updateMatrixWorld();
    return {
      right: new Vector3().setFromMatrixColumn(cam.matrixWorld, 0),
      up: new Vector3().setFromMatrixColumn(cam.matrixWorld, 1),
      back: new Vector3().setFromMatrixColumn(cam.matrixWorld, 2),
    };
  }
  private scratch = new PerspectiveCamera();

  savedView(name: string): SavedView {
    return { name, target: this.target.toArray() as Vec3, distance: this.distance, azimuth: this.azimuth, elevation: this.elevation, ortho: this.ortho };
  }

  restore(v: SavedView): void {
    this.ortho = v.ortho;
    this.go({ target: new Vector3(...v.target), distance: v.distance, azimuth: v.azimuth, elevation: v.elevation, roll: 0 });
  }

  /** Advance animations; returns true while animating. */
  tick(now: number): boolean {
    if (!this.animation) return false;
    const { from, to, t0 } = this.animation;
    const t = Math.min(1, (now - t0) / 380);
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    let dAz = to.azimuth - from.azimuth;
    dAz = Math.atan2(Math.sin(dAz), Math.cos(dAz));
    let dRoll = to.roll - from.roll;
    dRoll = Math.atan2(Math.sin(dRoll), Math.cos(dRoll));
    this.applyState(
      {
        target: from.target.clone().lerp(to.target, e),
        distance: MathUtils.lerp(from.distance, to.distance, e),
        azimuth: from.azimuth + dAz * e,
        elevation: MathUtils.lerp(from.elevation, to.elevation, e),
        roll: from.roll + dRoll * e,
      },
    );
    if (t >= 1) this.animation = null;
    return true;
  }

  get animating(): boolean {
    return this.animation !== null;
  }

  private state(): ViewState {
    return { target: this.target.clone(), distance: this.distance, azimuth: this.azimuth, elevation: this.elevation, roll: this.roll };
  }

  /**
   * Where the view is heading: the end of a move still animating, else where it
   * is. A new move builds on this — Fit tapped while a turn to Top is still
   * animating must keep the Top, not freeze it half way round.
   */
  private aim(): ViewState {
    const a = this.animation;
    return a ? { ...a.to, target: a.to.target.clone() } : this.state();
  }

  private go(to: ViewState): void {
    if (!this.animate) {
      this.applyState(to);
      return;
    }
    this.animation = { from: this.state(), to, t0: performance.now() };
  }

  private applyState(s: ViewState): void {
    // Never take a broken view (NaN/Infinity would blank everything, grid included).
    const ok = [s.target.x, s.target.y, s.target.z, s.distance, s.azimuth, s.elevation, s.roll].every(Number.isFinite) && s.distance > 0;
    if (!ok) return;
    this.target.copy(s.target);
    this.distance = s.distance;
    this.azimuth = s.azimuth;
    this.elevation = s.elevation;
    this.roll = s.roll;
    this.update();
  }

  /** The last view that was valid: restored if something ever corrupts it. */
  private good: ViewState | null = null;

  update(): void {
    const valid = [this.target.x, this.target.y, this.target.z, this.distance, this.azimuth, this.elevation, this.roll].every(Number.isFinite) && this.distance > 0;
    if (!valid) {
      const g = this.good ?? { target: new Vector3(), distance: 300, azimuth: MathUtils.degToRad(-60), elevation: MathUtils.degToRad(30), roll: 0 };
      this.target.copy(g.target);
      Object.assign(this, { distance: g.distance, azimuth: g.azimuth, elevation: g.elevation, roll: g.roll });
      this.animation = null;
    } else this.good = this.state();
    const ce = Math.cos(this.elevation);
    const dir = new Vector3(ce * Math.cos(this.azimuth), ce * Math.sin(this.azimuth), Math.sin(this.elevation));
    for (const cam of [this.persp, this.orthoCam] as Camera[]) {
      cam.position.copy(this.target).addScaledVector(dir, this.distance);
      cam.up.copy(UP);
      // Near the poles, derive "up" from the azimuth so the view doesn't spin.
      if (Math.abs(dir.z) > 0.99) cam.up.set(-Math.cos(this.azimuth) * Math.sign(dir.z), -Math.sin(this.azimuth) * Math.sign(dir.z), 0);
      cam.lookAt(this.target);
      if (this.roll) cam.rotateZ(this.roll);
    }
    this.persp.aspect = this.aspect;
    this.persp.near = Math.max(1e-4, this.distance / 2000);
    this.persp.far = this.distance * 2000;
    this.persp.updateProjectionMatrix();
    const h = this.distance * Math.tan(MathUtils.degToRad(FOV / 2));
    Object.assign(this.orthoCam, { left: -h * this.aspect, right: h * this.aspect, top: h, bottom: -h });
    this.orthoCam.near = -this.distance * 1000;
    this.orthoCam.far = this.distance * 1000;
    this.orthoCam.updateProjectionMatrix();
    this.persp.updateMatrixWorld();
    this.orthoCam.updateMatrixWorld();
  }
}

/** How much of the screen tool columns and bars cover on each side (0–1 of the width/height). */
export interface Insets {
  left: number;
  right: number;
  top: number;
  bottom: number;
}
const NO_INSETS: Insets = { left: 0, right: 0, top: 0, bottom: 0 };

interface ViewState {
  target: Vector3;
  distance: number;
  azimuth: number;
  elevation: number;
  roll: number;
}
