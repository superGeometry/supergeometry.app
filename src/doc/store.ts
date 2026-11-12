import { entityPolylines } from "../sketch/curves";
import { arrangement, regionRef } from "../sketch/regions";
import { pointInPoly } from "../sketch/curves";
import { resolveDoc } from "./params";
import { emptyDoc, type Feature, type FeatureType, type ProjectDoc, type SketchEntity } from "./types";

/** While set, commits made under the same key join into one undo step. */
let mergeKey: object | null = null;

/**
 * Run `fn` with its commits merged with the ones made before under the same
 * key (and nothing else in between): a value typed key by key into one box -
 * 3, 30, 30.5 - is one undo step, not three.
 */
export function mergingCommits(key: object, fn: () => void): void {
  const was = mergeKey;
  mergeKey = key;
  try {
    fn();
  } finally {
    mergeKey = was;
  }
}

// Earlier builds were called "Tessel": their autosave is still picked up.
const LEGACY_KEY = "tessel.autosave.v1";
const DB_NAME = "supergeometry";
const OLD_DB_NAME = "tessel";
const MAX_UNDO = 200;

type Listener = () => void;

const LABELS: Record<FeatureType, string> = {
  sketch: "Sketch",
  extrude: "Extrude",
  fillet: "Fillet",
  chamfer: "Chamfer",
  boolean: "Boolean",
  delete: "Delete",
  revolve: "Revolve",
  sweep: "Sweep",
  loft: "Loft",
  shell: "Shell",
  transform: "Transform",
  split: "Split",
  plane: "Plane",
  axis: "Axis",
  import: "Import",
  image: "Image",
  deleteGeom: "Delete",
  moveFace: "Move Face",
  freeform: "Freeform",
  scaleFace: "Scale Face",
  replaceFace: "Replace Face",
  repair: "Repair",
  fillToPlane: "Fill to Plane",
  fill: "Fill",
  connect: "Connect",
  faceFreeform: "Freeform Face",
  thread: "Thread",
  imprint: "Project as Edge",
  wrap: "Wrap & Emboss",
};

/** Steps still being tried out: shown with a BETA tag wherever they appear. */
export const BETA_TYPES: ReadonlySet<string> = new Set(["connect", "faceFreeform", "imprint", "wrap"]);

/**
 * Holds the document and its undo/redo history. Every change goes through
 * `commit`, which snapshots the previous state, so undo is exact.
 */
/**
 * Undo snapshots are whole documents as text. Big values in them (an imported
 * model, an image - megabytes of base64) are kept once, and each snapshot
 * holds only a short reference: otherwise 200 undo steps would hold 200 copies.
 */
const BIG = 50_000;
const bigById = new Map<string, string>();
const idOfBig = new Map<string, string>();
const REF = "\u0000sg-big:";

function pack(doc: ProjectDoc): string {
  return JSON.stringify(doc, (_k, v) => {
    if (typeof v !== "string" || v.length < BIG) return v;
    let id = idOfBig.get(v);
    if (!id) {
      id = `${REF}${idOfBig.size}`;
      idOfBig.set(v, id);
      bigById.set(id, v);
    }
    return id;
  });
}

function unpack(text: string): ProjectDoc {
  return JSON.parse(text, (_k, v) => (typeof v === "string" && v.startsWith(REF) ? (bigById.get(v) ?? v) : v));
}

export class DocStore {
  doc: ProjectDoc = emptyDoc();
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private listeners = new Set<Listener>();
  private saveTimer = 0;

  /** Restore the autosaved project (IndexedDB, or the old localStorage slot). */
  async load(): Promise<void> {
    const saved = (await idbGet("autosave")) ?? (await idbGet("autosave", OLD_DB_NAME)) ?? legacyAutosave();
    if (saved) {
      try {
        this.doc = migrate(JSON.parse(saved));
        await this.loadHistory(saved);
      } catch {
        // A broken autosave must never block the app.
      }
    }
    this.loaded = true;
    this.listeners.forEach((fn) => fn());
  }
  /** Until the saved project is read, saving would overwrite it with an empty one. */
  private loaded = false;

