import test from "node:test";
import assert from "node:assert/strict";
import {
  buildOutboundLiveCallsPayload,
  normalizeOutboundLiveCallStatus,
  shouldShowOutboundLiveCall,
} from "../lib/outbound-dialer/live-calls.js";

test("normalizeOutboundLiveCallStatus maps active attempt states to live call states", () => {
  assert.equal(normalizeOutboundLiveCallStatus("dialing"), "ringing");
  assert.equal(normalizeOutboundLiveCallStatus("claimed"), "ringing");
  assert.equal(normalizeOutboundLiveCallStatus("answered"), "connected");
  assert.equal(normalizeOutboundLiveCallStatus("completed"), "hangup");
  assert.equal(normalizeOutboundLiveCallStatus("failed"), "failed");
});

test("shouldShowOutboundLiveCall keeps hangup calls for 60 seconds only", () => {
  const now = new Date("2026-05-17T18:00:00.000Z");
  assert.equal(shouldShowOutboundLiveCall({ status: "completed", updated_at: "2026-05-17T17:59:01.000Z" }, now), true);
  assert.equal(shouldShowOutboundLiveCall({ status: "completed", updated_at: "2026-05-17T17:58:59.000Z" }, now), false);
  assert.equal(shouldShowOutboundLiveCall({ status: "answered", updated_at: "2026-05-17T17:00:00.000Z" }, now), true);
});

test("buildOutboundLiveCallsPayload returns totals, filters, timers, numbers and session payload", () => {
  const now = new Date("2026-05-17T18:00:00.000Z");
  const payload = buildOutboundLiveCallsPayload([
    {
      id: "attempt-1",
      campaign_id: "campaign-1",
      campaign_name: "Renewals",
      status: "answered",
      call_control_id: "call-a",
      call_session_id: "session-a",
      created_at: "2026-05-17T17:58:30.000Z",
      updated_at: "2026-05-17T17:59:30.000Z",
      from_number: "+48111111111",
      to_number: "+48222222222",
      contact_row_data: { first_name: "Ada" },
      contact_methods: [{ type: "mobile", value: "+48222222222" }],
      metadata: { attempt: 1 },
    },
    {
      id: "attempt-2",
      campaign_id: "campaign-2",
      campaign_name: "Winback",
      status: "completed",
      call_control_id: "call-b",
      call_session_id: "session-b",
      created_at: "2026-05-17T17:57:00.000Z",
      updated_at: "2026-05-17T17:59:15.000Z",
      metadata: { from_number: "+48333333333", to_number: "+48444444444" },
    },
    {
      id: "attempt-3",
      campaign_id: "campaign-3",
      campaign_name: "Expired",
      status: "completed",
      call_control_id: "call-c",
      created_at: "2026-05-17T17:50:00.000Z",
      updated_at: "2026-05-17T17:50:10.000Z",
    },
  ], { now });

  assert.equal(payload.calls.length, 2);
  assert.equal(payload.totals.active, 1);
  assert.equal(payload.totals.total, 2);
  assert.deepEqual(payload.totals.byStatus, { connected: 1, hangup: 1 });
  assert.deepEqual(payload.filters.campaigns.map((item) => item.id), ["campaign-1", "campaign-2"]);
  assert.deepEqual(payload.filters.statuses, ["connected", "hangup"]);
  assert.equal(payload.calls[0].duration_seconds, 90);
  assert.equal(payload.calls[0].from_number, "+48111111111");
  assert.equal(payload.calls[0].to_number, "+48222222222");
  assert.equal(payload.calls[0].sessionDetails.call_control_id, "call-a");
  assert.equal(payload.calls[0].supervisionCall.callControlId, "call-a");
});
