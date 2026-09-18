import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prepareAcdTestPool, seedQueue } from "./helpers/acd-test-db.mjs";
import { whatsappAdminAction, whatsappAdminOverview, whatsappAdminResource, ensureWhatsAppProfileWebhook } from "../lib/whatsapp/admin.mjs";
import { resolveWhatsAppCredentials, forgetWhatsAppCredentials } from "../lib/whatsapp/provider.mjs";

const pool = await prepareAcdTestPool("acd_core_test_whatsapp_admin");
await pool.query(`DROP TABLE IF EXISTS app_settings; CREATE TABLE app_settings(id text PRIMARY KEY,cc_settings jsonb);`);
after(() => pool.end());
beforeEach(async () => {
  delete process.env.TELNYX_WEBHOOK_BASE_URL; delete process.env.NEXT_PUBLIC_BASE_URL; delete process.env.NEXTAUTH_URL;
  process.env.APP_BASE_URL = "https://contact.example.com"; process.env.TELNYX_WEBHOOK_PUBLIC_KEY = "test-public-key"; delete process.env.TELNYX_WEBHOOK_PUBLIC_KEY_WHATSAPP;
  forgetWhatsAppCredentials();
  // Primary account without a WABA, backup account with one: the backup key is resolved and cached.
  await resolveWhatsAppCredentials({ force: true, env: { TELNYX_API_KEY: "primary", TELNYX_API_KEY_WHATSAPP: "backup" },
    fetchImpl: async (url, options) => new Response(JSON.stringify({ data: options.headers.Authorization === "Bearer backup" ? [{ id: "acct-1", waba_id: "waba-1" }] : [] }), { status: 200 }) });
});

