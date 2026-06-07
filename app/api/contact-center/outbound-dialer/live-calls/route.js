import { NextResponse } from "next/server";
import { getOutboundPool, requireOutboundSupervisor } from "@/lib/outbound-dialer/api";
import { buildOutboundLiveCallsPayload, OUTBOUND_LIVE_CALLS_SQL } from "@/lib/outbound-dialer/live-calls";
import { liveCallsLogger, outboundErrorPayload } from "@/lib/outbound-dialer/logging.mjs";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await requireOutboundSupervisor();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const pool = getOutboundPool();
    if (!pool) return NextResponse.json({ error: "Postgres is not configured" }, { status: 503 });

    const { rows } = await pool.query(OUTBOUND_LIVE_CALLS_SQL);
    return NextResponse.json(buildOutboundLiveCallsPayload(rows));
  } catch (error) {
    liveCallsLogger.error("live_calls_load_failed", { ...outboundErrorPayload(error) });
    return NextResponse.json({ error: error?.message || "Failed to load live calls" }, { status: 500 });
  }
}
