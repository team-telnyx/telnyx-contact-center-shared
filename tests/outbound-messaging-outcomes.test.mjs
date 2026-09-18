import assert from "node:assert/strict";
import test from "node:test";
import { classifyMessagingOutcome, deliveryAdvances, deliveryStateFor } from "../lib/outbound-dialer/messaging/outcomes.mjs";
import { COMMITTED_STATES, computeMessagingBudget, senderCapacity } from "../lib/outbound-dialer/messaging/pacing.mjs";
import { MESSAGE_STATE_LEDGER_STATUS, OUTBOUND_MESSAGE_STATES } from "../lib/outbound-dialer/messaging/schema.mjs";

const settings = { attempts: { throttled_retry_minutes: 5, transient_retry_minutes: 30, frequency_cap_retry_hours: 24 } };

test("provider rejections classify into throttled, transient, opted-out, undeliverable and sender problems", () => {
  assert.equal(classifyMessagingOutcome("sms", { outcome: "ambiguous", httpStatus: 429 }, settings).state, "throttled");
  assert.equal(classifyMessagingOutcome("sms", { outcome: "failed", httpStatus: 422, code: "40318" }, settings).throttled, true);
  const transient = classifyMessagingOutcome("sms", { outcome: "failed", httpStatus: 422, code: "40016" }, settings);
  assert.equal(transient.state, "failed_transient");
  assert.equal(transient.retry_minutes, 30);
  const stop = classifyMessagingOutcome("sms", { outcome: "failed", httpStatus: 422, code: "40300" }, settings);
  assert.equal(stop.state, "failed_permanent");
  assert.equal(stop.reason_code, "opted_out");
  assert.equal(classifyMessagingOutcome("sms", { outcome: "failed", httpStatus: 422, code: "40001" }, settings).state, "undeliverable");
  const sender = classifyMessagingOutcome("sms", { outcome: "failed", httpStatus: 422, code: "40010" }, settings);
  assert.equal(sender.pause_campaign, true);
  assert.equal(classifyMessagingOutcome("sms", { outcome: "ambiguous", httpStatus: 503 }, settings).state, "unconfirmed");
  assert.equal(classifyMessagingOutcome("sms", { outcome: "ambiguous", httpStatus: 401 }, settings).pause_campaign, true);
  assert.equal(classifyMessagingOutcome("whatsapp", { outcome: "failed", httpStatus: 422, code: "131049" }, settings).retry_minutes, 24 * 60);
});

test("delivery evidence maps to message states and never moves backwards", () => {
  assert.equal(deliveryStateFor("sms", { status: "delivered" }).state, "delivered");
  assert.equal(deliveryStateFor("sms", { status: "sending" }).state, "accepted");
  assert.equal(deliveryStateFor("sms", { status: "delivery_unconfirmed" }).state, "unconfirmed");
  const failed = deliveryStateFor("sms", { status: "delivery_failed", code: "40300" }, settings);
  assert.equal(failed.state, "failed_permanent");
  assert.equal(failed.reason_code, "opted_out");
  assert.equal(deliveryStateFor("sms", { status: "sending_failed", code: "40011" }, settings).state, "failed_transient");
  assert.equal(deliveryStateFor("sms", { status: "unknown_status" }), null);
  assert.equal(deliveryAdvances("accepted", "sent"), true);
  assert.equal(deliveryAdvances("delivered", "sent"), false);
  assert.equal(deliveryAdvances("replied", "delivered"), false);
  assert.equal(deliveryAdvances("sent", "failed_permanent"), true);
  assert.equal(deliveryAdvances("unconfirmed", "delivered"), false);
});

test("every message state maps to a coarse ledger status", () => {
  for (const state of OUTBOUND_MESSAGE_STATES) assert.ok(MESSAGE_STATE_LEDGER_STATUS[state], state);
  assert.equal(MESSAGE_STATE_LEDGER_STATUS.replied, "completed");
  assert.equal(MESSAGE_STATE_LEDGER_STATUS.throttled, "cancelled");
});

