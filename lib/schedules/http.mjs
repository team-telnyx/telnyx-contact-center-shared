import { ScheduleError } from "./evaluator.mjs";
import { adminRuntimeLogger } from "../runtime-logging.mjs";

export async function scheduleBody(request) {
  const raw = await request.text();
  if (raw.length > 512000) throw new ScheduleError("Schedule request is too large.", "request_too_large", 413);
  try { const value = JSON.parse(raw); if (!value || Array.isArray(value) || typeof value !== "object") throw new Error(); return value; }
  catch { throw new ScheduleError("Provide a JSON object.", "invalid_json"); }
}
export async function scheduleResponse(run) {
  try { return Response.json({ ok: true, ...await run() }); }
  catch (error) {
    if (error instanceof ScheduleError) return Response.json({ ok: false, error: error.message, code: error.code, ...error.details }, { status: error.status });
    adminRuntimeLogger.error("schedule_request_failed", { error: error.message });
    return Response.json({ ok: false, error: "Schedules are temporarily unavailable.", code: "service_unavailable" }, { status: 503 });
  }
}
