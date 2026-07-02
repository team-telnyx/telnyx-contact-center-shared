import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const webhookHandlerPath = new URL("../lib/contact-center/webhook-handler.js", import.meta.url);
const incomingWebhookRoutePath = new URL("../app/api/voice/webhook/incoming/[flowId]/route.js", import.meta.url);

async function readSource(path) {
  return readFile(path, "utf8");
}

test("contact-center webhook events are deduplicated before interaction lookup or mutation", async () => {
  const source = await readSource(webhookHandlerPath);

  assert.match(
    source,
    /import\s+\{\s*alreadyProcessed\s*\}\s+from\s+["']\.\.\/events\/idempotency\.js["']/,
    "handler should use the DB-backed idempotency primitive",
  );
  assert.match(
    source,
    /export async function handleContactCenterEvent\(eventType, payload,\s*opts\s*=\s*\{\}\)/,
    "handler should accept webhook metadata/options without breaking existing callers",
  );
  assert.match(
    source,
    /const eventId\s*=\s*opts\?\.eventId\s*\|\|\s*payload\?\.event_id\s*\|\|\s*payload\?\.id\s*\|\|\s*null/,
    "handler should resolve a stable Telnyx webhook event id",
  );

  const handlerStart = source.indexOf("export async function handleContactCenterEvent");
  assert.notEqual(handlerStart, -1, "contact-center event handler should exist");
  const handlerSource = source.slice(handlerStart);
  const dedupeIndex = handlerSource.indexOf("alreadyProcessed(eventId");
  const lookupIndex = handlerSource.indexOf("PgDb.findInteractionByCallControlId");
  const updatesIndex = handlerSource.indexOf("const updates = {}");

  assert.notEqual(dedupeIndex, -1, "handler should check idempotency for identified events");
  assert.ok(
    dedupeIndex < lookupIndex,
    "idempotency check must happen before interaction lookup to avoid duplicate side effects",
  );
  assert.ok(
    dedupeIndex < updatesIndex,
    "idempotency check must happen before building/applying interaction updates",
  );
  assert.match(
    source,
    /if\s*\(await alreadyProcessed\(eventId,\s*`contact-center:\$\{eventType\}`[\s\S]*?\)\)\s*\{[\s\S]*?return \{ handled: false, duplicate: true \};[\s\S]*?\}/,
    "duplicate webhook events should return before mutating contact-center state",
  );
});

test("incoming voice webhook route passes Telnyx data.id into contact-center event handling", async () => {
  const source = await readSource(incomingWebhookRoutePath);

  assert.match(
    source,
    /const webhookEventId\s*=\s*body\?\.data\?\.id\s*\|\|\s*null/,
    "route should extract the Telnyx webhook id from data.id",
  );
  assert.match(
    source,
    /handleContactCenterEvent\(event, payload, \{ eventId: webhookEventId \}\)/,
    "all contact-center event dispatches should pass the webhook id for DB-backed dedupe",
  );
});
