export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { buildTelnyxV2Url } from "@/lib/telnyx";

export async function GET(request, { params }) {
  try {
    const apiKey = process.env.TELNYX_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { ok: false, error: "Missing TELNYX_API_KEY" },
        { status: 500 }
      );
    }

    const { id } = await params;

    const res = await fetch(
      buildTelnyxV2Url(`/ai/conversations/insights/${encodeURIComponent(id)}`),
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        cache: "no-store",
      }
    );

    const text = await res.text();
    if (!res.ok) {
      return NextResponse.json(
        { ok: false, error: `Telnyx API error: ${res.status} ${text}` },
        { status: res.status }
      );
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    return NextResponse.json({ ok: true, insight: data?.data || data });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err?.message || String(err) },
      { status: 500 }
    );
  }
}
