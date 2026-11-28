// Insert menu: files (STEP/STL/OBJ/DXF/projects), images, variables.

import { newId, parseProject } from "../doc/store";
import { insertProjectInto, type Inserted } from "../doc/insertProject";
import type { ImageFeature, PlaneDef, ProjectDoc, SketchEntity, SketchFeature } from "../doc/types";
import { GROUND } from "../geom";
import { uid } from "../sketch/edit";
import type { AppContext } from "../tools/tool";
import { bareExpr, evaluate, fmtLen, RESERVED, setVariables, withUnitOf } from "../units";
import { namesIn } from "../doc/varAnchors";
import { nameProblem, renameVariable } from "../doc/renameVariable";
import { DIALOG_ACTION } from "../ui/dialogAction";
import { read3mf } from "./formats";
import { parseSVG } from "./svg";

/**
 * What a file picker is told to offer. On an iPad or iPhone, nothing: told a list of endings (".stl,.step,.super"),
 * the Files window there greys out every file whose kind it has no name for - STL and STEP files and the app's own
 * projects could not be tapped (reported from an iPad, files in iCloud Drive). Every file can be picked there, and
 * one that is not of a kind the app reads is said so once picked. (A list of kinds alone, "image/*", is understood.)
 */
export function acceptFor(accept: string): string {
  const apple = /iPad|iPhone|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  return apple && accept.split(",").some((a) => a.trim().startsWith(".")) ? "" : accept;
}

export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = acceptFor(accept);
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}

/**
 * The most triangles a mesh may have to be brought in (the engine's own limit, kernel/engine.ts MESH_MAX), and the
 * largest file read at all. Both are looked at here, before the file is put into the project: a mesh of millions
 * of triangles was first made text, saved with the project, copied for undo and sent to the engine - where it
 * would have been refused - and the page ran out of memory on the way. Saved by then, it did so again at every start.
 */
export const MESH_MAX = 250000;
/** (A mesh as text is some 250 bytes a triangle; a STEP or 3MF file that large is far more than the engine reads.) */
const FILE_MAX: Record<string, number> = { stl: 100, obj: 100, step: 40, stp: 40, "3mf": 40, brep: 40, brp: 40, fcstd: 60, glb: 100, gltf: 100, ifc: 60 };

/** How many triangles an STL has: said in a binary one, counted in a text one. */
export function stlTriangleCount(bytes: Uint8Array): number {
  if (bytes.length >= 84) {
    const n = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true);
    if (84 + n * 50 === bytes.length) return n;
  }
  // Text: one "endfacet" a triangle (e, n, d, f, a, c, e, t).
  const want = [101, 110, 100, 102, 97, 99, 101, 116];
  let count = 0;
  for (let i = 0, n = bytes.length - 8; i <= n; i++) {
    if ((bytes[i] | 32) !== 101 || (bytes[i + 3] | 32) !== 102) continue;
    let k = 1;
    while (k < 8 && (bytes[i + k] | 32) === want[k]) k++;
    if (k === 8) (count++, (i += 7));
  }
  return count;
}

const many = (n: number) => n.toLocaleString("en-US");

/** Why a mesh / STEP file can't be what it says (null: it looks right). */
function unreadable(bytes: Uint8Array, format: "step" | "stl"): string | null {
  if (format === "step") {
    const head = new TextDecoder().decode(bytes.subarray(0, 4096));
    if (!/ISO-10303-21/.test(head)) return "it isn't a STEP file";
    if (!new TextDecoder().decode(bytes).includes("DATA;")) return "the file is damaged (it has no shapes in it)";
    return null;
  }
  // Binary STL: 80 bytes, a triangle count, 50 bytes per triangle.
  if (bytes.length >= 84) {
    const n = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true);
    if (n > 0 && 84 + n * 50 === bytes.length) return null;
  }
  const text = new TextDecoder().decode(bytes);
  if (/\bfacet\b/i.test(text) && /\bvertex\b/i.test(text)) return null;
  return bytes.length ? "it isn't an STL file, or it is damaged" : "the file is empty";
}

/**
 * A mesh has come in (or was asked to be given faces): once it is built, how many of its round parts are true
 * round faces now, said once. (Looked for a few times a second until the body is there - it can take a while.)
 */
