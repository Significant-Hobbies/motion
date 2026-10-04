import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname } from "node:path";

// Execute only the installed executable's factories, stopping before CLI code.
// The patch must route every outside caller to the installed Undici export.
export async function qualifyRuntime(binary, partyRequire, runtimeRequire) {
  const bytes = readFileSync(binary, "utf8");
  const comments = [...bytes.matchAll(/^\/\/ [^\n]+$/gmu)];
  const factories = comments.flatMap((comment, index) => {
    const end = comments[index + 1]?.index ?? bytes.length;
    const factory = /var (require_[a-zA-Z0-9_]+) = __commonJS/u.exec(
      bytes.slice(comment.index, end)
    );
    return comment[0].includes("/undici/") && factory
      ? [{ start: comment.index, end, name: factory[1] }]
      : [];
  });
  assert.equal(factories.length, 95);
  const names = new Set(factories.map(({ name }) => name));
  const outside = [...bytes.matchAll(/\b(require_[a-zA-Z0-9_]+)\s*\(/gu)]
    .filter(
      (call) =>
        names.has(call[1]) &&
        !factories.some(
          ({ start: rangeStart, end: rangeEnd }) =>
            call.index >= rangeStart && call.index < rangeEnd
        )
    )
    .map((call) => call[1]);
  assert.deepEqual(outside, new Array(6).fill("require_undici"));
  const start = bytes.indexOf("var __create = Object.create;");
  const factory = bytes.indexOf("var require_undici = __commonJS({");
  const end = bytes.indexOf("\n// ", factory);
  assert(start > 0 && factory > start && end > factory);
  const builtins = new Set(
    builtinModules.map((name) => name.replace(/^node:/u, ""))
  );
  const loader = (name) => {
    assert(
      builtins.has(name.replace(/^node:/u, "")),
      `Unexpected dependency: ${name}`
    );
    return partyRequire(name);
  };
  loader.resolve = (name) => {
    assert.equal(name, "miniflare");
    return partyRequire.resolve(name);
  };
  const entry = new Function(
    "require",
    "__filename",
    "__dirname",
    `${bytes.slice(start, end)}\nreturn require_undici();\n//# sourceURL=${binary}`
  )(loader, binary, dirname(binary));
  assert.equal(runtimeRequire("undici/package.json").version, "6.29.0");
  assert.equal(entry, runtimeRequire("undici"));
  const mock = new entry.MockAgent();
  mock.disableNetConnect();
  mock
    .get("http://fixture.invalid")
    .intercept({ path: "/bundled", method: "GET" })
    .reply(200, "entry-bytes-ok");
  try {
    const response = await entry.fetch("http://fixture.invalid/bundled", {
      dispatcher: mock,
    });
    assert.equal(await response.text(), "entry-bytes-ok");
    mock.assertNoPendingInterceptors();
  } finally {
    await mock.close();
  }
  return "PASS: executable entry delegates to resolved Undici 6.29.0; network-disabled mock";
}
