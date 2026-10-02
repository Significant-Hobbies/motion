const severities = new Set(["info", "low", "moderate", "high", "critical"]);
const advisoryLevels = ["critical", "high", "moderate", "low", "info"];

export function summarizeDependencyAudit(result) {
  if (![0, 1].includes(result.status)) {
    throw new Error(
      `Dependency audit exited unexpectedly with status ${result.status}.`
    );
  }

  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw new Error("Dependency audit returned invalid JSON.");
  }

  if (
    !report ||
    typeof report !== "object" ||
    Array.isArray(report) ||
    report.error ||
    !report.advisories ||
    typeof report.advisories !== "object" ||
    Array.isArray(report.advisories) ||
    !report.metadata?.vulnerabilities ||
    typeof report.metadata.vulnerabilities !== "object" ||
    !Number.isInteger(report.metadata.dependencies) ||
    report.metadata.dependencies < 0 ||
    !Number.isInteger(report.metadata.totalDependencies) ||
    report.metadata.totalDependencies < report.metadata.dependencies
  ) {
    throw new Error(
      "Dependency audit returned an incomplete or unexpected report."
    );
  }

  for (const severity of advisoryLevels) {
    if (
      !Number.isInteger(report.metadata.vulnerabilities[severity]) ||
      report.metadata.vulnerabilities[severity] < 0
    ) {
      throw new Error(
        "Dependency audit returned malformed vulnerability counts."
      );
    }
  }

  for (const [id, advisory] of Object.entries(report.advisories)) {
    if (
      !/^\d+$/u.test(id) ||
      !advisory ||
      typeof advisory !== "object" ||
      !severities.has(advisory.severity) ||
      typeof advisory.github_advisory_id !== "string"
    ) {
      throw new Error(
        `Dependency audit returned a malformed advisory (${id}).`
      );
    }
  }

  if (result.status === 1 && Object.keys(report.advisories).length === 0) {
    throw new Error("Dependency audit failure has no advisory explanation.");
  }

  const advisoryCounts = Object.fromEntries(
    advisoryLevels.map((severity) => [
      severity,
      Object.values(report.advisories).filter(
        (advisory) => advisory.severity === severity
      ).length,
    ])
  );
  if (
    advisoryLevels.some(
      (severity) =>
        report.metadata.vulnerabilities[severity] !== advisoryCounts[severity]
    )
  ) {
    throw new Error(
      "Dependency audit advisory details do not match its vulnerability counts."
    );
  }

  const severe = Object.entries(report.advisories).filter(([, advisory]) =>
    ["critical", "high"].includes(advisory.severity)
  );
  return {
    dependencies: report.metadata.totalDependencies,
    severe,
  };
}
