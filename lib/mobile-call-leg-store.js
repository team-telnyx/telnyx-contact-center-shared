import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "./runtime-logging.mjs";
/**
 * Store for mapping WebRTC call legs to PSTN call legs for outbound calls
 * Maps: X-RTC-CALLID -> {callSessionId, webrtcCallControlId, pstnCallControlId}
 * Works for both web and mobile WebRTC clients
 */

// Use global to persist across hot reloads in development
if (!global.webrtcCallLegMapping) {
  global.webrtcCallLegMapping = new Map();
}
const webrtcCallLegMapping = global.webrtcCallLegMapping;

// Also maintain reverse lookup by call_session_id
if (!global.webrtcCallLegMappingBySession) {
  global.webrtcCallLegMappingBySession = new Map();
}
const webrtcCallLegMappingBySession = global.webrtcCallLegMappingBySession;

// Also maintain reverse lookup by WebRTC call_control_id
if (!global.webrtcCallLegMappingByCallControlId) {
  global.webrtcCallLegMappingByCallControlId = new Map();
}
const webrtcCallLegMappingByCallControlId =
  global.webrtcCallLegMappingByCallControlId;

/**
 * Store mapping between WebRTC leg and PSTN leg
 * @param {string} rtcCallId - X-RTC-CALLID header value
 * @param {object} data - {callSessionId, webrtcCallControlId, pstnCallControlId}
 */
export function storeWebrtcCallLegMapping(rtcCallId, data) {
  if (!rtcCallId) {
    voiceRuntimeLogger.warn("runtime_warning", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return;
  }

  const mapping = {
    rtcCallId,
    callSessionId: data.callSessionId || null,
    webrtcCallControlId: data.webrtcCallControlId || null,
    pstnCallControlId: data.pstnCallControlId || null,
    ...data,
  };

  webrtcCallLegMapping.set(rtcCallId, mapping);
  voiceRuntimeLogger.info("runtime_diagnostic", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });

  // Also store by call_session_id for reverse lookup
  if (data.callSessionId) {
    webrtcCallLegMappingBySession.set(data.callSessionId, mapping);
    voiceRuntimeLogger.info("runtime_diagnostic", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
  }

  // Also store by WebRTC call_control_id for reverse lookup (for frontend)
  if (mapping.webrtcCallControlId) {
    webrtcCallLegMappingByCallControlId.set(
      mapping.webrtcCallControlId,
      mapping
    );
    voiceRuntimeLogger.info("runtime_diagnostic", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
  }
}

/**
 * Get PSTN leg call_control_id by X-RTC-CALLID
 * @param {string} rtcCallId - X-RTC-CALLID header value
 * @returns {object|null} Mapping object or null
 */
export function getWebrtcCallLegMapping(rtcCallId) {
  if (!rtcCallId) {
    voiceRuntimeLogger.warn("runtime_warning", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return null;
  }
  const mapping = webrtcCallLegMapping.get(rtcCallId);
  if (mapping) {
    voiceRuntimeLogger.info("runtime_diagnostic", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
  } else {
    voiceRuntimeLogger.info("runtime_diagnostic", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
  }
  return mapping || null;
}

/**
 * Get mapping by call_session_id (for second leg webhook)
 * @param {string} callSessionId - call_session_id from webhook
 * @returns {object|null} Mapping object or null
 */
export function getWebrtcCallLegMappingBySessionId(callSessionId) {
  if (!callSessionId) {
    voiceRuntimeLogger.warn("runtime_warning", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return null;
  }
  const mapping = webrtcCallLegMappingBySession.get(callSessionId);
  if (mapping) {
    voiceRuntimeLogger.info("runtime_diagnostic", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
  } else {
    voiceRuntimeLogger.info("runtime_diagnostic", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
  }
  return mapping || null;
}

/**
 * Get mapping by WebRTC call_control_id (for frontend lookup)
 * @param {string} webrtcCallControlId - WebRTC leg's call_control_id
 * @returns {object|null} Mapping object or null
 */
export function getWebrtcCallLegMappingByCallControlId(webrtcCallControlId) {
  if (!webrtcCallControlId) {
    voiceRuntimeLogger.warn("runtime_warning", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return null;
  }
  const mapping = webrtcCallLegMappingByCallControlId.get(webrtcCallControlId);
  if (mapping) {
    voiceRuntimeLogger.info("runtime_diagnostic", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
  } else {
    voiceRuntimeLogger.info("runtime_diagnostic", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
  }
  return mapping || null;
}

/**
 * Clean up mapping when call ends
 * @param {string} rtcCallId - X-RTC-CALLID header value
 */
export function removeWebrtcCallLegMapping(rtcCallId) {
  if (!rtcCallId) return;
  const mapping = webrtcCallLegMapping.get(rtcCallId);
  if (mapping?.callSessionId) {
    webrtcCallLegMappingBySession.delete(mapping.callSessionId);
  }
  if (mapping?.webrtcCallControlId) {
    webrtcCallLegMappingByCallControlId.delete(mapping.webrtcCallControlId);
  }
  webrtcCallLegMapping.delete(rtcCallId);
  voiceRuntimeLogger.info("runtime_diagnostic", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
}

// Legacy function names for backward compatibility
export const storeMobileCallLegMapping = storeWebrtcCallLegMapping;
export const getMobileCallLegMapping = getWebrtcCallLegMapping;
export const getMobileCallLegMappingBySessionId =
  getWebrtcCallLegMappingBySessionId;
export const removeMobileCallLegMapping = removeWebrtcCallLegMapping;
