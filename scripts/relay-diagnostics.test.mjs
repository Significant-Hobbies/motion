import { createRequire } from "node:module";
import { expect, it } from "vitest";

const { diagnosticCallback, createCollector, hash } = createRequire(import.meta.url)("./relay-diagnostics.cjs");
const identity = { port: 21999, binary: "/fixture/bin.mjs", guard: "/fixture/guard.cjs",
  binarySha256: hash("executable fixture"), mapSha256: hash("map fixture"),
  map: { version: 3, sources: ["request.js"], sourcesContent: ["mock source"],
    names: [], mappings: "AAAA" } };
const request = { method: "GET", origin: "http://127.0.0.1:21999", path: "/json" };
const prefix = "Error\n    at callback (/fixture/guard.cjs:1:1)\n    at Channel.publish (node:diagnostics_channel:1:1)\n";
function record(stack = `${prefix}    at implementation (/fixture/bin.mjs:1:1)`) {
  let emitted;
  diagnosticCallback(identity, (value) => { emitted = value; }, () => stack)({ request });
  return emitted;
}

it("observes the first implementation via Node SourceMap, always UNKNOWN", () => {
  const result = JSON.parse(record("Error\n    at callback (/fixture/guard.cjs:1:1)\n    at Channel.publish (node:diagnostics_channel:1:1)\n    at implementation (/fixture/bin.mjs:1:1)").slice(15));
  expect(result.bundled).toBe("UNKNOWN");
  expect(result.observation).toEqual({ source: "request.js", sourceSha256: hash("mock source"),
    line: 1, column: 1, sourceLine: 1, sourceColumn: 1 });
  for (const stack of ["Error", "Error\n    at native", `${prefix}    at earlier (/other/request.js:1:1)\n    at later (/fixture/bin.mjs:1:1)`, "Error\n    at implementation (/fixture/bin.mjs:1:1)"]) {
    expect(JSON.parse(record(stack).slice(15)).observation).toEqual({});
  }
  for (const map of [null, { ...identity.map, sources: ["request.js", "request.js"] }]) {
    let output;
    diagnosticCallback({ ...identity, map }, (value) => { output = value; }, () => `${prefix}    at implementation (/fixture/bin.mjs:1:1)`)({ request });
    expect(JSON.parse(output.slice(15)).observation).toEqual({});
  }
});

it("frames readiness at every stdout split and keeps stderr separate", () => {
  const url = "Ready http://127.0.0.1:21999/\n";
  for (let split = 0; split <= url.length; split++) {
    const collector = createCollector(identity.port, identity);
    collector.push("stdout", url.slice(0, split));
    collector.push("stdout", url.slice(split));
    expect(collector.ready()).toBe(true);
  }
  const collector = createCollector(identity.port, identity);
  collector.push("stdout", "http://127.0.0.1:");
  collector.push("stderr", "21999\n");
  collector.push("stderr", "http://127.0.0.1:219990\nhttp://external.invalid:21999\n");
  expect(collector.ready()).toBe(false);
  collector.push("stderr", url);
  expect(collector.ready()).toBe(true);
});

it("frames records across chunks and newlines with bounded, redacted retention", () => {
  const value = record();
  for (let split = 0; split <= value.length; split++) {
    const collector = createCollector(identity.port, identity);
    collector.push("stdout", value.slice(0, split));
    collector.push("stdout", value.slice(split));
    expect(collector.observations()).toHaveLength(1);
    expect(collector.qualified()).toBe(false);
  }
  const collector = createCollector(identity.port, identity);
  collector.push("stdout", `${"secret/home/token?body".repeat(300)}${value}`);
  expect(collector.observations()).toHaveLength(0);
  const poisoned = JSON.parse(value.slice(15));
  poisoned.stack = "/home/person/token";
  poisoned.observation.extra = "secret query/body";
  for (let i = 0; i < 20; i++) collector.push("stdout", `FIXTURE_UNDICI ${JSON.stringify(poisoned)}\n`);
  expect(collector.observations()).toHaveLength(16);
  expect(JSON.stringify(collector.observations())).not.toMatch(/secret|home|token|extra|stack/u);
});

it("rejects unmatched GET, origin, path and identities and fails closed", () => {
  const value = JSON.parse(record().slice(15));
  for (const changes of [{ method: "POST" }, { origin: "http://localhost:219990" },
    { origin: "http://external.invalid:21999" }, { path: "/json?token=secret" },
    { binarySha256: hash("other") }, { mapSha256: null }]) {
    const collector = createCollector(identity.port, identity);
    collector.push("stdout", `FIXTURE_UNDICI ${JSON.stringify({ ...value, ...changes })}\n`);
    expect(collector.observations()).toHaveLength(0);
    expect(collector.qualified()).toBe(false);
  }
  for (const bundled of ["UNKNOWN", "FALSE", false, null, {}, "malformed"]) {
    // Even a separately affirmative gate cannot promote these observations.
    const collector = createCollector(identity.port, { ...identity, publisherQualified: true });
    collector.push("stdout", `FIXTURE_UNDICI ${JSON.stringify({ ...value, bundled })}\nFIXTURE_UNDICI {bad-json}\n`);
    expect(collector.qualified()).toBe(false);
  }
  let output;
  const callback = diagnosticCallback(identity, (emitted) => { output = emitted; });
  callback({ request: { ...request, path: "/json?token=secret" } });
  expect(output).not.toContain("secret");
  expect(() => callback({ request: { ...request, origin: "https://external.invalid?token=secret" } })).toThrow("Fixture blocked external Undici request");
});
