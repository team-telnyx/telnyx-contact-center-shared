import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { buildTelnyxV2Url } from "@/lib/telnyx";

export const dynamic = "force-dynamic";

export async function GET(_request, context) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401, headers: { "Cache-Control": "no-store" } }
      );
    }

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
        { ok: false, error: "Missing conversation id" },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }

    const pageSize = 100;
    let pageNumber = 1;
    const allMessages = [];

    for (let safety = 0; safety < 100; safety++) {
      const url = buildTelnyxV2Url(
        `/ai/conversations/${encodeURIComponent(
          id
        )}/messages?page[number]=${pageNumber}&page[size]=${pageSize}`
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
      allMessages.push(...chunk);
      const totalPages = data?.meta?.total_pages;
      const currentPage = data?.meta?.page_number || pageNumber;
      if (chunk.length < pageSize) break;
      if (totalPages && currentPage >= totalPages) break;
      pageNumber += 1;
    }
    return NextResponse.json(
      { ok: true, messages: allMessages },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err?.message || String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}

