import "./style.css";
import { App } from "./app";
import { outerScrollbars } from "./ui/scrollbars";

// Scroll bars outside the windows, only while scrolling.
outerScrollbars();

const app = new App(document.getElementById("view") as HTMLCanvasElement);
// Handy for debugging from the console.
(window as unknown as { supergeometry: App }).supergeometry = app;
