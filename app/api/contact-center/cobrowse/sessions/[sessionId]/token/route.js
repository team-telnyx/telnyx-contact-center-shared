import { NextResponse } from "next/server";
import { withPermission } from "@/lib/authz/guard";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { issueViewerTicket } from "@/lib/cobrowse/lifecycle.mjs";
import { cobrowseSocketUrl } from "@/lib/cobrowse/socket-url.mjs";

async function post(request, context, authz) {
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Service unavailable" }, { status: 503 });
  try {
    const { sessionId } = await context.params;
    return NextResponse.json({ ...(await issueViewerTicket(pool, { sessionId, agentId: authz.user.id, scope: authz.scope })), wsUrl: cobrowseSocketUrl(request.url) },
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error.status ? error.message : "Request failed" },
      { status: error.status || 500, headers: { "Cache-Control": "no-store" } });
  }
}

export const POST = withPermission("cobrowse:view", post, { route: "/api/contact-center/cobrowse/sessions/[sessionId]/token" });
