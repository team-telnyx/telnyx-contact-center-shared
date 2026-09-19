import {
  mergeAgentAssistSuggestions,
  mergeAgentAssistTranscriptions,
} from "./history-merge.mjs";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function artifactTrack(segment = {}) {
  const explicit = segment.track || segment.transcription_track;
  if (explicit) return explicit;
  const speaker = String(segment.speaker ?? segment.role ?? "").trim().toLowerCase();
  if (["agent", "assistant", "system"].includes(speaker)) return "outbound";
  if (["customer", "caller", "user"].includes(speaker)) return "inbound";
  const channel = speaker.match(/^channel[ _-]*(\d+)$/i);
  if (channel) return Number(channel[1]) === 2 ? "outbound" : "inbound";
  const numericSpeaker = speaker.match(/^(?:speaker\s*)?(\d+)$/i);
  if (numericSpeaker) {
    return Number(numericSpeaker[1]) % 2 === 1 ? "outbound" : "inbound";
  }
  return "inbound";
}

function normalizeArtifactTranscription(segment, index) {
  let transcript = String(
    segment?.transcript ?? segment?.text ?? segment?.content ?? "",
  ).trim();
  if (!transcript) return null;
  const prefixedChannel = transcript.match(/^Channel\s+(\d+)\s*:\s*(.+)$/i);
  const track = prefixedChannel
    ? Number(prefixedChannel[1]) === 2 ? "outbound" : "inbound"
    : artifactTrack(segment);
  if (prefixedChannel) transcript = prefixedChannel[2].trim();

  return {
    ...segment,
    id: segment?.id || `artifact-${index}`,
    transcript,
    track,
    isFinal: segment?.isFinal ?? segment?.is_final ?? true,
  };
}

function artifactTextSegments(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line, index) => normalizeArtifactTranscription({ text: line }, index))
    .filter(Boolean);
}

/**
 * Resolve the durable transcript shown in Call History.
 *
 * aa_workflow_sessions is the primary Agent Assist history. Interaction
 * metadata is only a compatibility fallback and the ACD transcript artifact is
 * the final durable fallback. Workflow item source_transcript values are slot
 * provenance (for example client_state.workflow_data), not spoken utterances,
 * and must never be reconstructed into the conversation transcript.
 */
export function resolveWorkflowHistoryTranscriptions({
  sessionTranscriptions,
  metadataTranscriptions,
  artifactSegments,
  artifactSpeakerTurns,
  artifactText,
} = {}) {
  const session = asArray(sessionTranscriptions);
  const metadata = asArray(metadataTranscriptions);

  if (session.length || metadata.length) {
    // Put the authoritative session copy last so it wins when a compatibility
    // metadata snapshot contains an older version of the same utterance.
    return mergeAgentAssistTranscriptions(metadata, session);
  }

  const artifact = asArray(artifactSpeakerTurns).length
    ? artifactSpeakerTurns
    : asArray(artifactSegments);
  const normalized = artifact
    .map(normalizeArtifactTranscription)
    .filter(Boolean);
  return normalized.length ? normalized : artifactTextSegments(artifactText);
}

export function resolveWorkflowHistorySuggestions({
  sessionSuggestions,
  metadataSuggestions,
} = {}) {
  return mergeAgentAssistSuggestions(
    asArray(metadataSuggestions),
    asArray(sessionSuggestions),
  );
}
