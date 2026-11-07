// Run: npx tsx tests/axisdrag.test.ts - dragging an arrow (extrude, offset,
// fillet, gimbals…) always goes the way the finger goes: drag towards where the
// arrow points on screen and the value grows; drag away and it shrinks. At any
// zoom (it used to flip when zoomed far out) and from any side.
import { PerspectiveCamera, Raycaster, Vector2, Vector3 } from "three";
import { axisDrag } from "../src/tools/handles";
import type { Vec3 } from "../src/doc/types";

const W = 400;
const H = 800;

function fakeView(eye: Vec3, target: Vec3) {
  const camera = new PerspectiveCamera(45, W / H, 0.01, 1e7);
  camera.position.set(...eye);
  camera.lookAt(new Vector3(...target));
  camera.updateMatrixWorld();
  const ray = new Raycaster();
  const dist = new Vector3(...eye).distanceTo(new Vector3(...target));
  return {
    width: W,
    height: H,
    cam: { worldPerPixel: () => (2 * dist * Math.tan((45 * Math.PI) / 360)) / H },
    toScreen(p: Vector3): [number, number] | null {
      const v = p.clone().project(camera);
      if (v.z > 1) return null;
      return [((v.x + 1) / 2) * W, ((1 - v.y) / 2) * H];
    },
    pointerRay(x: number, y: number) {
      ray.setFromCamera(new Vector2((x / W) * 2 - 1, -(y / H) * 2 + 1), camera);
      return { o: ray.ray.origin.toArray() as Vec3, d: ray.ray.direction.toArray() as Vec3 };
    },
  };
}

const ptr = (x: number, y: number) => ({ x, y, type: "touch" as const, shift: false, add: false, tol: 18 });
let failed = 0;
const dirs: Vec3[] = [[0, 0, 1], [0, 0, -1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0.6, 0.48, -0.64]];
// Close up, normal, and zoomed far out (1 mm well under a pixel).
for (const dist of [30, 300, 20000]) {
  for (const eye of [[1, -1.3, 0.9], [-0.7, 0.8, -1.1], [0.2, -1, 0.05]] as Vec3[]) {
    const e: Vec3 = [eye[0] * dist, eye[1] * dist, eye[2] * dist];
    const view = fakeView(e, [0, 0, 0]);
    for (const d of dirs) {
      const o: Vec3 = [0, 0, 0];
      const a = view.toScreen(new Vector3(...o))!;
      const tip = view.toScreen(new Vector3(...d).multiplyScalar(view.cam.worldPerPixel() * 60))!;
      const sx = tip[0] - a[0];
      const sy = tip[1] - a[1];
      const l = Math.hypot(sx, sy);
      if (l < 8) continue; // looking almost straight down this arrow
      const step = 40;
      const toward = axisDrag(view as never, o, d, ptr(a[0], a[1]), ptr(a[0] + (sx / l) * step, a[1] + (sy / l) * step));
      const away = axisDrag(view as never, o, d, ptr(a[0], a[1]), ptr(a[0] - (sx / l) * step, a[1] - (sy / l) * step));
      const ok = toward > 0 && away < 0;
      if (!ok) {
        failed++;
        console.log(`FAIL dist ${dist} eye ${eye} dir ${d}: toward ${toward.toFixed(4)}, away ${away.toFixed(4)}`);
      }
    }
  }
}
console.log(failed ? `${failed} wrong-way drags` : "ok   every arrow follows the finger, at every zoom");
if (failed) process.exit(1);
