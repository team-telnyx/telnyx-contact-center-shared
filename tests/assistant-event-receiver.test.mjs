import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import WebSocket from "ws";
import { createAssistantEventReceiver } from "../lib/ai/assistant-event-receiver.mjs";

test("receiver rejects missing credentials, buffers during correlation and flushes before disconnect", async () => {
  const received = [], disconnected = [];
  const receiver = createAssistantEventReceiver({ config: () => ({ token: "test-only" }), getPool: () => ({}),
    bind: async (_pool, session) => { assert.equal(session.conversation_id, "owned"); await new Promise(r => setTimeout(r, 180)); return "invitation"; },
    accept: async (_pool, id, _connection, events) => { assert.equal(id, "invitation"); received.push(...events); },
    disconnect: async (_pool, id) => disconnected.push(id),
  });
  const server = createServer(); server.on("upgrade", receiver.upgrade);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `ws://127.0.0.1:${server.address().port}/assistant-events`;
  try {
    const rejected = new WebSocket(url); rejected.on("error", () => {});
    const [, response] = await once(rejected, "unexpected-response"); assert.equal(response.statusCode, 401); response.resume(); rejected.terminate();
    const client = new WebSocket(url, { headers: { Authorization: "Bearer test-only" } }); await once(client, "open");
    client.send(JSON.stringify({ type: "session.created", session: { conversation_id: "owned" } }));
    client.send(JSON.stringify({ type: "response.text.delta", item_id: "one", delta: "hello" }));
    await new Promise(resolve => setTimeout(resolve, 250));
    client.send(JSON.stringify({ type: "response.text.delta", item_id: "one", delta: " world" }));
    client.close(); await once(client, "close"); await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(received.map(e => e.delta).join(""), "hello world"); assert.deepEqual(disconnected, ["invitation"]);
  } finally { receiver.close(); await new Promise(resolve => server.close(resolve)); }
});
