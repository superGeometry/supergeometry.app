// File → Open: the projects kept on this device, as a gallery of pictures.
// Tap one to open it; Open file… still takes any .super file.

import type { LibraryEntry } from "../doc/library";
import { icons } from "./icons";
import { el, twoTap } from "./ui";

export interface LibraryActions {
  open(id: string): void;
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

export function showLibrary(entries: LibraryEntry[], currentId: string | null, act: LibraryActions): void {
  const back = el("div", "dialog-back");
  const box = el("div", "dialog library");
  const head = el("div", "library-head");
  head.append(el("div", "panel-title", "Projects"));
  const fileBtn = el("button", "text-btn primary", "Open file…");
  fileBtn.type = "button";
  fileBtn.title = "Open a .super file from this device or elsewhere";
  const closeBtn = el("button", "icon-btn library-close");
  closeBtn.type = "button";
  closeBtn.title = "Close";
  closeBtn.innerHTML = icons.close;
  head.append(fileBtn, closeBtn);
  box.append(head);

  const grid = el("div", "library-grid");
  const close = () => {
    back.remove();
    window.removeEventListener("keydown", onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    // A question asked over it (Delete?) has the keys.
    if (back.nextElementSibling?.classList.contains("dialog-back")) return;
    if (e.key === "Escape") (e.preventDefault(), close());
    e.stopPropagation();
  };
  fileBtn.addEventListener("click", () => (close(), act.openFile()));
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
  box.append(el("div", "dialog-note library-note", "Kept in this browser on this device (Update keeps them). Clearing this site's data in the browser's settings deletes them - save the ones that matter as files too."));
  back.append(box);
  back.addEventListener("pointerdown", (ev) => ev.target === back && close());
  window.addEventListener("keydown", onKey, true);
  document.body.append(back);
}
