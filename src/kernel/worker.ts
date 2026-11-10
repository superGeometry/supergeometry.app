/// <reference lib="webworker" />
// Web Worker entry: loads OpenCascade and serves engine.ts over postMessage.

import opencascade from "replicad-opencascadejs";
import wasmUrl from "replicad-opencascadejs/wasm?url";
import { setOC } from "replicad";
import { bodyProperties, errorText, exportBodies, regenerate, resetKernel, withFreshKernel } from "./engine";
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

/** OpenCascade loaded afresh (at the start, and after it broke down: its memory can't be trusted then). */
async function load(): Promise<void> {
  oc = await opencascade({ locateFile: () => wasmUrl });
  setOC(oc as never);
  // Everything is new to the page again.
  sent = new Set();
}

/**
 * One message at a time: a rebuild waits at points (it awaits), and another
 * message taken then (an export, the bodies' properties) ran the same steps
 * at once, on the same cache.
 */
let queue: Promise<void> = Promise.resolve();
self.onmessage = (e: MessageEvent<Envelope<Request>>) => {
  queue = queue.then(() => handle(e));
};

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
        const result = await withFreshKernel(load, () => regenerate(msg.features, msg.saved));
        const bodies = result.bodies.map((b) => (sent.has(b.key) ? ({ id: b.id, name: b.name, key: b.key, same: true } as unknown as BodyMesh) : b));
        sent = new Set(result.bodies.map((b) => b.key));
        reply({ type: "regenerated", result: { ...result, bodies, memoryMB: (oc.wasmMemory?.buffer.byteLength ?? 0) / 2 ** 20 } });
        break;
      }
      case "export":
        reply({ type: "exported", blob: await withFreshKernel(load, () => exportBodies(msg.features, msg.format, msg.bodies)) });
        break;
      case "properties":
        reply({ type: "properties", bodies: await withFreshKernel(load, () => bodyProperties(msg.features)) });
        break;
    }
  } catch (err) {
    console.error(err);
    reply({ type: "error", message: errorText(err) });
  }
}
