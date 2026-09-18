import { NextResponse } from "next/server";
import { buildTelnyxV2Url } from "@/lib/telnyx";
import { withPermission } from "@/lib/authz/guard";

export const dynamic = "force-dynamic";

async function PATCH_handler(request, { params }, authz) {
  try {
    const user = authz.user;
    const apiKey = process.env.TELNYX_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { ok: false, error: "Missing TELNYX_API_KEY" },
        { status: 500, headers: { "Cache-Control": "no-store" } }
      );
    }
    const resolvedParams = await params;
    const id = resolvedParams?.id;
    if (!id)
      return NextResponse.json(
        { ok: false, error: "Missing id" },
        { status: 400 }
      );
    const body = await request.json();
    const payload = {};
    if (typeof body.connection_id === "string" || body.connection_id === null)
      payload.connection_id = body.connection_id;
    if (Array.isArray(body.tags)) payload.tags = body.tags.map(String);
    if (Object.keys(payload).length === 0)
      return NextResponse.json(
        { ok: false, error: "No updatable fields" },
        { status: 400 }
      );

    const url = buildTelnyxV2Url(`/phone_numbers/${encodeURIComponent(id)}`);
    const res = await fetch(url, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: data?.errors?.[0]?.detail || `Telnyx ${res.status}`,
        },
        { status: 502, headers: { "Cache-Control": "no-store" } }
      );
    }
    return NextResponse.json({ ok: true, number: data?.data || null });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err?.message || String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const PATCH = withPermission("numbers:update", PATCH_handler, { route: "/api/phone-numbers/[id]" });
