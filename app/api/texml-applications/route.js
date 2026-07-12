import { NextResponse } from "next/server";
import { buildTelnyxV2Url } from "@/lib/telnyx";

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const apiKey = process.env.TELNYX_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { ok: false, error: "Missing TELNYX_API_KEY" },
        { status: 500, headers: { "Cache-Control": "no-store" } }
      );
    }

    // Parse query parameters
    const { searchParams } = new URL(request.url);
    const pageSize = searchParams.get("pageSize") || "20";
    const pageNumber = searchParams.get("page") || "1";

    // Build URL with pagination parameters
    const url = new URL(buildTelnyxV2Url("/texml_applications"));
    url.searchParams.set("page[size]", pageSize);
    url.searchParams.set("page[number]", pageNumber);

    const res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
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
    return NextResponse.json(
      { ok: true, apps: Array.isArray(data?.data) ? data.data : [] },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err?.message || String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
