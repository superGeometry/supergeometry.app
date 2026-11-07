// Small vector / plane helpers shared by the UI and the kernel worker.

import type { PlaneDef, Vec2, Vec3 } from "./doc/types";

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const norm = (a: Vec3): Vec3 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
export const dist = (a: Vec3, b: Vec3): number => len(sub(a, b));

export const GROUND: PlaneDef = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] };
export const FRONT: PlaneDef = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, -1, 0] };
export const RIGHT: PlaneDef = { origin: [0, 0, 0], xDir: [0, 1, 0], normal: [1, 0, 0] };

export function planeY(p: PlaneDef): Vec3 {
  return cross(p.normal, p.xDir);
}

export function toWorld(p: PlaneDef, uv: Vec2): Vec3 {
  const y = planeY(p);
  return add(p.origin, add(scale(p.xDir, uv[0]), scale(y, uv[1])));
}

export function toPlane(p: PlaneDef, w: Vec3): Vec2 {
  const d = sub(w, p.origin);
  return [dot(d, p.xDir), dot(d, planeY(p))];
}

/** Pick a stable in-plane x direction for a face normal (world X if possible). */
export function xDirFor(normal: Vec3): Vec3 {
  const ref: Vec3 = Math.abs(normal[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1];
  // Project ref onto the plane; for vertical faces this gives a horizontal x axis.
  const x = Math.abs(normal[2]) > 0.9 ? ref : cross(ref, normal);
  const proj = sub(x, scale(normal, dot(x, normal)));
  return norm(proj);
}


/** Round to a "nice" step (0.1, 0.5, 1, 5, 10, …) close to `raw`. */
/**
 * The same plane with its origin where the model's origin falls on it: a
 * sketch on a face then measures X / Y from the model's origin (a face's own
 * centre moves as things are added to it - the pole typed at 0, 0 on a base
 * with letters and buttons landed at -0.9, 1.2).
 */
export function originOnPlane(p: PlaneDef): PlaneDef {
  const n = p.normal;
  const k = (p.origin[0] * n[0] + p.origin[1] * n[1] + p.origin[2] * n[2]) / (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
  return { ...p, origin: [n[0] * k, n[1] * k, n[2] * k] };
}

export function niceStep(raw: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  return (m < 2 ? 1 : m < 7 ? 5 : 10) * p;
}
