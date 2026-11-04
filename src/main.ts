import "./style.css";
import { App } from "./app";

const app = new App(document.getElementById("view") as HTMLCanvasElement);
// Handy for debugging from the console.
(window as unknown as { supergeometry: App }).supergeometry = app;