// Stateful in-memory Telnyx API: WhatsApp business accounts, numbers, templates and messaging profiles.
function telnyx({ accounts = [], numbers = [], templates = [], profiles = [] } = {}) {
  const calls = [];
  const settings = new Map(accounts.map(a => [a.id, { id: a.id, name: a.name, timezone: "UTC", webhook_url: "", webhook_failover_url: "", webhook_enabled: false, webhook_events: [] }]));
  const profilesOf = new Map(numbers.map(n => [n.phone_number, { display_name: n.display_name, category: "OTHER", about: "", description: "", email: "", website: "", address: "", profile_id: n.profile_id || "mp-portal" }]));
  const request = async (path, options = {}) => {
    calls.push({ path, method: options.method || "GET", body: options.body });
    const url = new URL(`https://api.test${path}`);
    const p = url.pathname;
    let m;
    if (p === "/whatsapp/business_accounts") return { data: accounts, meta: { total_pages: 1 } };
    if ((m = p.match(/^\/whatsapp\/business_accounts\/([^/]+)\/settings$/))) {
      const row = settings.get(decodeURIComponent(m[1])); if (!row) throw Object.assign(new Error("Not found"), { status: 404 });
      if (options.method === "PATCH") Object.assign(row, options.body, { updated_at: "2026-09-15T10:00:00Z" });
      return { data: row };
    }
    if ((m = p.match(/^\/whatsapp\/business_accounts\/([^/]+)\/phone_numbers$/)) && options.method === "POST") { numbers.push({ phone_number: options.body.phone_number, display_name: options.body.display_name, status: "PENDING", waba_id: accounts.find(a => a.id === decodeURIComponent(m[1]))?.waba_id }); return {}; }
    if ((m = p.match(/^\/whatsapp\/business_accounts\/([^/]+)$/))) { const row = accounts.find(a => a.id === decodeURIComponent(m[1])); if (!row) throw Object.assign(new Error("Not found"), { status: 404 }); return { data: row }; }
    if (p === "/whatsapp/phone_numbers") return { data: numbers, meta: { total_pages: 1 } };
    if ((m = p.match(/^\/whatsapp\/phone_numbers\/([^/]+)\/profile$/))) {
      const phone = decodeURIComponent(m[1]); const row = profilesOf.get(phone); if (!row) throw Object.assign(new Error("Number not found"), { status: 404 });
      if (options.method === "PATCH") Object.assign(row, options.body);
      return { data: row };
    }
    if ((m = p.match(/^\/whatsapp\/phone_numbers\/([^/]+)\/calling_settings$/))) { const number = numbers.find(n => n.phone_number === decodeURIComponent(m[1])); if (options.method === "PATCH") number.calling_enabled = options.body.enabled; return { data: { enabled: Boolean(number?.calling_enabled) } }; }
    if ((m = p.match(/^\/whatsapp\/phone_numbers\/([^/]+)\/profile\/photo$/))) return { data: { profile_photo_url: "" } };
    if ((m = p.match(/^\/whatsapp\/phone_numbers\/([^/]+)\/(verify|resend_verification)$/))) { if (m[2] === "verify") numbers.find(n => n.phone_number === decodeURIComponent(m[1])).status = "CONNECTED"; return {}; }
    if ((m = p.match(/^\/whatsapp\/phone_numbers\/([^/]+)$/)) && options.method === "DELETE") { const index = numbers.findIndex(n => n.phone_number === decodeURIComponent(m[1])); numbers.splice(index, 1); return {}; }
    if (p === "/whatsapp/message_templates" && !options.method) return { data: templates.filter(t => !url.searchParams.get("filter[waba_id]") || t.whatsapp_business_account?.waba_id === url.searchParams.get("filter[waba_id]")), meta: { total_pages: 1 } };
    if (p === "/whatsapp/message_templates" && options.method === "POST") { const created = { id: `tpl-${templates.length + 1}`, status: "PENDING", ...options.body, whatsapp_business_account: { waba_id: options.body.waba_id } }; templates.push(created); return { data: created }; }
    if ((m = p.match(/^\/whatsapp\/message_templates\/([^/]+)$/))) {
      const index = templates.findIndex(t => t.id === decodeURIComponent(m[1])); if (index < 0) throw Object.assign(new Error("Template not found"), { status: 404 });
      if (options.method === "DELETE") { templates.splice(index, 1); return {}; }
      if (options.method === "PATCH") Object.assign(templates[index], options.body);
      return { data: templates[index] };
    }
    if (p === "/messaging_profiles" && !options.method) return { data: profiles, meta: { total_pages: 1 } };
    if (p === "/messaging_profiles" && options.method === "POST") { const created = { id: `mp-${profiles.length + 1}`, enabled: true, ...options.body }; profiles.push(created); return { data: created }; }
    if ((m = p.match(/^\/messaging_profiles\/([^/]+)$/))) { const row = profiles.find(x => x.id === decodeURIComponent(m[1])); if (!row) throw Object.assign(new Error("Resource not found"), { status: 404 }); if (options.method === "PATCH") Object.assign(row, options.body); return { data: row }; }
    throw new Error(`Unexpected request ${options.method || "GET"} ${path}`);
  };
  return { request, calls, accounts, numbers, templates, profiles, profilesOf };
}
const baseAccount = () => ({ id: "acct-1", waba_id: "waba-1", name: "Telnyx Internal", status: "ACTIVE", phone_numbers_count: 2, business_verification_status: "verified", account_review_status: "APPROVED", country: "US", created_at: "2026-01-01T00:00:00Z" });
const baseNumbers = () => [{ phone_number: "+14155550100", phone_number_id: "pn-1", waba_id: "waba-1", display_name: "Support", quality_rating: "GREEN", status: "CONNECTED", enabled: true, calling_enabled: false },
  { phone_number: "+14155550101", phone_number_id: "pn-2", waba_id: "waba-1", display_name: "Demo portal", quality_rating: "GREEN", status: "CONNECTED", enabled: true }];

test("credentials fall back to the backup account and the overview reports it", async () => {
  const overview = await whatsappAdminOverview(pool);
  assert.deepEqual([overview.credentials.source, overview.credentials.resolved, overview.credentials.wabaCount], ["backup", true, 1]);
  assert.deepEqual(overview.credentials.checks.map(c => [c.source, c.configured, c.wabaCount]), [["primary", true, 0], ["backup", true, 1]]);
  assert.equal(overview.webhookUrl, "https://contact.example.com/api/webhooks/telnyx/whatsapp");
  assert.equal(overview.backupWebhookKeyConfigured, false);
  process.env.TELNYX_WEBHOOK_PUBLIC_KEY_WHATSAPP = "backup-key";
  assert.equal((await whatsappAdminOverview(pool)).backupWebhookKeyConfigured, true);
});

