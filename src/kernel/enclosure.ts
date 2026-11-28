// The shapes of the enclosure tools: a screw boss, a rib, a lip and its groove, a snap hook and its slot.
// Each takes the body as it is and gives it back with the detail added (or cut): the engine says where.

import { basicFaceExtrusion, cast, getOC, makeCylinder, makeFace, makePolygon, makeVertex, measureArea, measureVolume, Vector, type Face, type Shape3D, type Wire } from "replicad";
import type { BossFeature, LipFeature, RibFeature, SnapFeature, Vec3 } from "../doc/types";
import { add, cross, dist, dot, norm, scale, sub, xDirFor } from "../geom";
import { subShapes } from "./health";

/** Which of the points are inside the solid (or any of its solids). */
function inside(s: Shape3D, at: Vec3[]): boolean[] {
  const oc = getOC();
  const out = at.map(() => false);
  for (const solid of subShapes(s, "SOLID")) {
    const d = new oc.BRepExtrema_DistShapeShape();
    try {
      d.LoadS1(solid);
      at.forEach((q, k) => {
        if (out[k]) return;
        const point = makeVertex(q);
        d.LoadS2(point.wrapped);
        d.Perform();
        if (d.IsDone() && d.InnerSolution()) out[k] = true;
      });
    } finally {
      d.delete();
    }
  }
  return out;
}

const pieces = (s: Shape3D): Shape3D[] => subShapes(s, "SOLID").map((x) => cast(x) as Shape3D);
/** A flat outline pushed along a line. */
const prism = (pts: Vec3[], along: Vec3): Shape3D => basicFaceExtrusion(makePolygon(pts), new Vector(along)) as Shape3D;
/** `ref` turned round `out` by degrees. */
const turned = (ref: Vec3, out: Vec3, deg: number): Vec3 => {
  const a = (deg * Math.PI) / 180;
  return norm(add(scale(ref, Math.cos(a)), scale(cross(out, ref), Math.sin(a))));
};
const reachOf = (body: Shape3D): number => {
  const [lo, hi] = body.boundingBox.bounds as [Vec3, Vec3];
  return Math.max(1, dist(lo, hi));
};

// ------------------------------------------------------------------ boss

export function bossFault(f: BossFeature): string | null {
  if (!(f.diameter > 0)) return "The boss's diameter must be more than 0";
  if (!(f.height > 0)) return "The boss's height must be more than 0";
  if (f.hole > 0 && !(f.hole < f.diameter)) return "The hole must be narrower than the boss";
  if (f.hole > 0 && !(f.holeDepth > 0)) return "The hole's depth must be more than 0";
  if (f.ribs > 0 && !(f.ribThickness > 0 && f.ribReach > 0)) return "The ribs' thickness and length must be more than 0";
  return null;
}

/**
 * A post for a screw standing on a flat face at `at` (`out`: the way out of the body there), a hole down its
 * middle, and ribs round its foot that stop at a wall they meet.
 */
export function bossOn(body: Shape3D, f: BossFeature, at: Vec3, out: Vec3): Shape3D {
  const R = f.diameter / 2;
  const r = Math.max(0, f.hole) / 2;
  const h = f.height;
  if (!inside(body, [sub(at, scale(out, Math.max(1e-3, R * 0.02)))])[0]) throw new Error("The boss is off the body there: drag it onto the face.");
  let post = makeCylinder(R, h, at, out) as Shape3D;
  const n = Math.max(0, Math.min(8, Math.round(f.ribs || 0)));
  if (n > 0) {
    const t = f.ribThickness;
    const top = h * 0.75;
    const land = Math.min(top, Math.max(0.4, top * 0.1));
    const from = (R + r) / 2;
    const u0 = norm(xDirFor(out));
    for (let k = 0; k < n; k++) {
      const d = turned(u0, out, (f.ribAngle ?? 0) + (360 * k) / n);
      const v = cross(out, d);
      // As far as its length, or to the wall in its way (a little into it, to be one piece with it).
      const z = land / 2;
      const p = (s: number): Vec3 => add(add(at, scale(d, s)), scale(out, z));
      const N = 32;
      const far = (i: number) => R + (f.ribReach * i) / N;
      const hit = inside(body, Array.from({ length: N }, (_, i) => p(far(i + 1))));
      let reach = f.ribReach;
      const j = hit.indexOf(true);
      if (j >= 0) {
        let [lo, hi] = [far(j), far(j + 1)];
        for (let i = 0; i < 12; i++) {
          const m = (lo + hi) / 2;
          if (inside(body, [p(m)])[0]) hi = m;
          else lo = m;
        }
        reach = hi - R + Math.min(0.2, t / 2);
      }
      if (!(reach > 1e-3)) continue;
      const q = (s: number, up: number): Vec3 => add(add(add(at, scale(d, s)), scale(out, up)), scale(v, -t / 2));
      post = post.fuse(prism([q(from, 0), q(R + reach, 0), q(R + reach, land), q(from, top)], scale(v, t))) as Shape3D;
    }
  }
  let made = body.fuse(post) as Shape3D;
  if (r > 0) {
    const over = Math.max(1e-3, r * 0.02);
    made = made.cut(makeCylinder(r, f.holeDepth + over, add(at, scale(out, h - f.holeDepth)), out) as Shape3D) as Shape3D;
  }
  return made;
}

