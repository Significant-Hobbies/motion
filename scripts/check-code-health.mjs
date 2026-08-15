#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const productionPaths = ["protocol", "server/src", "web/src", "ios/Sources"];
const typescriptPaths = [
  "protocol",
  "server/src",
  "web/src",
  "scripts",
  "vitest.config.ts",
  "package.json",
  "web/package.json",
  "server/package.json",
  "biome.json",
];

function log(message) {
  process.stdout.write(`${message}\n`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? projectRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new Error(`${command} exited with status ${result.status}`);
  }
  return result;
}

function failRegressions(label, observed, baseline) {
  const regressions = Object.entries(baseline).filter(
    ([key, maximum]) => observed[key] > maximum
  );
  if (regressions.length > 0) {
    throw new Error(
      regressions
        .map(
          ([key, maximum]) =>
            `${label} ${key} regressed: ${observed[key]} > ${maximum}`
        )
        .join("\n")
    );
  }
  if (
    Object.entries(baseline).some(([key, maximum]) => observed[key] < maximum)
  ) {
    log(`${label} improved; lower the checked-in baseline intentionally.`);
  }
}

function checkMinimums(label, observed, minimums) {
  const regressions = Object.entries(minimums).filter(
    ([key, minimum]) => observed[key] + Number.EPSILON < minimum
  );
  if (regressions.length > 0) {
    throw new Error(
      regressions
        .map(
          ([key, minimum]) =>
            `${label} ${key} regressed: ${observed[key]} < ${minimum}`
        )
        .join("\n")
    );
  }
  if (
    Object.entries(minimums).some(([key, minimum]) => observed[key] > minimum)
  ) {
    log(`${label} improved; raise the checked-in baseline intentionally.`);
  }
}

function checkFormat() {
  const result = run(
    "pnpm",
    [
      "exec",
      "biome",
      "check",
      "--formatter-enabled=true",
      "--linter-enabled=false",
      "--assist-enabled=false",
      "--reporter=json",
      ...typescriptPaths,
    ],
    { allowFailure: true }
  );
  const report = JSON.parse(result.stdout);
  const observed = { files: report.summary.errors };
  log(`TypeScript format debt: ${observed.files} files.`);
  // Ratcheted legacy debt: https://github.com/Significant-Hobbies/motion/issues/26
  failRegressions("TypeScript format", observed, { files: 0 });
}

function checkCoverage() {
  const reportDirectory = mkdtempSync(join(tmpdir(), "motion-coverage-"));
  run("pnpm", [
    "exec",
    "vitest",
    "run",
    "--coverage",
    "--coverage.reporter=json-summary",
    `--coverage.reportsDirectory=${reportDirectory}`,
  ]);
  const total = JSON.parse(
    readFileSync(join(reportDirectory, "coverage-summary.json"), "utf8")
  ).total;
  const observed = {
    lines: total.lines.pct,
    branches: total.branches.pct,
    functions: total.functions.pct,
    statements: total.statements.pct,
  };
  log(
    `TypeScript coverage: ${observed.lines}% lines, ${observed.branches}% branches, ` +
      `${observed.functions}% functions, ${observed.statements}% statements.`
  );
  // Ratcheted legacy debt: https://github.com/Significant-Hobbies/motion/issues/26
  checkMinimums("TypeScript coverage", observed, {
    lines: 6.4,
    branches: 10.06,
    functions: 7.01,
    statements: 6.49,
  });
}

function checkComplexity() {
  const result = run("uvx", [
    "--from",
    "lizard==1.23.0",
    "lizard",
    ...productionPaths,
    "-x",
    "**/*.test.*",
    "--csv",
  ]);
  const rows = result.stdout
    .trim()
    .split("\n")
    .map((line) => line.match(/^(\d+),(\d+),(\d+),(\d+),(\d+),/u))
    .filter(Boolean)
    .map((match) => match.slice(1).map(Number));
  const observed = {
    functions: rows.length,
    nloc: rows.reduce((sum, row) => sum + row[0], 0),
    violations: rows.filter((row) => row[1] > 15 || row[4] > 100 || row[3] > 7)
      .length,
    maxCcn: Math.max(...rows.map((row) => row[1])),
    maxLength: Math.max(...rows.map((row) => row[4])),
    maxParams: Math.max(...rows.map((row) => row[3])),
  };
  log(
    `Complexity: ${observed.functions} functions, ${observed.nloc} NLOC, ` +
      `${observed.violations} violations; max CCN ${observed.maxCcn}, ` +
      `max length ${observed.maxLength}, max params ${observed.maxParams}.`
  );
  // Ratcheted legacy debt: https://github.com/Significant-Hobbies/motion/issues/26
  failRegressions("Complexity", observed, {
    violations: 3,
    maxCcn: 22,
    maxLength: 180,
    maxParams: 7,
  });
}

function checkDuplication() {
  const outputDirectory = mkdtempSync(join(tmpdir(), "motion-jscpd-"));
  run("pnpm", [
    "exec",
    "jscpd",
    ...productionPaths,
    "--format",
    "javascript,typescript,swift",
    "--min-lines",
    "8",
    "--min-tokens",
    "60",
    "--mode",
    "strict",
    "--ignore",
    "**/*.test.*,**/node_modules/**,**/coverage/**,**/dist/**,**/Resources/webgame/**",
    "--reporters",
    "json",
    "--output",
    outputDirectory,
    "--silent",
    "--no-tips",
  ]);
  const observed = JSON.parse(
    readFileSync(join(outputDirectory, "jscpd-report.json"), "utf8")
  ).statistics.total;
  log(
    `Duplication: ${observed.duplicatedLines}/${observed.lines} lines ` +
      `(${observed.percentage.toFixed(4)}%), ${observed.clones} groups across ` +
      `${observed.sources} files.`
  );
  // Ratcheted legacy debt: https://github.com/Significant-Hobbies/motion/issues/26
  failRegressions("Duplication", observed, {
    clones: 5,
    duplicatedLines: 65,
    percentage: 0.5543237250554324,
  });
}

