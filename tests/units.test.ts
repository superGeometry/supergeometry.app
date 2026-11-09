// Run: npx tsx tests/units.test.ts - what a size field accepts.
import { evaluate, setVariables } from "../src/units";

let failed = 0;
const near = (a: number | null, b: number) => a !== null && Math.abs(a - b) < 1e-9;
function check(text: string, kind: "length" | "number" | "angle", want: number | null): void {
  const got = evaluate(text, kind);
  const ok = want === null ? got === null : near(got, want);
  if (!ok) failed++;
  console.log(ok ? "ok  " : "FAIL", `${kind} "${text}" = ${got} (want ${want})`);
}

setVariables([{ name: "af", expr: "36 mm" }]);
check("36/sqrt(3)", "length", 36 / Math.sqrt(3)); // a hex's corner radius from its size across the flats
check("af/sqrt(3)", "length", 36 / Math.sqrt(3));
check("2^3", "number", 8);
check("2^3^2", "number", 512); // right to left
check("3*2^2", "length", 12);
check("10*sin(30)", "length", 5); // degrees
check("cos(60)", "number", 0.5);
check("abs(-4)", "length", 4);
check("2*pi", "number", 2 * Math.PI);
check("1in + 1", "length", 26.4);
check("sqrt 3", "length", null); // needs its brackets
check("sqrt(3", "length", null);
check("nope(3)", "length", null);

process.exit(failed ? 1 : 0);
