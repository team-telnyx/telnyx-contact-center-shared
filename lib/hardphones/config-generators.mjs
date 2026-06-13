// Hard Phones Provisioning — vendor config generators (Phase 1)
//
// Generates boot-provisioning config files for Polycom/Poly (XML),
// Yealink (key=value cfg) and AudioCodes (INI cfg) hard phones. Each phone
// registers to Telnyx SIP using its own dedicated credential connection injected here.
//
// File-name conventions handled by the provisioning endpoint:
//   Polycom:    <mac>.cfg (master config) + <mac>-reg.cfg (registration)
//   Yealink:    y000000000000.cfg (common, generic) + <mac>.cfg
//   AudioCodes: <mac>.cfg

export const SUPPORTED_VENDORS = ["polycom", "yealink", "audiocodes"];

export function normalizeMac(raw) {
  const mac = String(raw || "").toLowerCase().replace(/[^0-9a-f]/g, "");
  return mac.length === 12 ? mac : null;
}

export function formatMac(mac) {
  const normalized = normalizeMac(mac);
  if (!normalized) return null;
  return normalized.match(/.{2}/g).join(":");
}

function xmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function defaultSipServer(settings = {}) {
  return {
    address: settings.sip_server || "sip.telnyx.com",
    port: Number(settings.sip_port) > 0 ? Number(settings.sip_port) : 5060,
    transport: ["udp", "tcp", "tls"].includes(String(settings.transport || "").toLowerCase())
      ? String(settings.transport).toLowerCase()
      : "udp",
    expires: Number(settings.register_expires) > 0 ? Number(settings.register_expires) : 600,
  };
}

function boundedInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function truthySetting(settings, key, fallback = true) {
  if (settings[key] === undefined || settings[key] === null) return fallback;
  return settings[key] !== false && settings[key] !== "false" && settings[key] !== "0";
}

function nonDefaultUrl(value) {
  const text = String(value || "").trim();
  if (!text || text === "vendor-default") return "";
  return text;
}

function cfgEscape(value) {
  return String(value ?? "").replace(/[\r\n]/g, " ").trim();
}

function xmlAttr(value) {
  return xmlEscape(cfgEscape(value));
}

function polyLineKeys(settings) {
  return boundedInt(settings.line_keys, 1, 1, 16);
}

// ---------------------------------------------------------------------------
// Polycom / Poly (VVX, Edge E, CCX OpenSIP) — XML
// ---------------------------------------------------------------------------

// Master config served at <mac>.cfg — points the phone at its per-MAC
// device and registration files using the [PHONE_MAC_ADDRESS] macro. Older
// VVX firmware commonly probes <mac>-phone.cfg as the device-level file; serve
// it explicitly so the phone does not keep using stale local/cached settings.
export function polycomMasterConfig() {
  return `<?xml version="1.0" standalone="yes"?>
<APPLICATION APP_FILE_PATH="" CONFIG_FILES="[PHONE_MAC_ADDRESS]-phone.cfg,[PHONE_MAC_ADDRESS]-reg.cfg" MISC_FILES="" LOG_FILE_DIRECTORY="" OVERRIDES_DIRECTORY="" CONTACTS_DIRECTORY="" LICENSE_DIRECTORY=""/>
`;
}

