import { createRequire } from "node:module";
import { readFileSync, realpathSync } from "node:fs";
import { channel } from "node:diagnostics_channel";
import { createServer } from "node:http";
import { expect, it } from "vitest";

const { diagnosticCallback, createCollector, hash } = createRequire(
  import.meta.url
)("../../scripts/relay-diagnostics.cjs");
const identity = {
  port: 21999,
  binary: "/fixture/bin.mjs",
  guard: "/fixture/guard.cjs",
  binarySha256: hash("executable fixture"),
  mapSha256: hash("map fixture"),
};
const request = {
  method: "GET",
  origin: "http://127.0.0.1:21999",
  path: "/json",
};

it("qualifies only the actual installed Undici publisher on native V8 call sites", async () => {
  const partyRequire = createRequire(
    realpathSync(
      new URL("../node_modules/partykit/dist/bin.mjs", import.meta.url)
    )
  );
  const runtimeRequire = createRequire(partyRequire.resolve("miniflare"));
  const publisher = realpathSync(
    runtimeRequire.resolve("undici/lib/core/request.js")
  );
  const server = createServer((incoming, response) => {
    response.writeHead(
      incoming.method === "GET" && incoming.url === "/json" ? 200 : 404
    );
    response.end("fictional inspector");
  });
  await new Promise((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  const inspectorPort = server.address().port;
  const origin = `http://127.0.0.1:${inspectorPort}`;
  const qualified = {
    ...identity,
    inspectorPort,
    publisher,
    publisherVersion: "6.29.0",
    publisherSha256: hash(readFileSync(publisher)),
    publisherQualified: true,
  };
  const collector = createCollector(identity.port, qualified);
  const callback = diagnosticCallback(qualified, (value) =>
    collector.push("stdout", value)
  );
  const notifications = channel("undici:request:create");
  notifications.subscribe(callback);
  const { Agent, fetch } = runtimeRequire("undici");
  const agent = new Agent();
  try {
    const response = await fetch(`${origin}/json`, {
      dispatcher: agent,
    });
    expect(await response.text()).toBe("fictional inspector");
    expect(collector.qualified()).toBe(true);
    expect(collector.observations()[0].publisher).toEqual({
      kind: "external-undici",
      version: "6.29.0",
      sourceSha256: qualified.publisherSha256,
    });
    expect(collector.observations()[0].bundled).toBe("FALSE");
  } finally {
    notifications.unsubscribe(callback);
    await agent.close();
    await new Promise((done) => server.close(done));
  }
  // Publishing the same fixture object directly has no implementation frame.
  notifications.subscribe(callback);
  const before = collector.observations().length;
  try {
    notifications.publish({ request: { ...request, origin } });
  } finally {
    notifications.unsubscribe(callback);
  }
  expect(collector.observations()[before].bundled).toBe("UNKNOWN");
});
