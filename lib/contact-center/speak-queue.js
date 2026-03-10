/**
 * Speak Queue Service
 * Manages chunked TTS speak for long texts.
 *
 * Instead of sending a single large speak command (which causes long TTS
 * generation delays), text is split into sentence-sized chunks and sent
 * sequentially. Each chunk generates quickly and starts playing almost
 * immediately, giving the caller a much faster first-audio experience.
 */

import { buildTelnyxV2Url } from "@/lib/telnyx";

// Active speak queues keyed by callControlId
// Each entry: { chunks: string[], currentIndex: number, voice: string, callControlId: string, language: string }
const activeQueues = new Map();

// Suppress transcriptions for call legs while TTS is playing
const suppressedTranscriptions = new Map(); // callControlId -> suppressUntilMs

// Track legs where we explicitly paused transcription for TTS
const pausedTranscriptions = new Map(); // callControlId -> true

/** Minimum text length to trigger chunked speak */
const CHUNK_THRESHOLD = 400;

/** Target chunk size range */
const MIN_CHUNK_SIZE = 150;
const MAX_CHUNK_SIZE = 400;

/** Estimate TTS playback duration (ms) and suppress transcriptions during playback */
export function suppressTranscriptions(callControlId, durationMs) {
  if (!callControlId || !durationMs) return;
  const until = Date.now() + durationMs;
  suppressedTranscriptions.set(callControlId, until);
}

export function isTranscriptionSuppressed(callControlId) {
  if (!callControlId) return false;
  const until = suppressedTranscriptions.get(callControlId);
  if (!until) return false;
  if (Date.now() > until) {
    suppressedTranscriptions.delete(callControlId);
    return false;
  }
  return true;
}

function getApiKey() {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) {
    throw new Error("TELNYX_API_KEY environment variable is required");
  }
  return apiKey;
}

async function stopTranscription(callControlId) {
  const url = buildTelnyxV2Url(
    `/calls/${encodeURIComponent(callControlId)}/actions/transcription_stop`
  );
  try {
    await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${getApiKey()}` },
    });
    pausedTranscriptions.set(callControlId, true);
    console.log("[SpeakQueue] Transcription stopped for", callControlId);
  } catch (err) {
    console.warn("[SpeakQueue] Failed to stop transcription:", err.message || err);
  }
}

async function resumeTranscription(callControlId) {
  const url = buildTelnyxV2Url(
    `/calls/${encodeURIComponent(callControlId)}/actions/transcription_start`
  );
  try {
    await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${getApiKey()}` },
    });
    pausedTranscriptions.delete(callControlId);
    console.log("[SpeakQueue] Transcription resumed for", callControlId);
  } catch (err) {
    console.warn("[SpeakQueue] Failed to resume transcription:", err.message || err);
  }
}

export async function resumeTranscriptionIfPaused(callControlId) {
  if (!pausedTranscriptions.has(callControlId)) return false;
  await resumeTranscription(callControlId);
  return true;
}

/**
 * Split text into sentence-sized chunks suitable for fast TTS generation.
 *
 * Strategy:
 * 1. Split on sentence boundaries (. ! ?)
 * 2. Accumulate sentences into chunks of ~200-400 chars
 * 3. If a single sentence exceeds MAX_CHUNK_SIZE, split on commas or hard-break
 *
 * @param {string} text - Full text to split
 * @returns {string[]} Array of text chunks
 */
