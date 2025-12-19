/**
 * Shared utility functions for formatting and displaying call statuses
 * Used across floating phone, contact center interactions, and other components
 */

/**
 * Maps WebRTC SDK status to user-friendly display text
 * @param {string} status - Raw status from WebRTC SDK
 * @param {boolean} hasCall - Whether there's an active call object
 * @returns {string} - User-friendly status text (proper case)
 */
export function formatCallStatus(status, hasCall = true) {
  // If no status and no call, show Idle immediately
  if (!status && !hasCall) return "Idle";
  if (!status) return "Idle";

  const s = String(status).toLowerCase();

  // Map statuses to display text with requested names:
  // - Dialing, Ringing, Connected, On Hold, Idle
  // Based on Telnyx WebRTC SDK states

  // End states should immediately show Idle
  if (
    ["hangup", "ended", "destroy", "purge", "idle", "terminated"].includes(s)
  ) {
    return "Idle";
  }

  // Dialing states (outbound call setup)
  if (["dialing", "requesting", "trying", "new"].includes(s)) {
    return "Dialing";
  }

  // Ringing states (inbound call or outbound ringing)
  if (["ringing", "early", "initiated", "answering"].includes(s)) {
    return "Ringing";
  }

  // Connected states (call is active)
  if (["active", "answered", "connected"].includes(s)) {
    return "Connected";
  }

  // On Hold states
  if (["held", "hold"].includes(s)) {
    return "On Hold";
  }

  // Other states
  if (["busy"].includes(s)) {
    return "Busy";
  }
  if (["connecting", "bridging", "recovering"].includes(s)) {
    return "Connecting";
  }
  if (s === "parked") {
    return "Parked";
  }

  // Default: return proper case version of status
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Gets status badge color classes with background (matching floating phone design)
 * @param {string} status - Raw status from WebRTC SDK
 * @returns {string} - Tailwind CSS classes for text, border, and background color
 */
export function getStatusBadgeColor(status) {
  if (!status) return "border-emerald-600 bg-emerald-600/20 text-emerald-400";

  const s = String(status).toLowerCase();

  // Dialing/Connecting states - Yellow
  if (
    [
      "dialing",
      "requesting",
      "trying",
      "new",
      "connecting",
      "bridging",
      "initiated",
      "recovering",
    ].includes(s)
  ) {
    return "border-yellow-600 bg-yellow-600/20 text-yellow-400";
  }

  // Ringing states - Yellow
  if (["ringing", "early", "answering"].includes(s)) {
    return "border-yellow-600 bg-yellow-600/20 text-yellow-400";
  }

  // Connected states - Green
  if (["active", "answered", "connected"].includes(s)) {
    return "border-green-600 bg-green-600/20 text-green-400";
  }

  // On Hold states - Orange
  if (["held", "hold"].includes(s)) {
    return "border-orange-600 bg-orange-600/20 text-orange-400";
  }

  // Busy states - Red
  if (["busy"].includes(s)) {
    return "border-red-600 bg-red-600/20 text-red-400";
  }

  // Idle/Ready states - Emerald
  if (
    ["hangup", "ended", "destroy", "purge", "idle", "terminated"].includes(s)
  ) {
    return "border-emerald-600 bg-emerald-600/20 text-emerald-400";
  }

  // Parked - Yellow
  if (s === "parked") {
    return "border-yellow-600 bg-yellow-600/20 text-yellow-400";
  }

  // Default fallback - Gray
  return "border-zinc-700 bg-zinc-900/60 text-zinc-400";
}

/**
 * Gets complete status display object (text + color)
 * @param {string} status - Raw status from WebRTC SDK
 * @param {boolean} hasCall - Whether there's an active call object
 * @returns {{text: string, color: string}} - Display text and color classes
 */
export function getStatusDisplay(status, hasCall = true) {
  return {
    text: formatCallStatus(status, hasCall),
    color: getStatusBadgeColor(status),
  };
}
