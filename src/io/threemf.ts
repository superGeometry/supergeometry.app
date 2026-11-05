// 3MF export (what slicers open): one mesh object per body, in millimetres,
// with the bodies' colours, plus the exact STEP model packed in the file as
// an attachment (slicers skip it; it travels with the print file).

export interface MeshBody {
  name: string;
  positions: Float32Array;
  indices: Uint32Array;
  /** "#rrggbb" */
  color?: string;
}

const esc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
const num = (v: number) => (Math.round(v * 1e5) / 1e5).toString();

function modelXml(bodies: MeshBody[], title: string): string {
  const colors = [...new Set(bodies.map((b) => b.color).filter((c): c is string => !!c))];
  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push('<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">');
  out.push(`<metadata name="Title">${esc(title)}</metadata>`);
  out.push('<metadata name="Application">supergeometry.app</metadata>');
  out.push("<resources>");
  if (colors.length) {
    out.push('<basematerials id="1">');
    for (const c of colors) out.push(`<base name="${esc(c)}" displaycolor="${esc(c.toUpperCase())}FF"/>`);
    out.push("</basematerials>");
  }
  bodies.forEach((b, k) => {
    const id = k + 2;
    const ci = b.color ? colors.indexOf(b.color) : -1;
    out.push(`<object id="${id}" type="model" name="${esc(b.name)}"${ci >= 0 ? ` pid="1" pindex="${ci}"` : ""}><mesh><vertices>`);
    // Shared corners once (the display mesh repeats them per face).
    const map = new Map<string, number>();
    const remap: number[] = [];
    const p = b.positions;
    for (let i = 0; i < p.length / 3; i++) {
      const key = `${num(p[3 * i])},${num(p[3 * i + 1])},${num(p[3 * i + 2])}`;
      let v = map.get(key);
      if (v === undefined) {
        v = map.size;
        map.set(key, v);
        out.push(`<vertex x="${num(p[3 * i])}" y="${num(p[3 * i + 1])}" z="${num(p[3 * i + 2])}"/>`);
      }
      remap.push(v);
    }
    out.push("</vertices><triangles>");
    const ix = b.indices;
    for (let t = 0; t < ix.length; t += 3) {
      const [a, c, d] = [remap[ix[t]], remap[ix[t + 1]], remap[ix[t + 2]]];
      if (a === c || c === d || a === d) continue; // collapsed by the shared corners
      out.push(`<triangle v1="${a}" v2="${c}" v3="${d}"/>`);
    }
    out.push("</triangles></mesh></object>");
  });
  out.push("</resources><build>");
  bodies.forEach((_, k) => out.push(`<item objectid="${k + 2}"/>`));
  out.push("</build></model>");
  return out.join("\n");
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
<Default Extension="step" ContentType="application/step"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
<Relationship Target="/Attachments/model.step" Id="rel1" Type="http://schemas.supergeometry.app/2025/step"/>
</Relationships>`;

export async function exportThreeMF(bodies: MeshBody[], title: string, step: Blob): Promise<Blob> {
  const enc = new TextEncoder();
  return zip([
    { name: "[Content_Types].xml", data: enc.encode(CONTENT_TYPES) },
    { name: "_rels/.rels", data: enc.encode(RELS) },
    { name: "3D/3dmodel.model", data: enc.encode(modelXml(bodies, title)) },
    { name: "Attachments/model.step", data: new Uint8Array(await step.arrayBuffer()) },
  ]);
}

// ------------------------------------------------------------- tiny zip

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(d: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < d.length; i++) c = CRC[(c ^ d[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Deflate when the browser can (much smaller meshes), else store. */
async function deflate(d: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === "undefined") return null;
  try {
    const s = new Blob([d as BlobPart]).stream().pipeThrough(new CompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(s).arrayBuffer());
  } catch {
    return null;
  }
}

/** A ZIP archive (what 3MF is). */
export async function zip(files: { name: string; data: Uint8Array }[]): Promise<Blob> {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const enc = new TextEncoder();
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const packed = await deflate(f.data);
    const method = packed && packed.length < f.data.length ? 8 : 0;
    const body = method ? packed! : f.data;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(8, method, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, f.data.length, true);
    local.setUint16(26, name.length, true);
    parts.push(new Uint8Array(local.buffer), name, body);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, 20, true);
    cen.setUint16(6, 20, true);
    cen.setUint16(10, method, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, body.length, true);
    cen.setUint32(24, f.data.length, true);
    cen.setUint16(28, name.length, true);
    cen.setUint32(42, offset, true);
    central.push(new Uint8Array(cen.buffer), name);
    offset += 30 + name.length + body.length;
  }
  const size = central.reduce((s, c) => s + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)] as BlobPart[], { type: "application/vnd.ms-package.3dmanufacturing-3dmodel+xml" });
}
