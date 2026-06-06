import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { PgDb } from "@/lib/pgdb";
import { isAdmin } from "@/lib/role-utils";
import { discoverMcpServerAuth } from "@/lib/mcp/mcp-auth-discovery";

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

export async function POST(request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  try {
    const body = await request.json().catch(() => ({}));
    const discovery = await discoverMcpServerAuth({ url: body.url, type: body.type || "http" });
    return NextResponse.json({ ok: true, discovery });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error?.message || "Failed to discover MCP authentication" }, { status: 500 });
  }
}
