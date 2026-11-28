// Files of other programs, read in the page: FreeCAD documents, glTF / GLB models, IFC buildings. Loaded only
// when such a file is picked (io/insert.ts asks for this module then), so they cost nothing until they are used.
//
// - FreeCAD (.FCStd): a zip holding, for every object, its shape as the geometry kernel's own text (BRep) - the
//   exact solids, as FreeCAD last computed them. The objects on show are brought in, each a body.
// - glTF / GLB: meshes. Brought in as one mesh in millimetres, Z up (the file is in metres, Y up).
// - IFC: a building's elements, made meshes by the web-ifc library (fetched when an IFC file is picked).

import { unzip } from "./formats";

// ------------------------------------------------------------- FreeCAD

export interface FreecadShape {
  /** The object's label (what FreeCAD shows in its tree). */
  name: string;
  /** Its shape, as BRep text. */
  brep: Uint8Array;
}

/**
 * The shapes on show in a FreeCAD document. A Body's own features (the Pad, the Pocket…) are not bodies of their
 * own: the Body is. With no view data in the file (saved without the window), every shape nothing else is made from.
 */
export async function readFcstd(bytes: Uint8Array): Promise<FreecadShape[]> {
  const files = await unzip(bytes);
  const docXml = files.get("Document.xml");
  if (!docXml) throw new Error("it isn't a FreeCAD document (no Document.xml in it)");
  // (Read as text, by its tags: the document is FreeCAD's own writing, always of this form - and so this reads the
  // same in the page and outside it.)
  const xml = new TextDecoder().decode(docXml);
  const plain = (t: string) => t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  const attr = (tag: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
  const types = new Map<string, string>();
  const list = /<Objects\b[^>]*>([\s\S]*?)<\/Objects>/.exec(xml)?.[1] ?? "";
  for (const m of list.matchAll(/<Object\b([^>]*)>/g)) types.set(attr(m[1], "name") ?? "", attr(m[1], "type") ?? "");
  type Obj = { name: string; label: string; file: string | null; links: string[]; group: string[] };
  const objs: Obj[] = [];
  const data = /<ObjectData\b[^>]*>([\s\S]*)<\/ObjectData>/.exec(xml)?.[1] ?? "";
  for (const o of data.matchAll(/<Object\b([^>]*)>([\s\S]*?)<\/Object>/g)) {
    const name = attr(o[1], "name") ?? "";
    const body = o[2];
    const prop = (n: string) => new RegExp(`<Property\\b[^>]*\\bname="${n}"[^>]*>([\\s\\S]*?)<\\/Property>`).exec(body)?.[1] ?? "";
    const label = plain(/<String\b[^>]*\bvalue="([^"]*)"/.exec(prop("Label"))?.[1] ?? "") || name;
    const file = /<Part\b[^>]*\bfile="([^"]*)"/.exec(prop("Shape"))?.[1] || null;
    const linksIn = (t: string) => [...t.matchAll(/<Link(?:Sub)?\b[^>]*\bvalue="([^"]*)"/g)].map((m) => m[1]).filter(Boolean);
    objs.push({ name, label, file, links: linksIn(body), group: linksIn(prop("Group")) });
  }
  if (!objs.length) throw new Error("its Document.xml has no objects in it");
  // What a Body holds (its Pad, its Pocket…) is the Body's, not a body of its own.
  const inBody = new Set(objs.filter((o) => types.get(o.name) === "PartDesign::Body").flatMap((o) => o.group));
  let shown: Set<string> | null = null;
  const guiXml = files.get("GuiDocument.xml");
  if (guiXml) {
    const gui = new TextDecoder().decode(guiXml);
    const views = [...gui.matchAll(/<ViewProvider\b([^>]*)>([\s\S]*?)<\/ViewProvider>/g)];
    if (views.length) {
      shown = new Set();
      for (const v of views) {
        const vis = /<Property\b[^>]*\bname="Visibility"[^>]*>\s*<Bool\b[^>]*\bvalue="([^"]*)"/.exec(v[2])?.[1];
        if (vis === "true") shown.add(attr(v[1], "name") ?? "");
      }
    }
  }
  // (No view data: what nothing else is made from.)
  const used = new Set(objs.flatMap((o) => o.links));
  const out: FreecadShape[] = [];
  let binary = 0;
  for (const o of objs) {
    if (!o.file || inBody.has(o.name)) continue;
    if (shown ? !shown.has(o.name) : used.has(o.name)) continue;
    const shape = files.get(o.file);
    if (!shape || !shape.length) continue;
    // (A document saved with binary shapes: not the text this reads.)
    if (/\.bin$/i.test(o.file)) {
      binary++;
      continue;
    }
    out.push({ name: o.label, brep: shape });
  }
  if (!out.length)
    throw new Error(
      binary
        ? 'its shapes are saved in FreeCAD\'s binary form: in FreeCAD, switch off Preferences › General › Document › "Save shapes in binary format" and save it again'
        : "it has no shapes on show (make the bodies visible in FreeCAD and save it again)",
    );
  return out;
}

// ---------------------------------------------------------- glTF / GLB

type Mat = number[]; // 4 x 4, column-major, as glTF has it

