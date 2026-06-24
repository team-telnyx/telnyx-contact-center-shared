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
  const disposers = [];
  let api = null;
  let sdk = jabra;
  let easyCallControl = null;
  let currentDevice = null;
  let previousState = normalizeSoftphoneState();

  const emitCommand = (command) => {
    for (const subscriber of commandSubscribers) subscriber(command);
  };

  const emitDevice = (device) => {
    for (const subscriber of deviceSubscribers) subscriber(device);
  };

  const attachEasyCallControl = async (device) => {
    if (!sdk?.EasyCallControlFactory || !api) return;
    const factory = new sdk.EasyCallControlFactory(api);
    if (!factory.supportsEasyCallControl?.(device)) return;
    easyCallControl = await factory.createMultiCallControl(device);

    disposers.push(createObservableAdapter(easyCallControl.muteState, (muteState) => {
      emitCommand({ type: HEADSET_COMMANDS.MUTE, muted: Boolean(muteState), source: "headset" });
    }));
    disposers.push(createObservableAdapter(easyCallControl.holdState, (holdState) => {
      emitCommand({ type: HEADSET_COMMANDS.HOLD, held: Boolean(holdState), source: "headset" });
    }));
    disposers.push(createObservableAdapter(easyCallControl.swapRequest, () => {
      emitCommand({ type: HEADSET_COMMANDS.SWAP, source: "headset" });
    }));
  };

  const handleDeviceAdded = async (device) => {
    currentDevice = toDevice(device, api?.transportContext);
    emitDevice(currentDevice);
    await attachEasyCallControl(device);
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
        currentDevice = null;
        easyCallControl = null;
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

    getDevice() {
      return currentDevice;
    },

    async setSoftphoneState(state) {
      const next = normalizeSoftphoneState(state);
      if (!easyCallControl) {
        previousState = next;
        return;
      }

      if (next.ringing && !previousState.ringing) {
        await easyCallControl.signalIncomingCall?.(incomingRingTimeoutMs);
      }
      if (!next.ringing && previousState.ringing && !next.active) {
        await easyCallControl.endCall?.();
      }
      if (next.muted !== previousState.muted) {
        if (typeof easyCallControl.setMute === "function") {
          await easyCallControl.setMute(next.muted);
        } else {
          await easyCallControl.mute?.(next.muted);
        }
      }
      if (next.held !== previousState.held) {
        if (typeof easyCallControl.setHold === "function") {
          await easyCallControl.setHold(next.held);
        } else {
          await easyCallControl.hold?.(next.held);
        }
      }
      previousState = next;
    },

    async sendTestCommand(command) {
      if (!easyCallControl) return;
      if (command === "ring") await easyCallControl.signalIncomingCall?.(5000);
      if (command === "muteOn") await easyCallControl.setMute?.(true);
      if (command === "muteOff") await easyCallControl.setMute?.(false);
      if (command === "holdOn") await easyCallControl.setHold?.(true);
      if (command === "holdOff") await easyCallControl.setHold?.(false);
      if (command === "reset") await easyCallControl.endCall?.();
    },

    async dispose() {
      while (disposers.length) disposers.pop()?.();
      easyCallControl = null;
      currentDevice = null;
      previousState = normalizeSoftphoneState();
    },
  };
}
