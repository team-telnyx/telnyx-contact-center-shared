import assert from "node:assert";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
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
  settings: {},
};

describe("hard phones provisioning (Phase 1)", () => {
  it("normalizes and formats MAC addresses", () => {
    assert.strictEqual(normalizeMac("00:04:F2:AB:CD:EF"), "0004f2abcdef");
    assert.strictEqual(normalizeMac("0004f2abcdef"), "0004f2abcdef");
    assert.strictEqual(normalizeMac("not-a-mac"), null);
    assert.strictEqual(normalizeMac(""), null);
    assert.strictEqual(formatMac("0004F2ABCDEF"), "00:04:f2:ab:cd:ef");
    assert.deepStrictEqual(SUPPORTED_VENDORS, ["polycom", "yealink", "audiocodes"]);
  });

  it("resolves provisioning filenames to vendor and kind", () => {
    assert.deepStrictEqual(resolveProvisioningRequest("y000000000000.cfg"), { vendor: "yealink", kind: "common", mac: null });
    assert.deepStrictEqual(resolveProvisioningRequest("y000000000066.cfg"), { vendor: "yealink", kind: "common", mac: null });
    assert.deepStrictEqual(resolveProvisioningRequest("0004f2abcdef-reg.cfg"), { vendor: "polycom", kind: "registration", mac: "0004f2abcdef" });
    assert.deepStrictEqual(resolveProvisioningRequest("000000000000.cfg"), { vendor: "polycom", kind: "default-master", mac: null });
    assert.deepStrictEqual(resolveProvisioningRequest("805ec0123456.cfg"), { vendor: null, kind: "mac-config", mac: "805ec0123456" });
    assert.strictEqual(resolveProvisioningRequest("evil.php"), null);
    assert.strictEqual(resolveProvisioningRequest("../../etc/passwd"), null);
  });

  it("generates Polycom master and registration XML with Telnyx registration", () => {
    const master = polycomMasterConfig();
    assert.match(master, /CONFIG_FILES="\[PHONE_MAC_ADDRESS\]-reg\.cfg"/);
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
  });

  it("builds per-vendor config from the request kind", () => {
    const polyMaster = buildConfigForPhone(phone, "mac-config", {});
    assert.match(polyMaster.body, /APPLICATION/);
    assert.strictEqual(polyMaster.contentType, "text/xml");
    const polyReg = buildConfigForPhone(phone, "registration", {});
    assert.match(polyReg.body, /reg\.1\.address/);
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

  it("admin API supports phone CRUD with credential auto-create", async () => {
    const listCode = await src("app/api/admin/phones-provisioning/phones/route.js");
    assert.match(listCode, /export async function GET/);
    assert.match(listCode, /export async function POST/);
    assert.match(listCode, /createPhoneCredential/);
    assert.match(listCode, /requireAdmin/);
    const itemCode = await src("app/api/admin/phones-provisioning/phones/[id]/route.js");
    assert.match(itemCode, /export async function PUT/);
    assert.match(itemCode, /export async function DELETE/);
    assert.match(itemCode, /deletePhoneCredential/);
    assert.match(itemCode, /const \{ id \} = await params/);
  });

  it("public provisioning endpoint serves configs only for inventoried phones", async () => {
    const code = await src("app/api/provisioning/[filename]/route.js");
    assert.match(code, /resolveProvisioningRequest/);
    assert.match(code, /buildConfigForPhone/);
    assert.match(code, /unknown_phone_request/);
    assert.match(code, /config_served/);
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

  it("page uses 3-panel layout with dashboard, phones and settings sections", async () => {
    const code = await src("app/(portal)/admin/phones-provisioning/page.jsx");
    assert.match(code, /Context settings/);
    assert.match(code, /SectionRail/);
    assert.match(code, /SECTION_RAIL_PAGE_GRID_CLASS/);
    assert.match(code, /380px/);
    assert.match(code, /Dashboard/);
    assert.match(code, /Phones/);
    assert.match(code, /Settings/);
    assert.match(code, /MAC address/);
    assert.match(code, /disabled=\{!valid \|\| saving\}/);
    assert.match(code, /phoneDraftValid/);
  });

  it("menu replaces CTI Testing with Phones Provisioning", async () => {
    const code = await src("config/menu.jsx");
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
