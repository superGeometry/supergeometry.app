// Run: npx tsx tests/bodyparity.test.ts - Symmetric extrude and Two-Distance chamfer through the real engine.
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import type { Feature, PlaneDef } from "../src/doc/types";
import { regenerate } from "../src/kernel/engine";
import { arrangement, regionRef } from "../src/sketch/regions";

setOC(await (opencascade as unknown as () => Promise<any>)());

const XY: PlaneDef = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] };
const rect = [{ id: "r", kind: "rect", center: [0, 0], w: 40, h: 20, rotation: 0 }];
const regions = arrangement(rect as any).regions.map(regionRef);
const sketch: Feature = { id: "s1", name: "s1", type: "sketch", plane: XY, entities: rect as any };
const box = (extra: Partial<Feature> = {}): Feature => ({ id: "e1", name: "Extrude", type: "extrude", source: { kind: "profile", sketch: "s1", regions }, distance: 10, mode: "auto", ...extra }) as Feature;

let failed = 0;
const check = (name: string, ok: boolean, info: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${info}`);
  if (!ok) failed++;
};
const zs = (r: Awaited<ReturnType<typeof regenerate>>) => Array.from(r.bodies[0].positions).filter((_, i) => i % 3 === 2);

// Symmetric: 10 each side, from z = -10 to z = 10.
{
  const r = await regenerate([sketch, box({ symmetric: true } as Partial<Feature>)]);
  const z = zs(r);
  const lo = Math.min(...z);
  const hi = Math.max(...z);
  check("symmetric extrude", r.errors.length === 0 && Math.abs(lo + 10) < 1e-6 && Math.abs(hi - 10) < 1e-6, `z ${lo}..${hi}, errors ${r.errors.map((e) => e.message)}`);
}
// Symmetric with a taper: refused with a clear message.
{
  const r = await regenerate([sketch, box({ symmetric: true, taper: 0.5 } as Partial<Feature>)]);
  check("symmetric + taper refused", r.errors.length === 1 && /one way/.test(r.errors[0].message), r.errors.map((e) => e.message).join());
}

// Two-Distance chamfer on the top long edge (y = 10, z = 10): 2 along one face, 5 along the other.
const edge = { body: "e1", mid: [0, 10, 10] as [number, number, number], dir: [1, 0, 0] as [number, number, number], length: 40 };
const chamfer = (extra: object): Feature => ({ id: "c1", name: "Chamfer", type: "chamfer", edges: [edge], radius: 2, ...extra }) as Feature;
{
  const eq = await regenerate([sketch, box(), chamfer({})]);
  const two = await regenerate([sketch, box(), chamfer({ distance2: 5 })]);
  const flipped = await regenerate([sketch, box(), chamfer({ distance2: 5, flip: true })]);
  const errs = [...eq.errors, ...two.errors, ...flipped.errors].map((e) => e.message);
  check("chamfers rebuild", errs.length === 0, errs.join() || "no errors");
  check("equal chamfer: 7 faces", eq.bodies[0].faces.length === 7, `${eq.bodies[0].faces.length} faces`);
  check("two-distance: 7 faces", two.bodies[0].faces.length === 7, `${two.bodies[0].faces.length} faces`);
  // The slant's two ends: 2 and 5 from the edge, one on each face; flipped swaps them.
  const a = await slant(two);
  const b = await slant(flipped);
  check("two-distance sizes", near(a, [2, 5]), JSON.stringify(a));
  check("flip swaps the sides", near(b, [2, 5]) && a[0] !== b[0], `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
}

/** How far the slant runs along the top face and down the side face (from the box's corner line). */
async function slant(r: Awaited<ReturnType<typeof regenerate>>): Promise<[number, number]> {
  const p = Array.from(r.bodies[0].positions);
  let topY = -Infinity;
  let sideZ = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    const [y, z] = [p[i + 1], p[i + 2]];
    if (Math.abs(z - 10) < 1e-6) topY = Math.max(topY, y);
    if (Math.abs(y - 10) < 1e-6) sideZ = Math.max(sideZ, z);
  }
  return [Math.round((10 - topY) * 1e4) / 1e4, Math.round((10 - sideZ) * 1e4) / 1e4];
}
function near(v: [number, number], want: [number, number]): boolean {
  const s = [...v].sort((x, y) => x - y);
  return Math.abs(s[0] - want[0]) < 1e-3 && Math.abs(s[1] - want[1]) < 1e-3;
}

