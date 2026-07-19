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
      // CRITICAL for the bundled "pure app": the iOS app loads the build from a file://
      // URL in a WKWebView, which REFUSES to load an external `<script type=module src>`
      // from file: (module fetches use CORS semantics that fail for file origins) — the
      // module never executes and the game is a blank black screen (no JS, no diagnostics).
      // Fix: INLINE the entry chunk straight into index.html. An inline module script has
      // no fetch, so there's no CORS check and it runs from file://. Only applies to the
      // build (ctx.bundle present); the http dev server is untouched.
      name: "inline-entry-for-file-url",
      enforce: "post",
      transformIndexHtml(html: string, ctx: { bundle?: Record<string, { type: string; code?: string }> }) {
        const bundle = ctx.bundle;
        if (!bundle) return html; // dev server — leave the normal <script src> in place
        return html.replace(
          /<script\b[^>]*\bsrc="\.?\/?([^"]+)"[^>]*><\/script>/g,
          (match: string, src: string) => {
            const chunk = bundle[src];
            if (chunk && chunk.type === "chunk" && chunk.code) {
              // Drop the now-inlined chunk so it isn't also emitted as a separate file.
              delete bundle[src];
              return `<script type="module">\n${chunk.code}</script>`;
            }
            return match;
          },
        );
      },
    },
  ],
}));
