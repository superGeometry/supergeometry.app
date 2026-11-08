// More → Feedback: a bug report, a suggestion or a discussion, posted on the
// app's subreddit. The app has no server and no account, so it can't post by
// itself: it opens Reddit's own "new post" page in a new tab with the title
// and the text filled in, and the person posts it there (signed in to Reddit).
// What goes along: what's typed here, a short line with the app version and
// the browser if left on and, on a bug report, the project's file (a .super
// file is JSON) as a code block if left on. A file too long for Reddit's
// address is copied instead, for pasting into the post.

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
/** The longest address sent to Reddit (its servers turn away much longer ones). */
const MAX_URL = 7000;
/** The longest text a Reddit post takes. */
const MAX_POST = 40000;
/** Where a copied file goes in the post. */
const PASTE_HERE = "(paste the copied file here)";

/** The open project, as its .super file. */
export interface FeedbackProject {
  name: string;
  json: string;
}

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

/** The file as a code block in the post (Reddit's Markdown). */
function codeBlock(p: FeedbackProject): string {
  return "```json\n" + p.json + "\n```";
}

/** Copies text; it must run inside the tap (a browser only allows it there). */
function copyText(t: string): boolean {
  const ta = document.createElement("textarea");
  ta.value = t;
  ta.readOnly = true;
  ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
  document.body.append(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  if (!ok && navigator.clipboard) {
    void navigator.clipboard.writeText(t).catch(() => {});
    ok = true;
  }
  return ok;
}

const sizeText = (n: number) => (n < 1000 ? `${n} characters` : `${Math.round(n / 1000)}k characters`);

/** `project`: the open project's file, offered on a bug report. `toast`: a short message. */
export function showFeedback(project?: () => FeedbackProject, toast: (t: string) => void = () => {}): void {
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

  // Bug report: the project's file as a code block, so the bug can be opened and seen.
  const file = project?.();
  const fileCode = file ? codeBlock(file) : "";
  /** Not even with an empty description (the head and the version line counted). */
  const neverFits = fileCode.length > MAX_POST - 200;
  const fileRow = el("label", "feedback-info");
  const fileBox = document.createElement("input");
  fileBox.type = "checkbox";
  const fileText = el("span", "");
  const fileHow = el("span", "feedback-how");
  if (file) {
    fileText.append("Add this project's file as code: ", el("code", "", `${file.name}.super`), ` (${sizeText(file.json.length)}). Anyone who reads the post can open it.`);
    if (neverFits) {
      fileBox.disabled = true;
      fileHow.textContent = " Too big for a Reddit post (it takes 40,000 characters at most).";
    }
    fileText.append(fileHow);
  }
  fileRow.append(fileBox, fileText);

  list.append(kinds, titleField, textField, info, fileRow);

  const row = el("div", "panel-buttons");
  const close = () => {
    back.remove();
    window.removeEventListener("keydown", onKey, true);
  };
  row.append(textButton("Cancel", "Esc", close));
  const post = textButton("Open Reddit", "", () => send(), true);
  const postLabel = post.firstChild as Text;
  post.insertAdjacentHTML("beforeend", '<span class="feedback-out" aria-hidden="true">↗</span>');
  row.append(post);
  for (const b of row.querySelectorAll("button")) b.type = "button";

  const tag = () => KINDS.find((k) => k.id === kind)!.tag;
  /** The post's text, without the file. */
  const bodyText = () => {
    let body = text.value.trim().slice(0, MAX_TEXT);
    if (infoBox.checked) body += `${body ? "\n\n" : ""}---\n${infoLine()}`;
    return body;
  };
  const fileHead = (body: string) => `${body ? "\n\n" : ""}Project file (\`${file!.name}.super\`):\n\n`;
  const withFile = () => !!file && kind === "bug" && fileBox.checked;
  /** The whole post with the file in it fits Reddit's 40,000 characters (the description counts too). */
  const postFits = () => {
    const body = bodyText();
    return (body + fileHead(body) + fileCode).length <= MAX_POST;
  };
  /** The file fits in the address (filled in); longer, it's copied for pasting. */
  const fileFits = () => {
    const body = bodyText();
    return submitUrl(`[${tag()}] ${title.value.trim()}`, body + fileHead(body) + fileCode).length <= MAX_URL;
  };

  const paint = () => {
    const over = withFile() && !postFits();
    post.disabled = !title.value.trim() || over;
    const copy = withFile() && !over && !fileFits();
    postLabel.textContent = copy ? "Copy file and open Reddit" : "Open Reddit";
    if (file && !neverFits)
      fileHow.textContent = !withFile()
        ? ""
        : over
          ? ` With this description the post is over Reddit's 40,000 characters: shorten it by ${(bodyText().length + fileHead(bodyText()).length + fileCode.length - MAX_POST).toLocaleString("en")} characters, or untick the file.`
          : copy
            ? " Too long to fill in: it's copied, paste it into the post where it says so."
            : "";
  };
  title.addEventListener("input", paint);
  text.addEventListener("input", paint);
  infoBox.addEventListener("change", paint);
  fileBox.addEventListener("change", paint);

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
    // The file: only on a bug report, on by default there.
    fileRow.hidden = !file || id !== "bug";
    fileBox.checked = !!file && !neverFits && id === "bug";
    paint();
  };

  const send = () => {
    const t = title.value.trim();
    if (!t) return void title.focus();
    if (withFile() && !postFits()) return;
    let body = bodyText();
    if (withFile()) {
      if (fileFits()) body += fileHead(body) + fileCode;
      else {
        if (!copyText(fileCode)) return void toast("Couldn't copy the file: try again, or post without it");
        body += fileHead(body) + PASTE_HERE;
      }
    }
    openSupport(submitUrl(`[${tag()}] ${t}`, body));
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
