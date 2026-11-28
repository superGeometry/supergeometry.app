// The ways to support the project: More → Support and the
// welcome window list them. A way without a link yet shows as "soon".
// `logo`: its picture in public/logos (the sites' own marks, in their
// colours); without one, a plain drawn mark holds its place.

export interface SupportWay {
  id: string;
  name: string;
  /** A word on what it is. */
  sub: string;
  url: string;
  logo: string;
  /** What the logo sits on (one drawn for a light page). */
  tile?: string;
  /** The mark that stands in for the logo. */
  mark: string;
  /** A tag on the button's right (MakerWorld's Boost, with its rocket). */
  tag?: { icon: string; text: string };
  /** Said on a card of the app's own before its page opens (Ko-fi): its name and one button on to it. Without it the page opens at once. */
  card?: boolean;
}

const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const SUPPORT: SupportWay[] = [
  {
    id: "makerworld",
    name: "MakerWorld",
    sub: "Boost my models",
    url: "https://makerworld.com/en/@supergeometry/upload",
    logo: "logos/makerworld.png",
    tile: "#fff",
    tag: {
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.5c2.6 2 4 5 4 8.5v5H8v-5c0-3.5 1.4-6.5 4-8.5z"/><path d="M8 12.5 5.5 15v3.5H8M16 12.5l2.5 2.5v3.5H16"/><circle cx="12" cy="9.5" r="1.6"/><path d="M10.5 19v2.5M13.5 19v2.5"/></svg>',
      text: "Boost",
    },
    mark: svg('<path d="M12 3 4 7.5v9L12 21l8-4.5v-9z"/><path d="M4 7.5 12 12l8-4.5M12 12v9"/>'),
  },
  {
    id: "kofi",
    name: "Ko-fi",
    sub: "Buy me a coffee",
    url: "https://ko-fi.com/supergeometry",
    logo: "",
    card: true,
    // (A cup with a heart on it.)
    mark: svg('<path d="M4 8h12v6a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z"/><path d="M16 9.5h1.5a2.5 2.5 0 0 1 0 5H16"/><path d="M10 15.2 7.9 13a1.4 1.4 0 0 1 2.1-1.9A1.4 1.4 0 0 1 12.1 13z" fill="currentColor"/>'),
  },
];

/** Opens in a new tab, with no way back into this page. */
export function openSupport(url: string): void {
  window.open(url, "_blank", "noopener");
}

/** A way to support, opened: the app's card for it first if it has one, else its page in a new tab. */
export function showSupport(w: SupportWay): void {
  if (!w.card) return openSupport(w.url);
  const back = document.createElement("div");
  back.className = "dialog-back";
  const box = document.createElement("div");
  box.className = "dialog support-panel";
  const head = document.createElement("div");
  head.className = "library-head";
  const title = document.createElement("div");
  title.className = "panel-title";
  title.textContent = `Support on ${w.name}`;
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "icon-btn library-close";
  closeBtn.title = "Close";
  closeBtn.innerHTML = svg('<path d="M6 6l12 12M18 6 6 18"/>');
  head.append(title, closeBtn);
  // The app's own card, in its own look: what it is for, and one button on to the site (nothing of the site is loaded here).
  const card = document.createElement("div");
  card.className = "support-card";
  const mark = document.createElement("div");
  mark.className = "support-card-mark";
  mark.innerHTML = w.mark;
  const big = document.createElement("div");
  big.className = "support-card-title";
  big.textContent = w.sub;
  const out = document.createElement("button");
  out.type = "button";
  out.className = "text-btn primary support-card-go";
  out.textContent = `Continue to ${w.name} ↗`;
  const note = document.createElement("div");
  note.className = "dialog-note support-note";
  note.textContent = `Opens ${new URL(w.url).host} in a new tab. Paying is between you and ${w.name}.`;
  card.append(mark, big, out);
  box.append(head, card, note);
  const close = () => {
    window.removeEventListener("keydown", onKey, true);
    back.remove();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") (e.preventDefault(), close());
    e.stopPropagation();
  };
  out.addEventListener("click", () => (openSupport(w.url), close()));
  closeBtn.addEventListener("click", close);
  back.addEventListener("pointerdown", (ev) => ev.target === back && close());
  window.addEventListener("keydown", onKey, true);
  back.append(box);
  document.body.append(back);
}
