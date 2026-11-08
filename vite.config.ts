import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { defineConfig, type Plugin } from "vite";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

/**
 * Offline mode's download list: every file the app needs, and the build it
 * belongs to (the main script's name), written into dist/offline-files.json.
 */
function offlineFiles(): Plugin {
  let outDir = "dist";
  return {
    name: "offline-files",
    apply: "build",
    configResolved(c) {
      outDir = c.build.outDir;
    },
    closeBundle() {
      const skip = new Set(["_headers", "robots.txt", "sitemap.xml", "og-image.png", "sw.js", "offline-files.json"]);
      const files: string[] = [];
      const walk = (dir: string) => {
        for (const n of readdirSync(dir)) {
          const p = join(dir, n);
          if (statSync(p).isDirectory()) walk(p);
          else {
            const rel = relative(outDir, p).replace(/\\/g, "/");
            if (!skip.has(rel)) files.push(rel);
          }
        }
      };
      walk(outDir);
      const html = readFileSync(join(outDir, "index.html"), "utf8");
      const build = html.match(/index-[\w-]+\.js/)?.[0] ?? String(Date.now());
      // The page under its address too (that's what the browser asks for).
      writeFileSync(join(outDir, "offline-files.json"), JSON.stringify({ build, files: ["./", ...files.sort()] }));
    },
  };
}

export default defineConfig({
  // Relative base so the build works from any static host sub-path (GitHub Pages etc.).
  base: "./",
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  worker: { format: "es" },
  optimizeDeps: { exclude: ["replicad-opencascadejs"] },
  build: { target: "es2022", chunkSizeWarningLimit: 4000 },
  plugins: [offlineFiles()],
});