test("tick budget is the tightest of batch size, windows, in-flight and campaign cap", () => {
  const pacing = { batch_size: 50, max_per_minute: 60, max_per_hour: 2000, max_per_day: 10000, max_in_flight: 200, max_messages_per_campaign: 0 };
  assert.deepEqual(computeMessagingBudget({ pacing, counts: { last_minute: 0, last_hour: 0, last_day: 0, in_flight: 0, campaign_total: 0 } }), { budget: 50, limitedBy: null });
  assert.deepEqual(computeMessagingBudget({ pacing, counts: { last_minute: 55, last_hour: 0, last_day: 0, in_flight: 0, campaign_total: 0 } }), { budget: 5, limitedBy: null });
  assert.deepEqual(computeMessagingBudget({ pacing, counts: { last_minute: 60, last_hour: 0, last_day: 0, in_flight: 0, campaign_total: 0 } }), { budget: 0, limitedBy: "max_per_minute" });
  assert.deepEqual(computeMessagingBudget({ pacing, counts: { last_minute: 0, last_hour: 0, last_day: 0, in_flight: 200, campaign_total: 0 } }), { budget: 0, limitedBy: "max_in_flight" });
  assert.deepEqual(computeMessagingBudget({ pacing: { ...pacing, max_messages_per_campaign: 100 }, counts: { last_minute: 0, last_hour: 0, last_day: 0, in_flight: 0, campaign_total: 95 } }), { budget: 5, limitedBy: null });
  assert.equal(senderCapacity({ per_sender_per_minute: 10, per_sender_daily: 100 }, { minute: 4, day: 99 }), 1);
  assert.equal(senderCapacity({}, { minute: 4, day: 99 }) > 1000, true);
});

test("a failure reported after the provider accepted the message is never resent", () => {
  // The send phase may retry; the delivery phase describes a message the
  // customer may already have received, so it must not schedule another one.
  const transient = classifyMessagingOutcome("sms", { outcome: "failed", httpStatus: 422, code: "40016", sent: true }, settings);
  assert.equal(transient.state, "failed_transient");
  assert.equal(transient.retry_minutes, null);
  assert.equal(transient.retry_eligible, undefined);
  const capped = classifyMessagingOutcome("whatsapp", { outcome: "failed", code: "131049", sent: true }, settings);
  assert.equal(capped.retry_minutes, null);
  const throttledDelivery = deliveryStateFor("sms", { status: "sending_failed", code: "40011" }, settings);
  assert.equal(throttledDelivery.state, "failed_transient");
  assert.equal(throttledDelivery.retry_minutes, null, "a throttle code in a delivery receipt never reschedules the message");
  assert.equal(throttledDelivery.throttled, undefined, "and never backs the whole campaign off");
  // The send phase keeps its retries.
  assert.equal(classifyMessagingOutcome("sms", { outcome: "failed", httpStatus: 422, code: "40016" }, settings).retry_minutes, 30);
});

test("committed rows are priced into every window so two nodes cannot double-spend", () => {
  const pacing = { batch_size: 50, max_per_minute: 60, max_in_flight: 200, max_messages_per_campaign: 100 };
  // A node that just claimed 60 messages leaves no budget for the next tick,
  // even though none of them has reached the provider yet.
  assert.deepEqual(computeMessagingBudget({ pacing, counts: { last_minute: 60, last_hour: 0, last_day: 0, in_flight: 60, campaign_total: 60 } }), { budget: 0, limitedBy: "max_per_minute" });
  assert.deepEqual(COMMITTED_STATES.filter((state) => ["pending", "rendered", "queued"].includes(state)), ["pending", "rendered", "queued"]);
  assert.equal(COMMITTED_STATES.includes("suppressed"), false, "a suppressed row consumed no provider capacity");
  assert.equal(COMMITTED_STATES.includes("cancelled"), false);
});
