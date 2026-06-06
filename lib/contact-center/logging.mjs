import { createDiagnosticLogger } from "../diagnostic-logger.mjs";

const TOPICS = Object.freeze({
  routing: "contact-center.routing",
  timeout: "contact-center.timeout",
  reservations: "contact-center.reservations",
  status: "contact-center.status",
  queues: "contact-center.queues",
  interactions: "contact-center.interactions",
  wrapup: "contact-center.wrapup",
  transfer: "contact-center.transfer",
  consult: "contact-center.consult",
  supervision: "contact-center.supervision",
});

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null && entry !== ""),
  );
}

export function createContactCenterLogger(topic, bindings = {}, options = {}) {
  const base = createDiagnosticLogger(topic, options);
  const safeBindings = compactObject(bindings || {});

  function emit(level, eventName, fields = {}) {
    base[level](eventName, compactObject({ ...safeBindings, ...(fields || {}) }));
  }

  return {
    debug: (eventName, fields) => emit("debug", eventName, fields),
    info: (eventName, fields) => emit("info", eventName, fields),
    warn: (eventName, fields) => emit("warn", eventName, fields),
    error: (eventName, fields) => emit("error", eventName, fields),
  };
}

export const routingLogger = createDiagnosticLogger("contact-center.routing");
export const timeoutLogger = createDiagnosticLogger("contact-center.timeout");
export const reservationLogger = createDiagnosticLogger("contact-center.reservations");
export const statusLogger = createDiagnosticLogger("contact-center.status");

export function contactCenterErrorPayload(error) {
  if (!error) return {};
  return compactObject({
    errorName: error.name || "Error",
    errorMessage: error.message || String(error),
    errorCode: error.code,
    errorStatus: error.status || error.statusCode,
  });
}

export function callPayload({ interactionId, callControlId, callSessionId } = {}) {
  return compactObject({
    interactionId: interactionId ? String(interactionId) : undefined,
    callControlId: callControlId ? String(callControlId) : undefined,
    callSessionId: callSessionId ? String(callSessionId) : undefined,
  });
}

export function agentPayload({ agentUserId, agentUsername, extension } = {}) {
  return compactObject({
    agentUserId: agentUserId ? String(agentUserId) : undefined,
    agentUsername: agentUsername || undefined,
    extension: extension ? String(extension) : undefined,
  });
}

export function queuePayload({ queueId, queueName } = {}) {
  return compactObject({
    queueId: queueId ? String(queueId) : undefined,
    queueName: queueName || undefined,
  });
}

export function reasonPayload(reason) {
  return compactObject({ reason });
}

export { TOPICS as CONTACT_CENTER_LOGGING_TOPICS };
