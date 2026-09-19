import { NextResponse } from "next/server";
import { buildTelnyxV2Url } from "@/lib/telnyx";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";
import { withPermission } from "@/lib/authz/guard";


function getApiKey() {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) {
    throw new Error("TELNYX_API_KEY environment variable is required");
  }
  return apiKey;
}

// GET /api/admin/media-library/[mediaName]/stream - Stream media file for playback
async function GET_handler(request, { params }, authz) {
  const user = authz.user;

  try {
    const resolvedParams = await params;
    const mediaName = resolvedParams?.mediaName;

    if (!mediaName) {
      return NextResponse.json(
        { error: "Media name is required" },
        { status: 400 }
      );
    }

    const apiKey = getApiKey();
    const url = buildTelnyxV2Url(
      `/media/${encodeURIComponent(mediaName)}/download`
    );

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      adminRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
      return NextResponse.json(
        { error: "Failed to stream media file" },
        { status: response.status }
      );
    }

    // Get the content type from the response
    const contentType = response.headers.get("content-type") || "audio/mpeg";

    // Stream the file
    const arrayBuffer = await response.arrayBuffer();
    return new NextResponse(arrayBuffer, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch (err) {
    adminRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return NextResponse.json(
      { error: "Failed to stream media file" },
      { status: 500 }
    );
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("media:read", GET_handler, { route: "/api/admin/media-library/[mediaName]/stream" });
