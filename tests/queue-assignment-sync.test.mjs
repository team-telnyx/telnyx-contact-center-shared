import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { patchQueueActivations, patchAgentQueueCount } from "../lib/contact-center/queue-assignment-sync.mjs";

const rows = () => [{ id: "1", displayName: "Support", isActivated: false }, { id: "2", displayName: "Sales", isActivated: true }];

test("activation deltas preserve other switches and unchanged row identity", () => {
  const before = rows();
  const after = patchQueueActivations(before, [1], true);
  assert.equal(after[0].isActivated, true);
  assert.equal(after[1], before[1]);
  assert.equal(patchQueueActivations(after, ["1"], true), after);
  assert.equal(patchQueueActivations(after, ["missing"], true), after);
  assert.equal(patchQueueActivations(after, ["1"], undefined), after);
});

test("monitor snapshot reconciles equal-count queue swaps and missed deactivations", () => {
  const next = patchQueueActivations(rows(), [1], true, { replace: true });
  assert.deepEqual(next.map((row) => row.isActivated), [true, false]);
  assert.deepEqual(patchQueueActivations(next, [], true, { replace: true }).map((row) => row.isActivated), [false, false]);
  assert.equal(patchQueueActivations(next, undefined, true, { replace: true }), next);
});

test("local write plus repeated SSE does not double count active queues", () => {
  const before = { activeQueueIds: [2], activeQueues: 1 };
  const first = patchAgentQueueCount(before, ["1"], true);
  const duplicate = patchAgentQueueCount(first, [1], true);
  assert.equal(duplicate.activeQueues, 2);
  assert.equal(patchAgentQueueCount(patchAgentQueueCount(duplicate, [2], false), ["2"], false).activeQueues, 1);
});

const page = await readFile(new URL("../app/(portal)/supervisor/monitor/page.jsx", import.meta.url), "utf8");
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function harness() {
  const pending = [];
  const state = { rows: [], loading: false, notices: [], counts: [] };
  const context = vm.createContext({
    patchQueueActivations, patchAgentQueueCount,
    queueDialogAgentRef: { current: "alice" }, queueRequestRef: { current: 0 }, queueLoadUpdatesRef: { current: null },
    savingQueues: new Set(),
    setAgentQueues: (value) => { state.rows = typeof value === "function" ? value(state.rows) : value; },
    setLoadingQueues: (value) => { state.loading = value; },
    setSavingQueues: () => {},
    updateAgentQueues: (...args) => state.counts.push(args),
    notify: (value) => state.notices.push(value), console,
    fetch: (url, options) => {
      const request = deferred();
      pending.push({ url, options, ...request });
      return request.promise;
    },
  });
  for (const name of ["updateOpenQueueRows", "applyQueueActivationEvent", "loadAgentQueues", "toggleQueueActivation"]) {
    const source = page.match(new RegExp(`  (?:async )?function ${name}\\([\\s\\S]*?\\n  }`));
    assert.ok(source, `${name} remains testable`);
    vm.runInContext(source[0], context);
  }
  return { state, context, pending };
}
const response = (queues) => ({ ok: true, json: async () => ({ queues }) });

test("phone activation while initial HTTP request is pending wins over stale response", async () => {
  const { state, context, pending } = harness();
  const loading = context.loadAgentQueues("alice");
  context.applyQueueActivationEvent({ userId: "alice", queueIds: [1], activated: true });
  context.applyQueueActivationEvent({ userId: "bob", queueIds: [2], activated: false });
  pending[0].resolve(response(rows()));
  await loading;
  assert.equal(state.loading, false);
  assert.deepEqual(state.rows.map((row) => row.isActivated), [true, true]);
  context.applyQueueActivationEvent({ userId: "alice", queueIds: [2], activated: false });
  assert.deepEqual(state.rows.map((row) => row.isActivated), [true, false]);
  assert.equal(state.loading, false, "SSE must never show the loading skeleton again");
});

test("late response from a previously opened agent cannot replace current modal", async () => {
  const { state, context, pending } = harness();
  const alice = context.loadAgentQueues("alice");
  context.queueDialogAgentRef.current = "bob";
  const bob = context.loadAgentQueues("bob");
  pending[1].resolve(response([{ id: "bob-queue", isActivated: true }]));
  await bob;
  pending[0].resolve(response(rows()));
  await alice;
  assert.equal(state.rows[0].id, "bob-queue");
  assert.equal(state.loading, false);
});

test("switching agents during mutation keeps the correct target and ignores old modal write", async () => {
  const { state, context, pending } = harness();
  const mutation = context.toggleQueueActivation("1", false);
  assert.equal(JSON.parse(pending[0].options.body).userId, "alice");
  context.queueDialogAgentRef.current = "bob";
  context.queueRequestRef.current += 1;
  state.rows = [{ id: "1", isActivated: false }];
  pending[0].resolve(response([]));
  await mutation;
  assert.equal(state.rows[0].isActivated, false);
  assert.equal(state.counts[0][0], "alice");
});


test("activation broadcasts reach supervisor-only users while unrelated broadcasts remain agent-only", async () => {
  const source = await readFile(new URL("../lib/sse.js", import.meta.url), "utf8");
  const functionSource = source.slice(source.indexOf("export async function broadcastToAllAgents"))
    .replace("export async function", "async function")
    .replace('await import("./postgres.mjs")', '({ getPostgresPool: mockPool })');
  const sent = [], selectedRoles = [];
  const context = vm.createContext({
    mockPool: () => ({ query: async (_sql, [roles]) => {
      selectedRoles.push(roles);
      return {rows: roles.map(id => ({id}))};
    }}),
    broadcastToKey: async (...args) => sent.push(args),
    platformApiLogger: { error: () => assert.fail("broadcast should succeed") }, runtimePayload: value => value,
  });
  vm.runInContext(functionSource, context);
  await context.broadcastToAllAgents({queueIds:["q"]}, "queue_changed", {includeSupervisors:true});
  assert.deepEqual(Array.from(selectedRoles[0]), ["agent", "supervisor", "admin"]);
  assert.deepEqual(sent.map(([key]) => key), ["user:queues:agent", "user:queues:supervisor", "user:queues:admin"]);
  await context.broadcastToAllAgents({}, "other_event");
  assert.deepEqual(Array.from(selectedRoles[1]), ["agent"]);
  for (const kind of ["activate", "deactivate"]) {
    const route = await readFile(new URL(`../app/api/contact-center/agent/queues/${kind}/route.js`, import.meta.url), "utf8");
    assert.match(route, /"queue_changed", \{ includeSupervisors: true \}/);
  }
});
