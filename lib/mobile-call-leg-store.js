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
    console.warn(
      "[WebrtcCallLegStore] Cannot store mapping: rtcCallId is missing"
    );
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
  console.log("[WebrtcCallLegStore] ✅ Stored mapping by X-RTC-CALLID:", {
    rtcCallId,
    callSessionId: mapping.callSessionId,
    webrtcCallControlId: mapping.webrtcCallControlId,
    pstnCallControlId: mapping.pstnCallControlId,
  });

  // Also store by call_session_id for reverse lookup
  if (data.callSessionId) {
    webrtcCallLegMappingBySession.set(data.callSessionId, mapping);
    console.log(
      "[WebrtcCallLegStore] ✅ Stored mapping by call_session_id:",
      data.callSessionId
    );
  }

  // Also store by WebRTC call_control_id for reverse lookup (for frontend)
  if (mapping.webrtcCallControlId) {
    webrtcCallLegMappingByCallControlId.set(
      mapping.webrtcCallControlId,
      mapping
    );
    console.log(
      "[WebrtcCallLegStore] ✅ Stored mapping by WebRTC call_control_id:",
      mapping.webrtcCallControlId
    );
  }
}

/**
 * Get PSTN leg call_control_id by X-RTC-CALLID
 * @param {string} rtcCallId - X-RTC-CALLID header value
 * @returns {object|null} Mapping object or null
 */
export function getWebrtcCallLegMapping(rtcCallId) {
  if (!rtcCallId) {
    console.warn(
      "[WebrtcCallLegStore] Cannot get mapping: rtcCallId is missing"
    );
    return null;
  }
  const mapping = webrtcCallLegMapping.get(rtcCallId);
  if (mapping) {
    console.log("[WebrtcCallLegStore] ✅ Found mapping by X-RTC-CALLID:", {
      rtcCallId,
      pstnCallControlId: mapping.pstnCallControlId,
      webrtcCallControlId: mapping.webrtcCallControlId,
    });
  } else {
    console.log(
      "[WebrtcCallLegStore] ⚠️ No mapping found for X-RTC-CALLID:",
      rtcCallId
    );
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
    console.warn(
      "[WebrtcCallLegStore] Cannot get mapping: callSessionId is missing"
    );
    return null;
  }
  const mapping = webrtcCallLegMappingBySession.get(callSessionId);
  if (mapping) {
    console.log("[WebrtcCallLegStore] ✅ Found mapping by call_session_id:", {
      callSessionId,
      rtcCallId: mapping.rtcCallId,
      webrtcCallControlId: mapping.webrtcCallControlId,
    });
  } else {
    console.log(
      "[WebrtcCallLegStore] ⚠️ No mapping found for call_session_id:",
      callSessionId
    );
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
    console.warn(
      "[WebrtcCallLegStore] Cannot get mapping: webrtcCallControlId is missing"
    );
    return null;
  }
  const mapping = webrtcCallLegMappingByCallControlId.get(webrtcCallControlId);
  if (mapping) {
    console.log(
      "[WebrtcCallLegStore] ✅ Found mapping by WebRTC call_control_id:",
      {
        webrtcCallControlId,
        pstnCallControlId: mapping.pstnCallControlId,
        rtcCallId: mapping.rtcCallId,
      }
    );
  } else {
    console.log(
      "[WebrtcCallLegStore] ⚠️ No mapping found for WebRTC call_control_id:",
      webrtcCallControlId
    );
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
  console.log(
    "[WebrtcCallLegStore] 🗑️ Removed mapping for X-RTC-CALLID:",
    rtcCallId
  );
}

// Legacy function names for backward compatibility
export const storeMobileCallLegMapping = storeWebrtcCallLegMapping;
export const getMobileCallLegMapping = getWebrtcCallLegMapping;
export const getMobileCallLegMappingBySessionId =
  getWebrtcCallLegMappingBySessionId;
export const removeMobileCallLegMapping = removeWebrtcCallLegMapping;
