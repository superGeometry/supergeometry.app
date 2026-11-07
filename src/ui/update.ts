// Newer version available? The page checks the site now and then (and when
// you come back to it); if a new build is out, More pulses and its Update
// item carries a NEW badge - no notice over the work.
// Updating - or More → Update - clears the browser's stored copies of
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
  /** `beforeReload` saves the project before the page is reloaded. */
  constructor(private beforeReload: () => Promise<void>) {
    // Only a built site has a build to compare (not the dev server).
    if (!loadedBuild()) return;
    setTimeout(() => void this.check(), 20_000);
    setInterval(() => void this.check(), 10 * 60_000);
    document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && void this.check());
  }

  /** More pulses; its Update item gets a NEW badge. */
  private markPending(): void {
    document.body.classList.add("update-pending");
    const item = document.getElementById("m-update");
    if (item && !item.querySelector(".new-badge")) item.append(el("span", "new-badge", "NEW"));
  }

  /** Is a newer build out? Marks More if so. Returns whether it is. */
  async check(): Promise<boolean> {
    const mine = loadedBuild();
    const live = await liveBuild();
    if (!mine || !live || live === mine) return false;
    this.markPending();
    return true;
  }

  /**
   * Clear every stored copy of the app's files (Cache Storage, service
   * workers) and reload from the site. The project is saved first.
   */
  async reset(): Promise<void> {
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
