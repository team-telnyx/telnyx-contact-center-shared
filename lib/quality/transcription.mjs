/**
 * Quality Management transcription helper.
 *
 * Ensures an interaction has a transcript before AI evaluation. Reuses the
 * same Telnyx AI transcription API as the recording transcribe route and
 * stores results in cc_interactions.metadata using the same keys, so the
 * call-history detail page picks the transcript up too.
 */

import { buildTelnyxV2Url } from "@/lib/telnyx";
import { PgDb } from "@/lib/pgdb";
import { createDiagnosticLogger } from "@/lib/diagnostic-logger.mjs";
import {
  extractSpeakerTurns,
  extractTranscriptionConfidence,
} from "@/lib/voice-transcription-utils.mjs";
import {
  DEFAULT_TRANSCRIPTION_MODEL,
  buildTranscriptionModelConfig,
  NOVA3_OPTION_DEFAULTS,
} from "@/config/transcription-models";

const qualityLogger = createDiagnosticLogger("contact-center.quality");

function getApiKey() {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) {
    throw new Error("TELNYX_API_KEY environment variable is required");
  }
  return apiKey;
}

export function getExistingTranscript(interaction) {
  const text = interaction?.metadata?.transcription_text;
  if (!text || !String(text).trim()) return null;
  return {
    text: String(text),
    segments: interaction.metadata.transcription_segments || null,
    speakerTurns: interaction.metadata.transcription_speaker_turns || [],
    details: interaction.metadata.transcription_details || null,
  };
}

export function resolveRecordingId(interaction) {
  return interaction?.metadata?.recording?.recording_id || null;
}

/**
 * Transcribe the interaction's recording via Telnyx AI and persist the result
 * to interaction metadata. Returns the transcript object.
 */
export async function transcribeInteractionRecording({
  interaction,
  recordingId,
  model = DEFAULT_TRANSCRIPTION_MODEL,
}) {
  if (!recordingId) {
    throw new Error("Interaction has no recording to transcribe");
  }

  const apiKey = getApiKey();

  // Recording URLs expire after ~10 minutes, always fetch fresh ones.
  const recordingInfoResponse = await fetch(
    buildTelnyxV2Url(`/recordings/${recordingId}`),
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
    },
  );
  if (!recordingInfoResponse.ok) {
    qualityLogger.error("quality_transcribe_recording_info_failed", {
      status: recordingInfoResponse.status,
    });
    throw new Error("Failed to fetch recording information from Telnyx");
  }

  const recording = (await recordingInfoResponse.json())?.data;
  const audioUrl =
    recording?.download_urls?.wav || recording?.download_urls?.mp3 || null;
  const fileExtension = recording?.download_urls?.wav ? "wav" : "mp3";
  if (!audioUrl) {
    throw new Error("No downloadable recording format available");
  }

  const recordingResponse = await fetch(audioUrl);
  if (!recordingResponse.ok) {
    throw new Error("Failed to download recording audio");
  }
  const audioBlob = await recordingResponse.blob();

  const formData = new FormData();
  formData.append("file", audioBlob, `recording-${recordingId}.${fileExtension}`);
  formData.append("model", model);
  formData.append("response_format", "verbose_json");
  formData.append("timestamp_granularities[]", "segment");
  const modelConfig = buildTranscriptionModelConfig(model, { ...NOVA3_OPTION_DEFAULTS }, "auto");
  if (modelConfig) {
    formData.append("model_config", JSON.stringify(modelConfig));
  }

  const startedAt = Date.now();
  const transcriptionResponse = await fetch(buildTelnyxV2Url("/ai/audio/transcriptions"), {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });

  if (!transcriptionResponse.ok) {
    const errorData = await transcriptionResponse.json().catch(() => ({}));
    qualityLogger.error("quality_transcribe_request_failed", {
      status: transcriptionResponse.status,
    });
    throw new Error(
      errorData?.detail || errorData?.message || "Failed to transcribe recording",
    );
  }

  const transcriptionData = await transcriptionResponse.json();
  const transcriptionText = transcriptionData?.text || null;
  if (!transcriptionText) {
    throw new Error("No transcription text received");
  }

  const segments = transcriptionData?.segments || null;
  const speakerTurns = extractSpeakerTurns(transcriptionData);
  const confidence = extractTranscriptionConfidence(transcriptionData);

  const details = {
    model,
    language: "auto",
    detected_language: transcriptionData?.language || null,
    confidence,
    duration: transcriptionData?.duration || null,
    diarize: Boolean(modelConfig?.diarize),
    processing_time_ms: Date.now() - startedAt,
    transcribed_at: new Date().toISOString(),
  };

  await PgDb.updateInteractionById(interaction.id, {
    metadata: {
      ...(interaction.metadata || {}),
      transcription_text: transcriptionText,
      transcription_segments: segments,
      transcription_speaker_turns: speakerTurns,
      transcription_details: details,
    },
  });

  return {
    text: transcriptionText,
    segments,
    speakerTurns,
    details,
  };
}