// Sweep with an end size: a circle of radius 2 along a 50 long line, twice as big at the end.
{
  const XZ: PlaneDef = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, -1, 0] };
  const prof: Feature = { id: "g", name: "g", type: "sketch", plane: XY, entities: [{ id: "c", kind: "circle", center: [0, 0], radius: 2 }] as any };
  const path: Feature = { id: "p", name: "p", type: "sketch", plane: XZ, entities: [{ id: "l", kind: "line", a: [0, 0], b: [0, 50] }] as any };
  const regionsC = arrangement(prof.entities as any).regions.map(regionRef);
  const sweep = (scale?: number): Feature => ({ id: "w", name: "Sweep", type: "sweep", source: { kind: "profile", sketch: "g", regions: regionsC }, path: { kind: "sketch", sketch: "p", entities: ["l"] }, mode: "new", scale }) as Feature;
  const radiusAt = (r: Awaited<ReturnType<typeof regenerate>>, zWant: number) => {
    const p = Array.from(r.bodies[0].positions);
    let best = 0;
    for (let i = 0; i < p.length; i += 3) if (Math.abs(p[i + 2] - zWant) < 1e-3) best = Math.max(best, Math.hypot(p[i], p[i + 1]));
    return Math.round(best * 1e3) / 1e3;
  };
  const plain = await regenerate([prof, path, sweep()]);
  const grown = await regenerate([prof, path, sweep(2)]);
  const errs = [...plain.errors, ...grown.errors].map((e) => e.message);
  check("sweeps rebuild", errs.length === 0, errs.join() || "no errors");
  if (!errs.length) {
    const ends = [radiusAt(grown, 0), radiusAt(grown, 50)].sort((a, b) => a - b);
    check("plain sweep keeps its size", radiusAt(plain, 0) === 2 && radiusAt(plain, 50) === 2, `${radiusAt(plain, 0)} / ${radiusAt(plain, 50)}`);
    check("end size 2 doubles it", ends[0] === 2 && ends[1] === 4, JSON.stringify(ends));
  }
}