export function sayRounds(app: AppContext, id: string, name: string, before = -1): void {
  const began = Date.now();
  const look = () => {
    if (!app.store.doc.features.some((f) => f.id === id)) return;
    const body = app.view.body(id);
    const count = body ? body.faces.filter((f) => f.round).length : -1;
    // (Asked of a mesh already in the project: until its faces have changed.)
    if (body && (before < 0 || body.faces.length !== before)) {
      if (count > 0) app.ui.toast(`${name}: ${count} round ${count === 1 ? "part is a true round face" : "parts are true round faces"} now (holes, bosses, rounded corners).`);
      return;
    }
    if (Date.now() - began < 180_000) setTimeout(look, 400);
  };
  setTimeout(look, 400);
}

export async function insertFile(app: AppContext): Promise<void> {
  const file = await pickFile(".step,.stp,.stl,.obj,.3mf,.glb,.gltf,.brep,.brp,.fcstd,.ifc,.dxf,.svg,.dwg,.super,.tessel");
  if (!file) return;
  const ext = file.name.split(".").pop()!.toLowerCase();
  try {
    // (Before it is read: a file this big would not fit in the page with the project.)
    const most = FILE_MAX[ext];
    if (most && file.size > most * 1048576) return app.ui.toast(`Could not insert ${file.name}: it is ${Math.round(file.size / 1048576)} MB, more than can be brought in (up to ${most} MB for this kind of file)`, "error");
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
      // (Not a mesh in it far over what can be brought in: see MESH_MAX.)
      const theirs = parseProject(await file.text());
      const parts = theirs.features;
      const big = parts.filter((f) => f.type === "import" && f.format === "stl" && (f.data.length * 0.75) / 50 > MESH_MAX * 1.5);
      if (big.length) app.ui.toast(`Left out of ${file.name}: ${big.map((f) => (f.type === "import" && f.fileName) || f.name).join(", ")} has more triangles than can be brought in (up to ${many(MESH_MAX)})`, "error");
      insertProject(app, { ...theirs, features: parts.filter((f) => !big.includes(f)) }, file.name);
      return;
    }
    // A shape in the geometry kernel's own form, and a FreeCAD document's shapes (kept in it in that form): the
    // exact solids, each a body. (The readers of these, of glTF and of IFC are fetched when such a file is picked.)
    if (ext === "brep" || ext === "brp") {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!/CASCADE Topology/.test(new TextDecoder().decode(bytes.subarray(0, 400)))) return app.ui.toast(`Could not insert ${file.name}: it isn't a BRep file`, "error");
      app.store.add({ ...app.store.newIdentity("import"), type: "import" as const, format: "brep" as const, fileName: file.name, data: toBase64(bytes), apart: true });
      return;
    }
    if (ext === "fcstd") {
      app.ui.setStatus(`Reading ${file.name}…`);
      const { readFcstd } = await import("./moreFormats");
      const shapes = await readFcstd(new Uint8Array(await file.arrayBuffer()));
      app.ui.setStatus(null);
      const title = file.name.replace(/\.fcstd$/i, "");
      const steps = shapes.map((s) => ({ ...app.store.newIdentity("import"), name: s.name, type: "import" as const, format: "brep" as const, fileName: `${s.name} (${file.name})`, data: toBase64(s.brep), apart: true }));
      // One object: a step. Several: together, as one group in History and one folder in Items, named after the file.
      const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      app.store.commit((d) => {
        d.features.push(...steps);
        for (const s of steps) d.names = { ...d.names, [s.id]: s.name };
        if (steps.length < 2) return;
        const ids = steps.map((s) => s.id);
        d.historyGroups = [...(d.historyGroups ?? []), { id: `hgroup-${stamp}`, name: title, steps: ids }];
        d.folders = [...(d.folders ?? []), { id: `folder-${stamp}`, name: title, items: [...ids], fresh: ids }];
      });
      app.ui.toast(`Inserted ${steps.length} ${steps.length === 1 ? "shape" : "shapes"} from ${file.name}: the exact solids, as FreeCAD last built them (without their history)`);
      return;
    }
    // (Any file can be picked on an iPad: see acceptFor.)
    if (!["step", "stp", "stl", "obj", "3mf", "glb", "gltf", "ifc"].includes(ext))
      return app.ui.toast(`Could not insert ${file.name}: it is not a kind of file the app reads (STEP, STL, OBJ, 3MF, glTF, BRep, FreeCAD, IFC, DXF, SVG or a project)`, "error");
    let bytes: Uint8Array = new Uint8Array(await file.arrayBuffer());
    let format: "step" | "stl" = ext === "stl" ? "stl" : "step";
    if (ext === "obj") {
      bytes = objToStl(new TextDecoder().decode(bytes));
      format = "stl";
    }
    // glTF and IFC: their meshes, as one mesh in millimetres.
    if (ext === "glb" || ext === "gltf" || ext === "ifc") {
      app.ui.setStatus(`Reading ${file.name}…`);
      const more = await import("./moreFormats");
      const tris = ext === "ifc" ? await (await import("./ifc")).ifcTriangles(bytes, MESH_MAX) : more.gltfTriangles(bytes);
      app.ui.setStatus(null);
      if (tris.length > MESH_MAX)
        return app.ui.toast(`Could not insert ${file.name}: it has ${many(tris.length)} triangles, more than can be brought in (up to ${many(MESH_MAX)}).`, "error");
      bytes = more.stlOfTriangles(tris);
      format = "stl";
    }
    // 3MF: the exact model packed in it (ours), else its meshes.
    if (ext === "3mf") ({ format, bytes } = await read3mf(bytes));
    // A damaged or wrong file stops here, not as a failed step in History
    // (that kept the broken file in the project).
    const why = unreadable(bytes, format);
    if (why) return app.ui.toast(`Could not insert ${file.name}: ${why}`, "error");
    // A mesh too big stops here too, before it is in the project.
    const triangles = format === "stl" ? stlTriangleCount(bytes) : 0;
    if (triangles > MESH_MAX)
      return app.ui.toast(`Could not insert ${file.name}: it has ${many(triangles)} triangles, more than can be brought in (up to ${many(MESH_MAX)}). Thin it out in a mesh program first.`, "error");
    app.ui.setStatus(`Importing ${file.name}…`);
    // (A mesh: its flat faces made whole and its round parts round - see kernel/meshRound.ts.)
    const step = { ...app.store.newIdentity("import"), type: "import" as const, format, fileName: file.name, data: toBase64(bytes), apart: true, ...(format === "stl" ? { round: true } : {}) };
    app.store.add(step);
    if (format === "stl") sayRounds(app, step.id, file.name);
    app.ui.setStatus(null);
  } catch (err) {
    app.ui.setStatus(null);
    app.ui.toast(`Could not insert ${file.name}: ${(err as Error).message}`, "error");
  }
}

