import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const webhookHandlerPath = new URL(
  "../lib/contact-center/webhook-handler.js",
  import.meta.url,
);

async function source(path) {
  return readFile(path, "utf8");
}

test("call.dequeued does not move an unassigned queued interaction to ringing", async () => {
  const src = await source(webhookHandlerPath);

  const dequeuedCase = src.slice(
    src.indexOf('case "call.dequeued"'),
    src.indexOf('case "call.held"'),
  );

  assert.match(dequeuedCase, /interaction\.agent_username/);
  assert.match(dequeuedCase, /updates\.state\s*=\s*"ringing"/);
  assert.doesNotMatch(
    dequeuedCase,
    /if\s*\(\s*interaction\.state\s*===\s*"queued"\s*\)\s*{[\s\S]*updates\.state\s*=\s*"ringing"/,
    "dequeued must not blindly convert queued calls into ringing without an assigned agent",
  );
});

test("call.hangup abandons any un-answered interaction even if it is already ringing", async () => {
  const src = await source(webhookHandlerPath);

  const hangupCase = src.slice(
    src.indexOf('case "call.hangup"'),
    src.indexOf('case "call.dequeued"'),
  );

  assert.match(hangupCase, /latestInteraction\.answered_at/);
  assert.doesNotMatch(
    hangupCase,
    /interaction\.state\s*===\s*"queued"\s*\?\s*"abandoned"\s*:\s*"completed"/,
    "hangup final state must be based on answered_at, not only queued state",
  );
});
