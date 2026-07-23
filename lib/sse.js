import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "./runtime-logging.mjs";
const globalAny = globalThis;

const SSE_INSTANCE_ID = (globalAny.__sse_instance_id ||= `${process.pid || "pid"}-${Date.now()}-${Math.random().toString(36).slice(2)}`);

if (!globalAny.__sse_clients) {
  globalAny.__sse_clients = new Map(); // Map<string, Set<WritableStreamDefaultWriter>>
}
if (!globalAny.__sse_fanout) {
  globalAny.__sse_fanout = { unsubscribe: null, starting: null };
}

function isSseFanoutEnabled() {
  return String(process.env.SSE_FANOUT || "false").toLowerCase() === "true";
}

function getClientSet(key) {
  const map = globalAny.__sse_clients;
  if (!map.has(key)) map.set(key, new Set());
  return map.get(key);
}

export function addSseClient(key, writer) {
  const set = getClientSet(key);
  set.add(writer);
  ensureSseFanoutSubscriber().catch((err) => {
    platformApiLogger.warn("runtime_warning", { ...runtimePayload({ error: err }) });
  });
}

/**
 * Replace all existing connections for a key with a new writer.
 * Use instead of addSseClient when only one active connection per key is
 * expected (e.g. single-tab agent stream). Proactively closes stale writers
 * so they don't keep receiving events until the 15s heartbeat detects failure.
 */
export function replaceSseClient(key, writer) {
  const set = getClientSet(key);
  for (const existing of Array.from(set)) {
    if (existing !== writer) {
      // Call deactivate (not close) — close() shuts the HTTP response which causes
      // the browser EventSource to auto-reconnect, creating an eviction feedback loop.
      // deactivate() stops writes/heartbeats without closing the underlying stream.
      try { existing.deactivate?.(); } catch (_) {}
    }
  }
  set.clear();
  set.add(writer);
  ensureSseFanoutSubscriber().catch((err) => {
    platformApiLogger.warn("runtime_warning", { ...runtimePayload({ error: err }) });
  });
}

export function removeSseClient(key, writer) {
  try {
    const set = getClientSet(key);
    if (set.has(writer)) {
      set.delete(writer);
    }
  } catch (_) {}
}

/**
 * Check if there are active SSE clients for a given key
 * @param {string} key - The SSE key to check
 * @returns {boolean} - True if there are active clients
 */
export function hasActiveClients(key) {
  try {
    const set = getClientSet(key);
    return set.size > 0;
  } catch (_) {
    return false;
  }
}

async function broadcastLocalToKey(key, payloadObj, eventType = null) {
  try {
    const set = getClientSet(key);
    // If eventType is provided, include it in the SSE format
    const encoder = new TextEncoder();
    const data = eventType
      ? `event: ${eventType}\ndata: ${JSON.stringify(payloadObj)}\n\n`
      : `data: ${JSON.stringify(payloadObj)}\n\n`;
    const encoded = encoder.encode(data);
    for (const w of Array.from(set)) {
      try {
        await w.write(encoded);
      } catch (_) {
        try {
          set.delete(w);
        } catch (_) {}
      }
    }
  } catch (_) {}
}

async function ensureSseFanoutSubscriber() {
  if (!isSseFanoutEnabled()) return null;
  const state = globalAny.__sse_fanout;
  if (state.unsubscribe) return state.unsubscribe;
  if (state.starting) return state.starting;

  state.starting = (async () => {
    const { subscribe, TOPICS } = await import("./events/event-bus.js");
    const unsubscribe = await subscribe(`${TOPICS.SSE_PREFIX}*`, async (message = {}, meta = {}) => {
      const origin = message?.origin;
      if (origin === SSE_INSTANCE_ID) return;
      const topic = meta?.topic || "";
      const key = message?.key || (topic.startsWith(TOPICS.SSE_PREFIX) ? topic.slice(TOPICS.SSE_PREFIX.length) : "");
      if (!key) return;
      await broadcastLocalToKey(key, message?.payload, message?.eventType || null);
    });
    state.unsubscribe = unsubscribe;
    return unsubscribe;
  })();

  try {
    return await state.starting;
  } finally {
    state.starting = null;
  }
}

function publishSseFanout(key, payloadObj, eventType = null) {
  if (!isSseFanoutEnabled()) return;
  ensureSseFanoutSubscriber().catch((err) => {
    platformApiLogger.warn("runtime_warning", { ...runtimePayload({ error: err }) });
  });
  Promise.resolve()
    .then(async () => {
      const { publish, TOPICS } = await import("./events/event-bus.js");
      await publish(`${TOPICS.SSE_PREFIX}${key}`, {
        key,
        payload: payloadObj,
        eventType,
        origin: SSE_INSTANCE_ID,
      });
    })
    .catch((err) => {
      platformApiLogger.warn("runtime_warning", { ...runtimePayload({ error: err }) });
    });
}

export async function broadcastToKey(key, payloadObj, eventType = null) {
  await broadcastLocalToKey(key, payloadObj, eventType);
  publishSseFanout(key, payloadObj, eventType);
}

/**
 * Broadcast to all agent users
 * @param {Object} payloadObj - Payload to broadcast
 * @param {string} eventType - Event type for SSE
 */
export async function broadcastToAllAgents(payloadObj, eventType = null) {
  try {
    const { getPostgresPool } = await import("./postgres.mjs");
    const pool = getPostgresPool();
    if (!pool) return;

    // Get all users with agent role
    const res = await pool.query(
      `SELECT id FROM users WHERE 'agent' = ANY(roles)`
    );
    const agentUsers = res.rows || [];

    // Broadcast to each agent user
    for (const agent of agentUsers) {
      const queueKey = `user:queues:${agent.id}`;
      await broadcastToKey(queueKey, payloadObj, eventType);
    }
  } catch (error) {
    platformApiLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
  }
}
