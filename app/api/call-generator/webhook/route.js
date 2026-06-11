import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { handleGeneratorWebhookEvent } from "@/lib/call-generator/engine.mjs";
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

  try {
    const applied = await handleGeneratorWebhookEvent(pool, eventType, payload);
    return NextResponse.json({ ok: true, applied: applied || null });
  } catch (err) {
    adminRuntimeLogger.error("call_generator_webhook_failed", runtimePayload({ error: err, operation: "cg_webhook" }));
    // Acknowledge anyway — the watchdog reaps stuck ledger rows.
    return NextResponse.json({ ok: true, error: "handler_error" });
  }
}
