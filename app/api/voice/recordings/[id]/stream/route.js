import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { buildTelnyxV2Url } from "@/lib/telnyx";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";

export async function GET(request, { params }) {
  try {
    const user = await getAuthenticatedUser(request.url);
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 }
      );
    }

    const telnyxApiKey = process.env.TELNYX_API_KEY;
    if (!telnyxApiKey) {
      return NextResponse.json(
        { ok: false, error: "Server not configured" },
        { status: 500 }
      );
    }

    const { id } = await params;
    if (!id) {
      return NextResponse.json(
        { ok: false, error: "recording_id is required" },
        { status: 400 }
      );
    }

    const telnyxUrl = buildTelnyxV2Url(`/recordings/${id}`);
    const recordingResponse = await fetch(telnyxUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${telnyxApiKey}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
    });

    if (!recordingResponse.ok) {
      const errorText = await recordingResponse.text();
      voiceRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
      return NextResponse.json(
        { ok: false, error: "Failed to fetch recording" },
        { status: recordingResponse.status }
      );
    }

    const recordingData = await recordingResponse.json();
    const recording = recordingData.data;

    let audioUrl = null;
    let contentType = "audio/mpeg";

    if (recording?.download_urls?.wav) {
      audioUrl = recording.download_urls.wav;
      contentType = "audio/wav";
    } else if (recording?.download_urls?.mp3) {
      audioUrl = recording.download_urls.mp3;
      contentType = "audio/mpeg";
    }

    if (!audioUrl) {
      return NextResponse.json(
        { ok: false, error: "No downloadable recording format available" },
        { status: 404 }
      );
    }

    const rangeHeader = request.headers.get("range");
    const fetchOptions = rangeHeader ? { headers: { Range: rangeHeader } } : {};
    const audioResponse = await fetch(audioUrl, fetchOptions);

    if (!audioResponse.ok) {
      voiceRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
      return NextResponse.json(
        { ok: false, error: "Failed to fetch audio file" },
        { status: audioResponse.status }
      );
    }

    const stream = audioResponse.body;
    const contentLength = audioResponse.headers.get("content-length");
    const contentRange = audioResponse.headers.get("content-range");
    const etag = audioResponse.headers.get("etag");
    const lastModified = audioResponse.headers.get("last-modified");

    const headers = {
      "Content-Type": contentType,
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Range, Authorization",
    };

    if (contentLength) {
      headers["Content-Length"] = contentLength;
    }
    if (contentRange) {
      headers["Content-Range"] = contentRange;
    }
    if (etag) {
      headers["ETag"] = etag;
    }
    if (lastModified) {
      headers["Last-Modified"] = lastModified;
    }

    const status = rangeHeader ? 206 : 200;

    return new NextResponse(stream, {
      status,
      headers,
    });
  } catch (error) {
    voiceRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return NextResponse.json(
      { ok: false, error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Range, Authorization",
    },
  });
}

