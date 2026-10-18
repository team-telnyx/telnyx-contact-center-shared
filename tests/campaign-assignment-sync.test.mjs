import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { patchCampaignActivations } from "../lib/contact-center/campaign-assignment-sync.mjs";

const page = await readFile(new URL("../app/(portal)/supervisor/monitor/page.jsx", import.meta.url), "utf8");
function harness() {
  const pending = [];
  const state = { rows: [], loading: false, notices: [] };
  const context = vm.createContext({
    patchCampaignActivations,
    campaignDialogAgentRef: { current: "alice" }, campaignRequestRef: { current: 0 },
    campaignLoadUpdatesRef: { current: null },
    setAgentCampaigns: (value) => { state.rows = typeof value === "function" ? value(state.rows) : value; },
    setLoadingCampaigns: (value) => { state.loading = value; },
    notify: (value) => state.notices.push(value), console,
    fetch: () => new Promise((resolve) => pending.push(resolve)),
  });
  for (const name of ["updateOpenCampaignRows", "applyCampaignActivationEvent", "loadAgentCampaigns"]) {
    const source = page.match(new RegExp(`  (?:async )?function ${name}\\([\\s\\S]*?\\n  }`));
    assert.ok(source);
    vm.runInContext(source[0], context);
  }
  return { state, context, pending };
}
const response = (campaigns) => ({ ok: true, json: async () => ({ campaigns }) });

test("campaign snapshots normalize IDs, clear all activations and preserve unchanged rows", () => {
  const rows = [{ id: 1, activated: false }, { id: "2", activated: true }];
  assert.equal(patchCampaignActivations(rows, [2]), rows);
  const next = patchCampaignActivations(rows, ["1", 2]);
  assert.equal(next[0].activated, true);
  assert.equal(next[1], rows[1]);
  assert.deepEqual(patchCampaignActivations(next, []).map(row => row.activated), [false, false]);
});

test("phone activation during modal load wins over the older HTTP response", async () => {
  const { state, context, pending } = harness();
  const load = context.loadAgentCampaigns("alice");
  context.applyCampaignActivationEvent({ userId: "alice", campaignIds: [1, "2"] });
  context.applyCampaignActivationEvent({ userId: "bob", campaignIds: [] });
  pending[0](response([{ id: "1", activated: false }, { id: "2", activated: false }]));
  await load;
  assert.deepEqual(state.rows.map(row => row.activated), [true, true]);
  context.applyCampaignActivationEvent({ userId: "alice", campaignIds: [] });
  assert.deepEqual(state.rows.map(row => row.activated), [false, false]);
  assert.equal(state.loading, false);
});

test("switching agents or closing the modal ignores old responses", async () => {
  const { state, context, pending } = harness();
  const alice = context.loadAgentCampaigns("alice");
  context.campaignDialogAgentRef.current = "bob";
  const bob = context.loadAgentCampaigns("bob");
  pending[1](response([{ id: "bob-campaign", activated: true }]));
  await bob;
  pending[0](response([{ id: "alice-campaign", activated: false }]));
  await alice;
  assert.equal(state.rows[0].id, "bob-campaign");
  const refresh = context.loadAgentCampaigns("bob", { silent: true });
  assert.equal(state.loading, false);
  context.campaignDialogAgentRef.current = null;
  context.campaignRequestRef.current++;
  pending[2](response([]));
  await refresh;
  assert.equal(state.rows[0].id, "bob-campaign");
});

test("monitor and shared status stream use the current modal handler", () => {
  assert.match(page, /addEventListener\("campaign_changed",[\s\S]*?campaignActivationHandlerRef\.current\?\.\(update\)/);
  assert.match(page, /subscribeStatusStream\("campaign_changed", \(update\) => campaignActivationHandlerRef\.current\?\.\(update\)\)/);
  assert.match(page, /\[campaignDialogOpen, selectedAgent\?\.userId\]/);
});
