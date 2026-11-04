// Text → closed outline polylines (each glyph contour; holes come out as regions).
// Font: Roboto (Apache-2.0), parsed with opentype.js (MIT).

import { parse, type Font } from "opentype.js";
import fontUrl from "@fontsource/roboto/files/roboto-latin-400-normal.woff?url";
import type { SketchEntity, Vec2 } from "../doc/types";
import { uid } from "./edit";

let font: Promise<Font> | null = null;

function loadFont(): Promise<Font> {
  font ??= fetch(fontUrl)
    .then((r) => r.arrayBuffer())
    .then((b) => parse(b));
  return font;
}

/** Outline entities for `text` with its baseline-left at `at`, cap height ≈ size. */
export async function textEntities(text: string, at: Vec2, size: number, angle = 0): Promise<SketchEntity[]> {
  const f = await loadFont();
  // opentype sizes are em; Roboto caps are ~0.71 em.
  const fontSize = size / 0.711;
  // Lay glyphs out ourselves: opentype's text shaper chokes on some of Roboto's
  // substitution tables ("substFormat 2 not supported").
  const scale = fontSize / f.unitsPerEm;
  const commands: { type: string; x?: number; y?: number; x1?: number; y1?: number; x2?: number; y2?: number }[] = [];
  let x = 0;
  let prev: ReturnType<Font["charToGlyph"]> | null = null;
  for (const ch of text) {
    const g = f.charToGlyph(ch);
    if (prev) x += f.getKerningValue(prev, g) * scale;
    commands.push(...g.getPath(x, 0, fontSize).commands);
    x += (g.advanceWidth ?? 0) * scale;
    prev = g;
  }
  const path = { commands } as { commands: Array<{ type: string; x: number; y: number; x1: number; y1: number; x2: number; y2: number }> };
  const contours: Vec2[][] = [];
  let cur: Vec2[] = [];
  let last: Vec2 = [0, 0];
  const push = (p: Vec2) => {
    cur.push(p);
    last = p;
  };
  const steps = 8;
  for (const c of path.commands) {
    if (c.type === "M") {
      if (cur.length > 2) contours.push(cur);
      cur = [];
      push([c.x, -c.y]);
    } else if (c.type === "L") push([c.x, -c.y]);
    else if (c.type === "Q") {
      const p0 = last;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const u = 1 - t;
        push([u * u * p0[0] + 2 * u * t * c.x1 + t * t * c.x, u * u * p0[1] + 2 * u * t * -c.y1 + t * t * -c.y]);
      }
    } else if (c.type === "C") {
      const p0 = last;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const u = 1 - t;
        push([
          u * u * u * p0[0] + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t * t * t * c.x,
          u * u * u * p0[1] + 3 * u * u * t * -c.y1 + 3 * u * t * t * -c.y2 + t * t * t * -c.y,
        ]);
      }
    } else if (c.type === "Z") {
      if (cur.length > 2) contours.push(cur);
      cur = [];
    }
  }
  if (cur.length > 2) contours.push(cur);
  const cs = Math.cos(angle);
  const sn = Math.sin(angle);
  return contours.map((pts) => {
    // Drop a duplicated closing point.
    const a = pts[0];
    const b = pts[pts.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9) pts.pop();
    return {
      id: uid(),
      kind: "polyline" as const,
      closed: true,
      points: pts.map(([x, y]) => [at[0] + x * cs - y * sn, at[1] + x * sn + y * cs] as Vec2),
    };
  });
}
