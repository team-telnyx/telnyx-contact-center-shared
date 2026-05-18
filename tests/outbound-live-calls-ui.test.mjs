import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("live call card renders failure reason, full session id, and copy buttons for identifiers", async () => {
  const source = await readFile(new URL("../app/(portal)/supervisor/outbound-dialer/page.jsx", import.meta.url), "utf8");
  const cardStart = source.indexOf("function LiveCallCard");
  const cardEnd = source.indexOf("function LiveCallsSettings", cardStart);
  assert.ok(cardStart > -1 && cardEnd > cardStart, "LiveCallCard should exist");
  const cardSource = source.slice(cardStart, cardEnd);

  assert.match(cardSource, /call\.failure_reason_label/, "failed cards should render a failure reason label");
  assert.doesNotMatch(cardSource, /String\(call\.call_session_id\)\.slice\(0, 8\)/, "session id should not be truncated in the header");
  assert.match(cardSource, /CopyValueButton[\s\S]*value=\{call\.call_session_id\}/, "session id should be copyable");
  assert.match(cardSource, /CopyValueButton[\s\S]*value=\{call\.call_control_id\}/, "call control id should be copyable");
  assert.match(cardSource, /CopyValueButton[\s\S]*value=\{call\.contact_record_id\}/, "contact record id should be copyable");
});

test("outbound live calls SQL selects failure reason and hangup causes for failed calls", async () => {
  const source = await readFile(new URL("../lib/outbound-dialer/live-calls.js", import.meta.url), "utf8");
  assert.match(source, /l\.failure_reason/, "live calls query should select ledger failure_reason");
  assert.match(source, /l\.metadata->>'hangup_cause'/, "live calls query should expose Telnyx hangup cause metadata");
  assert.match(source, /l\.metadata->>'sip_hangup_cause'/, "live calls query should expose SIP hangup cause metadata");
});
