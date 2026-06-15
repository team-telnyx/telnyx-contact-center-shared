import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (p) => readFile(new URL(p, root), "utf8");

// Components that previously each opened their own EventSource to
// /api/user/status-stream. With React StrictMode + re-mounts this produced
// 12-17 concurrent SSE connections and exhausted the browser's per-origin
// connection cap, which starved ordinary fetches (e.g. /api/user/profile).
// They must all multiplex over the single shared client instead.
const SHARED_STREAM_CONSUMERS = [
  "components/site-header.jsx",
  "components/nav-user.jsx",
  "components/contact-center/AgentDesktop.jsx",
  "components/contact-center/CampaignActivationSelector.jsx",
  "components/contact-center/QueueActivationPanel.jsx",
  "components/contact-center/GlobalWrapupSheet.jsx",
];

test("shared status-stream client exists and exposes a ref-counted singleton API", async () => {
  const src = await read("lib/status-stream-client.js");

  assert.match(src, /export function subscribeStatusStream\(/);
  assert.match(src, /export function subscribeStatusStreamState\(/);
  // One EventSource for the whole app, opened on first subscriber.
  assert.match(src, /new EventSource\(ENDPOINT\)/);
  assert.match(src, /refCount \+= 1/);
  assert.match(src, /if \(refCount === 1\)\s*\{\s*openConnection\(\)/);
  // Closed when the last subscriber leaves — no leaked connections.
  assert.match(src, /if \(refCount === 0\)\s*\{\s*closeConnection\(\)/);
  // Centralized reconnect with backoff.
  assert.match(src, /scheduleReconnect\(/);
});

test("no component opens its own EventSource to /api/user/status-stream", async () => {
  for (const file of SHARED_STREAM_CONSUMERS) {
    const src = await read(file);
    assert.doesNotMatch(
      src,
      /new EventSource\(\s*["'`]\/api\/user\/status-stream/,
      `${file} must use the shared status-stream client, not its own EventSource`,
    );
    assert.match(
      src,
      /from ["']@\/lib\/status-stream-client["']/,
      `${file} must import the shared status-stream client`,
    );
  }
});
