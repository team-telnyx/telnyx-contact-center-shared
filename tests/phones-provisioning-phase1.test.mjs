import assert from "node:assert";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import {
  createPhoneSipConnection,
  updatePhoneSipConnectionCallerId,
  phoneConnectionUserName,
  phoneConnectionName,
} from "../lib/hardphones/credentials.mjs";
import {
  normalizeMac,
  formatMac,
  resolveProvisioningRequest,
  buildConfigForPhone,
  polycomMasterConfig,
  polycomRegistrationConfig,
  yealinkCommonConfig,
  yealinkPhoneConfig,
  audiocodesPhoneConfig,
  vendorFromUserAgent,
  SUPPORTED_VENDORS,
} from "../lib/hardphones/config-generators.mjs";

async function src(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

const phone = {
  mac: "0004f2abcdef",
  vendor: "polycom",
  model: "VVX 450",
  label: "Desk 12",
  sip_username: "gencredabc123",
  sip_password: "secretpw",
  admin_password: "newadminpw",
  settings: {
    line_keys: 3,
    sntp_server: "time.example.com",
    dynamic_reload: true,
    automatic_firmware_updates: true,
    firmware_source: "https://firmware.example.com/poly/",
    custom_config_url: "https://cfg.example.com/extra.cfg",
    syslog_server: "10.0.0.10",
  },
};

function currentOffsetSeconds(timezone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "shortOffset",
  }).formatToParts(new Date());
  const value = parts.find((part) => part.type === "timeZoneName")?.value || "GMT";
  if (value === "GMT" || value === "UTC") return 0;
  const match = value.match(/^(?:GMT|UTC)([+-])(\d{1,2})(?::?(\d{2}))?$/);
  assert.ok(match, `Expected parseable timezone offset, got ${value}`);
  const sign = match[1] === "-" ? -1 : 1;
  return sign * ((Number(match[2]) * 3600) + (Number(match[3] || 0) * 60));
}

