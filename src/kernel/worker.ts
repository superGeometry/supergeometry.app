/// <reference lib="webworker" />
// Web Worker entry: loads OpenCascade and serves engine.ts over postMessage.

import opencascade from "replicad-opencascadejs";
import wasmUrl from "replicad-opencascadejs/wasm?url";
import { setOC } from "replicad";
import { askStop, bodyHealth, bodyProperties, projectViews, errorText, exportBodies, rebuildBegins, rebuildEnds, regenerate, resetKernel, setOnStep, Stopped, withFreshKernel } from "./engine";
import type { BodyMesh, Envelope, Request, Response } from "./protocol";

/**
 * The meshes the page has (it keeps the last answer's): those go back as their
 * key only - a step changes one body, and every body's triangles were copied
 * across on each move of a drag.
 */
let sent = new Set<number>();
let oc: { wasmMemory?: WebAssembly.Memory } = {};
/** Past this much memory the engine is replaced before the next rebuild (a phone's tab is killed not far above it). */
const FRESH_ENGINE_MB = 1200;
/** Rebuilds done with the OpenCascade that is loaded now (none yet: the next one says what the project itself takes). */
let builds = 0;

/** OpenCascade loaded afresh (at the start, and after it broke down: its memory can't be trusted then). */
async function load(): Promise<void> {
  oc = await opencascade({ locateFile: () => wasmUrl });
  setOC(oc as never);
  // Everything is new to the page again.
  sent = new Set();
  builds = 0;
}

/**
 * One message at a time: a rebuild waits at points (it awaits), and another
 * message taken then (an export, the bodies' properties) ran the same steps
 * at once, on the same cache.
 */
let queue: Promise<void> = Promise.resolve();
self.onmessage = (e: MessageEvent<Envelope<Request>>) => {
  // (Stop is taken at once: the rebuild it is for sees it between two steps.)
  if (e.data.msg.type === "stop") return askStop(e.data.msg.of);
  queue = queue.then(() => handle(e));
};
setOnStep((featureId) => (self as DedicatedWorkerGlobalScope).postMessage({ id: 0, msg: { type: "step", featureId } } satisfies Envelope<Response>));

async function handle(e: MessageEvent<Envelope<Request>>): Promise<void> {
  const { id, msg } = e.data;
  const reply = (r: Response) => (self as DedicatedWorkerGlobalScope).postMessage({ id, msg: r } satisfies Envelope<Response>);
  try {
    switch (msg.type) {
      case "init":
        await load();
        reply({ type: "ready" });
        break;
      case "regenerate": {
        // The engine's memory only grows (and some steps leak tens of MB a
        // rebuild: a long drag of a fillet's size). The page swaps in a spare
        // engine when it can; if it didn't get to, a fresh one here, before
        // this one runs out mid-step.
        if ((oc.wasmMemory?.buffer.byteLength ?? 0) / 2 ** 20 > FRESH_ENGINE_MB) {
          await load();
          resetKernel();
        }
        rebuildBegins(id);
        let built: Awaited<ReturnType<typeof regenerate>>;
        try {
          built = await withFreshKernel(load, () => regenerate(msg.features, msg.saved));
        } finally {
          rebuildEnds(id);
        }
        // "From nothing" says what the project itself takes only of an engine just loaded: one long in use that
        // happened to keep no step (its first step edited, another project opened in it) is as big as all that came
        // before, and the page took that for the project's own size - no spare engine was got ready after it.
        const { fromNothing, ...result } = built;
        const first = builds++ === 0;
        const bodies = result.bodies.map((b) => (sent.has(b.key) ? ({ id: b.id, name: b.name, key: b.key, same: true } as unknown as BodyMesh) : b));
        sent = new Set(result.bodies.map((b) => b.key));
        reply({ type: "regenerated", result: { ...result, bodies, ...(fromNothing && first ? { fromNothing: true } : {}), memoryMB: (oc.wasmMemory?.buffer.byteLength ?? 0) / 2 ** 20 } });
        break;
      }
      case "export":
        reply({ type: "exported", blob: await withFreshKernel(load, () => exportBodies(msg.features, msg.format, msg.bodies, msg.colors)) });
        break;
      case "drawing":
        reply({ type: "drawing", views: await withFreshKernel(load, () => projectViews(msg.features, msg.views, msg.bodies)) });
        break;
      case "properties":
        reply({ type: "properties", bodies: await withFreshKernel(load, () => bodyProperties(msg.features)) });
        break;
      case "health":
        reply({ type: "health", bodies: await withFreshKernel(load, () => bodyHealth(msg.features)) });
        break;
    }
  } catch (err) {
    if (err instanceof Stopped) return reply({ type: "error", message: err.message });
    console.error(err);
    reply({ type: "error", message: errorText(err) });
  }
}
