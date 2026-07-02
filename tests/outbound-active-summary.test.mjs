import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const routeSourcePromise = readFile(new URL("../app/api/contact-center/outbound-dialer/route.js", import.meta.url), "utf8");
const streamSourcePromise = readFile(new URL("../app/api/contact-center/outbound-dialer/stream/route.js", import.meta.url), "utf8");

test("outbound summaries count only live claimed attempts as active lines", async () => {
  const routeSource = await routeSourcePromise;
  const streamSource = await streamSourcePromise;

  assert.match(routeSource, /l\.status IN \('dialing','answered'\)/, "active lines should always include dialing and answered attempts");
  assert.match(routeSource, /l\.status = 'claimed'[\s\S]*COALESCE\(l\.lease_expires_at, NOW\(\) \+ INTERVAL '1 second'\) > NOW\(\) - INTERVAL '5 seconds'/, "claimed attempts should count as active only while the claim lease is still live");
  assert.doesNotMatch(routeSource, /WHERE l\.status IN \('claimed','dialing','answered'\)\)::int AS active_now/, "active summary must not count every historical claimed row forever");
  assert.match(streamSource, /import \{ loadExecutionDebugByCampaign \} from "\.\.\/route";/, "stream must reuse the canonical summary query instead of keeping a divergent copy");
});
