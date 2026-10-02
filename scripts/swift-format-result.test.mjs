import { describe, expect, it } from "vitest";
import { countSwiftFormatDiagnostics } from "./swift-format-result.mjs";

describe("Swift format tool result", () => {
  it("accepts clean output and counts legacy lint debt", () => {
    expect(
      countSwiftFormatDiagnostics({ status: 0, stdout: "", stderr: "" })
    ).toBe(0);
    expect(
      countSwiftFormatDiagnostics({
        status: 1,
        stderr: "A.swift:1:1: error: indentation\nB.swift:2:3: error: spacing",
      })
    ).toBe(2);
  });
  it.each([1, 2, null])(
    "rejects unexplained failure %s instead of passing zero debt",
    (status) => {
      expect(() =>
        countSwiftFormatDiagnostics({ status, stderr: "tool failed" })
      ).toThrow(/without valid lint diagnostics/u);
    }
  );
  it("rejects abnormal exit even with diagnostic text", () => {
    expect(() =>
      countSwiftFormatDiagnostics({ status: 2, stderr: "error: could not run" })
    ).toThrow();
  });
  it("does not count tool errors as ratchetable Swift lint debt", () => {
    expect(() =>
      countSwiftFormatDiagnostics({
        status: 1,
        stderr: "error: unable to load configuration",
      })
    ).toThrow();
  });
});
