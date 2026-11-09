import type { Feature } from "../doc/types";
import type { BodyMesh, Envelope, ExportFormat, RegenResult, Request, Response } from "./protocol";

/** Promise-based wrapper around the kernel worker. */
export class KernelClient {
  private worker!: Worker;
  private nextId = 1;
  private pending = new Map<number, (r: Response) => void>();
  ready!: Promise<void>;
  /** The features the running regeneration is for (null when idle). */
  running: Feature[] | null = null;

  // Coalesce regenerations: while one runs, only the most recent request waits.
  private regenRunning = false;
  private regenQueued: { features: Feature[]; saved: boolean; resolve: (r: RegenResult | null) => void } | null = null;
  /** The last answer's meshes by key: the worker sends a mesh once, then just its key. */
  private meshes = new Map<number, BodyMesh>();

  /**
   * The engine (OpenCascade) never hands memory back, and some of its
   * operations leak (a union with a freeform body: ~10 MB each time). Past
   * this much a spare engine is started, brought up to date in the
   * background, and swapped in while nothing is running - a phone would
   * otherwise run out after a while of editing.
   */
  static RECYCLE_MB = 500;
  private last: { features: Feature[]; saved: Feature[] | null } = { features: [], saved: null };
  private spare: { worker: Worker; bodies: BodyMesh[] | null } | null = null;

  constructor() {
    this.start();
  }

  private handler = (e: MessageEvent<Envelope<Response>>) => {
    const cb = this.pending.get(e.data.id);
    this.pending.delete(e.data.id);
    cb?.(e.data.msg);
  };

  private start(): void {
    // A fresh worker sends every mesh again.
    this.meshes = new Map();
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = this.handler;
    this.ready = this.call({ type: "init" }).then((r) => {
      if (r.type === "error") throw new Error(r.message);
    });
  }

  /** A spare engine, given the last saved project (and the last preview): it's ready to take over. */
  private warmSpare(): void {
    if (this.spare) return;
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    const spare: { worker: Worker; bodies: BodyMesh[] | null } = { worker, bodies: null };
    this.spare = spare;
    let n = 0;
    const waiting = new Map<number, (r: Response) => void>();
    worker.onmessage = (e: MessageEvent<Envelope<Response>>) => waiting.get(e.data.id)?.(e.data.msg);
    const ask = (msg: Request) =>
      new Promise<Response>((resolve) => {
        waiting.set(++n, resolve);
        worker.postMessage({ id: n, msg } satisfies Envelope<Request>);
      });
    const { features, saved } = this.last;
    (async () => {
      if ((await ask({ type: "init" })).type !== "ready") throw new Error("init");
      const got = new Map<number, BodyMesh>();
      const regen = async (fs: Feature[], asSaved: boolean) => {
        const r = await ask({ type: "regenerate", features: fs, saved: asSaved });
        if (r.type !== "regenerated") throw new Error("regenerate");
        const bodies = r.result.bodies.map((b) => ((b as { same?: boolean }).same ? got.get(b.key)! : b));
        for (const b of bodies) got.set(b.key, b);
        return bodies;
      };
      let bodies = saved ? await regen(saved, true) : [];
      if (!saved || features !== saved) bodies = await regen(features, false);
      if (this.spare !== spare) throw new Error("stopped");
      spare.bodies = bodies;
      this.swapIfIdle();
    })().catch(() => {
      worker.terminate();
      if (this.spare === spare) this.spare = null;
    });
  }

  /** The spare engine takes over, if it's ready and nothing is running. */
  private swapIfIdle(): void {
    const s = this.spare;
    if (!s?.bodies || this.regenRunning || this.pending.size) return;
    this.spare = null;
    this.worker.terminate();
    this.worker = s.worker;
    this.worker.onmessage = this.handler;
    this.ready = Promise.resolve();
    // It sends meshes it already sent (to us, while warming) as keys only.
    this.meshes = new Map(s.bodies.map((b) => [b.key, b]));
  }

  /**
   * Stop whatever the engine is working on (it can't be interrupted mid-way:
   * the worker is thrown away and a fresh one started). Waiting calls end empty.
   */
  stop(): void {
    this.spare?.worker.terminate();
    this.spare = null;
    this.worker.terminate();
    const waiting = [...this.pending.values()];
    this.pending.clear();
    this.regenQueued?.resolve(null);
    this.regenQueued = null;
    for (const cb of waiting) cb({ type: "error", message: "Stopped" } as Response);
    this.regenRunning = false;
    this.running = null;
    this.start();
    this.onBusy?.(false);
  }

  /** Told when the kernel starts and stops being busy (to show a busy indicator). */
  onBusy: ((busy: boolean) => void) | null = null;

  private call(msg: Request): Promise<Response> {
    const id = this.nextId++;
    if (this.pending.size === 0) this.onBusy?.(true);
    return new Promise((resolve) => {
      this.pending.set(id, (r) => {
        resolve(r);
        if (this.pending.size === 0 && !this.regenQueued) this.onBusy?.(false);
      });
      this.worker.postMessage({ id, msg } satisfies Envelope<Request>);
    });
  }

  /**
   * Rebuild geometry. If calls arrive faster than the kernel can answer, the
   * intermediate ones resolve with null (they were superseded).
   */
  regenerate(features: Feature[], saved = false): Promise<RegenResult | null> {
    return new Promise((resolve) => {
      if (this.regenRunning) {
        this.regenQueued?.resolve(null);
        this.regenQueued = { features, saved, resolve };
        return;
      }
      this.runRegen(features, saved, resolve);
    });
  }

  /** `saved`: the project as saved (not a tool's preview) - the engine keeps its steps for Cancel. */
  private async runRegen(features: Feature[], saved: boolean, resolve: (r: RegenResult | null) => void) {
    this.regenRunning = true;
    await this.ready;
    this.running = features;
    this.last = { features, saved: saved ? features : this.last.saved };
    const worker = this.worker;
    const r = await this.call({ type: "regenerate", features, saved });
    // Stopped meanwhile: the fresh worker has its own queue.
    if (worker !== this.worker) return resolve(null);
    this.running = null;
    resolve(r.type === "regenerated" ? this.withMeshes(r.result) : null);
    if (r.type === "error") console.error(r.message);
    this.regenRunning = false;
    const q = this.regenQueued;
    this.regenQueued = null;
    if (q) this.runRegen(q.features, q.saved, q.resolve);
    else if (r.type === "regenerated" && (r.result.memoryMB ?? 0) > KernelClient.RECYCLE_MB) this.warmSpare();
    if (!q) this.swapIfIdle();
  }

  /** Meshes sent as their key only (unchanged bodies): the ones the page has. */
  private withMeshes(result: RegenResult): RegenResult {
    const bodies = result.bodies.map((b) => {
      if (!(b as { same?: boolean }).same) return b;
      const had = this.meshes.get(b.key)!;
      // (The same object when nothing about it changed: the view keeps what it drew.)
      return had.id === b.id && had.name === b.name ? had : { ...had, id: b.id, name: b.name };
    });
    this.meshes = new Map(bodies.map((b) => [b.key, b]));
    return { ...result, bodies };
  }

  async export(features: Feature[], format: ExportFormat, bodies?: string[]): Promise<Blob> {
    await this.ready;
    const r = await this.call({ type: "export", features, format, bodies });
    if (r.type === "exported") return r.blob;
    throw new Error(r.type === "error" ? r.message : "Export failed");
  }
}
