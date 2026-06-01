import assert from "node:assert/strict";
import { once } from "node:events";
import { get } from "node:http";
import test from "node:test";

function requestHealth(port) {
  return new Promise((resolve, reject) => {
    const req = get({ hostname: "127.0.0.1", port, path: "/api/health", timeout: 1000 }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("timeout", () => {
      req.destroy(new Error("health request timed out"));
    });
    req.on("error", reject);
  });
}

test("streaming websocket server can be explicitly shut down and releases its port", async () => {
  const port = 41000 + Math.floor(Math.random() * 1000);
  process.env.STREAMING_WS_PORT = String(port);

  const moduleUrl = new URL(
    `../lib/streaming-ws-handler.mjs?shutdown-test=${Date.now()}-${Math.random()}`,
    import.meta.url,
  );
  const { initStreamingWSServer, shutdownStreamingWSServer } = await import(moduleUrl);

  initStreamingWSServer();
  const server = globalThis.__streamingHttpServer;
  assert.ok(server, "init should expose the active HTTP server for lifecycle management");
  if (!server.listening) await once(server, "listening");

  assert.equal(await requestHealth(port), 200);

  await shutdownStreamingWSServer();

  assert.equal(globalThis.__streamingHttpServer, null);
  assert.equal(globalThis.__streamingWss, null);
  assert.equal(globalThis.__streamingWsPort, null);

  await assert.rejects(requestHealth(port), /ECONNREFUSED|ECONNRESET|socket hang up|health request timed out/);

  initStreamingWSServer();
  const restartedServer = globalThis.__streamingHttpServer;
  assert.ok(restartedServer, "server should restart on the same port after shutdown");
  if (!restartedServer.listening) await once(restartedServer, "listening");
  assert.equal(await requestHealth(port), 200);

  await shutdownStreamingWSServer();
});

test("streaming websocket module installs SIGINT and SIGTERM shutdown handlers", async () => {
  const sourceModule = await import(
    new URL(`../lib/streaming-ws-handler.mjs?signal-test=${Date.now()}-${Math.random()}`, import.meta.url)
  );

  assert.equal(typeof sourceModule.shutdownStreamingWSServer, "function");

  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("../lib/streaming-ws-handler.mjs", import.meta.url), "utf8"),
  );

  assert.match(source, /process\.once\(\s*"SIGINT"/);
  assert.match(source, /process\.once\(\s*"SIGTERM"/);
  assert.match(source, /shutdownStreamingWSServer/);
});
