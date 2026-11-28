// Run: npx tsx tests/planesquare.test.ts
// A construction plane's square is drawn by what the plane was made from: half as big again as the face it is
// offset from and in front of it; between a midplane's two faces; where a step itself says for the other kinds.
import { regenerate } from "../src/kernel/engine";
import type { Feature, Vec3 } from "../src/doc/types";
import { block, check, done, near } from "./kit";

const faceRef = (body: string, f: any) => ({ body, center: f.center, normal: f.normal, area: f.area, step: f.step, curve: f.curve });
const facing = (r: any, n: Vec3, body = 0) => r.bodies[body].faces.filter((f: any) => f.type === "PLANE" && f.normal[0] * n[0] + f.normal[1] * n[1] + f.normal[2] * n[2] > 0.999);
const same = (a: Vec3 | undefined, b: Vec3, tol = 1e-6) => !!a && a.every((x, i) => near(x, b[i], tol));

// A big plate with a small block standing on one corner of it.
const model: Feature[] = [...block("P", 200, 100, 10), ...block("S", 20, 12, 30, [150, 70, 10])];
const r0: any = await regenerate(model);
const small = faceRef("S", facing(r0, [0, 0, 1], 1)[0]);
const side = faceRef("S", facing(r0, [1, 0, 0], 1)[0]);
const far = faceRef("S", facing(r0, [-1, 0, 0], 1)[0]);
const big = faceRef("P", facing(r0, [0, 0, -1], 0)[0]);
const pl = (more: Record<string, unknown>): Feature => ({ id: "pl", name: "Plane 01", type: "plane", kind: "offset", plane: { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] }, offset: 0, ...more }) as Feature;
const info = async (f: Feature) => {
  const r: any = await regenerate([...model, f]);
  return { c: r.planes.find((p: any) => p.id === "pl"), errors: r.errors };
};

{
  const { c, errors } = await info(pl({ face: small, plane: { origin: small.center, xDir: [1, 0, 0], normal: [0, 0, 1] }, offset: 8 }));
  check("offset from the small block's top (20 x 12): a square of 30, over the middle of that face", !errors.length && near(c.size, 30, 1e-6) && same(c.at, [160, 76, 48]), JSON.stringify(c));
}
{
  const { c } = await info(pl({ face: big, plane: { origin: big.center, xDir: [1, 0, 0], normal: [0, 0, -1] }, offset: 5 }));
  check("offset from the plate's underside (200 x 100): a square of 300 over its middle", near(c.size, 300, 1e-6) && same(c.at, [100, 50, -5]), JSON.stringify(c));
}
{
  const { c } = await info(pl({ kind: "mid", plane: { origin: [160, 76, 25], xDir: [0, 1, 0], normal: [1, 0, 0] }, near: [side, far] }));
  check("a midplane of the block's two sides (12 x 30 each): a square of 45, between them", near(c.size, 45, 1e-6) && same(c.at, [160, 76, 25]), JSON.stringify(c));
}
{
  const { c } = await info(pl({ kind: "3pt", plane: { origin: [0, 0, 10], xDir: [1, 0, 0], normal: [0, 0, 1] }, shown: { at: [10, 10, 10], size: 42 } }));
  check("a plane that says where its square is and how big: there, that big", near(c.size, 42) && same(c.at, [10, 10, 10]), JSON.stringify(c));
}
{
  const { c } = await info(pl({ kind: "parallel", plane: { origin: [5, 5, 60], xDir: [1, 0, 0], normal: [0, 0, 1] }, near: [small], shown: { at: [5, 5, 60] } }));
  check("parallel to a face through a point: at the point, by the face's size", near(c.size, 30, 1e-6) && same(c.at, [5, 5, 60]), JSON.stringify(c));
}
{
  const { c, errors } = await info(pl({ plane: { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] }, offset: 20 }));
  check("a plane from an origin plane, nothing said: no square of its own (drawn by the model, as before)", !errors.length && c.size === undefined && c.at === undefined, JSON.stringify(c));
}
{
  const gone = { ...small, body: "nobody" };
  const { c, errors } = await info(pl({ kind: "mid", plane: { origin: [160, 76, 25], xDir: [0, 1, 0], normal: [1, 0, 0] }, near: [side, gone] }));
  check("one of a midplane's faces gone: still made, drawn by the other", !errors.length && near(c.size, 45, 1e-6), JSON.stringify(c));
}
done();
