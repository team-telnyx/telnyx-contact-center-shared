// Send budget for one campaign tick. Windows are counted from the attempt
// ledger, never from process memory, so every worker node sees the same numbers.
import { MESSAGE_LIVE_STATES } from "./schema.mjs";

// Rows that reached the provider, plus `sending`, whose outcome is still
// unknown. These spent real provider capacity.
const SPENT_STATES = ["sending", "accepted", "sent", "delivered", "read", "replied", "unconfirmed", "failed_transient", "failed_permanent", "undeliverable"];
// Rows a tick already claimed. They have not reached the provider yet, but the
// claiming node is about to send them, so their capacity is committed. Counting
// them is what stops a second node from re-spending the same budget; a row that
// ends up suppressed or skipped simply drops out of the window again.
const RESERVED_STATES = ["pending", "rendered", "queued"];
// Everything that consumed a send slot, reserved or spent. Used for the rate
// windows and the campaign cap.
export const COMMITTED_STATES = Object.freeze([...SPENT_STATES, ...RESERVED_STATES]);

export function computeMessagingBudget({ pacing = {}, counts = {} } = {}) {
  const remaining = (limit, used) => (Number.isFinite(limit) && limit > 0 ? Math.max(0, limit - (Number(used) || 0)) : Number.POSITIVE_INFINITY);
  const candidates = [
    Number(pacing.batch_size) || 1,
    remaining(pacing.max_per_minute, counts.last_minute),
    remaining(pacing.max_per_hour, counts.last_hour),
    remaining(pacing.max_per_day, counts.last_day),
    remaining(pacing.max_in_flight, counts.in_flight),
    pacing.max_messages_per_campaign > 0 ? remaining(pacing.max_messages_per_campaign, counts.campaign_total) : Number.POSITIVE_INFINITY,
  ];
  const budget = Math.max(0, Math.floor(Math.min(...candidates)));
  const limitedBy = budget === 0
    ? (remaining(pacing.max_per_minute, counts.last_minute) === 0 ? "max_per_minute"
      : remaining(pacing.max_per_hour, counts.last_hour) === 0 ? "max_per_hour"
        : remaining(pacing.max_per_day, counts.last_day) === 0 ? "max_per_day"
          : remaining(pacing.max_in_flight, counts.in_flight) === 0 ? "max_in_flight"
            : pacing.max_messages_per_campaign > 0 && remaining(pacing.max_messages_per_campaign, counts.campaign_total) === 0 ? "max_messages_per_campaign" : "batch_size")
    : null;
  return { budget, limitedBy };
}

// Per-sender capacity left in the current minute and day.
export function senderCapacity(pacing = {}, senderCounts = {}) {
  const minuteLimit = Number(pacing.per_sender_per_minute) || Number.POSITIVE_INFINITY;
  const dayLimit = Number(pacing.per_sender_daily) || Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor(Math.min(minuteLimit - (Number(senderCounts.minute) || 0), dayLimit - (Number(senderCounts.day) || 0))));
}

export async function loadMessagingCounts(db, { channel, campaignId }) {
  // Every count includes the rows this or another node has already claimed, so
  // the budget a tick computes is never spent twice.
  const { rows } = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE message_state = ANY($3::text[]) AND created_at > NOW() - INTERVAL '1 minute')::int AS last_minute,
       COUNT(*) FILTER (WHERE message_state = ANY($3::text[]) AND created_at > NOW() - INTERVAL '1 hour')::int AS last_hour,
       COUNT(*) FILTER (WHERE message_state = ANY($3::text[]) AND created_at > NOW() - INTERVAL '1 day')::int AS last_day,
       COUNT(*) FILTER (WHERE campaign_id = $2 AND message_state = ANY($4::text[]))::int AS in_flight,
       COUNT(*) FILTER (WHERE campaign_id = $2 AND message_state = ANY($3::text[]))::int AS campaign_total
     FROM outbound_attempt_ledger
     WHERE channel = $1 AND message_state IS NOT NULL`,
    [channel, campaignId, [...COMMITTED_STATES], [...MESSAGE_LIVE_STATES]],
  );
  const senders = await db.query(
    `SELECT sender_address,
       COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 minute')::int AS minute,
       COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 day')::int AS day
     FROM outbound_attempt_ledger
     WHERE channel = $1 AND sender_address IS NOT NULL AND message_state = ANY($2::text[])
       AND created_at > NOW() - INTERVAL '1 day'
     GROUP BY sender_address`,
    [channel, [...COMMITTED_STATES]],
  );
  return {
    ...(rows[0] || { last_minute: 0, last_hour: 0, last_day: 0, in_flight: 0, campaign_total: 0 }),
    per_sender: Object.fromEntries(senders.rows.map((row) => [row.sender_address, { minute: Number(row.minute) || 0, day: Number(row.day) || 0 }])),
  };
}
