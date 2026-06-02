import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import test from "node:test";

async function getFreePort() {
  const { createServer } = await import("node:net");
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function waitForHealth(port, timeoutMs = 1000) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return response.json();
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw lastError || new Error(`health endpoint did not become ready on ${port}`);
}

async function assertHealthUnavailable(port) {
  await assert.rejects(
    () => fetch(`http://127.0.0.1:${port}/api/health`),
    /fetch failed|ECONNREFUSED|terminated/,
  );
}

test("streaming websocket server exposes HTTP health endpoint for load balancer checks", async () => {
  const source = await readFile(
    new URL("../lib/streaming-ws-handler.mjs", import.meta.url),
    "utf8",
  );

  assert.match(source, /createServer/);
  assert.match(source, /\/api\/health/);
  assert.match(source, /status:\s*"healthy"/);
  assert.match(source, /server\.listen\(port/);
  assert.match(source, /new WebSocketServer\(\{\s*server\s*\}\)/);
});

test("streaming websocket server can shutdown and rebind the same port", async () => {
  const port = await getFreePort();
  const moduleUrl = new URL(`../lib/streaming-ws-handler.mjs?test=${Date.now()}`, import.meta.url);
  const {
    initStreamingWSServer,
    shutdownStreamingWSServer,
    waitForStreamingWSServerReady,
  } = await import(moduleUrl);

  initStreamingWSServer({ port, registerProcessHandlers: false });
  // A second init while the first listener is still binding should be ignored,
  // not orphan a server that shutdown cannot see later.
  initStreamingWSServer({ port, registerProcessHandlers: false });
  await waitForStreamingWSServerReady();
  const firstHealth = await waitForHealth(port);
  assert.equal(firstHealth.status, "healthy");
  assert.equal(firstHealth.port, port);

  const shutdownResult = await shutdownStreamingWSServer({ reason: "test_shutdown" });
  assert.equal(shutdownResult.stopped, true);

  await assertHealthUnavailable(port);

  initStreamingWSServer({ port, registerProcessHandlers: false });
  await waitForStreamingWSServerReady();
  const secondHealth = await waitForHealth(port);
  assert.equal(secondHealth.status, "healthy");
  assert.equal(secondHealth.port, port);

  await shutdownStreamingWSServer({ reason: "test_cleanup" });
});

test("streaming websocket shutdown has a deadline for connected clients", async () => {
  const port = await getFreePort();
  const moduleUrl = new URL(`../lib/streaming-ws-handler.mjs?test=client-timeout-${Date.now()}`, import.meta.url);
  const {
    initStreamingWSServer,
    shutdownStreamingWSServer,
    waitForStreamingWSServerReady,
  } = await import(moduleUrl);

  const state = initStreamingWSServer({ port, registerProcessHandlers: false });
  await waitForStreamingWSServerReady();

  const fakeClient = new EventEmitter();
  fakeClient.readyState = 1;
  fakeClient.CLOSED = 3;
  fakeClient.close = () => {};
  fakeClient.terminate = () => {
    fakeClient.readyState = fakeClient.CLOSED;
    fakeClient.emit("close");
  };
  state.wss.clients.add(fakeClient);

  const startedAt = Date.now();
  const shutdownResult = await shutdownStreamingWSServer({
    reason: "test_client_timeout",
    clientCloseTimeoutMs: 10,
    serverCloseTimeoutMs: 100,
  });
  assert.equal(shutdownResult.stopped, true);
  assert.ok(Date.now() - startedAt < 1000, "shutdown should not wait indefinitely for WebSocket clients");
  await assertHealthUnavailable(port);
});

test("streaming websocket init is ignored while shutdown is in progress", async () => {
  const port = await getFreePort();
  const moduleUrl = new URL(`../lib/streaming-ws-handler.mjs?test=init-during-shutdown-${Date.now()}`, import.meta.url);
  const {
    initStreamingWSServer,
    shutdownStreamingWSServer,
    waitForStreamingWSServerReady,
  } = await import(moduleUrl);

  const state = initStreamingWSServer({ port, registerProcessHandlers: false });
  await waitForStreamingWSServerReady();

  const fakeClient = new EventEmitter();
  fakeClient.readyState = 1;
  fakeClient.CLOSED = 3;
  fakeClient.close = () => {};
  fakeClient.terminate = () => {
    fakeClient.readyState = fakeClient.CLOSED;
    fakeClient.emit("close");
  };
  state.wss.clients.add(fakeClient);

  const shutdownPromise = shutdownStreamingWSServer({
    reason: "test_shutdown_race",
    clientCloseTimeoutMs: 50,
    serverCloseTimeoutMs: 100,
  });
  const initDuringShutdownState = initStreamingWSServer({ port, registerProcessHandlers: false });
  assert.equal(initDuringShutdownState, state);

  const shutdownResult = await shutdownPromise;
  assert.equal(shutdownResult.stopped, true);
  await assertHealthUnavailable(port);

  initStreamingWSServer({ port, registerProcessHandlers: false });
  await waitForStreamingWSServerReady();
  const health = await waitForHealth(port);
  assert.equal(health.status, "healthy");
  await shutdownStreamingWSServer({ reason: "test_cleanup" });
});

test("streaming websocket server releases its port on SIGTERM", async () => {
  const port = await getFreePort();
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
        import { initStreamingWSServer, waitForStreamingWSServerReady } from './lib/streaming-ws-handler.mjs';
        initStreamingWSServer({ port: ${port} });
        await waitForStreamingWSServerReady();
        console.log('READY:${port}');
        await new Promise(() => {});
      `,
    ],
    {
      cwd: new URL("..", import.meta.url),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  try {
    await waitForHealth(port, 2000);

    child.kill("SIGTERM");
    const exit = await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        resolve({ code: null, signal: "timeout" });
      }, 2000);
      child.on("exit", (code, signal) => {
        clearTimeout(timeout);
        resolve({ code, signal });
      });
    });

    assert.equal(exit.code, 0, stderr || stdout);
    await assertHealthUnavailable(port);
  } finally {
    if (!child.killed) child.kill("SIGKILL");
  }
});
