// DXF of a drawing sheet (for CAD programs): the sheet's SVG read back and
// written as AutoCAD R12 DXF, millimetres, y up. Lines, arcs and circles stay
// exact; text stays text; arrowheads are solids; the hatching of a section is
// written out as lines; a detail view is cut to its circle. Layers by kind of
// line: VISIBLE, THIN (dimensions, the frame, hatching), HIDDEN (dashed),
// CENTER (centrelines), TEXT.

type M = [number, number, number, number, number, number];
type P = [number, number];

const n = (v: number) => (Math.abs(v) < 1e-9 ? "0" : String(Math.round(v * 1e5) / 1e5));
const deg = (r: number) => ((((r * 180) / Math.PI) % 360) + 360) % 360;
const mul = (a: M, b: M): M => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
const apply = (m: M, p: P): P => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
const ID: M = [1, 0, 0, 1, 0, 0];

/** A transform="…" (rotate and translate, as the sheet writes them). */
function transformOf(t: string | undefined): M {
  let m = ID;
  if (!t) return m;
  for (const [, k, args] of t.matchAll(/(rotate|translate|matrix|scale)\(([^)]*)\)/g)) {
    const a = args.split(/[\s,]+/).filter(Boolean).map(Number);
    if (k === "translate") m = mul(m, [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0]);
    else if (k === "scale") m = mul(m, [a[0], 0, 0, a[1] ?? a[0], 0, 0]);
    else if (k === "matrix") m = mul(m, a as M);
    else {
      const r = ((a[0] ?? 0) * Math.PI) / 180;
      const [cx, cy] = [a[1] ?? 0, a[2] ?? 0];
      m = mul(m, mul([1, 0, 0, 1, cx, cy], mul([Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0], [1, 0, 0, 1, -cx, -cy])));
    }
  }
  return m;
}

const unescape = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");

/** Text as R12 writes it: Ø ± ° as its codes, other letters past ASCII as \U+XXXX. */
const dxfText = (s: string) =>
  s.replace(/[^\x20-\x7e]/gu, (c) => (c === "Ø" || c === "ø" || c === "⌀" ? "%%c" : c === "±" ? "%%p" : c === "°" ? "%%d" : `\\U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`));

interface Style {
  stroke: string;
  width: number;
  dash: string;
  fill: string;
  m: M;
  /** Cut to this circle (a detail view). */
  clip?: { c: P; r: number };
  /** Filled with this hatch (its angle, degrees). */
  hatch?: number;
}

/** A segment a→b cut to a circle: the parts inside. */
function clipToCircle(a: P, b: P, c: P, r: number): [P, P][] {
  const d: P = [b[0] - a[0], b[1] - a[1]];
  const f: P = [a[0] - c[0], a[1] - c[1]];
  const A = d[0] * d[0] + d[1] * d[1];
  if (A < 1e-18) return [];
  const B = 2 * (f[0] * d[0] + f[1] * d[1]);
  const C = f[0] * f[0] + f[1] * f[1] - r * r;
  const disc = B * B - 4 * A * C;
  if (disc <= 0) return [];
  const s = Math.sqrt(disc);
  const t0 = Math.max(0, (-B - s) / (2 * A));
  const t1 = Math.min(1, (-B + s) / (2 * A));
  if (t1 <= t0) return [];
  return [
    [
      [a[0] + d[0] * t0, a[1] + d[1] * t0],
      [a[0] + d[0] * t1, a[1] + d[1] * t1],
    ],
  ];
}

