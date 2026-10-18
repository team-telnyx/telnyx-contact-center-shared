import { withPermission } from "@/lib/authz/guard";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { withVideoDevice } from "@/lib/acd/media-device-control.mjs";
import { controlConferenceAi, requireConferenceAgent } from "@/lib/video/conference.mjs";
import { readConferenceBody } from "@/lib/video/request-body.mjs";
export const POST = withPermission("agent:self", async (request, context, authz) => {
  const pool = getPostgresPool();
  if (!pool) return Response.json({ error: "Database unavailable" }, { status: 503 });
  try {
  const { id } = await context.params;
  const body = await readConferenceBody(request);
  return await withVideoDevice(pool, authz.user, request, id, async () => {
    const principalId = String(authz.user.id);
    const video = await requireConferenceAgent(pool, { workItemId: id, agentId: principalId });
    return Response.json(await controlConferenceAi(pool, { video, role: "agent", principalId, body }), { headers: { "Cache-Control": "no-store" } });
  });
  } catch (error) {
    return Response.json({error:error.status ? error.message : "Unable to update the video assistant. Please retry shortly."},{status:error.status || 500,headers:{"Cache-Control":"no-store"}});
  }
});
