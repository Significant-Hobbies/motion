// The live dependency gate found GHSA-pqg4-j6r4-53mv in concurrently's
// shell-quote dependency. Exercise that resolved dependency without executing
// a shell command: a comment must not let a later token introduce a new line.
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const toolRequire = createRequire(require.resolve("concurrently"));
const { quote } = toolRequire("shell-quote");

describe("development command quoting", () => {
  it.each(["\n", "\r", "\u2028", "\u2029"])(
    "rejects a line terminator after a comment token: %j",
    (terminator) => {
      expect(() =>
        quote(["echo", "ok", { comment: "fixture" }, `a${terminator}echo x;#`])
      ).toThrow(TypeError);
    }
  );

  it("keeps ordinary arguments with spaces quoted", () => {
    expect(quote(["node", "a file.js"])).toBe("node 'a file.js'");
  });
});
