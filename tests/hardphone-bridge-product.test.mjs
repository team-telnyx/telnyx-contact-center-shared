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
    assert.match(page, /BridgeManager/);
    assert.match(page, /local_bridge_id: phoneDraft\.local_bridge_id/);
  });
});
