import { resolveCallerIdentity } from "../contact-center/caller-identity.mjs";

export {
  ACD_HISTORY_DTO_VERSION,
  assertAcdHistoryDto,
  createAcdHistoryDto,
} from "./history-contract.mjs";

const CORE_LIFECYCLE_TYPES = new Set([
  "enqueued",
  "offered",
  "alerting",
  "agent_not_answering",
  "answered",
  "connected",
  "bridged",
  "disconnected",
  "abandoned",
  "wrapup_start",
  "wrapup_end",
]);

function iso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function secondsBetween(start, end) {
  const startMs = start ? new Date(start).getTime() : Number.NaN;
  const endMs = end ? new Date(end).getTime() : Number.NaN;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 0;
  return Math.max(0, Math.floor((endMs - startMs) / 1000));
}

function eventKey(event) {
  return [
    event?.type || "event",
    iso(event?.timestamp) || "",
    event?.eventId || "",
    event?.agentUsername || "",
    event?.queueId || "",
  ].join("|");
}

const LEGACY_CONSULT_STEP_EVENTS = {
  route_initial_hold_audio: "consult_ringing",
  consult_active: "consult_connected",
  customer_active: "consult_customer_active",
  consultant_active: "consult_consultant_active",
  consult_cancelled: "consult_customer_restored",
  dial_failed: "consult_failed",
  consult_requeued: "consult_failed",
  complete_consult: "consult_completed",
};

export function deriveConsultTimelineEvents(events = []) {
  const explicitSagaIds = new Set(
    events
      .filter((event) => String(event.type || "").startsWith("consult_"))
      .map((event) => event.payload?.saga_id)
      .filter(Boolean),
  );
  const explicit = events.filter((event) =>
    String(event.type || "").startsWith("consult_"),
  );
  const derived = [];

  for (const event of events) {
    const payload = event.payload || {};
    const sagaId = payload.saga_id || null;
    if (
      payload.saga_type !== "consult" ||
      !sagaId ||
      explicitSagaIds.has(sagaId)
    ) {
      continue;
    }
    const type = event.type === "saga_started"
      ? "consult_started"
      : LEGACY_CONSULT_STEP_EVENTS[payload.to];
    if (!type) continue;
    const sagaData = event.saga_data || {};
    derived.push({
      ...event,
      type,
      payload: {
        saga_id: sagaId,
        agent_id: sagaData.agentId || event.agent_id || null,
        agent_username: sagaData.agentUsername || null,
        target: sagaData.target || null,
        target_kind: sagaData.targetKind || null,
        target_label: sagaData.targetLabel || null,
        target_username: sagaData.targetUsername || null,
        active_leg:
          type === "consult_customer_active" ||
          type === "consult_customer_restored"
            ? "parked"
            : type === "consult_connected" ||
                type === "consult_consultant_active"
              ? "consultant"
              : null,
        derived: true,
      },
    });
  }

  return [...explicit, ...derived].sort(
    (a, b) => Number(a.id || 0) - Number(b.id || 0),
  );
}

export function attachAgentNamesToTimeline(
  routingMetadata,
  agentNamesByUsername = {},
) {
  const timeline = Array.isArray(routingMetadata?.timeline)
    ? routingMetadata.timeline
    : null;
  if (!timeline) return routingMetadata;

  const normalizedNames = Object.fromEntries(
    Object.entries(agentNamesByUsername).map(([username, name]) => [
      String(username).toLowerCase(),
      name,
    ]),
  );
  const resolveName = (username) =>
    username
      ? normalizedNames[String(username).toLowerCase()] || null
      : null;

  return {
    ...(routingMetadata || {}),
    timeline: timeline.map((event) => {
      const agentName = resolveName(event?.agentUsername);
      const transferredByName = resolveName(event?.transferredBy);
      return {
        ...event,
        ...(agentName ? { agentName } : {}),
        ...(transferredByName ? { transferredByName } : {}),
      };
    }),
  };
}

