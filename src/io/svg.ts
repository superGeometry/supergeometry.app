// SVG → sketch curves. Lines stay lines, circular arcs become arcs, circles /
// ellipses / rectangles become those shapes (when not skewed), and Bézier or
// elliptical curves become splines through points on them. Units follow the
// SVG's width/viewBox (mm, cm, in, pt, px); y is flipped so up stays up, and
// the drawing is centred on the sketch origin.
//
// Self-contained (no DOM), so it works in tests and workers alike.

import type { SketchEntity, Vec2 } from "../doc/types";
import { uid } from "../sketch/edit";

/** 2D affine map [a b c d e f]: x' = a x + c y + e, y' = b x + d y + f (SVG's matrix order). */
type M = [number, number, number, number, number, number];
const I: M = [1, 0, 0, 1, 0, 0];
const mul = (p: M, q: M): M => [p[0] * q[0] + p[2] * q[1], p[1] * q[0] + p[3] * q[1], p[0] * q[2] + p[2] * q[3], p[1] * q[2] + p[3] * q[3], p[0] * q[4] + p[2] * q[5] + p[4], p[1] * q[4] + p[3] * q[5] + p[5]];
const ap = (m: M, [x, y]: Vec2): Vec2 => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/** Rotation + uniform scale (+ mirror) only: circles stay circles. */
function similarity(m: M): { k: number; rot: number } | null {
  const k1 = Math.hypot(m[0], m[1]);
  const k2 = Math.hypot(m[2], m[3]);
  const dotp = m[0] * m[2] + m[1] * m[3];
  if (Math.abs(k1 - k2) > 1e-9 * Math.max(k1, k2) || Math.abs(dotp) > 1e-9 * k1 * k2) return null;
  return { k: k1, rot: Math.atan2(m[1], m[0]) };
}

function parseTransform(s: string | undefined): M {
  let m = I;
  if (!s) return m;
  for (const [, fn, args] of s.matchAll(/(\w+)\s*\(([^)]*)\)/g)) {
    const v = nums(args);
    let t: M = I;
    switch (fn) {
      case "matrix":
        if (v.length === 6) t = v as M;
        break;
      case "translate":
        t = [1, 0, 0, 1, v[0] ?? 0, v[1] ?? 0];
        break;
      case "scale":
        t = [v[0] ?? 1, 0, 0, v[1] ?? v[0] ?? 1, 0, 0];
        break;
      case "rotate": {
        const a = ((v[0] ?? 0) * Math.PI) / 180;
        const r: M = [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0];
        t = v.length >= 3 ? mul(mul([1, 0, 0, 1, v[1], v[2]], r), [1, 0, 0, 1, -v[1], -v[2]]) : r;
        break;
      }
      case "skewX":
        t = [1, 0, Math.tan(((v[0] ?? 0) * Math.PI) / 180), 1, 0, 0];
        break;
      case "skewY":
        t = [1, Math.tan(((v[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0];
        break;
    }
    m = mul(m, t);
  }
  return m;
}

function nums(s: string): number[] {
  return (s.match(/[-+]?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?/gi) ?? []).map(Number);
}

// ---------------------------------------------------------------- XML

interface El {
  name: string;
  attrs: Record<string, string>;
  children: El[];
}

/** Tiny XML reader: elements and attributes only (enough for SVG geometry). */
function parseXml(text: string): El {
  const root: El = { name: "#root", attrs: {}, children: [] };
  const stack = [root];
  const src = text.replace(/<!--[\s\S]*?-->/g, "").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "").replace(/<\?[\s\S]*?\?>/g, "").replace(/<!DOCTYPE[\s\S]*?>/gi, "");
  for (const [, close, name, rest, selfClose] of src.matchAll(/<(\/?)([\w:.-]+)([^>]*?)(\/?)>/g)) {
    if (close) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const [, k, , v1, v2] of rest.matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) attrs[k] = v1 ?? v2 ?? "";
    // style="stroke:…; transform:…" isn't geometry, except display:none.
    const el: El = { name: name.replace(/^svg:/, ""), attrs, children: [] };
    stack[stack.length - 1].children.push(el);
    if (!selfClose) stack.push(el);
  }
  return root;
}

// ---------------------------------------------------------------- units

const UNIT_MM: Record<string, number> = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6, px: 25.4 / 96, "": 25.4 / 96 };

function lengthMM(s: string | undefined): number | null {
  const m = s?.trim().match(/^([-+]?[\d.]+(?:e[-+]?\d+)?)\s*(mm|cm|in|pt|pc|px)?$/i);
  return m ? Number(m[1]) * UNIT_MM[(m[2] ?? "").toLowerCase()] : null;
}

// ---------------------------------------------------------------- import

