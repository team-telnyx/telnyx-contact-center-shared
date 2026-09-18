// GET, PATCH, DELETE for single pronunciation dictionary
import { NextResponse } from "next/server";
import { withPermission } from "@/lib/authz/guard";

const TELNYX_BASE = "https://api.telnyx.com/v2";

async function GET_handler(request, context, authz) {
  const user = authz.user;
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "Missing TELNYX_API_KEY" }, { status: 500 });
  const { id } = await context.params;
  const res = await fetch(`${TELNYX_BASE}/pronunciation_dicts/${id}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}

async function PATCH_handler(request, context, authz) {
  const user = authz.user;
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "Missing TELNYX_API_KEY" }, { status: 500 });
  const { id } = await context.params;
  const body = await request.json();
  const res = await fetch(`${TELNYX_BASE}/pronunciation_dicts/${id}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}

async function DELETE_handler(request, context, authz) {
  const user = authz.user;
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "Missing TELNYX_API_KEY" }, { status: 500 });
  const { id } = await context.params;
  const res = await fetch(`${TELNYX_BASE}/pronunciation_dicts/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (res.status === 204) return new NextResponse(null, { status: 204 });
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("pronunciation_dicts:read", GET_handler, { route: "/api/ai/pronunciation-dictionaries/[id]" });
export const PATCH = withPermission("pronunciation_dicts:update", PATCH_handler, { route: "/api/ai/pronunciation-dictionaries/[id]" });
export const DELETE = withPermission("pronunciation_dicts:delete", DELETE_handler, { route: "/api/ai/pronunciation-dictionaries/[id]" });
