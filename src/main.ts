import "./style.css";
import { App } from "./app";
import { outerScrollbars } from "./ui/scrollbars";

// Update reloads with ?v=<time> so no stored copy is used; once loaded, the
// address is plain again (it's what people copy to share the app).
{
  const url = new URL(location.href);
  if (url.searchParams.has("v")) {
    url.searchParams.delete("v");
    history.replaceState(history.state, "", url.pathname + url.search + url.hash);
  }
}

// Scroll bars outside the windows, only while scrolling.
outerScrollbars();

const app = new App(document.getElementById("view") as HTMLCanvasElement);
// Handy for debugging from the console.
(window as unknown as { supergeometry: App }).supergeometry = app;
