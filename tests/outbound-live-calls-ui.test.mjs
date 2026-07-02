import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("live call card renders combined status/reason badges like History and suppresses failure labels for hangups", async () => {
  const source = await readFile(new URL("../app/(portal)/supervisor/outbound-dialer/page.jsx", import.meta.url), "utf8");
  const cardStart = source.indexOf("function LiveCallCard");
  const cardEnd = source.indexOf("function LiveCallsSettings", cardStart);
  assert.ok(cardStart > -1 && cardEnd > cardStart, "LiveCallCard should exist");
  const cardSource = source.slice(cardStart, cardEnd);

  assert.match(cardSource, /liveCallBadgeLabel\(call\)/, "live cards should derive one status/reason badge label");
  assert.match(cardSource, /liveCallBadgeClass\(call\)/, "live cards should derive badge styling from status and reason");
  assert.doesNotMatch(cardSource, /Failure reason:/, "live cards should not render a separate Failure reason line");
  assert.doesNotMatch(cardSource, /call\.status === "failed" && call\.failure_reason_label/, "failed cards should not render a second reason badge");
  assert.doesNotMatch(cardSource, /String\(call\.call_session_id\)\.slice\(0, 8\)/, "session id should not be truncated in the header");
  assert.match(cardSource, /CopyValueButton[\s\S]*value=\{call\.call_session_id\}/, "session id should be copyable");
  assert.match(cardSource, /CopyValueButton[\s\S]*value=\{call\.call_control_id\}/, "call control id should be copyable");
  assert.match(cardSource, /CopyValueButton[\s\S]*value=\{call\.contact_record_id\}/, "contact record id should be copyable");
});

test("live call copy helper waits for clipboard writes before reporting success", async () => {
  const source = await readFile(new URL("../app/(portal)/supervisor/outbound-dialer/page.jsx", import.meta.url), "utf8");
  const helperStart = source.indexOf("async function copyLiveCallValue");
  const helperEnd = source.indexOf("function CopyValueButton", helperStart);
  assert.ok(helperStart > -1 && helperEnd > helperStart, "copyLiveCallValue should be async and exist before CopyValueButton");
  const helperSource = source.slice(helperStart, helperEnd);

  assert.match(helperSource, /await navigator\.clipboard\.writeText\(text\)/, "clipboard write should be awaited before success notification");
  assert.match(helperSource, /Clipboard is not available/, "missing clipboard API should show a failure notification");
  assert.match(helperSource, /title: "Copy failed"/, "clipboard failures should show an error notification");
});

test("outbound live calls SQL selects failure reason and hangup causes for failed calls", async () => {
  const source = await readFile(new URL("../lib/outbound-dialer/live-calls.js", import.meta.url), "utf8");
  assert.match(source, /l\.failure_reason/, "live calls query should select ledger failure_reason");
  assert.match(source, /l\.metadata->>'hangup_cause'/, "live calls query should expose Telnyx hangup cause metadata");
  assert.match(source, /l\.metadata->>'sip_hangup_cause'/, "live calls query should expose SIP hangup cause metadata");
});
