export const WEBRTC_DIAL_FAILURE_STATES = Object.freeze([
  "busy",
  "failed",
  "rejected",
  "declined",
  "unavailable",
  "no_answer",
  "timeout",
  "request_timeout",
  "cancelled",
  "canceled",
  "error",
]);

const FAILURE_STATES = new Set(WEBRTC_DIAL_FAILURE_STATES);
const handledCalls = new WeakSet();
const connectedCalls = new WeakSet();

const CONNECTED_STATES = new Set(["active", "connected", "answered"]);
const DIALING_STATES = new Set([
  "new",
  "trying",
  "requesting",
  "early",
  "ringing",
  "connecting",
]);

export function markWebrtcCallConnected(call) {
  if (call && (typeof call === "object" || typeof call === "function")) {
    connectedCalls.add(call);
  }
}

export function claimWebrtcDialFailure(call) {
  if (!call || (typeof call !== "object" && typeof call !== "function")) return false;
  if (handledCalls.has(call)) return false;
  handledCalls.add(call);
  return true;
}

export function shouldHandleWebrtcDialFailure({
  call,
  state,
  direction,
  currentStatus,
} = {}) {
  if (!isWebrtcDialFailureState(state) || !call || connectedCalls.has(call)) return false;
  const effectiveDirection = String(
    direction || call?.direction || call?.options?.direction || "",
  ).trim().toLowerCase();
  const status = String(currentStatus || "").trim().toLowerCase();
  if (CONNECTED_STATES.has(status)) return false;
  if (status && !DIALING_STATES.has(status)) return false;
  return (
    ["outbound", "outgoing"].includes(effectiveDirection) ||
    Boolean(directIntentIdFromCall(call))
  );
}

export function isWebrtcDialFailureState(state) {
  return FAILURE_STATES.has(String(state || "").trim().toLowerCase());
}

export function describeWebrtcDialFailure(state) {
  const normalized = String(state || "").trim().toLowerCase();
  if (normalized === "busy") return "The destination is busy or rejected the call.";
  if (["no_answer", "timeout", "request_timeout"].includes(normalized)) {
    return "The call could not be connected before it timed out.";
  }
  if (["rejected", "declined"].includes(normalized)) {
    return "The call was rejected.";
  }
  if (normalized === "unavailable") return "The destination is unavailable.";
  return "The call could not be connected.";
}

export function directIntentIdFromCall(call) {
  const groups = [
    call?.options?.customHeaders,
    call?.inviteCustomHeaders,
    call?.invite?.customHeaders,
    call?.customHeaders,
  ].filter(Array.isArray);
  for (const header of groups.flat()) {
    if (String(header?.name || "").toLowerCase() === "x-cc-direct-intent-id") {
      return String(header?.value || "").trim() || null;
    }
  }
  return null;
}

export async function cancelUnstartedWebrtcIntent(intentId) {
  if (!intentId) return false;
  try {
    const response = await fetch(`/api/voice/direct-intent?id=${encodeURIComponent(intentId)}`, {
      method: "DELETE",
    });
    return response.ok;
  } catch {
    return false;
  }
}
