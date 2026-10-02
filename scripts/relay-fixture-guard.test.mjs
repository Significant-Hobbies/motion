import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("blocks sync, promise and ESM sensitive I/O plus external sockets before I/O", () => {
  const guard = fileURLToPath(
    new URL("./relay-fixture-guard.cjs", import.meta.url)
  );
  const result = spawnSync(
    process.execPath,
    [
      "--require",
      guard,
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    import { readFileSync } from 'node:fs';
    import { readFile, writeFile } from 'node:fs/promises';
    import { Socket } from 'node:net';
    // These fixture paths need not exist: guards must fire before any I/O.
    assert.throws(() => readFileSync('/tmp/.env.synthetic-fixture'), /Fixture blocked/);
    await assert.rejects(readFile('/tmp/.env.synthetic-fixture'), /Fixture blocked/);
    await assert.rejects(writeFile('/tmp/.env.synthetic-fixture', 'synthetic'), /Fixture blocked/);
    const socket = new Socket();
    assert.throws(() => socket.connect({ host: 'external.invalid', port: 80 }), /Fixture blocked external/);
    socket.destroy();
    console.log('guards passed');
  `,
    ],
    { encoding: "utf8", timeout: 3000, env: { PATH: "/usr/bin:/bin" } }
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("guards passed");
});
