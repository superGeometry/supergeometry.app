import type { Feature } from "../doc/types";
import type { Envelope, ExportFormat, RegenResult, Request, Response } from "./protocol";

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
  private regenQueued: { features: Feature[]; resolve: (r: RegenResult | null) => void } | null = null;

  constructor() {
    this.start();
  }

  private start(): void {
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (e: MessageEvent<Envelope<Response>>) => {
      const cb = this.pending.get(e.data.id);
      this.pending.delete(e.data.id);
      cb?.(e.data.msg);
    };
    this.ready = this.call({ type: "init" }).then((r) => {
      if (r.type === "error") throw new Error(r.message);
    });
  }

  /**
   * Stop whatever the engine is working on (it can't be interrupted mid-way:
   * the worker is thrown away and a fresh one started). Waiting calls end empty.
   */
  stop(): void {
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
  regenerate(features: Feature[]): Promise<RegenResult | null> {
    return new Promise((resolve) => {
      if (this.regenRunning) {
        this.regenQueued?.resolve(null);
        this.regenQueued = { features, resolve };
        return;
      }
      this.runRegen(features, resolve);
    });
  }

  private async runRegen(features: Feature[], resolve: (r: RegenResult | null) => void) {
    this.regenRunning = true;
    await this.ready;
    this.running = features;
    const worker = this.worker;
    const r = await this.call({ type: "regenerate", features });
    // Stopped meanwhile: the fresh worker has its own queue.
    if (worker !== this.worker) return resolve(null);
    this.running = null;
    resolve(r.type === "regenerated" ? r.result : null);
    if (r.type === "error") console.error(r.message);
    this.regenRunning = false;
    const q = this.regenQueued;
    this.regenQueued = null;
    if (q) this.runRegen(q.features, q.resolve);
  }

  async export(features: Feature[], format: ExportFormat, bodies?: string[]): Promise<Blob> {
    await this.ready;
    const r = await this.call({ type: "export", features, format, bodies });
    if (r.type === "exported") return r.blob;
    throw new Error(r.type === "error" ? r.message : "Export failed");
  }
}