// ------------------------------------------------------------------ snap fit

export function snapFault(f: SnapFeature): string | null {
  if (!(f.width > 0)) return "The width must be more than 0";
  if (!(f.hookHeight > 0)) return "The hook's height must be more than 0";
  if (!(f.overhang > 0)) return "The hook's overhang must be more than 0";
  if (f.kind === "hook" && !(f.length > 0 && f.thickness > 0)) return "The arm's length and thickness must be more than 0";
  if (!(f.clearance >= 0)) return "The clearance cannot be less than 0";
  return null;
}

/**
 * A hook: an arm standing on the face at `at`, a nose at its end facing `angle` round the face (flat underneath,
 * to hold; sloped on top, to slide in). A slot: the pocket in a wall that the nose springs into, the hook's size
 * and a clearance all round.
 */
export function snapOn(body: Shape3D, f: SnapFeature, at: Vec3, out: Vec3): Shape3D {
  const u = turned(norm(xDirFor(out)), out, f.angle ?? 0);
  const v = cross(out, u);
  if (f.kind === "slot") {
    const c = f.clearance;
    const W = f.width + 2 * c;
    const H = f.hookHeight + 2 * c;
    let depth = f.overhang + c;
    if (f.through) {
      const [lo, hi] = body.boundingBox.bounds as [Vec3, Vec3];
      depth = 0;
      for (const x of [lo[0], hi[0]]) for (const y of [lo[1], hi[1]]) for (const z of [lo[2], hi[2]]) depth = Math.max(depth, -dot(sub([x, y, z], at), out));
      depth += 1;
    }
    const over = Math.max(1e-3, Math.min(W, H) * 0.01);
    const p = (a: number, b: number): Vec3 => add(add(add(at, scale(u, a)), scale(v, b)), scale(out, over));
    const made = body.cut(prism([p(-H / 2, -W / 2), p(H / 2, -W / 2), p(H / 2, W / 2), p(-H / 2, W / 2)], scale(out, -(depth + over)))) as Shape3D;
    if (!(measureVolume(body) - measureVolume(made) > 1e-9)) throw new Error("The slot is off the body there: nothing to cut into. Drag it onto the face.");
    return made;
  }
  const t = f.thickness;
  const L = f.length;
  const o = f.overhang;
  const hh = f.hookHeight;
  if (!inside(body, [sub(at, scale(out, Math.max(1e-3, t * 0.02)))])[0]) throw new Error("The hook is off the body there: drag it onto the face.");
  const p = (a: number, z: number): Vec3 => add(add(add(at, scale(u, a)), scale(out, z)), scale(v, -f.width / 2));
  const arm = prism([p(-t / 2, 0), p(t / 2, 0), p(t / 2, L), p(t / 2 + o, L), p(t / 2 + o, L + hh * 0.25), p(0, L + hh), p(-t / 2, L + hh)], scale(v, f.width));
  return body.fuse(arm) as Shape3D;
}

// ------------------------------------------------------------------ lip

export function lipFault(f: LipFeature): string | null {
  if (!(f.width > 0)) return "The lip's width must be more than 0";
  if (!(f.height > 0)) return "The lip's height must be more than 0";
  if (!(f.clearance >= 0)) return "The clearance cannot be less than 0";
  return null;
}

