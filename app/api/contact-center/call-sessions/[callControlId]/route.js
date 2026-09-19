import { NextResponse } from "next/server";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";
import { withPermission } from "@/lib/authz/guard";

function getTelnyxBaseUrl() {
  return process.env.TELNYX_BASE_PATH || "https://api.telnyx.com";
}

async function GET_handler(request, context, authz) {
  try {
    const user = authz.user;


    const resolvedParams = (await context?.params) || {};
    const { callControlId } = resolvedParams;
    if (!callControlId) {
      return NextResponse.json(
        { ok: false, error: "Call control ID is required" },
        { status: 400 }
      );
    }

    const baseUrl = getTelnyxBaseUrl();
    const token = process.env.TELNYX_API_KEY;
    if (!token) {
      return NextResponse.json(
        { ok: false, error: "Missing Telnyx API key" },
        { status: 500 }
      );
    }

    const callUrl = `${baseUrl}/v2/calls/${encodeURIComponent(callControlId)}`;
    const eventsParams = new URLSearchParams();
    eventsParams.set("filter[call_control_id]", callControlId);
    eventsParams.set("page[size]", "200");
    const eventsUrl = `${baseUrl}/v2/call_events?${eventsParams.toString()}`;

    const [callRes, eventsRes] = await Promise.all([
      fetch(callUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }),
      fetch(eventsUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }),
    ]);

    if (!callRes.ok) {
      const errorText = await callRes.text();
      contactCenterRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
      return NextResponse.json(
        { ok: false, error: "Failed to fetch call details from Telnyx" },
        { status: callRes.status }
      );
    }

    if (!eventsRes.ok) {
      const errorText = await eventsRes.text();
      contactCenterRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
      return NextResponse.json(
        { ok: false, error: "Failed to fetch call events from Telnyx" },
        { status: eventsRes.status }
      );
    }

    const callData = await callRes.json();
    const eventsData = await eventsRes.json();

    return NextResponse.json({
      ok: true,
      call: callData?.data || null,
      events: eventsData?.data || [],
    });
  } catch (error) {
    contactCenterRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return NextResponse.json(
      { ok: false, error: "Failed to fetch call session details" },
      { status: 500 }
    );
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission(["monitor:read", "interactions_history:read"], GET_handler, { route: "/api/contact-center/call-sessions/[callControlId]" });