/**
 * Another project's steps, after this one's (under new ids): one group in History and one folder in Items, both
 * named after the file - see doc/insertProject.ts.
 */
function insertProject(app: AppContext, theirs: ProjectDoc, name: string): void {
  if (!theirs.features.length) return app.ui.toast(`${name} has no steps to insert`);
  let done: Inserted | null = null;
  app.store.commit((d) => (done = insertProjectInto(d, theirs, name, newId)));
  const made = done as Inserted | null;
  if (!made) return;
  const title = name.replace(/\.(super|tessel)$/i, "");
  app.ui.toast(
    `Inserted ${made.steps.length} step${made.steps.length === 1 ? "" : "s"} from ${name}: one group in History and one folder in Items, both named ${title}` +
      (made.clashes.length ? `. This project's own value is used for ${made.clashes.join(", ")}` : ""),
  );
}

export async function insertImage(app: AppContext, plane: PlaneDef = GROUND): Promise<ImageFeature | null> {
  const file = await pickFile("image/*");
  if (!file) return null;
  let src = await new Promise<string>((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.readAsDataURL(file);
  });
  const img = new Image();
  img.src = src;
  try {
    await img.decode();
  } catch {
    app.ui.toast(`${file.name} can't be shown here - save it as JPG or PNG first (an iPhone's HEIC photos too)`, "error");
    return null;
  }
  // A phone photo (4000 px, 12 MB) kept whole went into the project and was
  // saved again on every change, and wider than a phone can draw (4096 px):
  // 2048 px across is plenty to trace over.
  const MAX = 2048;
  const k = Math.min(1, MAX / Math.max(img.width, img.height));
  if (k < 1 || file.size > 2e6) {
    const c = document.createElement("canvas");
    c.width = Math.round(img.width * k);
    c.height = Math.round(img.height * k);
    c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
    // PNG keeps see-through parts (a logo); a photo is smaller as JPEG.
    src = file.type === "image/png" ? c.toDataURL("image/png") : c.toDataURL("image/jpeg", 0.85);
  }
  const width = 100;
  const f: ImageFeature = { ...app.store.newIdentity("image"), type: "image", plane, src, width, height: (width * img.height) / img.width, opacity: 0.8 };
  app.store.add(f);
  app.ui.toast("Image placed on the floor, 100 mm wide: stand it up, place and size it here");
  return f;
}

