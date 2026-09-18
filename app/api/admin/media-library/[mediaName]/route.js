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

// GET /api/admin/media-library/[mediaName] - Get a specific media file
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
    const url = buildTelnyxV2Url(`/media/${encodeURIComponent(mediaName)}`);

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      adminRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
      return NextResponse.json(
        { error: "Failed to fetch media file" },
        { status: response.status }
      );
    }

    const data = await response.json();
    return NextResponse.json({ ok: true, data: data.data || data });
  } catch (err) {
    adminRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return NextResponse.json(
      { error: "Failed to load media file" },
      { status: 500 }
    );
  }
}

// DELETE /api/admin/media-library/[mediaName] - Delete a media file
async function DELETE_handler(request, { params }, authz) {
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
    const url = buildTelnyxV2Url(`/media/${encodeURIComponent(mediaName)}`);

    const response = await fetch(url, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      adminRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
      return NextResponse.json(
        { error: "Failed to delete media file" },
        { status: response.status }
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    adminRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return NextResponse.json(
      { error: "Failed to delete media file" },
      { status: 500 }
    );
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("media:read", GET_handler, { route: "/api/admin/media-library/[mediaName]" });
export const DELETE = withPermission("media:delete", DELETE_handler, { route: "/api/admin/media-library/[mediaName]" });
