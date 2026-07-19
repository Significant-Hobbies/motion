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
    // Allow the dev server to be reached by the Mac's mDNS name (…​.local) and any
    // LAN host, so a TV/other-device browser (or the phone webview) can load it
    // without Vite's host-check returning 403.
    allowedHosts: true,
  },
  build: {
    target: "es2022",
    outDir: "dist",
    sourcemap: true,
    // No runtime-injected `<link rel=modulepreload crossorigin>` (see the plugin
    // below for why crossorigin is fatal on file://). Single-chunk build anyway.
    modulePreload: false,
  },
  plugins: [
    {
      // CRITICAL for the bundled "pure app": Vite adds `crossorigin` to the emitted
      // <script type=module> (and modulepreload) tags. Over http that's fine, but the
      // iOS app loads the build from a file:// URL in a WKWebView, where `crossorigin`
      // forces a CORS check that FAILS for file: origins — so the module never
      // executes and the game is a blank black screen (no JS, no diagnostics). Strip
      // the attribute from the HTML so the file:// load runs. No effect on the game.
      name: "strip-crossorigin-for-file-url",
      transformIndexHtml(html: string) {
        return html.replace(/\s+crossorigin(?:=(?:"[^"]*"|'[^']*'|\S+))?/g, "");
      },
    },
  ],
}));