/**
 * Create a named variable (optionally from a field's current value); returns
 * its name. "Add Another" at the top makes it and opens a fresh one (a window
 * needs twenty: the dialog had to be reopened from the card each time) - the
 * name returned is still the first one's, the one made from the field's value.
 */
export async function createVariable(app: AppContext, value = ""): Promise<string | null> {
  let first: string | null = null;
  let name = "";
  for (;;) {
    const r = await createOne(app, name, value);
    first ??= r.made;
    // A bad name or value: the next window has what was typed, to put right (after OK too: the window closed, and
    // what was typed was gone).
    const again = !r.made && !!(r.typed.name.trim() || r.typed.expr.trim());
    if (!r.another && !again) return first;
    [name, value] = r.made ? ["", ""] : [r.typed.name, r.typed.expr];
  }
}

async function createOne(app: AppContext, name: string, value: string): Promise<{ made: string | null; another: boolean; typed: { name: string; expr: string } }> {
  const list = app.store.doc.variables;
  const note = list.length ? `Existing: ${list.map((v) => `${v.name} = ${v.expr}`).join(", ")}` : "Use variables in any field, e.g. width*2 or wall + 1mm.";
  const v = await app.ui.dialog("Create Variable", [
    { key: "name", label: "Name", value: name, placeholder: "width" },
    { key: "expr", label: "Value", value, placeholder: "40 or 1.5in or depth/2" },
  ], note, { label: "Add Another", icon: "variableNew" });
  if (!v) return { made: null, another: false, typed: { name: "", expr: "" } };
  return { made: makeVariable(app, list, v), another: !!v[DIALOG_ACTION], typed: { name: v.name, expr: v.expr } };
}

function makeVariable(app: AppContext, list: AppContext["store"]["doc"]["variables"], v: Record<string, string>): string | null {
  const name = v.name.trim();
  // (A variable called sin or pi hid the function: sin(30) stopped working.)
  if (!/^[a-z_][a-z0-9_]*$/i.test(name) || RESERVED.test(name)) {
    app.ui.toast("Names use letters, digits and _ (not starting with a digit, and not a unit or a function like sin or pi)", "error");
    return null;
  }
  // (od and Od would be two variables, and one typed for the other is a wrong size with nothing said.)
  const twin = list.find((x) => x.name !== name && x.name.toLowerCase() === name.toLowerCase());
  if (twin) {
    app.ui.toast(`There is a variable ${twin.name} already: ${name} differs only in its capitals`, "error");
    return null;
  }
  const was = list.find((x) => x.name === name);
  const next = [...list.filter((x) => x.name !== name), { name, expr: v.expr.trim() || "0" }];
  setVariables(next);
  // (An angle - "30 deg" - is a value too: it was refused here, and taken in the list of them all.)
  if (evaluate(v.expr || "0") === null && evaluate(v.expr || "0", "angle") === null) {
    setVariables(list);
    const unknown = namesIn(v.expr).filter((x) => x !== name && !next.some((y) => y.name === x) && !RESERVED.test(x));
    app.ui.toast(
      new RegExp(`(^|[^A-Za-z0-9_])${name}($|[^A-Za-z0-9_])`).test(v.expr)
        ? `${name} can't use itself`
        : unknown.length
          ? `${unknown.join(", ")}: no variable has that name`
          : `"${v.expr}" isn't a valid value`,
      "error",
    );
    return null;
  }
  app.store.commit((d) => (d.variables = next));
  // (One there already by that name is changed, and said so.)
  app.ui.toast(was && was.expr !== v.expr.trim() ? `${name} changed: ${was.expr} → ${v.expr.trim()}` : `${name} = ${v.expr}`);
  return name;
}

