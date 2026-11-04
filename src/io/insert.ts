// Insert menu: files (STEP/STL/OBJ/DXF/projects), images, variables.

import { migrate, newId } from "../doc/store";
import type { Feature, ImageFeature, PlaneDef, SketchEntity, SketchFeature } from "../doc/types";
import { GROUND } from "../geom";
import { uid } from "../sketch/edit";
import type { AppContext } from "../tools/tool";
import { evaluate, fmtLen, setVariables } from "../units";
import { parseSVG } from "./svg";

export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}

export async function insertFile(app: AppContext): Promise<void> {
  const file = await pickFile(".step,.stp,.stl,.obj,.dxf,.svg,.dwg,.super,.tessel");
  if (!file) return;
  const ext = file.name.split(".").pop()!.toLowerCase();
  try {
    if (ext === "dwg") {
      app.ui.toast("DWG is a closed format. Save it as DXF (e.g. with LibreCAD or ODA File Converter, both free) and insert that.", "error");
      return;
    }
    if (ext === "dxf") {
      const entities = parseDXF(await file.text());
      if (!entities.length) throw new Error("No lines, arcs, circles, polylines or splines found");
      const sk: SketchFeature = { ...app.store.newIdentity("sketch", file.name.replace(/\.dxf$/i, "")), type: "sketch", plane: GROUND, entities };
      app.store.add(sk);
      app.ui.toast(`Inserted ${entities.length} curves as a sketch on the ground plane`);
      return;
    }
    if (ext === "svg") {
      // Outlines (logos, laser/vinyl cut files…) as a sketch, centred on the origin.
      const { entities, size } = parseSVG(await file.text());
      const sk: SketchFeature = { ...app.store.newIdentity("sketch", file.name.replace(/\.svg$/i, "")), type: "sketch", plane: GROUND, entities };
      app.store.add(sk);
      app.ui.toast(`Inserted ${entities.length} curves (${fmtLen(size[0])} × ${fmtLen(size[1])}) as a sketch on the ground plane`);
      return;
    }
    if (ext === "super" || ext === "tessel") {
      insertProject(app, migrate(JSON.parse(await file.text())).features, file.name);
      return;
    }
    let bytes: Uint8Array = new Uint8Array(await file.arrayBuffer());
    let format: "step" | "stl" = ext === "stl" ? "stl" : "step";
    if (ext === "obj") {
      bytes = objToStl(new TextDecoder().decode(bytes));
      format = "stl";
    }
    app.ui.setStatus(`Importing ${file.name}…`);
    app.store.add({ ...app.store.newIdentity("import"), type: "import", format, fileName: file.name, data: toBase64(bytes) });
    app.ui.setStatus(null);
  } catch (err) {
    app.ui.setStatus(null);
    app.ui.toast(`Could not insert ${file.name}: ${(err as Error).message}`, "error");
  }
}

/** Append another project's history (ids are renamed so nothing collides). */
function insertProject(app: AppContext, features: Feature[], name: string): void {
  const map = new Map(features.map((f) => [f.id, newId(f.type)]));
  let json = JSON.stringify(features);
  for (const [from, to] of map) json = json.split(`"${from}"`).join(`"${to}"`);
  const renamed = JSON.parse(json) as Feature[];
  app.store.commit((d) => d.features.push(...renamed));
  app.ui.toast(`Inserted ${renamed.length} steps from ${name}`);
}

export async function insertImage(app: AppContext, plane: PlaneDef = GROUND): Promise<void> {
  const file = await pickFile("image/*");
  if (!file) return;
  const src = await new Promise<string>((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.readAsDataURL(file);
  });
  const img = new Image();
  img.src = src;
  await img.decode();
  const width = 100;
  const f: ImageFeature = { ...app.store.newIdentity("image"), type: "image", plane, src, width, height: (width * img.height) / img.width, opacity: 0.8 };
  app.store.add(f);
  app.ui.toast("Image placed on the ground plane (100 mm wide). Edit it from History.");
}

