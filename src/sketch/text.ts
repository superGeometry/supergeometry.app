// Text → closed outline polylines (each glyph contour; holes come out as regions).
// Fonts (all free, SIL OFL / Apache-2.0) parsed with opentype.js (MIT); you can
// also import your own .ttf / .otf / .woff. A font is only needed while placing
// text: the outlines are what's kept.

import { parse, type Font } from "opentype.js";
import roboto from "@fontsource/roboto/files/roboto-latin-400-normal.woff?url";
import robotoSlab from "@fontsource/roboto-slab/files/roboto-slab-latin-400-normal.woff?url";
import robotoMono from "@fontsource/roboto-mono/files/roboto-mono-latin-400-normal.woff?url";
import oswald from "@fontsource/oswald/files/oswald-latin-400-normal.woff?url";
import bebas from "@fontsource/bebas-neue/files/bebas-neue-latin-400-normal.woff?url";
import pacifico from "@fontsource/pacifico/files/pacifico-latin-400-normal.woff?url";
import type { SketchEntity, Vec2 } from "../doc/types";
import { uid } from "./edit";

/** The fonts to choose from (id → name, file). Imported ones are added at runtime. */
export const FONTS: { id: string; name: string; url?: string }[] = [
  { id: "roboto", name: "Sans", url: roboto },
  { id: "roboto-slab", name: "Serif", url: robotoSlab },
  { id: "roboto-mono", name: "Mono", url: robotoMono },
  { id: "oswald", name: "Narrow", url: oswald },
  { id: "bebas", name: "Bold caps", url: bebas },
  { id: "pacifico", name: "Script", url: pacifico },
];

const loaded = new Map<string, Promise<Font>>();
const STORE = "supergeometry.fonts.v1";

function loadFont(id: string): Promise<Font> {
  const hit = loaded.get(id);
  if (hit) return hit;
  const def = FONTS.find((f) => f.id === id) ?? FONTS[0];
  const p = fetch(def.url!)
    .then((r) => r.arrayBuffer())
    .then((b) => parse(b));
  loaded.set(def.id, p);
  return p;
}

/** Imported fonts, kept on this device (small ones; big ones last for this visit). */
(() => {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) ?? "[]") as { id: string; name: string; data: string }[];
    for (const f of saved) {
      const bytes = Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0));
      FONTS.push({ id: f.id, name: f.name });
      loaded.set(f.id, Promise.resolve(parse(bytes.buffer)));
    }
  } catch {
    // nothing saved
  }
})();

/** Add a font file (.ttf / .otf / .woff); returns its id. */
export async function importFont(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const font = parse(buf); // throws for files it can't read
  const name = (font.names.fontFamily?.en ?? file.name.replace(/\.[^.]+$/, "")).slice(0, 24);
  const id = `user-${Date.now().toString(36)}`;
  FONTS.push({ id, name });
  loaded.set(id, Promise.resolve(font));
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) ?? "[]");
    let bin = "";
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    saved.push({ id, name, data: btoa(bin) });
    localStorage.setItem(STORE, JSON.stringify(saved));
  } catch {
    // too big for this device's storage: it stays for this visit
  }
  return id;
}

/** Outline entities for `text` with its baseline-left at `at`, cap height ≈ size. */
export async function textEntities(text: string, at: Vec2, size: number, angle = 0, fontId = "roboto"): Promise<SketchEntity[]> {
  const f = await loadFont(fontId);
  // opentype sizes are em: scale so capitals are `size` tall (the font says how tall its caps are).
  const os2 = (f.tables as { os2?: { sCapHeight?: number } }).os2;
  const cap = os2?.sCapHeight ? os2.sCapHeight / f.unitsPerEm : 0.711;
  const fontSize = size / cap;
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
