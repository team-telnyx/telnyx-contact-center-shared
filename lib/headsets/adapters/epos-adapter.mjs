import { HEADSET_COMMANDS, normalizeSoftphoneState } from "../headset-control-service.mjs";

const DEFAULT_EP0S_URL = "wss://127.0.0.1:41088";
const DEFAULT_SOFTPHONE_NAME = "Telnyx Contact Center";

function waitForOpen(socket) {
  if (!socket) return Promise.reject(new Error("missing websocket"));
  if (socket.readyState === 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const previousOpen = socket.onopen;
    const previousError = socket.onerror;
    socket.onopen = (...args) => {
      previousOpen?.(...args);
      resolve();
    };
    socket.onerror = (event) => {
      previousError?.(event);
      reject(new Error("EPOS websocket connection failed"));
    };
  });
}

function baseMessage(event, callId = null) {
  const message = { Event: event, EventType: "Request" };
  if (callId) message.CallID = callId;
  return message;
}

function toDevice(payload = {}) {
  const model = payload.DeviceName || payload.HeadsetName || payload.ProductName || payload.Model || null;
  return {
    id: String(payload.HeadsetPath || payload.SerialNumber || model || "epos-device"),
    vendor: "epos",
    vendorLabel: "EPOS/Sennheiser",
    model,
    serialNumber: payload.SerialNumber || null,
    productId: payload.ProductId || null,
    transport: "epos-websocket",
    connectionState: "connected",
    battery: payload.BatteryLevel ? { levelPercent: Number(payload.BatteryLevel), charging: null, source: "sdk" } : null,
    capabilities: {
      answer: true,
      reject: true,
      hangup: true,
      mute: true,
      hold: true,
      ring: true,
      battery: Boolean(payload.BatteryLevel),
      donDoff: false,
      busylight: true,
    },
  };
}

export function createEposAdapter({
  WebSocketImpl = globalThis.WebSocket,
  url = process.env.NEXT_PUBLIC_EPOS_SDK_WS_URL || DEFAULT_EP0S_URL,
  softphoneName = process.env.NEXT_PUBLIC_EPOS_SOFTPHONE_NAME || DEFAULT_SOFTPHONE_NAME,
} = {}) {
  const commandSubscribers = new Set();
  const deviceSubscribers = new Set();
  let socket = null;
  let previousState = normalizeSoftphoneState();
  let initialized = false;

  const emitCommand = (command) => {
    for (const subscriber of commandSubscribers) subscriber(command);
  };

  const emitDevice = (device) => {
    for (const subscriber of deviceSubscribers) subscriber(device);
  };

  const send = (message) => {
    if (!socket || typeof socket.send !== "function") return;
    socket.send(JSON.stringify(message));
  };

  const handleMessage = (event) => {
    let payload = null;
    try {
      payload = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
    } catch (_) {
      return;
    }
    if (!payload?.Event) return;

    if (/HeadsetConnected|ActiveDeviceChanged|DeviceConnected/i.test(payload.Event)) {
      emitDevice(toDevice(payload));
      return;
    }
    if (/HeadsetDisconnected|DeviceDisconnected/i.test(payload.Event)) {
      emitDevice(null);
      return;
    }

    const eventName = String(payload.Event);
    if (/InCallAccepted|DNDIncomingCallAccepted|OffHook/i.test(eventName) && payload.EventType !== "Request") {
      emitCommand({ type: HEADSET_COMMANDS.ANSWER, source: "headset" });
    } else if (/InCallRejected/i.test(eventName) && payload.EventType !== "Request") {
      emitCommand({ type: HEADSET_COMMANDS.REJECT, source: "headset" });
    } else if (/CallEnded|OnHook/i.test(eventName) && payload.EventType !== "Request") {
      emitCommand({ type: HEADSET_COMMANDS.HANGUP, source: "headset" });
    } else if (/MuteHeadset/i.test(eventName) && payload.EventType !== "Request") {
      emitCommand({ type: HEADSET_COMMANDS.MUTE, muted: true, source: "headset" });
    } else if (/UnmuteHeadset/i.test(eventName) && payload.EventType !== "Request") {
      emitCommand({ type: HEADSET_COMMANDS.MUTE, muted: false, source: "headset" });
    } else if (/CallHold|ConfCallOnHold/i.test(eventName) && payload.EventType !== "Request") {
      emitCommand({ type: HEADSET_COMMANDS.HOLD, held: true, source: "headset" });
    } else if (/HeldCallResumed|HeldConfCallResumed/i.test(eventName) && payload.EventType !== "Request") {
      emitCommand({ type: HEADSET_COMMANDS.HOLD, held: false, source: "headset" });
    }
  };

  return {
    vendor: "epos",

    async init() {
      if (initialized) return;
      initialized = true;
      if (!WebSocketImpl) {
        emitDevice({
          id: "epos-service-missing",
          vendor: "epos",
          vendorLabel: "EPOS/Sennheiser",
          model: null,
          transport: "epos-websocket",
          connectionState: "service-missing",
          capabilities: {},
        });
        return;
      }
      socket = new WebSocketImpl(url);
      socket.onmessage = handleMessage;
      await waitForOpen(socket);
      send({
        Event: "EstablishConnection",
        EventType: "Request",
        SPName: softphoneName,
        SPIconImage: "telnyx-contact-center.ico",
        RedialSupport: "Yes",
        OffHookSupport: "Yes",
        MuteSupport: "Yes",
        AudioDeviceChangesSupport: "Yes",
        DNDOption: "Yes",
      });
      send(baseMessage("SPLoggedIn"));
    },

    onCommand(callback) {
      commandSubscribers.add(callback);
      return () => commandSubscribers.delete(callback);
    },

    onDeviceChange(callback) {
      deviceSubscribers.add(callback);
      return () => deviceSubscribers.delete(callback);
    },

    async setSoftphoneState(state) {
      const next = normalizeSoftphoneState(state);
      const callId = next.callId || previousState.callId || "1";

      if (next.ringing && !previousState.ringing) {
        send(baseMessage("IncomingCall", callId));
      }
      if (next.active && !previousState.active) {
        send(baseMessage(next.direction === "outgoing" ? "OutCallAccepted" : "InCallAccepted", callId));
      }
      if (next.muted !== previousState.muted) {
        send(baseMessage(next.muted ? "MuteHeadset" : "UnmuteHeadset", callId));
      }
      if (next.held !== previousState.held) {
        send(baseMessage(next.held ? "CallHold" : "HeldCallResumed", callId));
      }
      if (!next.active && !next.ringing && (previousState.active || previousState.ringing)) {
        send(baseMessage("CallEnded", callId));
      }
      previousState = next;
    },

    async sendTestCommand(command) {
      if (command === "ring") send(baseMessage("IncomingCall", "test"));
      if (command === "muteOn") send(baseMessage("MuteHeadset", "test"));
      if (command === "muteOff") send(baseMessage("UnmuteHeadset", "test"));
      if (command === "holdOn") send(baseMessage("CallHold", "test"));
      if (command === "holdOff") send(baseMessage("HeldCallResumed", "test"));
      if (command === "reset") send(baseMessage("CallEnded", "test"));
    },

    async dispose() {
      try {
        send(baseMessage("SPLoggedOut"));
        send(baseMessage("TerminateConnection"));
        socket?.close?.();
      } catch (_) {}
      socket = null;
      initialized = false;
      previousState = normalizeSoftphoneState();
    },
  };
}
