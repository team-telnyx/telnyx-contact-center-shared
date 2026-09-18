const VALID_TRANSCRIPTION_TRACKS = new Set(["inbound", "outbound", "both"]);

export function normalizeTelnyxSttTracks(value) {
  return VALID_TRANSCRIPTION_TRACKS.has(value) ? value : "both";
}

/**
 * The call-flow stream owns only the customer side of an ACD conversation.
 * Telnyx exposes the WebRTC microphone from a separate transferred transport
 * leg, so requesting the customer leg's outbound track captures queue/hold
 * audio but not the agent after answer. Keep this stream inbound-only; the
 * transport-leg stream is started when the agent answers.
 */
export function telnyxSttMediaStreamTrack(_value) {
  return "inbound_track";
}
