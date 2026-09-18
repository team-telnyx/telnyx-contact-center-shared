export const SHARED_AGENT_CONNECTION_ID = "1000000000000000000";

export const DIRECT_AGENT_USERS = Object.freeze([
  Object.freeze({
    id: "agent-a",
    username: "agent.a",
    telephony_user_name: "acd-agent-a",
    telephony_credentials_id: "credential-a-not-a-connection",
    voice_number: "+48221110001",
    mobile: "+48600000003",
  }),
  Object.freeze({
    id: "agent-b",
    username: "agent.b",
    telephony_user_name: "acd-agent-b",
    telephony_credentials_id: "credential-b-not-a-connection",
    voice_number: "+48221110002",
    mobile: "+48600111002",
  }),
]);

export const ACD_ADMISSION_FIXTURES = Object.freeze([
  Object.freeze({
    name: "known Core customer leg",
    event: {
      eventType: "call.hangup",
      payload: { call_control_id: "v3:known-customer" },
    },
    evidence: { knownCoreLeg: true },
    expected: { decision: "admit_core", eventClass: "known_core_event" },
  }),
  Object.freeze({
    name: "configured CC queue enqueue",
    event: {
      eventType: "call.enqueued",
      payload: { queue: "ACD Voice E2E" },
    },
    evidence: { configuredCcQueue: true },
    expected: { decision: "admit_core", eventClass: "queue_enqueue" },
  }),
  Object.freeze({
    name: "journaled outbound customer leg",
    event: {
      eventType: "call.initiated",
      payload: { direction: "outgoing", to: "+48600000001" },
    },
    evidence: { journaledOutboundCommand: true },
    expected: { decision: "admit_core", eventClass: "outbound_leg" },
  }),
  Object.freeze({
    name: "reserved agent leg",
    event: {
      eventType: "call.initiated",
      payload: { direction: "incoming", to: "sip:acd-agent-a@sip.telnyx.com" },
    },
    evidence: { boundLegIntent: true },
    expected: { decision: "admit_core", eventClass: "reserved_agent_leg" },
  }),
  Object.freeze({
    name: "voice flow domain event",
    event: {
      eventType: "call.initiated",
      payload: { direction: "incoming", to: "+48700000001" },
    },
    evidence: { nonCcDomain: "voice_flow" },
    expected: { decision: "pass_domain", eventClass: "non_cc_domain" },
  }),
  Object.freeze({
    name: "Core correlation wins over media pass-through",
    event: {
      eventType: "streaming.started",
      payload: { call_control_id: "v3:known-agent" },
    },
    evidence: { knownCoreLeg: true, nonCcDomain: "media" },
    expected: { decision: "admit_core", eventClass: "known_core_event" },
  }),
  Object.freeze({
    name: "unmatched explicit Core header",
    event: {
      eventType: "call.initiated",
      payload: { direction: "incoming" },
    },
    evidence: { coreScopedHint: true },
    expected: { decision: "unmatched_core", eventClass: "unmatched_core_event" },
  }),
  Object.freeze({
    name: "unrelated voice event",
    event: { eventType: "call.cost", payload: {} },
    evidence: {},
    expected: { decision: "pass_domain", eventClass: "other_voice_event" },
  }),
]);
