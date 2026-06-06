export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { buildTelnyxV2Url } from "@/lib/telnyx";

/**
 * POST /api/ai/assistants/[id]/chat
 * Proxies chat messages to Telnyx AI Assistant Chat API
 * 
 * Body:
 *   - content: string (required) - The message to send
 *   - conversation_id: string (required) - Conversation thread ID
 *   - name: string (optional) - Display name of the user
 */
export async function POST(request, context) {
  try {
    const apiKey = process.env.TELNYX_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { ok: false, error: "Missing TELNYX_API_KEY" },
        { status: 500, headers: { "Cache-Control": "no-store" } }
      );
    }

    const { params } = await context;
    const { id } = await params;
    if (!id) {
      return NextResponse.json(
        { ok: false, error: "Missing assistant id" },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }

    const body = await request.json();
    const { content, conversation_id, name } = body;

    if (!content) {
      return NextResponse.json(
        { ok: false, error: "Missing content in request body" },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }

    if (!conversation_id) {
      return NextResponse.json(
        { ok: false, error: "Missing conversation_id in request body" },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }

    // Call Telnyx AI Assistant Chat API
    const chatRes = await fetch(
      buildTelnyxV2Url(`/ai/assistants/${encodeURIComponent(id)}/chat`),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          content,
          conversation_id,
          ...(name && { name }),
        }),
        cache: "no-store",
      }
    );

    if (!chatRes.ok) {
      const text = await chatRes.text();
      console.error("[AI Chat] Telnyx API error:", chatRes.status, text);
      
      return NextResponse.json(
        {
          ok: false,
          error: `Telnyx API error: ${chatRes.status}`,
          details: text,
        },
        { status: chatRes.status >= 400 && chatRes.status < 500 ? chatRes.status : 502, headers: { "Cache-Control": "no-store" } }
      );
    }

    const data = await chatRes.json();

    return NextResponse.json(
      {
        ok: true,
        content: data.content || data.response || "",
        conversation_id,
        raw: data,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("[AI Chat] Error:", err);
    return NextResponse.json(
      { ok: false, error: err.message || "Internal server error" },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
