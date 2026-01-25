import { NextResponse } from "next/server";
import { buildTelnyxV2Url } from "@/lib/telnyx";
import { PgDb } from "@/lib/pgdb";
import { generateCallSummary } from "@/lib/contact-center/call-summary.js";

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
    const { interactionId } = body;

    if (!interactionId) {
      return NextResponse.json(
        { ok: false, error: "Interaction ID is required" },
        { status: 400 }
      );
    }

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
      console.error("[TranscribeRecording] Failed to fetch recording info:", errorText);
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
      console.error("[TranscribeRecording] Failed to download recording:", errorText);
      return NextResponse.json(
        { ok: false, error: "Failed to download recording" },
        { status: 500 }
      );
    }

    const audioBlob = await recordingResponse.blob();

    // Create FormData for multipart/form-data request
    const formData = new FormData();
    formData.append("file", audioBlob, `recording-${recordingId}.${fileExtension}`);
    formData.append("model", "distil-whisper/distil-large-v2");
    formData.append("response_format", "verbose_json");
    formData.append("timestamp_granularities[]", "segment");

    // Call Telnyx transcription API
    const url = buildTelnyxV2Url("/ai/audio/transcriptions");

    const transcriptionResponse = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: formData,
    });

    if (!transcriptionResponse.ok) {
      const errorData = await transcriptionResponse.json().catch(() => ({}));
      console.error(
        "[TranscribeRecording] Telnyx API error:",
        errorData
      );
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
    const transcriptionText = transcriptionData?.text || null;
    const segments = transcriptionData?.segments || null;

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
        console.log(
          `[TranscribeRecording] Generated call summary for interaction ${interactionId}`
        );
      }
    } catch (summaryError) {
      console.error(
        "[TranscribeRecording] Error generating call summary:",
        summaryError
      );
      // Continue even if summary generation fails
    }

    // Save transcription to interaction metadata (include both text, segments, and summary)
    const updatedMetadata = {
      ...(interaction.metadata || {}),
      transcription_text: transcriptionText,
      transcription_segments: segments,
      transcription_summary: summary,
    };

    await PgDb.updateInteractionById(interactionId, {
      metadata: updatedMetadata,
    });

    return NextResponse.json({
      ok: true,
      transcription_text: transcriptionText,
      transcription_segments: segments,
      transcription_summary: summary,
    });
  } catch (error) {
    console.error("[TranscribeRecording] Error:", error);
    return NextResponse.json(
      { ok: false, error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}

