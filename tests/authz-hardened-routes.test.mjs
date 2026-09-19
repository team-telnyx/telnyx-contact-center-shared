import test from "node:test";
import assert from "node:assert/strict";
import { loadRoute } from "./helpers/route-harness.mjs";
import { authzGuardStub, roleUtilsStub, USERS } from "./helpers/authz-harness.mjs";
import { assertPublicHostname } from "../lib/security/outbound-url.mjs";

const quiet = { error() {}, warn() {}, info() {} };
const logging = { adminRuntimeLogger: quiet, contactCenterRuntimeLogger: quiet, platformApiLogger: quiet, platformDbLogger: quiet, voiceRuntimeLogger: quiet, runtimePayload: (v) => v };

function providerFetch(counter) {
  return async () => { counter.calls += 1; return { ok: true, status: 200, headers: { get: () => "application/json", entries: () => [] }, json: async () => ({ data: [] }), text: async () => "{}" }; };
}

async function assistantsRoute({ user }) {
  const counter = { calls: 0 };
  const route = await loadRoute("app/api/ai/assistants/route.js", {
    "@/lib/authz/guard": authzGuardStub({ user }),
    "@/lib/role-utils": roleUtilsStub,
    "@/lib/telnyx": { buildTelnyxV2Url: (path) => `https://provider.test${path}` },
    "@/lib/postgres.mjs": { getPostgresPool: () => null },
    "@/lib/runtime-logging.mjs": logging,
    "@/lib/ai/assistant-payload.mjs": { normalizeAssistantPayload: (v) => v },
    "@/lib/telnyx-error.mjs": { telnyxErrorDetail: () => "" },
    env: { TELNYX_API_KEY: "test-only" },
    fetch: providerFetch(counter),
  });
  return { route, counter };
}

const listRequest = { url: "http://test.local/api/ai/assistants?pageSize=10", method: "GET", headers: { get: () => null } };

test("/api/ai/assistants: anonymous 401, agent 403, supervisor may list, only admin may create", async () => {
  const anon = await assistantsRoute({ user: USERS.anonymous });
  assert.equal((await anon.route.GET(listRequest, {})).status, 401);
  assert.equal(anon.counter.calls, 0, "no provider call before authentication");

  const agent = await assistantsRoute({ user: USERS.agent });
  assert.equal((await agent.route.GET(listRequest, {})).status, 403);
  assert.equal(agent.counter.calls, 0);

  const supervisor = await assistantsRoute({ user: USERS.supervisor });
  assert.equal((await supervisor.route.GET(listRequest, {})).status, 200, "scheduled events lets supervisors pick an assistant");
  assert.equal(supervisor.counter.calls, 1);
  const created = await supervisor.route.POST({ url: "http://test.local/api/ai/assistants", method: "POST", json: async () => ({ name: "x" }) }, {});
  assert.equal(created.status, 403, "creating assistants stays admin-only");

  const admin = await assistantsRoute({ user: USERS.admin });
  assert.equal((await admin.route.POST({ url: "http://test.local/api/ai/assistants", method: "POST", json: async () => ({ name: "x" }) }, {})).status, 200);
});

test("the permission decides: a conversation designer lists assistants, an agent does not", async () => {
  const designer = await assistantsRoute({ user: USERS.designer });
  assert.equal((await designer.route.GET(listRequest, {})).status, 200, "ai_assistants:* is part of the shipped role");
  const agent = await assistantsRoute({ user: USERS.agent });
  assert.equal((await agent.route.GET(listRequest, {})).status, 403);
});

async function webPagesRoute({ user }) {
  const pool = { query: async () => ({ rows: [], rowCount: 0 }) };
  return loadRoute("app/api/admin/web-pages/route.js", {
    "@/lib/authz/guard": authzGuardStub({ user }),
    "@/lib/role-utils": roleUtilsStub,
    "@/lib/auth-server": { getAuthenticatedUser: async () => user },
    "@/lib/postgres.mjs": { getPostgresPool: () => pool },
    "@/lib/secrets": { resolveSimpleSecretReferences: async (v) => v },
    "@/lib/runtime-logging.mjs": logging,
    crypto: { randomUUID: () => "id" },
  });
}

