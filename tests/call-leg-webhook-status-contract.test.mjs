import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

test("agent leg call.initiated is treated as ringing and marks agent Busy", async () => {
  const webhookSource = await source("../lib/contact-center/webhook-handler.js");

  assert.match(
    webhookSource,
    /eventType\s*===\s*["']call\.initiated["'][\s\S]{0,1800}metadata->>'agent_call_control_id'/,
    "call.initiated webhooks must look up existing CC interactions by agent leg id",
  );
  assert.match(
    webhookSource,
    /case\s+["']call\.initiated["'][\s\S]{0,900}event:\s*["']ringing["']/,
    "agent leg call.initiated must delegate ringing to lifecycle status handler",
  );
  assert.match(
    webhookSource,
    /case\s+["']call\.initiated["'][\s\S]{0,900}updates\.state\s*=\s*["']ringing["']/,
    "agent leg call.initiated must keep interaction state ringing, not connected",
  );
});

test("call hangup status outcome is based on which leg ended and answer evidence", async () => {
  const webhookSource = await source("../lib/contact-center/webhook-handler.js");

  assert.match(
    webhookSource,
    /const\s+isOriginalCustomerLegHangup\s*=/,
    "hangup handler must explicitly detect customer/original leg hangups",
  );
  assert.match(
    webhookSource,
    /isOriginalCustomerLegHangup[\s\S]{0,1300}event:\s*["']customer-abandoned["']/,
    "customer/original leg hangup during ringing must return the agent to Available",
  );
  assert.match(
    webhookSource,
    /isAgentLegNoAnswerDisconnect[\s\S]{0,900}handleAgentLegNoAnswerDisconnect/,
    "agent leg hangup before answer must run the no-answer handler",
  );
  assert.match(
    webhookSource,
    /!wasAbandoned[\s\S]{0,700}startServerSideWrapupForInteraction/,
    "answered/completed hangup must start server-side wrapup",
  );
});

test("lifecycle status transitions clear current_calls_count after calls leave the agent", async () => {
  const lifecycleSource = await source("../lib/contact-center/agent-call-lifecycle-status.js");

  assert.match(
    lifecycleSource,
    /async function clearResolvedAgentCallCount/,
    "lifecycle handler must own DB current_calls_count cleanup after hangup/no-answer/abandon",
  );
  assert.match(
    lifecycleSource,
    /case\s+["']disconnected["'][\s\S]{0,1200}clearCallCount:\s*true/,
    "answered hangup -> Wrapup must also clear active call count",
  );
  assert.match(
    lifecycleSource,
    /case\s+["']no-answer["'][\s\S]{0,1200}clearCallCount:\s*true/,
    "agent no-answer must clear active call count",
  );
  assert.match(
    lifecycleSource,
    /case\s+["']customer-abandoned["'][\s\S]{0,1200}status:\s*["']Available["']/,
    "customer abandoned ringing call must return the agent to Available",
  );
});

test("server-side wrapup emits a direct wrapup_required event for the agent UI", async () => {
  const webhookSource = await source("../lib/contact-center/webhook-handler.js");

  assert.match(
    webhookSource,
    /startServerSideWrapupForInteraction[\s\S]{0,2200}type:\s*["']wrapup_required["']/,
    "server-side wrapup must directly tell the agent UI to open wrapup sheet",
  );
  assert.match(
    webhookSource,
    /wrapup_required[\s\S]{0,500}answeredAt/,
    "wrapup_required payload must include answered evidence for UI gating",
  );
});
