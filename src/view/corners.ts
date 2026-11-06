import { Vector3 } from "three";
import type { Vec3 } from "../doc/types";

/**
 * The corners of a body: its edges' ends, each once (within 1e-6), in the
 * order first met — selections refer to corners by that number. Found by
 * position in a grid of cells (comparing each end with every corner so far
 * took 0.3 s for a ruler's 11 000 edges).
 */
export function uniqueEnds(edges: readonly { start: Vec3; end: Vec3 }[]): Vector3[] {
  const out: Vector3[] = [];
  // Cells by a hash of their coordinates (two cells sharing a hash is
  // harmless: the distance check still decides).
  const cells = new Map<number, number[]>();
  const h = (x: number, y: number, z: number) => (Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663) ^ Math.imul(z | 0, 83492791)) | 0;
  const C = 1e-6;
  for (const e of edges)
    for (const p of [e.start, e.end]) {
      const v = new Vector3(p[0], p[1], p[2]);
      const cx = Math.floor(p[0] / C), cy = Math.floor(p[1] / C), cz = Math.floor(p[2] / C);
      let found = false;
      for (let dx = -1; dx <= 1 && !found; dx++)
        for (let dy = -1; dy <= 1 && !found; dy++)
          for (let dz = -1; dz <= 1 && !found; dz++) {
            const l = cells.get(h(cx + dx, cy + dy, cz + dz));
            if (l) for (const i of l) if (out[i].distanceToSquared(v) < 1e-12) { found = true; break; }
          }
      if (found) continue;
      const k = h(cx, cy, cz);
      const l = cells.get(k);
      if (l) l.push(out.length);
      else cells.set(k, [out.length]);
      out.push(v);
    }
  return out;
}
