import { defineConfig } from "astro/config";
import { site } from "./src/site.config.ts";

export default defineConfig({
  site: site.url,
  output: "static",
  trailingSlash: "ignore",
  build: {
    format: "directory",
    inlineStylesheets: "always"
  },
  vite: {
    css: { transformer: "lightningcss" },
    build: { cssMinify: "lightningcss" }
  }
});
