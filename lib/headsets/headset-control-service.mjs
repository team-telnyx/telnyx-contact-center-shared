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

export function createHeadsetControlService({
  adapters = [],
  now = () => Date.now(),
  debounceMs = 350,
} = {}) {
  const commandSubscribers = new Set();
  const deviceSubscribers = new Set();
  const disposers = [];
  let initialized = false;
  let lastCommandKey = null;
  let lastCommandAt = 0;
  let activeDevice = null;

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

  const emitDevice = (adapter, device) => {
    activeDevice = device ? { ...device, vendor: device.vendor || adapter.vendor } : null;
    for (const subscriber of deviceSubscribers) {
      subscriber(activeDevice);
    }
  };

  return {
    async init() {
      if (initialized) return;
      initialized = true;
      for (const adapter of adapters) {
        if (typeof adapter.onCommand === "function") {
          disposers.push(adapter.onCommand((command) => emitCommand(adapter, command)));
        }
        if (typeof adapter.onDeviceChange === "function") {
          disposers.push(adapter.onDeviceChange((device) => emitDevice(adapter, device)));
        }
        if (typeof adapter.init === "function") {
          await adapter.init();
        }
      }
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
      for (const adapter of adapters) {
        if (typeof adapter.setSoftphoneState === "function") {
          await adapter.setSoftphoneState(normalized);
        }
      }
      return normalized;
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
