import { withPermission } from "@/lib/authz/guard";
import { scheduleStore } from "@/lib/schedules/store.mjs";
import { scheduleBody, scheduleResponse } from "@/lib/schedules/http.mjs";

export const POST = withPermission("schedules:publish", async (request, { params }, authz) => scheduleResponse(async () => {
  const { id } = await params, body = await scheduleBody(request);
  return { publication: await scheduleStore().publish(id, body.editVersion, authz.user.id) };
}));
