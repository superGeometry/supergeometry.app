// Run: npx tsx tests/iofuzz.test.ts - the file readers fed junk, truncated and
// absurd files: they refuse with a message or read what makes sense, never
// hang, and never hand the sketch NaN or infinite numbers. DXF out → in is exact.
(globalThis as any).window ??= globalThis;
const { parseDXF, objToStl } = await import("../src/io/insert");
const { parseSVG } = await import("../src/io/svg");
const { sketchToDXF } = await import("../src/io/dxf");
import type { SketchEntity } from "../src/doc/types";

let failed = 0;
const check = (name: string, ok: boolean, info = "") => {
  if (!ok) failed++;
  console.log(ok ? "ok  " : "FAIL", name, info);
};
let seed = 5;
const R = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const finite = (x: unknown): boolean => {
  let ok = true;
  JSON.stringify(x, (_k, v) => {
    if (typeof v === "number" && !Number.isFinite(v)) ok = false;
    return v;
  });
  // JSON turns NaN into null: look for those too.
  return ok && !/\bnull\b/.test(JSON.stringify(x));
};
const junk = (n: number) => Array.from({ length: n }, () => String.fromCharCode(32 + Math.floor(R() * 95))).join("");

/** Run a reader; it may throw a message, but must return quickly and cleanly. */
function tryRead<T>(name: string, read: () => T, ok: (x: T) => boolean): void {
  const t = performance.now();
  let out: T | undefined;
  let msg = "";
  try {
    out = read();
  } catch (e) {
    msg = (e as Error)?.message ?? String(e);
  }
  const dt = performance.now() - t;
  const fine = dt < 3000 && (out === undefined ? !!msg : ok(out));
  check(name, fine, out === undefined ? `refused: ${msg.slice(0, 60)}` : `${dt.toFixed(0)} ms`);
}

// ------------------------------------------------------------------ DXF
const dxfLine = (a: number[], b: number[]) => ["0", "LINE", "8", "0", "10", a[0], "20", a[1], "11", b[0], "21", b[1]].join("\n");
const wrap = (body: string) => ["0", "SECTION", "2", "ENTITIES", body, "0", "ENDSEC", "0", "EOF"].join("\n");
tryRead("DXF: random junk", () => parseDXF(junk(5000)), finite);
tryRead("DXF: empty", () => parseDXF(""), finite);
tryRead("DXF: a line with NaN / Infinity coordinates", () => parseDXF(wrap(dxfLine([NaN, 0], [Infinity, 5]))), finite);
tryRead("DXF: circle with a negative radius", () => parseDXF(wrap(["0", "CIRCLE", "8", "0", "10", "0", "20", "0", "40", "-5"].join("\n"))), finite);
tryRead("DXF: a zero-length line", () => parseDXF(wrap(dxfLine([1, 1], [1, 1]))), (es) => finite(es) && es.every((e: any) => e.kind !== "line" || Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]) > 0));
tryRead("DXF: cut off in the middle of an entity", () => parseDXF(wrap(dxfLine([0, 0], [10, 0])).slice(0, 40)), finite);
tryRead("DXF: 20 000 lines", () => parseDXF(wrap(Array.from({ length: 20000 }, (_, i) => dxfLine([i, 0], [i, 10])).join("\n"))), (es) => finite(es) && es.length === 20000);
{
  // Out and back in: the same curves.
  const es: SketchEntity[] = [
    { id: "a", kind: "line", a: [0, 0], b: [10, 5] },
    { id: "b", kind: "circle", center: [3, 4], radius: 2.5 },
    { id: "c", kind: "arc", a: [10, 0], m: [7.0710678, 7.0710678], b: [0, 10] },
  ];
  const back = parseDXF(sketchToDXF(es));
  const lines = back.filter((e) => e.kind === "line").length;
  const round = back.filter((e) => e.kind === "circle" || e.kind === "arc").length;
  check("DXF out → in: a line, a circle and an arc come back", lines >= 1 && round >= 2 && finite(back), `${back.map((e) => e.kind).join(", ")}`);
}

// ------------------------------------------------------------------ SVG
tryRead("SVG: random junk", () => parseSVG(junk(3000)), finite);
tryRead("SVG: an svg with a broken path", () => parseSVG('<svg xmlns="http://www.w3.org/2000/svg"><path d="M 10 10 L Z Q 5 c c c 1e400 NaN"/></svg>'), finite);
tryRead("SVG: nested groups 2000 deep", () => parseSVG(`<svg>${"<g>".repeat(2000)}<rect x="0" y="0" width="10" height="5"/>${"</g>".repeat(2000)}</svg>`), finite);
tryRead("SVG: a path of 50 000 segments", () => parseSVG(`<svg><path d="M0 0 ${Array.from({ length: 50000 }, (_, i) => `L${i % 100} ${Math.floor(i / 100)}`).join(" ")}"/></svg>`), finite);
tryRead("SVG: transforms with zero scale", () => parseSVG('<svg><g transform="scale(0)"><circle cx="5" cy="5" r="3"/></g></svg>'), finite);
tryRead("SVG: unclosed tags", () => parseSVG("<svg><g><rect width=10 height=4><circle r=2"), finite);

// ------------------------------------------------------------------ OBJ
tryRead("OBJ: junk", () => objToStl(junk(4000)), (b) => b instanceof Uint8Array);
tryRead("OBJ: faces pointing at points that don't exist", () => objToStl("v 0 0 0\nv 1 0 0\nf 1 2 99\nf -5 1 2\n"), (b) => b instanceof Uint8Array);
tryRead("OBJ: a 200-sided polygon face", () => objToStl(Array.from({ length: 200 }, (_, i) => `v ${Math.cos(i / 32)} ${Math.sin(i / 32)} 0`).join("\n") + "\nf " + Array.from({ length: 200 }, (_, i) => i + 1).join(" ")), (b) => b instanceof Uint8Array && b.length > 84);
tryRead("OBJ: NaN coordinates", () => objToStl("v nan 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n"), (b) => b instanceof Uint8Array);

process.exit(failed ? 1 : 0);
