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
import { textOutlines } from "./textLayout";

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
  return textOutlines(await loadFont(fontId), text, at, size, angle);
}
