export const OUTBOUND_LIVE_CALLS_CHANGED_TOPIC = "outbound.live_calls.changed";

// Wake live-monitor subscribers after the authoritative database transition
// commits. The notification contains only a lookup hint; subscribers always
// reload their snapshot from Postgres.
export async function notifyOutboundLiveCallsChanged(pool, payload = {}) {
  if (!pool) return false;
  await pool.query("SELECT pg_notify('cc_events', $1)", [
    JSON.stringify({
      topic: OUTBOUND_LIVE_CALLS_CHANGED_TOPIC,
      payload,
    }),
  ]);
  return true;
}