async function hydrateTimelineAgentNames(db, routingMetadata) {
  const timeline = Array.isArray(routingMetadata?.timeline)
    ? routingMetadata.timeline
    : [];
  const usernames = [
    ...new Set(
      timeline
        .flatMap((event) => [event?.agentUsername, event?.transferredBy])
        .filter(Boolean),
    ),
  ];
  if (usernames.length === 0) return routingMetadata;

  const users = await db.query(
    `SELECT username, first_name, last_name
       FROM users
      WHERE username = ANY($1::text[])`,
    [usernames],
  );
  const namesByUsername = {};
  for (const user of users.rows) {
    const fullName = [user.first_name, user.last_name]
      .filter(Boolean)
      .join(" ")
      .trim();
    if (fullName) namesByUsername[user.username] = fullName;
  }
  return attachAgentNamesToTimeline(routingMetadata, namesByUsername);
}

/**
 * Build the legacy Call History timeline from Core's durable routing model.
 * The call-flow-created `initiated` event is intentionally preserved: it is
 * the IVR phase before Core takes ownership at enqueue.
 */
export function buildAcdTimeline({
  routingMetadata = {},
  workItem,
  segments = [],
  offers = [],
  queue = null,
  queuesById = {},
  transferEvents = [],
  consultEvents = [],
  agentUsernames = {},
} = {}) {
  const existingTimeline = Array.isArray(routingMetadata?.timeline)
    ? routingMetadata.timeline
    : [];
  const preserved = existingTimeline.filter((event) => {
    if (event?.source === "acd_core") return false;
    return !CORE_LIFECYCLE_TYPES.has(String(event?.type || "").toLowerCase());
  });
  const generated = [];
  const add = (type, timestamp, data = {}) => {
    const normalizedTimestamp = iso(timestamp);
    if (!normalizedTimestamp) return;
    generated.push({
      type,
      timestamp: normalizedTimestamp,
      source: "acd_core",
      ...data,
    });
  };
  if (workItem?.channel && workItem.channel !== "voice") {
    add("received", workItem.created_at);
  }

  const orderedSegments = [...segments].sort(
    (a, b) => Number(a.seq) - Number(b.seq),
  );
  const orderedOffers = [...offers].sort(
    (a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0),
  );
  const queueDetails = (queueId) => {
    const resolved = queuesById?.[queueId] ||
      (queue?.id === queueId || !queueId ? queue : null);
    return {
      queueName: resolved?.name || null,
      queueId: queueId || workItem?.queue_id || null,
      routingAlgorithm: resolved?.routing_strategy || null,
    };
  };

  const queueSegments = orderedSegments.filter(
    (segment) => segment.kind === "queue_wait",
  );
  if (queueSegments.length > 0) {
    for (const segment of queueSegments) {
      add("enqueued", segment.started_at, queueDetails(segment.queue_id));
    }
  } else {
    add("enqueued", workItem?.enqueued_at, queueDetails(workItem?.queue_id));
  }

  const queueAt = (timestamp) => {
    const at = new Date(timestamp || 0).getTime();
    const matching = [...queueSegments]
      .reverse()
      .find((segment) => new Date(segment.started_at || 0).getTime() <= at);
    return queueDetails(matching?.queue_id || workItem?.queue_id);
  };

  // Offers are the source of alerting intervals. A failed attempt returns the
  // call to the queue, while an accepted offer flows into the agent segment.
  for (const offer of orderedOffers) {
    const agentUsername = agentUsernames[offer.agent_id] || null;
    const offerQueue = queueAt(offer.created_at);
    add("alerting", offer.created_at, {
      agentUsername,
      agentId: offer.agent_id || null,
      queueId: offerQueue.queueId,
      queueName: offerQueue.queueName,
      routingAlgorithm: offerQueue.routingAlgorithm,
      offerGeneration: Number(offer.generation),
    });
    if (offer.state === "no_answer") {
      add("agent_not_answering", offer.terminal_at, {
        agentUsername,
        agentId: offer.agent_id || null,
        reason: "agent not answering",
        alertingDurationSeconds: secondsBetween(
          offer.created_at,
          offer.terminal_at,
        ),
        offerGeneration: Number(offer.generation),
      });
    }
    // A cancelled offer does not necessarily mean that the caller re-entered
    // the same queue. Core also cancels the accepted source offer while a
    // queue transfer is being committed. A real queue entry is represented by
    // its own durable queue_wait segment, so only failed agent attempts need a
    // synthetic re-evaluation event here.
    if (
      ["no_answer", "rejected"].includes(offer.state) ||
      (offer.state === "cancelled" &&
        offer.outcome_reason === "orphaned_claim")
    ) {
      add("enqueued", offer.terminal_at, {
        ...offerQueue,
        reEvaluated: true,
        reason: offer.outcome_reason || offer.state,
      });
    }
  }

  const agentSegments = orderedSegments.filter(
    (segment) => segment.kind === "agent",
  );
  const orderedTransferEvents = [...transferEvents].sort(
    (a, b) => new Date(a.occurred_at || 0) - new Date(b.occurred_at || 0),
  );
  const usedTransferEvents = new Set();
  const transferForSegment = (segment) => {
    const candidates = orderedTransferEvents
      .map((event, index) => ({ event, index }))
      .filter(({ event, index }) => {
        if (usedTransferEvents.has(index)) return false;
        const eventAgent = event.payload?.agent_id;
        return !eventAgent || String(eventAgent) === String(segment.agent_id);
      })
      .sort((left, right) => {
        const endedAt = new Date(segment.ended_at || 0).getTime();
        return (
          Math.abs(new Date(left.event.occurred_at || 0).getTime() - endedAt) -
          Math.abs(new Date(right.event.occurred_at || 0).getTime() - endedAt)
        );
      });
    const selected = candidates[0];
    if (!selected) return null;
    usedTransferEvents.add(selected.index);
    return selected.event;
  };
  for (const segment of agentSegments) {
    const agentUsername = agentUsernames[segment.agent_id] || null;
    const answeredAt = segment.answered_at || segment.started_at;
    add("answered", answeredAt, {
      agentUsername,
      agentId: segment.agent_id || null,
    });
    // Keep the detailed Event Journey at legacy parity. Both events share the
    // timestamp, so only `connected` contributes the visible interaction phase.
    add("connected", answeredAt, {
      agentUsername,
      agentId: segment.agent_id || null,
    });
    if (segment.outcome === "transferred") {
      const transferEvent = transferForSegment(segment);
      const payload = transferEvent?.payload || {};
      const targetKind =
        transferEvent?.type === "work_item_queue_transferred"
          ? "queues"
          : payload.target_kind || null;
      const targetLabel =
        payload.target_label || payload.queue_name || payload.target || null;
      add("transfer", segment.ended_at, {
        transferredBy: agentUsername,
        agentId: segment.agent_id || null,
        targetKind,
        targetLabel,
        to: targetLabel,
        queueId: payload.queue_id || null,
        queueName: payload.queue_name || null,
      });
      add("wrapup_start", segment.ended_at, {
        agentUsername, agentId: segment.agent_id, segmentId: segment.id,
        outcome: "transferred", queueId: segment.queue_id,
      });
      add("wrapup_end", segment.wrapup_ended_at, {
        agentUsername, agentId: segment.agent_id, segmentId: segment.id,
        outcome: "transferred", queueId: segment.queue_id,
        wrapupDurationSeconds: secondsBetween(
          segment.ended_at,
          segment.wrapup_ended_at,
        ),
      });
    }
  }

  for (const event of consultEvents) {
    const payload = event.payload || {};
    add(event.type, event.occurred_at, {
      eventId: event.id != null ? Number(event.id) : null,
      sagaId: payload.saga_id || null,
      agentId: payload.agent_id || event.agent_id || null,
      agentUsername: payload.agent_username || null,
      target: payload.target || null,
      targetKind: payload.target_kind || null,
      targetLabel: payload.target_label || null,
      targetUsername: payload.target_username || null,
      activeLeg: payload.active_leg || null,
      state: payload.state || null,
      reason: payload.reason || null,
    });
  }

  const terminalAt = workItem?.terminal_at;
  const lastAgentSegment = agentSegments.at(-1) || null;
  const finalAgentSegment = lastAgentSegment?.outcome !== "transferred" ? lastAgentSegment : null;
  // Messaging work becomes terminal only after disposition. The agent segment
  // ends when handling stops, before wrap-up; terminal_at would hide that time
  // inside Interact and report a zero-length wrap-up. Use the same segment
  // boundaries as the history DTO and reporting metrics for every channel.
  const handlingEndedAt = finalAgentSegment?.ended_at || terminalAt;
  if (workItem?.state === "abandoned") {
    add("abandoned", terminalAt, {
      reason: workItem.terminal_reason || null,
      waitTimeSeconds: secondsBetween(workItem.enqueued_at, terminalAt),
    });
  } else if (["completed", "failed"].includes(workItem?.state)) {
    add("disconnected", handlingEndedAt, {
      reason: workItem.terminal_reason || null,
    });
  }

  if (finalAgentSegment && ["completed", "failed"].includes(workItem?.state)) {
    const agentUsername = agentUsernames[finalAgentSegment.agent_id] || null;
    add("wrapup_start", handlingEndedAt, { agentUsername });
    add("wrapup_end", finalAgentSegment.wrapup_ended_at, {
      agentUsername,
      wrapupDurationSeconds: secondsBetween(
        handlingEndedAt,
        finalAgentSegment.wrapup_ended_at,
      ),
    });
  }

  const unique = new Map();
  for (const event of [...preserved, ...generated]) {
    unique.set(eventKey(event), event);
  }
  const timestampOrder = {
    initiated: 0,
    received: 0,
    consult_completed: 0.5,
    // PostgreSQL now() is transaction-stable. Queue transfer and the target
    // queue_wait segment can therefore share a timestamp; the hand-off must be
    // shown before the destination queue entry in Event Journey.
    transfer: 1,
    agent_not_answering: 1.5,
    enqueued: 2,
    alerting: 3,
    answered: 4,
    connected: 5,
    consult_started: 5.1,
    consult_ringing: 5.2,
    consult_connected: 5.3,
    consult_consultant_active: 5.3,
    consult_customer_active: 5.4,
    consult_customer_restored: 5.4,
    consult_failed: 5.4,
    disconnected: 6,
    abandoned: 6,
    wrapup_start: 7,
    wrapup_end: 8,
  };
  const timeline = [...unique.values()].sort((a, b) => {
    const delta = new Date(a.timestamp || 0) - new Date(b.timestamp || 0);
    if (delta !== 0) return delta;
    return (timestampOrder[a.type] ?? 50) - (timestampOrder[b.type] ?? 50);
  });

  return { ...(routingMetadata || {}), timeline };
}

