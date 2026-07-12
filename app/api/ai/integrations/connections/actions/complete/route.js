import { NextResponse } from "next/server";
import { buildTelnyxV2Url } from "@/lib/telnyx";

export const dynamic = "force-dynamic";

export async function POST(request) {
  try {
    const apiKey = process.env.TELNYX_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { ok: false, error: "Missing TELNYX_API_KEY" },
        { status: 500, headers: { "Cache-Control": "no-store" } }
      );
    }

    const payload = await request.json().catch(() => ({}));
    const integrationName = String(payload?.integration_name || "").trim();
    if (!integrationName) {
      return NextResponse.json(
        { ok: false, error: "integration_name is required" },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }

    const allowedTools = Array.isArray(payload?.allowed_tools)
      ? payload.allowed_tools
      : [];

    const res = await fetch(
      buildTelnyxV2Url("/ai/integrations/connections/actions/complete"),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          integration_name: integrationName,
          allowed_tools: allowedTools,
        }),
        cache: "no-store",
      }
    );

    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }

    if (!res.ok) {
      return NextResponse.json(
        { ok: false, error: `Telnyx API error: ${res.status} ${text}` },
        { status: 502, headers: { "Cache-Control": "no-store" } }
      );
    }

    return NextResponse.json(
      { ok: true, data: data?.data ?? data },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err?.message || String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
