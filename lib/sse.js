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

export async function broadcastToKey(key, payloadObj, eventType = null) {
  try {
    const set = getClientSet(key);
    // If eventType is provided, include it in the SSE format
    const data = eventType
      ? `event: ${eventType}\ndata: ${JSON.stringify(payloadObj)}\n\n`
      : `data: ${JSON.stringify(payloadObj)}\n\n`;
    for (const w of Array.from(set)) {
      try {
        await w.write(data);
      } catch (_) {
        try {
          set.delete(w);
        } catch (_) {}
      }
    }
  } catch (_) {}
}
