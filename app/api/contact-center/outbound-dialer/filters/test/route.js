export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getOutboundPool, jsonError, requireOutboundSupervisor, requireUuid, safeJson, testOutboundContactFilter } from "@/lib/outbound-dialer/api";

export async function POST(request) {
  const user = await requireOutboundSupervisor(); if (!user) return jsonError("Forbidden", 403);
  const pool = getOutboundPool(); if (!pool) return jsonError("Server not ready", 500);
  try {
    const body = await request.json().catch(() => ({}));
    const contactListId = requireUuid(body.contact_list_id || body.contactListId, "Target contact list");
    const result = await testOutboundContactFilter(pool, {
      contactListId,
      conditions: safeJson(body.conditions, []),
      sampleLimit: 10,
      scanLimit: 10000,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("[Outbound Dialer] test filter error:", err);
    return jsonError(err.message || "Failed to test filter", 400);
  }
}
