import { HEADSET_COMMANDS, normalizeSoftphoneState } from "../headset-control-service.mjs";
import { findHeadsetCatalogEntry } from "../headset-device-catalog.js";

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
  const productId = payload.ProductId || payload.ProductID || null;
  const source = payload.Source || "epos-websocket";
  const baseDevice = {
    id: getDeviceId(payload, connectionState),
    vendor: "epos",
    vendorLabel: "EPOS/Sennheiser",
    model,
    productName,
    serialNumber: payload.SerialNumber || null,
    productId,
    transport: source,
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
  const catalogEntry = findHeadsetCatalogEntry(baseDevice);
  const physicalState = catalogEntry?.role === "dongle" ? "service-connected" : connectionState;
  return {
    ...baseDevice,
    deviceRole: catalogEntry?.role || null,
    connectionState: physicalState,
    capabilities: {
      ...baseDevice.capabilities,
      audio: catalogEntry?.role !== "dongle",
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
  const hasStrongerIdentifier = Boolean(
    device.serialNumber
      || (device.id && (!device.productId || String(device.id) !== String(device.productId)))
  );
  const identifiers = [device.id, device.serialNumber];
  if (!hasStrongerIdentifier) identifiers.push(device.productId);
  return identifiers
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

function isEposMediaDevice(device = {}) {
  const label = String(device.label || "").toLowerCase();
  return /epos|sennheiser/.test(label);
}

function mediaDeviceToPayload(device = {}) {
  const label = String(device.label || "").trim();
  return {
    DeviceName: label,
    HeadsetName: label,
    HeadsetType: label,
    HeadsetPath: device.deviceId || label,
    Source: "browser-media-device",
  };
}

export function createEposAdapter({
  WebSocketImpl = globalThis.WebSocket,
  url = process.env.NEXT_PUBLIC_EPOS_SDK_WS_URL || DEFAULT_EP0S_URL,
  softphoneName = process.env.NEXT_PUBLIC_EPOS_SOFTPHONE_NAME || DEFAULT_SOFTPHONE_NAME,
  reconnectDelayMs = 2000,
  disconnectConfirmationMs = 1200,
  mediaDevicePollMs = 2000,
  transientDisconnectGraceMs = 5000,
  mediaDevices = globalThis.navigator?.mediaDevices,
  now = () => Date.now(),
  logger = console,
} = {}) {
  const commandSubscribers = new Set();
  const deviceSubscribers = new Set();
  const diagnosticSubscribers = new Set();
  let socket = null;
  let reconnectTimer = null;
  let disconnectTimer = null;
  let mediaDevicePollTimer = null;
  let serviceDevice = null;
  let currentDevice = null;
  let currentDeviceConnectedAt = 0;
  let previousState = normalizeSoftphoneState();
  let pendingSoftphoneState = null;
  let softphoneRegistered = false;
  let initialized = false;
  let disposed = false;
  const handleMediaDeviceChange = () => {
    emitDiagnostic("Browser media-device change detected", "info");
    requestActiveDevice("browser-devicechange");
    void reconcileBrowserMediaDevices("browser-devicechange");
  };

  const emitCommand = (command) => {
    logger?.info?.("[Headset][EPOS] command from headset", command);
    for (const subscriber of commandSubscribers) subscriber(command);
  };

  const emitDevice = (device) => {
    logger?.info?.("[Headset][EPOS] device state", device);
    for (const subscriber of deviceSubscribers) subscriber(device);
  };

  const emitCurrentDevice = () => emitDevice(currentDevice || serviceDevice || null);

  const emitDiagnostic = (message, level = "info", payload = null) => {
    const diagnostic = { message, level };
    if (payload) diagnostic.payload = payload;
    const logMethod = level === "error" ? "error" : level === "warn" ? "warn" : "debug";
    logger?.[logMethod]?.(`[Headset][EPOS] ${message}`, payload || "");
    for (const subscriber of diagnosticSubscribers) subscriber(diagnostic);
  };

  const clearDisconnectTimer = () => {
    if (disconnectTimer) {
      clearTimeout(disconnectTimer);
      disconnectTimer = null;
    }
  };

  const scheduleDisconnectConfirmation = (delayMs = disconnectConfirmationMs) => {
    clearDisconnectTimer();
    disconnectTimer = setTimeout(() => {
      disconnectTimer = null;
      currentDevice = null;
      emitCurrentDevice();
    }, delayMs);
    disconnectTimer.unref?.();
  };

  const clearMediaDevicePollTimer = () => {
    if (mediaDevicePollTimer) {
      clearTimeout(mediaDevicePollTimer);
      mediaDevicePollTimer = null;
    }
  };

  const markCurrentDevice = (payload, connectionState = "connected") => {
    clearDisconnectTimer();
    currentDevice = toDevice(payload, connectionState);
    currentDeviceConnectedAt = now();
    emitCurrentDevice();
  };

  const requestActiveDevice = (reason) => {
    if (reason) emitDiagnostic(`EPOS ActiveDeviceChanged requested: ${reason}`, "info");
    send(baseMessage("ActiveDeviceChanged"));
  };

  const reconcileBrowserMediaDevices = async (reason = "manual") => {
    if (!mediaDevices?.enumerateDevices) return;
    try {
      const devices = await mediaDevices.enumerateDevices();
      const audioDevices = devices.filter((device) => device.kind === "audioinput" || device.kind === "audiooutput");
      const labeledAudioDevices = audioDevices.filter((device) => String(device.label || "").trim());
      const eposDevice = labeledAudioDevices.find(isEposMediaDevice);
      emitDiagnostic(
        `Browser media-device scan (${reason}): ${eposDevice ? eposDevice.label : "no EPOS/Sennheiser audio device"}`,
        eposDevice ? "info" : "warn",
        { reason, audioDeviceLabels: labeledAudioDevices.map((device) => device.label) }
      );
      if (eposDevice) {
        markCurrentDevice(mediaDeviceToPayload(eposDevice), "connected");
      } else if (labeledAudioDevices.length && currentDevice?.transport === "browser-media-device") {
        currentDevice = null;
        emitCurrentDevice();
      }
    } catch (error) {
      emitDiagnostic("Browser media-device scan failed", "warn", { reason, message: error?.message || String(error) });
    }
  };

  const scheduleMediaDevicePoll = () => {
    if (disposed || !mediaDevicePollMs || mediaDevicePollTimer) return;
    mediaDevicePollTimer = setTimeout(async () => {
      mediaDevicePollTimer = null;
      requestActiveDevice("poll");
      await reconcileBrowserMediaDevices("poll");
      scheduleMediaDevicePoll();
    }, mediaDevicePollMs);
    mediaDevicePollTimer.unref?.();
  };

  const isSocketOpen = () => socket?.readyState === WEBSOCKET_OPEN;

  const send = (message) => {
    if (!isSocketOpen() || typeof socket.send !== "function") {
      logger?.warn?.("[Headset][EPOS] dropped outgoing message because websocket is not open", message);
      return false;
    }
    logger?.debug?.("[Headset][EPOS] outgoing", message);
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
      send(baseMessage("SystemInformation"));
      requestActiveDevice("login");
      void reconcileBrowserMediaDevices("login");
      scheduleMediaDevicePoll();
      flushPendingSoftphoneState();
      return;
    }

    if (/HeadsetConnected|DeviceConnected/i.test(eventName) && isNotification(payload)) {
      if (!hasDeviceIdentity(payload)) return;
      clearDisconnectTimer();
      const wasConnected = Boolean(currentDevice);
      markCurrentDevice(payload, "connected");
      if (!wasConnected) requestActiveDevice("headset-connected");
      return;
    }

    if (/ActiveDeviceChanged/i.test(eventName)) {
      if (isNotification(payload) && hasDeviceIdentity(payload)) {
        markCurrentDevice(payload, "connected");
      }
      return;
    }

    if (/HeadsetDisconnected|DeviceDisconnected/i.test(eventName) && isNotification(payload)) {
      const disconnectedDeviceId = getDeviceId(payload, null);
      if (currentDevice && disconnectedDeviceId && !deviceMatchesIdentifier(currentDevice, disconnectedDeviceId)) {
        return;
      }
      requestActiveDevice("headset-disconnected");
      void reconcileBrowserMediaDevices("headset-disconnected");
      if (currentDevice && !disconnectedDeviceId) {
        emitDiagnostic(`EPOS ${eventName}: notification had no device identity; keeping current device until EPOS reports an identified disconnect`, "warn", payload);
        return;
      }
      clearDisconnectTimer();
      if (currentDevice && now() - currentDeviceConnectedAt < transientDisconnectGraceMs) {
        const remainingGraceMs = Math.max(transientDisconnectGraceMs - (now() - currentDeviceConnectedAt), 0);
        emitDiagnostic(`EPOS ${eventName}: deferring transient disconnect confirmation until grace window expires`, "warn", payload);
        scheduleDisconnectConfirmation(remainingGraceMs + disconnectConfirmationMs);
        return;
      }
      emitDiagnostic(`EPOS ${eventName}: confirming active device`, "warn", payload);
      scheduleDisconnectConfirmation();
      return;
    }

    if (/InCallAccepted|DNDIncomingCallAccepted|OffHook|InCallAcceptedOnOffhook/i.test(eventName) && isNotification(payload)) {
      emitCommand({ type: HEADSET_COMMANDS.ANSWER, source: "headset" });
    } else if (/InCallRejected/i.test(eventName) && isNotification(payload)) {
      emitCommand({ type: HEADSET_COMMANDS.REJECT, source: "headset" });
    } else if (/CallEnded|OnHook/i.test(eventName) && isNotification(payload)) {
      emitCommand({ type: HEADSET_COMMANDS.HANGUP, source: "headset" });
    } else if (/UnmuteSoftphone/i.test(eventName) && isNotification(payload)) {
      emitCommand({ type: HEADSET_COMMANDS.MUTE, muted: false, source: "headset" });
    } else if (/MuteSoftphone/i.test(eventName) && isNotification(payload)) {
      emitCommand({ type: HEADSET_COMMANDS.MUTE, muted: true, source: "headset" });
    } else if (/UnmuteHeadset/i.test(eventName) && isNotification(payload)) {
      emitCommand({ type: HEADSET_COMMANDS.MUTE, muted: false, source: "headset" });
    } else if (/MuteHeadset/i.test(eventName) && isNotification(payload)) {
      emitCommand({ type: HEADSET_COMMANDS.MUTE, muted: true, source: "headset" });
    } else if (/CallHold|ConfCallOnHold/i.test(eventName) && isNotification(payload)) {
      emitCommand({ type: HEADSET_COMMANDS.HOLD, held: true, source: "headset" });
    } else if (/HeldCallResumed|HeldConfCallResumed/i.test(eventName) && isNotification(payload)) {
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
      mediaDevices?.addEventListener?.("devicechange", handleMediaDeviceChange);
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
      clearMediaDevicePollTimer();
      mediaDevices?.removeEventListener?.("devicechange", handleMediaDeviceChange);
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
      currentDeviceConnectedAt = 0;
      pendingSoftphoneState = null;
      softphoneRegistered = false;
      previousState = normalizeSoftphoneState();
    },
  };
}
