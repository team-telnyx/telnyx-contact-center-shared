import test from "node:test";
import assert from "node:assert/strict";

import {
  attemptStatusReasonLabel,
  campaignControlState,
  campaignStatusEventsFromCampaigns,
  contactRecordHeaderLabel,
  contactRecordLabel,
  groupAttemptsByContactRecord,
  normalizeCampaignExecutionState,
  singleCampaignSelection,
} from "../lib/outbound-dialer/history-view-model.js";

test("exhausted campaigns use explicit exhausted state and disable all dashboard controls", () => {
  const campaign = {
    id: "campaign-1",
    status: "stopped",
    metadata: { execution_state: "stopped", auto_completed_reason: "all_callable_records_exhausted" },
  };

  assert.equal(normalizeCampaignExecutionState(campaign), "exhausted");
  assert.deepEqual(campaignControlState(campaign), {
    state: "exhausted",
    pauseAction: "pause",
    canStart: false,
    canStop: false,
    canPause: false,
    canRecycle: false,
    controlsDisabled: true,
  });
});

test("running campaign with zero callable records and no active calls is treated as exhausted", () => {
  const campaign = { id: "campaign-1", status: "running", metadata: {} };
  const runtime = { progress: { total: 10, completed: 10, remaining: 0 }, live: { active: 0, ringing: 0 } };

  assert.equal(normalizeCampaignExecutionState(campaign, runtime), "exhausted");
  assert.deepEqual(campaignControlState(campaign, false, runtime), {
    state: "exhausted",
    pauseAction: "pause",
    canStart: false,
    canStop: false,
    canPause: false,
    canRecycle: false,
    controlsDisabled: true,
  });
});

test("running campaign with persisted running metadata and zero callable records is treated as exhausted", () => {
  const campaign = { id: "campaign-1", status: "running", metadata: { execution_state: "running" } };
  const runtime = { progress: { total: 10, completed: 10, remaining: 0 }, live: { active: 0, ringing: 0 } };

  assert.equal(normalizeCampaignExecutionState(campaign, runtime), "exhausted");
  assert.equal(campaignControlState(campaign, false, runtime).state, "exhausted");
});

test("running campaign with active calls is not treated as exhausted even when callable is zero", () => {
  const campaign = { id: "campaign-1", status: "running", metadata: {} };
  const runtime = { progress: { total: 10, completed: 10, remaining: 0 }, live: { active: 1, ringing: 0 } };

  assert.equal(normalizeCampaignExecutionState(campaign, runtime), "running");
  assert.equal(campaignControlState(campaign, false, runtime).state, "running");
});

test("event viewer campaign selector requires one concrete campaign", () => {
  const campaigns = [{ id: "campaign-1" }, { id: "campaign-2" }];
  assert.deepEqual(singleCampaignSelection(campaigns, "all"), { id: "campaign-1", hasCampaigns: true });
  assert.deepEqual(singleCampaignSelection(campaigns, "campaign-2"), { id: "campaign-2", hasCampaigns: true });
  assert.deepEqual(singleCampaignSelection(campaigns, "missing"), { id: "campaign-1", hasCampaigns: true });
  assert.deepEqual(singleCampaignSelection([], "all"), { id: null, hasCampaigns: false });
});

test("event viewer includes only campaign status events and synthesizes exhausted events", () => {
  const events = campaignStatusEventsFromCampaigns([
    {
      id: "campaign-1",
      name: "Campaign 1",
      updated_at: "2026-05-17T10:00:00.000Z",
      metadata: {
        event_timeline: [
          { type: "start", at: "2026-05-17T09:00:00.000Z" },
          { type: "dialing", at: "2026-05-17T09:01:00.000Z" },
          { type: "completed", at: "2026-05-17T09:02:00.000Z" },
          { type: "failed", at: "2026-05-17T09:03:00.000Z" },
        ],
      },
    },
    {
      id: "campaign-2",
      name: "Campaign 2",
      updated_at: "2026-05-17T11:00:00.000Z",
      metadata: { auto_completed_reason: "all_callable_records_exhausted" },
    },
  ]);

  assert.deepEqual(events.map((event) => event.type), ["exhausted", "start"]);
  assert.ok(events.every((event) => ["start", "stop", "pause", "recycle", "exhausted"].includes(event.type)));
});

test("event viewer maps resume control actions to a running status event", () => {
  const events = campaignStatusEventsFromCampaigns([
    {
      id: "campaign-1",
      name: "Campaign 1",
      updated_at: "2026-05-17T11:00:00.000Z",
      metadata: {
        execution_control: {
          lastAction: "resume",
          updatedAt: "2026-05-17T11:00:00.000Z",
        },
      },
    },
  ]);

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "start");
});

test("history groups attempts by contact-list record with identifying row data and status counts", () => {
  const groups = groupAttemptsByContactRecord(
    [
      {
        contact_record_id: "record-1",
        row_data: { first_name: "Ada", last_name: "Lovelace", company_name: "Analytical Engines" },
        contact_methods: { number: { work: "+48100100100" } },
      },
    ],
    [
      { id: "attempt-1", contact_record_id: "record-1", status: "failed", reason_code: "user_busy", created_at: "2026-05-17T09:00:00.000Z" },
      { id: "attempt-2", contact_record_id: "record-1", status: "completed", reason_code: "completed", created_at: "2026-05-17T10:00:00.000Z" },
    ],
  );

  assert.equal(groups.length, 1);
  assert.equal(groups[0].label.to, "+48100100100");
  assert.equal(groups[0].label.name, "Ada Lovelace");
  assert.equal(groups[0].label.company, "Analytical Engines");
  assert.equal(groups[0].attempt_count, 2);
  assert.deepEqual(groups[0].status_counts, { failed: 1, completed: 1 });
  assert.deepEqual(groups[0].attempts.map((attempt) => attempt.id), ["attempt-2", "attempt-1"]);
});