  /**
   * Undo survives a reload (a phone drops the page whenever it likes): the
   * stacks are saved beside the project, and taken back only if they end at
   * exactly the project that was loaded.
   */
  private async loadHistory(saved: string): Promise<void> {
    const text = await idbGet("undo");
    if (!text) return;
    const h = JSON.parse(text) as SavedHistory;
    if (h.head !== hashText(saved) || !Array.isArray(h.undo) || !Array.isArray(h.redo)) return;
    for (const [id, v] of h.big ?? []) {
      bigById.set(id, v);
      idOfBig.set(v, id);
    }
    this.undoStack = h.undo;
    this.redoStack = h.redo;
  }

  private historyTimer = 0;
  private saveHistory(docText: string): Promise<void> {
    clearTimeout(this.historyTimer);
    // The newest steps first, up to a few MB (200 snapshots of a big model would be hundreds).
    const keep = (stack: string[]) => {
      const out: string[] = [];
      let left = HISTORY_BYTES / 2;
      for (let i = stack.length - 1; i >= 0 && left - stack[i].length >= 0; i--) {
        left -= stack[i].length;
        out.unshift(stack[i]);
      }
      return out;
    };
    const undo = keep(this.undoStack), redo = keep(this.redoStack);
    const refs = new Set<string>();
    for (const t of [...undo, ...redo]) for (const m of t.matchAll(/\\u0000sg-big:(\d+)/g)) refs.add(REF + m[1]);
    const big = [...refs].filter((id) => bigById.has(id)).map((id) => [id, bigById.get(id)!] as [string, string]);
    const h: SavedHistory = { head: hashText(docText), undo, redo, big };
    return idbSet("undo", JSON.stringify(h));
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get features(): readonly Feature[] {
    return this.doc.features;
  }

  find<T extends Feature = Feature>(id: string): T | undefined {
    return this.doc.features.find((f) => f.id === id) as T | undefined;
  }

  /** Unique id + "Extrude 03"-style name for a new feature. */
  newIdentity(type: FeatureType, label = LABELS[type]): { id: string; name: string } {
    // One past the highest number in use (a step deleted from the middle doesn't free its number for a duplicate).
    const nums = this.doc.features.map((f) => (f.name.startsWith(label + " ") ? Number(f.name.slice(label.length + 1)) : NaN)).filter((x) => Number.isFinite(x));
    const n = Math.max(0, this.doc.features.filter((f) => f.name.startsWith(label + " ")).length, ...nums) + 1;
    return { id: newId(type), name: `${label} ${String(n).padStart(2, "0")}` };
  }

  /** Expressions that couldn't be evaluated / sketches that can't be solved. */
  problems: string[] = [];
  private transientBase: string | null = null;

  /** Apply a mutation as one undoable step. */
  commit(mutate: (doc: ProjectDoc) => void): void {
    const before = this.transientBase ?? pack(this.doc);
    const next = unpack(pack(this.doc));
    mutate(next);
    // With a breakpoint: what's after it stays last, so a new step goes in at the breakpoint.
    if (next.features.some((f) => f.rolledBack)) next.features = [...next.features.filter((f) => !f.rolledBack), ...next.features.filter((f) => f.rolledBack)];
    this.problems = resolveDoc(next);
    const wasLive = this.transientBase !== null;
    this.transientBase = null;
    if (pack(next) === before) {
      // No change overall - but after a drag that came back to where it began,
      // the document must still end up there (not at the drag's last frame).
      if (wasLive) {
        this.doc = next;
        this.listeners.forEach((fn) => fn());
      }
      return;
    }
    // The same box typed into again: still the step it began (its first undo state stays).
    const joins = mergeKey !== null && mergeKey === this.lastMerge && this.undoStack.length > 0;
    if (!joins) this.undoStack.push(before);
    this.lastMerge = mergeKey;
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    this.redoStack = [];
    this.doc = next;
    this.changed();
  }

  /** The merge key of the last commit (see mergingCommits). */
  private lastMerge: object | null = null;

  /**
   * Live edits during a drag: update the document and notify, but leave undo
   * alone; the next `commit` records everything since the drag began as one step.
   */
  transient(mutate: (doc: ProjectDoc) => void): void {
    this.transientBase ??= pack(this.doc);
    const next = unpack(pack(this.doc));
    mutate(next);
    this.doc = next;
    this.listeners.forEach((fn) => fn());
  }

  /**
   * What the engine worked out for the project as it is (a sketch's curves
   * where the edges they follow are now): taken in as it stands - not a step
   * to undo, and nothing for the engine to do again.
   */
  adopt(mutate: (doc: ProjectDoc) => void): void {
    const next = unpack(pack(this.doc));
    mutate(next);
    this.doc = next;
    this.changed(false);
  }

  add(feature: Feature): void {
    this.commit((d) => d.features.push(feature));
  }

  update(id: string, patch: Partial<Feature>): void {
    this.commit((d) => {
      const i = d.features.findIndex((f) => f.id === id);
      if (i >= 0) d.features[i] = { ...d.features[i], ...patch } as Feature;
    });
  }

  remove(id: string): void {
    this.commit((d) => {
      const gone = d.features.find((f) => f.id === id);
      d.features = d.features.filter((f) => f.id !== id);
      // Its sketches, now used by nothing, come back into view to be used again
      // (they were hidden once used: deleting a cut left its sketch invisible).
      const used = (f: Feature) => sketchesOf(f);
      const still = new Set(d.features.flatMap(used));
      const free = gone ? used(gone).filter((s) => !still.has(s)) : [];
      if (free.length) d.hidden = d.hidden.filter((h) => !free.includes(h));
    });
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.lastMerge = null;
    this.redoStack.push(pack(this.doc));
    this.doc = unpack(prev);
    this.changed();
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.lastMerge = null;
    this.undoStack.push(pack(this.doc));
    this.doc = unpack(next);
    this.changed();
  }

  /**
   * Switch to another project (from the library, a file, or a new one): its
   * own document, with no undo history - undo never reaches into another project.
   */
  openDoc(doc: ProjectDoc): void {
    this.doc = migrate(structuredClone(doc));
    this.problems = resolveDoc(this.doc);
    this.transientBase = null;
    this.undoStack = [];
    this.redoStack = [];
    this.lastMerge = null;
    this.changed();
  }

  /** Called with the project's text each time it is autosaved (the library keeps its copy). */
  onSaved: ((text: string) => void) | null = null;

  /** Replace the whole document (open file / new project). Undoable. */
  replace(doc: ProjectDoc): void {
    this.commit((d) => {
      // Drop every key first: anything the new document doesn't have (folders,
      // colours, custom names…) must not linger from the old one.
      for (const k of Object.keys(d)) delete (d as unknown as Record<string, unknown>)[k];
      Object.assign(d, structuredClone(doc));
    });
  }

  /** Save the project now (before the page reloads). */
  async flush(): Promise<void> {
    if (!this.loaded) return;
    clearTimeout(this.saveTimer);
    const v = this.edits;
    const text = JSON.stringify(this.doc);
    await idbSet("autosave", text);
    this.wrote(v);
    this.onSaved?.(text);
    await this.saveHistory(text);
  }

  /** Every change made is written to this device (false from a change until its save is done). */
  saved = true;
  private edits = 0;
  private savedListeners = new Set<Listener>();
  onSavedState(fn: Listener): void {
    this.savedListeners.add(fn);
  }
  private setSaved(on: boolean): void {
    if (this.saved === on) return;
    this.saved = on;
    this.savedListeners.forEach((fn) => fn());
  }
  /** A save of the state after change `v` is written: saved, unless more came since. */
  private wrote(v: number): void {
    if (v === this.edits) this.setSaved(true);
  }

  private changed(tell = true): void {
    this.edits++;
    this.setSaved(false);
    if (tell) this.listeners.forEach((fn) => fn());
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      const v = this.edits;
      const text = JSON.stringify(this.doc);
      void idbSet("autosave", text).then(() => this.wrote(v));
      this.onSaved?.(text);
      // The undo steps less eagerly: they're bigger, and only matter after a reload.
      clearTimeout(this.historyTimer);
      this.historyTimer = window.setTimeout(() => void this.saveHistory(text), 1200);
    }, 400);
  }
}

