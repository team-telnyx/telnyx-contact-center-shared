// GET (list) and POST (create)
import { NextResponse } from "next/server";
import { withPermission } from "@/lib/authz/guard";

const TELNYX_BASE = "https://api.telnyx.com/v2";

async function GET_handler(request, _context, authz) {
  const user = authz.user;
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "Missing TELNYX_API_KEY" }, { status: 500 });
  const { searchParams } = new URL(request.url);
  const page = searchParams.get("page") || "1";
  const pageSize = searchParams.get("page_size") || "20";
  const res = await fetch(
    `${TELNYX_BASE}/pronunciation_dicts?page[number]=${page}&page[size]=${pageSize}`,
    {
      headers: { Authorization: `Bearer ${apiKey}` },
    }
  );
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}

async function POST_handler(request, _context, authz) {
  const user = authz.user;
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "Missing TELNYX_API_KEY" }, { status: 500 });
  const body = await request.json();
  const res = await fetch(`${TELNYX_BASE}/pronunciation_dicts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("pronunciation_dicts:read", GET_handler, { route: "/api/ai/pronunciation-dictionaries" });
export const POST = withPermission("pronunciation_dicts:create", POST_handler, { route: "/api/ai/pronunciation-dictionaries" });
