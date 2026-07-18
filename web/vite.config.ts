import { defineConfig } from "vite";

// The display is a single-page app shell (plain TS + Canvas 2D, no framework).
// The protocol lives one dir up and is imported by relative path; Vite bundles it.
export default defineConfig({
  root: ".",
  server: {
    host: true,
    port: 5173,
  },
  build: {
    target: "es2022",
    outDir: "dist",
    sourcemap: true,
  },
});