function checkDependencies() {
  const result = run("pnpm", ["audit", "--json"], { allowFailure: true });
  const report = JSON.parse(result.stdout);
  const severe = Object.entries(report.advisories ?? {}).filter(
    ([, advisory]) => ["critical", "high"].includes(advisory.severity)
  );
  const allowedHigh = new Set(["1114638", "1114640", "1121245"]);
  const unexpected = severe.filter(([id]) => !allowedHigh.has(id));
  const missing = [...allowedHigh].filter(
    (id) => !severe.some(([observedId]) => observedId === id)
  );
  const reviewDate = new Date("2026-09-12T00:00:00Z");
  log(
    `Dependencies: ${severe.length} critical/high advisories; ` +
      `${severe.length - unexpected.length} accepted PartyKit/Miniflare findings.`
  );
  if (Date.now() >= reviewDate.getTime()) {
    throw new Error(
      "PartyKit dependency-risk exception expired on 2026-09-12 (#26)."
    );
  }
  if (unexpected.length > 0) {
    throw new Error(
      `Unexpected critical/high advisories: ${unexpected
        .map(([id, advisory]) => `${id}/${advisory.github_advisory_id}`)
        .join(", ")}`
    );
  }
  if (missing.length > 0) {
    log(
      `Dependency risk improved; remove resolved exceptions: ${missing.join(", ")}.`
    );
  }
}

function countMatches(pattern) {
  const result = run(
    "git",
    [
      "grep",
      "-n",
      "-E",
      pattern,
      "--",
      ...productionPaths,
      ":(exclude)**/*.test.*",
    ],
    { allowFailure: true }
  );
  return result.stdout.trim() ? result.stdout.trim().split("\n") : [];
}

function checkSuppressions() {
  const matches = countMatches(
    "(^|[[:space:]])(//|/\\*)[[:space:]]*(eslint-disable|@ts-ignore|@ts-expect-error|istanbul ignore|c8 ignore|swiftlint:disable|biome-ignore)"
  );
  log(`Suppressions: ${matches.length} inline directives.`);
  if (matches.length > 0) {
    throw new Error(`Unjustified suppressions:\n${matches.join("\n")}`);
  }
}

function checkHygiene() {
  const conflictMarkers = run(
    "git",
    ["grep", "-n", "-E", "^(<<<<<<<|=======|>>>>>>>)", "--", "."],
    { allowFailure: true }
  ).stdout.trim();
  if (conflictMarkers) throw new Error(`Conflict markers:\n${conflictMarkers}`);
  const todos = countMatches("TODO|FIXME");
  if (todos.length > 0) {
    throw new Error(`Durable TODO/FIXME markers:\n${todos.join("\n")}`);
  }
  run("git", ["diff", "--check", "HEAD", "--", "."]);
  log("Repository hygiene: clean.");
}

function checkSwiftFormat() {
  const result = run(
    "xcrun",
    ["swift-format", "lint", "--strict", "--recursive", "ios/Sources"],
    { allowFailure: true }
  );
  const diagnostics = `${result.stdout}\n${result.stderr}`
    .split("\n")
    .filter((line) => line.includes("error:")).length;
  log(`Swift format debt: ${diagnostics} diagnostics.`);
  // Ratcheted legacy debt: https://github.com/Significant-Hobbies/motion/issues/26
  failRegressions("Swift format", { diagnostics }, { diagnostics: 4553 });
}

function checkSwiftUnused() {
  const indexStore = process.env.MOTION_INDEX_STORE;
  if (!indexStore) {
    throw new Error(
      "Set MOTION_INDEX_STORE to a completed Motion build index store."
    );
  }
  const versionResult = run("periphery", ["version"]);
  const version = `${versionResult.stdout}\n${versionResult.stderr}`.trim();
  const major = Number(version.match(/\d+/u)?.[0]);
  if (!Number.isInteger(major)) {
    throw new Error(`Could not parse Periphery version: ${version}`);
  }
  const args = [
    "scan",
    major < 3 ? "--workspace" : "--project",
    "ios/Motion.xcworkspace",
    "--schemes",
    "Motion",
    "--skip-build",
    "--index-store-path",
    indexStore,
    "--format",
    "json",
    "--relative-results",
    "--disable-update-check",
    "--quiet",
    "--retain-objc-accessible",
    "--retain-codable-properties",
    "--retain-swift-ui-previews",
  ];
  if (major < 3) args.push("--targets", "Motion");
  const result = run("periphery", args);
  const observed = { findings: JSON.parse(result.stdout).length };
  log(
    `Swift unused-code debt: ${observed.findings} Periphery ${version} findings.`
  );
  // Ratcheted legacy debt: https://github.com/Significant-Hobbies/motion/issues/26
  failRegressions("Swift unused code", observed, { findings: 68 });
}

const checks = {
  complexity: checkComplexity,
  coverage: checkCoverage,
  dependencies: checkDependencies,
  duplication: checkDuplication,
  format: checkFormat,
  hygiene: checkHygiene,
  suppressions: checkSuppressions,
  "swift-format": checkSwiftFormat,
  "swift-unused": checkSwiftUnused,
};
const selected = process.argv[2];

if (!Object.hasOwn(checks, selected)) {
  process.stderr.write(
    `Usage: check-code-health.mjs <${Object.keys(checks).join("|")}>\n`
  );
  process.exit(2);
}

try {
  checks[selected]();
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exit(1);
}