/** Undo history as saved: the stacks, the big values they refer to, and the project they lead up to. */
interface SavedHistory {
  head: string;
  undo: string[];
  redo: string[];
  big: [string, string][];
}
const HISTORY_BYTES = 8_000_000;

/** A short fingerprint of a saved project (FNV-1a, plus the length). */
function hashText(t: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 0x01000193);
  return `${t.length}:${(h >>> 0).toString(36)}`;
}

/** The sketches a step makes something from (its profiles). */
function sketchesOf(f: Feature): string[] {
  const srcs = f.type === "extrude" || f.type === "revolve" || f.type === "sweep" ? [f.source] : f.type === "loft" ? f.sections : [];
  return srcs.flatMap((s) => (s.kind === "profile" ? [s.sketch] : []));
}

export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function parseProject(text: string): ProjectDoc {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // (Not the parser's "Expected ',' or '}' at position 47".)
    throw new Error("The file is damaged - cut short, or not a project file");
  }
  return migrate(raw);
}

// ------------------------------------------------------------------ migration

/** Bring any saved project up to the current format. */
export function migrate(raw: unknown): ProjectDoc {
  const doc = raw as ProjectDoc & { version: number };
  // "tessel" is the format name of files saved before the rename.
  if (!doc || (doc.format !== "super" && (doc.format as string) !== "tessel") || !Array.isArray(doc.features)) throw new Error("Not a supergeometry.app project file");
  if (doc.version === 2) return { ...emptyDoc(), ...doc, format: "super" };
  // A newer app saved it: read as an old one, it would come out mangled.
  if (doc.version > 2) throw new Error("This project was saved by a newer version of the app - reload the page to update");

  // v1: rect {a, b}; extrude profiles referenced entity ids.
  const sketches = new Map<string, SketchEntity[]>();
  for (const f of doc.features as unknown as Array<Record<string, any>>) {
    if (f.type === "sketch") {
      f.entities = f.entities.map((e: any) => {
        if (e.kind === "rect" && e.a) {
          return { id: e.id, kind: "rect", center: [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2], w: Math.abs(e.b[0] - e.a[0]), h: Math.abs(e.b[1] - e.a[1]), rotation: 0 };
        }
        return e;
      });
      sketches.set(f.id, f.entities);
    }
    if (f.type === "extrude" && f.source?.kind === "profile" && f.source.entities) {
      const entities = sketches.get(f.source.sketch) ?? [];
      f.source = { kind: "profile", sketch: f.source.sketch, regions: regionsForEntities(entities, f.source.entities) };
    }
  }
  return { ...emptyDoc(), ...doc, format: "super", version: 2 } as ProjectDoc;
}

