// /api/contact-center/agent/campaigns follows its manifest row, "agents:campaigns.assign
// (self allowed)" (the internal documentation): an agent reads and
// activates their own campaigns — the header's campaign selector and the mobile shift
// screen both depend on it — while another agent's campaigns need the assign grant.
import test from "node:test";
import assert from "node:assert/strict";
import { loadRoute } from "./helpers/route-harness.mjs";
import { authzGuardStub, USERS } from "./helpers/authz-harness.mjs";

const quiet = { error() {}, warn() {}, info() {}, debug() {} };

async function campaignsRoute(user) {
  const calls = { listed: [], activated: [], broadcast: [], lookups: [] };
  const pool = {
    async query(sql, params = []) {
      const text = sql.replace(/\s+/g, " ").trim();
      if (text.startsWith("SELECT id, username, email FROM users WHERE id = $1")) {
        calls.lookups.push(params[0]);
        return { rows: [{ id: params[0], username: `${params[0]}@test.local` }] };
      }
      return { rows: [] };
    },
  };
  const route = await loadRoute("app/api/contact-center/agent/campaigns/route.js", {
    "@/lib/authz/guard": authzGuardStub({ user }),
    "@/lib/postgres.mjs": { getPostgresPool: () => pool },
    "@/lib/runtime-logging.mjs": { adminRuntimeLogger: quiet, contactCenterRuntimeLogger: quiet, platformApiLogger: quiet, platformDbLogger: quiet, voiceRuntimeLogger: quiet, runtimePayload: (v) => v },
    "@/lib/outbound-dialer/agent-campaigns": {
      listAgentCampaigns: async (_pool, username) => { calls.listed.push(username); return [{ id: "camp-1", activated: true }]; },
      setAgentCampaignActivation: async (_pool, username, ids) => { calls.activated.push({ username, ids }); },
      broadcastCampaignActivationChanged: async (_pool, payload) => { calls.broadcast.push(payload); },
    },
  });
  return { route, calls };
}

const get = (query = "") => new Request(`https://cc.test/api/contact-center/agent/campaigns${query}`);
const post = (body) => new Request("https://cc.test/api/contact-center/agent/campaigns", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("an agent reads and activates their own campaigns", async () => {
  const { route, calls } = await campaignsRoute(USERS.agent);
  const listed = await route.GET(get());
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.deepEqual(listed.body.campaigns, [{ id: "camp-1", activated: true }]);
  assert.deepEqual(calls.listed, ["agent@test.local"]);

  const set = await route.POST(post({ campaignIds: ["camp-1", "camp-2"] }));
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.deepEqual(calls.activated, [{ username: "agent@test.local", ids: ["camp-1", "camp-2"] }]);
  assert.equal(calls.broadcast.at(-1).userId, "agent-1", "the web and the phone hear the change");

  const namedSelf = await route.POST(post({ userId: "agent-1", campaignIds: [] }));
  assert.equal(namedSelf.status, 200, "naming oneself is still oneself");
  assert.deepEqual(calls.activated.at(-1), { username: "agent@test.local", ids: [] });
  assert.deepEqual(calls.lookups, [], "no user lookup for the caller's own campaigns");
});

test("an agent can neither read nor set another agent's campaigns", async () => {
  const { route, calls } = await campaignsRoute(USERS.agent);
  const read = await route.GET(get("?userId=agent-2"));
  assert.equal(read.status, 403);
  assert.match(read.body.error, /other users' campaigns/);

  const write = await route.POST(post({ userId: "agent-2", campaignIds: ["camp-1"] }));
  assert.equal(write.status, 403);
  assert.match(write.body.error, /other users' campaigns/);

  assert.deepEqual(calls.lookups, [], "the other agent is not even looked up");
  assert.deepEqual(calls.listed, []);
  assert.deepEqual(calls.activated, [], "nothing is written for someone else");
  assert.deepEqual(calls.broadcast, []);
});

test("the assign grant still manages another agent's campaigns", async () => {
  for (const user of [USERS.supervisor, USERS.campaignManager]) {
    const { route, calls } = await campaignsRoute(user);
    const read = await route.GET(get("?userId=agent-2"));
    assert.equal(read.status, 200, `${user.roles[0]}: ${JSON.stringify(read.body)}`);
    assert.deepEqual(calls.listed, ["agent-2@test.local"]);

    const write = await route.POST(post({ userId: "agent-2", campaignIds: ["camp-1"] }));
    assert.equal(write.status, 200, `${user.roles[0]}: ${JSON.stringify(write.body)}`);
    assert.deepEqual(calls.activated, [{ username: "agent-2@test.local", ids: ["camp-1"] }]);
    assert.equal(calls.broadcast.at(-1).userId, "agent-2");
  }
});

test("a role with neither grant is refused, and nobody anonymous gets in", async () => {
  const { route: designer, calls } = await campaignsRoute(USERS.designer);
  assert.equal((await designer.GET(get())).status, 403);
  assert.equal((await designer.POST(post({ campaignIds: ["camp-1"] }))).status, 403);
  assert.deepEqual(calls.activated, []);

  const { route: anonymous } = await campaignsRoute(USERS.anonymous);
  assert.equal((await anonymous.GET(get())).status, 401);
  assert.equal((await anonymous.POST(post({ campaignIds: [] }))).status, 401);
});
