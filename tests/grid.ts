// Shared pieces of the grid tests (gridbooleans, gridextrude, gridfillet, gridshapes,
// gridfaces, gridsizes, shellclose): one operation tried over a grid of shapes, places
// and sizes, each result held to a volume worked out by hand and to being one sound solid.
//
//   import { build, say, near, faceRef, edgeRefs } from "./grid";
//   const g = await build([...steps]);
//   say(!g.errors.length && !g.unsound.length && near(g.vol.A, 24000), "a block", `${g.errors} ${g.unsound} ${g.vol.A}`);
import { after, bodies, check, health } from "./kit";
import { measureArea, type Shape3D } from "replicad";
import type { Feature, Vec3 } from "../src/doc/types";

/** One case: ok or FAIL, with what was found when it fails. */
export const say = (ok: boolean, name: string, info: string) => check(name, ok, ok ? "" : info);

export interface Got {
  /** The steps' errors ("step: message"). */
  errors: string[];
  ids: string[];
  /** Each body's volume. */
  vol: Record<string, number>;
  /** What is wrong with the bodies (invalid, more solids than expected, open edges, hair-thin faces). */
  unsound: string[];
}

/** Build the steps: each body's volume, and whether it is one sound solid (`pieces`: bodies meant to be more, or 0 for any number). */
export async function build(fs: Feature[], pieces: Record<string, number> = {}): Promise<Got> {
  const { errors } = await after(fs);
  const vol: Record<string, number> = {};
  const unsound: string[] = [];
  for (const [id, s] of bodies()) {
    const h = health(s);
    vol[id] = h.volume;
    const want = pieces[id] ?? 1;
    if (!h.valid) unsound.push(`${id} invalid`);
    if (want && h.solids !== want) unsound.push(`${id}: ${h.solids} solids`);
    if (h.openEdges) unsound.push(`${id}: ${h.openEdges} open edges`);
    if (h.thin) unsound.push(`${id}: ${h.thin} thin faces`);
  }
  return { errors, ids: [...bodies().keys()], vol, unsound };
}

/** The same number, to a part in ten thousand (or `rel`). */
export const near = (a: number, b: number, rel = 1e-4, abs = 1e-6) => Math.abs(a - b) <= Math.max(abs, rel * Math.max(Math.abs(a), Math.abs(b)));

const unit = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/**
 * A face of a body, as the last build left it, by a test on its (unit) normal
 * and its middle: the reference a step takes. Build the steps before it first -
 * the faces are those of the last build.
 */
export function faceRef(body: string, pick: (n: Vec3, c: Vec3, f: any) => boolean) {
  const s = bodies().get(body) as Shape3D;
  // (replicad's normalAt isn't a unit vector on round faces.)
  const f = s.faces.find((x) => pick(unit(x.normalAt().toTuple() as Vec3), x.center.toTuple() as Vec3, x));
  if (!f) throw new Error(`no such face on ${body}`);
  return { body, center: f.center.toTuple() as Vec3, normal: unit(f.normalAt().toTuple() as Vec3), area: measureArea(f) };
}

/** Edges of a body, as the last build left it, by a test on their middle and direction. */
export function edgeRefs(body: string, pick: (mid: Vec3, dir: Vec3, e: any) => boolean) {
  const s = bodies().get(body) as Shape3D;
  return s.edges
    .filter((e) => pick(e.pointAt(0.5).toTuple() as Vec3, e.tangentAt(0.5).toTuple() as Vec3, e))
    .map((e) => ({ body, mid: e.pointAt(0.5).toTuple() as Vec3, dir: e.tangentAt(0.5).toTuple() as Vec3, length: e.length as number }));
}
