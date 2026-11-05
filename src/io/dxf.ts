// DXF export of a sketch (for laser cutters, CNC, other 2D/3D programs).
// AutoCAD R12 DXF (the most widely read): lines, arcs and circles stay exact;
// ellipses and splines become fine polylines. Millimetres, in the sketch's own
// 2D coordinates. Construction curves go on their own layer.

import type { SketchEntity } from "../doc/types";
import { entityPrims, samplePrim, type Prim } from "../sketch/curves";

const TAU = Math.PI * 2;
const n = (v: number) => (Math.abs(v) < 1e-12 ? "0" : String(Math.round(v * 1e6) / 1e6));
const deg = (r: number) => (((r * 180) / Math.PI) % 360 + 360) % 360;

function primDXF(p: Prim, layer: string): string[] {
  const head = (type: string) => ["0", type, "8", layer];
  switch (p.t) {
    case "line":
      return [...head("LINE"), "10", n(p.a[0]), "20", n(p.a[1]), "30", "0", "11", n(p.b[0]), "21", n(p.b[1]), "31", "0"];
    case "circle": {
      if (Math.abs(Math.abs(p.sweep) - TAU) < 1e-9) return [...head("CIRCLE"), "10", n(p.c[0]), "20", n(p.c[1]), "30", "0", "40", n(p.r)];
      // DXF arcs run counter-clockwise from start to end angle.
      const [s, e] = p.sweep >= 0 ? [p.a0, p.a0 + p.sweep] : [p.a0 + p.sweep, p.a0];
      return [...head("ARC"), "10", n(p.c[0]), "20", n(p.c[1]), "30", "0", "40", n(p.r), "50", n(deg(s)), "51", n(deg(e))];
    }
    default: {
      // Ellipses and splines: a polyline through close samples.
      const closed = p.t === "spline" ? p.closed : Math.abs(Math.abs(p.sweep) - TAU) < 1e-9;
      let pts = samplePrim(p, 0, 1, p.t === "spline" ? Math.max(64, p.pts.length) : 128);
      if (closed && pts.length > 1) pts = pts.slice(0, -1);
      const out = [...head("POLYLINE"), "66", "1", "10", "0", "20", "0", "30", "0", "70", closed ? "1" : "0"];
      for (const q of pts) out.push("0", "VERTEX", "8", layer, "10", n(q[0]), "20", n(q[1]), "30", "0");
      out.push("0", "SEQEND", "8", layer);
      return out;
    }
  }
}

/** The sketch's curves as a DXF file's text. */
export function sketchToDXF(entities: SketchEntity[]): string {
  const body: string[] = [];
  for (const e of entities) for (const p of entityPrims(e)) body.push(...primDXF(p, e.construction ? "CONSTRUCTION" : "0"));
  return [
    "0", "SECTION", "2", "HEADER",
    "9", "$ACADVER", "1", "AC1009",
    // Millimetres.
    "9", "$INSUNITS", "70", "4",
    "9", "$MEASUREMENT", "70", "1",
    "0", "ENDSEC",
    "0", "SECTION", "2", "TABLES",
    "0", "TABLE", "2", "LAYER", "70", "2",
    "0", "LAYER", "2", "0", "70", "0", "62", "7", "6", "CONTINUOUS",
    "0", "LAYER", "2", "CONSTRUCTION", "70", "0", "62", "8", "6", "CONTINUOUS",
    "0", "ENDTAB",
    "0", "ENDSEC",
    "0", "SECTION", "2", "ENTITIES",
    ...body,
    "0", "ENDSEC",
    "0", "EOF",
    "",
  ].join("\n");
}
