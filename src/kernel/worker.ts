/// <reference lib="webworker" />
// Web Worker entry: loads OpenCascade and serves engine.ts over postMessage.

import opencascade from "replicad-opencascadejs";
import wasmUrl from "replicad-opencascadejs/wasm?url";
import { setOC } from "replicad";
import { errorText, exportBodies, regenerate } from "./engine";
import type { BodyMesh, Envelope, Request, Response } from "./protocol";

/**
 * The meshes the page has (it keeps the last answer's): those go back as their
 * key only - a step changes one body, and every body's triangles were copied
 * across on each move of a drag.
 */
let sent = new Set<number>();

self.onmessage = async (e: MessageEvent<Envelope<Request>>) => {
  const { id, msg } = e.data;
  const reply = (r: Response) => (self as DedicatedWorkerGlobalScope).postMessage({ id, msg: r } satisfies Envelope<Response>);
  try {
    switch (msg.type) {
      case "init":
        setOC(await opencascade({ locateFile: () => wasmUrl }));
        reply({ type: "ready" });
        break;
      case "regenerate": {
        const result = await regenerate(msg.features, msg.saved);
        const bodies = result.bodies.map((b) => (sent.has(b.key) ? ({ id: b.id, name: b.name, key: b.key, same: true } as unknown as BodyMesh) : b));
        sent = new Set(result.bodies.map((b) => b.key));
        reply({ type: "regenerated", result: { ...result, bodies } });
        break;
      }
      case "export":
        reply({ type: "exported", blob: await exportBodies(msg.features, msg.format, msg.bodies) });
        break;
    }
  } catch (err) {
    console.error(err);
    reply({ type: "error", message: errorText(err) });
  }
};
