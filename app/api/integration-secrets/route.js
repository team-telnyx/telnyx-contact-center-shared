import { NextResponse } from "next/server";
import { buildTelnyxV2Url } from "@/lib/telnyx.js";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const apiKey = process.env.TELNYX_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { ok: false, error: "Missing TELNYX_API_KEY" },
        { status: 500, headers: { "Cache-Control": "no-store" } }
      );
    }

    // Fetch all integration secrets with pagination to ensure we get all items
    const pageSize = 250;
    let pageNumber = 1;
    const allSecrets = [];

    for (let safety = 0; safety < 10; safety++) {
      const url = buildTelnyxV2Url(
        `/integration_secrets?page[number]=${pageNumber}&page[size]=${pageSize}`
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

      // Map the secrets to our format
      const mappedChunk = chunk.map((s) => ({
        id: s?.id || "",
        identifier: s?.identifier || "",
        type: s?.type || "",
        created_at: s?.created_at || s?.createdAt || undefined,
      }));

      allSecrets.push(...mappedChunk);

      // Check if we've received all pages
      const totalPages = data?.meta?.total_pages;
      const currentPage = data?.meta?.page_number || pageNumber;
      if (chunk.length < pageSize) break;
      if (totalPages && currentPage >= totalPages) break;

      pageNumber += 1;
    }

    return NextResponse.json(
      { ok: true, secrets: allSecrets },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err?.message || String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
