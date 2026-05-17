export const CAMPAIGN_STATUS_EVENT_TYPES = ["start", "stop", "pause", "recycle", "exhausted"];

const STATUS_EVENT_ALIASES = {
  started: "start",
  running: "start",
  resume: "start",
  resumed: "start",
  stopped: "stop",
  paused: "pause",
  recycled: "recycle",
  auto_complete: "exhausted",
  auto_completed: "exhausted",
  exhausted: "exhausted",
  all_callable_records_exhausted: "exhausted",
};

const CONTACT_IDENTITY_FIELD_TYPES = ["first_name", "last_name", "display_name", "company", "phone"];

export function singleCampaignSelection(campaigns = [], selectedId = null) {
  const safeCampaigns = Array.isArray(campaigns) ? campaigns : [];
  if (!safeCampaigns.length) return { id: null, hasCampaigns: false };
  const selected = safeCampaigns.find((campaign) => campaign?.id === selectedId);
  return { id: selected?.id || safeCampaigns[0]?.id || null, hasCampaigns: true };
}

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

function eventDetailParts(parts = []) {
  return parts.filter((part) => part != null && String(part).trim()).map((part) => String(part).trim()).join(" · ");
}

function statusEventsFromCampaignRun(campaign = {}, run = {}) {
  const events = [];
  const campaignName = campaign?.name;
  if (run.started_at || run.created_at) {
    events.push({
      campaign_id: campaign.id,
      campaign_name: campaignName,
      type: "start",
      timestamp: run.started_at || run.created_at,
      details: eventDetailParts(["Campaign run started", run.started_by ? `by ${run.started_by}` : null, run.id ? `run ${run.id}` : null]),
      idx: 0,
      run_id: run.id || null,
    });
  }
  const stopReason = String(run.stop_reason || run.metadata?.reason || "").toLowerCase();
  const autoCompleted = Boolean(run.metadata?.auto_completed || stopReason === "all_callable_records_exhausted");
  const statusType = autoCompleted ? "exhausted" : ["completed", "failed", "stopped"].includes(String(run.status || "").toLowerCase()) ? "stop" : run.status;
  const type = normalizeStatusEventType(run.metadata?.action || run.metadata?.lastAction || statusType);
  if (["stop", "pause", "recycle", "exhausted"].includes(type) && (run.stopped_at || run.updated_at)) {
    events.push({
      campaign_id: campaign.id,
      campaign_name: campaignName,
      type,
      timestamp: run.stopped_at || run.updated_at,
      details: eventDetailParts([
        type === "exhausted" ? "All callable records exhausted" : `Campaign run ${type}`,
        run.stop_reason,
        run.stopped_by ? `by ${run.stopped_by}` : null,
        run.id ? `run ${run.id}` : null,
      ]),
      idx: 1,
      run_id: run.id || null,
    });
  }
  return events;
}

