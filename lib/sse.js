const globalAny = globalThis;

if (!globalAny.__sse_clients) {
  globalAny.__sse_clients = new Map(); // Map<string, Set<WritableStreamDefaultWriter>>
}

function getClientSet(key) {
  const map = globalAny.__sse_clients;
  if (!map.has(key)) map.set(key, new Set());
  return map.get(key);
}

export function addSseClient(key, writer) {
  const set = getClientSet(key);
  set.add(writer);
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

export async function broadcastToKey(key, payloadObj, eventType = null) {
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
    console.error("[SSE] Failed to broadcast to all agents:", error);
  }
}
