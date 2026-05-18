const LIVE_TERMINAL_STATUSES = new Set(["completed", "cancelled", "recycled", "hangup", "hangup_ended"]);
const LIVE_FAILED_STATUSES = new Set(["failed", "suppressed", "skipped"]);
const LIVE_ACTIVE_STATUSES = new Set(["claimed", "dialing", "answered", "running"]);
const HANGUP_RETENTION_SECONDS = 60;

export function normalizeOutboundLiveCallStatus(status) {
  const value = String(status || "").toLowerCase();
  if (["claimed", "dialing", "running"].includes(value)) return "ringing";
  if (value === "answered") return "connected";
  if (LIVE_TERMINAL_STATUSES.has(value)) return "hangup";
  if (LIVE_FAILED_STATUSES.has(value)) return "failed";
  return value || "unknown";
}

function parseTime(value) {
  const time = value ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? time : null;
}

function secondsBetween(start, end) {
  const startTime = parseTime(start);
  const endTime = end instanceof Date ? end.getTime() : parseTime(end);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) return 0;
  return Math.max(0, Math.floor((endTime - startTime) / 1000));
}

export function shouldShowOutboundLiveCall(row, now = new Date()) {
  const status = String(row?.status || "").toLowerCase();
  if (LIVE_ACTIVE_STATUSES.has(status)) return true;
  if (LIVE_TERMINAL_STATUSES.has(status) || LIVE_FAILED_STATUSES.has(status)) {
    const updatedAt = row?.updated_at || row?.created_at;
    return secondsBetween(updatedAt, now) <= HANGUP_RETENTION_SECONDS;
  }
  return false;
}

export function shouldShowOutboundLiveCallInUi(call, options = {}) {
  const status = String(call?.status || "").toLowerCase();
  const showDisconnectedCalls = options.showDisconnectedCalls !== false;
  if (!["hangup", "failed"].includes(status)) return true;
  if (!showDisconnectedCalls) return false;

  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const visibleUntil = parseTime(call?.hangup_visible_until);
  if (Number.isFinite(visibleUntil)) return visibleUntil >= now.getTime();

  const endedAt = call?.ended_at || call?.updated_at || call?.started_at;
  return secondsBetween(endedAt, now) <= HANGUP_RETENTION_SECONDS;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value == null) continue;
    const stringValue = String(value).trim();
    if (stringValue) return stringValue;
  }
  return "";
}

function numberFromContactMethods(contactMethods = [], preferredTypes = []) {
  const methods = Array.isArray(contactMethods) ? contactMethods : [];
  const preferred = methods.find((method) => preferredTypes.includes(String(method?.type || "").toLowerCase()) && method?.value);
  const any = preferred || methods.find((method) => method?.value);
  return any?.value || "";
}

function normalizeMetadata(metadata) {
  return metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {};
}

