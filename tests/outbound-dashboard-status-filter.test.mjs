import assert from "node:assert/strict";
import test from "node:test";
import { DASHBOARD_CAMPAIGN_STATUSES, restoreDashboardCampaignStatuses } from "../lib/outbound-dialer/dashboard-view-model.mjs";

test("new and invalid browser preferences default to Running and Paused", () => {
  for (const value of [null, undefined, "", "invalid JSON", "true", "{}", '["unknown"]']) {
    assert.deepEqual(restoreDashboardCampaignStatuses(value), ["running", "paused"]);
  }
});

test("all campaign status combinations survive storage, including no statuses selected", () => {
  for (let mask = 0; mask < 2 ** DASHBOARD_CAMPAIGN_STATUSES.length; mask += 1) {
    const selection = DASHBOARD_CAMPAIGN_STATUSES.filter((_, index) => mask & (1 << index));
    assert.deepEqual(restoreDashboardCampaignStatuses(JSON.stringify(selection)), selection);
  }
});

test("saved preferences drop unsupported values and duplicate statuses", () => {
  assert.deepEqual(restoreDashboardCampaignStatuses('["stopped","unknown",null,"exhausted","stopped"]'), ["stopped", "exhausted"]);
});
