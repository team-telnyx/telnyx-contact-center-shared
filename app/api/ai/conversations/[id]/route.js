import { NextResponse } from "next/server";
import { buildTelnyxV2Url } from "@/lib/telnyx";
import { withPermission } from "@/lib/authz/guard";

export const dynamic = "force-dynamic";

async function GET_handler(request, context, authz) {
  try {
    const user = authz.user;

    const { searchParams } = new URL(request.url);
    const useDemoApiKey = searchParams.get("useDemoApiKey") === "true";
    
    // Use demo API key if requested, otherwise use regular API key
    const apiKey = useDemoApiKey
      ? process.env.TELNYX_DEMO_PORTAL_API_KEY
      : process.env.TELNYX_API_KEY;
    
    if (!apiKey) {
      return NextResponse.json(
        { ok: false, error: useDemoApiKey ? "Missing TELNYX_DEMO_PORTAL_API_KEY" : "Missing TELNYX_API_KEY" },
        { status: 500, headers: { "Cache-Control": "no-store" } }
      );
    }

    const { params } = await context;
    const { id } = await params;
    if (!id) {
      return NextResponse.json(
        { ok: false, error: "Missing conversation id" },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }

    const url = buildTelnyxV2Url(`/ai/conversations/${encodeURIComponent(id)}`);
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
    });

    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json(
        { ok: false, error: `Telnyx API error: ${res.status} ${text}` },
        { status: 502, headers: { "Cache-Control": "no-store" } }
      );
    }

    const data = await res.json();
    // Telnyx API returns { data: {...} } structure
    return NextResponse.json(
      { ok: true, data: data?.data || data },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err?.message || String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission(["ai_insights:read", "agent:self"], GET_handler, { route: "/api/ai/conversations/[id]" });