function humanizeLiveCallReason(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const words = raw
    .replace(/^sip_/, "SIP ")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function buildLiveCall(row, now) {
  const metadata = normalizeMetadata(row.metadata);
  const contactMethods = Array.isArray(row.contact_methods) ? row.contact_methods : [];
  const status = normalizeOutboundLiveCallStatus(row.status);
  const startedAt = row.created_at || row.updated_at || null;
  const endedAt = status === "hangup" || status === "failed" ? (row.updated_at || row.created_at || null) : null;
  const fromNumber = firstNonEmpty(row.from_number, metadata.from_number, metadata.fromNumber, metadata.telnyx_from, metadata.dial_from);
  const toNumber = firstNonEmpty(row.to_number, metadata.to_number, metadata.toNumber, metadata.phone_number, metadata.dial_to, numberFromContactMethods(contactMethods, ["mobile", "phone", "work", "home", "landline"]));
  const callControlId = firstNonEmpty(row.call_control_id, metadata.call_control_id, metadata.callControlId);
  const callSessionId = firstNonEmpty(row.call_session_id, metadata.call_session_id, metadata.callSessionId);
  const failureReason = firstNonEmpty(
    row.failure_reason,
    metadata.failure_reason,
    metadata.failureReason,
    row.reason_code,
    metadata.reason_code,
    metadata.reasonCode,
    row.hangup_cause,
    metadata.hangup_cause,
    metadata.hangupCause,
    row.sip_hangup_cause ? `sip_${row.sip_hangup_cause}` : "",
    metadata.sip_hangup_cause ? `sip_${metadata.sip_hangup_cause}` : "",
  );
  const hangupCause = firstNonEmpty(row.hangup_cause, metadata.hangup_cause, metadata.hangupCause);
  const sipHangupCause = firstNonEmpty(row.sip_hangup_cause, metadata.sip_hangup_cause, metadata.sipHangupCause);
  const id = firstNonEmpty(row.id, callControlId, callSessionId);
  const campaignName = firstNonEmpty(row.campaign_name, row.name, "Campaign");

  return {
    id,
    attempt_id: row.id || null,
    campaign_id: row.campaign_id || null,
    campaign_name: campaignName,
    campaign: { id: row.campaign_id || null, name: campaignName },
    status,
    raw_status: row.status || null,
    from_number: fromNumber || "—",
    to_number: toNumber || "—",
    call_control_id: callControlId || null,
    call_session_id: callSessionId || null,
    failure_reason: failureReason || null,
    failure_reason_label: failureReason ? humanizeLiveCallReason(failureReason) : null,
    hangup_cause: hangupCause || null,
    sip_hangup_cause: sipHangupCause || null,
    contact_record_id: row.contact_record_id || null,
    contact_record: row.contact_row_data || {},
    contact_methods: contactMethods,
    metadata,
    started_at: startedAt,
    updated_at: row.updated_at || null,
    ended_at: endedAt,
    duration_seconds: secondsBetween(startedAt, endedAt || now),
    hangup_visible_until: endedAt ? new Date(parseTime(endedAt) + HANGUP_RETENTION_SECONDS * 1000).toISOString() : null,
    can_supervise: Boolean(callControlId && ["ringing", "connected"].includes(status)),
    sessionDetails: {
      id: callSessionId || callControlId || id,
      call_control_id: callControlId || null,
      call_session_id: callSessionId || null,
      from_number: fromNumber || "",
      to_number: toNumber || "",
      direction: "outbound",
      state: status,
      created_at: startedAt,
      updated_at: row.updated_at || null,
      completed_at: endedAt,
      metadata: {
        ...metadata,
        failure_reason: failureReason || metadata.failure_reason || null,
        hangup_cause: hangupCause || metadata.hangup_cause || null,
        sip_hangup_cause: sipHangupCause || metadata.sip_hangup_cause || null,
        outbound_attempt_id: row.id || null,
        outbound_campaign_id: row.campaign_id || null,
        outbound_campaign_name: campaignName,
        contact_record: row.contact_row_data || {},
      },
    },
    supervisionCall: {
      id: id || callControlId || callSessionId,
      interactionId: id || callControlId || callSessionId,
      callControlId: callControlId || null,
      callSessionId: callSessionId || null,
      fromNumber: fromNumber || "",
      toNumber: toNumber || "",
      fromName: campaignName,
      toName: "Outbound contact",
      status,
      state: status,
      direction: "outbound",
      isAnswered: status === "connected",
      metadata,
    },
  };
}

export function buildOutboundLiveCallsPayload(rows = [], options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const calls = (Array.isArray(rows) ? rows : [])
    .filter((row) => shouldShowOutboundLiveCall(row, now))
    .map((row) => buildLiveCall(row, now))
    .sort((a, b) => {
      const activeOrder = Number(b.status !== "hangup" && b.status !== "failed") - Number(a.status !== "hangup" && a.status !== "failed");
      if (activeOrder) return activeOrder;
      return (parseTime(b.updated_at || b.started_at) || 0) - (parseTime(a.updated_at || a.started_at) || 0);
    });

  const byStatus = calls.reduce((acc, call) => {
    acc[call.status] = (acc[call.status] || 0) + 1;
    return acc;
  }, {});
  const campaignMap = new Map();
  for (const call of calls) {
    if (call.campaign_id && !campaignMap.has(call.campaign_id)) {
      campaignMap.set(call.campaign_id, { id: call.campaign_id, name: call.campaign_name });
    }
  }

  return {
    calls,
    totals: {
      total: calls.length,
      active: calls.filter((call) => !["hangup", "failed"].includes(call.status)).length,
      byStatus,
    },
    filters: {
      campaigns: Array.from(campaignMap.values()).sort((a, b) => a.name.localeCompare(b.name)),
      statuses: Object.keys(byStatus).sort(),
    },
    generated_at: now.toISOString(),
    hangup_retention_seconds: HANGUP_RETENTION_SECONDS,
  };
}

export const OUTBOUND_LIVE_CALLS_SQL = `
  SELECT
    l.id,
    l.campaign_id,
    c.name AS campaign_name,
    l.contact_record_id,
    l.status,
    l.call_control_id,
    l.call_session_id,
    l.failure_reason,
    COALESCE(l.metadata->>'reason_code', l.metadata->>'reasonCode') AS reason_code,
    COALESCE(l.metadata->>'hangup_cause', l.metadata->>'hangupCause') AS hangup_cause,
    COALESCE(l.metadata->>'sip_hangup_cause', l.metadata->>'sipHangupCause') AS sip_hangup_cause,
    l.metadata,
    l.created_at,
    l.updated_at,
    r.row_data AS contact_row_data,
    r.contact_methods,
    COALESCE(
      l.metadata->>'from_number',
      l.metadata->>'fromNumber',
      l.metadata->>'telnyx_from',
      l.metadata->>'dial_from'
    ) AS from_number,
    COALESCE(
      l.metadata->>'to_number',
      l.metadata->>'toNumber',
      l.metadata->>'phone_number',
      l.metadata->>'dial_to'
    ) AS to_number
  FROM outbound_attempt_ledger l
  JOIN outbound_campaigns c ON c.id = l.campaign_id
  LEFT JOIN outbound_contact_records r ON r.id = l.contact_record_id
  WHERE (
    l.status IN ('claimed','dialing','answered','running')
    OR (l.status IN ('completed','cancelled','recycled','hangup','hangup_ended','failed','suppressed','skipped') AND l.updated_at >= NOW() - INTERVAL '60 seconds')
  )
  ORDER BY
    CASE WHEN l.status IN ('claimed','dialing','answered','running') THEN 0 ELSE 1 END,
    COALESCE(l.updated_at, l.created_at) DESC
  LIMIT 500`;
