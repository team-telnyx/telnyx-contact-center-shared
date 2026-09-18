import assert from "node:assert/strict";
import test from "node:test";

import {
  describeWebrtcDialFailure,
  claimWebrtcDialFailure,
  directIntentIdFromCall,
  isWebrtcDialFailureState,
  markWebrtcCallConnected,
  shouldHandleWebrtcDialFailure,
} from "../lib/webrtc-dial-failure.js";

test("all supported WebRTC dialing failures are terminal", () => {
  for (const state of [
    "busy", "failed", "rejected", "declined", "unavailable", "no_answer",
    "timeout", "request_timeout", "cancelled", "canceled", "error",
  ]) {
    assert.equal(isWebrtcDialFailureState(state), true, state);
    assert.ok(describeWebrtcDialFailure(state));
  }
  assert.equal(isWebrtcDialFailureState("ringing"), false);
  assert.equal(isWebrtcDialFailureState("connected"), false);
});

test("only pre-connect outbound failures trigger recovery", () => {
  const outbound = { direction: "outbound" };
  const inbound = { direction: "inbound" };
  assert.equal(
    shouldHandleWebrtcDialFailure({ call: outbound, state: "busy", currentStatus: "trying" }),
    true,
  );
  assert.equal(
    shouldHandleWebrtcDialFailure({ call: inbound, state: "busy", currentStatus: "ringing" }),
    false,
  );
  assert.equal(
    shouldHandleWebrtcDialFailure({ call: outbound, state: "cancelled", currentStatus: "ended" }),
    false,
  );
  markWebrtcCallConnected(outbound);
  assert.equal(
    shouldHandleWebrtcDialFailure({ call: outbound, state: "error", currentStatus: "connected" }),
    false,
  );
});

test("dial failure ownership is shared across both softphone surfaces", () => {
  const call = {};
  assert.equal(claimWebrtcDialFailure(call), true);
  assert.equal(claimWebrtcDialFailure(call), false);
});

test("direct intent identity is recovered from every WebRTC header location", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  for (const call of [
    { options: { customHeaders: [{ name: "X-CC-Direct-Intent-Id", value: id }] } },
    { inviteCustomHeaders: [{ name: "x-cc-direct-intent-id", value: id }] },
    { invite: { customHeaders: [{ name: "X-CC-DIRECT-INTENT-ID", value: id }] } },
    { customHeaders: [{ name: "X-CC-Direct-Intent-Id", value: id }] },
  ]) assert.equal(directIntentIdFromCall(call), id);
  assert.equal(directIntentIdFromCall({}), null);
});