export function splitTextIntoChunks(text) {
  if (!text || text.length <= CHUNK_THRESHOLD) {
    return [text];
  }

  // Split into sentences — keep the delimiter attached to the sentence
  const sentenceRegex = /[^.!?]*[.!?]+[\s]*/g;
  const rawSentences = [];
  let match;
  let lastIndex = 0;

  while ((match = sentenceRegex.exec(text)) !== null) {
    rawSentences.push(match[0]);
    lastIndex = sentenceRegex.lastIndex;
  }

  // Grab any remaining text after the last sentence-ending punctuation
  if (lastIndex < text.length) {
    const remainder = text.slice(lastIndex).trim();
    if (remainder) {
      rawSentences.push(remainder);
    }
  }

  // If no sentence boundaries were found, treat the whole text as one sentence
  if (rawSentences.length === 0) {
    rawSentences.push(text);
  }

  // Further split oversized sentences on commas or hard-break
  const sentences = [];
  for (const sentence of rawSentences) {
    if (sentence.length <= MAX_CHUNK_SIZE) {
      sentences.push(sentence);
    } else {
      // Try splitting on commas first
      const parts = splitLongSentence(sentence);
      sentences.push(...parts);
    }
  }

  // Accumulate sentences into chunks within target size range
  const chunks = [];
  let currentChunk = "";

  for (const sentence of sentences) {
    const trimmedSentence = sentence.trim();
    if (!trimmedSentence) continue;

    // If adding this sentence would exceed MAX_CHUNK_SIZE and we already have content, flush
    if (
      currentChunk.length > 0 &&
      currentChunk.length + trimmedSentence.length > MAX_CHUNK_SIZE
    ) {
      chunks.push(currentChunk.trim());
      currentChunk = trimmedSentence;
    } else {
      // Accumulate
      currentChunk += (currentChunk.length > 0 ? " " : "") + trimmedSentence;
    }
  }

  // Don't forget the last chunk
  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  // If the last chunk is very short, merge it with the previous one
  if (
    chunks.length > 1 &&
    chunks[chunks.length - 1].length < MIN_CHUNK_SIZE / 2
  ) {
    const last = chunks.pop();
    chunks[chunks.length - 1] += " " + last;
  }

  return chunks;
}

/**
 * Split a long sentence (>MAX_CHUNK_SIZE) on commas or by hard-breaking.
 * @param {string} sentence
 * @returns {string[]}
 */
function splitLongSentence(sentence) {
  // Try comma-based splitting first
  const commaParts = sentence.split(/,\s*/);
  if (commaParts.length > 1) {
    const result = [];
    let current = "";

    for (let i = 0; i < commaParts.length; i++) {
      const part = commaParts[i] + (i < commaParts.length - 1 ? "," : "");

      if (
        current.length > 0 &&
        current.length + part.length > MAX_CHUNK_SIZE
      ) {
        result.push(current.trim());
        current = part;
      } else {
        current += (current.length > 0 ? " " : "") + part;
      }
    }

    if (current.trim()) {
      result.push(current.trim());
    }

    // Check if all parts are within limit
    const allFit = result.every((p) => p.length <= MAX_CHUNK_SIZE + 50); // small tolerance
    if (allFit) return result;
  }

  // Hard-break on word boundaries
  const words = sentence.split(/\s+/);
  const result = [];
  let current = "";

  for (const word of words) {
    if (current.length > 0 && current.length + word.length + 1 > MAX_CHUNK_SIZE) {
      result.push(current.trim());
      current = word;
    } else {
      current += (current.length > 0 ? " " : "") + word;
    }
  }

  if (current.trim()) {
    result.push(current.trim());
  }

  return result;
}

/**
 * Send a single speak command to Telnyx.
 * @param {string} callControlId
 * @param {string} payload - Text to speak
 * @param {string} voice - TTS voice name
 * @param {string} [language] - Language code
 * @returns {Promise<boolean>} true if successful
 */
async function sendSpeak(callControlId, payload, voice, language) {
  const url = buildTelnyxV2Url(
    `/calls/${encodeURIComponent(callControlId)}/actions/speak`
  );

  const body = { payload, voice };
  if (language) {
    body.language = language;
  }

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getApiKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      const errorMsg =
        data?.errors?.[0]?.detail || data?.message || "speak failed";
      console.error(
        `[SpeakQueue] Speak failed for ${callControlId}: ${errorMsg}`
      );
      return false;
    }

    return true;
  } catch (err) {
    console.error(`[SpeakQueue] Speak error for ${callControlId}:`, err);
    return false;
  }
}

/**
 * Start a chunked speak session. Splits the text, sends the first chunk,
 * and stores the queue so subsequent chunks are sent on call.speak.ended events.
 *
 * @param {string} callControlId
 * @param {string} text - Full text to speak
 * @param {string} voice - TTS voice
 * @param {string} [language] - Language code
 * @returns {Promise<{ ok: boolean, chunked: boolean, totalChunks: number, error?: string }>}
 */
