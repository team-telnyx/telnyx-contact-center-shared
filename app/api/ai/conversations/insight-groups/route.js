import { NextResponse } from "next/server";
import { buildTelnyxV2Url } from "@/lib/telnyx";

import { withPermission } from "@/lib/authz/guard";
export const dynamic = "force-dynamic";

async function GET_handler(request) {
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
    const allGroups = [];

    for (let safety = 0; safety < 200; safety++) {
      const url = buildTelnyxV2Url(
        `/ai/conversations/insight-groups?page[number]=${pageNumber}&page[size]=${pageSize}`
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
      allGroups.push(...chunk);
      const totalPages = data?.meta?.total_pages;
      const currentPage = data?.meta?.page_number || pageNumber;
      if (chunk.length < pageSize) break;
      if (totalPages && currentPage >= totalPages) break;
      pageNumber += 1;
    }

    const insightNameById = {};
    for (const group of allGroups) {
      const list = Array.isArray(group?.insights) ? group.insights : [];
      for (const ins of list) {
        if (ins?.id && typeof ins?.name === "string") {
          insightNameById[ins.id] = ins.name;
        }
      }
    }

    return NextResponse.json(
      { ok: true, items: allGroups, insightNameById },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err?.message || String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}

async function POST_handler(request) {
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
      description: body?.description,
      webhook: body?.webhook || undefined,
    };

    const res = await fetch(
      buildTelnyxV2Url("/ai/conversations/insight-groups"),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        cache: "no-store",
        body: JSON.stringify(payload),
      }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return NextResponse.json(
        { ok: false, error: data?.error || `Telnyx API error ${res.status}` },
        { status: 502, headers: { "Cache-Control": "no-store" } }
      );
    }
    return NextResponse.json(
      { ok: true, group: data?.data || data },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err?.message || String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}

// Phase 0 hardening: every export goes through the permission guard (the internal documentation).
export const GET = withPermission(["ai_insights:read","interactions:read"], GET_handler, { route: "/api/ai/conversations/insight-groups" });
export const POST = withPermission("ai_insights:create", POST_handler, { route: "/api/ai/conversations/insight-groups" });
