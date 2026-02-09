import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { buildTelnyxV2Url } from "@/lib/telnyx";

export const dynamic = "force-dynamic";

export async function GET(request, context) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401, headers: { "Cache-Control": "no-store" } }
      );
    }

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

    const upstream = new URL(
      buildTelnyxV2Url(
        `/ai/conversations/${encodeURIComponent(id)}/conversations-insights`
      )
    );
    // Don't forward the useDemoApiKey parameter to Telnyx API
    searchParams.forEach((value, key) => {
      if (key !== "useDemoApiKey") {
        upstream.searchParams.set(key, value);
      }
    });

    const res = await fetch(upstream.toString(), {
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
    const insights = Array.isArray(data?.data) ? data.data : [];
    return NextResponse.json(
      { ok: true, insights, data },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err?.message || String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}

