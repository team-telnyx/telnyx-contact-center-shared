import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { handleGeneratorWebhookEvent, parseGeneratorClientState } from "@/lib/call-generator/engine.mjs";
import { adminRuntimeLogger, runtimePayload } from "@/lib/runtime-logging.mjs";

// Dedicated Telnyx webhook endpoint for generated calls. Generated calls set
// webhook_url to this route, so events never collide with the voice flow or
// outbound dialer webhooks. Correlation runs through client_state
// { callGenerator: true, runId, ledgerId }.
//
// Note: events are processed regardless of the Settings master switch so that
// calls already in flight when the generator is disabled still complete their
// ledger lifecycle. Foreign events are dropped by client_state correlation.
export async function POST(request) {
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 500 });

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const eventType = body?.data?.event_type || body?.event_type || null;
  const payload = body?.data?.payload || body?.payload || {};
  if (!eventType) return NextResponse.json({ ok: true, ignored: true });

  const generatorState = parseGeneratorClientState(payload?.client_state);
  const webhookEventId = body?.data?.id || body?.id || null;

  // Belt-and-suspenders: a generated leg carries this endpoint as its webhook_url
  // override. If a contact-center / transcription event for a generated call ever
  // lands here (instead of the flow connection webhook), forward it so Agent
  // Assist live transcription and contact-center interaction state are not
  // silently lost. This is additive: generator ledger handling below still runs
  // for lifecycle correlation. Foreign events are dropped by requiring the
  // generator client_state before forwarding into contact-center handlers.
  try {
    if (generatorState && eventType === "call.transcription") {
      const { handleTranscriptionEvent } = await import("@/lib/contact-center/webhook-handler.js");
      await handleTranscriptionEvent(payload);
    } else if (
      generatorState &&
      (eventType === "call.answered" ||
        eventType === "call.bridged" ||
        eventType === "call.dequeued" ||
        eventType === "call.held" ||
        eventType === "call.unheld" ||
        eventType === "call.hangup")
    ) {
      const { handleContactCenterEvent } = await import("@/lib/contact-center/webhook-handler.js");
      await handleContactCenterEvent(eventType, payload, { eventId: webhookEventId });
    }
  } catch (forwardErr) {
    adminRuntimeLogger.warn(
      "call_generator_webhook_cc_forward_failed",
      runtimePayload({ error: forwardErr, operation: "cg_webhook_cc_forward" }),
    );
  }

  try {
    const applied = await handleGeneratorWebhookEvent(pool, eventType, payload);
    return NextResponse.json({ ok: true, applied: applied || null });
  } catch (err) {
    adminRuntimeLogger.error("call_generator_webhook_failed", runtimePayload({ error: err, operation: "cg_webhook" }));
    // Acknowledge anyway — the watchdog reaps stuck ledger rows.
    return NextResponse.json({ ok: true, error: "handler_error" });
  }
}
