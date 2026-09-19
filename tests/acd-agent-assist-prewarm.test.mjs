import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  agentAssistSttConfigFromClientState,
  prewarmAgentAssistTransport,
} from "../lib/acd/agent-assist-prewarm.mjs";

function encoded(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64");
}

test("Core prewarm reads Agent Assist STT config from transferred client state", () => {
  const config = { enabled: true, transcription_tracks: "both", language: "en-US" };
  assert.deepEqual(
    agentAssistSttConfigFromClientState(encoded({ telnyx_stt_config: config })),
    config,
  );
  assert.equal(agentAssistSttConfigFromClientState("not-base64-json"), null);
});

test("Core prewarms the exact agent transport leg", async () => {
  const calls = [];
  const started = await prewarmAgentAssistTransport({
    callControlId: "transport-leg",
    clientState: encoded({ telnyx_stt_config: { enabled: true } }),
    interactionId: "work-item",
    agentUsername: "agent@example.com",
    prewarm: async (...args) => calls.push(args),
  });

  assert.equal(started, true);
  assert.deepEqual(calls, [[
    "transport-leg",
    { enabled: true },
    "work-item",
    "agent@example.com",
  ]]);
});

test("Core skips prewarm when Agent Assist is disabled", async () => {
  let called = false;
  const started = await prewarmAgentAssistTransport({
    callControlId: "transport-leg",
    clientState: encoded({ telnyx_stt_config: { enabled: false } }),
    interactionId: "work-item",
    agentUsername: "agent@example.com",
    prewarm: async () => { called = true; },
  });
  assert.equal(started, false);
  assert.equal(called, false);
});

test("connect saga prewarms only when the provider response includes a transport leg id", async () => {
  const source = await readFile(
    new URL("../lib/acd/sagas/connect.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /onAccepted:[\s\S]*agentLegProviderId[\s\S]*prewarmAgentAssistTransport\(\{/);
  assert.match(source, /response\?\.data\?\.call_control_id \|\| null/);
  assert.match(source, /clientState: data\.clientState/);
  assert.match(source, /agentUsername: data\.agentUsername/);
  assert.doesNotMatch(source, /transfer response carries the new agent leg/);
});