/** The outline moved out (`grow`) or in by `d` in its plane: of the two ways the kernel can move it, the bigger or the smaller. */
function moved(w: Wire, d: number, grow: boolean): Face | null {
  let best: { face: Face; area: number } | null = null;
  for (const s of [d, -d]) {
    try {
      const face = makeFace(w.clone().offset2D(s, "intersection"));
      const area = measureArea(face);
      if (!(area > 0)) continue;
      if (!best || (grow ? area > best.area : area < best.area)) best = { face, area };
    } catch {
      // (Moved in past its middle: nothing left that way.)
    }
  }
  return best?.face ?? null;
}

/**
 * A lip along a rim (the flat face on top of a wall): a band of the rim's own shape, `width` wide, on the side of
 * the opening or the outside, raised by `height`. A groove: the same band cut into the rim, a clearance wider and
 * deeper - what the other half's lip sits in.
 */
export function lipOn(body: Shape3D, faces: Face[], f: LipFeature): Shape3D {
  const groove = f.kind === "groove";
  const w = f.width + (groove ? f.clearance : 0);
  const h = f.height + (groove ? f.clearance : 0);
  let made = body;
  for (const face of faces) {
    const n = norm(face.normalAt().toTuple() as Vec3);
    const over = Math.max(1e-3, h * 0.01);
    // The rim's own shape, as tall as the lip (a groove: from a hair over the rim down into it).
    const slab = groove ? (basicFaceExtrusion(face.clone().translate(scale(n, over)), new Vector(scale(n, -(h + over)))) as Shape3D) : (basicFaceExtrusion(face.clone(), new Vector(scale(n, h))) as Shape3D);
    const whole = measureVolume(slab);
    const tall = (g: Face): Shape3D => basicFaceExtrusion(g.translate(scale(n, -(h + 1))), new Vector(scale(n, 2 * (h + 1)))) as Shape3D;
    let band: Shape3D | null = null;
    if (f.side === "inside") {
      const holes = face.clone().innerWires();
      if (!holes.length) throw new Error("That face does not go round an opening: tap the rim of a hollow body (or set the side to Outside).");
      for (const hole of holes) {
        const grown = moved(hole, w, true);
        if (!grown) throw new Error("The lip could not follow the rim's shape");
        const part = slab.intersect(tall(grown)) as Shape3D;
        band = band ? (band.fuse(part) as Shape3D) : part;
      }
    } else {
      const less = moved(face.clone().outerWire(), w, false);
      band = less ? (slab.cut(tall(less)) as Shape3D) : slab;
    }
    if (!band || !(measureVolume(band) > 1e-9)) throw new Error("The lip came out with nothing in it");
    if (measureVolume(band) > whole * 0.999) throw new Error(`The ${groove ? "groove" : "lip"} is as wide as the wall: make it narrower.`);
    made = (groove ? made.cut(band) : made.fuse(band)) as Shape3D;
  }
  return made;
}

// ------------------------------------------------------------------ rib

export function ribFault(f: RibFeature): string | null {
  if (!(f.thickness > 0)) return "The rib's thickness must be more than 0";
  if (!(f.height > 0)) return "The rib's height must be more than 0";
  return null;
}

/** The loose ends of a path, each with the way the path runs out of it (null: it ends on a curve). */
function looseEnds(wire: Wire): { p: Vec3; dir: Vec3 | null }[] {
  const ends: { p: Vec3; other: Vec3; line: boolean }[] = [];
  for (const e of wire.edges) {
    const a = e.pointAt(0).toTuple() as Vec3;
    const b = e.pointAt(1).toTuple() as Vec3;
    ends.push({ p: a, other: b, line: e.geomType === "LINE" }, { p: b, other: a, line: e.geomType === "LINE" });
  }
  const size = Math.max(1e-9, ...ends.map((x) => dist(x.p, x.other)));
  return ends.filter((x, i) => !ends.some((y, k) => k !== i && dist(x.p, y.p) < size * 1e-6)).map((x) => ({ p: x.p, dir: x.line ? norm(sub(x.p, x.other)) : null }));
}

/**
 * A rib from lines drawn in a sketch: the lines made `thickness` thick. Drawn on a face of the body it rises
 * `height` from it; drawn above the body it goes down to whatever is under it. Its ends that are straight run on
 * to the wall they point at, if there is one.
 * Throws when this body is not the one the lines belong to.
 */
