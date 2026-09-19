import assert from "node:assert/strict";
import test from "node:test";

import {
  DISCONNECTED_INTERACTION_SUPPRESSION_MS,
  forgetDisconnectedInteraction,
  isRecentlyDisconnectedInteraction,
  rememberDisconnectedInteraction,
} from "../lib/contact-center/disconnected-interaction-suppression.js";

test("a stale active interaction cannot reappear immediately after disconnect", () => {
  const suppressed = new Map();
  const now = Date.parse("2026-09-10T19:07:59.000Z");

  rememberDisconnectedInteraction(
    suppressed,
    { interactionId: "work-item", callControlId: "v3:device" },
    now,
  );

  assert.equal(
    isRecentlyDisconnectedInteraction(
      suppressed,
      { id: "work-item", call_control_id: "v3:customer" },
      now + 300,
    ),
    true,
  );
  assert.equal(
    isRecentlyDisconnectedInteraction(
      suppressed,
      { id: "another-work-item", call_control_id: "v3:other" },
      now + 300,
    ),
    false,
  );
});

test("a continuing queue transfer clears the source disconnect tombstone", () => {
  const suppressed = new Map();
  const now = 1_000;
  rememberDisconnectedInteraction(
    suppressed,
    { interactionId: "work-item", callControlId: "v3:customer" },
    now,
  );

  forgetDisconnectedInteraction(suppressed, {
    interactionId: "work-item",
    callControlId: "v3:customer",
  });

  assert.equal(
    isRecentlyDisconnectedInteraction(
      suppressed,
      { id: "work-item", call_control_id: "v3:customer" },
      now + 300,
    ),
    false,
  );
});

test("disconnect suppression expires and removes its tombstone", () => {
  const suppressed = new Map();
  const now = 1_000;
  rememberDisconnectedInteraction(suppressed, { interactionId: "work-item" }, now);

  assert.equal(
    isRecentlyDisconnectedInteraction(
      suppressed,
      { id: "work-item" },
      now + DISCONNECTED_INTERACTION_SUPPRESSION_MS + 1,
    ),
    false,
  );
  assert.equal(suppressed.size, 0);
});