/**
 * The Variables window: every variable at once (changing one rebuilds everything
 * that uses it), and New Variable at its top. Making one keeps what was typed,
 * then comes back here with the new one in the list.
 */
export async function editVariables(app: AppContext): Promise<void> {
  for (;;) {
    const list = app.store.doc.variables;
    const v = await app.ui.dialog(
      "Variables",
      list.map((x) => ({ key: x.name, label: x.name, value: bareExpr(x.expr) })),
      list.length
        ? "Change a value to update every feature that uses it. Clear a value to delete the variable."
        : "No variables yet. Make one, then use it in any field, e.g. width*2 or wall + 1mm.",
      { label: "New Variable", icon: "variableNew" },
    );
    if (!v) return;
    if (list.length) {
      // Shown without the unit in use ("220"): a plain number keeps the unit it had.
      const next = list.filter((x) => v[x.name]?.trim()).map((x) => ({ name: x.name, expr: withUnitOf(v[x.name], x.expr) }));
      setVariables(next);
      // (An angle - "30 deg" - is a value too: it was refused as a length.)
      const bad = next.find((x) => evaluate(x.expr) === null && evaluate(x.expr, "angle") === null);
      if (bad) {
        setVariables(list);
        // (Said as it is: another variable still uses the one being deleted.)
        const lost = list.filter((x) => !next.some((y) => y.name === x.name)).find((x) => new RegExp(`(^|[^A-Za-z0-9_])${x.name}($|[^A-Za-z0-9_])`).test(bad.expr));
        return app.ui.toast(lost ? `${bad.name} uses ${lost.name} (${bad.name} = ${bad.expr}): change ${bad.name} first` : `"${bad.expr}" isn't a valid value for ${bad.name}`, "error");
      }
      // Deleted while steps still use it: they keep the sizes they have now, as
      // plain numbers (else every rebuild said "can't be evaluated").
      const gone = list.filter((x) => !next.some((y) => y.name === x.name)).map((x) => x.name);
      // (Capitals count: W deleted is not w deleted.)
      const uses = (expr: string) => gone.some((n) => new RegExp(`(^|[^A-Za-z0-9_])${n}($|[^A-Za-z0-9_])`).test(expr));
      let kept = 0;
      if (next.some((x, i) => x.name !== list[i]?.name || x.expr !== list[i]?.expr) || next.length !== list.length)
        app.store.commit((d) => {
          d.variables = next;
          for (const f of d.features) {
            for (const [path, expr] of Object.entries(f.exprs ?? {})) if (uses(expr)) (delete f.exprs![path], kept++);
            // (A sketch pattern that followed it: its copies stay as they are, plain curves from now on.)
            if (f.type === "sketch" && f.repeats?.some((r) => uses(r.countExpr))) {
              kept += f.repeats.filter((r) => uses(r.countExpr)).length;
              f.repeats = f.repeats.filter((r) => !uses(r.countExpr));
              if (!f.repeats.length) delete f.repeats;
            }
            if (f.type === "sketch")
              for (const c of f.constraints ?? []) {
                if (c.expr && uses(c.expr)) (delete c.expr, kept++);
                // (A point placed by it too: left, every rebuild said it can't be evaluated.)
                if (c.atExpr?.some((e) => e && uses(e))) {
                  c.atExpr = c.atExpr.map((e) => (e && uses(e) ? null : e));
                  if (!c.atExpr.some((e) => e)) delete c.atExpr;
                  kept++;
                }
              }
          }
        });
      if (kept) app.ui.toast(`${gone.join(", ")} deleted - the ${kept === 1 ? "size" : `${kept} sizes`} that used ${gone.length > 1 ? "them" : "it"} ${kept === 1 ? "keeps its value" : "keep their values"}`);
    }
    if (!v[DIALOG_ACTION]) return;
    await createVariable(app);
  }
}

