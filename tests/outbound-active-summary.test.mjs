import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const routeSourcePromise = readFile(new URL("../app/api/contact-center/outbound-dialer/route.js", import.meta.url), "utf8");
const streamSourcePromise = readFile(new URL("../app/api/contact-center/outbound-dialer/stream/route.js", import.meta.url), "utf8");
const summarySourcePromise = readFile(new URL("../lib/outbound-dialer/dashboard-summary.mjs", import.meta.url), "utf8");

test("outbound summaries count only live claimed attempts as active lines", async () => {
  const routeSource = await routeSourcePromise;
  const streamSource = await streamSourcePromise;
  const summarySource = await summarySourcePromise;

  assert.match(routeSource, /import \{ DASHBOARD_SUMMARY_SQL \} from "@\/lib\/outbound-dialer\/dashboard-summary\.mjs";/, "route must use the canonical summary query");
  assert.match(summarySource, /l\.status IN \('dialing','answered'\)/, "active lines should always include dialing and answered attempts");
  assert.match(summarySource, /l\.status = 'claimed'[\s\S]*COALESCE\(l\.lease_expires_at, NOW\(\) \+ INTERVAL '1 second'\) > NOW\(\) - INTERVAL '5 seconds'/, "claimed attempts should count as active only while the claim lease is still live");
  assert.doesNotMatch(summarySource, /WHERE l\.status IN \('claimed','dialing','answered'\)\)::int AS active_now/, "active summary must not count every historical claimed row forever");
  assert.match(streamSource, /import \{ loadExecutionDebugByCampaign \} from "\.\.\/route";/, "stream must reuse the canonical summary query instead of keeping a divergent copy");
  assert.match(streamSource, /subscribe\(OUTBOUND_LIVE_CALLS_CHANGED_TOPIC, pushUpdate\)/, "campaign monitor should refresh immediately after a committed call-state change");
  assert.match(streamSource, /setInterval\(pushUpdate, 3000\)/, "campaign monitor should retain polling as a missed-notification safety net");
  assert.match(streamSource, /"Cache-Control": "no-cache, no-transform"/, "campaign stream should forbid proxy transformations");
  assert.match(streamSource, /"X-Accel-Buffering": "no"/, "campaign stream should disable proxy buffering");
});

test("campaign monitor falls back when EventSource opens but stops delivering snapshots", async () => {
  const pageSource = await readFile(new URL("../app/(portal)/supervisor/outbound-dialer/page.jsx", import.meta.url), "utf8");
  // Authorization prerequisites may grow without changing stream liveness.
  const effectStart = pageSource.indexOf('active !== "dashboard"');
  const effectEnd = pageSource.indexOf('active !== "live-calls"', effectStart);
  assert.ok(effectStart >= 0 && effectEnd > effectStart, "dashboard and live-call effects must be present in order");
  const effect = pageSource.slice(effectStart, effectEnd);

  assert.match(effect, /lastStreamPayloadAt = Date\.now\(\)/);
  assert.match(effect, /Date\.now\(\) - lastStreamPayloadAt > 7000/);
  assert.match(effect, /enablePollingFallback\(\);/);
  assert.doesNotMatch(effect, /eventSource\.onopen[\s\S]*disablePollingFallback/);
});
