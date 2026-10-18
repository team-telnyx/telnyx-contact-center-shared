"use client";
/**
 * The Contact Center's agent stream, as the handoff reads it: ContactCenterStreamProvider
 * raises window events for every ACD change (`contact-center:acd-state`) and for the
 * interactions list (`contact-center:refresh-interactions`); a handoff's progress is an
 * ACD change, so both are the cue to read again.
 */
export function subscribeAgentStream(listener) {
  if (typeof window === "undefined") return () => {};
  const onState = () => listener({ type: "device_handoff_changed", interactionId: null });
  const onRefresh = () => listener({ type: "voice_endpoints_changed" });
  window.addEventListener("contact-center:acd-state", onState);
  window.addEventListener("contact-center:refresh-interactions", onRefresh);
  return () => { window.removeEventListener("contact-center:acd-state", onState); window.removeEventListener("contact-center:refresh-interactions", onRefresh); };
}
