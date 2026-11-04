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
 * Parse a field value: numbers, + - * / ^ ( ), unit suffixes (25.4mm, 1in,
 * 2 ft), and variable names. Plain numbers are in the current unit.
 * Returns millimetres for lengths (kind "length"), the raw value otherwise.
 */
export function evaluate(text: string, kind: "length" | "number" | "angle" = "length"): number | null {
  try {
    const scaleFor = kind === "length" ? UNIT_MM[current] : 1;
    const v = new Parser(text, scaleFor, kind === "length", 0).parse();
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

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
    let v = this.factor();
    for (;;) {
      this.ws();
      const c = this.s[this.i];
      // Multiplying/dividing two lengths would square units; treat the right side as a plain number.
      if (c === "*") (this.i++, (v *= this.factor() / (this.lengths ? this.defaultScale : 1)));
      else if (c === "/") (this.i++, (v /= this.factor() / (this.lengths ? this.defaultScale : 1)));
      else return v;
    }
  }

  private factor(): number {
    this.ws();
    const c = this.s[this.i];
    if (c === "-") {
      this.i++;
      return -this.factor();
    }
    if (c === "(") {
      this.i++;
      const v = this.expr();
      this.ws();
      if (this.s[this.i++] !== ")") throw new Error("Missing )");
      // Already in mm; a suffix re-interprets the bracketed number in that unit.
      return this.unit(v / this.defaultScale);
    }
    const num = /^\d*\.?\d+(e[-+]?\d+)?/i.exec(this.s.slice(this.i));
    if (num) {
      this.i += num[0].length;
      return this.unit(parseFloat(num[0]));
    }
    const name = /^[a-z_][a-z0-9_]*/i.exec(this.s.slice(this.i));
    if (name) {
      this.i += name[0].length;
      const variable = variables.find((x) => x.name === name[0]);
      if (!variable || this.depth > 8) throw new Error(`Unknown variable ${name[0]}`);
      return new Parser(variable.expr, this.defaultScale, this.lengths, this.depth + 1).parse();
    }
    throw new Error("Expected a number");
  }

  /** Apply an optional unit suffix; no suffix = current unit. */
  private unit(v: number): number {
    this.ws();
    const m = /^(mm|cm|m|in|ft|"|')(?![a-z])/i.exec(this.s.slice(this.i));
    if (m && this.lengths) {
      this.i += m[0].length;
      const u = m[0] === '"' ? "in" : m[0] === "'" ? "ft" : (m[0].toLowerCase() as Units);
      return v * UNIT_MM[u];
    }
    return v * this.defaultScale;
  }
}
