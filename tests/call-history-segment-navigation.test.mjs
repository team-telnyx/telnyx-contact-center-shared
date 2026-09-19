import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const pagePath = new URL(
  "../app/(portal)/supervisor/call-history/[id]/page.jsx",
  import.meta.url,
);
const routePath = new URL(
  "../app/api/contact-center/interactions/[id]/route.js",
  import.meta.url,
);
const projectionPath = new URL(
  "../lib/acd/history-projection.mjs",
  import.meta.url,
);

test("Call History exposes synchronized navigation for every Core agent segment", async () => {
  const page = await readFile(pagePath, "utf8");

  assert.match(page, /interaction\.acd_segments/);
  assert.match(page, /activeSegmentIndex/);
  assert.match(page, /Segment \{index \+ 1\} of \{count\}/);
  assert.equal(
    page.match(/<SegmentNavigator/g)?.length,
    3,
    "Participants, Call Details and Call IDs must share segment navigation",
  );
  assert.match(page, /activeSegment\?\.queue_name/);
  assert.match(page, /activeSegment\?\.agent_call_control_id/);
  assert.match(page, /handle_time_seconds: interaction\.handle_time_seconds/);
  assert.match(page, /activeSegment\?\.handle_time_seconds \?\?/);
});

test("interaction details API loads durable Core segment headers", async () => {
  const [route, projection] = await Promise.all([
    readFile(routePath, "utf8"),
    readFile(projectionPath, "utf8"),
  ]);

  assert.match(route, /loadAcdInteractionSegments/);
  assert.match(route, /acd_segments: acdSegments/);
  assert.match(projection, /s\.kind = 'agent'/);
  assert.match(projection, /agent_call_control_id/);
  assert.match(projection, /agent_call_session_id/);
});
