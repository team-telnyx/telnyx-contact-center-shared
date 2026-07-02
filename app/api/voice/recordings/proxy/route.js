import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";

/**
 * Proxy endpoint for recording URLs to avoid CORS issues
 * GET /api/voice/recordings/proxy?url=<encoded-url>
 */
export async function GET(request) {
  try {
    const user = await getAuthenticatedUser(request.url);
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 }
      );
    }

    const { searchParams } = new URL(request.url);
    const audioUrl = searchParams.get("url");

    if (!audioUrl) {
      return NextResponse.json(
        { ok: false, error: "URL parameter is required" },
        { status: 400 }
      );
    }

    // Validate that the URL is from a trusted source (S3 or Telnyx)
    try {
      const url = new URL(audioUrl);
      const hostname = url.hostname.toLowerCase();
      
      // Only allow S3 URLs (telephony-recorder-prod) or Telnyx domains
      const allowedHosts = [
        "s3.amazonaws.com",
        "telephony-recorder-prod.s3.amazonaws.com",
        "telephony-recorder-prod.s3.us-east-1.amazonaws.com",
      ];
      
      if (!allowedHosts.some(host => hostname.includes(host))) {
        return NextResponse.json(
          { ok: false, error: "URL is not from an allowed source" },
          { status: 403 }
        );
      }
    } catch (urlError) {
      return NextResponse.json(
        { ok: false, error: "Invalid URL format" },
        { status: 400 }
      );
    }

    // Support range requests for audio streaming
    const rangeHeader = request.headers.get("range");
    const fetchOptions = rangeHeader 
      ? { headers: { Range: rangeHeader } } 
      : {};

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
    
    // Determine content type from URL or response
    let contentType = audioResponse.headers.get("content-type") || "audio/mpeg";
    if (!contentType || contentType === "application/octet-stream") {
      if (audioUrl.includes(".wav")) {
        contentType = "audio/wav";
      } else if (audioUrl.includes(".mp3")) {
        contentType = "audio/mpeg";
      }
    }

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

