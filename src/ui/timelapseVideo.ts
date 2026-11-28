// History's Play as a video file. Loaded only when a recording is asked for. The browser's own recorder does the
// encoding (MP4 where it can, WebM where it can't), fed from a second canvas: the part of the 3D view that has the
// video's shape, with the step's name drawn in. The page's panels are not in the 3D view, so not in the video.
import type { Insets } from "../view/camera";
import type { Viewport } from "../view/viewport";

const KINDS: [mime: string, ext: string][] = [
  ["video/mp4;codecs=avc1.42E01F", "mp4"],
  ["video/mp4;codecs=avc1", "mp4"],
  ["video/mp4", "mp4"],
  ["video/webm;codecs=vp9", "webm"],
  ["video/webm;codecs=vp8", "webm"],
  ["video/webm", "webm"],
];

function kind(): [string, string] | null {
  if (typeof MediaRecorder === "undefined" || !HTMLCanvasElement.prototype.captureStream) return null;
  return KINDS.find(([m]) => MediaRecorder.isTypeSupported(m)) ?? null;
}

export class TimelapseVideo {
  static supported(): boolean {
    return !!kind();
  }

  /** The file's ending: mp4, or webm where the browser records nothing else. */
  readonly ext: string;
  private out = document.createElement("canvas");
  private g: CanvasRenderingContext2D;
  private rec: MediaRecorder;
  private parts: Blob[] = [];
  private text: { count: string; name: string } | null = null;
  private waits = new Set<string>();
  private stopped: Promise<void>;

  constructor(private view: Viewport) {
    const [mime, ext] = kind()!;
    this.ext = ext;
    // Lying or upright, as the view is: 1280 x 720, or 720 x 1280 on a phone held upright.
    const wide = view.canvas.width >= view.canvas.height;
    this.out.width = wide ? 1280 : 720;
    this.out.height = wide ? 720 : 1280;
    this.g = this.out.getContext("2d", { alpha: false })!;
    this.rec = new MediaRecorder(this.out.captureStream(30), { mimeType: mime, videoBitsPerSecond: 4_000_000 });
    this.rec.ondataavailable = (e) => e.data.size && this.parts.push(e.data);
    this.stopped = new Promise((done) => (this.rec.onstop = () => done()));
    view.afterDraw = () => this.draw();
    this.draw();
    this.rec.start(1000);
  }

  /** The part of the 3D view that goes into the video: the biggest of the video's shape, in its middle. */
  private crop(): { x: number; y: number; w: number; h: number } {
    const c = this.view.canvas;
    const k = this.out.width / this.out.height;
    const w = Math.min(c.width, c.height * k);
    const h = w / k;
    return { x: (c.width - w) / 2, y: (c.height - h) / 2, w, h };
  }

  /** That part, as what the view is to keep the model inside (its edges, as shares of the view). */
  insets(): Insets {
    const c = this.view.canvas;
    const { x, y, w, h } = this.crop();
    // (A little room at the bottom, where the step's name is.)
    return { left: x / c.width, right: 1 - (x + w) / c.width, top: y / c.height, bottom: 1 - (y + h) / c.height + (h / c.height) * 0.12 };
  }

  private draw(): void {
    const { x, y, w, h } = this.crop();
    const [W, H] = [this.out.width, this.out.height];
    this.g.drawImage(this.view.canvas, x, y, w, h, 0, 0, W, H);
    if (!this.text) return;
    // The step's number and name, as on the screen: a dark pill at the bottom.
    const g = this.g;
    const size = Math.round(Math.min(W, H) * 0.036);
    g.font = `500 ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    const cw = g.measureText(this.text.count).width;
    g.font = `600 ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    let name = this.text.name;
    const room = W * 0.8 - cw - size * 2.4;
    while (name.length > 4 && g.measureText(name).width > room) name = `${name.slice(0, -2).trimEnd()}…`;
    const nw = g.measureText(name).width;
    const [bw, bh] = [cw + nw + size * 2.4, size * 2.1];
    const [bx, by] = [(W - bw) / 2, H - bh - size * 1.1];
    g.fillStyle = "rgba(24, 26, 30, 0.88)";
    g.beginPath();
    g.roundRect(bx, by, bw, bh, bh * 0.32);
    g.fill();
    g.textBaseline = "middle";
    g.font = `500 ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    g.fillStyle = "#9aa1ad";
    g.fillText(this.text.count, bx + size * 0.9, by + bh / 2);
    g.font = `600 ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    g.fillStyle = "#f1f3f6";
    g.fillText(name, bx + size * 0.9 + cw + size * 0.6, by + bh / 2);
  }

  caption(at: { index: number; of: number; name: string } | null): void {
    this.text = at ? { count: `${at.index + 1} / ${at.of}`, name: at.name } : null;
    this.view.requestRender();
  }

  /** Nothing to see for a while (the engine is building a step, the playing is paused): that while is left out. */
  hold(why: string, on: boolean): void {
    if (on) this.waits.add(why);
    else this.waits.delete(why);
    if (this.rec.state === "inactive") return;
    if (this.waits.size && this.rec.state === "recording") this.rec.pause();
    else if (!this.waits.size && this.rec.state === "paused") this.rec.resume();
  }

  /** The end: the video (null: thrown away, or nothing was recorded). */
  async finish(keep: boolean): Promise<Blob | null> {
    this.view.afterDraw = null;
    if (this.rec.state !== "inactive") {
      if (this.rec.state === "paused") this.rec.resume();
      this.rec.stop();
      await this.stopped;
    }
    this.out.width = this.out.height = 0;
    if (!keep || !this.parts.length) return null;
    return new Blob(this.parts, { type: this.rec.mimeType.split(";")[0] || `video/${this.ext}` });
  }
}
