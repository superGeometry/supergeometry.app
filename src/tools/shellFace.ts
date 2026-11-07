import type { FaceRef } from "../doc/types";
import { dot, scale, sub } from "../geom";

/**
 * A face tapped on a shell's preview, as the face of the body before it was
 * hollowed: the same face, or else the flat face parallel to it at most a wall
 * away (the inside of an end, seen through the end already opened).
 */
export function faceBeforeShell(original: FaceRef[], r: FaceRef, thickness: number): FaceRef {
  const same = (o: FaceRef) => Math.hypot(...sub(o.center, r.center)) < 1e-3 && dot(o.normal, r.normal) > 0.999;
  if (!original.length || original.some(same)) return r;
  let best: { o: FaceRef; d: number } | null = null;
  for (const o of original) {
    if (Math.abs(dot(o.normal, r.normal)) < 0.999) continue;
    const off = sub(o.center, r.center);
    const d = Math.abs(dot(off, o.normal));
    const side = Math.hypot(...sub(off, scale(o.normal, dot(off, o.normal))));
    if (d <= thickness + 0.5 && side < Math.sqrt(o.area) && (!best || d < best.d)) best = { o, d };
  }
  return best?.o ?? r;
}
