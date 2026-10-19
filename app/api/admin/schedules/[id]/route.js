import { withPermission } from "@/lib/authz/guard";
import { scheduleStore } from "@/lib/schedules/store.mjs";
import { scheduleBody, scheduleResponse } from "@/lib/schedules/http.mjs";

export const GET = withPermission("schedules:read", async (_request, { params }) => scheduleResponse(async () => {
  const { id } = await params, store = scheduleStore();
  return { item: await store.get(id), affectedFlows: await store.references(id) };
}));
export const PUT = withPermission("schedules:update", async (request, { params }, authz) => scheduleResponse(async () => {
  const { id } = await params, body = await scheduleBody(request);
  return { item: await scheduleStore().save(id, body, body.editVersion, authz.user.id) };
}));
export const DELETE = withPermission("schedules:delete", async (request, { params }, authz) => scheduleResponse(async () => {
  const { id } = await params, body = await scheduleBody(request);
  return scheduleStore().archive(id, body.editVersion, authz.user.id);
}));
