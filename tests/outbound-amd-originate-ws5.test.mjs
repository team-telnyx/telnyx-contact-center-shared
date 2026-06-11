import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const executionPath = new URL("../lib/outbound-dialer/execution.js", import.meta.url);
const routePath = new URL(
  "../app/api/voice/webhook/incoming/[flowId]/route.js",
  import.meta.url,
);

test("WS5-T2 originate includes client_state with {campaignId, attemptId} (base64 JSON)", async () => {
  const source = await readFile(executionPath, "utf8");
  assert.match(
    source,
    /campaignId: campaignRow\.id,\s*\n\s*attemptId: ledgerRow\.id/,
    "client_state must carry campaignId and attemptId",
  );
  assert.match(
    source,
    /client_state: clientState,/,
    "originate payload must include client_state",
  );
  assert.match(source, /toString\("base64"\)/, "client_state must be base64 JSON");
});

test("WS5-T2 AMD is config-driven and additive (off → pre-WS5 payload shape)", async () => {
  const source = await readFile(executionPath, "utf8");
  assert.match(
    source,
    /const amdEnabled = amdConfig\?\.enabled === true;/,
    "AMD only enabled when amd_config.enabled === true",
  );
  assert.match(
    source,
    /\.\.\.\(amdEnabled\s*\?\s*\{\s*answering_machine_detection:/,
    "answering_machine_detection only present when AMD enabled",
  );
  assert.match(
    source,
    /amdConfig\.mode === "premium" \? "premium" : "detect_words"/,
    "AMD mode mapping",
  );
});

test("WS5-T2 machine detection handler: human connect path, machine voicemail action", async () => {
  const source = await readFile(executionPath, "utf8");
  assert.match(
    source,
    /export async function handleOutboundMachineDetection/,
    "handler exported",
  );
  assert.match(
    source,
    /registerWebhookEventOnce\(pool, \{\s*eventId,\s*callControlId,\s*eventType,\s*\}\)/,
    "AMD events deduped via outbound_webhook_events (replay-safe)",
  );
  assert.match(
    source,
    /return \{ status: "human", ledgerId: ledger\.id \};/,
    "human result returns connect path marker",
  );
  assert.match(
    source,
    /\["drop_message", "leave_message"\]\.includes\(voicemailAction\) && voicemailMessage/,
    "drop_message action speaks the configured message",
  );
  assert.match(
    source,
    /actions\/hangup/,
    "default machine action hangs up",
  );
  // The handler must classify AMD results through the shared dial-state mapper.
  assert.match(
    source,
    /applyDialStateForEvent\(pool, ledger, eventType, \{\s*amdResult: normalizedResult,/,
    "AMD drives the dial-state machine",
  );
});

test("WS5-T2 webhook route dispatches call.machine.detection.ended to the outbound handler", async () => {
  const source = await readFile(routePath, "utf8");
  assert.match(
    source,
    /event === "call\.machine\.detection\.ended"/,
    "route reacts to AMD events",
  );
  assert.match(
    source,
    /handleOutboundMachineDetection\(pool, \{\s*callControlId,\s*amdResult: payload\?\.result \|\| null,/,
    "route passes the Telnyx AMD result",
  );
  // Existing agentless finalization must remain untouched.
  assert.match(
    source,
    /finalizeAgentlessAttemptByWebhook\(pool, \{\s*callControlId,\s*eventType: event,/,
    "legacy finalization path intact",
  );
});

test("WS5-T2 voicemail drop transitions dial_state to voicemail_action", async () => {
  const source = await readFile(executionPath, "utf8");
  assert.match(
    source,
    /transitionDialState\(pool, ledger\.id, "voicemail_action", \{\s*event: eventType,\s*reason: voicemailAction,/,
    "drop_message records voicemail_action state",
  );
  assert.match(
    source,
    /transitionDialState\(pool, ledger\.id, "voicemail_action", \{\s*event: eventType,\s*reason: "hangup",/,
    "hangup records voicemail_action state",
  );
});
