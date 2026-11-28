// Run: npx tsx tests/importmore.test.ts
// Files of other programs brought in: BRep (the geometry kernel's own text), FreeCAD documents (a zip of such
// shapes), glTF / GLB meshes. Every file here is made by the test itself.
import { getOC } from "replicad";
import type { Feature } from "../src/doc/types";
import { glb } from "../src/io/formats";
import { gltfTriangles, readFcstd, stlOfTriangles } from "../src/io/moreFormats";
import { after, block, bodies, check, circle, done, extrude, sketch, volume, XY } from "./kit";

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const text = (s: string) => new TextEncoder().encode(s);

// ---------------------------------------------------------------- BRep
// A block with a hole through it, written as BRep text and read back: the same solid, to the last digit.
const s2 = sketch("s2", XY(), [circle("c", 20, 15, 5)]);
await after([...block("b", 40, 30, 10), s2, extrude("hole", s2, 10, "cut", { target: "b" })], "b");
const solid = bodies().get("b")!;
const v0 = volume(solid);
const faces0 = solid.faces.length;
const brep = text((getOC() as any).BRepToolsWrapper.Write(solid.wrapped));
{
  const f = { id: "imp", name: "part.brep", type: "import", format: "brep", fileName: "part.brep", data: b64(brep), apart: true } as unknown as Feature;
  const { errors, body } = await after([f], "imp");
  check("a BRep file: the same solid, exactly (its volume and its faces, the hole a round face)", !errors.length && Math.abs(volume(body) - v0) < 1e-9 && body!.faces.length === faces0 && body!.faces.some((x) => x.geomType === "CYLINDRE"), `${volume(body)} / ${v0}, ${body?.faces.length} / ${faces0} faces ${errors.join("; ")}`);
  const bad = { ...f, id: "bad", data: b64(text("not a brep at all")) } as unknown as Feature;
  const r = await after([bad], "bad");
  check("a file that isn't BRep: said, not a crash", r.errors.length === 1 && /couldn't be read/.test(r.errors[0]), r.errors.join("; "));
}

// ------------------------------------------------------------- FreeCAD
/** A zip of files, stored as they are (what the reader needs: names, sizes, where each starts). */
function zip(files: [string, Uint8Array][]): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let at = 0;
  for (const [name, data] of files) {
    const n = text(name);
    const local = new Uint8Array(30 + n.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, n.length, true);
    local.set(n, 30);
    const c = new Uint8Array(46 + n.length);
    const cv = new DataView(c.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, n.length, true);
    cv.setUint32(42, at, true);
    c.set(n, 46);
    parts.push(local, data);
    central.push(c);
    at += local.length + data.length;
  }
  const size = central.reduce((a, c) => a + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, size, true);
  ev.setUint32(16, at, true);
  const out = new Uint8Array(at + size + 22);
  let o = 0;
  for (const p of [...parts, ...central, end]) (out.set(p, o), (o += p.length));
  return out;
}
const obj = (name: string, label: string, file: string | null, extra = "") =>
  `<Object name="${name}"><Properties Count="3"><Property name="Label" type="App::PropertyString"><String value="${label}"/></Property>${file ? `<Property name="Shape" type="Part::PropertyPartShape"><Part file="${file}"/></Property>` : ""}${extra}</Properties></Object>`;
