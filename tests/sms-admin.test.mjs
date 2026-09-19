import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prepareAcdTestPool, seedQueue } from "./helpers/acd-test-db.mjs";
import { smsAdminAction, smsAdminOverview, smsAdminResource, ensureSmsProfileWebhook } from "../lib/sms/admin.mjs";

const pool = await prepareAcdTestPool("acd_core_test_sms_admin");
await pool.query(`DROP TABLE IF EXISTS app_settings; CREATE TABLE app_settings(id text PRIMARY KEY,cc_settings jsonb);`);
after(() => pool.end());
beforeEach(() => {
  delete process.env.TELNYX_WEBHOOK_BASE_URL; delete process.env.NEXT_PUBLIC_BASE_URL; delete process.env.NEXTAUTH_URL;
  process.env.APP_BASE_URL = "https://contact.example.com";
  process.env.TELNYX_WEBHOOK_PUBLIC_KEY = "test-public-key";
});

// Stateful in-memory Telnyx messaging API: profiles, numbers and their assignments.
function telnyx({ profiles = [], numbers = [] } = {}) {
  const calls = [];
  const request = async (path, options = {}) => {
    calls.push({ path, method: options.method || "GET", body: options.body });
    const url = new URL(`https://api.test${path}`);
    if (url.pathname === "/messaging_profiles" && !options.method) return { data: profiles, meta: { total_pages: 1 } };
    if (url.pathname === "/messaging_profiles" && options.method === "POST") { const created = { id: `mp-${profiles.length + 1}`, enabled: true, ...options.body }; profiles.push(created); return { data: created }; }
    const profile = url.pathname.match(/^\/messaging_profiles\/([^/]+)$/);
    if (profile) {
      const row = profiles.find(p => p.id === decodeURIComponent(profile[1]));
      if (!row) throw Object.assign(new Error("Resource not found"), { status: 404 });
      if (options.method === "PATCH") Object.assign(row, options.body);
      return { data: row };
    }
    if (url.pathname === "/phone_numbers/messaging") return { data: numbers, meta: { total_pages: 1 } };
    const assignment = url.pathname.match(/^\/phone_numbers\/([^/]+)\/messaging$/);
    if (assignment && options.method === "PATCH") {
      const row = numbers.find(n => n.id === decodeURIComponent(assignment[1]));
      if (!row) throw Object.assign(new Error("Number not found"), { status: 404 });
      row.messaging_profile_id = options.body.messaging_profile_id; return { data: row };
    }
    throw new Error(`Unexpected request ${options.method || "GET"} ${path}`);
  };
  return { request, calls, profiles, numbers };
}

test("connecting a profile registers the application webhook once and keeps a foreign profile untouched", async () => {
  const api = telnyx({ profiles: [{ id: "mp-1", name: "Marketing", enabled: true, webhook_url: "https://other.example.com/hook", webhook_api_version: "1", whitelisted_destinations: [] },
    { id: "mp-2", name: "Ready", enabled: true, webhook_url: "https://contact.example.com/api/webhooks/telnyx/sms", webhook_api_version: "2", whitelisted_destinations: ["*"] }] });
  const connected = await smsAdminAction(pool, { action: "connect_profile", profileId: "mp-1" }, "admin", { request: api.request });
  assert.equal(connected.warning, undefined);
  const patch = api.calls.find(c => c.method === "PATCH");
  assert.deepEqual(patch.body, { webhook_url: "https://contact.example.com/api/webhooks/telnyx/sms", webhook_api_version: "2", whitelisted_destinations: ["*"] });
  assert.equal(api.profiles[0].webhook_url, "https://contact.example.com/api/webhooks/telnyx/sms");
  const before = api.calls.length;
  await smsAdminAction(pool, { action: "connect_profile", profileId: "mp-2" }, "admin", { request: api.request });
  assert.equal(api.calls.slice(before).filter(c => c.method === "PATCH").length, 0, "a profile that already points at the application is not rewritten");
  const overview = await smsAdminOverview(pool);
  assert.deepEqual(overview.profiles.map(p => p.id).sort(), ["mp-1", "mp-2"]);
  assert.equal(overview.webhookUrl, "https://contact.example.com/api/webhooks/telnyx/sms");
  const listed = await smsAdminResource(pool, new URLSearchParams({ resource: "profiles" }), { request: api.request });
  assert.equal(listed.data.find(p => p.id === "mp-1").webhook_matches, true);
  assert.equal(listed.data.find(p => p.id === "mp-1").connected, true);
});

test("creating a Contact Center profile sends the webhook in the creation request", async () => {
  const api = telnyx();
  const created = await smsAdminAction(pool, { action: "connect_profile", create: true, name: "Contact Center" }, "admin", { request: api.request });
  assert.equal(created.result.id, "mp-1");
  assert.equal(api.calls[0].method, "POST");
  assert.equal(api.calls[0].body.webhook_url, "https://contact.example.com/api/webhooks/telnyx/sms");
  assert.deepEqual(api.calls[0].body.whitelisted_destinations, ["*"]);
});

