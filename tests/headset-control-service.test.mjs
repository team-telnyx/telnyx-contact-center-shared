import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createHeadsetControlService,
  HEADSET_COMMANDS,
  normalizeSoftphoneState,
} from "../lib/headsets/headset-control-service.mjs";
import { createJabraAdapter } from "../lib/headsets/adapters/jabra-adapter.mjs";
import { createEposAdapter } from "../lib/headsets/adapters/epos-adapter.mjs";

describe("headset control service", () => {
  it("normalizes softphone state before sending it to active adapters", async () => {
    const sent = [];
    const adapter = {
      vendor: "jabra",
      async init() {},
      async dispose() {},
      async setSoftphoneState(state) {
        sent.push(state);
      },
      onCommand() {
        return () => {};
      },
      onDeviceChange() {
        return () => {};
      },
    };

    const service = createHeadsetControlService({ adapters: [adapter] });
    await service.init();
    await service.setSoftphoneState({
      callId: 123,
      direction: "incoming",
      ringing: 1,
      active: "yes",
      muted: 0,
      held: undefined,
      remoteDisplayName: " Alice ",
      remoteNumber: "+15551234567",
    });

    assert.deepEqual(sent, [{
      callId: "123",
      direction: "incoming",
      ringing: true,
      active: true,
      muted: false,
      held: false,
      remoteDisplayName: "Alice",
      remoteNumber: "+15551234567",
    }]);
  });

  it("deduplicates repeated headset commands within the debounce window", async () => {
    const emitted = [];
    let commandHandler = null;
    const adapter = {
      vendor: "epos",
      async init() {},
      async dispose() {},
      async setSoftphoneState() {},
      onCommand(cb) {
        commandHandler = cb;
        return () => {};
      },
      onDeviceChange() {
        return () => {};
      },
    };

    const service = createHeadsetControlService({ adapters: [adapter], now: () => 1000, debounceMs: 500 });
    service.onCommand((command) => emitted.push(command));
    await service.init();

    commandHandler({ type: HEADSET_COMMANDS.MUTE, muted: true, source: "headset" });
    commandHandler({ type: HEADSET_COMMANDS.MUTE, muted: true, source: "headset" });

    assert.equal(emitted.length, 1);
    assert.deepEqual(emitted[0], { type: "mute", muted: true, source: "headset", vendor: "epos" });
  });

  it("keeps other headset adapters available when one vendor fails to initialize", async () => {
    const initCalls = [];
    const warn = console.warn;
    console.warn = () => {};
    try {
      const jabra = {
        vendor: "jabra",
        async init() { initCalls.push("jabra"); },
        onCommand() { return () => {}; },
        onDeviceChange() { return () => {}; },
      };
      const epos = {
        vendor: "epos",
        async init() { initCalls.push("epos"); throw new Error("EPOS Connect unavailable"); },
        onCommand() { return () => {}; },
        onDeviceChange() { return () => {}; },
      };

      const service = createHeadsetControlService({ adapters: [jabra, epos] });
      await service.init();
      await service.init();

      assert.deepEqual(initCalls, ["jabra", "epos", "epos"]);
    } finally {
      console.warn = warn;
    }
  });

  it("keeps set mute/hold actions idempotent instead of exposing only toggles", () => {
    assert.deepEqual(normalizeSoftphoneState({ muted: true, held: true }), {
      callId: null,
      direction: null,
      ringing: false,
      active: false,
      muted: true,
      held: true,
      remoteDisplayName: null,
      remoteNumber: null,
    });
  });
});

