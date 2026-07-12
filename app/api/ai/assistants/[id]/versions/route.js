import { NextResponse } from "next/server";
import { buildTelnyxV2Url } from "@/lib/telnyx";

export const dynamic = "force-dynamic";

export async function GET(_request, { params }) {
  try {
    const apiKey = process.env.TELNYX_API_KEY;
    if (!apiKey) return NextResponse.json({ ok: false, error: "Missing TELNYX_API_KEY" }, { status: 500 });
    const { id } = await params;
    const response = await fetch(buildTelnyxV2Url(`/ai/assistants/${encodeURIComponent(id)}/versions`), {
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      cache: "no-store",
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return NextResponse.json({ ok: false, error: data?.errors?.[0]?.detail || "Failed to load versions" }, { status: response.status });
    return NextResponse.json({ ok: true, versions: data?.data || [] });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error?.message || String(error) }, { status: 500 });
  }
}
