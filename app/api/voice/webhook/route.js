import { NextResponse } from "next/server";

import { admitAcdVoiceEvent } from "@/lib/acd/admission.mjs";
import { handleAcdMediaEvent } from "@/lib/acd/media-events.mjs";
import { VERIFIED_INBOX_REPLAY } from "@/lib/acd/replay-effects.mjs";
import { startAgentlessAiAssistantForCall } from "@/lib/outbound-dialer/ai-assistant";
import { finalizeAgentlessAttemptByWebhook } from "@/lib/outbound-dialer/execution";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";
import { verifyTelnyxSignature } from "@/lib/telnyx-webhooks";

function voiceEvent(body) {
  return {
    eventId: body?.data?.id || body?.id || null,
    eventType: body?.data?.event_type || body?.event_type || "",
    occurredAt: body?.data?.occurred_at || null,
    payload: body?.data?.payload || body?.data || {},
    sourceRoute: "voice",
  };
}

async function runAgentlessEffects(pool, event) {
  if (!["call.answered", "call.bridged", "call.hangup"].includes(event.eventType)) {
    return null;
  }
  const callControlId = event.payload?.call_control_id || null;
  if (!callControlId) return null;

  const ledger = await finalizeAgentlessAttemptByWebhook(pool, {
    callControlId,
    eventType: event.eventType,
    hangupCause: event.payload?.hangup_cause || null,
    sipHangupCause: event.payload?.sip_hangup_cause || null,
    eventId: event.eventId,
  });
  if (!ledger || event.eventType !== "call.answered") return ledger;

  const metadata = ledger.metadata && typeof ledger.metadata === "object"
    ? ledger.metadata
    : {};
  const payloadMetadata = event.payload?.metadata && typeof event.payload.metadata === "object"
    ? event.payload.metadata
    : {};
  const handlerType =
    metadata.outbound_handler_type || ledger.handler_type || payloadMetadata.outbound_handler_type;
  const handlerRef =
    metadata.outbound_handler_ref || ledger.handler_ref || payloadMetadata.outbound_handler_ref;
  if (handlerType !== "ai_assistant" || !handlerRef || metadata.ai_assistant_started_at) {
    return ledger;
  }

  const started = await startAgentlessAiAssistantForCall({
    callControlId,
    assistantId: handlerRef,
    eventType: event.eventType,
    ledgerId: ledger.id || payloadMetadata.outbound_ledger_id || null,
    campaignId: ledger.campaign_id || payloadMetadata.outbound_campaign_id || null,
  });
  if (started.ok && ledger.id) {
    await pool.query(
      `UPDATE outbound_attempt_ledger
          SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb,
              updated_at = NOW()
        WHERE id = $2`,
      [
        JSON.stringify({
          ai_assistant_started_at: new Date().toISOString(),
          ai_assistant_id: handlerRef,
          ai_assistant_start_command_id: started.request?.command_id || null,
        }),
        ledger.id,
      ],
    );
  }
  return ledger;
}

export async function POST(request, context = {}) {
  const replay = context[VERIFIED_INBOX_REPLAY];
  try {
    const raw = await request.text();
    const signatureValid = replay || (await verifyTelnyxSignature(request, raw));
    const enforceSignature =
      String(process.env.TELNYX_ENFORCE_WEBHOOK_SIGNATURE || "true").toLowerCase() === "true";
    if (!signatureValid && enforceSignature) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }

    const body = JSON.parse(raw || "{}");
    const event = voiceEvent(body);
    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json({ ok: false, error: "Database unavailable" }, { status: 503 });
    }

    // Adapter effects run only after the durable inbox worker has applied the
    // Core event. A provider delivery merely admits the immutable envelope.
    if (replay) {
      await handleAcdMediaEvent(event.eventType, event.payload);
      return NextResponse.json({ ok: true, durable: true, replayed: true });
    }

    const admission = await admitAcdVoiceEvent(pool, event);
    if (admission?.retryable) {
      return NextResponse.json(
        { ok: false, error: "ACD durable intake unavailable", retryable: true },
        { status: admission.httpStatus || 503, headers: { "Retry-After": "1" } },
      );
    }
    if (admission?.handled) {
      return NextResponse.json({ ok: true, durable: true });
    }

    // Events outside the Contact Center ownership boundary retain their own
    // agentless campaign lifecycle. They never create legacy interactions.
    await runAgentlessEffects(pool, event);
    return NextResponse.json({ ok: true });
  } catch (error) {
    voiceRuntimeLogger.error("runtime_error", { ...runtimePayload({ error }) });
    if (error?.code === "QUEUE_AUDIO_RESUME_RETRYABLE") {
      return NextResponse.json(
        { ok: false, error: error.message, retryable: true },
        { status: 503, headers: { "Retry-After": "1" } },
      );
    }
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
