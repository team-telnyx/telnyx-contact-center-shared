import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { cobrowseGatewayTarget, startCobrowseLocalGateway } from "../scripts/cobrowse-local-gateway.mjs";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

test("local co-browsing gateway forwards app HTTP and sidecar HTTP/WebSocket on one port", async () => {
  assert.deepEqual(cobrowseGatewayTarget("/ws/cobrowse?x=1", 3000, 3001), { port: 3001, path: "/cobrowse?x=1" });
  assert.deepEqual(cobrowseGatewayTarget("/ws-other", 3000, 3001), { port: 3000, path: "/ws-other" });
  const app = createServer((request, response) => response.end(`app:${request.url}`));
  const sidecar = createServer((request, response) => response.end(`sidecar:${request.url}`));
  const appPort = await listen(app);
  const sidecarPort = await listen(sidecar);
  const wss = new WebSocketServer({ server: sidecar, path: "/cobrowse" });
  wss.on("connection", (socket) => socket.on("message", (message) => socket.send(`echo:${message}`)));
  const gateway = await startCobrowseLocalGateway({ port: 0, appPort, sidecarPort });
  let client;
  try {
    assert.equal(await (await fetch(`http://127.0.0.1:${gateway.port}/api/health`)).text(), "app:/api/health");
    assert.equal(await (await fetch(`http://127.0.0.1:${gateway.port}/ws/health`)).text(), "sidecar:/health");
    client = new WebSocket(`ws://127.0.0.1:${gateway.port}/ws/cobrowse`);
    await once(client, "open");
    client.send("hello");
    const [message] = await once(client, "message");
    assert.equal(String(message), "echo:hello");
  } finally {
    client?.close();
    await gateway.close();
    await new Promise((resolveClosed) => wss.close(resolveClosed));
    await new Promise((resolveClosed) => app.close(resolveClosed));
    await new Promise((resolveClosed) => sidecar.close(resolveClosed));
  }
});
