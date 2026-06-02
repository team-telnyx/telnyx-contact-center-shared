import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { PgDb } from "@/lib/pgdb";
import { isAdmin } from "@/lib/role-utils";
import { discoverMcpToolsForServer } from "@/lib/mcp/mcp-tool-runner";
import { getMcpServer, listMcpServerTools, upsertMcpServerTools } from "@/lib/mcp/mcp-server-registry";

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

async function getId(context) {
  const { params } = await context;
  const { id } = await params;
  return id;
}

export async function GET(request, context) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const id = await getId(context);
  if (!id || id === "new") return NextResponse.json({ tools: [] });

  try {
    const tools = await listMcpServerTools(id);
    return NextResponse.json({ tools });
  } catch (error) {
    return NextResponse.json({ error: error?.message || "Failed to fetch tools" }, { status: 500 });
  }
}

export async function POST(request, context) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  try {
    const id = await getId(context);
    const body = await request.json().catch(() => ({}));
    let server = null;

    if (id && id !== "new") server = await getMcpServer(id);
    if (!server) {
      const { type, url } = body;
      if (!type || !url) {
        return NextResponse.json({ error: "Type and URL are required" }, { status: 400 });
      }
      server = {
        id: id || "new",
        name: body.name || "Unsaved MCP Server",
        type: String(type).trim(),
        url: String(url).trim(),
        auth_type: body.auth_type || (body.api_key_ref || body.auth_secret_name ? "bearer" : "none"),
        auth_header_name: body.auth_header_name || null,
        auth_scheme: body.auth_scheme || null,
        auth_secret_name: body.auth_secret_name || body.api_key_ref || null,
        headers: body.headers || {},
      };
    } else if (body && Object.keys(body).length > 0) {
      server = { ...server, ...body, auth_secret_name: body.auth_secret_name || body.api_key_ref || server.auth_secret_name };
    }

    const tools = await discoverMcpToolsForServer(server);
    if (server.id && server.id !== "new") {
      await upsertMcpServerTools(server.id, tools);
    }
    return NextResponse.json({ tools });
  } catch (error) {
    return NextResponse.json(
      { error: error?.message || "Failed to connect to MCP server", connectionError: true },
      { status: 500 },
    );
  }
}
