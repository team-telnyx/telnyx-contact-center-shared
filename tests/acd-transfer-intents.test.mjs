import assert from "node:assert/strict";
import test from "node:test";

import { resolveTransferFromNumber } from "../lib/acd/transfer-intents.mjs";

test("transfer caller id keeps an inbound DID", () => {
  assert.equal(
    resolveTransferFromNumber(
      { cc_address: "+15550001001", owner_voice_number: "+15550001002" },
      "+15550001003",
    ),
    "+15550001001",
  );
});

test("transfer caller id rejects a manual WebRTC credential", () => {
  assert.equal(
    resolveTransferFromNumber(
      { cc_address: "agent-credential", owner_voice_number: "+15550001002" },
      "+15550001003",
    ),
    "+15550001002",
  );
  assert.equal(
    resolveTransferFromNumber(
      { cc_address: "agent-credential", owner_voice_number: null },
      "+15550001003",
    ),
    "+15550001003",
  );
});

test("transfer caller id refuses non-E.164 fallbacks", () => {
  assert.equal(
    resolveTransferFromNumber(
      { cc_address: "agent-credential", owner_voice_number: "602 410 402" },
      "main-number",
    ),
    null,
  );
});
