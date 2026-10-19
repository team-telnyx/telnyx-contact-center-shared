import test from "node:test";
import assert from "node:assert/strict";
import { saveFlowWithAssistantConfirmation } from "../lib/ai/flow-save-client.mjs";
import { ASSISTANT_EVENT_DESTINATION_CONFLICT } from "../lib/ai/assistant-event-conflicts.mjs";

const conflict = token => ({ ok: false, code: ASSISTANT_EVENT_DESTINATION_CONFLICT, error: "Eva already uses a different Conversation WebSocket.", conflicts: [{ assistantId: "eva", confirmationToken: token, currentUrl: "wss://dev.example/events", targetUrl: "wss://prod.example/events" }] });
const response = (status, value) => ({ status, ok: status < 400, json: async () => value });

test("cancel leaves the flow unsaved and never retries", async () => {
  let requests = 0;
  assert.equal(await saveFlowWithAssistantConfirmation("/flow", {}, { request: async () => { requests++; return response(409, conflict("one")); }, confirm: async () => false }), null);
  assert.equal(requests, 1);
});

test("approval retries the exact draft with scoped consent; imported consent is ignored", async () => {
  const draft = { name: "Draft", nodes: [{ id: "node" }], assistantEventDestinationConfirmations: [{ assistantId: "imported", confirmationToken: "untrusted" }] };
  const calls = [];
  const result = await saveFlowWithAssistantConfirmation("/api/voice/flows", draft, {
    method: "POST", request: async (url, options) => { calls.push(JSON.parse(options.body)); assert.equal(url, "/api/voice/flows"); assert.equal(options.method, "POST"); return calls.length === 1 ? response(409, conflict("one")) : response(200, { ok: true }); },
    confirm: async info => { assert.equal(info.message, conflict("one").error); draft.name = "Concurrent edit"; return true; },
  });
  assert.equal(result.ok, true);
  assert.equal(calls[0].assistantEventDestinationConfirmations, undefined);
  assert.deepEqual(calls[1], { ...calls[0], assistantEventDestinationConfirmations: [{ assistantId: "eva", confirmationToken: "one" }] });
  assert.equal(calls[1].name, "Draft");
});

test("a changed destination requires a new confirmation and propagates retry failures", async () => {
  let requests = 0, prompts = 0;
  await assert.rejects(saveFlowWithAssistantConfirmation("/flow", {}, {
    request: async () => ++requests < 3 ? response(409, conflict(String(requests))) : response(503, { error: "Telnyx unavailable; flow was not saved." }),
    confirm: async () => { prompts++; return true; },
  }), /Telnyx unavailable; flow was not saved/);
  assert.equal(prompts, 2);
});

test("server error messages survive; non-JSON failures have an actionable fallback", async () => {
  await assert.rejects(saveFlowWithAssistantConfirmation("/flow", {}, { request: async () => response(400, { error: "Add Skip Turn to Eva." }) }), /Add Skip Turn to Eva/);
  await assert.rejects(saveFlowWithAssistantConfirmation("/flow", {}, { request: async () => ({ status: 502, ok: false, json: async () => { throw new SyntaxError(); } }) }), /HTTP 502/);
});
