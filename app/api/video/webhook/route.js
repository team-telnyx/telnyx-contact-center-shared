import { NextResponse } from "next/server";

import { applyVideoRoomEvent } from "@/lib/video/lifecycle.mjs";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { contactCenterRuntimeLogger, runtimePayload } from "@/lib/runtime-logging.mjs";
import { verifyTelnyxSignature } from "@/lib/telnyx-webhooks";

function roomEvent(body) {
  return {
    eventId: body?.data?.id || body?.id || null,
    eventType: body?.data?.event_type || body?.event_type || "",
    occurredAt: body?.data?.occurred_at || null,
    payload: body?.data?.payload || {},
  };
}

// Telnyx Video Rooms webhooks (session, participants, recordings, compositions).
// Signed with the primary account key like the Call Control webhook.
export async function POST(request) {
  try {
    const raw = await request.text();
    const signatureValid = await verifyTelnyxSignature(request, raw);
    const enforceSignature = String(process.env.TELNYX_ENFORCE_WEBHOOK_SIGNATURE || "true").toLowerCase() === "true";
    if (!signatureValid && enforceSignature) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
    const pool = getPostgresPool();
    if (!pool) return NextResponse.json({ ok: false, error: "Database unavailable" }, { status: 503 });
    const result = await applyVideoRoomEvent(pool, roomEvent(JSON.parse(raw || "{}")));
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    contactCenterRuntimeLogger.error("video_webhook_failed", { ...runtimePayload({ error }) });
    return NextResponse.json({ ok: false, error: "Server error", retryable: true }, { status: 500 });
  }
}
