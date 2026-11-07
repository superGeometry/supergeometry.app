// Scroll bars outside the windows: the browser's own bars (inside the tool
// column, Items, History, menus…) are hidden; while a window scrolls, a thin
// bar shows just outside its edge, and fades away when the scrolling stops.
// With a mouse it can be dragged.

const GAP = 3;
const THICK = 4;
const HIDE_MS = 900;

interface Bar {
  el: HTMLElement;
  timer: number;
}

const bars = new WeakMap<HTMLElement, { v: Bar; h: Bar }>();

function makeBar(target: HTMLElement, vertical: boolean): Bar {
  const el = document.createElement("div");
  el.className = `outer-scroll ${vertical ? "v" : "h"}`;
  el.hidden = true;
  document.body.append(el);
  const bar: Bar = { el, timer: 0 };
  // Mouse: drag the bar to scroll.
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    el.setPointerCapture(e.pointerId);
    const start = vertical ? e.clientY : e.clientX;
    const s0 = vertical ? target.scrollTop : target.scrollLeft;
    const r = target.getBoundingClientRect();
    const track = vertical ? r.height : r.width;
    const content = vertical ? target.scrollHeight : target.scrollWidth;
    const move = (m: PointerEvent) => {
      const d = ((vertical ? m.clientY : m.clientX) - start) * (content / track);
      if (vertical) target.scrollTop = s0 + d;
      else target.scrollLeft = s0 + d;
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  });
  return bar;
}

function show(target: HTMLElement): void {
  let b = bars.get(target);
  if (!b) {
    b = { v: makeBar(target, true), h: makeBar(target, false) };
    bars.set(target, b);
  }
  const r = target.getBoundingClientRect();
  const W = window.innerWidth;
  const H = window.innerHeight;
  // Up and down.
  if (target.scrollHeight > target.clientHeight + 1) {
    const len = Math.max(24, (r.height * target.clientHeight) / target.scrollHeight);
    const top = r.top + ((r.height - len) * target.scrollTop) / Math.max(1, target.scrollHeight - target.clientHeight);
    // Outside the right edge; at the screen's edge, outside the left one.
    const x = r.right + GAP + THICK <= W - 1 ? r.right + GAP : r.left - GAP - THICK;
    place(b.v, x, top, THICK, len);
  }
  // Side to side (the tool strip along the bottom of a phone).
  if (target.scrollWidth > target.clientWidth + 1) {
    const len = Math.max(24, (r.width * target.clientWidth) / target.scrollWidth);
    const left = r.left + ((r.width - len) * target.scrollLeft) / Math.max(1, target.scrollWidth - target.clientWidth);
    const y = r.top - GAP - THICK >= 1 ? r.top - GAP - THICK : r.bottom + GAP;
    place(b.h, left, Math.min(y, H - THICK - 1), len, THICK);
  }
}

function place(bar: Bar, x: number, y: number, w: number, h: number): void {
  const s = bar.el.style;
  s.left = `${Math.round(x)}px`;
  s.top = `${Math.round(y)}px`;
  s.width = `${Math.round(w)}px`;
  s.height = `${Math.round(h)}px`;
  bar.el.hidden = false;
  bar.el.classList.add("on");
  clearTimeout(bar.timer);
  bar.timer = window.setTimeout(() => {
    bar.el.classList.remove("on");
    bar.timer = window.setTimeout(() => (bar.el.hidden = true), 250);
  }, HIDE_MS);
}

/** Watch every scrolling window of the app (scroll events are caught on the way down). */
export function outerScrollbars(): void {
  document.addEventListener(
    "scroll",
    (e) => {
      const t = e.target;
      // (A window with a bar of its own, always in sight, needs no second one.)
      if (t instanceof HTMLElement && t !== document.body && t !== document.documentElement && !("ownBar" in t.dataset)) show(t);
    },
    true,
  );
}
