// Which sketch curves the constraints hold completely (drawn green).
// Run: npx tsx tests/sketchdefined.test.ts
import type { SketchConstraint, SketchEntity } from "../src/doc/types";
import { definedCurves } from "../src/sketch/constraints";
import { check, done } from "./kit";

const L = (id: string, a: [number, number], b: [number, number]) => ({ id, kind: "line", a, b }) as SketchEntity;
const line = L("l", [0, 0], [10, 0]);
const fixA: SketchConstraint = { id: "f", type: "fix", pts: [{ e: "l", p: "a" }], at: [0, 0] };
const horiz: SketchConstraint = { id: "h", type: "horizontal", curves: ["l"] };
const length: SketchConstraint = { id: "d", type: "dim", curves: ["l"], prop: "length", value: 10 };

const free = definedCurves([line], []);
check("a line on its own is free", !!free && !free.defined.has("l") && !free.all, free);
const part = definedCurves([line], [fixA, horiz]);
check("one end fixed and horizontal: still slides longer", !!part && !part.defined.has("l"), part);
const full = definedCurves([line], [fixA, horiz, length]);
check("plus its length: fully defined", !!full && full.defined.has("l") && full.all, full);

// Two lines: one held, the other only joined to it - just the first is green.
const other = L("m", [10, 0], [10, 8]);
const join: SketchConstraint = { id: "c", type: "coincident", pts: [{ e: "l", p: "b" }, { e: "m", p: "a" }] };
const two = definedCurves([line, other], [fixA, horiz, length, join]);
check("the held line is, the one hanging off it isn't", !!two && two.defined.has("l") && !two.defined.has("m") && !two.all, two && [...two.defined]);

// A circle: centre fixed and its radius.
const circ = { id: "c1", kind: "circle", center: [5, 5], radius: 3 } as SketchEntity;
const c1 = definedCurves([circ], [{ id: "f", type: "fix", pts: [{ e: "c1", p: "c" }], at: [5, 5] }, { id: "r", type: "dim", curves: ["c1"], prop: "radius", value: 3 }]);
check("a circle with its centre fixed and radius set is defined", !!c1 && c1.all, c1 && [...c1.defined]);

done();
