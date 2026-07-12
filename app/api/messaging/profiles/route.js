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
    const url = new URL(buildTelnyxV2Url("/messaging_profiles"));
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
    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json(
        { ok: false, error: `Telnyx API error: ${res.status} ${text}` },
        { status: 502, headers: { "Cache-Control": "no-store" } }
      );
    }
    const data = await res.json();
    const profiles = Array.isArray(data?.data) ? data.data : [];
    return NextResponse.json(
      { ok: true, profiles },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err?.message || String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
