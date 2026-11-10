// Run: npx tsx tests/bim.test.ts
// BIM: a body's volume, area and centre of mass are measured on the solid,
// and its mass is that volume times its material's density.
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { bodyProperties } from "../src/kernel/engine";
import { arrangement, regionRef } from "../src/sketch/regions";
import { assignMaterial, massOf, materialOf, MATERIALS } from "../src/bim/materials";
import { emptyDoc, type Feature } from "../src/doc/types";

setOC(await (opencascade as unknown as () => Promise<any>)());
let failed = 0;
const check = (name: string, ok: boolean, info = "") => {
  if (!ok) failed++;
  console.log(ok ? "ok  " : "FAIL", name, info);
};
const es = [{ id: "p", kind: "polyline", points: [[0, 0], [10, 0], [10, 20], [0, 20]], closed: true }];
const features: Feature[] = [
  { id: "s", name: "s", type: "sketch", plane: { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] }, entities: es } as Feature,
  { id: "A", name: "A", type: "extrude", source: { kind: "profile", sketch: "s", regions: arrangement(es as any).regions.map(regionRef) }, distance: 30, mode: "new" } as Feature,
];
const [p] = await bodyProperties(features);
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6 * Math.max(1, Math.abs(b));
check("a 10 x 20 x 30 block: 6000 mm³", near(p.volume, 6000), String(p.volume));
check("its surface: 2200 mm²", near(p.area, 2200), String(p.area));
check("its centre of mass in its middle", near(p.center[0], 5) && near(p.center[1], 10) && near(p.center[2], 15), p.center.join());
check("its box", p.box[0].every((v) => near(v, 0)) && near(p.box[1][0], 10) && near(p.box[1][1], 20) && near(p.box[1][2], 30));

const doc = emptyDoc();
const steel = MATERIALS.find((m) => m.id === "steel-s235")!;
assignMaterial(doc, ["A"], steel);
check("given steel, it is steel, and shows steel's colour", materialOf(doc, "A")?.id === "steel-s235" && doc.colors?.A === steel.color);
check("6000 mm³ of steel weighs 47.1 g", near(massOf(steel, p.volume), 0.0471), String(massOf(steel, p.volume)));
assignMaterial(doc, ["A"], MATERIALS.find((m) => m.id === "glass")!);
check("glass is see-through", doc.opacity?.A === 0.3);
assignMaterial(doc, ["A"], steel);
check("steel again: solid", doc.opacity?.A === undefined);
assignMaterial(doc, ["A"], null);
check("taken off: no material", !materialOf(doc, "A"));
check("every material has a density and a colour", MATERIALS.every((m) => m.density > 0 && /^#[0-9a-f]{6}$/i.test(m.color)));
check("material ids are all different", new Set(MATERIALS.map((m) => m.id)).size === MATERIALS.length);
process.exit(failed ? 1 : 0);
