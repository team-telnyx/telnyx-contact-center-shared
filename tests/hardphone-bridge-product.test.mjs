import assert from "node:assert";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";

async function file(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("hardphone bridge product integration", () => {
  it("persists local bridge registry and command audit tables", async () => {
    const schema = await file("lib/postgres-schema.mjs");
    assert.match(schema, /CREATE TABLE IF NOT EXISTS hp_local_bridges/);
    assert.match(schema, /bridge_id TEXT NOT NULL UNIQUE/);
    assert.match(schema, /token_hash TEXT/);
    assert.match(schema, /CREATE TABLE IF NOT EXISTS hp_local_bridge_commands/);
    assert.match(schema, /idx_hp_local_bridge_commands_bridge/);
    assert.match(schema, /ALTER TABLE hp_phones ADD COLUMN IF NOT EXISTS local_bridge_id TEXT/);
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
    assert.match(driver, /HARDPHONE_BRIDGE_RELAY_URL/);
    assert.match(driver, /\/api\/hardphone-bridge\/command/);
    assert.match(driver, /const bridge_id = phone\.local_bridge_id \|\| phone\?\.settings\?\.local_bridge_id/);
    assert.match(driver, /admin_password: phone\.admin_password/);
  });

  it("allows admins to assign a bridge to a phone in the provisioning UI", async () => {
    const page = await file("app/(portal)/admin/phones-provisioning/page.jsx");
    assert.match(page, /fetch\(`\$\{API\}\/bridges`\)/);
    assert.match(page, /setBridges/);
    assert.match(page, /<SelectItem value="local_bridge">Local bridge \(outbound WS\)<\/SelectItem>/);
    assert.match(page, /Local bridge ID/);
    assert.match(page, /local_bridge_id: phoneDraft\.local_bridge_id/);
  });

  it("auto-discovers phone IP and keeps the phone IP field read-only", async () => {
    const page = await file("app/(portal)/admin/phones-provisioning/page.jsx");
    const eventsRoute = await file("app/api/provisioning/events/[vendor]/route.js");
    const phonesRoute = await file("app/api/admin/phones-provisioning/phones/route.js");
    const generator = await file("lib/hardphones/config-generators.mjs");
    assert.match(eventsRoute, /extractPhoneIp\(\{ queryParams, body \}\)/);
    assert.match(eventsRoute, /source_ip: sourceIp/);
    assert.match(eventsRoute, /last_ip = COALESCE\(\$2, last_ip\)/);
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
    assert.match(phonesRoute, /sip_registration_status/);
    assert.match(phonesRoute, /registration_status_event/);
    assert.match(page, /Telnyx registration/);
    assert.match(page, /registrationBadgeClass/);
    assert.match(page, /p\.sip_registration_status \|\| "unknown"/);
    assert.doesNotMatch(page, /Registration \{p\.sip_registration_status/);
    assert.match(page, /phone\.sip_registration_status/);
    assert.match(page, /setInterval\(\(\) => refresh\(false, \{ silent: true \}\), 10000\)/);
    assert.match(bridgeRoute, /status = liveBridge\?\.online \? "online" : "offline"/);
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
