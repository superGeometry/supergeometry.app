// Newer version available? The page checks the site now and then (and when
// you come back to it); if a new build is out, a notice offers to update.
// Updating - or More → Reset cache - clears the browser's stored copies of
// the app's files and reloads. Your project is saved first and stays.

import { el } from "./ui";

/** The app's main script of this page (its name changes with every build). */
function loadedBuild(): string | null {
  const s = [...document.querySelectorAll<HTMLScriptElement>("script[src]")].map((x) => x.src).find((src) => /\/assets\/index-[\w-]+\.js/.test(src));
  return s ? (s.match(/index-[\w-]+\.js/)?.[0] ?? null) : null;
}

async function liveBuild(): Promise<string | null> {
  try {
    const res = await fetch(`/?check=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.text()).match(/index-[\w-]+\.js/)?.[0] ?? null;
  } catch {
    return null; // offline: nothing to say
  }
}

export class Updates {
  private banner = el("div", "update-banner");
  private shownFor: string | null = null;

  /** `beforeReload` saves the project before the page is reloaded. */
  constructor(private beforeReload: () => Promise<void>) {
    this.banner.hidden = true;
    const text = el("span", "", "New app version available");
    const now = el("button", "text-btn primary", "Update now");
    now.addEventListener("click", () => void this.reset());
    const later = el("button", "text-btn", "Later");
    later.addEventListener("click", () => (this.banner.hidden = true));
    this.banner.append(text, now, later);
    this.banner.addEventListener("pointerdown", (e) => e.stopPropagation());
    document.body.append(this.banner);
    // Only a built site has a build to compare (not the dev server).
    if (!loadedBuild()) return;
    setTimeout(() => void this.check(), 20_000);
    setInterval(() => void this.check(), 10 * 60_000);
    document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && void this.check());
  }

  /** Is a newer build out? Shows the notice (once per build). Returns whether it is. */
  async check(): Promise<boolean> {
    const mine = loadedBuild();
    const live = await liveBuild();
    if (!mine || !live || live === mine) return false;
    if (this.shownFor !== live) {
      this.shownFor = live;
      this.banner.hidden = false;
    }
    return true;
  }

  /**
   * Clear every stored copy of the app's files (Cache Storage, service
   * workers) and reload from the site. The project is saved first.
   */
  async reset(): Promise<void> {
    this.banner.hidden = true;
    await this.beforeReload();
    try {
      if ("caches" in window) for (const k of await caches.keys()) await caches.delete(k);
    } catch {
      // nothing stored
    }
    try {
      for (const r of (await navigator.serviceWorker?.getRegistrations?.()) ?? []) await r.unregister();
    } catch {
      // none
    }
    // A fresh address so no stored copy of the page is used.
    const url = new URL(location.href);
    url.searchParams.set("v", String(Date.now()));
    location.replace(url.toString());
  }
}
