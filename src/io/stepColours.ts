// The colours a STEP file gives its solids (pure logic: text in, colours out). The geometry kernel's STEP reader
// brings in the shapes only; the colours are read here from the file's text and given to the bodies as they come in.
//
// In a STEP file a colour hangs on a solid through a chain of records: a STYLED_ITEM names the solid (or the shape
// it is part of) and a style, which leads - through several records that only pass it on - to a COLOUR_RGB. The
// solids are taken in the order the file lists them, which is the order the reader builds them in.

/** "#rrggbb" for each solid of the file, in the file's order; null where the file gives it none. Empty: no solids. */
export function stepColours(text: string): (string | null)[] {
  // Only the records that matter are kept: the solids, what holds them, and the chain from style to colour.
  const KEPT =
    /#(\d+)\s*=\s*(MANIFOLD_SOLID_BREP|BREP_WITH_VOIDS|ADVANCED_BREP_SHAPE_REPRESENTATION|MANIFOLD_SURFACE_SHAPE_REPRESENTATION|SHAPE_REPRESENTATION|STYLED_ITEM|OVER_RIDING_STYLED_ITEM|PRESENTATION_STYLE_ASSIGNMENT|PRESENTATION_STYLE_BY_CONTEXT|SURFACE_STYLE_USAGE|SURFACE_SIDE_STYLE|SURFACE_STYLE_FILL_AREA|FILL_AREA_STYLE|FILL_AREA_STYLE_COLOUR|COLOUR_RGB|DRAUGHTING_PRE_DEFINED_COLOUR)\s*\(([^;]*)\)\s*;/g;
  const recs = new Map<number, { type: string; args: string }>();
  const solids: number[] = [];
  for (const m of text.matchAll(KEPT)) {
    const id = Number(m[1]);
    recs.set(id, { type: m[2], args: m[3] });
    if (m[2] === "MANIFOLD_SOLID_BREP" || m[2] === "BREP_WITH_VOIDS") solids.push(id);
  }
  if (!solids.length) return [];
  const refs = (args: string) => [...args.matchAll(/#(\d+)/g)].map((r) => Number(r[1]));
  const NAMED: Record<string, string> = { red: "#ff0000", green: "#00ff00", blue: "#0000ff", yellow: "#ffff00", magenta: "#ff00ff", cyan: "#00ffff", black: "#000000", white: "#ffffff" };
  const hex = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0");
  /** The colour a style leads to (followed through the records that pass it on). */
  const colourOf = (start: number): string | null => {
    const seen = new Set<number>();
    const todo = [start];
    while (todo.length) {
      const id = todo.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const r = recs.get(id);
      if (!r) continue;
      if (r.type === "COLOUR_RGB") {
        const n = r.args.replace(/'[^']*'/, "").match(/-?\d*\.?\d+(?:[eE][-+]?\d+)?/g)?.map(Number) ?? [];
        if (n.length >= 3) return `#${hex(n[0])}${hex(n[1])}${hex(n[2])}`;
      }
      if (r.type === "DRAUGHTING_PRE_DEFINED_COLOUR") {
        const name = /'([^']*)'/.exec(r.args)?.[1]?.toLowerCase() ?? "";
        if (NAMED[name]) return NAMED[name];
      }
      // (Not back into shapes: a style's chain is style records only.)
      if (!/SOLID|BREP|REPRESENTATION$/.test(r.type) || r.type === "PRESENTATION_STYLE_ASSIGNMENT") todo.push(...refs(r.args));
    }
    return null;
  };
  // What each styled item colours: the last record it names (its item), with the colour its styles lead to.
  const coloured = new Map<number, string>();
  for (const [, r] of recs) {
    if (r.type !== "STYLED_ITEM" && r.type !== "OVER_RIDING_STYLED_ITEM") continue;
    // STYLED_ITEM('name', (#styles...), #item)
    const list = /\(([^()]*)\)/.exec(r.args);
    const styles = list ? refs(list[1]) : [];
    const rest = list ? r.args.slice(r.args.indexOf(list[0]) + list[0].length) : r.args;
    const item = refs(rest)[0];
    if (item === undefined) continue;
    let c: string | null = null;
    for (const s of styles) if ((c = colourOf(s))) break;
    if (c && !coloured.has(item)) coloured.set(item, c);
  }
  if (!coloured.size) return solids.map(() => null);
  // A colour on a shape that holds solids is the colour of each of them that has none of its own.
  const held = new Map<number, string>();
  for (const [id, r] of recs) {
    if (!/REPRESENTATION$/.test(r.type)) continue;
    const c = coloured.get(id);
    if (c) for (const k of refs(r.args)) if (!held.has(k)) held.set(k, c);
  }
  // (The app's own grey is what a body with no colour is written in: read back, it has no colour again.)
  const plain = (c: string | null) => {
    if (!c) return null;
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
    return Math.abs(r - 0xb9) <= 3 && Math.abs(g - 0xbe) <= 3 && Math.abs(b - 0xc7) <= 3 ? null : c;
  };
  return solids.map((id) => plain(coloured.get(id) ?? held.get(id) ?? null));
}