test("/api/admin/web-pages: agents keep reading (desktop web pages), only admins write", async () => {
  const agent = await webPagesRoute({ user: USERS.agent });
  assert.equal((await agent.GET({ url: "http://test.local/api/admin/web-pages?activeOnly=true", method: "GET" }, {})).status, 200);
  assert.equal((await agent.POST({ url: "http://test.local/api/admin/web-pages", method: "POST", json: async () => ({ title: "x", url: "https://example.com" }) }, {})).status, 403);
  const admin = await webPagesRoute({ user: USERS.admin });
  const response = await admin.POST({ url: "http://test.local/api/admin/web-pages", method: "POST", json: async () => ({ title: "x", url: "https://example.com" }) }, {});
  assert.notEqual(response.status, 403, "admins pass the guard (the handler then validates the body)");
  const anon = await webPagesRoute({ user: null });
  assert.equal((await anon.GET({ url: "http://test.local/api/admin/web-pages", method: "GET" }, {})).status, 401);
});

test("/api/tts/voices: agents are refused, supervisors and admins pass", async () => {
  const load = async (user) => {
    const counter = { calls: 0 };
    const route = await loadRoute("app/api/tts/voices/route.js", {
      "@/lib/authz/guard": authzGuardStub({ user }),
      "@/lib/role-utils": roleUtilsStub,
      "@/lib/telnyx": { buildTelnyxV2Url: (path) => `https://provider.test${path}` },
      "@/lib/runtime-logging.mjs": logging,
      env: { TELNYX_API_KEY: "test-only" },
      fetch: providerFetch(counter),
    });
    return { route, counter };
  };
  const request = { url: "http://test.local/api/tts/voices", method: "GET" };
  const agent = await load(USERS.agent);
  assert.equal((await agent.route.GET(request, {})).status, 403);
  assert.equal(agent.counter.calls, 0);
  assert.equal((await (await load(USERS.supervisor)).route.GET(request, {})).status, 200);
  assert.equal((await (await load(USERS.admin)).route.GET(request, {})).status, 200);
});

test("/api/config/supervisor-number: any signed-in user, never anonymous", async () => {
  const load = (user) => loadRoute("app/api/config/supervisor-number/route.js", { "@/lib/authz/guard": authzGuardStub({ user }), "@/lib/runtime-logging.mjs": logging, env: { TELNYX_SUPERVISOR_FROM_NUMBER: "+15550001111" } });
  assert.equal((await (await load(null)).GET({ url: "http://test.local/api/config/supervisor-number", method: "GET" }, {})).status, 401);
  const agent = await (await load(USERS.agent)).GET({ url: "http://test.local/api/config/supervisor-number", method: "GET" }, {});
  assert.equal(agent.status, 200);
  assert.equal(agent.body.supervisorNumber, "+15550001111");
});

test("/api/voice/flows/test-http-request: admin only, and private targets are refused before any request", async () => {
  const load = async ({ user, outbound }) => {
    const counter = { calls: 0 };
    const route = await loadRoute("app/api/voice/flows/test-http-request/route.js", {
      "@/lib/authz/guard": authzGuardStub({ user }),
      "@/lib/role-utils": roleUtilsStub,
      "@/lib/secrets.js": { resolveSecretReferences: async (v) => v },
      "@/lib/security/outbound-url.mjs": outbound,
      "@/lib/runtime-logging.mjs": logging,
      fetch: providerFetch(counter),
    });
    return { route, counter };
  };
  const post = (route, url) => route.POST({ url: "http://test.local/api/voice/flows/test-http-request", method: "POST", json: async () => ({ url, method: "GET" }) }, {});

  const agent = await load({ user: USERS.agent, outbound: { assertPublicHostname } });
  assert.equal((await post(agent.route, "https://example.com/")).status, 403);
  assert.equal(agent.counter.calls, 0);

  const loopback = await load({ user: USERS.admin, outbound: { assertPublicHostname } });
  const refused = await post(loopback.route, "http://127.0.0.1:8080/internal");
  assert.equal(refused.status, 400);
  assert.equal(loopback.counter.calls, 0, "no request leaves the server for a loopback target");
  const metadata = await post(loopback.route, "http://169.254.169.254/latest/meta-data/");
  assert.equal(metadata.status, 400);
  assert.equal((await post(loopback.route, "ftp://example.com/x")).status, 400);

  const allowed = await load({ user: USERS.admin, outbound: { assertPublicHostname: async () => true } });
  const ok = await post(allowed.route, "https://example.com/");
  assert.equal(ok.status, 200);
  assert.equal(allowed.counter.calls, 1);
});
