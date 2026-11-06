// Run: npx tsx tests/storestress.test.ts — the project store under abuse: long
// random runs of edits, undo, redo and live drags checked against a record of
// every state; damaged project files; big projects (an imported model inside).
(globalThis as any).window ??= globalThis;
const { DocStore, migrate, parseProject } = await import("../src/doc/store");
import type { Feature } from "../src/doc/types";

let failed = 0;
const check = (name: string, ok: boolean, info = "") => {
  if (!ok) failed++;
  console.log(ok ? "ok  " : "FAIL", name, info);
};
let seed = 3;
const R = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

// ------------------------------------------ undo / redo against a record
{
  const store = new DocStore();
  // What the document must be after each undo (and redo) — kept independently.
  const past: string[] = [];
  const future: string[] = [];
  const now = () => JSON.stringify(store.doc);
  let bad = "";
  for (let i = 0; i < 3000 && !bad; i++) {
    const r = R();
    const before = now();
    if (r < 0.3) {
      const f: Feature = { ...store.newIdentity("extrude"), type: "extrude", source: { kind: "profile", sketch: "s", regions: [] }, distance: Math.round(R() * 50), mode: "new" } as Feature;
      store.add(f);
    } else if (r < 0.45 && store.features.length) {
      const f = store.features[Math.floor(R() * store.features.length)];
      store.update(f.id, { distance: Math.round(R() * 99) } as Partial<Feature>);
    } else if (r < 0.52 && store.features.length) {
      store.remove(store.features[Math.floor(R() * store.features.length)].id);
    } else if (r < 0.6 && store.features.length) {
      // A drag: many live changes, then one commit — one undo step.
      const f = store.features[Math.floor(R() * store.features.length)];
      for (let k = 0; k < 5; k++) store.transient((d) => ((d.features.find((x) => x.id === f.id) as any).distance = k));
      store.update(f.id, { distance: 7 } as Partial<Feature>);
    } else if (r < 0.8) {
      const could = store.canUndo;
      store.undo();
      if (could) {
        const want = past.pop()!;
        if (now() !== want) bad = `undo ${i} didn't restore the state before`;
        future.push(before);
      } else if (now() !== before) bad = `undo with nothing to undo changed the document (${i})`;
      continue;
    } else {
      const could = store.canRedo;
      store.redo();
      if (could) {
        const want = future.pop()!;
        if (now() !== want) bad = `redo ${i} didn't bring the state back`;
        past.push(before);
      } else if (now() !== before) bad = `redo with nothing to redo changed the document (${i})`;
      continue;
    }
    if (now() !== before) {
      past.push(before);
      if (past.length > 200) past.shift();
      future.length = 0;
    }
  }
  check("3000 random edits / undos / redos / drags: every undo and redo exact", !bad, bad);
}

// ------------------------------------- a drag that comes back to its start
{
  const store = new DocStore();
  store.add({ id: "e", name: "Extrude 01", type: "extrude", source: { kind: "profile", sketch: "s", regions: [] }, distance: 10, mode: "new" } as Feature);
  for (const d of [12, 15, 11]) store.transient((doc) => ((doc.features[0] as any).distance = d));
  store.update("e", { distance: 10 } as Partial<Feature>);
  check("drag away and back to the start: the document is where it began (not at the last frame)", (store.features[0] as any).distance === 10, `distance ${(store.features[0] as any).distance}`);
}

// ------------------------------------------------- damaged project files
{
  const good = JSON.stringify({ format: "super", version: 2, name: "x", features: [], variables: [], views: [], units: "mm", hidden: [], pins: [], names: {} });
  const cases: [string, string][] = [
    ["empty", ""],
    ["not JSON", "{{{"],
    ["JSON of something else", '{"hello": 1}'],
    ["cut off half way", good.slice(0, good.length / 2)],
    ["features not a list", good.replace('"features":[]', '"features":5')],
    ["null", "null"],
    ["a number", "42"],
  ];
  for (const [name, text] of cases) {
    let threw = false;
    let msg = "";
    try {
      parseProject(text);
    } catch (e) {
      threw = true;
      msg = (e as Error).message;
    }
    check(`damaged file (${name}) is refused with a message, not a crash`, threw && !!msg && !/undefined|null|cannot read/i.test(msg), msg);
  }
  // Missing fields an old version didn't have: filled in.
  const old = migrate(JSON.parse(JSON.stringify({ format: "super", version: 2, name: "x", features: [] })));
  check("an older file without the newer fields still opens", Array.isArray(old.variables) && Array.isArray(old.hidden));
}

// ----------------------------------------------------------- big projects
{
  const store = new DocStore();
  // An imported 6 MB model inside the project (base64), then 100 edits.
  const data = "A".repeat(6_000_000);
  store.add({ ...store.newIdentity("import"), type: "import", format: "step", fileName: "big.step", data } as Feature);
  const t = performance.now();
  for (let i = 0; i < 100; i++) store.add({ ...store.newIdentity("extrude"), type: "extrude", source: { kind: "profile", sketch: "s", regions: [] }, distance: i, mode: "new" } as Feature);
  const per = (performance.now() - t) / 100;
  check("with a 6 MB import inside: each edit stays quick", per < 60, `${per.toFixed(1)} ms per edit`);
  const mem = process.memoryUsage().heapUsed / 1e6;
  check("…and undo doesn't keep hundreds of copies of the import", mem < 800, `${mem.toFixed(0)} MB in use`);
  const tu = performance.now();
  for (let i = 0; i < 50; i++) store.undo();
  check("undoing 50 steps of it is quick", (performance.now() - tu) / 50 < 60, `${((performance.now() - tu) / 50).toFixed(1)} ms per undo`);
}

process.exit(failed ? 1 : 0);
