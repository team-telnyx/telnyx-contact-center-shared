function normalizedText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

export const SAME_LEG_FINAL_COALESCE_MS = 3500;

export function compactTranscriptText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function mergeCoalesceTranscript(existing, incoming) {
  const current = compactTranscriptText(existing);
  const next = compactTranscriptText(incoming);
  if (!current) return next;
  if (!next) return current;
  if (next.startsWith(current) || current.includes(next)) {
    return next.length > current.length ? next : current;
  }
  if (current.endsWith(next)) return current;
  const currentCore = current.replace(/[.,!?;:]+$/u, "").trim();
  if (currentCore && next.toLowerCase().startsWith(currentCore.toLowerCase())) {
    return next.length >= current.length ? next : current;
  }
  return compactTranscriptText(`${current} ${next}`);
}

export function transcriptionTimestampMs(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function transcriptionLeg(item = {}) {
  const track = String(item.track || item.transcription_track || "").toLowerCase();
  return track === "outbound" || track === "agent" ? "agent" : "customer";
}

function coalesceFinalTranscriptions(items) {
  const result = [];
  for (const item of items) {
    const previous = result[result.length - 1];
    const previousMs = transcriptionTimestampMs(previous?.timestamp);
    const currentMs = transcriptionTimestampMs(item?.timestamp);
    const gapMs = currentMs - previousMs;
    const canCoalesce =
      previous?.isFinal === true &&
      item?.isFinal === true &&
      transcriptionLeg(previous) === transcriptionLeg(item) &&
      previousMs > 0 &&
      currentMs > 0 &&
      gapMs >= 0 &&
      gapMs <= SAME_LEG_FINAL_COALESCE_MS;

    if (!canCoalesce) {
      result.push(item);
      continue;
    }

    const previousText = compactTranscriptText(previous.transcript || previous.text);
    const currentText = compactTranscriptText(item.transcript || item.text);
    // Preserve intentionally repeated short answers. Substantial equal text
    // inside the window is a provider/browser redelivery of the same turn.
    const equalText = normalizedText(previousText) === normalizedText(currentText);
    const substantial = previousText.includes(" ") || previousText.length >= 6;
    if (equalText && !substantial) {
      result.push(item);
      continue;
    }

    result[result.length - 1] = {
      ...previous,
      ...item,
      id: previous.id || item.id,
      transcriptionKey:
        previous.transcriptionKey || previous.transcription_key || item.transcriptionKey,
      transcript: mergeCoalesceTranscript(previousText, currentText),
      isFinal: true,
    };
  }
  return result;
}

function transcriptKey(item = {}) {
  return (
    item.transcriptionKey ||
    item.transcription_key ||
    item.originalTranscriptionKey ||
    item.id ||
    [
      item.callControlId || item.call_control_id || "",
      item.track || item.transcription_track || "",
      item.timestamp || "",
      normalizedText(item.transcript),
    ].join("|")
  );
}

function suggestionKey(item = {}) {
  return (
    item.id ||
    [item.itemId || "", item.stageName || "", normalizedText(item.text)].join("|")
  );
}

function mergeByStableKey(existing, incoming, keyOf) {
  const merged = [];
  const indexes = new Map();

  for (const item of [...(existing || []), ...(incoming || [])]) {
    if (!item || typeof item !== "object") continue;
    const key = String(keyOf(item));
    const index = indexes.get(key);
    if (index === undefined) {
      indexes.set(key, merged.length);
      merged.push(item);
    } else {
      // Later saves carry the most complete form of a live utterance (final
      // text, sentiment, slots) but retain fields omitted by that save.
      merged[index] = { ...merged[index], ...item };
    }
  }

  return merged;
}

export function mergeAgentAssistTranscriptions(existing = [], incoming = []) {
  return coalesceFinalTranscriptions(
    mergeByStableKey(existing, incoming, transcriptKey),
  );
}

export function mergeAgentAssistSuggestions(existing = [], incoming = []) {
  return mergeByStableKey(existing, incoming, suggestionKey);
}
