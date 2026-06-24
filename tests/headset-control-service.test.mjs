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

  it("does not let one adapter's disconnect clear another adapter's connected device", async () => {
    const emitted = [];
    let eposDeviceChange;
    let jabraDeviceChange;
    const epos = {
      vendor: "epos",
      async init() {},
      onCommand() { return () => {}; },
      onDeviceChange(callback) { eposDeviceChange = callback; return () => {}; },
    };
    const jabra = {
      vendor: "jabra",
      async init() {},
      onCommand() { return () => {}; },
      onDeviceChange(callback) { jabraDeviceChange = callback; return () => {}; },
    };

    const service = createHeadsetControlService({ adapters: [epos, jabra] });
    service.onDeviceChange((device) => emitted.push(device));
    await service.init();

    eposDeviceChange({ vendor: "epos", model: "Sennheiser BTD 800 USB for Lync", connectionState: "connected" });
    jabraDeviceChange(null);

    assert.equal(service.getDevice().model, "Sennheiser BTD 800 USB for Lync");
    assert.equal(emitted.at(-1).model, "Sennheiser BTD 800 USB for Lync");
  });

  it("forwards adapter diagnostics without changing the selected device", async () => {
    const diagnostics = [];
    let diagnosticHandler;
    const adapter = {
      vendor: "epos",
      async init() {},
      onCommand() { return () => {}; },
      onDeviceChange() { return () => {}; },
      onDiagnostic(callback) { diagnosticHandler = callback; return () => {}; },
    };

    const service = createHeadsetControlService({ adapters: [adapter] });
    service.onDiagnostic((diagnostic) => diagnostics.push(diagnostic));
    await service.init();

    diagnosticHandler({ message: "EPOS HeadsetDisconnected notification", level: "warn" });

    assert.deepEqual(diagnostics, [{ message: "EPOS HeadsetDisconnected notification", level: "warn", vendor: "epos" }]);
    assert.equal(service.getDevice(), null);
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
  it("surfaces EPOS service-ready and service-missing states instead of silently hiding websocket failures", async () => {
    const devices = [];
    class FailingWebSocket {
      constructor() {
        this.readyState = 0;
        queueMicrotask(() => this.onerror?.(new Error("connection refused")));
      }
      send() {}
      close() {}
    }

    const adapter = createEposAdapter({
      WebSocketImpl: FailingWebSocket,
      url: "wss://127.0.0.1:41088",
      reconnectDelayMs: 0,
      activeDevicePollMs: 0,
    });
    adapter.onDeviceChange((device) => devices.push(device));
    await adapter.init();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await adapter.dispose();

    assert.equal(devices.at(-1).connectionState, "service-missing");
  });

  it("sends SDK-service websocket messages for call, mute, hold, and resume state", async () => {
    const sent = [];
    const devices = [];
    class FakeWebSocket {
      constructor() {
        this.readyState = 0;
        queueMicrotask(() => {
          this.readyState = 1;
          this.onopen?.();
        });
      }
      send(payload) {
        sent.push(JSON.parse(payload));
      }
      close() {}
    }

    const adapter = createEposAdapter({ WebSocketImpl: FakeWebSocket, url: "wss://127.0.0.1:41088", softphoneName: "Telnyx Contact Center", activeDevicePollMs: 0 });
    adapter.onDeviceChange((device) => devices.push(device));
    await adapter.init();
    await new Promise((resolve) => setTimeout(resolve, 0));
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

  it("polls EPOS ActiveDeviceChanged so plug/unplug changes appear without refreshing", async () => {
    const sent = [];
    class FakeWebSocket {
      constructor() {
        this.readyState = 0;
        queueMicrotask(() => {
          this.readyState = 1;
          this.onopen?.();
        });
      }
      send(payload) {
        sent.push(JSON.parse(payload));
      }
      close() {}
    }

    const adapter = createEposAdapter({ WebSocketImpl: FakeWebSocket, activeDevicePollMs: 5, reconnectDelayMs: 0 });
    await adapter.init();
    await new Promise((resolve) => setTimeout(resolve, 14));
    await adapter.dispose();

    assert.ok(sent.filter((message) => message.Event === "ActiveDeviceChanged").length >= 2);
  });

  it("keeps an EPOS device connected until a disconnect notification is confirmed", async () => {
    const devices = [];
    const diagnostics = [];
    let socket;
    class FakeWebSocket {
      constructor() {
        socket = this;
        this.readyState = 0;
        queueMicrotask(() => {
          this.readyState = 1;
          this.onopen?.();
        });
      }
      send() {}
      close() {}
    }

    const adapter = createEposAdapter({
      WebSocketImpl: FakeWebSocket,
      reconnectDelayMs: 0,
      disconnectConfirmationMs: 20,
      activeDevicePollMs: 0,
    });
    adapter.onDeviceChange((device) => devices.push(device));
    adapter.onDiagnostic((diagnostic) => diagnostics.push(diagnostic));
    await adapter.init();
    await new Promise((resolve) => setTimeout(resolve, 0));

    socket.onmessage?.({ data: JSON.stringify({ Event: "HeadsetConnected", EventType: "Notification", HeadsetType: "Sennheiser BTD 800 USB for Lync" }) });
    socket.onmessage?.({ data: JSON.stringify({ Event: "HeadsetDisconnected", EventType: "Notification" }) });

    assert.equal(devices.at(-1).model, "Sennheiser BTD 800 USB for Lync");
    assert.equal(diagnostics.some((item) => /HeadsetDisconnected/.test(item.message)), true);

    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.equal(devices.at(-1).connectionState, "service-connected");
  });
});
