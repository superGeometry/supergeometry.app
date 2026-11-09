// Length units and expression evaluation for every numeric field.
// Internally everything is millimetres.

import type { Units, Variable } from "./doc/types";

export const UNIT_MM: Record<Units, number> = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 };
export const UNIT_LABEL: Record<Units, string> = { mm: "mm", cm: "cm", m: "m", in: "in", ft: "ft" };

let current: Units = "mm";
let variables: Variable[] = [];

export function setUnits(u: Units): void {
  current = u;
}
export function units(): Units {
  return current;
}
export function setVariables(v: Variable[]): void {
  variables = v;
}

/**
 * A variable's value as shown: "220 mm" is just "220" when mm is the unit in
 * use (it goes without saying). Formulas are shown as they are.
 */
export function bareExpr(expr: string): string {
  const m = /^\s*(-?\d*\.?\d+)\s*(mm|cm|m|in|ft)\s*$/i.exec(expr);
  return m && m[2].toLowerCase() === current ? m[1] : expr.trim();
}

/** Typed as a plain number where the value had a unit ("220 mm" → "300"): it keeps that unit ("300 mm"). */
export function withUnitOf(typed: string, original: string): string {
  const t = typed.trim();
  const unit = /^\s*-?\d*\.?\d+\s*(mm|cm|m|in|ft)\s*$/i.exec(original)?.[1];
  return unit && /^-?\d*\.?\d+$/.test(t) ? `${t} ${unit}` : t;
}

/** mm → display string in the current unit. */
export function fmtLen(mm: number, digits = 3): string {
  const v = mm / UNIT_MM[current];
  return `${trim(v, digits)} ${UNIT_LABEL[current]}`;
}

/** mm → number in the current unit (for input fields). */
export function toDisplay(mm: number): number {
  return mm / UNIT_MM[current];
}

export function trim(v: number, digits = 3): string {
  const p = Math.pow(10, digits);
  return String(Math.round(v * p) / p);
}

/**
 * Parse a field value: numbers, + - * / ^ ( ), sqrt sin cos tan abs pi, unit suffixes (25.4mm, 1in,
 * 2 ft), and variable names. Plain numbers are in the current unit.
 * Returns millimetres for lengths (kind "length"), the raw value otherwise.
 */
export function evaluate(text: string, kind: "length" | "number" | "angle" = "length"): number | null {
  try {
    const scaleFor = kind === "length" ? UNIT_MM[current] : 1;
    const v = new Parser(decimalComma(text), scaleFor, kind === "length", 0).parse();
    // (2^1000 is a number, but no size: 1000 km is the most a box takes.)
    return Number.isFinite(v) && Math.abs(v) <= 1e9 ? v : null;
  } catch {
    return null;
  }
}

/**
 * "5,5" is 5.5 (a decimal comma: much of Europe writes it so, and a phone's
 * keyboard offers it). "1,000" stays unread: one, or a thousand?
 */
function decimalComma(text: string): string {
  return /,\d{3}(?!\d)/.test(text) ? text : text.replace(/(\d),(\d)/g, "$1.$2");
}

const DEG = Math.PI / 180;
/** Functions a field can use: sqrt(3), sin(30) (degrees), abs(-2). */
const FUNCS: Record<string, (x: number) => number> = {
  sqrt: Math.sqrt,
  abs: Math.abs,
  sin: (x) => Math.sin(x * DEG),
  cos: (x) => Math.cos(x * DEG),
  tan: (x) => Math.tan(x * DEG),
};

class Parser {
  private i = 0;
  constructor(
    private s: string,
    private defaultScale: number,
    private lengths: boolean,
    private depth: number,
  ) {}

  parse(): number {
    const v = this.expr();
    this.ws();
    if (this.i < this.s.length) throw new Error("Unexpected input");
    return v;
  }

  private ws() {
    while (this.s[this.i] === " ") this.i++;
  }

  private expr(): number {
    let v = this.term();
    for (;;) {
      this.ws();
      const c = this.s[this.i];
      if (c === "+") (this.i++, (v += this.term()));
      else if (c === "-") (this.i++, (v -= this.term()));
      else return v;
    }
  }

  private term(): number {
    let v = this.power();
    for (;;) {
      this.ws();
      const c = this.s[this.i];
      // Multiplying/dividing two lengths would square units; treat the right side as a plain number.
      if (c === "*") (this.i++, (v *= this.power() / (this.lengths ? this.defaultScale : 1)));
      else if (c === "/") (this.i++, (v /= this.power() / (this.lengths ? this.defaultScale : 1)));
      else return v;
    }
  }

  /** a ^ b, right to left; both sides as plain numbers in the field's unit. */
  private power(): number {
    const v = this.factor();
    this.ws();
    if (this.s[this.i] !== "^") return v;
    this.i++;
    const k = this.lengths ? this.defaultScale : 1;
    return (v / k) ** (this.power() / k) * k;
  }

  private factor(): number {
    this.ws();
    const c = this.s[this.i];
    if (c === "-") {
      this.i++;
      return -this.factor();
    }
    if (c === "+") {
      this.i++;
      return this.factor();
    }
    if (c === "(") {
      this.i++;
      const v = this.expr();
      this.ws();
      if (this.s[this.i++] !== ")") throw new Error("Missing )");
      // Already in mm; a suffix re-interprets the bracketed number in that unit.
      return this.unit(v / this.defaultScale);
    }
    // (Also "5." - a dot typed and nothing after it yet.)
    const num = /^(\d+\.?\d*|\.\d+)(e[-+]?\d+)?/i.exec(this.s.slice(this.i));
    if (num) {
      this.i += num[0].length;
      return this.unit(parseFloat(num[0]));
    }
    const name = /^[a-z_][a-z0-9_]*/i.exec(this.s.slice(this.i));
    if (name) {
      this.i += name[0].length;
      const variable = variables.find((x) => x.name === name[0]);
      const k = this.lengths ? this.defaultScale : 1;
      const fn = !variable && FUNCS[name[0].toLowerCase()];
      if (fn) {
        // sqrt(3), sin(30): the bracket is a plain number in the field's unit (angles in degrees).
        this.ws();
        if (this.s[this.i++] !== "(") throw new Error("Missing (");
        const a = this.expr() / k;
        this.ws();
        if (this.s[this.i++] !== ")") throw new Error("Missing )");
        return fn(a) * k;
      }
      if (!variable && name[0].toLowerCase() === "pi") return this.unit(Math.PI);
      if (!variable || this.depth > 8) throw new Error(`Unknown variable ${name[0]}`);
      return new Parser(variable.expr, this.defaultScale, this.lengths, this.depth + 1).parse();
    }
    throw new Error("Expected a number");
  }

  /**
   * Apply an optional unit suffix; no suffix = current unit. In a plain
   * number (a count, a ratio) a length is in mm: "shadeR / 16 mm" is the
   * ratio of two lengths - a variable like "55 mm" was refused there.
   */
  private unit(v: number): number {
    this.ws();
    // An angle or a plain number may say "deg" / "°" (a variable "30 deg" used for a revolve).
    const deg = !this.lengths && /^(deg|°)(?![a-z])/i.exec(this.s.slice(this.i));
    if (deg) {
      this.i += deg[0].length;
      return v;
    }
    const m = /^(mm|cm|m|in|ft|"|')(?![a-z])/i.exec(this.s.slice(this.i));
    if (m) {
      this.i += m[0].length;
      const u = m[0] === '"' ? "in" : m[0] === "'" ? "ft" : (m[0].toLowerCase() as Units);
      return v * UNIT_MM[u];
    }
    return v * this.defaultScale;
  }
}