test("connecting a messaging profile registers the application webhook once and keeps a foreign profile untouched", async () => {
  const api = telnyx({ profiles: [{ id: "mp-1", name: "Demo portal WhatsApp", enabled: true, webhook_url: "https://demo.example.com/api/messaging/whatsapp/webhook", webhook_api_version: "2", whitelisted_destinations: ["*"] },
    { id: "mp-2", name: "Ready", enabled: true, webhook_url: "https://contact.example.com/api/webhooks/telnyx/whatsapp", webhook_api_version: "2", whitelisted_destinations: ["*"] }] });
  const connected = await whatsappAdminAction(pool, { action: "connect_profile", profileId: "mp-1" }, "admin", { request: api.request });
  assert.equal(connected.warning, undefined);
  assert.equal(connected.result.credential_source, "backup");
  const patch = api.calls.find(c => c.method === "PATCH");
  assert.deepEqual(patch.body, { webhook_url: "https://contact.example.com/api/webhooks/telnyx/whatsapp" });
  const before = api.calls.length;
  await whatsappAdminAction(pool, { action: "connect_profile", profileId: "mp-2" }, "admin", { request: api.request });
  assert.equal(api.calls.slice(before).filter(c => c.method === "PATCH").length, 0);
  const created = await whatsappAdminAction(pool, { action: "connect_profile", create: true, name: "Contact Center WhatsApp" }, "admin", { request: api.request });
  assert.equal(created.result.id, "mp-3");
  assert.equal(api.calls.find(c => c.method === "POST" && c.path === "/messaging_profiles").body.webhook_url, "https://contact.example.com/api/webhooks/telnyx/whatsapp");
  const listed = await whatsappAdminResource(pool, new URLSearchParams({ resource: "profiles" }), { request: api.request });
  assert.deepEqual(listed.data.filter(p => p.connected).map(p => p.id).sort(), ["mp-1", "mp-2", "mp-3"]);
  assert.equal(listed.data.find(p => p.id === "mp-1").webhook_matches, true);
  process.env.APP_BASE_URL = "http://localhost:3000";
  await assert.rejects(ensureWhatsAppProfileWebhook({ id: "mp-x" }, async () => ({})), /HTTPS/);
});

test("mapping a number points its inbound messaging profile at Contact Center and enforces queue channel state", async () => {
  const queueId = randomUUID(); await seedQueue(pool, queueId, []);
  const api = telnyx({ accounts: [baseAccount()], numbers: baseNumbers(), profiles: [{ id: "mp-cc", name: "Contact Center WhatsApp", enabled: true, webhook_url: "https://contact.example.com/api/webhooks/telnyx/whatsapp", webhook_api_version: "2", whitelisted_destinations: ["*"] }] });
  await whatsappAdminAction(pool, { action: "connect_profile", profileId: "mp-cc" }, "admin", { request: api.request });
  await assert.rejects(whatsappAdminAction(pool, { action: "save_number", phoneNumber: "+14155550100", profileId: "mp-cc", name: "Support", queueId, routingEnabled: true }, "admin", { request: api.request }), /Utilization/);
  await pool.query("INSERT INTO cc_queue_channels(queue_id,channel,enabled,max_concurrent,weight) VALUES($1,'whatsapp',true,4,0.25)", [queueId]);
  const saved = await whatsappAdminAction(pool, { action: "save_number", phoneNumber: "+1 (415) 555-0100", phoneNumberId: "pn-1", wabaId: "waba-1", displayName: "Support", profileId: "mp-cc", name: "Support", queueId, routingEnabled: true, sendingEnabled: true, qualityRating: "GREEN", providerStatus: "CONNECTED" }, "admin", { request: api.request });
  assert.equal(saved.result.phone_number, "+14155550100");
  assert.equal(api.profilesOf.get("+14155550100").profile_id, "mp-cc", "the number's inbound messaging profile now points at Contact Center");
  assert.equal(api.profilesOf.get("+14155550101").profile_id, "mp-portal", "the demo portal number keeps its own profile");
  assert.ok(api.calls.some(c => c.method === "PATCH" && c.path === "/whatsapp/phone_numbers/%2B14155550100/profile"));
  await assert.rejects(whatsappAdminAction(pool, { action: "save_number", phoneNumber: "+14155550100", name: "Dup", queueId }, "admin", { request: api.request }), /already mapped/);
  await assert.rejects(whatsappAdminAction(pool, { action: "save_number", phoneNumber: "+14155550102", name: "Orphan", queueId, profileId: "mp-unknown" }, "admin", { request: api.request }), /Connect the messaging profile/);
  const inventory = await whatsappAdminResource(pool, new URLSearchParams({ resource: "phone-numbers" }), { request: api.request });
  assert.equal(inventory.data[0].managed.queue_id, queueId);
  assert.equal(inventory.data[1].managed, null);
  const stale = await whatsappAdminAction(pool, { action: "save_number", id: saved.result.id, version: 999, phoneNumber: "+14155550100", name: "Support", queueId, sendingEnabled: false }, "admin", { request: api.request }).catch(e => e);
  assert.equal(stale.status, 409);
  const patches = api.calls.filter(c => c.method === "PATCH" && c.path.endsWith("/profile")).length;
  const updated = await whatsappAdminAction(pool, { action: "save_number", id: saved.result.id, version: saved.result.version, phoneNumber: "+14155550100", name: "Support desk", queueId, profileId: "mp-cc", assignProfile: false, routingEnabled: false, sendingEnabled: false }, "admin", { request: api.request });
  assert.equal(api.calls.filter(c => c.method === "PATCH" && c.path.endsWith("/profile")).length, patches, "an update without assignProfile does not call Telnyx again");
  assert.equal(updated.result.name, "Support desk");
  await assert.rejects(whatsappAdminAction(pool, { action: "disconnect_profile", profileId: "mp-cc" }, "admin", { request: api.request }), /numbers/);
  const overview = await whatsappAdminOverview(pool);
  assert.equal(overview.numbers.find(n => n.id === saved.result.id).queue_whatsapp_enabled, true);
  assert.ok(overview.audit.length >= 3);
  await assert.rejects(whatsappAdminAction(pool, { action: "delete_phone_number", phoneNumber: "+14155550100" }, "admin", { request: api.request }), /queue mapping/);
  assert.equal((await whatsappAdminAction(pool, { action: "remove_number", id: saved.result.id }, "admin", { request: api.request })).result.removed, true);
  await whatsappAdminAction(pool, { action: "disconnect_profile", profileId: "mp-cc" }, "admin", { request: api.request });
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM cc_whatsapp_profiles WHERE id='mp-cc'")).rows[0].n, 0);
});

