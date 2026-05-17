export const CAMPAIGN_STATUS_EVENT_TYPES = ["start", "stop", "pause", "recycle", "exhausted"];

const STATUS_EVENT_ALIASES = {
  started: "start",
  running: "start",
  stopped: "stop",
  paused: "pause",
  recycled: "recycle",
  auto_complete: "exhausted",
  auto_completed: "exhausted",
  exhausted: "exhausted",
  all_callable_records_exhausted: "exhausted",
};

export function normalizeCampaignExecutionState(campaign = {}) {
  const status = String(campaign?.status || "draft").toLowerCase();
  const metadata = campaign?.metadata || {};
  const autoCompletedReason = String(metadata.auto_completed_reason || metadata.autoCompletedReason || "").toLowerCase();
  const metadataState = metadata.execution_state || metadata.executionState;
  if (status === "exhausted" || autoCompletedReason === "all_callable_records_exhausted" || String(metadataState || "").toLowerCase() === "exhausted") return "exhausted";
  if (metadataState) return String(metadataState).toLowerCase();
  if (status === "running") return "running";
  if (status === "paused") return "paused";
  if (status === "completed") return "completed";
  if (["ready", "scheduled", "published", "active"].includes(status)) return "ready";
  return status || "not started";
}

export function campaignControlState(campaign = {}, saving = false) {
  const state = normalizeCampaignExecutionState(campaign);
  const isPaused = state === "paused";
  const isRunning = state === "running";
  const isExhausted = state === "exhausted";
  return {
    state,
    pauseAction: isPaused ? "resume" : "pause",
    canStart: !saving && !isRunning && !isExhausted,
    canStop: !saving && isRunning && !isExhausted,
    canPause: !saving && (isRunning || isPaused) && !isExhausted,
    canRecycle: !saving && ["stopped", "completed"].includes(state) && !isExhausted,
    controlsDisabled: Boolean(isExhausted),
  };
}

function normalizeStatusEventType(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/[\s.-]+/g, "_");
  return STATUS_EVENT_ALIASES[normalized] || normalized;
}

export function campaignStatusEventsFromCampaigns(campaigns = []) {
  const allowed = new Set(CAMPAIGN_STATUS_EVENT_TYPES);
  return campaigns.flatMap((campaign) => {
    const metadata = campaign?.metadata || {};
    const rawEvents = [
      ...(Array.isArray(metadata.event_timeline) ? metadata.event_timeline : []),
      ...(Array.isArray(metadata.eventTimeline) ? metadata.eventTimeline : []),
      ...(Array.isArray(metadata.events) ? metadata.events : []),
    ];
    const timeline = rawEvents.map((event, idx) => {
      const type = normalizeStatusEventType(event?.type || event?.state || event?.action || event?.reason || "event");
      if (!allowed.has(type)) return null;
      return {
        campaign_id: campaign.id,
        campaign_name: campaign.name,
        type,
        timestamp: event?.at || event?.timestamp || event?.created_at || event?.updatedAt || campaign.updated_at,
        details: event?.message || event?.description || event?.reason || `Campaign ${type}`,
        idx,
      };
    }).filter(Boolean);

    if (metadata.execution_control) {
      const controlType = normalizeStatusEventType(metadata.execution_control.lastAction || metadata.execution_control.last_action);
      if (allowed.has(controlType)) {
        timeline.push({
          campaign_id: campaign.id,
          campaign_name: campaign.name,
          type: controlType,
          timestamp: metadata.execution_control.updatedAt || metadata.execution_control.updated_at || campaign.updated_at,
          details: controlType === "exhausted" ? "All callable records exhausted" : "Execution control action stored in campaign metadata",
          idx: 9999,
        });
      }
    }

    if (normalizeCampaignExecutionState(campaign) === "exhausted" && !timeline.some((event) => event.type === "exhausted")) {
      timeline.push({
        campaign_id: campaign.id,
        campaign_name: campaign.name,
        type: "exhausted",
        timestamp: metadata.auto_completed_at || metadata.autoCompletedAt || campaign.updated_at,
        details: "All callable records exhausted",
        idx: 10000,
      });
    }

    return timeline;
  }).sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
}

export function attemptReasonCode(attempt = {}) {
  return attempt.reason_code || attempt.failure_reason || attempt.suppression_reason || attempt.skip_reason || attempt.status || "unknown";
}

export function contactRecordLabel(record = {}) {
  const row = record.row_data || record.rowData || record.contact_row_data || record.contactRowData || {};
  const methods = record.contact_methods || record.contactMethods || {};
  const first = row.first_name || row.firstname || row.firstName || row.first || "";
  const last = row.last_name || row.lastname || row.lastName || row.last || "";
  const company = row.company_name || row.company || row.organization || row.account || "";
  const name = [first, last].filter(Boolean).join(" ");
  const to = record.to_number || methods.mobile || methods.phone || methods.work || methods.home || row.phone || row.mobile || row.number || "Unknown number";
  return {
    to: String(to || "Unknown number"),
    name: String(name || "").trim(),
    company: String(company || "").trim(),
  };
}

export function groupAttemptsByContactRecord(records = [], attempts = []) {
  const byId = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const id = record.contact_record_id || record.id;
    if (!id) continue;
    byId.set(id, {
      id,
      record,
      label: contactRecordLabel(record),
      attempts: [],
      attempt_count: Number(record.attempt_count || 0),
      status_counts: { ...(record.status_counts || {}) },
      has_precomputed_counts: Boolean(record.attempt_count || Object.keys(record.status_counts || {}).length),
    });
  }

  for (const attempt of Array.isArray(attempts) ? attempts : []) {
    const id = attempt.contact_record_id || "unmatched";
    if (!byId.has(id)) {
      byId.set(id, {
        id,
        record: attempt,
        label: contactRecordLabel(attempt),
        attempts: [],
        attempt_count: 0,
        status_counts: {},
      });
    }
    const group = byId.get(id);
    group.attempts.push(attempt);
    if (!group.has_precomputed_counts) {
      group.attempt_count += 1;
      const status = attempt.status || "unknown";
      group.status_counts[status] = Number(group.status_counts[status] || 0) + 1;
    }
  }

  return [...byId.values()].map((group) => ({
    ...group,
    attempts: group.attempts.sort((a, b) => new Date(b.created_at || b.updated_at || 0) - new Date(a.created_at || a.updated_at || 0)),
  })).sort((a, b) => {
    const aTime = a.attempts[0]?.created_at || a.record?.last_attempt_at || a.record?.updated_at || 0;
    const bTime = b.attempts[0]?.created_at || b.record?.last_attempt_at || b.record?.updated_at || 0;
    return new Date(bTime) - new Date(aTime);
  });
}
