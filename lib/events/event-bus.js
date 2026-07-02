/**
 * WS0-T2 — Event bus interface.
 *
 * Cross-node, best-effort signaling bus. The DB remains the source of truth:
 * a missed notification only delays a re-evaluation that the coordinator's
 * periodic safety tick still catches.
 *
 * Adapter selection via process.env.EVENT_BUS (default: "pg").
 * This module is dormant until callers (WS3 routing reactor, WS4 SSE fan-out,
 * WS5 pacing) subscribe/publish. Importing it has no side effects; the
 * underlying connection is established lazily on first use.
 */

import { createPgNotifyAdapter } from "./adapter-pg-notify.js";

const runtime = (globalThis.__cc_event_bus_runtime ||= {
  adapter: null,
  adapterName: null,
});

function resolveAdapterName() {
  const name = String(process.env.EVENT_BUS || "pg").trim().toLowerCase();
  return name || "pg";
}

function createAdapter(name) {
  switch (name) {
    case "pg":
      return createPgNotifyAdapter();
    case "redis":
      // WS0-T2 plan: redis adapter is a stub until a redis deployment exists.
      throw new Error(
        "EVENT_BUS=redis adapter is not implemented yet; use EVENT_BUS=pg",
      );
    default:
      throw new Error(`Unknown EVENT_BUS adapter: ${name}`);
  }
}

export function getEventBus() {
  const name = resolveAdapterName();
  if (!runtime.adapter || runtime.adapterName !== name) {
    runtime.adapter = createAdapter(name);
    runtime.adapterName = name;
  }
  return runtime.adapter;
}

/**
 * Publish a payload on a topic. Best-effort: failures are logged by the
 * adapter and surfaced as a rejected promise; callers MUST NOT treat publish
 * failure as fatal for the underlying state change (DB write came first).
 *
 * @param {string} topic
 * @param {object} payload JSON-serializable, keep < 7KB (pg NOTIFY margin)
 */
export async function publish(topic, payload = {}) {
  return getEventBus().publish(topic, payload);
}

/**
 * Subscribe a handler to a topic. Returns an unsubscribe function.
 * Topic matching supports exact topics and "prefix:*" wildcard patterns
 * (e.g. "sse:*" receives every "sse:<key>" message).
 *
 * @param {string} topic
 * @param {(payload: object, meta: {topic: string}) => void|Promise<void>} handler
 * @returns {Promise<() => void>} unsubscribe
 */
export async function subscribe(topic, handler) {
  return getEventBus().subscribe(topic, handler);
}

/** Close the bus connection (tests/shutdown). Safe to call repeatedly. */
export async function closeEventBus() {
  if (runtime.adapter) {
    const adapter = runtime.adapter;
    runtime.adapter = null;
    runtime.adapterName = null;
    await adapter.close();
  }
}

/** Well-known topics (WS3/WS4/WS5 contract). */
export const TOPICS = Object.freeze({
  AGENT_AVAILABLE: "agent.available",
  CALL_ENQUEUED: "call.enqueued",
  SSE_PREFIX: "sse:",
});