export function polycomRegistrationConfig(phone, { baseUrl = "" } = {}) {
  const settings = phone.settings || {};
  const server = defaultSipServer(settings);
  const transportMap = { udp: "UDPOnly", tcp: "TCPOnly", tls: "TLS" };
  const label = phone.assigned_phone_number || phone.label || phone.sip_username || "Telnyx";
  const lineKeys = polyLineKeys(settings);
  const lines = [
    `<?xml version="1.0" encoding="utf-8" standalone="yes"?>`,
    `<polycomConfig>`,
    `  <reg`,
    `    reg.1.address="${xmlEscape(phone.sip_username)}"`,
    `    reg.1.label="${xmlEscape(label)}"`,
    `    reg.1.displayName="${xmlEscape(label)}"`,
    `    reg.1.auth.userId="${xmlEscape(phone.sip_username)}"`,
    `    reg.1.auth.password="${xmlEscape(phone.sip_password)}"`,
    `    reg.1.server.1.address="${xmlEscape(server.address)}"`,
    `    reg.1.server.1.port="${server.transport === "tls" ? 5061 : server.port}"`,
    `    reg.1.server.1.transport="${transportMap[server.transport]}"`,
    `    reg.1.server.1.expires="${server.expires}"`,
    `    reg.1.server.1.register="1"`,
    `    reg.1.lineKeys="${lineKeys}"/>`,
    `  <nat nat.keepalive.interval="30"/>`,
    `  <prov prov.polling.enabled="${truthySetting(settings, "dynamic_reload", true) ? 1 : 0}" prov.polling.mode="rel" prov.polling.period="3600"/>`,
    `  <tcpIpApp.sntp tcpIpApp.sntp.address="${xmlAttr(settings.sntp_server || "pool.ntp.org")}"/>`,
    `  <device.set device.set="1" device.sntp.serverName.set="1" device.sntp.serverName="${xmlAttr(settings.sntp_server || "pool.ntp.org")}"/>`,
    `  <httpd httpd.enabled="1" apps.restapi.enabled="1"/>`,
  ];
  if (baseUrl) {
    lines.push(
      `  <apps apps.telNotification.URL="${xmlEscape(`${baseUrl}/api/provisioning/events/polycom?mac=[PHONE_MAC_ADDRESS]&ip=[PHONE_IP_ADDRESS]`)}" apps.telNotification.incomingEvent="1" apps.telNotification.outgoingEvent="1" apps.telNotification.callStateChangeEvent="1" apps.telNotification.offhookEvent="1" apps.telNotification.onhookEvent="1"/>`,
    );
  }
  if (phone.admin_password) {
    lines.push(
      `  <device device.set="1" device.auth.localAdminPassword.set="1" device.auth.localAdminPassword="${xmlEscape(phone.admin_password)}"/>`,
    );
  }
  const firmwareUrl = nonDefaultUrl(settings.firmware_source);
  if (firmwareUrl && truthySetting(settings, "automatic_firmware_updates", true)) {
    lines.push(`  <device.prov.upgradeServer device.set="1" device.prov.upgradeServer.set="1" device.prov.upgradeServer="${xmlAttr(firmwareUrl)}"/>`);
  }
  if (settings.syslog_server) {
    lines.push(`  <log log.render.level="3" log.render.file.size="256" log.server.address="${xmlAttr(settings.syslog_server)}"/>`);
  }
  lines.push(`</polycomConfig>`, ``);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Yealink (T3x/T4x/T5x) — key=value cfg with #!version header
// ---------------------------------------------------------------------------

export function yealinkCommonConfig({ baseUrl = "" } = {}) {
  const lines = [
    `#!version:1.0.0.1`,
    ``,
    `static.auto_provision.power_on = 1`,
    `static.auto_provision.repeat.enable = 1`,
    `static.auto_provision.repeat.minutes = 60`,
  ];
  if (baseUrl) {
    lines.push(`static.auto_provision.server.url = ${baseUrl}/api/provisioning/`);
  }
  lines.push(``);
  return lines.join("\n");
}

export function yealinkPhoneConfig(phone, { baseUrl = "" } = {}) {
  const settings = phone.settings || {};
  const server = defaultSipServer(settings);
  const transportMap = { udp: 0, tcp: 1, tls: 2 };
  const label = cfgEscape(phone.assigned_phone_number || phone.label || phone.sip_username || "Telnyx");
  const lineKeys = boundedInt(settings.line_keys, 1, 1, 16);
  const lines = [
    `#!version:1.0.0.1`,
    ``,
    `account.1.enable = 1`,
    `account.1.label = ${label}`,
    `account.1.display_name = ${label}`,
    `account.1.auth_name = ${phone.sip_username || ""}`,
    `account.1.user_name = ${phone.sip_username || ""}`,
    `account.1.password = ${phone.sip_password || ""}`,
    `account.1.sip_server.1.address = ${server.address}`,
    `account.1.sip_server.1.port = ${server.transport === "tls" ? 5061 : server.port}`,
    `account.1.sip_server.1.transport_type = ${transportMap[server.transport]}`,
    `account.1.sip_server.1.expires = ${server.expires}`,
    `account.1.nat.udp_update_enable = 1`,
    `account.1.nat.udp_update_time = 30`,
    `account.1.nat.rport = 1`,
    `linekey.1.line = 1`,
    `linekey.1.value = 1`,
    `linekey.1.type = 15`,
    `linekey.1.label = ${label}`,
    `features.config_dsskey_length = ${lineKeys}`,
    ``,
    `features.action_uri.enable = 1`,
  ];
  if (settings.cti_allow_ip) {
    lines.push(`features.action_uri_limit_ip = ${settings.cti_allow_ip}`);
  }
  if (phone.admin_password) {
    lines.push(`static.security.user_password = admin:${phone.admin_password}`);
  }
  lines.push(
    `local_time.ntp_server1 = ${cfgEscape(settings.sntp_server || "pool.ntp.org")}`,
    `local_time.dhcp_time = ${truthySetting(settings, "timezone_discovery", true) ? 1 : 0}`,
    `auto_provision.repeat.enable = ${truthySetting(settings, "dynamic_reload", true) ? 1 : 0}`,
  );
  const firmwareUrl = nonDefaultUrl(settings.firmware_source);
  if (firmwareUrl && truthySetting(settings, "automatic_firmware_updates", true)) {
    lines.push(`firmware.url = ${cfgEscape(firmwareUrl)}`);
  }
  if (settings.custom_config_url) {
    lines.push(`custom_config.url = ${cfgEscape(settings.custom_config_url)}`);
  }
  if (settings.syslog_server) {
    lines.push(`syslog.mode = 1`, `syslog.server = ${cfgEscape(settings.syslog_server)}`);
  }
  if (baseUrl) {
    const ev = (name) => `${baseUrl}/api/provisioning/events/yealink?mac=$mac&ip=$ip&event=${name}&call_id=$call_id&remote=$remote&local=$local`;
    lines.push(
      ``,
      `action_url.registered = ${ev("registered")}`,
      `action_url.unregistered = ${ev("unregistered")}`,
      `action_url.incoming_call = ${ev("incoming_call")}`,
      `action_url.outgoing_call = ${ev("outgoing_call")}`,
      `action_url.call_established = ${ev("call_established")}`,
      `action_url.call_terminated = ${ev("call_terminated")}`,
      `action_url.autop_finish = ${ev("autop_finish")}`,
    );
  }
  lines.push(``);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// AudioCodes (405HD/445HD/450HD — Linux UC firmware) — INI cfg
// ---------------------------------------------------------------------------

export function audiocodesPhoneConfig(phone, { baseUrl = "" } = {}) {
  const settings = phone.settings || {};
  const server = defaultSipServer(settings);
  const transportMap = { udp: "UDP", tcp: "TCP", tls: "TLS" };
  const label = cfgEscape(phone.assigned_phone_number || phone.label || phone.sip_username || "Telnyx");
  const lineKeys = boundedInt(settings.line_keys, 1, 1, 16);
  const lines = [
    `# AudioCodes provisioning — generated for ${formatMac(phone.mac) || phone.mac}`,
    phone.model ? `system/type=${phone.model}` : null,
    ``,
    `voip/line/0/enabled=1`,
    `voip/line/0/id=${phone.sip_username || ""}`,
    `voip/line/0/description=${label}`,
    `voip/line/0/auth_name=${phone.sip_username || ""}`,
    `voip/line/0/auth_password=${phone.sip_password || ""}`,
    ``,
    `voip/signalling/sip/use_proxy=1`,
    `voip/signalling/sip/proxy_address=${server.address}`,
    `voip/signalling/sip/proxy_port=${server.transport === "tls" ? 5061 : server.port}`,
    `voip/signalling/sip/use_proxy_ip_and_port_for_registration=1`,
    `voip/signalling/sip/transport_protocol=${transportMap[server.transport]}`,
    `voip/signalling/sip/registration_expires=${server.expires}`,
    ``,
    `provisioning/method=STATIC`,
    baseUrl ? `provisioning/configuration/url=${baseUrl}/api/provisioning/<MAC>.cfg` : null,
    `provisioning/period/type=HOURLY`,
    `provisioning/period/hourly/hours_interval=1`,
    `provisioning/check_sync/enabled=${truthySetting(settings, "dynamic_reload", true) ? 1 : 0}`,
    `provisioning/firmware/auto_update=${truthySetting(settings, "automatic_firmware_updates", true) ? 1 : 0}`,
    nonDefaultUrl(settings.firmware_source) ? `provisioning/firmware/url=${cfgEscape(nonDefaultUrl(settings.firmware_source))}` : null,
    settings.custom_config_url ? `provisioning/custom_configuration/url=${cfgEscape(settings.custom_config_url)}` : null,
    ``,
    `system/time/ntp_server=${cfgEscape(settings.sntp_server || "pool.ntp.org")}`,
    `system/time/timezone_discovery=${truthySetting(settings, "timezone_discovery", true) ? 1 : 0}`,
    `system/line_keys=${lineKeys}`,
    ``,
    `voip/auto_answer/enabled=1`,
    settings.syslog_server ? `system/syslog/server=${cfgEscape(settings.syslog_server)}` : null,
    phone.admin_password ? `system/password=${phone.admin_password}` : null,
    ``,
  ].filter((line) => line !== null);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Request resolution — map a requested provisioning filename to vendor +
// file kind. Returns null for unrecognized names.
// ---------------------------------------------------------------------------

export function resolveProvisioningRequest(filename) {
  const name = String(filename || "").toLowerCase();

  // Yealink common config: y000000000000.cfg (and model-family variants y0000000000XX.cfg)
  if (/^y0{10}[0-9a-f]{2}\.cfg$/.test(name)) {
    return { vendor: "yealink", kind: "common", mac: null };
  }
  // Polycom per-MAC registration file: <mac>-reg.cfg
  let match = name.match(/^([0-9a-f]{12})-reg\.cfg$/);
  if (match) return { vendor: "polycom", kind: "registration", mac: match[1] };
  // Polycom per-MAC phone/device file: <mac>-phone.cfg. VVX firmware may
  // request this even when the master file also references -reg.cfg.
  match = name.match(/^([0-9a-f]{12})-phone\.cfg$/);
  if (match) return { vendor: "polycom", kind: "phone", mac: match[1] };
  // Polycom default master config — we intentionally do NOT serve
  // 000000000000.cfg (unknown phones stay unprovisioned).
  if (name === "000000000000.cfg") {
    return { vendor: "polycom", kind: "default-master", mac: null };
  }
  // Per-MAC .cfg — vendor decided by inventory lookup (Polycom master,
  // Yealink MAC cfg and AudioCodes MAC cfg all use <mac>.cfg).
  match = name.match(/^([0-9a-f]{12})\.cfg$/);
  if (match) return { vendor: null, kind: "mac-config", mac: match[1] };

  return null;
}

// Build the served file body for a phone given the request kind.
export function buildConfigForPhone(phone, kind, { baseUrl = "" } = {}) {
  const vendor = String(phone.vendor || "").toLowerCase();
  if (vendor === "polycom") {
    if (kind === "registration" || kind === "phone") return { contentType: "text/xml", body: polycomRegistrationConfig(phone, { baseUrl }) };
    return { contentType: "text/xml", body: polycomMasterConfig() };
  }
  if (vendor === "yealink") {
    return { contentType: "text/plain", body: yealinkPhoneConfig(phone, { baseUrl }) };
  }
  if (vendor === "audiocodes") {
    return { contentType: "text/plain", body: audiocodesPhoneConfig(phone, { baseUrl }) };
  }
  return null;
}

// Heuristic vendor detection from the provisioning HTTP User-Agent. Used to
// flag mismatches and enrich the event log; inventory vendor stays canonical.
export function vendorFromUserAgent(userAgent) {
  const ua = String(userAgent || "").toLowerCase();
  if (!ua) return null;
  if (ua.includes("polycom") || ua.includes("polyedge") || ua.includes("poly/")) return "polycom";
  if (ua.includes("yealink")) return "yealink";
  if (ua.includes("audiocodes") || ua.includes("400hd") || ua.includes("445hd") || ua.includes("450hd") || ua.includes("405hd")) return "audiocodes";
  return null;
}
