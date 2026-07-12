import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import {
  buildGeneratorClientState,
  handleGeneratorWebhookEvent,
  parseGeneratorClientState,
} from "@/lib/call-generator/engine.mjs";
import { adminRuntimeLogger, runtimePayload } from "@/lib/runtime-logging.mjs";

async function findGeneratorStateByLedger(pool, payload) {
  const callControlId = payload?.call_control_id || null;
  const callSessionId = payload?.call_session_id || null;
  if (!callControlId && !callSessionId) return null;

  const { rows } = await pool.query(
    `SELECT id, run_id
     FROM cg_call_ledger
     WHERE ($1::text IS NOT NULL AND call_control_id = $1)
        OR ($2::text IS NOT NULL AND call_session_id = $2)
     ORDER BY created_at DESC
     LIMIT 1`,
    [callControlId, callSessionId],
  );
  const row = rows[0];
  if (!row?.id) return null;

  return {
    callGenerator: true,
    runId: row.run_id,
    ledgerId: row.id,
  };
}

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

  let generatorState = parseGeneratorClientState(payload?.client_state);
  if (!generatorState) {
    try {
      generatorState = await findGeneratorStateByLedger(pool, payload);
    } catch (lookupErr) {
      adminRuntimeLogger.warn(
        "call_generator_webhook_ledger_lookup_failed",
        runtimePayload({ error: lookupErr, operation: "cg_webhook_ledger_lookup" }),
      );
    }
  }
  const generatorPayload = generatorState
    ? {
        ...payload,
        client_state: buildGeneratorClientState({ runId: generatorState.runId, ledgerId: generatorState.ledgerId }),
      }
    : payload;
  const webhookEventId = body?.data?.id || body?.id || null;

  // Belt-and-suspenders: a generated leg carries this endpoint as its webhook_url
  // override. If a contact-center / transcription event for a generated call ever
  // lands here (instead of the flow connection webhook), forward it so Agent
  // Assist live transcription and contact-center interaction state are not
  // silently lost. This is additive: generator ledger handling below still runs
  // for lifecycle correlation. Foreign events are dropped by requiring a matched
  // generator ledger/state before forwarding into contact-center handlers. Keep
  // the original payload for forwarding because its client_state may contain the
  // flow/contact-center STT config; generatorPayload is only for ledger handling.
  try {
    if (generatorState && eventType === "call.transcription") {
      const { handleTranscriptionEvent } = await import("@/lib/contact-center/webhook-handler.js");
      // The generated call is the agent leg. Telnyx reports the physical media
      // direction: the agent's voice arrives as "inbound" (client→server) and
      // conference audio sent to the agent is "outbound" (server→client).
      // Standalone STT remaps this to conversational role: agent audio →
      // outputTrack "outbound", customer audio → "inbound". Normalize here so
      // the per-leg and cross-leg dedup keys match across both paths and the
      // shared cache can suppress the cross-path duplicate.
      const td = payload?.transcription_data;
      const agentPayload =
        td?.transcription_track === "inbound" || td?.transcription_track === "outbound"
          ? {
              ...payload,
              transcription_data: {
                ...td,
                transcription_track:
                  td.transcription_track === "inbound" ? "outbound" : "inbound",
              },
            }
          : payload;
      await handleTranscriptionEvent(agentPayload);
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
    const applied = await handleGeneratorWebhookEvent(pool, eventType, generatorPayload);
    return NextResponse.json({ ok: true, applied: applied || null });
  } catch (err) {
    adminRuntimeLogger.error("call_generator_webhook_failed", runtimePayload({ error: err, operation: "cg_webhook" }));
    // Acknowledge anyway — the watchdog reaps stuck ledger rows.
    return NextResponse.json({ ok: true, error: "handler_error" });
  }
}
