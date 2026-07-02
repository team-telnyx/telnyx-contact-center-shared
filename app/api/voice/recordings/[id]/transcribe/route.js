import { NextResponse } from "next/server";
import { buildTelnyxV2Url } from "@/lib/telnyx";
import { PgDb } from "@/lib/pgdb";
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

function getApiKey() {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) {
    throw new Error("TELNYX_API_KEY environment variable is required");
  }
  return apiKey;
}

/**
 * Transcribe a recording using Telnyx AI Transcription API
 * POST /api/voice/recordings/[id]/transcribe
 */
export async function POST(request, { params }) {
  try {
    const { id: recordingId } = await params;
    if (!recordingId) {
      return NextResponse.json(
        { ok: false, error: "Recording ID is required" },
        { status: 400 }
      );
    }

    const body = await request.json();
    const {
      interactionId,
      model: requestedModel,
      language: requestedLanguage,
      options: requestedOptions,
    } = body;

    if (!interactionId) {
      return NextResponse.json(
        { ok: false, error: "Interaction ID is required" },
        { status: 400 }
      );
    }

    // Validate the requested model against the allowlist; default to Nova 3.
    const model = TRANSCRIPTION_MODELS.some((m) => m.value === requestedModel)
      ? requestedModel
      : DEFAULT_TRANSCRIPTION_MODEL;
    const modelMeta = TRANSCRIPTION_MODELS.find((m) => m.value === model);
    const language =
      requestedLanguage && modelMeta?.languages?.includes(requestedLanguage)
        ? requestedLanguage
        : "auto";
    const options =
      requestedOptions && typeof requestedOptions === "object" && !Array.isArray(requestedOptions)
        ? requestedOptions
        : {};

    // Get interaction to find recording URL
    const interaction = await PgDb.findInteractionById(interactionId);
    if (!interaction) {
      return NextResponse.json(
        { ok: false, error: "Interaction not found" },
        { status: 404 }
      );
    }

    // Fetch fresh recording URLs from Telnyx API (URLs expire after 10 minutes)
    const apiKey = getApiKey();
    const telnyxUrl = buildTelnyxV2Url(`/recordings/${recordingId}`);
    const recordingInfoResponse = await fetch(telnyxUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
    });

    if (!recordingInfoResponse.ok) {
      const errorText = await recordingInfoResponse.text();
      recordingsLogger.error("recording_transcribe_transcriberecording", voiceRuntimePayload({ error: typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof e !== "undefined" ? e : undefined, eventType: typeof event !== "undefined" ? event : typeof eventType !== "undefined" ? eventType : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof payload !== "undefined" ? payload?.call_control_id : undefined, callSessionId: typeof callSessionId !== "undefined" ? callSessionId : typeof payload !== "undefined" ? payload?.call_session_id : undefined, flowId: typeof flowId !== "undefined" ? flowId : typeof flow !== "undefined" ? flow?.id : undefined, nodeId: typeof nodeId !== "undefined" ? nodeId : typeof node !== "undefined" ? node?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined, provider: typeof provider !== "undefined" ? provider : undefined }));
      return NextResponse.json(
        { ok: false, error: "Failed to fetch recording information" },
        { status: recordingInfoResponse.status }
      );
    }

    const recordingInfoData = await recordingInfoResponse.json();
    const recording = recordingInfoData?.data;

    if (!recording) {
      return NextResponse.json(
        { ok: false, error: "Recording not found" },
        { status: 404 }
      );
    }

    // Get download URL (prefer WAV, fallback to MP3)
    let audioUrl = null;
    let fileExtension = "mp3";

    if (recording?.download_urls?.wav) {
      audioUrl = recording.download_urls.wav;
      fileExtension = "wav";
    } else if (recording?.download_urls?.mp3) {
      audioUrl = recording.download_urls.mp3;
      fileExtension = "mp3";
    }

    if (!audioUrl) {
      return NextResponse.json(
        { ok: false, error: "No downloadable recording format available" },
        { status: 404 }
      );
    }

    // Download the recording file
    const recordingResponse = await fetch(audioUrl);
    if (!recordingResponse.ok) {
      const errorText = await recordingResponse.text();
      recordingsLogger.error("recording_transcribe_transcriberecording", voiceRuntimePayload({ error: typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof e !== "undefined" ? e : undefined, eventType: typeof event !== "undefined" ? event : typeof eventType !== "undefined" ? eventType : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof payload !== "undefined" ? payload?.call_control_id : undefined, callSessionId: typeof callSessionId !== "undefined" ? callSessionId : typeof payload !== "undefined" ? payload?.call_session_id : undefined, flowId: typeof flowId !== "undefined" ? flowId : typeof flow !== "undefined" ? flow?.id : undefined, nodeId: typeof nodeId !== "undefined" ? nodeId : typeof node !== "undefined" ? node?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined, provider: typeof provider !== "undefined" ? provider : undefined }));
      return NextResponse.json(
        { ok: false, error: "Failed to download recording" },
        { status: 500 }
      );
    }

    const audioBlob = await recordingResponse.blob();

    // Create FormData for multipart/form-data request
    const formData = new FormData();
    formData.append("file", audioBlob, `recording-${recordingId}.${fileExtension}`);
    formData.append("model", model);
    formData.append("response_format", "verbose_json");
    formData.append("timestamp_granularities[]", "segment");
    if (language && language !== "auto") {
      formData.append("language", language);
    }
    const modelConfig = buildTranscriptionModelConfig(model, options, language);
    if (modelConfig) {
      formData.append("model_config", JSON.stringify(modelConfig));
    }

    // Call Telnyx transcription API
    const url = buildTelnyxV2Url("/ai/audio/transcriptions");

    const startedAt = Date.now();
    const transcriptionResponse = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: formData,
    });

    if (!transcriptionResponse.ok) {
      const errorData = await transcriptionResponse.json().catch(() => ({}));
      recordingsLogger.error("recording_transcribe_transcriberecording", voiceRuntimePayload({ error: typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof e !== "undefined" ? e : undefined, eventType: typeof event !== "undefined" ? event : typeof eventType !== "undefined" ? eventType : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof payload !== "undefined" ? payload?.call_control_id : undefined, callSessionId: typeof callSessionId !== "undefined" ? callSessionId : typeof payload !== "undefined" ? payload?.call_session_id : undefined, flowId: typeof flowId !== "undefined" ? flowId : typeof flow !== "undefined" ? flow?.id : undefined, nodeId: typeof nodeId !== "undefined" ? nodeId : typeof node !== "undefined" ? node?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined, provider: typeof provider !== "undefined" ? provider : undefined }));
      return NextResponse.json(
        {
          ok: false,
          error:
            errorData?.detail ||
            errorData?.message ||
            "Failed to transcribe recording",
        },
        { status: transcriptionResponse.status }
      );
    }

    const transcriptionData = await transcriptionResponse.json();
    const processingTimeMs = Date.now() - startedAt;
    const transcriptionText = transcriptionData?.text || null;
    const segments = transcriptionData?.segments || null;
    const speakerTurns = extractSpeakerTurns(transcriptionData);
    const confidence = extractTranscriptionConfidence(transcriptionData);
    const detectedLanguage = transcriptionData?.language || null;
    const audioDuration = transcriptionData?.duration || null;

    if (!transcriptionText) {
      return NextResponse.json(
        { ok: false, error: "No transcription text received" },
        { status: 500 }
      );
    }

    // Generate call summary
    let summary = null;
    try {
      summary = await generateCallSummary(transcriptionText);
      if (summary) {
        recordingsLogger.debug("recording_transcribe_transcriberecording", voiceRuntimePayload({ eventType: typeof event !== "undefined" ? event : typeof eventType !== "undefined" ? eventType : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof payload !== "undefined" ? payload?.call_control_id : undefined, callSessionId: typeof callSessionId !== "undefined" ? callSessionId : typeof payload !== "undefined" ? payload?.call_session_id : undefined, flowId: typeof flowId !== "undefined" ? flowId : typeof flow !== "undefined" ? flow?.id : undefined, nodeId: typeof nodeId !== "undefined" ? nodeId : typeof node !== "undefined" ? node?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined, provider: typeof provider !== "undefined" ? provider : undefined }));
      }
    } catch (summaryError) {
      recordingsLogger.error("recording_transcribe_transcriberecording", voiceRuntimePayload({ error: typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof e !== "undefined" ? e : undefined, eventType: typeof event !== "undefined" ? event : typeof eventType !== "undefined" ? eventType : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof payload !== "undefined" ? payload?.call_control_id : undefined, callSessionId: typeof callSessionId !== "undefined" ? callSessionId : typeof payload !== "undefined" ? payload?.call_session_id : undefined, flowId: typeof flowId !== "undefined" ? flowId : typeof flow !== "undefined" ? flow?.id : undefined, nodeId: typeof nodeId !== "undefined" ? nodeId : typeof node !== "undefined" ? node?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined, provider: typeof provider !== "undefined" ? provider : undefined }));
      // Continue even if summary generation fails
    }

    // Save transcription to interaction metadata (include text, segments,
    // speaker turns, model details, and summary)
    const updatedMetadata = {
      ...(interaction.metadata || {}),
      transcription_text: transcriptionText,
      transcription_segments: segments,
      transcription_summary: summary,
      transcription_speaker_turns: speakerTurns,
      transcription_details: {
        model,
        language,
        detected_language: detectedLanguage,
        confidence,
        duration: audioDuration,
        diarize: Boolean(modelConfig?.diarize),
        processing_time_ms: processingTimeMs,
        transcribed_at: new Date().toISOString(),
      },
    };

    await PgDb.updateInteractionById(interactionId, {
      metadata: updatedMetadata,
    });

    return NextResponse.json({
      ok: true,
      transcription_text: transcriptionText,
      transcription_segments: segments,
      transcription_summary: summary,
      transcription_speaker_turns: speakerTurns,
      transcription_details: updatedMetadata.transcription_details,
    });
  } catch (error) {
    recordingsLogger.error("recording_transcribe_transcriberecording", voiceRuntimePayload({ error: typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof e !== "undefined" ? e : undefined, eventType: typeof event !== "undefined" ? event : typeof eventType !== "undefined" ? eventType : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof payload !== "undefined" ? payload?.call_control_id : undefined, callSessionId: typeof callSessionId !== "undefined" ? callSessionId : typeof payload !== "undefined" ? payload?.call_session_id : undefined, flowId: typeof flowId !== "undefined" ? flowId : typeof flow !== "undefined" ? flow?.id : undefined, nodeId: typeof nodeId !== "undefined" ? nodeId : typeof node !== "undefined" ? node?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined, provider: typeof provider !== "undefined" ? provider : undefined }));
    return NextResponse.json(
      { ok: false, error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}

