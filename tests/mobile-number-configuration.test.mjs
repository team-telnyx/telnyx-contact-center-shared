import test from "node:test";
import assert from "node:assert/strict";
import { loadRoute } from "./helpers/route-harness.mjs";

const request = (path) => new Request(`https://cc.test${path}`, { headers: { Authorization: "Bearer fixture" } });
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data, text: async () => "provider error" });
function deps(fetch, authenticated = true) {
  return {
    env: { AUTHZ_MODE: "enforce", TELNYX_API_KEY: "test-only" },
    "@/lib/auth-server": { getAuthenticatedUser: async () => authenticated ? { id: "owner", roles: ["owner"] } : null },
    "@/lib/postgres.mjs": { getPostgresPool: () => null },
    "@/lib/runtime-logging.mjs": { adminRuntimeLogger: { error() {} }, runtimePayload: (value) => value },
    fetch,
  };
}
const detailRoute = "app/api/admin/numbers/[id]/route.js";
const context = { params: Promise.resolve({ id: "number-1" }) };

test("number details use bearer auth and fetch fresh voice and messaging configuration", async () => {
  const calls = [];
  const route = await loadRoute(detailRoute, deps(async (url, options) => {
    calls.push({ url, options });
    return response({ data: url.endsWith("/messaging") ? { messaging_profile_id: "m1" } : { id: "number-1", connection_id: "v1" } });
  }));
  const result = await route.GET(request("/api/admin/numbers/number-1"), context);
  assert.equal(result.status, 200);
  assert.equal(result.body.data.connection_id, "v1");
  assert.equal(result.body.messaging.messaging_profile_id, "m1");
  assert.equal(result.body.messagingAvailable, true);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(({ options }) => options.cache === "no-store"));
});

test("messaging failure is explicit instead of an unassigned profile", async () => {
  const route = await loadRoute(detailRoute, deps(async (url) => url.endsWith("/messaging") ? response({}, 503) : response({ data: { id: "number-1" } })));
  const result = await route.GET(request("/api/admin/numbers/number-1"), context);
  assert.equal(result.status, 200);
  assert.equal(result.body.messagingAvailable, false);
  assert.equal(result.body.messaging, null);
  assert.ok(result.body.messagingError);
});

test("number details and catalogs reject unauthenticated access before provider I/O", async () => {
  for (const path of [detailRoute, "app/api/admin/connections/route.js", "app/api/admin/messaging-profiles/route.js"]) {
    const route = await loadRoute(path, deps(() => { throw new Error("Must not contact provider"); }, false));
    const result = await route.GET(request("/api/admin/numbers/number-1"), context);
    assert.equal(result.status, 401);
  }
});

test("voice profile pages are bounded, preserve total and return only picker fields", async () => {
  for (const [kind, path] of [["texml", "texml_applications"], ["voice-api", "call_control_applications"], ["sip", "connections"]]) {
    const route = await loadRoute("app/api/admin/connections/route.js", deps(async (url) => {
      assert.ok(url.includes(`/v2/${path}?page[size]=25&page[number]=3`));
      return response({ data: [{ id: "v1", friendly_name: "Support", secret: "not-for-mobile" }], meta: { total_results: 125 } });
    }));
    const result = await route.GET(request(`/api/admin/connections?kind=${kind}&pageSize=1000&page=3`));
    assert.equal(result.status, 200);
    assert.equal(result.body.meta.total, 125);
    assert.equal(result.body.data[0].connection_name, "Support");
    assert.equal(result.body.data[0].secret, undefined);
  }
});

test("invalid connection type and provider failure do not return empty successful catalogs", async () => {
  const route = await loadRoute("app/api/admin/connections/route.js", deps(async () => response({}, 503)));
  assert.equal((await route.GET(request("/api/admin/connections?kind=unknown&pageSize=25"))).status, 400);
  assert.equal((await route.GET(request("/api/admin/connections?kind=sip&pageSize=25"))).status, 503);
});

test("messaging profiles support bearer and bounded pages while preserving the existing web contract", async () => {
  const urls = [];
  const route = await loadRoute("app/api/admin/messaging-profiles/route.js", deps(async (url) => {
    urls.push(url);
    return response({ data: [{ id: "m1", name: "Support", extra: true }], meta: { total_results: 73 } });
  }));
  const mobile = await route.GET(request("/api/admin/messaging-profiles?pageSize=25&page=2"));
  assert.deepEqual(mobile.body, { data: [{ id: "m1", name: "Support" }], meta: { total: 73 } });
  assert.ok(urls[0].includes("page[size]=25&page[number]=2"));
  const web = await route.GET(request("/api/admin/messaging-profiles"));
  assert.equal(web.body.data[0].extra, true);
  assert.ok(urls[1].includes("page[size]=250"));
});
