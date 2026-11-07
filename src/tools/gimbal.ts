// Move/rotate gimbal: three axis arrows, three plane squares, three rotation
// arcs and a centre ball. Drawn at constant screen size; hit-tested on screen.

import { BoxGeometry, BufferGeometry, ConeGeometry, DoubleSide, Group, Mesh, MeshBasicMaterial, PlaneGeometry, SphereGeometry, Vector3 } from "three";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import type { Vec3 } from "../doc/types";
import type { ToolPointer } from "../view/input";
import type { Viewport } from "../view/viewport";

export type GimbalPart = { kind: "axis" | "plane" | "ring"; i: 0 | 1 | 2 } | { kind: "center" };

const AXES: Vec3[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
const COLORS = [0xe0584f, 0x5fbf5a, 0x4f8ce0];
const SIZE_PX = 85;
const ARC_FROM = 0.25;
const ARC_TO = 1.32;

/** Points of the rotation arc around axis i, in unit gimbal space. */
function arcPoints(axes: Vec3[], i: number, n = 24): Vector3[] {
  const u = new Vector3(...axes[(i + 1) % 3]);
  const v = new Vector3(...axes[(i + 2) % 3]);
  return Array.from({ length: n + 1 }, (_, k) => {
    const t = ARC_FROM + ((ARC_TO - ARC_FROM) * k) / n;
    return u.clone().multiplyScalar(Math.cos(t) * 1.1).addScaledVector(v, Math.sin(t) * 1.1);
  });
}

export interface GimbalOptions {
  /** The three axes (default world X, Y, Z). For a sketch: plane x, plane y, normal. */
  axes?: Vec3[];
  /** Which parts exist (e.g. a sketch gimbal has no out-of-plane arrow). */
  parts?: (p: GimbalPart) => boolean;
  /** Cube ends instead of arrow heads: the scale gimbal. */
  cubes?: boolean;
}

/** Scale gimbal: the three axis handles (cube ends) and the centre (uniform). */
export const SCALE_PARTS = (p: GimbalPart) => p.kind === "axis" || p.kind === "center";

/** Parts of a gimbal that keep things in a plane whose normal is axis 2. */
export const IN_PLANE = (p: GimbalPart) => p.kind === "center" || (p.kind === "axis" && p.i < 2) || (p.kind !== "axis" && p.i === 2);

export class Gimbal {
  private group = new Group();
  private center = new Vector3();
  private parts: { part: GimbalPart; obj: Group | Mesh | LineSegments2; color: number }[] = [];
  private hook = () => this.layout();
  private hot: GimbalPart | null = null;
  readonly axes: Vec3[];
  private allow: (p: GimbalPart) => boolean;

  constructor(
    private view: Viewport,
    opts: GimbalOptions = {},
  ) {
    this.axes = opts.axes ?? AXES;
    this.allow = opts.parts ?? (() => true);
    const AX = this.axes;
    AX.forEach((a, i) => {
      const dir = new Vector3(...a);
      const color = COLORS[i];
      // Axis arrow
      const arrow = new Group();
      const shaft = new LineSegments2(new LineSegmentsGeometry().setPositions([...dir.clone().multiplyScalar(0.18).toArray(), ...dir.clone().multiplyScalar(0.82).toArray()]), view.lineMaterial(color, 3.5));
      const head = new Mesh(opts.cubes ? new BoxGeometry(0.15, 0.15, 0.15) : new ConeGeometry(0.07, 0.22, 16), new MeshBasicMaterial({ color, depthTest: false }));
      head.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), dir);
      head.position.copy(dir).multiplyScalar(0.9);
      arrow.add(shaft, head);
      this.add({ kind: "axis", i: i as 0 | 1 | 2 }, arrow, color);
      // Plane square (moves in the plane perpendicular to this axis)
      const u = new Vector3(...AX[(i + 1) % 3]);
      const v = new Vector3(...AX[(i + 2) % 3]);
      const sq = new Mesh(new PlaneGeometry(0.17, 0.17), new MeshBasicMaterial({ color, transparent: true, opacity: 0.55, side: DoubleSide, depthTest: false }));
      sq.position.copy(u.clone().add(v).multiplyScalar(0.33));
      sq.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), dir);
      this.add({ kind: "plane", i: i as 0 | 1 | 2 }, sq, color);
      // Rotation arc
      const pts = arcPoints(AX, i);
      const seg: number[] = [];
      for (let k = 0; k < pts.length - 1; k++) seg.push(...pts[k].toArray(), ...pts[k + 1].toArray());
      const arc = new LineSegments2(new LineSegmentsGeometry().setPositions(seg), view.lineMaterial(color, 3));
      this.add({ kind: "ring", i: i as 0 | 1 | 2 }, arc, color);
    });
    const ball = new Mesh(new SphereGeometry(0.075, 16, 12), new MeshBasicMaterial({ color: 0xffffff, depthTest: false }));
    this.add({ kind: "center" }, ball, 0xffffff);
    // Over everything, selection highlights included (see Handle).
    this.group.traverse((o) => {
      o.renderOrder = 50;
      const m = (o as Mesh).material as MeshBasicMaterial | undefined;
      if (m && "transparent" in m) m.transparent = true;
    });
    view.overlay.add(this.group);
    view.frameHooks.add(this.hook);
    view.helpers.add(this);
  }

  private add(part: GimbalPart, obj: Group | Mesh | LineSegments2, color: number): void {
    obj.visible = this.allow(part);
    this.parts.push({ part, obj, color });
    this.group.add(obj);
  }

  setCenter(c: Vec3): void {
    this.center.set(...c);
    this.layout();
    this.view.requestRender();
  }

  get origin(): Vec3 {
    return this.center.toArray() as Vec3;
  }

  private scale(): number {
    return this.view.cam.worldPerPixel(this.view.height) * SIZE_PX;
  }

  private layout(): void {
    this.group.position.copy(this.center);
    this.group.scale.setScalar(this.scale());
  }

  private screen(local: Vector3): [number, number] | null {
    return this.view.toScreen(local.clone().multiplyScalar(this.scale()).add(this.center));
  }

  /** Which part is under the pointer (centre, planes, arrows, arcs - in that order). */
  hit(p: ToolPointer): GimbalPart | null {
    const tol = Math.max(10, p.tol * 1.2);
    const c = this.screen(new Vector3());
    if (c && this.allow({ kind: "center" }) && Math.hypot(c[0] - p.x, c[1] - p.y) < tol) return { kind: "center" };
    for (let i = 0; i < 3; i++) {
      if (!this.allow({ kind: "plane", i: i as 0 | 1 | 2 })) continue;
      const u = new Vector3(...this.axes[(i + 1) % 3]);
      const v = new Vector3(...this.axes[(i + 2) % 3]);
      const m = u.clone().add(v).multiplyScalar(0.33);
      const quad = [m.clone().addScaledVector(u, -0.085).addScaledVector(v, -0.085), m.clone().addScaledVector(u, 0.085).addScaledVector(v, -0.085), m.clone().addScaledVector(u, 0.085).addScaledVector(v, 0.085), m.clone().addScaledVector(u, -0.085).addScaledVector(v, 0.085)]
        .map((q) => this.screen(q))
        .filter((q): q is [number, number] => !!q);
      if (quad.length === 4 && inPoly(p.x, p.y, quad)) return { kind: "plane", i: i as 0 | 1 | 2 };
    }
    let best: { part: GimbalPart; d: number } | null = null;
    for (let i = 0; i < 3; i++) {
      const dir = new Vector3(...this.axes[i]);
      const a = this.screen(dir.clone().multiplyScalar(0.18));
      const b = this.screen(dir.clone().multiplyScalar(1.02));
      if (a && b && this.allow({ kind: "axis", i: i as 0 | 1 | 2 })) {
        const d = segDist(p.x, p.y, a, b);
        if (d < tol && (!best || d < best.d)) best = { part: { kind: "axis", i: i as 0 | 1 | 2 }, d };
      }
      const pts = this.allow({ kind: "ring", i: i as 0 | 1 | 2 }) ? arcPoints(this.axes, i, 16).map((q) => this.screen(q)) : [];
      for (let k = 0; k < pts.length - 1; k++) {
        const s0 = pts[k];
        const s1 = pts[k + 1];
        if (!s0 || !s1) continue;
        const d = segDist(p.x, p.y, s0, s1);
        if (d < tol && (!best || d < best.d)) best = { part: { kind: "ring", i: i as 0 | 1 | 2 }, d };
      }
    }
    return best?.part ?? null;
  }

  /** Brighten the part under the pointer / being dragged. */
  setHot(part: GimbalPart | null): void {
    if (JSON.stringify(part) === JSON.stringify(this.hot)) return;
    this.hot = part;
    for (const { part: q, obj, color } of this.parts) {
      const on = !!part && JSON.stringify(part) === JSON.stringify(q);
      obj.traverse((o) => {
        const m = (o as Mesh).material as MeshBasicMaterial & { color?: { setHex(n: number): void } };
        if (m?.color) m.color.setHex(on ? 0xffd34d : color);
      });
    }
    this.view.requestRender();
  }

  dispose(): void {
    this.view.helpers.delete(this);
    this.view.frameHooks.delete(this.hook);
    this.view.overlay.remove(this.group);
    this.group.traverse((o) => {
      const m = o as Mesh;
      if (m.geometry instanceof BufferGeometry) m.geometry.dispose();
      if (m.material instanceof LineMaterial) this.view.releaseLineMaterial(m.material);
    });
    this.view.requestRender();
  }
}

export const GIMBAL_AXES = AXES;

function segDist(x: number, y: number, a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l2));
  return Math.hypot(a[0] + dx * t - x, a[1] + dy * t - y);
}

function inPoly(x: number, y: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
