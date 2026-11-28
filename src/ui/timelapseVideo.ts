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
    // A frame thirty times a second, whether the picture changed or not. (Left to the browser, a frame is sent only
    // when the canvas changes: a step held for two seconds was one frame two seconds long, and players took that
    // as a stall - or jumped over it.)
    const stream = this.out.captureStream(0);
    const track = stream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?(): void };
    const push = () => (track.requestFrame ? track.requestFrame() : (stream as MediaStream & { requestFrame?(): void }).requestFrame?.());
    // (Sent as each picture is drawn, so a frame is the picture of its own moment - sent by the clock alone, a
    // turning view came out uneven. The clock sends one only when nothing has been drawn for a while.)
    this.push = () => {
      this.pushed = performance.now();
      if (this.rec.state !== "recording") return;
      // (A frame asked for is only sent if the canvas has changed since the last one: one dot of it is drawn over
      // itself, which changes nothing to see. Without it a step held still was one frame seconds long, and a
      // player on a computer stood still on it - or for much longer, losing its place among such frames.)
      this.g.drawImage(this.out, 0, 0, 1, 1, 0, 0, 1, 1);
      push();
    };
    this.ticker = window.setInterval(() => performance.now() - this.pushed > 30 && this.push(), 1000 / 30);
    this.rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
    this.rec.ondataavailable = (e) => e.data.size && this.parts.push(e.data);
    this.stopped = new Promise((done) => (this.rec.onstop = () => done()));
    view.plainGround(true);
    view.afterDraw = () => this.draw();
    view.requestRender();
  }

  /**
   * Recording begins with the first frame drawn once the playing has cleared the view (begun before any frame, the
   * video opened on a black picture; before the view was cleared, on a flash of the finished model).
   */
  private begun = false;
  private open = false;
  private done = false;
  private ticker = 0;
  private began = 0;
  private push: () => void = () => {};
  private pushed = 0;
  start(): void {
    if (this.open) return;
    this.open = true;
    this.view.requestRender();
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
    this.paint();
    // At most thirty a second (the screen draws sixty, or more).
    if (this.open && performance.now() - this.pushed > 27) this.push();
  }

  private paint(): void {
    // (Nothing is copied before the playing has cleared the view: the recorder's first picture is whatever was
    // last put on this canvas, and that was the finished model.)
    if (!this.open) return;
    const { x, y, w, h } = this.crop();
    const [W, H] = [this.out.width, this.out.height];
    const g = this.g;
    // (A big screen's picture is made much smaller: smoothly, or its thin lines break up.)
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = "high";
    g.drawImage(this.view.canvas, x, y, w, h, 0, 0, W, H);
    if (!this.begun) {
      // The recorder starts once this first picture is out (two frames on), so it is the one it opens with.
      this.begun = true;
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (this.rec.state !== "inactive" || this.done) return;
          this.rec.start(1000);
          this.began = performance.now();
          this.view.requestRender();
        }),
      );
    }
    const size = Math.round(Math.min(W, H) * 0.036);
    const sans = `system-ui, -apple-system, "Segoe UI", sans-serif`;
    // The app's name, bottom right.
    const edge = size * 1.1;
    const ls = Math.round(size * 0.95);
    g.textBaseline = "middle";
    g.font = `750 ${ls}px ${sans}`;
    const n1 = g.measureText("superGeometry").width;
    g.font = `600 ${ls}px ${sans}`;
    const n2 = g.measureText(".app").width;
    // (The height of the row the name and the step's caption share.)
    const icon = ls * 1.35;
    const lw = n1 + n2;
    const [lx, ly] = [W - edge - lw, H - edge - icon / 2];
    g.save();
    g.shadowColor = "rgba(0, 0, 0, 0.55)";
    g.shadowBlur = ls * 0.4;
    g.font = `750 ${ls}px ${sans}`;
    g.fillStyle = "#f1f3f6";
    g.fillText("superGeometry", lx, ly);
    g.font = `600 ${ls}px ${sans}`;
    g.fillStyle = "#3d8bff";
    g.fillText(".app", lx + n1, ly);
    g.restore();
    if (!this.text) return;
    // The step's number and name, as on the screen: a dark pill at the bottom - in the middle where there is room
    // beside the name (a lying video), above it where there isn't (an upright one).
    const beside = W > H;
    g.font = `500 ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    const cw = g.measureText(this.text.count).width;
    g.font = `600 ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    let name = this.text.name;
    const room = (beside ? W - 2 * (lw + edge * 2) : W * 0.86) - cw - size * 2.4;
    while (name.length > 4 && g.measureText(name).width > room) name = `${name.slice(0, -2).trimEnd()}…`;
    const nw = g.measureText(name).width;
    const [bw, bh] = [cw + nw + size * 2.4, size * 2.1];
    const [bx, by] = [(W - bw) / 2, beside ? H - edge - icon / 2 - bh / 2 : H - edge - icon - size * 0.7 - bh];
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

  /**
   * Nothing new to see for a while (the engine is building a step, the playing is paused). The recording runs on,
   * on the picture there is: stopped and started again for such whiles, the file's clock ran on without frames and
   * came out with single frames many seconds long. (Each stage is built ahead of its turn, so these whiles are
   * short.)
   */
  hold(why: string, on: boolean): void {
    if (on) this.waits.add(why);
    else this.waits.delete(why);
  }

  /** The end: the video (null: thrown away, or nothing was recorded). */
  async finish(keep: boolean): Promise<Blob | null> {
    this.view.afterDraw = null;
    this.view.plainGround(false);
    this.done = true;
    if (!this.begun || this.rec.state === "inactive") clearInterval(this.ticker);
    if (!this.begun || this.rec.state === "inactive") return null;
    const ms = performance.now() - this.began;
    this.rec.stop();
    await this.stopped;
    clearInterval(this.ticker);
    this.out.width = this.out.height = 0;
    if (!keep || !this.parts.length) return null;
    const type = this.rec.mimeType.split(";")[0] || `video/${this.ext}`;
    const blob = new Blob(this.parts, { type });
    if (this.ext !== "webm") return blob;
    // A WebM as recorded says nothing of how long it is (players then show no length and can't jump about in
    // it): written in now.
    try {
      const { withDuration } = await import("../io/webmDuration");
      return new Blob([withDuration(new Uint8Array(await blob.arrayBuffer()), ms) as BlobPart], { type });
    } catch {
      return blob;
    }
  }
}
