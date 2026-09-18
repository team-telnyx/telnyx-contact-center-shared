import { NextResponse } from "next/server";
import { listMcpServers, createMcpServer } from "@/lib/mcp/mcp-server-registry";
import { withPermission } from "@/lib/authz/guard";


async function GET_handler(_request, _context, authz) {
  const user = authz.user;

  try {
    const rows = await listMcpServers({ includeTools: true });
    return NextResponse.json({ ok: true, rows, count: rows.length });
  } catch (error) {
    return NextResponse.json({ error: error?.message || "Failed to fetch MCP servers" }, { status: 500 });
  }
}

async function POST_handler(request, _context, authz) {
  const user = authz.user;

  try {
    const body = await request.json();
    const { name, type, url } = body;
    if (!name || !type || !url) {
      return NextResponse.json({ error: "Name, type, and URL are required" }, { status: 400 });
    }

    const row = await createMcpServer({
      ...body,
      created_by: user.id,
      updated_by: user.id,
    });
    return NextResponse.json({ ok: true, data: row, ...row });
  } catch (error) {
    return NextResponse.json({ error: error?.message || "Failed to create MCP server" }, { status: 500 });
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("mcp_servers:read", GET_handler, { route: "/api/admin/mcp-servers" });
export const POST = withPermission("mcp_servers:create", POST_handler, { route: "/api/admin/mcp-servers" });
