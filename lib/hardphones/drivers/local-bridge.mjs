const DEFAULT_RELAY_TIMEOUT_MS = 15000;

function relayBaseUrl() {
  return (process.env.HARDPHONE_BRIDGE_RELAY_URL || `http://127.0.0.1:${process.env.STREAMING_WS_PORT || 3001}`).replace(/\/$/, "");
}

function relayToken() {
  return process.env.HARDPHONE_BRIDGE_ADMIN_TOKEN || process.env.HARDPHONE_BRIDGE_TOKEN || process.env.BRIDGE_TOKEN || "";
}

function phoneHost(phone) {
  return phone?.ip_address || phone?.settings?.ip_address || phone?.last_ip || "";
}

async function sendLocalBridgeCommand(phone, action, payload = {}) {
  const bridge_id = phone.local_bridge_id || phone?.settings?.local_bridge_id || "";
  if (!bridge_id) return { ok: false, reason: "missing_local_bridge_id" };
  const host = phoneHost(phone);
  if (!host) return { ok: false, reason: "missing_phone_ip" };
  const body = {
    bridge_id,
    phone_id: phone?.id || null,
    vendor: String(phone?.vendor || "").toLowerCase(),
    host,
    action,
    payload: {
      ...payload,
      admin_password: phone.admin_password,
    },
    timeoutMs: DEFAULT_RELAY_TIMEOUT_MS,
  };
  const headers = { "content-type": "application/json" };
  const token = relayToken();
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${relayBaseUrl()}/api/hardphone-bridge/command`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return { ok: false, reason: data.error || data.reason || `relay_http_${response.status}`, relay: data };
  return data.result || data;
}

export function createLocalBridgeDriver() {
  return {
    vendor: "local-bridge",
    dial: (phone, number) => sendLocalBridgeCommand(phone, "dial", { number }),
    answer: (phone) => sendLocalBridgeCommand(phone, "answer"),
    hangup: (phone) => sendLocalBridgeCommand(phone, "hangup"),
    hold: (phone) => sendLocalBridgeCommand(phone, "hold"),
    resume: (phone) => sendLocalBridgeCommand(phone, "resume"),
    mute: (phone, state = true) => sendLocalBridgeCommand(phone, state ? "mute" : "unmute"),
    sendDtmf: (phone, digits) => sendLocalBridgeCommand(phone, "send_dtmf", { digits }),
    status: (phone) => sendLocalBridgeCommand(phone, "status"),
    reprovision: (phone) => sendLocalBridgeCommand(phone, "reprovision"),
    reboot: (phone) => sendLocalBridgeCommand(phone, "reboot"),
  };
}