/**
 * Return one Call History header record per durable Core agent segment. These
 * records deliberately remain separate from the flattened legacy interaction
 * row so queue transfers never hide the source agent, queue, wrap-up or leg.
 */
export async function loadAcdInteractionSegments(db, workItemId) {
  if (!workItemId) return [];

  const result = await db.query(
    `SELECT s.id,
            s.seq,
            s.queue_id,
            q.name AS queue_name,
            s.agent_id,
            u.username AS agent_username,
            COALESCE(
              NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), ''),
              u.username
            ) AS agent_name,
            s.started_at,
            s.answered_at,
            s.ended_at,
            s.outcome,
            s.wrapup_code_id,
            wc.name AS wrapup_code_name,
            s.wrapup_ended_at,
            matched_offer.generation AS offer_generation,
            agent_leg.provider_call_id AS agent_call_control_id,
            agent_leg.provider_session_id AS agent_call_session_id
       FROM acd_segments s
       LEFT JOIN cc_queues q ON q.id = s.queue_id
       LEFT JOIN users u ON u.id = s.agent_id
       LEFT JOIN cc_wrapup_codes wc ON wc.id = s.wrapup_code_id
       LEFT JOIN LATERAL (
         SELECT o.generation
           FROM acd_offers o
          WHERE o.work_item_id = s.work_item_id
            AND o.agent_id = s.agent_id
            AND o.created_at <= COALESCE(s.answered_at, s.started_at) + interval '5 seconds'
          ORDER BY ABS(EXTRACT(EPOCH FROM (
            COALESCE(s.answered_at, s.started_at) - o.created_at
          ))) ASC,
          o.generation DESC
          LIMIT 1
       ) matched_offer ON TRUE
       LEFT JOIN LATERAL (
         SELECT l.provider_call_id, l.provider_session_id
           FROM acd_legs l
          WHERE l.work_item_id = s.work_item_id
            AND l.role = 'agent_device'
            AND l.offer_generation = matched_offer.generation
          ORDER BY l.created_at DESC
          LIMIT 1
       ) agent_leg ON TRUE
      WHERE s.work_item_id = $1
        AND s.kind = 'agent'
      ORDER BY s.seq`,
    [workItemId],
  );

  return result.rows.map((segment) => ({
    ...segment,
    source: "acd_core",
    wrapup_code_names: segment.wrapup_code_name
      ? [segment.wrapup_code_name]
      : [],
  }));
}