test("webhook registration fails closed without a public HTTPS base or verification key", async () => {
  process.env.APP_BASE_URL = "http://localhost:3000";
  await assert.rejects(ensureSmsProfileWebhook({ id: "mp-x" }, async () => ({})), /HTTPS/);
  process.env.APP_BASE_URL = "https://contact.example.com"; delete process.env.TELNYX_WEBHOOK_PUBLIC_KEY; delete process.env.TELNYX_WEBHOOK_SECRET;
  await assert.rejects(ensureSmsProfileWebhook({ id: "mp-x" }, async () => ({})), /public key/);
  const api = telnyx({ profiles: [{ id: "mp-9", name: "Late", enabled: true }] });
  const connected = await smsAdminAction(pool, { action: "connect_profile", profileId: "mp-9" }, "admin", { request: api.request });
  assert.match(connected.warning, /incomplete/);
  assert.equal((await pool.query("SELECT last_error,webhook_verified_at FROM cc_sms_profiles WHERE id='mp-9'")).rows[0].webhook_verified_at, null);
});

test("mapping a number assigns it to the connected profile in Telnyx and enforces queue channel state", async () => {
  const queueId = randomUUID(); await seedQueue(pool, queueId, []);
  const api = telnyx({ profiles: [{ id: "mp-cc", name: "Contact Center", enabled: true, webhook_url: "https://contact.example.com/api/webhooks/telnyx/sms", webhook_api_version: "2", whitelisted_destinations: ["*"] }],
    numbers: [{ id: "pn-1", phone_number: "+14155550100", messaging_profile_id: "mp-old", type: "long-code", country_code: "US", features: { sms: { domestic_two_way: true, international_inbound: true, international_outbound: true } } }] });
  await smsAdminAction(pool, { action: "connect_profile", profileId: "mp-cc" }, "admin", { request: api.request });
  await assert.rejects(smsAdminAction(pool, { action: "save_number", phoneNumber: "+14155550100", providerNumberId: "pn-1", profileId: "mp-cc", name: "Sales", queueId, routingEnabled: true }, "admin", { request: api.request }), /Utilization/);
  await pool.query("INSERT INTO cc_queue_channels(queue_id,channel,enabled,max_concurrent,weight) VALUES($1,'sms',true,4,0.25)", [queueId]);
  const saved = await smsAdminAction(pool, { action: "save_number", phoneNumber: "+1 (415) 555-0100", providerNumberId: "pn-1", profileId: "mp-cc", name: "Sales", queueId, routingEnabled: true, sendingEnabled: true, countryCode: "us", numberType: "long-code" }, "admin", { request: api.request });
  assert.equal(saved.result.phone_number, "+14155550100");
  assert.equal(api.numbers[0].messaging_profile_id, "mp-cc");
  assert.ok(api.calls.some(c => c.method === "PATCH" && c.path === "/phone_numbers/pn-1/messaging"));
  await assert.rejects(smsAdminAction(pool, { action: "save_number", phoneNumber: "+14155550100", name: "Dup", queueId }, "admin", { request: api.request }), /already mapped/);
  await assert.rejects(smsAdminAction(pool, { action: "save_number", phoneNumber: "+14155550101", name: "Orphan", queueId, profileId: "mp-unknown" }, "admin", { request: api.request }), /Connect the messaging profile/);
  const inventory = await smsAdminResource(pool, new URLSearchParams({ resource: "numbers" }), { request: api.request });
  assert.equal(inventory.data[0].managed.queue_id, queueId);
  assert.equal(inventory.data[0].two_way, true);
  const stale = await smsAdminAction(pool, { action: "save_number", id: saved.result.id, version: 999, phoneNumber: "+14155550100", name: "Sales", queueId, sendingEnabled: false }, "admin", { request: api.request }).catch(e => e);
  assert.equal(stale.status, 409);
  const updated = await smsAdminAction(pool, { action: "save_number", id: saved.result.id, version: saved.result.version, phoneNumber: "+14155550100", name: "Sales desk", queueId, profileId: "mp-cc", assignProfile: false, routingEnabled: false, sendingEnabled: false }, "admin", { request: api.request });
  assert.equal(api.calls.filter(c => c.method === "PATCH" && c.path === "/phone_numbers/pn-1/messaging").length, 1, "an update without assignProfile does not call Telnyx again");
  assert.equal(updated.result.name, "Sales desk");
  await assert.rejects(smsAdminAction(pool, { action: "disconnect_profile", profileId: "mp-cc" }, "admin", { request: api.request }), /numbers/);
  const overview = await smsAdminOverview(pool);
  assert.equal(overview.numbers.find(n => n.id === saved.result.id).queue_sms_enabled, true);
  assert.ok(overview.audit.length >= 3);
  assert.equal((await smsAdminAction(pool, { action: "remove_number", id: saved.result.id }, "admin", { request: api.request })).result.removed, true);
  await smsAdminAction(pool, { action: "disconnect_profile", profileId: "mp-cc" }, "admin", { request: api.request });
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM cc_sms_profiles WHERE id='mp-cc'")).rows[0].n, 0);
});

test("SMS Copilot settings are stored separately and inherit chat until saved", async () => {
  const api = telnyx();
  await pool.query(`INSERT INTO app_settings VALUES('default','{"chat_copilot":{"model":"chat-model","bucketIds":[]}}') ON CONFLICT(id) DO UPDATE SET cc_settings=EXCLUDED.cc_settings`);
  assert.equal((await smsAdminOverview(pool)).copilot.model, "chat-model");
  await smsAdminAction(pool, { action: "save_copilot", settings: { model: "sms-model", bucketIds: ["kb"], maxTokens: 2000 } }, "admin", { request: api.request });
  assert.equal((await smsAdminOverview(pool)).copilot.model, "sms-model");
  await assert.rejects(smsAdminAction(pool, { action: "unknown" }, "admin", { request: api.request }), /Unsupported/);
});
