import type { Feature } from "../doc/types";
import type { BodyHealth, BodyMesh, BodyProps, ProjectedView, ViewSpec, Envelope, ExportFormat, RegenResult, Request, Response } from "./protocol";

/**
 * The steps as the engine needs them: a reference image without its picture
 * (megabytes the engine never reads, copied across and hashed on every rebuild
 * - every step of a drag). The same for every kind of call, so the engine sees
 * the same steps each time.
 */
function lean(features: Feature[]): Feature[] {
  return features.some((f) => f.type === "image" && f.src) ? features.map((f) => (f.type === "image" ? { ...f, src: "" } : f)) : features;
}

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
  /**
   * Some steps cost the engine tens of MB each time they are rebuilt (memory
   * it never gets back): dragging one of their sizes, a rebuild per move,
   * would fill it in seconds. After a rebuild seen to cost a lot, the next
   * previews wait a moment - fewer of them, the drag's last one always shown.
   */
  private memoryMB = 0;
  /** What the last few rebuilds cost, each (MB; the engine's memory grows in jumps, so one rebuild's own cost says little). */
  private costMB = 0;
  private restUntil = 0;
  /** How long previews rest after a rebuild that cost `mb` of the engine's memory (ms). */
  static restFor(mb: number): number {
    return mb < 4 ? 0 : Math.min(400, mb * 8);
  }
  private spare: { worker: Worker; bodies: BodyMesh[] | null; mb?: number } | null = null;
  /**
   * What a fresh engine took to build the project (the last spare's memory): a big project needs that much
   * however fresh. A spare is got ready only past this and RECYCLE_MB more - one past RECYCLE_MB alone came
   * out as big, and was replaced by another after every change: the whole project built over again, all the time.
   */
  private freshMB = 0;
  /** The step the rebuild is at (the engine says as each begins). */
  private atStep: string | null = null;
  /**
   * Stops waiting for the engine: each is told the step it stopped before and whether the engine is a fresh one
   * (null: no answer in time). Each its own - a second Stop took the first one's place, and the first then threw
   * away whatever engine there was four seconds later, the next project's with it.
   */
  private stops = new Set<(r: { at?: string; fresh: boolean } | null) => void>();
  /** The id of the rebuild the engine was last asked for (a Stop is for that one, not for an export in its way). */
  private regenId = 0;
  /** How long Stop waits for the engine to stop between two steps before throwing it away (a step can't be broken off). */
  static STOP_WAIT_MS = 4000;
  /** ... and when another project is being opened: its own rebuild is waiting behind the one stopped. */
  static SWITCH_WAIT_MS = 300;

  constructor() {
    this.start();
  }

  private handler = (e: MessageEvent<Envelope<Response>>) => {
    if (e.data.msg.type === "step") return void (this.atStep = e.data.msg.featureId);
    const cb = this.pending.get(e.data.id);
    this.pending.delete(e.data.id);
    cb?.(e.data.msg);
  };

  private start(): void {
    // A fresh worker sends every mesh again.
    this.meshes = new Map();
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = this.handler;
    // The engine died without an answer (out of memory, a fault outside any step): what waits on it would wait for
    // ever, and "Working…" with it. Everything waiting ends, and a fresh engine is started.
    const worker = this.worker;
    worker.onerror = (e) => {
      if (worker !== this.worker) return;
      console.error("The geometry engine stopped:", e.message);
      this.hardStop();
      this.onLost?.();
    };
    this.ready = this.call({ type: "init" }).then((r) => {
      if (r.type === "error") throw new Error(r.message);
    });
  }

  /** A spare engine, given the last saved project (and the last preview): it's ready to take over. */
  private warmSpare(): void {
    if (this.spare) return;
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    const spare: { worker: Worker; bodies: BodyMesh[] | null; mb?: number } = { worker, bodies: null };
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
        const r = await ask({ type: "regenerate", features: lean(fs), saved: asSaved });
        if (r.type !== "regenerated") throw new Error("regenerate");
        spare.mb = r.result.memoryMB;
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
    this.freshMB = s.mb ?? 0;
    this.worker.terminate();
    this.worker = s.worker;
    this.worker.onmessage = this.handler;
    this.ready = Promise.resolve();
    // It sends meshes it already sent (to us, while warming) as keys only.
    this.meshes = new Map(s.bodies.map((b) => [b.key, b]));
  }

  /**
   * Stop. A rebuild ends before its next step, and what it built is kept (asked again, it carries on from there);
   * one that doesn't answer in time - a long step can't be broken off - or other work (an export) has its engine
   * thrown away and a fresh one started, with nothing built. Says the step it stopped before (or was at), and
   * whether the engine is a fresh one. What is asked for while it waits is built after it, on whichever engine.
   */
  async stop(wait = KernelClient.STOP_WAIT_MS): Promise<{ at?: string; fresh: boolean }> {
    if (this.regenRunning && this.running) {
      this.regenQueued?.resolve(null);
      this.regenQueued = null;
      this.worker.postMessage({ id: 0, msg: { type: "stop", of: this.regenId } } satisfies Envelope<Request>);
      let mine!: (r: { at?: string; fresh: boolean } | null) => void;
      const got = await new Promise<{ at?: string; fresh: boolean } | null>((done) => {
        mine = done;
        this.stops.add(done);
        setTimeout(() => done(null), wait);
      });
      this.stops.delete(mine);
      // (Answered - or the engine was thrown away meanwhile by another Stop, or broke down: said, not done again.)
      if (got) return got;
    }
    const at = this.atStep ?? undefined;
    this.hardStop();
    return { at, fresh: true };
  }

  /** Another project is being opened: what the last one took of a fresh engine says nothing of this one. */
  newProject(): void {
    this.freshMB = 0;
  }

  /**
   * Throw the engine away and start a fresh one (what it was working on is lost). Waiting calls end empty; Stops
   * waiting for it are told; and a rebuild asked for since - another project opened, an edit made while a Stop was
   * waiting - is built on the fresh engine (it ended empty with the rest, and that project was never built).
   */
  private hardStop(): void {
    const at = this.atStep ?? undefined;
    this.spare?.worker.terminate();
    this.spare = null;
    this.worker.terminate();
    const waiting = [...this.pending.values()];
    this.pending.clear();
    const next = this.regenQueued;
    this.regenQueued = null;
    for (const cb of waiting) cb({ type: "error", message: "Stopped" } as Response);
    this.regenRunning = false;
    this.running = null;
    this.atStep = null;
    this.start();
    const stops = [...this.stops];
    this.stops.clear();
    for (const s of stops) s({ at, fresh: true });
    this.onBusy?.(false);
    if (next) void this.runRegen(next.features, next.saved, next.resolve);
  }

  /** Told when the kernel starts and stops being busy (to show a busy indicator). */
  onBusy: ((busy: boolean) => void) | null = null;
  /** Told when the engine died and was started again (what was being made is not made). */
  onLost: (() => void) | null = null;
  /** Is anything being worked on, or waiting to be? (What the busy indicator is checked against.) */
  get busy(): boolean {
    return this.pending.size > 0 || this.regenRunning || !!this.regenQueued;
  }

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
    const worker = this.worker;
    try {
      await this.ready;
    } catch {
      // The engine could not be started. (Or was thrown away while starting: see below.)
    }
    // Thrown away while it waited for the engine to start (a Stop pressed again): it ends empty - it never ended at
    // all, and the page went on counting a rebuild under way. Whoever threw the engine away asks again.
    if (worker !== this.worker) return resolve(null);
    this.running = features;
    this.last = { features, saved: saved ? features : this.last.saved };
    this.atStep = null;
    this.regenId = this.nextId;
    const r = await this.call({ type: "regenerate", features: lean(features), saved });
    // Stopped meanwhile: the fresh worker has its own queue.
    if (worker !== this.worker) return resolve(null);
    // Stops waiting for this one: it stopped (before the step it names), or had finished anyway.
    const stoppedAt = r.type === "error" && r.message.startsWith("Stopped:") ? r.message.slice(8) : undefined;
    if (this.stops.size) {
      const stops = [...this.stops];
      this.stops.clear();
      for (const s of stops) s({ at: stoppedAt, fresh: false });
    }
    this.running = null;
    resolve(r.type === "regenerated" ? this.withMeshes(r.result) : null);
    if (r.type === "error" && stoppedAt === undefined) console.error(r.message);
    if (r.type === "regenerated" && r.result.memoryMB !== undefined) {
      // (A fresh engine starts small again: that isn't a rebuild giving memory back.)
      const cost = this.memoryMB ? Math.max(0, r.result.memoryMB - this.memoryMB) : 0;
      if (r.result.memoryMB < this.memoryMB) this.costMB = 0;
      this.memoryMB = r.result.memoryMB;
      // (A project built from nothing - just opened: that much is the project's own, not memory lost along the way.)
      if (r.result.fromNothing) this.freshMB = r.result.memoryMB;
      this.costMB = this.costMB * 0.7 + cost * 0.3;
      this.restUntil = performance.now() + KernelClient.restFor(this.costMB);
    }
    // A preview waiting its turn rests first (whatever is asked meanwhile takes its place).
    const rest = this.restUntil - performance.now();
    if (this.regenQueued && !this.regenQueued.saved && rest > 0) {
      await new Promise((done) => setTimeout(done, rest));
      if (worker !== this.worker) return;
    }
    this.regenRunning = false;
    // A big engine: a spare is got ready (also in the middle of a drag, where
    // it used to wait for the drag to end), and takes over between two rebuilds.
    if (r.type === "regenerated" && (r.result.memoryMB ?? 0) > KernelClient.RECYCLE_MB + this.freshMB) this.warmSpare();
    this.swapIfIdle();
    const q = this.regenQueued;
    this.regenQueued = null;
    if (q) this.runRegen(q.features, q.saved, q.resolve);
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

  /** The bodies drawn in views, hidden lines found (for BIM drawings). */
  async drawing(features: Feature[], views: ViewSpec[], bodies?: string[]): Promise<ProjectedView[]> {
    await this.ready;
    const r = await this.call({ type: "drawing", features: lean(features), views, bodies });
    if (r.type === "drawing") return r.views;
    throw new Error(r.type === "error" ? r.message : "Could not draw the views");
  }

  /** Each body's volume, area, centre of mass and box (for BIM). */
  async properties(features: Feature[]): Promise<BodyProps[]> {
    await this.ready;
    const r = await this.call({ type: "properties", features: lean(features) });
    if (r.type === "properties") return r.bodies;
    throw new Error(r.type === "error" ? r.message : "Could not measure the bodies");
  }

  /** Each body's health: valid, closed, solids, faces, volume (the console's sg.health()). */
  async health(features: Feature[]): Promise<BodyHealth[]> {
    await this.ready;
    const r = await this.call({ type: "health", features: lean(features) });
    if (r.type === "health") return r.bodies;
    throw new Error(r.type === "error" ? r.message : "Could not check the bodies");
  }

  /** `colors`: the bodies' colours ("#rrggbb" by body id), written into a STEP file. */
  async export(features: Feature[], format: ExportFormat, bodies?: string[], colors?: Record<string, string>): Promise<Blob> {
    await this.ready;
    const r = await this.call({ type: "export", features: lean(features), format, bodies, colors });
    if (r.type === "exported") return r.blob;
    throw new Error(r.type === "error" ? r.message : "Export failed");
  }
}
