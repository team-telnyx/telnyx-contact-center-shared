import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";

export const dynamic = "force-dynamic";

const TELNYX_BASE = process.env.TELNYX_BASE_PATH || "https://api.telnyx.com";

/**
 * GET /api/ai/conversations/[id]/session-analysis
 *
 * Fetches session analysis from Telnyx Session Analysis API:
 * GET /v2/session_analysis/{record_type}/{event_id}
 *
 * The conversation `id` is used as event_id with record_type=call-session
 * (fallback: try multiple record types if first one returns 404)
 */
export async function GET(request, context) {
  try {
    // Auth check — required before proxying any Telnyx data
    const user = await getAuthenticatedUser(request.url);
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401, headers: { "Cache-Control": "no-store" } }
      );
    }

    const { searchParams: sp } = new URL(request.url);
    const useDemoApiKey = sp.get("useDemoApiKey") === "true";
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

    const { searchParams } = new URL(request.url);
    const recordType = searchParams.get("record_type") || "call-session";
    const includeChildren = searchParams.get("include_children") ?? "true";
    const maxDepth = searchParams.get("max_depth") ?? "5";
    const dateTime = searchParams.get("date_time");
    // useDemoApiKey already consumed above for key selection

    // Build the Telnyx session analysis URL
    const url = new URL(
      `${TELNYX_BASE}/v2/session_analysis/${encodeURIComponent(recordType)}/${encodeURIComponent(id)}`
    );
    url.searchParams.set("include_children", includeChildren);
    url.searchParams.set("max_depth", maxDepth);
    url.searchParams.set("expand", "record");

    if (dateTime) {
      url.searchParams.set("date_time", dateTime);
    }

    const res = await fetch(url.toString(), {
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
        {
          ok: false,
          error: `Telnyx API error: ${res.status} ${text}`,
          status: res.status,
        },
        { status: res.status >= 500 ? 502 : res.status, headers: { "Cache-Control": "no-store" } }
      );
    }

    const data = await res.json();
    return NextResponse.json(
      { ok: true, data },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err?.message || String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
