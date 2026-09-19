import { NextResponse } from "next/server";
import { buildTelnyxV2Url } from "@/lib/telnyx";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";
import { withPermission } from "@/lib/authz/guard";


// GET /api/admin/scheduled-events/[id] - Get a specific scheduled event
async function GET_handler(request, { params }, authz) {
  const user = authz.user;

  try {
    const apiKey = process.env.TELNYX_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "Missing TELNYX_API_KEY" },
        { status: 500 }
      );
    }

    const resolvedParams = await params;
    const eventId = resolvedParams.id;
    const { searchParams } = new URL(request.url);
    const assistantId = searchParams.get("assistantId");

    if (!assistantId) {
      return NextResponse.json(
        { error: "assistantId query parameter is required" },
        { status: 400 }
      );
    }

    const res = await fetch(
      buildTelnyxV2Url(
        `/ai/assistants/${assistantId}/scheduled_events/${eventId}`
      ),
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        cache: "no-store",
      }
    );

    if (!res.ok) {
      const errorText = await res.text();
      return NextResponse.json(
        { error: `Telnyx API error: ${errorText}` },
        { status: res.status }
      );
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch (err) {
    adminRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return NextResponse.json(
      { error: err.message || "Failed to fetch scheduled event" },
      { status: 500 }
    );
  }
}

// DELETE /api/admin/scheduled-events/[id] - Delete a scheduled event
async function DELETE_handler(request, { params }, authz) {
  const user = authz.user;

  try {
    const apiKey = process.env.TELNYX_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "Missing TELNYX_API_KEY" },
        { status: 500 }
      );
    }

    const resolvedParams = await params;
    const eventId = resolvedParams.id;
    const { searchParams } = new URL(request.url);
    const assistantId = searchParams.get("assistantId");

    if (!assistantId) {
      return NextResponse.json(
        { error: "assistantId query parameter is required" },
        { status: 400 }
      );
    }

    const res = await fetch(
      buildTelnyxV2Url(
        `/ai/assistants/${assistantId}/scheduled_events/${eventId}`
      ),
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!res.ok) {
      const errorText = await res.text();
      return NextResponse.json(
        { error: `Telnyx API error: ${errorText}` },
        { status: res.status }
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    adminRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return NextResponse.json(
      { error: err.message || "Failed to delete scheduled event" },
      { status: 500 }
    );
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("scheduled_events:read", GET_handler, { route: "/api/admin/scheduled-events/[id]" });
export const DELETE = withPermission("scheduled_events:delete", DELETE_handler, { route: "/api/admin/scheduled-events/[id]" });
