export const HEADSET_COMMANDS = Object.freeze({
  ANSWER: "answer",
  REJECT: "reject",
  HANGUP: "hangup",
  MUTE: "mute",
  HOLD: "hold",
  DEVICE_CHANGED: "deviceChanged",
  BATTERY_CHANGED: "batteryChanged",
  SWAP: "swap",
});

export function normalizeSoftphoneState(input = {}) {
  const normalizeString = (value) => {
    if (value === null || value === undefined || value === "") return null;
    const trimmed = String(value).trim();
    return trimmed || null;
  };

  const direction = ["incoming", "outgoing"].includes(input.direction)
    ? input.direction
    : null;

  return {
    callId: normalizeString(input.callId),
    direction,
    ringing: Boolean(input.ringing),
    active: Boolean(input.active),
    muted: Boolean(input.muted),
    held: Boolean(input.held),
    remoteDisplayName: normalizeString(input.remoteDisplayName),
    remoteNumber: normalizeString(input.remoteNumber),
  };
}

function commandKey(command = {}) {
  return JSON.stringify({
    type: command.type || null,
    muted: command.muted ?? null,
    held: command.held ?? null,
    source: command.source || null,
  });
}

function isConnectedDevice(device) {
  return device?.connectionState === "connected";
}

function isServiceStatusDevice(device) {
  return typeof device?.connectionState === "string" && device.connectionState.startsWith("service-");
}

export function createHeadsetControlService({
  adapters = [],
  now = () => Date.now(),
  debounceMs = 350,
} = {}) {
  const commandSubscribers = new Set();
  const deviceSubscribers = new Set();
  const diagnosticSubscribers = new Set();
  const disposers = [];
  let initialized = false;
  let subscriptionsInitialized = false;
  const initializedAdapters = new Set();
  let lastCommandKey = null;
  let lastCommandAt = 0;
  let activeDevice = null;
  const devicesByVendor = new Map();
  let stateUpdateChain = Promise.resolve();
  let latestSoftphoneState = normalizeSoftphoneState();

  const emitCommand = (adapter, command) => {
    if (!command?.type) return;
    const stamped = { ...command, vendor: command.vendor || adapter.vendor };
    const key = commandKey(stamped);
    const timestamp = now();
    if (key === lastCommandKey && timestamp - lastCommandAt < debounceMs) return;
    lastCommandKey = key;
    lastCommandAt = timestamp;
    for (const subscriber of commandSubscribers) {
      subscriber(stamped);
    }
  };

  const selectActiveDevice = () => {
    const devices = Array.from(devicesByVendor.values());
    return devices.findLast(isConnectedDevice) || devices.findLast(isServiceStatusDevice) || devices.findLast(Boolean) || null;
  };

  const emitDevice = (adapter, device) => {
    if (!device) {
      devicesByVendor.delete(adapter.vendor);
    } else {
      devicesByVendor.set(adapter.vendor, { ...device, vendor: device.vendor || adapter.vendor });
    }
    activeDevice = selectActiveDevice();
    for (const subscriber of deviceSubscribers) {
      subscriber(activeDevice);
    }
  };

  const emitDiagnostic = (adapter, diagnostic) => {
    if (!diagnostic) return;
    const stamped = typeof diagnostic === "string"
      ? { message: diagnostic, level: "info", vendor: adapter.vendor }
      : { ...diagnostic, vendor: diagnostic.vendor || adapter.vendor };
    for (const subscriber of diagnosticSubscribers) {
      subscriber(stamped);
    }
  };

  return {
    async init() {
      if (initialized) return;
      let hasInitFailure = false;
      for (const adapter of adapters) {
        if (!subscriptionsInitialized && typeof adapter.onCommand === "function") {
          disposers.push(adapter.onCommand((command) => emitCommand(adapter, command)));
        }
        if (!subscriptionsInitialized && typeof adapter.onDeviceChange === "function") {
          disposers.push(adapter.onDeviceChange((device) => emitDevice(adapter, device)));
        }
        if (!subscriptionsInitialized && typeof adapter.onDiagnostic === "function") {
          disposers.push(adapter.onDiagnostic((diagnostic) => emitDiagnostic(adapter, diagnostic)));
        }
        if (typeof adapter.init === "function" && !initializedAdapters.has(adapter)) {
          try {
            await adapter.init();
            initializedAdapters.add(adapter);
          } catch (error) {
            hasInitFailure = true;
            console.warn(`Headset adapter ${adapter.vendor || "unknown"} failed to initialize`, error);
            emitDiagnostic(adapter, {
              message: `${adapter.vendor || "Headset"} adapter failed to initialize`,
              level: "error",
              payload: { message: error?.message || String(error) },
            });
          }
        }
      }
      subscriptionsInitialized = true;
      initialized = !hasInitFailure;
    },

    async dispose() {
      while (disposers.length) {
        const dispose = disposers.pop();
        try {
          dispose?.();
        } catch (_) {}
      }
      for (const adapter of adapters) {
        try {
          await adapter.dispose?.();
        } catch (_) {}
      }
      initialized = false;
      subscriptionsInitialized = false;
      initializedAdapters.clear();
      devicesByVendor.clear();
      activeDevice = null;
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
      return activeDevice;
    },

    async requestPermission(vendor) {
      const targets = vendor
        ? adapters.filter((adapter) => adapter.vendor === vendor)
        : adapters;
      for (const adapter of targets) {
        if (typeof adapter.requestPermission === "function") {
          await adapter.requestPermission();
        }
      }
    },

    async setSoftphoneState(state) {
      const normalized = normalizeSoftphoneState(state);
      latestSoftphoneState = normalized;
      stateUpdateChain = stateUpdateChain.catch(() => {}).then(async () => {
        for (const adapter of adapters) {
          if (typeof adapter.setSoftphoneState !== "function") continue;
          try {
            await adapter.setSoftphoneState(normalized);
          } catch (error) {
            emitDiagnostic(adapter, {
              message: `${adapter.vendor || "Headset"} state synchronization failed`,
              level: "error",
              payload: { message: error?.message || String(error), state: normalized },
            });
          }
        }
      });
      await stateUpdateChain;
      return normalized;
    },

    getSoftphoneState() {
      return latestSoftphoneState;
    },

    async sendTestCommand(command) {
      for (const adapter of adapters) {
        if (typeof adapter.sendTestCommand === "function") {
          await adapter.sendTestCommand(command);
        }
      }
    },
  };
}
