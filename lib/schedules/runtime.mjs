import { scheduleStore } from "./store.mjs";
import { normalizeNodeConfig, evaluateSchedule, resolveLocalMoment, ScheduleError } from "./evaluator.mjs";

export async function resolveSchedule(config, store, asOf) {
  const c = normalizeNodeConfig(config);
  const resources = await store.revisions([...(c.source === "shared" ? [c.scheduleId] : []), ...(c.useExceptions ? c.calendarIds : [])], asOf);
  const shared = c.source === "shared" ? resources.find(r => r.id === c.scheduleId) : null;
  if (shared && shared.kind !== "schedule") throw new ScheduleError("Working hours must reference a shared schedule.");
  const calendars = c.useExceptions ? c.calendarIds.map(id => {
    const r = resources.find(r => r.id === id); if (r?.kind !== "calendar") throw new ScheduleError("An exception reference must be a calendar."); return r;
  }) : [];
  return { config: c, schedule: shared?.definition || c, calendars, versions: resources.map(r => ({ id: r.id, name: r.name, revision: r.revision })) };
}
export async function testSchedule({ config, date, time, disambiguation = "reject", instant }, store = scheduleStore()) {
  const resolved = await resolveSchedule(config, store);
  const at = instant || resolveLocalMoment(date, time, resolved.schedule.timeZone, disambiguation);
  return evaluateSchedule({ ...resolved, instant: at });
}
export async function initializeScheduleExecution(flow, callControlId, event, execution, store = null) {
  if (!flow.nodes?.some(n => n.data?.nodeType === "schedules")) return;
  const at = new Date(execution?.started_at || Date.now()).toISOString();
  const rawReceived = event?.data?.payload?.start_time || event?.data?.occurred_at || at;
  const receivedAt = Number.isFinite(Date.parse(rawReceived)) ? new Date(rawReceived).toISOString() : at;
  return (store || scheduleStore()).executionContext({ flowId: flow.id, callControlId, receivedAt, snapshotAt: at, nodes: flow.nodes });
}
export async function runScheduleNode(node, callControlId, event, executionState, { store, now = () => new Date().toISOString() } = {}) {
  const rawConfig = node.data?.config || {}; let config = rawConfig;
  const enteredAt = now();
  let context, visitKey;
  try {
    store ||= scheduleStore();
    context = await store.context(executionState.flowId, callControlId);
    if (!context) throw new ScheduleError("Schedule execution context was not initialized.", "execution_context_missing");
    config = context.node_configs?.[node.id] || rawConfig;
    visitKey = String(event?.data?.id || event?.id || `${event?.data?.event_type || "trigger"}:${event?.data?.occurred_at || context.snapshot_at}`);
    const existing = await store.evaluation(executionState.flowId, callControlId, node.id, visitKey);
    if (existing) return existing;
    config = normalizeNodeConfig(config);
    const resolved = await resolveSchedule(config, store, context.snapshot_at);
    const result = evaluateSchedule({ ...resolved, instant: config.timeSource === "call_received" ? context.received_at : enteredAt });
    result.timeSource = config.timeSource; result.snapshotAt = new Date(context.snapshot_at).toISOString(); result.resultVariable = config.resultVariable;
    return await store.evaluation(executionState.flowId, callControlId, node.id, visitKey, result);
  } catch (error) {
    const result = { status: "error", matched: null, branch: config.errorBranch === "true" ? "true" : "false", reason: error instanceof ScheduleError ? error.code : "evaluation_failed", error: error instanceof ScheduleError ? error.message : "Schedule evaluation unavailable.", evaluatedAt: enteredAt, resultVariable: /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(config.resultVariable || "") && !["constructor", "prototype"].includes(config.resultVariable) ? config.resultVariable : "schedule_result" };
    if (context && visitKey) {
      try { return await store.evaluation(executionState.flowId, callControlId, node.id, visitKey, result); }
      catch { /* Database failures still follow the configured error branch. */ }
    }
    return result;
  }
}
