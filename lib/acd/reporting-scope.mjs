import { parseChannel } from "./interaction-channels.mjs";
import { RELEASED_CHANNELS } from "./channel-registry.mjs";
import { scopedChannels, UNRESTRICTED } from "../authz/scope.mjs";
/**
 * Report window and filters from query parameters. `restriction` is the
 * caller's data scope (`authz.scope`); the report modules apply it next to
 * the requested queue/agent/channel so query parameters cannot widen a view.
 */
export async function resolveReportingScope(
  db,
  params = new URLSearchParams(),
  restriction = UNRESTRICTED,
) {
  const timezone = params.get("timezone") || "UTC";
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
  } catch {
    throw Object.assign(new Error("Invalid timezone"), { status: 400 });
  }
  const period = params.get("period") || "today",
    days = { today: 1, "7days": 7, "30days": 30 }[period];
  if (!days)
    throw Object.assign(new Error("Invalid reporting period"), { status: 400 });
  const defaults = (
    await db.query(
      `SELECT (date_trunc('day',now() AT TIME ZONE $1)-make_interval(days=>$2::int-1)) AT TIME ZONE $1 AS start,
    (date_trunc('day',now() AT TIME ZONE $1)+interval '1 day') AT TIME ZONE $1 AS finish`,
      [timezone, days],
    )
  ).rows[0];
  const from = new Date(params.get("from") || defaults.start),
    to = new Date(params.get("to") || defaults.finish);
  if (
    !Number.isFinite(+from) ||
    !Number.isFinite(+to) ||
    from >= to ||
    to - from > 366 * 86400000
  )
    throw Object.assign(new Error("Choose a valid date range up to 366 days"), {
      status: 400,
    });
  const channel = parseChannel(params.get("channel"));
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    timezone,
    period,
    channel,
    channels: scopedChannels(restriction, channel, RELEASED_CHANNELS),
    queueId: params.get("queueId") || null,
    agentId: params.get("agentId") || null,
    cohort: "closed",
    bucket: to - from <= 26 * 3600000 ? "hour" : "day",
    restriction: restriction?.restricted ? restriction : UNRESTRICTED,
  };
}
