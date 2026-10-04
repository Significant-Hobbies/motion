// Only the isolated local qualification child loads this cooperative Node guard.
"use strict";
const net = require("node:net");
const fs = require("node:fs");
const diagnostics = require("node:diagnostics_channel");
const { dirname, resolve, sep } = require("node:path");
const { fileURLToPath } = require("node:url");
const { createRequire, syncBuiltinESMExports } = require("node:module");
const { hash, diagnosticCallback } = require("./relay-diagnostics.cjs");
const canonical = fs.realpathSync;
const source = canonical(resolve(__dirname, ".."));
const fixtureAlias = process.env.RELAY_FIXTURE_DIRECTORY
  ? resolve(process.env.RELAY_FIXTURE_DIRECTORY)
  : null;
const fixture = fixtureAlias ? canonical(fixtureAlias) : null;
const within = (path, root) =>
  root && (path === root || path.startsWith(root + sep));
const sensitive =
  /(^|\/)\.env(?:\.|$)|(^|\/)\.(?:git|ssh|aws|npmrc|yarnrc)(?:\/|$)|\.partykit\/config\.json$/iu;
function blocked() {
  // Missing credentials remain missing without attempting to open them.
  const error = new Error("Fixture blocked sensitive or out-of-scope I/O");
  error.code = "ENOENT";
  throw error;
}
function guardPath(path, write = false) {
  if (typeof path === "number") blocked();
  const text = resolve(
    path instanceof URL ? fileURLToPath(path) : String(path)
  );
  if (sensitive.test(text)) blocked();
  if (
    !within(text, fixtureAlias) &&
    !within(text, fixture) &&
    (write || !within(text, source))
  )
    blocked();
  // Resolve existing parents as well as existing files, so symlink escapes and
  // writes to a new file through a symlink are rejected before content I/O.
  let parent = text;
  while (true) {
    try {
      const real = canonical(parent);
      if (sensitive.test(real)) blocked();
      if (!within(real, fixture) && (write || !within(real, source))) blocked();
      break;
    } catch (error) {
      if (error.message.startsWith("Fixture blocked")) throw error;
      if (error.code !== "ENOENT" || dirname(parent) === parent) throw error;
      parent = dirname(parent);
    }
  }
}
// Only the exact numeric read-only flag can open checkout source files.
// Other numeric modes fail closed; fixture-local files still allow writes.
const writing = (flags) =>
  typeof flags === "number"
    ? flags !== fs.constants.O_RDONLY
    : /[wa+]/u.test(String(flags));
function wrap(api, name, mode) {
  const original = api[name];
  if (!original) return;
  const guarded = function (path, ...args) {
    guardPath(path, mode === "write" || (mode === "open" && writing(args[0])));
    return original.call(this, path, ...args);
  };
  api[name] =
    api === fs.promises
      ? async function (...args) {
          return guarded.apply(this, args);
        }
      : guarded;
}
for (const name of ["readFileSync", "readFile", "createReadStream"])
  wrap(fs, name, "read");
for (const name of [
  "writeFileSync",
  "writeFile",
  "appendFileSync",
  "appendFile",
  "createWriteStream",
  "mkdirSync",
  "mkdir",
  "rmSync",
  "rm",
  "unlinkSync",
  "unlink",
  "rmdirSync",
  "rmdir",
  "truncateSync",
  "truncate",
  "chmodSync",
  "chmod",
  "chownSync",
  "chown",
])
  wrap(fs, name, "write");
for (const name of ["openSync", "open"]) wrap(fs, name, "open");
for (const name of ["readFile"]) wrap(fs.promises, name, "read");
for (const name of [
  "writeFile",
  "appendFile",
  "mkdir",
  "rm",
  "unlink",
  "rmdir",
  "truncate",
  "chmod",
  "chown",
])
  wrap(fs.promises, name, "write");
wrap(fs.promises, "open", "open");
for (const api of [fs, fs.promises]) {
  for (const name of [
    "rename",
    "renameSync",
    "copyFile",
    "copyFileSync",
    "cp",
    "cpSync",
    "link",
    "linkSync",
    "symlink",
    "symlinkSync",
  ]) {
    const original = api[name];
    if (!original) continue;
    const guarded = function (from, to, ...args) {
      guardPath(from, name.startsWith("rename"));
      guardPath(to, true);
      return original.call(this, from, to, ...args);
    };
    api[name] =
      api === fs.promises
        ? async function (...args) {
            return guarded.apply(this, args);
          }
        : guarded;
  }
}
syncBuiltinESMExports();
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const options = net._normalizeArgs(args)[0];
  if (
    options.path ||
    (options.host && !["127.0.0.1", "localhost", "::1"].includes(options.host))
  ) {
    throw new Error("Fixture blocked external connection");
  }
  return connect.apply(this, args);
};
const identity = {
  guard: __filename,
  port: Number(process.env.RELAY_FIXTURE_PORT),
  inspectorPort: Number(process.env.RELAY_FIXTURE_INSPECTOR_PORT),
};
try {
  identity.binary = fs.realpathSync(process.argv[1]);
  identity.binarySha256 = hash(fs.readFileSync(identity.binary));
  const bytes = fs.readFileSync(`${identity.binary}.map`);
  identity.mapSha256 = hash(bytes);
  identity.map = JSON.parse(bytes);
  const partyRequire = createRequire(identity.binary);
  const runtimeRequire = createRequire(partyRequire.resolve("miniflare"));
  identity.publisher = fs.realpathSync(
    runtimeRequire.resolve("undici/lib/core/request.js")
  );
  identity.publisherSha256 = hash(fs.readFileSync(identity.publisher));
  identity.publisherVersion = runtimeRequire("undici/package.json").version;
} catch {
  /* Missing identity leaves provenance UNKNOWN. */
}
diagnostics
  .channel("undici:request:create")
  .subscribe(
    diagnosticCallback(identity, (record) => process.stdout.write(record))
  );
