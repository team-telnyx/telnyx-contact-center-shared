import { NextResponse } from "next/server";
import { buildTelnyxV2Url } from "@/lib/telnyx";
import { withPermission } from "@/lib/authz/guard";

export const dynamic = "force-dynamic";

async function proxy(request, { params }, method) {
  try {
    const apiKey = process.env.TELNYX_API_KEY;
    if (!apiKey) return NextResponse.json({ ok: false, error: "Missing TELNYX_API_KEY" }, { status: 500 });
    const { id } = await params;
    const init = { method, headers: { Authorization: `Bearer ${apiKey}` }, cache: "no-store" };
    if (method === "POST" || method === "PUT") {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(await request.json().catch(() => ({})));
    }
    const response = await fetch(buildTelnyxV2Url(`/ai/assistants/${encodeURIComponent(id)}/canary-deploys`), init);
    if (method === "GET" && response.status === 404) return NextResponse.json({ ok: true, canary: null });
    if (method === "DELETE" && response.status === 204) return NextResponse.json({ ok: true });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return NextResponse.json({ ok: false, error: data?.errors?.[0]?.detail || data?.detail || `Traffic request failed: ${response.status}` }, { status: response.status });
    return NextResponse.json(method === "GET" || method === "POST" || method === "PUT" ? { ok: true, canary: data?.data || data } : { ok: true });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error?.message || String(error) }, { status: 500 });
  }
}

// Phase 0 hardening: every export goes through the permission guard (the internal documentation).
const route = "/api/ai/assistants/[id]/canary-deploys";
export const GET = withPermission("ai_assistants:read", (request, context) => proxy(request, context, "GET"), { route });
export const POST = withPermission("ai_assistants:update", (request, context) => proxy(request, context, "POST"), { route });
export const PUT = withPermission("ai_assistants:update", (request, context) => proxy(request, context, "PUT"), { route });
export const DELETE = withPermission("ai_assistants:update", (request, context) => proxy(request, context, "DELETE"), { route });
