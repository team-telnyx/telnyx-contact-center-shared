import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  campaignAgentAssistConfig,
  campaignAssignmentPayload,
  isPreviewProgressiveMode,
  resolveCampaignContactPhone,
} from "../lib/outbound-dialer/agent-campaigns.js";

test("preview/progressive campaign assignment payload exposes contact record, callable number and 30s progressive auto-dial metadata", () => {
  const assignedAt = "2026-05-18T10:00:00.000Z";
  const payload = campaignAssignmentPayload({
    now: new Date(assignedAt),
    campaign: {
      id: "campaign-1",
      name: "Renewals",
      mode: "progressive",
      attached_form_id: "form-1",
      metadata: { contact_list_numbers: ["mobile", "phone"] },
    },
    ledger: {
      id: "attempt-1",
      created_at: assignedAt,
      metadata: { assigned_at: assignedAt },
    },
    contact: {
      id: "contact-1",
      row_data: { first_name: "Anna", mobile: "48 600 700 800" },
      contact_methods: {},
    },
  });

  assert.equal(payload.campaign_mode, "progressive");
  assert.equal(payload.to_number, "+48600700800");
  assert.deepEqual(payload.contact_record, { first_name: "Anna", mobile: "48 600 700 800" });
  assert.equal(payload.auto_dial_seconds, 30);
  assert.equal(payload.auto_dial_at, "2026-05-18T10:00:30.000Z");
  assert.deepEqual(payload.agent_assist_config, {
    enabled: true,
    assist_type: "forms",
    form_ids: ["form-1"],
    auto_open_forms: true,
    source: "outbound_campaign",
  });
});

test("preview campaign payload does not include progressive timer and workflow attachment wins over forms", () => {
  const payload = campaignAssignmentPayload({
    campaign: {
      id: "campaign-2",
      name: "Callbacks",
      mode: "preview",
      attached_form_id: "form-1",
      metadata: { attached_workflow_id: "workflow-1" },
    },
    ledger: { id: "attempt-2", created_at: "2026-05-18T10:00:00.000Z", metadata: {} },
    contact: {
      id: "contact-2",
      row_data: { phone: "+15551234567" },
      contact_methods: {},
    },
  });

  assert.equal(payload.campaign_mode, "preview");
  assert.equal(payload.auto_dial_at, null);
  assert.equal(payload.auto_dial_seconds, null);
  assert.equal(payload.agent_assist_config.assist_type, "workflows");
  assert.equal(payload.agent_assist_config.workflow_id, "workflow-1");
});

test("agent campaign helpers only expose preview/progressive modes and resolve phone fields from campaign metadata", () => {
  assert.equal(isPreviewProgressiveMode("preview"), true);
  assert.equal(isPreviewProgressiveMode("progressive"), true);
  assert.equal(isPreviewProgressiveMode("predictive"), false);
  assert.equal(resolveCampaignContactPhone(
    { metadata: { contact_list_numbers: ["mobile"] } },
    { row_data: { phone: "+15550001111", mobile: "+15550002222" }, contact_methods: {} },
  ), "+15550002222");
  assert.equal(campaignAgentAssistConfig({ metadata: {} }).assist_type, "kb_articles");
});

test("site header renders campaign selector next to agent status selector", async () => {
  const source = await readFile(new URL("../components/site-header.jsx", import.meta.url), "utf8");
  const agentControlsStart = source.indexOf("<StatusSelector value={status} onChange={handleStatusChange} />");
  const queueControlsStart = source.indexOf("<QueueActivationPanel", agentControlsStart);
  const controlsSource = source.slice(agentControlsStart, queueControlsStart);

  assert.match(source, /CampaignActivationSelector/);
  assert.match(source, /\/api\/contact-center\/agent\/campaigns/);
  assert.match(controlsSource, /<CampaignActivationSelector/);
});

test("agent desktop polls assigned campaign records and dials progressive records after countdown", async () => {
  const source = await readFile(new URL("../components/contact-center/AgentDesktop.jsx", import.meta.url), "utf8");

  assert.match(source, /\/api\/contact-center\/agent\/campaigns\/next/);
  assert.match(source, /campaignAssignment/);
  assert.match(source, /auto_dial_at/);
  assert.match(source, /\/api\/contact-center\/agent\/campaigns\/dial/);
  assert.match(source, /Outbound Campaign Record/);
  assert.match(source, /Start outbound call/);
});
test("campaign configuration form exposes one grouped Agent Script selector for preview/progressive agent desktop", async () => {
  const source = await readFile(new URL("../app/(portal)/supervisor/outbound-dialer/page.jsx", import.meta.url), "utf8");
  const formStart = source.indexOf("function CampaignSettingsForm");
  const formEnd = source.indexOf("function parseTtsVoiceString", formStart);
  assert.ok(formStart > -1 && formEnd > formStart, "CampaignSettingsForm should exist");
  const formSource = source.slice(formStart, formEnd);

  assert.match(formSource, /const showAgentScript = \["preview", "progressive"\]\.includes\(mode\)/);
  assert.match(formSource, /<AgentScriptSelect[\s\S]*label="Agent Script"/);
  assert.match(source, /CommandGroup heading="Forms"/);
  assert.match(source, /CommandGroup heading="Workflows"/);
  assert.match(formSource, /attached_form_id/);
  assert.match(formSource, /attached_workflow_id/);
  assert.match(formSource, /Agent desktop/);
  assert.doesNotMatch(formSource, /<ConfigSelect label="Agent Script"/);
});
