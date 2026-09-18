export const VOICE_OCCUPANCY_KINDS = Object.freeze({
  QUEUE: "queue",
  CAMPAIGN: "campaign",
  MANUAL_OUTBOUND: "manual_outbound",
  SUPERVISION: "supervision",
  DIRECT_INBOUND: "direct_inbound",
  BLIND_TRANSFER_TARGET: "blind_transfer_target",
  CONSULT_TARGET: "consult_target",
});

export const VOICE_OCCUPANCY_POLICY = Object.freeze({
  [VOICE_OCCUPANCY_KINDS.QUEUE]: Object.freeze({
    direction: "inbound",
    queueLess: false,
  }),
  [VOICE_OCCUPANCY_KINDS.CAMPAIGN]: Object.freeze({
    direction: "outbound",
    queueLess: false,
  }),
  [VOICE_OCCUPANCY_KINDS.MANUAL_OUTBOUND]: Object.freeze({
    direction: "outbound",
    queueLess: true,
  }),
  [VOICE_OCCUPANCY_KINDS.SUPERVISION]: Object.freeze({
    direction: "internal",
    queueLess: true,
  }),
  [VOICE_OCCUPANCY_KINDS.DIRECT_INBOUND]: Object.freeze({
    direction: "inbound",
    queueLess: true,
  }),
  [VOICE_OCCUPANCY_KINDS.BLIND_TRANSFER_TARGET]: Object.freeze({
    direction: "internal",
    queueLess: false,
  }),
  [VOICE_OCCUPANCY_KINDS.CONSULT_TARGET]: Object.freeze({
    direction: "internal",
    queueLess: false,
  }),
});

export function sipUser(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^(?:sip:)?([^@;>]+)@/i);
  let username = match?.[1] || null;
  // Telnyx WebRTC device-leg webhooks may carry only the credential username
  // in `to`, while the originating API request uses a full SIP URI. Treat a
  // bare non-phone token as the same SIP identity. An all-numeric value stays
  // in the E.164 path below.
  if (!username && !raw.includes("@")) {
    const bare = raw.replace(/^sip:/i, "").split(/[;>]/, 1)[0].trim();
    if (bare && /[a-z]/i.test(bare) && !/[\s<>]/.test(bare)) username = bare;
  }
  if (!username) return null;
  try {
    return decodeURIComponent(username).toLowerCase();
  } catch {
    return username.toLowerCase();
  }
}

export function normalizedPhone(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.includes("@")) return null;
  const candidate = raw.replace(/^tel:/i, "").split(";", 1)[0].trim();
  // Do not manufacture a phone number from digits embedded in an alphanumeric
  // WebRTC credential username.
  if (!/^\+?[0-9().\s-]+$/.test(candidate)) return null;
  const digits = candidate.replace(/\D/g, "");
  return digits.length >= 7 ? digits : null;
}

export function voiceAddressMatches(left, right) {
  const leftSip = sipUser(left);
  const rightSip = sipUser(right);
  if (leftSip || rightSip) return Boolean(leftSip && rightSip && leftSip === rightSip);
  const leftPhone = normalizedPhone(left);
  const rightPhone = normalizedPhone(right);
  return Boolean(leftPhone && rightPhone && leftPhone === rightPhone);
}

function uniqueAgents(rows) {
  return [
    ...new Map(
      rows
        .filter((row) => row?.id)
        .map((row) => [String(row.id), row]),
    ).values(),
  ];
}

/**
 * Resolve an unsolicited direct-agent destination. connectionId may reject an
 * event from an unrelated provider connection, but it never selects a user:
 * Telnyx credential connections are shared by multiple agent credentials.
 */
export function resolveDirectAgentAddress(
  users,
  destination,
  { connectionId = null, allowedCredentialConnectionIds = [] } = {},
) {
  if (!Array.isArray(users)) throw new TypeError("users must be an array");
  if (
    allowedCredentialConnectionIds.length > 0 &&
    !allowedCredentialConnectionIds.map(String).includes(String(connectionId))
  ) {
    return { status: "outside_connection", agent: null, matchedBy: null };
  }

  const targetSipUser = sipUser(destination);
  const targetPhone = normalizedPhone(destination);
  let matchedBy = null;
  let matches = [];
  if (targetSipUser) {
    matchedBy = "sip_user";
    matches = users.filter((user) =>
      [user.telephony_user_name, user.username]
        .filter(Boolean)
        .some((value) => String(value).trim().toLowerCase() === targetSipUser),
    );
  } else if (targetPhone) {
    matchedBy = "e164";
    matches = users.filter((user) =>
      [user.voice_number, user.mobile]
        .map(normalizedPhone)
        .filter(Boolean)
        .includes(targetPhone),
    );
  }

  const distinct = uniqueAgents(matches);
  if (distinct.length === 1) {
    return { status: "matched", agent: distinct[0], matchedBy };
  }
  if (distinct.length > 1) {
    return {
      status: "ambiguous",
      agent: null,
      matchedBy,
      agentIds: distinct.map((agent) => String(agent.id)).sort(),
    };
  }
  return { status: "unmatched", agent: null, matchedBy };
}

export function buildQueueLessVoiceWorkItem({
  kind,
  customerAddress,
  contactCenterAddress,
  attributes = {},
} = {}) {
  const policy = VOICE_OCCUPANCY_POLICY[kind];
  if (!policy?.queueLess) {
    throw new TypeError(`${kind || "unknown"} is not a queue-less voice kind`);
  }
  if (!customerAddress || !contactCenterAddress) {
    throw new TypeError("Both customer and contact-center addresses are required");
  }
  return {
    channel: "voice",
    direction: policy.direction,
    queueId: null,
    customerAddress: String(customerAddress),
    ccAddress: String(contactCenterAddress),
    attributes: {
      ...attributes,
      voice_occupancy_kind: kind,
    },
  };
}

export function assertExclusiveVoiceOccupancy({
  kind,
  agentId,
  workItem,
  reservation,
} = {}) {
  const policy = VOICE_OCCUPANCY_POLICY[kind];
  if (!policy) throw new TypeError(`Unsupported voice occupancy kind: ${kind}`);
  if (!workItem?.id || workItem.channel !== "voice") {
    throw new TypeError("Voice occupancy requires a Core voice work item");
  }
  if (policy.queueLess && workItem.queue_id != null) {
    throw new TypeError("Direct/manual work items must not have a queue");
  }
  if (
    !reservation ||
    String(reservation.agent_id) !== String(agentId) ||
    String(reservation.work_item_id) !== String(workItem.id) ||
    reservation.channel !== "voice" ||
    Number(reservation.weight) !== 1 ||
    reservation.state === "released"
  ) {
    throw new TypeError(
      "Voice occupancy requires one live weight-1 reservation for the agent and work item",
    );
  }
  return true;
}
