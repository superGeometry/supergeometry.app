// Typing boxes that aren't form fields. A phone's browser hangs its autofill
// bar (passwords, cards, addresses) over the screen for every input it sees,
// whatever autocomplete says; editable text gets none. And a finger never gets
// the whole text selected for it: that brought up the phone's Cut / Copy bar.

/** A mouse (or a trackpad) points: selecting all to type over is fine there. */
const fine = () => matchMedia("(pointer: fine)").matches;

/** A typing box made by `textField`: it reads and writes like an input. */
export interface TextField extends HTMLElement {
  value: string;
  placeholder: string;
  /** At most this many characters (0: any). */
  maxLength: number;
  select(): void;
}

/**
 * The whole text, ready to be typed over - with a mouse; a finger gets the
 * caret at the end instead.
 */
export function selectAll(box: HTMLElement): void {
  if (box instanceof HTMLInputElement || box instanceof HTMLTextAreaElement) {
    if (fine()) return box.select();
    const n = box.value.length;
    try {
      box.setSelectionRange(n, n);
    } catch {
      // (not a text box)
    }
    return;
  }
  const r = document.createRange();
  r.selectNodeContents(box);
  if (!fine()) r.collapse(false);
  const s = getSelection();
  s?.removeAllRanges();
  s?.addRange(r);
}

/** The caret at the end of a box's text. */
export function caretToEnd(box: HTMLElement): void {
  if (box instanceof HTMLInputElement || box instanceof HTMLTextAreaElement) {
    const n = box.value.length;
    return box.setSelectionRange(n, n);
  }
  const r = document.createRange();
  r.selectNodeContents(box);
  r.collapse(false);
  const s = getSelection();
  s?.removeAllRanges();
  s?.addRange(r);
}

/** The caret sits at the end of the box's text (nothing selected). */
export function caretAtEnd(box: HTMLElement): boolean {
  if (box instanceof HTMLInputElement || box instanceof HTMLTextAreaElement) return box.selectionStart === box.value.length && box.selectionEnd === box.value.length;
  const s = getSelection();
  if (!s || !s.rangeCount || !s.isCollapsed || !box.contains(s.anchorNode)) return false;
  const r = document.createRange();
  r.selectNodeContents(box);
  r.setStart(s.anchorNode!, s.anchorOffset);
  return r.toString() === "";
}

/**
 * A one-line typing box (or several lines: `multiline`). It has an input's
 * value, placeholder, maxLength and select(); "input" fires as it's typed and
 * "change" when it's left changed, as an input's do. Enter stays out of a
 * one-line box (its own keydown handlers still see it), and a paste comes in
 * as plain text.
 */
export function textField(className = "", opts: { multiline?: boolean } = {}): TextField {
  const multi = !!opts.multiline;
  const f = document.createElement(multi ? "div" : "span") as unknown as TextField;
  f.className = `text-field${multi ? " multiline" : ""}${className ? ` ${className}` : ""}`;
  f.contentEditable = "plaintext-only";
  if (f.contentEditable !== "plaintext-only") f.contentEditable = "true";
  f.setAttribute("role", "textbox");
  if (multi) f.setAttribute("aria-multiline", "true");
  f.tabIndex = 0;
  f.spellcheck = false;
  let max = 0;
  const read = () => {
    const t = multi ? f.innerText : (f.textContent ?? "");
    return multi ? t.replace(/\n$/, "") : t.replace(/\s*\n\s*/g, " ");
  };
  Object.defineProperties(f, {
    value: {
      get: read,
      set: (v: string) => {
        f.textContent = String(v ?? "");
      },
    },
    placeholder: {
      get: () => f.dataset.placeholder ?? "",
      set: (v: string) => {
        if (v) f.dataset.placeholder = v;
        else delete f.dataset.placeholder;
      },
    },
    maxLength: {
      get: () => max,
      set: (v: number) => {
        max = Math.max(0, v | 0);
      },
    },
    select: { value: () => selectAll(f) },
  });
  f.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !multi) e.preventDefault();
  });
  f.addEventListener("paste", (e) => {
    e.preventDefault();
    let t = e.clipboardData?.getData("text/plain") ?? "";
    if (!multi) t = t.replace(/\s+/g, " ");
    document.execCommand("insertText", false, t);
  });
  f.addEventListener("input", () => {
    // Emptied: no stray line break left (the placeholder shows again).
    if (!read() && f.childNodes.length) f.textContent = "";
    if (max && read().length > max) {
      f.textContent = read().slice(0, max);
      caretToEnd(f);
    }
  });
  // "change" on leaving it changed, as an input does.
  let before = "";
  f.addEventListener("focus", () => (before = read()));
  f.addEventListener("blur", () => {
    if (read() !== before) f.dispatchEvent(new Event("change", { bubbles: true }));
  });
  return f;
}
