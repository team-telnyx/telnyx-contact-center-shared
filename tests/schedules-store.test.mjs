import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { readDotEnvPostgres } from "./helpers/acd-test-db.mjs";
import { ensureSchedulesSchema } from "../lib/schedules/schema.mjs";
import { createScheduleStore } from "../lib/schedules/store.mjs";
import { defaultWeekly, defaultScheduleConfig } from "../lib/schedules/evaluator.mjs";
import { initializeScheduleExecution, runScheduleNode, testSchedule } from "../lib/schedules/runtime.mjs";
import { scheduleResponse, scheduleBody } from "../lib/schedules/http.mjs";
import { loadRoute } from "./helpers/route-harness.mjs";

const base = readDotEnvPostgres();
assert.ok(["localhost", "127.0.0.1", "::1"].includes(base.host), "Schedules tests require local PostgreSQL");
const schema = `schedule_test_${randomUUID().replaceAll("-", "")}`;
const admin = new pg.Pool({ ...base, max: 1, connectionTimeoutMillis: 3000 });
await admin.query(`CREATE SCHEMA ${schema}`);
const pool = new pg.Pool({ ...base, options: `-c search_path=${schema}`, max: 5, connectionTimeoutMillis: 3000 });
after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
await ensureSchedulesSchema(pool);
await pool.query("CREATE TABLE voice_flows(id TEXT PRIMARY KEY,name TEXT,nodes JSONB)");
const store = createScheduleStore(pool);
const resource = () => ({ kind: "schedule", name: "Support", definition: { timeZone: "Europe/Warsaw", weekly: defaultWeekly() } });
beforeEach(() => pool.query("TRUNCATE cc_schedule_evaluations,cc_schedule_contexts,cc_schedule_revisions,cc_schedule_resources,voice_flows CASCADE"));
async function published() { const row = await store.create(resource(), "owner"); await store.publish(row.id, row.edit_version, "owner"); return store.get(row.id); }