test("business account details, settings, templates and phone number administration proxy Telnyx with validation", async () => {
  const api = telnyx({ accounts: [baseAccount()], numbers: baseNumbers(), templates: [{ id: "tpl-0", name: "hello", language: "en_US", category: "UTILITY", status: "APPROVED", components: [{ type: "BODY", text: "Hello {{1}}" }], whatsapp_business_account: { waba_id: "waba-1" } }] });
  const accounts = await whatsappAdminResource(pool, new URLSearchParams({ resource: "accounts" }), { request: api.request });
  assert.deepEqual([accounts.data[0].wabaId, accounts.data[0].connected], ["waba-1", false]);
  const connected = await whatsappAdminAction(pool, { action: "connect_account", accountId: "acct-1" }, "admin", { request: api.request });
  assert.deepEqual([connected.result.waba_id, connected.result.credential_source], ["waba-1", "backup"]);
  const detail = await whatsappAdminResource(pool, new URLSearchParams({ resource: "account", id: "acct-1" }), { request: api.request });
  assert.deepEqual([detail.account.name, detail.settings.webhookEnabled, detail.phoneNumbers.length], ["Telnyx Internal", false, 2]);
  await assert.rejects(whatsappAdminAction(pool, { action: "save_account_settings", accountId: "acct-1", settings: { webhookEnabled: true, webhookUrl: "http://insecure" } }, "admin", { request: api.request }), /HTTPS/);
  await assert.rejects(whatsappAdminAction(pool, { action: "save_account_settings", accountId: "acct-1", settings: { webhookEvents: ["bogus"] } }, "admin", { request: api.request }), /Unsupported/);
  const settings = await whatsappAdminAction(pool, { action: "save_account_settings", accountId: "acct-1", settings: { name: "Telnyx Internal", timezone: "Europe/Warsaw", webhookEnabled: true, webhookUrl: "https://demo.example.com/hooks", webhookEvents: ["messages", "account_updates"] } }, "admin", { request: api.request });
  assert.deepEqual([settings.result.timezone, settings.result.webhookEnabled, settings.result.webhookEvents], ["Europe/Warsaw", true, ["messages", "account_updates"]]);
  const templates = await whatsappAdminResource(pool, new URLSearchParams({ resource: "templates", "filter[waba_id]": "waba-1" }), { request: api.request });
  assert.equal(templates.data.length, 1);
  await assert.rejects(whatsappAdminAction(pool, { action: "save_template", name: "Bad Name", wabaId: "waba-1", category: "UTILITY", language: "en_US", components: [{ type: "BODY", text: "x" }] }, "admin", { request: api.request }), /lowercase/);
  await assert.rejects(whatsappAdminAction(pool, { action: "save_template", name: "starts_with_var", wabaId: "waba-1", category: "UTILITY", language: "en_US", components: [{ type: "BODY", text: "{{1}} hi" }] }, "admin", { request: api.request }), /cannot start/);
  const created = await whatsappAdminAction(pool, { action: "save_template", name: "order_update", wabaId: "waba-1", category: "UTILITY", language: "pl", components: [{ type: "BODY", text: "Zamówienie {{1}} wysłane.", example: { body_text: [["123"]] } }] }, "admin", { request: api.request });
  assert.deepEqual([created.result.id, created.result.status, created.result.language], ["tpl-2", "PENDING", "pl"]);
  const updated = await whatsappAdminAction(pool, { action: "save_template", id: "tpl-2", category: "MARKETING", components: [{ type: "BODY", text: "Promocja {{1}}!" }] }, "admin", { request: api.request });
  assert.equal(updated.result.category, "MARKETING");
  assert.equal((await whatsappAdminAction(pool, { action: "delete_template", id: "tpl-2" }, "admin", { request: api.request })).result.removed, true);
  assert.equal(api.templates.length, 1);
  const number = await whatsappAdminResource(pool, new URLSearchParams({ resource: "phone-number", phone: "+14155550100" }), { request: api.request });
  assert.deepEqual([number.phoneNumber, number.profile.profile_id, number.calling.enabled, number.managed], ["+14155550100", "mp-portal", false, null]);
  await assert.rejects(whatsappAdminAction(pool, { action: "save_phone_profile", phoneNumber: "+14155550100", profile: { about: "x".repeat(140) } }, "admin", { request: api.request }), /139/);
  await assert.rejects(whatsappAdminAction(pool, { action: "save_phone_profile", phoneNumber: "+14155550100", profile: { category: "NOPE" } }, "admin", { request: api.request }), /category/);
  const profile = await whatsappAdminAction(pool, { action: "save_phone_profile", phoneNumber: "+14155550100", profile: { displayName: "Support team", category: "PROFESSIONAL_SERVICES", about: "We help", website: "https://example.com", profileId: "mp-cc" } }, "admin", { request: api.request });
  assert.deepEqual([profile.result.display_name, profile.result.profile_id], ["Support team", "mp-cc"]);
  assert.equal((await whatsappAdminAction(pool, { action: "set_calling", phoneNumber: "+14155550100", enabled: true }, "admin", { request: api.request })).result.enabled, true);
  await whatsappAdminAction(pool, { action: "add_phone_number", accountId: "acct-1", phoneNumber: "+14155550199", displayName: "New line", verificationMethod: "sms", language: "pl_PL" }, "admin", { request: api.request });
  assert.equal(api.numbers.at(-1).status, "PENDING");
  await assert.rejects(whatsappAdminAction(pool, { action: "verify_number", phoneNumber: "+14155550199", code: "" }, "admin", { request: api.request }), /code/);
  await whatsappAdminAction(pool, { action: "resend_verification", phoneNumber: "+14155550199", verificationMethod: "voice" }, "admin", { request: api.request });
  await whatsappAdminAction(pool, { action: "verify_number", phoneNumber: "+14155550199", code: "123456" }, "admin", { request: api.request });
  assert.equal(api.numbers.at(-1).status, "CONNECTED");
  assert.equal((await whatsappAdminAction(pool, { action: "delete_phone_number", phoneNumber: "+14155550199" }, "admin", { request: api.request })).result.removed, true);
  assert.equal(api.numbers.length, 2);
  assert.equal((await whatsappAdminAction(pool, { action: "disconnect_account", accountId: "acct-1" }, "admin", { request: api.request })).result.removed, true);
});

test("WhatsApp Copilot settings are stored separately and inherit chat until saved", async () => {
  const api = telnyx();
  await pool.query(`INSERT INTO app_settings VALUES('default','{"chat_copilot":{"model":"chat-model","bucketIds":[]}}') ON CONFLICT(id) DO UPDATE SET cc_settings=EXCLUDED.cc_settings`);
  assert.equal((await whatsappAdminOverview(pool)).copilot.model, "chat-model");
  await whatsappAdminAction(pool, { action: "save_copilot", settings: { model: "wa-model", bucketIds: ["kb"], maxTokens: 2000 } }, "admin", { request: api.request });
  assert.equal((await whatsappAdminOverview(pool)).copilot.model, "wa-model");
  await assert.rejects(whatsappAdminAction(pool, { action: "unknown" }, "admin", { request: api.request }), /Unsupported/);
});
