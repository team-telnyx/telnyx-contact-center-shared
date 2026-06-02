import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { PgDb } from "@/lib/pgdb";
import { isAdmin } from "@/lib/role-utils";
import { buildTelnyxV2Url } from "@/lib/telnyx";

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  const id = session?.user?.id || null;
  const email = session?.user?.email || null;
  if (!id && !email) return null;
  let user = null;
  if (id) user = await PgDb.findUserById(id);
  if (!user && email) user = await PgDb.findUserByUsername(email);
  if (!user || !isAdmin(user)) return null;
  return user;
}

function telnyxHeaders() {
  const telnyxApiKey = process.env.TELNYX_API_KEY;
  if (!telnyxApiKey) return null;
  return {
    Authorization: `Bearer ${telnyxApiKey}`,
    "Content-Type": "application/json",
  };
}

export async function GET(request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const headers = telnyxHeaders();
  if (!headers) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  try {
    const { searchParams } = new URL(request.url);
    const page = Math.max(1, Number(searchParams.get("page") || 1));
    const pageSize = Math.min(100, Math.max(1, Number(searchParams.get("pageSize") || 20)));
    const type = searchParams.get("type");

    const url = new URL(buildTelnyxV2Url("/ai/mcp_servers"));
    url.searchParams.set("page[number]", page);
    url.searchParams.set("page[size]", pageSize);
    if (type && type !== "all") url.searchParams.set("type", type);

    const resp = await fetch(url.toString(), { method: "GET", headers, cache: "no-store" });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return NextResponse.json(
        { error: data?.errors?.[0]?.detail || "Failed to fetch MCP servers" },
        { status: resp.status },
      );
    }

    return NextResponse.json({
      ok: true,
      rows: Array.isArray(data.data) ? data.data : [],
      count: data.meta?.total_results || data.meta?.total_count || data.meta?.total || 0,
      meta: data.meta || {},
    });
  } catch (error) {
    return NextResponse.json({ error: "Failed to fetch MCP servers" }, { status: 500 });
  }
}

export async function POST(request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const headers = telnyxHeaders();
  if (!headers) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  try {
    const body = await request.json();
    const { name, type, url, api_key_ref, allowed_tools } = body;
    if (!name || !type || !url) {
      return NextResponse.json({ error: "Name, type, and URL are required" }, { status: 400 });
    }

    const payload = {
      name: String(name).trim(),
      type: String(type).trim(),
      url: String(url).trim(),
      api_key_ref: api_key_ref ? String(api_key_ref).trim() : undefined,
      allowed_tools: Array.isArray(allowed_tools) ? allowed_tools : [],
    };

    const resp = await fetch(buildTelnyxV2Url("/ai/mcp_servers"), {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return NextResponse.json(
        { error: data?.errors?.[0]?.detail || "Failed to create MCP server" },
        { status: resp.status },
      );
    }
    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json({ error: "Failed to create MCP server" }, { status: 500 });
  }
}
