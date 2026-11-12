// Sketch patterns stay linked: change the original and its copies follow.
// Run: npx tsx tests/sketchpattern.test.ts
import type { SketchConstraint, SketchEntity } from "../src/doc/types";
import { definedCurves, setValueStrict } from "../src/sketch/constraints";
import { check, done, near } from "./kit";

const C = (id: string, x: number, y: number, r: number) => ({ id, kind: "circle", center: [x, y], radius: r }) as SketchEntity;
const ents = [C("o", 0, 0, 2), C("c1", 10, 0, 2), C("c2", 20, 0, 2)];
const fix: SketchConstraint = { id: "f", type: "fix", pts: [{ e: "o", p: "c" }], at: [0, 0] };
const rad: SketchConstraint = { id: "r", type: "dim", curves: ["o"], prop: "radius", value: 2 };
const links: SketchConstraint[] = [
  { id: "p1", type: "pattern", curves: ["o", "c1"], at: [10, 0] },
  { id: "p2", type: "pattern", curves: ["o", "c2"], at: [20, 0] },
];
const all = [fix, rad, ...links];
const r = setValueStrict(ents, all, "r", 3);
const out = r?.result.entities.find((e) => e.id === "c2") as { center: [number, number]; radius: number } | undefined;
check("a linear pattern's copies take the original's new radius", !!out && near(out.radius, 3, 1e-6) && near(out.center[0], 20, 1e-6), out);
const d = definedCurves(ents, all);
check("the original held: so are its copies", !!d && d.all, d && [...d.defined]);

// Circular: a line turned 90° round the origin.
const L = (id: string, a: [number, number], b: [number, number]) => ({ id, kind: "line", a, b }) as SketchEntity;
const lines = [L("a", [5, 0], [8, 0]), L("b", [0, 5], [0, 8])];
const turn: SketchConstraint = { id: "t", type: "pattern", curves: ["a", "b"], turn: true, at: [0, 0], value: 90 };
const len: SketchConstraint = { id: "l", type: "dim", curves: ["a"], prop: "length", value: 3 };
const fa: SketchConstraint = { id: "fa", type: "fix", pts: [{ e: "a", p: "a" }], at: [5, 0] };
const h: SketchConstraint = { id: "h", type: "horizontal", curves: ["a"] };
const r2 = setValueStrict(lines, [fa, h, len, turn], "l", 6);
const b = r2?.result.entities.find((e) => e.id === "b") as { a: [number, number]; b: [number, number] } | undefined;
check("a circular pattern's copy follows (turned)", !!b && near(b.b[0], 0, 1e-6) && near(b.b[1], 11, 1e-6), b);

done();
