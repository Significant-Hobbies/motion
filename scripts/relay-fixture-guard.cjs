// Only the isolated local qualification child loads this guard.
"use strict";
const net = require("node:net");
const fs = require("node:fs");
const diagnostics = require("node:diagnostics_channel");
const { homedir } = require("node:os");
const { resolve } = require("node:path");
const { fileURLToPath } = require("node:url");
const { syncBuiltinESMExports } = require("node:module");
const { hash, diagnosticCallback } = require("./relay-diagnostics.cjs");
const personalDirectory = homedir();
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const options = net._normalizeArgs(args)[0];
  if (
    options.host &&
    !["127.0.0.1", "localhost", "::1"].includes(options.host)
  ) {
    throw new Error(`Fixture blocked external connection: ${options.host}`);
  }
  return connect.apply(this, args);
};
function guardPath(path) {
  const text = resolve(
    path instanceof URL ? fileURLToPath(path) : String(path)
  );
  if (
    text === personalDirectory ||
    text.startsWith(`${personalDirectory}/`) ||
    /(^|\/)\.env(?:\.|$)|\.partykit\/config\.json|\/\.ssh\/|\/\.aws\//u.test(
      text
    )
  ) {
    throw new Error(`Fixture blocked sensitive read: ${text}`);
  }
}
for (const name of [
  "readFileSync",
  "readFile",
  "openSync",
  "open",
  "writeFileSync",
  "writeFile",
  "createReadStream",
  "createWriteStream",
]) {
  const original = fs[name];
  fs[name] = function (path, ...args) {
    guardPath(path);
    return original.call(this, path, ...args);
  };
}
for (const name of ["readFile", "open", "writeFile"]) {
  const original = fs.promises[name];
  fs.promises[name] = async function (path, ...args) {
    guardPath(path);
    return await original.call(this, path, ...args);
  };
}
syncBuiltinESMExports();
const identity = {
  guard: __filename,
  port: Number(process.env.RELAY_FIXTURE_PORT),
};
try {
  identity.binary = fs.realpathSync(process.argv[1]);
  identity.binarySha256 = hash(fs.readFileSync(identity.binary));
  const bytes = fs.readFileSync(`${identity.binary}.map`);
  identity.mapSha256 = hash(bytes);
  identity.map = JSON.parse(bytes);
} catch {
  /* Missing identity or map leaves provenance UNKNOWN. */
}
diagnostics
  .channel("undici:request:create")
  .subscribe(
    diagnosticCallback(identity, (record) => process.stdout.write(record))
  );
