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
    const to = this.state();
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
    const to = this.state();
    to.roll += rad;
    this.go(to);
  }

  iso(): void {
    this.go({ ...this.state(), azimuth: MathUtils.degToRad(-60), elevation: MathUtils.degToRad(30), roll: 0 });
  }

  fit(box: Box3, animate = true): void {
    this.pivot = null;
    const finite = (v: Vector3) => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
    if (box.isEmpty() || !finite(box.min) || !finite(box.max)) box = new Box3(new Vector3(-50, -50, 0), new Vector3(50, 50, 20));
    const size = box.getSize(new Vector3()).length();
    const center = box.getCenter(new Vector3());
    // Fit the tighter of the vertical and horizontal fields of view (portrait phones).
    const tanV = Math.tan(MathUtils.degToRad(FOV / 2));
    const tanH = tanV * this.aspect;
    const distance = (Math.max(size, 0.01) / (2 * Math.min(tanV, tanH))) * 1.15;
    const to = { ...this.state(), target: center, distance };
    if (animate) this.go(to);
    else this.applyState(to);
  }

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

interface ViewState {
  target: Vector3;
  distance: number;
  azimuth: number;
  elevation: number;
  roll: number;
}