export async function loadAcdTimelineProjection(
  db,
  workItemId,
  { routingMetadata = {} } = {},
) {
  const [workItemResult, segmentsResult, offersResult, journeyEventsResult] = await Promise.all([
    db.query(`SELECT * FROM acd_work_items WHERE id = $1`, [workItemId]),
    db.query(
      `SELECT * FROM acd_segments WHERE work_item_id = $1 ORDER BY seq`,
      [workItemId],
    ),
    db.query(
      `SELECT * FROM acd_offers WHERE work_item_id = $1 ORDER BY generation`,
      [workItemId],
    ),
    db.query(
      `SELECT e.id, e.agent_id, e.type, e.payload, e.occurred_at,
              s.data AS saga_data
         FROM acd_events e
         LEFT JOIN acd_sagas s ON s.id::text = e.payload->>'saga_id'
        WHERE e.work_item_id = $1
          AND (
            e.type IN ('work_item_transferred', 'work_item_queue_transferred')
            OR e.type LIKE 'consult_%'
            OR (
              e.type IN ('saga_started', 'saga_step')
              AND e.payload->>'saga_type' = 'consult'
            )
          )
        ORDER BY e.id`,
      [workItemId],
    ),
  ]);
  const workItem = workItemResult.rows[0];
  if (!workItem) return null;

  const segments = segmentsResult.rows;
  const offers = offersResult.rows;
  const queueIds = [
    ...new Set(
      [workItem.queue_id, ...segments.map((segment) => segment.queue_id)].filter(Boolean),
    ),
  ];
  const queueResult = queueIds.length > 0
    ? await db.query(`SELECT * FROM cc_queues WHERE id = ANY($1::text[])`, [queueIds])
    : { rows: [] };
  const queuesById = Object.fromEntries(
    queueResult.rows.map((queueRow) => [queueRow.id, queueRow]),
  );
  const agentIds = [
    ...new Set(
      [
        ...segments.map((segment) => segment.agent_id),
        ...offers.map((offer) => offer.agent_id),
      ].filter(Boolean),
    ),
  ];
  const agentUsernames = {};
  if (agentIds.length > 0) {
    const users = await db.query(
      `SELECT id, username FROM users WHERE id = ANY($1::text[])`,
      [agentIds],
    );
    for (const user of users.rows) agentUsernames[user.id] = user.username;
  }

  return buildAcdTimeline({
    routingMetadata,
    workItem,
    segments,
    offers,
    queue: queuesById[workItem.queue_id] || null,
    queuesById,
    transferEvents: journeyEventsResult.rows.filter((event) =>
      ["work_item_transferred", "work_item_queue_transferred"].includes(event.type),
    ),
    consultEvents: deriveConsultTimelineEvents(journeyEventsResult.rows),
    agentUsernames,
  });
}

export async function hydrateAcdInteractionTimeline(db, interaction) {
  if (!interaction) return interaction;

  const workItemId = interaction?.work_item_id || interaction?.id || null;
  let routingMetadata = interaction.routing_metadata || {};
  let callerIdentity = null;
  if (workItemId) {
    [routingMetadata, callerIdentity] = await Promise.all([
      loadAcdTimelineProjection(db, workItemId, {
        routingMetadata,
      }),
      interaction.from_name
        ? Promise.resolve(null)
        : resolveCallerIdentity(db, interaction.from_number),
    ]);
  }
  routingMetadata = await hydrateTimelineAgentNames(db, routingMetadata);

  return {
    ...interaction,
    ...(routingMetadata ? { routing_metadata: routingMetadata } : {}),
    ...(callerIdentity?.name ? { from_name: callerIdentity.name } : {}),
  };
}
