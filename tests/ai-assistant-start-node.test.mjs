import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { VOICE_FLOW_NODES } from "../config/voice-flow-nodes.js";

test("Start AI Assistant node config exposes send_message_history_updates as a boolean field", () => {
  const field =
    VOICE_FLOW_NODES.ai_assistant_start.config.send_message_history_updates;
  assert.ok(field, "node config should declare send_message_history_updates");
  assert.equal(field.type, "boolean");
  assert.equal(field.default, false);
  assert.equal(field.required, false);
  assert.match(
    field.description,
    /message history/i,
    "field should describe the message-history webhook behaviour",
  );
});

test("Voice flow engine maps send_message_history_updates into the ai_assistant_start body", async () => {
  const source = await readFile(
    new URL("../lib/voice-flow-engine.js", import.meta.url),
    "utf8",
  );

  // It must be destructured from params in the ai_assistant_start case so it is
  // not blindly forwarded inside otherParams.
  assert.match(
    source,
    /send_message_history_updates,\s*\n\s*\.\.\.otherParams/,
    "send_message_history_updates should be pulled out of params before spreading otherParams",
  );

  // It must be assigned onto the request body with a real boolean (coerced).
  assert.match(
    source,
    /body\.send_message_history_updates\s*=\s*\n?\s*send_message_history_updates === true \|\|\s*\n?\s*send_message_history_updates === "true"/,
    "engine should coerce send_message_history_updates to a boolean on the body",
  );

  // It must only be set when explicitly provided so Telnyx keeps its default.
  assert.match(
    source,
    /send_message_history_updates !== undefined &&/,
    "engine should only attach the flag when it was explicitly provided",
  );
});
