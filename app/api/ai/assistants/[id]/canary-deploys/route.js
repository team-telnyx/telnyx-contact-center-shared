import { NextResponse } from "next/server";
import { buildTelnyxV2Url } from "@/lib/telnyx";

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

export const GET = (request, context) => proxy(request, context, "GET");
export const POST = (request, context) => proxy(request, context, "POST");
export const PUT = (request, context) => proxy(request, context, "PUT");
export const DELETE = (request, context) => proxy(request, context, "DELETE");
