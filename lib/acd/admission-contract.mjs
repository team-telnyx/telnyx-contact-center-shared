export const ACD_ADMISSION_DECISIONS = Object.freeze({
  ADMIT_CORE: "admit_core",
  PASS_DOMAIN: "pass_domain",
  UNMATCHED_CORE: "unmatched_core",
});

export const ACD_ADMISSION_CLASSES = Object.freeze({
  KNOWN_CORE_EVENT: "known_core_event",
  QUEUE_ENQUEUE: "queue_enqueue",
  OUTBOUND_LEG: "outbound_leg",
  RESERVED_AGENT_LEG: "reserved_agent_leg",
  DIRECT_AGENT_LEG: "direct_agent_leg",
  NON_CC_DOMAIN: "non_cc_domain",
  UNMATCHED_CORE_EVENT: "unmatched_core_event",
  OTHER_VOICE_EVENT: "other_voice_event",
});

function result(decision, eventClass, reason, extra = {}) {
  return {
    decision,
    eventClass,
    reason,
    requiresDurableAdmission:
      decision !== ACD_ADMISSION_DECISIONS.PASS_DOMAIN,
    observableFailure:
      decision === ACD_ADMISSION_DECISIONS.UNMATCHED_CORE,
    ...extra,
  };
}

/**
 * Pure precedence contract for Telnyx voice admission. Database and signature
 * checks happen in adapters and are passed as evidence. Core evidence always
 * wins over a generic domain pass so direct agent legs cannot bypass capacity.
 */
export function classifyAcdVoiceAdmission(event, evidence = {}) {
  const eventType = event?.eventType || event?.event_type || null;
  const payload = event?.payload || {};

  if (
    evidence.inboxPersisted ||
    evidence.knownCoreLeg ||
    evidence.knownCoreSession ||
    evidence.knownDirectIntent
  ) {
    return result(
      ACD_ADMISSION_DECISIONS.ADMIT_CORE,
      ACD_ADMISSION_CLASSES.KNOWN_CORE_EVENT,
      "durable_core_correlation",
    );
  }

  if (eventType === "call.enqueued" && evidence.configuredCcQueue) {
    return result(
      ACD_ADMISSION_DECISIONS.ADMIT_CORE,
      ACD_ADMISSION_CLASSES.QUEUE_ENQUEUE,
      "configured_cc_queue",
    );
  }

  if (evidence.journaledOutboundCommand) {
    return result(
      ACD_ADMISSION_DECISIONS.ADMIT_CORE,
      ACD_ADMISSION_CLASSES.OUTBOUND_LEG,
      "journaled_outbound_command",
    );
  }

  if (evidence.boundLegIntent || evidence.liveReservationEvidence) {
    return result(
      ACD_ADMISSION_DECISIONS.ADMIT_CORE,
      ACD_ADMISSION_CLASSES.RESERVED_AGENT_LEG,
      "reserved_agent_leg",
    );
  }

  if (
    eventType === "call.initiated" &&
    ["incoming", "inbound"].includes(String(payload.direction || "").toLowerCase()) &&
    evidence.directAgentResolution?.status === "matched"
  ) {
    return result(
      ACD_ADMISSION_DECISIONS.ADMIT_CORE,
      ACD_ADMISSION_CLASSES.DIRECT_AGENT_LEG,
      "direct_agent_destination",
      { agentId: String(evidence.directAgentResolution.agent.id) },
    );
  }

  if (
    evidence.coreScopedHint ||
    evidence.recognizedAgentCredentialConnection ||
    evidence.directAgentResolution?.status === "ambiguous"
  ) {
    return result(
      ACD_ADMISSION_DECISIONS.UNMATCHED_CORE,
      ACD_ADMISSION_CLASSES.UNMATCHED_CORE_EVENT,
      evidence.directAgentResolution?.status === "ambiguous"
        ? "ambiguous_direct_agent_destination"
        : "core_evidence_not_correlated",
    );
  }

  if (evidence.nonCcDomain) {
    return result(
      ACD_ADMISSION_DECISIONS.PASS_DOMAIN,
      ACD_ADMISSION_CLASSES.NON_CC_DOMAIN,
      String(evidence.nonCcDomain),
    );
  }

  return result(
    ACD_ADMISSION_DECISIONS.PASS_DOMAIN,
    ACD_ADMISSION_CLASSES.OTHER_VOICE_EVENT,
    "not_core_scoped",
  );
}
