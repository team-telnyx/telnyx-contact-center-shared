import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  AGENT_CAMPAIGN_ACTIVATION_STATUSES,
  agentCampaignStatusBadgeClass,
  campaignDistributionWeight,
  normalizeCampaignPriority,
  priorityDistributionCursor,
} from "../lib/outbound-dialer/agent-campaigns-view-model.js";
import { campaignSaveRequirements } from "../lib/outbound-dialer/campaign-validation.js";

const baseCampaign = {
  name: "Renewals",
  contact_list_id: "list-1",
  metadata: { contact_list_numbers: ["phone"], from_numbers: ["+15551234567"] },
};

test("preview and progressive campaigns do not require a queue target before save", () => {
  for (const mode of ["preview", "progressive"]) {
    const requirements = campaignSaveRequirements({
      ...baseCampaign,
      mode,
      handler_type: "queue",
      handler_ref: "",
    });

    assert.equal(requirements.canSave, true);
    assert.deepEqual(requirements.missing, []);
  }
});

test("power and predictive campaigns still require a queue target before save", () => {
  for (const mode of ["power", "predictive"]) {
    const requirements = campaignSaveRequirements({
      ...baseCampaign,
      mode,
      handler_type: "queue",
      handler_ref: "",
    });

    assert.equal(requirements.canSave, false);
    assert.ok(requirements.missing.includes("handler_ref"));
  }
});

test("agent campaign activation list supports running paused and stopped with status badge colors", () => {
  assert.deepEqual(AGENT_CAMPAIGN_ACTIVATION_STATUSES, ["running", "paused", "stopped"]);
  assert.match(agentCampaignStatusBadgeClass("running"), /emerald/);
  assert.match(agentCampaignStatusBadgeClass("paused"), /amber/);
  assert.match(agentCampaignStatusBadgeClass("stopped"), /rose/);
});

test("campaign priority normalizes to Genesys-style 1-5 weights", () => {
  assert.equal(normalizeCampaignPriority({ metadata: { agent_priority: 9 } }), 5);
  assert.equal(normalizeCampaignPriority({ metadata: { agent_priority: 0 } }), 1);
  assert.equal(normalizeCampaignPriority({ metadata: { agent_priority: 3 } }), 3);
  assert.equal(normalizeCampaignPriority({ metadata: {} }), 3);
  assert.equal(campaignDistributionWeight({ metadata: { agent_priority: 5 } }), 5);
});

test("priority distribution cursor favors campaigns with fewer served records per star", () => {
  const campaigns = [
    { id: "A", metadata: { agent_priority: 5 }, assignment_metadata: { served_count: 10 } },
    { id: "B", metadata: { agent_priority: 3 }, assignment_metadata: { served_count: 3 } },
    { id: "C", metadata: { agent_priority: 1 }, assignment_metadata: { served_count: 2 } },
  ];
  assert.equal(priorityDistributionCursor(campaigns)?.id, "B");
});

test("campaign settings show five-star Priority near top and persist metadata agent_priority", async () => {
  const source = await readFile(new URL("../app/(portal)/supervisor/outbound-dialer/page.jsx", import.meta.url), "utf8");

  assert.match(source, /CampaignPriorityStarRating/);
  assert.match(source, /label="Priority"/);
  assert.match(source, /agent_priority/);
  assert.match(source, /IconStarFilled/);
  assert.match(source, /IconStar/);
});

test("agent campaign selector is a multi-activation popover with status badges and no status-disabled items", async () => {
  const source = await readFile(new URL("../components/contact-center/CampaignActivationSelector.jsx", import.meta.url), "utf8");

  assert.match(source, /Popover/);
  assert.match(source, /Checkbox/);
  assert.match(source, /campaignIds/);
  assert.match(source, /agentCampaignStatusBadgeClass/);
  assert.doesNotMatch(source, /disabled=\{campaign\.status !== "running"\}/);
});

test("supervisor monitor exposes Active Campaigns next to Active Queues with campaign management modal", async () => {
  const source = await readFile(new URL("../app/(portal)/supervisor/monitor/page.jsx", import.meta.url), "utf8");

  assert.match(source, /Active Campaigns/);
  assert.match(source, /campaignDialogOpen/);
  assert.match(source, /loadAgentCampaigns/);
  assert.match(source, /toggleCampaignActivation/);
  assert.match(source, /\/api\/contact-center\/agent\/campaigns\?userId=/);
});

test("campaign status changes are broadcast to agents so activation lists refresh", async () => {
  const executionRoute = await readFile(new URL("../app/api/contact-center/outbound-dialer/campaigns/[campaignId]/execution/route.js", import.meta.url), "utf8");
  const selector = await readFile(new URL("../components/contact-center/CampaignActivationSelector.jsx", import.meta.url), "utf8");

  assert.match(executionRoute, /broadcastCampaignActivationChanged/);
  assert.match(selector, /campaign_changed/);
  assert.match(selector, /campaign_status_changed/);
});
