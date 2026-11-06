import { entityPolylines } from "../sketch/curves";
import { arrangement, regionRef } from "../sketch/regions";
import { pointInPoly } from "../sketch/curves";
import { resolveDoc } from "./params";
import { emptyDoc, type Feature, type FeatureType, type ProjectDoc, type SketchEntity } from "./types";

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
  thread: "Thread",
};

/**
 * Holds the document and its undo/redo history. Every change goes through
 * `commit`, which snapshots the previous state, so undo is exact.
 */
/**
 * Undo snapshots are whole documents as text. Big values in them (an imported
 * model, an image — megabytes of base64) are kept once, and each snapshot
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
      } catch {
        // A broken autosave must never block the app.
      }
    }
    this.listeners.forEach((fn) => fn());
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
    this.problems = resolveDoc(next);
    const wasLive = this.transientBase !== null;
    this.transientBase = null;
    if (pack(next) === before) {
      // No change overall — but after a drag that came back to where it began,
      // the document must still end up there (not at the drag's last frame).
      if (wasLive) {
        this.doc = next;
        this.listeners.forEach((fn) => fn());
      }
      return;
    }
    this.undoStack.push(before);
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    this.redoStack = [];
    this.doc = next;
    this.changed();
  }

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
      d.features = d.features.filter((f) => f.id !== id);
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
    this.redoStack.push(pack(this.doc));
    this.doc = unpack(prev);
    this.changed();
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(pack(this.doc));
    this.doc = unpack(next);
    this.changed();
  }

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
    clearTimeout(this.saveTimer);
    await idbSet("autosave", JSON.stringify(this.doc));
  }

  private changed(): void {
    this.listeners.forEach((fn) => fn());
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void idbSet("autosave", JSON.stringify(this.doc)), 400);
  }
}

export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function parseProject(text: string): ProjectDoc {
  return migrate(JSON.parse(text));
}

// ------------------------------------------------------------------ migration

/** Bring any saved project up to the current format. */
export function migrate(raw: unknown): ProjectDoc {
  const doc = raw as ProjectDoc & { version: number };
  // "tessel" is the format name of files saved before the rename.
  if (!doc || (doc.format !== "super" && (doc.format as string) !== "tessel") || !Array.isArray(doc.features)) throw new Error("Not a supergeometry.app project file");
  if (doc.version === 2) return { ...emptyDoc(), ...doc, format: "super" };

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

async function idbGet(key: string, dbName = DB_NAME): Promise<string | null> {
  const d = await db(dbName);
  if (!d) return null;
  return new Promise((resolve) => {
    const req = d.transaction("kv").objectStore("kv").get(key);
    req.onsuccess = () => resolve((req.result as string) ?? null);
    req.onerror = () => resolve(null);
  });
}

async function idbSet(key: string, value: string): Promise<void> {
  const d = await db();
  if (!d) return;
  d.transaction("kv", "readwrite").objectStore("kv").put(value, key);
}

function legacyAutosave(): string | null {
  try {
    return localStorage.getItem(LEGACY_KEY);
  } catch {
    return null;
  }
}
