import { HEADSET_COMMANDS, normalizeSoftphoneState } from "../headset-control-service.mjs";

const DEFAULT_EP0S_URL = "wss://127.0.0.1:41088";
const DEFAULT_SOFTPHONE_NAME = "Telnyx Contact Center";
const WEBSOCKET_OPEN = 1;

function baseMessage(event, callId = null) {
  const message = { Event: event, EventType: "Request" };
  if (callId) message.CallID = callId;
  return message;
}

function getDeviceId(payload = {}, connectionState = "connected") {
  const productName = payload.ProductName || payload.HeadsetType || payload.DeviceName || payload.HeadsetName || payload.Model || null;
  const id = payload.HeadsetPath || payload.SerialNumber || payload.ProductId || payload.ProductID || productName || connectionState;
  return id ? String(id) : null;
}

function toDevice(payload = {}, connectionState = "connected") {
  const model = payload.DeviceName || payload.HeadsetName || payload.HeadsetType || payload.ProductName || payload.Model || null;
  const productName = payload.ProductName || payload.HeadsetType || model;
  return {
    id: getDeviceId(payload, connectionState),
    vendor: "epos",
    vendorLabel: "EPOS/Sennheiser",
    model,
    productName,
    serialNumber: payload.SerialNumber || null,
    productId: payload.ProductId || payload.ProductID || null,
    transport: "epos-websocket",
    connectionState,
    battery: payload.BatteryLevel || payload.Battery ? { levelPercent: Number(payload.BatteryLevel || payload.Battery), charging: null, source: "sdk" } : null,
    capabilities: {
      answer: true,
      reject: true,
      hangup: true,
      mute: true,
      hold: true,
      ring: true,
      battery: Boolean(payload.BatteryLevel || payload.Battery),
      donDoff: false,
      busylight: true,
    },
  };
}

function hasDeviceIdentity(payload = {}) {
  return Boolean(
    payload.HeadsetPath
      || payload.SerialNumber
      || payload.ProductName
      || payload.ProductId
      || payload.ProductID
      || payload.HeadsetType
      || payload.DeviceName
      || payload.HeadsetName
      || payload.Model
  );
}

function deviceMatchesIdentifier(device, identifier) {
  if (!device || !identifier) return false;
  const normalizedIdentifier = String(identifier);
  return [device.id, device.serialNumber, device.productId]
    .filter(Boolean)
    .some((value) => String(value) === normalizedIdentifier);
}

function isAcknowledgement(payload = {}) {
  return String(payload.EventType || "").toLowerCase() === "acknowledgement";
}

function isNotification(payload = {}) {
  return String(payload.EventType || "").toLowerCase() === "notification";
}

function formatSoftphoneName(name) {
  return String(name || DEFAULT_SOFTPHONE_NAME).startsWith("Softphone::")
    ? String(name || DEFAULT_SOFTPHONE_NAME)
    : `Softphone::${name || DEFAULT_SOFTPHONE_NAME}`;
}

