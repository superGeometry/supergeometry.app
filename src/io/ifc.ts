// IFC (a building model): its elements' geometry as triangles. The reading is done by the web-ifc library (its own
// WebAssembly, over a megabyte), which is fetched only when an IFC file is picked - this module is itself loaded on
// demand (io/insert.ts), and the library when it is first called.
//
// A building is brought in as one mesh, in millimetres with Z up: its walls, slabs, doors and the rest together, to
// look at, measure against and cut with. Openings (doors' and windows' holes) are cut by the library. Spaces (the
// rooms' volumes, IfcSpace) and opening elements are left out: they are not things, and would fill every room.

/** Thrown past the limit so the reading stops at once (a big building has millions of triangles). */
class TooMany extends Error {}

export async function ifcTriangles(bytes: Uint8Array, most: number): Promise<number[][][]> {
  const head = new TextDecoder().decode(bytes.subarray(0, 200));
  if (!/ISO-10303-21/.test(head)) throw new Error("it isn't an IFC file (an .ifczip has to be unpacked first)");
  const WebIFC = await import("web-ifc");
  const wasm = (await import("web-ifc/web-ifc.wasm?url")).default;
  const api = new WebIFC.IfcAPI();
  // (The library asks for its WebAssembly by name, beside a folder: it is given the one the app was built with.)
  await api.Init((path: string) => (path.endsWith(".wasm") ? wasm : path));
  let model = -1;
  const tris: number[][][] = [];
  try {
    model = api.OpenModel(bytes, { COORDINATE_TO_ORIGIN: false });
    if (model < 0) throw new Error("it couldn't be read as an IFC model");
    const skip = new Set<number>([WebIFC.IFCSPACE, WebIFC.IFCOPENINGELEMENT]);
    api.StreamAllMeshes(model, (mesh) => {
      let type = 0;
      try {
        type = api.GetLineType(model, mesh.expressID);
      } catch {
        // (An element whose type can't be told: kept.)
      }
      if (skip.has(type)) return;
      const placed = mesh.geometries;
      for (let i = 0; i < placed.size(); i++) {
        const g = placed.get(i);
        const geom = api.GetGeometry(model, g.geometryExpressID);
        // Six numbers a corner: where it is, and which way the face looks there.
        const verts = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
        const index = api.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());
        const m = g.flatTransformation;
        // The library hands out metres with Y up: millimetres, Z up.
        const at = (k: number): number[] => {
          const [x, y, z] = [verts[k * 6], verts[k * 6 + 1], verts[k * 6 + 2]];
          const X = m[0] * x + m[4] * y + m[8] * z + m[12];
          const Y = m[1] * x + m[5] * y + m[9] * z + m[13];
          const Z = m[2] * x + m[6] * y + m[10] * z + m[14];
          return [X * 1000, -Z * 1000, Y * 1000];
        };
        for (let t = 0; t + 2 < index.length; t += 3) tris.push([at(index[t]), at(index[t + 1]), at(index[t + 2])]);
        geom.delete();
        if (tris.length > most) throw new TooMany();
      }
    });
  } catch (err) {
    // (Past the limit: what there is says so by its count - the caller refuses it with the number it knows.)
    if (!(err instanceof TooMany)) throw err instanceof Error && /isn't|couldn't/.test(err.message) ? err : new Error("it couldn't be read as an IFC model");
  } finally {
    if (model >= 0) api.CloseModel(model);
  }
  if (!tris.length) throw new Error("it has no shapes in it that can be shown");
  return tris;
}