export async function startChunkedSpeak(
  callControlId,
  text,
  voice,
  language
) {
  // Cancel any existing queue for this call
  cancelQueue(callControlId);

  // Stop transcription to avoid feedback loop during TTS
  await stopTranscription(callControlId);

  const chunks = splitTextIntoChunks(text);
  const durationMs = Math.min(60000, 3000 + (text?.length || 0) * 50);
  suppressTranscriptions(callControlId, durationMs);

  if (chunks.length <= 1) {
    // Short text — send directly, no queue needed
    const ok = await sendSpeak(callControlId, text, voice, language);
    return { ok, chunked: false, totalChunks: 1 };
  }

  // Store the queue
  const queue = {
    chunks,
    currentIndex: 0,
    voice,
    language,
    callControlId,
    startedAt: Date.now(),
  };
  activeQueues.set(callControlId, queue);

  console.log(
    `[SpeakQueue] Starting chunked speak for ${callControlId}: ${chunks.length} chunks`
  );

  // Send the first chunk
  const ok = await sendSpeak(callControlId, chunks[0], voice, language);

  if (!ok) {
    // Clean up on failure
    activeQueues.delete(callControlId);
    return { ok: false, chunked: true, totalChunks: chunks.length, error: "Failed to send first chunk" };
  }

  return { ok: true, chunked: true, totalChunks: chunks.length };
}

/**
 * Advance the speak queue to the next chunk.
 * Called from the webhook handler on call.speak.ended events.
 *
 * @param {string} callControlId
 * @returns {Promise<boolean>} true if there was a queue and next chunk was sent (or queue finished)
 */
export async function advanceQueue(callControlId) {
  const queue = activeQueues.get(callControlId);
  if (!queue) {
    return false; // No active queue — this speak.ended is from a non-chunked speak
  }

  queue.currentIndex++;

  if (queue.currentIndex >= queue.chunks.length) {
    // All chunks have been played
    const elapsed = Date.now() - queue.startedAt;
    console.log(
      `[SpeakQueue] Completed all ${queue.chunks.length} chunks for ${callControlId} in ${elapsed}ms`
    );
    activeQueues.delete(callControlId);
    await resumeTranscriptionIfPaused(callControlId);
    return true;
  }

  // Send the next chunk
  const nextChunk = queue.chunks[queue.currentIndex];
  console.log(
    `[SpeakQueue] Sending chunk ${queue.currentIndex + 1}/${queue.chunks.length} for ${callControlId} (${nextChunk.length} chars)`
  );

  const ok = await sendSpeak(
    callControlId,
    nextChunk,
    queue.voice,
    queue.language
  );

  if (!ok) {
    console.error(
      `[SpeakQueue] Failed to send chunk ${queue.currentIndex + 1} for ${callControlId}, aborting queue`
    );
    activeQueues.delete(callControlId);
    await resumeTranscriptionIfPaused(callControlId);
    return true; // Return true to indicate we handled the event (even though we aborted)
  }

  return true;
}

/**
 * Cancel and clean up any active speak queue for a call.
 * Called on call.hangup to prevent orphaned queues.
 *
 * @param {string} callControlId
 * @returns {boolean} true if a queue was cancelled
 */
export function cancelQueue(callControlId) {
  if (activeQueues.has(callControlId)) {
    const queue = activeQueues.get(callControlId);
    console.log(
      `[SpeakQueue] Cancelled queue for ${callControlId} at chunk ${queue.currentIndex + 1}/${queue.chunks.length}`
    );
    activeQueues.delete(callControlId);
    return true;
  }
  return false;
}

/**
 * Check if a call has an active speak queue.
 * @param {string} callControlId
 * @returns {boolean}
 */
export function hasActiveQueue(callControlId) {
  return activeQueues.has(callControlId);
}

/**
 * Check if text should use chunked speak.
 * @param {string} text
 * @returns {boolean}
 */
export function shouldChunk(text) {
  return text && text.length > CHUNK_THRESHOLD;
}
