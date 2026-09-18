import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  callHistoryAddressDisplayName,
  isE164Address,
  isWebRtcAddress,
} from "../lib/contact-center/telephony-address.js";

const read = (path) =>
  readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("telephony addresses preserve E.164 numbers and collapse WebRTC identities", () => {
  assert.equal(isE164Address("+48220000530"), true);
  assert.equal(isWebRtcAddress("+48220000530"), false);
  assert.equal(
    isWebRtcAddress("sip:gencred-long-generated-identity@sip.telnyx.com"),
    true,
  );
  assert.equal(isWebRtcAddress("call:v3:generated-call-control-id"), true);
  assert.equal(isWebRtcAddress("agent@example.com"), true);
});

test("voice history uses the WebRTC address view and Agent Desktop keeps caller identity", async () => {
  const component = await read("components/contact-center/TelephonyAddress.jsx");
  const history = await read(
    "components/contact-center/SupervisorCallHistoryView.jsx",
  );
  const interactions = await read(
    "components/contact-center/InteractionsList.jsx",
  );

  assert.match(component, /label \|\| "WebRTC"/);
  assert.match(component, /HoverCardContent/);
  assert.match(component, /navigator\.clipboard\.writeText\(address\)/);
  assert.match(history, /callHistoryAddressDisplayName\(item, "from"\)/);
  assert.match(history, /callHistoryAddressDisplayName\(item, "to"\)/);
  assert.match(interactions, /Voice call with \$\{callerNameLabel\|\|callerNumberLabel\}/);
});

test("call history names a known user on the WebRTC side of the call", () => {
  const outbound = {
    direction: "outbound",
    from_number: "sip:generated-agent@sip.telnyx.com",
    from_name: "Customer name stored by the legacy projection",
    to_number: "+48220000510",
    agent_name: "John Wick",
  };
  assert.equal(callHistoryAddressDisplayName(outbound, "from"), "John Wick");
  assert.equal(callHistoryAddressDisplayName(outbound, "to"), null);

  const inbound = {
    direction: "inbound",
    from_number: "+48600000001",
    from_name: "Demo User",
    to_number: "sip:generated-agent@sip.telnyx.com",
    agent_username: "agent@example.com",
  };
  assert.equal(
    callHistoryAddressDisplayName(inbound, "to"),
    "agent@example.com",
  );
  assert.equal(
    callHistoryAddressDisplayName(inbound, "from"),
    "Demo User",
  );
});

test("an accepted queue transfer keeps the reused interaction visible", async () => {
  const modal = await read("components/contact-center/TransferModal.jsx");
  const desktop = await read("components/contact-center/AgentDesktop.jsx");

  assert.match(modal, /contact-center:queue-transfer-accepted/);
  assert.match(desktop, /queueTransferContinuationsRef/);
  assert.match(desktop, /!isQueueTransferContinuation\(interaction\)/);
  assert.match(desktop, /isOwnedQueueTransferContinuation/);
  assert.match(desktop, /contact-center:queue-transfer-accepted/);
});

test("transfer and supervision mode tiles use neutral cards with colored accents", async () => {
  const transfer = await read("components/contact-center/TransferModal.jsx");
  const supervision = await read(
    "components/contact-center/SupervisionModal.jsx",
  );

  assert.match(transfer, /border-2 bg-background p-3 text-foreground/);
  assert.doesNotMatch(transfer, /bg-blue-500 text-white border-blue-600/);
  assert.match(supervision, /border-2 bg-background text-foreground/);
  assert.doesNotMatch(supervision, /bg-blue-500 text-white border-blue-600/);
  assert.match(supervision, /function SupervisionParticipantCard/);
  assert.match(supervision, /testId="supervision-party-supervisor"/);
  assert.match(supervision, /testId="supervision-party-caller"/);
  assert.match(supervision, /testId="supervision-party-agent"/);
  assert.match(supervision, /min-h-\[76px\][\s\S]*rounded-xl[\s\S]*p-3/);
  assert.match(supervision, /M 284 92 V 140 H 150 V 208/);
  assert.match(supervision, /M 316 92 V 140 H 450 V 208/);
  assert.match(supervision, /M 284 246 H 316/);
  assert.match(supervision, /grid grid-cols-2 gap-8/);
  assert.doesNotMatch(supervision, /<circle/);
  assert.doesNotMatch(supervision, /<rect/);
});