/** v1 profiles were "entity minus what's inside it": pick the regions that matches. */
function regionsForEntities(entities: SketchEntity[], ids: string[]) {
  const arr = arrangement(entities);
  const outline = (e: SketchEntity) => entityPolylines(e).flat();
  const areaOf = (pts: [number, number][]) => {
    let a = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
    return Math.abs(a / 2);
  };
  return arr.regions
    .filter((r) => {
      const owners = entities.filter((e) => pointInPoly(r.centroid, outline(e)));
      if (!owners.length) return false;
      const smallest = owners.reduce((a, b) => (areaOf(outline(a)) < areaOf(outline(b)) ? a : b));
      return ids.includes(smallest.id);
    })
    .map(regionRef);
}

// ---------------------------------------------------------------- IndexedDB

function db(name = DB_NAME): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => req.result.createObjectStore("kv");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function idbGet(key: string, dbName = DB_NAME): Promise<string | null> {
  const d = await db(dbName);
  if (!d) return null;
  return new Promise((resolve) => {
    const req = d.transaction("kv").objectStore("kv").get(key);
    req.onsuccess = () => resolve((req.result as string) ?? null);
    req.onerror = () => resolve(null);
  });
}

export async function idbSet(key: string, value: string): Promise<void> {
  const d = await db();
  if (!d) return;
  await new Promise<void>((resolve) => {
    const t = d.transaction("kv", "readwrite");
    t.objectStore("kv").put(value, key);
    t.oncomplete = t.onerror = t.onabort = () => resolve();
  });
}

export async function idbDel(key: string): Promise<void> {
  const d = await db();
  if (!d) return;
  await new Promise<void>((resolve) => {
    const t = d.transaction("kv", "readwrite");
    t.objectStore("kv").delete(key);
    t.oncomplete = t.onerror = t.onabort = () => resolve();
  });
}

function legacyAutosave(): string | null {
  try {
    return localStorage.getItem(LEGACY_KEY);
  } catch {
    return null;
  }
}