/** Create a named variable (optionally from a field's current value); returns its name. */
export async function createVariable(app: AppContext, value = ""): Promise<string | null> {
  const list = app.store.doc.variables;
  const note = list.length ? `Existing: ${list.map((v) => `${v.name} = ${v.expr}`).join(", ")}` : "Use variables in any field, e.g. width*2 or wall + 1mm.";
  const v = await app.ui.dialog("Create Variable", [
    { key: "name", label: "Name", value: "", placeholder: "width" },
    { key: "expr", label: "Value", value, placeholder: "40 or 1.5in or depth/2" },
  ], note);
  if (!v) return null;
  const name = v.name.trim();
  if (!/^[a-z_][a-z0-9_]*$/i.test(name) || /^(mm|cm|m|in|ft)$/i.test(name)) {
    app.ui.toast("Names use letters, digits and _ (not starting with a digit, not a unit)", "error");
    return null;
  }
  const next = [...list.filter((x) => x.name !== name), { name, expr: v.expr.trim() || "0" }];
  setVariables(next);
  if (evaluate(v.expr || "0") === null) {
    setVariables(list);
    app.ui.toast(`"${v.expr}" isn't a valid value`, "error");
    return null;
  }
  app.store.commit((d) => (d.variables = next));
  app.ui.toast(`${name} = ${v.expr}`);
  return name;
}

/** Edit every variable at once; changing one rebuilds everything that uses it. */
export async function editVariables(app: AppContext): Promise<void> {
  const list = app.store.doc.variables;
  if (!list.length) return void createVariable(app);
  const v = await app.ui.dialog(
    "Variables",
    list.map((x) => ({ key: x.name, label: x.name, value: x.expr })),
    "Change a value to update every feature that uses it. Clear a value to delete the variable.",
  );
  if (!v) return;
  const next = list.filter((x) => v[x.name]?.trim()).map((x) => ({ name: x.name, expr: v[x.name].trim() }));
  setVariables(next);
  const bad = next.find((x) => evaluate(x.expr) === null);
  if (bad) {
    setVariables(list);
    return app.ui.toast(`"${bad.expr}" isn't a valid value for ${bad.name}`, "error");
  }
  app.store.commit((d) => (d.variables = next));
}

export async function editImage(app: AppContext, f: ImageFeature): Promise<void> {
  const v = await app.ui.dialog("Image", [
    { key: "width", label: "Width (mm)", value: String(f.width) },
    { key: "opacity", label: "Opacity (0–1)", value: String(f.opacity) },
  ]);
  if (!v) return;
  const width = Number(v.width) || f.width;
  app.store.update(f.id, { width, height: (f.height * width) / f.width, opacity: Math.min(1, Math.max(0.05, Number(v.opacity) || f.opacity)) });
}

// -------------------------------------------------------------------- DXF

