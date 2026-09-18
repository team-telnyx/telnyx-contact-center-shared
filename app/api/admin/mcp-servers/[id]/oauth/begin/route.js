import { NextResponse } from "next/server";
import { getMcpServer } from "@/lib/mcp/mcp-server-registry";
import { beginTelnyxMcpOAuth } from "@/lib/mcp/mcp-oauth";
import { withPermission } from "@/lib/authz/guard";


async function getId(context) {
  const { params } = await context;
  const { id } = await params;
  return id;
}

async function GET_handler(request, context, authz) {
  const user = authz.user;

  try {
    const id = await getId(context);
    const server = await getMcpServer(id);
    if (!server) return NextResponse.json({ error: "MCP server not found" }, { status: 404 });
    if (server.type !== "http") return NextResponse.json({ error: "OAuth is supported for HTTP MCP servers" }, { status: 400 });

    const { authorizationUrl } = await beginTelnyxMcpOAuth({ server, request, userId: user.id });
    return NextResponse.redirect(authorizationUrl);
  } catch (error) {
    return NextResponse.json({ error: error?.message || "Failed to start MCP OAuth" }, { status: 500 });
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("mcp_servers:read", GET_handler, { route: "/api/admin/mcp-servers/[id]/oauth/begin" });
