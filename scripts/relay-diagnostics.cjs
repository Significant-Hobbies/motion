"use strict";
const { createHash } = require("node:crypto");
const { basename } = require("node:path");
const { SourceMap } = require("node:module");
const { fileURLToPath } = require("node:url");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const digest = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) ? value : null;
const PREFIX = "FIXTURE_UNDICI ";
const LIMIT = 4096;
function safeObservation(value) {
  if (
    !value ||
    typeof value.source !== "string" ||
    !/^[a-zA-Z0-9_.-]{1,80}$/u.test(value.source) ||
    !digest(value.sourceSha256) ||
    ![value.line, value.column, value.sourceLine, value.sourceColumn].every(
      (n) => Number.isSafeInteger(n) && n > 0
    )
  )
    return {};
  return {
    source: value.source,
    sourceSha256: value.sourceSha256,
    line: value.line,
    column: value.column,
    sourceLine: value.sourceLine,
    sourceColumn: value.sourceColumn,
  };
}

// Observations only: a mapped frame is never a publisher qualification.
function observe(stack, identity) {
  try {
    const frames = String(stack).split("\n").slice(1);
    let frame;
    let owned = false;
    let dispatched = false;
    for (const line of frames) {
      const match = /(?:\(|^at )([^()]+):(\d+):(\d+)\)?$/u.exec(line.trim());
      if (!match) return {};
      if (!dispatched && [__filename, identity.guard].includes(match[1])) {
        owned = true;
        continue;
      }
      if (owned && match[1] === "node:diagnostics_channel") {
        dispatched = true;
        continue;
      }
      frame = match;
      break;
    }
    if (!frame || !dispatched) return {};
    const executable = frame[1].startsWith("file:")
      ? fileURLToPath(frame[1])
      : frame[1];
    if (executable !== identity.binary) return {};
    const line = Number(frame[2]);
    const column = Number(frame[3]);
    if (
      !Number.isSafeInteger(line) ||
      !Number.isSafeInteger(column) ||
      line < 1 ||
      column < 1
    )
      return {};
    const entry = new SourceMap(identity.map).findEntry(line - 1, column - 1);
    const indexes = identity.map.sources.flatMap((mappedSource, index) =>
      mappedSource === entry.originalSource ? [index] : []
    );
    if (indexes.length !== 1) return {};
    const content = identity.map.sourcesContent[indexes[0]];
    const source = basename(entry.originalSource);
    if (
      typeof content !== "string" ||
      !/^[a-zA-Z0-9_.-]{1,80}$/u.test(source) ||
      !Number.isSafeInteger(entry.originalLine) ||
      entry.originalLine < 0 ||
      !Number.isSafeInteger(entry.originalColumn) ||
      entry.originalColumn < 0
    )
      return {};
    return {
      line,
      column,
      source,
      sourceSha256: hash(content),
      sourceLine: entry.originalLine + 1,
      sourceColumn: entry.originalColumn + 1,
    };
  } catch {
    return {};
  }
}

function diagnosticCallback(
  identity,
  emit,
  capture = () => new Error("Fixture request observation").stack
) {
  return ({ request }) => {
    const origin = String(request.origin);
    if (!/^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+$/u.test(origin))
      throw new Error("Fixture blocked external Undici request");
    const matched =
      request.method === "GET" &&
      request.path === "/json" &&
      ["127.0.0.1", "localhost", "[::1]"].some(
        (host) =>
          origin === `http://${host}:${identity.inspectorPort ?? identity.port}`
      );
    const proof = publisher(identity);
    emit(
      `${PREFIX}${JSON.stringify({
        method: matched ? "GET" : null,
        origin: matched ? origin : null,
        path: matched ? "/json" : null,
        binarySha256: digest(identity.binarySha256),
        mapSha256: digest(identity.mapSha256),
        bundled: proof ? "FALSE" : "UNKNOWN",
        publisher: proof,
        observation: observe(capture(), identity),
      })}\n`
    );
  };
}

