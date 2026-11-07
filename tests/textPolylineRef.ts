// For tests/text.test.ts: how text was made before - every font curve cut into
// `refSteps` straight pieces - to compare the fitted outlines with.
//
// Text laid out as closed outline polylines (each glyph contour; holes come out
// as regions) from a parsed font. No font loading here, so it runs anywhere.

import type { Font } from "opentype.js";
import type { SketchEntity, Vec2 } from "../src/doc/types";
import { uid } from "../src/sketch/edit";

/** Where `at` sits along the baseline: the text's start, the middle of its ink, or the end of its ink. */
export type TextAlign = "left" | "center" | "right";

/** `text` with its capitals `size` tall, its baseline through `at` (aligned there by `align`), turned `angle` radians. */
export function polylineOutlines(
  refSteps: number,
  f: Font,
  text: string,
  at: Vec2,
  size: number,
  angle = 0,
  align: TextAlign = "left",
): SketchEntity[] {
  // opentype sizes are em: scale so capitals are `size` tall (the font says how tall its caps are).
  const os2 = (f.tables as { os2?: { sCapHeight?: number } }).os2;
  const cap = os2?.sCapHeight ? os2.sCapHeight / f.unitsPerEm : 0.711;
  const fontSize = size / cap;
  // Lay glyphs out ourselves: opentype's text shaper chokes on some of Roboto's
  // substitution tables ("substFormat 2 not supported").
  const scale = fontSize / f.unitsPerEm;
  const commands: {
    type: string;
    x?: number;
    y?: number;
    x1?: number;
    y1?: number;
    x2?: number;
    y2?: number;
  }[] = [];
  let x = 0;
  let prev: ReturnType<Font["charToGlyph"]> | null = null;
  for (const ch of text) {
    const g = f.charToGlyph(ch);
    if (prev) x += f.getKerningValue(prev, g) * scale;
    commands.push(...g.getPath(x, 0, fontSize).commands);
    x += (g.advanceWidth ?? 0) * scale;
    prev = g;
  }
  const path = { commands } as {
    commands: Array<{
      type: string;
      x: number;
      y: number;
      x1: number;
      y1: number;
      x2: number;
      y2: number;
    }>;
  };
  const contours: Vec2[][] = [];
  let cur: Vec2[] = [];
  let last: Vec2 = [0, 0];
  const push = (p: Vec2) => {
    cur.push(p);
    last = p;
  };
  // (the app used 8)
  const steps = refSteps;
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
        push([
          u * u * p0[0] + 2 * u * t * c.x1 + t * t * c.x,
          u * u * p0[1] + 2 * u * t * -c.y1 + t * t * -c.y,
        ]);
      }
    } else if (c.type === "C") {
      const p0 = last;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const u = 1 - t;
        push([
          u * u * u * p0[0] +
            3 * u * u * t * c.x1 +
            3 * u * t * t * c.x2 +
            t * t * t * c.x,
          u * u * u * p0[1] +
            3 * u * u * t * -c.y1 +
            3 * u * t * t * -c.y2 +
            t * t * t * -c.y,
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
  // Centred / right: by the ink, not the advance (a "1" is mostly side bearing).
  let dx = 0;
  if (align !== "left" && contours.length) {
    const xs = contours.flat().map((p) => p[0]);
    const lo = Math.min(...xs), hi = Math.max(...xs);
    dx = align === "center" ? -(lo + hi) / 2 : -hi;
  }
  // Points closer than this are one point: fonts repeat a point where a curve
  // meets a line (an "8" in Roboto), and a zero-length edge can't be made into
  // a face - the text then fails to extrude or cut.
  const tiny = size * 1e-3;
  return contours
    .map((raw) => {
      const pts: Vec2[] = [];
      for (const p of raw)
        if (
          !pts.length ||
          Math.hypot(
            p[0] - pts[pts.length - 1][0],
            p[1] - pts[pts.length - 1][1],
          ) > tiny
        )
          pts.push(p);
      // …and the closing point repeating the first.
      while (
        pts.length > 1 &&
        Math.hypot(
          pts[0][0] - pts[pts.length - 1][0],
          pts[0][1] - pts[pts.length - 1][1],
        ) <= tiny
      )
        pts.pop();
      return pts;
    })
    .filter((pts) => pts.length >= 3)
    .map((pts) => {
      return {
        id: uid(),
        kind: "polyline" as const,
        closed: true,
        points: pts.map(
          ([x, y]) =>
            [at[0] + (x + dx) * cs - y * sn, at[1] + (x + dx) * sn + y * cs] as Vec2,
        ),
      };
    });
}
