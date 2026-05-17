import test from "node:test";
import assert from "node:assert/strict";

import {
  campaignControlState,
  campaignStatusEventsFromCampaigns,
  contactRecordLabel,
  groupAttemptsByContactRecord,
  normalizeCampaignExecutionState,
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
