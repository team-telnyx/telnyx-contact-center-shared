import { NextResponse } from "next/server";
import { getOutboundPool, jsonError, requireUuid, safeJson, testOutboundContactFilter } from "@/lib/outbound-dialer/api";
import { campaignsLogger, outboundErrorPayload } from "@/lib/outbound-dialer/logging.mjs";
import { withPermission } from "@/lib/authz/guard";

async function POST_handler(request, _context, authz) {
  const user = authz.user;
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
    campaignsLogger.error("filter_test_failed", { ...outboundErrorPayload(err) });
    return jsonError(err.message || "Failed to test filter", 400);
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const POST = withPermission("dialer_filters:test", POST_handler, { route: "/api/contact-center/outbound-dialer/filters/test" });
