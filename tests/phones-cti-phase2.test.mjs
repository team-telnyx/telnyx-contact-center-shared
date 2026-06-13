import assert from "node:assert";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { polycomDriver } from "../lib/hardphones/drivers/polycom.mjs";
import { yealinkDriver } from "../lib/hardphones/drivers/yealink.mjs";
import {
  createTelnyxFallbackDriver,
  buildCtiClientState,
  parseCtiClientState,
} from "../lib/hardphones/drivers/telnyx-fallback.mjs";
import { resolveCtiDriver, resolveCtiDriverForAction, executeCtiAction, CTI_ACTIONS } from "../lib/hardphones/cti.mjs";

async function src(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("hard phones CTI driver layer (Phase 2)", () => {
  it("exposes the full CTI action set", () => {
    for (const action of ["dial", "answer", "hangup", "hold", "resume", "mute", "unmute", "send_dtmf", "status", "reprovision", "reboot"]) {
      assert.ok(CTI_ACTIONS.includes(action), `missing action ${action}`);
    }
  });

  it("resolves drivers per vendor with telnyx fallback for audiocodes", () => {
    assert.strictEqual(resolveCtiDriver({ vendor: "polycom" }).vendor, "polycom");
    assert.strictEqual(resolveCtiDriver({ vendor: "yealink" }).vendor, "yealink");
    assert.strictEqual(resolveCtiDriver({ vendor: "audiocodes" }).vendor, "telnyx-fallback");
    assert.strictEqual(resolveCtiDriver({ vendor: "unknown" }).vendor, "telnyx-fallback");
    // explicit override forces fallback regardless of vendor
    assert.strictEqual(resolveCtiDriver({ vendor: "polycom", settings: { cti_mode: "telnyx" } }).vendor, "telnyx-fallback");
  });

  it("keeps AudioCodes local-bridge status on the bridge while call control uses fallback", () => {
    const phone = { vendor: "audiocodes", settings: { cti_mode: "local_bridge" } };
    assert.strictEqual(resolveCtiDriverForAction(phone, "status").vendor, "local-bridge");
    assert.strictEqual(resolveCtiDriverForAction(phone, "dial").vendor, "telnyx-fallback");
    assert.strictEqual(resolveCtiDriverForAction(phone, "hangup").vendor, "telnyx-fallback");
  });

  it("AudioCodes local bridge status is merged with Telnyx fallback call state", async () => {
    const code = await src("lib/hardphones/cti.mjs");
    assert.match(code, /isAudioCodesLocalBridgeStatus/);
    assert.match(code, /mergeAudioCodesHybridStatus/);
    assert.match(code, /localStatus = await localDriver\.status\(phone\)/);
    assert.match(code, /telnyxStatus = await telnyxDriver\.status\(phone\)/);
    assert.match(code, /call: telnyxStatus\?\.call/);
    assert.match(code, /line: localStatus\?\.line/);
  });

  it("drivers fail fast without a phone IP", async () => {
    const phone = { vendor: "polycom", admin_password: "x" };
    assert.deepStrictEqual(await polycomDriver.dial(phone, "123"), { ok: false, reason: "no_phone_ip" });
    assert.deepStrictEqual(await yealinkDriver.dial({ vendor: "yealink" }, "123"), { ok: false, reason: "no_phone_ip" });
    const status = await yealinkDriver.status({ vendor: "yealink" });
    assert.strictEqual(status.reachable, false);
  });

  it("drivers prefer the auto-detected IP over stale manual values", async () => {
    const page = await src("app/(portal)/admin/phones-provisioning/page.jsx");
    const yealinkCode = await src("lib/hardphones/drivers/yealink.mjs");
    const polycomCode = await src("lib/hardphones/drivers/polycom.mjs");
    const localBridgeCode = await src("lib/hardphones/drivers/local-bridge.mjs");
    assert.match(page, /const reachableIp = phone\.last_ip \|\| phone\.ip_address/);
    assert.doesNotMatch(page, /const reachableIp = phone\.ip_address \|\| phone\.last_ip/);
    assert.match(yealinkCode, /phone\.last_ip \|\| phone\.ip_address/);
    assert.match(polycomCode, /phone\.last_ip \|\| phone\.ip_address/);
    assert.match(localBridgeCode, /phone\?\.last_ip \|\| phone\?\.ip_address/);
  });

  it("yealink driver validates dial digits and dtmf input", async () => {
    assert.deepStrictEqual(await yealinkDriver.dial({ last_ip: "" }, ""), { ok: false, reason: "invalid_number" });
    assert.deepStrictEqual(await yealinkDriver.dial({ last_ip: "10.0.0.5" }, "!!!"), { ok: false, reason: "invalid_number" });
    assert.deepStrictEqual(await yealinkDriver.sendDtmf({ last_ip: "10.0.0.5" }, "abc"), { ok: false, reason: "invalid_digits" });
  });

  it("telnyx fallback CTI client_state round-trips", () => {
    const cs = buildCtiClientState({ phoneId: "p-1", target: "+48123" });
    assert.deepStrictEqual(parseCtiClientState(cs), { hardphoneCti: true, phoneId: "p-1", target: "+48123" });
    assert.strictEqual(parseCtiClientState("garbage"), null);
    const foreign = Buffer.from(JSON.stringify({ callGenerator: true })).toString("base64");
    assert.strictEqual(parseCtiClientState(foreign), null);
  });

  it("telnyx fallback requires a SIP credential to dial and reports auto-answer", async () => {
    const driver = createTelnyxFallbackDriver({ pool: null });
    assert.deepStrictEqual(await driver.dial({ id: "p-1" }, "+48123"), { ok: false, reason: "phone_has_no_sip_credential" });
    const answer = await driver.answer();
    assert.strictEqual(answer.ok, true);
    assert.deepStrictEqual(await driver.hangup({ id: "p-1" }), { ok: false, reason: "no_active_call" });
    assert.deepStrictEqual(await driver.reprovision(), { ok: false, reason: "not_supported_use_polling" });
  });

  it("executeCtiAction routes actions and rejects unknown ones", async () => {
    const result = await executeCtiAction({ vendor: "polycom" }, "dial", { number: "123" });
    assert.deepStrictEqual(result, { ok: false, reason: "no_phone_ip" });
    const unknown = await executeCtiAction({ vendor: "polycom" }, "explode");
    assert.deepStrictEqual(unknown, { ok: false, reason: "unknown_action" });
  });

  it("schema adds CTI columns and hp_cti_sessions table", async () => {
    const code = await src("lib/postgres-schema.mjs");
    assert.match(code, /ADD COLUMN IF NOT EXISTS ip_address TEXT/);
    assert.match(code, /ADD COLUMN IF NOT EXISTS last_ip TEXT/);
    assert.match(code, /CREATE TABLE IF NOT EXISTS hp_cti_sessions/);
    assert.match(code, /idx_hp_cti_sessions_phone/);
  });

  it("CTI admin endpoint gates on admin, validates action and logs events", async () => {
    const code = await src("app/api/admin/phones-provisioning/phones/[id]/cti/route.js");
    assert.match(code, /requireAdmin/);
    assert.match(code, /CTI_ACTIONS\.includes\(action\)/);
    assert.match(code, /executeCtiAction/);
    assert.match(code, /result\?\.registration/);
    assert.match(code, /line\?\.SipStatus/);
    assert.match(code, /cti_\$\{action\}/);
    assert.match(code, /const \{ id \} = await params/);
  });

  it("bulk reboot admin endpoint gates on admin and logs per-phone results", async () => {
    const code = await src("app/api/admin/phones-provisioning/phones/reboot/route.js");
    assert.match(code, /requireAdmin/);
    assert.match(code, /phone_ids/);
    assert.match(code, /executeCtiAction\(phone, "reboot"/);
    assert.match(code, /cti_reboot/);
  });

  it("CTI webhook transfers the auto-answered leg to the dial target", async () => {
    const code = await src("app/api/provisioning/cti-webhook/route.js");
    assert.match(code, /parseCtiClientState/);
    assert.match(code, /loadCtiSessionState/);
    assert.match(code, /SELECT s\.phone_id, s\.target/);
    assert.match(code, /FROM hp_cti_sessions s/);
    assert.match(code, /LEFT JOIN hp_phones p ON p\.id = s\.phone_id/);
    assert.match(code, /const state = parsedState \|\| await loadCtiSessionState\(pool, callControlId\)/);
    assert.match(code, /call\.answered/);
    assert.match(code, /actions\/transfer/);
    assert.match(code, /to: state\.target/);
    assert.match(code, /from: state\.callerId/);
    assert.match(code, /hp_cti_sessions/);
  });

  it("phone events capture explicit phone IP for CTI reachability without trusting proxy headers", async () => {
    const serveCode = await src("app/api/provisioning/[filename]/route.js");
    assert.doesNotMatch(serveCode, /last_ip = COALESCE\(\$3, last_ip\)/);
    assert.match(serveCode, /sourceIp: requestSourceIp\(request\)/);
    const eventsCode = await src("app/api/provisioning/events/[vendor]/route.js");
    assert.match(eventsCode, /last_ip = COALESCE/);
    assert.match(eventsCode, /queryParams\.ip/);
    assert.match(eventsCode, /source_ip: sourceIp/);
  });

  it("phone editor exposes IP field and CTI control card", async () => {
    const code = await src("app/(portal)/admin/phones-provisioning/page.jsx");
    assert.match(code, /Detected phone IP address/);
    assert.match(code, /readOnly/);
    assert.match(code, /phone\.last_ip \|\| phone\.ip_address/);
    assert.match(code, /PhoneCtiCard/);
    assert.match(code, /hp-cti-toolbar/);
    assert.match(code, /hp-cti-dial/);
    assert.match(code, /hp-cti-hold-toggle/);
    assert.match(code, /hp-cti-mute-toggle/);
    assert.match(code, /hp-cti-call-info/);
    assert.match(code, /HARDPHONE_RINGTONE_URL = "\/audio\/ringtone\.mp3"/);
    assert.match(code, /new Audio\(HARDPHONE_RINGTONE_URL\)/);
    assert.match(code, /audio\.loop = true/);
    assert.match(code, /callInfo\.isIncoming/);
    assert.match(code, /stopIncomingRingtone/);
    assert.match(code, /hp-cti-inline-error/);
    assert.match(code, /PhoneMaintenanceActions/);
    assert.match(code, /hp-sip-registration-actions/);
    assert.match(code, /hp-sip-check-status/);
    assert.match(code, /hp-sip-reprovision/);
    assert.match(code, /hp-sip-reboot/);
    assert.match(code, /rebootPhones=\{requestRebootPhones\}/);
    assert.match(code, /rebooting=\{rebooting\}/);
    assert.match(code, /<PhoneMaintenanceActions phone=\{phone\} rebootPhones=\{rebootPhones\} rebooting=\{rebooting\}/);
    assert.match(code, /hp-sip-reboot", \(\) => rebootPhones\?\.\(\[phone\.id\]\), rebooting \|\| !phone\?\.id\)/);
    assert.doesNotMatch(code, /const \[rebootOpen, setRebootOpen\] = useState\(false\)/);
    assert.doesNotMatch(code, /<AlertDialog open=\{rebootOpen\} onOpenChange=\{setRebootOpen\}>/);
    assert.doesNotMatch(code, /run\("reboot"\)\.then\(\(\) => setRebootOpen\(false\)\)/);
    assert.match(code, /from "@\/components\/ui\/alert-dialog"/);
    assert.match(code, /Reboot hardphone/);
    assert.match(code, /requestRebootPhones/);
    assert.match(code, /confirmRebootPhones/);
    assert.doesNotMatch(code, /Send remote reboot to \$\{label\}\?`\)\)/);
    assert.doesNotMatch(code, /Send remote reboot to this phone\?/);
    assert.match(code, /deriveCallInfo/);
    assert.match(code, /replace\(\/\(\[a-z0-9\]\)\(\[A-Z\]\)\/g/);
    assert.match(code, /call_hold/);
    assert.match(code, /call_connected/);
    assert.match(code, /const canHold = callInfo\.isConnected/);
    assert.match(code, /const canMute = \(callInfo\.isConnected && !callInfo\.isHeld\)/);
    assert.match(code, /disabled=\{!canHold\}/);
    assert.match(code, /disabled=\{!canMute\}/);
    assert.doesNotMatch(code, /canHoldOrMute/);
    assert.match(code, /applyOptimisticCtiState/);
    assert.match(code, /mergeStatusWithStickyMute/);
    assert.match(code, /explicitMuteValue/);
    assert.match(code, /phoneStatusSummary/);
    assert.match(code, /Registration: /);
    assert.match(code, /grid grid-cols-5 gap-2/);
    assert.match(code, /grid grid-cols-3 gap-2/);
    assert.match(code, /setInterval\(\(\) => fetchCtiStatus/);
    assert.doesNotMatch(code, /JSON\.stringify\(lastStatus/);
    assert.doesNotMatch(code, /Hardphone provisioning prerequisites are configured/);
    assert.doesNotMatch(code, /Phone IP address is detected automatically/);
    assert.doesNotMatch(code, /Identity used to match boot provisioning requests/);
    assert.doesNotMatch(code, /MAC cannot change/);
    assert.doesNotMatch(code, /Dedicated Telnyx credential connection injected into the config/);
    assert.doesNotMatch(code, /Driver: /);
    assert.doesNotMatch(code, /These values are emitted into generated provisioning files/);
    assert.doesNotMatch(code, /Poly UCS\/PVOS config supports/);
    assert.doesNotMatch(code, /title: `CTI:/);
    assert.doesNotMatch(code, /title: `CTI \$\{action\} failed`/);
    assert.match(code, /const isInbound = direction === "incoming"/);
    assert.match(code, /const isIncoming = hasCall && !isConnected/);
    assert.match(code, /from: isInbound/);
    assert.match(code, /to: isInbound/);
    assert.match(code, /canAnswer = callInfo\.isIncoming/);
    assert.doesNotMatch(code, /NAT-safe mode is enabled/);
    assert.match(code, /Telnyx Call Control/);
    assert.match(code, /Polycom REST API/);
    assert.match(code, /Yealink Action URI/);
  });

  it("polycom driver uses phone-local HTTP clients with self-signed HTTPS support and HTTP fallback", async () => {
    const code = await src("lib/hardphones/drivers/polycom.mjs");
    assert.match(code, /import https from "node:https"/);
    assert.match(code, /rejectUnauthorized: false/);
    assert.match(code, /https:\/\/\$\{host\}\$\{path\}/);
    assert.match(code, /http:\/\/\$\{host\}\$\{path\}/);
    assert.match(code, /shouldRetryPolyOverHttp/);
  });

  it("polycom driver covers the REST call-control surface", async () => {
    const code = await src("lib/hardphones/drivers/polycom.mjs");
    assert.match(code, /\/api\/v1\/callctrl\/dial/);
    assert.match(code, /Dest: String\(number\), Line: "1"/);
    assert.doesNotMatch(code, /Type: "SIP" \}/);
    assert.match(code, /\/api\/v1\/callctrl\/answerCall/);
    assert.match(code, /\/api\/v1\/callctrl\/endCall/);
    assert.match(code, /\/api\/v1\/callctrl\/holdCall/);
    assert.match(code, /\/api\/v1\/callctrl\/resumeCall/);
    assert.match(code, /\/api\/v1\/callctrl\/mute/);
    assert.match(code, /mute_not_allowed_while_held/);
    assert.doesNotMatch(code, /async mute\(phone, state = true\) \{[\s\S]*if \(isHeldCall\(call\)\) \{[\s\S]*\/api\/v1\/callctrl\/resumeCall[\s\S]*\/api\/v1\/callctrl\/mute[\s\S]*\/api\/v1\/callctrl\/holdCall/);
    assert.match(code, /\/api\/v1\/webCallControl\/callStatus/);
    assert.match(code, /\/api\/v1\/mgmt\/updateConfiguration/);
    assert.match(code, /\/api\/v1\/mgmt\/safeReboot/);
    assert.match(code, /shouldRetryPolyOverHttp/);
    assert.match(code, /4010/);
  });

  it("yealink driver uses Action URI commands", async () => {
    const code = await src("lib/hardphones/drivers/yealink.mjs");
    assert.match(code, /servlet\?/);
    assert.match(code, /key=OK/);
    assert.match(code, /key=CALLEND/);
    assert.match(code, /key=F_HOLD/);
    assert.match(code, /key=MUTE/);
    assert.match(code, /key=AUTOP/);
    assert.match(code, /key=Reboot/);
    assert.doesNotMatch(code, /key=REBOOT/);
  });

  it("telnyx fallback dials with auto-answer Alert-Info header", async () => {
    const code = await src("lib/hardphones/drivers/telnyx-fallback.mjs");
    assert.match(code, /Alert-Info/);
    assert.match(code, /alert-autoanswer/);
    assert.match(code, /sip:\$\{phone\.sip_username\}@sip\.telnyx\.com/);
    assert.match(code, /function fallbackCallerId\(phone\)/);
    assert.match(code, /phone\?\.assigned_phone_number/);
    assert.match(code, /if \(!callerId\) return \{ ok: false, reason: "phone_has_no_caller_id" \}/);
    assert.match(code, /from: callerId/);
    assert.doesNotMatch(code, /from: process\.env\.HP_CTI_FROM_NUMBER \|\| process\.env\.TELNYX_DEFAULT_FROM_NUMBER \|\| target/);
    assert.match(code, /hp_cti_sessions/);
    assert.match(code, /findActiveHardphoneInteractionSession/);
    assert.match(code, /metadata->>'hardphone_phone_id'/);
    assert.match(code, /metadata->>'hardphone_connection_id'/);
    assert.match(code, /metadata->>'hardphone_call_control_id'/);
    assert.match(code, /metadata->>'pstn_call_control_id'/);
    assert.match(code, /COALESCE\(metadata->>'hardphone_call_control_id'/);
    assert.match(code, /function telnyxSessionCall\(session\)/);
    assert.match(code, /RemotePartyNumber: target/);
    assert.match(code, /call: telnyxSessionCall\(session\)/);
    assert.match(code, /send_dtmf/);
  });
});