/** The sheet (its SVG, mm, y down, `H` tall) as a DXF file's text. */
export function sheetToDXF(svg: string): string {
  const vb = /viewBox="([^"]+)"/.exec(svg)?.[1].split(/\s+/).map(Number) ?? [0, 0, 420, 297];
  const H = vb[3];
  const flip = (p: P): P => [p[0], H - p[1]];
  const out: string[] = [];
  const head = (type: string, layer: string) => out.push("0", type, "8", layer);
  const layerOf = (s: Style): string | null => {
    if (s.dash === "3 1") return "HIDDEN";
    if (s.dash && s.dash !== "none") return /^(8 |1\.5 1 6)/.test(s.dash) ? "CENTER" : null;
    return s.width >= 0.4 ? "VISIBLE" : "THIN";
  };
  const line = (a: P, b: P, s: Style, layer: string) => {
    const segs: [P, P][] = s.clip ? clipToCircle(a, b, s.clip.c, s.clip.r) : [[a, b]];
    for (const [p, q] of segs) {
      const [P1, P2] = [flip(apply(s.m, p)), flip(apply(s.m, q))];
      if (Math.hypot(P2[0] - P1[0], P2[1] - P1[1]) < 1e-6) continue;
      head("LINE", layer);
      out.push("10", n(P1[0]), "20", n(P1[1]), "30", "0", "11", n(P2[0]), "21", n(P2[1]), "31", "0");
    }
  };
  /** A circle's arc from angle a0 sweeping by `sweep` (SVG's angles, y down), or the whole circle. */
  const arc = (c: P, r: number, a0: number, sweep: number, s: Style, layer: string) => {
    if (s.clip) {
      // Cut to a detail's circle: as short lines.
      const k = Math.max(8, Math.ceil((Math.abs(sweep) / (Math.PI * 2)) * 96));
      let prev: P = [c[0] + r * Math.cos(a0), c[1] + r * Math.sin(a0)];
      for (let i = 1; i <= k; i++) {
        const t = a0 + (sweep * i) / k;
        const q: P = [c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)];
        line(prev, q, s, layer);
        prev = q;
      }
      return;
    }
    const C = flip(apply(s.m, c));
    const rot = Math.atan2(s.m[1], s.m[0]);
    if (Math.abs(Math.abs(sweep) - Math.PI * 2) < 1e-9) {
      head("CIRCLE", layer);
      out.push("10", n(C[0]), "20", n(C[1]), "30", "0", "40", n(r));
      return;
    }
    // y flipped: SVG's angle t is -t; the DXF arc runs counter-clockwise.
    const s0 = -(a0 + rot);
    const s1 = -(a0 + sweep + rot);
    const [from, to] = sweep >= 0 ? [s1, s0] : [s0, s1];
    head("ARC", layer);
    out.push("10", n(C[0]), "20", n(C[1]), "30", "0", "40", n(r), "50", n(deg(from)), "51", n(deg(to)));
  };
  const solid = (pts: P[], s: Style, layer: string) => {
    const q = pts.map((p) => flip(apply(s.m, p)));
    const c = [q[0], q[1], q[q.length - 1], q.length > 3 ? q[2] : q[q.length - 1]];
    head("SOLID", layer);
    out.push("10", n(c[0][0]), "20", n(c[0][1]), "30", "0", "11", n(c[1][0]), "21", n(c[1][1]), "31", "0", "12", n(c[2][0]), "22", n(c[2][1]), "32", "0", "13", n(c[3][0]), "23", n(c[3][1]), "33", "0");
  };
  /** Hatch lines inside the loops (even-odd), every 2.5 mm at `angle` degrees from the vertical, as the sheet's pattern. */
  const hatchLines = (loops: P[][], angle: number, s: Style) => {
    const r = (angle * Math.PI) / 180;
    // In the pattern's own frame the lines are x = 2.5k.
    const toPat = (p: P): P => [p[0] * Math.cos(r) + p[1] * Math.sin(r), -p[0] * Math.sin(r) + p[1] * Math.cos(r)];
    const fromPat = (p: P): P => [p[0] * Math.cos(r) - p[1] * Math.sin(r), p[0] * Math.sin(r) + p[1] * Math.cos(r)];
    const edges: [P, P][] = [];
    for (const l of loops) for (let i = 0; i < l.length; i++) edges.push([toPat(l[i]), toPat(l[(i + 1) % l.length])]);
    if (!edges.length) return;
    const xs = edges.flatMap(([a, b]) => [a[0], b[0]]);
    for (let k = Math.ceil(Math.min(...xs) / 2.5); k * 2.5 <= Math.max(...xs); k++) {
      const x = k * 2.5;
      const ys: number[] = [];
      for (const [a, b] of edges) if (a[0] <= x !== b[0] <= x) ys.push(a[1] + ((x - a[0]) / (b[0] - a[0])) * (b[1] - a[1]));
      ys.sort((p, q) => p - q);
      for (let i = 0; i + 1 < ys.length; i += 2) line(fromPat([x, ys[i]]), fromPat([x, ys[i + 1]]), s, "THIN");
    }
  };
  const pathOf = (d: string, s: Style) => {
    const layer = s.hatch === undefined ? layerOf(s) : "THIN";
    const filled = s.fill !== "none" && s.fill !== "transparent" && !s.fill.startsWith("url(");
    const stroked = s.stroke !== "none";
    if (!layer || (!stroked && !filled && s.hatch === undefined)) return;
    const loops: P[][] = [];
    let cur: P = [0, 0];
    let start: P = [0, 0];
    let loop: P[] = [];
    const toks = d.match(/[MLHVAZmlhvaz]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/g) ?? [];
    let i = 0;
    let cmd = "";
    const num = () => Number(toks[i++]);
    const close = () => {
      if (loop.length > 1) loops.push(loop);
      loop = [];
    };
    while (i < toks.length) {
      if (/[A-Za-z]/.test(toks[i])) cmd = toks[i++];
      const C = cmd.toUpperCase();
      if (C === "Z") {
        if (stroked && s.hatch === undefined) line(cur, start, s, layer);
        cur = start;
        close();
        continue;
      }
      if (C === "M") {
        close();
        cur = start = [num(), num()];
        loop = [cur];
        cmd = cmd === "m" ? "l" : "L";
        continue;
      }
      let next: P;
      if (C === "L") next = [num(), num()];
      else if (C === "H") next = [num(), cur[1]];
      else if (C === "V") next = [cur[0], num()];
      else if (C === "A") {
        const rx = num();
        num();
        num();
        const large = num();
        const sweepF = num();
        next = [num(), num()];
        // The circle through cur and next (SVG's endpoint form, rx = ry).
        const dx = (cur[0] - next[0]) / 2;
        const dy = (cur[1] - next[1]) / 2;
        const r = Math.max(rx, Math.hypot(dx, dy));
        const h = Math.sqrt(Math.max(0, r * r - dx * dx - dy * dy)) / Math.hypot(dx, dy || 1e-30);
        const sg = large === sweepF ? 1 : -1;
        const c: P = [(cur[0] + next[0]) / 2 + sg * h * -dy, (cur[1] + next[1]) / 2 + sg * h * dx];
        const a0 = Math.atan2(cur[1] - c[1], cur[0] - c[0]);
        let sw = Math.atan2(next[1] - c[1], next[0] - c[0]) - a0;
        if (sweepF && sw < 0) sw += Math.PI * 2;
        if (!sweepF && sw > 0) sw -= Math.PI * 2;
        if (stroked && s.hatch === undefined) arc(c, r, a0, sw, s, layer);
        for (let k = 1; k <= 12; k++) loop.push([c[0] + r * Math.cos(a0 + (sw * k) / 12), c[1] + r * Math.sin(a0 + (sw * k) / 12)]);
        cur = next;
        continue;
      } else {
        i++;
        continue;
      }
      if (stroked && s.hatch === undefined) line(cur, next, s, layer);
      loop.push(next);
      cur = next;
    }
    close();
    if (s.hatch !== undefined) return hatchLines(loops, s.hatch, s);
    // A small filled shape, no outline (an arrowhead): a solid.
    if (filled && !stroked) for (const l of loops) if (l.length >= 3 && l.length <= 4) solid(l, s, "THIN");
  };

  // ---- Walk the elements, styles and transforms handed down through groups.
  const clips = new Map<string, { c: P; r: number }>();
  for (const [, id, body] of svg.matchAll(/<clipPath id="([^"]+)">(.*?)<\/clipPath>/gs)) {
    const c = /<circle cx="([-\d.]+)" cy="([-\d.]+)" r="([-\d.]+)"/.exec(body);
    if (c) clips.set(id, { c: [Number(c[1]), Number(c[2])], r: Number(c[3]) });
  }
  const hatches = new Map<string, number>();
  for (const [, id, a] of svg.matchAll(/<pattern id="([^"]+)"[^>]*patternTransform="rotate\(([-\d.]+)\)"/g)) hatches.set(id, Number(a));
  const body = svg.replace(/<defs>.*?<\/defs>/gs, "").replace(/<clipPath[^>]*>.*?<\/clipPath>/gs, "").replace(/<pattern[^>]*>.*?<\/pattern>/gs, "");
  const stack: Style[] = [{ stroke: "none", width: 0.25, dash: "", fill: "#000", m: ID }];
  const attrs = (s: string) => Object.fromEntries([...s.matchAll(/([\w:-]+)="([^"]*)"/g)].map(([, k, v]) => [k, v]));
  const styled = (a: Record<string, string>, up: Style): Style => {
    const s: Style = {
      stroke: a.stroke ?? up.stroke,
      width: a["stroke-width"] !== undefined ? Number(a["stroke-width"]) : up.width,
      dash: a["stroke-dasharray"] ?? up.dash,
      fill: a.fill ?? up.fill,
      m: a.transform ? mul(up.m, transformOf(a.transform)) : up.m,
      clip: up.clip,
      hatch: up.hatch,
    };
    const cp = /url\(#([^)]+)\)/.exec(a["clip-path"] ?? "")?.[1];
    if (cp && clips.has(cp)) s.clip = clips.get(cp);
    const hp = /url\(#([^)]+)\)/.exec(a.fill ?? "")?.[1];
    s.hatch = hp && hatches.has(hp) ? hatches.get(hp) : undefined;
    return s;
  };
  const tagRe = /<(\/?)([a-zA-Z]+)([^>]*?)(\/?)>|([^<]+)/g;
  let textOf: { a: Record<string, string>; s: Style; t: string } | null = null;
  for (const m of body.matchAll(tagRe)) {
    const [, closing, tag, rest, self, txt] = m;
    if (txt !== undefined) {
      if (textOf) textOf.t += txt;
      continue;
    }
    if (closing) {
      if (tag === "g") stack.length > 1 && stack.pop();
      if (tag === "text" && textOf) {
        const { a, s, t } = textOf;
        textOf = null;
        const str = unescape(t).trim();
        if (!str) continue;
        const p = flip(apply(s.m, [Number(a.x ?? 0), Number(a.y ?? 0)]));
        const size = Number(a["font-size"] ?? 3.5);
        const rot = -deg(Math.atan2(s.m[1], s.m[0]));
        const just = a["text-anchor"] === "middle" ? 1 : a["text-anchor"] === "end" ? 2 : 0;
        head("TEXT", "TEXT");
        out.push("10", n(p[0]), "20", n(p[1]), "30", "0", "40", n(size * 0.7), "1", dxfText(str), "50", n(((rot % 360) + 360) % 360));
        if (just) out.push("72", String(just), "11", n(p[0]), "21", n(p[1]), "31", "0");
      }
      continue;
    }
    const a = attrs(rest);
    const up = stack[stack.length - 1];
    if (tag === "g") {
      const s = styled(a, up);
      if (!self) stack.push(s);
      continue;
    }
    if (tag === "text") {
      textOf = { a, s: styled(a, up), t: "" };
      continue;
    }
    const s = styled(a, up);
    if (tag === "path" && a.d) pathOf(a.d, s);
    else if (tag === "line") pathOf(`M${a.x1} ${a.y1}L${a.x2} ${a.y2}`, s);
    else if (tag === "rect" && s.stroke !== "none") {
      const [x, y, w, h] = [Number(a.x ?? 0), Number(a.y ?? 0), Number(a.width), Number(a.height)];
      pathOf(`M${x} ${y}L${x + w} ${y}L${x + w} ${y + h}L${x} ${y + h}Z`, { ...s, fill: "none" });
    } else if (tag === "circle") {
      const layer = layerOf(s);
      const filled = s.fill !== "none" && s.fill !== "transparent" && s.fill !== "#fff";
      if (layer && (s.stroke !== "none" || filled)) arc([Number(a.cx), Number(a.cy)], Number(a.r), 0, Math.PI * 2, s, s.stroke !== "none" ? layer : "THIN");
    }
  }

  const ltype = (name: string, desc: string, parts: number[]) => ["0", "LTYPE", "2", name, "70", "0", "3", desc, "72", "65", "73", String(parts.length), "40", n(parts.reduce((x, y) => x + Math.abs(y), 0)), ...parts.flatMap((v) => ["49", n(v)])];
  const layer = (name: string, color: number, lt: string) => ["0", "LAYER", "2", name, "70", "0", "62", String(color), "6", lt];
  return [
    "0", "SECTION", "2", "HEADER",
    "9", "$ACADVER", "1", "AC1009",
    "9", "$INSUNITS", "70", "4",
    "9", "$MEASUREMENT", "70", "1",
    "9", "$EXTMIN", "10", n(vb[0]), "20", "0", "30", "0",
    "9", "$EXTMAX", "10", n(vb[0] + vb[2]), "20", n(H), "30", "0",
    "0", "ENDSEC",
    "0", "SECTION", "2", "TABLES",
    "0", "TABLE", "2", "LTYPE", "70", "3",
    ...ltype("CONTINUOUS", "Solid line", []),
    ...ltype("DASHED", "Dashed __ __ __", [3, -1]),
    ...ltype("CENTER", "Center ____ _ ____", [8, -1.5, 1.5, -1.5]),
    "0", "ENDTAB",
    "0", "TABLE", "2", "LAYER", "70", "6",
    ...layer("0", 7, "CONTINUOUS"),
    ...layer("VISIBLE", 7, "CONTINUOUS"),
    ...layer("THIN", 8, "CONTINUOUS"),
    ...layer("HIDDEN", 8, "DASHED"),
    ...layer("CENTER", 1, "CENTER"),
    ...layer("TEXT", 7, "CONTINUOUS"),
    "0", "ENDTAB",
    "0", "ENDSEC",
    "0", "SECTION", "2", "ENTITIES",
    ...out,
    "0", "ENDSEC",
    "0", "EOF",
    "",
  ].join("\n");
}
