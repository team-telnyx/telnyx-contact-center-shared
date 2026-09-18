import { NextResponse } from "next/server";
import { getMcpServer, updateMcpServer, deleteMcpServer } from "@/lib/mcp/mcp-server-registry";
import { withPermission } from "@/lib/authz/guard";


async function getId(context) {
  const { params } = await context;
  const { id } = await params;
  return id;
}

async function GET_handler(request, context, authz) {
  const user = authz.user;
  const id = await getId(context);
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  try {
    const server = await getMcpServer(id, { includeTools: true });
    if (!server) return NextResponse.json({ error: "MCP server not found" }, { status: 404 });
    return NextResponse.json(server);
  } catch (error) {
    return NextResponse.json({ error: error?.message || "Failed to fetch MCP server" }, { status: 500 });
  }
}

async function PUT_handler(request, context, authz) {
  const user = authz.user;
  const id = await getId(context);
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  try {
    const body = await request.json();
    const payload = { ...body, updated_by: user.id };
    if (!payload.name || !payload.url) {
      return NextResponse.json({ error: "Name and URL are required" }, { status: 400 });
    }
    const server = await updateMcpServer(id, payload);
    if (!server) return NextResponse.json({ error: "MCP server not found" }, { status: 404 });
    return NextResponse.json({ ok: true, data: server, ...server });
  } catch (error) {
    return NextResponse.json({ error: error?.message || "Failed to update MCP server" }, { status: 500 });
  }
}

async function DELETE_handler(request, context, authz) {
  const user = authz.user;
  const id = await getId(context);
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  try {
    await deleteMcpServer(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error?.message || "Failed to delete MCP server" }, { status: 500 });
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("mcp_servers:read", GET_handler, { route: "/api/admin/mcp-servers/[id]" });
export const PUT = withPermission("mcp_servers:update", PUT_handler, { route: "/api/admin/mcp-servers/[id]" });
export const DELETE = withPermission("mcp_servers:delete", DELETE_handler, { route: "/api/admin/mcp-servers/[id]" });
