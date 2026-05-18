import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  applyCampaignDispositionToLedger,
  normalizeCampaignDispositionMapping,
} from "../lib/outbound-dialer/campaign-dispositions.js";

test("campaign disposition mappings follow Genesys-style classifications and business categories", () => {
  assert.deepEqual(normalizeCampaignDispositionMapping({
    wrapup_code_id: "sale-made",
    classification: "right_party_contact",
    business_category: "success",
    retry_eligible: true,
  }), {
    wrapup_code_id: "sale-made",
    campaign_id: null,
    classification: "right_party_contact",
    business_category: "success",
    retry_eligible: false,
    requires_callback: false,
    status: "active",
    metadata: {},
  });

  assert.equal(normalizeCampaignDispositionMapping({ classification: "number_uncallable" }).classification, "number_uncallable");
  assert.equal(normalizeCampaignDispositionMapping({ classification: "contact_uncallable" }).classification, "contact_uncallable");
});

test("campaign disposition application converts mappings into ledger outcomes", () => {
  const baseAttempt = { id: "attempt-1", metadata: { assigned_agent: "agent@example.com" } };
  const success = applyCampaignDispositionToLedger(baseAttempt, {
    wrapup_code_id: "sale-made",
    classification: "right_party_contact",
    business_category: "success",
  }, { notes: "Sold" });

  assert.equal(success.status, "completed");
  assert.equal(success.metadata.disposition_code_id, "sale-made");
  assert.equal(success.metadata.disposition_classification, "right_party_contact");
  assert.equal(success.metadata.business_category, "success");
  assert.equal(success.metadata.right_party_contact, true);
  assert.equal(success.metadata.disposition_notes, "Sold");

  const callback = applyCampaignDispositionToLedger(baseAttempt, {
    wrapup_code_id: "callback",
    classification: "retry",
    requires_callback: true,
  }, { callback_at: "2026-05-20T10:30:00.000Z" });
  assert.equal(callback.status, "failed");
  assert.equal(callback.next_retry_at, "2026-05-20T10:30:00.000Z");
  assert.equal(callback.metadata.retry_eligible, true);
  assert.equal(callback.metadata.callback_at, "2026-05-20T10:30:00.000Z");

  const dnc = applyCampaignDispositionToLedger(baseAttempt, {
    wrapup_code_id: "do-not-call",
    classification: "contact_uncallable",
  });
  assert.equal(dnc.status, "suppressed");
  assert.equal(dnc.contact_validation_status, "suppressed");
  assert.equal(dnc.metadata.contact_uncallable, true);
});

test("outbound dialer exposes Disposition codes menu below Time Sets and CRUD wiring", async () => {
  const page = await readFile(new URL("../app/(portal)/supervisor/outbound-dialer/page.jsx", import.meta.url), "utf8");
  const timeSetsIndex = page.indexOf('id: "time-sets"');
  const dispositionIndex = page.indexOf('id: "disposition-codes"');
  const attemptControlsIndex = page.indexOf('id: "attempt-controls"');

  assert.ok(timeSetsIndex > -1, "Time Sets nav item should exist");
  assert.ok(dispositionIndex > timeSetsIndex, "Disposition codes must be below Time Sets");
  assert.ok(dispositionIndex < attemptControlsIndex, "Disposition codes must appear before Attempt Controls");
  assert.match(page, /DispositionCodesSettingsForm/);
  assert.match(page, /wrapup_code_id/);
  assert.match(page, /right_party_contact/);
  assert.match(page, /contact_uncallable/);
  assert.match(page, /number_uncallable/);
  assert.match(page, /Business Category/);
  assert.match(page, /\/disposition-codes/);
  const formStart = page.indexOf("function DispositionCodesSettingsForm");
  const formEnd = page.indexOf("function AttemptControlSettingsForm", formStart);
  assert.ok(formStart > -1 && formEnd > formStart, "DispositionCodesSettingsForm should exist");
  const formSource = page.slice(formStart, formEnd);
  assert.doesNotMatch(formSource, /<Field\b/, "Disposition Codes form should not reference an undefined Field component");
});

test("schema seeds On Campaign Call system status and disposition mapping tables", async () => {
  const schema = await readFile(new URL("../lib/postgres-schema.mjs", import.meta.url), "utf8");

  assert.match(schema, /'on-campaign-call', 'On Campaign Call'/);
  assert.match(schema, /'On Campaign Call'[\s\S]*false/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS outbound_disposition_code_mappings/);
  assert.match(schema, /right_party_contact/);
  assert.match(schema, /business_category/);
});

test("agent desktop opens a campaign disposition sheet after campaign dialing and submit endpoint is wired", async () => {
  const agentDesktop = await readFile(new URL("../components/contact-center/AgentDesktop.jsx", import.meta.url), "utf8");
  assert.match(agentDesktop, /CampaignDispositionSheet/);
  assert.match(agentDesktop, /campaignDispositionAssignment/);
  assert.match(agentDesktop, /\/api\/contact-center\/agent\/campaigns\/disposition/);
  assert.match(agentDesktop, /Campaign Disposition/);

  const submitRoute = await readFile(new URL("../app/api/contact-center/agent/campaigns/disposition/route.js", import.meta.url), "utf8");
  assert.match(submitRoute, /applyCampaignDispositionToLedger/);
  assert.match(submitRoute, /On Campaign Call/);
});
