import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { buildTelnyxV2Url } from "@/lib/telnyx";

export const dynamic = "force-dynamic";

export async function GET(request) {
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

    const { searchParams } = new URL(request.url);
    const upstream = new URL(buildTelnyxV2Url("/ai/conversations/insight-groups"));
    searchParams.forEach((value, key) => {
      upstream.searchParams.set(key, value);
    });

    const res = await fetch(upstream.toString(), {
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
    const groups = Array.isArray(data?.data) ? data.data : [];
    const insightNameById = {};
    groups.forEach((group) => {
      const list = Array.isArray(group?.insights) ? group.insights : [];
      list.forEach((insight) => {
        if (insight?.id && insight?.name) {
          insightNameById[insight.id] = insight.name;
        }
      });
    });

    return NextResponse.json(
      { ok: true, data, groups, insightNameById },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err?.message || String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}