test("contact record label uses contact-list field schema semantic mappings", () => {
  const label = contactRecordLabel(
    {
      row_data: { Imie: "Jan", Nazwisko: "Kowalski", Firma: "Telnyx", Telefon: "+48600111222" },
      contact_methods: { number: { mobile: "+48600111222" } },
    },
    {
      custom_field_schema: [
        { name: "Imie", type: "first_name" },
        { name: "Nazwisko", type: "last_name" },
        { name: "Firma", type: "company" },
        { name: "Telefon", type: "phone" },
      ],
    },
  );

  assert.deepEqual(label, { to: "+48600111222", name: "Jan Kowalski", displayName: "", company: "Telnyx" });
});

test("contact record label ignores non-callable contact methods when choosing a phone number", () => {
  const label = contactRecordLabel({
    row_data: { first_name: "Ada" },
    contact_methods: {
      email: { primary: "ada@example.com" },
      number: { work: "+48100100100" },
    },
  });

  assert.equal(label.to, "+48100100100");
});

test("contact record label uses joined attempt contact_row_data with semantic mappings", () => {
  const label = contactRecordLabel(
    {
      to_number: "+48666368808",
      contact_row_data: { First: "Marta", Last: "Nowak", Display: "Marta N.", Company: "Telnyx PL" },
      contact_methods: { number: { mobile: "+48666368808" } },
    },
    {
      custom_field_schema: [
        { name: "First", type: "first_name" },
        { name: "Last", type: "last_name" },
        { name: "Display", type: "display_name" },
        { name: "Company", type: "company" },
      ],
    },
  );

  assert.deepEqual(label, { to: "+48666368808", name: "Marta Nowak", displayName: "Marta N.", company: "Telnyx PL" });
});

test("contact record label infers identity columns from imported header names", () => {
  const label = contactRecordLabel(
    {
      row_data: { "First & Last Name": "Anna Zielinska", "Display Name": "Anna Z.", Company: "Telnyx", Phone: "+48600111222" },
      contact_methods: {},
    },
    { custom_field_schema: [{ name: "First & Last Name", type: "text" }, { name: "Display Name", type: "text" }, { name: "Company", type: "text" }, { name: "Phone", type: "phone" }] },
  );

  assert.deepEqual(label, { to: "+48600111222", name: "Anna Zielinska", displayName: "Anna Z.", company: "Telnyx" });
});

test("contact record label infers DEV imported row_data headers when contact list schema is unavailable", () => {
  const label = contactRecordLabel({
    row_data: { "First name": "Leszek", "Last name": "Winiarski", Company: "Telnyx", Number: "+48602410402" },
    contact_methods: { number: { mobile: "+48602410402" } },
  });

  assert.deepEqual(label, { to: "+48602410402", name: "Leszek Winiarski", displayName: "", company: "Telnyx" });
});

test("contact record header label joins phone name and company with pipe separators", () => {
  assert.equal(
    contactRecordHeaderLabel({ to: "+48602410402", name: "Leszek Winiarski", displayName: "", company: "Telnyx" }),
    "+48602410402 | Leszek Winiarski | Telnyx",
  );
  assert.equal(contactRecordHeaderLabel({ to: "+48602410402", name: "", company: "Telnyx" }), "+48602410402 | Telnyx");
  assert.equal(contactRecordHeaderLabel({ to: "+48602410402", name: "", company: "" }), "+48602410402");
});

test("attempt status reason label combines status and reason unless cancelled", () => {
  assert.equal(attemptStatusReasonLabel({ status: "failed", reason_code: "user_busy" }), "Failed - User Busy");
  assert.equal(attemptStatusReasonLabel({ status: "completed", reason_code: "normal_clearing" }), "Completed - Normal Clearing");
  assert.equal(attemptStatusReasonLabel({ status: "cancelled", reason_code: "cancelled" }), "Cancelled");
  assert.equal(attemptStatusReasonLabel({ status: "cancelled", reason_code: "originator_cancel" }), "Cancelled");
});

test("campaign status events include persisted campaign run lifecycle rows", () => {
  const events = campaignStatusEventsFromCampaigns(
    [{ id: "campaign-1", name: "Campaign 1", updated_at: "2026-05-17T10:00:00.000Z", metadata: {} }],
    {
      "campaign-1": {
        campaign_runs: [
          { id: "run-1", status: "running", started_by: "leszek", started_at: "2026-05-17T09:00:00.000Z" },
          { id: "run-2", status: "stopped", started_at: "2026-05-17T10:00:00.000Z", stopped_by: "leszek", stopped_at: "2026-05-17T10:05:00.000Z", stop_reason: "manual" },
        ],
      },
    },
  );

  assert.deepEqual(events.map((event) => event.type), ["stop", "start", "start"]);
  assert.ok(events.some((event) => event.details.includes("manual")));
});

test("history keeps attempts without contact records in separate fallback groups", () => {
  const groups = groupAttemptsByContactRecord(
    [],
    [
      { id: "attempt-1", status: "failed", to_number: "+48100100100", created_at: "2026-05-17T09:00:00.000Z" },
      { id: "attempt-2", status: "completed", to_number: "+48100100101", created_at: "2026-05-17T10:00:00.000Z" },
    ],
  );

  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((group) => group.id).sort(), ["unmatched:attempt-1", "unmatched:attempt-2"]);
  assert.ok(groups.every((group) => group.attempt_count === 1));
});