export function createEposAdapter({
  WebSocketImpl = globalThis.WebSocket,
  url = process.env.NEXT_PUBLIC_EPOS_SDK_WS_URL || DEFAULT_EP0S_URL,
  softphoneName = process.env.NEXT_PUBLIC_EPOS_SOFTPHONE_NAME || DEFAULT_SOFTPHONE_NAME,
  reconnectDelayMs = 2000,
  disconnectConfirmationMs = 1200,
} = {}) {
  const commandSubscribers = new Set();
  const deviceSubscribers = new Set();
  const diagnosticSubscribers = new Set();
  let socket = null;
  let reconnectTimer = null;
  let disconnectTimer = null;
  let serviceDevice = null;
  let currentDevice = null;
  let previousState = normalizeSoftphoneState();
  let pendingSoftphoneState = null;
  let softphoneRegistered = false;
  let initialized = false;
  let disposed = false;

  const emitCommand = (command) => {
    for (const subscriber of commandSubscribers) subscriber(command);
  };

  const emitDevice = (device) => {
    for (const subscriber of deviceSubscribers) subscriber(device);
  };

  const emitCurrentDevice = () => emitDevice(currentDevice || serviceDevice || null);

  const emitDiagnostic = (message, level = "info", payload = null) => {
    const diagnostic = { message, level };
    if (payload) diagnostic.payload = payload;
    for (const subscriber of diagnosticSubscribers) subscriber(diagnostic);
  };

  const clearDisconnectTimer = () => {
    if (disconnectTimer) {
      clearTimeout(disconnectTimer);
      disconnectTimer = null;
    }
  };

  const isSocketOpen = () => socket?.readyState === WEBSOCKET_OPEN;

  const send = (message) => {
    if (!isSocketOpen() || typeof socket.send !== "function") return false;
    socket.send(JSON.stringify(message));
    return true;
  };

  const handleMessage = (event) => {
    let payload = null;
    try {
      payload = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
    } catch (_) {
      return;
    }
    if (!payload?.Event) return;

    const eventName = String(payload.Event);
    emitDiagnostic(`EPOS ${eventName}${payload.EventType ? ` (${payload.EventType})` : ""}`, "info", payload);

    if (/SocketConnected/i.test(eventName)) {
      serviceDevice = toDevice({ ProductName: "EPOS Connect" }, "service-connected");
      emitCurrentDevice();
      sendRegistration();
      return;
    }

    if (/EstablishConnection/i.test(eventName) && isAcknowledgement(payload)) {
      send(baseMessage("SPLoggedIn"));
      return;
    }

    if (/SPLoggedIn/i.test(eventName) && isAcknowledgement(payload)) {
      softphoneRegistered = true;
      flushPendingSoftphoneState();
      return;
    }

    if (/HeadsetConnected|DeviceConnected/i.test(eventName) && isNotification(payload)) {
      if (!hasDeviceIdentity(payload)) return;
      clearDisconnectTimer();
      const wasConnected = Boolean(currentDevice);
      currentDevice = toDevice(payload, "connected");
      emitCurrentDevice();
      if (!wasConnected) send(baseMessage("ActiveDeviceChanged"));
      return;
    }

    if (/ActiveDeviceChanged/i.test(eventName)) {
      if (isNotification(payload) && hasDeviceIdentity(payload)) {
        clearDisconnectTimer();
        currentDevice = toDevice(payload, "connected");
        emitCurrentDevice();
      }
      return;
    }

    if (/HeadsetDisconnected|DeviceDisconnected/i.test(eventName) && isNotification(payload)) {
      const disconnectedDeviceId = getDeviceId(payload, null);
      if (currentDevice && disconnectedDeviceId && !deviceMatchesIdentifier(currentDevice, disconnectedDeviceId)) {
        return;
      }
      clearDisconnectTimer();
      emitDiagnostic(`EPOS ${eventName}: confirming active device`, "warn", payload);
      send(baseMessage("ActiveDeviceChanged"));
      disconnectTimer = setTimeout(() => {
        currentDevice = null;
        emitCurrentDevice();
      }, disconnectConfirmationMs);
      return;
    }

    if (/InCallAccepted|DNDIncomingCallAccepted|OffHook|InCallAcceptedOnOffhook/i.test(eventName) && payload.EventType !== "Request") {
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

  const emitServiceMissing = () => {
    serviceDevice = {
      id: "epos-service-missing",
      vendor: "epos",
      vendorLabel: "EPOS/Sennheiser",
      model: null,
      productName: "EPOS Connect",
      transport: "epos-websocket",
      connectionState: "service-missing",
      capabilities: {},
    };
    currentDevice = null;
    emitCurrentDevice();
  };

  const scheduleReconnect = () => {
    if (disposed || !reconnectDelayMs || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelayMs);
  };

  const sendRegistration = () => {
    softphoneRegistered = false;
    send({
      Event: "EstablishConnection",
      EventType: "Request",
      SPName: formatSoftphoneName(softphoneName),
      SPIconImage: "telnyx-contact-center.ico",
      RedialSupport: "Yes",
      OffHookSupport: "Yes",
      MuteSupport: "Yes",
      AudioDeviceChangesSupport: "Yes",
      DNDOption: "Yes",
    });
  };

  const flushPendingSoftphoneState = () => {
    if (!softphoneRegistered || !pendingSoftphoneState) return;
    const next = pendingSoftphoneState;
    pendingSoftphoneState = null;
    void applySoftphoneState(next);
  };

  const applySoftphoneState = async (next) => {
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
  };

  const connect = () => {
    if (disposed || !WebSocketImpl) {
      emitServiceMissing();
      return;
    }
    try {
      socket = new WebSocketImpl(url);
      socket.onmessage = handleMessage;
      socket.onopen = () => {
        serviceDevice = toDevice({ ProductName: "EPOS Connect" }, "service-connected");
        emitDiagnostic("EPOS websocket connected", "info");
        emitCurrentDevice();
      };
      socket.onerror = () => {
        emitDiagnostic("EPOS websocket error", "warn");
        emitServiceMissing();
        softphoneRegistered = false;
        scheduleReconnect();
      };
      socket.onclose = () => {
        if (!disposed) {
          emitDiagnostic("EPOS websocket closed", "warn");
          emitServiceMissing();
          softphoneRegistered = false;
          scheduleReconnect();
        }
      };
    } catch (_) {
      emitServiceMissing();
      scheduleReconnect();
    }
  };

  return {
    vendor: "epos",

    async init() {
      if (initialized) return;
      initialized = true;
      disposed = false;
      if (!WebSocketImpl) {
        emitServiceMissing();
        return;
      }
      connect();
    },

    onCommand(callback) {
      commandSubscribers.add(callback);
      return () => commandSubscribers.delete(callback);
    },

    onDeviceChange(callback) {
      deviceSubscribers.add(callback);
      return () => deviceSubscribers.delete(callback);
    },

    onDiagnostic(callback) {
      diagnosticSubscribers.add(callback);
      return () => diagnosticSubscribers.delete(callback);
    },

    async setSoftphoneState(state) {
      const next = normalizeSoftphoneState(state);
      if (!isSocketOpen() || !softphoneRegistered) {
        pendingSoftphoneState = next;
        return;
      }
      await applySoftphoneState(next);
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
      disposed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      clearDisconnectTimer();
      try {
        send(baseMessage("SPLoggedOut"));
        send(baseMessage("TerminateConnection"));
        socket?.close?.();
      } catch (_) {}
      socket = null;
      initialized = false;
      serviceDevice = null;
      currentDevice = null;
      pendingSoftphoneState = null;
      softphoneRegistered = false;
      previousState = normalizeSoftphoneState();
    },
  };
}
