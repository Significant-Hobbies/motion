// Bounded real PartyKit qualification; no login, deployment, camera or provider.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { qualifyRuntime } from "./relay-runtime.mjs";

const { createCollector } = createRequire(import.meta.url)(
  "./relay-diagnostics.cjs"
);

try {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const binary = realpathSync(
    resolve(root, "server/node_modules/partykit/dist/bin.mjs")
  );
  const partyRequire = createRequire(new URL(`file://${binary}`));
  const runtimeRequire = createRequire(partyRequire.resolve("miniflare"));
  const { WebSocket } = runtimeRequire("undici");
  const mapBytes = readFileSync(`${binary}.map`);
  const map = JSON.parse(mapBytes);
  const manifest = JSON.parse(
    map.sourcesContent[map.sources.indexOf("../package.json")]
  );
  const inventory = {
    node: process.version,
    partykit: manifest.version,
    binarySha256: createHash("sha256")
      .update(readFileSync(binary))
      .digest("hex"),
    mapSha256: createHash("sha256").update(mapBytes).digest("hex"),
    embeddedUndiciDeclaration: manifest.devDependencies.undici,
    embeddedUndiciSources: map.sources.filter((source) =>
      source.includes("/undici/")
    ).length,
    miniflare: runtimeRequire("miniflare/package.json").version,
    resolvedUndici: runtimeRequire("undici/package.json").version,
    securityRemediation:
      "patched entry uses resolved Undici; old inert factories retained",
    publisherVersion: runtimeRequire("undici/package.json").version,
    publisherSha256: createHash("sha256")
      .update(
        readFileSync(runtimeRequire.resolve("undici/lib/core/request.js"))
      )
      .digest("hex"),
  };
  const entryMockFetch = await qualifyRuntime(
    binary,
    partyRequire,
    runtimeRequire
  );
  if (process.argv[2] === "--inspect-bundle") {
    const sources = map.sources.flatMap((source, index) =>
      source.includes("/undici/") ? [[source, map.sourcesContent[index]]] : []
    );
    const installedRoot = dirname(
      runtimeRequire.resolve("undici/package.json")
    );
    const changedSources = sources.filter(([source, content]) => {
      const localPath = source.split("/undici/")[1];
      try {
        return readFileSync(join(installedRoot, localPath), "utf8") !== content;
      } catch {
        return true;
      }
    }).length;
    const report = JSON.stringify(
      {
        ...inventory,
        embeddedMockFetch: entryMockFetch,
        embeddedSourcesSha256: createHash("sha256")
          .update(JSON.stringify(sources))
          .digest("hex"),
        sourcesDifferentFromResolvedUndici: changedSources,
        embeddedExactVersion:
          "unknown: no embedded package version metadata; source fingerprint retained",
      },
      null,
      2
    );
    await new Promise((done) => process.stdout.write(`${report}\n`, done));
    process.exit(0);
  }
  const fixtureDirectory = mkdtempSync(join(tmpdir(), "motion-relay-fixture-"));
  const port = Number(process.argv[2] ?? 21999);
  assert(Number.isInteger(port) && port > 1024 && port < 65536);
  const reservation = createServer();
  await new Promise((done, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", done);
  });
  const inspectorPort = reservation.address().port;
  await new Promise((done) => reservation.close(done));
  writeFileSync(
    join(fixtureDirectory, "partykit.json"),
    JSON.stringify({
      name: "motion-fixture",
      main: resolve(root, "server/src/server.ts"),
      compatibilityDate: "2025-01-01",
    })
  );
  // The executable entry was qualified before the real child is launched.
  const evidence = createCollector(port, {
    ...inventory,
    inspectorPort,
    publisherQualified: true,
  });
  let phase = "relay ready";
  const child = spawn(
    process.execPath,
    [
      "--require",
      resolve(root, "scripts/relay-fixture-guard.cjs"),
      binary,
      "dev",
      "--config",
      join(fixtureDirectory, "partykit.json"),
      "--port",
      String(port),
      "--no-hotkeys",
      "--disable-request-cf-fetch",
      "--persist",
      join(fixtureDirectory, "state"),
      "--unstable_outdir",
      join(fixtureDirectory, "build"),
    ],
    {
      cwd: fixtureDirectory,
      env: {
        XDG_CONFIG_HOME: fixtureDirectory,
        TMPDIR: fixtureDirectory,
        RELAY_FIXTURE_DIRECTORY: fixtureDirectory,
        RELAY_FIXTURE_SOURCE_ROOT: root,
        CI: "1",
        RELAY_FIXTURE_PORT: String(port),
        RELAY_FIXTURE_INSPECTOR_PORT: String(inspectorPort),
        NO_UPDATE_NOTIFIER: "1",
        NODE_OPTIONS: `--require=${JSON.stringify(resolve(root, "scripts/relay-fixture-guard.cjs"))}`,
        PATH: "/usr/bin:/bin",
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    }
  );
  let childFailed = false;
  let childOutput = "";
  child.on("error", () => {
    childFailed = true;
  });
  child.stdout.on("data", (chunk) => {
    childOutput = (childOutput + chunk).slice(-8192);
    evidence.push("stdout", chunk);
  });
  child.stderr.on("data", (chunk) => {
    childOutput = (childOutput + chunk).slice(-8192);
    evidence.push("stderr", chunk);
  });
  const sockets = [];
  const checks = [];
  function stop(signal) {
    try {
      if (process.platform === "win32") child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  const deadline = setTimeout(() => stop("SIGTERM"), 25000);
  function client() {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/parties/main/FIX234`);
    const messages = [];
    socket.addEventListener("message", ({ data }) =>
      messages.push(JSON.parse(data))
    );
    sockets.push(socket);
    return {
      socket,
      messages,
      send: (message) => socket.send(JSON.stringify(message)),
    };
  }
  async function until(predicate, label, attempts = 100) {
    phase = label;
    for (let i = 0; i < attempts; i++) {
      if (predicate()) return;
      if (childFailed || child.exitCode !== null || child.signalCode !== null)
        throw new Error("PartyKit exited");
      await delay(50);
    }
    throw new Error("Qualification timed out");
  }
  async function connect(role) {
    const connection = client();
    await until(
      () => connection.socket.readyState === WebSocket.OPEN,
      "connect"
    );
    connection.send({ v: 1, type: "join", role });
    return connection;
  }
  try {
    await until(() => evidence.ready(), "relay ready", 300);
    const display = await connect("display");
    const controller = await connect("controller");
    await until(
      () => display.messages.some((m) => m.type === "peer" && m.connected),
      "presence"
    );
    checks.push("real relay handshake and presence");
    controller.send({ v: 1, type: "ping", t: 123 });
    await until(
      () => controller.messages.some((m) => m.type === "pong" && m.t === 123),
      "pong"
    );
    checks.push("ping/pong");
    const pose = {
      v: 1,
      type: "pose",
      seq: 1,
      sentAt: 12,
      quality: 1,
      joints: Object.fromEntries(
        [
          "head",
          "leftHand",
          "rightHand",
          "torso",
          "leftKnee",
          "rightKnee",
          "leftFoot",
          "rightFoot",
        ].map((name) => [name, [0.5, 0.5]])
      ),
    };
    controller.send(pose);
    await until(
      () => display.messages.some((m) => m.type === "pose"),
      "pose relay"
    );
    assert.deepEqual(
      display.messages.find((m) => m.type === "pose"),
      pose
    );
    display.send({ v: 1, type: "start" });
    await until(
      () => controller.messages.some((m) => m.type === "start"),
      "start relay"
    );
    checks.push("normalized pose and start relay");
    const duplicate = await connect("display");
    await until(
      () => duplicate.messages.some((m) => m.code === "room_full"),
      "duplicate role"
    );
    const replacement = await connect("controller");
    await until(
      () => controller.socket.readyState === WebSocket.CLOSED,
      "controller eviction"
    );
    replacement.socket.send("{bad-json");
    await until(
      () => replacement.messages.some((m) => m.code === "bad_message"),
      "malformed input"
    );
    replacement.socket.close();
    await until(
      () =>
        display.messages.at(-1)?.type === "peer" &&
        !display.messages.at(-1).connected,
      "disconnect presence"
    );
    checks.push(
      "duplicate display rejection, controller replacement, malformed input, disconnect presence"
    );
    await until(() => evidence.qualified(), "qualified inspector fetch");
    checks.push(
      "PartyKit inspector fetch through qualified resolved Undici 6.29.0"
    );
    console.log(
      JSON.stringify(
        {
          ...inventory,
          checks,
          observations: evidence.observations(),
        },
        null,
        2
      )
    );
  } catch (error) {
    // Private, bounded fixture diagnostics; never included in published evidence.
    writeFileSync(join(fixtureDirectory, "diagnostics.txt"), childOutput);
    console.log(
      JSON.stringify({
        status: "failed",
        phase,
        completedChecks: checks,
        observations: evidence.observations(),
        provenance: "UNKNOWN",
        failureType: error.name,
      })
    );
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
    for (const socket of sockets) socket.close();
    stop("SIGTERM");
    await new Promise((done) => {
      if (child.exitCode !== null) done();
      else {
        child.once("exit", done);
        setTimeout(() => {
          stop("SIGKILL");
          done();
        }, 2000).unref();
      }
    });
  }
} catch {
  console.log(
    JSON.stringify({
      status: "failed",
      phase: "setup",
      completedChecks: [],
      observations: [],
      provenance: "UNKNOWN",
    })
  );
  process.exitCode = 1;
}
