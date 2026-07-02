import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const streamRouteSource = readFileSync(
  new URL("../app/api/contact-center/outbound-dialer/stream/route.js", import.meta.url),
  "utf8",
);

test("outbound SSE stream reuses full execution debug loader for Event Viewer run history", () => {
  assert.match(
    streamRouteSource,
    /import \{ loadExecutionDebugByCampaign \} from "\.\.\/route";/,
    "stream route must use the canonical loader that includes campaign_runs",
  );
  assert.doesNotMatch(
    streamRouteSource,
    /async function loadExecutionDebugByCampaign\(/,
    "stream route must not shadow the canonical loader with the old reduced debug payload",
  );
  assert.match(streamRouteSource, /const executionDebugByCampaign = await loadExecutionDebugByCampaign\(pool, campaigns\.map\(\(c\) => c\.id\)\);/);
});
