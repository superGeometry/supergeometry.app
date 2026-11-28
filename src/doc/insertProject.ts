// More → Insert → Project: another project's steps put into this one (pure logic).
//
// The steps go in after this project's own, under new ids, as one History group named after the file; what they
// make - bodies, sketches, planes, images - goes into one Items folder of that name. The other project's own
// folders come along inside it, and so do its names, colours, hidden items and the variables its steps use.

import type { Feature, ItemFolder, ProjectDoc } from "./types";

/** An id's text made safe inside a regular expression. */
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Every id of `map` replaced in `text`, where it stands as an id: whole between quotes, or a part of a longer id
 * (a step's second body is "step:2", a pattern's copy "pattern:body:0", a face "step|curve:0").
 */
function renameIn(text: string, map: Map<string, string>): string {
  if (!map.size) return text;
  // (Longest first: an id that is the start of another must not be taken for it.)
  const ids = [...map.keys()].sort((a, b) => b.length - a.length);
  const re = new RegExp(`(?<=["':|@])(?:${ids.map(esc).join("|")})(?=["':|@])`, "g");
  return text.replace(re, (id) => map.get(id) ?? id);
}

export interface Inserted {
  /** The new steps' ids, in order. */
  steps: string[];
  /** The Items folder they are in. */
  folder: string;
  /** Variables of the other project that this one already has under the same name with another value: this project's value is used. */
  clashes: string[];
}

/**
 * `src`'s steps put into `doc` (changed in place). `name`: the file's name, for the group and the folder.
 * `newId`: a fresh id for a step of the given type.
 */
export function insertProjectInto(doc: ProjectDoc, src: ProjectDoc, name: string, newId: (type: string) => string): Inserted {
  const title = name.replace(/\.(super|tessel)$/i, "") || "Inserted";
  const map = new Map(src.features.map((f) => [f.id, newId(f.type)]));
  const re = <T>(v: T): T => JSON.parse(renameIn(JSON.stringify(v), map)) as T;
  const key = (id: string) => (JSON.parse(renameIn(JSON.stringify(id), map)) as string);
  const steps = re(src.features) as Feature[];
  // (A step's name is its own, even one that reads like an id.)
  steps.forEach((f, i) => (f.name = src.features[i].name));
  doc.features.push(...steps);
  const ids = steps.map((f) => f.id);

  // The variables its steps use: added where this project has none of that name.
  const clashes: string[] = [];
  for (const v of src.variables ?? []) {
    const mine = doc.variables.find((x) => x.name === v.name);
    if (!mine) doc.variables.push({ ...v });
    else if (mine.expr.trim() !== v.expr.trim()) clashes.push(v.name);
  }

  // What was said of its bodies and items: names, colours, see-through, materials, hidden.
  for (const k of ["names", "colors", "opacity", "materials"] as const) {
    const from = src[k] as Record<string, unknown> | undefined;
    if (!from || !Object.keys(from).length) continue;
    const to = ((doc as unknown as Record<string, Record<string, unknown>>)[k] ??= {});
    for (const [id, v] of Object.entries(from)) to[key(id)] = v;
  }
  doc.hidden = [...new Set([...doc.hidden, ...(src.hidden ?? []).map(key)])];

  // History: one group of them all.
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  doc.historyGroups = [...(doc.historyGroups ?? []), { id: `hgroup-${stamp}`, name: title, steps: ids }];

  // Items: one folder, the other project's folders inside it. A step's first body has the step's id, so the steps'
  // ids put those bodies in the folder at once; a step's further bodies (and a pattern's copies) join it when they
  // have been built (`fresh`: see ItemFolder).
  const folder = `folder-${stamp}`;
  const theirs: ItemFolder[] = (src.folders ?? []).map((f, i) => ({ ...f, id: `folder-${stamp}-${i}`, items: f.items.map(key) }));
  const was = new Map((src.folders ?? []).map((f, i) => [f.id, theirs[i].id]));
  for (const [i, f] of (src.folders ?? []).entries()) theirs[i].parent = (f.parent && was.get(f.parent)) || folder;
  const filed = new Set(theirs.flatMap((f) => f.items));
  doc.folders = [...(doc.folders ?? []), { id: folder, name: title, items: ids.filter((id) => !filed.has(id)), fresh: ids }, ...theirs];
  return { steps: ids, folder, clashes };
}

/**
 * Bodies just built that belong in a folder waiting for them (`fresh`: the steps whose bodies it takes): put in,
 * unless a folder has them already. True if anything changed. The folders stop waiting.
 */
export function fileFreshBodies(doc: ProjectDoc, bodies: readonly string[]): boolean {
  const waiting = (doc.folders ?? []).filter((f) => f.fresh?.length);
  if (!waiting.length) return false;
  const filed = new Set((doc.folders ?? []).flatMap((f) => f.items));
  for (const f of waiting) {
    const of = new Set(f.fresh);
    for (const id of bodies) {
      if (filed.has(id) || !of.has(id.split(":")[0])) continue;
      f.items.push(id);
      filed.add(id);
    }
    delete f.fresh;
  }
  return true;
}
