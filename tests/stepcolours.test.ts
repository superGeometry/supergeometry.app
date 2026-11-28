// Run: npx tsx tests/stepcolours.test.ts
// A body's colour goes into a STEP file with it, and a STEP file's colours come in with its bodies.
import type { Feature } from "../src/doc/types";
import { stepColours } from "../src/io/stepColours";
import { exportBodies } from "../src/kernel/engine";
import { after, block, bodies, check, done, volume } from "./kit";

// Three blocks of three sizes: an orange one, a blue one, and one with no colour.
const fs = [...block("a", 10, 10, 10), ...block("b", 20, 10, 10, [30, 0, 0]), ...block("c", 30, 10, 10, [70, 0, 0])];
const colours = { a: "#ff8800", b: "#2060c0" };
const file = await exportBodies(fs, "step", undefined, colours);
const text = await file.text();
check("the STEP file written holds the two colours", /COLOUR_RGB/.test(text) && (text.match(/COLOUR_RGB/g) ?? []).length >= 2, `${(text.match(/COLOUR_RGB/g) ?? []).length} colour records`);

const read = stepColours(text);
// (Colours pass through the writer's own arithmetic: within a step or two of 255.)
const close = (c: string | null, to: string) => !!c && [1, 3, 5].every((i) => Math.abs(parseInt(c.slice(i, i + 2), 16) - parseInt(to.slice(i, i + 2), 16)) <= 3);
check("read back from its text: the orange and the blue as they were, none for the third (written in the app's grey)", read.length === 3 && close(read[0], "#ff8800") && close(read[1], "#2060c0") && read[2] === null, JSON.stringify(read));

// Brought in again: the solids come in the order the file lists them, so each colour is on its own block.
const b64 = Buffer.from(text).toString("base64");
const imp = { id: "imp", name: "three.step", type: "import", format: "step", fileName: "three.step", data: b64, apart: true } as unknown as Feature;
const { errors } = await after([imp]);
const got = [...bodies().entries()].map(([id, s]) => ({ id, vol: Math.round(volume(s)) }));
const matched = [1000, 2000, 3000].every((vol, i) => got.find((g) => g.id === (i ? `imp:${i}` : "imp"))?.vol === vol);
check("…and the i-th colour is the i-th body's: orange on the 10 block, blue on the 20, none on the 30", !errors.length && got.length === 3 && matched, `${JSON.stringify(got)} ${JSON.stringify(read)} ${errors.join("; ")}`);

// A file with no colours, and text that is not STEP at all.
const plain = await (await exportBodies(fs, "step")).text();
check("a STEP file of bodies with no colours: none read for any solid, and none marked red in the file", stepColours(plain).length === 3 && stepColours(plain).every((c) => c === null) && !/DRAUGHTING_PRE_DEFINED_COLOUR\(\s*'red'/.test(plain), JSON.stringify(stepColours(plain)));
check("text with no solids in it: nothing", stepColours("hello").length === 0);

// A colour set on the shape that holds the solids (as some programs write it) is each solid's.
const hand = `
#10=MANIFOLD_SOLID_BREP('one',#11);
#20=MANIFOLD_SOLID_BREP('two',#21);
#30=ADVANCED_BREP_SHAPE_REPRESENTATION('',(#10,#20),#99);
#40=COLOUR_RGB('',0.,1.,0.);
#41=FILL_AREA_STYLE_COLOUR('',#40);
#42=FILL_AREA_STYLE('',(#41));
#43=SURFACE_STYLE_FILL_AREA(#42);
#44=SURFACE_SIDE_STYLE('',(#43));
#45=SURFACE_STYLE_USAGE(.BOTH.,#44);
#46=PRESENTATION_STYLE_ASSIGNMENT((#45));
#47=STYLED_ITEM('',(#46),#30);
#50=COLOUR_RGB('',1.,0.,0.);
#51=FILL_AREA_STYLE_COLOUR('',#50);
#52=FILL_AREA_STYLE('',(#51));
#53=SURFACE_STYLE_FILL_AREA(#52);
#54=SURFACE_SIDE_STYLE('',(#53));
#55=SURFACE_STYLE_USAGE(.BOTH.,#54);
#56=PRESENTATION_STYLE_ASSIGNMENT((#55));
#57=STYLED_ITEM('',(#56),#20);
`;
check("a colour on the shape that holds two solids, and one solid's own: its own wins, the other takes the shape's", JSON.stringify(stepColours(hand)) === JSON.stringify(["#00ff00", "#ff0000"]), JSON.stringify(stepColours(hand)));
done();