// Variable fillet: radius 2 at one end of the edge, 5 at the other; Flip ends swaps them.
{
  const fillet = (extra: object): Feature => ({ id: "f1", name: "Fillet", type: "fillet", edges: [edge], radius: 2, ...extra }) as Feature;
  const v = await regenerate([sketch, box(), fillet({ radius2: 5 })]);
  const vf = await regenerate([sketch, box(), fillet({ radius2: 5, flip: true })]);
  const errs = [...v.errors, ...vf.errors].map((e) => e.message);
  check("variable fillets rebuild", errs.length === 0, errs.join() || "no errors");
  if (!errs.length) {
    // How far the rounding runs back from the edge along the top face, at each end (x = -20, x = 20).
    const back = (r: Awaited<ReturnType<typeof regenerate>>, xWant: number) => {
      const p = Array.from(r.bodies[0].positions);
      let topY = -Infinity;
      for (let i = 0; i < p.length; i += 3) if (Math.abs(p[i] - xWant) < 1e-6 && Math.abs(p[i + 2] - 10) < 1e-6) topY = Math.max(topY, p[i + 1]);
      return Math.round((10 - topY) * 1e3) / 1e3;
    };
    const a = [back(v, -20), back(v, 20)];
    const b = [back(vf, -20), back(vf, 20)];
    check("variable radii at the ends", near(a as [number, number], [2, 5]), JSON.stringify(a));
    check("flip ends swaps them", a[0] === b[1] && a[1] === b[0], `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  }
}

// Chord-width fillet: 2 across a square edge is a radius of 2 / sqrt(2).
{
  const fillet = (extra: object): Feature => ({ id: "f1", name: "Fillet", type: "fillet", edges: [edge], radius: 2, chord: true, ...extra }) as Feature;
  const r = await regenerate([sketch, box(), fillet({})]);
  check("chord fillet rebuilds", r.errors.length === 0, r.errors.map((e) => e.message).join() || "no errors");
  if (!r.errors.length) {
    const s = await slant(r);
    check("chord 2 is radius 1.414", near(s, [Math.SQRT2, Math.SQRT2]), JSON.stringify(s));
  }
  // Faces meeting at a changing angle (a loft between a rectangle and the same one turned 30°): still rounds.
  const top: Feature = { id: "s2", name: "s2", type: "sketch", plane: { origin: [0, 0, 20], xDir: [1, 0, 0], normal: [0, 0, 1] }, entities: [{ id: "r2", kind: "rect", center: [0, 0], w: 40, h: 20, rotation: 30 }] as any };
  const topRegions = arrangement(top.entities as any).regions.map(regionRef);
  const loft = { id: "L", name: "Loft", type: "loft", sections: [{ kind: "profile", sketch: "s1", regions }, { kind: "profile", sketch: "s2", regions: topRegions }], ruled: true, mode: "new" } as Feature;
  const lofted = await regenerate([sketch, top, loft]);
  const faces0 = lofted.bodies[0]?.faces.length ?? 0;
  const edges0 = lofted.bodies[0] ? (lofted.bodies[0] as any).edges : [];
  // A side edge of the twisted shape: from the first corner below to its turned self above.
  const side = (edges0 as any[]).find((e) => e.type !== "LINE" || Math.abs(e.dir?.[2] ?? 0) > 0.3);
  if (side) {
    const ref = { body: "L", mid: side.mid ?? side.center ?? side.start, dir: side.dir ?? [0, 0, 1], length: side.length ?? 20 };
    const twisted = await regenerate([sketch, top, loft, { id: "f2", name: "Fillet", type: "fillet", edges: [ref], radius: 1, chord: true } as Feature]);
    check("chord fillet on a twisted edge", twisted.errors.length === 0 && twisted.bodies[0].faces.length === faces0 + 1, `${twisted.errors.map((e) => e.message).join() || "no errors"}, faces ${faces0} -> ${twisted.bodies[0]?.faces.length}`);
  } else check("found a twisted edge", false, JSON.stringify(Object.keys(lofted.bodies[0] ?? {})));
}

// Sweep twist: a 20 x 10 rectangle up a 50 line, a quarter turn - the top is turned square on.
{
  const XZ: PlaneDef = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, -1, 0] };
  const prof: Feature = { id: "g", name: "g", type: "sketch", plane: XY, entities: [{ id: "q", kind: "rect", center: [0, 0], w: 20, h: 10, rotation: 0 }] as any };
  const line: Feature = { id: "p", name: "p", type: "sketch", plane: XZ, entities: [{ id: "l", kind: "line", a: [0, 0], b: [0, 50] }] as any };
  const arc: Feature = { id: "p", name: "p", type: "sketch", plane: XZ, entities: [{ id: "l", kind: "arc", a: [0, 0], m: [40 - 40 * Math.SQRT1_2, 40 * Math.SQRT1_2], b: [40, 40] }] as any };
  const regionsQ = arrangement(prof.entities as any).regions.map(regionRef);
  const sweep = (twist?: number): Feature => ({ id: "w", name: "Sweep", type: "sweep", source: { kind: "profile", sketch: "g", regions: regionsQ }, path: { kind: "sketch", sketch: "p", entities: ["l"] }, mode: "new", twist }) as Feature;
  const span = (r: Awaited<ReturnType<typeof regenerate>>, zWant: number) => {
    const p = Array.from(r.bodies[0].positions);
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < p.length; i += 3) if (Math.abs(p[i + 2] - zWant) < 1e-3) ((lo = Math.min(lo, p[i])), (hi = Math.max(hi, p[i])));
    return Math.round((hi - lo) * 1e3) / 1e3;
  };
  const t = await regenerate([prof, line, sweep(90)]);
  check("twisted sweep rebuilds", t.errors.length === 0, t.errors.map((e) => e.message).join() || "no errors");
  if (!t.errors.length) check("quarter turn: top is 10 wide in x, bottom 20", span(t, 0) === 20 && span(t, 50) === 10, `${span(t, 0)} / ${span(t, 50)}`);
  const plainArc = await regenerate([prof, arc, sweep()]);
  const twistArc = await regenerate([prof, arc, sweep(180)]);
  const errs = [...plainArc.errors, ...twistArc.errors].map((e) => e.message);
  check("twist along a curve rebuilds", errs.length === 0, errs.join() || "no errors");
  if (!errs.length) {
    const vol = (b: any) => {
      const p = b.positions, ix = b.indices;
      let v = 0;
      for (let i = 0; i < ix.length; i += 3) {
        const [a, c, d] = [ix[i] * 3, ix[i + 1] * 3, ix[i + 2] * 3];
        v += p[a] * (p[c + 1] * p[d + 2] - p[c + 2] * p[d + 1]) - p[a + 1] * (p[c] * p[d + 2] - p[c + 2] * p[d]) + p[a + 2] * (p[c] * p[d + 1] - p[c + 1] * p[d]);
      }
      return Math.abs(v / 6);
    };
    const v0 = vol(plainArc.bodies[0]);
    const v1 = vol(twistArc.bodies[0]);
    check("twist keeps the volume", v0 > 0 && Math.abs(v1 - v0) / v0 < 0.02, `${v0.toFixed(1)} vs ${v1.toFixed(1)}`);
  }
}

// Loft, closed loop: four small circles round the z axis make a ring; along a guide: radius 3 to 6 up a line.
{
  const vol = (b: any) => {
    const p = b.positions, ix = b.indices;
    let v = 0;
    for (let i = 0; i < ix.length; i += 3) {
      const [a, c, d] = [ix[i] * 3, ix[i + 1] * 3, ix[i + 2] * 3];
      v += p[a] * (p[c + 1] * p[d + 2] - p[c + 2] * p[d + 1]) - p[a + 1] * (p[c] * p[d + 2] - p[c + 2] * p[d]) + p[a + 2] * (p[c] * p[d + 1] - p[c + 1] * p[d]);
    }
    return Math.abs(v / 6);
  };
  const ring: Feature[] = [0, 90, 180, 270].map((deg, i) => {
    const a = (deg * Math.PI) / 180;
    return { id: `k${i}`, name: `k${i}`, type: "sketch", plane: { origin: [20 * Math.cos(a), 20 * Math.sin(a), 0], xDir: [Math.cos(a), Math.sin(a), 0], normal: [-Math.sin(a), Math.cos(a), 0] }, entities: [{ id: `c${i}`, kind: "circle", center: [0, 0], radius: 3 }] } as any;
  });
  const sec = (sk: Feature) => ({ kind: "profile", sketch: sk.id, regions: arrangement((sk as any).entities).regions.map(regionRef) });
  const closed = await regenerate([...ring, { id: "L", name: "Loft", type: "loft", sections: ring.map(sec), ruled: false, mode: "new", closed: true } as any]);
  check("closed loop loft rebuilds", closed.errors.length === 0, closed.errors.map((e) => e.message).join() || "no errors");
  if (!closed.errors.length) {
    const v = vol(closed.bodies[0]);
    const torus = 2 * Math.PI * Math.PI * 20 * 9;
    check("closed loop is a ring", Math.abs(v - torus) / torus < 0.1, `${v.toFixed(0)} vs torus ${torus.toFixed(0)}`);
  }
  const XZ: PlaneDef = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, -1, 0] };
  const lo: Feature = { id: "a", name: "a", type: "sketch", plane: XY, entities: [{ id: "ca", kind: "circle", center: [0, 0], radius: 3 }] } as any;
  const hi: Feature = { id: "b", name: "b", type: "sketch", plane: { origin: [0, 0, 30], xDir: [1, 0, 0], normal: [0, 0, 1] }, entities: [{ id: "cb", kind: "circle", center: [0, 0], radius: 6 }] } as any;
  const rail: Feature = { id: "p", name: "p", type: "sketch", plane: XZ, entities: [{ id: "l", kind: "line", a: [0, 0], b: [0, 30] }] } as any;
  const guided = await regenerate([lo, hi, rail, { id: "L", name: "Loft", type: "loft", sections: [sec(hi), sec(lo)], ruled: false, mode: "new", guide: { kind: "sketch", sketch: "p", entities: ["l"] } } as any]);
  check("guided loft rebuilds", guided.errors.length === 0, guided.errors.map((e) => e.message).join() || "no errors");
  if (!guided.errors.length) {
    const v = vol(guided.bodies[0]);
    const cone = (Math.PI * 30 * (9 + 18 + 36)) / 3;
    check("guided loft: 3 to 6 is a cone", Math.abs(v - cone) / cone < 0.02, `${v.toFixed(0)} vs ${cone.toFixed(0)}`);
  }
}

// Smooth (G2) fillet: on a box edge it starts 2 back on both faces; on a cylinder's rim it goes all round.
{
  const g = await regenerate([sketch, box(), { id: "f1", name: "Fillet", type: "fillet", edges: [edge], radius: 2, g2: true } as Feature]);
  check("G2 fillet on a box edge rebuilds", g.errors.length === 0 && g.bodies[0].faces.length === 7, `${g.errors.map((e) => e.message).join() || "no errors"}, ${g.bodies[0]?.faces.length} faces`);
  if (!g.errors.length) {
    const s = await slant(g);
    check("G2 starts where a round of the same radius would", near(s, [2, 2]), JSON.stringify(s));
  }
  const disc: Feature = { id: "d", name: "d", type: "sketch", plane: XY, entities: [{ id: "cd", kind: "circle", center: [0, 0], radius: 10 }] } as any;
  const cyl = { id: "e2", name: "Extrude", type: "extrude", source: { kind: "profile", sketch: "d", regions: arrangement((disc as any).entities).regions.map(regionRef) }, distance: 20, mode: "new" } as Feature;
  const rim = { body: "e2", mid: [-10, 0, 20] as [number, number, number], dir: [0, 1, 0] as [number, number, number], length: 2 * Math.PI * 10 };
  const c = await regenerate([disc, cyl, { id: "f2", name: "Fillet", type: "fillet", edges: [rim], radius: 2, g2: true } as Feature]);
  check("G2 fillet on a cylinder rim rebuilds", c.errors.length === 0, c.errors.map((e) => e.message).join() || "no errors");
  if (!c.errors.length) {
    const p = Array.from(c.bodies[0].positions);
    let topR = 0;
    for (let i = 0; i < p.length; i += 3) if (Math.abs(p[i + 2] - 20) < 1e-6) topR = Math.max(topR, Math.hypot(p[i], p[i + 1]));
    check("G2 rim: the flat top ends 2 in", Math.abs(topR - 8) < 1e-3, `top radius ${topR.toFixed(4)}`);
  }
}

// Setback: the three rounds at the box corner (20, 10, 10) stop 4 short and a patch joins them; still a sound solid.
{
  const { shapeValid } = await import("../src/kernel/health");
  const three = [edge, { body: "e1", mid: [20, 0, 10] as [number, number, number], dir: [0, 1, 0] as [number, number, number], length: 20 }, { body: "e1", mid: [20, 10, 5] as [number, number, number], dir: [0, 0, 1] as [number, number, number], length: 10 }];
  const fil = (setback?: number) => ({ id: "f1", name: "Fillet", type: "fillet", edges: three, radius: 2, setback }) as Feature;
  const plain = await regenerate([sketch, box(), fil()]);
  const back = await regenerate([sketch, box(), fil(4)]);
  const errs = [...plain.errors, ...back.errors].map((e) => e.message);
  check("setback corner rebuilds", errs.length === 0, errs.join() || "no errors");
  const vol = (b: any) => {
    const p = b.positions, ix = b.indices;
    let v = 0;
    for (let i = 0; i < ix.length; i += 3) {
      const [a, c, d] = [ix[i] * 3, ix[i + 1] * 3, ix[i + 2] * 3];
      v += p[a] * (p[c + 1] * p[d + 2] - p[c + 2] * p[d + 1]) - p[a + 1] * (p[c] * p[d + 2] - p[c + 2] * p[d]) + p[a + 2] * (p[c] * p[d + 1] - p[c + 1] * p[d]);
    }
    return v / 6;
  };
  if (!errs.length) check("setback: about the same volume, a little less", vol(back.bodies[0]) < vol(plain.bodies[0]) && vol(plain.bodies[0]) - vol(back.bodies[0]) < 5, `${vol(plain.bodies[0]).toFixed(2)} -> ${vol(back.bodies[0]).toFixed(2)}`);
  const tooSmall = await regenerate([sketch, box(), fil(2)]);
  check("setback too small is refused", tooSmall.errors.length === 1 && /at least/.test(tooSmall.errors[0].message), tooSmall.errors.map((e) => e.message).join());
  void shapeValid;
}

// Overflow (keep surface): radius 3 on a 2 thick plate's top edge is too big for the side face. It's built as a
// true round (centre y 7, z -1) that cuts on through the bottom edge: the top ends at y 7, the bottom at 7 + sqrt(8).
{
  const plate = box({ distance: 2 } as Partial<Feature>);
  const r = await regenerate([sketch, plate, { id: "f1", name: "Fillet", type: "fillet", edges: [{ body: "e1", mid: [0, 10, 2], dir: [1, 0, 0], length: 40 }], radius: 3 } as Feature]);
  check("overflowing round builds", r.errors.length === 0, r.errors.map((e) => e.message).join() || "no errors");
  check("overflowing round says so", (r.notes ?? []).some((n) => /cuts on through/.test(n.message)), (r.notes ?? []).map((n) => n.message).join() || "no note");
  if (!r.errors.length) {
    const p = Array.from(r.bodies[0].positions);
    let top = -Infinity, bottom = -Infinity, far = -Infinity;
    for (let i = 0; i < p.length; i += 3) {
      if (Math.abs(p[i + 2] - 2) < 1e-6) top = Math.max(top, p[i + 1]);
      if (Math.abs(p[i + 2]) < 1e-6) bottom = Math.max(bottom, p[i + 1]);
      far = Math.max(far, p[i + 1]);
    }
    check("keeps a true round", Math.abs(top - 7) < 1e-3 && Math.abs(bottom - (7 + Math.sqrt(8))) < 1e-3 && far < 10 - 1e-3, `top ${top.toFixed(4)}, bottom ${bottom.toFixed(4)}, furthest ${far.toFixed(4)}`);
  }
}

if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log("all passed");
