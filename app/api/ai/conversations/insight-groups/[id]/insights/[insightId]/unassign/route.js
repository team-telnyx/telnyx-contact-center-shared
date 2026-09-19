import { NextResponse } from "next/server";
import { buildTelnyxV2Url } from "@/lib/telnyx";

import { withPermission } from "@/lib/authz/guard";
export const dynamic = "force-dynamic";

async function DELETE_handler(_request, context) {
  try {
    const apiKey = process.env.TELNYX_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { ok: false, error: "Missing TELNYX_API_KEY" },
        { status: 500, headers: { "Cache-Control": "no-store" } }
      );
    }
    const { params } = await context;
    const { id, insightId } = await params;
    if (!id || !insightId) {
      return NextResponse.json(
        { ok: false, error: "Missing group id or insight id" },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }
    const url = buildTelnyxV2Url(
      `/ai/conversations/insight-groups/${encodeURIComponent(
        id
      )}/insights/${encodeURIComponent(insightId)}/unassign`
    );
    const res = await fetch(url, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${apiKey}` },
      cache: "no-store",
    });
    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json(
        { ok: false, error: `Telnyx API error: ${res.status} ${text}` },
        { status: 502, headers: { "Cache-Control": "no-store" } }
      );
    }
    return NextResponse.json(
      { ok: true },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err?.message || String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}

// Phase 0 hardening: every export goes through the permission guard (the internal documentation).
export const DELETE = withPermission("ai_insights:update", DELETE_handler, { route: "/api/ai/conversations/insight-groups/[id]/insights/[insightId]/unassign" });
