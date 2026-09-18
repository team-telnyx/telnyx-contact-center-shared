export const ACD_HISTORY_DTO_VERSION = "acd.history.v1";

const WORK_ITEM_STATES = new Set([
  "open",
  "queued",
  "offered",
  "active",
  "completed",
  "abandoned",
  "failed",
]);

function asIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function asNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function secondsBetween(start, end) {
  const startMs = start ? new Date(start).getTime() : Number.NaN;
  const endMs = end ? new Date(end).getTime() : Number.NaN;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 0;
  return Math.max(0, Math.floor((endMs - startMs) / 1000));
}

function lookup(source, id) {
  if (!id || !source) return null;
  if (source instanceof Map) return source.get(id) || null;
  return source[id] || null;
}

function agentLabel(agent) {
  if (!agent) return null;
  const fullName = [agent.first_name, agent.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();
  return fullName || agent.display_name || agent.username || null;
}

function normalizeSegment(segment, lookups) {
  const queue = lookup(lookups.queues, segment.queue_id);
  const agent = lookup(lookups.agents, segment.agent_id);
  const wrapup = lookup(lookups.wrapupCodes, segment.wrapup_code_id);
  return {
    id: String(segment.id),
    sequence: asNumber(segment.seq),
    kind: segment.kind,
    queue: segment.queue_id
      ? { id: String(segment.queue_id), name: queue?.name || null }
      : null,
    agent: segment.agent_id
      ? {
          id: String(segment.agent_id),
          username: agent?.username || null,
          name: agentLabel(agent),
        }
      : null,
    startedAt: asIso(segment.started_at),
    answeredAt: asIso(segment.answered_at),
    endedAt: asIso(segment.ended_at),
    outcome: segment.outcome || null,
    wrapup: {
      codeId: segment.wrapup_code_id
        ? String(segment.wrapup_code_id)
        : null,
      codeName: wrapup?.name || null,
      endedAt: asIso(segment.wrapup_ended_at),
    },
  };
}

function normalizeOffer(offer, lookups) {
  const agent = lookup(lookups.agents, offer.agent_id);
  return {
    id: String(offer.id),
    generation: asNumber(offer.generation),
    state: offer.state,
    outcomeReason: offer.outcome_reason || null,
    agent: offer.agent_id
      ? {
          id: String(offer.agent_id),
          username: agent?.username || null,
          name: agentLabel(agent),
        }
      : null,
    createdAt: asIso(offer.created_at),
    deadlineAt: asIso(offer.deadline_at),
    terminalAt: asIso(offer.terminal_at),
  };
}

function normalizeLeg(leg) {
  return {
    id: String(leg.id),
    role: leg.role,
    state: leg.state,
    agentId: leg.agent_id ? String(leg.agent_id) : null,
    providerCallId: leg.provider_call_id || null,
    providerSessionId: leg.provider_session_id || null,
    offerGeneration:
      leg.offer_generation == null ? null : asNumber(leg.offer_generation),
    createdAt: asIso(leg.created_at),
    answeredAt: asIso(leg.answered_at),
    bridgedAt: asIso(leg.bridged_at),
    endedAt: asIso(leg.ended_at),
    endedReason: leg.ended_reason || null,
  };
}

function normalizeEvent(event) {
  return {
    id: event.id == null ? null : String(event.id),
    type: event.type,
    actor: event.actor || null,
    agentId: event.agent_id ? String(event.agent_id) : null,
    occurredAt: asIso(event.occurred_at),
    payload:
      event.payload && typeof event.payload === "object" ? event.payload : {},
  };
}

function normalizeStatusInterval(interval) {
  return {
    id: String(interval.id),
    agentId: String(interval.user_id || interval.agent_id),
    status: interval.status,
    statusType: interval.status_type || null,
    nextStatus: interval.next_status || null,
    startedAt: asIso(interval.started_at),
    endedAt: asIso(interval.ended_at),
    durationSeconds: asNumber(interval.duration_seconds),
    source: interval.source || null,
  };
}

function normalizeArtifact(record) {
  const normalized = { ...record };
  for (const key of [
    "created_at",
    "updated_at",
    "started_at",
    "ended_at",
    "completed_at",
  ]) {
    if (!(key in normalized)) continue;
    const camel = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    normalized[camel] = asIso(normalized[key]);
    delete normalized[key];
  }
  return normalized;
}

function buildMetrics(segments, offers, workItem) {
  const queueSegments = segments.filter((segment) => segment.kind === "queue_wait");
  const agentSegments = segments.filter((segment) => segment.kind === "agent");
  const waitSeconds = queueSegments.reduce(
    (total, segment) =>
      total + secondsBetween(segment.started_at, segment.ended_at),
    0,
  );
  const alertSeconds = offers.reduce(
    (total, offer) =>
      total + secondsBetween(offer.created_at, offer.terminal_at),
    0,
  );
  const talkSeconds = agentSegments.reduce(
    (total, segment) =>
      total + secondsBetween(segment.answered_at, segment.ended_at),
    0,
  );
  const wrapupSeconds = agentSegments.reduce(
    (total, segment) =>
      total + secondsBetween(segment.ended_at, segment.wrapup_ended_at),
    0,
  );
  return {
    waitSeconds,
    alertSeconds,
    talkSeconds,
    wrapupSeconds,
    handleSeconds: talkSeconds + wrapupSeconds,
    totalSeconds: secondsBetween(workItem.created_at, workItem.terminal_at),
  };
}

/**
 * Create the versioned history DTO consumed by agent, supervisor, analytics,
 * forms, Agent Assist and Quality Management readers after the voice cutover.
 * The DTO accepts Core rows only, so callers cannot depend on retired
 * projection metadata.
 */
export function createAcdHistoryDto({
  workItem,
  segments = [],
  offers = [],
  legs = [],
  events = [],
  statusIntervals = [],
  recordings = [],
  transcripts = [],
  annotations = [],
  formSubmissions = [],
  agentAssistSessions = [],
  qualityEvaluations = [],
  outboundAttempts = [],
  lookups = {},
} = {}) {
  if (!workItem?.id) throw new TypeError("A Core work item is required");
  if (!WORK_ITEM_STATES.has(workItem.state)) {
    throw new TypeError(`Unsupported Core work-item state: ${workItem.state}`);
  }
  for (const [name, value] of Object.entries({
    segments,
    offers,
    legs,
    events,
    statusIntervals,
    recordings,
    transcripts,
    annotations,
    formSubmissions,
    agentAssistSessions,
    qualityEvaluations,
    outboundAttempts,
  })) {
    if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  }

  const queue = lookup(lookups.queues, workItem.queue_id);
  const attributes =
    workItem.attributes && typeof workItem.attributes === "object"
      ? workItem.attributes
      : {};
  const normalizedSegments = [...segments]
    .sort((left, right) => asNumber(left.seq) - asNumber(right.seq))
    .map((segment) => normalizeSegment(segment, lookups));
  const normalizedOffers = [...offers]
    .sort(
      (left, right) =>
        new Date(left.created_at || 0) - new Date(right.created_at || 0),
    )
    .map((offer) => normalizeOffer(offer, lookups));
  const answeredAt = segments
    .map((segment) => asIso(segment.answered_at))
    .filter(Boolean)
    .sort()[0] || null;
  const bridgedAt = legs
    .map((leg) => asIso(leg.bridged_at))
    .filter(Boolean)
    .sort()[0] || null;

  return {
    contract: ACD_HISTORY_DTO_VERSION,
    id: String(workItem.id),
    interactionId: String(workItem.id),
    workItemId: String(workItem.id),
    version: asNumber(workItem.version),
    channel: workItem.channel,
    direction: workItem.direction,
    state: workItem.state,
    queue: workItem.queue_id
      ? { id: String(workItem.queue_id), name: queue?.name || null }
      : null,
    priority: asNumber(workItem.priority),
    requiredSkills:
      workItem.required_skills && typeof workItem.required_skills === "object"
        ? workItem.required_skills
        : {},
    customer: {
      address: workItem.customer_address || null,
      name: attributes.customer_name || null,
      contactId: attributes.customer_identity_id || null,
    },
    contactCenterAddress: workItem.cc_address || null,
    timestamps: {
      createdAt: asIso(workItem.created_at),
      enqueuedAt: asIso(workItem.enqueued_at),
      answeredAt,
      bridgedAt,
      terminalAt: asIso(workItem.terminal_at),
    },
    terminalReason: workItem.terminal_reason || null,
    outboundAttemptId: workItem.outbound_attempt_id || null,
    metrics: buildMetrics(segments, offers, workItem),
    segments: normalizedSegments,
    offers: normalizedOffers,
    legs: [...legs]
      .sort(
        (left, right) =>
          new Date(left.created_at || 0) - new Date(right.created_at || 0),
      )
      .map(normalizeLeg),
    timeline: [...events]
      .sort((left, right) => asNumber(left.id) - asNumber(right.id))
      .map(normalizeEvent),
    statusIntervals: statusIntervals.map(normalizeStatusInterval),
    artifacts: {
      recordings: recordings.map(normalizeArtifact),
      transcripts: transcripts.map(normalizeArtifact),
      annotations: annotations.map(normalizeArtifact),
    },
    business: {
      formSubmissions: formSubmissions.map(normalizeArtifact),
      agentAssistSessions: agentAssistSessions.map(normalizeArtifact),
      qualityEvaluations: qualityEvaluations.map(normalizeArtifact),
    },
    outboundAttempts: outboundAttempts.map(normalizeArtifact),
  };
}

export function assertAcdHistoryDto(value) {
  if (!value || value.contract !== ACD_HISTORY_DTO_VERSION) {
    throw new TypeError("Unsupported ACD history contract");
  }
  if (!value.workItemId || value.workItemId !== value.interactionId) {
    throw new TypeError("History identity must be the Core work-item id");
  }
  for (const key of ["segments", "offers", "legs", "timeline"] ) {
    if (!Array.isArray(value[key])) throw new TypeError(`${key} must be an array`);
  }
  return value;
}
