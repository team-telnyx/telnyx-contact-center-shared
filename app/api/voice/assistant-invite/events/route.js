import { NextResponse } from "next/server";
import { verifyTelnyxSignature } from "@/lib/telnyx-webhooks";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { applyAssistantInviteEvent } from "@/lib/acd/assistant-invites.mjs";

export const runtime = "nodejs";
export async function POST(request) {
  const raw = await request.text();
  if (!await verifyTelnyxSignature(request, raw)) return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  let event;
  try { event = JSON.parse(raw); } catch { return NextResponse.json({ error: "Invalid event" }, { status: 400 }); }
  try {
    await applyAssistantInviteEvent(getPostgresPool(), event);
    return NextResponse.json({ ok: true });
  } catch { return NextResponse.json({ error: "Event could not be persisted" }, { status: 503 }); }
}
