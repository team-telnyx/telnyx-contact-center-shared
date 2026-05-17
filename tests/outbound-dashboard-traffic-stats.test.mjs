import assert from "node:assert/strict";
import test from "node:test";
import { buildDashboardCampaignExpandedStats } from "../lib/outbound-dialer/dashboard-view-model.mjs";

test("buildDashboardCampaignExpandedStats returns contact statistics with connected contacts over total contacts", () => {
  const stats = buildDashboardCampaignExpandedStats({
    progress: { completed: 312, total: 500, remaining: 120 },
    summary: { attempts_total: 842, connected_records: 90, active_now: 6 },
    maxLines: 10,
  });

  assert.deepEqual(stats.contactStats.map((stat) => [stat.label, stat.value]), [
    ["Contacts", "312 / 500"],
    ["Attempts", "842"],
    ["Callable", "24%"],
    ["Connected", "18%"],
    ["Lines", "6 / 10"],
  ]);
});

test("buildDashboardCampaignExpandedStats returns calls processing cards", () => {
  const stats = buildDashboardCampaignExpandedStats({
    live: { active: 6, ringing: 2 },
    summary: {
      active_now: 6,
      dialing_now: 2,
      connected_total: 90,
      calls_failed_total: 71,
      machine_total: 12,
    },
  });

  assert.deepEqual(stats.callProcessingStats.map((stat) => [stat.label, stat.value]), [
    ["Active", "6"],
    ["Ringing", "2"],
    ["Answered", "90"],
    ["Failed", "71"],
    ["Machine", "12"],
  ]);
});

test("buildDashboardCampaignExpandedStats never displays used lines above configured capacity", () => {
  const stats = buildDashboardCampaignExpandedStats({
    progress: { completed: 0, total: 10, remaining: 10 },
    summary: { active_now: 6 },
    maxLines: 2,
  });

  const lines = stats.contactStats.find((stat) => stat.label === "Lines");
  assert.equal(lines.value, "2 / 2");
});

test("buildDashboardCampaignExpandedStats falls back safely when totals are missing", () => {
  const stats = buildDashboardCampaignExpandedStats({
    progress: { completed: 0, total: 0, remaining: 0 },
    live: { answered: 0 },
    summary: {},
    maxLines: 0,
  });

  assert.deepEqual(stats.contactStats.map((stat) => [stat.label, stat.value]), [
    ["Contacts", "0 / 0"],
    ["Attempts", "0"],
    ["Callable", "0%"],
    ["Connected", "0%"],
    ["Lines", "0 / —"],
  ]);
  assert.deepEqual(stats.callProcessingStats.map((stat) => [stat.label, stat.value]), [
    ["Active", "0"],
    ["Ringing", "0"],
    ["Answered", "0"],
    ["Failed", "0"],
    ["Machine", "0"],
  ]);
});
