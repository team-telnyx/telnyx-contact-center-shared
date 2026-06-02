import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { PgDb } from "@/lib/pgdb";
import { isAdmin } from "@/lib/role-utils";
import { finishTelnyxMcpOAuth, browserSafeBaseUrl } from "@/lib/mcp/mcp-oauth";

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

function adminRedirect(request, params = {}) {
  const url = new URL("/admin/mcp-servers", browserSafeBaseUrl(request));
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return NextResponse.redirect(url);
}

export async function GET(request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  if (error) return adminRedirect(request, { mcp_oauth_error: error });
  if (!code || !state) return adminRedirect(request, { mcp_oauth_error: "missing_code_or_state" });

  try {
    const { serverId } = await finishTelnyxMcpOAuth({ code, state, userId: user.id });
    return adminRedirect(request, { mcp_oauth: "connected", server_id: serverId });
  } catch (err) {
    return adminRedirect(request, { mcp_oauth_error: err?.message || "oauth_callback_failed" });
  }
}
