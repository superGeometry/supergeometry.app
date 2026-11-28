// Run: npx tsx tests/insertproject.test.ts
// More → Insert → Project: the other project's steps become one History group and one Items folder, both named
// after the file; its folders, names, colours, hidden items and variables come along (doc/insertProject.ts).
import type { Feature, ProjectDoc } from "../src/doc/types";
import { fileFreshBodies, insertProjectInto } from "../src/doc/insertProject";
import { after, bodies, block, check, done, extrude, sketch, XY, circle } from "./kit";

const empty = (name: string): ProjectDoc => ({ format: "super", version: 2, name, features: [], variables: [], views: [], units: "mm", hidden: [], pins: [], names: {} }) as ProjectDoc;
let n = 0;
const newId = (type: string) => `${type}-new${++n}`;

// The project being worked on: a block, in a folder of its own, with a variable.
const mine = empty("mine");
mine.features = block("base", 40, 30, 10);
mine.variables = [{ name: "wall", expr: "2" }];
mine.folders = [{ id: "f-mine", name: "Mine", items: ["base"] }];
mine.historyGroups = [{ id: "g-mine", name: "Base", steps: mine.features.map((f) => f.id) }];

// The one inserted: a block and a pin on it (two bodies), its sketches hidden, one body named and coloured, a
// folder of its own, two variables (one this project has too, with another value).
const s2 = sketch("pin-s", XY(20), [circle("c", 10, 10, 3)]);
const theirs = empty("bracket");
theirs.features = [...block("base", 20, 20, 20), s2, extrude("pin", s2, 15, "new"), { id: "chamf", name: "Chamfer 01", type: "chamfer", edges: [{ body: "pin", mid: [10, 10, 35], dir: [1, 0, 0], length: 18.85 }], radius: 1 } as unknown as Feature];
theirs.variables = [{ name: "wall", expr: "3" }, { name: "pinSize", expr: "6" }];
theirs.hidden = ["base-s", "pin-s"];
theirs.names = { pin: "Locating pin", "base:2": "Second piece" };
theirs.colors = { pin: "#ff8800" };
theirs.folders = [{ id: "f1", name: "Pins", items: ["pin", "pin-s"] }, { id: "f2", name: "Inner", items: [], parent: "f1" }];

const before = { steps: mine.features.length, ids: mine.features.map((f) => f.id) };
const out = insertProjectInto(mine, theirs, "bracket.super", newId);
const added = mine.features.slice(before.steps);

check("its steps come after this project's own, each under a new id", mine.features.length === before.steps + theirs.features.length && added.every((f) => f.id.includes("-new")) && mine.features.slice(0, before.steps).every((f, i) => f.id === before.ids[i]), added.map((f) => f.id).join(" "));
// (Their names are left as they were - in this test they read like the ids.)
const text = JSON.stringify(added.map((f) => ({ ...f, name: "" })));
check("the steps keep their names", added.map((f) => f.name).join() === theirs.features.map((f) => f.name).join());
check("nothing in them still names an old id (the sketch an extrude uses, the body a chamfer is on)", !/"(base|base-s|pin|pin-s|chamf)"/.test(text) && !/"base-r"/.test("") && text.includes(out.steps[2]), text.match(/"(base|base-s|pin|pin-s|chamf)"/g)?.join(" ") ?? "");

const group = mine.historyGroups!.find((g) => g.name === "bracket");
check("History: one group named after the file, holding exactly those steps; this project's group untouched", !!group && group.steps.join() === out.steps.join() && mine.historyGroups!.length === 2 && mine.historyGroups![0].steps.length === before.steps);

const folder = mine.folders!.find((f) => f.id === out.folder)!;
const pins = mine.folders!.find((f) => f.name === "Pins")!;
const inner = mine.folders!.find((f) => f.name === "Inner")!;
const pinId = added.find((f) => f.name === "pin")!.id;
check("Items: one folder named after the file, at the top", folder?.name === "bracket" && !folder.parent);
check("its own folders are inside it, a subfolder still inside its folder", pins.parent === folder.id && inner.parent === pins.id && pins.items.includes(pinId));
check("what it had in no folder is in the new folder; what it had in a folder is only there", folder.items.includes(added[1].id) && !folder.items.includes(pinId) && mine.folders![0].items.join() === "base");

check("its sketches stay hidden, its body's name and colour stay with the body", mine.hidden.includes(added[0].id) && mine.hidden.includes(added[2].id) && mine.names[pinId] === "Locating pin" && mine.colors?.[pinId] === "#ff8800");
check("a name given to a step's second body follows it too", mine.names[`${added[1].id}:2`] === "Second piece", JSON.stringify(mine.names));
check("its variables come along; one this project already has keeps this project's value, and that is said", mine.variables.length === 2 + 0 + 0 && mine.variables.find((v) => v.name === "wall")!.expr === "2" && mine.variables.some((v) => v.name === "pinSize") && out.clashes.join() === "wall", JSON.stringify(mine.variables));

// Built: sound, three bodies, and the ones the folder was waiting for are filed.
const { errors } = await after(mine.features);
const built = [...bodies().keys()];
check("the merged project builds: this project's block, and the inserted block and pin", !errors.length && built.length === 3, `${built.join(" ")} ${errors.join("; ")}`);
const changed = fileFreshBodies(mine, [...built, `${added[1].id}:2`]);
check("a body built later for one of its steps joins the folder; the folder then stops waiting", changed && folder.items.includes(`${added[1].id}:2`) && !folder.fresh && !fileFreshBodies(mine, built));
check("this project's own body is in no inserted folder", !mine.folders!.slice(1).some((f) => f.items.includes("base")));
done();
