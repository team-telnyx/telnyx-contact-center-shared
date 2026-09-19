export const ACD_INTAKE_STATE_VERSION = 1;
export const ACD_INTAKE_STATE_KEY = "acd_intake";
export const MAX_ACD_CLIENT_STATE_BYTES = 64 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

export function decodeAcdClientState(value) {
  if (!value) return {};
  if (plainObject(value) === value) return { ...value };
  if (typeof value !== "string" || value.length > MAX_ACD_CLIENT_STATE_BYTES * 2) {
    return {};
  }
  try {
    const decoded = Buffer.from(value, "base64").toString("utf8");
    if (Buffer.byteLength(decoded) > MAX_ACD_CLIENT_STATE_BYTES) return {};
    return { ...plainObject(JSON.parse(decoded)) };
  } catch {
    return {};
  }
}

export function encodeAcdClientState(value) {
  const serialized = JSON.stringify(plainObject(value));
  if (Buffer.byteLength(serialized) > MAX_ACD_CLIENT_STATE_BYTES) {
    throw new RangeError("ACD client state exceeds the supported size");
  }
  return Buffer.from(serialized).toString("base64");
}

function validGeneratorIdentity(identity, flowId) {
  if (!identity || typeof identity !== "object") return null;
  if (
    !UUID.test(String(identity.runId || "")) ||
    !UUID.test(String(identity.ledgerId || "")) ||
    !UUID.test(String(identity.flowId || "")) ||
    String(identity.flowId) !== String(flowId)
  ) {
    return null;
  }
  return {
    verified: true,
    runId: String(identity.runId),
    ledgerId: String(identity.ledgerId),
    flowId: String(identity.flowId),
    ...(identity.directAgentId && UUID.test(String(identity.directAgentId))
      ? { directAgentId: String(identity.directAgentId) }
      : {}),
  };
}

/**
 * Merge a flow update without allowing ordinary node configuration to replace
 * immutable Core correlation, original addressing or verified generator data.
 */
export function mergeAcdClientState(current, update) {
  const previous = decodeAcdClientState(current);
  const patch = decodeAcdClientState(update);
  const immutable = plainObject(previous[ACD_INTAKE_STATE_KEY]);
  const proposed = plainObject(patch[ACD_INTAKE_STATE_KEY]);
  const merged = {
    ...previous,
    ...patch,
  };
  const intake = Object.keys(immutable).length > 0 ? immutable : proposed;
  if (Object.keys(intake).length > 0) {
    merged[ACD_INTAKE_STATE_KEY] = intake;
  } else {
    delete merged[ACD_INTAKE_STATE_KEY];
  }
  return merged;
}

/**
 * Materialize the complete Core intake source at verified initial ingress.
 * generatorIdentity must come from parse/bindGeneratedInbound; an arbitrary
 * callGenerator flag inside client_state is never promoted to verified data.
 */
export function materializeAcdIntakeState({
  clientState = null,
  payload = {},
  flowId = null,
  generatorIdentity = null,
  workItem = null,
} = {}) {
  const state = decodeAcdClientState(clientState || payload.client_state);
  const verifiedGenerator = validGeneratorIdentity(generatorIdentity, flowId);
  const originalCustomerAddress =
    workItem?.customer_address ||
    payload.from ||
    null;
  const originalContactCenterAddress =
    workItem?.cc_address ||
    payload.to ||
    null;

  return {
    ...state,
    [ACD_INTAKE_STATE_KEY]: {
      version: ACD_INTAKE_STATE_VERSION,
      source: "telnyx_voice_flow",
      flowId: flowId || null,
      workItemId: workItem?.id || null,
      providerSessionId:
        workItem?.provider_session_id ||
        payload.call_session_id ||
        null,
      originalCustomerAddress,
      originalContactCenterAddress,
      ...(verifiedGenerator ? { generator: verifiedGenerator } : {}),
    },
  };
}

/** Bind the server-created Core work item without reopening immutable flow data. */
export function bindAcdIntakeWorkItem(value, workItem) {
  const state = decodeAcdClientState(value);
  const source = plainObject(state[ACD_INTAKE_STATE_KEY]);
  if (source.version !== ACD_INTAKE_STATE_VERSION || !workItem?.id) {
    throw new Error("A materialized ACD intake state and work item are required");
  }
  return {
    ...state,
    [ACD_INTAKE_STATE_KEY]: {
      ...source,
      workItemId: String(workItem.id),
      providerSessionId:
        source.providerSessionId || workItem.provider_session_id || null,
      originalCustomerAddress:
        source.originalCustomerAddress || workItem.customer_address || null,
      originalContactCenterAddress:
        source.originalContactCenterAddress || workItem.cc_address || null,
    },
  };
}

export function extractAcdIntakeContext(value) {
  const state = decodeAcdClientState(value);
  const source = plainObject(state[ACD_INTAKE_STATE_KEY]);
  if (source.version !== ACD_INTAKE_STATE_VERSION) return null;
  const priority = Number(state.call_priority);
  const callerLanguage = state.caller_language || null;
  const agentLanguage = state.agent_language || null;
  const languages = Array.isArray(state.languages)
    ? [...state.languages]
    : [callerLanguage, agentLanguage].filter(Boolean);
  return {
    source,
    routing: {
      queueName: state.queue_name || null,
      priority: Number.isFinite(priority) ? priority : 0,
      requiredSkills: plainObject(state.required_skills),
    },
    agentAssistConfig: plainObject(state.agent_assist_config),
    transcriptionConfig: plainObject(state.telnyx_stt_config),
    workflowData: plainObject(state.workflow_data),
    aiCallControlId: state.ai_call_control_id || null,
    callerLanguage,
    agentLanguage,
    languages,
    clientState: state,
  };
}
