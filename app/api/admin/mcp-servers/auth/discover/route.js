import { NextResponse } from "next/server";
import { discoverMcpServerAuth } from "@/lib/mcp/mcp-auth-discovery";
import { withPermission } from "@/lib/authz/guard";


async function POST_handler(request, _context, authz) {
  const user = authz.user;

  try {
    const body = await request.json().catch(() => ({}));
    const discovery = await discoverMcpServerAuth({ url: body.url, type: body.type || "http" });
    return NextResponse.json({ ok: true, discovery });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error?.message || "Failed to discover MCP authentication" }, { status: 500 });
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const POST = withPermission("mcp_servers:create", POST_handler, { route: "/api/admin/mcp-servers/auth/discover" });
