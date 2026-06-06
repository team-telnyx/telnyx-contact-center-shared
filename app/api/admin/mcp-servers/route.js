export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { PgDb } from "@/lib/pgdb";
import { isAdmin } from "@/lib/role-utils";
import { listMcpServers, createMcpServer } from "@/lib/mcp/mcp-server-registry";

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

export async function GET() {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  try {
    const rows = await listMcpServers({ includeTools: true });
    return NextResponse.json({ ok: true, rows, count: rows.length });
  } catch (error) {
    return NextResponse.json({ error: error?.message || "Failed to fetch MCP servers" }, { status: 500 });
  }
}

export async function POST(request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

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
