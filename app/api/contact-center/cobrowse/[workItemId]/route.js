import { NextResponse } from "next/server";
import { withPermission } from "@/lib/authz/guard";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { claimPairing, endAgentCobrowse, readAgentCobrowse, requestCobrowse } from "@/lib/cobrowse/lifecycle.mjs";

const noStore = { "Cache-Control": "no-store" };
const response = (data, status = 200) => NextResponse.json(data, { status, headers: noStore });

async function get(request, context, authz) {
  const pool = getPostgresPool();
  if (!pool) return response({ error: "Service unavailable" }, 503);
  const { workItemId } = await context.params;
  try {
    return response({ ...(await readAgentCobrowse(pool, { workItemId, agentId: authz.user.id, scope: authz.scope })),
      canControl: authz.can("cobrowse:control") });
  } catch (error) { return response({ error: error.status ? error.message : "Request failed" }, error.status || 500); }
}

async function post(request, context, authz) {
  const pool = getPostgresPool();
  if (!pool) return response({ error: "Service unavailable" }, 503);
  if (Number(request.headers.get("content-length") || 0) > 2048) return response({ error: "Request too large" }, 413);
  const { workItemId } = await context.params;
  const body = await request.json().catch(() => ({}));
  const args = { workItemId, agentId: authz.user.id, scope: authz.scope };
  try {
    if (body.action === "request") return response({ session: await requestCobrowse(pool, args) });
    if (body.action === "claim") return response({ session: await claimPairing(pool, { ...args, code: body.code }) });
    if (body.action === "end") return response({ session: await endAgentCobrowse(pool, args) });
    return response({ error: "Unsupported action" }, 400);
  } catch (error) { return response({ error: error.status ? error.message : "Request failed" }, error.status || 500); }
}

export const GET = withPermission("cobrowse:view", get, { route: "/api/contact-center/cobrowse/[workItemId]" });
export const POST = withPermission("cobrowse:request", post, { route: "/api/contact-center/cobrowse/[workItemId]" });
