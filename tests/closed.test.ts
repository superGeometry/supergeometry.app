// Run: npx tsx tests/closed.test.ts — face edits never leave a body torn open.
// A tower pushed out over a fillet used to leave hair-thin faces; offsetting
// one of them, then moving a corner, opened the body.
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { regenerate } from "../src/kernel/engine";

setOC(await (opencascade as unknown as () => Promise<any>)());

const features = 
[{"id":"sk","name":"Sketch 01","type":"sketch","plane":{"origin":[0,0,0],"xDir":[1,0,0],"normal":[0,0,1]},"entities":[{"id":"r1","kind":"rect","center":[0,0],"w":40,"h":30,"rotation":0}]},{"id":"extrude-mw40viqx-sw1z","name":"Extrude 01","type":"extrude","source":{"kind":"profile","sketch":"sk","regions":[{"c":[0,0],"a":1200}]},"distance":10,"mode":"auto"},{"id":"fillet-mw41c9tz-z5x0","name":"Fillet 01","type":"fillet","edges":[{"body":"extrude-mw40viqx-sw1z","mid":[20,0,10],"dir":[0,1,0],"length":30}],"radius":4},{"id":"extrude-mw41dume-9ees","name":"Offset Face 02b","type":"extrude","source":{"kind":"face","face":{"body":"extrude-mw40viqx-sw1z","center":[-0.16543192186287836,14.999999999999998,4.964444044938901],"normal":[0,1,0],"area":396.56637061435913}},"distance":17,"mode":"new","target":"extrude-mw40viqx-sw1z"},{"id":"extrude-mw41dx4f-cobj","name":"Offset Face 03","type":"extrude","source":{"kind":"face","face":{"body":"extrude-mw41dume-9ees","center":[-20,23.5,5],"normal":[-1,0,0],"area":169.99999999999997}},"distance":-18.5,"mode":"auto","target":"extrude-mw41dume-9ees"},{"id":"extrude-mw41dzw7-7v1z","name":"Offset Face 04","type":"extrude","source":{"kind":"face","face":{"body":"extrude-mw41dume-9ees","center":[7.25,23.499999999999996,10],"normal":[0,0,1],"area":297.5000000000001}},"distance":20.5,"mode":"auto","target":"extrude-mw41dume-9ees"},{"id":"boolean-mw41e7tc-cszh","name":"Union 01","type":"boolean","op":"union","target":"extrude-mw40viqx-sw1z","tools":["extrude-mw41dume-9ees"]},{"id":"extrude-mw41eci4-ho6n","name":"Offset Face 05","type":"extrude","source":{"kind":"face","face":{"body":"extrude-mw40viqx-sw1z","center":[9.25,15,20.090296307644618],"normal":[0,-1,0],"area":440.7500000000002}},"distance":16.5,"mode":"auto","target":"extrude-mw40viqx-sw1z"},{"id":"extrude-mw41emgx-mqt9","name":"Offset Face 06","type":"extrude","source":{"kind":"face","face":{"body":"extrude-mw40viqx-sw1z","center":[19.97156799355699,-1.5,6.42746108151053],"normal":[0,-1,0],"area":0.00002914562972283763}},"distance":-20.5,"mode":"auto","target":"extrude-mw40viqx-sw1z"},{"id":"moveFace-mw41etpt-hhz4","name":"Move Vertex 01","type":"moveFace","vertex":{"body":"extrude-mw40viqx-sw1z","at":[-1.5000000000000002,32,30.50000000000001]},"translate":[0,0,-9]}]
;

let failed = 0;
for (let i = 1; i <= features.length; i++) {
  const r = await regenerate(features.slice(0, i));
  const open = r.bodies.filter((b) => b.openEdges.length);
  const ok = !open.length && !r.errors.length;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${features[i - 1].name}: ${r.bodies.map((b) => `${b.name} ${b.faces.length} faces, ${b.openEdges.length} open`).join("; ")}${r.errors.length ? " — " + r.errors.map((e) => e.message).join("; ") : ""}`);
}
if (failed) process.exit(1);
