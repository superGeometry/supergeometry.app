// More → Feedback: a bug report, a suggestion or a discussion, posted on the
// app's subreddit. The app has no server and no account, so it can't post by
// itself: it opens Reddit's own "new post" page in a new tab with the title
// and the text filled in, and the person posts it there (signed in to Reddit).
// Nothing from the project goes along - only what's typed here and, if left
// on, a short line with the app version and the browser.

import { icons } from "./icons";
import { el, textButton } from "./ui";
import { openSupport } from "./support";

export const SUBREDDIT = "supergeometry";

type Kind = "bug" | "idea" | "talk";
const KINDS: { id: Kind; label: string; tag: string; title: string; text: string }[] = [
  { id: "bug", label: "Bug report", tag: "Bug", title: "What went wrong, in a few words", text: "What you did, what you expected, and what happened instead." },
  { id: "idea", label: "Suggestion", tag: "Suggestion", title: "What you'd like, in a few words", text: "What it would do and where it would help." },
  { id: "talk", label: "Discussion", tag: "Discussion", title: "The topic", text: "Anything you'd like to talk about." },
];

/** A browser address has a length limit: the text stops well short of it. */
const MAX_TEXT = 4000;

/** "Chrome 131, Android, phone": short, nothing that tells who it is. */
export function deviceLine(): string {
  const ua = navigator.userAgent;
  const browser =
    ua.match(/(Edg|OPR|SamsungBrowser|Firefox|FxiOS|CriOS|Chrome)\/(\d+)/)?.slice(1).join(" ").replace(/^Edg\b/, "Edge").replace(/^OPR\b/, "Opera").replace(/^CriOS\b/, "Chrome").replace(/^FxiOS\b/, "Firefox").replace(/^SamsungBrowser\b/, "Samsung Internet") ??
    (/Safari\//.test(ua) ? `Safari ${ua.match(/Version\/(\d+)/)?.[1] ?? ""}`.trim() : "Browser");
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? "iOS" : /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "macOS" : /CrOS/.test(ua) ? "ChromeOS" : /Linux/.test(ua) ? "Linux" : "";
  const touch = matchMedia("(pointer: coarse)").matches;
  const kind = touch ? (Math.min(screen.width, screen.height) < 600 ? "phone" : "tablet") : "";
  return [browser, os, kind].filter(Boolean).join(", ");
}

export function infoLine(): string {
  return `supergeometry.app ${__APP_VERSION__} · ${deviceLine()}`;
}

/** Reddit's "new text post" page for the subreddit, filled in. */
export function submitUrl(title: string, text: string): string {
  // %20 for spaces, not "+": every reader of the address takes it as a space.
  const q = Object.entries({ title, text, selftext: "true", type: "TEXT" }).map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
  return `https://www.reddit.com/r/${SUBREDDIT}/submit?${q.join("&")}`;
}

export function showFeedback(): void {
  const back = el("div", "dialog-back");
  const box = el("form", "dialog feedback");
  const head = el("div", "library-head");
  head.append(el("div", "panel-title", "Feedback"));
  const closeBtn = el("button", "icon-btn library-close");
  closeBtn.type = "button";
  closeBtn.title = "Close";
  closeBtn.innerHTML = icons.close;
  head.append(closeBtn);

  const list = el("div", "dialog-list");
  list.append(el("div", "dialog-note", `Report a bug, suggest something or start a discussion on r/${SUBREDDIT}. Reddit opens in a new tab with this filled in: sign in there and press Post.`));

  let kind: Kind = "bug";
  const kinds = el("div", "chip-list feedback-kinds");
  kinds.setAttribute("role", "radiogroup");
  const chips = KINDS.map((k) => {
    const c = el("button", "chip", k.label);
    c.type = "button";
    c.setAttribute("role", "radio");
    c.addEventListener("click", () => pick(k.id));
    kinds.append(c);
    return c;
  });

  const titleField = el("label", "dialog-field");
  titleField.append(el("span", "field-label", "Title"));
  const title = document.createElement("input");
  title.maxLength = 280;
  title.autocomplete = "off";
  titleField.append(title);

  const textField = el("label", "dialog-field");
  textField.append(el("span", "field-label", "Description"));
  const text = document.createElement("textarea");
  text.rows = 6;
  text.maxLength = MAX_TEXT;
  textField.append(text);

  const info = el("label", "feedback-info");
  const infoBox = document.createElement("input");
  infoBox.type = "checkbox";
  infoBox.checked = true;
  const infoText = el("span", "");
  infoText.append("Add the app version and browser: ", el("code", "", infoLine()));
  info.append(infoBox, infoText);

  list.append(kinds, titleField, textField, info);

  const pick = (id: Kind) => {
    kind = id;
    const k = KINDS.find((x) => x.id === id)!;
    chips.forEach((c, i) => {
      const on = KINDS[i].id === id;
      c.classList.toggle("on", on);
      c.setAttribute("aria-checked", String(on));
    });
    title.placeholder = k.title;
    text.placeholder = k.text;
    // Version and browser help most with a bug: on for it, off for the others (it can still be ticked).
    infoBox.checked = id === "bug";
    paint();
  };

  const row = el("div", "panel-buttons");
  const close = () => {
    back.remove();
    window.removeEventListener("keydown", onKey, true);
  };
  row.append(textButton("Cancel", "Esc", close));
  const post = textButton("Open Reddit", "", () => send(), true);
  post.insertAdjacentHTML("beforeend", '<span class="feedback-out" aria-hidden="true">↗</span>');
  row.append(post);
  for (const b of row.querySelectorAll("button")) b.type = "button";

  const paint = () => (post.disabled = !title.value.trim());
  title.addEventListener("input", paint);

  const send = () => {
    const t = title.value.trim();
    if (!t) return void title.focus();
    const tag = KINDS.find((k) => k.id === kind)!.tag;
    let body = text.value.trim().slice(0, MAX_TEXT);
    if (infoBox.checked) body += `${body ? "\n\n" : ""}---\n${infoLine()}`;
    openSupport(submitUrl(`[${tag}] ${t}`, body));
    close();
  };

  box.append(head, list, row);
  box.addEventListener("submit", (e) => (e.preventDefault(), send()));
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") (e.preventDefault(), close());
    // Enter in the title sends; in the description it's a new line.
    else if (e.key === "Enter" && e.target === title) (e.preventDefault(), send());
    e.stopPropagation();
  };
  closeBtn.addEventListener("click", close);
  back.addEventListener("pointerdown", (ev) => ev.target === back && close());
  window.addEventListener("keydown", onKey, true);
  back.append(box);
  document.body.append(back);
  pick("bug");
  // Not on a touch screen: its keyboard would cover the window before it's read.
  if (matchMedia("(pointer: fine)").matches) title.focus();
}