export function campaignStatusEventsFromCampaigns(campaigns = [], executionDebugByCampaign = {}) {
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

    const debug = executionDebugByCampaign?.[campaign.id] || {};
    for (const run of Array.isArray(debug.campaign_runs) ? debug.campaign_runs : []) {
      timeline.push(...statusEventsFromCampaignRun(campaign, run));
    }

    if (metadata.execution_control) {
      const controlType = normalizeStatusEventType(metadata.execution_control.lastAction || metadata.execution_control.last_action);
      if (allowed.has(controlType)) {
        timeline.push({
          campaign_id: campaign.id,
          campaign_name: campaign.name,
          type: controlType,
          timestamp: metadata.execution_control.lastActionAt || metadata.execution_control.updatedAt || metadata.execution_control.updated_at || campaign.updated_at,
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

function firstValue(...values) {
  return values.map((value) => (value == null ? "" : String(value).trim())).find(Boolean) || "";
}

function fieldsBySemanticType(contactList = {}) {
  const fields = Array.isArray(contactList?.custom_field_schema) ? contactList.custom_field_schema : [];
  return fields.reduce((acc, field) => {
    const name = String(field?.name || "").trim();
    const type = String(field?.type || "").trim().toLowerCase();
    if (name && CONTACT_IDENTITY_FIELD_TYPES.includes(type)) acc[type] = name;
    const header = String(field?.label || field?.name || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    if (name && !acc.full_name && /^(first_)?(and_)?last_name$/.test(header)) acc.full_name = name;
    if (name && !acc.full_name && header.includes("first") && header.includes("last") && header.includes("name")) acc.full_name = name;
    if (name && !acc.display_name && header.includes("display") && header.includes("name")) acc.display_name = name;
    if (name && !acc.company && (header === "company" || header.includes("company_name") || header.includes("organization"))) acc.company = name;
    if (name && !acc.phone && ["phone", "phone_number", "mobile", "number", "tel", "telephone"].includes(header)) acc.phone = name;
    return acc;
  }, {});
}

function valuesFromContactMethods(methods = {}) {
  if (!methods || typeof methods !== "object") return [];
  const values = [];
  for (const value of [methods.number, methods.voice, methods.whatsapp]) {
    if (value == null) continue;
    if (typeof value === "object" && !Array.isArray(value)) values.push(...Object.values(value));
    else if (Array.isArray(value)) values.push(...value);
    else values.push(value);
  }
  return values.map((value) => String(value || "").trim()).filter(Boolean);
}

export function contactRecordLabel(record = {}, contactList = {}) {
  const row = record.row_data || record.rowData || record.contact_row_data || record.contactRowData || {};
  const methods = record.contact_methods || record.contactMethods || {};
  const semantic = fieldsBySemanticType(contactList);
  const first = firstValue(row[semantic.first_name], row.first_name, row.firstname, row.firstName, row.first);
  const last = firstValue(row[semantic.last_name], row.last_name, row.lastname, row.lastName, row.last);
  const displayName = firstValue(row[semantic.display_name], row.display_name, row.displayName, row.name, row.full_name, row.fullName);
  const company = firstValue(row[semantic.company], row.company_name, row.company, row.organization, row.account);
  const fullName = firstValue(row[semantic.full_name], row.full_name, row.fullName);
  const name = firstValue([first, last].filter(Boolean).join(" "), fullName, displayName);
  const methodNumbers = valuesFromContactMethods(methods);
  const to = firstValue(record.to_number, ...methodNumbers, row[semantic.phone], row.phone, row.mobile, row.number, row.phone_number, row.msisdn, "Unknown number");
  return {
    to: String(to || "Unknown number"),
    name: String(name || "").trim(),
    displayName: String(displayName || "").trim(),
    company: String(company || "").trim(),
  };
}

export function groupAttemptsByContactRecord(records = [], attempts = [], contactList = {}) {
  const byId = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const id = record.contact_record_id || record.id;
    if (!id) continue;
    byId.set(id, {
      id,
      record,
      label: contactRecordLabel(record, contactList),
      attempts: [],
      attempt_count: Number(record.attempt_count || 0),
      status_counts: { ...(record.status_counts || {}) },
      has_precomputed_counts: Boolean(record.attempt_count || Object.keys(record.status_counts || {}).length),
    });
  }

  for (const attempt of Array.isArray(attempts) ? attempts : []) {
    const id = attempt.contact_record_id || `unmatched:${attempt.id || attempt.call_control_id || attempt.call_session_id || byId.size}`;
    if (!byId.has(id)) {
      byId.set(id, {
        id,
        record: attempt,
        label: contactRecordLabel(attempt, contactList),
        attempts: [],
        attempt_count: 0,
        status_counts: {},
      });
    }
    const group = byId.get(id);
    group.attempts.push(attempt);
    if (group.label?.to === "Unknown number" && attempt.to_number) group.label = { ...group.label, to: attempt.to_number };
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
