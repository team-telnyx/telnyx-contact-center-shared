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
import { resolveCtiDriver, executeCtiAction, CTI_ACTIONS } from "../lib/hardphones/cti.mjs";

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

  it("drivers fail fast without a phone IP", async () => {
    const phone = { vendor: "polycom", admin_password: "x" };
    assert.deepStrictEqual(await polycomDriver.dial(phone, "123"), { ok: false, reason: "no_phone_ip" });
    assert.deepStrictEqual(await yealinkDriver.dial({ vendor: "yealink" }, "123"), { ok: false, reason: "no_phone_ip" });
    const status = await yealinkDriver.status({ vendor: "yealink" });
    assert.strictEqual(status.reachable, false);
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
    assert.match(code, /call\.answered/);
    assert.match(code, /actions\/transfer/);
    assert.match(code, /hp_cti_sessions/);
    assert.match(code, /bridged/);
  });

  it("provisioning endpoints capture phone IP for CTI reachability", async () => {
    const serveCode = await src("app/api/provisioning/[filename]/route.js");
    assert.match(serveCode, /last_ip = COALESCE/);
    assert.match(serveCode, /x-forwarded-for/);
    const eventsCode = await src("app/api/provisioning/events/[vendor]/route.js");
    assert.match(eventsCode, /last_ip = COALESCE/);
  });

  it("phone editor exposes IP field and CTI control card", async () => {
    const code = await src("app/(portal)/admin/phones-provisioning/page.jsx");
    assert.match(code, /Phone IP address/);
    assert.match(code, /readOnly/);
    assert.match(code, /phone\.last_ip \|\| phone\.ip_address/);
    assert.match(code, /PhoneCtiCard/);
    assert.match(code, /hp-cti-dial/);
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
    assert.match(code, /\/api\/v1\/callctrl\/answerCall/);
    assert.match(code, /\/api\/v1\/callctrl\/endCall/);
    assert.match(code, /\/api\/v1\/callctrl\/holdCall/);
    assert.match(code, /\/api\/v1\/callctrl\/resumeCall/);
    assert.match(code, /\/api\/v1\/callctrl\/mute/);
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
    assert.match(code, /hp_cti_sessions/);
    assert.match(code, /send_dtmf/);
  });
});
