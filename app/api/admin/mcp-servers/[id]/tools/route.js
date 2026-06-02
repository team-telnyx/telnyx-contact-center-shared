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

function normalizeTools(data) {
  const rawTools = Array.isArray(data)
    ? data
    : Array.isArray(data?.data)
      ? data.data
      : Array.isArray(data?.tools)
        ? data.tools
        : [];

  return rawTools
    .map((tool) => {
      if (tool?.type === "function" && tool.function) {
        return {
          name: tool.function.name || "",
          description: tool.function.description || "",
          input_schema: tool.function.parameters || tool.function.input_schema || tool.function.inputSchema || null,
          type: tool.type,
        };
      }
      return {
        name: tool?.name || "",
        description: tool?.description || "",
        input_schema: tool?.input_schema || tool?.inputSchema || tool?.parameters || null,
        type: tool?.type || "function",
      };
    })
    .filter((tool) => tool.name);
}

export async function POST(request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const telnyxApiKey = process.env.TELNYX_API_KEY;
  if (!telnyxApiKey) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  try {
    const body = await request.json();
    const { type, url, api_key_ref } = body;
    if (!type || !url) {
      return NextResponse.json({ error: "Type and URL are required" }, { status: 400 });
    }

    const payload = {
      type: String(type).trim(),
      url: String(url).trim(),
      api_key_ref: api_key_ref ? String(api_key_ref).trim() : undefined,
    };

    const resp = await fetch(buildTelnyxV2Url("/ai/mcp_servers/list_tools"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${telnyxApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return NextResponse.json(
        { error: data?.errors?.[0]?.detail || "Failed to fetch tools", connectionError: true },
        { status: resp.status },
      );
    }
    return NextResponse.json({ tools: normalizeTools(data) });
  } catch (error) {
    return NextResponse.json({ error: "Failed to connect to MCP server", connectionError: true }, { status: 500 });
  }
}