test("drafts stay private to administration until publish; saving does not change published hours", async () => {
  const row = await store.create(resource(), "owner"); assert.equal((await store.list()).length, 0);
  assert.equal((await store.list({ drafts: true })).length, 1);
  const pub = await store.publish(row.id, 1, "owner"); assert.equal(pub.revision, 1);
  const list = await store.list(); assert.equal(list.length, 1); assert.equal(list[0].draft, undefined);
  const changed = resource(); changed.definition.weekly.forEach(d => d.periods = []);
  await store.save(row.id, changed, 2, "owner");
  assert.equal((await store.revisions([row.id]))[0].definition.weekly[0].periods.length, 1);
});
test("concurrent edits and publication use optimistic locks", async () => {
  const row = await store.create(resource(), "owner");
  const edits = await Promise.allSettled([store.save(row.id, { ...resource(), name: "A" }, 1, "alice"), store.save(row.id, { ...resource(), name: "B" }, 1, "bob")]);
  assert.equal(edits.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(edits.find(r => r.status === "rejected").reason.code, "version_conflict");
  await assert.rejects(store.publish(row.id, 1, "owner"), e => e.code === "version_conflict");
});
test("referenced resources cannot be archived and publication reports affected flows", async () => {
  const row = await published(); const config = { ...defaultScheduleConfig(), source: "shared", scheduleId: row.id };
  await pool.query("INSERT INTO voice_flows VALUES('flow','Inbound support',$1)", [JSON.stringify([{ id: "schedule", data: { nodeType: "schedules", config } }])]);
  await assert.rejects(store.archive(row.id, row.edit_version, "owner"), e => e.code === "resource_in_use");
  const pub = await store.publish(row.id, row.edit_version, "owner"); assert.deepEqual(pub.affectedFlows, [{ id: "flow", name: "Inbound support" }]);
  await pool.query("DELETE FROM voice_flows");
  await store.archive(row.id, row.edit_version + 1, "owner"); assert.equal((await store.list()).length, 0);
  assert.equal((await store.revisions([row.id]))[0].revision, 2, "published history remains readable for existing calls");
  await assert.rejects(store.validateFlow([{ data: { nodeType: "schedules", config } }]), e => e.code === "not_found");
});
test("calls freeze published revisions and node settings; retries preserve evaluation", async () => {
  const row = await published();
  const node = { id: "schedule", data: { nodeType: "schedules", config: { ...defaultScheduleConfig(), source: "shared", scheduleId: row.id } } };
  const flow = { id: "flow", nodes: [node] }, event = { data: { id: "event-1", occurred_at: "2027-11-10T08:00:00Z" } };
  const snapshot = (await pool.query("SELECT clock_timestamp() AS at")).rows[0].at;
  // PG timestamps have microseconds. Give the fixture a deterministic ordering.
  await pool.query("UPDATE cc_schedule_revisions SET published_at=$1::timestamptz - interval '1 second'", [snapshot]);
  await initializeScheduleExecution(flow, "old-call", event, { started_at: snapshot }, store);
  const changed = resource(); changed.definition.weekly.forEach(d => d.periods = []);
  const saved = await store.save(row.id, changed, row.edit_version, "owner"); await store.publish(row.id, saved.edit_version, "owner");
  let options = { store, now: () => "2027-11-10T10:00:00Z" };
  let result = await runScheduleNode(node, "old-call", event, { flowId: flow.id }, options);
  assert.equal(result.matched, true); assert.equal(result.versions[0].revision, 1);
  result = await runScheduleNode(node, "old-call", event, { flowId: flow.id }, { ...options, now: () => "2027-11-10T23:00:00Z" });
  assert.equal(result.matched, true); assert.equal(result.evaluatedAt, "2027-11-10T10:00:00.000Z");
  const newStart = new Date(Date.now() + 1000).toISOString();
  await initializeScheduleExecution(flow, "new-call", event, { started_at: newStart }, store);
  result = await runScheduleNode(node, "new-call", event, { flowId: flow.id }, options);
  assert.equal(result.matched, false); assert.equal(result.versions[0].revision, 2);
  node.data.config = { ...defaultScheduleConfig(), timeZone: "America/New_York" };
  const nextEvent = { data: { id: "event-2" } };
  result = await runScheduleNode(node, "old-call", nextEvent, { flowId: flow.id }, options);
  assert.equal(result.timeZone, "Europe/Warsaw", "an in-progress call retains node configuration");
});
test("preview uses published shared resources and rejects missing references", async () => {
  const row = await published(), config = { ...defaultScheduleConfig(), source: "shared", scheduleId: row.id };
  assert.equal((await testSchedule({ config, date: "2027-11-10", time: "09:00" }, store)).matched, true);
  await assert.rejects(store.validateFlow([{ data: { nodeType: "schedules", config: { ...config, scheduleId: "absent" } } }]), e => e.code === "resource_unpublished");
});
test("actual API handlers support create, save, publish, reload and distinct read permissions", async () => {
  const permissions = new Set(["schedules:create", "schedules:read", "schedules:update", "schedules:publish", "schedules:test"]);
  const authz = { user: { id: "owner" }, can: p => permissions.has(p) };
  const deps = {
    "@/lib/authz/guard": { withPermission: (required, handler) => async (...args) => (Array.isArray(required) ? required : [required]).some(p => permissions.has(p)) ? handler(args[0], args[1] || {}, authz) : Response.json({ error: "Forbidden" }, { status: 403 }) },
    "@/lib/schedules/store.mjs": { scheduleStore: () => store },
    "@/lib/schedules/http.mjs": { scheduleResponse, scheduleBody },
    "@/lib/schedules/runtime.mjs": { testSchedule: body => testSchedule(body, store) },
  };
  const list = await loadRoute("app/api/admin/schedules/route.js", deps), detail = await loadRoute("app/api/admin/schedules/[id]/route.js", deps), publish = await loadRoute("app/api/admin/schedules/[id]/publish/route.js", deps), tester = await loadRoute("app/api/admin/schedules/test/route.js", deps);
  const request = body => new Request("http://localhost/api/admin/schedules", { method: "POST", body: JSON.stringify(body) });
  const row = (await (await list.POST(request(resource()))).json()).item, context = { params: Promise.resolve({ id: row.id }) };
  const saved = (await (await detail.PUT(request({ ...resource(), name: "Changed", editVersion: row.edit_version }), context)).json()).item;
  assert.equal((await publish.POST(request({ editVersion: saved.edit_version }), context)).status, 200);
  assert.equal((await (await detail.GET(null, context)).json()).item.draft.name, "Changed");
  assert.equal((await tester.POST(request({ config: { ...defaultScheduleConfig(), source: "shared", scheduleId: row.id }, date: "2027-11-10", time: "09:00" }))).status, 200);
  permissions.clear(); permissions.add("call_flows:read");
  assert.equal((await list.GET()).status, 200); assert.equal((await (await list.GET()).json()).items[0].draft, undefined);
  assert.equal((await detail.PUT(request(resource()), context)).status, 403); assert.equal((await publish.POST(request({}), context)).status, 403);
  assert.equal((await tester.POST(request({}))).status, 403); assert.equal((await detail.GET(null, context)).status, 403);
});

test("evaluation failures are persisted for retries, with a safe configurable branch", async () => {
  const node = { id: "schedule", data: { nodeType: "schedules", config: { ...defaultScheduleConfig(), source: "shared", scheduleId: "missing", errorBranch: "true" } } };
  const flow = { id: "flow", nodes: [node] }, event = { data: { id: "event-failure", occurred_at: "2027-01-01T10:00:00Z", payload: { start_time: "2027-01-01T09:00:00Z" } } };
  const context = await initializeScheduleExecution(flow, "call", event, { started_at: new Date() }, store);
  assert.equal(context.received_at.toISOString(), "2027-01-01T09:00:00.000Z");
  const result = await runScheduleNode(node, "call", event, { flowId: "flow" }, { store, now: () => "2027-01-01T11:00:00Z" });
  assert.equal(result.status, "error"); assert.equal(result.matched, null); assert.equal(result.branch, "true");
  const replay = await runScheduleNode(node, "call", event, { flowId: "flow" }, { store, now: () => "2027-01-01T12:00:00Z" });
  assert.deepEqual(replay, result);
});

test("inactive references do not block archiving or report publication impact", async () => {
  const row = await published();
  const config = { ...defaultScheduleConfig(), scheduleId: row.id, calendarIds: [row.id], useExceptions: false };
  await pool.query("INSERT INTO voice_flows VALUES('flow','Custom hours',$1)", [JSON.stringify([{ id: 'schedule', data: { nodeType: 'schedules', config } }])]);
  assert.deepEqual(await store.references(row.id), []);
  assert.equal((await store.archive(row.id, row.edit_version, 'owner')).archived, true);
});
