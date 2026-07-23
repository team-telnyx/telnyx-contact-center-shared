import { HEADSET_COMMANDS, normalizeSoftphoneState } from "../headset-control-service.mjs";

const DEFAULT_INCOMING_RING_TIMEOUT_MS = 60000;
const DEFAULT_APP_ID = "telnyx-contact-center";
const DEFAULT_APP_NAME = "Telnyx Contact Center";

function subscriptionDisposer(subscription) {
  return () => {
    try {
      subscription?.unsubscribe?.();
    } catch (_) {}
  };
}

function createObservableAdapter(observable, handler) {
  if (!observable || typeof observable.subscribe !== "function") return () => {};
  const subscription = observable.subscribe(handler);
  return subscriptionDisposer(subscription);
}

function toDevice(device, transportContext) {
  if (!device) return null;
  return {
    id: String(device.serialNumber || device.productId || device.name || "jabra-device"),
    vendor: "jabra",
    vendorLabel: "Jabra",
    model: device.name || null,
    serialNumber: device.serialNumber || null,
    productId: device.productId ?? null,
    transport: transportContext === "chrome-extension" ? "jabra-extension" : "jabra-webhid",
    connectionState: "connected",
    battery: null,
    capabilities: {
      answer: true,
      reject: true,
      hangup: true,
      mute: true,
      hold: true,
      ring: true,
      battery: false,
      donDoff: false,
      busylight: false,
    },
  };
}

export async function loadJabraSdk() {
  return import("@gnaudio/jabra-js");
}

