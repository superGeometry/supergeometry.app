// The projects kept on this device (File → Open shows them). Each one is its
// whole document, saved as it's worked on, with a small picture of it. They
// live in the browser's storage for this site: Reset cache & update leaves
// them alone; clearing the site's data in the browser's settings removes them.

import { idbDel, idbGet, idbSet } from "./store";

export interface LibraryEntry {
  id: string;
  name: string;
  /** When it was last saved (ms). */
  modified: number;
  /** A small JPEG of the view (data URL). */
  thumb?: string;
  /** How big its saved document is (characters). */
  size: number;
}

const INDEX = "library";
const CURRENT = "library-current";
const docKey = (id: string) => `project:${id}`;

export function newProjectId(): string {
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** The projects, newest first. */
export async function libraryEntries(): Promise<LibraryEntry[]> {
  try {
    const list = JSON.parse((await idbGet(INDEX)) ?? "[]") as LibraryEntry[];
    return Array.isArray(list) ? list.sort((a, b) => b.modified - a.modified) : [];
  } catch {
    return [];
  }
}

/** The index is read, changed and written back one change at a time. */
let queue: Promise<unknown> = Promise.resolve();
function editIndex(fn: (list: LibraryEntry[]) => LibraryEntry[]): Promise<void> {
  const run = queue.then(async () => idbSet(INDEX, JSON.stringify(fn(await libraryEntries()))));
  queue = run.catch(() => undefined);
  return run;
}

/** Which project is open (its autosave is its newest state). */
export async function currentProjectId(): Promise<string | null> {
  return idbGet(CURRENT);
}
export function setCurrentProject(id: string): Promise<void> {
  return idbSet(CURRENT, id);
}

/** Keep a project (its document as text; a new picture, or the one it had). */
export async function keepProject(id: string, name: string, text: string, thumb?: string): Promise<void> {
  await idbSet(docKey(id), text);
  await editIndex((list) => {
    const was = list.find((e) => e.id === id);
    const entry: LibraryEntry = { id, name, modified: Date.now(), thumb: thumb ?? was?.thumb, size: text.length };
    return [entry, ...list.filter((e) => e.id !== id)];
  });
  askToKeepStorage();
}

export function projectText(id: string): Promise<string | null> {
  return idbGet(docKey(id));
}

export async function forgetProject(id: string): Promise<void> {
  await editIndex((list) => list.filter((e) => e.id !== id));
  await idbDel(docKey(id));
}

/**
 * Ask the browser to keep this site's storage (it may otherwise clear it when
 * the device runs low, or - Safari - after weeks without a visit). Asked once
 * a visit; browsers decide by themselves (an installed app usually gets it).
 */
let asked = false;
function askToKeepStorage(): void {
  if (asked) return;
  asked = true;
  try {
    void navigator.storage?.persist?.();
  } catch {
    // not offered here
  }
}
