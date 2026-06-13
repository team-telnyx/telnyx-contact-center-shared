import assert from "node:assert";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";

async function bridgeFile(path) {
  return readFile(new URL(`../tools/hardphone-bridge/${path}`, import.meta.url), "utf8");
}

describe("hardphone local bridge", () => {
  it("ships a dockerized token-protected LAN bridge", async () => {
    const server = await bridgeFile("server.mjs");
    const compose = await bridgeFile("docker-compose.yml");
    const deploy = await bridgeFile("scripts/deploy-local.sh");

    assert.match(server, /BRIDGE_TOKEN/);
    assert.match(server, /timingSafeEqual/);
    assert.match(server, /vendor === "polycom"/);
    assert.match(server, /\/api\/v1\/callctrl\/dial/);
    assert.match(server, /Dest: String\(payload\.number \|\| payload\.target \|\| ""\), Line: "1"/);
    assert.doesNotMatch(server, /Type: "SIP" \}/);
    assert.match(server, /rejectUnauthorized: false/);
    assert.match(server, /\/api\/v1\/callctrl\/mute/);
    assert.match(server, /if \(action === "mute" \|\| action === "unmute"\)/);
    assert.match(server, /\/api\/v1\/mgmt\/updateConfiguration", \{ method: "POST", password, body: \{\} \}/);
    assert.match(server, /\/api\/v1\/mgmt\/safeReboot", \{ method: "POST", password, body: \{\} \}/);
    assert.match(server, /\/api\/v1\/mgmt\/updateConfiguration/);
    assert.match(server, /\/api\/v1\/mgmt\/safeReboot/);
    assert.match(server, /\/servlet\?key=/);
    assert.match(server, /\/voip_status\.cgi/);
    assert.match(server, /discovered_ip: host/);
    assert.match(server, /parseAudioCodesVoipStatus/);
    assert.match(server, /DEFAULT_AUDIOCODES_ADMIN_USER/);

    assert.match(compose, /ports:/);
    assert.match(compose, /host\.docker\.internal:host-gateway/);
    assert.match(compose, /env_file:/);
    assert.match(deploy, /docker compose up -d --build/);
  });
});
