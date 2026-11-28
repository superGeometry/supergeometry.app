// A project as a web file: a small page with the project inside it. Opened on any device it opens a browser, and
// its one button opens the app with the project in it (page to app, in the browser: nothing is uploaded). For
// passing a project to someone who has never used the app - a .super file means nothing to their device, a page does.
//
// The project is in the page squeezed and written in letters and digits (`packed`). How it gets to the app:
//  - a project that is not big: in the address itself, after the "#" (that part of an address is never sent to
//    a server). The button is a plain link - it works in every browser, and in the browsers inside chat apps.
//  - a big one (files brought in, pictures): the page opens `<app>/#receive` in a new tab; the app, started that
//    way, says "ready" to the page that opened it, and the page answers with the project.
// Either way the app opens it as a project of its own, checked and read exactly as a file chosen by hand.

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Longer than this (packed), a project does not go in an address: some browsers cut long ones short. */
const IN_ADDRESS = 300_000;

async function through(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream as unknown as TransformStream<Uint8Array, Uint8Array>));
  return new Uint8Array(await out.arrayBuffer());
}

/** A project's text squeezed, in the letters an address may hold. */
export async function pack(json: string): Promise<string> {
  const z = await through(new TextEncoder().encode(json), new CompressionStream("deflate-raw"));
  let s = "";
  for (let i = 0; i < z.length; i += 0x8000) s += String.fromCharCode(...z.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** And back. Throws on what is not a packed project. */
export async function unpack(packed: string): Promise<string> {
  if (!/^[A-Za-z0-9_-]+$/.test(packed)) throw new Error("This link does not hold a project");
  const s = atob(packed.replace(/-/g, "+").replace(/_/g, "/"));
  const z = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) z[i] = s.charCodeAt(i);
  return new TextDecoder().decode(await through(z, new DecompressionStream("deflate-raw")));
}

/** The page (its text): `name` the project's name, `json` the project as saved, `app` the app's address (its origin). */
export async function webFile(name: string, json: string, app: string): Promise<string> {
  const packed = await pack(json);
  const host = app.replace(/^https?:\/\//, "");
  const small = packed.length <= IN_ADDRESS;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(name)} - superGeometry.app</title>
<style>
  html, body { height: 100%; margin: 0; }
  body { display: grid; place-items: center; background: #1f2125; color: #e8eaee; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 420px; padding: 24px; text-align: center; }
  h1 { font-size: 22px; margin: 0 0 6px; overflow-wrap: anywhere; }
  p { color: #a4abb8; margin: 6px 0; }
  #go { display: inline-block; margin: 18px 0 8px; padding: 12px 22px; border: 0; border-radius: 10px; background: #3d8bff; color: #fff; font: inherit; font-weight: 600; cursor: pointer; text-decoration: none; }
  #go:hover { background: #5a9dff; }
  .app b { color: #e8eaee; } .app span { color: #3d8bff; }
</style>
</head>
<body>
<main>
  <p class="app"><b>superGeometry</b><span>.app</span> project</p>
  <h1>${esc(name)}</h1>
  <p>A 3D model with its whole history. It opens in your browser, in a free app: no account, nothing to install, and nothing is uploaded.</p>
  ${small ? `<a id="go" href="${esc(app)}/#p=${packed}">Open in ${esc(host)}</a>` : `<button id="go" type="button">Open in ${esc(host)}</button>`}
  <p id="say"></p>
</main>
${
  small
    ? ""
    : `<script>
(function () {
  var APP = ${JSON.stringify(app)};
  var packed = "${packed}";
  var say = function (t) { document.getElementById("say").textContent = t; };
  var win = null;
  window.addEventListener("message", function (e) {
    if (e.origin !== APP || !win || e.source !== win || !e.data || e.data.sg !== "ready") return;
    win.postMessage({ sg: "project", packed: packed }, APP);
    say("Opened in the other tab. You can close this one.");
  });
  document.getElementById("go").addEventListener("click", function () {
    win = window.open(APP + "/#receive", "_blank");
    say(win ? "Opening..." : "Your browser blocked the new tab. Allow pop-ups for this page, then tap the button again.");
  });
})();
</script>`
}
</body>
</html>
`;
}