export function createJabraAdapter({
  jabra = null,
  loadSdk = loadJabraSdk,
  partnerKey = process.env.NEXT_PUBLIC_JABRA_PARTNER_KEY || "",
  appId = process.env.NEXT_PUBLIC_JABRA_APP_ID || DEFAULT_APP_ID,
  appName = process.env.NEXT_PUBLIC_JABRA_APP_NAME || DEFAULT_APP_NAME,
  incomingRingTimeoutMs = DEFAULT_INCOMING_RING_TIMEOUT_MS,
  logger = null,
} = {}) {
  const commandSubscribers = new Set();
  const deviceSubscribers = new Set();
  const diagnosticSubscribers = new Set();
  const disposers = [];
  const controlDisposers = [];
  let api = null;
  let sdk = jabra;
  let easyCallControl = null;
  let currentDevice = null;
  let desiredState = normalizeSoftphoneState();
  let appliedState = normalizeSoftphoneState();
  let incomingResolutionSource = null;
  let lastOngoingCalls = 0;
  let suppressDeviceHangupUntil = 0;

  const emitCommand = (command) => {
    for (const subscriber of commandSubscribers) subscriber(command);
  };

  const emitDevice = (device) => {
    for (const subscriber of deviceSubscribers) subscriber(device);
  };

  const emitDiagnostic = (message, level = "info", payload = null) => {
    const diagnostic = { message, level, ...(payload ? { payload } : {}) };
    for (const subscriber of diagnosticSubscribers) subscriber(diagnostic);
  };

  const isMutedState = (value) => value === sdk?.MuteState?.MUTED || String(value).toLowerCase() === "muted";
  const isHeldState = (value) => value === sdk?.HoldState?.ON_HOLD || String(value).toLowerCase() === "on-hold";

  const clearControlSubscriptions = () => {
    while (controlDisposers.length) controlDisposers.pop()?.();
  };

  const emitIncomingCallResult = (accepted) => {
    const resolutionSource = incomingResolutionSource;
    incomingResolutionSource = null;
    if (resolutionSource === "softphone") return;
    if (accepted === true) {
      appliedState = normalizeSoftphoneState({ ...appliedState, ringing: false, active: true });
      emitCommand({ type: HEADSET_COMMANDS.ANSWER, source: "headset" });
    } else if (accepted === false) {
      appliedState = normalizeSoftphoneState({ ...appliedState, ringing: false, active: false });
      emitCommand({ type: HEADSET_COMMANDS.REJECT, source: "headset" });
    }
  };

  const attachEasyCallControl = async (device) => {
    if (!sdk?.EasyCallControlFactory || !api) return;
    const factory = new sdk.EasyCallControlFactory(api);
    if (!factory.supportsEasyCallControl?.(device)) {
      currentDevice = {
        ...currentDevice,
        connectionState: "unsupported",
        capabilities: {},
      };
      emitDevice(currentDevice);
      emitDiagnostic("Connected Jabra device does not support Easy Call Control", "warn");
      return;
    }
    clearControlSubscriptions();
    easyCallControl?.teardown?.();
    easyCallControl = await factory.createMultiCallControl(device);

    controlDisposers.push(createObservableAdapter(easyCallControl.muteState, (muteState) => {
      const normalized = String(muteState).toLowerCase();
      if (normalized === "no-ongoing-calls") return;
      emitCommand({ type: HEADSET_COMMANDS.MUTE, muted: isMutedState(muteState), source: "headset" });
    }));
    controlDisposers.push(createObservableAdapter(easyCallControl.holdState, (holdState) => {
      const normalized = String(holdState).toLowerCase();
      if (normalized === "no-ongoing-calls") return;
      emitCommand({ type: HEADSET_COMMANDS.HOLD, held: isHeldState(holdState), source: "headset" });
    }));
    controlDisposers.push(createObservableAdapter(easyCallControl.swapRequest, () => {
      emitCommand({ type: HEADSET_COMMANDS.SWAP, source: "headset" });
    }));
    controlDisposers.push(createObservableAdapter(easyCallControl.ongoingCalls, (count) => {
      const nextCount = Number(count) || 0;
      if (
        lastOngoingCalls > 0
        && nextCount === 0
        && desiredState.active
        && Date.now() >= suppressDeviceHangupUntil
      ) {
        emitCommand({ type: HEADSET_COMMANDS.HANGUP, source: "headset" });
      }
      lastOngoingCalls = nextCount;
    }));

    appliedState = normalizeSoftphoneState();
    await applySoftphoneState(desiredState);
  };

  const applySoftphoneState = async (next) => {
    if (!easyCallControl) return;
    const previous = appliedState;

    try {
      if (next.ringing && !previous.ringing) {
        incomingResolutionSource = null;
        const result = easyCallControl.signalIncomingCall?.(incomingRingTimeoutMs);
        if (result && typeof result.then === "function") {
          result.then(emitIncomingCallResult).catch((error) => {
            emitDiagnostic("Jabra incoming-call signalling failed", "error", { message: error?.message || String(error) });
          });
        } else {
          emitIncomingCallResult(result);
        }
      }

      if (next.active && !previous.active) {
        if (previous.ringing) {
          incomingResolutionSource = "softphone";
          await easyCallControl.acceptIncomingCall?.();
        } else {
          await easyCallControl.startCall?.();
        }
      } else if (!next.ringing && previous.ringing && !next.active) {
        incomingResolutionSource = "softphone";
        await easyCallControl.rejectIncomingCall?.();
      } else if (!next.active && previous.active) {
        suppressDeviceHangupUntil = Date.now() + 1000;
        await easyCallControl.endCall?.();
      }

      if (next.active && next.muted !== previous.muted) {
        if (next.muted) await easyCallControl.mute?.();
        else await easyCallControl.unmute?.();
      }
      if (next.active && next.held !== previous.held) {
        if (next.held) await easyCallControl.hold?.();
        else await easyCallControl.resume?.();
      }
      appliedState = next;
    } catch (error) {
      emitDiagnostic("Jabra call-control synchronization failed", "error", {
        message: error?.message || String(error),
        previous,
        next,
      });
      throw error;
    }
  };

  const handleDeviceAdded = (device) => {
    currentDevice = toDevice(device, api?.transportContext);
    emitDevice(currentDevice);
    void attachEasyCallControl(device).catch((error) => {
      emitDiagnostic("Unable to attach Jabra Easy Call Control", "error", {
        message: error?.message || String(error),
      });
    });
  };

  return {
    vendor: "jabra",

    async init() {
      sdk = sdk || await loadSdk();
      const RequestedBrowserTransport = sdk.RequestedBrowserTransport || {};
      const config = {
        partnerKey,
        transport: RequestedBrowserTransport.CHROME_EXTENSION_WITH_WEB_HID_FALLBACK,
        appId,
        appName,
      };
      if (logger) config.logger = logger;

      api = typeof sdk.createApi === "function"
        ? await sdk.createApi(config)
        : await sdk.init(config);

      if (!api) {
        currentDevice = {
          id: "jabra-unavailable",
          vendor: "jabra",
          vendorLabel: "Jabra",
          model: null,
          transport: "jabra-js-sdk",
          connectionState: "error",
          capabilities: {},
        };
        emitDevice(currentDevice);
        return;
      }

      disposers.push(createObservableAdapter(api.deviceAdded, handleDeviceAdded));
      disposers.push(createObservableAdapter(api.deviceRemoved, () => {
        clearControlSubscriptions();
        easyCallControl?.teardown?.();
        currentDevice = null;
        easyCallControl = null;
        appliedState = normalizeSoftphoneState();
        lastOngoingCalls = 0;
        emitDevice(null);
      }));

      if (typeof api.start === "function") {
        await api.start();
      }
    },

    async requestPermission() {
      sdk = sdk || await loadSdk();
      if (typeof sdk.webHidPairing === "function") {
        await sdk.webHidPairing();
      }
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

    getDevice() {
      return currentDevice;
    },

    async setSoftphoneState(state) {
      const next = normalizeSoftphoneState(state);
      desiredState = next;
      if (!easyCallControl) {
        return;
      }
      await applySoftphoneState(next);
    },

    async sendTestCommand(command) {
      if (!easyCallControl) return;
      if (command === "ring") await easyCallControl.signalIncomingCall?.(5000);
      if (command === "muteOn") await easyCallControl.mute?.();
      if (command === "muteOff") await easyCallControl.unmute?.();
      if (command === "holdOn") await easyCallControl.hold?.();
      if (command === "holdOff") await easyCallControl.resume?.();
      if (command === "reset") await easyCallControl.endCall?.();
    },

    async dispose() {
      clearControlSubscriptions();
      while (disposers.length) disposers.pop()?.();
      easyCallControl?.teardown?.();
      easyCallControl = null;
      currentDevice = null;
      desiredState = normalizeSoftphoneState();
      appliedState = normalizeSoftphoneState();
      incomingResolutionSource = null;
      lastOngoingCalls = 0;
    },
  };
}
