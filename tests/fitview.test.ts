// Run: npx tsx tests/fitview.test.ts - Zoom to fit on every screen shape: the
// model must land inside the part of the screen the tool columns and bars
// leave free (a ruler fitted to a phone's whole screen ran under the columns).
import { Box3, MathUtils, Vector3 } from "three";
import { CameraController, type Insets } from "../src/view/camera";

let failed = 0;
const check = (name: string, ok: boolean, info = "") => {
  if (!ok) failed++;
  console.log(ok ? "ok  " : "FAIL", name, info);
};

// Screens: [name, width, height, covered sides in px (left, right, top, bottom)].
const screens: [string, number, number, [number, number, number, number]][] = [
  ["small phone", 320, 568, [0, 56, 44, 56]],
  ["phone", 375, 812, [0, 63, 52, 62]],
  ["phone in a sketch", 375, 812, [60, 63, 52, 62]],
  ["phone landscape", 812, 375, [60, 63, 52, 0]],
  ["tablet", 768, 1024, [110, 60, 52, 0]],
  ["tablet with Items and the tool menu open", 768, 1024, [392, 56, 52, 0]],
  ["phone on its side with Items open", 812, 375, [293, 56, 44, 0]],
  ["tablet landscape", 1024, 768, [110, 60, 52, 0]],
  ["laptop", 1366, 768, [110, 60, 52, 0]],
  ["desktop", 1920, 1080, [110, 60, 52, 0]],
];
const boxes: [string, Box3][] = [
  ["ruler", new Box3(new Vector3(0, 0, 0), new Vector3(160, 30, 3))],
  ["closet", new Box3(new Vector3(0, 0, 0), new Vector3(800, 500, 1800))],
  ["screw", new Box3(new Vector3(-8, -8, 0), new Vector3(8, 8, 40))],
  ["plate", new Box3(new Vector3(-100, -100, 0), new Vector3(100, 100, 2))],
];
const views: [string, number, number][] = [
  ["iso", -60, 30],
  ["top", -90, 89.99],
  ["front", -90, 0],
];

for (const [sn, W, H, px] of screens)
  for (const [bn, box] of boxes)
    for (const [vn, az, el] of views)
      for (const ortho of [false, true]) {
        const free: Insets = { left: px[0] / W, right: px[1] / W, top: px[2] / H, bottom: px[3] / H };
        const c = new CameraController(W / H);
        c.animate = false;
        c.setOrtho(ortho);
        c.azimuth = MathUtils.degToRad(az);
        c.elevation = MathUtils.degToRad(el);
        c.update();
        c.fit(box, false, free);
        const xs: number[] = [], ys: number[] = [];
        for (let i = 0; i < 8; i++) {
          const p = new Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).project(c.camera);
          xs.push(((p.x + 1) / 2) * W);
          ys.push(((1 - p.y) / 2) * H);
        }
        const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
        const inside = x0 >= px[0] - 0.5 && x1 <= W - px[1] + 0.5 && y0 >= px[2] - 0.5 && y1 <= H - px[3] + 0.5;
        // …and fills it reasonably (not a speck in the middle).
        const fill = Math.max((x1 - x0) / (W - px[0] - px[1]), (y1 - y0) / (H - px[2] - px[3]));
        const ok = inside && fill > 0.6;
        if (!ok) check(`${bn} on ${sn}, ${vn}${ortho ? " ortho" : ""}`, false, `x ${x0.toFixed(0)}–${x1.toFixed(0)} of ${px[0]}–${W - px[1]}, y ${y0.toFixed(0)}–${y1.toFixed(0)} of ${px[2]}–${H - px[3]}, fills ${(fill * 100).toFixed(0)} %`);
      }
check("every model fits the free area on every screen, view and projection", failed === 0);
process.exit(failed ? 1 : 0);
