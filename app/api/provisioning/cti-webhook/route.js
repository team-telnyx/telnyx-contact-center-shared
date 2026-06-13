import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { parseCtiClientState } from "@/lib/hardphones/drivers/telnyx-fallback.mjs";
import { verifyTelnyxSignature } from "@/lib/telnyx-webhooks.js";

export const dynamic = "force-dynamic";

async function loadCtiSessionByCallControlId(pool, callControlId) {
  if (!callControlId) return null;
  const { rows } = await pool.query(
    `SELECT s.*, COALESCE(p.assigned_phone_number, '') AS caller_id
     FROM hp_cti_sessions s
     LEFT JOIN hp_phones p ON p.id = s.phone_id
     WHERE s.call_control_id = $1
        OR s.phone_call_control_id = $1
        OR s.target_call_control_id = $1
     ORDER BY s.updated_at DESC NULLS LAST, s.created_at DESC
     LIMIT 1`,
    [callControlId],
  );
  const row = rows[0];
  if (!row?.phone_id) return null;
  return {
    hardphoneCti: true,
    sessionId: row.id,
    phoneId: row.phone_id,
    target: row.target,
    callerId: row.caller_id || process.env.HP_CTI_FROM_NUMBER || process.env.TELNYX_DEFAULT_FROM_NUMBER || undefined,
    phoneCallControlId: row.phone_call_control_id || row.call_control_id || null,
    targetCallControlId: row.target_call_control_id || null,
  };
}

function statusForEvent(eventType, direction) {
  switch (String(eventType || "")) {
    case "call.initiated":
      return direction === "incoming" ? "ringing" : "originating";
    case "call.answered":
      return "answered";
    case "call.bridged":
      return "bridged";
    case "call.hangup":
      return "completed";
    default:
      return null;
  }
}

export async function POST(request) {
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 500 });

  const rawBody = await request.text();
  const signatureValid = await verifyTelnyxSignature(request, rawBody);
  if (!signatureValid) return NextResponse.json({ error: "Invalid signature" }, { status: 401 });

  let body;
  try {
    body = JSON.parse(rawBody || "{}");
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const eventType = body?.data?.event_type || body?.event_type || null;
  const payload = body?.data?.payload || body?.payload || {};
  const callControlId = payload?.call_control_id || null;
  const direction = String(payload?.direction || "").toLowerCase();
  const parsedState = parseCtiClientState(payload?.client_state);
  const state = parsedState || await loadCtiSessionByCallControlId(pool, callControlId);
  const status = statusForEvent(eventType, direction);
  if (!state?.phoneId || !eventType || !status) return NextResponse.json({ ok: true, ignored: true });

  try {
    await pool.query(
      `UPDATE hp_cti_sessions
       SET status = $2,
           call_session_id = COALESCE($3, call_session_id),
           phone_call_control_id = COALESCE(
             CASE WHEN $4 = 'phone' OR phone_call_control_id = $1 OR (phone_call_control_id IS NULL AND target_call_control_id IS DISTINCT FROM $1) THEN $1 ELSE NULL END,
             phone_call_control_id
           ),
           target_call_control_id = COALESCE(
             CASE WHEN $4 = 'target' OR target_call_control_id = $1 THEN $1 ELSE NULL END,
             target_call_control_id
           ),
           updated_at = NOW()
       WHERE phone_id = $5
         AND (
           call_control_id = $1
           OR phone_call_control_id = $1
           OR target_call_control_id = $1
           OR id = $6
         )`,
      [callControlId, status, payload?.call_session_id || null, parsedState?.leg || null, state.phoneId, state.sessionId || null],
    );
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: true, error: "handler_error" });
  }
}
