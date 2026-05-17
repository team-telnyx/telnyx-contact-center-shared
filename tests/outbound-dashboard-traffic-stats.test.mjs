import assert from "node:assert/strict";
import test from "node:test";
import { buildDashboardCampaignTrafficStats } from "../lib/outbound-dialer/dashboard-view-model.mjs";

test("buildDashboardCampaignTrafficStats returns requested expanded campaign traffic KPIs", () => {
  const stats = buildDashboardCampaignTrafficStats({
    progress: { completed: 312, total: 500, remaining: 120 },
    live: { answered: 152 },
    summary: { attempts_total: 842, active_now: 6 },
    maxLines: 10,
  });

  assert.deepEqual(stats.map((stat) => [stat.label, stat.value]), [
    ["Contacts", "312 / 500"],
    ["Attempts", "842"],
    ["Callable", "24%"],
    ["Connected", "18%"],
    ["Lines", "6 / 10"],
  ]);
});

test("buildDashboardCampaignTrafficStats falls back safely when totals are missing", () => {
  const stats = buildDashboardCampaignTrafficStats({
    progress: { completed: 0, total: 0, remaining: 0 },
    live: { answered: 0 },
    summary: {},
    maxLines: 0,
  });

  assert.deepEqual(stats.map((stat) => [stat.label, stat.value]), [
    ["Contacts", "0 / 0"],
    ["Attempts", "0"],
    ["Callable", "0%"],
    ["Connected", "0%"],
    ["Lines", "0 / —"],
  ]);
});
