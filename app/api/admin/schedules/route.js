import { withPermission } from "@/lib/authz/guard";
import { scheduleStore } from "@/lib/schedules/store.mjs";
import { scheduleBody, scheduleResponse } from "@/lib/schedules/http.mjs";

export const GET = withPermission(["schedules:read", "call_flows:read", "call_flows:create", "call_flows:update"], async (_request, _context, authz) =>
  scheduleResponse(async () => ({ items: await scheduleStore().list({ drafts: authz.can("schedules:read") }) })));
export const POST = withPermission("schedules:create", async (request, _context, authz) =>
  scheduleResponse(async () => ({ item: await scheduleStore().create(await scheduleBody(request), authz.user.id) })));
