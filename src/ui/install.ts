// "Add to your home screen": on phones and tablets the app offers, once in a
// while, to be installed like an app (its own icon, full screen, no browser
// bars). Android / Chrome show their own install dialog; on iPhone and iPad
// Safari it's done from the Share menu, so the notice says how. Saying "Not
// now" keeps it quiet for a month; More → Install app is always there.

import { isTouchDevice } from "../device";
import { el } from "./ui";

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const KEY = "supergeometry.install.v1";
const QUIET_DAYS = 30;

/** Already running as an installed app? */
export function isInstalled(): boolean {
  return matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
}

/** iPhone / iPad (iPadOS says it's a Mac, but has touch). */
function isIOS(): boolean {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

export class Install {
  private deferred: InstallPromptEvent | null = null;
  private banner = el("div", "update-banner install-banner");

  constructor(private toast: (t: string) => void) {
    this.banner.hidden = true;
    this.banner.addEventListener("pointerdown", (e) => e.stopPropagation());
    document.body.append(this.banner);
    window.addEventListener("beforeinstallprompt", (e) => {
      // Keep the browser's own mini bar away: we ask at a better moment.
      e.preventDefault();
      this.deferred = e as InstallPromptEvent;
    });
    window.addEventListener("appinstalled", () => {
      this.deferred = null;
      this.banner.hidden = true;
    });
    // Phones and tablets, a little after starting (not over the first look around).
    if (isTouchDevice && !isInstalled() && !this.quiet()) setTimeout(() => this.offer(), 45_000);
  }

  /** Can it be offered here at all (for the More menu)? */
  get available(): boolean {
    return !isInstalled() && (!!this.deferred || isIOS() || isTouchDevice);
  }

  private quiet(): boolean {
    try {
      const t = Number(localStorage.getItem(KEY) ?? 0);
      return Date.now() - t < QUIET_DAYS * 86_400_000;
    } catch {
      return false;
    }
  }

  private later(): void {
    try {
      localStorage.setItem(KEY, String(Date.now()));
    } catch {
      // private mode: it may ask again next time
    }
    this.banner.hidden = true;
  }

  /** The notice: Install / Not now (or, on iOS, how to do it). */
  offer(fromMenu = false): void {
    if (isInstalled()) return void (fromMenu && this.toast("supergeometry.app is already installed on this device"));
    this.banner.innerHTML = "";
    const ios = isIOS() && !this.deferred;
    if (!ios && !this.deferred) {
      // Nothing to show yet (the browser hasn't offered it, or doesn't do installs).
      if (fromMenu) this.toast("Use your browser's menu → “Install app” or “Add to Home screen”");
      return;
    }
    const text = el(
      "span",
      "",
      ios
        ? "Add supergeometry.app to your Home Screen: tap Share (the square with the arrow), then “Add to Home Screen”."
        : "Install supergeometry.app on this device? It opens like an app, full screen.",
    );
    const yes = el("button", "text-btn primary", ios ? "Got it" : "Install");
    yes.addEventListener("click", () => void this.accept(ios));
    const no = el("button", "text-btn", "Not now");
    no.addEventListener("click", () => this.later());
    this.banner.append(text, yes, no);
    this.banner.hidden = false;
  }

  private async accept(ios: boolean): Promise<void> {
    this.banner.hidden = true;
    if (ios || !this.deferred) return this.later();
    const ev = this.deferred;
    this.deferred = null;
    await ev.prompt();
    const { outcome } = await ev.userChoice;
    if (outcome !== "accepted") this.later();
  }
}