const view = (name: string, on: boolean) => `<ViewProvider name="${name}" expanded="0"><Properties Count="1"><Property name="Visibility" type="App::PropertyBool"><Bool value="${on}"/></Property></Properties></ViewProvider>`;
const docXml = `<?xml version='1.0' encoding='utf-8'?><Document SchemaVersion="4"><Objects Count="4"><Object type="PartDesign::Body" name="Body" id="1"/><Object type="PartDesign::Pad" name="Pad" id="2"/><Object type="PartDesign::Pocket" name="Pocket" id="3"/><Object type="Part::Box" name="Box" id="4"/></Objects><ObjectData Count="4">${obj("Body", "Bracket &amp; plate", "Body.Shape.brp", `<Property name="Group" type="App::PropertyLinkList"><LinkList count="2"><Link value="Pad"/><Link value="Pocket"/></LinkList></Property>`)}${obj("Pad", "Pad", "Pad.Shape.brp")}${obj("Pocket", "Pocket", "Pocket.Shape.brp", `<Property name="BaseFeature" type="App::PropertyLink"><Link value="Pad"/></Property>`)}${obj("Box", "Helper box", "Box.Shape.brp")}</ObjectData></Document>`;
const guiXml = `<?xml version='1.0' encoding='utf-8'?><Document SchemaVersion="1"><ViewProviderData Count="4">${view("Body", true)}${view("Pad", false)}${view("Pocket", true)}${view("Box", false)}</ViewProviderData></Document>`;
{
  const file = zip([["Document.xml", text(docXml)], ["GuiDocument.xml", text(guiXml)], ["Body.Shape.brp", brep], ["Pad.Shape.brp", brep], ["Pocket.Shape.brp", brep], ["Box.Shape.brp", brep]]);
  const shapes = await readFcstd(file);
  check("a FreeCAD document: the Body on show comes in, by its label - not its own Pad and Pocket, not the hidden box", shapes.length === 1 && shapes[0].name === "Bracket & plate" && shapes[0].brep.length === brep.length, shapes.map((s) => s.name).join(", "));
  const f = { id: "fc", name: shapes[0].name, type: "import", format: "brep", fileName: "x.FCStd", data: b64(shapes[0].brep), apart: true } as unknown as Feature;
  const { errors, body } = await after([f], "fc");
  check("…and it is the exact solid FreeCAD kept", !errors.length && Math.abs(volume(body) - v0) < 1e-9, `${volume(body)} ${errors.join("; ")}`);
  // Saved without the window (no view data): what nothing else is made from - the Body and the box, not the Pad.
  const bare = await readFcstd(zip([["Document.xml", text(docXml)], ["Body.Shape.brp", brep], ["Pad.Shape.brp", brep], ["Pocket.Shape.brp", brep], ["Box.Shape.brp", brep]]));
  check("with no view data in the file: every shape nothing else is made from", bare.map((s) => s.name).sort().join() === "Bracket & plate,Helper box", bare.map((s) => s.name).join(", "));
  let said = "";
  try {
    await readFcstd(zip([["Document.xml", text(docXml)], ["GuiDocument.xml", text(guiXml.replace(/value="true"/g, 'value="false"'))], ["Body.Shape.brp", brep]]));
  } catch (e) {
    said = (e as Error).message;
  }
  check("nothing on show: said so", /no shapes on show/.test(said), said);
  try {
    said = "";
    await readFcstd(zip([["hello.txt", text("hi")]]));
  } catch (e) {
    said = (e as Error).message;
  }
  check("a zip that is not a FreeCAD document: said so", /isn't a FreeCAD document/.test(said), said);
}

// ---------------------------------------------------------- glTF / GLB
{
  // A pyramid in millimetres, Z up, saved as this app saves a GLB (metres, Y up) and read back: where it was.
  const positions = new Float32Array([0, 0, 0, 40, 0, 0, 0, 30, 0, 0, 0, 20]);
  const indices = new Uint32Array([0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2]);
  const file = glb([{ name: "Pyramid", positions, indices }], "test");
  const tris = gltfTriangles(file);
  const want = [...indices].map((i) => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]]);
  const worst = Math.max(...tris.flat().map((p, k) => Math.max(...p.map((x, j) => Math.abs(x - want[k][j])))));
  check("a GLB saved by this app and read back: the same four triangles, in millimetres with Z up", tris.length === 4 && worst < 1e-3, `${tris.length} triangles, off by ${worst}`);
  const stl = stlOfTriangles(tris);
  const f = { id: "g", name: "g.glb", type: "import", format: "stl", fileName: "g.glb", data: b64(stl), apart: true, round: true } as unknown as Feature;
  const { errors, body } = await after([f], "g");
  check("…and it comes in as a closed solid of the pyramid's volume (40 x 30 x 20 / 6)", !errors.length && Math.abs(volume(body) - 4000) < 0.5, `${volume(body)} ${errors.join("; ")}`);

  // A .gltf as text with its data inside it: one triangle, its node moved 1 m along X and turned upright.
  const buf = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const json = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ translation: [1, 0, 0], children: [1] }, { mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
    buffers: [{ byteLength: 36, uri: `data:application/octet-stream;base64,${b64(new Uint8Array(buf.buffer))}` }],
  };
  const t2 = gltfTriangles(text(JSON.stringify(json)));
  // Metres, Y up: (0,0,0) (1,0,0) (0,1,0) moved +1 in X  =>  mm, Z up: (1000,0,0) (2000,0,0) (1000,0,1000).
  const want2 = [[1000, 0, 0], [2000, 0, 0], [1000, 0, 1000]];
  check("a .gltf with its data inside and no index list: its triangle where its node puts it, Y up made Z up", t2.length === 1 && t2[0].every((p, k) => p.every((x, j) => Math.abs(x - want2[k][j]) < 1e-6)), JSON.stringify(t2));
  let said = "";
  try {
    gltfTriangles(text(JSON.stringify({ ...json, buffers: [{ byteLength: 36, uri: "mesh.bin" }] })));
  } catch (e) {
    said = (e as Error).message;
  }
  check("a .gltf that keeps its meshes in a file beside it: said what to do", /one \.glb file/.test(said), said);
  try {
    said = "";
    gltfTriangles(text(JSON.stringify({ ...json, extensionsRequired: ["KHR_draco_mesh_compression"] })));
  } catch (e) {
    said = (e as Error).message;
  }
  check("compressed meshes: said", /compressed/.test(said), said);
}
done();
