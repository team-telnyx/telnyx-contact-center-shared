import {
  ACD_ADMISSION_DECISIONS,
  classifyAcdVoiceAdmission,
} from "./admission-contract.mjs";
import { outboundEnvelope } from "./outbound-intake.mjs";
import { hasInboxEvent, persistWebhookEvent } from "./inbox.mjs";
import { ACD_ARTIFACT_EVENT_TYPES } from "./artifacts.mjs";
import { resolveDirectAgentForPayload } from "./direct-capacity.mjs";

function headerValue(payload, name) {
  const headers = Array.isArray(payload?.custom_headers)
    ? payload.custom_headers
    : [];
  return (
    headers.find(
      (header) =>
        String(header?.name || "").toLowerCase() === name.toLowerCase(),
    )?.value || null
  );
}

async function collectAdmissionEvidence(pool, event) {
  const payload = event.payload || {};
  const callControlId = payload.call_control_id || null;
  const callSessionId = payload.call_session_id || null;
  const workItemHeader = headerValue(payload, "x-cc-work-item-id");
  const offerGenerationHeader = headerValue(
    payload,
    "x-cc-offer-generation",
  );
  const directIntentHeader = headerValue(payload, "x-cc-direct-intent-id");
  const sagaHeader = headerValue(payload, "x-cc-saga-id");
  const outbound = outboundEnvelope(payload);
  const inboundInitiation = event.eventType === "call.initiated"
    && ["incoming", "inbound"].includes(String(payload.direction || "").toLowerCase());
  const isArtifactEvent = ACD_ARTIFACT_EVENT_TYPES.has(event.eventType);

  const [
    inboxPersisted,
    knownLeg,
    knownSession,
    knownHeaderWorkItem,
    knownDirectIntent,
    configuredQueue,
    boundLegIntent,
    liveReservation,
    outboundWorkItem,
    directAgentResolution,
  ] = await Promise.all([
    hasInboxEvent(pool, event.eventId),
    pool.query(
      `SELECT 1 FROM acd_legs WHERE provider_call_id = $1 LIMIT 1`,
      [callControlId],
    ),
    pool.query(
      `SELECT 1
         FROM acd_work_items w
        WHERE ($2::boolean OR w.terminal_at IS NULL)
          AND (
            w.provider_session_id = $1
            OR EXISTS (
              SELECT 1 FROM acd_legs l
               WHERE l.work_item_id = w.id
                 AND l.provider_session_id = $1
            )
          )
        LIMIT 1`,
      [callSessionId, isArtifactEvent],
    ),
    pool.query(
      `SELECT 1
         FROM acd_work_items w
        WHERE w.id::text = $1
          AND (
            $2::text IS NULL
            OR EXISTS (
              SELECT 1 FROM acd_sagas s
               WHERE s.id::text = $2 AND s.work_item_id = w.id
            )
          )
        LIMIT 1`,
      [workItemHeader, sagaHeader],
    ),
    pool.query(
      `SELECT 1
         FROM acd_direct_intents
        WHERE provider_call_id = $1
           OR ($2::text IS NOT NULL AND id::text = $2)
        LIMIT 1`,
      [callControlId, directIntentHeader],
    ),
    pool.query(
      `SELECT 1 FROM cc_queues WHERE name = $1 LIMIT 1`,
      [event.eventType === "call.enqueued" ? payload.queue || null : null],
    ),
    pool.query(
      `SELECT 1
         FROM acd_leg_intents i
         JOIN acd_reservations r ON r.id = i.reservation_id
        WHERE i.work_item_id::text = $1
          AND i.offer_generation::text = $2
          AND r.state <> 'released'
        LIMIT 1`,
      [workItemHeader, offerGenerationHeader],
    ),
    pool.query(
      `SELECT 1
         FROM acd_legs l
         JOIN acd_work_items w ON w.id = l.work_item_id
        WHERE l.provider_call_id = $1
          AND (
            (l.role = 'customer' AND EXISTS (
              SELECT 1 FROM acd_outbound_lines ol
               WHERE ol.work_item_id = w.id AND ol.released_at IS NULL
            ))
            OR (l.role <> 'customer' AND EXISTS (
              SELECT 1 FROM acd_reservations r
               WHERE r.work_item_id = w.id AND r.state <> 'released'
            ))
          )
        LIMIT 1`,
      [callControlId],
    ),
    pool.query(
      `SELECT 1
         FROM acd_work_items
        WHERE id::text = $1 AND outbound_attempt_id = $2
        LIMIT 1`,
      [outbound.acdWorkItemId || null, outbound.attemptId || null],
    ),
    inboundInitiation
      ? resolveDirectAgentForPayload(pool, payload, {
          sourceFlowId: event.sourceFlowId || null,
        })
      : Promise.resolve(null),
  ]);

  const allowedCredentialConnectionIds = [process.env.TELNYX_SIP_CONNECTION_ID]
    .filter(Boolean)
    .map(String);
  const recognizedAgentCredentialConnection = allowedCredentialConnectionIds.length > 0
    && allowedCredentialConnectionIds.includes(String(payload.connection_id || ""));

  const coreScopedHint = Boolean(
    workItemHeader ||
      offerGenerationHeader ||
      directIntentHeader ||
      sagaHeader ||
      outbound.acdWorkItemId ||
      outbound.attemptId ||
      directAgentResolution?.directHintPresent,
  );

  return {
    inboxPersisted,
    knownCoreLeg: knownLeg.rowCount > 0,
    knownCoreSession:
      knownSession.rowCount > 0 || knownHeaderWorkItem.rowCount > 0,
    knownDirectIntent: knownDirectIntent.rowCount > 0,
    configuredCcQueue: configuredQueue.rowCount > 0,
    boundLegIntent: boundLegIntent.rowCount > 0,
    liveReservationEvidence: liveReservation.rowCount > 0,
    journaledOutboundCommand: outboundWorkItem.rowCount > 0,
    directAgentResolution,
    recognizedAgentCredentialConnection,
    coreScopedHint,
    nonCcDomain: event.sourceRoute === "incoming" ? "voice_flow" : "voice_api",
  };
}

// Only signature-verified server adapters call this function. It performs no
// provider I/O or saga advancement; a Core event is acknowledged only after
// its durable inbox INSERT succeeds.
export async function admitAcdVoiceEvent(pool, event) {
  if (!pool) return { retryable: true, httpStatus: 503 };
  if (!event?.eventId || !event?.eventType) {
    return { retryable: true, httpStatus: 400 };
  }
  try {
    const evidence = await collectAdmissionEvidence(pool, event);
    const classification = classifyAcdVoiceAdmission(event, evidence);
    if (classification.decision === ACD_ADMISSION_DECISIONS.PASS_DOMAIN) {
      return { handled: false, classification };
    }

    await persistWebhookEvent(pool, event);
    await pool
      .query(`SELECT pg_notify('acd_events', $1)`, [
        JSON.stringify({ type: "inbox_received" }),
      ])
      .catch(() => {});
    return {
      handled: true,
      durable: true,
      handledEnqueued: event.eventType === "call.enqueued",
      classification,
    };
  } catch {
    return { retryable: true, httpStatus: 503 };
  }
}
