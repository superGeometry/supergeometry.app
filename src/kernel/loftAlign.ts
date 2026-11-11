// A loft through sections that are each one closed curve (circles, ellipses,
// a closed spline) whose starts already line up, made as one smooth side.
//
// OpenCascade's loft first makes the sections "compatible": where their start
// points aren't exactly in line it projects each one's start onto the others
// and splits them all there. Six ellipses turned to a propeller's pitch came
// out with six faces down the blade instead of one, the blade's root on the hub
// chopped into pieces 1.3 mm long, and its root fillet failed. When the starts
// are near enough in line already (and the curves all run the same way round),
// the sections are lofted as they are.
import { cast, getOC, isShape3D, type Shape3D, type Wire } from "replicad";
import { add, cross, dot, len, norm, scale, sub } from "../geom";
import type { Vec3 } from "../doc/types";

const centre = (w: Wire): Vec3 => {
  const e = w.edges[0];
  let c: Vec3 = [0, 0, 0];
  const n = 32;
  for (let k = 0; k < n; k++) c = add(c, e.pointAt(k / n).toTuple() as Vec3);
  return scale(c, 1 / n);
};

/** Single closed curves, starts in line, all one way round: lofted without splitting (else null). */
export function loftInLine(wires: Wire[], ruled: boolean): Shape3D | null {
  if (wires.length < 2 || wires.some((w) => w.edges.length !== 1 || !w.isClosed)) return null;
  const cs = wires.map(centre);
  const axis = norm(sub(cs[cs.length - 1], cs[0]));
  if (!(len(sub(cs[cs.length - 1], cs[0])) > 1e-9)) return null;
  let prev: Vec3 | null = null;
  let sense = 0;
  for (const [i, w] of wires.entries()) {
    const e = w.edges[0];
    const s = sub(e.startPoint.toTuple() as Vec3, cs[i]);
    // Seen down the loft's run, its start's direction from its middle...
    const flat = sub(s, scale(axis, dot(s, axis)));
    if (len(flat) < 1e-9) return null;
    const d = norm(flat);
    // ...within 45° of the one before's.
    if (prev && dot(d, prev) < Math.SQRT1_2) return null;
    prev = d;
    // And the same way round.
    const turn = Math.sign(dot(cross(s, e.tangentAt(0).toTuple() as Vec3), axis));
    if (!turn || (sense && turn !== sense)) return null;
    sense = turn;
  }
  const oc = getOC();
  const b = new oc.BRepOffsetAPI_ThruSections(true, ruled, 1e-6);
  try {
    b.CheckCompatibility(false);
    for (const w of wires) b.AddWire(w.wrapped);
    b.Build();
    if (!b.IsDone()) return null;
    const shape = cast(b.Shape());
    return isShape3D(shape) ? shape : null;
  } catch {
    return null;
  } finally {
    b.delete();
  }
}
