import { NextResponse } from "next/server";
import { finishTelnyxMcpOAuth, browserSafeBaseUrl, getPendingTelnyxMcpOAuthServerId } from "@/lib/mcp/mcp-oauth";
import { withPermission } from "@/lib/authz/guard";


function adminRedirect(request, params = {}) {
  const url = new URL("/admin/mcp-servers", browserSafeBaseUrl(request));
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return NextResponse.redirect(url);
}

async function GET_handler(request, _context, authz) {
  const user = authz.user;

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  if (error) {
    const serverId = await getPendingTelnyxMcpOAuthServerId(state);
    return adminRedirect(request, { mcp_oauth: "error", mcp_oauth_error: error, server_id: serverId });
  }
  if (!code || !state) return adminRedirect(request, { mcp_oauth: "error", mcp_oauth_error: "missing_code_or_state" });

  try {
    const { serverId } = await finishTelnyxMcpOAuth({ code, state, userId: user.id });
    return adminRedirect(request, { mcp_oauth: "connected", server_id: serverId });
  } catch (err) {
    const serverId = await getPendingTelnyxMcpOAuthServerId(state);
    return adminRedirect(request, { mcp_oauth: "error", mcp_oauth_error: err?.message || "oauth_callback_failed", server_id: serverId });
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("mcp_servers:read", GET_handler, { route: "/api/admin/mcp-servers/oauth/callback" });
