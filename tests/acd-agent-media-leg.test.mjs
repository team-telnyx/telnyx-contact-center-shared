import assert from "node:assert/strict";
import test from "node:test";

import {
  isAcdAgentMediaEvent,
  resolveAcdAgentDeviceCallControlId,
  resolveAcdAgentMediaTriggerCallControlId,
} from "../lib/contact-center/acd-media-leg.mjs";

test("Core ACD keeps the device identity separate from the transport STT trigger", () => {
  const interaction = {
    metadata: {
      agent_transport_call_control_id: "v3:transport",
      agent_call_control_id: "v3:device",
    },
  };

  assert.equal(resolveAcdAgentDeviceCallControlId(interaction), "v3:device");
  assert.equal(resolveAcdAgentMediaTriggerCallControlId(interaction), "v3:transport");
  assert.equal(
    isAcdAgentMediaEvent(interaction, { call_control_id: "v3:transport" }),
    true,
  );
  assert.equal(
    isAcdAgentMediaEvent(interaction, { call_control_id: "v3:device" }),
    false,
  );
});

test("Core ACD Agent Assist supports a device-only topology", () => {
  const interaction = {
    metadata: { agent_call_control_id: "v3:legacy-device" },
  };

  assert.equal(resolveAcdAgentDeviceCallControlId(interaction), "v3:legacy-device");
  assert.equal(resolveAcdAgentMediaTriggerCallControlId(interaction), "v3:legacy-device");
  assert.equal(
    isAcdAgentMediaEvent(interaction, {
      call_control_id: "v3:legacy-device",
    }),
    true,
  );
});

test("Core ACD Agent Assist ignores answered events without a known media leg", () => {
  assert.equal(resolveAcdAgentDeviceCallControlId({ metadata: {} }), null);
  assert.equal(
    isAcdAgentMediaEvent(
      { metadata: {} },
      { call_control_id: "v3:unrelated" },
    ),
    false,
  );
});
