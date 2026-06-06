import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { PgDb } from "@/lib/pgdb";
import { isAdmin } from "@/lib/role-utils";
import { getMcpServer, updateMcpServer, deleteMcpServer } from "@/lib/mcp/mcp-server-registry";

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

export async function PUT(request, context) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
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

export async function DELETE(request, context) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const id = await getId(context);
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  try {
    await deleteMcpServer(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error?.message || "Failed to delete MCP server" }, { status: 500 });
  }
}
