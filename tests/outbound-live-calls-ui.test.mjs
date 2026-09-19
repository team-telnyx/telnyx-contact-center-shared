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

test("live calls stream wakes on committed outbound call changes and keeps polling as a safety net", async () => {
  const source = await readFile(new URL("../app/api/contact-center/outbound-dialer/live-calls/stream/route.js", import.meta.url), "utf8");
  assert.match(source, /subscribe\(OUTBOUND_LIVE_CALLS_CHANGED_TOPIC, pushUpdate\)/);
  assert.match(source, /setInterval\(pushUpdate, 2000\)/);
  assert.match(source, /unsubscribe\?\.\(\)/);
  assert.match(source, /"Cache-Control": "no-cache, no-transform"/);
  assert.match(source, /"X-Accel-Buffering": "no"/);
});

test("live calls UI falls back when EventSource stays open without delivering snapshots", async () => {
  const source = await readFile(new URL("../app/(portal)/supervisor/outbound-dialer/page.jsx", import.meta.url), "utf8");
  const effectStart = source.indexOf('if (!isAuthorized || !can("campaigns:read") || active !== "live-calls") return;');
  assert.ok(effectStart > -1, "the live-calls effect starts with its permission gate");
  const effectEnd = source.indexOf('if (active !== "dashboard") return;', effectStart);
  const effect = source.slice(effectStart, effectEnd);

  assert.match(effect, /lastStreamPayloadAt = Date\.now\(\)/);
  assert.match(effect, /Date\.now\(\) - lastStreamPayloadAt > 5000/);
  assert.match(effect, /startPollingFallback\(\);/);
  assert.doesNotMatch(effect, /addEventListener\("open"[\s\S]*stopPollingFallback/);
});

test("ACD outbound intake emits a live-monitor wake-up after applying the call event", async () => {
  const source = await readFile(new URL("../lib/acd/outbound-intake.mjs", import.meta.url), "utf8");
  const applyIndex = source.indexOf("if (name) await applySagaEvent");
  const notifyIndex = source.indexOf("await notifyOutboundLiveCallsChanged");
  assert.ok(applyIndex >= 0 && notifyIndex > applyIndex, "monitor notification must follow the authoritative saga update");
});

test("terminal attempt completion wakes monitors from the definitive ledger transition", async () => {
  const source = await readFile(new URL("../lib/outbound-dialer/execution.js", import.meta.url), "utf8");
  const completionStart = source.indexOf("export async function completeAttemptClaim");
  const completionEnd = source.indexOf("export function normalizeE164Like", completionStart);
  const completion = source.slice(completionStart, completionEnd);

  assert.match(completion, /RETURNING \*/);
  assert.match(completion, /await notifyOutboundLiveCallsChanged\(pool/);
  assert.ok(completion.indexOf("await notifyOutboundLiveCallsChanged") > completion.indexOf("const completed = rows[0]"));
});

test("live calls do not open their stream or polling without campaigns:read and say why", async () => {
  // Codex review of #1482: a role with the live-calls screen but without
  // campaigns:read opened both endpoints anyway; every 403 was retried after
  // two seconds and raised a "Live calls refresh failed" toast each time.
  const source = await readFile(new URL("../app/(portal)/supervisor/outbound-dialer/page.jsx", import.meta.url), "utf8");
  const gate = 'if (!isAuthorized || !can("campaigns:read") || active !== "live-calls") return;';
  const effectStart = source.indexOf(gate);
  assert.ok(effectStart > -1, "the live-calls effect returns before opening anything unless campaigns:read is held");
  const effectSource = source.slice(effectStart, source.indexOf("}, [active, isAuthorized, can]);", effectStart));
  assert.match(effectSource, /new EventSource\(`\$\{API\}\/live-calls\/stream`\)/, "the stream is opened inside the gated effect");
  assert.match(effectSource, /api\(`\$\{API\}\/live-calls`\)/, "the polling fallback runs inside the gated effect");
  assert.match(source, /<LiveCallsView payload=\{liveCallsPayload\} loading=\{liveCallsLoading\} readable=\{can\("campaigns:read"\)\}/, "the view is told whether the caller may read live calls");
  const viewStart = source.indexOf("function LiveCallsView");
  const viewSource = source.slice(viewStart, source.indexOf("async function copyLiveCallValue", viewStart));
  assert.match(viewSource, /readable = true/);
  assert.match(viewSource, /data-testid="live-calls-permission"[^>]*>Live calls are read with the campaigns permission \(campaigns:read\)/, "a caller without the grant sees why the list stays empty");
});
