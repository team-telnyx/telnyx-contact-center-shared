import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { buildTelnyxV2Url } from "@/lib/telnyx";
import { findWorkItemWithArtifacts } from "@/lib/acd/work-item-repository.mjs";
import { persistGeneratedTranscript } from "@/lib/acd/artifacts.mjs";
import { generateCallSummary } from "@/lib/contact-center/call-summary.js";
import { voiceRuntimePayload, recordingsLogger } from "@/lib/voice/logging.mjs";
import {
  extractSpeakerTurns,
  extractTranscriptionConfidence,
} from "@/lib/voice-transcription-utils.mjs";
import {
  TRANSCRIPTION_MODELS,
  DEFAULT_TRANSCRIPTION_MODEL,
  buildTranscriptionModelConfig,
} from "@/config/transcription-models";
import { withPermission } from "@/lib/authz/guard";
import { workItemInScope } from "@/lib/authz/scope.mjs";

function getApiKey() {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) {
    throw new Error("TELNYX_API_KEY environment variable is required");
  }
  return apiKey;
}

function failure(message, status) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

/** Transcribe a recording and persist it as an ACD Core artifact. */
async function POST_handler(request, { params }, authz) {
  try {
    const user = authz.user;

    const { id: recordingId } = await params;
    if (!recordingId) return failure("Recording ID is required", 400);

    const body = await request.json();
    const interactionId = body.interactionId;
    if (!interactionId) return failure("Interaction ID is required", 400);

    const pool = getPostgresPool();
    if (!pool) return failure("Server not ready", 503);
    const interaction = await findWorkItemWithArtifacts(pool, interactionId);
    if (!interaction) return failure("Interaction not found", 404);
    if (
      !authz.elevated &&
      String(interaction.agent_id || "") !== String(user.id || "")
    ) {
      return failure("Forbidden", 403);
    }
    if (
      authz.elevated &&
      !(await workItemInScope(pool, authz.scope, interaction.work_item_id || interaction.id, { queueId: interaction.queue_id, agentId: interaction.agent_id, channel: interaction.interaction_type || interaction.channel }))
    ) {
      return failure("Interaction is outside your data scope", 403);
    }

    const matchingRecording = interaction.artifacts.recordings.find(
      (item) => String(item.provider_recording_id) === String(recordingId),
    );
    if (!matchingRecording) {
      return failure("Recording does not belong to this interaction", 404);
    }

    const requestedModel = body.model;
    const model = TRANSCRIPTION_MODELS.some((item) => item.value === requestedModel)
      ? requestedModel
      : DEFAULT_TRANSCRIPTION_MODEL;
    const modelMeta = TRANSCRIPTION_MODELS.find((item) => item.value === model);
    const language =
      body.language && modelMeta?.languages?.includes(body.language)
        ? body.language
        : "auto";
    const options =
      body.options && typeof body.options === "object" && !Array.isArray(body.options)
        ? body.options
        : {};

    const apiKey = getApiKey();
    const recordingInfoResponse = await fetch(
      buildTelnyxV2Url(`/recordings/${recordingId}`),
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        cache: "no-store",
      },
    );
    if (!recordingInfoResponse.ok) {
      return failure(
        "Failed to fetch recording information",
        recordingInfoResponse.status,
      );
    }

    const recording = (await recordingInfoResponse.json())?.data;
    if (!recording) return failure("Recording not found", 404);
    const audioUrl =
      recording.download_urls?.wav || recording.download_urls?.mp3 || null;
    const fileExtension = recording.download_urls?.wav ? "wav" : "mp3";
    if (!audioUrl) {
      return failure("No downloadable recording format available", 404);
    }

    const recordingResponse = await fetch(audioUrl);
    if (!recordingResponse.ok) {
      return failure("Failed to download recording", 502);
    }

    const formData = new FormData();
    formData.append(
      "file",
      await recordingResponse.blob(),
      `recording-${recordingId}.${fileExtension}`,
    );
    formData.append("model", model);
    formData.append("response_format", "verbose_json");
    formData.append("timestamp_granularities[]", "segment");
    if (language !== "auto") formData.append("language", language);
    const modelConfig = buildTranscriptionModelConfig(model, options, language);
    if (modelConfig) {
      formData.append("model_config", JSON.stringify(modelConfig));
    }

    const startedAt = Date.now();
    const transcriptionResponse = await fetch(
      buildTelnyxV2Url("/ai/audio/transcriptions"),
      {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: formData,
      },
    );
    if (!transcriptionResponse.ok) {
      const errorData = await transcriptionResponse.json().catch(() => ({}));
      return failure(
        errorData?.detail ||
          errorData?.message ||
          "Failed to transcribe recording",
        transcriptionResponse.status,
      );
    }

    const transcriptionData = await transcriptionResponse.json();
    const transcriptionText = transcriptionData?.text || null;
    if (!transcriptionText) {
      return failure("No transcription text received", 502);
    }

    const segments = transcriptionData?.segments || [];
    const speakerTurns = extractSpeakerTurns(transcriptionData);
    const confidence = extractTranscriptionConfidence(transcriptionData);
    const details = {
      model,
      language,
      detected_language: transcriptionData?.language || null,
      confidence,
      duration: transcriptionData?.duration || null,
      diarize: Boolean(modelConfig?.diarize),
      processing_time_ms: Date.now() - startedAt,
      transcribed_at: new Date().toISOString(),
    };

    let summary = null;
    try {
      summary = await generateCallSummary(transcriptionText);
    } catch (summaryError) {
      recordingsLogger.error(
        "recording_summary_failed",
        voiceRuntimePayload({
          error: summaryError,
          provider: "telnyx",
          reason: "summary_generation",
        }),
      );
    }

    await persistGeneratedTranscript(pool, {
      workItemId: interaction.work_item_id,
      providerRecordingId: recordingId,
      text: transcriptionText,
      segments,
      speakerTurns,
      summary,
      language: transcriptionData?.language || null,
      model,
      sourceEventId: `manual:${recordingId}:${model}`,
      metadata: { transcription_details: details },
    });

    return NextResponse.json({
      ok: true,
      transcription_text: transcriptionText,
      transcription_segments: segments,
      transcription_summary: summary,
      transcription_speaker_turns: speakerTurns,
      transcription_details: details,
    });
  } catch (error) {
    recordingsLogger.error(
      "recording_transcribe_failed",
      voiceRuntimePayload({ error, provider: "telnyx" }),
    );
    return failure(error.message || "Internal server error", 500);
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
// Agents may transcribe recordings of their own interactions; supervisors (recordings:transcribe) any.
export const POST = withPermission(["recordings:transcribe", "agent:self"], POST_handler, { elevated: "recordings:transcribe", route: "/api/voice/recordings/[id]/transcribe" });
