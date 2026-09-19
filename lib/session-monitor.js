"use client";

/**
 * Keep the browser logout coordination hook without projecting routing state
 * from page visibility or network events. The authenticated WebRTC heartbeat
 * is the sole source of voice readiness in acd_agent_sessions.
 */
export function setupSessionMonitor() {
  if (typeof window === "undefined") return () => {};
  window.__markLoggingOut = () => {
    window.__isLoggingOut = true;
  };
  return () => {
    delete window.__markLoggingOut;
  };
}
