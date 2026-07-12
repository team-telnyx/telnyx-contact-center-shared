// GET (list) and POST (create)
import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";

const TELNYX_BASE = "https://api.telnyx.com/v2";

export async function GET(request) {
  const user = await getAuthenticatedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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

export async function POST(request) {
  const user = await getAuthenticatedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
