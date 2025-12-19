/**
 * Global store for incoming call information from SSE
 * This allows softphone components to access caller name/number
 * that was already fetched in the webhook handler
 */

let incomingCallData = new Map(); // Map<callControlId, {fromNumber, fromName, callControlId}>

/**
 * Store incoming call data from SSE
 */
export function storeIncomingCallData(callControlId, data) {
  if (callControlId && data) {
    incomingCallData.set(callControlId, {
      callControlId,
      fromNumber: data.fromNumber || data.from_number,
      fromName: data.fromName || data.from_name,
      ...data,
    });
    console.log("[IncomingCallStore] Stored call data:", {
      callControlId,
      ...data,
    });
  }
}

/**
 * Get incoming call data by callControlId
 */
export function getIncomingCallData(callControlId) {
  if (!callControlId) return null;
  return incomingCallData.get(callControlId) || null;
}

/**
 * Normalize phone number for comparison (remove spaces, dashes, etc., but keep +)
 */
function normalizePhone(phone) {
  if (!phone) return null;
  return String(phone)
    .replace(/[^\d+]/g, "")
    .replace(/^(\d{10,})$/, "+$1"); // Add + if it's a long number without +
}

/**
 * Get incoming call data by phone number (fallback)
 */
export function getIncomingCallDataByPhone(phoneNumber) {
  if (!phoneNumber) return null;
  const normalized = normalizePhone(phoneNumber);
  if (!normalized) return null;

  for (const [_, data] of incomingCallData.entries()) {
    const dataNumber = data.fromNumber || data.from_number;
    if (!dataNumber) continue;
    const normalizedData = normalizePhone(dataNumber);
    if (normalizedData === normalized) {
      return data;
    }
  }
  return null;
}

/**
 * Clear incoming call data
 */
export function clearIncomingCallData(callControlId) {
  if (callControlId) {
    incomingCallData.delete(callControlId);
  }
}

/**
 * Clear all incoming call data (cleanup)
 */
export function clearAllIncomingCallData() {
  incomingCallData.clear();
}
