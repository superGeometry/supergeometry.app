// File formats: 3MF in (the packed STEP, else the meshes), GLB out.
// Run: npx tsx tests/formats.test.ts
import { glb, read3mf } from "../src/io/formats";
import { exportThreeMF, zip } from "../src/io/threemf";
import { check, done } from "./kit";

const cube = { name: "Cube", positions: new Float32Array([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0]), indices: new Uint32Array([0, 1, 2, 0, 2, 3]), color: "#ff0000" };
const bytes = async (b: Blob) => new Uint8Array(await b.arrayBuffer());

// One of ours: the exact model inside wins.
{
  const step = new Blob(["ISO-10303-21;\nDATA;\nENDSEC;"]);
  const r = await read3mf(await bytes(await exportThreeMF([cube], "T", step)));
  check("our 3MF: the STEP packed in it", r.format === "step" && new TextDecoder().decode(r.bytes).startsWith("ISO-10303-21"), r.format);
}

// A slicer's: meshes, in inches, one placed twice through components.
{
  const xml = `<?xml version="1.0"?><model unit="inch" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>
<object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>
<object id="2" type="model"><components><component objectid="1"/><component objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 2"/></components></object>
</resources><build><item objectid="2" transform="1 0 0 0 1 0 0 0 1 3 0 0"/></build></model>`;
  const file = await bytes(await zip([{ name: "3D/3dmodel.model", data: new TextEncoder().encode(xml) }]));
  const r = await read3mf(file);
  const dv = new DataView(r.bytes.buffer, r.bytes.byteOffset);
  const n = dv.getUint32(80, true);
  // Second triangle, first corner: (0,0,0) moved up 2 in, then 3 in along x: (76.2, 0, 50.8) mm.
  const at = 84 + 50 + 12;
  const p = [dv.getFloat32(at, true), dv.getFloat32(at + 4, true), dv.getFloat32(at + 8, true)];
  check("a slicer's 3MF: its meshes as STL, components placed, inches to mm", r.format === "stl" && n === 2 && Math.abs(p[0] - 76.2) < 1e-3 && Math.abs(p[2] - 50.8) < 1e-3, { n, p });
}

// GLB: a valid header, the JSON chunk, a mesh per body with its colour.
{
  const out = glb([cube, { ...cube, name: "Glass", color: "#ffffff", opacity: 0.4 }], "Project");
  const dv = new DataView(out.buffer);
  const jl = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(out.subarray(20, 20 + jl)));
  check("GLB: magic, version, length", dv.getUint32(0, true) === 0x46546c67 && dv.getUint32(4, true) === 2 && dv.getUint32(8, true) === out.length);
  check("a mesh and a node per body, named", json.meshes.length === 2 && json.nodes[2].name === "Glass" && json.nodes[0].children.length === 2);
  check("colour (linear) and see-through", Math.abs(json.materials[0].pbrMetallicRoughness.baseColorFactor[0] - 1) < 1e-9 && json.materials[1].alphaMode === "BLEND");
  check("the binary chunk holds every buffer view", dv.getUint32(20 + jl, true) === json.buffers[0].byteLength && out.length === 20 + jl + 8 + json.buffers[0].byteLength);
}

done();
