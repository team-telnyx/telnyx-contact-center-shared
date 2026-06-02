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

async function getId(context) {
  const { params } = await context;
  const { id } = await params;
  return id;
}

export async function GET(request, context) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const headers = telnyxHeaders();
  if (!headers) return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  const id = await getId(context);
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  try {
    const resp = await fetch(buildTelnyxV2Url(`/ai/mcp_servers/${encodeURIComponent(id)}`), {
      method: "GET",
      headers,
      cache: "no-store",
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return NextResponse.json(
        { error: data?.errors?.[0]?.detail || "Failed to fetch MCP server" },
        { status: resp.status },
      );
    }
    return NextResponse.json(data.data || data);
  } catch (error) {
    return NextResponse.json({ error: "Failed to fetch MCP server" }, { status: 500 });
  }
}

export async function PUT(request, context) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const headers = telnyxHeaders();
  if (!headers) return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  const id = await getId(context);
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  try {
    const body = await request.json();
    const { name, type, url, api_key_ref, allowed_tools } = body;
    const payload = {
      name: String(name || "").trim(),
      type: String(type || "sse").trim(),
      url: String(url || "").trim(),
      api_key_ref: api_key_ref ? String(api_key_ref).trim() : undefined,
      allowed_tools: Array.isArray(allowed_tools) ? allowed_tools : [],
    };
    if (!payload.name || !payload.url) {
      return NextResponse.json({ error: "Name and URL are required" }, { status: 400 });
    }

    const resp = await fetch(buildTelnyxV2Url(`/ai/mcp_servers/${encodeURIComponent(id)}`), {
      method: "PUT",
      headers,
      body: JSON.stringify(payload),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return NextResponse.json(
        { error: data?.errors?.[0]?.detail || "Failed to update MCP server" },
        { status: resp.status },
      );
    }
    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json({ error: "Failed to update MCP server" }, { status: 500 });
  }
}

export async function DELETE(request, context) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const headers = telnyxHeaders();
  if (!headers) return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  const id = await getId(context);
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  try {
    const resp = await fetch(buildTelnyxV2Url(`/ai/mcp_servers/${encodeURIComponent(id)}`), {
      method: "DELETE",
      headers,
    });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      return NextResponse.json(
        { error: data?.errors?.[0]?.detail || "Failed to delete MCP server" },
        { status: resp.status },
      );
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: "Failed to delete MCP server" }, { status: 500 });
  }
}
