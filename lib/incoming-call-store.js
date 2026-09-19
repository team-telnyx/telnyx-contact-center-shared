/**
 * Global store for incoming call information from SSE
 * This allows softphone components to access caller name/number
 * that was already fetched in the webhook handler
 */

let incomingCallData = new Map(); // Map<alias, {fromNumber, fromName, callControlId}>

// This store is only a short-lived bridge between the server event and the
// WebRTC SDK notification. Keeping identity records indefinitely is unsafe:
// test callers commonly dial repeatedly from the same number.
const INCOMING_CALL_DATA_TTL_MS = 2 * 60 * 1000;

function storedAt(data) {
  const value = Number(data?.timestamp || data?.storedAt || 0);
  return Number.isFinite(value) ? value : 0;
}

function isFresh(data, now = Date.now()) {
  const timestamp = storedAt(data);
  return timestamp > 0 && now - timestamp <= INCOMING_CALL_DATA_TTL_MS;
}

function pruneExpired(now = Date.now()) {
  for (const [key, data] of incomingCallData.entries()) {
    if (!isFresh(data, now)) incomingCallData.delete(key);
  }
}

/**
 * Store incoming call data from SSE
 */
export function storeIncomingCallData(callControlId, data) {
  if (callControlId && data) {
    const timestamp = storedAt(data) || Date.now();
    incomingCallData.set(callControlId, {
      callControlId,
      fromNumber: data.fromNumber || data.from_number,
      fromName: data.fromName || data.from_name,
      ...data,
      timestamp,
    });
    pruneExpired(timestamp);
  }
}

/**
 * Get incoming call data by callControlId
 */
export function getIncomingCallData(callControlId) {
  if (!callControlId) return null;
  const data = incomingCallData.get(callControlId) || null;
  if (!data) return null;
  if (!isFresh(data)) {
    incomingCallData.delete(callControlId);
    return null;
  }
  return data;
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

  const now = Date.now();
  let newest = null;
  for (const [key, data] of incomingCallData.entries()) {
    if (!isFresh(data, now)) {
      incomingCallData.delete(key);
      continue;
    }
    const dataNumber = data.fromNumber || data.from_number;
    if (!dataNumber) continue;
    const normalizedData = normalizePhone(dataNumber);
    if (normalizedData === normalized) {
      if (!newest || storedAt(data) > storedAt(newest)) newest = data;
    }
  }
  return newest;
}

/**
 * Clear incoming call data
 */
export function clearIncomingCallData(callControlId) {
  if (!callControlId) return;
  for (const [key, data] of incomingCallData.entries()) {
    const aliases = [
      key,
      data?.callControlId,
      data?.originalCallControlId,
      data?.callSessionId,
      data?.interactionId,
    ];
    if (aliases.some((alias) => alias && String(alias) === String(callControlId))) {
      incomingCallData.delete(key);
    }
  }
}

/**
 * Clear all incoming call data (cleanup)
 */
export function clearAllIncomingCallData() {
  incomingCallData.clear();
}