export interface SvgImport {
  entities: SketchEntity[];
  /** Size of the drawing in mm. */
  size: Vec2;
}

export function parseSVG(text: string): SvgImport {
  const doc = parseXml(text);
  const svg = findFirst(doc, "svg");
  if (!svg) throw new Error("Not an SVG file");
  // User units → mm, from width + viewBox (no width: 96 px per inch).
  const vb = svg.attrs.viewBox ? nums(svg.attrs.viewBox) : null;
  const w = lengthMM(svg.attrs.width);
  const h = lengthMM(svg.attrs.height);
  // Without a viewBox one user unit is one CSS pixel; with one, width (or height) sets the scale.
  let k = UNIT_MM.px;
  if (vb && vb.length === 4 && vb[2] > 0 && vb[3] > 0) k = w !== null ? w / vb[2] : h !== null ? h / vb[3] : UNIT_MM.px;
  const [kx, ky] = [k, k];
  const ox = vb?.[0] ?? 0;
  const oy = vb?.[1] ?? 0;
  // SVG y points down; the sketch's y points up.
  const base: M = mul([kx, 0, 0, -ky, 0, 0], [1, 0, 0, 1, -ox, -oy]);
  const out: SketchEntity[] = [];
  walk(svg, base, out);
  if (!out.length) throw new Error("No shapes found (text has to be converted to paths first)");
  // Centre on the origin.
  const pts = out.flatMap(samplePoints);
  const lo: Vec2 = [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1]))];
  const hi: Vec2 = [Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
  const c: Vec2 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2];
  return { entities: out.map((e) => shift(e, -c[0], -c[1])), size: [hi[0] - lo[0], hi[1] - lo[1]] };
}

function findFirst(el: El, name: string): El | null {
  if (el.name === name) return el;
  for (const c of el.children) {
    const f = findFirst(c, name);
    if (f) return f;
  }
  return null;
}

const SKIP = new Set(["defs", "clipPath", "mask", "symbol", "marker", "pattern", "style", "title", "desc", "metadata", "text", "linearGradient", "radialGradient", "filter", "image"]);

