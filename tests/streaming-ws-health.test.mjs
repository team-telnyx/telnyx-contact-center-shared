import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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
