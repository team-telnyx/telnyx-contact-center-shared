import { NextResponse } from "next/server";
import { buildTelnyxV2Url } from "@/lib/telnyx";

export const dynamic = "force-dynamic";

/**
 * POST /api/ai/conversations
 * Creates a new AI conversation via Telnyx API
 * 
 * Body:
 *   - name: string (optional) - Conversation name
 *   - metadata: object (optional) - Custom metadata
 */
export async function POST(request) {
  try {
    const apiKey = process.env.TELNYX_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { ok: false, error: "Missing TELNYX_API_KEY" },
        { status: 500, headers: { "Cache-Control": "no-store" } }
      );
    }

    const body = await request.json().catch(() => ({}));
    const { name, metadata } = body;

    // Call Telnyx AI Conversations API
    const res = await fetch(
      buildTelnyxV2Url("/ai/conversations"),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...(name && { name }),
          ...(metadata && { metadata }),
        }),
        cache: "no-store",
      }
    );

    if (!res.ok) {
      const text = await res.text();
      console.error("[AI Conversations] Telnyx API error:", res.status, text);
      
      return NextResponse.json(
        {
          ok: false,
          error: `Telnyx API error: ${res.status}`,
          details: text,
        },
        { status: res.status >= 400 && res.status < 500 ? res.status : 502, headers: { "Cache-Control": "no-store" } }
      );
    }

    const data = await res.json();

    return NextResponse.json(
      {
        ok: true,
        id: data.id,
        name: data.name,
        created_at: data.created_at,
        metadata: data.metadata,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("[AI Conversations] Error:", err);
    return NextResponse.json(
      { ok: false, error: err.message || "Internal server error" },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}

/**
 * GET /api/ai/conversations
 * Lists AI conversations
 */
export async function GET(request) {
  try {
    const apiKey = process.env.TELNYX_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { ok: false, error: "Missing TELNYX_API_KEY" },
        { status: 500, headers: { "Cache-Control": "no-store" } }
      );
    }

    const { searchParams } = new URL(request.url);
    const pageSize = searchParams.get("pageSize") || "20";
    const pageNumber = searchParams.get("pageNumber") || "1";

    const res = await fetch(
      buildTelnyxV2Url(`/ai/conversations?page[size]=${pageSize}&page[number]=${pageNumber}`),
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        cache: "no-store",
      }
    );

    if (!res.ok) {
      const text = await res.text();
      console.error("[AI Conversations] Telnyx API error:", res.status, text);
      
      return NextResponse.json(
        {
          ok: false,
          error: `Telnyx API error: ${res.status}`,
          details: text,
        },
        { status: res.status >= 400 && res.status < 500 ? res.status : 502, headers: { "Cache-Control": "no-store" } }
      );
    }

    const data = await res.json();

    return NextResponse.json(
      {
        ok: true,
        items: data.data || [],
        meta: data.meta,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("[AI Conversations] Error:", err);
    return NextResponse.json(
      { ok: false, error: err.message || "Internal server error" },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