function walk(el: El, parent: M, out: SketchEntity[]): void {
  for (const c of el.children) {
    if (SKIP.has(c.name) || /display\s*:\s*none/.test(c.attrs.style ?? "") || c.attrs.display === "none") continue;
    const m = mul(parent, parseTransform(c.attrs.transform));
    const n = (k: string, d = 0) => (c.attrs[k] !== undefined ? Number(nums(c.attrs[k])[0] ?? d) : d);
    switch (c.name) {
      case "g":
      case "svg":
      case "a":
      case "switch":
        walk(c, c.name === "svg" ? mul(m, [1, 0, 0, 1, n("x"), n("y")]) : m, out);
        break;
      case "path":
        out.push(...pathEntities(c.attrs.d ?? "", m));
        break;
      case "line":
        out.push(line(ap(m, [n("x1"), n("y1")]), ap(m, [n("x2"), n("y2")])));
        break;
      case "polyline":
      case "polygon": {
        const v = nums(c.attrs.points ?? "");
        const p: Vec2[] = [];
        for (let i = 0; i + 1 < v.length; i += 2) p.push(ap(m, [v[i], v[i + 1]]));
        for (let i = 0; i + 1 < p.length; i++) out.push(line(p[i], p[i + 1]));
        if (c.name === "polygon" && p.length > 2) out.push(line(p[p.length - 1], p[0]));
        break;
      }
      case "rect": {
        const [x, y, w, h] = [n("x"), n("y"), n("width"), n("height")];
        if (w <= 0 || h <= 0) break;
        const rx = Math.min(n("rx", n("ry")), w / 2);
        const ry = Math.min(n("ry", rx), h / 2);
        const sim = similarity(m);
        if (!rx && !ry && sim) {
          const ctr = ap(m, [x + w / 2, y + h / 2]);
          out.push({ id: uid(), kind: "rect", center: ctr, w: w * sim.k, h: h * sim.k, rotation: Math.atan2(m[1], m[0]) });
        } else {
          // Rounded (or skewed): as a path.
          const d = rx || ry
            ? `M${x + rx},${y}H${x + w - rx}A${rx},${ry} 0 0 1 ${x + w},${y + ry}V${y + h - ry}A${rx},${ry} 0 0 1 ${x + w - rx},${y + h}H${x + rx}A${rx},${ry} 0 0 1 ${x},${y + h - ry}V${y + ry}A${rx},${ry} 0 0 1 ${x + rx},${y}Z`
            : `M${x},${y}H${x + w}V${y + h}H${x}Z`;
          out.push(...pathEntities(d, m));
        }
        break;
      }
      case "circle":
      case "ellipse": {
        const cx = n("cx");
        const cy = n("cy");
        const rx = c.name === "circle" ? n("r") : n("rx");
        const ry = c.name === "circle" ? n("r") : n("ry", rx);
        if (rx <= 0 || ry <= 0) break;
        const sim = similarity(m);
        const ctr = ap(m, [cx, cy]);
        if (sim && Math.abs(rx - ry) < 1e-12) out.push({ id: uid(), kind: "circle", center: ctr, radius: rx * sim.k });
        else if (sim) out.push({ id: uid(), kind: "ellipse", center: ctr, rx: rx * sim.k, ry: ry * sim.k, rotation: sim.rot });
        else out.push(closedSpline(Array.from({ length: 24 }, (_, i) => ap(m, [cx + rx * Math.cos((i / 24) * Math.PI * 2), cy + ry * Math.sin((i / 24) * Math.PI * 2)]))));
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- paths

/** One SVG path's curves. */
export function pathEntities(d: string, m: M = I): SketchEntity[] {
  const out: SketchEntity[] = [];
  const toks = d.match(/[a-df-z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?/gi) ?? [];
  let i = 0;
  let cmd = "";
  let cur: Vec2 = [0, 0];
  let start: Vec2 = [0, 0];
  let lastCtrl: Vec2 | null = null;
  let lastQ: Vec2 | null = null;
  const num = () => Number(toks[i++]);
  const more = () => i < toks.length && !/^[a-z]$/i.test(toks[i]);
  const P = (p: Vec2) => ap(m, p);
  const sim = similarity(m);
  while (i < toks.length) {
    if (/^[a-z]$/i.test(toks[i])) cmd = toks[i++];
    const rel = cmd === cmd.toLowerCase();
    const R = (p: Vec2): Vec2 => (rel ? [cur[0] + p[0], cur[1] + p[1]] : p);
    const C = cmd.toUpperCase();
    if (C === "Z") {
      if (Math.hypot(cur[0] - start[0], cur[1] - start[1]) > 1e-12) out.push(line(P(cur), P(start)));
      cur = start;
      lastCtrl = lastQ = null;
      if (!more()) continue;
      cmd = rel ? "l" : "L";
      continue;
    }
    if (!more()) break;
    switch (C) {
      case "M": {
        cur = R([num(), num()]);
        start = cur;
        cmd = rel ? "l" : "L";
        lastCtrl = lastQ = null;
        continue;
      }
      case "L":
      case "H":
      case "V": {
        const p: Vec2 = C === "L" ? R([num(), num()]) : C === "H" ? [rel ? cur[0] + num() : num(), cur[1]] : [cur[0], rel ? cur[1] + num() : num()];
        if (Math.hypot(p[0] - cur[0], p[1] - cur[1]) > 1e-12) out.push(line(P(cur), P(p)));
        cur = p;
        lastCtrl = lastQ = null;
        break;
      }
      case "C":
      case "S": {
        const c1: Vec2 = C === "C" ? R([num(), num()]) : lastCtrl ? [2 * cur[0] - lastCtrl[0], 2 * cur[1] - lastCtrl[1]] : cur;
        const c2 = R([num(), num()]);
        const p = R([num(), num()]);
        out.push(bezierSpline([cur, c1, c2, p].map(P)));
        lastCtrl = c2;
        lastQ = null;
        cur = p;
        break;
      }
      case "Q":
      case "T": {
        const q: Vec2 = C === "Q" ? R([num(), num()]) : lastQ ? [2 * cur[0] - lastQ[0], 2 * cur[1] - lastQ[1]] : cur;
        const p = R([num(), num()]);
        // Quadratic → cubic.
        const c1: Vec2 = [cur[0] + (2 / 3) * (q[0] - cur[0]), cur[1] + (2 / 3) * (q[1] - cur[1])];
        const c2: Vec2 = [p[0] + (2 / 3) * (q[0] - p[0]), p[1] + (2 / 3) * (q[1] - p[1])];
        out.push(bezierSpline([cur, c1, c2, p].map(P)));
        lastQ = q;
        lastCtrl = null;
        cur = p;
        break;
      }
      case "A": {
        const rx0 = Math.abs(num());
        const ry0 = Math.abs(num());
        const phi = (num() * Math.PI) / 180;
        const large = num() !== 0;
        const sweep = num() !== 0;
        const p = R([num(), num()]);
        out.push(...arcEntities(cur, p, rx0, ry0, phi, large, sweep, m, sim));
        cur = p;
        lastCtrl = lastQ = null;
        break;
      }
      default:
        i++;
    }
  }
  return out;
}

/** SVG endpoint arc → one arc (circular, under a similarity) or a spline through it. */
function arcEntities(a: Vec2, b: Vec2, rx: number, ry: number, phi: number, large: boolean, sweep: boolean, m: M, sim: { k: number } | null): SketchEntity[] {
  if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-12) return [];
  if (!rx || !ry) return [line(ap(m, a), ap(m, b))];
  // Endpoint → centre parameterisation (SVG spec, F.6.5).
  const cs = Math.cos(phi);
  const sn = Math.sin(phi);
  const dx = (a[0] - b[0]) / 2;
  const dy = (a[1] - b[1]) / 2;
  const x1 = cs * dx + sn * dy;
  const y1 = -sn * dx + cs * dy;
  const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lam > 1) {
    rx *= Math.sqrt(lam);
    ry *= Math.sqrt(lam);
  }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  const co = (large !== sweep ? 1 : -1) * Math.sqrt(Math.max(0, num / den));
  const cx1 = (co * rx * y1) / ry;
  const cy1 = (-co * ry * x1) / rx;
  const cx = cs * cx1 - sn * cy1 + (a[0] + b[0]) / 2;
  const cy = sn * cx1 + cs * cy1 + (a[1] + b[1]) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let dt = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  const at = (t: number): Vec2 => ap(m, [cx + rx * Math.cos(t) * cs - ry * Math.sin(t) * sn, cy + rx * Math.cos(t) * sn + ry * Math.sin(t) * cs]);
  if (sim && Math.abs(rx - ry) < 1e-9 * rx) {
    // A full-ish circle is split in two so each arc's three points stay well apart.
    if (Math.abs(dt) > Math.PI * 1.5) {
      const h = dt / 2;
      return [arc3(at(t1), at(t1 + h / 2), at(t1 + h)), arc3(at(t1 + h), at(t1 + h * 1.5), at(t1 + dt))];
    }
    return [arc3(at(t1), at(t1 + dt / 2), at(t1 + dt))];
  }
  const n = Math.max(4, Math.ceil((Math.abs(dt) / (Math.PI / 2)) * 4));
  return [{ id: uid(), kind: "spline", mode: "fit", closed: false, points: Array.from({ length: n + 1 }, (_, k) => at(t1 + (dt * k) / n)) }];
}

/** A cubic Bézier as a fit spline through points on it (ends exact). */
function bezierSpline([p0, p1, p2, p3]: Vec2[]): SketchEntity {
  // Straight "curves" stay lines.
  const off = (p: Vec2) => {
    const dx = p3[0] - p0[0];
    const dy = p3[1] - p0[1];
    const l = Math.hypot(dx, dy) || 1;
    return Math.abs((p[0] - p0[0]) * dy - (p[1] - p0[1]) * dx) / l;
  };
  if (off(p1) < 1e-9 && off(p2) < 1e-9) return line(p0, p3);
  const N = 8;
  const pts = Array.from({ length: N + 1 }, (_, k): Vec2 => {
    const t = k / N;
    const u = 1 - t;
    return [u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0], u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]];
  });
  return { id: uid(), kind: "spline", mode: "fit", closed: false, points: pts };
}

const line = (a: Vec2, b: Vec2): SketchEntity => ({ id: uid(), kind: "line", a, b });
const arc3 = (a: Vec2, m: Vec2, b: Vec2): SketchEntity => ({ id: uid(), kind: "arc", a, m, b });
const closedSpline = (points: Vec2[]): SketchEntity => ({ id: uid(), kind: "spline", mode: "fit", closed: true, points });

function samplePoints(e: SketchEntity): Vec2[] {
  switch (e.kind) {
    case "line":
      return [e.a, e.b];
    case "arc":
      return [e.a, e.m, e.b];
    case "circle":
      return [[e.center[0] - e.radius, e.center[1] - e.radius], [e.center[0] + e.radius, e.center[1] + e.radius]];
    case "ellipse": {
      const r = Math.max(e.rx, e.ry);
      return [[e.center[0] - r, e.center[1] - r], [e.center[0] + r, e.center[1] + r]];
    }
    case "rect": {
      const c = Math.cos(e.rotation);
      const s = Math.sin(e.rotation);
      return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]): Vec2 => [e.center[0] + (u * e.w * c - v * e.h * s) / 2, e.center[1] + (u * e.w * s + v * e.h * c) / 2]);
    }
    case "spline":
    case "polyline":
      return e.points;
    default:
      return [];
  }
}

function shift(e: SketchEntity, dx: number, dy: number): SketchEntity {
  const s = (p: Vec2): Vec2 => [p[0] + dx, p[1] + dy];
  switch (e.kind) {
    case "line":
      return { ...e, a: s(e.a), b: s(e.b) };
    case "arc":
      return { ...e, a: s(e.a), m: s(e.m), b: s(e.b) };
    case "circle":
    case "ellipse":
    case "rect":
    case "polygon":
      return { ...e, center: s(e.center) };
    case "spline":
    case "polyline":
      return { ...e, points: e.points.map(s) };
    default:
      return e;
  }
}
