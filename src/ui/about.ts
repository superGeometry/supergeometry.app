// More → About: the README (the one on GitHub), shown in the app. Built into
// the app (it's the same file), less the lines that only make sense on GitHub.

import readme from "../../README.md?raw";
import { icons } from "./icons";
import { el } from "./ui";

const REPO = "https://github.com/superGeometry/supergeometry.app";

/** Not shown: the link to open the app (you're in it) and the developer docs. */
function aboutText(): string {
  return readme
    .split(/\r?\n/)
    .filter((l) => !/^👉\s*\*\*Open it/.test(l) && !/docs\/(ARCHITECTURE|FEATURES)\.md/.test(l))
    .join("\n");
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Heading text → the id GitHub gives it (for the Contents links). */
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s/g, "-");

/** **bold**, *italic*, `code`, [links](...) - in already escaped text. */
function inline(s: string): string {
  const codes: string[] = [];
  let t = esc(s).replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  t = t
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*/g, "$1<i>$2</i>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, url) => {
      if (url.startsWith("#")) return `<a href="${url}" data-anchor="${url.slice(1)}">${text}</a>`;
      const href = /^https?:/.test(url) ? url : `${REPO}/blob/main/${url}`;
      return `<a href="${href}" target="_blank" rel="noopener">${text}</a>`;
    });
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
}

/** The README's own kind of Markdown: headings, paragraphs, lists, tables, code blocks, rules. */
function render(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) {
      const code: string[] = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) code.push(lines[i]);
      i++;
      out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
      continue;
    }
    const h = l.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const n = h[1].length;
      out.push(`<h${n} id="${slug(h[2])}">${inline(h[2])}</h${n}>`);
      i++;
      continue;
    }
    if (/^---+\s*$/.test(l)) {
      out.push("<hr>");
      i++;
      continue;
    }
    if (/^\|/.test(l)) {
      const rows: string[][] = [];
      for (; i < lines.length && /^\|/.test(lines[i]); i++) {
        const cells = lines[i].replace(/^\||\|\s*$/g, "").split("|").map((c) => c.trim());
        if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
        rows.push(cells);
      }
      const [head, ...body] = rows;
      out.push(
        `<div class="about-table"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${body
          .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
          .join("")}</tbody></table></div>`,
      );
      continue;
    }
    const item = /^(\s*)([-*]|\d+\.)\s+/;
    if (item.test(l)) {
      const ordered = /^\s*\d+\./.test(l);
      const items: string[] = [];
      while (i < lines.length && item.test(lines[i])) {
        let text = lines[i].replace(item, "");
        // Its wrapped lines (indented, not a new item).
        for (i++; i < lines.length && /^\s+\S/.test(lines[i]) && !item.test(lines[i]); i++) text += " " + lines[i].trim();
        items.push(`<li>${inline(text)}</li>`);
      }
      out.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
      continue;
    }
    if (!l.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    for (; i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\||---+\s*$)/.test(lines[i]) && !item.test(lines[i]); i++) para.push(lines[i].trim());
    out.push(`<p>${inline(para.join(" "))}</p>`);
  }
  return out.join("\n");
}

export function showAbout(): void {
  const back = el("div", "dialog-back");
  const box = el("div", "dialog about");
  const head = el("div", "library-head");
  head.append(el("div", "panel-title", "About"));
  const closeBtn = el("button", "icon-btn library-close");
  closeBtn.type = "button";
  closeBtn.title = "Close";
  closeBtn.innerHTML = icons.close;
  head.append(closeBtn);
  const body = el("div", "about-body");
  body.innerHTML = render(aboutText());
  // The name at the top opens the project's page on GitHub.
  const name = body.querySelector("h1");
  if (name) {
    const link = document.createElement("a");
    link.href = REPO;
    link.target = "_blank";
    link.rel = "noopener";
    link.title = "Open the project on GitHub";
    link.append(...name.childNodes);
    // (GitHub's mark beside it: where the name leads.)
    const mark = document.createElement("span");
    mark.className = "about-github";
    mark.innerHTML =
      '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>';
    link.append(mark);
    name.append(link);
  }
  // The Contents links scroll within the window.
  body.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest<HTMLAnchorElement>("a[data-anchor]");
    if (!a) return;
    e.preventDefault();
    body.querySelector(`#${CSS.escape(a.dataset.anchor!)}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  box.append(head, body);
  back.append(box);
  const close = () => {
    back.remove();
    window.removeEventListener("keydown", onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") (e.preventDefault(), close());
    e.stopPropagation();
  };
  closeBtn.addEventListener("click", close);
  back.addEventListener("pointerdown", (ev) => ev.target === back && close());
  window.addEventListener("keydown", onKey, true);
  document.body.append(back);
}
