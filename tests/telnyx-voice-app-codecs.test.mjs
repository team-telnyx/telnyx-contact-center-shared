import { test } from "node:test";
import assert from "node:assert/strict";

// Zadanie 1: Voice Applications created via the Telnyx API must pin inbound
// codecs to G711 (PCMA/PCMU) and never include G722. A G722 leg starves the
// Telnyx Standalone STT media stream (stream_codec=PCMU/mulaw) → no caller
// transcription / Agent Assist bubbles.

process.env.TELNYX_API_KEY = process.env.TELNYX_API_KEY || "test-key";

async function withFetchCapture(fn) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, options = {}) => {
    calls.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          data: {
            id: "app-123",
            application_name: "test",
            webhook_event_url: "https://example.test/webhook",
            created_at: "2026-06-14T00:00:00Z",
          },
        });
      },
    };
  };
  try {
    await fn(calls);
  } finally {
    global.fetch = original;
  }
}

test("createVoiceApplication pins inbound codecs to G711A+G711U (no G722)", async () => {
  const { createVoiceApplication } = await import("../lib/telnyx-voice-apps.js");
  await withFetchCapture(async (calls) => {
    await createVoiceApplication("Test App", "https://example.test/webhook");
    assert.equal(calls.length, 1);
    const body = calls[0].body;
    assert.ok(body.inbound, "payload must carry inbound block");
    assert.deepEqual(body.inbound.codecs, ["G711A", "G711U"]);
    assert.ok(!body.inbound.codecs.includes("G722"), "must never offer G722");
  });
});

test("createVoiceApplication keeps codecs AND sets sip_subdomain when flowId given", async () => {
  const { createVoiceApplication } = await import("../lib/telnyx-voice-apps.js");
  await withFetchCapture(async (calls) => {
    await createVoiceApplication("Flow App", "https://example.test/webhook", "flow-abc");
    const body = calls[0].body;
    assert.deepEqual(body.inbound.codecs, ["G711A", "G711U"]);
    assert.equal(body.inbound.sip_subdomain, "flow-abc");
    assert.equal(body.inbound.sip_subdomain_receive_settings, "from_anyone");
  });
});
