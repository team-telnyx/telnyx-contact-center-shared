import { test } from "node:test";
import assert from "node:assert/strict";
import { loadRoute } from "./helpers/route-harness.mjs";
import { authorizePersistedInteractionControl } from "../lib/voice/interaction-control-policy.mjs";

test("incoming flow rejects an invalid signature before logging or provider I/O", async () => {
  let writes=0,requests=0,verifications=0;
  const warnings=[];
  const route=await loadRoute("app/api/voice/webhook/incoming/[flowId]/route.js",{
    "@/lib/telnyx-webhooks.js":{verifyTelnyxSignature:async()=>{verifications++;return false;}},
    "@/lib/voice/logging.mjs":{voiceRuntimePayload:v=>v,voiceWebhookLogger:{warn:(_name,value)=>warnings.push(value),error(){}}},
    "@/lib/call-logger.js":{logCallEvent:async()=>{writes++;}},
    "@/lib/postgres.mjs":{getPostgresPool:()=>{writes++;throw Error('Unexpected database access');}},
    fetch:async()=>{requests++;throw Error('Unexpected provider I/O');},
  });
  const response=await route.POST({text:async()=>'{"data":{"event_type":"call.initiated","payload":{}}}'},{params:Promise.resolve({flowId:'fixture-flow'})});
  assert.equal(response.status,401);
  assert.equal(response.body.error,'Invalid signature');
  assert.equal(verifications,1);assert.equal(writes,0);assert.equal(requests,0);
  assert.equal(warnings[0].reason,'invalid_signature');
});

test("incoming flow log failure does not hide the retryable database-unavailable result", async()=>{
  const errors=[];
  const route=await loadRoute("app/api/voice/webhook/incoming/[flowId]/route.js",{
    "@/lib/telnyx-webhooks.js":{verifyTelnyxSignature:async()=>true},
    "@/lib/voice/logging.mjs":{voiceRuntimePayload:v=>v,voiceWebhookLogger:{warn(){},error:(_name,value)=>errors.push(value)}},
    "@/lib/call-logger.js":{logCallEvent:async()=>{throw Error('Log database unavailable');}},
    "@/lib/call-monitor-store.js":{addWebhookEvent(){}},
    "@/lib/postgres.mjs":{getPostgresPool:()=>null},
  });
  const response=await route.POST({text:async()=>'{"data":{"event_type":"call.initiated","payload":{"call_control_id":"fixture-leg"}}}'},{params:Promise.resolve({flowId:'fixture-flow'})});
  assert.equal(response.status,503);
  assert.equal(errors[0].callControlId,'fixture-leg');
  assert.equal(errors[0].error.message,'Log database unavailable');
});

for (const path of ["app/api/phone-numbers/route.js", "app/api/phone-numbers/[id]/route.js", "app/api/phone-numbers/[id]/messaging/route.js", "app/api/messaging/profiles/route.js"]) {
  test(`${path}: auth and admin role precede provider access`, async () => {
    for (const [user, status] of [[null, 401], [{ roles: ["agent"] }, 403], [{ roles: ["admin"] }, 200]]) {
      let requests = 0;
      const route = await loadRoute(path, {
        "@/lib/auth-server": { getAuthenticatedUser: async () => user },
        "@/lib/role-utils": { isAdmin: current => current.roles.includes("admin") },
        "@/lib/telnyx": { buildTelnyxV2Url: url => `https://provider.test${url}` },
        env: { TELNYX_API_KEY: "test-only" },
        fetch: async () => { requests++; return { ok: true, json: async () => ({ data: {} }) }; },
      });
      const response = await (route.PATCH || route.GET)({ url: "http://test.local/api", json: async () => ({ connection_id: "test", messaging_profile_id: "test" }) }, { params: Promise.resolve({ id: "test" }) });
      assert.equal(response.status, status);
      assert.equal(requests, status === 200 ? 1 : 0);
    }
  });
}

test("direct intent cancellation rejects a foreign direct reservation", async () => {
  let cancellations = 0;
  const route = await loadRoute("app/api/voice/direct-intent/route.js", {
    "@/lib/auth-server": { getAuthenticatedUser: async () => ({ id: "agent-a", username: "agent-a", roles: ["agent"] }) },
    "@/lib/postgres.mjs": { getPostgresPool: () => ({ query: async () => ({ rows: [{ id: "11111111-1111-4111-8111-111111111111", agent_id: "agent-b", work_item_id: "work-a", purpose: "manual_outbound" }] }) }) },
    "@/lib/acd/direct-capacity.mjs": {
      reserveDirectVoice: async () => null,
      reserveCoreTarget: async () => null,
      cancelUnstartedDirectIntent: async () => { cancellations++; return true; },
    },
    "@/lib/voice/interaction-control-policy.mjs": { authorizePersistedInteractionControl },
  });
  const response = await route.DELETE({ url: "http://test.local/api/voice/direct-intent?id=11111111-1111-4111-8111-111111111111" });
  assert.equal(response.status, 403);
  assert.equal(cancellations, 0);
});

