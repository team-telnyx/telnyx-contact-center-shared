import { NextResponse } from "next/server";
import { buildTelnyxV2Url } from "@/lib/telnyx";

import { withPermission } from "@/lib/authz/guard";
export const dynamic = "force-dynamic";

async function GET_handler(_request, context) {
  try {
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
        { ok: false, error: "Missing tool id" },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }

    const res = await fetch(
      buildTelnyxV2Url(`/ai/tools/${encodeURIComponent(id)}`),
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        cache: "no-store",
      }
    );
    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json(
        { ok: false, error: `Telnyx API error: ${res.status} ${text}` },
        { status: 502, headers: { "Cache-Control": "no-store" } }
      );
    }
    const data = await res.json();
    return NextResponse.json(
      { ok: true, tool: data?.data || data },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err?.message || String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}

async function PATCH_handler(request, context) {
  try {
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
        { ok: false, error: "Missing tool id" },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }

    const payload = await request.json().catch(() => ({}));

    const res = await fetch(
      buildTelnyxV2Url(`/ai/tools/${encodeURIComponent(id)}`),
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload || {}),
      }
    );
    const text = await res.text();
    if (!res.ok) {
      return NextResponse.json(
        { ok: false, error: `Telnyx API error: ${res.status} ${text}` },
        { status: 502, headers: { "Cache-Control": "no-store" } }
      );
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { data: null, raw: text };
    }
    return NextResponse.json(
      { ok: true, tool: data?.data || data },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err?.message || String(err) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}

async function POST_handler(request, context) {
  return PATCH(request, context);
}

async function DELETE_handler(_request, context) {
  try {
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
        { ok: false, error: "Missing tool id" },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }

    const res = await fetch(
      buildTelnyxV2Url(`/ai/tools/${encodeURIComponent(id)}`),
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      }
    );
    const text = await res.text();
    if (!res.ok) {
      return NextResponse.json(
        { ok: false, error: `Telnyx API error: ${res.status} ${text}` },
        { status: 502, headers: { "Cache-Control": "no-store" } }
      );
    }
    return NextResponse.json(
      { ok: true },
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
export const GET = withPermission("ai_tools:read", GET_handler, { route: "/api/ai/tools/[id]" });
export const POST = withPermission("ai_tools:update", POST_handler, { route: "/api/ai/tools/[id]" });
export const PATCH = withPermission("ai_tools:update", PATCH_handler, { route: "/api/ai/tools/[id]" });
export const DELETE = withPermission("ai_tools:delete", DELETE_handler, { route: "/api/ai/tools/[id]" });
