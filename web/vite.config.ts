import { defineConfig } from "vite";

// The display is a single-page app shell (plain TS + Canvas 2D, no framework).
// The protocol lives one dir up and is imported by relative path; Vite bundles it.
//
// `base` is RELATIVE ('./') for builds so the bundle can be loaded from a `file://`
// URL inside the iOS app's WKWebView (the "pure app" finish) — absolute '/assets'
// paths don't resolve off a filesystem root. The dev server keeps the '/' root so
// the fast `?debug=1` browser loop is unaffected.
export default defineConfig(({ command }) => ({
  root: ".",
  base: command === "build" ? "./" : "/",
  server: {
    host: true,
    port: 5173,
  },
  build: {
    target: "es2022",
    outDir: "dist",
    sourcemap: true,
  },
}));
