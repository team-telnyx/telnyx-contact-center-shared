import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { PgDb } from "@/lib/pgdb";
import { isAdmin } from "@/lib/role-utils";
import { getMcpServer } from "@/lib/mcp/mcp-server-registry";
import { beginTelnyxMcpOAuth } from "@/lib/mcp/mcp-oauth";

export const dynamic = "force-dynamic";

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