/** Minimal ASCII DXF reader: LINE, CIRCLE, ARC, LWPOLYLINE, POLYLINE, SPLINE, ELLIPSE. */
export function parseDXF(text: string): SketchEntity[] {
  const lines = text.split(/\r?\n/);
  const pairs: [number, string][] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) pairs.push([parseInt(lines[i].trim(), 10), lines[i + 1].trim()]);
  const start = pairs.findIndex((p, i) => p[0] === 2 && p[1] === "ENTITIES" && pairs[i - 1]?.[1] === "SECTION");
  if (start < 0) return [];
  const out: SketchEntity[] = [];
  let i = start + 1;
  const num = (codes: [number, string][], c: number, d = 0) => Number(codes.find((x) => x[0] === c)?.[1] ?? d);
  while (i < pairs.length && !(pairs[i][0] === 0 && pairs[i][1] === "ENDSEC")) {
    if (pairs[i][0] !== 0) {
      i++;
      continue;
    }
    const type = pairs[i][1];
    const codes: [number, string][] = [];
    i++;
    while (i < pairs.length && pairs[i][0] !== 0) codes.push(pairs[i++]);
    if (type === "LINE") out.push({ id: uid(), kind: "line", a: [num(codes, 10), num(codes, 20)], b: [num(codes, 11), num(codes, 21)] });
    else if (type === "CIRCLE") out.push({ id: uid(), kind: "circle", center: [num(codes, 10), num(codes, 20)], radius: num(codes, 40) });
    else if (type === "ARC") {
      const c: [number, number] = [num(codes, 10), num(codes, 20)];
      const r = num(codes, 40);
      const a0 = (num(codes, 50) * Math.PI) / 180;
      let a1 = (num(codes, 51) * Math.PI) / 180;
      if (a1 <= a0) a1 += Math.PI * 2;
      const at = (t: number): [number, number] => [c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)];
      out.push({ id: uid(), kind: "arc", a: at(a0), m: at((a0 + a1) / 2), b: at(a1) });
    } else if (type === "ELLIPSE") {
      const mx = num(codes, 11);
      const my = num(codes, 21);
      const rx = Math.hypot(mx, my);
      out.push({ id: uid(), kind: "ellipse", center: [num(codes, 10), num(codes, 20)], rx, ry: rx * num(codes, 40, 1), rotation: Math.atan2(my, mx) });
    } else if (type === "LWPOLYLINE") {
      const xs = codes.filter((c) => c[0] === 10).map((c) => Number(c[1]));
      const ys = codes.filter((c) => c[0] === 20).map((c) => Number(c[1]));
      const closed = (num(codes, 70) & 1) === 1;
      const pts = xs.map((x, k) => [x, ys[k]] as [number, number]);
      if (pts.length >= 2) out.push({ id: uid(), kind: "polyline", points: pts, closed });
    } else if (type === "SPLINE") {
      const fx = codes.filter((c) => c[0] === 11).map((c) => Number(c[1]));
      const fy = codes.filter((c) => c[0] === 21).map((c) => Number(c[1]));
      const cx = codes.filter((c) => c[0] === 10).map((c) => Number(c[1]));
      const cy = codes.filter((c) => c[0] === 20).map((c) => Number(c[1]));
      const closed = (num(codes, 70) & 1) === 1;
      if (fx.length >= 2) out.push({ id: uid(), kind: "spline", points: fx.map((x, k) => [x, fy[k]]), closed, mode: "fit" });
      else if (cx.length >= 2) out.push({ id: uid(), kind: "spline", points: cx.map((x, k) => [x, cy[k]]), closed, mode: "control" });
    } else if (type === "POLYLINE") {
      const closed = (num(codes, 70) & 1) === 1;
      const pts: [number, number][] = [];
      while (i < pairs.length && pairs[i][1] === "VERTEX") {
        i++;
        const v: [number, string][] = [];
        while (i < pairs.length && pairs[i][0] !== 0) v.push(pairs[i++]);
        pts.push([num(v, 10), num(v, 20)]);
      }
      if (pts.length >= 2) out.push({ id: uid(), kind: "polyline", points: pts, closed });
    }
  }
  return out;
}

// -------------------------------------------------------------------- OBJ

/** OBJ (triangles/polygons) → binary STL, so the kernel can import it. */
export function objToStl(text: string): Uint8Array {
  const v: number[][] = [];
  const tris: number[][] = [];
  for (const line of text.split(/\r?\n/)) {
    const p = line.trim().split(/\s+/);
    if (p[0] === "v") v.push([Number(p[1]), Number(p[2]), Number(p[3])]);
    else if (p[0] === "f") {
      const idx = p.slice(1).map((s) => {
        const n = parseInt(s.split("/")[0], 10);
        return n < 0 ? v.length + n : n - 1;
      });
      for (let k = 1; k + 1 < idx.length; k++) tris.push([idx[0], idx[k], idx[k + 1]]);
    }
  }
  if (!tris.length) throw new Error("No faces in the OBJ file");
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  let o = 84;
  for (const t of tris) {
    o += 12; // normal left as zero; readers recompute it
    for (const k of t) {
      for (let c = 0; c < 3; c++) dv.setFloat32(o + c * 4, v[k][c], true);
      o += 12;
    }
    o += 2;
  }
  return new Uint8Array(buf);
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
