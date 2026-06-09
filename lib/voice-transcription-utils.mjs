function normalizedConfidenceValue(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  if (num < 0) return null;
  return num > 1 ? num / 100 : num;
}

export function extractTranscriptionConfidence(rawData) {
  const direct = normalizedConfidenceValue(rawData?.confidence);
  if (direct != null) return direct;

  const confidenceValues = [];
  const seenWordKeys = new Set();
  const collect = (word) => {
    const confidence = normalizedConfidenceValue(word?.confidence);
    if (confidence == null) return;

    const key = wordIdentityKey(word);
    if (key && seenWordKeys.has(key)) return;
    if (key) seenWordKeys.add(key);
    confidenceValues.push(confidence);
  };

  for (const word of rawData?.words || []) collect(word);
  for (const segment of rawData?.segments || []) {
    const segmentConfidence = normalizedConfidenceValue(segment?.confidence);
    if (segmentConfidence != null) confidenceValues.push(segmentConfidence);
    for (const word of segment?.words || []) collect(word);
  }

  if (!confidenceValues.length) return null;
  const average = confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length;
  return Number(average.toFixed(4));
}

function wordText(word) {
  return word?.punctuated_word || word?.word || word?.text || "";
}

function wordDisplayScore(word) {
  const displayText = wordText(word).trim();
  const rawText = (word?.word || word?.text || "").trim();
  let score = 0;
  if (word?.punctuated_word) score += 2;
  if (displayText && displayText !== rawText) score += 1;
  if (/[.!?]$/.test(displayText)) score += 4;
  return score;
}

function speakerFrom(value) {
  if (value == null || value === "") return null;
  const label = String(value).replace(/^speaker[_\s-]*/i, "");
  return label || String(value);
}

function normalizeTimestamp(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Number(num.toFixed(3));
}

function wordIdentityText(word) {
  return (word?.word || word?.text || word?.punctuated_word || "").trim().toLowerCase();
}

function wordHasSpeaker(word) {
  return speakerFrom(word?.speaker ?? word?.speaker_tag ?? word?.speaker_id) != null;
}

function wordIdentityKey(word) {
  const text = wordIdentityText(word);
  const speaker = speakerFrom(word?.speaker ?? word?.speaker_tag ?? word?.speaker_id);
  const start = normalizeTimestamp(word?.start);
  const end = normalizeTimestamp(word?.end);
  if (!text || !speaker || start == null) return null;
  return `${speaker}|${start}|${end ?? ""}|${text}`;
}

function collectSpeakerWords(rawData) {
  const words = [];
  const pushWord = (word) => {
    if (word && typeof word === "object") words.push(word);
  };

  for (const word of rawData?.words || []) pushWord(word);
  for (const segment of rawData?.segments || []) {
    const segmentWords = Array.isArray(segment?.words) ? segment.words : [];
    const hasSpeakerWords = segmentWords.some(wordHasSpeaker);

    if (segmentWords.length) {
      for (const word of segmentWords) pushWord(word);
    } else if (segment?.text && (segment.speaker != null || segment.speaker_tag != null)) {
      pushWord({
        word: segment.text,
        start: segment.start,
        end: segment.end,
        speaker: segment.speaker ?? segment.speaker_tag,
      });
    }

    if (hasSpeakerWords) continue;

    for (const speakerTurn of segment?.speakers || []) {
      if (!speakerTurn || typeof speakerTurn !== "object") continue;
      if (Array.isArray(speakerTurn?.words) && speakerTurn.words.length) {
        for (const word of speakerTurn.words) {
          pushWord({
            ...word,
            speaker:
              word?.speaker ??
              word?.speaker_tag ??
              word?.speaker_id ??
              speakerTurn.speaker ??
              speakerTurn.speaker_tag ??
              speakerTurn.speaker_id,
          });
        }
      } else {
        pushWord({
          word: speakerTurn?.text ?? speakerTurn?.word ?? speakerTurn?.transcript,
          start: speakerTurn?.start ?? segment?.start,
          end: speakerTurn?.end ?? segment?.end,
          speaker: speakerTurn?.speaker ?? speakerTurn?.speaker_tag ?? speakerTurn?.speaker_id,
        });
      }
    }
  }

  const dedupedWords = [];
  const seen = new Map();
  for (const word of words) {
    const key = wordIdentityKey(word);
    if (!key) {
      dedupedWords.push(word);
      continue;
    }

    const existingIndex = seen.get(key);
    if (existingIndex == null) {
      seen.set(key, dedupedWords.length);
      dedupedWords.push(word);
      continue;
    }

    if (wordDisplayScore(word) > wordDisplayScore(dedupedWords[existingIndex])) {
      dedupedWords[existingIndex] = word;
    }
  }

  return dedupedWords
    .sort((a, b) => {
      const startA = Number(a?.start);
      const startB = Number(b?.start);
      if (Number.isFinite(startA) && Number.isFinite(startB) && startA !== startB) return startA - startB;
      const endA = Number(a?.end);
      const endB = Number(b?.end);
      if (Number.isFinite(endA) && Number.isFinite(endB) && endA !== endB) return endA - endB;
      return 0;
    });
}

export function extractSpeakerTurns(rawData) {
  const words = collectSpeakerWords(rawData);
  const turns = [];

  const addConfidence = (turn, word) => {
    const confidence = normalizedConfidenceValue(word?.confidence);
    if (confidence == null) return;
    turn.confidenceValues = [...(turn.confidenceValues || []), confidence];
    const average = turn.confidenceValues.reduce((sum, value) => sum + value, 0) / turn.confidenceValues.length;
    turn.confidence = Number(average.toFixed(4));
  };

  for (const word of words) {
    const text = wordText(word).trim();
    const speaker = speakerFrom(word?.speaker ?? word?.speaker_tag ?? word?.speaker_id);
    const start = Number(word?.start);
    const end = Number(word?.end);
    if (!text || !speaker || !Number.isFinite(start)) continue;

    const last = turns[turns.length - 1];
    if (last && last.speaker === speaker) {
      last.text = `${last.text}${/^[.,!?;:%)]/.test(text) ? "" : " "}${text}`;
      if (Number.isFinite(end)) last.end = end;
      addConfidence(last, word);
    } else {
      const turn = { speaker, text, start, end: Number.isFinite(end) ? end : start };
      addConfidence(turn, word);
      turns.push(turn);
    }
  }

  return turns.map(({ confidenceValues, ...turn }) => turn);
}