describe("Jabra adapter contract", () => {
  it("uses Jabra Easy Call Control multi-call semantics and WebHID pairing hook", async () => {
    const calls = [];
    const fakeMultiCallControl = {
      signalIncomingCall: async (timeout) => calls.push(["signalIncomingCall", timeout]),
      endCall: async () => calls.push(["endCall"]),
      setMute: async (value) => calls.push(["setMute", value]),
      setHold: async (value) => calls.push(["setHold", value]),
      ongoingCalls: { subscribe() { return { unsubscribe() {} }; } },
      muteState: { subscribe() { return { unsubscribe() {} }; } },
      holdState: { subscribe() { return { unsubscribe() {} }; } },
      swapRequest: { subscribe() { return { unsubscribe() {} }; } },
    };
    const fakeJabra = {
      RequestedBrowserTransport: { CHROME_EXTENSION_WITH_WEB_HID_FALLBACK: "transport" },
      async createApi(config) {
        calls.push(["createApi", config.transport, config.appId, config.appName]);
        return {
          transportContext: "chrome-extension",
          deviceAdded: { subscribe(cb) { cb({ name: "Jabra Engage 50", productId: 1, serialNumber: "SN1" }); return { unsubscribe() {} }; } },
          deviceRemoved: { subscribe() { return { unsubscribe() {} }; } },
          async start() { calls.push(["start"]); },
        };
      },
      EasyCallControlFactory: class {
        supportsEasyCallControl() { return true; }
        async createMultiCallControl() { calls.push(["createMultiCallControl"]); return fakeMultiCallControl; }
      },
      async webHidPairing() { calls.push(["webHidPairing"]); },
    };

    const adapter = createJabraAdapter({ jabra: fakeJabra, partnerKey: "pk", appId: "telnyx-cc", appName: "Telnyx Contact Center", incomingRingTimeoutMs: 45000 });
    await adapter.init();
    await adapter.requestPermission();
    await adapter.setSoftphoneState({ ringing: true, muted: true, held: true, active: false });
    await adapter.setSoftphoneState({ ringing: false, muted: false, held: false, active: false });

    assert.deepEqual(calls, [
      ["createApi", "transport", "telnyx-cc", "Telnyx Contact Center"],
      ["createMultiCallControl"],
      ["start"],
      ["webHidPairing"],
      ["signalIncomingCall", 45000],
      ["setMute", true],
      ["setHold", true],
      ["endCall"],
      ["setMute", false],
      ["setHold", false],
    ]);
  });

  it("emits Jabra answer/reject results and uses unmute/resume fallbacks", async () => {
    const calls = [];
    const emitted = [];
    let resolveIncomingCall;
    const incomingCallResult = new Promise((resolve) => { resolveIncomingCall = resolve; });
    const fakeMultiCallControl = {
      signalIncomingCall: (timeout) => { calls.push(["signalIncomingCall", timeout]); return incomingCallResult; },
      endCall: async () => calls.push(["endCall"]),
      mute: async () => calls.push(["mute"]),
      unmute: async () => calls.push(["unmute"]),
      hold: async () => calls.push(["hold"]),
      resume: async () => calls.push(["resume"]),
      muteState: { subscribe() { return { unsubscribe() {} }; } },
      holdState: { subscribe() { return { unsubscribe() {} }; } },
      swapRequest: { subscribe() { return { unsubscribe() {} }; } },
    };
    const fakeJabra = {
      RequestedBrowserTransport: { CHROME_EXTENSION_WITH_WEB_HID_FALLBACK: "transport" },
      async createApi() {
        return {
          transportContext: "chrome-extension",
          deviceAdded: { subscribe(cb) { cb({ name: "Jabra Engage 50", productId: 1, serialNumber: "SN1" }); return { unsubscribe() {} }; } },
          deviceRemoved: { subscribe() { return { unsubscribe() {} }; } },
        };
      },
      EasyCallControlFactory: class {
        supportsEasyCallControl() { return true; }
        async createMultiCallControl() { return fakeMultiCallControl; }
      },
    };

    const adapter = createJabraAdapter({ jabra: fakeJabra, incomingRingTimeoutMs: 45000 });
    adapter.onCommand((command) => emitted.push(command));
    await adapter.init();
    await adapter.setSoftphoneState({ ringing: true, muted: true, held: true, active: false });
    await adapter.setSoftphoneState({ ringing: false, muted: false, held: false, active: false });

    resolveIncomingCall(true);
    await incomingCallResult;
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(calls, [
      ["signalIncomingCall", 45000],
      ["mute"],
      ["hold"],
      ["endCall"],
      ["unmute"],
      ["resume"],
    ]);
    assert.deepEqual(emitted, [{ type: HEADSET_COMMANDS.ANSWER, source: "headset" }]);
  });
});

describe("EPOS adapter contract", () => {
  it("sends SDK-service websocket messages for call, mute, hold, and resume state", async () => {
    const sent = [];
    class FakeWebSocket {
      constructor(url) {
        this.url = url;
        setTimeout(() => this.onopen?.(), 0);
      }
      send(message) {
        sent.push(JSON.parse(message));
      }
      close() {}
    }

    const adapter = createEposAdapter({ WebSocketImpl: FakeWebSocket, url: "wss://127.0.0.1:41088", softphoneName: "Telnyx Contact Center" });
    await adapter.init();
    await adapter.setSoftphoneState({ callId: "call-1", direction: "incoming", ringing: true, active: false, muted: false, held: false });
    await adapter.setSoftphoneState({ callId: "call-1", direction: "incoming", ringing: false, active: true, muted: true, held: true });
    await adapter.setSoftphoneState({ callId: "call-1", direction: "incoming", ringing: false, active: true, muted: false, held: false });
    await adapter.setSoftphoneState({ callId: "call-1", direction: null, ringing: false, active: false, muted: false, held: false });

    assert.deepEqual(sent.map((message) => message.Event), [
      "EstablishConnection",
      "SPLoggedIn",
      "ActiveDeviceChanged",
      "IncomingCall",
      "InCallAccepted",
      "MuteHeadset",
      "CallHold",
      "UnmuteHeadset",
      "HeldCallResumed",
      "CallEnded",
    ]);
    assert.equal(sent[0].SPName, "Telnyx Contact Center");
    assert.equal(sent[3].CallID, "call-1");
  });
});
