import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { parseCtiClientState } from "@/lib/hardphones/drivers/telnyx-fallback.mjs";
import { buildTelnyxV2Url } from "@/lib/telnyx.js";

export const dynamic = "force-dynamic";

// Dedicated webhook for hardphone CTI click-to-dial legs (Telnyx fallback
// driver). Correlation via client_state { hardphoneCti, phoneId, target }.
// On call.answered the leg is transferred to the dial target, completing the
// click-to-dial: phone auto-answers → transfer bridges phone with target.
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
  const state = parseCtiClientState(payload?.client_state);
  if (!state?.phoneId || !eventType) return NextResponse.json({ ok: true, ignored: true });

  const callControlId = payload?.call_control_id || null;
  const setStatus = async (status) => {
    if (!callControlId) return;
    await pool.query(
      `UPDATE hp_cti_sessions SET status = $2, updated_at = NOW() WHERE call_control_id = $1`,
      [callControlId, status],
    );
  };

  try {
    switch (String(eventType)) {
      case "call.initiated":
        await setStatus("originating");
        break;
      case "call.ringing":
        await setStatus("ringing");
        break;
      case "call.answered": {
        await setStatus("answered");
        // Transfer the auto-answered phone leg to the dial target.
        if (callControlId && state.target && process.env.TELNYX_API_KEY) {
          const response = await fetch(buildTelnyxV2Url(`/calls/${encodeURIComponent(callControlId)}/actions/transfer`), {
            method: "POST",
            headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              to: state.target,
              from: process.env.HP_CTI_FROM_NUMBER || process.env.TELNYX_DEFAULT_FROM_NUMBER || undefined,
            }),
          });
          if (response.ok) await setStatus("bridged");
        }
        break;
      }
      case "call.hangup":
        await setStatus("completed");
        break;
      default:
        break;
    }
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: true, error: "handler_error" });
  }
}