export function ribOn(body: Shape3D, wire: Wire, normal: Vec3, f: RibFeature): Shape3D {
  const n = norm(normal);
  const t = f.thickness;
  const ends = looseEnds(wire);
  // The lines, made thick (a closed shape: a band along it).
  let regions: Face[];
  if (ends.length) {
    try {
      regions = [makeFace(wire.clone().offset2D(t / 2, "arc"))];
      if (!(measureArea(regions[0]) > 0)) throw new Error("empty");
    } catch {
      // (Straight all the way - one line, or lines end to end: the kernel has no plane to move it in. Each line its own strip.)
      regions = wire.edges.map((e) => {
        if (e.geomType !== "LINE") throw new Error("The rib could not follow the lines");
        const a = e.pointAt(0).toTuple() as Vec3;
        const b = e.pointAt(1).toTuple() as Vec3;
        const w = scale(norm(cross(n, sub(b, a))), t / 2);
        return makePolygon([sub(a, w), sub(b, w), add(b, w), add(a, w)]);
      });
    }
  } else {
    const [a, b] = [moved(wire, t / 2, true), moved(wire, t / 2, false)];
    if (!a) throw new Error("The rib could not follow the lines");
    regions = [b ? makeFace(a.clone().outerWire(), [b.clone().outerWire()]) : a];
  }
  const mid = wire.edges[0].pointAt(0.5).toTuple() as Vec3;
  const eps = Math.max(2e-3, t * 0.02);
  const [above, below] = inside(body, [add(mid, scale(n, eps)), sub(mid, scale(n, eps))]);
  if (above && below) throw new Error("The lines are inside the body: draw them on a face of it, or above it.");
  const E = reachOf(body) * 1.5;
  const parts: Shape3D[] = [];
  let dir: Vec3;
  let deep = 0;
  if (above !== below) {
    // On the body: up from it.
    dir = above ? scale(n, -1) : n;
    for (const region of regions) parts.push(basicFaceExtrusion(region, new Vector(scale(dir, f.height))) as Shape3D);
  } else {
    // Above it: down to what is under the lines.
    const [lo, hi] = body.boundingBox.bounds as [Vec3, Vec3];
    const centre = scale(add(lo, hi), 0.5);
    dir = dot(sub(centre, mid), n) < 0 ? scale(n, -1) : n;
    deep = E;
    const samples = wire.edges.flatMap((e) => [0.1, 0.5, 0.9].map((k) => e.pointAt(k).toTuple() as Vec3));
    const kept = regions.flatMap((region) =>
      pieces((basicFaceExtrusion(region, new Vector(scale(dir, deep))) as Shape3D).cut(body) as Shape3D).filter((piece) => {
        const near = inside(piece, samples.map((q) => add(q, scale(dir, eps))));
        const far = inside(piece, samples.map((q) => add(q, scale(dir, deep - eps))));
        return near.some(Boolean) && !far.some(Boolean);
      }),
    );
    if (!kept.length) throw new Error("There is nothing under the lines for the rib to stand on.");
    parts.push(...kept);
  }
  if (f.extend !== false) {
    for (const end of ends) {
      if (!end.dir) continue;
      const e = end.dir;
      const w = cross(n, e);
      const q = (along: number, side: number): Vec3 => add(add(end.p, scale(e, along)), scale(w, side));
      const long = prism([q(0, -t / 2), q(E, -t / 2), q(E, t / 2), q(0, t / 2)], scale(dir, deep || f.height));
      const level = deep ? eps : f.height / 2;
      const at = (along: number, down = level): Vec3 => add(add(end.p, scale(e, along)), scale(dir, down));
      const piece = pieces(long.cut(body) as Shape3D).find((x) => inside(x, [at(eps)])[0]);
      if (!piece) continue;
      // (No wall that way, or no floor under it: the rib ends where it was drawn.)
      const runsOff = inside(piece, [at(E - eps), ...(deep ? [0.25, 0.5, 0.75, 1].map((k) => at(Math.max(eps, k * E - eps), deep - eps)) : [])]);
      if (runsOff.some(Boolean)) continue;
      parts.push(piece);
    }
  }
  let made = body;
  for (const part of parts) made = made.fuse(part) as Shape3D;
  if (!(measureVolume(made) - measureVolume(body) > 1e-9)) throw new Error("The rib added nothing: it is inside the body already.");
  return made;
}
