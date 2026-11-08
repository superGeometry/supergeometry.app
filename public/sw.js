// Offline mode (More → Offline mode). Registered only while it's on.
//
// The page asks it to download the app's files (the list the build writes,
// offline-files.json) into one store per version. Files are then served from
// that store, so the app opens and works with no connection. The page itself
// is fetched from the site first while online (so a new version shows up),
// and from the store when there's no connection.

const PREFIX = "sg-offline-";
const scope = self.registration.scope;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

async function tell(msg) {
  for (const c of await self.clients.matchAll({ includeUncontrolled: true })) c.postMessage(msg);
}

let running = null;

/** Store every file of the site's current version. `keep`: the version the open page runs (not removed). */
async function download(fresh, keep) {
  let list;
  try {
    list = await (await fetch(new URL("offline-files.json", scope).href, { cache: "no-store" })).json();
  } catch {
    await tell({ type: "offline-failed", reason: "offline" });
    return;
  }
  const name = PREFIX + list.build;
  if (fresh) await caches.delete(name);
  const store = await caches.open(name);
  let done = 0;
  try {
    for (const f of list.files) {
      const url = new URL(f, scope).href;
      if (!(await store.match(url))) {
        // A file an older version already has (the same name means the same contents) is copied over.
        const same = f !== "./" && f !== "index.html" && !fresh ? await caches.match(url, { ignoreVary: true }) : null;
        const res = same ?? (await fetch(url, { cache: "no-cache" }));
        if (!res.ok) throw new Error(String(res.status));
        await store.put(url, res);
      }
      done++;
      await tell({ type: "offline-progress", done, total: list.files.length });
    }
  } catch {
    await tell({ type: "offline-failed", reason: "network" });
    return;
  }
  for (const k of await caches.keys()) if (k.startsWith(PREFIX) && k !== name && k !== PREFIX + keep) await caches.delete(k);
  await tell({ type: "offline-ready", build: list.build });
}

self.addEventListener("message", (e) => {
  if (e.data?.type !== "download") return;
  running ??= download(!!e.data.fresh, e.data.keep).finally(() => (running = null));
  e.waitUntil(running);
});

/** The page from the store (the newest version stored). */
async function storedPage() {
  const names = (await caches.keys()).filter((k) => k.startsWith(PREFIX));
  for (const n of names.reverse()) {
    const hit = (await (await caches.open(n)).match(scope)) ?? (await (await caches.open(n)).match(new URL("index.html", scope).href));
    if (hit) return hit;
  }
  return Response.error();
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  // The update check always asks the site.
  if (url.searchParams.has("check") || url.pathname.endsWith("offline-files.json")) return;
  if (req.mode === "navigate") {
    // Online: the site's page (a new version shows up). Offline or very slow: the stored one.
    e.respondWith(
      new Promise((resolve) => {
        let settled = false;
        const fallback = () => {
          if (settled) return;
          settled = true;
          storedPage().then(resolve);
        };
        const timer = setTimeout(fallback, 6000);
        fetch(req)
          .then((res) => {
            clearTimeout(timer);
            if (settled) return;
            settled = true;
            resolve(res);
          })
          .catch(() => {
            clearTimeout(timer);
            fallback();
          });
      }),
    );
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true, ignoreVary: true }).then((hit) => hit ?? fetch(req)));
});
