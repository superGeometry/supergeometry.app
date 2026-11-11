// Run: npx tsx tests/sheetcamera.test.ts - zooming and moving round a drawing
// sheet: the point under the cursor stays put, limits hold, the sheet never
// goes out of sight, all of it comes back with Fit.
import { check, done, near } from "./kit";
import { SheetCamera } from "../src/bim/sheetCamera";

const cam = new SheetCamera();
cam.setSheet(420, 297);
cam.resize(1000, 700);
const fitZ = Math.min((1000 - 32) / 420, (700 - 32) / 297);
check("it starts with all of an A3 sheet in view, in the middle", near(cam.z, fitZ) && near(cam.cx, 210) && near(cam.cy, 148.5) && cam.fitted, cam.state);
check("  ...100 %", near(cam.ratio(), 1));
const [l, t, w, h] = cam.viewBox().split(" ").map(Number);
check("  ...the viewBox has the screen's shape, the sheet inside it", near(w / h, 1000 / 700, 1e-3) && l <= 0 && t <= 0 && l + w >= 420 && t + h >= 297, cam.viewBox());

// The wheel at a point: the paper under it stays under it.
const under = cam.toPaper(300, 200);
cam.zoomAt(300, 200, 3);
const after = cam.toPaper(300, 200);
check("zooming in at a point keeps the paper under it there", near(under[0], after[0], 1e-9) && near(under[1], after[1], 1e-9), { under, after });
check("  ...3 times closer, no longer fitted", near(cam.ratio(), 3) && !cam.fitted);
const back = cam.toScreen(...under);
check("  ...and that paper point is still at (300, 200) on the screen", near(back[0], 300) && near(back[1], 200), back);

// Dragging moves the paper with the finger.
const p0 = cam.toPaper(500, 350);
cam.panBy(40, -25);
const p1 = cam.toScreen(...p0);
check("dragging 40 px right and 25 up moves the paper with it", near(p1[0], 540) && near(p1[1], 325), p1);

// Limits.
for (let i = 0; i < 100; i++) cam.zoomAt(500, 350, 1.5);
check("zooming in stops at its limit", near(cam.z, cam.maxZoom()), cam.z);
for (let i = 0; i < 100; i++) cam.zoomAt(500, 350, 0.5);
check("zooming out stops at a quarter of the whole sheet", near(cam.ratio(), 0.25), cam.ratio());
cam.panBy(1e6, 1e6);
check("however far it is dragged, the sheet stays in sight (its corner in the middle)", near(cam.cx, 0) && near(cam.cy, 0), cam.state);

// Fit, then the window changes size: still all of it.
cam.fit();
cam.resize(400, 800);
check("fitted, the window narrower and taller: all of the sheet still, fitted to the width", near(cam.z, (400 - 32) / 420) && cam.fitted, cam.state);
// Zoomed, the window changes size: the same zoom and middle.
cam.zoomAt(200, 400, 2);
const st = cam.state;
cam.resize(600, 600);
check("zoomed in, the window resized: the same zoom and middle", near(cam.z, st.z) && near(cam.cx, st.cx) && near(cam.cy, st.cy));
// Another sheet size: all of the new one.
cam.setSheet(297, 210);
check("another sheet size: all of it in view", cam.fitted && near(cam.cx, 148.5) && near(cam.cy, 105));

// Gliding from one zoom to another: evenly in scale.
const a = { z: 1, cx: 0, cy: 0 };
const b = { z: 4, cx: 100, cy: 50 };
cam.blend(a, b, 0.5);
check("half way from 1x to 4x is 2x (zoom glides evenly)", near(cam.z, 2) && near(cam.cx, 50) && near(cam.cy, 25), cam.state);

done();
