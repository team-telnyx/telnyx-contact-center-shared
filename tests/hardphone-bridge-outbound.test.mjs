import assert from "node:assert";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";

async function file(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("outbound hardphone bridge relay", () => {
  it("CC streaming sidecar accepts outbound bridge websocket sessions and exposes command APIs", async () => {
    const streaming = await file("lib/streaming-ws-handler.mjs");
    const relay = await file("lib/hardphones/bridge-relay.mjs");

    assert.match(streaming, /\/hardphone-bridge/);
    assert.match(streaming, /handleHardphoneBridgeConnection/);
    assert.match(streaming, /\/api\/hardphone-bridge\/bridges/);
    assert.match(streaming, /\/api\/hardphone-bridge\/command/);

    assert.match(relay, /registerBridgeConnection/);
    assert.match(relay, /sendBridgeCommand/);
    assert.match(relay, /command_id/);
    assert.match(relay, /HARDPHONE_BRIDGE_TOKEN/);
    assert.match(relay, /result_timeout/);
  });

  it("local bridge opens an outbound websocket to CC and executes command messages", async () => {
    const server = await file("tools/hardphone-bridge/server.mjs");
    const env = await file("tools/hardphone-bridge/.env.example");
    const readme = await file("tools/hardphone-bridge/README.md");

    assert.match(server, /CC_WS_URL/);
    assert.match(server, /BRIDGE_ID/);
    assert.match(server, /new WebSocket/);
    assert.match(server, /type: "hello"/);
    assert.match(server, /type: "command_result"/);
    assert.match(server, /executeCommand/);

    assert.match(env, /CC_WS_URL=/);
    assert.match(env, /BRIDGE_ID=/);
    assert.match(readme, /outbound WebSocket/i);
    assert.match(readme, /host\.docker\.internal/);
  });
});
