import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      all: true,
      exclude: ["**/*.test.ts", "web/src/vite-env.d.ts"],
      include: ["protocol/**/*.ts", "server/src/**/*.ts", "web/src/**/*.ts"],
      provider: "v8",
      reporter: ["text", "json-summary"],
      reportsDirectory: "coverage",
    },
    include: [
      "protocol/**/*.test.ts",
      "server/src/**/*.test.ts",
      "web/src/**/*.test.ts",
    ],
  },
});
