import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const admissionPath = new URL("../lib/acd/admission.mjs", import.meta.url);
const inboxPath = new URL("../lib/acd/inbox.mjs", import.meta.url);
const workerPath = new URL("../lib/acd/worker.mjs", import.meta.url);
const incomingWebhookRoutePath = new URL("../app/api/voice/webhook/incoming/[flowId]/route.js", import.meta.url);

async function readSource(path) {
  return readFile(path, "utf8");
}

test("Core-owned webhook events are persisted before the worker can apply domain mutations", async () => {
  const admission = await readSource(admissionPath);
  const inbox = await readSource(inboxPath);
  const worker = await readSource(workerPath);

  assert.match(admission, /await persistWebhookEvent\(pool, event\)/);
  assert.match(admission, /pg_notify\('acd_events'/);
  assert.ok(
    admission.indexOf("await persistWebhookEvent(pool, event)") < admission.indexOf("pg_notify('acd_events'"),
    "durable INSERT must precede the worker notification",
  );
  assert.match(inbox, /ON CONFLICT \(event_id\) DO NOTHING/);
  assert.match(inbox, /FOR UPDATE SKIP LOCKED/);
  assert.match(inbox, /status = 'processing'/);
  assert.match(inbox, /lease_owner = \$1/);
  assert.match(worker, /runInboxWorkerOnce\(pool/);
  assert.match(worker, /applyClaimedAcdVoiceEvent/);
  assert.match(worker, /replayVoiceEffects\(row, live\)/);
});

test("incoming voice webhook route admits the immutable Telnyx event envelope into ACD Core", async () => {
  const source = await readSource(incomingWebhookRoutePath);

  assert.match(source, /eventId: body\?\.data\?\.id \|\| null/);
  assert.match(source, /eventType: event/);
  assert.match(source, /occurredAt: body\?\.data\?\.occurred_at \|\| null/);
  assert.match(source, /sourceRoute: "incoming"/);
  assert.match(source, /sourceFlowId: flowId/);
  assert.match(source, /await admitAcdVoiceEvent\(acdPool, acdEvent\)/);
  assert.match(source, /ACD durable intake unavailable/);
  assert.doesNotMatch(source, /handleContactCenterEvent/);
});
