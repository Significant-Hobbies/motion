import { describe, expect, it } from "vitest";
import { summarizeDependencyAudit } from "./dependency-audit.mjs";

function auditResult({ status = 0, advisories = {}, error } = {}) {
  const vulnerabilities = {
    info: 0,
    low: 0,
    moderate: 0,
    high: 0,
    critical: 0,
  };
  for (const advisory of Object.values(advisories)) {
    vulnerabilities[advisory.severity] += 1;
  }
  return {
    status,
    stdout: JSON.stringify({
      ...(error ? { error } : {}),
      advisories,
      metadata: {
        vulnerabilities,
        dependencies: 10,
        totalDependencies: 10,
      },
    }),
  };
}

describe("dependency audit gate", () => {
  it("accepts a clean, valid report", () => {
    expect(summarizeDependencyAudit(auditResult())).toEqual({
      dependencies: 10,
      severe: [],
    });
  });

  it("accepts nonzero status for a valid advisory report and returns severe findings", () => {
    const advisory = { severity: "high", github_advisory_id: "GHSA-test" };
    const result = summarizeDependencyAudit(
      auditResult({ status: 1, advisories: { 123: advisory } })
    );

    expect(result.severe).toEqual([["123", advisory]]);
  });

  it("rejects registry errors even when they exit nonzero", () => {
    expect(() =>
      summarizeDependencyAudit(
        auditResult({ status: 1, error: { code: "ENOTFOUND" } })
      )
    ).toThrow(/incomplete or unexpected report/u);
  });

  it.each(["not json", "{}", JSON.stringify({ advisories: {} })])(
    "rejects malformed reports: %s",
    (stdout) => {
      expect(() => summarizeDependencyAudit({ status: 0, stdout })).toThrow();
    }
  );

  it("rejects unexpected audit process statuses", () => {
    expect(() => summarizeDependencyAudit({ status: 2, stdout: "{}" })).toThrow(
      /exited unexpectedly/u
    );
  });

  it("rejects failure status without an advisory explanation", () => {
    expect(() => summarizeDependencyAudit(auditResult({ status: 1 }))).toThrow(
      /no advisory explanation/u
    );
  });

  it.each([
    { dependencies: -1, totalDependencies: 10 },
    { dependencies: 10, totalDependencies: 9 },
  ])("rejects invalid dependency totals: %j", (counts) => {
    const result = auditResult();
    const report = JSON.parse(result.stdout);
    Object.assign(report.metadata, counts);
    expect(() =>
      summarizeDependencyAudit({ ...result, stdout: JSON.stringify(report) })
    ).toThrow(/incomplete or unexpected report/u);
  });

  it("rejects report counts that do not match advisory details", () => {
    const result = auditResult({
      advisories: {
        123: { severity: "high", github_advisory_id: "GHSA-test" },
      },
    });
    const report = JSON.parse(result.stdout);
    report.metadata.vulnerabilities.high = 0;

    expect(() =>
      summarizeDependencyAudit({ ...result, stdout: JSON.stringify(report) })
    ).toThrow(/do not match/u);
  });
});
