// More file formats: GLB out (glTF's one-file form, for the web, AR and
// renderers) and 3MF in (slicer files: the exact model packed in one of ours,
// else its meshes).

// ------------------------------------------------------------------ unzip

/** The files of a ZIP archive (what 3MF is), by name. */
export async function unzip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
    if (dv.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  if (end < 0) throw new Error("it isn't a ZIP-based file, or it is damaged");
  const count = dv.getUint16(end + 10, true);
  let at = dv.getUint32(end + 16, true);
  const out = new Map<string, Uint8Array>();
  const dec = new TextDecoder();
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(at, true) !== 0x02014b50) throw new Error("the file is damaged");
    const method = dv.getUint16(at + 10, true);
    const packed = dv.getUint32(at + 20, true);
    const n = dv.getUint16(at + 28, true);
    const extra = dv.getUint16(at + 30, true);
    const comment = dv.getUint16(at + 32, true);
    const local = dv.getUint32(at + 42, true);
    const name = dec.decode(bytes.subarray(at + 46, at + 46 + n));
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + packed);
    if (!name.endsWith("/")) out.set(name, method === 8 ? await inflate(data) : data);
    at += 46 + n + extra + comment;
  }
  return out;
}

async function inflate(d: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([d as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

// -------------------------------------------------------------------- 3MF

const UNIT_MM: Record<string, number> = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 };
const attrs = (s: string) => Object.fromEntries([...s.matchAll(/([\w:]+)\s*=\s*"([^"]*)"/g)].map((m) => [m[1].replace(/^\w+:/, ""), m[2]]));
type M = number[];
/** 3MF's 3×4 matrix ("m00 m01 m02 m10 … m32"), points as rows: p·M. */
const matrix = (t?: string): M => (t ? t.trim().split(/\s+/).map(Number) : [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
const apply = (m: M, p: number[]) => [p[0] * m[0] + p[1] * m[3] + p[2] * m[6] + m[9], p[0] * m[1] + p[1] * m[4] + p[2] * m[7] + m[10], p[0] * m[2] + p[1] * m[5] + p[2] * m[8] + m[11]];
/** a then b. */
const compose = (a: M, b: M): M => {
  const r: M = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[3 * i + j] = a[3 * i] * b[j] + a[3 * i + 1] * b[3 + j] + a[3 * i + 2] * b[6 + j];
  const t = apply(b, [a[9], a[10], a[11]]);
  return [...r, ...t];
};

/**
 * A 3MF file as something to import: the exact STEP model when it carries one
 * (ours do), else its meshes - each build item, its components placed - as a
 * binary STL, in millimetres.
 */
export async function read3mf(bytes: Uint8Array): Promise<{ format: "step" | "stl"; bytes: Uint8Array }> {
  const files = await unzip(bytes);
  for (const [name, data] of files) if (/\.(step|stp)$/i.test(name)) return { format: "step", bytes: data };
  const modelName = [...files.keys()].find((n) => /^\/?3D\/.*\.model$/i.test(n));
  if (!modelName) throw new Error("it has no 3D model in it");
  const xml = new TextDecoder().decode(files.get(modelName));
  const unit = UNIT_MM[attrs(xml.match(/<(?:\w+:)?model\b([^>]*)>/)?.[1] ?? "").unit ?? "millimeter"] ?? 1;
  type Obj = { v: number[][]; t: number[][]; parts: { id: string; m: M }[] };
  const objects = new Map<string, Obj>();
  for (const o of xml.matchAll(/<(?:\w+:)?object\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?object>)/g)) {
    const body = o[2] ?? "";
    const v = [...body.matchAll(/<(?:\w+:)?vertex\b([^>]*)>/g)].map((m) => {
      const a = attrs(m[1]);
      return [Number(a.x), Number(a.y), Number(a.z)];
    });
    const t = [...body.matchAll(/<(?:\w+:)?triangle\b([^>]*)>/g)].map((m) => {
      const a = attrs(m[1]);
      return [Number(a.v1), Number(a.v2), Number(a.v3)];
    });
    const parts = [...body.matchAll(/<(?:\w+:)?component\b([^>]*)>/g)].map((m) => {
      const a = attrs(m[1]);
      return { id: a.objectid, m: matrix(a.transform) };
    });
    objects.set(attrs(o[1]).id, { v, t, parts });
  }
  const tris: number[][][] = [];
  const add = (id: string, m: M, depth: number) => {
    const o = objects.get(id);
    if (!o || depth > 16) return;
    for (const [a, b, c] of o.t) {
      if (![a, b, c].every((k) => Number.isInteger(k) && k >= 0 && k < o.v.length)) continue;
      tris.push([a, b, c].map((k) => apply(m, o.v[k]).map((x) => x * unit)));
    }
    for (const p of o.parts) add(p.id, compose(p.m, m), depth + 1);
  };
  const items = [...xml.matchAll(/<(?:\w+:)?item\b([^>]*)>/g)].map((m) => attrs(m[1]));
  if (items.length) for (const it of items) add(it.objectid, matrix(it.transform), 0);
  else for (const id of objects.keys()) add(id, matrix(), 0);
  if (!tris.length) throw new Error("it has no triangles in it");
  return { format: "stl", bytes: stlOf(tris) };
}

/** Triangles as a binary STL (normals left zero: readers work them out). */
function stlOf(tris: number[][][]): Uint8Array {
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

// -------------------------------------------------------------------- GLB

export interface GlbBody {
  name: string;
  positions: Float32Array;
  indices: Uint32Array;
  /** "#rrggbb" */
  color?: string;
  opacity?: number;
}

/** sRGB "#rrggbb" to glTF's linear colour. */
const linear = (hex: string) =>
  [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });

/**
 * The bodies as one GLB: a mesh each (smooth normals, its colour), named,
 * under a root that turns Z up into glTF's Y up and millimetres into metres.
 */
export function glb(bodies: GlbBody[], title: string): Uint8Array {
  const chunks: Uint8Array[] = [];
  let length = 0;
  const views: object[] = [];
  const accessors: object[] = [];
  const push = (data: ArrayBufferView, target: number) => {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    views.push({ buffer: 0, byteOffset: length, byteLength: bytes.length, target });
    chunks.push(bytes);
    length += bytes.length;
    const pad = (4 - (length % 4)) % 4;
    if (pad) (chunks.push(new Uint8Array(pad)), (length += pad));
    return views.length - 1;
  };
  const meshes: object[] = [];
  const materials: object[] = [];
  const nodes: object[] = [{ name: title, rotation: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2], scale: [0.001, 0.001, 0.001], children: bodies.map((_, i) => i + 1) }];
  bodies.forEach((b, i) => {
    const p = b.positions;
    const n = new Float32Array(p.length);
    // Smooth normals: each corner's, from the triangles round it (weighted by their size).
    for (let t = 0; t < b.indices.length; t += 3) {
      const [a, c, d] = [b.indices[t], b.indices[t + 1], b.indices[t + 2]];
      const u = [p[3 * c] - p[3 * a], p[3 * c + 1] - p[3 * a + 1], p[3 * c + 2] - p[3 * a + 2]];
      const v = [p[3 * d] - p[3 * a], p[3 * d + 1] - p[3 * a + 1], p[3 * d + 2] - p[3 * a + 2]];
      const x = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      for (const k of [a, c, d]) for (let j = 0; j < 3; j++) n[3 * k + j] += x[j];
    }
    for (let k = 0; k < n.length; k += 3) {
      const l = Math.hypot(n[k], n[k + 1], n[k + 2]) || 1;
      n[k] /= l;
      n[k + 1] /= l;
      n[k + 2] /= l;
    }
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < p.length; k += 3)
      for (let j = 0; j < 3; j++) {
        min[j] = Math.min(min[j], p[k + j]);
        max[j] = Math.max(max[j], p[k + j]);
      }
    const count = p.length / 3;
    accessors.push({ bufferView: push(new Float32Array(p), 34962), componentType: 5126, count, type: "VEC3", min, max });
    accessors.push({ bufferView: push(n, 34962), componentType: 5126, count, type: "VEC3" });
    accessors.push({ bufferView: push(new Uint32Array(b.indices), 34963), componentType: 5125, count: b.indices.length, type: "SCALAR" });
    const alpha = b.opacity ?? 1;
    materials.push({
      name: b.name,
      pbrMetallicRoughness: { baseColorFactor: [...linear(b.color ?? "#b8bcc6"), alpha], metallicFactor: 0, roughnessFactor: 0.6 },
      ...(alpha < 1 ? { alphaMode: "BLEND" } : {}),
    });
    meshes.push({ name: b.name, primitives: [{ attributes: { POSITION: 3 * i, NORMAL: 3 * i + 1 }, indices: 3 * i + 2, material: i }] });
    nodes.push({ name: b.name, mesh: i });
  });
  const json = {
    asset: { version: "2.0", generator: "supergeometry.app" },
    scene: 0,
    scenes: [{ name: title, nodes: [0] }],
    nodes,
    meshes,
    materials,
    accessors,
    bufferViews: views,
    buffers: [{ byteLength: length }],
  };
  let jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jpad = (4 - (jsonBytes.length % 4)) % 4;
  if (jpad) {
    const padded = new Uint8Array(jsonBytes.length + jpad).fill(0x20);
    padded.set(jsonBytes);
    jsonBytes = padded;
  }
  const total = 12 + 8 + jsonBytes.length + 8 + length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); // "glTF"
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.length, true);
  dv.setUint32(16, 0x4e4f534a, true); // "JSON"
  out.set(jsonBytes, 20);
  let o = 20 + jsonBytes.length;
  dv.setUint32(o, length, true);
  dv.setUint32(o + 4, 0x004e4942, true); // "BIN"
  o += 8;
  for (const c of chunks) (out.set(c, o), (o += c.length));
  return out;
}