test("direct intent cancellation accepts the authorized source interaction", async () => {
  let cancellation;
  const pool = { query: async sql => {
    if (sql.includes("FROM acd_direct_intents")) return { rows: [{ id: "22222222-2222-4222-8222-222222222222", agent_id: "consultant", work_item_id: "work-a", purpose: "consult_target" }] };
    if (sql.includes("FROM acd_work_items")) return { rows: [{ id: "work-a", terminal_at: null, agent_id: "initiator", agent_username: "agent-a", call_control_id: "v3:customer" }] };
    return { rows: [], rowCount: 0 };
  } };
  const route = await loadRoute("app/api/voice/direct-intent/route.js", {
    "@/lib/auth-server": { getAuthenticatedUser: async () => ({ id: "initiator", username: "agent-a", roles: ["agent"] }) },
    "@/lib/postgres.mjs": { getPostgresPool: () => pool },
    "@/lib/acd/direct-capacity.mjs": {
      reserveDirectVoice: async () => null,
      reserveCoreTarget: async () => null,
      cancelUnstartedDirectIntent: async (_pool, args) => { cancellation = args; return true; },
    },
    "@/lib/voice/interaction-control-policy.mjs": { authorizePersistedInteractionControl },
  });
  const response = await route.DELETE({ url: "http://test.local/api/voice/direct-intent?id=22222222-2222-4222-8222-222222222222" });
  assert.equal(response.status, 200);
  assert.deepEqual(cancellation, { id: "22222222-2222-4222-8222-222222222222", workItemId: "work-a" });
});

test("direct intent cancellation rejects malformed UUIDs before database access", async () => {
  let queries = 0;
  const route = await loadRoute("app/api/voice/direct-intent/route.js", {
    "@/lib/auth-server": { getAuthenticatedUser: async () => ({ id: "agent-a", username: "agent-a", roles: ["agent"] }) },
    "@/lib/postgres.mjs": { getPostgresPool: () => ({ query: async () => { queries++; throw new Error("Unexpected database access"); } }) },
    "@/lib/acd/direct-capacity.mjs": {
      reserveDirectVoice: async () => null,
      reserveCoreTarget: async () => null,
      cancelUnstartedDirectIntent: async () => false,
    },
    "@/lib/voice/interaction-control-policy.mjs": { authorizePersistedInteractionControl },
  });
  for (const id of ["------------------------------------", "a".repeat(36), "11111111-1111-1111-1111-11111111111z"]) {
    const response = await route.DELETE({ url: `http://test.local/api/voice/direct-intent?id=${id}` });
    assert.equal(response.status, 400);
  }
  assert.equal(queries, 0);
});

test("acting on another agent's interaction stays allowed for supervisors but is audited", async () => {
  const statements = [];
  // appendEvent reads back the inserted row, so a mock that returns nothing
  // makes the audit throw and the assertion pass for the wrong reason.
  const pool = {
    query: async (sql, values) => {
      statements.push({ sql, values });
      if (/FROM acd_work_items/i.test(sql)) return { rows: [{ id: "work-a", terminal_at: null, agent_id: "agent-a-id", agent_username: "agent-a", call_control_id: "v3:customer" }], rowCount: 1 };
      if (/INSERT INTO acd_events/i.test(sql)) return { rows: [{ id: 1, occurred_at: new Date().toISOString() }], rowCount: 1 };
      if (/INSERT INTO acd_outbox/i.test(sql)) return { rows: [{ seq: 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  const interaction = { id: "work-a", work_item_id: "work-a" };

  const owner = await authorizePersistedInteractionControl(pool, interaction, { username: "agent-a", roles: ["agent"] });
  assert.equal(owner.ok, true);
  assert.equal(owner.privileged, false, "owning your own interaction is not a privileged act");
  assert.equal(statements.filter(entry => /INSERT INTO acd_events/i.test(entry.sql)).length, 0);

  const supervisor = await authorizePersistedInteractionControl(
    pool, interaction, { username: "sup", roles: ["supervisor"] }, { operation: "transfer" },
  );
  assert.equal(supervisor.ok, true);
  assert.equal(supervisor.privileged, true);

  const audit = statements.filter(entry => /INSERT INTO acd_events/i.test(entry.sql));
  assert.equal(audit.length, 1, "a supervisor acting on a foreign interaction is recorded");
  const [, , type, payload, actor] = audit[0].values;
  assert.equal(type, "privileged_interaction_control");
  assert.equal(actor, "supervisor:sup");
  assert.deepEqual(JSON.parse(payload), {
    owner_username: "agent-a",
    call_control_id: "v3:customer",
    operation: "transfer",
    roles: ["supervisor"],
  });
  assert.equal(statements.filter(entry => /INSERT INTO acd_outbox/i.test(entry.sql)).length, 1);
});

test("an audit write failure is reported but never strands the supervisor", async () => {
  const errors = [];
  const original = console.error;
  const pool = {
    query: async (sql) => {
      if (/FROM acd_work_items/i.test(sql)) return { rows: [{ id: "work-b", terminal_at: null, agent_id: "agent-a-id", agent_username: "agent-a", call_control_id: "v3:customer" }], rowCount: 1 };
      if (/INSERT INTO acd_events/i.test(sql)) throw new Error("audit table unavailable");
      return { rows: [], rowCount: 0 };
    },
  };
  console.error = (...args) => errors.push(args);
  try {
    const decision = await authorizePersistedInteractionControl(
      pool,
      { id: "work-b", work_item_id: "work-b" },
      { username: "sup", roles: ["supervisor"] },
      { operation: "consult" },
    );
    assert.equal(decision.ok, true, "an audit outage must not block an incident response");
    assert.equal(decision.privileged, true);
  } finally {
    console.error = original;
  }
  assert.equal(errors.length, 1, "the failure is surfaced, not swallowed");
  assert.match(String(errors[0][0]), /privileged interaction control audit failed/);
  assert.equal(errors[0][1].operation, "consult");
});
