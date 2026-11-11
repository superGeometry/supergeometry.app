// Shared pieces of the tests: the geometry engine started once, pass/fail
// counting, and quick ways to write sketches, shapes and steps.
//
//   import { check, done, sketch, rect, circle, extrude, XY, after } from "./kit";
//   const fs = [sketch("s", XY(), [rect("r", 0, 0, 10, 10)]), extrude("E", "s", 5)];
//   const { body, err } = await after(fs, "E");
//   check("a 10 x 10 x 5 block", !err && Math.abs(volume(body) - 500) < 1e-6);
//   done();
import opencascade from "replicad-opencascadejs";
import { measureVolume, setOC, type Shape3D } from "replicad";
import { debugBodies, healthReport, regenerate } from "../src/kernel/engine";
import { arrangement, regionRef } from "../src/sketch/regions";
import type { Feature, PlaneDef, SketchEntity, Vec3 } from "../src/doc/types";
import type { BodyHealth, RegenResult } from "../src/kernel/protocol";

setOC(await (opencascade as unknown as () => Promise<any>)());

// ------------------------------------------------------------------ results

let failed = 0;
let passed = 0;

/** One check: printed as ok or FAIL, with what was found when it fails (or always, if given). */
export function check(name: string, ok: boolean, info: unknown = ""): boolean {
  if (ok) passed++;
  else failed++;
  console.log(ok ? "ok  " : "FAIL", name, typeof info === "string" ? info : JSON.stringify(info));
  return ok;
}

/** Near enough: |a - b| <= tol. */
export const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;

/** The end of a test file: the count, and the exit code. */
export function done(): never {
  console.log(failed ? `${failed} failed, ${passed} passed` : `all ${passed} passed`);
  process.exit(failed ? 1 : 0);
}

// ------------------------------------------------------------------ planes

export const XY = (z = 0): PlaneDef => ({ origin: [0, 0, z], xDir: [1, 0, 0], normal: [0, 0, 1] });
/** Seen from the front: x to the right, z up. */
export const XZ = (y = 0): PlaneDef => ({ origin: [0, y, 0], xDir: [1, 0, 0], normal: [0, -1, 0] });
export const YZ = (x = 0): PlaneDef => ({ origin: [x, 0, 0], xDir: [0, 1, 0], normal: [1, 0, 0] });
export const plane = (origin: Vec3, normal: Vec3, xDir: Vec3): PlaneDef => ({ origin, normal, xDir });

// ------------------------------------------------------------------ sketches

export const rect = (id: string, x0: number, y0: number, x1: number, y1: number): SketchEntity =>
  ({ id, kind: "polyline", points: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], closed: true }) as SketchEntity;
export const circle = (id: string, x: number, y: number, r: number): SketchEntity => ({ id, kind: "circle", center: [x, y], radius: r }) as SketchEntity;
export const line = (id: string, a: [number, number], b: [number, number]): SketchEntity => ({ id, kind: "line", a, b }) as SketchEntity;
export const poly = (id: string, points: [number, number][], closed = true): SketchEntity => ({ id, kind: "polyline", points, closed }) as SketchEntity;

export const sketch = (id: string, plane: PlaneDef, entities: SketchEntity[], name = id): Feature => ({ id, name, type: "sketch", plane, entities }) as Feature;

/** Every closed shape of the sketch's curves (or those `pick` keeps). */
export function profile(sketchId: string, entities: SketchEntity[], pick?: (regions: ReturnType<typeof regionRef>[]) => ReturnType<typeof regionRef>[]) {
  const regions = arrangement(entities).regions.map(regionRef);
  return { kind: "profile" as const, sketch: sketchId, regions: pick ? pick(regions) : regions };
}

/** The entities of a sketch step made above. */
const entitiesOf = (fs: Feature[], id: string) => (fs.find((f) => f.id === id) as { entities: SketchEntity[] } | undefined)?.entities ?? [];

// ------------------------------------------------------------------ steps

/** An extrude of the sketch's shapes (all of them, given its entities or the steps holding it). */
export function extrude(id: string, sk: Feature | string, distance: number, mode: "new" | "add" | "cut" = "new", extra: Record<string, unknown> = {}): Feature {
  const sid = typeof sk === "string" ? sk : sk.id;
  const es = typeof sk === "string" ? [] : (sk as { entities: SketchEntity[] }).entities;
  return { id, name: id, type: "extrude", source: profile(sid, es), distance, mode, ...extra } as Feature;
}

/** A block w x d x h from the origin (a sketch and its extrude). */
export function block(id: string, w: number, d: number, h: number, at: Vec3 = [0, 0, 0]): Feature[] {
  const s = sketch(`${id}-s`, XY(at[2]), [rect(`${id}-r`, at[0], at[1], at[0] + w, at[1] + d)]);
  return [s, extrude(id, s, h)];
}

/** A cylinder of radius r and height h standing on the XY plane at (x, y). */
export function cylinder(id: string, r: number, h: number, x = 0, y = 0, z = 0): Feature[] {
  const s = sketch(`${id}-s`, XY(z), [circle(`${id}-c`, x, y, r)]);
  return [s, extrude(id, s, h)];
}

// ------------------------------------------------------------------ results

/** Rebuild the steps: the result, the solid of one body (by its id), and the first error. */
export async function after(fs: Feature[], bodyId?: string): Promise<{ r: RegenResult; body: Shape3D | undefined; err?: string; errors: string[] }> {
  const r = await regenerate(fs);
  const bodies = debugBodies();
  const body = bodyId ? bodies.get(bodyId) : [...bodies.values()][0];
  const errors = r.errors.map((e) => `${e.featureId}: ${e.message}`);
  return { r, body, err: r.errors[0]?.message, errors };
}

/** The solids of the last rebuild, by body id. */
export const bodies = () => debugBodies();

export const volume = (s: Shape3D | undefined) => (s ? measureVolume(s) : 0);

/** A body's health: valid, closed, solids, faces, volume, box. */
export const health = (s: Shape3D, id = "body"): BodyHealth => healthReport(id, id, s);

export { entitiesOf };
