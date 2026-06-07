import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeLogPayload } from "../lib/logger/redaction.mjs";

test("safe debug identifier keys only bypass token-shaped string redaction", () => {
  const safeString = "018f0ef2-9a2c-7c6b-a5a6-8327b631d771";
  assert.equal(sanitizeLogPayload({ flowId: safeString }).flowId, safeString);
});

test("agent assist and admin domain identifiers are preserved for debugging", () => {
  const uuid = "018f0ef2-9a2c-7c6b-a5a6-8327b631d771";
  const payload = sanitizeLogPayload({
    sessionId: uuid,
    workflowId: uuid,
    stageId: uuid,
    itemId: uuid,
    groupId: uuid,
    insightId: uuid,
    appId: uuid,
    eventId: uuid,
    campaignId: uuid,
    contactListId: uuid,
    dncListId: uuid,
    attemptControlId: uuid,
    filterId: uuid,
    timeSetId: uuid,
    dispositionCodeId: uuid,
  });

  for (const [key, value] of Object.entries(payload)) {
    assert.equal(value, uuid, `${key} should not be redacted`);
  }
});

test("safe debug identifier keys still sanitize nested non-string values", () => {
  const payload = sanitizeLogPayload({
    flowId: {
      id: "018f0ef2-9a2c-7c6b-a5a6-8327b631d771",
      authorization: "Bearer supersecrettokenvalue1234567890",
      stream_url: "wss://example.test/stream?secret=abc123&room=main",
    },
  });

  assert.deepEqual(payload, {
    flowId: {
      id: "[redacted:string:36]",
      authorization: "[redacted:string:38]",
      stream_url: "wss://example.test/stream?secret=%5BREDACTED%5D&room=%5BREDACTED_PARAM%5D",
    },
  });
});

test("safe debug identifier array values do not bypass string redaction", () => {
  const payload = sanitizeLogPayload({
    flowId: ["Bearer supersecrettokenvalue1234567890", "018f0ef2-9a2c-7c6b-a5a6-8327b631d771"],
  });

  assert.deepEqual(payload, {
    flowId: ["[redacted:string:38]", "[redacted:string:36]"],
  });
});
