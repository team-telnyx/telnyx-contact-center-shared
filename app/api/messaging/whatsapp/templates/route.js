import { NextResponse } from "next/server";
import { buildTelnyxV2Url } from "@/lib/telnyx";
import { withPermission } from "@/lib/authz/guard";

export const dynamic = "force-dynamic";


async function GET_handler(request, _context, authz) {
  const user = authz.user;

  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { ok: false, error: "Missing TELNYX_API_KEY" },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }

  try {
    const query = new URL(request.url).searchParams.toString();
    const url = buildTelnyxV2Url(
      `/whatsapp/message_templates${query ? `?${query}` : ""}`
    );
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return NextResponse.json(
        {
          ok: false,
          error:
            data?.errors?.[0]?.detail ||
            data?.errors?.[0]?.title ||
            `Telnyx API error: ${response.status}`,
          telnyx: data,
        },
        { status: 502, headers: { "Cache-Control": "no-store" } }
      );
    }
    return NextResponse.json(
      { ok: true, data: data?.data ?? data, meta: data?.meta },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error?.message || String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("messaging_admin:read", GET_handler, { route: "/api/messaging/whatsapp/templates" });