/**
 * Rename Variables: each variable's name in a box, to change. Everything that uses a renamed variable - other
 * variables, steps' sizes, sketch dimensions - says its new name; nothing changes size. (A variable could only be
 * deleted and made again under another name, and what used it lost its link to it.)
 */
export async function renameVariables(app: AppContext): Promise<void> {
  const list = app.store.doc.variables;
  if (!list.length) return;
  const v = await app.ui.dialog(
    "Rename Variables",
    list.map((x) => ({ key: x.name, label: `${x.name} =  ${bareExpr(x.expr)}`, value: x.name })),
    "Type a new name over an old one. Everything that uses it follows, and nothing changes size.",
  );
  if (!v) return;
  const wanted = list.map((x) => ({ from: x.name, to: (v[x.name] ?? x.name).trim() || x.name })).filter((x) => x.from !== x.to);
  if (!wanted.length) return;
  // Tried on a copy first: all of them, or none (two swapping names go by way of a spare one).
  const trial = structuredClone(app.store.doc);
  const spare = (i: number) => `__renaming_${i}__`;
  wanted.forEach((w, i) => renameVariable(trial, w.from, spare(i)));
  for (const [i, w] of wanted.entries()) {
    const problem = nameProblem(trial, spare(i), w.to);
    if (problem) return app.ui.toast(`${w.from} → ${w.to}: ${problem}`, "error");
    renameVariable(trial, spare(i), w.to);
  }
  app.store.commit((d) => {
    d.variables = trial.variables;
    d.features = trial.features;
  });
  app.ui.toast(wanted.length === 1 ? `${wanted[0].from} is ${wanted[0].to} now, everywhere it is used` : `${wanted.length} variables renamed, everywhere they are used`);
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
  // Only curves that make sense: real numbers, some size (a damaged file
  // mustn't put NaN or a dot into the sketch).
  return out.filter(usableCurve);
}

function usableCurve(e: SketchEntity): boolean {
  let finite = true;
  JSON.stringify(e, (_k, v) => {
    if (typeof v === "number" && !Number.isFinite(v)) finite = false;
    return v;
  });
  if (!finite) return false;
  switch (e.kind) {
    case "line":
      return Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]) > 1e-9;
    case "circle":
      return e.radius > 1e-9;
    case "arc":
      return Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]) > 1e-9 || Math.hypot(e.m[0] - e.a[0], e.m[1] - e.a[1]) > 1e-9;
    case "ellipse":
      return e.rx > 1e-9 && e.ry > 1e-9;
    case "spline":
    case "polyline":
      return e.points.length >= 2;
    default:
      return true;
  }
}

// -------------------------------------------------------------------- OBJ

/** OBJ (triangles/polygons) → binary STL, so the kernel can import it. */
export function objToStl(text: string): Uint8Array {
  const v: number[][] = [];
  const tris: number[][] = [];
  let skipped = 0;
  for (const line of text.split(/\r?\n/)) {
    const p = line.trim().split(/\s+/);
    if (p[0] === "v") v.push([Number(p[1]), Number(p[2]), Number(p[3])]);
    else if (p[0] === "f") {
      // Points by number (from 1), or counted back from the last one (-1).
      const idx = p.slice(1).map((s) => {
        const n = parseInt(s.split("/")[0], 10);
        return n < 0 ? v.length + n : n - 1;
      });
      // A face pointing at points that aren't there (or with broken numbers): skipped.
      const ok = (k: number) => Number.isInteger(k) && k >= 0 && k < v.length && v[k].every(Number.isFinite);
      if (idx.length < 3 || !idx.every(ok)) {
        skipped++;
        continue;
      }
      for (let k = 1; k + 1 < idx.length; k++) tris.push([idx[0], idx[k], idx[k + 1]]);
    }
  }
  if (!tris.length) throw new Error(skipped ? "The OBJ file's faces use points that are missing or broken (a damaged file?)" : "No faces in the OBJ file");
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
