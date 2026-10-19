import { withPermission } from "@/lib/authz/guard";
import { testSchedule } from "@/lib/schedules/runtime.mjs";
import { scheduleBody, scheduleResponse } from "@/lib/schedules/http.mjs";

export const POST = withPermission(["schedules:test", "call_flows:test"], async request =>
  scheduleResponse(async () => ({ result: await testSchedule(await scheduleBody(request)) })));
