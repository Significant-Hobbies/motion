import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, symlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

it("allows its own source and fixture, denying source writes and symlink escapes", () => {
  const guard = fileURLToPath(
    new URL("./relay-fixture-guard.cjs", import.meta.url)
  );
  const fixture = mkdtempSync(join(tmpdir(), "motion-guard-fixture-"));
  const outside = mkdtempSync(join(tmpdir(), "motion-guard-outside-"));
  writeFileSync(join(outside, "fictional.txt"), "fictional private fixture");
  symlinkSync(outside, join(fixture, "escape"));
  const before = readFileSync(guard);
  const result = spawnSync(
    process.execPath,
    [
      "--require",
      guard,
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    import { readFileSync, writeFileSync, openSync, renameSync } from 'node:fs';
    import { readFile, writeFile, open } from 'node:fs/promises';
    import { join } from 'node:path';
    const fixture = process.env.RELAY_FIXTURE_DIRECTORY;
    const source = process.env.RELAY_GUARD_SOURCE;
    assert.match(readFileSync(source, 'utf8'), /qualification child/);
    assert.match(await readFile(source, 'utf8'), /qualification child/);
    writeFileSync(join(fixture, 'owned.txt'), 'owned');
    await writeFile(join(fixture, 'async.txt'), 'async');
    assert.equal(await readFile(join(fixture, 'async.txt'), 'utf8'), 'async');
    assert.throws(() => writeFileSync(source, 'must not write'), /Fixture blocked/);
    assert.throws(() => openSync(source, 'r+'), /Fixture blocked/);
    await assert.rejects(open(source, 'w'), /Fixture blocked/);
    assert.throws(() => renameSync(join(fixture, 'owned.txt'), source), /Fixture blocked/);
    assert.throws(() => readFileSync(join(fixture, 'escape/fictional.txt')), /Fixture blocked/);
    await assert.rejects(writeFile(join(fixture, 'escape/new.txt'), 'blocked'), /Fixture blocked/);
    console.log('scoped guards passed');
  `,
    ],
    {
      encoding: "utf8",
      timeout: 3000,
      cwd: fixture,
      env: {
        PATH: "/usr/bin:/bin",
        RELAY_FIXTURE_DIRECTORY: fixture,
        RELAY_GUARD_SOURCE: guard,
      },
    }
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("scoped guards passed");
  expect(readFileSync(guard)).toEqual(before);
});
