import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("executes embedded Undici without sockets and emits complete parseable evidence", () => {
  const script = fileURLToPath(new URL("./qualify-relay.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, "--inspect-bundle"], {
    encoding: "utf8",
    timeout: 3000,
    env: { PATH: "/usr/bin:/bin" },
  });
  expect(result.status, result.stderr).toBe(0);
  const report = JSON.parse(result.stdout);
  expect(report.embeddedMockFetch).toMatch(/^PASS:/u);
  expect(report.binarySha256).toMatch(/^[a-f0-9]{64}$/u);
  expect(report.embeddedSourcesSha256).toMatch(/^[a-f0-9]{64}$/u);
  expect(report.embeddedUndiciSources).toBeGreaterThan(0);
  expect(report.embeddedExactVersion).toMatch(/^unknown:/u);
});