const IDENTITY: Mat = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const mul = (a: Mat, b: Mat): Mat => {
  const r = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) for (let row = 0; row < 4; row++) for (let k = 0; k < 4; k++) r[c * 4 + row] += a[k * 4 + row] * b[c * 4 + k];
  return r;
};
function localMatrix(n: { matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] }): Mat {
  if (n.matrix?.length === 16) return n.matrix;
  const [tx, ty, tz] = n.translation ?? [0, 0, 0];
  const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale ?? [1, 1, 1];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

const SIZES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const COUNT: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

/**
 * A glTF model's triangles, as a mesh in millimetres with Z up: every mesh of the scene, placed as its nodes place
 * it. `bytes`: a .glb, or a .gltf with its data inside it (one that keeps its data in files beside it can't be read
 * from the one file picked).
 */
export function gltfTriangles(bytes: Uint8Array): number[][][] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let json: any;
  let bin: Uint8Array | null = null;
  if (bytes.length >= 12 && dv.getUint32(0, true) === 0x46546c67) {
    let at = 12;
    while (at + 8 <= bytes.length) {
      const len = dv.getUint32(at, true);
      const kind = dv.getUint32(at + 4, true);
      const data = bytes.subarray(at + 8, at + 8 + len);
      if (kind === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(data));
      else if (kind === 0x004e4942) bin = data;
      at += 8 + len;
    }
  } else {
    try {
      json = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new Error("it isn't a glTF file, or it is damaged");
    }
  }
  if (!json?.asset) throw new Error("it isn't a glTF file, or it is damaged");
  const packed = (json.extensionsRequired ?? []).find((e: string) => /draco|meshopt/i.test(e));
  if (packed) throw new Error(`its meshes are compressed (${packed}): save it without mesh compression`);
  const buffers: Uint8Array[] = (json.buffers ?? []).map((b: { uri?: string }, i: number) => {
    if (!b.uri) {
      if (i === 0 && bin) return bin;
      throw new Error("its data is missing");
    }
    const m = /^data:[^;,]*;base64,(.*)$/s.exec(b.uri);
    if (!m) throw new Error("its meshes are in a separate file beside it: save it as one .glb file");
    return Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0));
  });
  /** An accessor's values, a row each. */
  const read = (index: number): number[][] => {
    const a = json.accessors?.[index];
    if (!a) return [];
    const n = COUNT[a.type] ?? 1;
    const size = SIZES[a.componentType] ?? 4;
    const out: number[][] = [];
    const view = a.bufferView === undefined ? null : json.bufferViews[a.bufferView];
    if (!view) {
      for (let i = 0; i < a.count; i++) out.push(new Array<number>(n).fill(0));
      return out;
    }
    const buf = buffers[view.buffer];
    const d = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const stride = view.byteStride || n * size;
    const start = (view.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const get = (o: number): number => {
      switch (a.componentType) {
        case 5120: return a.normalized ? Math.max(d.getInt8(o) / 127, -1) : d.getInt8(o);
        case 5121: return a.normalized ? d.getUint8(o) / 255 : d.getUint8(o);
        case 5122: return a.normalized ? Math.max(d.getInt16(o, true) / 32767, -1) : d.getInt16(o, true);
        case 5123: return a.normalized ? d.getUint16(o, true) / 65535 : d.getUint16(o, true);
        case 5125: return d.getUint32(o, true);
        default: return d.getFloat32(o, true);
      }
    };
    for (let i = 0; i < a.count; i++) {
      const row: number[] = [];
      for (let k = 0; k < n; k++) row.push(get(start + i * stride + k * size));
      out.push(row);
    }
    return out;
  };
  const tris: number[][][] = [];
  const visit = (index: number, parent: Mat, depth: number) => {
    const node = json.nodes?.[index];
    if (!node || depth > 64) return;
    const m = mul(parent, localMatrix(node));
    const mesh = node.mesh === undefined ? null : json.meshes?.[node.mesh];
    for (const prim of mesh?.primitives ?? []) {
      const mode = prim.mode ?? 4;
      if (mode < 4 || prim.attributes?.POSITION === undefined) continue;
      // Metres, Y up, to millimetres, Z up.
      const pts = read(prim.attributes.POSITION).map(([x, y, z]) => {
        const X = m[0] * x + m[4] * y + m[8] * z + m[12];
        const Y = m[1] * x + m[5] * y + m[9] * z + m[13];
        const Z = m[2] * x + m[6] * y + m[10] * z + m[14];
        return [X * 1000, -Z * 1000, Y * 1000];
      });
      const idx = prim.indices === undefined ? pts.map((_, i) => i) : read(prim.indices).map((r) => r[0]);
      const tri = (a: number, b: number, c: number) => {
        if (a === b || b === c || a === c || !pts[a] || !pts[b] || !pts[c]) return;
        tris.push([pts[a], pts[b], pts[c]]);
      };
      if (mode === 4) for (let i = 0; i + 2 < idx.length; i += 3) tri(idx[i], idx[i + 1], idx[i + 2]);
      else if (mode === 5) for (let i = 0; i + 2 < idx.length; i++) (i % 2 ? tri(idx[i + 1], idx[i], idx[i + 2]) : tri(idx[i], idx[i + 1], idx[i + 2]));
      else if (mode === 6) for (let i = 1; i + 1 < idx.length; i++) tri(idx[0], idx[i], idx[i + 1]);
    }
    for (const c of node.children ?? []) visit(c, m, depth + 1);
  };
  const scene = json.scenes?.[json.scene ?? 0];
  const roots: number[] = scene?.nodes ?? (json.nodes ?? []).map((_: unknown, i: number) => i).filter((i: number) => !(json.nodes as { children?: number[] }[]).some((n) => n.children?.includes(i)));
  for (const r of roots) visit(r, IDENTITY, 0);
  if (!tris.length) throw new Error("it has no triangles in it");
  return tris;
}

/** Triangles as a binary STL (normals left zero: readers work them out). */
export function stlOfTriangles(tris: number[][][]): Uint8Array {
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  let o = 84;
  for (const t of tris) {
    o += 12;
    for (const p of t) for (const x of p) (dv.setFloat32(o, x, true), (o += 4));
    o += 2;
  }
  return new Uint8Array(buf);
}