describe("hard phones provisioning (Phase 1)", () => {
  it("normalizes and formats MAC addresses", () => {
    assert.strictEqual(normalizeMac("00:04:F2:AB:CD:EF"), "0004f2abcdef");
    assert.strictEqual(normalizeMac("0004f2abcdef"), "0004f2abcdef");
    assert.strictEqual(normalizeMac("not-a-mac"), null);
    assert.strictEqual(normalizeMac(""), null);
    assert.strictEqual(formatMac("0004F2ABCDEF"), "00:04:f2:ab:cd:ef");
    assert.deepStrictEqual(SUPPORTED_VENDORS, ["polycom", "yealink", "audiocodes"]);
  });

  it("derives Telnyx SIP connection usernames with phone prefix before the MAC", () => {
    assert.strictEqual(phoneConnectionUserName("00:04:F2:AB:CD:EF"), "phone0004F2ABCDEF");
    assert.strictEqual(phoneConnectionUserName("805ec0123456"), "phone805EC0123456");
    assert.strictEqual(phoneConnectionUserName("hp0004F2ABCDEF"), "phone0004F2ABCDEF");
    assert.strictEqual(phoneConnectionUserName("phone0004F2ABCDEF"), "phone0004F2ABCDEF");
    assert.strictEqual(phoneConnectionName("00:04:F2:AB:CD:EF"), "phone_0004F2ABCDEF");
    assert.throws(() => phoneConnectionUserName("not-a-mac"), /Valid phone MAC is required/);
  });

  it("repairs Telnyx-created SIP connections when the create response loses the phone prefix", async () => {
    const originalFetch = globalThis.fetch;
    const originalApiKey = process.env.TELNYX_API_KEY;
    const originalOutboundProfile = process.env.TELNYX_OUTBOUND_VOICE_PROFILE;
    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (options.method === "PATCH") {
        return Response.json({ data: { id: "cc-123", connection_name: "phone_0004F2CBF6D5", user_name: "phone0004F2CBF6D5" } });
      }
      return Response.json({ data: { id: "cc-123", connection_name: "phone_0004F2CBF6D5", user_name: "0004F2CBF6D5" } });
    };
    process.env.TELNYX_API_KEY = "test-key";
    process.env.TELNYX_OUTBOUND_VOICE_PROFILE = "ovp-123";
    try {
      const created = await createPhoneSipConnection({ mac: "00:04:F2:CB:F6:D5", vendor: "polycom", model: "VVX 310", assignedPhoneNumber: "+17209533450" });
      assert.strictEqual(created.sip_username, "phone0004F2CBF6D5");
      assert.strictEqual(calls.length, 2);
      const createBody = JSON.parse(calls[0].options.body);
      assert.strictEqual(createBody.user_name, "phone0004F2CBF6D5");
      assert.strictEqual(createBody.inbound.ani_number_format, "+E.164");
      assert.strictEqual(createBody.inbound.dnis_number_format, "+e164");
      assert.strictEqual(createBody.outbound.ani_override, "+17209533450");
      assert.strictEqual(createBody.outbound.ani_override_type, "always");
      assert.strictEqual(calls[1].options.method, "PATCH");
      assert.strictEqual(JSON.parse(calls[1].options.body).user_name, "phone0004F2CBF6D5");
    } finally {
      globalThis.fetch = originalFetch;
      if (originalApiKey === undefined) delete process.env.TELNYX_API_KEY;
      else process.env.TELNYX_API_KEY = originalApiKey;
      if (originalOutboundProfile === undefined) delete process.env.TELNYX_OUTBOUND_VOICE_PROFILE;
      else process.env.TELNYX_OUTBOUND_VOICE_PROFILE = originalOutboundProfile;
    }
  });

  it("clears Telnyx SIP connection outbound caller ID with a blank override", async () => {
    const originalFetch = globalThis.fetch;
    const originalApiKey = process.env.TELNYX_API_KEY;
    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
      calls.push({ url: String(url), options });
      return Response.json({ data: { id: "cc-123" } });
    };
    process.env.TELNYX_API_KEY = "test-key";
    try {
      await updatePhoneSipConnectionCallerId({ connectionId: "cc-123", phoneNumber: null });
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0].options.method, "PATCH");
      assert.deepStrictEqual(JSON.parse(calls[0].options.body).outbound, {
        ani_override: "",
        ani_override_type: "always",
      });
    } finally {
      globalThis.fetch = originalFetch;
      if (originalApiKey === undefined) delete process.env.TELNYX_API_KEY;
      else process.env.TELNYX_API_KEY = originalApiKey;
    }
  });

  it("resolves provisioning filenames to vendor and kind", () => {
    assert.deepStrictEqual(resolveProvisioningRequest("y000000000000.cfg"), { vendor: "yealink", kind: "common", mac: null });
    assert.deepStrictEqual(resolveProvisioningRequest("y000000000066.cfg"), { vendor: "yealink", kind: "common", mac: null });
    assert.deepStrictEqual(resolveProvisioningRequest("0004f2abcdef-reg.cfg"), { vendor: "polycom", kind: "registration", mac: "0004f2abcdef" });
    assert.deepStrictEqual(resolveProvisioningRequest("0004f2abcdef-phone.cfg"), { vendor: "polycom", kind: "phone", mac: "0004f2abcdef" });
    assert.deepStrictEqual(resolveProvisioningRequest("000000000000.cfg"), { vendor: "polycom", kind: "default-master", mac: null });
    assert.deepStrictEqual(resolveProvisioningRequest("805ec0123456.cfg"), { vendor: null, kind: "mac-config", mac: "805ec0123456" });
    assert.strictEqual(resolveProvisioningRequest("evil.php"), null);
    assert.strictEqual(resolveProvisioningRequest("../../etc/passwd"), null);
  });

  it("generates Polycom master and registration XML with Telnyx registration", () => {
    const master = polycomMasterConfig();
    assert.match(master, /CONFIG_FILES="\[PHONE_MAC_ADDRESS\]-phone\.cfg,\[PHONE_MAC_ADDRESS\]-reg\.cfg"/);
    const reg = polycomRegistrationConfig(phone, { baseUrl: "https://cc.example.com" });
    assert.match(reg, /reg\.1\.address="gencredabc123"/);
    assert.match(reg, /reg\.1\.auth\.userId="gencredabc123"/);
    assert.match(reg, /reg\.1\.auth\.password="secretpw"/);
    assert.match(reg, /reg\.1\.server\.1\.address="sip\.telnyx\.com"/);
    assert.match(reg, /reg\.1\.server\.1\.transport="UDPOnly"/);
    assert.match(reg, /apps\.restapi\.enabled="1"/);
    assert.match(reg, /apps\.telNotification\.URL=/);
    assert.match(reg, /device\.auth\.localAdminPassword="newadminpw"/);
    assert.match(reg, /prov\.polling\.enabled="1"/);
    assert.match(reg, /reg\.1\.lineKeys="3"/);
    assert.match(reg, /time\.example\.com/);
    assert.match(reg, /device\.prov\.upgradeServer/);
    assert.match(reg, /log\.server\.address="10\.0\.0\.10"/);
  });

  it("generates Yealink cfg with version header, account and action URLs", () => {
    const common = yealinkCommonConfig({ baseUrl: "https://cc.example.com" });
    assert.match(common, /^#!version:1\.0\.0\.1/);
    assert.match(common, /static\.auto_provision\.server\.url = https:\/\/cc\.example\.com\/api\/provisioning\//);
    const cfg = yealinkPhoneConfig({ ...phone, vendor: "yealink" }, { baseUrl: "https://cc.example.com" });
    assert.match(cfg, /^#!version:1\.0\.0\.1/);
    assert.match(cfg, /account\.1\.auth_name = gencredabc123/);
    assert.match(cfg, /account\.1\.user_name = gencredabc123/);
    assert.match(cfg, /account\.1\.password = secretpw/);
    assert.match(cfg, /account\.1\.sip_server\.1\.address = sip\.telnyx\.com/);
    assert.match(cfg, /features\.action_uri\.enable = 1/);
    assert.match(cfg, /action_url\.incoming_call = /);
    assert.match(cfg, /action_url\.call_terminated = /);
    assert.match(cfg, /static\.security\.user_password = admin:newadminpw/);
    assert.match(cfg, /linekey\.1\.label = Desk 12/);
    assert.match(cfg, /features\.config_dsskey_length = 3/);
    assert.match(cfg, /local_time\.ntp_server1 = time\.example\.com/);
    assert.match(cfg, /firmware\.url = https:\/\/firmware\.example\.com\/poly\//);
    assert.match(cfg, /custom_config\.url = https:\/\/cfg\.example\.com\/extra\.cfg/);
    assert.match(cfg, /syslog\.server = 10\.0\.0\.10/);
  });

  it("keeps Yealink common provisioning URLs on the request host instead of public webhook host", async () => {
    const route = await src("app/api/provisioning/[filename]/route.js");
    assert.match(route, /function resolveProvisioningBaseUrl\(request\)/);
    assert.match(route, /x-forwarded-host/);
    assert.match(route, /x-forwarded-proto/);
    assert.match(route, /yealinkCommonConfig\(\{ baseUrl: resolveProvisioningBaseUrl\(request\) \}\)/);
  });

  it("generates AudioCodes INI cfg with line 0 and provisioning persistence", () => {
    const cfg = audiocodesPhoneConfig({ ...phone, vendor: "audiocodes", model: "445HD" }, { baseUrl: "https://cc.example.com" });
    assert.match(cfg, /system\/type=445HD/);
    assert.match(cfg, /voip\/line\/0\/auth_name=gencredabc123/);
    assert.match(cfg, /voip\/line\/0\/auth_password=secretpw/);
    assert.match(cfg, /voip\/signalling\/sip\/proxy_address=sip\.telnyx\.com/);
    assert.match(cfg, /provisioning\/configuration\/url=https:\/\/cc\.example\.com\/api\/provisioning\/<MAC>\.cfg/);
    assert.match(cfg, /provisioning\/check_sync\/enabled=1/);
    assert.match(cfg, /voip\/auto_answer\/enabled=1/);
    assert.match(cfg, /system\/password=newadminpw/);
    assert.match(cfg, /provisioning\/firmware\/auto_update=1/);
    assert.match(cfg, /provisioning\/firmware\/url=https:\/\/firmware\.example\.com\/poly\//);
    assert.match(cfg, /provisioning\/custom_configuration\/url=https:\/\/cfg\.example\.com\/extra\.cfg/);
    assert.match(cfg, /system\/time\/ntp_server=time\.example\.com/);
    assert.match(cfg, /system\/line_keys=3/);
    assert.match(cfg, /system\/syslog\/server=10\.0\.0\.10/);
  });

  it("uses the Telnyx credential username as SIP line identity for registration", () => {
    const numberedPhone = { ...phone, assigned_phone_number: "+15551234567", sip_username: "0004F2ABCDEF" };

    const poly = polycomRegistrationConfig(numberedPhone, { baseUrl: "https://cc.example.com" });
    assert.match(poly, /reg\.1\.address="0004F2ABCDEF"/);
    assert.match(poly, /reg\.1\.auth\.userId="0004F2ABCDEF"/);

    const yealink = yealinkPhoneConfig({ ...numberedPhone, vendor: "yealink" }, { baseUrl: "https://cc.example.com" });
    assert.match(yealink, /account\.1\.user_name = 0004F2ABCDEF/);
    assert.match(yealink, /account\.1\.auth_name = 0004F2ABCDEF/);

    const audiocodes = audiocodesPhoneConfig({ ...numberedPhone, vendor: "audiocodes" }, { baseUrl: "https://cc.example.com" });
    assert.match(audiocodes, /voip\/line\/0\/id=0004F2ABCDEF/);
    assert.match(audiocodes, /voip\/line\/0\/auth_name=0004F2ABCDEF/);
  });

  it("uses Line Label for phone display text without replacing SIP line identity", () => {
    const namedPhone = {
      ...phone,
      phone_name: "Reception inventory name",
      label: "Front Desk Line",
      assigned_phone_number: "+15551234567",
      sip_username: "phone0004F2ABCDEF",
    };

    const poly = polycomRegistrationConfig(namedPhone, { baseUrl: "https://cc.example.com" });
    assert.match(poly, /reg\.1\.address="phone0004F2ABCDEF"/);
    assert.match(poly, /reg\.1\.label="Front Desk Line"/);
    assert.match(poly, /reg\.1\.displayName="Front Desk Line"/);
    assert.doesNotMatch(poly, /Reception inventory name/);

    const yealink = yealinkPhoneConfig({ ...namedPhone, vendor: "yealink" }, { baseUrl: "https://cc.example.com" });
    assert.match(yealink, /account\.1\.user_name = phone0004F2ABCDEF/);
    assert.match(yealink, /account\.1\.label = Front Desk Line/);
    assert.match(yealink, /linekey\.1\.label = Front Desk Line/);
    assert.doesNotMatch(yealink, /Reception inventory name/);

    const audiocodes = audiocodesPhoneConfig({ ...namedPhone, vendor: "audiocodes" }, { baseUrl: "https://cc.example.com" });
    assert.match(audiocodes, /voip\/line\/0\/id=phone0004F2ABCDEF/);
    assert.match(audiocodes, /voip\/line\/0\/description=Front Desk Line/);
    assert.doesNotMatch(audiocodes, /Reception inventory name/);
  });

  it("writes selected NTP timezone offset settings into vendor configs", () => {
    const warsawPhone = { ...phone, settings: { ...phone.settings, ntp_timezone: "Europe/Warsaw", timezone_discovery: false } };
    const warsawOffset = currentOffsetSeconds("Europe/Warsaw");
    const warsawYealinkOffset = `${warsawOffset >= 0 ? "+" : ""}${warsawOffset / 3600}`;

    const poly = polycomRegistrationConfig(warsawPhone, { baseUrl: "https://cc.example.com" });
    assert.match(poly, new RegExp(`tcpIpApp\\.sntp\\.gmtOffset="${warsawOffset}"`));
    assert.match(poly, new RegExp(`device\\.sntp\\.gmtOffset="${warsawOffset}"`));

    const yealink = yealinkPhoneConfig({ ...warsawPhone, vendor: "yealink" }, { baseUrl: "https://cc.example.com" });
    assert.match(yealink, /local_time\.dhcp_time = 0/);
    assert.match(yealink, new RegExp(`local_time\\.time_zone = \\${warsawYealinkOffset}`));

    const audiocodes = audiocodesPhoneConfig({ ...warsawPhone, vendor: "audiocodes" }, { baseUrl: "https://cc.example.com" });
    assert.match(audiocodes, /system\/time\/timezone=Europe\/Warsaw/);
    assert.match(audiocodes, new RegExp(`system/time/gmt_offset=${warsawOffset}`));
  });

  it("builds per-vendor config from the request kind", () => {
    const polyMaster = buildConfigForPhone(phone, "mac-config", {});
    assert.match(polyMaster.body, /APPLICATION/);
    assert.strictEqual(polyMaster.contentType, "text/xml");
    const polyReg = buildConfigForPhone(phone, "registration", {});
    assert.match(polyReg.body, /reg\.1\.address/);
    const polyPhone = buildConfigForPhone(phone, "phone", {});
    assert.match(polyPhone.body, /reg\.1\.address/);
    assert.strictEqual(polyPhone.contentType, "text/xml");
    const yl = buildConfigForPhone({ ...phone, vendor: "yealink" }, "mac-config", {});
    assert.match(yl.body, /account\.1\.enable = 1/);
    assert.strictEqual(yl.contentType, "text/plain");
    const ac = buildConfigForPhone({ ...phone, vendor: "audiocodes" }, "mac-config", {});
    assert.match(ac.body, /voip\/line\/0\/enabled=1/);
    assert.strictEqual(buildConfigForPhone({ ...phone, vendor: "cisco" }, "mac-config", {}), null);
  });

  it("escapes XML special characters in Polycom config", () => {
    const reg = polycomRegistrationConfig({ ...phone, label: `A"B<C>&D`, sip_password: `p"w&` }, {});
    assert.match(reg, /A&quot;B&lt;C&gt;&amp;D/);
    assert.match(reg, /p&quot;w&amp;/);
    assert.doesNotMatch(reg, /reg\.1\.label="A"B/);
  });

  it("detects vendor from provisioning user agents", () => {
    assert.strictEqual(vendorFromUserAgent("PolycomVVX-VVX_450-UA/6.4.0"), "polycom");
    assert.strictEqual(vendorFromUserAgent("Yealink SIP-T46S 66.86.0.15 805ec0123456"), "yealink");
    assert.strictEqual(vendorFromUserAgent("AUDC-IPPhone-445HD_UC_3.4.8/1.0"), "audiocodes");
    assert.strictEqual(vendorFromUserAgent("curl/8.0"), null);
  });

  it("schema defines hp_phones and hp_provisioning_events", async () => {
    const code = await src("lib/postgres-schema.mjs");
    assert.match(code, /CREATE TABLE IF NOT EXISTS hp_phones/);
    assert.match(code, /CREATE TABLE IF NOT EXISTS hp_provisioning_events/);
    assert.match(code, /hp_phones_updated_at_trigger/);
    assert.match(code, /idx_hp_phones_mac/);
  });

  it("admin API supports phone CRUD with SIP connection auto-create", async () => {
    const listCode = await src("app/api/admin/phones-provisioning/phones/route.js");
    assert.match(listCode, /export async function GET/);
    assert.match(listCode, /export async function POST/);
    assert.match(listCode, /createPhoneSipConnection/);
    assert.match(listCode, /TELNYX_PHONE_ADMIN_PASSWORD/);
    assert.match(listCode, /TELNYX_OUTBOUND_VOICE_PROFILE/);
    assert.match(listCode, /requireAdmin/);
    const itemCode = await src("app/api/admin/phones-provisioning/phones/[id]/route.js");
    assert.match(itemCode, /export async function PUT/);
    assert.match(itemCode, /export async function DELETE/);
    assert.match(itemCode, /deletePhoneSipConnection/);
    assert.match(itemCode, /const \{ id \} = await params/);
  });

  it("public provisioning endpoint serves configs only for inventoried phones", async () => {
    const code = await src("app/api/provisioning/[filename]/route.js");
    assert.match(code, /resolveProvisioningRequest/);
    assert.match(code, /SELECT id, mac, vendor, model, label, assigned_phone_number_id, assigned_phone_number, sip_username/);
    assert.match(code, /buildConfigForPhone\(phone/);
    assert.match(code, /unknown_phone_request/);
    assert.match(code, /config_served/);
    assert.match(code, /const kind = resolved\.kind/);
    assert.doesNotMatch(code, /resolved\.kind === "registration" \? "registration" : "mac-config"/);
    assert.match(code, /last_seen_at = NOW\(\)/);
    assert.match(code, /provisioning_state = 'disabled'|provisioning_state === "disabled"/);
    // No auth gate — phones cannot authenticate; security via MAC allow-list
    assert.doesNotMatch(code, /requireAdmin/);
  });

  it("phone event sink logs vendor events with MAC correlation", async () => {
    const code = await src("app/api/provisioning/events/[vendor]/route.js");
    assert.match(code, /export async function GET/);
    assert.match(code, /export async function POST/);
    assert.match(code, /phone_event_/);
    assert.match(code, /normalizeMac/);
  });

  it("page uses 3-panel layout with dashboard, phones, bridges, logs and settings sections", async () => {
    const code = await src("app/(portal)/admin/phones-provisioning/page.jsx");
    assert.match(code, /Context settings/);
    assert.match(code, /SectionRail/);
    assert.match(code, /SECTION_RAIL_PAGE_GRID_CLASS/);
    assert.match(code, /380px/);
    assert.match(code, /Dashboard/);
    assert.match(code, /Phones/);
    assert.match(code, /Bridges/);
    assert.match(code, /Logs/);
    assert.match(code, /id: "logs"[\s\S]*label: "Logs"/);
    assert.match(code, /id: "bridges"[\s\S]*id: "logs"[\s\S]*id: "settings"/);
    assert.match(code, /MAC address/);
    assert.match(code, /disabled=\{!valid \|\| saving \|\| \(!editing && \(!phoneAdminPasswordConfigured \|\| !outboundVoiceProfileConfigured\)\)\}/);
    assert.match(code, /phoneDraftValid/);
    assert.match(code, /PHONE_MODEL_CATALOG/);
    assert.match(code, /PhoneModelPreview/);
    assert.match(code, /Full manufacturer documentation/);
    assert.match(code, /\/images\/hardphones\/poly-vvx-450\.png/);
    assert.match(code, /VVX 101/);
    assert.match(code, /Edge E550/);
    assert.match(code, /420HD/);
    assert.match(code, /T22P/);
    assert.match(code, /T27P/);
    assert.match(code, /T19P E2/);
    assert.match(code, /https:\/\/www\.yealink\.com\/en\/products_list_18\.html/);
    assert.match(code, /https:\/\/www\.yealink\.com\/en\/product-detail\/ip-phone-t46u/);
    assert.match(code, /Context settings view/);
    assert.match(code, /Dynamic reload/);
    assert.match(code, /Automatic firmware updates/);
    assert.match(code, /Reboot selected/);
    assert.match(code, /\/phones\/reboot/);
    assert.doesNotMatch(code, /Genesys managed phone matrix/);
    assert.doesNotMatch(code, /help\.genesys\.cloud/);
    assert.match(code, /settings\.cti_mode = &quot;telnyx&quot;/);
  });

  it("moves provisioning events to a dedicated paged logs section", async () => {
    const page = await src("app/(portal)/admin/phones-provisioning/page.jsx");
    const dashboardView = page.slice(page.indexOf("function DashboardView"), page.indexOf("function PhonesListView"));
    assert.doesNotMatch(dashboardView, /Provisioning activity/);
    assert.match(page, /function LogsView/);
    assert.match(page, /setLogDays/);
    assert.match(page, /setLogPageSize/);
    assert.match(page, /\[10, 25, 50\]\.map/);
    assert.match(page, /Accordion/);
    assert.match(page, /AccordionContent/);
    assert.match(page, /Phone name/);
    assert.match(page, /MAC address/);
    assert.match(page, /Event type/);
    assert.match(page, /event\.detail/);
    assert.match(page, /fetch\(`\$\{API\}\/logs\?/);

    const route = await src("app/api/admin/phones-provisioning/logs/route.js");
    assert.match(route, /export async function GET/);
    assert.match(route, /hp_provisioning_events/);
    assert.match(route, /hp_phones/);
    assert.match(route, /phone_name/);
    assert.match(route, /detail/);
    assert.match(route, /days === 7 \? 7 : 1/);
    assert.match(route, /\[10, 25, 50\]\.includes\(pageSize\)/);
    assert.match(route, /LIMIT \$2 OFFSET \$3/);
    assert.match(route, /COUNT\(\*\)::int AS total/);
  });

  it("bundles exact manufacturer phone photos for catalog models", async () => {
    const base = new URL("..", import.meta.url).pathname;
    const files = readdirSync(`${base}public/images/hardphones`).filter((name) => /\.(png|jpe?g|webp)$/i.test(name));
    const page = await src("app/(portal)/admin/phones-provisioning/page.jsx");

    [
      "yealink-t31p.png",
      "yealink-t33g.png",
      "yealink-t43u.png",
      "yealink-t46u.png",
      "yealink-t48u.png",
      "yealink-t53w.png",
      "yealink-t54w.png",
      "yealink-t57w.png",
      "yealink-t58w.png",
      "audiocodes-405hd.png",
      "audiocodes-420hd.png",
      "audiocodes-425hd.png",
      "audiocodes-430hd.png",
      "audiocodes-c430hd.png",
      "audiocodes-440hd.png",
      "audiocodes-445hd.png",
      "audiocodes-450hd.png",
      "audiocodes-c450hd.png",
    ].forEach((file) => assert.ok(files.includes(file), `missing ${file}`));

    assert.match(page, /T54W[\s\S]*yealink-t54w\.png/);
    assert.match(page, /T57W[\s\S]*yealink-t57w\.png/);
    assert.match(page, /420HD[\s\S]*audiocodes-420hd\.png/);
    assert.match(page, /425HD[\s\S]*audiocodes-425hd\.png/);
    assert.match(page, /430HD[\s\S]*audiocodes-430hd\.png/);
    assert.match(page, /440HD[\s\S]*audiocodes-440hd\.png/);
    assert.match(page, /450HD[\s\S]*audiocodes-450hd\.png/);
    assert.match(page, /C450HD[\s\S]*audiocodes-c450hd\.png/);
    assert.doesNotMatch(page, /\["T53", "T53W", "T52S", "T54S", "T54W"\]\.includes\(model\)\) return "\/images\/hardphones\/yealink-t53w\.png"/);
    assert.ok(files.length >= 30);
  });

  it("menu replaces CTI Testing with Phones Provisioning", async () => {
    const code = await src("components/admin/SystemSectionNav.jsx");
    assert.match(code, /Phones Provisioning/);
    assert.match(code, /\/admin\/phones-provisioning/);
    assert.doesNotMatch(code, /cti-testing/);
  });

  it("legacy CTI testing module is removed", () => {
    const base = new URL("..", import.meta.url).pathname;
    assert.strictEqual(existsSync(`${base}app/(portal)/admin/cti-testing`), false);
    assert.strictEqual(existsSync(`${base}app/api/voice/cti`), false);
    assert.strictEqual(existsSync(`${base}lib/cti`), false);
  });
});
