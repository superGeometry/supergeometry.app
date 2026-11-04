/// <reference lib="webworker" />
// Web Worker entry: loads OpenCascade and serves engine.ts over postMessage.

import opencascade from "replicad-opencascadejs";
import wasmUrl from "replicad-opencascadejs/wasm?url";
import { setOC } from "replicad";
import { errorText, exportBodies, regenerate } from "./engine";
import type { Envelope, Request, Response } from "./protocol";

self.onmessage = async (e: MessageEvent<Envelope<Request>>) => {
  const { id, msg } = e.data;
  const reply = (r: Response) => (self as DedicatedWorkerGlobalScope).postMessage({ id, msg: r } satisfies Envelope<Response>);
  try {
    switch (msg.type) {
      case "init":
        setOC(await opencascade({ locateFile: () => wasmUrl }));
        reply({ type: "ready" });
        break;
      case "regenerate":
        reply({ type: "regenerated", result: await regenerate(msg.features) });
        break;
      case "export":
        reply({ type: "exported", blob: await exportBodies(msg.features, msg.format, msg.bodies) });
        break;
    }
  } catch (err) {
    console.error(err);
    reply({ type: "error", message: errorText(err) });
  }
};
