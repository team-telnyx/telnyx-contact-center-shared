import assert from "node:assert";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { createPhoneSipConnection, phoneConnectionUserName } from "../lib/hardphones/credentials.mjs";

async function file(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("hardphone bridge product integration", () => {
  it("derives Telnyx-safe hardphone SIP usernames from MAC addresses", () => {
    assert.strictEqual(phoneConnectionUserName("00:90:8F:56:10:A5"), "phone00908F5610A5");
    assert.strictEqual(phoneConnectionUserName("00908f5610a5"), "phone00908F5610A5");
    assert.strictEqual(phoneConnectionUserName("A0:90:8F:56:10:A5"), "phoneA0908F5610A5");
    assert.doesNotThrow(() => phoneConnectionUserName("A0908F5610A5"));
    assert.strictEqual(phoneConnectionUserName("hp00908F5610A5"), "phone00908F5610A5");
    assert.strictEqual(phoneConnectionUserName("phone00908F5610A5"), "phone00908F5610A5");
  });

  it("rejects Telnyx SIP connections when username repair does not persist", async () => {
    const originalFetch = global.fetch;
    const oldApiKey = process.env.TELNYX_API_KEY;
    const oldOvp = process.env.TELNYX_OUTBOUND_VOICE_PROFILE;
    const calls = [];
    try {
      process.env.TELNYX_API_KEY = "KEY_TEST";
      process.env.TELNYX_OUTBOUND_VOICE_PROFILE = "ovp123";
      global.fetch = async (url, options = {}) => {
        calls.push({ url: String(url), method: options.method || "GET" });
        if (options.method === "DELETE") {
          return { ok: true, json: async () => ({}) };
        }
        return {
          ok: true,
          json: async () => ({ data: { id: "conn123", connection_name: "phone_0004F2ABCDEF", user_name: "0004F2ABCDEF" } }),
        };
      };

      await assert.rejects(
        () => createPhoneSipConnection({ mac: "00:04:f2:ab:cd:ef", vendor: "audiocodes", model: "420HD", label: "Desk" }),
        /username update did not persist/,
      );
      assert.ok(calls.some((call) => call.method === "DELETE"), "mismatched Telnyx connection should be cleaned up");
    } finally {
      global.fetch = originalFetch;
      if (oldApiKey === undefined) delete process.env.TELNYX_API_KEY; else process.env.TELNYX_API_KEY = oldApiKey;
      if (oldOvp === undefined) delete process.env.TELNYX_OUTBOUND_VOICE_PROFILE; else process.env.TELNYX_OUTBOUND_VOICE_PROFILE = oldOvp;
    }
  });

  it("persists local bridge registry and command audit tables", async () => {
    const schema = await file("lib/postgres-schema.mjs");
    assert.match(schema, /CREATE TABLE IF NOT EXISTS hp_local_bridges/);
    assert.match(schema, /bridge_id TEXT NOT NULL UNIQUE/);
    assert.match(schema, /token_hash TEXT/);
    assert.match(schema, /CREATE TABLE IF NOT EXISTS hp_local_bridge_commands/);
    assert.match(schema, /idx_hp_local_bridge_commands_bridge/);
    assert.match(schema, /ALTER TABLE hp_phones ADD COLUMN IF NOT EXISTS local_bridge_id TEXT/);
    assert.match(schema, /ALTER TABLE hp_phones ADD COLUMN IF NOT EXISTS sip_registration_status TEXT/);
    assert.match(schema, /ALTER TABLE hp_phones ADD COLUMN IF NOT EXISTS sip_registration_status_at TIMESTAMPTZ/);
  });

  it("exposes admin bridge enrollment and live-status APIs", async () => {
    const route = await file("app/api/admin/phones-provisioning/bridges/route.js");
    assert.match(route, /requireAdmin/);
    assert.match(route, /hp_local_bridges/);
    assert.match(route, /crypto\.randomBytes\(32\)/);
    assert.match(route, /HARDPHONE_BRIDGE_RELAY_URL/);
    assert.match(route, /\/api\/hardphone-bridge\/bridges/);
    assert.doesNotMatch(route, /DELETE FROM hp_local_bridges/);
  });

  it("authenticates bridge connections with persisted enrollment token hashes", async () => {
    const relay = await file("lib/hardphones/bridge-relay.mjs");
    const streaming = await file("lib/streaming-ws-handler.mjs");
    assert.match(relay, /function tokenHash\(token\)/);
    assert.match(relay, /bridgeTokenAuthorized/);
    assert.match(relay, /SELECT 1 FROM hp_local_bridges WHERE bridge_id = \$1 AND token_hash = \$2 LIMIT 1/);
    assert.match(relay, /export async function registerBridgeConnection/);
    assert.match(streaming, /await handleHardphoneBridgeConnection\(clientWs, request\)/);
    assert.doesNotMatch(relay, /const expectedToken = process\.env\.HARDPHONE_BRIDGE_TOKEN \|\| process\.env\.BRIDGE_TOKEN \|\| "";\n\s*if \(!tokenMatches\(token, expectedToken\)\)/);
  });

  it("routes CTI through outbound local bridge mode", async () => {
    const cti = await file("lib/hardphones/cti.mjs");
    const driver = await file("lib/hardphones/drivers/local-bridge.mjs");
    assert.match(cti, /cti_mode = "local_bridge"/);
    assert.match(cti, /createLocalBridgeDriver/);
    assert.match(cti, /TELNYX_PHONE_ADMIN_PASSWORD/);
    assert.match(cti, /phone = withRuntimeAdminPassword\(phone\)/);
    assert.match(driver, /HARDPHONE_BRIDGE_RELAY_URL/);
    assert.match(driver, /\/api\/hardphone-bridge\/command/);
    assert.match(driver, /const bridge_id = phone\.local_bridge_id \|\| phone\?\.settings\?\.local_bridge_id/);
    assert.match(driver, /admin_password: phone\.admin_password/);
  });

  it("allows admins to assign a bridge to a phone in the provisioning UI", async () => {
    const page = await file("app/(portal)/admin/phones-provisioning/page.jsx");
    assert.match(page, /fetch\(`\$\{API\}\/bridges`\)/);
    assert.match(page, /setBridges/);
    assert.match(page, /<SelectItem value="local_bridge">Local bridge<\/SelectItem>/);
    assert.match(page, /Local bridge ID/);
    assert.match(page, /local_bridge_id: phoneDraft\.local_bridge_id/);
  });

  it("separates Phone Name inventory display from Line Label provisioning copy", async () => {
    const page = await file("app/(portal)/admin/phones-provisioning/page.jsx");
    const schema = await file("lib/postgres-schema.mjs");
    const listRoute = await file("app/api/admin/phones-provisioning/phones/route.js");
    const itemRoute = await file("app/api/admin/phones-provisioning/phones/[id]/route.js");
    assert.match(schema, /ALTER TABLE hp_phones ADD COLUMN IF NOT EXISTS phone_name TEXT/);
    assert.match(listRoute, /phone_name, mac, vendor, model, label/);
    assert.match(itemRoute, /phone_name, mac, vendor, model, label/);
    assert.match(page, /<Label>Phone Name<\/Label>/);
    assert.match(page, /phone_name: phoneDraft\.phone_name\.trim\(\)/);
    assert.match(page, /phone_name: selectedPhone\.phone_name \|\| ""/);
    assert.match(page, /<Label>Line Label<\/Label>/);
    assert.doesNotMatch(page, /<Label>Label<\/Label>/);
    assert.match(page, /\{p\.phone_name \|\| p\.label \|\| formatMacDisplay\(p\.mac\)\}/);
    assert.match(page, /placeholder="Desk phone \/ Reception"/);
    assert.match(page, /placeholder="Line 1 \/ Agent name"/);
  });

  it("shows the assigned Telnyx phone number as its own phone inventory column", async () => {
    const page = await file("app/(portal)/admin/phones-provisioning/page.jsx");
    assert.match(page, /<span>Phone number<\/span>/);
    assert.match(page, /p\.assigned_phone_number \|\| "—"/);
    assert.match(page, /font-mono text-xs/);
  });

  it("offers an NTP timezone offset dropdown defaulting to the logged-in user's timezone", async () => {
    const page = await file("app/(portal)/admin/phones-provisioning/page.jsx");
    const listRoute = await file("app/api/admin/phones-provisioning/phones/route.js");
    assert.match(listRoute, /userTimezone: user\.timezone \|\| "UTC"/);
    assert.match(page, /PHONE_TIMEZONES/);
    assert.match(page, /Europe\/Warsaw/);
    assert.match(page, /GMT\+01:00\/\+02:00/);
    assert.match(page, /emptyPhoneDraft\(hardphoneConfig\.userTimezone\)/);
    assert.match(page, /<Label>NTP timezone offset<\/Label>/);
    assert.match(page, /settings\.ntp_timezone/);
    assert.match(page, /updateSettings\(\{ ntp_timezone: v \}\)/);
  });

  it("formats the context settings MAC input like the phone inventory list", async () => {
    const page = await file("app/(portal)/admin/phones-provisioning/page.jsx");
    assert.match(page, /function formatMacInput\(mac\)/);
    assert.match(page, /replace\(\/\[\^0-9a-f\]\/g, ""\)\.slice\(0, 12\)/);
    assert.match(page, /value=\{formatMacInput\(draft\.mac\)\}/);
    assert.match(page, /onChange=\{\(e\) => update\(\{ mac: formatMacInput\(e\.target\.value\) \}\)\}/);
    assert.match(page, /placeholder="00:90:8f:56:10:a5"/);
  });

  it("auto-discovers phone IP and keeps the phone IP field read-only", async () => {
    const page = await file("app/(portal)/admin/phones-provisioning/page.jsx");
    const eventsRoute = await file("app/api/provisioning/events/[vendor]/route.js");
    const phonesRoute = await file("app/api/admin/phones-provisioning/phones/route.js");
    const generator = await file("lib/hardphones/config-generators.mjs");
    const bridgeRelay = await file("lib/hardphones/bridge-relay.mjs");
    assert.match(eventsRoute, /extractPhoneIp\(\{ queryParams, body \}\)/);
    assert.match(eventsRoute, /source_ip: sourceIp/);
    assert.match(eventsRoute, /last_ip = COALESCE\(\$2, last_ip\)/);
    assert.match(bridgeRelay, /ip_address = COALESCE\(NULLIF\(ip_address, ''\), \$2\)/);
    assert.match(bridgeRelay, /bridge_command_result/);
    assert.match(bridgeRelay, /phone_id: command\.phone_id/);
    assert.match(generator, /&ip=\$ip/);
    assert.match(page, /Detected phone IP address/);
    assert.match(page, /readOnly/);
    assert.match(page, /phone\.last_ip \|\| phone\.ip_address/);
    assert.doesNotMatch(page, /onChange=\{\(e\) => update\(\{ ip_address: e\.target\.value \}\)\}/);
    assert.doesNotMatch(phonesRoute, /String\(body\?\.ip_address/);
  });

  it("surfaces SIP registration status and automatically refreshes bridge state", async () => {
    const page = await file("app/(portal)/admin/phones-provisioning/page.jsx");
    const phonesRoute = await file("app/api/admin/phones-provisioning/phones/route.js");
    const bridgeRoute = await file("app/api/admin/phones-provisioning/bridges/route.js");
    const bridgeServer = await file("tools/hardphone-bridge/server.mjs");
    const bridgeRelay = await file("lib/hardphones/bridge-relay.mjs");
    const deployScript = await file("tools/hardphone-bridge/scripts/deploy-local.sh");
    const envExample = await file("tools/hardphone-bridge/.env.example");
    assert.match(phonesRoute, /sip_registration_status/);
    assert.match(phonesRoute, /p\.sip_registration_status \|\| registrationByPhone/);
    assert.match(phonesRoute, /registration_status_event/);
    assert.match(bridgeRelay, /sip_registration_status = COALESCE\(\$4, sip_registration_status\)/);
    assert.match(bridgeRelay, /registrationStatusFromMessage/);
    assert.match(bridgeRelay, /message\.result\?\.line,/);
    assert.match(bridgeRelay, /message\.RegistrationStatus/);
    assert.match(bridgeRelay, /phone_registry_request/);
    assert.match(bridgeRelay, /phone_registry/);
    assert.match(bridgeRelay, /FROM hp_phones[\s\S]*WHERE local_bridge_id = \$1/);
    assert.match(page, /Telnyx registration/);
    assert.match(page, /registrationBadgeClass/);
    assert.match(page, /function registrationBadgeLabel/);
    assert.match(page, /Not registered/);
    assert.match(page, /registrationBadgeLabel\(p\.sip_registration_status\)/);
    assert.doesNotMatch(page, /Registration \{p\.sip_registration_status/);
    assert.match(page, /registrationBadgeLabel\(phone\.sip_registration_status\)/);
    assert.match(page, /setInterval\(\(\) => refresh\(false, \{ silent: true, includeAvailablePhoneNumbers: false \}\), 10000\)/);
    assert.match(bridgeRoute, /status = liveBridge\?\.online \? "online" : "offline"/);
    assert.match(bridgeServer, /registration:\s*parsed\.registration \|\| "not_registered"/);
    assert.match(bridgeServer, /phone_registry_request/);
    assert.match(bridgeServer, /message\.type === "registered"/);
    assert.match(bridgeServer, /phone_registry_updated/);
    assert.match(bridgeServer, /AUTO_POLL_INTERVAL_MS/);
    assert.match(bridgeServer, /WebSocket\.OPEN \?\? 1/);
    assert.doesNotMatch(bridgeServer, /readyState === WebSocket\.OPEN\)/);
    assert.doesNotMatch(bridgeServer, /PHONE_MAC_IP_MAP/);
    assert.doesNotMatch(deployScript, /PHONE_MAC_IP_MAP/);
    assert.doesNotMatch(envExample, /PHONE_MAC_IP_MAP/);
  });

  it("provisions new hardphones with dedicated Telnyx credential connections", async () => {
    const schema = await file("lib/postgres-schema.mjs");
    const route = await file("app/api/admin/phones-provisioning/phones/route.js");
    const credentials = await file("lib/hardphones/credentials.mjs");
    assert.match(schema, /ALTER TABLE hp_phones ADD COLUMN IF NOT EXISTS telnyx_connection_id TEXT/);
    assert.match(schema, /ALTER TABLE hp_phones ADD COLUMN IF NOT EXISTS assigned_phone_number TEXT/);
    assert.match(route, /createPhoneSipConnection/);
    assert.match(route, /TELNYX_PHONE_ADMIN_PASSWORD/);
    assert.match(route, /TELNYX_OUTBOUND_VOICE_PROFILE/);
    assert.doesNotMatch(route, /createPhoneCredential\(\{ label, mac \}\)/);
    assert.match(credentials, /buildTelnyxV2Url\("\/credential_connections"\)/);
    assert.match(credentials, /sip_uri_calling_preference: "unrestricted"/);
    assert.match(credentials, /outbound_voice_profile_id: outboundVoiceProfileId/);
    assert.match(credentials, /ani_override_type: "always"/);
    assert.match(credentials, /updatePhoneSipConnectionCallerId/);
    assert.match(credentials, /buildTelnyxV2Url\(`\/phone_numbers\/\$\{encodeURIComponent\(phoneNumberId\)\}`\)/);
  });

  it("sends Telnyx-safe hardphone SIP connection tags without colon separators", async () => {
    const originalFetch = global.fetch;
    const oldApiKey = process.env.TELNYX_API_KEY;
    const oldOvp = process.env.TELNYX_OUTBOUND_VOICE_PROFILE;
    const oldWebhook = process.env.TELNYX_HARDPHONE_WEBHOOK_URL;
    const oldWebhookBase = process.env.TELNYX_WEBHOOK_BASE_URL;
    let requestBody = null;
    try {
      process.env.TELNYX_API_KEY = "KEY_TEST";
      process.env.TELNYX_OUTBOUND_VOICE_PROFILE = "ovp123";
      delete process.env.TELNYX_HARDPHONE_WEBHOOK_URL;
      delete process.env.TELNYX_WEBHOOK_BASE_URL;
      global.fetch = async (_url, options) => {
        requestBody = JSON.parse(options.body);
        return {
          ok: true,
          json: async () => ({ data: { id: "conn123", connection_name: requestBody.connection_name, user_name: requestBody.user_name } }),
        };
      };

      await createPhoneSipConnection({ mac: "00:04:f2:ab:cd:ef", vendor: "audiocodes", model: "420HD", label: "Desk" });

      assert.strictEqual(requestBody.user_name, "phone0004F2ABCDEF");
      assert.strictEqual(requestBody.inbound.ani_number_format, "+E.164");
      assert.strictEqual(requestBody.inbound.dnis_number_format, "+e164");
      assert.deepStrictEqual(requestBody.tags, ["hardphone", "vendor_audiocodes", "model_420HD", "mac_0004F2ABCDEF"]);
      assert.ok(requestBody.tags.every((tag) => /^[A-Za-z0-9_-]+$/.test(tag)), "Telnyx tags must contain only letters, numbers, dashes and underscores");
    } finally {
      global.fetch = originalFetch;
      if (oldApiKey === undefined) delete process.env.TELNYX_API_KEY; else process.env.TELNYX_API_KEY = oldApiKey;
      if (oldOvp === undefined) delete process.env.TELNYX_OUTBOUND_VOICE_PROFILE; else process.env.TELNYX_OUTBOUND_VOICE_PROFILE = oldOvp;
      if (oldWebhook === undefined) delete process.env.TELNYX_HARDPHONE_WEBHOOK_URL; else process.env.TELNYX_HARDPHONE_WEBHOOK_URL = oldWebhook;
      if (oldWebhookBase === undefined) delete process.env.TELNYX_WEBHOOK_BASE_URL; else process.env.TELNYX_WEBHOOK_BASE_URL = oldWebhookBase;
    }
  });

  it("sets hardphone SIP webhook URL and parks direct outbound calls for Call Control", async () => {
    const originalFetch = global.fetch;
    const oldApiKey = process.env.TELNYX_API_KEY;
    const oldOvp = process.env.TELNYX_OUTBOUND_VOICE_PROFILE;
    const oldWebhook = process.env.TELNYX_HARDPHONE_WEBHOOK_URL;
    const oldWebhookBase = process.env.TELNYX_WEBHOOK_BASE_URL;
    const oldNextAuth = process.env.NEXTAUTH_URL;
    const oldAppBase = process.env.APP_BASE_URL;
    let requestBody = null;
    try {
      process.env.TELNYX_API_KEY = "KEY_TEST";
      process.env.TELNYX_OUTBOUND_VOICE_PROFILE = "ovp123";
      delete process.env.TELNYX_HARDPHONE_WEBHOOK_URL;
      delete process.env.TELNYX_WEBHOOK_BASE_URL;
      process.env.NEXTAUTH_URL = "https://api.tokaj.synology.me";
      delete process.env.APP_BASE_URL;
      global.fetch = async (_url, options) => {
        requestBody = JSON.parse(options.body);
        return {
          ok: true,
          json: async () => ({ data: { id: "conn123", connection_name: requestBody.connection_name, user_name: requestBody.user_name } }),
        };
      };

      await createPhoneSipConnection({ mac: "00:04:f2:ab:cd:ef", vendor: "audiocodes", model: "420HD", label: "Desk" });

      assert.strictEqual(requestBody.webhook_event_url, "https://api.tokaj.synology.me/api/voice/webhook");
      assert.strictEqual(requestBody.webhook_api_version, "2");
      assert.strictEqual(requestBody.outbound.call_parking_enabled, true);
    } finally {
      global.fetch = originalFetch;
      if (oldApiKey === undefined) delete process.env.TELNYX_API_KEY; else process.env.TELNYX_API_KEY = oldApiKey;
      if (oldOvp === undefined) delete process.env.TELNYX_OUTBOUND_VOICE_PROFILE; else process.env.TELNYX_OUTBOUND_VOICE_PROFILE = oldOvp;
      if (oldWebhook === undefined) delete process.env.TELNYX_HARDPHONE_WEBHOOK_URL; else process.env.TELNYX_HARDPHONE_WEBHOOK_URL = oldWebhook;
      if (oldWebhookBase === undefined) delete process.env.TELNYX_WEBHOOK_BASE_URL; else process.env.TELNYX_WEBHOOK_BASE_URL = oldWebhookBase;
      if (oldNextAuth === undefined) delete process.env.NEXTAUTH_URL; else process.env.NEXTAUTH_URL = oldNextAuth;
      if (oldAppBase === undefined) delete process.env.APP_BASE_URL; else process.env.APP_BASE_URL = oldAppBase;
    }
  });

  it("handles parked outbound hardphone calls separately from WebRTC softphone calls", async () => {
    const route = await file("app/api/voice/webhook/route.js");
    assert.match(route, /async function findHardphoneByConnectionId/);
    assert.match(route, /FROM hp_phones hp[\s\S]*LEFT JOIN users u/);
    assert.match(route, /metadata:\s*\{[\s\S]*is_hardphone_outbound_call:\s*true/);
    assert.match(route, /hardphoneCallControlId:\s*callControlId/);
    assert.match(route, /linkTo:\s*callControlId/);
    assert.match(route, /pstnCallControlId:\s*pstnCallControlId/);
    assert.match(route, /metadata->>'is_hardphone_outbound_call' = 'true'/);
    assert.match(route, /hardphone_call_control_id: hardphoneCallControlId \|\| null/);
    assert.match(route, /source:\s*"hardphone"/);
    assert.match(route, /direction === "outgoing" &&\s*rtcCallId/);
  });

  it("hides advanced provisioning URL/syslog fields and uses env-managed admin password", async () => {
    const page = await file("app/(portal)/admin/phones-provisioning/page.jsx");
    assert.match(page, /phoneAdminPasswordConfigured/);
    assert.match(page, /TELNYX_PHONE_ADMIN_PASSWORD/);
    assert.match(page, /Select a Telnyx number/);
    assert.doesNotMatch(page, /<Label>Admin password<\/Label>/);
    assert.doesNotMatch(page, /Firmware source URL/);
    assert.doesNotMatch(page, /Custom config URL/);
    assert.doesNotMatch(page, /Syslog server/);
  });

  it("renders bridges as a first-class rail section with list and context settings", async () => {
    const page = await file("app/(portal)/admin/phones-provisioning/page.jsx");
    assert.match(page, /id: "bridges", label: "Bridges"/);
    assert.match(page, /active === "bridges" \? \(/);
    assert.match(page, /<BridgesListView[\s\S]*bridges=\{bridges\}/);
    assert.match(page, /<BridgeEditor[\s\S]*bridges=\{bridges\}/);
    assert.match(page, /Bridge status/);
    assert.match(page, /Connected phones/);
  });

  it("keeps one-time bridge enrollment inside the card with copy actions and a real CC_WS_URL", async () => {
    const page = await file("app/(portal)/admin/phones-provisioning/page.jsx");
    const route = await file("app/api/admin/phones-provisioning/bridges/route.js");
    assert.match(page, /IconCopy/);
    assert.match(page, /navigator\.clipboard\.writeText/);
    assert.match(page, /whitespace-pre-wrap break-all/);
    assert.match(page, /enrollment\.env/);
    assert.doesNotMatch(page, /wss:\/\/<cc-host>/);
    assert.match(route, /function ccWsUrl\(\)/);
    assert.match(route, /WS_BASE_URL/);
    assert.match(route, /NEXT_PUBLIC_BASE_URL/);
    assert.match(route, /if \(!explicitWsBase\) url\.port = wsPort/);
    assert.match(route, /enrollment: \{ bridge_id: bridgeId, token, cc_ws_url: ccWsUrl\(\), env: bridgeEnvBlock/);
  });
});
