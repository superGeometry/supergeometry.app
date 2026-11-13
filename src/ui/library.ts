// File → Open: the projects kept on this device, as a gallery of pictures.
// Tap one to open it; New project starts one; Open file… still takes any
// .super file. It also opens by itself when the app starts, with a welcome
// and the ways to support the project.

import type { LibraryEntry } from "../doc/library";
import { icons } from "./icons";
import { SUPPORT, openSupport } from "./support";
import { el, twoTap } from "./ui";

export interface LibraryActions {
  open(id: string): void;
  newProject(): void;
  openFile(): void;
  download(id: string): void;
  /** Resolves with the new name (null: kept as it was). */
  rename(id: string, name: string): Promise<string | null>;
  remove(id: string): Promise<void>;
}

const DOWNLOAD =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 19h14"/></svg>';

/** "Today 14:32", "Yesterday 09:10", "3 Mar", "3 Mar 2025". */
function when(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(now) - day(d)) / 864e5);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  return d.toLocaleDateString([], { day: "numeric", month: "short", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
}

/** The ways to support the project, each with room for its logo. */
function supportBox(): HTMLElement {
  const box = el("div", "library-support");
  box.append(
    el(
      "div",
      "library-support-text",
      "This app is free, with no ads and no account, and one person makes it. If it's useful to you, your support will help keep it this way. Thank you!",
    ),
  );
  const row = el("div", "library-support-row");
  // (Only the ways with a link: Buy Me a Coffee and Stripe stay out of the welcome window until they have one.)
  for (const w of SUPPORT.filter((s) => s.url)) {
    const b = el("button", "library-support-btn");
    b.type = "button";
    const logo = el("span", "library-support-logo");
    if (w.logo) {
      logo.classList.add("has-logo");
      if (w.tile) logo.style.background = w.tile;
      const img = el("img", "");
      img.src = w.logo;
      img.alt = "";
      img.draggable = false;
      logo.append(img);
    } else logo.innerHTML = w.mark;
    const text = el("span", "library-support-name");
    text.append(el("b", "", w.name), el("span", "", w.url ? w.sub : "Coming soon"));
    b.append(logo, text);
    if (w.tag) {
      const tag = el("span", "library-support-tag");
      tag.innerHTML = w.tag.icon;
      tag.append(w.tag.text);
      b.append(tag);
    }
    if (w.url) {
      b.title = `${w.name} - opens in a new tab`;
      b.addEventListener("click", () => openSupport(w.url));
    } else b.disabled = true;
    row.append(b);
  }
  box.append(row);
  return box;
}

const FULL =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/></svg>';
const UNFULL =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4v5H4M20 9h-5V4M15 20v-5h5M4 15h5v5"/></svg>';

export interface LibraryOptions {
  /** The app's opening: a welcome and a few words on it. */
  welcome?: boolean;
  /** A Full screen button (null: not offered). */
  fullscreen?: { isFull(): boolean; toggle(): void } | null;
}

/** The page already fills the screen (the browser's own full screen, or an app window that has it all). */
function wholeScreen(): boolean {
  return matchMedia("(display-mode: fullscreen)").matches || (Math.abs(innerWidth - screen.width) < 2 && Math.abs(innerHeight - screen.height) < 2);
}

export function showLibrary(entries: LibraryEntry[], currentId: string | null, act: LibraryActions, opts: LibraryOptions = {}): void {
  const back = el("div", "dialog-back");
  const box = el("div", "dialog library");
  if (opts.welcome) box.classList.add("welcome");
  const head = el("div", "library-head");
  head.append(el("div", "panel-title", opts.welcome ? "Welcome to supergeometry.app" : "Projects"));
  // No projects yet: New project is the way in.
  const newBtn = el("button", entries.length ? "text-btn" : "text-btn primary", "New project");
  newBtn.type = "button";
  newBtn.title = "Start an empty project (the open one stays here)";
  const fileBtn = el("button", entries.length ? "text-btn primary" : "text-btn", "Open file…");
  fileBtn.type = "button";
  fileBtn.title = "Open a .super file from this device or elsewhere";
  const closeBtn = el("button", "icon-btn library-close");
  closeBtn.type = "button";
  closeBtn.title = "Close";
  closeBtn.innerHTML = icons.close;
  // Full screen: the window stays (pick a project next); the button follows the state.
  let fsBtn: HTMLButtonElement | null = null;
  const fs = opts.fullscreen;
  const paintFull = () => {
    if (!fsBtn || !fs) return;
    const on = fs.isFull();
    fsBtn.innerHTML = on ? UNFULL : FULL;
    // (Phones show the icon alone.)
    fsBtn.append(el("span", "library-full-text", on ? "Exit full screen" : "Full screen"));
    fsBtn.title = on ? "Exit full screen" : "Full screen";
    // The welcome points it out (it pulses) until the app has the whole
    // screen - from this button, or the browser's own full screen (F11).
    fsBtn.classList.toggle("pulse", !!opts.welcome && !on && !wholeScreen());
  };
  if (fs) {
    fsBtn = el("button", "text-btn library-full");
    fsBtn.type = "button";
    fsBtn.addEventListener("click", () => fs.toggle());
    paintFull();
    head.append(fsBtn);
  }
  head.append(newBtn, fileBtn, closeBtn);
  box.append(head);
  if (opts.welcome) {
    box.append(
      el(
        "div",
        "library-welcome",
        "A free parametric, history-based 3D CAD app for every device: sketch an idea, turn it into a solid part and take it wherever it's going next. Everything stays on this device only.",
      ),
    );
    if (entries.length) box.append(el("div", "library-section", "Your projects"));
  }

  const grid = el("div", "library-grid");
  const close = () => {
    back.remove();
    window.removeEventListener("keydown", onKey, true);
    document.removeEventListener("fullscreenchange", paintFull);
    document.removeEventListener("webkitfullscreenchange", paintFull);
    window.removeEventListener("resize", paintFull);
  };
  document.addEventListener("fullscreenchange", paintFull);
  document.addEventListener("webkitfullscreenchange", paintFull);
  window.addEventListener("resize", paintFull);
  const onKey = (e: KeyboardEvent) => {
    // A question asked over it (Delete?) has the keys.
    if (back.nextElementSibling?.classList.contains("dialog-back")) return;
    if (e.key === "Escape") (e.preventDefault(), close());
    e.stopPropagation();
  };
  fileBtn.addEventListener("click", () => (close(), act.openFile()));
  newBtn.addEventListener("click", () => (close(), act.newProject()));
  closeBtn.addEventListener("click", close);

  const empty = () => {
    if (grid.querySelector(".library-card")) return;
    grid.classList.add("empty");
    grid.replaceChildren(el("div", "library-empty", "No projects here yet. The one you're working on is kept here as soon as it has something in it."));
  };
  for (const e of entries) {
    const card = el("div", "library-card");
    const isOpen = e.id === currentId;
    if (isOpen) card.classList.add("current");
    const pic = el("button", "library-pic");
    pic.type = "button";
    pic.title = isOpen ? "Open now" : `Open “${e.name}”`;
    if (e.thumb) {
      const img = el("img", "");
      img.src = e.thumb;
      img.alt = "";
      img.draggable = false;
      pic.append(img);
    } else pic.innerHTML = icons.body;
    if (isOpen) pic.append(el("span", "library-badge", "Open now"));
    pic.addEventListener("click", () => {
      close();
      if (!isOpen) act.open(e.id);
    });
    const info = el("div", "library-info");
    const text = el("div", "library-text");
    const nameEl = el("div", "library-name", e.name);
    nameEl.title = e.name;
    text.append(nameEl, el("div", "library-date", when(e.modified)));
    const ren = el("button", "icon-btn");
    ren.type = "button";
    ren.title = "Rename";
    ren.innerHTML = icons.rename;
    ren.addEventListener("click", async () => {
      const name = await act.rename(e.id, e.name);
      if (!name) return;
      e.name = name;
      nameEl.textContent = nameEl.title = name;
      pic.title = isOpen ? "Open now" : `Open “${name}”`;
    });
    const dl = el("button", "icon-btn");
    dl.type = "button";
    dl.title = "Save as a .super file";
    dl.innerHTML = DOWNLOAD;
    dl.addEventListener("click", () => act.download(e.id));
    info.append(text, ren, dl);
    if (!isOpen) {
      const del = el("button", "icon-btn danger");
      del.type = "button";
      del.title = "Delete from this device";
      del.innerHTML = icons.trash;
      twoTap(del, `library:${e.id}`, async () => {
        await act.remove(e.id);
        card.remove();
        empty();
      });
      info.append(del);
    }
    card.append(pic, info);
    grid.append(card);
  }
  empty();
  // A mouse wheel turned up and down moves the row side to side.
  grid.addEventListener(
    "wheel",
    (ev) => {
      if (Math.abs(ev.deltaX) >= Math.abs(ev.deltaY) || grid.scrollWidth <= grid.clientWidth) return;
      ev.preventDefault();
      grid.scrollLeft += ev.deltaY;
    },
    { passive: false },
  );
  grid.dataset.ownBar = "";
  box.append(grid);
  box.append(supportBox());
  box.append(el("div", "dialog-note library-note", "Clearing this site's data in the browser's settings deletes your projects - save the ones that matter as files too."));
  back.append(box);
  back.addEventListener("pointerdown", (ev) => ev.target === back && close());
  window.addEventListener("keydown", onKey, true);
  document.body.append(back);
}