// Capture V8's actual call sites before string formatting or source-map mapping.
// A caller-supplied string stack can provide observations, never qualification.
function publisher(identity) {
  const prepare = Error.prepareStackTrace;
  try {
    Error.prepareStackTrace = (_error, callSites) => callSites;
    const error = new Error("Fixture publisher observation");
    Error.captureStackTrace(error, publisher);
    const sites = error.stack;
    let owned = false;
    let dispatched = false;
    for (const site of sites) {
      const file = site.getFileName();
      if (!dispatched && [__filename, identity.guard].includes(file)) {
        owned = true;
        continue;
      }
      if (owned && file === "node:diagnostics_channel") {
        dispatched = true;
        continue;
      }
      if (
        !dispatched ||
        file !== identity.publisher ||
        identity.publisherVersion !== "6.29.0" ||
        !digest(identity.publisherSha256)
      )
        return null;
      return {
        kind: "external-undici",
        version: identity.publisherVersion,
        sourceSha256: identity.publisherSha256,
      };
    }
  } catch {
    /* Unqualified frames leave the publisher unknown. */
  } finally {
    Error.prepareStackTrace = prepare;
  }
  return null;
}

function createCollector(port, identity) {
  const streams = new Map();
  const records = [];
  let ready = false;
  function push(stream, chunk) {
    let state = streams.get(stream) ?? { tail: "", oversized: false };
    // Each stream is independently newline framed; no cross-stream joins.
    for (const part of String(chunk).split(/(?<=\n)/u)) {
      const complete = part.endsWith("\n");
      state.tail = (state.tail + part).slice(-LIMIT);
      state.oversized ||= state.tail.length === LIMIT;
      if (!complete) continue;
      if (!state.oversized) {
        const line = state.tail.trim();
        ready ||= new RegExp(
          `(?:^|\\s)http://(?:127\\.0\\.0\\.1|localhost|\\[::1\\]):${port}(?:/)?(?:\\s|$)`,
          "u"
        ).test(line);
        if (line.startsWith(PREFIX) && records.length < 16) {
          try {
            const record = JSON.parse(line.slice(PREFIX.length));
            if (
              record?.method === "GET" &&
              record.path === "/json" &&
              ["127.0.0.1", "localhost", "[::1]"].some(
                (host) =>
                  record.origin ===
                  `http://${host}:${identity.inspectorPort ?? port}`
              ) &&
              digest(record.binarySha256) &&
              digest(record.mapSha256) &&
              record.binarySha256 === identity.binarySha256 &&
              record.mapSha256 === identity.mapSha256
            ) {
              // Only sanitized matched observations enter failure reports.
              records.push({
                method: "GET",
                origin: record.origin,
                path: "/json",
                binarySha256: record.binarySha256,
                mapSha256: record.mapSha256,
                bundled: ["TRUE", "FALSE"].includes(record.bundled)
                  ? record.bundled
                  : "UNKNOWN",
                publisher:
                  record.publisher?.kind === "external-undici" &&
                  record.publisher.version === "6.29.0" &&
                  digest(record.publisher.sourceSha256)
                    ? {
                        kind: "external-undici",
                        version: "6.29.0",
                        sourceSha256: record.publisher.sourceSha256,
                      }
                    : null,
                observation: safeObservation(record.observation),
              });
            }
          } catch {
            /* Malformed records provide no evidence. */
          }
        }
      }
      state = { tail: "", oversized: false };
    }
    streams.set(stream, state);
  }
  return {
    push,
    ready: () => ready,
    qualified: () =>
      identity.publisherQualified === true &&
      records.some(
        (record) =>
          record.bundled === "FALSE" &&
          record.publisher?.kind === "external-undici" &&
          record.publisher.version === identity.publisherVersion &&
          record.publisher.sourceSha256 === identity.publisherSha256
      ),
    observations: () => records.slice(),
  };
}
module.exports = { hash, diagnosticCallback, createCollector };
