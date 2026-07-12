import { NextResponse } from "next/server";
import { buildTelnyxV2Url } from "@/lib/telnyx";

export const dynamic = "force-dynamic";

// List insights (auto-paginate) and create insight templates

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
    const pageSize = Math.min(
      200,
      Math.max(1, parseInt(searchParams.get("page[size]") || "100", 10))
    );

    let pageNumber = Math.max(
      1,
      parseInt(searchParams.get("page[number]") || "1", 10)
    );
    const allItems = [];

    for (let safety = 0; safety < 200; safety++) {
      const url = buildTelnyxV2Url(
        `/ai/conversations/insights?page[number]=${pageNumber}&page[size]=${pageSize}`
      );
      const res = await fetch(url, {
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
      const chunk = Array.isArray(data?.data) ? data.data : [];
      allItems.push(...chunk);
      const totalPages = data?.meta?.total_pages;
      const currentPage = data?.meta?.page_number || pageNumber;
      if (chunk.length < pageSize) break;
      if (totalPages && currentPage >= totalPages) break;
      pageNumber += 1;
    }

    return NextResponse.json(
      { ok: true, items: allItems },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err?.message || String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}

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
    const payload = {
      name: body?.name,
      instructions: body?.instructions,
      webhook: body?.webhook || undefined,
      json_schema: body?.json_schema || undefined,
    };

    const res = await fetch(buildTelnyxV2Url("/ai/conversations/insights"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
      body: JSON.stringify(payload),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return NextResponse.json(
        { ok: false, error: data?.error || `Telnyx API error ${res.status}` },
        { status: 502, headers: { "Cache-Control": "no-store" } }
      );
    }
    return NextResponse.json(
      { ok: true, insight: data?.data || data },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err?.message || String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
