import { NextResponse } from "next/server";
import { buildTelnyxV2Url } from "@/lib/telnyx";
import { normalizeAssistantPayload } from "@/lib/ai/assistant-payload.mjs";
import { telnyxErrorDetail } from "@/lib/telnyx-error.mjs";

export const dynamic = "force-dynamic";

// GET single assistant
export async function GET(request, { params }) {
  try {
    const apiKey = process.env.TELNYX_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { ok: false, error: "Missing TELNYX_API_KEY" },
        { status: 500, headers: { "Cache-Control": "no-store" } }
      );
    }

    const { id } = await params;

    const res = await fetch(buildTelnyxV2Url(`/ai/assistants/${id}`), {
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
        { ok: false, error: telnyxErrorDetail(text, `Telnyx API error: ${res.status}`) },
        { status: res.status === 404 ? 404 : 502, headers: { "Cache-Control": "no-store" } }
      );
    }

    const data = await res.json();
    return NextResponse.json(
      { ok: true, assistant: data?.data || data },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err?.message || String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}

// PUT update assistant (forwards as POST to Telnyx - their API uses POST for updates)
export async function PUT(request, { params }) {
  try {
    const apiKey = process.env.TELNYX_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { ok: false, error: "Missing TELNYX_API_KEY" },
        { status: 500, headers: { "Cache-Control": "no-store" } }
      );
    }

    const { id } = await params;
    const payload = normalizeAssistantPayload(await request.json().catch(() => ({})));

    const res = await fetch(buildTelnyxV2Url(`/ai/assistants/${id}`), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      cache: "no-store",
    });

    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json(
        { ok: false, error: telnyxErrorDetail(text, `Telnyx API error: ${res.status}`) },
        { status: res.status === 404 ? 404 : 502, headers: { "Cache-Control": "no-store" } }
      );
    }

    const data = await res.json();
    return NextResponse.json(
      { ok: true, assistant: data?.data || data },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err?.message || String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}

// Telnyx uses POST for assistant updates; keep PUT for the contact-center
// editor and expose POST for demo-portal components such as WidgetTab.
export async function POST(request, context) {
  return PUT(request, context);
}

// DELETE assistant
export async function DELETE(request, { params }) {
  try {
    const apiKey = process.env.TELNYX_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { ok: false, error: "Missing TELNYX_API_KEY" },
        { status: 500, headers: { "Cache-Control": "no-store" } }
      );
    }

    const { id } = await params;

    const res = await fetch(buildTelnyxV2Url(`/ai/assistants/${id}`), {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
    });

    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json(
        { ok: false, error: telnyxErrorDetail(text, `Telnyx API error: ${res.status}`) },
        { status: res.status === 404 ? 404 : 502, headers: { "Cache-Control": "no-store" } }
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
